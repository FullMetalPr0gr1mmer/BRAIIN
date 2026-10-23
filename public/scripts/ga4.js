/*
 * Google Analytics 4, behind analytics consent (Admin v2 U15; CLAUDE.md §2 "GA4 secondary,
 * behind consent", §7 the one consent gate).
 *
 * A same-origin classic script, rendered only on a public page whose response lists Google's
 * hosts in its CSP (src/components/Ga4Loader.astro, src/lib/http/ga4.ts): the switch on, a
 * saved id, a public page route. Its tag carries what it needs in data attributes, never as
 * inline script or JSON (the CSP has no 'unsafe-inline'):
 *   data-ga4-id               the measurement id, G- and 4 to 15 capitals or digits;
 *   data-consent-version      the consent version a choice must have been made under.
 *
 * NOTHING FROM GOOGLE LOADS BEFORE CONSENT. gtag.js is requested only once the visitor's
 * choice grants analytics, read from the consent cookie exactly as the server's gate reads it
 * (packages/consent/gate.ts hasConsent: the same cookie, the same shape, analytics true;
 * tests/lib/ga4Loader.spec.ts holds the two equal), and only when that choice was made under
 * the current consent version, so consent given to a notice that did not name Google never
 * loads it. Then: consent mode with analytics granted and every advertising signal denied,
 * Google signals and ad personalisation off, cookies on this host only, at most 180 days (the
 * consent cookie's own lifetime), and page addresses sent without their query or fragment.
 *
 * ON WITHDRAWAL (the banner's `consent-updated`, a choice changed in another tab, a page
 * restored from the back-forward cache): consent mode denied, Google's own off switch
 * (`ga-disable-<id>`), nothing more loaded, and the `_ga` cookies cleared as far as a page
 * can (this host and its parent domains). A page loaded without consent clears them too.
 *
 * THE REPORT-ONLY CYCLE (U15's as-built): a request gtag.js makes to a host the CSP does not
 * list is refused by the browser, and this reports the directive and the host (never the URL,
 * whose query carries the visitor's id) to the first-party error log, at most five a page.
 */
(function () {
  'use strict';

  const script = document.currentScript;
  if (!script) return;
  const id = script.getAttribute('data-ga4-id') || '';
  const version = Number(script.getAttribute('data-consent-version'));
  if (!/^G-[A-Z0-9]{4,15}$/.test(id) || !Number.isInteger(version) || version < 0) return;

  const CONSENT_COOKIE = '__Host-consent';
  const GTAG = 'https://www.googletagmanager.com/gtag/js?id=';
  const OFF = 'ga-disable-' + id;
  /** The cookies gtag.js sets for GA4: `_ga`, and `_ga_<container>` for each property. */
  const GA_COOKIE = /^_ga(?:_[A-Za-z0-9]+)?$/;
  const COOKIE_SECONDS = 15552000;

  /** gate.ts readCookie: the first cookie of that name, its value trimmed. */
  function readCookie(name) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
  }

  /** gate.ts parseConsentCookie + ConsentStateSchema: the stored choice, or null for none. */
  function consentState() {
    const raw = readCookie(CONSENT_COOKIE);
    if (!raw) return null;
    try {
      const state = JSON.parse(decodeURIComponent(raw));
      const count = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
      if (
        state === null ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        state.functional !== true ||
        typeof state.analytics !== 'boolean' ||
        typeof state.marketing !== 'boolean' ||
        !count(state.v) ||
        !count(state.ts)
      ) {
        return null;
      }
      return state;
    } catch {
      return null;
    }
  }

  /** hasConsent(req, 'analytics'), given under the notice this page shows. */
  function granted() {
    const state = consentState();
    return state !== null && state.analytics === true && state.v === version;
  }

  function gtag() {
    window.dataLayer.push(arguments);
  }

  /** An address without its query or fragment ('' for none or one that is not a URL). */
  function bare(href) {
    try {
      const url = new URL(href);
      return url.origin + url.pathname;
    } catch {
      return '';
    }
  }

  function clearCookies() {
    const names = new Set();
    for (const part of document.cookie.split(';')) {
      const name = part.split('=')[0].trim();
      if (GA_COOKIE.test(name)) names.add(name);
    }
    if (names.size === 0) return;
    // Host-only, then this host and each parent domain (a browser refuses a public suffix).
    const labels = location.hostname.split('.');
    const domains = [''];
    for (let i = 0; i < labels.length - 1; i++) domains.push(labels.slice(i).join('.'));
    for (const name of names) {
      for (const domain of domains) {
        document.cookie =
          name + '=; Max-Age=0; Path=/' + (domain ? '; Domain=' + domain : '') + '; SameSite=Lax';
      }
    }
  }

  const GOOGLE =
    /(?:^|\.)(?:googletagmanager\.com|google-analytics\.com|google\.com|doubleclick\.net|googlesyndication\.com|google\.[a-z]{2,3}(?:\.[a-z]{2})?)$/;

  function watchCsp() {
    const seen = new Set();
    document.addEventListener('securitypolicyviolation', (event) => {
      let origin;
      try {
        const url = new URL(event.blockedURI);
        if (!GOOGLE.test(url.hostname)) return;
        origin = url.origin;
      } catch {
        return;
      }
      const key = event.effectiveDirective + ' ' + origin;
      if (seen.has(key) || seen.size >= 5) return;
      seen.add(key);
      try {
        navigator.sendBeacon(
          '/api/clientlog',
          JSON.stringify({
            level: 'warn',
            message:
              'GA4: the CSP refused ' + event.effectiveDirective + ' ' + origin + ' (not listed)',
            source: 'ga4-csp',
            path: location.pathname,
          }),
        );
      } catch {
        /* never let reporting throw */
      }
    });
  }

  let started = false;

  function start() {
    started = true;
    window[OFF] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = gtag;
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    const config = {
      cookie_domain: 'none',
      cookie_expires: COOKIE_SECONDS,
      cookie_flags: 'SameSite=Lax;Secure',
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: bare(location.href),
    };
    const referrer = bare(document.referrer);
    if (referrer) config.page_referrer = referrer;
    gtag('config', id, config);
    watchCsp();
    const tag = document.createElement('script');
    tag.async = true;
    tag.src = GTAG + encodeURIComponent(id);
    document.head.appendChild(tag);
  }

  function stop() {
    window[OFF] = true;
    if (started) {
      gtag('consent', 'update', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
    }
    clearCookies();
  }

  /** The page follows the stored choice: start, resume, or stop and clear. */
  function sync() {
    if (!granted()) {
      stop();
    } else if (!started) {
      start();
    } else if (window[OFF] === true) {
      window[OFF] = false;
      gtag('consent', 'update', { analytics_storage: 'granted' });
    }
  }

  sync();
  document.addEventListener('consent-updated', sync);
  addEventListener('pageshow', (event) => {
    if (event.persisted) sync();
  });
})();
