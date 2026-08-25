use crate::dnr::DnrRuleSet;
use crate::whitelist::{Allowlist, Site, Tracker};
use adblock::engine::Engine;
use adblock::lists::{ParseOptions, RuleTypes};
use adblock::request::Request;
use adblock::FilterSet;
use wasm_bindgen::prelude::*;

const AD_RULES: &str = include_str!("baseline_rules.txt");
// Cosmetic rules were stripped from EasyList at build time (see build.rs);
// the engine only does network filtering, so the binary ships network rules
// only.
const EASYLIST_RULES: &str = include_str!(concat!(env!("OUT_DIR"), "/easylist_network.txt"));
const TURTLECUTE_RULES: &str = include_str!("turtlecute_rules.txt");
const TRACKING_RULES: &str = include_str!("tracking_rules.txt");

/// Why a request was allowed or blocked, as returned by
/// [`AdblockEngine::evaluate`].
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    Allow,
    Ad,
    Tracker,
}

/// One filter list and its accumulated rules. The ads and tracking lists
/// are kept apart so each can be reported and updated independently.
struct FilterEngine {
    core: Engine,
    /// Raw accumulated rule text. Only the compiled `core` is kept hot; the
    /// intermediate `FilterSet` is dropped after every rebuild so the parsed
    /// filters don't linger in memory next to the compiled matching
    /// structures.
    list: String,
    rules: usize,
}

impl FilterEngine {
    fn new(list: &str) -> Self {
        let mut engine = Self {
            core: Engine::default(),
            list: String::new(),
            rules: 0,
        };
        engine.load(list);
        engine
    }

    fn load(&mut self, list: &str) {
        self.list.clear();
        self.list.push_str(list);
        self.rebuild();
        self.rules = count_rules(&self.list);
    }

    fn add_rules(&mut self, list: &str) {
        self.list.push('\n');
        self.list.push_str(list);
        self.rebuild();
        self.rules += count_rules(list);
    }

    fn rebuild(&mut self) {
        let mut filters = FilterSet::new(false);
        filters.add_filter_list(&self.list, network_only_options());
        self.core = Engine::from_filter_set(filters, true);
    }

    fn blocks(&self, request: &Request) -> bool {
        self.core.check_network_request(request).matched
    }
}

/// This extension only ever calls `check_network_request`, so the cosmetic
/// rules (the `##` selectors that make up a large share of EasyList) are
/// dropped at parse time. That shrinks the compiled matching structures, the
/// WASM binary, and the initial build time.
fn network_only_options() -> ParseOptions {
    ParseOptions {
        rule_types: RuleTypes::NetworkOnly,
        ..ParseOptions::default()
    }
}

/// A WebAssembly-exposed network filtering engine. The JS glue lives in the
/// extension's service worker; see `extension/background/service-worker.js`.
#[wasm_bindgen]
pub struct AdblockEngine {
    ads: FilterEngine,
    trackers: FilterEngine,
    site_allowlist: Allowlist<Site>,
    tracker_allowlist: Allowlist<Tracker>,
    dnr: DnrRuleSet,
    paused: bool,
    requests_checked: u32,
    ads_blocked: u32,
    trackers_blocked: u32,
}

