import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import { RELEASE_REGISTRY } from '@/lib/release/registry';

// No admin route or library writes a release-registry table outside the release (Admin v2
// R14b; releases.md slice R14: "a static test that no admin route writes a registry table
// outside src/lib/release"). With releases on, 0066's guard refuses a staff token's direct
// write to every registry table (and to the case study's two link tables), so a forgotten
// write path would fail in production the day releases are switched on; this finds it first.
//
// The scan reads every source file under src/ but src/lib/release/ (the release itself: the
// staged writers, the apply, the restore) and finds:
//   • every `.from(<table>)` chain that inserts, updates, upserts or deletes, where <table> is a
//     guarded table or not a literal (a kernel's `config.table`, a helper's `table`);
//   • every `.rpc('<fn>')` whose function, as the migrations last define it, writes a guarded
//     table (read from the SQL, so a function that starts writing one is found too).
// Each must be one of SANCTIONED below, with why it never writes live content while releases
// are on and the line its file must hold for that to stay true. An unlisted write fails, and so
// does a listed one the scan no longer finds (the list cannot go stale).

type Kind = 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';

interface Found {
  file: string;
  /** The table (`from`) or the function (`rpc`) as written. */
  target: string;
  kind: Kind;
}

interface Sanction {
  file: string;
  target: string;
  kinds: readonly Kind[];
  why: string;
  /** A line the file (or the named file) must hold for `why` to stay true. */
  guard: { file?: string; holds: string | RegExp };
}

const ROOT = process.cwd();
const RELEASE_DIR = 'src/lib/release/';

/** Every table 0066 guards: the registry's, and the case study's two link tables. */
const REGISTRY_TABLES = [...new Set(RELEASE_ENTITY_TYPES.map((t) => RELEASE_REGISTRY[t].table))];
const GUARDED = [...REGISTRY_TABLES, 'portfolio_services', 'portfolio_media'].sort();

const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return files(path);
    return /\.(ts|tsx|astro|mjs)$/.test(name) ? [path] : [];
  });
const SOURCES = files('src')
  .filter((path) => !path.startsWith(RELEASE_DIR))
  .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ---- the functions that write a guarded table -------------------------------------------------

const MIGRATIONS = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => read(`supabase/migrations/${f}`));

/** The body of `public.<fn>` as the last migration that (re)defines it has it, or null. */
export function functionBody(
  fn: string,
  migrations: readonly string[] = MIGRATIONS,
): string | null {
  const head = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`,
    'gi',
  );
  let body: string | null = null;
  for (const sql of migrations) {
    for (const match of sql.matchAll(head)) {
      const rest = sql.slice(match.index!);
      const open = /\bas\s+(\$[a-z_]*\$)/i.exec(rest);
      if (!open) continue;
      const start = open.index + open[0].length;
      const end = rest.indexOf(open[1]!, start);
      if (end > start) body = rest.slice(start, end);
    }
  }
  return body;
}

/** Whether SQL writes one of the guarded tables. */
export function writesGuarded(sql: string): string[] {
  const out = new Set<string>();
  for (const table of GUARDED) {
    const t = `(?:public\\.)?${table}\\b`;
    if (
      new RegExp(`\\binsert\\s+into\\s+${t}`, 'i').test(sql) ||
      new RegExp(`\\bupdate\\s+${t}`, 'i').test(sql) ||
      new RegExp(`\\bdelete\\s+from\\s+${t}`, 'i').test(sql)
    ) {
      out.add(table);
    }
  }
  return [...out];
}

// ---- the scan ---------------------------------------------------------------------------------

/** Every write the scan finds in one file. */
export function scan(path: string, text: string, writingRpcs: ReadonlySet<string>): Found[] {
  const out: Found[] = [];
  for (const match of text.matchAll(/\.from\(\s*([^)]*?)\s*\)/g)) {
    const arg = match[1]!;
    const literal = /^(['"`])([a-z_]+)\1$/.exec(arg)?.[2];
    if (literal !== undefined && !GUARDED.includes(literal)) continue;
    // The chain this `.from` starts, up to the statement's end.
    const chain = text.slice(match.index! + match[0].length).split(';')[0]!;
    for (const kind of ['insert', 'update', 'upsert', 'delete'] as const) {
      if (new RegExp(`\\.${kind}\\(`).test(chain)) out.push({ file: path, target: arg, kind });
    }
  }
  for (const match of text.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)) {
    if (writingRpcs.has(match[1]!)) out.push({ file: path, target: match[1]!, kind: 'rpc' });
  }
  return out;
}

