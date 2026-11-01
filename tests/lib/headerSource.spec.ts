import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { HEADER_COLUMNS, HEADER_DEFAULTS, headerColumnDefaults } from '@schemas/appearance';
import { SITE_APPEARANCE_HEADER_COLUMNS } from '@/lib/data/appearance';
import { siteAppearanceSingleton } from '@/lib/admin/singletons/siteAppearance';
import { appearanceUi } from '@/lib/admin/ui/appearance';
import { ANON_COLUMNS } from '@/lib/preview/visibility';
import { CREATE_DEFAULTS } from '@/lib/preview/dataset';

// The header's options (Admin v2 E5) from its pre-PR code review: one source for the columns
// and the defaults (CR7), the sketches over the schema's buckets (CR8), the language switch
// written once (CR9), and a bar that scrolls away with the page adding no scroll work (CR6).

const read = (path: string) => readFileSync(path, 'utf8');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path.replaceAll('\\', '/')] : [];
  });

describe('one source for the header’s columns and defaults (CR7)', () => {
  it('the column names are written in the schema, and once more where a scan must read them', () => {
    // src/lib/data/appearance.ts keeps its select a literal: the loader scan
    // (tests/lib/loaderQueries.ts) reads selects from the source, for the preview's parser.
    const ALLOWED = new Set(['packages/schemas/appearance.ts', 'src/lib/data/appearance.ts']);
    const writers = [...files('src'), ...files('packages')].filter(
      (file) => !ALLOWED.has(file) && /\bheader_(logo|menu|sticky|tint|blur|cta)/.test(read(file)),
    );
    expect(writers).toEqual([]);
  });

  it('the literal select is the schema’s columns', () => {
    expect(SITE_APPEARANCE_HEADER_COLUMNS).toBe(Object.values(HEADER_COLUMNS).join(','));
  });

  it('every copy follows HEADER_COLUMNS and HEADER_DEFAULTS', () => {
    const byColumn = headerColumnDefaults();
    expect(Object.keys(byColumn)).toEqual(Object.values(HEADER_COLUMNS));
    expect(byColumn['header_logo_size']).toBe(HEADER_DEFAULTS.logoSize);
    expect(siteAppearanceSingleton.defaults).toEqual(byColumn);
    expect(ANON_COLUMNS['site_appearance']).toEqual([
      'tenant_id',
      ...Object.values(HEADER_COLUMNS),
    ]);
    // The preview's create defaults are the table's: the NOT NULL columns (the button's words
    // and link have none).
    expect(CREATE_DEFAULTS['site_appearance']).toEqual(
      Object.fromEntries(Object.entries(byColumn).filter(([, value]) => value !== null)),
    );
    for (const field of appearanceUi.fields) {
      expect(field.column, field.name).toBe(
        HEADER_COLUMNS[field.name as keyof typeof HEADER_COLUMNS],
      );
    }
  });
});

describe('the sketches read the schema’s buckets and defaults (CR8)', () => {
  it('no option list, default or bucket check of their own', () => {
    const sketch = read('src/components/admin/screens/header/sketch.ts');
    expect(sketch).toContain("from '@schemas/appearance'");
    expect(sketch).not.toMatch(/\bconst pick\b/);
    expect(sketch).not.toMatch(/\[\s*'(none|s|start)',/);
    expect(sketch).not.toMatch(/'soft'|'center'/);
  });
});

describe('SiteHeader.astro', () => {
  const source = read('src/components/SiteHeader.astro');

  it('writes the language switch once, with or without the button (CR9)', () => {
    expect(source.match(/class="site-header__lang"/g)).toHaveLength(1);
  });

  /** The header's script, transpiled and run against a stand-in page. */
  function runScript(dataset: Record<string, string>) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)?.[1];
    if (!script) throw new Error('no script');
    const js = ts.transpileModule(script, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const listeners: string[] = [];
    const frames: string[] = [];
    const header = {
      dataset,
      classList: { toggle() {}, add() {}, remove() {} },
      querySelector: () => null,
    };
    const document = {
      querySelector: (selector: string) => (selector === '.site-header' ? header : null),
    };
    const run = new Function(
      'document',
      'addEventListener',
      'requestAnimationFrame',
      'window',
      js.replace(/^export \{\};?$/m, ''),
    );
    run(
      document,
      (type: string) => listeners.push(type),
      () => frames.push('frame'),
      { scrollY: 0, innerHeight: 800 },
    );
    return { listeners, frames };
  }

  it('a sticky bar listens to scroll and resize, from the first frame', () => {
    expect(runScript({ header: 'overlay' })).toEqual({
      listeners: ['resize', 'scroll'],
      frames: ['frame'],
    });
  });

  it('a bar that scrolls away with the page adds no listener and no frame (CR6)', () => {
    expect(runScript({ header: 'overlay', sticky: 'off' })).toEqual({ listeners: [], frames: [] });
    expect(runScript({ header: 'solid', sticky: 'off' })).toEqual({ listeners: [], frames: [] });
  });
});
