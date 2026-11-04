import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_STYLESHEETS } from '@/lib/admin/stylesheets';
import { FONT_FAMILIES } from '@theme/fonts';
import { familyFaceRules, fontFaceCss } from '@theme/fontFaces';

// public/styles/admin.css, the Admin v2 design system (F1). Each rule here keeps a
// property the port depends on:
//   - the admin's @font-face set is global.css's, so authors proof Arabic in the faces
//     visitors see (docs/fonts.md: both stylesheets change together), then every other
//     family of the font catalogue (Admin v2 E13), so the theme editor draws each in itself;
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
  it('declares exactly the @font-face set global.css does, then the catalogue’s other families', () => {
    const admin = fontFaces(ADMIN);
    const site = fontFaces(GLOBAL);
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.slice(0, site.length)).toEqual(site);
    expect(admin.slice(site.length)).toEqual(
      FONT_FAMILIES.filter((f) => !f.brand).flatMap((f) =>
        fontFaceCss(familyFaceRules(f), 'spaced'),
      ),
    );
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
    expect([...ADMIN_STYLESHEETS].sort()).toEqual([
      'activity.css',
      'applications.css',
      'collection.css',
      'crm-settings.css',
      'dashboard.css',
      // Admin v2 E6: the Footer screen.
      'footer.css',
      'forms.css',
      'general.css',
      'header.css',
      'health.css',
      'help.css',
      'integrations.css',
      'kit.css',
      'leads.css',
      // Admin v2 E7: the Loading screen.
      'loading.css',
      'login.css',
      'maintenance.css',
      'media.css',
      'pages.css',
      'personal.css',
      'projects.css',
      'search.css',
      'seo.css',
      'services.css',
      'stats.css',
      'theme.css',
      'two-step.css',
      'users.css',
      'versions.css',
      'visibility.css',
    ]);
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

describe('admin.css: a list row wraps text it does not control (Admin v2 F8)', () => {
  // The bell's rows carry what visitors typed: a lead's name and an applicant's role, up
  // to 120 characters each, possibly one unbroken word. tests/admin/personal.e2e.ts proves
  // the drawer then has no sideways scroll; this keeps the rule that makes it so.
  it('lets the title and the second line break anywhere', () => {
    for (const hook of ['li__t', 'li__s']) {
      expect(ADMIN, hook).toMatch(
        new RegExp(`(?:^|\\n)\\.${hook}\\s*\\{[^}]*overflow-wrap:\\s*anywhere`),
      );
    }
  });
});

describe('admin.css: a row’s hidden actions take no presses (Admin v2 F4b review)', () => {
  // DataTable's row actions sit above the row's stretched link. Hidden by opacity alone
  // they still took presses, so a tap at a row's end pressed an unseen Move (which posts
  // at once). tests/admin/kit.e2e.ts proves it in a browser; this keeps the rules.

  /** The declarations of the rule whose selector is exactly `selector`, indented two. */
  const body = (selector: string) => {
    const start = ADMIN.indexOf(`\n  ${selector} {`);
    if (start === -1) return '';
    const open = ADMIN.indexOf('{', start);
    return ADMIN.slice(open + 1, ADMIN.indexOf('}', open));
  };

  it('hidden: click-through, armed by hover only after the fade', () => {
    const hidden = body('.dt .row-acts');
    expect(hidden).toMatch(/opacity:\s*0;/);
    expect(hidden).toMatch(/pointer-events:\s*none;/);
    expect(hidden).toMatch(/pointer-events 0s 0\.2s allow-discrete/);
    // visibility: hidden would also take them out of the tab order; focus must reach them.
    expect(hidden).not.toMatch(/visibility/);
  });

  it('shown on hover, focus or a tick; focus and a tick arm them at once', () => {
    expect(ADMIN).toMatch(
      /\.dt tbody tr:hover \.row-acts,\s*\.dt tbody tr:focus-within \.row-acts,\s*\.dt tbody tr\[data-selected\] \.row-acts\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/,
    );
    expect(ADMIN).toMatch(
      /\n {2}\.dt tbody tr:focus-within \.row-acts,\s*\.dt tbody tr\[data-selected\] \.row-acts\s*\{\s*transition-delay:\s*0s;/,
    );
  });

  it('a list row’s actions follow the same rules (ListRow over its stretched title link)', () => {
    const hidden = body('.li__acts');
    expect(hidden).toMatch(/opacity:\s*0;/);
    expect(hidden).toMatch(/pointer-events:\s*none;/);
    expect(hidden).toMatch(/pointer-events 0s 0\.2s allow-discrete/);
    expect(hidden).not.toMatch(/visibility/);
    expect(ADMIN).toMatch(
      /\.li:hover \.li__acts,\s*\.li:focus-within \.li__acts,\s*\.li\[aria-current\] \.li__acts\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/,
    );
    expect(ADMIN).toMatch(
      /\n {2}\.li:focus-within \.li__acts,\s*\.li\[aria-current\] \.li__acts\s*\{\s*transition-delay:\s*0s;/,
    );
  });

  it('reduced motion keeps the arming delay for both: it is not motion', () => {
    expect(ADMIN).toMatch(
      /\.admin-body \.dt \.row-acts,\s*\.admin-body \.li__acts\s*\{\s*transition:\s*pointer-events 0s 0\.2s allow-discrete !important;/,
    );
  });
});

describe('admin.css: a table never widens the page (WCAG 1.4.10, F4b pre-merge review)', () => {
  // tests/admin/kit.e2e.ts measures it at 320 and 390px; this keeps the rules that make it
  // so. A visually hidden cell text is position: absolute: without a positioned scroll
  // container its containing block is outside the clip and it widens the page.
  it('the scroll container is the containing block of what is positioned inside it', () => {
    expect(ADMIN).toMatch(/\n\.table-wrap\s*\{[^}]*position:\s*relative;[^}]*overflow-x:\s*auto/);
  });

  // The same trap, for every scroll container a stylesheet declares (C4c: the pipeline board
  // widened the page by 879px at 320, its column heads' hidden " leads" escaping its clip).
  it('every scroll container in the admin sheets is positioned', () => {
    const sheets: Record<string, string> = { 'admin.css': ADMIN, ...SCREENS };
    const scrollers: string[] = [];
    for (const [name, css] of Object.entries(sheets)) {
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/overflow(?:-x|-inline)?:\s*(?:auto|scroll)/.test(body ?? '')) continue;
        const where = `${name} ${selector?.trim()}`;
        scrollers.push(where);
        expect(body, where).toMatch(/position:\s*(?:relative|absolute|fixed|sticky)/);
      }
    }
    expect(scrollers).toEqual(expect.arrayContaining(['admin.css .table-wrap', 'leads.css .kb']));
  });

  // A group field's label bar is a flex box beside the field's floated legend. Chromium
  // squeezes such a box to 0px beside a float that fills the line, so with a long label at
  // 320px the EN | AR switch spilled 19px past the page (U8: the blog editor's SEO tab;
  // tests/admin/blog.e2e.ts measures it). Its one line, capped at the field, pushes it below.
  it('a group field’s label bar keeps its one line, so a long label pushes it below', () => {
    expect(ADMIN).toMatch(/\n\.f--group > \.f__bar\s*\{[^}]*min-inline-size:\s*fit-content;/);
  });

  it('the kit page stack lets a wide card shrink to the page', () => {
    expect(SCREENS['kit.css']).toMatch(
      /\.kit__stack\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
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

describe('admin.css: the shown savebar never covers a control or focus (R14a, WCAG 2.4.11)', () => {
  // The bar's measured height (--ad-savebar-h, src/components/admin/screens/release/
  // savebarSpace.ts) plus its inset is the room kept under it. Every rule that reserves room is
  // under the shown, fixed bar, which AdminLayout renders only with releases on, so with them
  // off nothing moves. tests/lib/savebarSpace.spec.ts holds the measure; the browser half is
  // tests/admin/releases-mode.e2e.ts.
  const GATE = ':has(.savebar[data-shown]:not([data-inline]))';
  const ROOM = 'calc(var(--ad-savebar-h, var(--ad-savebar)) + var(--ad-savebar-gap) + ';
  /** Every plain rule (selector, body), media blocks included. */
  const rules = [...ADMIN.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
    // One space between tokens, none inside a bracket's edges (prettier breaks a long calc).
    body: (m[2] ?? '').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
  }));
  const declared = (selector: string, prop: string) =>
    rules
      .filter((r) => r.selector === selector)
      .flatMap((r) => [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))])
      .map((m) => (m[1] ?? '').trim());
  const extra = (value: string | undefined) => {
    expect(value?.startsWith(ROOM), value).toBe(true);
    return Number(/\+ (\d+)px\)$/.exec(value!)?.[1]);
  };

  it('keeps the measured room plus the inset: the main column, the scroll port, the bulk bar, the toasts', () => {
    expect(extra(declared(`:root${GATE}`, 'scroll-padding-block-end')[0])).toBeGreaterThanOrEqual(
      8,
    );
    expect(
      extra(declared(`.admin-body${GATE} .admin-main`, 'padding-block-end')[0]),
    ).toBeGreaterThanOrEqual(16);
    expect(extra(declared(`.admin-body${GATE} .bulkbar`, 'inset-block-end')[0])).toBeGreaterThan(0);
    expect(extra(declared(`.admin-body${GATE} .toasts`, 'inset-block-end')[0])).toBeGreaterThan(0);
    // The inset the room adds is the bar's own.
    expect(declared('.savebar', 'inset-block-end')).toEqual(['var(--ad-savebar-gap)']);
  });

  it('keeps a stuck bulk bar’s measured room too, so a focused row is clear of both bars', () => {
    // The bulk bar sits on the band right above the shown bar (h + gap + 8px). Scroll padding
    // that ended where the bulk bar starts left a row's focused control behind it (R14a review,
    // CR-1): while a bulk bar shows, the scroll port also ends above the bulk bar.
    const both = declared(`:root${GATE}:has(.bulkbar)`, 'scroll-padding-block-end');
    expect(both).toHaveLength(1);
    const bulkAt = declared(`.admin-body${GATE} .bulkbar`, 'inset-block-end')[0];
    expect(bulkAt).toBe(`${ROOM}8px)`);
    // The bulk bar's own place (its inset over the savebar), then its measured height, then a gap.
    const value = both[0]!;
    expect(value.startsWith(`${ROOM}8px + var(--ad-bulkbar-h, var(--ad-bulkbar)) + `), value).toBe(
      true,
    );
    expect(Number(/\+ (\d+)px\)$/.exec(value)?.[1])).toBeGreaterThanOrEqual(8);
    // A stand-in before BulkBar's first measure, and the measure read only under the shown bar.
    expect(ADMIN).toMatch(/--ad-bulkbar:\s*\d+px;/);
    for (const rule of rules) {
      if (/var\(--ad-bulkbar(-h)?[,)]/.test(rule.body)) {
        expect(rule.selector, rule.body).toContain(GATE);
      }
    }
  });

  it('stands in with the worst bar measured until the first measure', () => {
    const px = (value: string | undefined) => Number(/^(\d+)px$/.exec(value ?? '')?.[1]);
    const wide = rules
      .filter((r) => r.selector === ':root')
      .flatMap((r) => {
        const m = /--ad-savebar:\s*([^;]+)/.exec(r.body);
        return m ? [m[1]!.trim()] : [];
      });
    // Two rows on a wide screen (about 109 px), three on a phone (about 177 px).
    expect(wide).toHaveLength(2);
    expect(px(wide[0])).toBeGreaterThanOrEqual(109);
    expect(px(wide[1])).toBeGreaterThanOrEqual(177);
    expect(ADMIN).toMatch(/--ad-savebar-gap:\s*22px;/);
  });

  it('reads the bar’s room only under the shown bar, and keeps releases off as it was', () => {
    for (const rule of rules) {
      if (/var\(--ad-savebar(-h)?[,)]/.test(rule.body)) {
        expect(rule.selector, rule.body).toContain(GATE);
      }
    }
    expect(rules.filter((r) => r.selector.includes(GATE))).toHaveLength(5);
    // What a page has with no bar: main's own values.
    expect(declared('.admin-main', 'padding')).toEqual(['var(--ad-pad-b) var(--ad-pad-i) 60px']);
    expect(declared('.bulkbar', 'inset-block-end')).toEqual(['16px']);
    expect(declared('.toasts', 'inset-block-end')).toEqual(['22px']);
  });
});

