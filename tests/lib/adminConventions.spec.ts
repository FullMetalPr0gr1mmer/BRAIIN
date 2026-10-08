import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static rules for admin code (Admin v2 F0). They hold for every admin slice that follows,
// and each one guards something no browser test sees reliably:
//
//   no <script> in an admin PAGE   Admin behaviour lives in islands and src/lib/admin, where
//                                  it is bundled into the admin-* chunks and weighed by the
//                                  admin budget. A page script is a separate chunk on its
//                                  own path (login.astro's pulls the whole admin-ui chunk
//                                  onto the sign-in screen). Grandfathered: login.astro,
//                                  until sign-in v2 (F7) moves its script into an enhancer.
//   no style= in admin markup      style-src has no 'unsafe-inline': a style attribute in
//                                  server HTML is dead, and React's style={{…}} emits one
//                                  during the server render. Dynamic values use data-*
//                                  buckets, SVG attributes or the CSSOM after hydration.
//   islands land in the admin      size-limit splits public from admin by FILE NAME, so a
//   bundle                         hydrated admin island must be an Admin* entry (in
//                                  src/components/admin/islands, F3), or its chunk would be
//                                  weighed against the public 100 KB budget. The pre-F1
//                                  islands took that shape in W0; none is listed by name.

const ROOT = process.cwd();

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, exts));
    else if (exts.some((ext) => name.endsWith(ext))) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(ROOT, path).split(sep).join('/');
const read = (path: string) => readFileSync(path, 'utf8');

/** Blanks comments (keeping line breaks, so line numbers hold): rules apply to code. */
function code(path: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return read(path)
    .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, blank)
    .replace(
      /(^|[^:])(\/\/[^\n]*)/gm,
      (_m, before: string, comment: string) => before + blank(comment),
    );
}

const ADMIN_PAGES = walk(join(ROOT, 'src/pages/admin'), ['.astro']);
const ADMIN_MARKUP = [
  ...ADMIN_PAGES,
  ...walk(join(ROOT, 'src/components/admin'), ['.tsx', '.ts', '.astro']),
  join(ROOT, 'src/layouts/AdminLayout.astro'),
];

/** Pages allowed a <script> until the named slice removes it. Only ever shrinks. */
const SCRIPT_GRANDFATHERED: Record<string, string> = {
  'src/pages/admin/login.astro': 'F7 (sign-in v2)',
};

describe('admin pages carry no <script>', () => {
  it('outside the grandfathered pages', () => {
    const offenders = ADMIN_PAGES.map(rel).filter(
      (file) => /<script\b/i.test(code(join(ROOT, file))) && !(file in SCRIPT_GRANDFATHERED),
    );
    expect(offenders).toEqual([]);
  });

  it('and a grandfathered page that no longer needs its entry loses it', () => {
    for (const file of Object.keys(SCRIPT_GRANDFATHERED)) {
      expect(/<script\b/i.test(code(join(ROOT, file))), `${file}: drop its entry`).toBe(true);
    }
  });
});

describe('admin markup carries no style attribute', () => {
  it('no style= or style={…} in admin pages, components or the layout', () => {
    const offenders = ADMIN_MARKUP.flatMap((path) =>
      code(path)
        .split('\n')
        .map((line, i) => ({ line, at: `${rel(path)}:${i + 1}` }))
        .filter(({ line }) => /(^|[\s<])style\s*=\s*["'{]/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});

describe('admin code adds no <style> at runtime', () => {
  // A <style> element created after load is refused by style-src exactly like a style=
  // attribute in markup. The F0 sweep found Tiptap doing it on every editor screen.
  const editors = walk(join(ROOT, 'src'), ['.ts', '.tsx']).filter((path) =>
    /\buseEditor\(|\bnew Editor\(/.test(read(path)),
  );

  it('every Tiptap editor turns its CSS injection off', () => {
    expect(editors.length).toBeGreaterThan(0);
    for (const path of editors) expect(read(path), rel(path)).toMatch(/injectCSS:\s*false/);
  });

  it('and admin.css carries the ProseMirror rules Tiptap would have injected', () => {
    const css = read(join(ROOT, 'public/styles/admin.css'));
    expect(css).toMatch(/\.ProseMirror\s*\{[^}]*white-space:\s*pre-wrap/);
    expect(css).toContain('.ProseMirror-gapcursor');
  });

  it('no admin module creates a style element', () => {
    const modules = [
      ...walk(join(ROOT, 'src/components/admin'), ['.ts', '.tsx']),
      ...walk(join(ROOT, 'src/lib/admin'), ['.ts', '.tsx']),
    ];
    const offenders = modules
      .filter((path) =>
        /createElement\(\s*['"]style['"]|<style[\s>]|adoptedStyleSheets/.test(code(path)),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('hydrated admin islands are weighed by the admin budget', () => {
  // `<Name … client:load`, across line breaks: the tag of every hydrated component, with
  // the module its page imports it from.
  const hydrated = [...ADMIN_PAGES, join(ROOT, 'src/layouts/AdminLayout.astro')].flatMap((path) => {
    const src = read(path);
    return [
      ...src.matchAll(/<([A-Z][\w.]*)\b[^<>]*?\sclient:(?:load|idle|visible|media|only)\b/gs),
    ].map((m) => {
      const name = m[1] as string;
      const from = new RegExp(String.raw`import\s+${name}\s+from\s+'([^']+)'`).exec(src)?.[1];
      return { name, from, at: rel(path) };
    });
  });
  /** Where island entries live (F3), as a path and as the specifier a page imports. */
  const ISLANDS_DIR = 'src/components/admin/islands';
  const ISLANDS_IMPORT = '@/components/admin/islands';
  const sizeLimit = JSON.parse(read(join(ROOT, '.size-limit.json'))) as {
    name: string;
    path: string[];
  }[];
  const publicEntry = sizeLimit.find((e) => e.name.startsWith('public'));
  const adminEntry = sizeLimit.find((e) => e.name.startsWith('admin'));

  it('finds the islands it checks', () => {
    expect(hydrated.length).toBeGreaterThan(0);
  });

  it('every island is an Admin* entry in src/components/admin/islands', () => {
    const offenders = hydrated
      .filter(({ name, from }) => !name.startsWith('Admin') || from !== `${ISLANDS_IMPORT}/${name}`)
      .map(({ name, from, at }) => `${at}: ${name} from ${from ?? '(no import)'}`);
    expect(offenders).toEqual([]);
  });

  it('every entry in islands/ is hydrated by a page or the layout', () => {
    const entries = readdirSync(join(ROOT, ISLANDS_DIR)).map((f) => f.replace(/\.tsx$/, ''));
    const names = new Set(hydrated.map(({ name }) => name));
    expect(entries.filter((entry) => !names.has(entry))).toEqual([]);
  });

  it('Admin*.js is in the admin bundle and out of the public one', () => {
    expect(adminEntry?.path).toContain('dist/client/_astro/Admin*.js');
    expect(publicEntry?.path).toContain('!dist/client/_astro/Admin*.js');
  });

  it('the budgets name no island one by one: the Admin* glob covers them all', () => {
    expect(adminEntry?.path).toEqual([
      'dist/client/_astro/admin-*.js',
      'dist/client/_astro/Admin*.js',
      'dist/client/_astro/login.astro_*.js',
    ]);
    expect(publicEntry?.path).toEqual([
      'dist/client/_astro/*.js',
      '!dist/client/_astro/admin-*.js',
      '!dist/client/_astro/Admin*.js',
      '!dist/client/_astro/login.astro_*.js',
    ]);
  });
});
