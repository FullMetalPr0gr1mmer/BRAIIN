import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// public/styles/admin.css, the Admin v2 design system (F1). Each rule here keeps a
// property the port depends on:
//   - the admin's @font-face set is global.css's, so authors proof Arabic in the faces
//     visitors see (docs/fonts.md: both stylesheets change together);
//   - colour literals live only in the token block, so a palette change is one edit and
//     scripts/contrast-audit.mjs, which reads that block, checks every colour that ships;
//   - every class the admin markup uses is still styled: a restyle that drops a hook an
//     island renders is a silent regression no type checker sees.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const ADMIN = stripComments(read('public/styles/admin.css'));
const GLOBAL = stripComments(read('public/styles/global.css'));

function fontFaces(css: string): string[] {
  return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

/** The token section: the :root block and the ::backdrop scrim. */
function withoutTokenBlocks(css: string): string {
  return css.replace(/:root\s*\{[\s\S]*?\n\}/, '').replace(/::backdrop\s*\{[^}]*\}/, '');
}

describe('admin.css fonts', () => {
  it('declares exactly the @font-face set global.css does', () => {
    const admin = fontFaces(ADMIN);
    expect(admin.length).toBeGreaterThan(0);
    expect(admin).toEqual(fontFaces(GLOBAL));
  });

  it('sets Arabic in the public site’s stack, Almarai and both fallbacks first', () => {
    const stack = (css: string, token: string) =>
      new RegExp(`${token}:\\s*([^;]+);`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    const admin = stack(ADMIN, '--ad-font-ar');
    expect(admin.split(',').slice(0, 3).map((s) => s.trim().replace(/'/g, ''))).toEqual([
      'Almarai',
      'Almarai Fallback',
      'Almarai Fallback Linux',
    ]);
    expect(admin).toBe(stack(GLOBAL, '--bs-font-ar'));
  });
});

describe('admin.css colours', () => {
  it('has a token block', () => {
    expect(ADMIN).toMatch(/:root\s*\{[\s\S]*--ad-primary:/);
  });

  it('keeps every colour literal inside the token block', () => {
    const rest = withoutTokenBlocks(ADMIN).replace(/@font-face\s*\{[^}]*\}/g, '');
    // Declaration VALUES only (selectors such as [data-tone='gray'] and properties such
    // as white-space are not colours), with token references removed.
    const literals = [...rest.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gi)].flatMap((m) => {
      const value = (m[2] ?? '').replace(/var\([^)]*\)/g, '');
      return [
        ...value.matchAll(
          /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:black|white|red|green|blue|gray|grey)\b/gi,
        ),
      ].map((hit) => `${m[1]}: ${hit[0]}`);
    });
    expect(literals).toEqual([]);
  });

  it('would catch a literal outside the block (the check is not vacuous)', () => {
    const planted = `${ADMIN}\n.x { color: #123456; border-color: gray; }`;
    const rest = withoutTokenBlocks(planted);
    expect(rest).toMatch(/color:\s*#123456/);
  });

  it('has one reduced-motion block', () => {
    expect(ADMIN.match(/prefers-reduced-motion:\s*reduce/g)).toHaveLength(1);
  });

  it('gives fill-only states a border under forced colours', () => {
    expect(ADMIN).toMatch(/@media \(forced-colors: active\)/);
  });
});

describe('admin.css keeps the hooks the markup renders', () => {
  // Classes that are behaviour or test hooks with no style of their own.
  const UNSTYLED_HOOKS = new Set(['account-menu', 'admin-nav']);

  function walk(dir: string): string[] {
    return readdirSync(join(ROOT, dir)).flatMap((name) => {
      const path = `${dir}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) return walk(path);
      return /\.(tsx|ts|astro)$/.test(name) ? [path] : [];
    });
  }

  const sources = [
    ...walk('src/components/admin'),
    ...walk('src/pages/admin'),
    ...walk('src/lib/admin'),
    'src/layouts/AdminLayout.astro',
  ];

  const used = new Set<string>();
  for (const file of sources) {
    const src = read(file);
    for (const m of src.matchAll(/\bclass(?:Name)?\s*=\s*"([^"]+)"/g)) {
      for (const c of (m[1] ?? '').split(/\s+/)) if (c) used.add(c);
    }
    for (const m of src.matchAll(/\bclass(?:Name)?\s*=\s*\{([^}]*)\}/g)) {
      for (const q of (m[1] ?? '').matchAll(/['"`]([^'"`]+)['"`]/g)) {
        for (const c of (q[1] ?? '').split(/\s+/)) if (/^[a-z][a-z0-9_-]*$/.test(c)) used.add(c);
      }
    }
    for (const m of src.matchAll(/\.className\s*=\s*['"`]([^'"`]+)['"`]/g)) {
      for (const c of (m[1] ?? '').split(/\s+/)) if (c) used.add(c);
    }
  }

  it('finds the classes it checks', () => {
    expect(used.size).toBeGreaterThan(40);
  });

  it('styles every class an admin page, island or helper renders', () => {
    const styled = new Set([...ADMIN.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    const missing = [...used].filter((c) => !styled.has(c) && !UNSTYLED_HOOKS.has(c)).sort();
    expect(missing).toEqual([]);
  });
});
