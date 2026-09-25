// Makes the BUILT worker config previewable without Cloudflare credentials.
//
// wrangler.jsonc marks the SESSION KV namespace `"remote": true`, so `wrangler dev` binds
// the real namespace — which needs an authenticated wrangler. In CI (perf-seo-a11y.yml)
// and on a machine that isn't logged in, `wrangler dev` then fails before serving a page.
//
// The fix belongs to the preview, not the source: this rewrites only the adapter's
// generated copy (dist/server/wrangler.json), dropping `remote` so miniflare simulates the
// namespace locally. wrangler.jsonc — and therefore every deploy — is untouched.
//
//   npm run build && node scripts/local-preview-config.mjs && npx wrangler dev --port 8788

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = 'dist/server/wrangler.json';

if (!existsSync(FILE)) {
  console.error(`  ✘ ${FILE} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(FILE, 'utf8'));
let stripped = 0;
for (const key of ['kv_namespaces', 'r2_buckets', 'd1_databases']) {
  for (const binding of config[key] ?? []) {
    if (binding.remote) {
      delete binding.remote;
      stripped += 1;
    }
  }
}
writeFileSync(FILE, `${JSON.stringify(config, null, 2)}\n`);
console.log(`  ✓ ${FILE}: ${stripped} remote binding(s) switched to local simulation.`);
