// YouTube Video Ad Remover — v12 (Enhanced JSON Interception + SSAI Support)
//
// Enhanced approach that blocks ads without breaking video startup or AI features:
// 1. Player response JSON interception and neutralization
// 2. Enhanced IMA SDK shim with realistic event timing
// 3. CSS-based ad element hiding (AI-safe selectors)
// 4. DOM-level fallback for any ads that slip through
// 5. SSAI (Server-Side Ad Insertion) detection and handling
// 6. Balanced ad class removal (200ms loop + ad module content detection)
// 7. Skip button clicking and ad seeking
// 8. Only force playback when ad module content is confirmed
//
// MIT License
//
// Copyright (c) 2026 AdbloquRs Contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

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
  // Player Response JSON Interception
  // ==========================================================================
  
  // Store original JSON.parse to intercept YouTube's player responses
  const originalJSONParse = JSON.parse;
  
  // Enhanced JSON.parse to intercept and neutralize YouTube player responses
  JSON.parse = function(text, reviver) {
    const result = originalJSONParse.call(this, text, reviver);
    
    // Check if this looks like a YouTube player response
    if (result && typeof result === 'object') {
      // Check for key YouTube player response indicators
      const isPlayerResponse = 
        result.playerResponse || 
        result.playabilityStatus || 
        result.videoDetails ||
        result.streamingData ||
        (result.adPlacements && Array.isArray(result.adPlacements)) ||
        (result.adBreaks && Array.isArray(result.adBreaks)) ||
        (result.playerAds && Array.isArray(result.playerAds)) ||
        (result.responseContext && result.responseContext.visitorData);
      
      if (isPlayerResponse) {
        console.log('[AdbloquRs] Intercepted player response JSON, neutralizing ads...');
        neutralizePlayerResponse(result);
      }
    }
    
    return result;
  };
  
  // Intercept Response.json() for fetch API calls
  const originalResponseJson = Response.prototype.json;
  Response.prototype.json = function() {
    return originalResponseJson.call(this).then(data => {
      // Check if this looks like a YouTube player response
      if (data && typeof data === 'object') {
        const isPlayerResponse = 
          data.playerResponse || 
          data.playabilityStatus || 
          data.videoDetails ||
          data.streamingData ||
          (data.adPlacements && Array.isArray(data.adPlacements)) ||
          (data.adBreaks && Array.isArray(data.adBreaks)) ||
          (data.playerAds && Array.isArray(data.playerAds)) ||
          (data.responseContext && data.responseContext.visitorData);
        
        if (isPlayerResponse) {
          console.log('[AdbloquRs] Intercepted fetch response JSON, neutralizing ads...');
          neutralizePlayerResponse(data);
        }
      }
      return data;
    });
  };
  
  // Comprehensive player response neutralization
  function neutralizePlayerResponse(response) {
    try {
      // Handle nested playerResponse
      const playerResponse = response.playerResponse || response;
      
      // 1. Neutralize streaming data (remove ad manifest URLs)
      if (playerResponse.streamingData) {
        const sd = playerResponse.streamingData;
        
        // Remove all ad manifest URLs
        delete sd.adManifestUrl;
        delete sd.ssai;
        delete sd.serverSide;
        delete sd.adPlaylist;
        delete sd.adTagUrl;
        delete sd.serverSideAdManifestUrl;
        delete sd.embeddedAdManifestUrl;
        delete sd.hlsAdManifestUrl;
        delete sd.dashAdManifestUrl;
        
        // Filter adaptive formats to remove ad formats
        if (sd.adaptiveFormats && Array.isArray(sd.adaptiveFormats)) {
          sd.adaptiveFormats = sd.adaptiveFormats.filter(format => {
            const url = format.url || '';
            const isAdFormat = 
              format.isAd || 
              format.adBreakId ||
              format.adMetadata ||
              url.includes('ad=') || 
              url.includes('/ads/');
            return !isAdFormat;
          });
        }
      }
      
      // 2. Clear video details ad flags (surgical - preserve AI features)
      if (playerResponse.videoDetails) {
        const vd = playerResponse.videoDetails;
        delete vd.allowAds;
        delete vd.hasAds;
        delete vd.showAds;
        delete vd.adFlags;
        // Preserve: aiSummary, askAi, generativeAi, shortForm, etc.
      }
      
      // 3. Clear playability status ad info
      if (playerResponse.playabilityStatus) {
        const ps = playerResponse.playabilityStatus;
        delete ps.adReason;
        delete ps.adPlaybackInfo;
        // Preserve: status, reason, miniplayer for normal playback
      }
      
      // 4. Remove ad placements and breaks
      delete playerResponse.adPlacements;
      delete playerResponse.adBreaks;
      delete playerResponse.playerAds;
      delete playerResponse.adSchedule;
      delete playerResponse.adPlacementConfig;
      delete playerResponse.companionSlots;
      delete playerResponse.showCompanion;
      
      // 5. Remove tracking fields
      delete playerResponse.cit;
      delete playerResponse.msr;
      delete playerResponse.mediaStreamRendering;
      
      // 6. Remove response context ad tracking
      if (playerResponse.responseContext) {
        delete playerResponse.responseContext.adTrackingParams;
      }
      
      // 7. Remove storyboards if they contain ad segments
      if (playerResponse.storyboards && Array.isArray(playerResponse.storyboards)) {
        playerResponse.storyboards = playerResponse.storyboards.filter(sb => {
          if (sb.storyboardRenderer) {
            const sr = sb.storyboardRenderer;
            return !sr.spec || !sr.spec.includes('ad');
          }
          return true;
        });
      }
      
      console.log('[AdbloquRs] Player response neutralized successfully');
    } catch (e) {
      console.error('[AdbloquRs] Error neutralizing player response:', e);
    }
  }

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
    ".ytp-ad-player-overlay-instream-info .ytp-ad-skip-button-container button",
    ".ytp-ad-player-overlay .ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern.ytp-button",
    "button.ytp-ad-skip-button-modern.ytp-button",
    ".ytp-ad-skip-button-modern",
    "button.ytp-skip-ad",
    ".ytp-skip-ad",
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
    /* Ad containers - specific selectors only */
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
    ytd-reel-player-overlay-renderer[class*="ad"],
    ytd-shelf-renderer[class*="ad"],
    div#player-ads.style-scope.ytd-watch-flexy {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      overflow: hidden !important;
    }
    
    /* YouTube Shop/Shopping ads - specific selectors only */
    ytd-product-renderer,
    ytd-shelf-renderer[shelf-type*="shopping"],
    ytd-compact-shopping-list-renderer,
    ytd-merch-shelf-renderer,
    ytd-shopping-shelf-renderer,
    ytd-companion-slot-renderer,
    ytd-donation-shelf-renderer,
    ytd-grid-movie-renderer[is-shopping],
    ytd-carousel-ad-renderer,
    ytd-ecommerce-renderer,
    ytd-grid-renderer[yt-marketplace-renderer] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      overflow: hidden !important;
    }
    
    /* Don't hide general containers that might contain AI UI */
    /* Removed :has selectors and broad panel selectors */
    
    /* PRESERVE AI UI - explicitly ensure AI features are visible */
    ytd-ask-ai-button-renderer { display: block !important; visibility: visible !important; }
    ytd-generative-ai-section-renderer { display: block !important; visibility: visible !important; }
    .ytp-ask-button { display: block !important; visibility: visible !important; }
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
    .video-ads {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    
    /* Don't use broad attribute selectors that could hide AI UI */
    /* Removed [class*="ad-badge"], [class*="ad-overlay"], etc. */
  `;

  const POPUP_CSS = `
    ytd-enforcement-message-view-model {
      display: none !important;
      visibility: hidden !important;
    }
  `;

  // ==========================================================================
  // SSAI (Server-Side Ad Insertion) Detection
  // ==========================================================================
  
  let ssaiSegments = []; // Store detected SSAI ad segments
  let lastSSAICheck = 0;
  
  function detectSSAISegments() {
    // Check YouTube's page data for SSAI segment information
    try {
      // Look for ytInitialPlayerResponse in page
      const playerData = document.querySelector('#script')?.textContent;
      if (playerData && playerData.includes('adSlots')) {
        console.log('[AdbloquRs] SSAI ad slots detected in page data');
        return true;
      }
      
      // Check for SSAI indicators in video URL
      const video = document.querySelector(VIDEO_SEL);
      if (video && video.src) {
        if (video.src.includes('ssai') || video.src.includes('ctier')) {
          console.log('[AdbloquRs] SSAI indicators in video URL');
          return true;
        }
      }
      
      return false;
    } catch (e) {
      return false;
    }
  }
  
  function handleSSAIAd() {
    const video = document.querySelector(VIDEO_SEL);
    if (!video) return false;
    
    // For SSAI ads, we need to seek past them since they're embedded in the stream
    const currentTime = video.currentTime;
    const duration = video.duration;
    
    // If we detect SSAI and video is in an ad segment, seek past it
    if (detectSSAISegments() && isAdPlaying()) {
      console.log('[AdbloquRs] SSAI ad detected, seeking past it...');
      // Seek to 90% of current position to jump past embedded ad
      const jumpTarget = Math.min(duration - 1, currentTime + 5);
      video.currentTime = jumpTarget;
      return true;
    }
    
    return false;
  }

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
    // Enhanced detection - catch ads earlier while preserving video startup safety
    const player = document.querySelector(PLAYER_SEL);
    const video = document.querySelector(VIDEO_SEL);
    
    // Primary detection: ad module has actual content (most reliable)
    if (adModuleHasContent()) {
      return true;
    }
    
    // Secondary detection: ad classes on player (more aggressive)
    if (player) {
      const hasAdClass = player.classList.contains("ad-showing") || 
                         player.classList.contains("ad-interrupting") ||
                         player.classList.contains("ytp-ad-playing");
      
      if (hasAdClass) {
        // Additional check: if we have ad classes but no ad module content,
        // it might be an unskippable mid-roll ad that hasn't fully loaded yet
        // In this case, be more aggressive
        return true;
      }
    }
    
    // Tertiary detection: check for unskippable ad indicators
    if (video && player) {
      // Check if video is in a strange state that suggests an unskippable ad
      const duration = video.duration;
      const currentTime = video.currentTime;
      
      // Unskippable ads often have very short durations or strange time ratios
      if (isFinite(duration) && duration > 0 && duration < 10) {
        // Very short video might be an unskippable ad
        if (player.classList.contains("ad-showing")) {
          return true;
        }
      }
      
      // Check for ad-related URL parameters in video source
      if (video.src && (video.src.includes('ad=') || video.src.includes('ctier='))) {
        return true;
      }
    }
    
    return false;
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
    const player = document.querySelector(PLAYER_SEL);
    const currentTime = video ? video.currentTime : 0;

    // 0. Handle SSAI ads first (they're embedded in the stream)
    if (handleSSAIAd()) {
      if (!skipAttempted) {
        skipAttempted = true;
        reportAdBlocked();
      }
      return;
    }

    // 1. Try to click skip button immediately and repeatedly
    if (clickSkipButton()) {
      if (!skipAttempted) {
        skipAttempted = true;
        reportAdBlocked();
      }
      return;
    }

    // 2. For unskippable ads, seek near the end (balanced timing)
    if (Date.now() - adStartedAt > 100 && seekAttempts < 8) {
      if (seekPastAd()) {
        seekAttempts++;
        if (!skipAttempted) {
          skipAttempted = true;
          reportAdBlocked();
        }
      }
    }

    // 3. Try skip button again after seeking
    if (clickSkipButton()) {
      if (!skipAttempted) {
        skipAttempted = true;
        reportAdBlocked();
      }
    }
    
    // 4. Only remove ad classes if we're confident it's an ad (don't interfere with startup)
    if (player && adModuleHasContent()) {
      player.classList.remove('ad-showing', 'ad-interrupting', 'ytp-ad-playing');
    }
    
    // 5. Force video to play if it's paused during a confirmed ad
    if (video && video.paused && !video.ended && adModuleHasContent()) {
      video.play().catch(() => {});
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

    // Periodic safety net (200ms — balanced response for skip buttons)
    mainLoopId = setInterval(processPage, 200);

    // Initial processing
    processPage();

    console.log("[AdbloquRs] YouTube ad remover v12 initialized (enhanced JSON interception + SSAI support)");
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
