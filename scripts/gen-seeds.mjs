// Generates BOTH seed files from one source (supabase/seed-data/*.json):
//
//   supabase/seed.sql              mode "published"  — local, CI, staging. Applied by
//                                  `supabase start` / `supabase db reset`. Design-delivery
//                                  placeholders are PUBLISHED so these environments look
//                                  exactly like the approved mockup.
//   supabase/seeds/production.sql  mode "production" — the same rows, with every
//                                  placeholder demoted (status → draft, visible → false) so
//                                  editors can replace and publish them. Nothing fake is
//                                  ever live in production (UI v2 decision 7).
//
// Why generated rather than two hand-kept files: two copies of ~all site content drift the
// first time someone fixes a typo in one. tests/seed/seeds.spec.ts regenerates in memory
// and fails if either committed file differs, so an edit that bypasses the generator is
// caught in review rather than in production.
//
//   node scripts/gen-seeds.mjs          write both files
//   node scripts/gen-seeds.mjs --check  exit 1 if either committed file is stale
//
// ── Data format (supabase/seed-data/NN-name.json) ────────────────────────────────────
//   { "blocks": [ { "table": "services",
//                   "conflict": ["tenant_id", "slug"],   // ON CONFLICT … DO NOTHING
//                   "existsBy": ["name"],                // OR: insert-where-not-exists
//                   "unlessAuthored": ["location"],      // with conflict: rows sharing these
//                                                        // values form a slice, inserted only
//                                                        // while the table holds NO row of
//                                                        // that slice (once, never again)
//                   "tenantScoped": true,                // default true: adds tenant_id
//                   "rows": [ { …columns…,
//                               "__placeholder": true,   // demoted in production mode
//                               "__published": { … },    // overrides in published mode
//                               "__production": { … } } ] } ] }
// Values: strings/numbers/booleans/null are literals; objects/arrays are jsonb — so a
// text[] column takes a Postgres array LITERAL string ("{home,work}"), which the
// INSERT … VALUES types from its column (tests/seed/seeds.spec.ts checks the format);
// {"$ref": {"table": "team_members", "by": {"slug": "x"}}} is a tenant-scoped id lookup;
// {"$sql": "now()"} is the one raw expression allowed.
//
// Every statement is idempotent: re-running a seed never duplicates a row and never
// overwrites an editor's change (conflict → do nothing).

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'supabase', 'seed-data');
export const OUTPUTS = {
  published: join(ROOT, 'supabase', 'seed.sql'),
  production: join(ROOT, 'supabase', 'seeds', 'production.sql'),
};

/** The single launch tenant (anon fence). Every tenant-scoped row belongs to it. */
export const TENANT_ID = '00000000-0000-0000-0000-0000000000b1';

const RAW_SQL_ALLOWED = new Set(['now()']);

export function loadBlocks() {
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const doc = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
      return doc.blocks.map((block) => ({ ...block, source: file }));
    });
}

/** Applies a mode to one row: strips meta keys, applies overrides, demotes placeholders. */
export function rowForMode(row, mode) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('__')) out[k] = v;
  if (row.__placeholder && mode === 'production') {
    if (out.status === 'published' || out.status === 'scheduled') out.status = 'draft';
    if (out.visible === true) out.visible = false;
  }
  Object.assign(out, mode === 'production' ? row.__production : row.__published);
  return out;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function literal(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number in seed data: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'object' && '$ref' in value) {
    const { table, by } = value.$ref;
    const where = Object.entries(by)
      .map(([k, v]) => `${k} = ${literal(v)}`)
      .join(' and ');
    return `(select id from public.${table} where tenant_id = ${quote(TENANT_ID)} and ${where})`;
  }
  if (typeof value === 'object' && '$sql' in value) {
    if (!RAW_SQL_ALLOWED.has(value.$sql)) throw new Error(`raw SQL not allowed: ${value.$sql}`);
    return value.$sql;
  }
  return `${quote(JSON.stringify(value))}::jsonb`;
}

