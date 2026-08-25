//! Preprocesses the bundled EasyList before it is embedded into the WASM
//! binary via `include_str!`.
//!
//! The engine only performs network filtering (`check_network_request`), so
//! the cosmetic rules (the `##` / `#@#` / `#?#` / `#$#` / `#%#` selectors
//! that make up roughly a third of EasyList) are dead weight. Dropping them
//! here — rather than only at parse time — shrinks the shipped WASM binary,
//! the parse time, and the runtime memory footprint. Network rules and list
//! directives (`!` comments, `!#if` blocks) are kept verbatim.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=src/easylist.txt");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let src = fs::read_to_string("src/easylist.txt").expect("read src/easylist.txt");

    let filtered = src
        .lines()
        .filter(|line| !is_cosmetic(line))
        .collect::<Vec<_>>()
        .join("\n");

    fs::write(out_dir.join("easylist_network.txt"), filtered).expect("write filtered EasyList");
}

/// True for cosmetic rules and scriptlet injections. Network rules never
/// contain these markers, so a line-level check is exact.
fn is_cosmetic(line: &str) -> bool {
    line.contains("##")
        || line.contains("#@#")
        || line.contains("#?#")
        || line.contains("#$#")
        || line.contains("#%#")
}
