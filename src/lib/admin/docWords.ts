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
