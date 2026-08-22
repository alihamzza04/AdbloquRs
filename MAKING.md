# AdbloquRs — Developer Guide

> **Purpose:** This document explains the architecture, known issues, and
> troubleshooting steps for the AdbloquRs Chrome extension. **Read this first
> before making changes.**

---

## ⚠️ KNOWN ISSUES (READ FIRST)

### 1. ~~YouTube Ads Are Still Uncontrollable~~ (Fixed in v7)

**Previous Problem:** YouTube video ads still appear for many users despite the IMA SDK
shim being in place.

**Root Causes (Fixed in v7):**
- The old approach tried to fake a complex event sequence that YouTube's player
  validates internally. YouTube detects fake events and shows ads anyway.
- The DOM fallback was too late — ads were already visible before detection.

**New Approach (v7 - Aggressive disable + network interception):**
- `google-ima-shim.js` completely disables the IMA SDK by stubbing out
  `AdsManager.start()` and `AdsLoader.requestAds()` as no-ops.
- Intercepts `fetch()` and `XMLHttpRequest` to block ad network domains
  at the network level before requests are made.
- Injects CSS to hide all ad elements (containers, overlays, promoted content).
- Removes ad scripts from the DOM when they appear.

**What Was Done:**
- Rewrote `google-ima-shim.js` with aggressive SDK disable + fetch/XHR interception.
- Simplified `youtube-ad-remover.js` with better CSS hiding and DOM cleanup.
- Updated DNR rules for broader YouTube ad network blocking.

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

### 3. YouTube "Ask" AI Feature Not Working

**Problem:** The YouTube AI "Ask" feature (Gemini-powered) does not respond
when clicked. The button is visible but clicking produces no action.

**Root Causes (Investigated):**
- The v7 rewrite introduced fetch/XHR interception that wraps all network
  requests. Even with an allowlist for Google AI domains, the wrapper may
  interfere with the AI feature's request/response cycle.
- The AI feature likely uses streaming responses (Server-Sent Events or
  ReadableStream) which our fetch wrapper does not handle correctly —
  it only returns a static `{}` Response.
- The AI feature may depend on specific `window.google` properties or
  YouTube-internal globals that our IMA stub overwrites.
- The AI feature may use `yt.config` or `ytcfg` data that gets corrupted
  by our MAIN-world script running before YouTube's initialization.

**What Needs Work:**
- Investigate the exact API endpoint the AI feature uses (likely
  `youtube.com/youtubei/v1/ask` or `generativelanguage.googleapis.com`).
- Ensure the fetch wrapper preserves streaming responses and ReadableStreams.
- Audit whether our MAIN-world script clobbers any YouTube globals needed
  by the AI feature beyond `window.google.ima`.
- Consider scoping fetch/XHR interception to only active ad-loading states
  rather than wrapping all requests globally.

### 4. YouTube Shop Ads Still Appearing

**Problem:** YouTube "Shop" ads (product listing overlays, shopping
banners, and product shelf ads) still appear despite ad blocking.

**Root Causes:**
- YouTube Shop ads are served from first-party YouTube infrastructure
  (`youtube.com/shopping/*`, `shopping.youtube.com`) rather than external
  ad networks, so they bypass network-level blocking.
- Shop ad elements use different DOM selectors than standard video ads:
  `ytd-product-renderer`, `ytd-shelf-renderer[shelf-type*="shopping"]`,
  `yt购物shelf-renderer`, and dynamic classes that change frequently.
- The current CSS rules don't target shopping-specific ad elements.
- Shop ads may be injected via client-side rendering (Web Components)
  that aren't caught by MutationObserver timing.

**What Needs Work:**
- Add CSS rules targeting YouTube Shopping ad elements:
  - `ytd-product-renderer`
  - `ytd-shelf-renderer[shelf-type*="shopping"]`
  - `ytd-compact-shopping-list-renderer`
  - `ytd-rich-section-renderer:has(ytd-shelf-renderer[shelf-type*="shopping"])`
- Add DNR rules to block `youtube.com/shopping/*` and
  `shopping.youtube.com` requests.
- Monitor YouTube's shopping ad DOM for selector changes.

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
4. v7 fix: IMA SDK is now completely disabled (no-op). If ads still show,
   check the service worker console for `[AdbloquRs]` logs.
5. The content script now intercepts fetch/XHR to block ad domains.
   If you see ad network requests in Network tab, the interception
   isn't working — reload the extension.

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
| YouTube video ad removal | ✅ Fixed v7 — Aggressive IMA disable + fetch/XHR interception + DOM fallback |
| Anti-adblock popup removal | ✅ Done |
| YouTube ad stats in popup | ✅ Done |
| DNR rules (real request cancellation) | ✅ Done |
| YouTube "Ask" AI feature | ⚠️ Known issue — fetch wrapper breaks streaming/AI API calls |
| YouTube Shop ads | ⚠️ Known issue — first-party shopping ads bypass network blocking |
| Runtime EasyList/EasyPrivacy refresh | ❌ Not yet |
| Cosmetic filtering (hide ad elements) | ❌ Not yet |
| Firefox support | ❌ Not yet |

---

## Next Steps for Other Agents

If you are picking up this project, here are the priorities:

1. ~~**YouTube ads** — The IMA spoof is fragile.~~ (Fixed in v7)
   - Aggressive IMA SDK disable (start/requestAds as no-ops).
   - Fetch/XHR interception blocks ad network domains.
   - CSS injection hides all ad elements.
   - DOM cleanup removes ad scripts.

2. **YouTube "Ask" AI feature broken** — HIGH PRIORITY
   - The fetch/XHR wrapper in `google-ima-shim.js` likely breaks the AI
     feature's streaming API calls or clobbers YouTube globals.
   - Investigate the exact endpoint (likely `youtube.com/youtubei/v1/ask`).
   - The wrapper only returns static `{}` — it does not handle SSE or
     ReadableStream responses that the AI feature uses.
   - Consider scoping the interception to only active ad-loading states.

3. **YouTube Shop ads not blocked** — MEDIUM PRIORITY
   - Shopping ads come from first-party YouTube infrastructure, bypassing
     network-level blocking.
   - Need new CSS rules targeting shopping-specific elements.
   - Need DNR rules for `youtube.com/shopping/*` and `shopping.youtube.com`.

4. **Web ads still showing** — The main gaps are:
   - No cosmetic filtering (ad placeholders still visible)
   - Outdated rule lists
   - First-party ad serving not covered
   - DNR rule limit causing eviction

5. **Runtime rule updates** — Download EasyList/EasyPrivacy from `easylist.to`
   on install and periodically. The engine API (`add_rules` /
   `add_tracking_rules`) is ready; just needs fetch logic.

6. **Firefox support** — `webRequest.onBeforeRequest` can return
   `{ cancel: true }` directly, so the DNR layer can be skipped.
