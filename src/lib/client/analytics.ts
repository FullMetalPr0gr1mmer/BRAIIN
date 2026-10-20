// The public site's first-party analytics emitter (PageView.astro imports it on every public
// route; Admin v2 G1 moved the pageview beacon here and added two events).
//
//   pageview          on `pageshow` (a fresh load and a back/forward-cache restore), and on
//                     `consent-updated` (opting in mid-visit counts the page you opted in on).
//   cta_click         one delegated `click` listener on the document: an element carrying
//                     `data-track="<id>"` (a closed vocabulary, CTA_IDS in
//                     packages/schemas/analytics.ts, checked again by the ingest), at most once
//                     per id per page view. Never on a form field: no event comes from the
//                     contact form (a session trail beside an identified lead, G1 D4).
//   service_interest  a `bs:interest` CustomEvent (detail `{ discipline }` or `{ service }`),
//                     dispatched by the /services explorer when the visitor opens a panel or
//                     chooses a service there, at most once per key per page view.
//
// Nothing is sent without analytics consent (read here from the consent cookie, and
// re-checked by /api/analytics with hasConsent), and nothing new is stored: the same per-tab
// `bs_sid` the page views always carried. `sendBeacon`, so a beacon never delays a navigation
// and survives the one the click starts (the language link). No layout reads, no work on
// idle: one listener for clicks and one for the explorer's event.
//
// ── Why a module, not an inline script with the locale passed in ─────────────────────────
// `define:vars` cannot produce an external script: injecting the values requires the script
// to be INLINE, and our CSP is `script-src 'self' 'nonce-…'` with no 'unsafe-inline', so the
// browser refuses to execute it (tests/e2e/csp.e2e.ts caught exactly that). The locale is on
// <html lang> already (BaseLayout sets it).
//
// The session id is a random per-tab value in sessionStorage. It is NOT an identifier: it
// dies with the tab, is never joined to a user, and exists only so visits are countable.
// Under PDPL that keeps this an analytics measure rather than a tracking one, but it is still
// consent-gated, because the visitor's expectation governs, not our data model.

const COOKIE = '__Host-consent';
const ENDPOINT = '/api/analytics';

/** True when the consent cookie records analytics as accepted. */
export function analyticsConsent(cookie: string = document.cookie): boolean {
  const match = cookie.split('; ').find((c) => c.startsWith(COOKIE + '='));
  if (!match) return false;
  try {
    return JSON.parse(decodeURIComponent(match.slice(COOKIE.length + 1))).analytics === true;
  } catch {
    return false;
  }
}

function sessionId(): string | undefined {
  try {
    let id = sessionStorage.getItem('bs_sid');
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('bs_sid', id);
    }
    return id;
  } catch {
    // Storage blocked (private mode, strict cookie policy). Beacon anonymously rather than
    // not at all: the counts stay right, only the visit grouping is lost.
    return undefined;
  }
}

type Props = Readonly<Record<string, string>>;

/** One beacon, with consent only. True when it was handed to the browser. */
function send(type: 'pageview' | 'cta_click' | 'service_interest', props?: Props): boolean {
  if (!analyticsConsent()) return false;
  try {
    const locale = document.documentElement.lang === 'ar' ? 'ar' : 'en';
    const body = { type, path: location.pathname, locale, sessionId: sessionId(), props };
    return navigator.sendBeacon(
      ENDPOINT,
      new Blob([JSON.stringify(body)], { type: 'application/json' }),
    );
  } catch {
    // A failed beacon is never worth an error to the visitor.
    return false;
  }
}

/** The explorer's event name (src/lib/client/serviceExplorer.ts dispatches it). */
export const INTEREST_EVENT = 'bs:interest';

/** What the explorer says the visitor showed interest in. */
export type InterestDetail = { discipline: string } | { service: string };

let wired = false;

/** Wires the three events. Idempotent per document. */
export function initAnalytics(): void {
  if (wired) return;
  wired = true;

  let viewSent = false;
  const sendView = () => {
    if (viewSent || !analyticsConsent()) return;
    viewSent = true;
    send('pageview');
  };
  // `pageshow` covers both a fresh load and a bfcache restore.
  addEventListener('pageshow', sendView);
  document.addEventListener('consent-updated', sendView);

  // Once per id (or key) per page view: a second click on the same link counts nothing.
  const done = new Set<string>();
  const once = (key: string, type: 'cta_click' | 'service_interest', props: Props) => {
    if (done.has(key) || !analyticsConsent()) return;
    done.add(key);
    send(type, props);
  };

  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-track]') : null;
    const id = el?.getAttribute('data-track');
    if (!id || el?.closest('form')) return;
    once(`c:${id}`, 'cta_click', { cta: id });
  });

  document.addEventListener(INTEREST_EVENT, (e) => {
    const detail = (e as CustomEvent<unknown>).detail as Partial<Record<string, unknown>> | null;
    const discipline = detail?.['discipline'];
    const service = detail?.['service'];
    if (typeof discipline === 'string') once(`d:${discipline}`, 'service_interest', { discipline });
    else if (typeof service === 'string') once(`s:${service}`, 'service_interest', { service });
  });
}

/** Tells the emitter the visitor showed interest in a discipline or a service. */
export function interest(detail: InterestDetail): void {
  document.dispatchEvent(new CustomEvent(INTEREST_EVENT, { detail }));
}
