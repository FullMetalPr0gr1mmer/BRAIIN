import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CASE_MODULES, CASES } from './cases';
import { CASE_MANIFEST } from './caseManifest';

// The authorization matrix (endpoints.spec.ts) proves only the rows it has. Before this
// check, an admin route added without a case passed silently: nothing compared the matrix
// with the routes that exist. Here every handler exported under src/pages/api/admin must
// be driven by at least one case, matched by the module its `load()` imports, or be named
// below with the reason the matrix cannot drive it.

/** Every module under src/pages/api/admin, keyed by its path from the repo root. */
const ROUTE_MODULES = import.meta.glob<Record<string, unknown>>(
  '/src/pages/api/admin/**/*.{ts,js}',
);

/** Astro's endpoint handler exports. `ALL` and the rest count too: each serves requests. */
const HANDLERS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL'];

/**
 * Exported handlers the matrix cannot drive, each with the reason. Every other handler
 * needs a case in tests/authz/cases, however much body it takes to build one.
 */
const NOT_DRIVABLE: Readonly<Record<string, string>> = {
  'POST /api/admin/auth/login':
    'Sign-in is reached without a session (the middleware exempts this one path) and checks ' +
    'no capability, so the matrix row "anon → 403" cannot hold. tests/authz/login.spec.ts ' +
    'drives its guards instead: the middleware refusing a cross-site or tokenless POST, the ' +
    'one generic 401 for every failure, and the 423 lockout (fail-closed included) over a ' +
    'stubbed lockout store. The counting itself is SQL (0009) with no pgTAP test yet.',
  'POST /api/admin/auth/logout':
    'Sign-out needs a session, not a capability: every role may sign out, and the session ' +
    'gate is src/middleware.ts (401 before the handler, which this suite invokes directly; ' +
    'tests/authz/login.spec.ts drives that 401). There is no role to deny.',
};

/** '/src/pages/api/admin/leads/[id]/notes.ts' → '/api/admin/leads/[id]/notes'. */
const routePath = (file: string) =>
  file
    .replace(/^\/src\/pages/, '')
    .replace(/\.(ts|js)$/, '')
    .replace(/\/index$/, '');

/** Astro routes no file or directory whose name starts with `_`. */
const ROUTE_FILES = Object.keys(ROUTE_MODULES).filter(
  (file) =>
    !routePath(file)
      .split('/')
      .some((segment) => segment.startsWith('_')),
);

/** A segment's rank when two routes match one URL: static, then `[param]`, then `[...rest]`. */
const rankOf = (segment: string) =>
  segment.startsWith('[...') ? 2 : segment.startsWith('[') ? 1 : 0;

function matches(pattern: readonly string[], parts: readonly string[]): boolean {
  for (const [i, segment] of pattern.entries()) {
    if (segment.startsWith('[...')) return parts.length > i;
    if (parts[i] === undefined) return false;
    if (!segment.startsWith('[') && segment !== parts[i]) return false;
  }
  return pattern.length === parts.length;
}

/** The route file that serves `pathname`, by Astro's precedence: static segments win. */
function routeFor(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean);
  const candidates = ROUTE_FILES.map((file) => {
    const pattern = routePath(file).split('/').filter(Boolean);
    return { file, pattern, rank: pattern.map(rankOf).join('') };
  }).filter(({ pattern }) => matches(pattern, parts));
  candidates.sort((a, b) => a.rank.localeCompare(b.rank));
  return candidates[0]?.file;
}

/** Route module → its file, and every exported handler as "METHOD /api/admin/…". */
const fileOf = new Map<unknown, string>();
const exportedHandlers: string[] = [];

beforeAll(async () => {
  for (const file of ROUTE_FILES) {
    const module = await ROUTE_MODULES[file]!();
    fileOf.set(module, file);
    for (const name of Object.keys(module).filter((key) => HANDLERS.includes(key))) {
      exportedHandlers.push(`${name} ${routePath(file)}`);
    }
  }
}, 120_000);

/** "METHOD /api/admin/…" for every case, through the module its `load()` imports. */
async function caseHandlers(): Promise<Set<string>> {
  const driven = new Set<string>();
  for (const testCase of CASES) {
    const file = fileOf.get(await testCase.load());
    if (file) driven.add(`${testCase.method} ${routePath(file)}`);
  }
  return driven;
}

describe('the endpoint cases cover every admin route', () => {
  it('sees every file under src/pages/api/admin', () => {
    // So a route in an extension the glob above does not match cannot escape this check.
    const onDisk = readdirSync('src/pages/api/admin', { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        `/${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`.replace(/^\/\.\//, '/'),
      );
    expect(onDisk.length).toBeGreaterThan(0);
    expect(new Set(Object.keys(ROUTE_MODULES))).toEqual(new Set(onDisk));
    // And the routes known to exist are among them, so a broken glob cannot pass empty.
    for (const known of [
      '/src/pages/api/admin/services/index.ts',
      '/src/pages/api/admin/leads/[id]/notes.ts',
    ]) {
      expect(ROUTE_FILES).toContain(known);
    }
  });

  it('every exported handler has a case, or a stated reason it cannot have one', async () => {
    const driven = await caseHandlers();
    const missing = exportedHandlers.filter(
      (handler) => !driven.has(handler) && !(handler in NOT_DRIVABLE),
    );
    expect(
      missing,
      'add a case to tests/authz/cases/<feature>.ts for each (and its line to caseManifest.ts)',
    ).toEqual([]);
  });

  it('names only real handlers that no case drives, in its list of exceptions', async () => {
    const driven = await caseHandlers();
    for (const handler of Object.keys(NOT_DRIVABLE)) {
      expect(exportedHandlers, `${handler} is not an exported handler`).toContain(handler);
      expect(driven.has(handler), `${handler} has a case now: drop it from NOT_DRIVABLE`).toBe(
        false,
      );
    }
  });

  it('every case loads a route under src/pages/api/admin, and its URL is served by that route', async () => {
    for (const testCase of CASES) {
      const file = fileOf.get(await testCase.load());
      expect(
        file,
        `${testCase.name}: load() imports no route under src/pages/api/admin`,
      ).toBeDefined();
      const { pathname } = new URL(testCase.url, 'https://admin.example.test');
      expect(routeFor(pathname), `${testCase.name}: ${testCase.url} is not served by ${file}`).toBe(
        file,
      );
    }
  });
});

describe('the case registry', () => {
  it('collects every file under tests/authz/cases, subfolders included', () => {
    // The glob in cases/index.ts is the only way a module runs, so a file it did not match
    // (a nested folder it did not reach, a .js module) would sit there unrun.
    const dir = 'tests/authz/cases';
    const onDisk = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
      .filter((file) => file !== 'index.ts')
      .map((file) => file.replace(/\.ts$/, ''));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(new Set(Object.keys(CASE_MODULES))).toEqual(new Set(onDisk));
  });

  it('keeps each case name unique', () => {
    const names = CASES.map((testCase) => testCase.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it('keeps the manifest sorted', () => {
    expect(CASE_MANIFEST).toEqual([...CASE_MANIFEST].sort());
  });

  it('holds every module and case to the manifest', () => {
    // A module dropped in a merge, or a row lost inside one, fails here by name.
    const collected = Object.entries(CASE_MODULES).flatMap(([feature, cases]) =>
      cases.map((testCase) => `${feature}: ${testCase.name}`),
    );
    expect(collected.sort(), 'tests/authz/caseManifest.ts').toEqual(CASE_MANIFEST);
  });
});