describe('admin.css keeps the hooks the markup renders', () => {
  // Classes that are behaviour or test hooks with no style of their own.
  // The preview bridge's classes (Admin v2 R9) are drawn inside a PUBLIC page, so they live in
  // public/styles/preview.css, which the preview links instead of admin.css (checked below).
  const PREVIEW_CLASSES = new Set(['pv-notice', 'pv-highlight']);
  const UNSTYLED_HOOKS = new Set(['admin-nav', ...PREVIEW_CLASSES]);

  it('the preview bridge’s classes are styled by the preview’s own sheet', () => {
    const sheet = read('public/styles/preview.css');
    for (const c of PREVIEW_CLASSES) expect(sheet, c).toContain(`.${c} {`);
  });

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
    'src/layouts/AuthLayout.astro',
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
      expect(pagesFor('activity.css')).toEqual(['src/pages/admin/audit.astro']);
      expect(pagesFor('help.css')).toEqual(['src/pages/admin/help.astro']);
      expect(pagesFor('kit.css')).toEqual(['src/pages/admin/kit.astro']);
      // The leads screens (C4b): their three pages, and no other.
      expect(pagesFor('leads.css')).toEqual([
        'src/pages/admin/leads/[id].astro',
        'src/pages/admin/leads/board.astro',
        'src/pages/admin/leads/index.astro',
      ]);
      // The sign-in screens (F7) render login.css's classes in their pages and in the shell
      // they share, src/layouts/AuthLayout.astro, which the walk traces to all four (the
      // invite page joined in U12b).
      expect(pagesFor('login.css')).toEqual([
        // U17: the two step page in the sign-in shell (a session that owes its code).
        'src/pages/admin/2fa.astro',
        'src/pages/admin/forgot.astro',
        'src/pages/admin/invite.astro',
        'src/pages/admin/login.astro',
        'src/pages/admin/reset.astro',
      ]);
      expect(pagesOf('src/layouts/AuthLayout.astro').sort()).toEqual([
        'src/pages/admin/2fa.astro',
        'src/pages/admin/forgot.astro',
        'src/pages/admin/invite.astro',
        'src/pages/admin/login.astro',
        'src/pages/admin/reset.astro',
      ]);
      expect(pagesFor('search.css')).toEqual(['src/pages/admin/search.astro']);
      // The media library (U4): through its island's entry to the two pages hydrating it.
      expect(pagesFor('media.css')).toEqual([
        'src/pages/admin/media/[id].astro',
        'src/pages/admin/media/index.astro',
      ]);
      expect(pagesFor('users.css')).toEqual(['src/pages/admin/users.astro']);
      // The SEO screen (U10): its page renders the sections, its island the table and dialogs.
      expect(pagesFor('seo.css')).toEqual(['src/pages/admin/seo.astro']);
      // The two step page (U17), in either frame: its panel's classes are this sheet's.
      expect(pagesFor('two-step.css')).toEqual(['src/pages/admin/2fa.astro']);
      expect(pagesFor('personal.css')).toEqual([
        'src/pages/admin/account.astro',
        'src/pages/admin/notifications.astro',
      ]);
      // Website stats and site health (U2): rendered by server partials, traced through
      // the import walk to the pages that render them.
      expect(pagesFor('stats.css')).toEqual([
        'src/pages/admin/analytics/index.astro',
        'src/pages/admin/analytics/search.astro',
      ]);
      // The dashboard's health widget (U1) draws site health's summary with its classes.
      expect(pagesFor('health.css')).toEqual([
        'src/pages/admin/index.astro',
        'src/pages/admin/site-health.astro',
      ]);
      // And on an island's code: through its entry to the page hydrating it.
      expect(pagesOf('src/components/admin/screens/logs/ClearLogs.tsx')).toEqual([
        'src/pages/admin/site-health.astro',
      ]);
    });
  });
});
