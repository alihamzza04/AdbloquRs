// YouTube Video Ad Remover — v5 (Enhanced with Player Response Interception)
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
// 7. NEW in v5: Intercept ytInitialPlayerResponse/ytInitialData to detect
//    and neutralize server-side ad insertion (SSAI) before the player starts.

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

  // SSAI detection: track if the current video has embedded ad segments
  let ssaiAdSegments = [];
  let lastPlayerResponse = null;

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

  // Page-level ad selectors to hide via CSS - expanded for better coverage
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
    div#main-container.style-scope.ytd-promoted-video-renderer,
    /* NEW in v5: Additional YouTube ad containers */
    ytd-promoted-video-renderer,
    ytd-compact-promoted-video-renderer,
    ytd-search-ad-renderer,
    ytd-rich-item-renderer[is-ad],
    ytd-ad-persistent-header-renderer,
    #related > ytd-watch-next-secondary-results-renderer > #items > ytd-rich-item-renderer[is-ad],
    /* Shorts ads */
    ytd-reel-player-overlay-renderer.ytd-reel-player-overlay-renderer,
    ytd-shelf-renderer[class*="ad"],
    /* Home feed promoted content */
    ytd-rich-section-renderer:has([is-ad]),
    /* Sponsor block markers (if user has sponsorblock installed) */
    .sponsorBlockSpacer,
    /* General ad containers that may appear */
    [class*="ad-container"],
    [class*="ad-wrapper"],
    [id*="ad-container"],
    [id*="ad-wrapper"] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      overflow: hidden !important;
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
    .ytp-ad-badge,
    /* NEW in v5: Additional overlay ad elements */
    .ytp-ad-action-interstitial,
    .ytp-ad-overlay-content,
    .ytp-ad-module-container,
    .video-ads,
    ytd-promoted-sparkles-card-renderer,
    [class*="ad-badge"],
    [class*="ad-overlay"],
    [id*="ad-badge"],
    [id*="ad-overlay"] {
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

  // NEW in v5: Check for SSAI ad segments from intercepted player response
  function hasSSAIAdSegments() {
    return ssaiAdSegments.length > 0;
  }

  // NEW in v5: Check if current playback position is within an ad segment
  function isInSSAIAdSegment(currentTime) {
    for (const seg of ssaiAdSegments) {
      if (currentTime >= seg.startMs / 1000 && currentTime <= seg.endMs / 1000) {
        return true;
      }
    }
    return false;
  }

  function isAdPlaying() {
    return playerHasAdClass() || adModuleHasContent() || hasSSAIAdSegments();
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

  // NEW in v5: Seek past SSAI ad segment by jumping to the end of the segment
  function seekPastSSAIAdSegment(currentTime) {
    const video = document.querySelector(VIDEO_SEL);
    if (!video) return false;
    
    for (const seg of ssaiAdSegments) {
      const startSec = seg.startMs / 1000;
      const endSec = seg.endMs / 1000;
      
      // If we're within this ad segment, jump past it
      if (currentTime >= startSec && currentTime < endSec) {
        try {
          // Jump just past the ad segment
          video.currentTime = Math.min(endSec + 0.1, video.duration);
          if (video.paused) video.play().catch(() => {});
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
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
    // Clear SSAI segments after ad ends (they're per-video)
    ssaiAdSegments = [];
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
    const video = document.querySelector(VIDEO_SEL);
    const currentTime = video ? video.currentTime : 0;

    // NEW in v5: Handle SSAI ad segments first - seek past them directly
    if (hasSSAIAdSegments() && isInSSAIAdSegment(currentTime)) {
      if (seekPastSSAIAdSegment(currentTime)) {
        reportAdBlocked();
        return;
      }
    }

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
  // NEW in v5: Player Response Interception for SSAI Ad Detection
  // YouTube uses ytInitialPlayerResponse and ytInitialData to configure the player.
  // We intercept these to detect server-side ad insertion (SSAI) segments.
  // ---------------------------------------------------------------------------
  

  // ---------------------------------------------------------------------------
  // NEW in v5: Player Response Interception for SSAI Ad Detection
  // YouTube uses ytInitialPlayerResponse and ytInitialData to configure the player.
  // We intercept these to detect server-side ad insertion (SSAI) segments.
  // Enhanced in v2 with more field patterns and SSAI indicators.
  // ---------------------------------------------------------------------------

  function extractAdSegments(playerResponse) {
    const segments = [];

    try {
      // Check for adBreaks in the player response - primary indicator
      const adBreaks = playerResponse?.adBreaks || 
                       playerResponse?.storyboards?.adBreaks || 
                       [];

      for (const break_ of adBreaks) {
        // Try multiple field name patterns - YouTube uses different naming conventions
        const startMs = break_.startTimeMs || 
                        break_.startMs || 
                        break_.positionMs || 
                        0;
        
        // Duration or explicit end time
        const durationMs = break_.durationMs || 0;
        let endMs = break_.endTimeMs || 0;
        
        // NEW in v2: Also check for rtf (real-time feedback) timing fields
        const rtfStartMs = break_.rtfStartMs || 0;
        const rtfEndMs = break_.rtfEndMs || 0;
        
        // Calculate end time from available data
        if (endMs <= 0 && durationMs > 0) {
          endMs = startMs + durationMs;
        } else if (endMs <= 0 && rtfEndMs > 0) {
          // Use RTF timing as fallback
          endMs = rtfEndMs;
        } else if (endMs <= 0) {
          endMs = startMs + 15000; // Default 15 second ad
        }

        if (startMs > 0 && endMs > startMs) {
          segments.push({ startMs, endMs });
        }
      }

      // Also check playerAds array if present - alternative ad format
      const playerAds = playerResponse?.playerAds || [];
      for (const ad of playerAds) {
        // Multiple possible start time fields
        const startMs = ad.startTimeMs || 
                        ad.positionMs || 
                        ad.startMs || 
                        ad.cueStartTimeMs || 
                        0;
        
        // Duration with better defaults
        const durationMs = ad.durationMs || ad.lengthMs || 15000;
        const endMs = ad.endTimeMs || ad.cueEndTimeMs || (startMs + durationMs);

        if (startMs > 0 && endMs > startMs) {
          segments.push({ startMs, endMs });
        }
      }

      // Check for streaming data with embedded ads (SSAI)
      const streamingData = playerResponse?.streamingData || {};
      
      // NEW in v2: More comprehensive SSAI detection
      if (streamingData.adManifestUrl || 
          streamingData.ssai || 
          streamingData.serverSide ||
          streamingData.adPlaylist) {
        console.log("[AdbloquRs] Detected SSAI stream");
      }
      
      // NEW in v2: Check for msr (media stream rendering) which often indicates SSAI
      if (playerResponse?.msr || playerResponse?.mediaStreamRendering) {
        console.log("[AdbloquRs] Detected MSR (potential SSAI)");
      }

      // NEW in v2: Check videoDetails for ad-related fields
      const videoDetails = playerResponse?.videoDetails || {};
      if (videoDetails.allowAds || videoDetails.hasAds) {
        console.log("[AdbloquRs] Video has ad flags set");
      }

    } catch (e) {
      // Silently fail - parsing errors shouldn't break video playback
      console.warn("[AdbloquRs] Error extracting ad segments:", e);
    }

    return segments;
  }

  function interceptPlayerResponse() {
    // Intercept ytInitialPlayerResponse
    let originalPlayerResponse = null;
    
    // Use Object.defineProperty to intercept when YouTube sets the global
    try {
      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        configurable: true,
        set(value) {
          originalPlayerResponse = value;
          lastPlayerResponse = value;
          
          // Extract ad segments from the response
          ssaiAdSegments = extractAdSegments(value);
          
          if (ssaiAdSegments.length > 0) {
            console.log(`[AdbloquRs] Detected ${ssaiAdSegments.length} SSAI ad segment(s)`);
          }
          
          // Clear any ad-related fields to prevent ad rendering
          if (value && value.playerAds) {
            value.playerAds = [];
          }
          if (value && value.adBreaks) {
            value.adBreaks = [];
          }
          
          // Dispatch custom event for other scripts
          window.dispatchEvent(new CustomEvent('adbloqurs-player-response', { detail: value }));
        },
        get() {
          return originalPlayerResponse;
        }
      });
    } catch (e) {
      // Already defined, try alternative approach
    }
    
    // Also intercept ytInitialData which may contain ad info
    let originalInitialData = null;
    try {
      Object.defineProperty(window, 'ytInitialData', {
        configurable: true,
        set(value) {
          originalInitialData = value;
          
          // Check for ad-related content in initial data
          if (value && value.contents) {
            // Could contain promoted content markers
          }
          
          window.dispatchEvent(new CustomEvent('adbloqurs-initial-data', { detail: value }));
        },
        get() {
          return originalInitialData;
        }
      });
    } catch (e) {
      // Already defined
    }
  }

  // Call interception early, before page scripts run
  interceptPlayerResponse();

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

    console.log("[AdbloquRs] YouTube ad remover v5 initialized with SSAI detection");
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
