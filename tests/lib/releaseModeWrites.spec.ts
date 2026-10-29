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

/** What the scan found in one file: its writes, and the calls it could not read. */
interface Scan {
  writes: Write[];
  /** `file: url` of a call that may write but whose method or address is not written out. */
  unclassified: string[];
}

/**
 * Every `adminFetch(url, options)` in `text` (R12b review: hardened). A call is a write when
 * its options name a literal write method ANYWHERE in them (`{ body, method: 'POST' }` too);
 * a read when it has no options, or options with no `method` or `'GET'`. Anything else (the
 * options held in a variable, a method that is not a literal) is unclassified, and so is a
 * write whose address is not a string or template literal (or `stagedUrl` of one): a constant
 * of the file (`const API = '…'`) is read as its value. Unclassified calls must be named,
 * each with its reason, in UNCLASSIFIED below.
 */
function scan(file: string, text: string): Scan {
  const out: Scan = { writes: [], unclassified: [] };
  for (const match of text.matchAll(/\badminFetch(<)?/g)) {
    if (/function\s+$/.test(text.slice(Math.max(0, match.index! - 20), match.index!))) continue;
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
    const [rawUrl = '', options = ''] = argumentsAt(text, at);
    const constant = /^[A-Z][A-Z0-9_]*$/.test(rawUrl)
      ? new RegExp(`\\bconst ${rawUrl} = ('[^']*')`).exec(text)?.[1]
      : undefined;
    const url = constant ?? rawUrl;
    const name = `${file}: ${rawUrl.replace(/\s+/g, ' ')}`;
    if (options === '') continue; // a read
    if (!options.startsWith('{')) {
      out.unclassified.push(name);
      continue;
    }
    const method = /(?:^\{|,)\s*method:\s*([^,}\s]+)/.exec(options)?.[1];
    if (method === undefined || method === "'GET'") continue; // a read
    const literal = /^'(POST|PATCH|PUT|DELETE)'$/.exec(method)?.[1];
    // A literal address (or stagedUrl of one) whose resource is named: a literal slug, or a
    // screen's own slug. `/api/admin/${other}` names no resource the scan can check.
    const addressed =
      /^(['`"]|stagedUrl\(['`])/.test(url) &&
      !/\/api\/admin\/\$\{(?!(def|ui|req)\.slug\})/.test(url);
    if (!literal || !addressed) {
      out.unclassified.push(name);
      continue;
    }
    out.writes.push({ file, url, method: literal, options });
  }
  return out;
}

const SCANS = [...SOURCES].map(([file, text]) => scan(file, text));
const writes = (): Write[] => SCANS.flatMap((found) => found.writes);

/**
 * The calls the scan cannot read, each with why it needs no marker. A new one fails the scan
 * until it is named here, so an unread write cannot land silently.
 */
const UNCLASSIFIED: Record<string, string> = {
  'src/lib/admin/useEntitySave.ts: request.url':
    'every editor save and create: buildSaveRequest (entitySave.ts) marks it, tested in entitySave.spec',
  'src/components/admin/screens/seo/PagesTab.tsx: url':
    'the SEO list’s read (its options are typed { signal })',
  'src/components/admin/screens/logs/ClearLogs.tsx: clearUrl(scope)':
    'system logs: not release-managed',
  'src/components/admin/screens/resources/ResourceTable.tsx: action.endpoint':
    'the redirects’ edge sync (ui.syncAction): rebuilds the KV snapshot, writes no content',
  'src/components/admin/screens/versions/api.ts: path(id)':
    'Backups & versions’ Change time (R13): PATCH /api/admin/releases/[id], R11’s release route, ' +
    'not a kernel resource; it refuses itself while releases are off (409 releases-off, ' +
    'src/lib/release/schedule.ts)',
};

/** A write to a release-managed kernel route: a literal slug, or a screen's own slug. */
function releaseManaged(url: string): boolean {
  if (/\/api\/admin\/\$\{(def|ui|req)\.slug\}/.test(url)) return true;
  const literal = /\/api\/admin\/([a-z-]+)/.exec(url);
  return literal !== null && RELEASE_SLUGS.includes(literal[1]!);
}

describe('the scan reads what it must (R12b review)', () => {
  it('finds a write whose method is not first, and refuses to guess an address', () => {
    const found = scan(
      'x.tsx',
      [
        "adminFetch('/api/admin/faq', { body, method: 'POST' });",
        "adminFetch(`/api/admin/faq/${id}`, {\n  body: { a: 1 },\n  method: 'PATCH',\n});",
        "adminFetch(address, { method: 'DELETE' });",
        'adminFetch(`/api/admin/faq`, { method: verb });',
        'adminFetch(`/api/admin/faq`, options);',
        "const API = '/api/admin/faq';\nadminFetch(API, { method: 'POST', body });",
        "adminFetch('/api/admin/faq', { signal });",
        "adminFetch('/api/admin/faq', { method: 'GET' });",
        'adminFetch(`/api/admin/faq?limit=${n}`);',
        "adminFetch(`/api/admin/${slug}/reorder`, { method: 'POST', body });",
      ].join('\n'),
    );
    expect(found.writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      "POST '/api/admin/faq'",
      'PATCH `/api/admin/faq/${id}`',
      "POST '/api/admin/faq'",
    ]);
    expect(found.unclassified).toEqual([
      'x.tsx: address',
      'x.tsx: `/api/admin/faq`',
      'x.tsx: `/api/admin/faq`',
      'x.tsx: `/api/admin/${slug}/reorder`',
    ]);
    // So the first two would fail the marker check below.
    expect(found.writes.filter((w) => releaseManaged(w.url))).toHaveLength(3);
  });

  it('every call it cannot read is named, with its reason', () => {
    expect(SCANS.flatMap((found) => found.unclassified).sort()).toEqual(
      Object.keys(UNCLASSIFIED).sort(),
    );
  });

  it('the constants it reads as addresses are outside the release', () => {
    const read = writes()
      .filter((w) =>
        [
          'src/components/admin/screens/integrations/IntegrationDrawer.tsx',
          'src/components/admin/screens/visibility/VisibilityScreen.tsx',
        ].includes(w.file),
      )
      .map((w) => w.url);
    expect(read).toEqual(
      expect.arrayContaining(["'/api/admin/integrations'", "'/api/admin/page-visibility'"]),
    );
    expect(read.some(releaseManaged)).toBe(false);
  });
});

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
        'src/components/admin/screens/pageEditor/PageEditor.tsx',
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
    // E1's page editor: its sections list (merge train).
    'src/components/admin/screens/pageEditor/PageEditor.tsx':
      /setRelease\(readsThroughRelease\(answer\)\)/,
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
    // The create pages (/admin/<slug>/new): the page's mode is the server page's
    // createReleaseMode (the shell's flag), passed as `releaseMode` (checked below).
    'src/components/admin/screens/resources/ResourceForm.tsx': [
      /const target = \{ kind: 'resource', slug: ui\.slug, staged: releaseMode \} as const;/,
    ],
    'src/components/admin/screens/services/ServiceEditor.tsx': [
      /const target = \{ kind: 'resource', slug: ui\.slug, staged: releaseMode \} as const;/,
    ],
    'src/components/admin/screens/projects/ProjectEditor.tsx': [
      /const target = \{ kind: 'resource', slug: ui\.slug, staged: releaseMode \} as const;/,
    ],
    // Admin v2 E4: the theme editor creates the tenant's theme on its first save; its page
    // (/admin/appearance/theme) reads the mode as a create page does (checked below).
    'src/components/admin/screens/theme/ThemeScreen.tsx': [
      /const target = \{ kind: 'resource', slug: 'themes', staged: releaseMode \} as const;/,
    ],
  };

  /** The resource editors that never need a mode: media is not release-managed. */
  const NO_SCREEN_MODE = new Set(['src/components/admin/screens/media/MediaDrawer.tsx']);

  /**
   * The resource editors that never create (E1's page editor panels, merge train): each opens
   * a saved row by its own id, so every save is a PATCH whose mode is its own answer's (`draft`,
   * buildSaveRequest marks it, entitySave.spec). E1's Add section is the column's own POST,
   * marked through stagedUrl and checked by the scan above.
   */
  const EDITS_ONLY: Record<string, RegExp> = {
    'src/components/admin/screens/pageEditor/PagePanel.tsx':
      /useEntitySave\(PAGE_TARGET, page\.id,/,
    'src/components/admin/screens/pageEditor/SectionPanel.tsx':
      /useEntitySave\(SECTION_TARGET, section\.id,/,
  };

  it('an editor that never creates opens a saved row by its id', () => {
    for (const [file, wiring] of Object.entries(EDITS_ONLY)) {
      expect(source(file), file).toMatch(wiring);
      expect(source(file), file).not.toMatch(/useEntitySave\([^)]*\bnull\b/);
    }
  });

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
    const known = [...Object.keys(CREATES), ...NO_SCREEN_MODE, ...Object.keys(EDITS_ONLY)].filter(
      (file) => editors.includes(file),
    );
    expect(editors).toEqual([...new Set(known)].sort());
  });

  it('every create page passes its mode, read for its own resource (R12b review)', () => {
    const ISLANDS: Record<string, (page: string) => string | undefined> = {
      AdminResourceForm: (page) => /resource="([a-z-]+)"/.exec(page)?.[1],
      AdminServiceEditor: () => 'services',
      AdminProjectEditor: () => 'portfolio',
    };
    const pages = readdirSync('src/pages/admin', { withFileTypes: true })
      .filter((dir) => dir.isDirectory())
      .map((dir) => `src/pages/admin/${dir.name}/new.astro`)
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    let checked = 0;
    for (const path of pages) {
      const page = readFileSync(path, 'utf8');
      const island = Object.keys(ISLANDS).find((name) => page.includes(`<${name}`));
      if (!island) continue;
      checked += 1;
      const slug = ISLANDS[island]!(page);
      expect(slug, path).toBeDefined();
      expect(page, path).toContain(
        `const releaseMode = await createReleaseMode(Astro.locals, '${slug}');`,
      );
      expect(page, path).toMatch(
        new RegExp(`<${island}\\s[^>]*\\breleaseMode=\\{releaseMode\\}[^>]*\\bid=\\{null\\}`),
      );
    }
    // Every create page that hydrates a resource editor (the collection screens' /new pages
    // open their drawer, whose mode is the screen's list answer). /admin/themes/new answers
    // with a 302 since E4; the theme editor's page is checked below.
    expect(checked).toBeGreaterThanOrEqual(13);
  });

  it('the theme editor’s page passes its mode, read for the themes resource (E4)', () => {
    const page = readFileSync('src/pages/admin/appearance/theme.astro', 'utf8');
    expect(page).toContain("await createReleaseMode(Astro.locals, 'themes')");
    expect(page).toMatch(/<AdminTheme\s[^>]*id=\{id\}[^>]*releaseMode=\{releaseMode\}/);
  });
});

// ---- a refused list write is said, and stays said -------------------------------------------

describe('a refused list write is said after the list is read again (R12b review)', () => {
  /** The body of `async function name(…) {…}` in `text`, its braces balanced. */
  function handler(text: string, name: string): string {
    const at = text.indexOf(`async function ${name}(`);
    if (at < 0) throw new Error(`no handler ${name}`);
    const open = text.indexOf(') {', at) + 2;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
    }
    throw new Error(`unbalanced handler ${name}`);
  }

  // Each list's load() clears its message once it has read, so a handler that re-reads after
  // a write says why the write failed only after that read (said before it, the message lasted
  // one round trip: the eye's releases-off words never showed on a discipline's page, and a
  // refused move or copy on a collection screen was silent).
  const HANDLERS: Record<string, string[]> = {
    'src/components/admin/screens/services/DisciplinePage.tsx': ['commitOrder', 'toggle'],
    'src/components/admin/screens/services/ServicesOverview.tsx': ['commitOrder', 'toggle'],
    'src/components/admin/screens/collection/CollectionScreen.tsx': ['commitOrder', 'duplicate'],
    'src/components/admin/screens/projects/ProjectsList.tsx': ['move'],
    'src/components/admin/screens/resources/ResourceTable.tsx': ['move', 'remove'],
  };

  it('no message is set before the read that would clear it', () => {
    for (const [file, names] of Object.entries(HANDLERS)) {
      for (const name of names) {
        const body = handler(source(file), name);
        const read = body.lastIndexOf('await load()');
        expect(read, `${file} ${name}`).toBeGreaterThan(-1);
        const early = [...body.matchAll(/setError\((?!'')/g)]
          .filter((match) => match.index! < read)
          .map((match) => body.slice(match.index!, match.index! + 40));
        expect(early, `${file} ${name}`).toEqual([]);
      }
    }
  });

  it('the eye’s refusal: publishing switched off says so, never “someone else”', async () => {
    const { eyeRefusal } = await import('@/components/admin/screens/services/model');
    const { AdminApiError, describeError } = await import('@/lib/admin/client');
    const off = new AdminApiError({ status: 409, error: 'releases-off' });
    expect(eyeRefusal('service', off.info, describeError(off))).toBe(
      'It was not changed. Publishing was switched off. Reload to edit the live site.',
    );
    const conflict = new AdminApiError({ status: 409, error: 'conflict' });
    expect(eyeRefusal('discipline', conflict.info, describeError(conflict))).toBe(
      'Someone else changed this discipline. The list has been reloaded: try again.',
    );
    const forbidden = new AdminApiError({ status: 403, error: 'forbidden' });
    expect(eyeRefusal('service', forbidden.info, describeError(forbidden))).toBe(
      'It was not changed. Your role does not allow that.',
    );
    expect(eyeRefusal('service', null, describeError(new Error('Network down')))).toBe(
      'It was not changed. Network down',
    );
    // Both Services screens say it through this one helper.
    for (const file of [
      'src/components/admin/screens/services/DisciplinePage.tsx',
      'src/components/admin/screens/services/ServicesOverview.tsx',
    ]) {
      expect(source(file), file).toMatch(/failure = eyeRefusal\(/);
      expect(source(file), file).not.toContain('Someone else changed this');
    }
  });
});
