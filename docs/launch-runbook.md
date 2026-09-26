# Launch runbook — Braiin Station MVP

> Everything here is a step that **cannot** be done from the repository: it needs the
> Supabase dashboard, Cloudflare dashboard, or a secret that must never be committed.
> The code is complete without them; the product does not work without them.
>
> Order matters. Steps 1–4 are hard blockers — nothing else can even be tested until
> they are done. Run them top to bottom.

---

## 0. Before you start

| You need | Where |
|---|---|
| Supabase project (prod) | `braiin-prod` |
| Cloudflare account with Workers, KV, Images, Stream | dash.cloudflare.com |
| A real email address for the first admin | — |

```bash
npm ci
npx supabase link --project-ref <prod-ref>
```

---

## 1. Apply migrations  ⛔ blocker

```bash
npx supabase db push          # applies every migration not yet recorded in production
```

**Order for every change that ships a migration: apply it here FIRST, then merge.**
Merging to `main` auto-deploys the Worker; code that reads a column production does not
have yet fails closed to empty content (§5a's deploy guard refuses such a deploy once
configured).

### 1a. Mark this database as production  ⛔ blocker — immediately after 0016

Migration 0016 creates `app.deployment`, the marker that tells the database which
environment it is. It arms the production-only guards: `supabase/seed.sql` refuses to run
(it publishes design placeholders), and from migration 0025 a placeholder row cannot be
published or made visible. **Unset, production behaves like staging.**

```sql
insert into app.deployment (env) values ('production')
  on conflict (singleton) do update set env = excluded.env, set_at = now();
select env, set_at from app.deployment;          -- expect exactly: production
```

Staging gets `'staging'` the same way. Local / CI need nothing (unset ≠ production).

### 1b. Seed content

Seeds are GENERATED from `supabase/seed-data/*.json` (`npm run seed:gen`); never hand-edit
the `.sql` files — `tests/seed/seeds.spec.ts` fails if they drift.

```bash
# Production — every design placeholder lands as a DRAFT / hidden row for editors to
# replace and publish. Idempotent: never overwrites a row an editor has changed.
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/production.sql

# Staging — placeholders PUBLISHED so the environment matches the approved mockup.
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

`-v ON_ERROR_STOP=1` is load-bearing: without it psql keeps executing after the seed's
production guard raises. Each file is one transaction, so a failure applies nothing.

**Legacy rows (owner sign-off required).** Production may already hold the pre-UI-v2 demo
content (three case studies, "150+ / 14 / 8" statistics, role-titled team members, two
blog posts) as PUBLISHED rows — the seeds only ever insert-if-absent, so they will not
demote what is already there. Archiving them is an owner decision, taken after real
content exists, and is not automated.

`0010_launch_readiness.sql` generates the audit HMAC key into Supabase Vault on first
run. Verify it landed — **if this row is missing, every admin write returns 500**,
because `audit_log`'s BEFORE INSERT trigger raises when the key is absent:

```sql
select name from vault.secrets where name = 'audit_hmac_key';
-- expect exactly one row
```

## 2. Enable the Custom Access Token Hook  ⛔ blocker

Migration 0010 **creates** `public.custom_access_token_hook`, but Supabase will not call
it until it is enabled in the dashboard.

> Dashboard → **Authentication → Hooks → Customize Access Token (JWT) Claims** →
> select `public.custom_access_token_hook` → **Enable**.

Until this is on, **every login is correctly refused**: the JWT carries no
`app_metadata.role`, so `resolveAuthContext` treats the session as anonymous and RLS
resolves the user into the anon fence. This is the single most common "the CMS is
broken" cause — it is not broken, it is unclaimed.

## 3. Create and promote the first admin  ⛔ blocker

`users.manage` is Admin-only, so there is no in-product path to the first admin.

1. Dashboard → **Authentication → Users → Add user** → email + password → *Auto Confirm*.
2. Then, in the SQL editor:

```sql
select public.bootstrap_admin('you@braiinstation.com');
```

That writes the `profiles` row **and** mirrors the claim into `auth.users.raw_app_meta_data`,
so the row and the JWT agree. They must: `src/lib/auth/context.ts` treats any divergence
as a dead session.

Verify:

```sql
select p.role, p.is_active, u.raw_app_meta_data->>'role' as jwt_role
  from public.profiles p join auth.users u on u.id = p.id;
