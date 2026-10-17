import { HIDDEN_CACHE_CONTROL, type VisibilityNote } from '@/lib/http/visibility';
import { PAGE_ACCESS_FIELDS } from '@schemas/visibility';
import type { VisibilityPageSlug } from './routes';

// The password box a visitor sees instead of a page behind a password (Admin v2 U14b).
//
// Built the way maintenanceResponse() is (src/lib/http/maintenance.ts), and for the same
// reasons: it is answered by the middleware before anything renders, so it carries no
// island, no stylesheet link and no script — zero bytes of client JavaScript on a public
// route — and its styles live in ONE nonced <style> block, because the CSP has no
// 'unsafe-inline' and an inline-styled page would render bare.
//
// It is a plain <form method="post">, so it works with JavaScript off, and every authored
// string is escaped before it reaches the HTML. The only authored string here is the
// message the admin wrote, which the database already refuses `<` and `>` in (0061) and
// which the snapshot parser refuses again — escaping is the third layer, not the first.
//
// 403, `private, no-store`, `noindex`: the gate is never cached and never indexed, and the
// status says plainly that the page exists and is closed, which is what a password box
// says anyway.

const BRAND_FALLBACK = 'This page is private';

/** HTML-escapes a string for text and for a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COPY = {
  en: {
    lang: 'en',
    dir: 'ltr',
    title: BRAND_FALLBACK,
    heading: 'This page is private',
    intro: 'Type the password you were given to open it.',
    label: 'Password',
    submit: 'Open the page',
    wrong: 'That password did not work. Try again.',
    home: 'Go to the homepage',
  },
  ar: {
    lang: 'ar',
    dir: 'rtl',
    title: 'هذه الصفحة خاصة',
    heading: 'هذه الصفحة خاصة',
    intro: 'اكتب كلمة المرور التي وصلتك لفتحها.',
    label: 'كلمة المرور',
    submit: 'افتح الصفحة',
    wrong: 'كلمة المرور غير صحيحة. حاول مرة أخرى.',
    home: 'اذهب إلى الصفحة الرئيسية',
  },
} as const;

export interface PageAccessGateOptions {
  nonce: string;
  locale: 'en' | 'ar';
  /** The page's slug, which the form posts back so the route knows what to open. */
  page: VisibilityPageSlug;
  /** Where to send the visitor once the password is right: a path of this site. */
  next: string;
  note: VisibilityNote | null;
  /** Whether the last attempt was refused (`?pa=wrong`). Nothing typed is ever echoed. */
  wrong: boolean;
}

const STYLE = [
  'body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0b0b0f;color:#e8e8ea;',
  'display:grid;place-items:center;min-height:100vh;margin:0}',
  'main{width:min(26rem,100% - 2rem);padding:2rem 0}',
  'h1{margin:0 0 .5rem;font-size:1.5rem}',
  'p{margin:0 0 1rem;opacity:.75;line-height:1.5}',
  'label{display:block;margin:0 0 .4rem;font-weight:600}',
  'input{width:100%;box-sizing:border-box;padding:.7rem .8rem;font:inherit;color:inherit;',
  'background:#17171d;border:1px solid #3a3a45;border-radius:8px}',
  'input:focus-visible{outline:2px solid #8ab4ff;outline-offset:2px}',
  'button{margin-top:1rem;width:100%;padding:.7rem 1rem;font:inherit;font-weight:600;',
  'color:#0b0b0f;background:#e8e8ea;border:0;border-radius:8px;cursor:pointer}',
  'button:focus-visible{outline:2px solid #8ab4ff;outline-offset:2px}',
  '.err{color:#ffb4b4;opacity:1}',
  'a{color:#8ab4ff}',
].join('');

/**
 * The gate, as a complete response. `nonce` is the request's CSP nonce; it is filtered to
 * the base64 alphabet first, exactly as the maintenance page filters it, because it lands
 * both in an attribute and in the CSP header.
 */
export function pageAccessGate(options: PageAccessGateOptions): Response {
  const copy = COPY[options.locale];
  const safeNonce = options.nonce.replace(/[^A-Za-z0-9+/=]/g, '');
  const note = options.note?.[options.locale] ?? options.note?.en ?? options.note?.ar ?? null;
  const home = options.locale === 'ar' ? '/ar' : '/';
  const html =
    `<!doctype html><html lang="${copy.lang}" dir="${copy.dir}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    `<title>${escapeHtml(copy.title)}</title>` +
    `<style nonce="${safeNonce}">${STYLE}</style></head>` +
    '<body><main>' +
    `<h1>${escapeHtml(copy.heading)}</h1>` +
    (note === null ? `<p>${escapeHtml(copy.intro)}</p>` : `<p>${escapeHtml(note)}</p>`) +
    (options.wrong ? `<p class="err" role="alert">${escapeHtml(copy.wrong)}</p>` : '') +
    '<form method="post" action="/api/page-access">' +
    `<input type="hidden" name="${PAGE_ACCESS_FIELDS.page}" value="${escapeHtml(options.page)}">` +
    `<input type="hidden" name="${PAGE_ACCESS_FIELDS.next}" value="${escapeHtml(options.next)}">` +
    `<label for="page-password">${escapeHtml(copy.label)}</label>` +
    `<input id="page-password" name="${PAGE_ACCESS_FIELDS.password}" type="password" ` +
    'autocomplete="off" autocapitalize="off" spellcheck="false" required maxlength="200">' +
    `<button type="submit">${escapeHtml(copy.submit)}</button>` +
    '</form>' +
    `<p><a href="${home}">${escapeHtml(copy.home)}</a></p>` +
    '</main></body></html>';
  return new Response(html, {
    status: 403,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': HIDDEN_CACHE_CONTROL,
      'x-robots-tag': 'noindex',
    },
  });
}
