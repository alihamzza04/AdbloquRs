# AdbloquRs — Developer Guide

> **Purpose:** This document explains the architecture, known issues, and
> troubleshooting steps for the AdbloquRs Chrome extension. **Read this first
> before making changes.**

---

## ⚠️ KNOWN ISSUES (READ FIRST)

### 1. YouTube Ads Are Still Uncontrollable

**Problem:** YouTube video ads still appear for many users despite the IMA SDK
shim being in place.

**Root Causes:**
- YouTube actively evolves its ad-serving infrastructure. The current IMA SDK
  spoof (`google-ima-shim.js`) may not intercept newer ad formats.
- The shim only covers the IMA SDK path — YouTube may be using alternative ad
  injection mechanisms (server-side ad insertion, mid-roll injection via
  player API).
- The `youtube-ad-remover.js` DOM fallback is reactive (detects ad DOM elements
  after they appear) rather than proactive.

**Current Approach:**
- `google-ima-shim.js` runs in MAIN world at `document_start` and spoofs
  `window.google.ima` so YouTube's ad player thinks ads loaded and completed
  instantly.
- `rules.json` statically blocks `imasdk.googleapis.com` on YouTube pages.
- `youtube-ad-remover.js` does DOM-level fallback (skip/seek, popup removal).

**What Needs Work:**
- YouTube's ad player may bypass the IMA SDK entirely in newer versions.
- Server-side ad insertion (SSAI) serves ads as regular video segments that
  cannot be distinguished from content at the network level.
- The anti-adblock detection (`ytd-enforcement-message-view-model`) keeps
  evolving.

### 2. Most Web Ads Still Showing

**Problem:** Many ads on non-YouTube websites are not being blocked.

**Root Causes:**
- The engine only does **network-level blocking** (no cosmetic filtering).
  Cosmetic rules from EasyList are stripped at build time.
- Some ad networks use first-party serving (ads served from the same domain
  as content), making network-level rules ineffective.
- The engine's rule coverage depends on the bundled EasyList snapshot
  (202608120629) which may be outdated.
- DNR (declarativeNetRequest) rules have a 10,000 rule limit per extension,
  and the FIFO eviction may drop needed rules.
- Some ads are loaded via JavaScript that the extension cannot intercept.

**What Needs Work:**
- Runtime EasyList/EasyPrivacy downloads and periodic refresh.
- Consider adding cosmetic filtering capability.
- Improve DNR rule efficiency (better host-level rules, fewer individual rules).
- Handle first-party ad serving patterns.

---

## Architecture Overview

```
┌──────────────────────────── browser extension ────────────────────────────┐
│  popup (React, Chakra)  ──messages──▶  service worker (MV3)               │
│                                            │  chrome.webRequest           │
│                                            ▼                              │
│                                      WASM engine (adblocker-wasm)         │
│                              ┌───────────┴──────────────┐                 │
│                              │ ads engine   │ tracking  │                 │
│                              │ (EasyList)   │ engine    │                 │
│                              └───────────┬──────────────┘                 │
│                                          │ allowlists + pause state       │
│                                      chrome.storage.local                 │
│                                                                           │
│  content script (YouTube)  ───────────▶  google-ima-shim.js (MAIN world)  │
│  (on *.youtube.com)          spoofs the IMA SDK so ads never render       │
│                               + youtube-ad-remover.js (DOM fallback)      │
│  static DNR rule (rules.json)  blocks imasdk.googleapis.com on YT pages   │
└───────────────────────────────────────────────────────────────────────────┘
```

## Repo Layout

| Path | Purpose |
| --- | --- |
| `rust-adblock/src/lib.rs` | Crate root: module wiring, `crate_version()` export |
| `rust-adblock/src/engine.rs` | `AdblockEngine` (WASM-exported), `BlockReason`, stats, host parsing, DNR bindings |
| `rust-adblock/src/dnr.rs` | declarativeNetRequest rule cache: host rules, resource types, FIFO eviction, allowlist sync |
| `rust-adblock/src/whitelist.rs` | Generic `Allowlist<T>` with parent-domain matching |
| `rust-adblock/build.rs` | Strips cosmetic rules from EasyList before WASM embedding |
| `rust-adblock/src/baseline_rules.txt` | Bundled EasyList-style fallback (ad networks) |
| `rust-adblock/src/easylist.txt` | Full EasyList snapshot (202608120629) — compiled into WASM |
| `rust-adblock/src/tracking_rules.txt` | Bundled EasyPrivacy-style fallback (analytics, trackers) |
| `rust-adblock/src/turtlecute_rules.txt` | Bundled Turtlecute host list (ads + analytics + OEM trackers) |
| `extension/background/service-worker.js` | Owns the engine, intercepts requests, persists state |
| `extension/background/google-ima-shim.js` | MAIN-world content script: spoofs the IMA SDK for YouTube |
| `extension/background/youtube-ad-remover.js` | Isolated-world content script: DOM fallback for YouTube |
| `extension/rules.json` | Static DNR ruleset: blocks imasdk.googleapis.com on YouTube |
| `extension/manifest.json` | MV3 manifest with MAIN-world content script for YouTube |
| `extension/popup.html`, `src/popup/` | React popup UI (warm beige theme) |
| `extension/pkg/` | Generated WASM artifacts + JS glue (committed; see "Build") |

