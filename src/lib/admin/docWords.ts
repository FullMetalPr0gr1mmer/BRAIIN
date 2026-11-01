// Whether a rich-text value is an Arabic gap (Admin v2 E10): what "Arabic missing" asks of
// a body whose two languages go together (FormField's rich-text field, `bothLanguages`). What
// "has words" means is packages/schemas/docWords.ts, the one definition the section schema and
// renderer use too; it is zod-free, so it adds nothing to the field kit but its walk.

import { docHasWords } from '@schemas/docWords';

export { docHasWords };

/**
 * Whether a rich-text field's value is an Arabic gap ("Arabic missing"): its two languages go
 * together (`bothLanguages`, a Text block's body) and the English has words the Arabic lacks.
 * FormField's rich-text field reports it (useArabicGap); tests/admin/section-blocks.e2e.ts
 * holds the wiring, tests/lib/sectionBlocks.spec.ts the rule.
 */
export function richTextArabicGap(bothLanguages: boolean, value: unknown): boolean {
  if (!bothLanguages || typeof value !== 'object' || value === null) return false;
  const pair = value as { en?: unknown; ar?: unknown };
  return docHasWords(pair.en) && !docHasWords(pair.ar);
}
