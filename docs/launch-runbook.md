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

### 6a. After the UI v2 brand deploy — retire the old brand from the SEO defaults

Since UI v2 PR2 every title is `%brand% | %s` with the brand read from `site_profile`.
Anything an editor typed into **SEO → Global SEO defaults** before that still holds the
old spelling as literal text, and a stored template wins over the code default. Look
first, then switch only values that still name the old brand — a compare-and-set, so a
value the SEO team has authored since is never overwritten:

```sql
-- 1. What does this database hold? (the defaults, and any per-page override naming the old brand)
select title_template, default_title, default_description, organization from public.seo_defaults;
select entity_type, entity_id, meta_title, meta_description
  from public.entity_seo
 where meta_title::text ilike '%braiin station%' or meta_description::text ilike '%braiin station%'
    or meta_title::text like '%بريين%' or meta_description::text like '%بريين%';

-- 2. A template that spells the old brand → the token form (the same as leaving it empty).
update public.seo_defaults
   set title_template = '{"en":"%brand% | %s","ar":"%brand% | %s"}'::jsonb
 where title_template::text ilike '%braiin station%'
    or title_template::text like '%بريين%';

-- 3. A default title that IS the old brand would render "Braiin Statiion | Braiin Station".
update public.seo_defaults
   set default_title = '{}'::jsonb
 where default_title::text ilike '%braiin station%'
    or default_title::text like '%بريين%';

-- 4. Descriptions and per-page overrides: swap the old name for the %brand% token rather
--    than erasing the text. resolveSeo substitutes it, and a title that then names the
--    brand is used as is (no second "Braiin Statiion | " prefix).
update public.seo_defaults
   set default_description = regexp_replace(regexp_replace(default_description::text,
         'braiin station', '%brand%', 'gi'), 'بريين ستيشن', '%brand%', 'g')::jsonb
 where default_description::text ilike '%braiin station%'
    or default_description::text like '%بريين%';
update public.entity_seo
   set meta_title = regexp_replace(regexp_replace(meta_title::text,
         'braiin station', '%brand%', 'gi'), 'بريين ستيشن', '%brand%', 'g')::jsonb,
       meta_description = regexp_replace(regexp_replace(meta_description::text,
         'braiin station', '%brand%', 'gi'), 'بريين ستيشن', '%brand%', 'g')::jsonb
 where meta_title::text ilike '%braiin station%' or meta_description::text ilike '%braiin station%'
    or meta_title::text like '%بريين%' or meta_description::text like '%بريين%';
```

Re-run the two `select`s from step 1: both must now come back clean.

`organization` is no longer read (the Organization schema is built from the public
identity); it can stay as it is. Re-check a title afterwards:
`curl -s $BASE/ | grep -o '<title>[^<]*'` should print `Braiin Statiion | …`.

### 6b. UI v2 content model (migrations 0020–0025) — before merging PR4a

The order is the §1 order: migrations, then `production.sql`, then merge. Three things to
know first:

- **Pre-flight.** Three new CHECKs are added `NOT VALID` and then validated; a legacy row
  that fails one leaves it unvalidated with a WARNING (still enforced on every new or
  edited row). Look before applying so a warning is expected rather than a surprise:

  ```sql
  select id, slug from public.portfolio where lower(slug::text) = 'all';           -- expect none
  select id from public.media_assets
   where (width is null) <> (height is null) or width > 12000 or height > 12000;   -- expect none
  ```

