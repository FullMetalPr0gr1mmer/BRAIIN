// Toast notifications for the admin shell. Browser-only; islands and layout scripts
// share it, and the admin-client chunk group (astro.config.mjs) holds it either way.
//
// The region is server-rendered in AdminLayout with `aria-live="polite"` — it must
// exist BEFORE anything is appended, because a live region announces changes to its
// contents, not its own arrival. A region created on the fly announces nothing.
//
// Toasts are for SUCCESS confirmation only ("Deleted.", "Saved."). Errors stay inline
// next to the thing that failed: an auto-dismissing message is the wrong container for
// information the user has to act on (WCAG 2.2.1 thinking, even where the letter of it
// permits), and the inline `.msg[data-kind='error']` pattern already does that job.

import { ICON_SPRITE } from './icons';

export type ToastKind = 'ok' | 'info';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The prototype's toast icon, from the sprite: built with DOM calls, never markup. */
function toastIcon(kind: ToastKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${ICON_SPRITE}#i-${kind === 'ok' ? 'check' : 'info'}`);
  svg.appendChild(use);
  return svg;
}

const LIFETIME_MS = 4000;
const LEAVE_MS = 200;

export function toast(message: string, kind: ToastKind = 'info'): void {
  const region = document.getElementById('admin-toasts');
  if (!region) return;

  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset['kind'] = kind;
  const text = document.createElement('span');
  text.textContent = message;
  // appendChild, not append — see the note in confirm.ts (Workers-types clash).
  el.appendChild(toastIcon(kind));
  el.appendChild(text);
  region.appendChild(el);

  // data-state drives the exit transition in CSS; the CSS gates it behind
  // prefers-reduced-motion, so this only *schedules* removal.
  window.setTimeout(() => {
    el.dataset['state'] = 'leaving';
    window.setTimeout(() => el.remove(), LEAVE_MS);
  }, LIFETIME_MS);
}
