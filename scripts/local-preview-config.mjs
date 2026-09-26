// Makes the BUILT worker previewable without Cloudflare credentials or a local .env.
//
// Two things stand between `npm run build` and a working `wrangler dev` in CI
// (perf-seo-a11y.yml) or on a machine that isn't logged in to Cloudflare:
//
// 1. wrangler.jsonc marks the SESSION KV namespace `"remote": true`, so `wrangler dev`
//    binds the real namespace — which needs an authenticated wrangler. This rewrites only
//    the adapter's generated copy (dist/server/wrangler.json), dropping `remote` so
//    miniflare simulates the namespace locally.
//
// 2. Server env (astro:env `context: 'server'`) reaches `wrangler dev` through
//    dist/server/.dev.vars, and the adapter builds that file from `.env*` FILES only —
//    never from the process environment. CI has no .env, so the Worker booted with no
//    secrets and died on its first `getSecret` ("SUPABASE_DB_POOL_URL is missing"). Any
//    server variable present in the process env and absent from .dev.vars is appended
//    here. The names come from astro.config.mjs's env schema, so this cannot drift.
//
// wrangler.jsonc — and therefore every deploy — is untouched. dist/server is not the
// assets directory (wrangler.jsonc serves dist/client), so .dev.vars is never served.
//
//   npm run build && node scripts/local-preview-config.mjs && npx wrangler dev --port 8788

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG = 'dist/server/wrangler.json';
const DEV_VARS = 'dist/server/.dev.vars';

if (!existsSync(CONFIG)) {
  console.error(`  ✘ ${CONFIG} not found — run \`npm run build\` first.`);
  process.exit(1);
}

// ---- 1. remote bindings → local simulation -----------------------------------
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
let stripped = 0;
for (const key of ['kv_namespaces', 'r2_buckets', 'd1_databases']) {
  for (const binding of config[key] ?? []) {
    if (binding.remote) {
      delete binding.remote;
      stripped += 1;
    }
  }
}
writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
console.log(`  ✓ ${CONFIG}: ${stripped} remote binding(s) switched to local simulation.`);

// ---- 2. server env → .dev.vars -----------------------------------------------
const schema = readFileSync('astro.config.mjs', 'utf8');
const serverVars = [
  ...schema.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*envField\.\w+\(\{[^}]*context:\s*'server'/gm),
].map((m) => m[1]);

const existing = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : '';
const present = new Set(
  existing
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter(Boolean),
);

// Written for the parser wrangler uses (dotenv), which does NOT unescape `\"` or `\\` inside
// double quotes — it only expands `\n`/`\r`. Escaping would therefore corrupt the value.
// Double quotes for plain values; single quotes (fully literal in dotenv) when the value has
// a double quote or a backslash; refuse anything neither form can carry.
const quote = (name, v) => {
  if (/[\r\n]/.test(v)) throw new Error(`${name}: multi-line values are not supported here`);
  if (!/["\\]/.test(v)) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  throw new Error(`${name}: value contains both quote kinds — add it to ${DEV_VARS} by hand`);
};
const added = [];
let out = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
for (const name of serverVars) {
  const value = process.env[name];
  if (present.has(name) || value === undefined || value === '') continue;
  out += `${name}=${quote(name, value)}\n`;
  added.push(name);
}
if (added.length) writeFileSync(DEV_VARS, out);

const missing = serverVars.filter((n) => !present.has(n) && !added.includes(n));
console.log(
  `  ✓ ${DEV_VARS}: ${added.length ? `added ${added.join(', ')} from the environment` : 'nothing to add'}` +
    (missing.length
      ? ` — not set anywhere (fine if optional/defaulted): ${missing.join(', ')}`
      : ''),
);
