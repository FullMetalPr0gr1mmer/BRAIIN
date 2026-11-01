// Whether a rich-text document holds any words (Admin v2 E10): what "Arabic missing" asks of
// a body whose two languages go together (FormField's rich-text field, `bothLanguages`). Pure
// and type-only on the schema, so it adds nothing to the field kit but this walk.

interface DocNode {
  text?: unknown;
  content?: unknown;
}

/** True when some text node of `doc` has a character that is not white space. */
export function docHasWords(doc: unknown): boolean {
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const { text, content } = node as DocNode;
    if (typeof text === 'string' && text.trim() !== '') return true;
    if (Array.isArray(content)) stack.push(...(content as unknown[]));
  }
  return false;
}

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
