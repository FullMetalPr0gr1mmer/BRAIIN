import { hasAttributionConsent } from '@consent/gate';
import type { LeadAttributionInput } from '@schemas/lead';
import type { LeadChannel } from '@schemas/crm';

// Lead attribution, the server's half (Admin v2 C13, crm.md §7.3; HELD for O-11): what is
// recorded with an inquiry about how the visitor found the site, and ONLY when they said yes to
// analytics, under the current notice. The consent is read here through the one gate
// (packages/consent/gate.ts hasAttributionConsent: hasConsent, and the choice's version is the
// current one and names attribution, packages/consent/version.ts), the gate of record, whatever
// the browser sent: without it the answer is null and the lead carries none of these columns
// (its channel stays `unknown`).
//
// What is recorded (migration 0132's columns), each cleaned on its own, a value that does not
// fit dropped while the rest are kept:
//   landing_path   the page the form was sent from: the PATH of the POST's same-origin
//                  Referer, never a query or a fragment. The server's, never the client's.
//   referrer_host  the other site that sent the visitor at the start of the session: a host
//                  name, never a URL, never this site's own (the browser's first touch).
//   utm_*          the first page's campaign tags: lower-case slugs, at most 64 characters.
//   device_class   mobile, tablet or desktop, from Sec-CH-UA-Mobile or the User-Agent. The
//                  User-Agent itself is never stored.
//   country        Cloudflare's two-letter country for the connection (request.cf.country,
//                  else its CF-IPCountry header), never the IP, never a city.
//   channel        organic, social, paid, referral, direct or email, classified from the above;
//                  `unknown` when the visitor allowed analytics only after the first page.
//
// No value may carry an `@`, seven digits in a row or split by single separators (an e-mail
// address or a phone number a link put there, `050-123-4567` too), a percent-escape in a path
// (an encoded `@` must not slip through) or an IP address as a host; the database's CHECKs
// refuse them as well (0132), with the same patterns (tests/lib/leadAttributionSql.spec.ts).
//
// Never recorded: the IP, the full User-Agent, any URL with its query, a city, the analytics
// session id, or anything else that links a lead to its page views (G1 D4).

/** The columns this module produces, as crm_ingest_lead takes them (its allow-list, 0132). */
export interface LeadAttributionColumns {
  landing_path?: string;
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  device_class?: DeviceClass;
  country?: string;
  channel: LeadChannel;
}

export type DeviceClass = 'mobile' | 'tablet' | 'desktop';

/**
 * A phone number: seven digits, each pair split by at most one character that is not a letter
 * or a digit (`0501234567`, `050-123-4567`, `(050)1234`). The SQL CHECKs carry this source.
 */
export const PHONE_LIKE_SOURCE = '[0-9]([^0-9A-Za-z]?[0-9]){6}';
const PHONE_LIKE = new RegExp(PHONE_LIKE_SOURCE);
/** An e-mail address or a phone number: never stored in a path or a tag. */
const looksPersonal = (value: string) => value.includes('@') || PHONE_LIKE.test(value);
const PATH = /^\/[^?#%\s]{0,199}$/;
const TAG = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** A host whose last label is all digits is an IP address (no top-level domain is numeric). */
export const NUMERIC_TLD_SOURCE = '\\.[0-9]+$';
const NUMERIC_TLD = new RegExp(NUMERIC_TLD_SOURCE);

/**
 * The path of the page the form was sent from: the Referer's, when it is this site's own
 * origin (the request's Host), with no query and no fragment. Anything else is no path, and so
 * is a path with a percent-escape (every page of the site has an ASCII path, and `%40` is an
 * `@`).
 */
export function landingPathFrom(
  referer: string | null | undefined,
  host: string | null | undefined,
): string | undefined {
  if (!referer || !host) return undefined;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.host.toLowerCase() !== host.toLowerCase()) return undefined;
  const path = url.pathname;
  return PATH.test(path) && !looksPersonal(path) ? path : undefined;
}