-- role = admin, is_active = true, jwt_role = admin
```

## 4. Worker secrets  ⛔ blocker

Never in `.env`, never in `wrangler.jsonc`.

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put LEAD_PII_ENC_KEY        # openssl rand -hex 32
npx wrangler secret put AUDIT_HMAC_KEY          # unused by the Worker; see note
npx wrangler secret put NOTIFY_LEAD_SECRET      # openssl rand -hex 32
npx wrangler secret put ANTHROPIC_API_KEY       # optional — Style-Finder is a 501 stub
```

`LEAD_PII_ENC_KEY` is the one that cannot be rotated casually: it decrypts every stored
lead. Back it up somewhere that is not this repository before any lead is submitted.

> **Note on `AUDIT_HMAC_KEY`:** the audit chain is keyed from **Supabase Vault**, not
> from this variable — the hash is computed by a database trigger so that no caller,
> including service-role, can skip or forge it. The `astro:env` entry exists because the
> schema declares it; the Vault secret from step 1 is the one that matters.

Public vars (`wrangler.jsonc` / dashboard vars, not secrets):
`PUBLIC_SITE_URL`, `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`.

---

## 5. Extensions and scheduled jobs

Migration 0010 registers the cron jobs **only if `pg_cron` is already installed**. Enable
the extensions first, then re-run the migration's job block.

> Dashboard → **Database → Extensions** → enable `pg_cron`, `pg_net`.

```sql
select cron.schedule('publish-scheduled',    '*/5 * * * *',  $$ select app.publish_scheduled() $$);
select cron.schedule('rollup-pageviews',     '*/15 * * * *', $$ select app.rollup_pageviews(3) $$);
select cron.schedule('telemetry-retention',  '0 3 * * *',    $$ select app.run_retention() $$);
select cron.schedule('telemetry-partitions', '0 2 25 * *',   $$ select app.ensure_telemetry_partitions(2) $$);
select jobname, schedule from cron.job;
```

`pg_net` enables the lead-notification trigger. It is created by 0010 only when the
extension exists, so after enabling it:

```sql
create trigger leads_notify after insert on public.leads
  for each row execute function app.tg_notify_lead();

-- Where the trigger posts, and the shared secret it presents:
update public.site_settings
   set identity = identity || jsonb_build_object(
         'notify_lead_url', 'https://www.braiinstation.com/api/hooks/notify-lead')
 where tenant_id = (select id from public.tenants order by created_at limit 1);

select vault.create_secret('<same value as NOTIFY_LEAD_SECRET>', 'notify_lead_secret',
  'Bearer token the leads_notify trigger presents to the Worker');
```

**Cron runs on the direct `:5432` connection, never the Supavisor pooler** — pg_cron
holds a session, which transaction-mode pooling cannot provide.

## 5a. Deploy guard role (CI refuses to deploy ahead of migrations)

Merging to `main` auto-deploys the Worker, but migrations are applied by hand (§1). The
deploy job runs `scripts/deploy-guard.sh` first, which fails the deploy when production is
missing any migration in the repo. **Order for every change that ships a migration:
apply it to production (§1) → merge → auto-deploy.** Code first is how content silently
vanishes: loaders fail closed to empty results, not to an error page.

The guard reads two things and nothing else, so it gets its own read-only role — never
the `postgres` password:

```sql
create role deploy_guard login password '<openssl rand -hex 24>'
  nosuperuser nocreatedb nocreaterole noinherit;
grant usage on schema supabase_migrations to deploy_guard;
grant select on supabase_migrations.schema_migrations to deploy_guard;
-- Once migration 0016 is applied (it creates the app.deployment marker):
grant usage on schema app to deploy_guard;
grant select on app.deployment to deploy_guard;
```

The grant alone is not what lets the guard read the marker: `app.deployment` has row
security FORCED, and `deploy_guard` is NOBYPASSRLS, so it reads through the one policy
0016 creates for it (`deployment_read_deploy_guard`, `current_user = 'deploy_guard'`).
Verify with the guard's own credentials, after §1a — it must print `production`, not an
empty result:

