import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_STYLESHEETS } from '@/lib/admin/stylesheets';

// public/styles/admin.css, the Admin v2 design system (F1). Each rule here keeps a
// property the port depends on:
//   - the admin's @font-face set is global.css's, so authors proof Arabic in the faces
//     visitors see (docs/fonts.md: both stylesheets change together);
//   - colour literals live only in the token block, so a palette change is one edit and
//     scripts/contrast-audit.mjs, which reads that block, checks every colour that ships;
//   - every class the admin markup uses is still styled: a restyle that drops a hook an
//     island renders is a silent regression no type checker sees.
// The screen stylesheets (public/styles/admin/<name>, Admin v2 W0) hold what one screen
// alone renders. They use the tokens and define none, so the colour rule covers them with
// no exemption at all, and a class only a screen sheet styles must render only on the
// pages that link that sheet.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const ADMIN = stripComments(read('public/styles/admin.css'));
const GLOBAL = stripComments(read('public/styles/global.css'));

/** The screen stylesheets by name, comments stripped. */
const SCREENS: Record<string, string> = Object.fromEntries(
  ADMIN_STYLESHEETS.map((name) => [name, stripComments(read(`public/styles/admin/${name}`))]),
);

/** The class names a stylesheet's selectors mention. */
const classesOf = (css: string) =>
  new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string));

function fontFaces(css: string): string[] {
  return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

/** The token section: the :root block and the ::backdrop scrim. */
function withoutTokenBlocks(css: string): string {
  return css.replace(/:root\s*\{[\s\S]*?\n\}/, '').replace(/::backdrop\s*\{[^}]*\}/, '');
}

/**
 * Colour literals in declaration VALUES, as `property: literal`. Selectors such as
 * [data-tone='gray'] and properties such as white-space are not colours. A declaration
 * ends at `;` or at its rule's `}` (the last one may have no `;`). A token reference is
 * not a literal, but its fallback is: `var(--x, #123)` renders #123 whenever --x is unset.
 */
function colourLiterals(css: string): string[] {
  return [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/gi)].flatMap((m) => {
    const value = (m[2] ?? '')
      .replace(/var\(\s*--[\w-]+\s*,/g, '(')
      .replace(/var\(\s*--[\w-]+\s*\)/g, '');
    return [
      ...value.matchAll(
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:black|white|red|green|blue|gray|grey)\b/gi,
      ),
    ].map((hit) => `${m[1]}: ${hit[0]}`);
  });
}

/** What the colour rule applies to: everything but the token blocks and the font faces. */
const outsideTokens = (css: string) =>
  withoutTokenBlocks(css).replace(/@font-face\s*\{[^}]*\}/g, '');

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
    expect(
      admin
        .split(',')
        .slice(0, 3)
        .map((s) => s.trim().replace(/'/g, '')),
    ).toEqual(['Almarai', 'Almarai Fallback', 'Almarai Fallback Linux']);
    expect(admin).toBe(stack(GLOBAL, '--bs-font-ar'));
  });
});

