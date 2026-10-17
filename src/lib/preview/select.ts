// The select strings the public loaders send, parsed for the preview's emulator (Admin v2
// R8; docs/admin-v2/README.md "Preview": the overlay emulates only what the loaders use).
//
// What parses: plain column names, and embeds written `alias:target(...)` or `target(...)`,
// nested so that a path holds at most three tables (service_cases → project → poster is
// the deepest a loader goes). Whitespace and newlines are ignored, as supabase-js strips
// them. Everything else PostgREST would accept is REFUSED with PreviewUnsupportedError,
// never approximated: `*`, casts (`::`), hints and inner joins (`!`), spreads (`...`), JSON
// paths (`->`), column aliases, quoted names, aggregates (`count()`, `col.sum()`), and a
// deeper nest. Whether an embed's target exists is the client's question (relations.ts),
// since it depends on the table the select runs on.
//
// Pure. The memo below is keyed by the select string alone (code constants in the
// loaders) and holds frozen parse trees, nothing about a request: the one module-level
// value tests/lib/contentSource.spec.ts allows here. It is bounded, so a caller passing
// many different strings cannot grow it without limit.

/** An operation, select form or table the emulator does not handle. Recorded, then thrown. */
export class PreviewUnsupportedError extends Error {
  constructor(readonly what: string) {
    super(`not previewable: ${what}`);
    this.name = 'PreviewUnsupportedError';
  }
}

export type SelectItem =
  | { readonly kind: 'column'; readonly name: string }
  | {
      readonly kind: 'embed';
      /** The key the embedded value is returned under. */
      readonly alias: string;
      /** A foreign-key column of the table, or a table name (relations.ts resolves it). */
      readonly target: string;
      readonly items: readonly SelectItem[];
    };

/** Tables in one embed path, the top-level table included. */
export const MAX_SELECT_DEPTH = 3;
const MEMO_MAX = 256;
const NAME = /^[a-z_][a-z0-9_]*$/;
const EMBED = /^([a-z_][a-z0-9_]*)(?::([a-z_][a-z0-9_]*))?\((.*)\)$/s;

const memo = new Map<string, readonly SelectItem[]>();

/** Splits a list on its top-level commas; refuses unbalanced parentheses. */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) throw new PreviewUnsupportedError('select: unbalanced parentheses');
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (depth !== 0) throw new PreviewUnsupportedError('select: unbalanced parentheses');
  out.push(current);
  return out;
}

function refuseForms(text: string): void {
  if (text.includes('*')) throw new PreviewUnsupportedError('select: *');
  if (text.includes('::')) throw new PreviewUnsupportedError('select: a cast');
  if (text.includes('!')) throw new PreviewUnsupportedError('select: a hint or inner join');
  if (text.includes('...')) throw new PreviewUnsupportedError('select: a spread');
  if (text.includes('->')) throw new PreviewUnsupportedError('select: a JSON path');
  if (text.includes('"')) throw new PreviewUnsupportedError('select: a quoted name');
}

function parseList(list: string, depth: number): SelectItem[] {
  if (depth > MAX_SELECT_DEPTH) {
    throw new PreviewUnsupportedError(`select: embeds deeper than ${MAX_SELECT_DEPTH} tables`);
  }
  const items: SelectItem[] = [];
  for (const raw of splitTop(list)) {
    if (raw === '') throw new PreviewUnsupportedError('select: an empty item');
    const embed = EMBED.exec(raw);
    if (embed) {
      const [, first, second, inner] = embed;
      if (inner === '') throw new PreviewUnsupportedError('select: an aggregate');
      items.push(
        Object.freeze({
          kind: 'embed' as const,
          alias: first!,
          target: second ?? first!,
          items: Object.freeze(parseList(inner!, depth + 1)),
        }),
      );
      continue;
    }
    if (raw.includes('.')) throw new PreviewUnsupportedError('select: an aggregate');
    if (raw.includes(':')) throw new PreviewUnsupportedError('select: a column alias');
    if (!NAME.test(raw)) throw new PreviewUnsupportedError('select: a column name');
    items.push(Object.freeze({ kind: 'column' as const, name: raw }));
  }
  return items;
}

/** The parse tree of a select string (memoised, frozen); throws PreviewUnsupportedError. */
export function parseSelect(select: string): readonly SelectItem[] {
  const known = memo.get(select);
  if (known) return known;
  const text = select.replace(/\s+/g, '');
  refuseForms(text);
  if (text === '') throw new PreviewUnsupportedError('select: an empty list');
  const tree = Object.freeze(parseList(text, 1));
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(select, tree);
  return tree;
}
