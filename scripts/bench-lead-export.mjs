#!/usr/bin/env node
// What one row of the lead CSV export costs in CPU, in the Workers runtime (workerd, through
// Miniflare: no bindings, no network, nothing read from any database or any hosted service).
// The export's caps (src/lib/crm/exportRead.ts, EXPORT_ROW_CAP) are set from these numbers
// against the Workers Free plan's 10 ms of CPU a request; docs/admin-v2/as-built/C3.md
// records a run. Re-run it when the export's per-row work changes:
//
//   node scripts/bench-lead-export.mjs
//
// It takes about a minute and prints, for a typical message and for the longest the form
// accepts, the cost of a row without PII, with PII (the key imported once, as the export does)
// and with the key imported per decrypt (as the export did before), then what each cap costs.
//
// Miniflare is not a dependency of this repo: wrangler and the Cloudflare Vite plugin bring
// it (and workerd) in. If an upgrade drops it, the script says so and exits.
//
// It runs the real code: src/lib/crypto/pii.ts and src/lib/admin/csv.ts, transpiled as they
// are, inside one Worker. Each request parses a page of leads as PostgREST would send it,
// builds the export's records (decrypting the four PII fields for a PII export) and the CSV.
// The rows are synthetic (example.test addresses, a repeated letter for the message).
// workerd does not advance its clocks while a request computes, so each request is timed from
// outside, at two sizes: the difference, per row, is what a row costs. That is wall time on
// the Worker's one thread, which is its CPU time on an otherwise idle machine; the fastest of
// several runs is taken, since other work on the machine only ever adds time.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');

let Miniflare;
try {
  ({ Miniflare } = require('miniflare'));
} catch {
  console.error('miniflare is not installed (wrangler brings it in): nothing to measure with.');
  process.exit(1);
}

