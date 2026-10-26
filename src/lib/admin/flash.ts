// Confirmations that outlive a navigation (Admin v2 C4b). toast() writes to the current
// document only, so a toast fired just before location.assign is gone with the page, never
// seen or heard. An action that navigates adds `?done=<key>` to the next address instead
// (withFlash); the next page's island shows that toast once (showFlash) and takes the key out
// of the address with history.replaceState, so a reload, Back or a copied link does not say
// it again.
//
// The key is from a closed list: an address can name a confirmation but never put words of
// its own into one. An unknown key is removed and says nothing.

import { toast } from './toast';

export const FLASH_PARAM = 'done';

export const FLASH_MESSAGES = {
  'lead-added': 'Lead added',
  'lead-erased': 'Lead erased',
  // Website stats goals (G1c): the card reloads with its new progress after each change.
  'goal-added': 'Goal added',
  'goal-saved': 'Goal saved',
  'goal-deleted': 'Goal deleted',
  // An editor's Delete (U5/U6, editorDelete.ts), back on the list; with releases on the
  // removal is a pending change until the release is published.
  'service-deleted': 'Service deleted',
  'project-deleted': 'Project deleted',
  'removal-pending': 'Will be removed when the release is published',
} as const;

export type FlashKey = keyof typeof FLASH_MESSAGES;

/** `href` (a same-origin path, maybe with a query) with the confirmation to show there. */
export function withFlash(href: string, key: FlashKey): string {
  const hash = href.indexOf('#');
  const [path, fragment] = hash === -1 ? [href, ''] : [href.slice(0, hash), href.slice(hash)];
  return `${path}${path.includes('?') ? '&' : '?'}${FLASH_PARAM}=${key}${fragment}`;
}

/**
 * The confirmation an address carries, and the address without it; null when it carries
 * none. `message` is null for a key outside the list (removed, never shown).
 */
export function readFlash(href: string): { message: string | null; rest: string } | null {
  const url = new URL(href, 'https://admin.invalid');
  const key = url.searchParams.get(FLASH_PARAM);
  if (key === null) return null;
  url.searchParams.delete(FLASH_PARAM);
  const message = Object.hasOwn(FLASH_MESSAGES, key) ? FLASH_MESSAGES[key as FlashKey] : null;
  return { message, rest: `${url.pathname}${url.search}${url.hash}` };
}

/** On a page's first render in the browser: show the address's confirmation, once. */
export function showFlash(): void {
  const found = readFlash(`${location.pathname}${location.search}${location.hash}`);
  if (!found) return;
  history.replaceState(history.state, '', found.rest);
  if (found.message) toast(found.message, 'ok');
}
