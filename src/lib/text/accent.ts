import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';

// Accent ranges → renderable runs. The design accents words anywhere in a heading
// ("Ideas that <em>leave the brain</em> and land in the world"), so an accent is a WORD
// RANGE per locale (packages/schemas/media.ts AccentSchema), not a start index. The
// server renders the runs; no heading is ever built from HTML strings.

export interface AccentRange {
  /** 0-based index of the first accented word. */
  from: number;
  /** Exclusive end; omitted = to the end of the heading. */
  to?: number | undefined;
}

export interface TextRun {
  text: string;
  accent: boolean;
}

/** The range for this locale, if the accent names one. */
export function accentRange(
  accent: Accent | null | undefined,
  locale: Locale,
): AccentRange | undefined {
  return accent?.[locale] ?? undefined;
}

/**
 * Splits `text` into runs, marking the words in `range` as accented. Whitespace is kept
 * verbatim: the spaces BETWEEN accented words belong to the accent, the ones at its edges
 * do not. A trailing "*" on the last accented word (the hero's footnote mark) stays
 * outside the accent.
 */
export function splitAccent(text: string, range: AccentRange | undefined): TextRun[] {
  if (!range) return text ? [{ text, accent: false }] : [];
  const tokens = text.split(/(\s+)/).filter((t) => t !== '');
  const words = tokens.filter((t) => !/^\s+$/.test(t)).length;
  const inRange = (i: number) => i >= range.from && (range.to === undefined || i < range.to);
  const lastAccented = Math.min(range.to ?? words, words) - 1;

  const runs: TextRun[] = [];
  const push = (chunk: string, accent: boolean) => {
    if (!chunk) return;
    const last = runs[runs.length - 1];
    if (last && last.accent === accent) last.text += chunk;
    else runs.push({ text: chunk, accent });
  };

  let word = -1;
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      // A space is accented only when the words on both sides of it are.
      push(token, word + 1 < words && inRange(word) && inRange(word + 1));
      continue;
    }
    word += 1;
    if (!inRange(word)) push(token, false);
    else if (word === lastAccented && token.length > 1 && token.endsWith('*')) {
      push(token.slice(0, -1), true);
      push('*', false);
    } else push(token, true);
  }
  return runs;
}