/** The RPCs src/ calls (outside the release) whose function writes a guarded table. */
function writingRpcsCalled(): Map<string, string[]> {
  const called = new Set<string>();
  for (const { text } of SOURCES) {
    for (const match of text.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)) called.add(match[1]!);
  }
  const out = new Map<string, string[]>();
  for (const fn of called) {
    const body = functionBody(fn);
    if (body === null) continue;
    const tables = writesGuarded(body);
    if (tables.length > 0) out.set(fn, tables);
  }
  return out;
}

const WRITING_RPCS = writingRpcsCalled();
const FOUND = SOURCES.flatMap(({ path, text }) => scan(path, text, new Set(WRITING_RPCS.keys())));

// ---- what is sanctioned, and why --------------------------------------------------------------

const KERNEL_STAGES = { file: 'src/lib/admin/resource.ts', holds: 'stagedEntry(config)' };

const SANCTIONED: readonly Sanction[] = [
  {
    file: 'src/lib/admin/crud.ts',
    target: 'table',
    kinds: ['insert', 'update', 'delete'],
    why:
      'the generic row helpers of the live (releases-off) path: the resource kernel hands every ' +
      'write to a release-managed table to src/lib/release/staged.ts first when releases are on ' +
      '(R3a), and page visibility reaches updateRow only through its legacy branch',
    guard: KERNEL_STAGES,
  },
  {
    file: 'src/lib/admin/resource.ts',
    target: 'config.table',
    kinds: ['update'],
    why:
      'the live reorder, reached only with releases off: with them on the kernel stages a move ' +
      '(R3a), and a move marked as made in release mode is refused (409 releases-off, R12b)',
    guard: { holds: 'refuseStagedQuery(ctx.url, config.entity);' },
  },
  {
    file: 'src/lib/admin/singleton.ts',
    target: 'config.table',
    kinds: ['insert', 'update'],
    why:
      "the singleton kernel's live save: a release-managed singleton stages through " +
      'stagedSingleton.ts when releases are on (R3b); the others are outside the registry',
    guard: { holds: 'stagedSingletonUpdate(' },
  },
  {
    file: 'src/pages/api/admin/entity-seo.ts',
    target: "'entity_seo'",
    kinds: ['insert', 'update'],
    why: 'the live branch of the entity-SEO PUT; with releases on it stages first (R3b)',
    guard: {
      holds: 'if (await ctx.releasesEnabled()) return stagedEntitySeoWrite(ctx, ctx.input);',
    },
  },
  {
    file: 'src/lib/admin/pageVisibility.ts',
    target: "'page_visibility'",
    kinds: ['insert'],
    why:
      'the live branch of a visibility save (writeVisibility): both routes stage first when ' +
      'releases are on (R14b, stagedPageVisibility.ts)',
    guard: {
      file: 'src/pages/api/admin/page-visibility/index.ts',
      holds: 'return stagedVisibilityWrite(ctx, ctx.input);',
    },
  },
  {
    file: 'src/lib/admin/pageVisibility.ts',
    target: 'set_page_password',
    kinds: ['rpc'],
    why:
      'the password door: a secret is immediate (P-3). With releases on it is reached only for a ' +
      'page already behind a password, its message unchanged and nothing pending, which moves ' +
      "only 0061's exempt password_version past the guard (R14b)",
    guard: {
      file: 'src/pages/api/admin/page-visibility/password.ts',
      holds: 'if (await ctx.releasesEnabled()) await assertPasswordImmediate(ctx, input);',
    },
  },
  {
    file: 'src/lib/admin/resources/portfolio.ts',
    target: 'save_portfolio',
    kinds: ['rpc'],
    why:
      "the portfolio config's `persist`, which the kernel never runs when staged (R3a; held by " +
      'stagedKernel.spec.ts "persist and afterWrite never run when staged")',
    guard: {
      file: 'tests/lib/stagedKernel.spec.ts',
      holds: "it('persist and afterWrite never run when staged'",
    },
  },
  {
    file: 'src/lib/admin/resources/themes.ts',
    target: "'custom_themes'",
    kinds: ['update'],
    why:
      "the themes config's `afterWrite` (one active theme), which never runs when staged; with " +
      'releases on the apply clears the other themes in its own transaction (0051)',
    guard: {
      file: 'tests/lib/stagedKernel.spec.ts',
      holds: "it('persist and afterWrite never run when staged'",
    },
  },
  {
    file: 'src/pages/api/admin/site-profile/intake.ts',
    target: "'site_profile'",
    kinds: ['insert', 'update'],
    why:
      'the job-application switch, an immediate column (accepting_applications, 0038) the guard ' +
      'lets an update change alone; the insert runs only where the tenant has no identity row, ' +
      'which the switch-on read-back requires to exist (launch runbook §6p, identity_rows 1)',
    guard: { holds: 'const values = { accepting_applications: next };' },
  },
];

