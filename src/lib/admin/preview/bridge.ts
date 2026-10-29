import {
  FromPreviewMessageSchema,
  PreviewSectionIdSchema,
  PREVIEW_MESSAGE_VERSION,
  ToPreviewMessageSchema,
  type FromPreviewMessage,
  type ToPreviewMessage,
} from '@schemas/previewMessage';
import { PREVIEW_PREFIX, READ_ONLY_ENDPOINTS, toPreviewPath } from './paths';

// The bridge's preview side (Admin v2 R9, P-4; releases.md §6.3 item 9), loaded only into a
// `/admin/preview/**` render (src/components/preview/AdminPreviewBridge.astro). The parent
// side is src/lib/admin/previewChannel.ts (the page editor, E2).
//
// The rules (CLAUDE.md §3 "postMessage"):
//   - post with an explicit targetOrigin, this page's own origin, never '*';
//   - accept a message only from this origin AND from the parent window, and only when it
//     parses as the envelope (packages/schemas/previewMessage.ts); anything else is dropped;
//   - apply theme tokens as CSS custom properties through the CSSOM (`style.setProperty`),
//     never as markup or a style attribute.
// In the page:
//   - a same-origin link to a previewable page stays in the preview (rewritten to
//     `/admin/preview/<path>`, the `only` selection or the version `v` kept) and is reported
//     to the parent;
//   - a click inside a marked section, not on a link or another of the page's own controls
//     (PAGE_CONTROLS), is reported to the parent as `select` (Admin v2 E2: the page editor
//     opens that section);
//   - a form never sends: the submit is stopped before the page's own handler sees it, and the
//     response's CSP already says `form-action 'none'` (src/lib/http/preview.ts);
//   - a script's request that could change something (any method but GET and HEAD) is refused,
//     and so is a beacon: a preview never writes a lead, an application or telemetry. A read
//     of the site's own API is refused too unless it is on READ_ONLY_ENDPOINTS: a GET can
//     write (`/api/search` records the query for the SEO report), so only an endpoint known
//     to write nothing may answer a preview.

