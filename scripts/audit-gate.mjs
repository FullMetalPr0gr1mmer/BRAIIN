// Supply-chain audit gate (CLAUDE.md §3 Pillar 1 — Security; §11 documented exceptions).
//
// Blocks on HIGH/CRITICAL advisories in PRODUCTION dependencies (what actually ships
// in the Cloudflare Worker bundle). Dev-only tooling (vitest, lighthouse, etc.) is
// audited informationally in CI but does not block feature work — it never ships.
//
// Accepted advisories are listed EXPLICITLY below with a reason + expiry (never a blanket
// `|| true`). Anything HIGH/CRITICAL in prod that is NOT allowlisted fails the gate, so
// new vulnerabilities are always caught. An allowlist entry past its `expires` date also
// fails the gate — forcing us to revisit rather than silently carrying debt forever.

import { execSync } from 'node:child_process';

/**
 * Each entry MUST justify why the advisory is acceptable AND carry an expiry.
 * All four below are build/deploy tooling pulled transitively by astro (→ vite → esbuild)
 * and @astrojs/cloudflare (→ wrangler → undici); none are part of the deployed Worker
 * runtime bundle, and none have a fix without the Astro 6 / Node 22 / wrangler-major
 * upgrade tracked in KAN-31. Re-evaluate on or before `expires`.
 */
const ALLOWLIST = [
  // --- Astro framework advisories: ONLY fix is astro@6 (major, needs Node 22) = KAN-31.
  //     Reviewed as NOT reachable in our code; short expiry to force the upgrade soon.
  {
    id: 'GHSA-8hv8-536x-4wqp',
    pkg: 'astro',
    reason:
      'Reflected XSS via unescaped slot NAME. Not reachable: we use only static slot names (<slot/>, Astro.slots.render("default")) — no user-derived slot names. Fix = astro 6 — KAN-31.',
    expires: '2026-06-30',
  },
  {
    id: 'GHSA-2pvr-wf23-7pc7',
    pkg: 'astro',
    reason:
      'Host-header SSRF in prerendered error-page fetch. Framework-internal; mitigated by Cloudflare validating Host at the edge + SSR (no prerendered error pages). Fix = astro 6 — KAN-31.',
    expires: '2026-06-30',
  },
  {
    id: 'GHSA-f269-vfmq-vjvj',
    pkg: 'undici',
    reason:
      'Wrangler deploy CLI (undici via @astrojs/cloudflare→wrangler); not in the Workers runtime. Fixed by adapter 13 / wrangler-major — KAN-31.',
    expires: '2026-09-15',
  },
  {
    id: 'GHSA-vrm6-8vpv-qv8q',
    pkg: 'undici',
    reason: 'Wrangler/undici, deploy-time only (see GHSA-f269). Fixed by adapter 13 — KAN-31.',
    expires: '2026-09-15',
  },
  {
    id: 'GHSA-v9p9-hfj2-hcw8',
    pkg: 'undici',
    reason: 'Wrangler/undici, deploy-time only (see GHSA-f269). Fixed by adapter 13 — KAN-31.',
    expires: '2026-09-15',
  },
  {
    id: 'GHSA-vxpw-j846-p89q',
    pkg: 'undici',
    reason:
      'WebSocket DoS via fragment-count bypass. Wrangler/undici, deploy-time only (see GHSA-f269); not in the shipped Worker runtime, no ws server. Fixed by adapter 13 — KAN-31.',
    expires: '2026-06-30',
  },
  {
    id: 'GHSA-96hv-2xvq-fx4p',
    pkg: 'ws',
    reason:
      'Local Workers emulator (ws via @astrojs/cloudflare→wrangler→miniflare); not in the shipped Worker runtime, and we run no ws server / no Supabase realtime, so the fragment-DoS is unreachable. Fixed by the wrangler-major upgrade — KAN-31.',
    expires: '2026-09-15',
  },
];

function runAudit() {
  try {
    return execSync('npm audit --json --omit=dev', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // npm audit exits non-zero when advisories exist; the JSON is still on stdout.
    if (e.stdout) return e.stdout;
    throw e;
  }
}

const audit = JSON.parse(runAudit().replace(/^﻿/, ''));

const found = new Map();
for (const [pkg, v] of Object.entries(audit.vulnerabilities || {})) {
  for (const via of v.via) {
    if (typeof via === 'object' && (via.severity === 'high' || via.severity === 'critical')) {
      const id = (via.url || '').split('/').pop() || String(via.source);
      if (!found.has(id)) found.set(id, { pkg, sev: via.severity, title: via.title || '' });
    }
  }
}

const today = new Date().toISOString().slice(0, 10);
const allow = new Map(ALLOWLIST.map((a) => [a.id, a]));
const unexpected = [];
const expired = [];

for (const [id, info] of found) {
  const a = allow.get(id);
  if (!a) unexpected.push({ id, ...info });
  else if (a.expires < today) expired.push({ id, ...info, expires: a.expires });
}
const stale = ALLOWLIST.filter((a) => !found.has(a.id)).map((a) => a.id);

console.log(`Supply-chain gate — production deps (--omit=dev), high+critical.`);
console.log(`Found ${found.size} high/critical; ${ALLOWLIST.length} allowlisted.\n`);

if (stale.length) {
  console.log(`ℹ️  Stale allowlist entries (advisory no longer present — safe to remove):`);
  for (const id of stale) console.log(`    - ${id}`);
  console.log('');
}

if (expired.length) {
  console.log(`❌ Allowlisted advisories PAST expiry — revisit now:`);
  for (const f of expired) console.log(`    - ${f.id} (${f.pkg}) expired ${f.expires}`);
  console.log('');
}

if (unexpected.length) {
  console.log(`❌ Unallowlisted high/critical advisories in production deps:`);
  for (const f of unexpected)
    console.log(`    - ${f.sev.toUpperCase()} ${f.pkg}: ${f.id} — ${f.title}`);
  console.log(`\n   Fix the dependency, or (if genuinely accepted) add a documented,`);
  console.log(`   expiring entry to ALLOWLIST in scripts/audit-gate.mjs.`);
  console.log('');
}

if (unexpected.length || expired.length) {
  console.log('Supply-chain gate: FAIL');
  process.exit(1);
}
console.log('Supply-chain gate: PASS (all production high/critical are documented + unexpired).');
