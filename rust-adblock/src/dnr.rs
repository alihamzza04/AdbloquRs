//! declarativeNetRequest rule cache.
//!
//! Manifest V3 extensions cannot cancel requests from `webRequest`; Chrome
//! only honours `declarativeNetRequest` rules. For every request the engine
//! blocks we install a host-level DNR rule (`||host^`, i.e. the host and its
//! subdomains) restricted to the resource types actually seen. `main_frame`
//! is deliberately excluded: a host-level rule must never cancel whole-page
//! navigations.
//!
//! All of that bookkeeping used to live in the service worker (Maps, FIFO
//! eviction, allowlist reconciliation, JSON payload assembly). It is pure
//! logic with no DOM or Chrome API access, so it now lives here, where it is
//! unit-testable and keeps the per-request JS work to a single call that
//! returns the exact `updateDynamicRules` payload to apply (or nothing).
//!
//! Payload shape (verbatim `updateDynamicRules` options):
//! `{"addRules":[...],"removeRuleIds":[...]}` — the service worker parses it
//! and hands it straight to Chrome.

use std::collections::{BTreeSet, HashMap};

/// Cap on cached rules, well below Chrome's 30 000 dynamic-rule limit.
/// Oldest rules are evicted first (FIFO).
pub const MAX_RULES: usize = 10_000;

struct Rule {
    id: u32,
    types: BTreeSet<String>,
}

/// One cached host rule plus the FIFO order needed for eviction.
pub struct DnrRuleSet {
    rules: HashMap<String, Rule>,
    order: Vec<String>, // hosts, oldest first
    next_id: u32,
    needs_sort: bool,
    last_exclusions: String,
    max_rules: usize,
}

impl Default for DnrRuleSet {
    fn default() -> Self {
        Self::new()
    }
}

