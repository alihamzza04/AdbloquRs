mod dnr;
mod engine;
mod whitelist;
mod youtube;

pub use engine::{AdblockEngine, BlockReason};
pub use youtube::{
    analyze_youtube_player_response,
    is_in_ad_segment,
    get_skip_position_for_ad,
};

use wasm_bindgen::prelude::*;

/// Version string reported to JS callers for display in the popup.
#[wasm_bindgen]
pub fn crate_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
