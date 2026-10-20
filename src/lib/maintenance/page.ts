import type { Locale } from '@schemas/primitives';
import type { Bilingual, MaintenanceSnapshot } from '@schemas/maintenance';
import { arabicIndic } from '@/lib/i18n';
import { DEFAULT_MESSAGE, DEFAULT_TITLE, MONTH_WORDS, PAGE_WORDS } from './copy';

// The maintenance page (Admin v2 U9b), as one string of HTML: what a visitor gets while
// maintenance is on (503, src/lib/http/maintenance.ts) and what "Preview full screen" shows
// (200, the admin's preview route). Pure: everything it prints comes from the KV snapshot the
// pre-cache check already read (no database on the request path) and the request's nonce.
//
//   - bilingual by the path: `/ar/…` is lang="ar" dir="rtl", with the Arabic words;
//   - the headline and the message from the snapshot, else the built-in words (copy.ts);
//   - "Back on <day>" when asked, in our own month words, Arabic-Indic digits in Arabic;
//   - "Email us" and "WhatsApp" (only with a number) when the buttons are on;
//   - the background: the hero's blurred still (`/media/hero-poster-blur.jpg`, a static file
//     the asset layer serves during maintenance, zero video bytes) under a midnight scrim
//     dark enough for white text on a white still (tests/lib/maintenancePage.spec.ts
//     measures it), or plain black;
//   - every style in the one nonced <style>, fonts from /fonts (font-src 'self'), no `style=`
//     attribute, every text and attribute escaped. No script.

/** The blurred hero still (public/media), the background "The hero image" names. */
export const MAINTENANCE_POSTER = '/media/hero-poster-blur.jpg';

/** The scrim over the still: midnight (#000d30) at this opacity. */
export const SCRIM_RGB = [0, 13, 48] as const;
export const SCRIM_ALPHA = 0.72;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text for an element or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** The base64 alphabet only: the nonce lands in an attribute and in the CSP header. */
export function safeNonce(nonce: string): string {
  return nonce.replace(/[^A-Za-z0-9+/=]/g, '');
}

/** "3 November", or "3 November 2027" in another year; Arabic: "٣ نوفمبر". */
export function backOnDate(day: string, locale: Locale, now: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const name = MONTH_WORDS[locale][month - 1];
  if (!name) return null;
  const sameYear = new Date(now).getUTCFullYear() === year;
  if (locale === 'ar') {
    return `${arabicIndic(date)} ${name}${sameYear ? '' : ` ${arabicIndic(year)}`}`;
  }
  return `${date} ${name}${sameYear ? '' : ` ${year}`}`;
}

/** The message the page shows: the admin's, else the built-in one matching its buttons. */
function messageOf(s: MaintenanceSnapshot, buttons: { email: boolean; whatsapp: boolean }): Bilingual {
  if (s.copy.message) return s.copy.message;
  if (buttons.email && buttons.whatsapp) return DEFAULT_MESSAGE.emailAndWhatsapp;
  if (buttons.email) return DEFAULT_MESSAGE.email;
  return DEFAULT_MESSAGE.none;
}

const FONT_FACES =
  "@font-face{font-family:'Archivo';font-weight:400 800;font-display:swap;" +
  "src:url('/fonts/archivo-var-latin.woff2') format('woff2')}" +
  "@font-face{font-family:'Almarai';font-weight:400;font-display:swap;" +
  "src:url('/fonts/almarai-400-arabic.woff2') format('woff2')}" +
  "@font-face{font-family:'Almarai';font-weight:800;font-display:swap;" +
  "src:url('/fonts/almarai-800-arabic.woff2') format('woff2')}";

