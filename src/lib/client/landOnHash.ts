// Arriving on a page with a fragment — `/services/logo#inquiry` from an "Inquire" pill or
// the /services explorer — lands on the target at once, as the mockup's pageBoot() did
// (`scrollTo(helloSec, { immediate: true })`).
//
// The site's `html { scroll-behavior: smooth }` otherwise turns the browser's own fragment
// scroll into a ~2 s sweep through every band above the form: disorienting after a page
// change, and a lot of motion for a reader who has not set prefers-reduced-motion. In-page
// links (the hero CTA, the skip pill, the floating button) keep the smooth scroll; only
// the first landing is instant. The target's `scroll-margin-top` still applies.

/** The element id a location hash names, or null ('#' alone, or a malformed escape). */
export function hashTarget(hash: string): string | null {
  if (!hash || hash === '#') return null;
  try {
    return decodeURIComponent(hash.slice(1)) || null;
  } catch {
    return null;
  }
}

export function landOnHash(root: Document = document): void {
  const id = hashTarget(location.hash);
  const target = id ? root.getElementById(id) : null;
  if (!target) return;
  target.scrollIntoView({ behavior: 'instant', block: 'start' });
}
