#!/usr/bin/env node
// What one row of the activity log's CSV export costs in CPU, in the Workers runtime (workerd,
// through Miniflare: no bindings, no network, nothing read from any database or any hosted
// service). The export's cap (src/lib/admin/activityExport.ts, ACTIVITY_EXPORT_CAP) is set
// from these numbers against the Workers Free plan's 10 ms of CPU a request;
// docs/admin-v2/as-built/U13.md records a run. Re-run it when the export's per-row work
// changes:
//
//   node scripts/bench-activity-export.mjs
//
// It runs the real code: toActivityRecords (src/lib/admin/activityExport.ts, which describes
// each row through src/lib/admin/auditLabels.ts and names its person) and toCsv
// (src/lib/admin/csv.ts), bundled with esbuild into one Worker, the virtual modules the
// Worker build supplies (astro:env, cloudflare:workers) replaced by the test stubs, as
// vitest does. Each request parses a page of entries as PostgREST would send it, builds the
// records (the people answered by a stand-in for public.audit_people) and the CSV. The rows
// are synthetic: kernel saves with a dozen changed fields, a lead reveal, a sign-in.
// workerd does not advance its clocks while a request computes, so each request is timed from
// outside, at two sizes: the difference, per row, is what a row costs (bench-lead-export.mjs
// explains the method). Miniflare and esbuild come with wrangler and Vite; if an upgrade drops
// either, the script says so and exits.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'package.json'));

let Miniflare;
let esbuild;
try {
  ({ Miniflare } = require('miniflare'));
  esbuild = require('esbuild');
} catch {
  console.error('miniflare or esbuild is not installed (wrangler and Vite bring them in).');
  process.exit(1);
}

const entry = `
import { toActivityRecords, ACTIVITY_CSV_HEADER } from '@/lib/admin/activityExport';
import { toCsv } from '@/lib/admin/csv';

const PEOPLE = Array.from({ length: 12 }, (_, i) => ({
  id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
  display_name: 'Member ' + i,
  role: ['admin', 'developer', 'content_creator', 'seo'][i % 4],
  is_active: i % 5 !== 0,
}));
const ACTIONS = [
  ['service.update', 'service', { fields: ['title', 'summary', 'body', 'body_html', 'status', 'meta_title', 'meta_description', 'slug', 'poster_media_id', 'discipline_id', 'value_points', 'deliverables'], version: 7, status: 'published', previousStatus: 'draft' }],
  ['lead.view_pii', 'lead', {}],
  ['auth.login', 'profile', { ip: '203.0.113.9', remember: true }],
  ['lead.update', 'lead', { fields: ['stage_id', 'assigned_to', 'tags'], status: null, stage: 'x' }],
  ['site_profile.update', 'site_profile', { fields: ['brand_name', 'contact_email', 'socials'] }],
];

let body = '';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get('n') ?? '0');
    if (url.pathname === '/setup') {
      const rows = [];
      for (let i = 0; i < n; i += 1) {
        const [action, type, detail] = ACTIONS[i % ACTIONS.length];
        rows.push({
          id: 100000 - i,
          actor_id: PEOPLE[i % PEOPLE.length].id,
          actor_role: PEOPLE[i % PEOPLE.length].role,
          action,
          entity_type: type,
          entity_id: crypto.randomUUID(),
          detail,
          created_at: new Date(Date.UTC(2026, 9, 15, 9) - i * 60000).toISOString(),
        });
      }
      body = JSON.stringify(rows);
      return new Response(String(rows.length));
    }
    const rows = JSON.parse(body).slice(0, n);
    const sb = { rpc: async () => ({ data: PEOPLE, error: null }) };
    const records = await toActivityRecords(sb, { tenantId: 't' }, rows);
    return new Response(String(toCsv(ACTIVITY_CSV_HEADER, records).length));
  },
};
`;

const stub = (path) => join(root, path);
const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  alias: {
    '@': stub('src'),
    '@schemas': stub('packages/schemas'),
    '@consent': stub('packages/consent'),
    'astro:env/client': stub('tests/stubs/astro-env-client.ts'),
    'astro:env/server': stub('tests/stubs/astro-env-server.ts'),
    'cloudflare:workers': stub('tests/stubs/cloudflare-workers.ts'),
  },
  // Vite's import.meta.glob (the build-time stills registry the resource configs reach):
  // nothing the export runs reads it, so an empty registry stands in.
  define: {
    'import.meta.glob': 'globalThis.__benchGlob',
    'import.meta.env': 'globalThis.__benchEnv',
  },
  banner: { js: 'globalThis.__benchGlob = () => ({}); globalThis.__benchEnv = {};' },
  logLevel: 'error',
});
const worker = built.outputFiles[0].text;

const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'bench-activity-export',
        compatibilityDate: '2025-09-01',
        manifest: {
          mainModule: 'index.mjs',
          modulesRoot: root,
          modules: { 'index.mjs': { type: 'esm', contents: worker } },
        },
      },
    },
  ],
});

/** The fastest of `reps` timings of one request, in milliseconds, after two unmeasured runs. */
async function time(path, reps = 15) {
  let best = Infinity;
  for (let i = 0; i < reps + 2; i += 1) {
    const start = performance.now();
    await (await mf.dispatchFetch(`http://bench${path}`)).text();
    if (i >= 2) best = Math.min(best, performance.now() - start);
  }
  return best;
}

try {
  const [small, large] = [200, 2200];
  await (await mf.dispatchFetch(`http://bench/setup?n=${large}`)).text();
  const perRow =
    (((await time(`/rows?n=${large}`)) - (await time(`/rows?n=${small}`))) * 1000) /
    (large - small);
  const source = readFileSync(join(root, 'src/lib/admin/activityExport.ts'), 'utf8');
  const cap = Number(/ACTIVITY_EXPORT_CAP = (\d+)/.exec(source)?.[1] ?? '0');
  console.log(`activity export: ${perRow.toFixed(1)} µs a row`);
  console.log(`cap: ${cap} rows, about ${((cap * perRow) / 1000).toFixed(1)} ms of CPU`);
} finally {
  await mf.dispose();
}
