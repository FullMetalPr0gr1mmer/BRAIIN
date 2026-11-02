// How deep a JSON value nests, checked without recursion (H15). Zod-free: the schemas that
// stringify a value to measure it (packages/schemas/admin.ts, release.ts) call it first.
//
// `JSON.stringify` recurses once a level. On a value nested past about 4,700 levels (a payload
// of some 19 KB, inside every size cap the schemas set) it overflows the stack: a RangeError
// out of a refine, so a 500 where an issue was meant (E10's independent check: the 64 KB refine
// on section content, every section type). Checking the depth first, iteratively, turns that
// value into an issue, and the stringify then only ever sees a shallow one.

/**
 * Whether `value` nests at most `maxDepth` levels: an object or an array is one level more than
 * its container, a scalar none. Iterative, and it stops at the first value past the bound. It
 * reads what `JSON.stringify` reads (own enumerable values).
 */
export function jsonDepthWithin(value: unknown, maxDepth: number): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: next, depth } = stack.pop()!;
    if (typeof next !== 'object' || next === null) continue;
    if (depth + 1 > maxDepth) return false;
    const entries: unknown[] = Array.isArray(next) ? next : Object.values(next);
    for (const entry of entries) {
      if (typeof entry === 'object' && entry !== null)
        stack.push({ value: entry, depth: depth + 1 });
    }
  }
  return true;
}