describe('admin.css colours', () => {
  it('has a token block', () => {
    expect(ADMIN).toMatch(/:root\s*\{[\s\S]*--ad-primary:/);
  });

  it('keeps every colour literal inside the token block', () => {
    expect(colourLiterals(outsideTokens(ADMIN))).toEqual([]);
  });

  it('would catch a literal outside the block (the check is not vacuous)', () => {
    // Planted after the real stylesheet, so the token-block cut is exercised too: it must
    // not swallow what follows it.
    const planted = `${ADMIN}
.x { color: #123456; border-color: gray; }
.y { background: var(--ad-card, #fafafa) }
.z { box-shadow: 0 0 0 1px var(--ad-line, var(--ad-line-2)); outline-color: rgb(0 0 0) }`;
    expect(colourLiterals(outsideTokens(planted))).toEqual([
      'color: #123456',
      'border-color: gray',
      'background: #fafafa',
      'outline-color: rgb(',
    ]);
  });

  it('finds the token block’s own literals, so it is the cut that keeps them out', () => {
    expect(colourLiterals(ADMIN).length).toBeGreaterThan(20);
  });

  it('has one reduced-motion block', () => {
    expect(ADMIN.match(/prefers-reduced-motion:\s*reduce/g)).toHaveLength(1);
  });

  it('gives fill-only states a border under forced colours', () => {
    expect(ADMIN).toMatch(/@media \(forced-colors: active\)/);
  });
});

describe('the screen stylesheets (public/styles/admin/)', () => {
  it('are exactly the files the closed list names', () => {
    const files = readdirSync(join(ROOT, 'public/styles/admin')).filter((f) => f.endsWith('.css'));
    expect(files.sort()).toEqual([...ADMIN_STYLESHEETS].sort());
    // Pinned, not derived: a sheet dropped from the list must fail, not go unchecked.
    expect([...ADMIN_STYLESHEETS].sort()).toEqual(['login.css', 'search.css']);
  });

  it.each([...ADMIN_STYLESHEETS])(
    '%s uses the tokens: no colour literal, token, font face or motion block of its own',
    (name) => {
      const css = SCREENS[name] as string;
      expect(colourLiterals(css)).toEqual([]);
      expect(css).not.toMatch(/--ad-[\w-]+\s*:/);
      expect(css).not.toMatch(/:root\s*\{/);
      expect(css).not.toMatch(/@font-face/);
      expect(css).not.toMatch(/prefers-reduced-motion/);
    },
  );
});

describe('admin.css keeps the design system’s hooks', () => {
  // The hooks docs/admin-v2/ui.md §1.2 keeps for every screen ("JS and the tests depend on
  // these"). Rendered by one screen today is not the test: a later screen renders them
  // too (the lead score bar is a `.bar-fill[data-width]`, ui.md §1.6, crm.md), and a hook
  // moved into one screen's sheet would make it link a sheet named for another screen or
  // move the rules back, the shared-file edit the screen sheets exist to avoid.
  const DESIGN_SYSTEM_HOOKS = [
    'admin-dialog',
    'badge',
    'bar',
    'bar-fill',
    'btn',
    'card',
    'data',
    'field',
    'field-group',
    'field-legend',
    'msg',
    'row-2',
    'tabs',
    'toast',
    'toasts',
    'toolbar',
    'visually-hidden',
  ];

  it('styles every one of them', () => {
    const styled = classesOf(ADMIN);
    expect(DESIGN_SYSTEM_HOOKS.filter((hook) => !styled.has(hook))).toEqual([]);
  });

  it('holds the whole bar: the track, every 5% bucket and the forced-colours fill', () => {
    expect(ADMIN).toMatch(/(?:^|\n)\.bar\s*\{[^}]*inline-size:/);
    for (let width = 0; width <= 100; width += 5) {
      expect(ADMIN).toMatch(
        new RegExp(`\\.bar-fill\\[data-width='${width}'\\]\\s*\\{\\s*inline-size:\\s*${width}%`),
      );
    }
    expect(ADMIN).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*\.bar-fill\s*\{\s*background:\s*Highlight/,
    );
  });
});

describe('admin.css: the sticky topbar never hides focus (WCAG 2.4.11)', () => {
  // tests/admin/shell.e2e.ts proves it in a browser; this keeps the two halves together.
  it('pads the scroll port by the height the layout measures', () => {
    expect(ADMIN).toMatch(/\.admin-main > \.admin-topbar\s*\{[^}]*position:\s*sticky/);
    expect(ADMIN).toMatch(/scroll-padding-block-start:\s*calc\(var\(--ad-top-h, var\(--ad-top\)\)/);
    expect(read('src/layouts/AdminLayout.astro')).toMatch(/setProperty\('--ad-top-h'/);
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

  /** The classes one file renders. */
  function classesIn(src: string): Set<string> {
    const used = new Set<string>();
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
    return used;
  }

  const usedBy = new Map(sources.map((file) => [file, classesIn(read(file))]));
  const used = new Set([...usedBy.values()].flatMap((classes) => [...classes]));

  // Who imports whom among these files, so a component's classes can be traced to the
  // pages it renders on (through an island's re-export, a lazy import, the layout).
  const known = new Set(sources);
  function resolve(from: string, spec: string): string | null {
    const base = spec.startsWith('@/')
      ? `src/${spec.slice(2)}`
      : spec.startsWith('.')
        ? posix.join(posix.dirname(from), spec)
        : null;
    if (base === null) return null;
    for (const ext of ['', '.ts', '.tsx', '.astro', '/index.ts']) {
      if (known.has(base + ext)) return base + ext;
    }
    return null;
  }
  const importers = new Map<string, string[]>();
  for (const file of sources) {
    for (const m of read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      const target = resolve(file, m[1] as string);
      if (target) importers.set(target, [...(importers.get(target) ?? []), file]);
    }
  }
  /** The admin pages a file renders on: itself when it is one, else every page above it. */
  function pagesOf(file: string, seen = new Set<string>()): string[] {
    if (seen.has(file)) return [];
    seen.add(file);
    if (file.startsWith('src/pages/admin/')) return [file];
    return [...new Set((importers.get(file) ?? []).flatMap((up) => pagesOf(up, seen)))];
  }
  const linksSheet = (page: string, sheet: string) =>
    (read(page).match(/\bstyles=\{\[([^\]]*)\]\}/)?.[1] ?? '').includes(`'${sheet}'`);

  it('finds the classes it checks', () => {
    expect(used.size).toBeGreaterThan(40);
  });

  it('styles every class an admin page, island or helper renders', () => {
    const styled = new Set(
      [ADMIN, ...Object.values(SCREENS)].flatMap((css) => [...classesOf(css)]),
    );
    const missing = [...used].filter((c) => !styled.has(c) && !UNSTYLED_HOOKS.has(c)).sort();
    expect(missing).toEqual([]);
  });

  describe('a class only a screen sheet styles renders only where that sheet is linked', () => {
    const shared = classesOf(ADMIN);
    /** Per sheet: each file rendering a class only that sheet styles, and those classes. */
    const renderers: Record<string, { file: string; rendered: string[] }[]> = Object.fromEntries(
      Object.entries(SCREENS).map(([sheet, css]) => {
        const own = [...classesOf(css)].filter((c) => !shared.has(c));
        const files = [...usedBy].flatMap(([file, classes]) => {
          const rendered = own.filter((c) => classes.has(c));
          return rendered.length > 0 ? [{ file, rendered }] : [];
        });
        return [sheet, files];
      }),
    );

    it.each([...ADMIN_STYLESHEETS])('%s: every page that renders its classes links it', (sheet) => {
      const problems: string[] = [];
      for (const { file, rendered } of renderers[sheet] ?? []) {
        const pages = pagesOf(file);
        if (pages.length === 0) problems.push(`${file}: no admin page renders it`);
        for (const page of pages) {
          if (!linksSheet(page, sheet)) problems.push(`${page} renders ${rendered.join(', ')}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('traces each sheet to the pages it serves (the walk is not vacuous)', () => {
      const pagesFor = (sheet: string) =>
        [...new Set((renderers[sheet] ?? []).flatMap(({ file }) => pagesOf(file)))].sort();
      expect(pagesFor('login.css')).toEqual(['src/pages/admin/login.astro']);
      expect(pagesFor('search.css')).toEqual(['src/pages/admin/search.astro']);
      // Both sheets' classes are rendered by their pages themselves, so the import walk
      // is proved on a screen's code: through its island entry to every page hydrating it.
      expect(pagesOf('src/components/admin/screens/insights/InsightsPanel.tsx').sort()).toEqual([
        'src/pages/admin/analytics/index.astro',
        'src/pages/admin/analytics/search.astro',
        'src/pages/admin/site-health.astro',
      ]);
    });
  });
});
