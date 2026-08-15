// YouTube Video Ad Remover — v4 (Conservative)
//
// KEY INSIGHT: YouTube uses ONE <video> element for everything. We only act
// when we are CERTAIN an ad is playing, and we never touch unrelated YouTube
// UI. Detection uses two independent signals:
//   1. the "ad-showing" class on #movie_player (YouTube's own flag), and
//   2. the ytp-ad-module div having content.
//
// Strategy:
// 1. Watch for ad signals (player class + ad module mutations)
// 2. Mute the <video> ONLY while an ad plays, restore audio afterwards —
//    this kills the 1-2 frames of ad audio bleed without touching playback
// 3. Click YouTube's skip button the instant it appears
// 4. For unskippable ads: seek the <video> near its end, retrying a few times
// 5. Remove overlay/page-level ads via CSS
// 6. Remove the anti-adblock enforcement popup — and only that popup. We
//    never remove generic iron-overlay backdrops or force scroll, so
//    YouTube's own dialogs (share, settings, ...) keep working.

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let adBlockedCount = 0;
  let statsSent = 0;
  let mainLoopId = null;
  let adModuleObserver = null;
  let playerObserver = null;
  let bodyObserver = null;
  let isInitialized = false;
  let currentHref = "";
  let wasAdPlaying = false;
  let adStartedAt = 0;
  let skipAttempted = false;
  let reportedThisAd = false;
  let seekAttempts = 0;

  // Audio state: remember the user's mute preference and restore it after
  // the ad. Never mute outside a confirmed ad.
  let wasMutedByUs = false;
  let originalMuted = null;

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  const PLAYER_SEL = "#movie_player";
  const VIDEO_SEL = ".html5-video-player video";
  const AD_MODULE_SEL = [
    "#movie_player .ytp-ad-module",
    ".html5-video-player .ytp-ad-module",
    "#ytd-player .ytp-ad-module",
  ].join(", ");

  // YouTube keeps renaming the skip button; cover the known variants.
  const SKIP_BTN_SEL = [
    "button.ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button",
    "button.ytp-skip-ad-button",
    ".ytp-ad-skip-button-slot button",
    "button.ytp-ad-skip-button-slot",
  ].join(", ");

  // Page-level ad selectors to hide via CSS
  const PAGE_ADS_CSS = `
    /* Page-level ad units */
    div#player-ads.style-scope.ytd-watch-flexy,
    div#panels.style-scope.ytd-watch-flexy,
    ytd-ad-slot-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-display-ad-renderer,
    ytd-video-masthead-ad-v3-renderer,
    ytd-video-masthead-ad-advertiser-info-renderer,
    ytd-video-masthead-ad-primary-video-renderer,
    ytd-action-companion-ad-renderer,
    yt-about-this-ad-renderer,
    yt-mealbar-promo-renderer,
    ytd-statement-banner-renderer,
    ytd-banner-promo-renderer-background,
    #masthead-ad,
    ad-slot-renderer,
    ytm-promoted-sparkles-web-renderer,
    div#root.style-scope.ytd-display-ad-renderer.yt-simple-endpoint,
    div#sparkles-container.style-scope.ytd-promoted-sparkles-web-renderer,
    div#main-container.style-scope.ytd-promoted-video-renderer {
      display: none !important;
    }
  `;

  const OVERLAY_ADS_CSS = `
    /* Video overlay ads (text/image banners on top of video) */
    .ytp-ad-overlay-container,
    .ytp-ad-overlay-slot,
    .ytp-ad-overlay-wrapper,
    /* In-video ad text/image overlays. The skip button lives in a separate
       container, so hiding these never hides the skip button. */
    .ytp-ad-text-overlay,
    .ytp-ad-image-overlay,
    .ytp-ad-message-overlay,
    .ytp-ad-simple-ad-badge,
    .ytp-ad-badge {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;

  // Hide only the enforcement popup element itself. Generic overlay backdrops
  // are left alone — they also back YouTube's own dialogs.
  const POPUP_CSS = `
    ytd-enforcement-message-view-model {
      display: none !important;
      visibility: hidden !important;
    }
  `;

  // ---------------------------------------------------------------------------
  // CSS injection
  // ---------------------------------------------------------------------------
  const injectedStyles = {};

  function injectStyle(css, id) {
    if (injectedStyles[id]) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    injectedStyles[id] = s;
  }

  // ---------------------------------------------------------------------------
  // Detection: is an ad DEFINITELY playing?
  // ---------------------------------------------------------------------------
  function playerHasAdClass() {
    const player = document.querySelector(PLAYER_SEL);
    return !!player && player.classList.contains("ad-showing");
  }

  function adModuleHasContent() {
    const mod = document.querySelector(AD_MODULE_SEL);
    // The module is empty when no ad is playing
    return !!mod && mod.innerHTML.trim().length > 0;
  }

  function isAdPlaying() {
    return playerHasAdClass() || adModuleHasContent();
  }

  // ---------------------------------------------------------------------------
  // Audio: mute ONLY during a confirmed ad, restore afterwards
  // ---------------------------------------------------------------------------
  function muteDuringAd() {
    const video = document.querySelector(VIDEO_SEL);
    if (!video) return;
    if (originalMuted === null) originalMuted = video.muted;
    if (!video.muted) {
      video.muted = true;
      wasMutedByUs = true;
    }
  }

  function restoreAudio() {
    const video = document.querySelector(VIDEO_SEL);
    if (video && originalMuted !== null && wasMutedByUs) {
      video.muted = originalMuted;
    }
    wasMutedByUs = false;
    originalMuted = null;
  }

  // ---------------------------------------------------------------------------
  // Core: click the skip button if present
  // ---------------------------------------------------------------------------
  function clickSkipButton() {
    const btn = document.querySelector(SKIP_BTN_SEL);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Core: seek the video near its end to finish an unskippable ad
  // ---------------------------------------------------------------------------
  function seekPastAd() {
    const video = document.querySelector(VIDEO_SEL);
    if (!video) return false;
    if (!isFinite(video.duration) || video.duration <= 0) return false;
    try {
      // Jump to 0.3s before the end so the ad's "ended" event fires and
      // YouTube transitions back to content.
      video.currentTime = Math.max(0, video.duration - 0.3);
      // Nudge playback — a paused player won't advance past the ad.
      if (video.paused) video.play().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Core: remove the anti-adblock enforcement popup — and nothing else
  // ---------------------------------------------------------------------------
  function removeAntiAdblockPopup() {
    const enforcement = document.querySelector(
      "ytd-enforcement-message-view-model",
    );
    if (!enforcement) return; // nothing to remove: leave all other UI alone

    // Click dismiss if present, then remove the popup and its backdrop.
    const dismiss = document.getElementById("dismiss-button");
    if (dismiss) dismiss.click();
    enforcement.remove();
    document
      .querySelectorAll("tp-yt-iron-overlay-backdrop[opened]")
      .forEach((el) => el.remove());
    document.body.style.setProperty("overflow-y", "auto", "important");
  }

  // ---------------------------------------------------------------------------
  // Ad lifecycle
  // ---------------------------------------------------------------------------
  function onAdStart() {
    if (wasAdPlaying) return;
    wasAdPlaying = true;
    adStartedAt = Date.now();
    skipAttempted = false;
    reportedThisAd = false;
    seekAttempts = 0;
    // Mute immediately so no ad audio bleeds through while we handle it.
    muteDuringAd();
  }

  function onAdEnd() {
    if (!wasAdPlaying) return;
    wasAdPlaying = false;
    restoreAudio();
    removeAntiAdblockPopup();
  }

  function reportAdBlocked() {
    if (reportedThisAd) return; // count each ad once
    reportedThisAd = true;
    adBlockedCount++;
    if (adBlockedCount > statsSent) {
      statsSent = adBlockedCount;
      try {
        chrome.runtime.sendMessage({ type: "youtubeAdBlocked", count: 1 });
      } catch {
        // context invalidated
      }
    }
  }

  function handleAdPlaying() {
    // 1. Skippable ads: click the skip button as soon as it exists.
    if (!skipAttempted && clickSkipButton()) {
      skipAttempted = true;
      reportAdBlocked();
      return;
    }

    // 2. Unskippable ads: seek near the end, retrying a few times. The ad's
    //    "ended" event then makes YouTube return to the video. Give up after
    //    ~6 attempts to stay conservative and avoid glitching.
    if (!skipAttempted && Date.now() - adStartedAt > 400 && seekAttempts < 6) {
      if (seekPastAd()) {
        seekAttempts++;
        reportAdBlocked();
      }
    }

    // 3. Late skip button (e.g. it appeared after the seek attempts).
    if (!skipAttempted && clickSkipButton()) {
      skipAttempted = true;
      reportAdBlocked();
    }
  }

  // Evaluate the ad state from any trigger (observer or timer).
  function checkAdState() {
    if (isAdPlaying()) {
      onAdStart();
      handleAdPlaying();
    } else if (wasAdPlaying) {
      onAdEnd();
    }
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------
  function setupAdModuleObserver() {
    if (adModuleObserver) return;
    const mod = document.querySelector(AD_MODULE_SEL);
    if (!mod) return;

    adModuleObserver = new MutationObserver(checkAdState);
    adModuleObserver.observe(mod, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function setupPlayerObserver() {
    if (playerObserver) return;
    const player = document.querySelector(PLAYER_SEL);
    if (!player) return;

    // The "ad-showing" class is toggled on the player element itself.
    playerObserver = new MutationObserver(checkAdState);
    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function resetObservers() {
    if (adModuleObserver) {
      adModuleObserver.disconnect();
      adModuleObserver = null;
    }
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
  }

  function setupBodyObserver() {
    if (bodyObserver) return;

    bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const tag = node.tagName?.toLowerCase() || "";

          // Player loaded — hook into it
          if (tag === "ytd-player" || node.id === "movie_player") {
            setTimeout(() => {
              setupAdModuleObserver();
              setupPlayerObserver();
            }, 500);
          }

          // Ad module appeared. The module always lives under the player, so
          // only scan player subtrees — scanning every added subtree on a
          // busy page (chat, comments, feed) is the most expensive work this
          // observer can do.
          if (node.matches?.(AD_MODULE_SEL)) {
            setTimeout(setupAdModuleObserver, 100);
          } else if (
            tag === "ytd-player" ||
            tag === "yt-player" ||
            node.id === "movie_player"
          ) {
            if (node.querySelector?.(AD_MODULE_SEL)) {
              setTimeout(setupAdModuleObserver, 100);
            }
          }

          // Anti-adblock popup appeared
          if (tag === "ytd-enforcement-message-view-model") {
            setTimeout(removeAntiAdblockPopup, 100);
          }
        }
      }
    });

    bodyObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Player event hooks
  // ---------------------------------------------------------------------------
  function hookPlayerEvents() {
    const player = document.querySelector(PLAYER_SEL);
    if (!player || player._adbloqursHooked) return;
    player._adbloqursHooked = true;

    // When YouTube says an ad started, act immediately
    const adEventNames = [
      "onAdStarted",
      "onAdProgress",
      "onAdUnit",
      "onAdPlaying",
    ];

    for (const evt of adEventNames) {
      player.addEventListener(evt, () => {
        // Immediate skip attempt
        setTimeout(() => {
          if (isAdPlaying()) {
            onAdStart();
            handleAdPlaying();
          }
        }, 50);
      });
    }

    // Clean up when the ad ends
    player.addEventListener("onAdComplete", () => onAdEnd());
    player.addEventListener("onAdCancel", () => onAdEnd());
  }

  // ---------------------------------------------------------------------------
  // Main processing (periodic safety net)
  // ---------------------------------------------------------------------------
  function processPage() {
    // Detect SPA navigation
    if (location.href !== currentHref) {
      currentHref = location.href;
      wasAdPlaying = false;
      restoreAudio();
      // Player and ad module may have been re-rendered — re-hook them.
      resetObservers();
      setTimeout(() => {
        setupAdModuleObserver();
        setupPlayerObserver();
        hookPlayerEvents();
      }, 1000);
    }

    // Always try to remove the anti-adblock popup (no-op when absent).
    removeAntiAdblockPopup();

    // Evaluate the ad state.
    checkAdState();

    // Try to hook player events if not yet done.
    hookPlayerEvents();
  }

  // ---------------------------------------------------------------------------
  // Stats reporting
  // ---------------------------------------------------------------------------
  // (reportAdBlocked lives above with the ad lifecycle)

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message.type === "getYouTubeAdStats") {
        respond({
          adsDetected: adBlockedCount,
          isAdPlaying: isAdPlaying(),
        });
        return true;
      }
      if (message.type === "refreshYouTubeAds") {
        processPage();
        respond({ ok: true });
        return true;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    if (isInitialized) return;
    isInitialized = true;

    // Inject CSS for page ads, overlay ads, and the enforcement popup
    injectStyle(PAGE_ADS_CSS, "adbloqurs-yt-page-ads");
    injectStyle(OVERLAY_ADS_CSS, "adbloqurs-yt-overlay-ads");
    injectStyle(POPUP_CSS, "adbloqurs-yt-popup");

    // Set up observers
    setupBodyObserver();
    setupAdModuleObserver();
    setupPlayerObserver();

    // Hook player events
    hookPlayerEvents();

    // Message listener
    setupMessageListener();

    // Periodic safety net (1 second — conservative, won't glitch)
    mainLoopId = setInterval(processPage, 1000);

    // Initial processing
    processPage();

    console.log("[AdbloquRs] YouTube ad remover v4 initialized");
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-initialize on YouTube SPA navigation
  document.addEventListener("yt-navigate-finish", () => {
    currentHref = location.href;
    wasAdPlaying = false;
    restoreAudio();
    resetObservers();
    setTimeout(() => {
      setupAdModuleObserver();
      setupPlayerObserver();
      hookPlayerEvents();
      processPage();
    }, 500);
  });

  // No beforeunload teardown: the content-script context is destroyed with
  // the document, and disconnecting observers on unload would leave a
  // bfcache-restored page with dead observers.
})();