function transpile(path) {
  const source = readFileSync(join(root, path), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const worker = `
import { encryptPII, decryptPII, importPIIKey } from './pii.js';
import { toCsv } from './csv.js';

const MATERIAL = 'k'.repeat(44);
const HEADER = ['id', 'lead_number', 'created_at', 'status', 'stage', 'spam', 'name', 'company',
  'email', 'phone', 'budget', 'timeline', 'timeline_band', 'service_of_interest', 'service_label',
  'service_label_ar', 'discipline_of_interest', 'discipline_label', 'discipline_label_ar', 'locale',
  'message', 'assignee', 'value_sar', 'tags', 'score', 'source', 'channel', 'notes_count'];

let rows = [];
/** The response body PostgREST would send for the first n rows, made once per size. */
const bodies = new Map();
function body(n) {
  if (!bodies.has(n)) bodies.set(n, JSON.stringify(rows.slice(0, n)));
  return bodies.get(n);
}

function record(row) {
  return {
    id: row.id, lead_number: row.lead_number, created_at: row.created_at, status: row.status,
    stage: 'Proposal sent', spam: row.is_spam ? 'yes' : 'no', name: row.name, company: row.company,
    service_of_interest: row.service_of_interest, service_label: 'Logo design',
    service_label_ar: 'تصميم الشعار', discipline_of_interest: row.discipline_of_interest,
    discipline_label: '', discipline_label_ar: '', locale: row.locale, message: row.message,
    assignee: 'Amal', value_sar: row.value_sar, tags: row.tags.join(', '), score: row.score,
    source: row.source, channel: row.channel,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get('n') ?? '0');
    if (url.pathname === '/setup') {
      const message = 'م'.repeat(Number(url.searchParams.get('message') ?? '400'));
      rows = [];
      bodies.clear();
      for (let i = 0; i < n; i += 1) {
        rows.push({
          id: crypto.randomUUID(), kind: 'contact', locale: 'ar', name: 'سارة أحمد ' + i,
          company: 'Acme Trading', message, service_of_interest: 'logo', status: 'in_progress',
          consent_marketing: false, created_at: '2026-10-01T10:00:00.123456+00:00',
          updated_at: '2026-10-01T10:00:00.123456+00:00', discipline_of_interest: null,
          lead_number: i, stage_id: crypto.randomUUID(), is_spam: false,
          assigned_to: crypto.randomUUID(), value_sar: 50000, tags: ['VIP', 'Urgent'], score: 40,
          source: 'web_form', channel: 'unknown', timeline_band: null,
          email_enc: await encryptPII('person' + i + '@example.test', MATERIAL),
          phone_enc: await encryptPII('+966500000000', MATERIAL),
          budget_enc: await encryptPII('gt_200k', MATERIAL),
          timeline_text_enc: await encryptPII('Before Ramadan next year', MATERIAL),
        });
      }
      return new Response(String(rows.length));
    }
    const page = JSON.parse(body(n));
    const pii = url.pathname !== '/safe';
    // '/pii' imports the key once for the request (the export since C3's review); '/pii-per-call'
    // lets each decrypt import it again (decryptPII given the material), as the export did before.
    const key = url.pathname === '/pii' ? await importPIIKey(MATERIAL) : MATERIAL;
    const records = [];
    for (const row of page) {
      const r = record(row);
      if (pii) {
        r.email = await decryptPII(row.email_enc, key);
        r.phone = await decryptPII(row.phone_enc, key);
        r.budget = await decryptPII(row.budget_enc, key);
        r.timeline = await decryptPII(row.timeline_text_enc, key);
        r.timeline_band = row.timeline_band;
        r.notes_count = 0;
      }
      records.push(r);
    }
    return new Response(String(toCsv(HEADER, records).length));
  },
};
`;

const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'bench-lead-export',
        compatibilityDate: '2025-09-01',
        manifest: {
          mainModule: 'index.mjs',
          modulesRoot: root,
          modules: {
            'index.mjs': { type: 'esm', contents: worker },
            'pii.js': { type: 'esm', contents: transpile('src/lib/crypto/pii.ts') },
            'csv.js': { type: 'esm', contents: transpile('src/lib/admin/csv.ts') },
          },
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

/** The caps as the export reads them (exportRead.ts imports only a type, which transpiling drops). */
async function caps() {
  const code = transpile('src/lib/crm/exportRead.ts');
  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return mod.EXPORT_ROW_CAP;
}

try {
  const cap = await caps();
  let worst = { safe: 0, pii: 0 };
  // The cost of a row is the slope between a small and a large request: what the request
  // itself costs (routing, the response, Miniflare's own hop) is the same in both and cancels.
  const [small, large] = [200, 1200];
  // A typical message, and the longest the form accepts (5,000 characters, LeadInputSchema).
  for (const message of [400, 5000]) {
    await (await mf.dispatchFetch(`http://bench/setup?n=${large}&message=${message}`)).text();
    const perRow = async (path) =>
      (((await time(`${path}?n=${large}`)) - (await time(`${path}?n=${small}`))) * 1000) /
      (large - small);
    const safe = await perRow('/safe');
    const pii = await perRow('/pii');
    const perCall = await perRow('/pii-per-call');
    console.log(
      `message of ${message} characters: no PII ${safe.toFixed(1)} µs a row; ` +
        `PII, key imported once ${pii.toFixed(1)} µs a row; ` +
        `PII, key imported per decrypt ${perCall.toFixed(1)} µs a row`,
    );
    worst = { safe: Math.max(worst.safe, safe), pii: Math.max(worst.pii, pii) };
  }
  // What a full export's rows cost at the worst rate measured, of the 10 ms a request has.
  for (const kind of ['pii', 'safe']) {
    const ms = (cap[kind] * worst[kind]) / 1000;
    console.log(`cap ${kind}: ${cap[kind]} rows, about ${ms.toFixed(1)} ms of CPU at worst`);
  }
} finally {
  await mf.dispose();
}
