import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESOURCES } from '@/lib/admin/resources';
import { stagedEntry } from '@/lib/release/staged';
import { STAGED_MARKER } from '@/lib/release/releasesOff';
import { STAGED_KEY } from '@/lib/admin/entitySave';
import {
  readsThroughRelease,
  STAGED_DELETE,
  STAGED_QUERY,
  stagedBody,
  stagedUrl,
} from '@/lib/admin/releaseEvents';

// Admin v2 R12b: every write a screen in release mode sends says so, so once releases are
// switched off under it the live path refuses it (409 `releases-off`, src/lib/release/
// releasesOff.ts; the routes are driven in tests/lib/stagedKernel.spec.ts) instead of writing
// live what the screen would only have staged. R12 marked the editors' saves and the lists'
// deletes; R12b the POSTs (creates, copies, moves) and the U5 + U6 screens' eye and deletes.
//
// A screen's mode is its own: a list's answer read through the release (`draftsInvalid`,
// readsThroughRelease) or an editor's (`draft`, save.mode). Never a row's: a row with nothing
// pending carries no `draft` key, exactly as a row read live (E1's security review).
//
// The screens are React islands whose handlers do not run in a server render, so their wiring
// is read from the source, and the scan below fails on any write to a release-managed route
// that does not carry the marker.

describe('the helpers', () => {
  it('name the server’s marker, and leave a live request exactly as it was', () => {
    expect(STAGED_QUERY).toBe(`?${STAGED_MARKER}=1`);
    expect(STAGED_DELETE).toBe(STAGED_QUERY);
    expect(stagedUrl('/api/admin/faq/reorder', true)).toBe('/api/admin/faq/reorder?staged=1');
    expect(stagedUrl('/api/admin/faq?x=1', true)).toBe('/api/admin/faq?x=1&staged=1');
    expect(stagedUrl('/api/admin/faq/reorder', false)).toBe('/api/admin/faq/reorder');
    const body = { status: 'draft', version: 3 };
    expect(stagedBody(body, false)).toBe(body);
    expect(stagedBody(body, true)).toEqual({ ...body, [STAGED_KEY]: true });
    expect(STAGED_KEY).toBe(STAGED_MARKER);
  });

  it('a list answer is in release mode only when it carries `draftsInvalid`', () => {
    expect(readsThroughRelease({ rows: [], total: 0, draftsInvalid: [] })).toBe(true);
    expect(readsThroughRelease({ rows: [], total: 0, draftsInvalid: ['x'] })).toBe(true);
    // A live answer, whatever its rows say (a row's `draft` key is no guide).
    expect(readsThroughRelease({ rows: [{ id: 'a', draft: null }], total: 1 })).toBe(false);
    for (const odd of [null, undefined, 'draftsInvalid', [], { draftsInvalid: true }]) {
      expect(readsThroughRelease(odd)).toBe(false);
    }
  });
});

// ---- the scan ------------------------------------------------------------------------------

const ROOTS = ['src/components/admin', 'src/lib/admin'];
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path.replaceAll('\\', '/')] : [];
  });
const SOURCES = new Map(ROOTS.flatMap(files).map((path) => [path, readFileSync(path, 'utf8')]));
const source = (path: string) => {
  const text = SOURCES.get(path);
  if (text === undefined) throw new Error(`no such source: ${path}`);
  return text;
};

/** The API slugs whose kernel routes stage with releases on (and so refuse the marker off). */
const RELEASE_SLUGS = Object.entries(RESOURCES)
  .filter(([, config]) => stagedEntry(config) !== undefined)
  .map(([slug]) => slug);

interface Write {
  file: string;
  method: string;
  url: string;
  options: string;
}

/**
 * The arguments of the call whose `(` is at `open`, split at the top-level commas (brackets
 * and template literals balanced; good enough for this codebase's own calls).
 */