function blockSql(block, mode) {
  const scoped = block.tenantScoped !== false;
  const rows = block.rows.map((r) => {
    const row = rowForMode(r, mode);
    return scoped ? { tenant_id: TENANT_ID, ...row } : row;
  });
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const tuple = (r) => columns.map((c) => (c in r ? literal(r[c]) : 'default')).join(', ');
  const header = `-- ${block.table} (${block.source})`;

  if (block.existsBy) {
    // No unique key to conflict on (e.g. partner_logos): insert only if absent, so a
    // re-seed does not duplicate the row.
    const stmts = rows.map((r) => {
      const match = block.existsBy.map((c) => `${c} = ${literal(r[c])}`).join(' and ');
      const tenant = scoped ? `tenant_id = ${quote(TENANT_ID)} and ` : '';
      return (
        `insert into public.${block.table} (${columns.join(', ')})\n` +
        `  select ${tuple(r)}\n` +
        `  where not exists (select 1 from public.${block.table} where ${tenant}${match});`
      );
    });
    return `${header}\n${stmts.join('\n')}`;
  }

  if (!block.conflict) throw new Error(`${block.source}:${block.table} needs conflict or existsBy`);

  if (block.unlessAuthored) {
    // A collection an editor may already have built (a menu). Seeding into it would mix
    // our rows into theirs — and a per-row check would also bring back a seeded row an
    // editor had DELETED the next time the seed ran. So the decision is made once per
    // slice (e.g. per menu location): the whole slice goes in only while that slice is
    // empty, and never again after anyone has touched it.
    //
    // One DO block per slice, so the check runs BEFORE any of its rows are inserted (a
    // per-row statement would see its siblings from the same transaction). A plain
    // INSERT … VALUES inside it types each literal from its target column, which an
    // INSERT … SELECT over bare literals would not (text into uuid fails).
    const slices = new Map();
    for (const r of rows) {
      const key = JSON.stringify(block.unlessAuthored.map((c) => r[c]));
      if (!slices.has(key)) slices.set(key, []);
      slices.get(key).push(r);
    }
    const tenant = scoped ? `tenant_id = ${quote(TENANT_ID)} and ` : '';
    const stmts = [...slices.values()].map((slice) => {
      const match = block.unlessAuthored.map((c) => `${c} = ${literal(slice[0][c])}`).join(' and ');
      const values = slice.map((r) => `      (${tuple(r)})`).join(',\n');
      return (
        `do $seed$ begin\n` +
        `  if not exists (select 1 from public.${block.table} where ${tenant}${match}) then\n` +
        `    insert into public.${block.table} (${columns.join(', ')}) values\n${values}\n` +
        `    on conflict (${block.conflict.join(', ')}) do nothing;\n` +
        `  end if;\n` +
        `end $seed$;`
      );
    });
    return `${header}\n${stmts.join('\n')}`;
  }

  const values = rows.map((r) => `  (${tuple(r)})`).join(',\n');
  return (
    `${header}\ninsert into public.${block.table} (${columns.join(', ')}) values\n${values}\n` +
    `on conflict (${block.conflict.join(', ')}) do nothing;`
  );
}

const GUARD = `-- Refuse to run against production: this file PUBLISHES design placeholders.
-- (app.deployment is set to 'production' by the launch runbook right after migration 0016.)
do $$
begin
  if to_regclass('app.deployment') is not null
     and exists (select 1 from app.deployment where env = 'production') then
    raise exception 'supabase/seed.sql publishes design placeholders and must never run in production — use supabase/seeds/production.sql';
  end if;
end $$;`;

export function generate(mode, blocks = loadBlocks()) {
  const intro =
    mode === 'published'
      ? `-- Seed for LOCAL / CI / STAGING. Applied by \`supabase start\` and \`supabase db reset\`.
-- Design placeholders are PUBLISHED here so these environments match the approved mockup.
-- Staging: psql -v ON_ERROR_STOP=1 -f supabase/seed.sql`
      : `-- Seed for PRODUCTION: the same rows as supabase/seed.sql, with every design placeholder
-- demoted to draft / hidden so editors can replace and publish it. Safe to re-run: every
-- statement is conflict → do nothing, so it never overwrites an editor's change.
-- Apply: psql -v ON_ERROR_STOP=1 -f supabase/seeds/production.sql`;
  const body = blocks.map((b) => blockSql(b, mode)).join('\n\n');
  return (
    `-- GENERATED by scripts/gen-seeds.mjs from supabase/seed-data/*.json — DO NOT EDIT.\n` +
    `-- Change the JSON, then run \`npm run seed:gen\`.\n${intro}\n\n` +
    `begin;\n\n${mode === 'published' ? `${GUARD}\n\n` : ''}${body}\n\ncommit;\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [mode, path] of Object.entries(OUTPUTS)) {
    const sql = generate(mode);
    if (check) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (current !== sql) {
        console.error(`  ✘ ${path} is stale — run \`npm run seed:gen\``);
        stale = true;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, sql);
      console.log(`  ✓ wrote ${path}`);
    }
  }
  if (stale) process.exit(1);
}
