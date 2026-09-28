import type { Locale } from '@schemas/primitives';

// Text for the hero's Round 2 links (Hero.astro `data.altLink` / `crumb` / `skipLink`).
// Route data, not CMS content: a preset hands the hero an {en, ar} pair, a service page
// (which already works in one language) a plain string.

export type HeroText = string | { en: string; ar?: string | undefined };

/** The text in the page's language (EN when an Arabic value is missing — EN is x-default). */
export function heroText(text: HeroText, locale: Locale): string {
  if (typeof text === 'string') return text;
  return (locale === 'ar' ? text.ar : text.en) || text.en;
}

export interface BoldRun {
  text: string;
  bold: boolean;
}

/**
 * "Know what you need? <b>Skip to the inquiry</b>" → runs rendered as text and a <b>
 * element. Only a literal `<b>` / `</b>` pair (attributes allowed, as the mockup's Arabic
 * `<b dir="ltr">`) marks the bold run; everything else — any other tag included — stays
 * text, so this can never inject markup. An unclosed <b> bolds to the end.
 */
export function splitBold(input: string): BoldRun[] {
  const runs: BoldRun[] = [];
  const push = (text: string, bold: boolean) => {
    if (text) runs.push({ text, bold });
  };
  const open = /<b(?:\s[^>]*)?>/i;
  let rest = input;
  for (;;) {
    const start = open.exec(rest);
    if (!start) break;
    push(rest.slice(0, start.index), false);
    rest = rest.slice(start.index + start[0].length);
    const end = rest.search(/<\/b>/i);
    if (end === -1) {
      push(rest, true);
      return runs;
    }
    push(rest.slice(0, end), true);
    rest = rest.slice(end + 4);
  }
  push(rest, false);
  return runs;
}
