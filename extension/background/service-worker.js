// Background service worker (Manifest V3).
//
// Owns the single WASM engine instance, feeds it every web request, and
// mirrors user state (pause flag, site allowlist, tracker allowlist) plus
// the block counters to chrome.storage.local so everything survives worker
// eviction.
//
// Blocking in MV3: chrome.webRequest is read-only in Chrome, so the engine's
// verdicts are converted into declarativeNetRequest dynamic rules — a
// host-level block that Chrome enforces for real. The engine remains the
// source of truth for verdicts and stats; the DNR rules are a cache of
// those verdicts. All of that rule bookkeeping (host normalization, resource
// types, FIFO eviction, allowlist reconciliation) lives in Rust: each call
// returns the exact `updateDynamicRules` payload to apply, or "" for a
// no-op. Chrome persists dynamic rules across worker evictions.

import init, {
  AdblockEngine,
  BlockReason,
  crate_version,
} from "../pkg/adblocker_wasm.js";

let engine = null;
let ready = null;

// chrome.webRequest resource types map onto the engine's request types as-is.
const RESOURCE_TYPES = {
  main_frame: "main_frame",
  sub_frame: "subdocument",
  stylesheet: "stylesheet",
  script: "script",
  image: "image",
  font: "font",
  object: "object",
  xhr: "xhr",
  ping: "ping",
  media: "media",
  websocket: "websocket",
  other: "other",
};

// ---------------------------------------------------------------------------
// Persistent stats
//
// The engine's counters live in WASM memory and reset to 0 whenever the
// worker is evicted. We keep a baseline in chrome.storage.local and fold the
// engine's in-memory counters into it (then reset them) so the popup always
// shows totals that survive restarts.
// ---------------------------------------------------------------------------

const STATS_KEYS = ["statsAdsBlocked", "statsTrackersBlocked", "statsChecked"];
let statsBaseline = { ads: 0, trackers: 0, checked: 0 };

async function loadStats() {
  const stored = await chrome.storage.local.get(STATS_KEYS);
  statsBaseline = {
    ads: stored.statsAdsBlocked || 0,
    trackers: stored.statsTrackersBlocked || 0,
    checked: stored.statsChecked || 0,
  };
}

async function mergeStats() {
  if (!engine) return;
  statsBaseline.ads += engine.ads_blocked;
  statsBaseline.trackers += engine.trackers_blocked;
  statsBaseline.checked += engine.requests_checked;
  engine.reset_stats();
  await chrome.storage.local.set({
    statsAdsBlocked: statsBaseline.ads,
    statsTrackersBlocked: statsBaseline.trackers,
    statsChecked: statsBaseline.checked,
  });
}

function currentStats() {
  return {
    adsBlocked: statsBaseline.ads + (engine ? engine.ads_blocked : 0),
    trackersBlocked:
      statsBaseline.trackers + (engine ? engine.trackers_blocked : 0),
    checkedCount: statsBaseline.checked + (engine ? engine.requests_checked : 0),
  };
}

async function resetAllStats() {
  statsBaseline = { ads: 0, trackers: 0, checked: 0 };
  if (engine) engine.reset_stats();
  await chrome.storage.local.set({
    statsAdsBlocked: 0,
    statsTrackersBlocked: 0,
    statsChecked: 0,
  });
}

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["paused", "siteAllowlist", "trackingAllowlist"],
      (stored) =>
        resolve({
          paused: !!stored.paused,
          siteAllowlist: stored.siteAllowlist || [],
          trackingAllowlist: stored.trackingAllowlist || [],
        }),
    );
  });
}

function saveState() {
  return chrome.storage.local.set({
    paused: engine.is_paused,
    siteAllowlist: JSON.parse(engine.get_site_allowlist()),
    trackingAllowlist: JSON.parse(engine.get_tracking_allowlist()),
  });
}

// ---------------------------------------------------------------------------
// declarativeNetRequest: real request cancellation
//
// The Rust engine owns the rule cache. The worker only parses the payload it
// produces and serializes the updateDynamicRules calls so Chrome state stays
// consistent. A "" payload means nothing changed and Chrome is left alone.
// ---------------------------------------------------------------------------

let dnrQueue = Promise.resolve();

function updateDnr(payload) {
  if (!payload) return dnrQueue;
  dnrQueue = dnrQueue
    .then(() => chrome.declarativeNetRequest.updateDynamicRules(payload))
    .catch((err) => console.error("[AdbloquRs] DNR update failed:", err));
  return dnrQueue;
}

// Rebuild the engine's rule cache from the rules Chrome already persisted
// (rules survive worker evictions; the in-memory cache does not).
async function initDnr() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  for (const rule of existing) {
    const filter = rule.condition?.urlFilter || "";
    const host = filter.replace(/^\|\|/, "").replace(/\^$/, "");
    if (!host || !rule.id) continue;
    engine.dnr_import(host, rule.id, rule.condition.resourceTypes || []);
  }
  // Refresh initiator exclusions against the restored allowlist and drop
  // rules for tracker-allowlisted hosts (no-op if nothing changed).
  updateDnr(JSON.parse(engine.dnr_sync() || "null"));
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

