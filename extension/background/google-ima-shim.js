/**
 * AdbloquRs: YouTube IMA SDK shim (v2 — Aggressive disable + network interception)
 *
 * Instead of trying to fake a complex event sequence that YouTube's player
 * validates internally, we completely disable the IMA SDK and intercept
 * ad network requests at the network level.
 *
 * This approach:
 * 1. Stub out google.ima so YouTube thinks the SDK loaded but ads never play
 * 2. Intercept fetch() and XMLHttpRequest to block ad network domains
 * 3. Inject CSS to hide all ad elements
 * 4. Remove ad scripts from the DOM
 *
 * Runs in MAIN world at document_start before YouTube's scripts load.
 */

'use strict';

(function() {
  // ========================================================================
  // 1. STUB OUT GOOGLE IMA SDK
  // ========================================================================
  // Completely disable the IMA SDK so YouTube never attempts to load ads.
  // This is more reliable than faking event sequences.

  window.google = window.google || {};
  
  // Create a minimal stub that makes YouTube think the SDK loaded
  // but all ad operations are no-ops
  if (!window.google.ima || !window.google.ima.VERSION) {
    window.google.ima = {
      // AdsManager - completely disable all ad operations
      AdsManager: {
        start: function() {},
        pause: function() {},
        resume: function() {},
        stop: function() {},
        destroy: function() {},
        getVolume: function() { return 0; },
        setVolume: function() {},
        init: function() {},
        expand: function() {},
        collapse: function() {},
        skip: function() {},
        configureAdsManager: function() {},
        discardAdBreak: function() {},
        focus: function() {},
        resize: function() {},
        updateAdsRenderingSettings: function() {},
        getAdSkippableState: function() { return false; },
        getCuePoints: function() { return []; },
        getCurrentAd: function() { return null; },
        getCurrentAdCuePoints: function() { return []; },
        getRemainingTime: function() { return 0; },
        requestNextAdBreak: function() {},
        isCustomPlaybackUsed: function() { return false; },
        isCustomClickTrackingUsed: function() { return false; }
      },

      // AdsLoader - disable ad requests entirely
      AdsLoader: function() {
        this.requestAds = function() {};
        this.contentComplete = function() {};
        this.destroy = function() {};
        this.getSettings = function() {
          return {
            setAutoPlayAdBreaks: function() {},
            setCompanionBackfill: function() {},
            setCookiesEnabled: function() {},
            setDisableCustomPlaybackForIOS10Plus: function() {},
            setFeatureFlags: function() {},
            setLocale: function() {},
            setNumRedirects: function() {},
            setPlayerType: function() {},
            setPlayerVersion: function() {},
            setPpid: function() {},
            setSessionId: function() {},
            setVpaidAllowed: function() {},
            setVpaidMode: function() {},
            setDisableFlashAds: function() {},
            getCompanionBackfill: function() { return ''; },
            getDisableCustomPlaybackForIOS10Plus: function() { return false; },
            getFeatureFlags: function() { return {}; },
            getLocale: function() { return ''; },
            getNumRedirects: function() { return 0; },
            getPlayerType: function() { return ''; },
            getPlayerVersion: function() { return ''; },
            getPpid: function() { return ''; },
            isCookiesEnabled: function() { return false; },
            getDisableFlashAds: function() {}
          };
        };
        this.getVersion = function() { return '3.764.0'; };
      },

      // AdDisplayContainer - no-op
      AdDisplayContainer: function() {
        this.destroy = function() {};
        this.initialize = function() {};
      },

      // AdEvent types
      AdEvent: {
        Type: {
          AD_BREAK_READY: 'adBreakReady',
          AD_BUFFERING: 'adBuffering',
          AD_CAN_PLAY: 'adCanPlay',
          AD_METADATA: 'adMetadata',
          AD_PROGRESS: 'adProgress',
          ALL_ADS_COMPLETED: 'allAdsCompleted',
          CLICK: 'click',
          COMPLETE: 'complete',
          CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
          CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
          DURATION_CHANGE: 'durationChange',
          EXPANDED_CHANGED: 'expandedChanged',
          FIRST_QUARTILE: 'firstQuartile',
          IMPRESSION: 'impression',
          INTERACTION: 'interaction',
          LINEAR_CHANGE: 'linearChange',
          LINEAR_CHANGED: 'linearChanged',
          LOADED: 'loaded',
          LOG: 'log',
          MIDPOINT: 'midpoint',
          PAUSED: 'pause',
          RESUMED: 'resume',
          SKIPPABLE_STATE_CHANGED: 'skippableStateChanged',
          SKIPPED: 'skip',
          STARTED: 'start',
          THIRD_QUARTILE: 'thirdQuartile',
          USER_CLOSE: 'userClose',
          VIDEO_CLICKED: 'videoClicked',
          VIDEO_ICON_CLICKED: 'videoIconClicked',
          VIEWABLE_IMPRESSION: 'viewable_impression',
          VOLUME_CHANGED: 'volumeChange',
          VOLUME_MUTED: 'mute'
        }
      },

      // AdError - minimal stub
      AdError: function(type, code, vast, message, request, context) {
        this.errorCode = code;
        this.message = message;
        this.type = type;
        this.adsRequest = request;
        this.userRequestContext = context;
        this.vastErrorCode = vast;
        this.getErrorCode = function() { return this.errorCode; };
        this.getInnerError = function() { return null; };
        this.getMessage = function() { return this.message; };
        this.getType = function() { return this.type; };
        this.getVastErrorCode = function() { return this.vastErrorCode; };
        this.toString = function() { return 'AdError ' + this.errorCode + ': ' + this.message; };
      },

      // AdErrorEvent - minimal stub
      AdErrorEvent: function(error) {
        this.type = 'adError';
        this.error = error;
        this.getError = function() { return this.error; };
        this.getUserRequestContext = function() { return this.error?.userRequestContext || {}; };
      },

      // AdsManagerLoadedEvent - minimal stub
      AdsManagerLoadedEvent: function(type, request, context) {
        this.type = type;
        this.adsRequest = request;
        this.userRequestContext = context;
        this.getAdsManager = function() {
          return window.google.ima.AdsManager;
        };
        this.getUserRequestContext = function() { return this.userRequestContext || {}; };
      },
      AdsManagerLoadedEvent: {
        Type: {
          ADS_MANAGER_LOADED: 'adsManagerLoaded'
        }
      },

      // AdsRequest - minimal stub
      AdsRequest: function() {
        this.setAdWillAutoPlay = function() {};
        this.setAdWillPlayMuted = function() {};
        this.setContinuousPlayback = function() {};
      },

      // AdsRenderingSettings - minimal stub
      AdsRenderingSettings: function() {},

      // Settings
      settings: {
        setAutoPlayAdBreaks: function() {},
        setCompanionBackfill: function() {},
        setCookiesEnabled: function() {},
        setDisableCustomPlaybackForIOS10Plus: function() {},
        setFeatureFlags: function() {},
        setLocale: function() {},
        setNumRedirects: function() {},
        setPlayerType: function() {},
        setPlayerVersion: function() {},
        setPpid: function() {},
        setSessionId: function() {},
        setVpaidAllowed: function() {},
        setVpaidMode: function() {},
        setDisableFlashAds: function() {}
      },

      // CompanionAdSelectionSettings
      CompanionAdSelectionSettings: {
        CreativeType: { ALL: 'All', FLASH: 'Flash', IMAGE: 'Image' },
        ResourceType: { ALL: 'All', HTML: 'Html', IFRAME: 'IFrame', STATIC: 'Static' },
        SizeCriteria: { IGNORE: 'IgnoreSize', SELECT_EXACT_MATCH: 'SelectExactMatch', SELECT_NEAR_MATCH: 'SelectNearMatch' }
      },

      // ViewMode
      ViewMode: {
        FULLSCREEN: 'fullscreen',
        NORMAL: 'normal'
      },

      // UIElements
      UiElements: {
        AD_ATTRIBUTION: 'adAttribution',
        COUNTDOWN: 'countdown'
      },

      // OmidVerificationVendor
      OmidVerificationVendor: {
        1: 'OTHER',
        2: 'GOOGLE',
        GOOGLE: 2,
        OTHER: 1
      },

      // VERSION
      VERSION: '3.764.0'
    };
  }

  // ========================================================================
  // 2. INTERCEPT FETCH TO BLOCK AD NETWORK DOMAINS
  // ========================================================================

  // Ad network domains to block
  const AD_NETWORKS = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleads.g.doubleclick.net',
    'pubads.g.doubleclick.net',
    'googleadservices.com',
    'googletagservices.com',
    'adservice.google.com',
    'pagead2.googlesyndication.com',
    'partner.googleadservices.com',
    'td.doubleclick.net',
    's0.2mdn.net',
    'static.doubleclick.net',
    'tpc.googlesyndication.com',
    'imasdk.googleapis.com',
    'youtube.com/pagead/',
    'youtube.com/api/stats/ads',
    'youtube.com/get_video_info'
  ];

  // Allowlist: never block these — used by YouTube's AI features, auth, etc.
  const ALLOWED_DOMAINS = [
    'generativelanguage.googleapis.com',
    'aiplatform.googleapis.com',
    'cloudaicompanion.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'www.googleapis.com',
    'accounts.google.com',
    'play.google.com',
    'youtube.com/youtubei/',
    'yt3.ggpht.com',
  ];

  function shouldBlockUrl(url) {
    if (!url || typeof url !== 'string') return false;
    // Never block allowlisted domains (YouTube AI, auth, etc.)
    if (ALLOWED_DOMAINS.some(domain => url.includes(domain))) return false;
    // Block ad network domains
    return AD_NETWORKS.some(domain => url.includes(domain));
  }

  const originalFetch = window.fetch;
  window.fetch = function(resource, init) {
    try {
      const url = typeof resource === 'string' ? resource : 
                  (resource instanceof Request ? resource.url : '');
      
      if (shouldBlockUrl(url)) {
        return Promise.resolve(new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    } catch (e) {
      // If any error, proceed with original request
    }
    return originalFetch.apply(this, arguments);
  };

  // ========================================================================
  // 3. INTERCEPT XMLHttpRequest TO BLOCK AD NETWORK DOMAINS
  // ========================================================================

  if (typeof XMLHttpRequest !== 'undefined') {
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    try {
      if (shouldBlockUrl(url)) {
        // Silently fail - don't make the request
        this._adbloqursBlocked = true;
        return;
      }
    } catch (e) {
      // If any error, proceed with original request
    }
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._adbloqursBlocked) {
      // Simulate successful response with empty object
      Object.defineProperty(this, 'status', { value: 200, writable: false });
      Object.defineProperty(this, 'readyState', { value: 4, writable: false });
      Object.defineProperty(this, 'responseText', { value: '{}', writable: false });
      Object.defineProperty(this, 'response', { value: '{}', writable: false });
      
      // Trigger events
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onload) this.onload();
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
      return;
    }
    return originalXHRSend.apply(this, args);
  };
  } // end XMLHttpRequest guard

  // ========================================================================
  // 4. REMOVE AD SCRIPTS FROM DOM
  // ========================================================================

  // Remove ad scripts when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeAdScripts);
  } else {
    removeAdScripts();
  }

  function removeAdScripts() {
    try {
      // Remove scripts from ad networks
      const adScriptSelectors = [
        'script[src*="doubleclick"]',
        'script[src*="googlesyndication"]',
        'script[src*="googleadservices"]',
        'script[src*="googletagservices"]',
        'script[src*="imasdk"]',
        'script[src*="pagead"]'
      ];
      
      for (const selector of adScriptSelectors) {
        const scripts = document.querySelectorAll(selector);
        scripts.forEach(script => script.remove());
      }
    } catch (e) {
      // DOM manipulation errors are non-critical
    }
  }

  // ========================================================================
  // 5. INJECT CSS TO HIDE AD ELEMENTS
  // ========================================================================

  const adBlockingCSS = `
    /* Hide ad containers */
    ytd-ad-slot-renderer { display: none !important; }
    ytd-in-feed-ad-layout-renderer { display: none !important; }
    ytd-display-ad-renderer { display: none !important; }
    ytd-video-masthead-ad-v3-renderer { display: none !important; }
    ytd-video-masthead-ad-advertiser-info-renderer { display: none !important; }
    ytd-video-masthead-ad-primary-video-renderer { display: none !important; }
    ytd-action-companion-ad-renderer { display: none !important; }
    yt-about-this-ad-renderer { display: none !important; }
    yt-mealbar-promo-renderer { display: none !important; }
    ytd-statement-banner-renderer { display: none !important; }
    ytd-banner-promo-renderer-background { display: none !important; }
    #masthead-ad { display: none !important; }
    ad-slot-renderer { display: none !important; }
    ytm-promoted-sparkles-web-renderer { display: none !important; }
    div#root.style-scope.ytd-display-ad-renderer.yt-simple-endpoint { display: none !important; }
    div#sparkles-container.style-scope.ytd-promoted-sparkles-web-renderer { display: none !important; }
    div#main-container.style-scope.ytd-promoted-video-renderer { display: none !important; }
    ytd-promoted-video-renderer { display: none !important; }
    ytd-compact-promoted-video-renderer { display: none !important; }
    ytd-search-ad-renderer { display: none !important; }
    ytd-rich-item-renderer[is-ad] { display: none !important; }
    ytd-ad-persistent-header-renderer { display: none !important; }
    
    /* Hide video ad elements */
    video-ads { display: none !important; }
    .ad-showing { display: none !important; }
    .ad-showing video { display: none !important; }
    ytd-ad-persistent-header-renderer { display: none !important; }
    yt-formatted-string[aria-label*="Advertisement"] { display: none !important; }
    
    /* Hide overlay ads */
    .ytp-ad-overlay-container { display: none !important; }
    .ytp-ad-overlay-slot { display: none !important; }
    .ytp-ad-overlay-wrapper { display: none !important; }
    .ytp-ad-text-overlay { display: none !important; }
    .ytp-ad-image-overlay { display: none !important; }
    .ytp-ad-message-overlay { display: none !important; }
    .ytp-ad-simple-ad-badge { display: none !important; }
    .ytp-ad-badge { display: none !important; }
    .ytp-ad-action-interstitial { display: none !important; }
    .ytp-ad-overlay-content { display: none !important; }
    .ytp-ad-module-container { display: none !important; }
    .video-ads { display: none !important; }
    
    /* Hide page-level ads */
    div#player-ads.style-scope.ytd-watch-flexy { display: none !important; }
    div#panels.style-scope.ytd-watch-flexy { display: none !important; }
    
    /* Hide anti-adblock popup */
    ytd-enforcement-message-view-model { display: none !important; visibility: hidden !important; }
    
    /* Hide Shorts ads */
    ytd-reel-player-overlay-renderer.ytd-reel-player-overlay-renderer { display: none !important; }
    ytd-shelf-renderer[class*="ad"] { display: none !important; }
    
    /* Hide home feed promoted content */
    ytd-rich-section-renderer:has([is-ad]) { display: none !important; }
    
    /* General ad containers - only target YouTube's known ad elements */
    ytd-ad-slot-renderer[ad-format] { display: none !important; }
    ytd-rich-item-renderer[is-ad] { display: none !important; }
  `;

  // Inject CSS
  function injectAdBlockingCSS() {
    if (document.getElementById('adbloqurs-yt-css')) return;
    
    const style = document.createElement('style');
    style.id = 'adbloqurs-yt-css';
    style.textContent = adBlockingCSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // Mute any video immediately to prevent ad audio bleed
  // YouTube plays ads on the same <video> element as content
  if (typeof HTMLVideoElement !== 'undefined') {
    const _origPlay = HTMLVideoElement.prototype.play;
    HTMLVideoElement.prototype.play = function() {
      const player = document.querySelector('#movie_player');
      if (player && player.classList.contains('ad-showing')) {
        this.muted = true;
      }
      return _origPlay.apply(this, arguments);
    };
  }

  // Inject CSS as early as possible
  injectAdBlockingCSS();

  // Also inject after DOM is ready in case it wasn't available
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAdBlockingCSS);
  }

  console.log('[AdbloquRs] YouTube ad blocking v2 initialized (aggressive disable + network interception)');
})();
