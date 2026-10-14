// Two letters for a person's avatar (the sidebar chip, the account drawer, the kit's
// Avatar): from the display name when there is one, else the e-mail. Pure, so the shell
// renders it on the server and the account drawer recomputes it after a rename, with the
// same answer.

/**
 * Two letters for the avatar: the first letters of the first and last words of the name,
 * the first two letters of a one-word name, else the first two characters of the e-mail.
 * Letters are whole characters (code points, F4b), so an Arabic or astral first letter is
 * never cut in half; Arabic has no case and is left as it is.
 */
export function initialsOf(displayName: string | null, email: string): string {
  const words = (displayName ?? '').split(/\s+/).filter(Boolean);
  const first = (word: string, n: number) => Array.from(word).slice(0, n).join('');
  if (words.length >= 2) {
    return `${first(words[0]!, 1)}${first(words[words.length - 1]!, 1)}`.toUpperCase();
  }
  if (words.length === 1) return first(words[0]!, 2).toUpperCase();
  return first(email, 2).toUpperCase();
}
