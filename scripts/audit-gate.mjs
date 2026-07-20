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
 * EMPTY BY DESIGN — `npm audit --omit=dev` currently reports **0 vulnerabilities**.
 *
 * History: this list carried 7 accepted advisories (astro XSS/SSRF + undici/ws/esbuild
 * build-tooling DoS) whose only fix was the framework major. The short expiry (2026-06-30)
 * did its job: it failed CI, forced KAN-31, and the Astro 5→7 + adapter 12→14 + Node 22
 * upgrade cleared every one of them. The debt was paid, not extended.
 *
 * If you add an entry it MUST carry a reason AND an expiry — never a blanket `|| true`.
 * Past-expiry entries fail the gate on purpose, so debt can't be carried silently.
 */
const ALLOWLIST = [];

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
