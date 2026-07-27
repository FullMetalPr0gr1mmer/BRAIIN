// Pushes the server secrets from .env into Cloudflare Worker Secrets.
//
// Exists because the alternative is `wrangler secret put` five times with five manual
// copy-pastes, and one of those values — LEAD_PII_ENC_KEY — must match the local one
// EXACTLY forever. A single mistyped character there does not fail loudly: leads keep
// saving, and every one of them becomes undecryptable. Reading straight from .env
// removes the hand entirely.
//
//   node scripts/push-secrets.mjs [--dry-run]
//
// .env is git-ignored and never committed. This script reads it, never prints a value,
// and never writes one anywhere but Cloudflare.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** The `context:"server", access:"secret"` entries in astro.config.mjs. */
const SECRETS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_POOL_URL',
  'LEAD_PII_ENC_KEY',
  'AUDIT_HMAC_KEY',
  'NOTIFY_LEAD_SECRET',
];

/** Optional — the AI proxy is a 501 stub, so a missing key is not an error. */
const OPTIONAL = new Set(['ANTHROPIC_API_KEY', 'SUPABASE_DB_POOL_URL']);

const dryRun = process.argv.includes('--dry-run');

function readEnv() {
  let raw;
  try {
    raw = readFileSync('.env', 'utf8');
  } catch {
    console.error('No .env found. Copy .env.example and fill it in first.');
    process.exit(1);
  }
  const out = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    // Only split on the FIRST '=' — a connection string is full of them.
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

const env = readEnv();
const names = [...SECRETS, ...(env.has('ANTHROPIC_API_KEY') ? ['ANTHROPIC_API_KEY'] : [])];

// Refuse the whole run if any value is still a placeholder. Pushing half the secrets
// and failing on the rest leaves a Worker that boots and then 500s on its first
// database call, which is a much worse place to debug from than "nothing deployed".
const missing = names.filter((name) => {
  const value = env.get(name);
  return !value || value.startsWith('REPLACE_') || value.includes('REPLACE_');
});
if (missing.length > 0) {
  console.error('These are still placeholders in .env:\n  ' + missing.join('\n  '));
  console.error('\nFill them in and re-run. Nothing was pushed.');
  process.exit(1);
}

for (const name of names) {
  const value = env.get(name);
  if (!value && OPTIONAL.has(name)) continue;

  if (dryRun) {
    console.log(`would push ${name} (${value.length} chars)`);
    continue;
  }

  // Value goes over stdin, never argv — argv is visible in `ps` and lands in shell
  // history.
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\nFailed on ${name}. Fix and re-run — already-pushed secrets are idempotent.`);
    process.exit(1);
  }
  console.log(`pushed ${name}`);
}

console.log(
  dryRun
    ? '\nDry run complete — nothing pushed.'
    : '\nAll secrets pushed. Public vars (PUBLIC_*) are NOT secrets: set them as plain\n' +
        'variables in the Cloudflare dashboard or [vars] in wrangler.jsonc.',
);
