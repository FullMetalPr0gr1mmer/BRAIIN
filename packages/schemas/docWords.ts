// Whether a rich-text document holds any words (Admin v2 E10). ONE definition, used by the
// section body's write check (sectionDocProblem, ./tiptap.ts), the section renderer (an empty
// heading or list item renders nothing: src/lib/content/tiptap.ts) and the admin (a body with
// no words is left out of the save, and "Arabic missing": src/lib/admin/docWords.ts). Zod-free,
// so the admin's field kit takes it without the schema code (E10 code review, CR7: the three
// had their own walks, and they disagreed on a `text` key outside a text node).

/** A text node with a character that is not white space: what "words" means everywhere. */
export function isWordText(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const { type, text } = node as { type?: unknown; text?: unknown };
  return type === 'text' && typeof text === 'string' && text.trim() !== '';
}

/**
 * True when `doc`, or a node anywhere under it, is a text node with words. Iterative (a deep
 * document never grows the call stack); it reads `content` arrays and nothing else.
 */
export function docHasWords(doc: unknown): boolean {
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isWordText(node)) return true;
    if (typeof node !== 'object' || node === null) continue;
    const content = (node as { content?: unknown }).content;
    if (Array.isArray(content)) for (const child of content as unknown[]) stack.push(child);
  }
  return false;
}
