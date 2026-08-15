mod dnr;
mod engine;
mod whitelist;

pub use engine::{AdblockEngine, BlockReason};

use wasm_bindgen::prelude::*;

/// Version string reported to JS callers for display in the popup.
#[wasm_bindgen]
pub fn crate_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
