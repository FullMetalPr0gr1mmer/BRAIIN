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

> **Superseded by §6d (Round 2, 2026-09-27)** for the services: the cut-over renames, re-copies
> or archives every row below. Kept as the record of what round 1 applied — its titles are what
> the §6d renames compare against.

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

### 6c. Showing the design delivery before real content exists (migrations 0027, 0028)

Owner decision 2026-09-26: until real content replaces it, production shows the design delivery as is:

- **Shown:** the sample projects and case studies, the sample statistics, the leadership cards, and the placeholder clients.
- **Hidden:** the invented testimonial quotes. *(Superseded 2026-09-27: the owner decided to show the sample quotes too — see "Round 2" below. Steps 1–4 stay as they were for the five original tables.)*

Every such row keeps `is_placeholder = true`, so the admin dashboard keeps listing it as **Placeholder content is live** until someone replaces it and clears the flag.

1. **Allow the tables.** Run this as the owner (`supabase db query --linked` or psql). Each row is audit-logged with its reason.

   ```sql
   insert into app.placeholder_live_override (tenant_id, table_name, reason)
   select t.id, x.table_name, 'Owner decision 2026-09-26: show the design delivery until real content replaces it'
     from public.tenants t
     cross join (values ('portfolio'), ('statistics'), ('team_members'), ('clients'), ('page_sections')) as x(table_name)
    where t.id = '00000000-0000-0000-0000-0000000000b1'
   on conflict (tenant_id, table_name) do nothing;
   ```

2. **Publish the placeholders.** Testimonials are deliberately absent from this list:

   ```sql
   begin;
   update public.portfolio    set status = 'published', published_at = coalesce(published_at, now())
    where is_placeholder and status = 'draft';
   update public.statistics   set status = 'published'
    where is_placeholder and status = 'draft';
   update public.team_members set status = 'published'
    where is_placeholder and status = 'draft';
   update public.clients      set visible = true
    where is_placeholder and not visible;
   commit;
   ```

3. **Verify.**
   - `select kind, entity_type, slug from public.dashboard_attention where kind = 'placeholder_live';` lists the rows you just published.
   - `select count(*) from public.testimonials where status = 'published';` is `0` *(until the Round 2 step below publishes the samples)*.
   - The pages render the samples.

4. **Taking it back**, per table, once real content exists:
   1. Unpublish the placeholders (`status = 'draft'` / `visible = false`), or replace them and clear `is_placeholder`.
   2. Then `delete from app.placeholder_live_override where table_name = '…';`. This is audit-logged as a revoke.

   With the allowance gone, the 0025 guard holds again: nothing flagged can go live.

#### Round 2 (2026-09-27, migration 0028): sample quotes and service cases

Owner decisions R1 and R3 (2026-09-27): show the **9 sample quotes** (signed "Client name / CEO, Company") and the **28 sample service case blocks** until real ones replace them from the admin. Migration 0028 makes this possible without weakening what protects a real person's words:

- **The override** may now name `testimonials` and `service_cases` (all seven placeholder tables). Nothing else changed about it: owner-only, per (tenant, table), audit-logged on grant and revoke.
- **The consent CHECK** (`testimonials_consent_gate`) now reads "consent recorded, **or** a flagged design sample". A real quote still cannot be published or scheduled without consent, by any role.
- **The sample lock** (`app.tg_testimonial_sample_lock`) holds for every staff session (any JWT with a staff role, i.e. the admin and PostgREST): nobody can create a sample, flag an existing quote as one, or change a sample's `quote`, `author_name`, `author_role`, `avatar_media_id`, `client_id` or `portfolio_id` while it stays a sample. Only the seed files and the owner's psql session, which carry no JWT, create or edit samples. Without the lock, the override plus the looser CHECK would let anyone flag a real person's quote as a "sample" and publish it without consent.

The Round 2 cut-over (§6d) runs these steps in its overrides transaction; they are here so they can also be run, checked or reversed on their own.