const STYLES =
  FONT_FACES +
  '*{box-sizing:border-box}' +
  "html{font-family:'Archivo',system-ui,'Segoe UI',Roboto,sans-serif;color:#fff;background:#000}" +
  "html[lang=ar]{font-family:'Almarai','Archivo',system-ui,sans-serif}" +
  'body{margin:0;min-height:100vh;display:flex;background:#000;position:relative}' +
  `body.bg-image{background:#000 url('${MAINTENANCE_POSTER}') center/cover no-repeat}` +
  `body.bg-image::before{content:'';position:absolute;inset:0;background:rgba(${SCRIM_RGB.join(',')},${SCRIM_ALPHA})}` +
  'main{position:relative;display:flex;flex-direction:column;justify-content:flex-end;' +
  'gap:16px;width:100%;max-width:960px;margin:0 auto;padding:32px 24px 56px;min-height:100vh}' +
  '.logo{width:132px;height:auto;margin-bottom:auto}' +
  'h1{margin:0;font-size:clamp(32px,7vw,64px);font-weight:800;line-height:1.05;' +
  'letter-spacing:-.02em;text-transform:uppercase;overflow-wrap:anywhere}' +
  'html[lang=ar] h1{letter-spacing:0;text-transform:none;line-height:1.3}' +
  'p{margin:0;max-width:34em;font-size:18px;line-height:1.5}' +
  '.when{font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#a8c2ff}' +
  'html[lang=ar] .when{letter-spacing:0}' +
  '.contact{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}' +
  '.btn{display:inline-flex;align-items:center;min-height:44px;padding:10px 20px;' +
  'border-radius:999px;font-weight:700;font-size:15px;color:#fff;text-decoration:none;' +
  'border:1px solid rgba(255,255,255,.7)}' +
  '.btn.primary{background:#0024bc;border-color:#0024bc}' +
  '.btn:focus-visible{outline:3px solid #fff;outline-offset:3px}' +
  '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}';

export interface MaintenancePageInput {
  nonce: string;
  snapshot: MaintenanceSnapshot;
  locale: Locale;
  now: number;
  /** The logo's URL (a same-origin `/_image`, exempt from maintenance), or null. */
  logoSrc: string | null;
  /** The brand when the snapshot carries none (the code fallback). */
  fallbackBrand: Bilingual;
}

/** The page's HTML. */
export function maintenancePage(input: MaintenancePageInput): string {
  const { snapshot: s, locale, now } = input;
  const words = PAGE_WORDS[locale];
  const brand = (s.contact.brand ?? input.fallbackBrand)[locale];
  const title = (s.copy.title ?? DEFAULT_TITLE)[locale];
  const email = s.showContact ? s.contact.email : null;
  const whatsapp = s.showContact ? s.contact.whatsappE164 : null;
  const message = messageOf(s, { email: email !== null, whatsapp: whatsapp !== null })[locale];
  const day = s.showDate && s.until ? backOnDate(s.until, locale, now) : null;
  const nonce = safeNonce(input.nonce);

  const buttons = [
    email
      ? `<a class="btn primary" href="mailto:${escapeHtml(email)}">${escapeHtml(words.emailUs)}</a>`
      : '',
    whatsapp
      ? `<a class="btn" href="https://wa.me/${whatsapp.replace(/\D/g, '')}">${escapeHtml(words.whatsapp)}</a>`
      : '',
  ].join('');

  return (
    '<!doctype html>' +
    `<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">` +
    '<head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)} | ${escapeHtml(brand)}</title>` +
    `<style nonce="${nonce}">${STYLES}</style>` +
    '</head>' +
    `<body class="bg-${s.background === 'black' ? 'black' : 'image'}"><main>` +
    (input.logoSrc
      ? `<img class="logo" src="${escapeHtml(input.logoSrc)}" alt="${escapeHtml(brand)}" width="132" height="67">`
      : '') +
    `<h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(message)}</p>` +
    (day ? `<p class="when">${escapeHtml(words.backOn(day))}</p>` : '') +
    (buttons ? `<div class="contact">${buttons}</div>` : '') +
    '</main></body></html>'
  );
}
