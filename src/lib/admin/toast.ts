// Toast notifications for the admin shell. Browser-only; islands and layout scripts
// share it, and manualChunks routes it into the admin-ui chunk either way.
//
// The region is server-rendered in AdminLayout with `aria-live="polite"` — it must
// exist BEFORE anything is appended, because a live region announces changes to its
// contents, not its own arrival. A region created on the fly announces nothing.
//
// Toasts are for SUCCESS confirmation only ("Deleted.", "Saved."). Errors stay inline
// next to the thing that failed: an auto-dismissing message is the wrong container for
// information the user has to act on (WCAG 2.2.1 thinking, even where the letter of it
// permits), and the inline `.msg[data-kind='error']` pattern already does that job.

export type ToastKind = 'ok' | 'info';

const LIFETIME_MS = 4000;
const LEAVE_MS = 200;

export function toast(message: string, kind: ToastKind = 'info'): void {
  const region = document.getElementById('admin-toasts');
  if (!region) return;

  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset['kind'] = kind;
  el.textContent = message;
  // appendChild, not append — see the note in confirm.ts (Workers-types clash).
  region.appendChild(el);

  // data-state drives the exit transition in CSS; the CSS gates it behind
  // prefers-reduced-motion, so this only *schedules* removal.
  window.setTimeout(() => {
    el.dataset['state'] = 'leaving';
    window.setTimeout(() => el.remove(), LEAVE_MS);
  }, LIFETIME_MS);
}
