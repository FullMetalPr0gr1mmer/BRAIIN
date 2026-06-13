# Provisioning Runbook — Braiin Station

How to take the repo from "builds locally" to "live on Cloudflare with a real database."
Covers Jira **KAN-19** (Supabase) and **KAN-20** (Cloudflare). **Never paste secrets into
chat or commit them** — they live in Cloudflare Worker Secrets / Supabase Vault.

## 0. Prerequisites

- Node 20+, npm; the repo cloned; `npm ci` run.
- Accounts: **Supabase**, **Cloudflare** (Workers + Stream), GitHub.
- CLIs: `npm i -g supabase wrangler` (or use `npx`).

---

## Part A — Supabase (KAN-19)

1. **Create the project.** Pick the region closest to KSA (e.g. `me-central-1` if available, else `eu-central-1`). Note the **project ref**.
2. **Grab the keys** (Project Settings → API): Project URL, **anon** key (public), **service-role** key (SECRET).
3. **Link the CLI:**
   ```bash
   supabase login
   supabase link --project-ref <your-ref>
   ```
4. **Apply migrations** (0001–0003) to the remote DB:
   ```bash
   supabase db push
   ```
5. **Seed** the launch tenant + 14 services. Locally `supabase db reset` runs `seed.sql`; for the remote DB run it once via the SQL editor or:
   ```bash
   psql "<DIRECT_DB_URL :5432>" -f supabase/seed.sql
   ```
6. **Vault — audit HMAC key** (the append-only audit chain reads this; inserts fail without it):
   ```sql
   select vault.create_secret(encode(gen_random_bytes(32), 'base64'), 'audit_hmac_key');
   ```
7. **Custom Access Token Hook** (Auth → Hooks) — inject `app_metadata.role` + `app_metadata.tenant_id` into the JWT. Full role wiring is Phase 3; the **anon tenant fence** already works without it (anon resolves to the single seeded tenant).
8. **Connection pooling** — copy the **Supavisor transaction-mode** URL (`:6543`, `pgbouncer=true`) from Settings → Database → Connection pooling. Use `:5432` only for migrations + `pg_cron`.
9. **Telemetry retention** — schedule the `pg_cron` jobs noted in `migrations/0002` (monthly partition roll-forward + drop partitions older than `RAW_TELEMETRY_RETENTION` = 90d). Pending the legal sign-off (KAN-22).
10. **Enable the DB test gate** — flip `.github/workflows/db-tests.yml` from `workflow_dispatch` to `push`/`pull_request` once `supabase test db` is green; it becomes the per-role authz gate (CLAUDE.md §9).

---

## Part B — Cloudflare (KAN-20)

1. **Workers project** — create a Workers Build connected to the GitHub repo (build: `npm run build`), or deploy manually with `wrangler deploy`. (Astro adapter targets **Workers**, not Pages.)
2. **KV namespace** (sessions + maintenance/redirect snapshots):
   ```bash
   wrangler kv namespace create SESSION
   wrangler kv namespace create SESSION --preview
   ```
   Paste the returned `id` / `preview_id` into `wrangler.jsonc`.
3. **Secrets** (server-only — never in `wrangler.jsonc`):
   ```bash
   wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   wrangler secret put SUPABASE_DB_POOL_URL
   wrangler secret put LEAD_PII_ENC_KEY        # 32-byte base64
   wrangler secret put AUDIT_HMAC_KEY          # same value as the Vault secret
   wrangler secret put NOTIFY_LEAD_SECRET
   wrangler secret put ANTHROPIC_API_KEY       # optional until Phase 4
   ```
   **Public** vars (`PUBLIC_SITE_URL`, `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`) go in the dashboard `[vars]` / `wrangler.jsonc` `vars` — these are client-safe.
4. **Images binding** — bind `IMAGES` (Cloudflare Images) for the adapter's `imageService`.
5. **Cloudflare Stream** — enable Stream; copy your **customer subdomain** (`customer-<code>.cloudflarestream.com`) and set `CUSTOMER_SUBDOMAIN` in `src/lib/video/stream.ts` (or promote it to a `PUBLIC_STREAM_SUBDOMAIN` env). Upload the 14 service hero videos; put each video's UID on its service row (`services.hero_video_uid`).
6. **WAF / rate limits:**
   - `/api/ai/style-finder` → **60/hr/IP** block; `/api/search/suggest` → 30/min/IP; `/notify-lead` rate-limited.
   - Block the **training-crawler** user-agent set (same tokens as `src/lib/seo/crawlers.ts`): `GPTBot, ClaudeBot, Google-Extended, CCBot, Applebot-Extended, Meta-ExternalAgent`. Allow retrieval crawlers.
7. **(Optional) trailing-slash 301** — the app uses `trailingSlash: 'ignore'` + canonical consolidation. If you prefer hard 301s, add a Cloudflare redirect rule `/(.*)/ → /$1`.
8. **Custom domain + TLS** — set `site` in `astro.config.mjs` to the real origin; add the domain, DNS, and confirm HSTS preload.
9. **Deploy** — push to the connected branch or `wrangler deploy`.

---

## Part C — Smoke test (Definition of Done)

- `/`, `/ar`, `/services` render the **14 seeded services**; a service detail shows its Stream hero.
- Response headers: **CSP without `unsafe-inline`**, HSTS, nosniff, Referrer-Policy.
- `/robots.txt`, `/llms.txt`, `/sitemap.xml` include the services (both locales).
- `db-tests` CI green; an `audit_log` insert produces a non-empty `hash` (chain works).
- Consent banner gates analytics; no RUM rows without consent.

---

## Secrets checklist (never commit; not in `wrangler.jsonc`)

| Variable | Where it lives | Secret? |
|---|---|---|
| `PUBLIC_SITE_URL`, `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` | Cloudflare vars / dashboard | No (client-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker Secret | **Yes** |
| `SUPABASE_DB_POOL_URL` | Worker Secret | **Yes** |
| `LEAD_PII_ENC_KEY` | Worker Secret | **Yes** |
| `AUDIT_HMAC_KEY` | Worker Secret **+** Supabase Vault | **Yes** |
| `NOTIFY_LEAD_SECRET` | Worker Secret | **Yes** |
| `ANTHROPIC_API_KEY` | Worker Secret (Phase 4) | **Yes** |