#[wasm_bindgen]
impl AdblockEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> AdblockEngine {
        set_panic_hook();
        // Merge the bundled baseline ad rules with the full EasyList so
        // offline filtering has broad coverage out of the box. The Turtlecute
        // host list is mostly analytics/OEM trackers, so it extends the
        // tracking engine; ad networks it lists (doubleclick, adcolony, ...)
        // are already covered by EasyList and keep their `Ad` verdict.
        let combined_ads = format!("{AD_RULES}\n{EASYLIST_RULES}");
        let combined_trackers = format!("{TRACKING_RULES}\n{TURTLECUTE_RULES}");
        AdblockEngine {
            ads: FilterEngine::new(&combined_ads),
            trackers: FilterEngine::new(&combined_trackers),
            site_allowlist: Allowlist::new(),
            tracker_allowlist: Allowlist::new(),
            dnr: DnrRuleSet::new(),
            paused: false,
            requests_checked: 0,
            ads_blocked: 0,
            trackers_blocked: 0,
        }
    }

    /// Classify a network request. Explicit user exceptions are checked
    /// before either filter list, so an allowlisted domain always wins.
    pub fn evaluate(
        &mut self,
        request_url: &str,
        source_url: &str,
        request_type: &str,
    ) -> BlockReason {
        self.requests_checked += 1;

        if self.paused {
            return BlockReason::Allow;
        }

        let request = match Request::new(request_url, source_url, request_type) {
            Ok(req) => req,
            Err(_) => return BlockReason::Allow,
        };

        if let Some(source_host) = host_of(source_url) {
            if self.site_allowlist.matches(&source_host) {
                return BlockReason::Allow;
            }
        }

        // `request.hostname` is the host the crate already parsed out of the
        // URL — reuse it instead of re-parsing the string a second time.
        if self.tracker_allowlist.matches(&request.hostname) {
            return BlockReason::Allow;
        }

        if self.ads.blocks(&request) {
            self.ads_blocked += 1;
            return BlockReason::Ad;
        }

        if self.trackers.blocks(&request) {
            self.trackers_blocked += 1;
            return BlockReason::Tracker;
        }

        BlockReason::Allow
    }

    /// Convenience wrapper: `true` when the request must be cancelled.
    pub fn check_url(&mut self, request_url: &str, source_url: &str, request_type: &str) -> bool {
        self.evaluate(request_url, source_url, request_type) != BlockReason::Allow
    }

    /// Beacon (navigator.sendBeacon) requests surface in Chrome as "ping"
    /// resource loads; this is just a named wrapper for that type.
    pub fn check_beacon(&mut self, request_url: &str, source_url: &str) -> bool {
        self.check_url(request_url, source_url, "ping")
    }

    /// Host portion of a URL, or `None` when the URL carries no authority.
    /// Lets the service worker avoid constructing a `URL` object for every
    /// blocked request.
    pub fn host_from_url(&self, url: &str) -> Option<String> {
        host_of(url)
    }

    pub fn pause_blocking(&mut self) {
        self.paused = true;
    }

    pub fn resume_blocking(&mut self) {
        self.paused = false;
    }

    #[wasm_bindgen(getter)]
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    // ---- Site allowlist: whole pages that bypass both lists ----

    pub fn add_site_to_allowlist(&mut self, domain: &str) {
        self.site_allowlist.add(domain);
    }

    /// Restore blocking for a site (also exposed as `move_site_to_blocklist`).
    pub fn remove_site_from_allowlist(&mut self, domain: &str) {
        self.site_allowlist.remove(domain);
    }

    pub fn move_site_to_blocklist(&mut self, domain: &str) {
        self.site_allowlist.remove(domain);
    }

    pub fn is_site_allowlisted(&self, domain: &str) -> bool {
        self.site_allowlist.matches(domain)
    }

    pub fn get_site_allowlist(&self) -> String {
        self.site_allowlist.to_json()
    }

    pub fn set_site_allowlist(&mut self, domains_json: &str) {
        self.site_allowlist.load_json(domains_json);
    }

    // ---- Tracker allowlist: individual tracking domains allowed through ----

    pub fn add_tracking_domain(&mut self, domain: &str) {
        self.tracker_allowlist.add(domain);
    }

    pub fn remove_tracking_domain(&mut self, domain: &str) {
        self.tracker_allowlist.remove(domain);
    }

    pub fn move_tracking_to_blocklist(&mut self, domain: &str) {
        self.tracker_allowlist.remove(domain);
    }

    pub fn is_tracking_allowed(&self, domain: &str) -> bool {
        self.tracker_allowlist.matches(domain)
    }

    pub fn get_tracking_allowlist(&self) -> String {
        self.tracker_allowlist.to_json()
    }

    pub fn set_tracking_allowlist(&mut self, domains_json: &str) {
        self.tracker_allowlist.load_json(domains_json);
    }

    // ---- Runtime rule updates (e.g. a freshly downloaded EasyList) ----

    pub fn add_rules(&mut self, list: &str) {
        self.ads.add_rules(list);
    }

    pub fn add_tracking_rules(&mut self, list: &str) {
        self.trackers.add_rules(list);
    }

    // ---- declarativeNetRequest rule cache ----
    //
    // The service worker turns the engine's verdicts into DNR rules so
    // Chrome actually cancels blocked requests. All of the rule bookkeeping
    // (host normalization, resource-type sets, FIFO eviction, allowlist
    // reconciliation) lives here; each call returns the exact
    // `updateDynamicRules` payload for the worker to apply, or "" for a no-op.

    /// Seed a rule from one Chrome-persisted dynamic rule (worker restart).
    pub fn dnr_import(&mut self, host: &str, id: u32, types: Vec<String>) {
        self.dnr.import(host, id, types);
    }

    /// Record one blocked request; returns the payload to apply, or "".
    pub fn dnr_ensure(&mut self, host: &str, web_request_type: &str) -> String {
        let exclusions = self.site_allowlist.to_json();
        self.dnr
            .ensure(host, web_request_type, &exclusions)
            .unwrap_or_default()
    }

    /// Reconcile the cache after allowlist changes; returns the payload to
    /// apply, or "" when nothing changed.
    pub fn dnr_sync(&mut self) -> String {
        let exclusions = self.site_allowlist.to_json();
        self.dnr
            .sync(&exclusions, |host| self.tracker_allowlist.matches(host))
            .unwrap_or_default()
    }

    /// Payload removing every cached rule (pause).
    pub fn dnr_pause_payload(&self) -> String {
        self.dnr.pause_payload()
    }

    /// Payload re-adding every cached rule with current exclusions (resume).
    pub fn dnr_resume_payload(&mut self) -> String {
        let exclusions = self.site_allowlist.to_json();
        self.dnr.resume_payload(&exclusions)
    }

    #[wasm_bindgen(getter)]
    pub fn dnr_rule_count(&self) -> usize {
        self.dnr.len()
    }

    #[wasm_bindgen(getter)]
    pub fn rule_count(&self) -> usize {
        self.ads.rules
    }

    #[wasm_bindgen(getter)]
    pub fn tracking_rule_count(&self) -> usize {
        self.trackers.rules
    }

    // ---- Stats ----

    #[wasm_bindgen(getter)]
    pub fn requests_checked(&self) -> u32 {
        self.requests_checked
    }

    #[wasm_bindgen(getter)]
    pub fn ads_blocked(&self) -> u32 {
        self.ads_blocked
    }

    #[wasm_bindgen(getter)]
    pub fn trackers_blocked(&self) -> u32 {
        self.trackers_blocked
    }

    pub fn reset_stats(&mut self) {
        self.requests_checked = 0;
        self.ads_blocked = 0;
        self.trackers_blocked = 0;
    }
}