impl DnrRuleSet {
    pub fn new() -> Self {
        Self {
            rules: HashMap::new(),
            order: Vec::new(),
            next_id: 1,
            needs_sort: false,
            last_exclusions: String::new(),
            max_rules: MAX_RULES,
        }
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    #[cfg(test)]
    fn with_cap(max_rules: usize) -> Self {
        Self {
            max_rules,
            ..Self::new()
        }
    }

    /// Seed a rule from a rule Chrome already persisted (worker restart).
    /// The host is normalized; ids feed the next-id counter.
    pub fn import(&mut self, host: &str, id: u32, types: Vec<String>) {
        let host = normalize_host(host);
        if host.is_empty() || id == 0 {
            return;
        }
        let types: BTreeSet<String> = types.into_iter().filter(|t| !t.is_empty()).collect();
        if types.is_empty() {
            return;
        }
        if self.rules.insert(host.clone(), Rule { id, types }).is_none() {
            self.order.push(host);
            self.needs_sort = true;
        }
        if id >= self.next_id {
            self.next_id = id + 1;
        }
    }

    /// Record one blocked request of the given `webRequest` type. Returns the
    /// `updateDynamicRules` payload to apply, or `None` when the rule already
    /// covers this host+type (the common case — no Chrome call needed).
    pub fn ensure(
        &mut self,
        host: &str,
        web_request_type: &str,
        exclusions_json: &str,
    ) -> Option<String> {
        let host = normalize_host(host);
        if host.is_empty() {
            return None;
        }
        let dnr_type = dnr_type_for(web_request_type)?;
        self.ensure_sorted();

        if let Some(rule) = self.rules.get_mut(&host) {
            if rule.types.contains(dnr_type) {
                return None;
            }
            rule.types.insert(dnr_type.to_string());
            // The rule already exists in Chrome's dynamic ruleset; rule IDs
            // must be unique within it, so the update removes the id and
            // re-adds it in the same call.
            let id = rule.id;
            let json = rule_json(&host, &self.rules[&host], exclusions_json);
            return Some(payload(&[json], &[id]));
        }

        // Evict oldest rules while over the cap.
        let mut remove_ids = Vec::new();
        while self.rules.len() >= self.max_rules {
            let Some(oldest) = self.order.first().cloned() else {
                break;
            };
            self.order.remove(0);
            if let Some(evicted) = self.rules.remove(&oldest) {
                remove_ids.push(evicted.id);
            }
        }

        let rule = Rule {
            id: self.next_id,
            types: BTreeSet::from([dnr_type.to_string()]),
        };
        self.next_id += 1;
        self.rules.insert(host.clone(), rule);
        self.order.push(host.clone());
        Some(payload(&[rule_json(&host, &self.rules[&host], exclusions_json)], &remove_ids))
    }

    /// Reconcile the cache after allowlist changes: drop rules for hosts the
    /// user has tracker-allowlisted and refresh the `excludedInitiatorDomains`
    /// taken from the site allowlist. Returns the payload to apply, or `None`
    /// when nothing changed.
    pub fn sync(&mut self, exclusions_json: &str, mut tracker_allowed: impl FnMut(&str) -> bool) -> Option<String> {
        self.ensure_sorted();

        // Drop rules for tracker-allowlisted hosts, scanning in insertion
        // order so the payload is deterministic.
        let dropped: Vec<String> = self
            .order
            .iter()
            .filter(|host| tracker_allowed(host))
            .cloned()
            .collect();
        let mut remove_ids: Vec<u32> = Vec::new();
        for host in &dropped {
            if let Some(rule) = self.rules.remove(host) {
                remove_ids.push(rule.id);
            }
        }
        self.order.retain(|host| self.rules.contains_key(host));

        let mut changed = !remove_ids.is_empty();
        if exclusions_json != self.last_exclusions {
            self.last_exclusions = exclusions_json.to_string();
            changed = true;
        }
        if !changed || (self.rules.is_empty() && remove_ids.is_empty()) {
            return None;
        }

        // Surviving rules keep their IDs, which already exist in Chrome's
        // dynamic ruleset — IDs must be unique within it, so every surviving
        // rule is removed and re-added in the same call. This is the pattern
        // the Chrome docs use for updating dynamic rules.
        let add_rules: Vec<String> = self
            .order
            .iter()
            .filter_map(|host| self.rules.get(host).map(|rule| rule_json(host, rule, exclusions_json)))
            .collect();
        let mut all_ids: Vec<u32> = self
            .order
            .iter()
            .filter_map(|host| self.rules.get(host).map(|rule| rule.id))
            .collect();
        all_ids.extend(remove_ids.iter().copied());
        Some(payload(&add_rules, &all_ids))
    }

    /// Payload that removes every cached rule (pause). Ids are emitted in
    /// insertion order (deterministic, unlike HashMap iteration).
    pub fn pause_payload(&self) -> String {
        let ids: Vec<u32> = self
            .order
            .iter()
            .filter_map(|host| self.rules.get(host).map(|rule| rule.id))
            .collect();
        payload(&[], &ids)
    }

    /// Payload that re-adds every cached rule with the current site-allowlist
    /// exclusions (resume). The exclusion cache is refreshed so a later sync
    /// is a no-op. The ids are removed too: after a pause Chrome's dynamic
    /// ruleset is empty (a no-op removal), but if an earlier update failed the
    /// ids may still exist and must be removed before re-adding.
    pub fn resume_payload(&mut self, exclusions_json: &str) -> String {
        self.last_exclusions = exclusions_json.to_string();
        let add_rules: Vec<String> = self
            .order
            .iter()
            .filter_map(|host| self.rules.get(host).map(|rule| rule_json(host, rule, exclusions_json)))
            .collect();
        let ids: Vec<u32> = self
            .order
            .iter()
            .filter_map(|host| self.rules.get(host).map(|rule| rule.id))
            .collect();
        payload(&add_rules, &ids)
    }

    fn ensure_sorted(&mut self) {
        if self.needs_sort {
            self.order.sort_by_key(|host| self.rules[host].id);
            self.needs_sort = false;
        }
    }
}

/// webRequest resource types map onto DNR resource types as-is, minus
/// `main_frame` (a host rule must never cancel whole-page navigations).
fn dnr_type_for(web_request_type: &str) -> Option<&'static str> {
    Some(match web_request_type {
        "sub_frame" => "sub_frame",
        "stylesheet" => "stylesheet",
        "script" => "script",
        "image" => "image",
        "font" => "font",
        "object" => "object",
        "xhr" => "xmlhttprequest",
        "ping" => "ping",
        "media" => "media",
        "websocket" => "websocket",
        "other" => "other",
        _ => return None,
    })
}

