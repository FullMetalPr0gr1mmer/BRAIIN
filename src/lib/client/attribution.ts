// Lead attribution, the browser's half (Admin v2 C13, crm.md §7.3; HELD for O-11): the first
// touch of the browsing session, which only the browser sees — the other site that sent the
// visitor (its host name, never the URL) and the campaign tags of their first page — kept so an
// inquiry sent later in the session can say how the visitor found us.
//
// ONLY with analytics consent. The caller passes the consent it read from the cookie
// (src/lib/client/analytics.ts analyticsConsent): without it nothing is written, and what an
// earlier yes wrote is removed, so withdrawing consent clears it. The server checks the consent
// again through hasConsent (the gate of record) and drops everything without it.
//
// Where: sessionStorage under `bs_ft`, so it dies with the tab. Never a cookie, never sent
// anywhere but with an inquiry, never joined to the analytics session id (`bs_sid`), never the
// page's full URL or the referrer's path or query. The values are cut to the schema's bounds
// here; the server cleans them (packages/schemas/lead.ts LeadAttributionInputSchema).

export const FIRST_TOUCH_KEY = 'bs_ft';

/** What the first touch holds, as LeadInputSchema's `attribution` takes it. */
export interface FirstTouch {
  referrerHost?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

const TAGS = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
] as const;
const KEYS = ['referrerHost', 'utmSource', 'utmMedium', 'utmCampaign'] as const;
const TAG_MAX = 200;
const HOST_MAX = 253;

/** The first touch of a page: its campaign tags and, from another site only, the referrer's host. */
export function firstTouchOf(href: string, referrer: string): FirstTouch {
  const touch: FirstTouch = {};
  let here: URL;
  try {
    here = new URL(href);
  } catch {
    return touch;
  }
  for (const [param, key] of TAGS) {
    const value = here.searchParams.get(param)?.trim();
    if (value) touch[key] = value.slice(0, TAG_MAX);
  }
  if (referrer) {
    try {
      const from = new URL(referrer);
      if (
        (from.protocol === 'https:' || from.protocol === 'http:') &&
        from.hostname !== '' &&
        from.hostname !== here.hostname
      ) {
        touch.referrerHost = from.hostname.slice(0, HOST_MAX);
      }
    } catch {
      // An unreadable referrer is no referrer.
    }
  }
  return touch;
}

/**
 * Keeps this page as the session's first touch, once, with consent; without consent removes
 * whatever an earlier yes kept. Storage blocked (private mode): nothing, silently.
 */
export function recordFirstTouch(consented: boolean): void {
  try {
    if (!consented) {
      sessionStorage.removeItem(FIRST_TOUCH_KEY);
      return;
    }
    if (sessionStorage.getItem(FIRST_TOUCH_KEY) !== null) return;
    sessionStorage.setItem(
      FIRST_TOUCH_KEY,
      JSON.stringify(firstTouchOf(location.href, document.referrer)),
    );
  } catch {
    // Attribution is never worth an error to the visitor.
  }
}

/** The session's first touch for an inquiry, with consent only; else undefined. */
export function readFirstTouch(consented: boolean): FirstTouch | undefined {
  if (!consented) return undefined;
  try {
    const raw = sessionStorage.getItem(FIRST_TOUCH_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const touch: FirstTouch = {};
    for (const key of KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '') {
        touch[key] = value.slice(0, key === 'referrerHost' ? HOST_MAX : TAG_MAX);
      }
    }
    return touch;
  } catch {
    return undefined;
  }
}