- **What goes live.** 0024 lets visitors read a media asset *only* while published or
  visible content references it, and only `static` / `cf_images` / `stream` rows — every
  existing (`external`) row stays private. 0022 makes a PUBLISHED project's services
  public (its drafts' stay private).
- **What the seed adds** (`production.sql`, all idempotent): the 30 showreel stills as
  `static` media, 6 sectors, the 8 marquee clients (visible — they are already on the live
  site), and the design's sample projects, quotes, statistics and leadership as
  **drafts / hidden** with `is_placeholder = true`. From 0025 the database refuses to
  publish one of those while `is_placeholder` is set (clear it when the content is real).

After the seed, confirm nothing placeholder is live:

```sql
select kind, entity_type, slug from public.dashboard_attention
 where kind = 'placeholder_live';                                          -- expect none
```

**Service copy (owner sign-off).** Fresh environments get the mockup's service titles and
blurbs; production keeps whatever it holds (seeds never overwrite). Once the owner approves
the new copy, apply it as a compare-and-set — only rows still holding the old seeded text
change:

```sql
-- Generated from supabase/seed-data/10-services.json (old seed value → mockup value).
begin;
update public.services set blurb = '{"en":"Identity systems that make brands unmistakable.","ar":"أنظمة هوية تجعل العلامة لا تُخطئها العين."}'::jsonb
 where slug = 'branding' and blurb = '{"en":"Identity systems that make brands unmistakable.","ar":"أنظمة هوية تجعل العلامات لا تُنسى."}'::jsonb;
update public.services set title = '{"en":"Animation","ar":"الرسوم المتحركة"}'::jsonb
 where slug = 'animations' and title = '{"en":"Animations","ar":"الرسوم المتحركة"}'::jsonb;
update public.services set title = '{"en":"Motion Graphics","ar":"الموشن جرافيك"}'::jsonb
 where slug = 'motion-graphics' and title = '{"en":"Motion Graphics","ar":"موشن جرافيك"}'::jsonb;
update public.services set blurb = '{"en":"Design in motion, for screens of every size.","ar":"تصميم متحرّك لكل مقاس شاشة."}'::jsonb
 where slug = 'motion-graphics' and blurb = '{"en":"Design in motion for screens of every size.","ar":"تصميم متحرك لكل الشاشات."}'::jsonb;
update public.services set title = '{"en":"Videography","ar":"الإنتاج المرئي"}'::jsonb
 where slug = 'videography' and title = '{"en":"Videography","ar":"إنتاج الفيديو"}'::jsonb;
update public.services set blurb = '{"en":"Cinematic production, end to end.","ar":"إنتاج سينمائي من الفكرة إلى التسليم."}'::jsonb
 where slug = 'videography' and blurb = '{"en":"Cinematic production end to end.","ar":"إنتاج سينمائي من الفكرة إلى التسليم."}'::jsonb;
update public.services set blurb = '{"en":"Images that sell the moment.","ar":"صور تبيع اللحظة."}'::jsonb
 where slug = 'photography' and blurb = '{"en":"Images that sell the moment.","ar":"صور تروي اللحظة."}'::jsonb;
update public.services set blurb = '{"en":"Experiences planned down to the detail.","ar":"تجارب مخططة حتى آخر تفصيل."}'::jsonb
 where slug = 'event-planning' and blurb = '{"en":"Experiences planned down to the detail.","ar":"تجارب مُخطَّطة حتى أدق التفاصيل."}'::jsonb;
update public.services set title = '{"en":"Advertising","ar":"الإعلان"}'::jsonb
 where slug = 'advertising' and title = '{"en":"Advertising","ar":"الإعلانات"}'::jsonb;
update public.services set title = '{"en":"Social Media","ar":"السوشيال ميديا"}'::jsonb
 where slug = 'social-media' and title = '{"en":"Social Media","ar":"وسائل التواصل"}'::jsonb;
update public.services set blurb = '{"en":"Always-on presence that converts.","ar":"حضور دائم يتحوّل إلى نتائج."}'::jsonb
 where slug = 'social-media' and blurb = '{"en":"Always-on presence that converts.","ar":"حضور دائم يحقق النتائج."}'::jsonb;
update public.services set title = '{"en":"SEO / GEO / AEO","ar":"تحسين الظهور SEO / GEO / AEO"}'::jsonb
 where slug = 'seo-geo-aeo' and title = '{"en":"SEO / GEO / AEO","ar":"تحسين محركات البحث"}'::jsonb;
update public.services set blurb = '{"en":"Be found by people and by AI answer engines.","ar":"أن تُوجد أمام الناس وأمام محركات الإجابة."}'::jsonb
 where slug = 'seo-geo-aeo' and blurb = '{"en":"Be found by people and AI answer engines.","ar":"ظهور أمام الناس ومحركات الإجابة بالذكاء الاصطناعي."}'::jsonb;
update public.services set short_title = '{"en":"SEO / GEO / AEO","ar":"تحسين الظهور"}'::jsonb
 where slug = 'seo-geo-aeo' and short_title is null;
update public.services set blurb = '{"en":"Original sound and scoring.","ar":"موسيقى أصلية وتوزيع صوتي."}'::jsonb
 where slug = 'music' and blurb = '{"en":"Original sound and scoring.","ar":"موسيقى وتلحين أصلي."}'::jsonb;
update public.services set blurb = '{"en":"Branded products people actually keep.","ar":"منتجات بعلامتك يحتفظ بها الناس."}'::jsonb
 where slug = 'merchandise' and blurb = '{"en":"Branded products people keep.","ar":"منتجات تحمل العلامة ويحتفظ بها الناس."}'::jsonb;
update public.services set blurb = '{"en":"Worlds, assets, and in-game brand work.","ar":"عوالم وأصول وحضور داخل اللعبة."}'::jsonb
 where slug = 'gaming' and blurb = '{"en":"Coming soon.","ar":"قريبًا."}'::jsonb;
commit;
```

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