/** A host name in ASCII, lower case, never an IP address, never this site's own; else nothing. */
export function cleanReferrerHost(
  value: string | undefined,
  ownHost: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  // A host name only: a scheme, a path, a port, credentials or a query make it something else.
  if (raw === '' || /[/:?#@\s\\]/.test(raw)) return undefined;
  let host: string;
  try {
    host = new URL(`https://${raw}/`).hostname;
  } catch {
    return undefined;
  }
  if (host.length > 253 || !HOST.test(host) || NUMERIC_TLD.test(host)) return undefined;
  const own = ownHost?.toLowerCase().replace(/:\d+$/, '');
  if (own && (host === own || host === `www.${own}` || own === `www.${host}`)) return undefined;
  return host;
}

/** A campaign tag as a lower-case slug (spaces become hyphens); else nothing. */
export function cleanTag(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tag = value.trim().toLowerCase().replace(/\s+/g, '-');
  return TAG.test(tag) && !looksPersonal(tag) ? tag : undefined;
}

/** Mobile, tablet or desktop, from the request's hints; nothing when it cannot tell. */
export function deviceClassOf(headers: Headers): DeviceClass | undefined {
  const ua = headers.get('user-agent') ?? '';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  const hint = headers.get('sec-ch-ua-mobile');
  if (hint === '?1') return 'mobile';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
  if (hint === '?0') return 'desktop';
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua)) return 'desktop';
  return undefined;
}

/**
 * Cloudflare's country code for the connection; else nothing. Adapter 14 documents
 * `Astro.request.cf` (its error for the removed `Astro.locals.runtime.cf` says so), but Astro
 * rebuilds the request with `new Request(url, request)` on its forwarded-host path
 * (astro/dist/core/fetch/fetch-state.js), and outside workerd a rebuilt request has no `cf`.
 * Cloudflare's CF-IPCountry header (set by its edge, never the client's) survives a rebuild, so
 * it is the fallback. Neither is verified on staging yet (C13 as-built, merge step 4).
 */
export function countryOf(request: Request): string | undefined {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country = cf?.country ?? request.headers.get('cf-ipcountry') ?? undefined;
  // XX: Cloudflare could not tell. T1 (Tor) fails the shape.
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) && country !== 'XX'
    ? country
    : undefined;
}

const PAID_MEDIA = new Set([
  'cpc',
  'ppc',
  'paid',
  'paidsearch',
  'paid-search',
  'paid_search',
  'paidsocial',
  'paid-social',
  'paid_social',
  'display',
  'cpm',
  'cpv',
  'banner',
  'ads',
  'ad',
  'retargeting',
  'sponsored',
]);
const EMAIL_MEDIA = new Set(['email', 'e-mail', 'newsletter']);
const SOCIAL_MEDIA = new Set(['social', 'social-media', 'social_media', 'social-network', 'sm']);

/** Social sites, as host suffixes or utm_source names. */
const SOCIAL = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  't.co',
  'linkedin.com',
  'lnkd.in',
  'tiktok.com',
  'snapchat.com',
  'youtube.com',
  'pinterest.com',
  'reddit.com',
  'threads.net',
  'behance.net',
  'dribbble.com',
];
const SOCIAL_NAMES = new Set([
  'facebook',
  'fb',
  'instagram',
  'ig',
  'twitter',
  'x',
  'linkedin',
  'tiktok',
  'snapchat',
  'youtube',
  'pinterest',
  'reddit',
  'threads',
  'behance',
  'dribbble',
]);
const SEARCH = [
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'ecosia.org',
  'baidu.com',
  'search.brave.com',
];
const SEARCH_NAMES = new Set([
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'yandex',
  'ecosia',
  'baidu',
]);
const MAIL = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com'];

const onHost = (host: string, domains: readonly string[]) =>
  domains.some((d) => host === d || host.endsWith(`.${d}`));