export interface MessageEventLike {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** A message from the parent, or null: another origin, another window, or not the envelope. */
export function acceptToPreview(
  event: MessageEventLike,
  expected: { origin: string; source: unknown },
): ToPreviewMessage | null {
  if (event.origin !== expected.origin) return null;
  if (expected.source === null || expected.source === undefined) return null;
  if (event.source !== expected.source) return null;
  const parsed = ToPreviewMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}

/** Posts to the parent with this origin as the target; an invalid message is not sent. */
export function postToParent(
  parent: PostTarget | null,
  origin: string,
  message: FromPreviewMessage,
): boolean {
  if (!parent) return false;
  const parsed = FromPreviewMessageSchema.safeParse(message);
  if (!parsed.success) return false;
  parent.postMessage(parsed.data, origin);
  return true;
}

/**
 * Where a click on `href` goes inside the preview: the preview URL of a previewable
 * same-origin page (with the current `only` selection, or the version shown, `v`: Admin v2
 * R10), or null to leave the click alone (an anchor on this page, another site, a feed, a file).
 */
export function previewHrefFor(href: string, base: string): string | null {
  let url: URL;
  let here: URL;
  try {
    here = new URL(base);
    url = new URL(href, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null;
  if (url.pathname === PREVIEW_PREFIX || url.pathname.startsWith(`${PREVIEW_PREFIX}/`)) return null;
  const mapped = toPreviewPath(`${url.pathname}${url.search}`);
  if (!mapped) return null;
  const out = new URL(mapped, here.origin);
  const only = here.searchParams.get('only');
  if (only) out.searchParams.set('only', only);
  const version = here.searchParams.get('v');
  if (version && !only) out.searchParams.set('v', version);
  return `${out.pathname}${out.search}${url.hash}`;
}

/** The sections on the page, as the `ready` message lists them. */
export function sectionsOf(doc: Pick<Document, 'querySelectorAll'>): {
  id: string;
  anchor: string | null;
}[] {
  const out: { id: string; anchor: string | null }[] = [];
  for (const el of doc.querySelectorAll('[data-pv-section]')) {
    const id = el.getAttribute('data-pv-section') ?? '';
    if (!PreviewSectionIdSchema.safeParse(id).success) continue;
    const anchor = /^[A-Za-z][\w-]{0,63}$/.test(el.id) ? el.id : null;
    out.push({ id, anchor });
    if (out.length === 200) break;
  }
  return out;
}

/**
 * What a click in the preview uses as the page's own control, never as a pick of its section:
 * a link (it navigates, and says so), a button (the Leadership slider's arrows, an accordion),
 * a form field or its label, a disclosure, and their ARIA twins. Not `[tabindex]`: the layout's
 * `#main` and the slider's scroll track carry one, and are no control.
 */
export const PAGE_CONTROLS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  ...['button', 'checkbox', 'link', 'menuitem', 'radio', 'slider', 'switch', 'tab'].map(
    (role) => `[role="${role}"]`,
  ),
].join(', ');

/**
 * The marked section a click landed in, for the editor to open (Admin v2 E2), or null: a click
 * on one of the page's own controls (PAGE_CONTROLS: using the page in the preview never opens
 * another section in the editor, nor asks about unsaved words), outside every section, or on a
 * marker that is not an id.
 */
export function sectionOfClick(target: EventTarget | null): string | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  if (el.closest(PAGE_CONTROLS)) return null;
  const id = el.closest('[data-pv-section]')?.getAttribute('data-pv-section') ?? '';
  return PreviewSectionIdSchema.safeParse(id).success ? id : null;
}

export { READ_ONLY_ENDPOINTS };

/** Stands in for the page's origin when no base is given (a relative URL keeps its path). */
const NO_BASE = 'http://preview.invalid/';

/**
 * Whether a script's request may go: reads only (GET, HEAD), and of this site's own API only
 * the endpoints on READ_ONLY_ENDPOINTS. `base` is the page's URL, against which a relative
 * request is resolved.
 */
export function requestAllowed(
  input: RequestInfo | URL,
  init?: RequestInit,
  base: string = NO_BASE,
): boolean {
  const method = (
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  let url: URL;
  let here: URL;
  let path: string;
  try {
    here = new URL(base);
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    url = new URL(raw, here);
    path = decodeURIComponent(url.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return false;
  }
  if (url.origin !== here.origin) return true;
  if (path !== '/api' && !path.startsWith('/api/')) return true;
  return READ_ONLY_ENDPOINTS.includes(path);
}

export const FORMS_NOTICE = "Forms don't send in preview.";

/** Shows a short polite notice (the form was not sent). */
function notice(doc: Document, text: string): void {
  let el = doc.querySelector<HTMLElement>('.pv-notice');
  if (!el) {
    el = doc.createElement('p');
    el.className = 'pv-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('lang', 'en');
    el.setAttribute('dir', 'ltr');
    doc.body.appendChild(el);
  }
  el.textContent = text;
}

/** Applies one parent message to the page. */
export function applyMessage(win: Window, message: ToPreviewMessage): void {
  const doc = win.document;
  const find = (id: string) => doc.querySelector<HTMLElement>(`[data-pv-section="${id}"]`);
  switch (message.type) {
    case 'jump': {
      const reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      find(message.sectionId)?.scrollIntoView({
        block: 'start',
        behavior: reduce ? 'auto' : 'smooth',
      });
      return;
    }
    case 'highlight': {
      for (const el of doc.querySelectorAll('.pv-highlight')) el.classList.remove('pv-highlight');
      if (message.sectionId !== null) find(message.sectionId)?.classList.add('pv-highlight');
      return;
    }
    case 'scroll':
      win.scrollTo(0, message.y);
      return;
    case 'reload':
      win.location.reload();
      return;
    case 'tokens': {
      const root = doc.documentElement.style;
      for (const [name, value] of Object.entries(message.tokens)) root.setProperty(name, value);
      return;
    }
  }
}

/** Wires the bridge into a preview page. */
export function installBridge(win: Window): void {
  const origin = win.location.origin;
  const parent: Window | null = win.parent !== win ? win.parent : null;
  const doc = win.document;

  // Nothing a preview runs may write: refuse every request but a read (and every read of an
  // API endpoint that writes), and every beacon.
  const nativeFetch = win.fetch.bind(win);
  win.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    requestAllowed(input, init, win.location.href)
      ? nativeFetch(input, init)
      : Promise.reject(new TypeError(FORMS_NOTICE));
  if (typeof win.navigator.sendBeacon === 'function') {
    win.navigator.sendBeacon = () => false;
  }

  doc.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      notice(doc, FORMS_NOTICE);
    },
    true,
  );

  doc.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href]');
    if (!link || link.hasAttribute('download')) return;
    const to = previewHrefFor(link.getAttribute('href') ?? '', win.location.href);
    if (!to) return;
    event.preventDefault();
    postToParent(parent, origin, { v: PREVIEW_MESSAGE_VERSION, type: 'navigate', path: to });
    win.location.assign(to);
  });

  // A click in a section opens it in the page editor that frames this preview (E2). Only
  // when framed; the page's own handling of the click goes on unchanged. As with a link
  // above, a click the page already handled (a widget that called preventDefault) or one
  // with a modifier key is the page's, never a pick of its section (E2 review CR4).
  doc.addEventListener('click', (event) => {
    if (!parent || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const sectionId = sectionOfClick(event.target);
    if (sectionId) {
      postToParent(parent, origin, { v: PREVIEW_MESSAGE_VERSION, type: 'select', sectionId });
    }
  });

  let queued = false;
  win.addEventListener(
    'scroll',
    () => {
      if (!parent || queued) return;
      queued = true;
      win.requestAnimationFrame(() => {
        queued = false;
        postToParent(parent, origin, {
          v: PREVIEW_MESSAGE_VERSION,
          type: 'scroll',
          y: Math.max(0, Math.round(win.scrollY)),
        });
      });
    },
    { passive: true },
  );

  win.addEventListener('message', (event) => {
    const message = acceptToPreview(event, { origin, source: parent });
    if (message) applyMessage(win, message);
  });

  postToParent(parent, origin, {
    v: PREVIEW_MESSAGE_VERSION,
    type: 'ready',
    path: `${win.location.pathname}${win.location.search}`,
    locale: doc.documentElement.lang === 'ar' ? 'ar' : 'en',
    sections: sectionsOf(doc),
  });
}