```bash
psql "$SUPABASE_GUARD_DB_URL" -At -c "select env from app.deployment"
```

Store the connection URL as the repository secret **`SUPABASE_GUARD_DB_URL`** (Settings →
Secrets and variables → Actions), using the session pooler on `:5432`:
`postgresql://deploy_guard.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
While the secret is absent the guard step skips with a warning, exactly like the deploy
step does without its Cloudflare secrets.

---

## 6. Deploy

```bash
npm run build
npx wrangler deploy
```

Bindings required in `wrangler.jsonc`: `SESSION` (KV), `IMAGES`.
The KV binding is load-bearing beyond sessions — maintenance mode is read from it before
the edge-cache lookup.

---

## 7. Cloudflare WAF (CLAUDE.md §3)

Not code; nothing enforces these until they are created.

| Rule | Action |
|---|---|
| `/api/search` | rate-limit 30/min/IP → block |
| `/api/ai/style-finder` | rate-limit **60/hr/IP** → block (not 10/60s) |
| `/api/hooks/notify-lead` | rate-limit; the endpoint is bearer-authenticated but unbounded by retry |
| `/api/analytics`, `/api/rum` | rate-limit per IP — unauthenticated paths to a service-role write |
| Training crawlers | block `GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`, `Applebot-Extended`, `Meta-ExternalAgent` |
| Retrieval crawlers | **allow** `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `Bingbot` |

The crawler lists must match `src/lib/seo/crawlers.ts` — `tests/seo/crawlers.spec.ts`
snapshot-tests the code-owned map against robots.txt, but nothing can test the WAF.

---

## 8. Smoke test

```bash
BASE=https://www.braiinstation.com

curl -s -o /dev/null -w '%{http_code}\n' $BASE/healthz                    # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $BASE/admin      # 302 → /admin/login
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/admin/services         # 401
curl -s -X POST -d '{}' -o /dev/null -w '%{http_code}\n' $BASE/api/admin/services  # 403 (csrf)
curl -sI $BASE/admin/login | grep -i 'cache-control\|content-security'    # no-store; no unsafe-inline
```

Then in a browser:

1. Sign in at `/admin/login` with the step-3 admin.
2. Create a service, save it as **draft**, then set it to **published** — confirm it
   appears at `/services`.
3. Open `/admin/audit` — the create and the publish are both there, chain contiguous.
4. Submit the public contact form; confirm the lead appears at `/admin/leads`, and that
   **Reveal contact details** writes a `lead.view_pii` row to the audit log.
5. Accept analytics consent, reload twice, wait for the rollup (≤15 min), and confirm
   `/admin/analytics` is non-zero.

---

## 9. Known-outstanding at MVP

These are **deliberately not** in the launch path. None blocks going live; each is a
commitment CLAUDE.md makes that is not yet met, and each should be tracked.

| Item | Where it bites | CLAUDE.md |
|---|---|---|
| `notify-lead` dispatches to no channel yet — it authenticates, gates fields, and writes `notification_log`, but sends no email | Sales sees leads in the CMS, not the inbox | §10 |
| Hourly audit-chain anchor to object-locked R2 + paging verifier | Chain contiguity is checked per page in the UI; tamper detection against an external anchor is not running | §3, §10 |
| Outbound CRM webhook HMAC (`X-Braiin-Signature`) | No CRM integration yet | §10 |
| Synthetic monitors (MENA, 60s) | No external uptime signal | §10 |
| PITR + off-platform `pg_dump` to a separate-account R2; quarterly restore drill | Supabase's own backups only | §10 |
| Playwright per-role negative-authz e2e | Covered at unit + pgTAP level; not end-to-end in a browser | §9 |
| `RAW_TELEMETRY_RETENTION` legal sign-off | Implemented at 90 days, capped so it can only shorten | Pillar 4 |
| CSP Report-Only cycle | Shipping **enforcing** from day one. Watch `/api/clientlog` for violations in week 1 and be ready to flip `CSP_REPORT_ONLY` in `src/middleware.ts` | §3 |

---

## 10. Rollback

```bash
npx wrangler rollback            # previous Worker version, seconds
```

Migrations are forward-only (expand/contract), so a Worker rollback is always safe: an
older Worker never sees a column it does not know about, only extra ones it ignores.
