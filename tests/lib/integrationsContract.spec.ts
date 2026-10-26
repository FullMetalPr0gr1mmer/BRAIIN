import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { APIRoute } from 'astro';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The integrations contract (Admin v2 U11c): site_integrations' four legacy jsonb boxes
// (ga4, search_console, calendly, recaptcha) are dropped by a migration that production
// applies BEFORE its PR merges (migrations.md rule 6), so between that push and the deploy
// the Worker running is main's. This spec proves that Worker never names a dropped column:
// every reader of the table is listed, driven or read here, and each one's columns are held
// inside the columns the migrations leave and inside the grants of the role that reads them.
// The PR changes no code under src/ but comments, so what holds here holds for the deployed
// Worker. A new reader of the table joins READERS below once its columns are checked.

const DIR = join(process.cwd(), 'supabase', 'migrations');
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8').replace(/--[^\n]*/g, '') }));
const CONTRACT = MIGRATIONS.find((m) => /^\d{4}_integrations_contract\.sql$/.test(m.name));

const LEGACY = ['ga4', 'search_console', 'calendly', 'recaptcha'] as const;
const KEPT = [
  'calendly_url',
  'ga4_measurement_id',
  'search_console_token',
  'tenant_id',
  'updated_at',
  'updated_by',
  'version',
];

/** The text between the parenthesis at `open` and its partner. */
function balanced(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    if (sql[i] === ')' && --depth === 0) return sql.slice(open + 1, i);
  }
  throw new Error('unbalanced parentheses');
}

/** The table's columns after the given migrations: create table, add, drop and rename. */
function columnsAfter(files: readonly { sql: string }[]): Set<string> {
  const cols = new Set<string>();
  for (const { sql } of files) {
    const create = /create table (?:if not exists )?public\.site_integrations\s*\(/i.exec(sql);
    if (create) {
      let depth = 0;
      let item = '';
      const items: string[] = [];
      for (const ch of balanced(sql, create.index + create[0].length - 1)) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          items.push(item);
          item = '';
        } else item += ch;
      }
      items.push(item);
      for (const it of items) {
        const name = /^\s*([a-z_][a-z0-9_]*)/i.exec(it)?.[1]?.toLowerCase();
        if (name && !/^(constraint|primary|unique|check|foreign|exclude|like)$/.test(name)) {
          cols.add(name);
        }
      }
    }
    for (const alter of sql.matchAll(
      /alter table (?:only )?(?:if exists )?public\.site_integrations\b([^;]*);/gi,
    )) {
      const body = alter[1]!;
      for (const m of body.matchAll(/\badd column (?:if not exists )?([a-z_0-9]+)/gi)) {
        cols.add(m[1]!.toLowerCase());
      }
      for (const m of body.matchAll(/\bdrop column (?:if exists )?([a-z_0-9]+)/gi)) {
        cols.delete(m[1]!.toLowerCase());
      }
      for (const m of body.matchAll(/\brename column ([a-z_0-9]+) to ([a-z_0-9]+)/gi)) {
        cols.delete(m[1]!.toLowerCase());
        cols.add(m[2]!.toLowerCase());
      }
    }
  }
  return cols;
}

type Priv = 'select' | 'insert' | 'update';
type Grants = Record<'anon' | 'authenticated', Record<Priv, Set<string>>>;

/**
 * Who may name which column, replayed through every migration in order, as PostgreSQL keeps
 * it: a grant or revoke naming the table (alone or in a list of tables) adds or removes its
 * columns for each role it names (a table-level one: every column the table has then), and a
 * dropped column takes its privileges with it.
 */