impl Default for AdblockEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Approximate rule count: every non-blank, non-comment line is one rule.
fn count_rules(list: &str) -> usize {
    list.lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty() && !line.starts_with('!')
        })
        .count()
}

/// Host portion of a URL, or `None` when the URL carries no authority.
/// Hand-rolled to avoid pulling the `url` crate into the wasm binary.
fn host_of(url: &str) -> Option<String> {
    let authority = url.split("://").nth(1)?.split(['/', '?', '#']).next()?;
    let host = authority.split('@').next_back()?.split(':').next()?;
    // `[` means an IPv6 literal, which allowlists never store.
    if host.is_empty() || host.starts_with('[') {
        None
    } else {
        Some(host.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> AdblockEngine {
        AdblockEngine::new()
    }

    #[test]
    fn bundled_lists_parse() {
        let e = engine();
        assert!(e.rule_count() > 0);
        assert!(e.tracking_rule_count() > 0);
    }

    #[test]
    fn blocks_ad_network() {
        let mut e = engine();
        assert_eq!(
            e.evaluate(
                "https://ad.doubleclick.net/banner",
                "https://news.example.com",
                "script",
            ),
            BlockReason::Ad
        );
    }

    #[test]
    fn blocks_tracker_and_beacon() {
        let mut e = engine();
        assert_eq!(
            e.evaluate(
                "https://www.google-analytics.com/collect",
                "https://shop.example.com",
                "xhr",
            ),
            BlockReason::Tracker
        );
        assert!(e.check_beacon(
            "https://api.mixpanel.com/beacon",
            "https://shop.example.com",
        ));
    }

    #[test]
    fn site_exception_bypasses_both_lists() {
        let mut e = engine();
        e.add_site_to_allowlist("news.example.com");
        assert_eq!(
            e.evaluate(
                "https://ad.doubleclick.net/banner",
                "https://news.example.com",
                "script",
            ),
            BlockReason::Allow
        );
        // subdomains inherit the site exception
        assert_eq!(
            e.evaluate(
                "https://ad.doubleclick.net/banner",
                "https://www.news.example.com",
                "script",
            ),
            BlockReason::Allow
        );
    }

    #[test]
    fn site_exception_removal_restores_blocking() {
        let mut e = engine();
        e.add_site_to_allowlist("news.example.com");
        e.move_site_to_blocklist("news.example.com");
        assert_eq!(
            e.evaluate(
                "https://ad.doubleclick.net/banner",
                "https://news.example.com",
                "script",
            ),
            BlockReason::Ad
        );
    }

    #[test]
    fn tracking_domain_exception_overrides_ad_list() {
        let mut e = engine();
        e.add_tracking_domain("doubleclick.net");
        assert_eq!(
            e.evaluate(
                "https://ad.doubleclick.net/banner",
                "https://news.example.com",
                "script",
            ),
            BlockReason::Allow
        );
    }

    #[test]
    fn pause_allows_everything() {
        let mut e = engine();
        e.pause_blocking();
        assert!(e.is_paused());
        assert_eq!(
            e.evaluate(
                "https://ad.doubleclick.net/banner",
                "https://news.example.com",
                "script",
            ),
            BlockReason::Allow
        );
        e.resume_blocking();
        assert!(!e.is_paused());
    }

    #[test]
    fn stats_count_blocks() {
        let mut e = engine();
        e.evaluate(
            "https://ad.doubleclick.net/banner",
            "https://news.example.com",
            "script",
        );
        e.evaluate(
            "https://www.google-analytics.com/collect",
            "https://shop.example.com",
            "xhr",
        );
        e.evaluate(
            "https://shop.example.com/page.css",
            "https://shop.example.com",
            "stylesheet",
        );
        assert_eq!(e.requests_checked(), 3);
        assert_eq!(e.ads_blocked(), 1);
        assert_eq!(e.trackers_blocked(), 1);
        e.reset_stats();
        assert_eq!(e.requests_checked(), 0);
    }

    #[test]
    fn runtime_rules_extend_the_ads_list() {
        let mut e = engine();
        let before = e.rule_count();
        e.add_rules("||ad.test.example^\n");
        assert_eq!(e.rule_count(), before + 1);
        assert_eq!(
            e.evaluate(
                "https://ad.test.example/1x1.gif",
                "https://news.example.com",
                "image",
            ),
            BlockReason::Ad
        );
    }

    #[test]
    fn allowlists_round_trip_through_json() {
        let mut e = engine();
        e.add_site_to_allowlist("example.com");
        e.add_tracking_domain("analytics.io");
        let sites = e.get_site_allowlist();
        let trackers = e.get_tracking_allowlist();

        let mut f = engine();
        f.set_site_allowlist(&sites);
        f.set_tracking_allowlist(&trackers);
        assert!(f.is_site_allowlisted("example.com"));
        assert!(f.is_tracking_allowed("analytics.io"));
    }

    #[test]
    fn host_from_url_extracts_the_host() {
        let e = engine();
        assert_eq!(
            e.host_from_url("https://www.example.com/path?q=1#frag"),
            Some("www.example.com".to_string())
        );
        assert_eq!(e.host_from_url("https://user:pass@example.com:8080/x"), Some("example.com".to_string()));
        assert_eq!(e.host_from_url("not a url"), None);
        assert_eq!(e.host_from_url(""), None);
    }

    #[test]
    fn dnr_ensure_payload_flows_through_the_engine() {
        let mut e = engine();
        let payload = e.dnr_ensure("ads.example.com", "script");
        assert!(payload.contains("\"urlFilter\":\"||ads.example.com^\""));
        // same host + type again is a no-op
        assert_eq!(e.dnr_ensure("ads.example.com", "script"), "");
        // a second type extends the rule
        let payload = e.dnr_ensure("ads.example.com", "image");
        assert!(payload.contains("\"resourceTypes\":[\"image\",\"script\"]"));
        assert_eq!(e.dnr_rule_count(), 1);
    }

    #[test]
    fn dnr_sync_honours_allowlists() {
        let mut e = engine();
        e.dnr_ensure("ads.example.com", "script");
        e.dnr_ensure("analytics.io", "xhr");
        e.dnr_ensure("fine.example.com", "image");

        // allowlisting the site excludes it as an initiator on every rule
        e.add_site_to_allowlist("news.example.com");
        let payload = e.dnr_sync();
        assert!(payload.contains("\"excludedInitiatorDomains\":[\"news.example.com\"]"));
        assert!(payload.contains("\"urlFilter\":\"||analytics.io^\""));

        // allowlisting a tracker host drops its rule entirely; the survivors
        // are removed and re-added (ids 1 and 3), plus the dropped id 2
        e.add_tracking_domain("analytics.io");
        let payload = e.dnr_sync();
        assert!(!payload.contains("||analytics.io^"));
        assert!(payload.contains("\"removeRuleIds\":[1,3,2]"));
        assert_eq!(e.dnr_rule_count(), 2);

        // nothing changed -> no-op
        assert_eq!(e.dnr_sync(), "");
    }

    #[test]
    fn turtlecute_list_blocks_its_domains() {
        let mut e = engine();
        // an ad network from the list that EasyList also covers → `Ad`
        assert_eq!(
            e.evaluate(
                "https://ads30.adcolony.com/banner",
                "https://news.example.com",
                "image",
            ),
            BlockReason::Ad
        );
        // an analytics domain the list adds beyond EasyList → `Tracker`
        assert_eq!(
            e.evaluate(
                "https://script.hotjar.com/modules.js",
                "https://shop.example.com",
                "script",
            ),
            BlockReason::Tracker
        );
        // an OEM tracker the list adds beyond EasyList → `Tracker`
        assert_eq!(
            e.evaluate(
                "https://data.mistat.xiaomi.com/collect",
                "https://shop.example.com",
                "xhr",
            ),
            BlockReason::Tracker
        );
    }

    #[test]
    fn turtlecute_site_specific_rules_work() {
        let mut e = engine();
        // `*$3p,domain=adblock.turtlecute.org` blocks every third-party
        // request on the test site, including unknown hosts.
        assert_eq!(
            e.evaluate(
                "https://unknown-tracker.example.net/beacon",
                "https://adblock.turtlecute.org",
                "xhr",
            ),
            BlockReason::Tracker
        );
        // `/pagead.js$domain=adblock.turtlecute.org` blocks the path rule.
        assert_eq!(
            e.evaluate(
                "https://adblock.turtlecute.org/pagead.js",
                "https://adblock.turtlecute.org",
                "script",
            ),
            BlockReason::Tracker
        );
        // The `@@*$redirect-rule` exception must NOT un-block requests on
        // the test site (it only exempts redirect rules, not block rules),
        // and EasyList-covered ad networks still report `Ad`.
        assert_eq!(
            e.evaluate(
                "https://doubleclick.net/banner",
                "https://adblock.turtlecute.org",
                "script",
            ),
            BlockReason::Ad
        );
        // ...and the list must not leak beyond the test site: a random
        // third-party request from another page stays allowed.
        assert_eq!(
            e.evaluate(
                "https://unknown-tracker.example.net/beacon",
                "https://news.example.com",
                "xhr",
            ),
            BlockReason::Allow
        );
    }

    #[test]
    fn dnr_pause_resume_and_import() {
        let mut e = engine();
        e.dnr_ensure("ads.example.com", "script");

        let pause = e.dnr_pause_payload();
        assert!(pause.contains("\"removeRuleIds\":[1]"));

        let resume = e.dnr_resume_payload();
        assert!(resume.contains("\"urlFilter\":\"||ads.example.com^\""));

        // simulate a worker restart: seed from Chrome's persisted rules
        let mut f = engine();
        f.dnr_import("ads.example.com", 1, vec!["script".to_string()]);
        assert_eq!(f.dnr_rule_count(), 1);
        // the imported rule is recognized, so re-ensuring is a no-op
        assert_eq!(f.dnr_ensure("ads.example.com", "script"), "");
        // next id continues past the imported one
        assert!(f.dnr_ensure("other.example.com", "script").contains("\"id\":2"));
    }
}
