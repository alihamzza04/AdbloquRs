#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# AdbloquRs — One-click setup & build script
# ============================================================
# This script installs dependencies and builds the extension.
# Run it once after cloning the repo.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---- Check prerequisites ----

check_command() {
  if ! command -v "$1" &> /dev/null; then
    error "$1 is not installed. $2"
  fi
}

info "Checking prerequisites..."

check_command node "Install from https://nodejs.org (requires Node.js >= 20)"
check_command rustc "Install from https://rustup.rs"
check_command cargo "Install from https://rustup.rs"

# Check Node version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js >= 20 is required (found v$(node -v | sed 's/v//'))"
fi
info "Node.js $(node -v) ✓"

# Check Rust
info "Rust $(rustc --version) ✓"

# ---- Install wasm-pack if missing ----

if ! command -v wasm-pack &> /dev/null; then
  info "Installing wasm-pack..."
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
fi
info "wasm-pack $(wasm-pack --version) ✓"

# ---- Add wasm32 target if missing ----

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  info "Adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi
info "wasm32-unknown-unknown target ✓"

# ---- Install npm dependencies ----

info "Installing npm dependencies..."
npm install

# ---- Build WASM engine ----

info "Building WASM engine (this may take a few minutes on first run)..."
cd rust-adblock
wasm-pack build --target web --out-dir ../extension/pkg --release

# Run wasm-opt if available
if command -v wasm-opt &> /dev/null || npx wasm-opt --version &> /dev/null 2>&1; then
  info "Optimizing WASM with wasm-opt..."
  npx wasm-opt -Oz --enable-bulk-memory --enable-sign-ext \
    -o ../extension/pkg/adblocker_wasm_bg.opt.wasm \
    ../extension/pkg/adblocker_wasm_bg.wasm && \
  mv ../extension/pkg/adblocker_wasm_bg.opt.wasm \
     ../extension/pkg/adblocker_wasm_bg.wasm || true
fi

cd ..

# ---- Build popup UI ----

info "Building popup UI..."
npm run build:popup

# ---- Done ----

echo ""
info "=========================================="
info "  Build complete!"
info "=========================================="
echo ""
echo "  To install the extension:"
echo "  1. Open chrome://extensions in Chrome/Edge"
echo "  2. Enable 'Developer mode' (top right)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select the 'extension/' folder"
echo ""
echo "  After rebuilding, click the ↻ reload button"
echo "  on the extension card in chrome://extensions"
echo ""