function argumentsAt(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      else if (quote === '`' && ch === '$' && text[i + 1] === '{') {
        // A template's `${…}`: its own brackets, closed before the template goes on.
        let inner = 0;
        for (i += 1; i < text.length; i += 1) {
          if (text[i] === '{') inner += 1;
          if (text[i] === '}' && --inner === 0) break;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error('unbalanced call');
}

/** Every `adminFetch(url, { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', … })` in the client. */
function writes(): Write[] {
  const out: Write[] = [];
  for (const [file, text] of SOURCES) {
    for (const match of text.matchAll(/\badminFetch(<)?/g)) {
      let at = match.index! + 'adminFetch'.length;
      if (match[1]) {
        // Skip the type arguments: `<…>`, nested ones included.
        let depth = 0;
        for (; at < text.length; at += 1) {
          if (text[at] === '<') depth += 1;
          if (text[at] === '>' && --depth === 0) break;
        }
        at += 1;
      }
      if (text[at] !== '(') continue; // an import, a type, a mention in a comment
      const [url = '', options = ''] = argumentsAt(text, at);
      const method = /^\{\s*method:\s*'(POST|PATCH|PUT|DELETE)'/.exec(options)?.[1];
      if (method) out.push({ file, url, method, options });
    }
  }
  return out;
}

/** A write to a release-managed kernel route: a literal slug, or a screen's own slug. */
function releaseManaged(url: string): boolean {
  if (/\/api\/admin\/\$\{(def|ui|req)\.slug\}/.test(url)) return true;
  const literal = /\/api\/admin\/([a-z-]+)/.exec(url);
  return literal !== null && RELEASE_SLUGS.includes(literal[1]!);
}

describe('every client write to a release-managed route says when it was made in release mode', () => {
  const found = writes().filter((w) => releaseManaged(w.url));

  it('finds them (the scan is not empty)', () => {
    expect(RELEASE_SLUGS).toEqual(expect.arrayContaining(['services', 'portfolio', 'faq']));
    expect(found.length).toBeGreaterThanOrEqual(12);
  });

  it('a POST or a DELETE carries the marker in its address; a PATCH in its body', () => {
    const unmarked = found
      .filter((w) =>
        w.method === 'PATCH' || w.method === 'PUT'
          ? !w.options.includes('stagedBody(')
          : !/stagedUrl\(|STAGED_DELETE|STAGED_QUERY/.test(w.url),
      )
      .map((w) => `${w.file}: ${w.method} ${w.url.replace(/\s+/g, ' ')}`);
    expect(unmarked).toEqual([]);
  });

  it('every move (reorder) in the client goes through stagedUrl', () => {
    const moves = found.filter((w) => w.url.includes('/reorder'));
    expect(moves.map((w) => w.file).sort()).toEqual(
      [
        'src/components/admin/screens/collection/CollectionScreen.tsx',
        'src/components/admin/screens/collection/CollectionScreen.tsx',
        'src/components/admin/screens/projects/ProjectsList.tsx',
        'src/components/admin/screens/resources/ResourceTable.tsx',
        'src/components/admin/screens/services/DisciplinePage.tsx',
        'src/components/admin/screens/services/ServicesOverview.tsx',
      ].sort(),
    );
    for (const move of moves) expect(move.url, move.file).toMatch(/^stagedUrl\(/);
  });
});

// ---- where each screen's mode comes from ----------------------------------------------------

describe('each screen takes its mode from its own answer, never from a row', () => {
  const LISTS: Record<string, RegExp> = {
    'src/components/admin/screens/resources/ResourceTable.tsx':
      /setStaged\(readsThroughRelease\(data\)\)/,
    'src/components/admin/screens/collection/CollectionScreen.tsx':
      /setStaged\(readsThroughRelease\(data\)\)/,
    'src/components/admin/screens/services/ServicesOverview.tsx':
      /setStaged\(readsThroughRelease\(d\) \|\| readsThroughRelease\(s\)\)/,
    'src/components/admin/screens/services/DisciplinePage.tsx':
      /setStaged\(readsThroughRelease\(d\) \|\| readsThroughRelease\(s\)\)/,
    'src/components/admin/screens/projects/ProjectsList.tsx':
      /setStaged\(readsThroughRelease\(projects\)\)/,
    'src/components/admin/screens/projects/TagsDrawer.tsx': /setStaged\(readsThroughRelease\(s\)\)/,
    'src/components/admin/screens/services/ServiceCasePanel.tsx':
      /setStaged\(readsThroughRelease\(data\)\)/,
  };

  it('the lists: from their answer’s `draftsInvalid`', () => {
    for (const [file, wiring] of Object.entries(LISTS)) expect(source(file), file).toMatch(wiring);
  });

  it('the editors: their copy and their Delete from their own answer (save.mode)', () => {
    expect(source('src/components/admin/screens/services/ServiceEditor.tsx')).toMatch(
      /stagedUrl\('\/api\/admin\/services', save\.mode === 'draft'\)/,
    );
    for (const file of [
      'src/components/admin/screens/services/ServiceEditor.tsx',
      'src/components/admin/screens/projects/ProjectEditor.tsx',
    ]) {
      expect(source(file), file).toMatch(
        /deleteFromEditor\(\{[\s\S]*?staged: save\.mode === 'draft',/,
      );
    }
    expect(source('src/components/admin/screens/services/DisciplineDrawer.tsx')).toMatch(
      /stagedUrl\(`\/api\/admin\/disciplines\/\$\{id\}`, save\.mode === 'draft'\)/,
    );
  });
});

// ---- creates through useEntitySave ----------------------------------------------------------

describe('a create made in a drawer or a modal says so (SaveTarget `staged`)', () => {
  /** Each create site, and how its screen's mode reaches it. */
  const CREATES: Record<string, RegExp[]> = {
    'src/components/admin/screens/collection/CollectionDrawer.tsx': [
      /useEntitySave\(\{ kind: 'resource', slug: def\.slug, staged \}/,
    ],
    'src/components/admin/screens/collection/CollectionScreen.tsx': [/staged=\{staged\}/],
    'src/components/admin/screens/seo/RedirectsTab.tsx': [
      /useEntitySave\(\{ kind: 'resource', slug: ui\.slug, staged \}/,
      /onCreate=\{\(throughRelease\) => \{\s*setStaged\(throughRelease\);/,
    ],
    'src/components/admin/screens/resources/ResourceTable.tsx': [
      /onClick=\{\(\) => onCreate\(staged\)\}/,
    ],
    'src/components/admin/screens/services/DisciplineDrawer.tsx': [
      /useEntitySave\(\{ kind: 'resource', slug: 'disciplines', staged \}/,
    ],
    'src/components/admin/screens/services/ServicesOverview.tsx': [/staged=\{staged\}/],
    'src/components/admin/screens/services/AddServiceModal.tsx': [
      /useEntitySave\(\{ kind: 'resource', slug: 'services', staged \}/,
    ],
    'src/components/admin/screens/services/DisciplinePage.tsx': [/staged=\{staged\}/],
    'src/components/admin/screens/projects/AddProjectModal.tsx': [
      /useEntitySave\(\{ kind: 'resource', slug: 'portfolio', staged \}/,
    ],
    'src/components/admin/screens/projects/ProjectsList.tsx': [/staged=\{staged\}/],
    'src/components/admin/screens/projects/TagsDrawer.tsx': [
      /const target = \{ kind: 'resource', slug: 'sectors', staged \} as const;/,
      /staged=\{staged\}/,
    ],
    'src/components/admin/screens/services/ServiceCasePanel.tsx': [
      /const target = \{ kind: 'resource', slug: 'service-cases', staged \} as const;/,
      /staged=\{staged\}/,
    ],
  };

  /**
   * The resource editors that create without a screen in release mode around them: a create
   * page (/admin/<slug>/new) has had no answer from the server, so it knows no mode and draws
   * main's form (R12: an editor's mode is only ever the server's answer). Media is not
   * release-managed.
   */
  const NO_SCREEN_MODE = new Set([
    'src/components/admin/screens/resources/ResourceForm.tsx',
    'src/components/admin/screens/services/ServiceEditor.tsx',
    'src/components/admin/screens/projects/ProjectEditor.tsx',
    'src/components/admin/screens/media/MediaDrawer.tsx',
  ]);

  it('each create site carries its screen’s mode', () => {
    for (const [file, wiring] of Object.entries(CREATES)) {
      for (const pattern of wiring) expect(source(file), file).toMatch(pattern);
    }
  });

  it('every resource editor is one of them or named with its reason', () => {
    const editors = [...SOURCES]
      .filter(
        ([file, text]) =>
          file.startsWith('src/components/') &&
          text.includes('useEntitySave(') &&
          text.includes("kind: 'resource'"),
      )
      .map(([file]) => file)
      .sort();
    const known = [...Object.keys(CREATES), ...NO_SCREEN_MODE].filter((file) =>
      editors.includes(file),
    );
    expect(editors).toEqual([...new Set(known)].sort());
  });
});
