// Which navigation item is the current page (`aria-current="page"`).
//
// Three rules, each fixing a real defect of the prefix match this replaces:
//
//   1. The locale root matches EXACTLY. `/ar` used to prefix-match every Arabic URL
//      (`/ar/about` starts with `/ar/`), so "Home" was announced as the current page on
//      all of them — to a screen reader, the site had no way out of the home page.
//   2. An item with a fragment (`/#services`) is an in-page anchor, never "a page". On
//      the home page it would otherwise be current alongside Home.
//   3. Everything else matches itself and its sub-paths: `/portfolio` is current on
//      `/portfolio/the-rider`, but `/portfolio-x` does not match `/portfolio`.
//
// Both arguments are LOCALIZED paths (what the browser has, and what localizedHref
// produced), so the comparison never needs to know the locale.

const LOCALE_ROOTS = new Set(['/', '/ar']);

function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function isCurrentNav(localizedTarget: string, currentPath: string): boolean {
  if (!localizedTarget.startsWith('/') || localizedTarget.startsWith('//')) return false;
  if (localizedTarget.includes('#')) return false;
  const target = normalize(localizedTarget.split('?')[0] ?? '');
  const current = normalize(currentPath);
  if (LOCALE_ROOTS.has(target)) return current === target;
  return current === target || current.startsWith(`${target}/`);
}
