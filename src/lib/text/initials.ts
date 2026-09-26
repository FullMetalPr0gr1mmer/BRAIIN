// Initials for an avatar placeholder (a testimonial or leader without a portrait).
//
// First grapheme of the first two words — graphemes, not UTF-16 code units, so a name
// starting with an emoji or a combining mark is not cut in half. Latin is uppercased.
// A leading Arabic definite article (ال) is skipped: "اسم العميل" gives "اع", where the
// mockup's naive first-letter rule gave "اا" — every surname starting with ال would
// otherwise share the same second initial.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function firstGrapheme(word: string): string {
  const stripped = word.length > 2 && word.startsWith('ال') ? word.slice(2) : word;
  for (const { segment } of segmenter.segment(stripped)) return segment;
  return '';
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map(firstGrapheme).join('').toLocaleUpperCase('en');
}
