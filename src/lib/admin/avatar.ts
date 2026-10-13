// The avatar's two letters and its colour (Admin v2 F4b, docs/admin-v2/ui.md §1.6, §2.4).
// Shared by Avatar.astro (server) and kit/Avatar.tsx (islands), so a person looks the same
// on every screen, and by the shell's user chip.
//
// The colour is a TONE, not a hex: one of eight `--ad-tone-*` tokens behind white initials,
// each at 4.5:1 or better (scripts/contrast-audit.mjs). The prototype hashed the name into
// seven hex colours, three of them below AA (#E4457B 3.86, #12B76A 2.62, #F79009 2.35), and
// set them with a style attribute, which style-src refuses. Here the tone is a
// `data-tone="0..7"` bucket, chosen by a stable hash of a key that does not change when a
// person edits their name: their user id.

/** How many avatar tones admin.css defines (`--ad-tone-0` … `--ad-tone-7`). */
export const AVATAR_TONES = 8;

/**
 * A stable tone for a key, 0 to 7: the prototype's string hash (h × 31 + code, kept to 32
 * bits) modulo the tone count. The same key always gets the same tone, on the server and in
 * the browser alike.
 */
export function avatarTone(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % AVATAR_TONES;
}

/** Two letters for the avatar: ./initials (F8's home for it), re-exported beside the tone. */
export { initialsOf } from './initials';