## Two Filter Engines

**Ads engine:** Fed from `baseline_rules.txt` + full EasyList at construction.
Network-level blocking only — cosmetic rules are stripped at build time.

**Tracking engine:** Fed from `tracking_rules.txt` + `turtlecute_rules.txt`.
Blocks analytics, beacons, and tracking pixels.

Priority inside `evaluate(url, source, type)`:
1. Paused → allow
2. Source host in site allowlist → allow (whole page)
3. Request host in tracker allowlist → allow (that domain only)
4. Ads engine match → block (`Ad`)
5. Tracking engine match → block (`Tracker`)

## YouTube Ad Removal

YouTube video ads are **NOT network-blocked** — they come from the same
infrastructure as content. Instead:

1. `google-ima-shim.js` (MAIN world, `document_start`) defines fake
   `window.google.ima` — when YouTube requests an ad break, the fake
   `AdsLoader` instantly fires `LOADED → COMPLETE → ALL_ADS_COMPLETED →
   CONTENT_RESUME_REQUESTED`, so the player returns to content with no ad.
2. `rules.json` blocks `imasdk.googleapis.com` so the real SDK never loads.
3. `youtube-ad-remover.js` is a conservative DOM fallback (skip button click,
   seek past ads, anti-adblock popup removal).

**This is the same technique AdGuard and uBlock Origin use.**

## DNR Rules (Real Request Cancellation in MV3)

Chrome MV3 cannot cancel requests from `webRequest`, so every blocked verdict
becomes a host-level `declarativeNetRequest` rule (`||host^`) that Chrome
enforces. Rule management lives in `dnr.rs`:
- Host normalization and resource-type tracking
- FIFO eviction under a 10k-rule cap
- Allowlist reconciliation
- Each update removes affected IDs and re-adds them in the same call

## Build

```bash
# 1. Compile the engine to WASM (outputs extension/pkg/*)
cd rust-adblock
wasm-pack build --target web --out-dir ../extension/pkg --release

# 2. Build the popup (outputs extension/popup.js)
cd ..
npm install
npm run build:popup
```

## Testing

```bash
cd rust-adblock && cargo test    # 33 unit tests
cargo clippy --all-targets       # must be warning-free
cd .. && npm run test:smoke      # 57 end-to-end checks
npx tsc --noEmit -p tsconfig.app.json   # TypeScript typecheck
npm run build:popup              # build the popup bundle
```

## Troubleshooting

### YouTube ads still show

1. Is the extension paused, or is youtube.com in the site allowlist?
2. Is the IMA shim active? On YouTube page console run
   `window.google.ima.VERSION` — a version string means the shim loaded.
   `undefined` means the content script isn't running.
3. Is the real SDK getting through? Check Network tab for
   `imasdk.googleapis.com`.
4. Brief black frame / buffering hitch = shim working (fake ad break
   completing).

### Nothing is blocked anywhere

Check the popup: if *Paused*, resume. A site in the allowlist bypasses
everything. Look for `engine ready: … ad rules, … tracking rules` in the
service worker console.

### Rule with id X does not have a unique ID

Chrome rejects duplicate rule IDs in dynamic ruleset. Reload the extension —
stale rules self-heal on startup (import → remove all → re-add all).

## Feature Status

| Feature | Status |
| --- | --- |
| Block ads (baseline + full EasyList) | ✅ Done |
| Site allowlist + move back to blocklist | ✅ Done |
| Block tracking requests and beacons | ✅ Done |
| Per-domain tracker allowlist + move back | ✅ Done |
| Pause / resume all blocking | ✅ Done |
| Runtime list updates (`add_rules`) | ✅ Done |
| YouTube video ad removal | ⚠️ Improved — IMA spoof + static block + DOM fallback; **YouTube may still show ads** |
| Anti-adblock popup removal | ✅ Done |
| YouTube ad stats in popup | ✅ Done |
| DNR rules (real request cancellation) | ✅ Done |
| Runtime EasyList/EasyPrivacy refresh | ❌ Not yet |
| Cosmetic filtering (hide ad elements) | ❌ Not yet |
| Firefox support | ❌ Not yet |

---

## Next Steps for Other Agents

If you are picking up this project, here are the priorities:

1. **YouTube ads** — The IMA spoof is fragile. YouTube changes frequently.
   Test on real traffic. Consider:
   - Hooking into the player API directly (e.g., intercepting
     `ytInitialPlayerResponse`)
   - Blocking SSAI ad segments
   - Improving the anti-adblock detection removal

2. **Web ads still showing** — The main gaps are:
   - No cosmetic filtering (ad placeholders still visible)
   - Outdated rule lists
   - First-party ad serving not covered
   - DNR rule limit causing eviction

3. **Runtime rule updates** — Download EasyList/EasyPrivacy from `easylist.to`
   on install and periodically. The engine API (`add_rules` /
   `add_tracking_rules`) is ready; just needs fetch logic.

4. **Firefox support** — `webRequest.onBeforeRequest` can return
   `{ cancel: true }` directly, so the DNR layer can be skipped.