5. **Allow the two tables.** As the owner:

   ```sql
   insert into app.placeholder_live_override (tenant_id, table_name, reason)
   select t.id, x.table_name, 'Owner decision 2026-09-27: show the design samples until real content replaces them'
     from public.tenants t
     cross join (values ('testimonials'), ('service_cases')) as x(table_name)
    where t.id = '00000000-0000-0000-0000-0000000000b1'
   on conflict (tenant_id, table_name) do nothing;
   ```

6. **Publish the samples.** Only flagged rows. A quote without consent that is *not* flagged is refused by the CHECK (23514); that is correct, so leave it as a draft:

   ```sql
   begin;
   update public.testimonials  set status = 'published', published_at = coalesce(published_at, now())
    where is_placeholder and status = 'draft';
   update public.service_cases set status = 'published', published_at = coalesce(published_at, now())
    where is_placeholder and status = 'draft';
   commit;
   ```

   A service case is public only while its **service** is published too; a case on a draft or archived service stays hidden without any further step.

7. **Verify.**
   - `select entity_type, count(*) from public.dashboard_attention where kind = 'placeholder_live' group by 1;` shows the `testimonial` and `service_case` rows.
   - `select action, entity_id, detail ->> 'reason' from public.audit_log where entity_type = 'placeholder_override' order by id desc limit 2;` shows both grants.
   - Home, Our Work and a case study render the quote carousel; a service page renders its case block.

8. **Making a quote real** (Admin → Testimonials; no SQL needed). In **one save**: replace the words and the author, set "Consent obtained" (date and reference), untick "Placeholder". The quote stays published. Two things the database refuses, on purpose:
   - unticking "Placeholder" on a published quote **without** recording consent (23514);
   - editing a sample's words or author while "Placeholder" stays ticked (42501, the sample lock).

   A service case is made real the same way (replace the content, untick "Placeholder"); cases carry no consent record.

9. **Taking it back.** When every quote (or case) is real, or to hide the samples again:
   1. Unpublish what is still flagged: `update public.testimonials set status = 'draft' where is_placeholder and status = 'published';` (and the same for `service_cases`).
   2. `delete from app.placeholder_live_override where table_name in ('testimonials', 'service_cases');`, audit-logged as revokes.

   With the allowance gone, the 0025 guard again refuses any flagged quote or case that tries to go live.

---

### 6d. Round 2: five disciplines, 28 services, sample quotes and cases (migration 0028) — the production cut-over

Owner decisions 2026-09-27: the design's taxonomy replaces the 14 services with **5 disciplines
holding 28 services** (Gaming and Merchandise retired; every old `/services/<slug>` answers a
301); each service page carries a **sample case block**; the **9 sample quotes** go live. Both
kinds of sample stay flagged `is_placeholder` and are replaced from the admin (§6c steps 8–9).

**When.** Immediately before merging the Round 2 stack, in this order. Old code with the new
data only makes lists longer; new code with the old data would hide whole sections.

**The SQL** is generated from the seed data into `supabase/seeds/round2-cutover.sql`
(`scripts/round2-cutover.mjs`; `npm run seed:gen` regenerates it with the seeds, and
`tests/seed/cutover.spec.ts` fails if it is stale), so the copy step 4 writes is the copy fresh
databases get. It is **not one script**: each step runs on its own. Print one and run it as the
owner, exactly like `production.sql` (§1b):

```bash
node scripts/round2-cutover.mjs --step renames > /tmp/r2-renames.sql
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f /tmp/r2-renames.sql
```

Every writing step is **one transaction** whose assertions compare **exact slug sets** (never
counts) and raise on a mismatch, so a failed step applied nothing: read the message, fix the
cause, run that step again. A step run too early refuses (the renames before 0028, the content
and samples steps before `production.sql`). A step that already ran does not run twice: the
renames match no row the second time and fail loudly.