function grantsAfter(files: readonly { sql: string }[]): Grants {
  const empty = () => ({
    select: new Set<string>(),
    insert: new Set<string>(),
    update: new Set<string>(),
  });
  const out: Grants = { anon: empty(), authenticated: empty() };
  const statement =
    /\b(grant|revoke)\s+([a-z,\s]+?)\s*(?:\(([^)]*)\))?\s+on\s+(?:table\s+)?((?:public\.[a-z_0-9]+\s*,\s*)*public\.[a-z_0-9]+)\s+(?:to|from)\s+([a-z_,\s]+?)\s*;/gi;
  files.forEach(({ sql }, i) => {
    const has = columnsAfter(files.slice(0, i + 1));
    for (const m of sql.matchAll(statement)) {
      const [, verb, privs, list, tables, roles] = m;
      const named = tables!.split(',').map((t) => t.trim().toLowerCase());
      if (!named.includes('public.site_integrations')) continue;
      const columns = list ? list.split(',').map((c) => c.trim().toLowerCase()) : [...has];
      const which = /\ball\b/i.test(privs!)
        ? ['select', 'insert', 'update']
        : privs!.split(',').map((x) => x.trim().toLowerCase());
      for (const role of roles!.split(',').map((r) => r.trim().toLowerCase())) {
        if (role !== 'anon' && role !== 'authenticated') continue;
        for (const p of which) {
          if (!(p in out[role])) continue;
          for (const c of columns) {
            if (verb!.toLowerCase() === 'grant') out[role][p as Priv].add(c);
            else out[role][p as Priv].delete(c);
          }
        }
      }
    }
    for (const role of Object.values(out)) {
      for (const set of Object.values(role))
        for (const c of [...set]) if (!has.has(c)) set.delete(c);
    }
  });
  return out;
}

const KEPT_NOW = columnsAfter(MIGRATIONS);
const GRANTS = grantsAfter(MIGRATIONS);

// ── The recording client: every read and write a reader makes, by table ──────────────────────
interface Call {
  who: 'staff' | 'anon';
  table: string;
  op: 'select' | 'insert' | 'update';
  columns: string[];
}
const calls: Call[] = [];
let existingRow: Record<string, unknown> | null = null;

function recording(who: Call['who']) {
  return {
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['eq', 'neq', 'in', 'is', 'order', 'limit', 'range', 'match', 'filter']) {
        q[m] = () => q;
      }
      const record = (op: Call['op'], columns: string[]) => {
        calls.push({ who, table, op, columns });
        return q;
      };
      q['select'] = (cols?: string) =>
        record(
          'select',
          (cols ?? '*').split(',').map((c) => c.trim()),
        );
      q['insert'] = (row: Record<string, unknown>) => record('insert', Object.keys(row));
      q['upsert'] = (row: Record<string, unknown>) => record('insert', Object.keys(row));
      q['update'] = (row: Record<string, unknown>) => record('update', Object.keys(row));
      q['maybeSingle'] = async () => ({
        data: table === 'site_integrations' ? existingRow : null,
        error: null,
      });
      q['single'] = async () => ({ data: { ...(existingRow ?? {}), version: 1 }, error: null });
      q['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, ko);
      return q;
    },
  };
}

vi.mock('@/lib/supabase/client', async (original) => ({
  ...(await original<typeof import('@/lib/supabase/client')>()),
  supabaseConfigured: () => true,
  anonClient: () => recording('anon'),
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));

// The readers, imported once the mocks are in place (a cold import of the route's graph takes
// longer than a test's timeout).
const route = (await import('@/pages/api/admin/integrations')) as {
  GET: APIRoute;
  PATCH: APIRoute;
};
const { loadIntegrations } = await import('@/lib/admin/integrations/load');
const { getSearchConsoleToken } = await import('@/lib/data/siteVerification');
const { getGa4MeasurementId } = await import('@/lib/data/ga4');
const { ANON_COLUMNS } = await import('@/lib/preview/visibility');
const { DATASET_ONLY_COLUMNS } = await import('@/lib/preview/dataset');
const { TABLE_KEYS } = await import('@/lib/preview/relations');
const { integrationsUi } = await import('@/lib/admin/ui/integrations');
const { BACKUP_TABLES } = await import('@/lib/admin/backupTables');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

function context(method: 'GET' | 'PATCH', body?: unknown) {
  const url = new URL('/api/admin/integrations', 'https://admin.example.test');
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'seo', isActive: true, email: 's@x.test' },
      supabase: recording('staff'),
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as Parameters<APIRoute>[0];
}

const FULL_SAVE = {
  ga4MeasurementId: 'G-ABC123XYZ',
  searchConsoleToken: 'abcDEF012_-xyz',
  calendlyUrl: 'https://calendly.com/studio',
};

/** The columns this reader named on site_integrations, per operation, held to the grants. */
function expectWithinGrants(made: Call[]) {
  const own = made.filter((c) => c.table === 'site_integrations');
  expect(own.length, 'the reader touched the table (the check is not of nothing)').toBeGreaterThan(
    0,
  );
  for (const call of own) {
    for (const column of call.columns) {
      const where = `${call.who} ${call.op} ${column}`;
      expect(LEGACY as readonly string[], where).not.toContain(column);
      expect(KEPT_NOW.has(column), `${where}: a column the table keeps`).toBe(true);
      const role = call.who === 'staff' ? 'authenticated' : 'anon';
      expect(GRANTS[role][call.op].has(column), `${where}: granted to ${role}`).toBe(true);
    }
  }
}