async function startEngine() {
  if (ready) return ready;
  ready = (async () => {
    await init();
    engine = new AdblockEngine();

    const state = await loadState();
    if (state.paused) engine.pause_blocking();
    if (state.siteAllowlist.length > 0) {
      engine.set_site_allowlist(JSON.stringify(state.siteAllowlist));
    }
    if (state.trackingAllowlist.length > 0) {
      engine.set_tracking_allowlist(JSON.stringify(state.trackingAllowlist));
    }

    await loadStats();
    await initDnr();

    // Best-effort counter persistence — the worker can be killed at any time.
    setInterval(() => mergeStats().catch(() => {}), 60000);

    console.log(
      `[AdbloquRs] engine ready: ${engine.rule_count} ad rules, ` +
        `${engine.tracking_rule_count} tracking rules, ` +
        `${engine.dnr_rule_count} DNR rules cached, v${crate_version()}`,
    );
  })().catch((err) => {
    ready = null; // allow a retry on the next message
    throw err;
  });
  return ready;
}

// Consult the engine for every request, then convert blocked verdicts into
// DNR rules so Chrome actually cancels them.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!engine) return;
    const source = details.initiator || details.originUrl || "";
    const reason = engine.evaluate(
      details.url,
      source,
      RESOURCE_TYPES[details.type] || "other",
    );
    if (reason === BlockReason.Allow) return;
    const kind = reason === BlockReason.Ad ? "ad" : "tracker";
    console.debug(`[AdbloquRs] ${kind} blocked: ${details.url}`);

    // Fire-and-forget: the rule update is queued behind earlier updates.
    // The engine normalizes the host and returns "" when the rule already
    // covers this host+type, so repeated blocks are free.
    const host = engine.host_from_url(details.url);
    if (!host) return;
    updateDnr(JSON.parse(engine.dnr_ensure(host, details.type) || "null"));
  },
  { urls: ["<all_urls>"] },
);

// YouTube ad blocking stats persistence
async function getYoutubeAdCount() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["youtubeAdsBlocked"], (stored) => {
      resolve(stored.youtubeAdsBlocked || 0);
    });
  });
}

async function incrementYoutubeAdCount(count = 1) {
  const current = await getYoutubeAdCount();
  await chrome.storage.local.set({ youtubeAdsBlocked: current + count });
  return current + count;
}

async function resetYoutubeAdCount() {
  await chrome.storage.local.set({ youtubeAdsBlocked: 0 });
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  // Active tab queries don't need the engine, so handle them before the
  // async branch that awaits wasm initialisation.
  if (message.type === "getActiveTabDomain") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let domain = "";
      try {
        domain = new URL(tabs[0]?.url).hostname;
      } catch {
        domain = "";
      }
      respond({ domain });
    });
    return true;
  }

  (async () => {
    await startEngine();
    switch (message.type) {
      case "getState": {
        await mergeStats();
        respond({
          paused: engine.is_paused,
          siteAllowlist: JSON.parse(engine.get_site_allowlist()),
          trackingAllowlist: JSON.parse(engine.get_tracking_allowlist()),
          youtubeAdsBlocked: await getYoutubeAdCount(),
          ...currentStats(),
          ruleCount: engine.rule_count,
          trackingRuleCount: engine.tracking_rule_count,
          version: crate_version(),
        });
        break;
      }
      case "pause":
        engine.pause_blocking();
        await saveState();
        updateDnr(JSON.parse(engine.dnr_pause_payload()));
        respond({ ok: true, paused: true });
        break;
      case "resume":
        engine.resume_blocking();
        await saveState();
        updateDnr(JSON.parse(engine.dnr_resume_payload()));
        respond({ ok: true, paused: false });
        break;
      case "addSiteAllowlist":
        engine.add_site_to_allowlist(message.domain);
        await saveState();
        updateDnr(JSON.parse(engine.dnr_sync() || "null"));
        respond({
          ok: true,
          siteAllowlist: JSON.parse(engine.get_site_allowlist()),
        });
        break;
      case "removeSiteAllowlist":
      case "moveSiteToBlocklist":
        engine.move_site_to_blocklist(message.domain);
        await saveState();
        updateDnr(JSON.parse(engine.dnr_sync() || "null"));
        respond({
          ok: true,
          siteAllowlist: JSON.parse(engine.get_site_allowlist()),
        });
        break;
      case "addTrackingAllow":
        engine.add_tracking_domain(message.domain);
        await saveState();
        updateDnr(JSON.parse(engine.dnr_sync() || "null"));
        respond({
          ok: true,
          trackingAllowlist: JSON.parse(engine.get_tracking_allowlist()),
        });
        break;
      case "removeTrackingAllow":
      case "moveTrackingToBlocklist":
        engine.move_tracking_to_blocklist(message.domain);
        await saveState();
        updateDnr(JSON.parse(engine.dnr_sync() || "null"));
        respond({
          ok: true,
          trackingAllowlist: JSON.parse(engine.get_tracking_allowlist()),
        });
        break;
      case "youtubeAdBlocked":
        await incrementYoutubeAdCount(message.count || 1);
        respond({ ok: true });
        break;
      case "resetStats":
        await resetAllStats();
        await resetYoutubeAdCount();
        respond({ ok: true });
        break;
      default:
        respond({ ok: false, error: `unknown message type: ${message.type}` });
    }
  })().catch((err) => {
    console.error("[AdbloquRs] message handler failed:", err);
    respond({ ok: false, error: String(err) });
  });
  return true; // keep the message channel open for the async response
});

startEngine().catch((err) => {
  console.error("[AdbloquRs] failed to initialise engine:", err);
});