| # | Step | What it does | Must see |
|---|---|---|---|
| 0 | `--step preflight` | Read-only, **before the push**. One JSON: the current services (slug, EN title, status), `entity_seo` of the 8 services that stay, authored `servicesOverview` / `aboutIntro` / `faq` content, SEO text saying "fourteen" / "أربع عشرة", the legacy `services` counter and `crafts`, the round-1 overrides, the 12 sample projects, the header menu. | Renamed slugs still titled Animation (or Animations) / Videography / Montage / Music; overrides for portfolio, statistics, team_members, clients, page_sections. Anything in `entity_seo_8`, `sections_authored` or `fourteen` is reviewed with the owner and fixed after step 4. |
| 1 | `npx supabase db push --linked --dry-run`, then `npx supabase db push --linked --skip-vault` | Migration 0028 (S1a: disciplines, service pages, service cases, the sample lock). Needs a valid Supabase access token. | Only 0028 listed by the dry run. |
| 2 | `--step renames` | In place, keeping the id (so `entity_seo`, `content_versions` and links survive): animations → animation, videography → photo-video, montage → video-editing, music → music-vo-sfx — each a compare-and-set on slug **and** current EN title, refused onto an existing slug, and exactly one row. Archives branding, photography, event-planning, web-development, merchandise, gaming (restorable). | `COMMIT`. |
| 3 | `--step rehearse`, then `production.sql` | The rehearsal is `production.sql` statement for statement inside `BEGIN … ROLLBACK`: it writes nothing and lists every row the seed would insert, `this_round = false` first. This round adds exactly: 14 `media_assets` (`stills/services/*`), 5 `disciplines`, 20 `services`, 28 `service_cases` (drafts), 4 `statistics` (the Services-page samples, drafts), and the Services page with its sections once the page slice lands. | **No row with `this_round = false`.** Any such row is one an editor deleted since the last run (the seed would bring it back) — stop, and apply a delta seed of this round's files instead: `node scripts/gen-seeds.mjs --only 05-media-stills.json,08-disciplines.json,10-services.json,44-statistics-team.json,45-service-cases.json > /tmp/r2-delta.sql` (plus the page slice's services-page file; the delta is per FILE, so review it for older rows of those files, then psql it). Otherwise: `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/production.sql`. |
| 4 | `--step content` | The rows the seed skips. The 8 kept or renamed services get the new copy (title, tagline, intro, body + body_html, value points, deliverables), their discipline, poster, clip window **and sort_order** (so they do not interleave with the new 20). The 12 sample projects' `portfolio_services` are rebuilt by slug. `crafts` → 28, "Services under one roof" (value and value_numeric together). Header Services → `/services`. | `COMMIT`. Then apply what step 0 surfaced (e.g. clear a stale `entity_seo` title or `canonical_override` of a renamed service, after review). |
| 5 | `--step samples` | The owner's override for `testimonials` and `service_cases` (audit-logged by the override table's trigger — §6c step 5 explains it), then publishes **only flagged drafts**, by exact slug: the 9 sample quotes, the 28 case blocks, the 4 Services-page stats (and the Services page's sample sections, when the seed has them). Asserts: disciplines = the 5, published services = the 28, archived = the 6 (test-service, archived in round 1, aside), live cases = the 28, live quotes = the 9, live Services stats = the 4, both override rows with their audit grants, crafts = 28. | `COMMIT`. |
| 6 | `--step verify` | Read-only JSON of the same facts, for the report. | 5 disciplines, 28 services each with its discipline, the 6 (+ test-service) archived, `cases_live` 28, 9 quotes, `98% 12+ 85% 250+`, crafts `28`, header `/services`, overrides incl. testimonials + service_cases. |
| 7 | Merge the stack (top-down, one push) → the deploy job → live checks | — | `/services`, `/services/logo` and the `/ar` twins → 200; `/services/branding` → 301 to `/services#branding`; `/ar/services/music` → 301; home shows the 5 discipline cards, the quote carousel and stat 28; a case study shows its quote. |

**Making the samples real, and taking the override back:** §6c steps 8–9. The Round 2 samples
are listed on the admin dashboard as "Placeholder content is live" until then.

**Undoing a step** (before the merge; after it, prefer fixing forward):

- Step 5: §6c step 9 (unpublish the flagged rows, then revoke the two overrides).
- Step 4: the old copy is in `content_versions` (every save snapshots the row); restore a service
  from its history in the admin. The header link: set it back to `/#services`.
- Step 2: `update public.services set slug = '<old>' where slug = '<new>'` for each rename, and
  `set status = 'published'` for the six. Restoring a pre-rename version of a renamed service
  from its history also restores the old slug, and the retired-slug 301 then stops applying to it.

---

### 6e. Legacy counters that render nowhere (statistics pre-0023)

Round 3 (2026-09-29), data only — no migration. Production still holds the pre-0023 demo
counters — `services` (14), and likely `projects` (150+) and `years` (8) — as
**published** rows with `placements = '{}'`. Since 0023 a counter renders only on the pages
its placements name, so these render nowhere; and 0023 added `is_placeholder` with a default
of `false` while the seed never overwrites an existing row, so they are unflagged and invisible
to the dashboard's placeholder lists. They are archived, not deleted: the admin can restore one
and give it a placement if it is ever wanted.

**When.** After PR3 of Round 3 is live (it adds `unplaced_published` to the preflight and
makes the verify step insist on none). Run as the owner: `supabase db query --linked` (the
`db query` allow rule; needs a valid Supabase access token) or psql with `$PROD_DB_URL`.

1. **Preflight** (read-only). `node scripts/round2-cutover.mjs --step preflight`, then run it
   and read `unplaced_published`: every published counter with no placement, as
   `{slug, value, is_placeholder}`. Expected: a subset of `services=14`, `projects=150+`,
   `years=8`. **Anything else is a counter an editor published without a page — stop and ask
   before archiving it**; the transaction below refuses to commit while it exists.

2. **Archive them — one transaction.** A compare-and-set on `(slug, value)` — only the three
   known rows, only while still published and unplaced — so a re-run matches nothing and a
   row an editor has since placed or edited is left alone. `value_numeric` and `value_suffix`
   are cleared so the row's own update cannot be refused by the 0023
   `statistics_value_consistent` CHECK (NOT VALID on production precisely because these rows
   predate it — it is still checked on every edited row):

   ```sql
   begin;

   with archived as (
     update public.statistics
        set status = 'archived', value_numeric = null, value_suffix = null
      where tenant_id = '00000000-0000-0000-0000-0000000000b1'
        and status = 'published' and cardinality(placements) = 0
        and (slug::text, value) in (('services', '14'), ('projects', '150+'), ('years', '8'))
     returning slug, value
   )
   select coalesce(string_agg(slug::text || '=' || value, ',' order by slug::text collate "C"), '(none)')
     as archived
     from archived;

   -- Nothing published may render nowhere once this commits. A row outside the known set
   -- (an editor's) is not archived by the statement above: this raises, the transaction
   -- rolls back, and the row is reviewed with the owner first.
   do $$
   declare v_bad text;
   begin
     select string_agg(slug::text || '=' || value, ',' order by slug::text collate "C") into v_bad
       from public.statistics
      where tenant_id = '00000000-0000-0000-0000-0000000000b1'
        and status = 'published' and cardinality(placements) = 0;
     if v_bad is not null then
       raise exception '§6e: published counters still render nowhere — review before archiving: %', v_bad;
     end if;
   end $$;

   commit;
   ```

   **Must see:** `archived` equal to the preflight's `unplaced_published` set (slug=value,
   in that order), then `COMMIT`. A `ROLLBACK` names the row to review.

3. **Verify** (read-only). `node scripts/round2-cutover.mjs --step verify`: its JSON now
   carries `unplaced_published` (**must be `[]`**), and the step raises if it is not — so a
   verify run before this section fails on purpose. Or directly:
   `select count(*) from public.statistics where status = 'published' and cardinality(placements) = 0;`
   is `0`. Nothing visible changes on the site (the rows rendered nowhere already).

4. **Record the run.** An owner psql statement carries no JWT, so **no `audit_log` row is
   written** for this change — record the date, the `archived` set and who ran it in the
   PR / ops log (as for §6c–§6d).

**Undo:** in the admin (Statistics → the row → status Published, and choose a page under
"Shown on"), or `update public.statistics set status = 'published' where slug = '<slug>'` —
the row then renders nowhere again until it has a placement, and the verify step fails again
until it does.

**Why not a migration or a `dashboard_attention` kind:** the fix is to three rows of one
tenant's data, and a view change would need migration 0029+, which Join's PRs hold this round
(R3-c). The seed spec (`tests/seed/seeds.spec.ts`) refuses a published seed counter without a
placement, so the state cannot be seeded again.

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