beforeEach(() => {
  calls.length = 0;
  existingRow = null;
});

describe('the table the contract leaves', () => {
  it('the migrations before the contract still hold the four boxes (the replay sees them)', () => {
    expect(CONTRACT, 'the contract migration exists').toBeDefined();
    const earlier = MIGRATIONS.filter((m) => m.name < CONTRACT!.name);
    const before = columnsAfter(earlier);
    const staff = grantsAfter(earlier).authenticated;
    for (const legacy of LEGACY) {
      expect(before.has(legacy), legacy).toBe(true);
      // ...and staff could read and write them, as the residual said (the replay is not blind).
      expect(staff.select.has(legacy) && staff.update.has(legacy), `staff on ${legacy}`).toBe(true);
    }
  });

  it('after every migration the table holds the typed values, the key, the version and the stamps', () => {
    expect([...KEPT_NOW].sort()).toEqual(KEPT);
  });

  it('the contract locks the table, counts the boxes and refuses before it drops anything', () => {
    const sql = CONTRACT!.sql;
    // The lock first: no write can land between the count and the drop.
    const lock = sql.search(/lock table public\.site_integrations in access exclusive mode;/);
    const count = sql.search(/where ga4 <> '\{\}'::jsonb or search_console <> '\{\}'::jsonb/);
    const refuse = sql.search(/raise exception 'U11c: % site_integrations row\(s\) hold legacy/);
    const drop = sql.search(/alter table public\.site_integrations\s+drop column/);
    expect(lock).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(lock);
    expect(refuse).toBeGreaterThan(count);
    expect(drop).toBeGreaterThan(refuse);
    for (const legacy of LEGACY) expect(sql).toMatch(new RegExp(`drop column ${legacy}[,;]`));
    expect(sql).not.toMatch(/drop column[^;]*\bcascade\b/i);
  });

  it('it takes the lock inside the counting DO block, bounded, where the CLI can apply it', () => {
    // The Supabase CLI sends a migration as one extended-protocol pipeline with no BEGIN, which
    // PostgreSQL does not count as a transaction block: a top-level LOCK TABLE raises 25P01
    // there, so neither `supabase start` (CI) nor `db push` (production) could apply the file.
    // In plpgsql the lock is not top level, and it holds until the batch's transaction ends.
    expect(CONTRACT!.sql).toMatch(
      /do \$\$\s*declare\s*n int;\s*begin\s*perform set_config\('lock_timeout', '5s', true\);\s*lock table public\.site_integrations in access exclusive mode;\s*select count\(\*\) into n/,
    );
  });

  it('no migration takes a top-level LOCK TABLE (the CLI pipeline refuses it)', () => {
    const topLevel = MIGRATIONS.filter((m) => /^lock table\b/im.test(m.sql)).map((m) => m.name);
    expect(topLevel).toEqual([]);
  });

  it('it refuses, before it restates them, when the grants are no longer the ones it replaces', () => {
    // The restatement is 0105's grants on the kept columns. A migration between 0105 and the
    // contract that changed them (U15's anon GA4 read) would be undone in silence, and the
    // postconditions, which read the restatement back, would pass: the guard compares the
    // grants it is about to replace with 0105's, whole, before anything is dropped.
    const sql = CONTRACT!.sql;
    const guard = sql.search(
      /raise exception 'U11c: the grants on public\.site_integrations are no longer 0105''s/,
    );
    const drop = sql.search(/alter table public\.site_integrations\s+drop column/);
    const revoke = sql.search(
      /revoke all on public\.site_integrations from public, anon, authenticated, service_role;/,
    );
    expect(guard).toBeGreaterThan(sql.search(/lock table public\.site_integrations/));
    expect(drop).toBeGreaterThan(guard);
    expect(revoke).toBeGreaterThan(drop);
    // What it expects is what the replay says the migrations before it leave.
    const earlier = grantsAfter(MIGRATIONS.filter((m) => m.name < CONTRACT!.name));
    const sorted = (s: Set<string>) => [...s].sort().join(',');
    const want = /v_want constant text :=([\s\S]*?);\s*begin/.exec(sql)?.[1];
    expect(want, 'the guard states the grants it expects').toBeDefined();
    const stated = [...want!.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
    const replayed = [
      `anon select:${sorted(earlier.anon.select)}`,
      `authenticated insert:${sorted(earlier.authenticated.insert)}`,
      `authenticated select:${sorted(earlier.authenticated.select)}`,
      `authenticated update:${sorted(earlier.authenticated.update)}`,
    ];
    expect(earlier.anon.insert.size + earlier.anon.update.size).toBe(0);
    expect(stated).toBe(replayed.join('; '));
  });

  it('the grants after it: staff the typed values, anon the Search Console code and (U15) the GA4 id', () => {
    expect([...GRANTS.authenticated.select].sort()).toEqual([
      'calendly_url',
      'ga4_measurement_id',
      'search_console_token',
      'tenant_id',
      'updated_at',
      'version',
    ]);
    expect([...GRANTS.authenticated.insert].sort()).toEqual([
      'calendly_url',
      'ga4_measurement_id',
      'search_console_token',
      'tenant_id',
    ]);
    expect([...GRANTS.authenticated.update].sort()).toEqual([
      'calendly_url',
      'ga4_measurement_id',
      'search_console_token',
    ]);
    expect([...GRANTS.anon.select].sort()).toEqual([
      'ga4_measurement_id',
      'search_console_token',
      'tenant_id',
    ]);
    expect(GRANTS.anon.insert.size + GRANTS.anon.update.size).toBe(0);
  });
});

describe('every reader on main names only columns the table keeps', () => {
  it('the integrations route, GET: the columns the screen shows', async () => {
    const { GET } = route;
    existingRow = { tenant_id: TENANT, version: 2 };
    const res = (await GET(context('GET'))) as Response;
    expect(res.status, await res.clone().text()).toBe(200);
    expectWithinGrants(calls);
  });

  it('the integrations route, PATCH, the first save: the read, the insert and its return', async () => {
    const { PATCH } = route;
    const res = (await PATCH(context('PATCH', { ...FULL_SAVE, version: 0 }))) as Response;
    expect(res.status, await res.clone().text()).toBe(200);
    expect(calls.some((c) => c.table === 'site_integrations' && c.op === 'insert')).toBe(true);
    expectWithinGrants(calls);
  });

  it('the integrations route, PATCH, a later save: the read, the update and its return', async () => {
    const { PATCH } = route;
    existingRow = { tenant_id: TENANT, version: 3 };
    const res = (await PATCH(context('PATCH', { ...FULL_SAVE, version: 3 }))) as Response;
    expect(res.status, await res.clone().text()).toBe(200);
    const update = calls.find((c) => c.table === 'site_integrations' && c.op === 'update');
    expect(update?.columns.sort()).toEqual([
      'calendly_url',
      'ga4_measurement_id',
      'search_console_token',
    ]);
    expectWithinGrants(calls);
  });

  it("the screen's server read (/admin/integrations)", async () => {
    existingRow = { tenant_id: TENANT, version: 1 };
    await loadIntegrations(recording('staff') as never, { tenantId: TENANT } as never);
    expectWithinGrants(calls);
  });

  it("the public loader: the home pages' Search Console code, read as anon", async () => {
    await getSearchConsoleToken();
    expect(
      calls.filter((c) => c.table === 'site_integrations').every((c) => c.who === 'anon'),
    ).toBe(true);
    expectWithinGrants(calls);
  });

  it('the public loader: the GA4 measurement id (U15), read as anon', async () => {
    await getGa4MeasurementId();
    expect(
      calls.filter((c) => c.table === 'site_integrations').every((c) => c.who === 'anon'),
    ).toBe(true);
    expectWithinGrants(calls);
  });

  it("the preview dataset: anon's projection, its key, nothing read as '*'", () => {
    // A preview table with no projection is read as `*`, which a column grant refuses (42501).
    const projection = [
      ...(ANON_COLUMNS['site_integrations'] ?? []),
      ...(DATASET_ONLY_COLUMNS['site_integrations'] ?? []),
    ];
    expect(projection.length).toBeGreaterThan(0);
    for (const column of [...projection, ...TABLE_KEYS['site_integrations']]) {
      expect(KEPT_NOW.has(column), column).toBe(true);
      expect(GRANTS.anon.select.has(column), `anon select ${column}`).toBe(true);
    }
  });

  it("the editor's fields save columns the table keeps", () => {
    expect(integrationsUi.fields.length).toBeGreaterThan(0);
    for (const field of integrationsUi.fields) {
      expect(KEPT_NOW.has(field.column ?? ''), field.name).toBe(true);
    }
  });

  it('export-backup does not dump the table, and names its columns for every table it does', () => {
    expect(BACKUP_TABLES.map((t) => t.table)).not.toContain('site_integrations');
    for (const { table, columns } of BACKUP_TABLES) expect(columns, table).not.toMatch(/\*/);
  });
});

// ── Nothing else reads it ────────────────────────────────────────────────────────────────────
// The files whose code (comments aside) names the table, each with how its columns are held
// above. A file that starts naming it fails here until its columns are checked and it is added.
const READERS: Record<string, string> = {
  'src/lib/admin/integrations/load.ts': "the screen's read and the route's columns, driven above",
  'src/pages/api/admin/integrations.ts':
    'the singleton route, GET and both PATCH paths, driven above',
  'src/lib/data/siteVerification.ts': 'the public loader, driven above',
  'src/lib/data/ga4.ts': 'the GA4 loader (U15), read as anon, driven above',
  'src/lib/preview/relations.ts': "the preview table's key, held above",
  'src/lib/preview/visibility.ts': "anon's projection and the mirrored policy, held above",
  'src/lib/admin/auditLabels.ts': 'the activity log names the table, never a column',
};

const ROOTS = ['src', 'packages', 'scripts', join('supabase', 'functions')];
const CODE = /\.(ts|tsx|astro|mjs|js|cjs|json)$/;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : CODE.test(name) ? [path] : [];
  });
}

