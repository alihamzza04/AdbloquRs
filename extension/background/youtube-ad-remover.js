// YouTube Video Ad Remover — v7 (Simplified + Aggressive)
//
// Uses the same approach as the working reference: completely disable the
// IMA SDK and intercept ad network requests. This version adds DOM-level
// fallback for any ads that slip through.

(() => {
  "use strict";

  // ==========================================================================
  // State
  // ==========================================================================
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

  // ==========================================================================
  // Selectors
  // ==========================================================================
  const PLAYER_SEL = "#movie_player";
  const VIDEO_SEL = ".html5-video-player video";

  const AD_MODULE_SEL = [
    "#movie_player .ytp-ad-module",
    ".html5-video-player .ytp-ad-module",
    "#ytd-player .ytp-ad-module",
  ].join(", ");

  // Comprehensive skip button selectors
  const SKIP_BTN_SEL = [
    "button.ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button",
    "button.ytp-skip-ad-button",
    ".ytp-ad-skip-button-slot button",
    "button.ytp-ad-skip-button-slot",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    "button[class*='skip-button']",
    "button[class*='skip-ad']",
    "[class*='skip-button']",
    "[class*='skip-ad']",
    "[aria-label*='Skip']",
    "[aria-label*='skip']",
    "[data-text*='Skip']",
    "ytd-button-renderer button",
  ].join(", ");

  // ==========================================================================
  // CSS injection
  // ==========================================================================
  const injectedStyles = {};

  function injectStyle(css, id) {
    if (injectedStyles[id]) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    injectedStyles[id] = s;
  }

  // Hide ad elements
  const PAGE_ADS_CSS = `
    /* Ad containers */
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
    div#main-container.style-scope.ytd-promoted-video-renderer,
    ytd-promoted-video-renderer,
    ytd-compact-promoted-video-renderer,
    ytd-search-ad-renderer,
    ytd-rich-item-renderer[is-ad],
    ytd-ad-persistent-header-renderer,
    ytd-reel-player-overlay-renderer.ytd-reel-player-overlay-renderer,
    ytd-shelf-renderer[class*="ad"],
    ytd-rich-section-renderer:has([is-ad]),
    div#player-ads.style-scope.ytd-watch-flexy,
    div#panels.style-scope.ytd-watch-flexy {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      overflow: hidden !important;
    }
  `;

  const OVERLAY_ADS_CSS = `
    .ytp-ad-overlay-container,
    .ytp-ad-overlay-slot,
    .ytp-ad-overlay-wrapper,
    .ytp-ad-text-overlay,
    .ytp-ad-image-overlay,
    .ytp-ad-message-overlay,
    .ytp-ad-simple-ad-badge,
    .ytp-ad-badge,
    .ytp-ad-action-interstitial,
    .ytp-ad-overlay-content,
    .ytp-ad-module-container,
    .video-ads,
    [class*="ad-badge"],
    [class*="ad-overlay"],
    [id*="ad-badge"],
    [id*="ad-overlay"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;

  const POPUP_CSS = `
    ytd-enforcement-message-view-model {
      display: none !important;
      visibility: hidden !important;
    }
  `;

  // ==========================================================================
  // Detection: is an ad DEFINITELY playing?
  // ==========================================================================
  function playerHasAdClass() {
    const player = document.querySelector(PLAYER_SEL);
    return !!player && player.classList.contains("ad-showing");
  }

  function adModuleHasContent() {
    const mod = document.querySelector(AD_MODULE_SEL);
    return !!mod && mod.innerHTML.trim().length > 0;
  }

  function isAdPlaying() {
    return playerHasAdClass() || adModuleHasContent();
  }

  // ==========================================================================
  // Audio: mute ONLY during a confirmed ad, restore afterwards
  // ==========================================================================
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

  // ==========================================================================
  // Core: click the skip button if present
  // ==========================================================================
  function clickSkipButton() {
    // Method 1: Try standard selector first
    let btn = document.querySelector(SKIP_BTN_SEL);
    if (btn) {
      btn.click();
      return true;
    }
    
    // Method 2: Look for any button with "skip" in text content
    const allButtons = document.querySelectorAll('button');
    for (const b of allButtons) {
      const text = (b.textContent || b.innerText || '').toLowerCase();
      if (text.includes('skip') || text.includes('的广告')) {
        b.click();
        return true;
      }
    }
    
    // Method 3: Check for skip button by aria-label
    const ariaButtons = document.querySelectorAll('[aria-label]');
    for (const b of ariaButtons) {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('skip')) {
        b.click();
        return true;
      }
    }
    
    return false;
  }

  // ==========================================================================
  // Core: seek the video near its end to finish an unskippable ad
  // ==========================================================================
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

  // ==========================================================================
  // Core: remove the anti-adblock enforcement popup
  // ==========================================================================
  function removeAntiAdblockPopup() {
    const enforcement = document.querySelector(
      "ytd-enforcement-message-view-model",
    );
    if (!enforcement) return;

    // Click dismiss if present, then remove the popup and its backdrop.
    const dismiss = document.getElementById("dismiss-button");
    if (dismiss) dismiss.click();
    enforcement.remove();
    document
      .querySelectorAll("tp-yt-iron-overlay-backdrop[opened]")
      .forEach((el) => el.remove());
    document.body.style.setProperty("overflow-y", "auto", "important");
  }

  // ==========================================================================
  // Ad lifecycle
  // ==========================================================================
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
    if (reportedThisAd) return;
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
    const video = document.querySelector(VIDEO_SEL);
    const currentTime = video ? video.currentTime : 0;

    // 1. Skippable ads: click the skip button as soon as it exists.
    if (!skipAttempted && clickSkipButton()) {
      skipAttempted = true;
      reportAdBlocked();
      return;
    }

    // 2. Unskippable ads: seek near the end, retrying a few times.
    if (!skipAttempted && Date.now() - adStartedAt > 400 && seekAttempts < 6) {
      if (seekPastAd()) {
        seekAttempts++;
        reportAdBlocked();
      }
    }

    // 3. Late skip button
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

  // ==========================================================================
  // Observers
  // ==========================================================================
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

          // Ad module appeared
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

  // ==========================================================================
  // Player event hooks
  // ==========================================================================
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

  // ==========================================================================
  // Main processing (periodic safety net)
  // ==========================================================================
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

  // ==========================================================================
  // Message listener
  // ==========================================================================
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

  // ==========================================================================
  // Init
  // ==========================================================================
  function init() {
    if (isInitialized) return;
    isInitialized = true;

    // Mute any video immediately when ad is showing - prevents audio bleed
    // YouTube plays ads on the same <video> element as content
    if (typeof HTMLVideoElement !== 'undefined') {
      const _origPlay = HTMLVideoElement.prototype.play;
      HTMLVideoElement.prototype.play = function() {
        const player = document.querySelector(PLAYER_SEL);
        if (player && player.classList.contains("ad-showing")) {
          this.muted = true;
        }
        return _origPlay.apply(this, arguments);
      };
    }

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

    console.log("[AdbloquRs] YouTube ad remover v7 initialized");
  }

  // ==========================================================================
  // Start
  // ==========================================================================
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
})();
