# Install AdbloquRs

## Option 1: Use Pre-built Extension (Easiest)

1. **Download** this repository (Code → Download ZIP, or `git clone`)
2. **Extract** the ZIP if you downloaded one
3. **Open Chrome** and go to `chrome://extensions`
4. **Enable Developer mode** — toggle in the top-right corner
5. **Click "Load unpacked"** button (top-left)
6. **Select the `extension/` folder** from the downloaded/cloned repository
7. **Done!** The AdbloquRs icon appears in your toolbar

### That's it! No coding required.

The `extension/pkg/` folder already contains the pre-built WebAssembly engine, so you don't need Rust or any build tools.

---

## Option 2: Build From Source

If you want to modify the code or contribute:

### Requirements

- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://rustup.rs) (stable)
- `wasm-pack`: `cargo install wasm-pack`
- `wasm32` target: `rustup target add wasm32-unknown-unknown`

### Steps

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/AdbloquRs.git
cd AdbloquRs

# Run the setup script (installs everything + builds)
chmod +x setup.sh
./setup.sh

# Or manually:
npm install
npm run build:wasm    # Build the Rust WASM engine
npm run build:popup   # Build the React popup UI
```

Then load `extension/` in Chrome as described in Option 1.

### Rebuilding After Changes

```bash
./build.sh            # Rebuild everything
./build.sh wasm       # Rebuild only the WASM engine (Rust changes)
./build.sh popup      # Rebuild only the popup (UI changes)
```

After rebuilding, click the **reload ↻** button on the extension card in `chrome://extensions`.

---

## Updating the Extension

1. Pull the latest changes: `git pull`
2. If Rust files changed: `npm run build:wasm`
3. If popup/UI changed: `npm run build:popup`
4. Go to `chrome://extensions` and click **reload ↻** on the AdbloquRs card

---

## Troubleshooting

**Extension icon doesn't appear:**
- Make sure you selected the `extension/` folder (not the repo root)

**"Failed to load extension" error:**
- Make sure Developer mode is enabled
- Check the Errors link on the extension card

**YouTube ads still showing:**
- This is a known issue — YouTube actively fights ad blockers
- See `MAKING.md` for details and status

**No ads being blocked:**
- Check the popup — if it says "Paused", click Resume
- Check if the site is in the allowlist
- Open the extension's service worker console for errors
