import { accentTokens, type AccentRange } from '@/lib/text/accent';

// The words an accent range counts, for the `accent` field (Admin v2 F5b, ui.md §2.6).
//
// An accent is a WORD RANGE of its sibling heading, never stored HTML (Pillar 1): the
// editor picks "from word 2 to word 4" and the server renders the runs. So the admin must
// count words exactly as the public side does, or a range picked here would highlight
// something else on the page — which is why the tokenising step itself lives in
// src/lib/text/accent.ts (`accentTokens`) and both sides call it.
//
// Pure, Zod-free and DOM-free: unit-tested in node (tests/lib/accentWords.spec.ts).

/** The words of a heading, in order — what an accent's numbers count. */
export function accentWords(text: string): string[] {
  return accentTokens(text).filter((token) => !/^\s+$/.test(token));
}

// AccentSchema's own bounds (packages/schemas/media.ts): a range past them is refused by
// the server, so the field never offers one.
const MAX_FROM = 30;
const MAX_TO = 31;

/**
 * A range held inside a text of `words` words, and inside the schema's bounds. Used when
 * the heading shrinks under a stored accent (ui.md §10: "the range clamps when the text
 * shrinks") and whenever the field writes its payload. `undefined` means "no highlight":
 * nothing is stored, and the heading renders plain.
 */
export function clampAccent(
  range: AccentRange | undefined | null,
  words: number,
): AccentRange | undefined {
  if (!range || words <= 0) return undefined;
  const from = Math.min(Math.max(Math.trunc(range.from), 0), Math.min(words - 1, MAX_FROM));
  if (!Number.isFinite(from)) return undefined;
  if (range.to === undefined || range.to === null) return { from };
  const to = Math.min(Math.trunc(range.to), words, MAX_TO);
  // A `to` that is no longer after `from` means the words it covered are gone: the range
  // runs to the end of what is left rather than becoming an empty highlight.
  return to > from ? { from, to } : { from };
}

/**
 * The words a range covers, for the field's live preview line: read the way the PAGE
 * reads it (splitAccent), not held, so the preview of a stored range is what the page
 * shows. A range the field would save is already held (formPayload's accentToRanges); one
 * kept exactly as stored may start past the last word, and then nothing is coloured.
 */
export function accentPreview(
  text: string,
  range: AccentRange | undefined,
): { before: string; accented: string; after: string } {
  const words = accentWords(text);
  const from = range ? Math.max(Math.trunc(range.from), 0) : NaN;
  if (!range || !(from < words.length)) return { before: text, accented: '', after: '' };
  const end = Math.min(range.to ?? words.length, words.length);
  if (!(end > from)) return { before: text, accented: '', after: '' };
  return {
    before: words.slice(0, from).join(' '),
    accented: words.slice(from, end).join(' '),
    after: words.slice(end).join(' '),
  };
}