/** google.com, google.com.sa, www.google.ae…; yandex.ru, yandex.com… */
const isSearchHost = (host: string) =>
  /(^|\.)(google|yandex)\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) || onHost(host, SEARCH);

/**
 * How the visitor reached us (crm.md §7.3): a paid, e-mail or social medium first, then the
 * referring site (mail before search: webmail lives on search engines' domains), then the
 * source's name, and `direct` with neither. `lateConsent` (the visitor allowed analytics on a
 * page reached from inside the site, so their arrival was never seen) makes that last case
 * `unknown`, never `direct`. Called only with consent; without it the lead keeps `unknown`.
 */
export function classifyChannel(touch: {
  source?: string | undefined;
  medium?: string | undefined;
  referrerHost?: string | undefined;
  lateConsent?: boolean | undefined;
}): LeadChannel {
  const { source, medium, referrerHost, lateConsent } = touch;
  if (medium) {
    if (PAID_MEDIA.has(medium)) return 'paid';
    if (EMAIL_MEDIA.has(medium)) return 'email';
    if (SOCIAL_MEDIA.has(medium)) return 'social';
    if (medium === 'organic') return 'organic';
    if (medium === 'referral') return 'referral';
  }
  if (referrerHost) {
    if (onHost(referrerHost, MAIL)) return 'email';
    if (onHost(referrerHost, SOCIAL)) return 'social';
    if (isSearchHost(referrerHost)) return 'organic';
    return 'referral';
  }
  if (source) {
    if (SOCIAL_NAMES.has(source)) return 'social';
    if (SEARCH_NAMES.has(source)) return 'organic';
    return 'referral';
  }
  if (medium) return 'referral';
  return lateConsent ? 'unknown' : 'direct';
}

/** A service page, English or Arabic: the `service_page` score signal (0035). */
export function isServicePage(path: string | undefined): boolean {
  return path !== undefined && /^\/(ar\/)?services\/[^/]+\/?$/.test(path);
}

/**
 * What a new lead records about how the visitor found us: null without analytics consent given
 * under the current notice (hasAttributionConsent, the gate of record), else the cleaned columns and the channel. `input` is the
 * browser's first touch (LeadInputSchema `attribution`); the landing path, device and country
 * come from the request itself.
 */
export function leadAttribution(
  request: Request,
  input: LeadAttributionInput | undefined,
): LeadAttributionColumns | null {
  if (!hasAttributionConsent(request)) return null;
  try {
    return attributionOf(request, input);
  } catch {
    // Attribution never costs a lead: anything unexpected records nothing.
    return null;
  }
}

function attributionOf(
  request: Request,
  input: LeadAttributionInput | undefined,
): LeadAttributionColumns {
  const host = request.headers.get('host');
  const landing_path = landingPathFrom(request.headers.get('referer'), host);
  const referrer_host = cleanReferrerHost(input?.referrerHost, host);
  const utm_source = cleanTag(input?.utmSource);
  const utm_medium = cleanTag(input?.utmMedium);
  const utm_campaign = cleanTag(input?.utmCampaign);
  const device_class = deviceClassOf(request.headers);
  const country = countryOf(request);
  const columns: LeadAttributionColumns = {
    channel: classifyChannel({
      source: utm_source,
      medium: utm_medium,
      referrerHost: referrer_host,
      lateConsent: input?.lateConsent === true,
    }),
  };
  if (landing_path) columns.landing_path = landing_path;
  if (referrer_host) columns.referrer_host = referrer_host;
  if (utm_source) columns.utm_source = utm_source;
  if (utm_medium) columns.utm_medium = utm_medium;
  if (utm_campaign) columns.utm_campaign = utm_campaign;
  if (device_class) columns.device_class = device_class;
  if (country) columns.country = country;
  return columns;
}

/** The attribution keys, as crm_ingest_lead takes them (the retry drops exactly these). */
export const ATTRIBUTION_KEYS = [
  'landing_path',
  'referrer_host',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'device_class',
  'country',
  'channel',
] as const;