const key = (f: Pick<Found, 'file' | 'target'>) => `${f.file} :: ${f.target}`;

describe('no route or library writes a registry table outside the release (Admin v2 R14b)', () => {
  it('knows the guarded tables: every registry table and the two link tables', () => {
    expect(GUARDED).toEqual(
      expect.arrayContaining(['services', 'page_sections', 'site_profile', 'page_visibility']),
    );
    expect(GUARDED).toEqual(expect.arrayContaining(['portfolio_services', 'portfolio_media']));
    expect(GUARDED.length).toBe(REGISTRY_TABLES.length + 2);
  });

  it('reads which functions write a guarded table from the migrations', () => {
    expect(WRITING_RPCS.get('save_portfolio')).toEqual(expect.arrayContaining(['portfolio']));
    expect(WRITING_RPCS.get('set_page_password')).toEqual(['page_visibility']);
    // The release's own apply is called from src/lib/release only.
    expect(SOURCES.some(({ text }) => /\.rpc\(\s*['"]apply_release['"]/.test(text))).toBe(false);
  });

  it('every write it finds is sanctioned, with its kind', () => {
    const unsanctioned = FOUND.filter(
      (f) =>
        !SANCTIONED.some(
          (s) => s.file === f.file && s.target === f.target && s.kinds.includes(f.kind),
        ),
    ).map((f) => `${key(f)} (${f.kind})`);
    expect(unsanctioned).toEqual([]);
  });

  it('every sanction is still found (the list cannot go stale)', () => {
    for (const s of SANCTIONED) {
      for (const kind of s.kinds) {
        expect(
          FOUND.some((f) => f.file === s.file && f.target === s.target && f.kind === kind),
          `${key(s)} (${kind})`,
        ).toBe(true);
      }
    }
  });

  it('every sanction’s guard holds', () => {
    for (const s of SANCTIONED) {
      const text = read(s.guard.file ?? s.file);
      if (typeof s.guard.holds === 'string') expect(text, key(s)).toContain(s.guard.holds);
      else expect(text, key(s)).toMatch(s.guard.holds);
      expect(s.why.length, key(s)).toBeGreaterThan(40);
    }
  });
});

describe('the scan itself', () => {
  it('finds a literal, a dynamic table and a writing rpc; skips reads and other tables', () => {
    const text = [
      "await sb.from('services').update({ title }).eq('id', id);",
      "await sb.from('services').select('id').eq('id', id);",
      "await sb.from('leads').update({ x }).eq('id', id);",
      'await sb.from(config.table).delete().eq("id", id);',
      "await sb.rpc('save_portfolio', { p: 1 });",
      "await sb.rpc('search_content', { q });",
    ].join('\n');
    expect(scan('x.ts', text, new Set(['save_portfolio']))).toEqual([
      { file: 'x.ts', target: "'services'", kind: 'update' },
      { file: 'x.ts', target: 'config.table', kind: 'delete' },
      { file: 'x.ts', target: 'save_portfolio', kind: 'rpc' },
    ]);
  });

  it('reads a function’s last definition and what it writes', () => {
    const sql = [
      'create or replace function public.f(a int) returns void language plpgsql as $$ begin update public.services set x = 1; end $$;',
      'create or replace function public.f(a int) returns void language plpgsql as $fn$ begin insert into public.leads values (1); end $fn$;',
    ];
    expect(functionBody('f', sql)).toContain('insert into public.leads');
    expect(writesGuarded(functionBody('f', sql)!)).toEqual([]);
    expect(writesGuarded('delete from public.page_sections where id = 1')).toEqual([
      'page_sections',
    ]);
  });
});
