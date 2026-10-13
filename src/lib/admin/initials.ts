// Two letters for a person's avatar (the sidebar chip, the account drawer): from the
// display name when there is one, else the e-mail. Pure, so the shell renders it on the
// server and the account drawer recomputes it after a rename, with the same answer.

/** Two letters for the avatar: from the name when there is one, else the e-mail. */
export function initialsOf(displayName: string | null, email: string): string {
  const words = (displayName ?? '').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}
