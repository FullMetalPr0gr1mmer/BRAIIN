import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A control byte in source is never intended. Edit scripts that pass a string like '\b' through
// another language's string escapes have written a literal backspace (0x08) where a regex word
// boundary was meant: `/\baccent\b/` became a pattern that matches nothing, so the assertion it
// guarded passed without testing anything (tests/e2e/home-sections.e2e.ts, fixed here).

const ROOTS = ['src', 'tests', 'scripts', 'packages', 'supabase'];
const EXTENSIONS = ['.ts', '.tsx', '.astro', '.js', '.mjs', '.cjs', '.sql', '.css', '.json', '.md'];
/** Tab, line feed and carriage return are text; every other C0 control byte is not. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (EXTENSIONS.some((ext) => name.endsWith(ext))) yield path;
  }
}

describe('no control bytes in source', () => {
  it('every source, test, script and migration file holds text only', () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const path of files(root)) {
        const bytes = readFileSync(path);
        const at = bytes.findIndex((byte) => byte < 0x20 && !ALLOWED.has(byte));
        if (at >= 0) found.push(`${path} @${at}: 0x${bytes[at]!.toString(16).padStart(2, '0')}`);
      }
    }
    expect(found).toEqual([]);
  });
});
