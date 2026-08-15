// End-to-end smoke test for the compiled extension artifacts. Run from the
// repo root with: node scripts/smoke-test.mjs
//
// 1. Loads extension/pkg/adblocker_wasm_bg.wasm directly via initSync and
//    exercises every exported binding against a request matrix.
// 2. Exercises the google-ima shim (extension/background/google-ima-shim.js)
//    in a minimal fake-browser harness: YouTube's IMA ad lifecycle must
//    "complete" instantly with no ad rendered.

import { readFileSync } from "node:fs"
import {
  initSync,
  AdblockEngine,
  BlockReason,
  crate_version,
} from "../extension/pkg/adblocker_wasm.js"

let failures = 0

function check(label, actual, expected) {
  const pass = actual === expected
  if (!pass) failures += 1
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` (got ${actual}, want ${expected})`}`)
}

// initSync takes the raw bytes directly, so no fetch is involved; this
// mirrors what the service worker does in a browser context.
const bytes = readFileSync(
  new URL("../extension/pkg/adblocker_wasm_bg.wasm", import.meta.url),
)
initSync({ module: bytes })

check("crate_version", typeof crate_version(), "string")

const engine = new AdblockEngine()
check("ad rules loaded", engine.rule_count > 0, true)
check("tracking rules loaded", engine.tracking_rule_count > 0, true)

const ads = {
  url: "https://ad.doubleclick.net/banner.gif",
  source: "https://news.example.com",
  type: "script",
}
const tracker = {
  url: "https://www.google-analytics.com/collect",
  source: "https://shop.example.com",
  type: "xhr",
}
const beacon = {
  url: "https://api.mixpanel.com/beacon",
  source: "https://shop.example.com",
  type: "ping",
}
const benign = {
  url: "https://shop.example.com/app.css",
  source: "https://shop.example.com",
  type: "stylesheet",
}

check("ad blocked", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Ad)
check("tracker blocked", engine.evaluate(tracker.url, tracker.source, tracker.type), BlockReason.Tracker)
check("beacon blocked", engine.check_beacon(beacon.url, beacon.source), true)
check("benign allowed", engine.evaluate(benign.url, benign.source, benign.type), BlockReason.Allow)

// Site allowlist bypasses both lists, including for subdomains.
engine.add_site_to_allowlist("news.example.com")
check("site allowlist wins", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Allow)
check("site allowlist covers subdomain", engine.evaluate(ads.url, "https://www.news.example.com", ads.type), BlockReason.Allow)
engine.move_site_to_blocklist("news.example.com")
check("site moved back to blocklist", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Ad)

// Tracker allowlist overrides the ad list too (user exception wins).
engine.add_tracking_domain("doubleclick.net")
check("tracker exception wins", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Allow)
engine.move_tracking_to_blocklist("doubleclick.net")
check("tracker moved back to blocklist", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Ad)

// Stats and pause.
check("stats: ads", engine.ads_blocked, 3)
check("stats: trackers", engine.trackers_blocked, 2)
check("stats: checked", engine.requests_checked, 9)
engine.pause_blocking()
check("pause allows", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Allow)
engine.resume_blocking()
check("resume blocks", engine.evaluate(ads.url, ads.source, ads.type), BlockReason.Ad)

// Allowlist JSON round-trip through the exported bindings.
engine.set_site_allowlist('["example.com"]')
check("site allowlist json set", engine.is_site_allowlisted("www.example.com"), true)
const sites = engine.get_site_allowlist()
check("site allowlist json get", sites, '["example.com"]')

// Runtime rule append. The site allowlist from the JSON round-trip above
// would mask this request (example.com covers x.example.com), so clear it.
engine.set_site_allowlist("[]")
const before = engine.rule_count
engine.add_rules("||myads.test.example^\n")
check("rule append", engine.rule_count, before + 1)
check("new rule blocks", engine.evaluate("https://myads.test.example/x.js", "https://x.example.com", "script"), BlockReason.Ad)

engine.reset_stats()
check("stats reset", engine.requests_checked, 0)

// --- host_from_url: no JS URL object needed on the blocked-request path ---
check("host_from_url", engine.host_from_url("https://www.example.com/x?q=1#f"), "www.example.com")
check("host_from_url strips userinfo/port", engine.host_from_url("https://u:p@example.com:8080/x"), "example.com")
check("host_from_url invalid", engine.host_from_url("not a url"), undefined)

// --- DNR rule cache: the engine now owns the rule bookkeeping ---
let payload = JSON.parse(engine.dnr_ensure("ads.example.com", "script"))
check("dnr_ensure adds a rule", payload.addRules.length, 1)
check("dnr_ensure rule filter", payload.addRules[0].condition.urlFilter, "||ads.example.com^")
check("dnr_ensure rule types", payload.addRules[0].condition.resourceTypes.join(","), "script")
check("dnr_ensure no removals", payload.removeRuleIds.length, 0)
check("dnr_ensure no-op on repeat", engine.dnr_ensure("ads.example.com", "script"), "")
payload = JSON.parse(engine.dnr_ensure("ads.example.com", "image"))
check("dnr_ensure extends types", payload.addRules[0].condition.resourceTypes.join(","), "image,script")
check("dnr_ensure skips main_frame", engine.dnr_ensure("ads.example.com", "main_frame"), "")

// sync: a tracker-allowlisted host's rule is dropped
engine.add_tracking_domain("ads.example.com")
payload = JSON.parse(engine.dnr_sync())
check("dnr_sync removes allowlisted host", payload.removeRuleIds.join(","), "1")
check("dnr_sync no re-adds", payload.addRules.length, 0)
engine.move_tracking_to_blocklist("ads.example.com")
check("dnr_sync no-op when unchanged", engine.dnr_sync(), "")

// pause / resume payloads
engine.dnr_ensure("ads.example.com", "script")
payload = JSON.parse(engine.dnr_pause_payload())
check("dnr_pause removes cached rules", payload.removeRuleIds.join(","), "2")
payload = JSON.parse(engine.dnr_resume_payload())
check("dnr_resume re-adds rules", payload.addRules.length, 1)

// import: seed from Chrome's persisted rules after a worker restart
const engine2 = new AdblockEngine()
engine2.dnr_import("restored.example.com", 7, ["script"])
check("dnr_import seeds the cache", engine2.dnr_rule_count, 1)
check("dnr_import next id continues", JSON.parse(engine2.dnr_ensure("new.example.com", "xhr")).addRules[0].id, 8)

// --- Turtlecute host list (bundled into the tracking engine) ---
check("turtlecute: adcolony blocked as Ad (EasyList too)", engine.evaluate("https://ads30.adcolony.com/banner.gif", "https://news.example.com", "image"), BlockReason.Ad)
check("turtlecute: hotjar blocked as Tracker", engine.evaluate("https://script.hotjar.com/modules.js", "https://shop.example.com", "script"), BlockReason.Tracker)
check("turtlecute: xiaomi blocked as Tracker", engine.evaluate("https://data.mistat.xiaomi.com/collect", "https://shop.example.com", "xhr"), BlockReason.Tracker)
check("turtlecute: test-site 3p rule", engine.evaluate("https://unknown-tracker.example.net/beacon", "https://adblock.turtlecute.org", "xhr"), BlockReason.Tracker)
check("turtlecute: test-site pagead.js", engine.evaluate("https://adblock.turtlecute.org/pagead.js", "https://adblock.turtlecute.org", "script"), BlockReason.Tracker)
check("turtlecute: no leak off the test site", engine.evaluate("https://unknown-tracker.example.net/beacon", "https://news.example.com", "xhr"), BlockReason.Allow)

// ---------------------------------------------------------------------------
// google-ima shim: YouTube's IMA SDK is replaced with a stub that instantly
// "completes" every ad break, so the player never renders an ad.
// ---------------------------------------------------------------------------
{
  const shimSource = readFileSync(
    new URL("../extension/background/google-ima-shim.js", import.meta.url),
    "utf8",
  )

  // Minimal fake-browser globals. requestAnimationFrame fires synchronously
  // so the shim's async event dispatch is deterministic in the test.
  globalThis.window = {}
  globalThis.document = {
    createElement: () => ({
      style: { setProperty() {} },
      appendChild() {},
    }),
  }
  globalThis.requestAnimationFrame = (cb) => cb()

  // Run the shim in global scope, like a classic <script> in the MAIN world.
  ;(0, eval)(shimSource)

  const ima = window.google.ima
  check("shim defines google.ima", !!ima, true)
  check("shim reports a version", typeof ima.VERSION, "string")

  // Simulate YouTube's player: build an AdsLoader, request an ad break, and
  // listen for the manager + lifecycle events.
  const loader = new ima.AdsLoader()
  const loaderEvents = []
  let adsManager = null
  loader.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (e) => {
    loaderEvents.push("adsManagerLoaded")
    adsManager = e.getAdsManager()
  })
  loader.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, () => loaderEvents.push("adError"))
  loader.requestAds(new ima.AdsRequest(), {})

  check("requestAds -> adsManagerLoaded", loaderEvents.includes("adsManagerLoaded"), true)
  check("requestAds -> adError fallback", loaderEvents.includes("adError"), true)
  check("getAdsManager returns a manager", !!adsManager, true)

  // Starting the manager must fire the whole lifecycle instantly so the
  // player returns to content with no visible ad.
  const adEvents = []
  adsManager.addEventListener(ima.AdEvent.Type.STARTED, () => adEvents.push("started"))
  adsManager.addEventListener(ima.AdEvent.Type.COMPLETE, () => adEvents.push("complete"))
  adsManager.addEventListener(ima.AdEvent.Type.ALL_ADS_COMPLETED, () => adEvents.push("allAdsCompleted"))
  adsManager.addEventListener(ima.AdEvent.Type.CONTENT_RESUME_REQUESTED, () => adEvents.push("contentResume"))
  adsManager.init(640, 360, ima.ViewMode.NORMAL)
  adsManager.start()

  check("manager.start -> started", adEvents.includes("started"), true)
  check("manager.start -> complete", adEvents.includes("complete"), true)
  check("manager.start -> allAdsCompleted", adEvents.includes("allAdsCompleted"), true)
  check("manager.start -> contentResume", adEvents.includes("contentResume"), true)
  check("no ad time remaining", adsManager.getRemainingTime(), 0)
  check("current ad object present", !!adsManager.getCurrentAd(), true)

  // The shim must never clobber a real SDK that is already present.
  window.google = { ima: { VERSION: "real-sdk" } }
  ;(0, eval)(shimSource)
  check("shim leaves an existing SDK alone", window.google.ima.VERSION, "real-sdk")
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