/// Lowercase, drop a trailing dot, and strip a leading `www.` so the cached
/// host is a canonical, JSON-safe form (`||host^` then covers subdomains and
/// both www and bare variants).
fn normalize_host(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.starts_with('[') {
        // empty, or an IPv6 literal — allowlists never store those
        String::new()
    } else {
        host.strip_prefix("www.").unwrap_or(&host).to_string()
    }
}

/// One DNR rule as JSON. `exclusions_json` is the site allowlist serialized
/// as a JSON array (e.g. `["a.com","b.com"]`); it is omitted when empty.
fn rule_json(host: &str, rule: &Rule, exclusions_json: &str) -> String {
    let types = rule
        .types
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(",");
    let mut out = format!(
        "{{\"id\":{},\"priority\":1,\"action\":{{\"type\":\"block\"}},\"condition\":{{\"urlFilter\":\"||{}^\",\"resourceTypes\":[{}]",
        rule.id, host, types
    );
    if exclusions_json != "[]" {
        out.push_str(&format!(",\"excludedInitiatorDomains\":{exclusions_json}"));
    }
    out.push_str("}}");
    out
}

fn payload(add_rules: &[String], remove_ids: &[u32]) -> String {
    let add = add_rules.join(",");
    let rm = remove_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"addRules\":[{add}],\"removeRuleIds\":[{rm}]}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_allowlist(_host: &str) -> bool {
        false
    }

    #[test]
    fn ensure_creates_rule_with_payload() {
        let mut dnr = DnrRuleSet::new();
        let payload = dnr
            .ensure("ads.example.com", "script", "[]")
            .expect("new rule needs a payload");
        assert!(payload.contains("\"urlFilter\":\"||ads.example.com^\""));
        assert!(payload.contains("\"resourceTypes\":[\"script\"]"));
        assert!(payload.contains("\"removeRuleIds\":[]"));
        assert!(payload.contains("\"id\":1"));
        assert!(!payload.contains("excludedInitiatorDomains"));
    }

    #[test]
    fn ensure_is_a_noop_for_known_host_and_type() {
        let mut dnr = DnrRuleSet::new();
        assert!(dnr.ensure("ads.example.com", "script", "[]").is_some());
        assert!(dnr.ensure("ads.example.com", "script", "[]").is_none());
    }

    #[test]
    fn ensure_adds_a_new_type_to_existing_host() {
        let mut dnr = DnrRuleSet::new();
        dnr.ensure("ads.example.com", "script", "[]");
        let payload = dnr
            .ensure("ads.example.com", "image", "[]")
            .expect("new type needs a payload");
        assert!(payload.contains("\"resourceTypes\":[\"image\",\"script\"]"));
        // the id already exists in Chrome — it must be removed and re-added
        assert!(payload.contains("\"removeRuleIds\":[1]"));
    }

    #[test]
    fn main_frame_is_never_ruleable() {
        let mut dnr = DnrRuleSet::new();
        assert!(dnr.ensure("ads.example.com", "main_frame", "[]").is_none());
        assert_eq!(dnr.len(), 0);
    }

    #[test]
    fn unknown_types_are_skipped() {
        let mut dnr = DnrRuleSet::new();
        assert!(dnr.ensure("ads.example.com", "weird_type", "[]").is_none());
    }

    #[test]
    fn site_exclusions_are_embedded() {
        let mut dnr = DnrRuleSet::new();
        let payload = dnr
            .ensure("ads.example.com", "script", "[\"news.example.com\"]")
            .unwrap();
        assert!(payload.contains("\"excludedInitiatorDomains\":[\"news.example.com\"]"));
    }

    #[test]
    fn oldest_rules_are_evicted_first() {
        let mut dnr = DnrRuleSet::with_cap(2);
        dnr.ensure("a.example.com", "script", "[]");
        dnr.ensure("b.example.com", "script", "[]");
        let payload = dnr.ensure("c.example.com", "script", "[]").unwrap();
        assert!(payload.contains("\"removeRuleIds\":[1]"));
        assert_eq!(dnr.len(), 2);
        assert!(dnr.rules.contains_key("b.example.com"));
        assert!(dnr.rules.contains_key("c.example.com"));
    }

    #[test]
    fn www_and_case_are_normalized() {
        let mut dnr = DnrRuleSet::new();
        assert!(dnr.ensure("WWW.Ads.Example.com", "script", "[]").is_some());
        // the same host under a different casing / www form is a no-op
        assert!(dnr.ensure("ads.example.com", "script", "[]").is_none());
        assert_eq!(dnr.len(), 1);
        // the stored filter dropped the www prefix
        let sync = dnr.sync("[]", no_allowlist).unwrap();
        assert!(sync.contains("\"urlFilter\":\"||ads.example.com^\""));
        assert!(!sync.contains("www"));

        let mut dnr = DnrRuleSet::new();
        let payload = dnr.ensure("tracker.example.com.", "script", "[]").unwrap();
        assert!(payload.contains("\"urlFilter\":\"||tracker.example.com^\""));
    }

    #[test]
    fn sync_removes_tracker_allowlisted_hosts() {
        let mut dnr = DnrRuleSet::new();
        dnr.ensure("ads.example.com", "script", "[]");
        dnr.ensure("analytics.io", "xhr", "[]");
        dnr.ensure("fine.example.com", "image", "[]");
        let payload = dnr.sync("[]", |host| host == "analytics.io" || host.ends_with(".analytics.io")).unwrap();
        // analytics.io (id 2) is dropped; the survivors (ids 1, 3) are
        // removed and re-added so Chrome accepts the update.
        assert!(payload.contains("\"removeRuleIds\":[1,3,2]"));
        assert!(payload.contains("\"urlFilter\":\"||ads.example.com^\""));
        assert!(payload.contains("\"urlFilter\":\"||fine.example.com^\""));
        assert!(!payload.contains("||analytics.io^"));
        assert_eq!(dnr.len(), 2);
    }

    #[test]
    fn sync_refreshes_exclusions_and_noops_when_nothing_changed() {
        let mut dnr = DnrRuleSet::new();
        dnr.ensure("ads.example.com", "script", "[]");
        let payload = dnr.sync("[\"news.example.com\"]", no_allowlist).unwrap();
        assert!(payload.contains("\"excludedInitiatorDomains\":[\"news.example.com\"]"));
        // the rebuilt rule removes its own id before re-adding it
        assert!(payload.contains("\"removeRuleIds\":[1]"));
        // second sync with the same state is a no-op
        assert!(dnr.sync("[\"news.example.com\"]", no_allowlist).is_none());
    }

    #[test]
    fn pause_and_resume_payloads_round_trip() {
        let mut dnr = DnrRuleSet::new();
        dnr.ensure("ads.example.com", "script", "[]");
        dnr.ensure("analytics.io", "xhr", "[]");

        let pause = dnr.pause_payload();
        assert!(pause.contains("\"removeRuleIds\":[1,2]"));
        assert!(pause.contains("\"addRules\":[]"));

        let resume = dnr.resume_payload("[]");
        assert!(resume.contains("\"urlFilter\":\"||ads.example.com^\""));
        assert!(resume.contains("\"urlFilter\":\"||analytics.io^\""));
        // remove-then-add: the ids are removed (no-op if already gone) and
        // the rules are re-added
        assert!(resume.contains("\"removeRuleIds\":[1,2]"));
    }

    #[test]
    fn imported_rules_feed_the_cache_and_next_id() {
        let mut dnr = DnrRuleSet::new();
        dnr.import("ads.example.com", 41, vec!["script".into(), "image".into()]);
        dnr.import("tracker.example.com", 7, vec!["xhr".into()]);
        // needs_sort is resolved on first ensure/sync
        let payload = dnr.ensure("new.example.com", "script", "[]").unwrap();
        assert!(payload.contains("\"id\":42"));
        // imported rules survive and carry their types
        let payload = dnr.sync("[]", no_allowlist).unwrap();
        assert!(payload.contains("\"resourceTypes\":[\"image\",\"script\"]"));
        assert_eq!(dnr.len(), 3);
    }
}
