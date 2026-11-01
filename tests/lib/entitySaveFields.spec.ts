import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// useEntitySave's `load` depends on its `fields` option, and the effect that loads the row runs
// again whenever `load` changes. A `fields` array built anew on every render therefore reloads
// the row after each render, and an `onRow` that sets state renders again: an endless read of the
// row's API, which the CI sweep found on the Forms editor (E8) as a page that never went
// network-idle. So every caller passes `fields` that keep their identity across renders: a
// member of a module-level config (`ui.fields`), a module-level constant, or a `useMemo` result.

const ROOT = 'src/components/admin';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Each `fields:` value passed in a useEntitySave(...) call, with the file it is in. */
function callerFields(): { file: string; value: string }[] {
  const out: { file: string; value: string }[] = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, 'utf8');
    let at = src.indexOf('useEntitySave(');
    while (at !== -1) {
      // The options object of this call: up to the call's closing parenthesis.
      let depth = 0;
      let end = at + 'useEntitySave'.length;
      for (; end < src.length; end += 1) {
        const ch = src[end];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const call = src.slice(at, end);
      const match = /\bfields:\s*([^,\n}]+)/.exec(call);
      if (match) out.push({ file, value: match[1]!.trim() });
      at = src.indexOf('useEntitySave(', end);
    }
  }
  return out;
}

/** True when `name` is imported, declared at the module's top level, or a useMemo result. */
function stableBinding(src: string, name: string): boolean {
  const imported = new RegExp(`^import\\s[^;]*\\b${name}\\b[^;]*\\sfrom\\s`, 'm');
  const topLevel = new RegExp(`^(?:export\\s+)?const\\s+${name}\\b`, 'm');
  const memo = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*useMemo\\b`);
  return imported.test(src) || topLevel.test(src) || memo.test(src);
}

describe('useEntitySave callers pass fields that keep their identity across renders', () => {
  const callers = callerFields();

  it('finds the callers it checks', () => {
    expect(callers.length).toBeGreaterThan(10);
    expect(callers.some((c) => c.file.includes('FormsScreen'))).toBe(true);
  });

  it.each(callers.map((c) => [c.file, c.value]))('%s passes fields: %s', (file, value) => {
    // Never an array literal written in the call.
    expect(
      value.startsWith('['),
      `${file}: an inline fields array is rebuilt on every render`,
    ).toBe(false);
    // A member (ui.fields, def.fields) of something the screen did not build itself, or a bare
    // name bound at the top level or by useMemo.
    if (/^\w+$/.test(value)) {
      const src = readFileSync(file, 'utf8');
      expect(
        stableBinding(src, value),
        `${file}: fields "${value}" must be a module constant or a useMemo result`,
      ).toBe(true);
    }
  });
});
