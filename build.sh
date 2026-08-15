#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# AdbloquRs — Rebuild script
# ============================================================
# Use this after making changes to rebuild the extension.
#
# Usage:
#   ./build.sh          # rebuild everything
#   ./build.sh wasm     # rebuild only the WASM engine
#   ./build.sh popup    # rebuild only the popup UI
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

TARGET="${1:-all}"

build_wasm() {
  info "Building WASM engine..."
  cd rust-adblock
  wasm-pack build --target web --out-dir ../extension/pkg --release

  if command -v wasm-opt &> /dev/null || npx wasm-opt --version &> /dev/null 2>&1; then
    info "Optimizing WASM..."
    npx wasm-opt -Oz --enable-bulk-memory --enable-sign-ext \
      -o ../extension/pkg/adblocker_wasm_bg.opt.wasm \
      ../extension/pkg/adblocker_wasm_bg.wasm && \
    mv ../extension/pkg/adblocker_wasm_bg.opt.wasm \
       ../extension/pkg/adblocker_wasm_bg.wasm || true
  fi
  cd ..
  info "WASM build complete ✓"
}

build_popup() {
  info "Building popup UI..."
  npm run build:popup
  info "Popup build complete ✓"
}

case "$TARGET" in
  wasm)
    build_wasm
    ;;
  popup)
    build_popup
    ;;
  all)
    build_wasm
    build_popup
    ;;
  *)
    error "Unknown target: $TARGET (use: wasm, popup, or all)"
    ;;
esac

echo ""
info "Done! Reload the extension in chrome://extensions to see changes."
