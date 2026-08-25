/**
 * AdbloquRs: YouTube IMA SDK shim (v8 — Firebase and Google Domain Blocking)
 *
 * Enhanced approach that blocks ads without breaking video startup or AI features:
 * 1. Stub out google.ima completely before YouTube loads
 * 2. Fire realistic ad completion events with proper timing
 * 3. Intercept and block all ad network requests including Firebase and Google ad domains
 * 4. Inject CSS to hide all ad elements immediately
 * 5. Remove ad scripts from the DOM as soon as they appear
 * 6. Minimal player hooks that don't interfere with normal playback
 * 7. Ad detection only when ad module content is present (prevents false positives)
 * 8. Restrictive allowlist to prevent Google ad domains from slipping through
 *
 * Runs in MAIN world at document_start before YouTube's scripts load.
 *
 * MIT License
 *
 * Copyright (c) 2026 AdbloquRs Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';

(function() {
  // ========================================================================
  // 1. STUB OUT GOOGLE IMA SDK (ENHANCED WITH REALISTIC EVENT FIRING)
  // ========================================================================
  // Create a realistic stub that makes YouTube think ads loaded and completed
  // naturally with proper event timing sequence to avoid detection.

  window.google = window.google || {};
  
  // Event dispatcher helper
  function dispatchEvent(manager, eventType) {
    try {
      if (manager._listeners && manager._listeners[eventType]) {
        manager._listeners[eventType].forEach(callback => {
          try {
            callback({ type: eventType });
          } catch (e) {
            // Ignore callback errors
          }
        });
      }
    } catch (e) {
      // Ignore dispatch errors
    }
  }
  
  // Create a minimal stub that makes YouTube think the SDK loaded
  // and fires realistic ad completion events
  if (!window.google.ima || !window.google.ima.VERSION) {
    window.google.ima = {
      // AdsManager - fires realistic ad completion sequence
      AdsManager: function() {
        this._listeners = {};
        this._started = false;
        
        this.start = function() {
          if (this._started) return;
          this._started = true;
          
          // Fire realistic ad event sequence with proper timing
          const eventSequence = [
            { type: 'LOADED', delay: 0 },
            { type: 'STARTED', delay: 50 },
            { type: 'AD_BUFFERING', delay: 100 },
            { type: 'FIRST_QUARTILE', delay: 150 },
            { type: 'MIDPOINT', delay: 200 },
            { type: 'THIRD_QUARTILE', delay: 250 },
            { type: 'COMPLETE', delay: 300 },
            { type: 'ALL_ADS_COMPLETED', delay: 350 }
          ];
          
          eventSequence.forEach(event => {
            setTimeout(() => {
              dispatchEvent(this, event.type);
            }, event.delay);
          });
        };
        
        this.pause = function() { return; };
        this.resume = function() { return; };
        this.stop = function() { return; };
        this.destroy = function() { return; };
        this.getVolume = function() { return 0; };
        this.setVolume = function() { return; };
        this.init = function() { return; };
        this.expand = function() { return; };
        this.collapse = function() { return; };
        this.skip = function() { 
          // Fire skip event when user skips
          dispatchEvent(this, 'SKIPPED');
          return; 
        };
        this.configureAdsManager = function() { return; };
        this.discardAdBreak = function() { return; };
        this.focus = function() { return; };
        this.resize = function() { return; };
        this.updateAdsRenderingSettings = function() { return; };
        this.getAdSkippableState = function() { return true; }; // Make ads appear skippable
        this.getCuePoints = function() { return []; };
        this.getCurrentAd = function() { return null; };
        this.getCurrentAdCuePoints = function() { return []; };
        this.getRemainingTime = function() { return 0; };
        this.requestNextAdBreak = function() { return; };
        this.isCustomPlaybackUsed = function() { return false; };
        this.isCustomClickTrackingUsed = function() { return false; }
        
        // Event listener management
        this.addEventListener = function(eventType, callback) {
          if (!this._listeners[eventType]) {
            this._listeners[eventType] = [];
          }
          this._listeners[eventType].push(callback);
        };
        
        this.removeEventListener = function(eventType, callback) {
          if (this._listeners[eventType]) {
            this._listeners[eventType] = this._listeners[eventType].filter(cb => cb !== callback);
          }
        };
      },

      // AdsLoader - fires realistic manager loaded events
      AdsLoader: function() {
        this._listeners = {};
        
        this.requestAds = function(request) {
          // Fire ADS_MANAGER_LOADED event after a short delay
          setTimeout(() => {
            dispatchEvent(this, 'ADS_MANAGER_LOADED');
          }, 25);
        };
        
        this.contentComplete = function() { 
          // Fire content complete event
          dispatchEvent(this, 'CONTENT_COMPLETE');
        };
        
        this.destroy = function() { return; };
        
        this.getSettings = function() {
          return {
            setAutoPlayAdBreaks: function() { return; },
            setCompanionBackfill: function() { return; },
            setCookiesEnabled: function() { return; },
            setDisableCustomPlaybackForIOS10Plus: function() { return; },
            setFeatureFlags: function() { return; },
            setLocale: function() { return; },
            setNumRedirects: function() { return; },
            setPlayerType: function() { return; },
            setPlayerVersion: function() { return; },
            setPpid: function() { return; },
            setSessionId: function() { return; },
            setVpaidAllowed: function() { return; },
            setVpaidMode: function() { return; },
            setDisableFlashAds: function() { return; },
            getCompanionBackfill: function() { return ''; },
            getDisableCustomPlaybackForIOS10Plus: function() { return false; },
            getFeatureFlags: function() { return {}; },
            getLocale: function() { return ''; },
            getNumRedirects: function() { return 0; },
            getPlayerType: function() { return ''; },
            getPlayerVersion: function() { return ''; },
            getPpid: function() { return ''; },
            isCookiesEnabled: function() { return false; },
            getDisableFlashAds: function() { return; }
          };
        };
        
        this.getVersion = function() { return '3.764.0'; };
        
        // Event listener management
        this.addEventListener = function(eventType, callback) {
          if (!this._listeners[eventType]) {
            this._listeners[eventType] = [];
          }
          this._listeners[eventType].push(callback);
        };
        
        this.removeEventListener = function(eventType, callback) {
          if (this._listeners[eventType]) {
            this._listeners[eventType] = this._listeners[eventType].filter(cb => cb !== callback);
          }
        };
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
    'youtube.com/get_video_info',
    'ad.doubleclick.net',
    'ad.col.doubleclick.net',
    'adx.g.doubleclick.net',
    'fls.doubleclick.net',
    'googletagservices.com/gpt.js',
    'youtube.com/ptracking',
    'youtube.com/api/stats/playback',
    'youtube.com/youtubei/v1/player?key=*&adformat',
    'youtube.com/youtubei/v1/player?key=*&ad_type',
    'googlevideo.com/videoplayback?*ad=',
    'googlevideo.com/videoplayback?*ctier=',
    // Firebase and Google domains often used for ads
    'firebase.google.com',
    'firebaseio.com',
    'firebaseapp.com',
    'googletagmanager.com',
    'google-analytics.com',
    'analytics.google.com',
    'googleads.g.doubleclick.net',
    'adwords.google.com',
    'ads.google.com',
    'developers.google.com',
    'support.google.com',
    'www.google.com/ad',
    'www.google.com/ads',
    'google.com/ads',
    'google.com/ad',
    'google.com/pagead',
    'google.com/afs',
    'google.com/aclk',
    'google.com/search?ad',
    'googleads.g.doubleclick.net/pagead',
    'googleads.g.doubleclick.net/td',
    'www.googletagmanager.com',
    'www.google-analytics.com',
    'ssl.google-analytics.com',
    'stats.g.doubleclick.net',
    'g.doubleclick.net',
    'fundingchoices.google.com',
    'consent.google.com',
    'adssettings.google.com',
    'adsense.google.com',
    'admob.google.com',
    'admanager.google.com',
    'dv360.google.com',
    'campaignmanager.google.com',
    'displayvideo.google.com',
    'searchads.google.com',
    'google.com/adsense',
    'google.com/afs/ads',
    'google.com/search?q=ad',
    'google.com/search?source=ad',
    'youtube.com/api/ads',
    'youtube.com/ads',
    'youtube.com/ad_stats',
    'youtube.com/ad_click',
    'youtube.com/ad_interaction',
    'youtube.com/ad_impression',
    'youtube.com/ad_playback',
    'youtube.com/ad_log',
    'youtube.com/ad_survey',
    'youtube.com/ad_feedback',
    'youtube.com/ad_pref',
    'youtube.com/ad_overlay',
    'youtube.com/ad_banner',
    'youtube.com/ad_companion',
    'youtube.com/ad_skip',
    'youtube.com/ad_pause',
    'youtube.com/ad_resume',
    'youtube.com/ad_progress',
    'youtube.com/ad_complete',
    'youtube.com/ad_error',
    'youtube.com/ad_load',
    'youtube.com/ad_start',
    'youtube.com/ad_end',
    'youtube.com/ad_buffer',
    'youtube.com/ad_seek',
    'youtube.com/ad_volume',
    'youtube.com/ad_mute',
    'youtube.com/ad_unmute',
    'youtube.com/ad_fullscreen',
    'youtube.com/ad_clickthrough',
    'youtube.com/ad_hover',
    'youtube.com/ad_leave',
    'youtube.com/ad_enter',
    'youtube.com/ad_close',
    'youtube.com/ad_minimize',
    'youtube.com/ad_expand',
    'youtube.com/ad_collapse',
    'youtube.com/ad_resize',
    'youtube.com/ad_rotation',
    'youtube.com/ad_orientation',
    'youtube.com/ad_metadata',
    'youtube.com/ad_cuepoint',
    'youtube.com/ad_break',
    'youtube.com/ad_pod',
    'youtube.com/ad_sequence',
    'youtube.com/ad_schedule',
    'youtube.com/ad_placement',
    'youtube.com/ad_slot',
    'youtube.com/ad_unit',
    'youtube.com/ad_format',
    'youtube.com/ad_type',
    'youtube.com/ad_category',
    'youtube.com/ad_creative',
    'youtube.com/ad_campaign',
    'youtube.com/ad_lineitem',
    'youtube.com/ad_order',
    'youtube.com/ad_insertion',
    'youtube.com/ad_instream',
    'youtube.com/ad_overlay',
    'youtube.com/ad_companion',
    'youtube.com/ad_display',
    'youtube.com/ad_video',
    'youtube.com/ad_audio',
    'youtube.com/ad_image',
    'youtube.com/ad_text',
    'youtube.com/ad_richmedia',
    'youtube.com/ad_interactive',
    'youtube.com/ad_native',
    'youtube.com/ad_sponsored',
    'youtube.com/ad_promoted',
    'youtube.com/ad_featured',
    'youtube.com/ad_recommended',
    'youtube.com/ad_suggested',
    'youtube.com/ad_related',
    'youtube.com/ad_shopping',
    'youtube.com/ad_product',
    'youtube.com/ad_merchandise',
    'youtube.com/ad_donation',
    'youtube.com/ad_fundraising',
    'youtube.com/ad_crowdfunding',
    'youtube.com/ad_subscription',
    'youtube.com/ad_membership',
    'youtube.com/ad_premium',
    'youtube.com/ad_paid',
    'youtube.com/ad_rental',
    'youtube.com/ad_purchase',
    'youtube.com/ad_transaction',
    'youtube.com/ad_payment',
    'youtube.com/ad_checkout',
    'youtube.com/ad_cart',
    'youtube.com/ad_wishlist',
    'youtube.com/ad_favorites',
    'youtube.com/ad_watchlist',
    'youtube.com/ad_history',
    'youtube.com/ad_library',
    'youtube.com/ad_collection',
    'youtube.com/ad_playlist',
    'youtube.com/ad_channel',
    'youtube.com/ad_user',
    'youtube.com/ad_creator',
    'youtube.com/ad_brand',
    'youtube.com/ad_business',
    'youtube.com/ad_company',
    'youtube.com/ad_organization',
    'youtube.com/ad_institution',
    'youtube.com/ad_agency',
    'youtube.com/ad_network',
    'youtube.com/ad_platform',
    'youtube.com/ad_service',
    'youtube.com/ad_provider',
    'youtube.com/ad_vendor',
    'youtube.com/ad_partner',
    'youtube.com/ad_affiliate',
    'youtube.com/ad_reseller',
    'youtube.com/ad_distributor',
    'youtube.com/ad_publisher',
    'youtube.com/ad_advertiser',
    'youtube.com/ad_marketer',
    'youtube.com/ad_promoter',
    'youtube.com/ad_sponsor',
    'youtube.com/ad_patron',
    'youtube.com/ad_backer',
    'youtube.com/ad_supporter',
    'youtube.com/ad_funder',
    'youtube.com/ad_investor',
    'youtube.com/ad_financier',
    'youtube.com/ad_benefactor',
    'youtube.com/ad_donor',
    'youtube.com/ad_contributor',
    'youtube.com/ad_subscriber',
    'youtube.com/ad_member',
    'youtube.com/ad_follower',
    'youtube.com/ad_fan',
    'youtube.com/ad_viewer',
    'youtube.com/ad_audience',
    'youtube.com/ad_target',
    'youtube.com/ad_segment',
    'youtube.com/ad_demographic',
    'youtube.com/ad_geographic',
    'youtube.com/ad_behavioral',
    'youtube.com/ad_contextual',
    'youtube.com/ad_retargeting',
    'youtube.com/ad_remarketing',
    'youtube.com/ad_personalization',
    'youtube.com_ad',
    'ad_youtube',
    'ytp-ad',
    'ytp_ad',
    'masthead-ad',
    'companion-ad',
    'display-ad',
    'overlay-ad',
    'instream-ad',
    'midroll-ad',
    'preroll-ad',
    'postroll-ad',
    'bumper-ad',
    'skippable-ad',
    'non-skippable-ad',
    'linear-ad',
    'non-linear-ad',
    'static-ad',
    'dynamic-ad',
    'interactive-ad',
    'rich-media-ad',
    'video-ad',
    'audio-ad',
    'image-ad',
    'text-ad',
    'native-ad',
    'sponsored-ad',
    'promoted-ad',
    'featured-ad',
    'recommended-ad',
    'suggested-ad',
    'related-ad',
    'shopping-ad',
    'product-ad',
    'merchandise-ad',
    'donation-ad',
    'fundraising-ad',
    'crowdfunding-ad',
    'subscription-ad',
    'membership-ad',
    'premium-ad',
    'paid-ad',
    'rental-ad',
    'purchase-ad',
    'transaction-ad',
    'payment-ad',
    'checkout-ad',
    'cart-ad',
    'wishlist-ad',
    'favorites-ad',
    'watchlist-ad',
    'history-ad',
    'library-ad',
    'collection-ad',
    'playlist-ad',
    'channel-ad',
    'user-ad',
    'creator-ad',
    'brand-ad',
    'business-ad',
    'company-ad',
    'organization-ad',
    'institution-ad',
    'agency-ad',
    'network-ad',
    'platform-ad',
    'service-ad',
    'provider-ad',
    'vendor-ad',
    'partner-ad',
    'affiliate-ad',
    'reseller-ad',
    'distributor-ad',
    'publisher-ad',
    'advertiser-ad',
    'marketer-ad',
    'promoter-ad',
    'sponsor-ad',
    'patron-ad',
    'backer-ad',
    'supporter-ad',
    'funder-ad',
    'investor-ad',
    'financier-ad',
    'benefactor-ad',
    'donor-ad',
    'contributor-ad',
    'subscriber-ad',
    'member-ad',
    'follower-ad',
    'fan-ad',
    'viewer-ad',
    'audience-ad',
    'target-ad',
    'segment-ad',
    'demographic-ad',
    'geographic-ad',
    'behavioral-ad',
    'contextual-ad',
    'retargeting-ad',
    'remarketing-ad',
    'personalization-ad'
  ];

  // Allowlist: never block these — used by YouTube's AI features, auth, etc.
  // Be very selective to avoid allowing ad-serving Google domains
  const ALLOWED_DOMAINS = [
    'generativelanguage.googleapis.com',
    'aiplatform.googleapis.com',
    'cloudaicompanion.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'accounts.google.com',
    'youtube.com/youtubei/v1/ask',
    'youtube.com/youtubei/v1/chat',
    'youtube.com/youtubei/v1/assistant',
    'yt3.ggpht.com',
    'yt.ggpht.com',
    'youtubei.googleapis.com',
    'youtubekids.googleapis.com',
  ];

  function shouldBlockUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    // Never block allowlisted domains (YouTube AI, auth, etc.)
    // Check allowlist first to ensure AI features work
    for (const domain of ALLOWED_DOMAINS) {
      if (url.includes(domain)) {
        return false;
      }
    }
    
    // Only block known ad network domains
    for (const domain of AD_NETWORKS) {
      if (url.includes(domain)) {
        return true;
      }
    }
    
    return false;
  }

  const originalFetch = window.fetch;
  window.fetch = function(resource, init) {
    try {
      let url = typeof resource === 'string' ? resource : 
                  (resource instanceof Request ? resource.url : '');
      
      if (shouldBlockUrl(url)) {
        // Block ad network requests
        return Promise.resolve(new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    } catch (e) {
      // If any error, proceed with original request
    }
    // For non-blocked requests, use original fetch to preserve streaming responses
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
      // Remove scripts from ad networks including Firebase and Google ad domains
      const adScriptSelectors = [
        'script[src*="doubleclick"]',
        'script[src*="googlesyndication"]',
        'script[src*="googleadservices"]',
        'script[src*="googletagservices"]',
        'script[src*="imasdk"]',
        'script[src*="pagead"]',
        'script[src*="firebase"]',
        'script[src*="googletagmanager"]',
        'script[src*="google-analytics"]',
        'script[src*="analytics.google"]',
        'script[src*="adwords"]',
        'script[src*="ads.google"]',
        'script[src*="fundingchoices"]',
        'script[src*="consent.google"]',
        'script[src*="adsense"]',
        'script[src*="admob"]',
        'script[src*="admanager"]',
        'script[src*="google.com/ads"]',
        'script[src*="google.com/pagead"]'
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
    /* Hide specific ad containers - very targeted selectors */
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
    
    /* Hide Firebase and Google ad containers */
    iframe[src*="firebase"] { display: none !important; }
    iframe[src*="googletagmanager"] { display: none !important; }
    iframe[src*="google-analytics"] { display: none !important; }
    iframe[src*="doubleclick"] { display: none !important; }
    iframe[src*="googlesyndication"] { display: none !important; }
    
    /* Hide video ad elements - but don't hide general containers */
    video-ads { display: none !important; }
    .ytp-ad-module { display: none !important; }
    ytd-ad-persistent-header-renderer { display: none !important; }
    /* Removed broad aria-label selector that could hide AI UI */
    
    /* Hide overlay ads - specific overlay elements only */
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
    
    /* Hide page-level ads - specific containers only */
    div#player-ads.style-scope.ytd-watch-flexy { display: none !important; }
    
    /* Hide anti-adblock popup */
    ytd-enforcement-message-view-model { display: none !important; }
    
    /* Hide Shorts ads - specific ads only */
    ytd-reel-player-overlay-renderer[class*="ad"] { display: none !important; }
    ytd-shelf-renderer[class*="ad"] { display: none !important; }
    
    /* Hide home feed promoted content - specific ad indicators only */
    ytd-rich-item-renderer[is-ad] { display: none !important; }
    
    /* Hide YouTube Shop/Shopping ads - specific shopping elements only */
    ytd-product-renderer { display: none !important; }
    ytd-shelf-renderer[shelf-type*="shopping"] { display: none !important; }
    ytd-compact-shopping-list-renderer { display: none !important; }
    ytd-merch-shelf-renderer { display: none !important; }
    ytd-shopping-shelf-renderer { display: none !important; }
    ytd-companion-slot-renderer { display: none !important; }
    ytd-donation-shelf-renderer { display: none !important; }
    ytd-grid-movie-renderer[is-shopping] { display: none !important; }
    ytd-carousel-ad-renderer { display: none !important; }
    ytd-ecommerce-renderer { display: none !important; }
    ytd-grid-renderer[yt-marketplace-renderer] { display: none !important; }
    
    /* PRESERVE AI UI - explicitly ensure AI features are visible */
    ytd-ask-ai-button-renderer { display: block !important; visibility: visible !important; }
    ytd-generative-ai-section-renderer { display: block !important; visibility: visible !important; }
    .ytp-ask-button { display: block !important; visibility: visible !important; }
  `;

  // Inject CSS
  function injectAdBlockingCSS() {
    if (document.getElementById('adbloqurs-yt-css')) return;
    
    const style = document.createElement('style');
    style.id = 'adbloqurs-yt-css';
    style.textContent = adBlockingCSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ========================================================================
  // 6. BALANCED PLAYER HOOKS (SAFE FOR AI + VIDEO STARTUP)
  // ========================================================================
  
  // Balanced hooks that block ads without breaking video startup
  function balancedPlayerHooks() {
    // Only hook video play to mute during ads, don't interfere with normal playback
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
  }
  
  // Run balanced hooks
  balancedPlayerHooks();

  // Inject CSS as early as possible
  injectAdBlockingCSS();

  // Also inject after DOM is ready in case it wasn't available
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAdBlockingCSS);
  }

  console.log('[AdbloquRs] YouTube ad blocking v8 initialized (Firebase and Google domain blocking)');
})();
