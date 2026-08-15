# AdbloquRs

A Chrome/Edge ad blocker extension with a **Rust + WebAssembly** filtering engine. Blocks ads and tracking requests, with YouTube video ad removal.

> ⚠️ **Current Issues:** YouTube ads may still appear (YouTube actively fights ad blockers). Some web ads still show because the engine only does network-level blocking (no cosmetic filtering). See `MAKING.md` for full details.

---

## Quick Start (Pre-built Extension)

If you just want to install the extension without building from source:

1. Download the latest release or clone this repo
2. Open `chrome://extensions` in Chrome or Edge
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder from this repo
6. Done! The extension icon appears in your toolbar

> The `extension/pkg/` folder contains pre-built WASM artifacts, so no Rust toolchain is needed for basic use.

---

## Build From Source

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| Rust | stable | [rustup.rs](https://rustup.rs) |
| wasm-pack | latest | `cargo install wasm-pack` |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |

### Build Commands

```bash
# Install npm dependencies
npm install

# Build the WASM engine (Rust → WebAssembly)
npm run build:wasm

# Build the popup UI
npm run build:popup

# Or build everything at once
npm run build:wasm && npm run build:popup
```

### Load in Browser

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click **reload ↻** on the extension card after rebuilding

---

## Features

| Feature | Status |
|---------|--------|
| Block ads (EasyList + baseline rules) | ✅ |
| Block tracking requests & beacons | ✅ |
| Site allowlist (pause on specific sites) | ✅ |
| Per-domain tracker allowlist | ✅ |
| Pause / resume all blocking | ✅ |
| YouTube video ad removal (IMA SDK spoof) | ⚠️ Works for most cases |
| Anti-adblock popup removal | ✅ |
| DNR rules for real request cancellation | ✅ |
| Runtime EasyList/EasyPrivacy refresh | ❌ Not yet |
| Cosmetic filtering (hide ad placeholders) | ❌ Not yet |

---

## Known Issues

See `MAKING.md` for detailed developer documentation on:

- **YouTube ads still appearing** — YouTube evolves its ad infrastructure; the IMA SDK spoof may not cover all ad formats
- **Web ads not blocked** — No cosmetic filtering; outdated rule lists; first-party ad serving
- Architecture details and troubleshooting

---

## Development

### Project Structure

```
├── extension/                  # The Chrome extension (load this folder)
│   ├── manifest.json          # MV3 manifest
│   ├── background/
│   │   ├── service-worker.js  # Main extension logic
│   │   ├── google-ima-shim.js # YouTube IMA SDK spoof (MAIN world)
│   │   └── youtube-ad-remover.js # DOM fallback for YouTube ads
│   ├── rules.json             # Static DNR rules (blocks imasdk)
│   ├── pkg/                   # Pre-built WASM artifacts
│   └── icons/                 # Extension icons
├── rust-adblock/              # Rust ad-blocking engine
│   ├── src/
│   │   ├── lib.rs             # Crate root
│   │   ├── engine.rs          # AdblockEngine (WASM-exported)
│   │   ├── dnr.rs             # DNR rule management
│   │   └── whitelist.rs       # Allowlist logic
│   ├── Cargo.toml
│   └── build.rs               # EasyList cosmetic rule stripper
├── src/popup/                 # React popup UI (Chakra UI)
├── scripts/                   # Test scripts
├── making.md                  # Developer guide & known issues
└── package.json
```

### Running Tests

```bash
cd rust-adblock && cargo test        # Rust unit tests
cargo clippy --all-targets           # Lint check
cd .. && npm run test:smoke          # End-to-end smoke tests
npx tsc --noEmit -p tsconfig.app.json  # TypeScript typecheck
```

### Tech Stack

- **Engine:** Rust compiled to WebAssembly via wasm-pack
- **Extension:** Chrome Manifest V3
- **Popup UI:** React + Chakra UI
- **Filter Lists:** EasyList, EasyPrivacy, Turtlecute host list

---

## License

See individual files for license information. The IMA SDK shim is MPL-2.0 (from uBlock Origin/Mozilla).
