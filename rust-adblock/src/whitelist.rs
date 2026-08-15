use std::collections::HashSet;
use std::marker::PhantomData;

/// Marker types that keep the site allowlist and the tracker allowlist
/// distinct at the type level, so a site list can never be passed where a
/// tracker list is expected.
pub enum Site {}

pub enum Tracker {}

/// A set of registered domains, stored lowercase with a single leading
/// `www.` stripped so that "www.example.com" and "example.com" collide.
pub struct Allowlist<T> {
    domains: HashSet<String>,
    _kind: PhantomData<T>,
}

impl<T> Default for Allowlist<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Allowlist<T> {
    pub fn new() -> Self {
        Self {
            domains: HashSet::new(),
            _kind: PhantomData,
        }
    }

    pub fn add(&mut self, domain: &str) {
        self.domains.insert(normalize(domain));
    }

    pub fn remove(&mut self, domain: &str) {
        self.domains.remove(&normalize(domain));
    }

    /// True when `domain` is registered directly or under a registered
    /// parent label; "example.com" therefore covers "a.b.example.com".
    pub fn matches(&self, domain: &str) -> bool {
        let mut rest = normalize(domain);
        loop {
            if self.domains.contains(&rest) {
                return true;
            }
            match rest.find('.') {
                Some(split) => rest = rest[split + 1..].to_string(),
                None => return false,
            }
        }
    }

    /// Sorted JSON array of the registered domains, e.g. `["a.com","b.com"]`.
    pub fn to_json(&self) -> String {
        let mut items: Vec<&str> = self.domains.iter().map(String::as_str).collect();
        items.sort_unstable();
        let body = items
            .iter()
            .map(|d| format!("\"{}\"", escape(d)))
            .collect::<Vec<_>>()
            .join(",");
        format!("[{body}]")
    }

    // Replace the contents from a JSON array. Malformed input is ignored and the current list is left untouched.
    pub fn load_json(&mut self, json: &str) {
        let bytes = json.as_bytes();
        let mut i = 0;
        skip_ws(bytes, &mut i);
        if bytes.get(i) != Some(&b'[') {
            return;
        }
        i += 1;
        let mut next = HashSet::new();
        loop {
            skip_ws(bytes, &mut i);
            match bytes.get(i) {
                // Unterminated array: nothing is committed.
                None => return,
                Some(b']') => {
                    i += 1;
                    skip_ws(bytes, &mut i);
                    if i < bytes.len() {
                        return; // trailing garbage after the array
                    }
                    self.domains = next;
                    return;
                }
                Some(b'"') => match parse_string(json, &mut i) {
                    Some(domain) => {
                        next.insert(normalize(&domain));
                    }
                    None => return,
                },
                Some(b',') => i += 1,
                _ => return,
            }
        }
    }
}

fn normalize(domain: &str) -> String {
    domain.trim().trim_start_matches("www.").to_ascii_lowercase()
}

fn escape(domain: &str) -> String {
    domain
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn skip_ws(bytes: &[u8], i: &mut usize) {
    while *i < bytes.len() && (bytes[*i] as char).is_whitespace() {
        *i += 1;
    }
}

/// Decode one JSON string starting at the opening quote; `i` is left past
/// the closing quote.
fn parse_string(json: &str, i: &mut usize) -> Option<String> {
    let bytes = json.as_bytes();
    *i += 1;
    let mut out = String::new();
    while *i < bytes.len() {
        match bytes[*i] {
            b'"' => {
                *i += 1;
                return Some(out);
            }
            b'\\' => {
                *i += 1;
                out.push(match bytes.get(*i)? {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'/' => '/',
                    _ => return None,
                });
                *i += 1;
            }
            _ => match json[*i..].chars().next() {
                Some(c) if c != '"' && !c.is_control() => {
                    out.push(c);
                    *i += c.len_utf8();
                }
                _ => return None,
            },
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_domain_matches_subdomains() {
        let mut list = Allowlist::<Site>::new();
        list.add("example.com");
        assert!(list.matches("example.com"));
        assert!(list.matches("www.example.com"));
        assert!(list.matches("a.b.example.com"));
        assert!(!list.matches("notexample.com"));
        assert!(!list.matches("example.org"));
    }

    #[test]
    fn www_prefix_is_normalized() {
        let mut list = Allowlist::<Tracker>::new();
        list.add("www.example.com");
        assert!(list.matches("example.com"));
    }

    #[test]
    fn json_round_trip_is_stable() {
        let mut list = Allowlist::<Site>::new();
        list.add("example.com");
        list.add("b.com");
        let encoded = list.to_json();
        let mut other = Allowlist::<Site>::new();
        other.load_json(&encoded);
        assert_eq!(list.to_json(), other.to_json());
        assert!(other.matches("example.com"));
        assert!(other.matches("b.com"));
    }

    #[test]
    fn malformed_json_is_rejected() {
        let mut list = Allowlist::<Site>::new();
        list.add("keep.com");
        list.load_json("{not json");
        list.load_json("");
        // Unterminated arrays and trailing garbage must not commit.
        list.load_json("[\"dropped.com\"");
        list.load_json("[\"dropped.com\"]garbage");
        assert!(list.matches("keep.com"));
        assert!(!list.matches("dropped.com"));
    }

    #[test]
    fn escaped_domains_round_trip() {
        let mut list = Allowlist::<Site>::new();
        list.add("quo\"te.com");
        let encoded = list.to_json();
        let mut other = Allowlist::<Site>::new();
        other.load_json(&encoded);
        assert!(other.matches("quo\"te.com"));
    }
}
