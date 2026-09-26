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
// 2. Server env (astro:env `context: 'server'`). `wrangler dev` finds it in the project's
//    own .env / .dev.vars — which is why every local run works and CI, which has neither,
//    booted a Worker with no secrets that died on its first getSecret ("SUPABASE_DB_POOL_URL
//    is missing"). It does NOT read the adapter's dist/server/.dev.vars (measured: a
//    populated one there was ignored). So this writes the server variables present in the
//    process environment to dist/server/.preview.env, and the workflow passes that file
//    explicitly:  npx wrangler dev --env-file dist/server/.preview.env
//    The names come from astro.config.mjs's env schema, so a new secret needs no edit here.
//
// wrangler.jsonc — and therefore every deploy — is untouched. dist/server is not the
// assets directory (wrangler.jsonc serves dist/client), so neither file is ever served.
//
//   Locally (uses your .env):  npm run build && node scripts/local-preview-config.mjs \
//                              && npx wrangler dev --port 8788
//   CI (no .env):              … && npx wrangler dev --port 8788 --env-file dist/server/.preview.env

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG = 'dist/server/wrangler.json';
const PREVIEW_ENV = 'dist/server/.preview.env';

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

// ---- 2. server env → .preview.env --------------------------------------------
const schema = readFileSync('astro.config.mjs', 'utf8');
const serverVars = [
  ...schema.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*envField\.\w+\(\{[^}]*context:\s*'server'/gm),
].map((m) => m[1]);

// Written for dotenv's rules, which do NOT unescape `\"` or `\\` inside double quotes —
// escaping would corrupt the value. Double quotes for plain values; single quotes (fully
// literal in dotenv) when the value has a double quote or a backslash; refuse the rest.
const quote = (name, v) => {
  if (/[\r\n]/.test(v)) throw new Error(`${name}: multi-line values are not supported here`);
  if (!/["\\]/.test(v)) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  throw new Error(`${name}: value contains both quote kinds — cannot be written to ${PREVIEW_ENV}`);
};

const lines = [];
const found = [];
for (const name of serverVars) {
  const value = process.env[name];
  if (value === undefined || value === '') continue;
  lines.push(`${name}=${quote(name, value)}`);
  found.push(name);
}
writeFileSync(PREVIEW_ENV, lines.length ? `${lines.join('\n')}\n` : '');

const absent = serverVars.filter((n) => !found.includes(n));
console.log(
  `  ✓ ${PREVIEW_ENV}: ${found.length ? found.join(', ') : 'no server variables in the environment'}` +
    (absent.length ? ` — not in the environment: ${absent.join(', ')}` : ''),
);