/** Code without its comments: block, HTML and line comments (not the `//` of a URL). */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');

describe('no other code names the table, and no reader names a box', () => {
  const files = ROOTS.flatMap((root) => walk(join(process.cwd(), root))).map((path) => ({
    rel: relative(process.cwd(), path).split('\\').join('/'),
    text: code(readFileSync(path, 'utf8')),
  }));

  it('the files that name site_integrations are the readers checked above', () => {
    expect(files.length).toBeGreaterThan(100);
    const naming = files.filter((f) => f.text.includes('site_integrations')).map((f) => f.rel);
    expect(naming.sort()).toEqual(Object.keys(READERS).sort());
  });

  it('none of them names a legacy column, as a string or as a key', () => {
    for (const f of files.filter((x) => x.text.includes('site_integrations'))) {
      const words = new Set(f.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      for (const legacy of LEGACY) expect(words.has(legacy), `${f.rel}: ${legacy}`).toBe(false);
    }
  });

  it('the seeds create no integrations row with a box (the first save creates the row, H7)', () => {
    const seeds = [
      'supabase/seed.sql',
      ...readdirSync('supabase/seeds').map((f) => `supabase/seeds/${f}`),
      ...readdirSync('supabase/seed-data').map((f) => `supabase/seed-data/${f}`),
      'scripts/gen-seeds.mjs',
    ];
    expect(seeds.length).toBeGreaterThan(3);
    for (const file of seeds) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/insert into public\.site_integrations\s*\(([^)]*)\)/gi)) {
        for (const c of m[1]!.split(',').map((x) => x.trim())) {
          expect(KEPT_NOW.has(c), `${file}: ${c}`).toBe(true);
        }
      }
      if (/\.json$/.test(file)) {
        const data = JSON.parse(text) as Record<string, unknown>;
        for (const row of (data['site_integrations'] as Record<string, unknown>[] | undefined) ??
          []) {
          for (const c of Object.keys(row)) expect(KEPT_NOW.has(c), `${file}: ${c}`).toBe(true);
        }
      }
    }
  });

  it('no SQL function or view any migration creates reads the table', () => {
    const readers: string[] = [];
    for (const { name, sql } of MIGRATIONS) {
      for (const fn of sql.matchAll(
        /create\s+(?:or\s+replace\s+)?function\s+([a-z_.]+)[\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi,
      )) {
        if (fn[3]!.includes('site_integrations')) readers.push(`${name}: ${fn[1]}`);
      }
      for (const view of sql.matchAll(
        /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([a-z_.]+)([^;]*);/gi,
      )) {
        if (view[2]!.includes('site_integrations')) readers.push(`${name}: ${view[1]}`);
      }
    }
    expect(readers).toEqual([]);
  });
});
