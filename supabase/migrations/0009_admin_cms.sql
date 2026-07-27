-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 — Admin / CMS (Phase 3) schema.
-- Forward-only (expand). Depends on 0001–0008.
--
-- The load-bearing idea in this migration: **RLS is row-level, not column-level**,
-- so any capability split that cuts THROUGH a row has to become its own table or it
-- cannot be enforced by the primary authz layer at all. Three splits in CLAUDE.md §5
-- do exactly that, and each gets a table here rather than a column on an existing one:
--
--   settings.integrations  Admin + SEO        ≠ settings.general (Admin + Developer)
--                          → public.site_integrations, not site_settings.integrations
--   seo.globalDefaults     Admin + SEO        ≠ settings.general
--                          → public.seo_defaults
--   seo.entityMeta         Admin + SEO (+CC view)  ≠ services/blog/portfolio/pages body
--                          (Admin + Content Creator)
--                          → public.entity_seo
--
-- Left as columns, "SEO edits the meta but not the body" would have been enforceable
-- only in application code — i.e. one layer, not two — and `site_settings`' existing
-- FOR ALL policy would have handed Developer the integrations keys and SEO nothing.
--
-- CLAUDE.md §3 (Pillar 1), §5 (role matrix), §8 (data model), §9 (testing).
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Shared triggers -------------------------------------------------------

-- Stamps created_by / updated_by from the verified JWT subject. Actor attribution is
-- never taken from the request body: a client that can name its own `updated_by` can
-- forge the provenance the audit log is supposed to establish.
create or replace function app.tg_set_actor() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  new.updated_by := auth.uid();
  return new;
end $$;

-- Singleton config tables carry only `updated_by` (they are never "created" by a user).
create or replace function app.tg_set_updater() returns trigger
  language plpgsql as $$
begin
  new.updated_by := auth.uid();
  return new;
end $$;

-- Optimistic locking (CLAUDE.md Pillar 4). The app updates WHERE version = <expected>;
-- a losing writer matches zero rows and the endpoint answers 409. The DB owns the
-- INCREMENT so no write path — including service_role — can forget to bump it and
-- silently turn concurrent edits into last-write-wins.
create or replace function app.tg_bump_version() returns trigger
  language plpgsql as $$
begin
  if new.version = old.version then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

-- Writes the post-image of every insert/update into the single polymorphic
-- content_versions table (there is NO page_versions table — CLAUDE.md §8).
-- security definer: history must be written even when the writer's own RLS would
-- reject the insert, otherwise "who changed this" is available only for edits by
-- people who happened to hold the content-write capability.
create or replace function app.tg_snapshot_version() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp as $$
begin
  insert into public.content_versions
    (tenant_id, entity_type, entity_id, version, snapshot, created_by)
  values (new.tenant_id, tg_argv[0], new.id, new.version, to_jsonb(new), auth.uid());
  return null;
end $$;

-- ---- Login lockout counter (0001 shipped locked_until; this is its partner) --
alter table public.profiles
  add column if not exists failed_login_count int not null default 0,
  add column if not exists last_login_at timestamptz;

-- ---- Publish / schedule parity across content types ------------------------
-- 0001 gave only blog_posts published_at/scheduled_for. "Publish / schedule" in §5 is
-- one capability over all content, so the columns (and the cron that acts on them)
-- have to exist on every schedulable type or the capability is a half-truth.
alter table public.services
  add column if not exists published_at timestamptz,
  add column if not exists scheduled_for timestamptz;
alter table public.portfolio
  add column if not exists published_at timestamptz,
  add column if not exists scheduled_for timestamptz;
alter table public.pages
  add column if not exists published_at timestamptz,
  add column if not exists scheduled_for timestamptz,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.page_sections
  add column if not exists version int not null default 1,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.categories
  add column if not exists version int not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.partner_logos
  add column if not exists version int not null default 1,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.redirects
  add column if not exists version int not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.custom_themes
  add column if not exists version int not null default 1,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.media_assets
  add column if not exists version int not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint,
  add column if not exists stream_uid text,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.site_settings
  add column if not exists version int not null default 1;

create trigger categories_updated_at before update on public.categories
  for each row execute function app.tg_set_updated_at();
create trigger partner_logos_updated_at before update on public.partner_logos
  for each row execute function app.tg_set_updated_at();
create trigger redirects_updated_at before update on public.redirects
  for each row execute function app.tg_set_updated_at();
create trigger media_assets_updated_at before update on public.media_assets
  for each row execute function app.tg_set_updated_at();

create index if not exists services_scheduled_idx
  on public.services (tenant_id, scheduled_for) where status = 'scheduled';
create index if not exists blog_scheduled_idx
  on public.blog_posts (tenant_id, scheduled_for) where status = 'scheduled';
create index if not exists portfolio_scheduled_idx
  on public.portfolio (tenant_id, scheduled_for) where status = 'scheduled';
create index if not exists pages_scheduled_idx
  on public.pages (tenant_id, scheduled_for) where status = 'scheduled';

-- ---- Login lockout RPCs (5 failures / 15 min → 423 for 15 min) -------------
-- These live in the database, not the Worker, for one reason: the counter and the
-- `profiles.locked_until` stamp must move together. A Worker doing "SELECT count, then
-- UPDATE" races itself under concurrent login attempts, which is precisely the
-- condition a credential-stuffing run creates.
--
-- All three are security definer over auth.users and return the SAME shape whether or
-- not the email exists, so they cannot be used to enumerate accounts (CLAUDE.md §3:
-- "generic copy (no enumeration)").
--
-- They sit in `public`, not `app`, only because PostgREST exposes `public` — an RPC in
-- `app` is unreachable from the Worker. The grants below (service_role only) are what
-- keeps that from being an exposure: `anon` and `authenticated` cannot execute them.

create or replace function public.login_is_locked(
  p_email citext, p_window interval default '15 minutes', p_threshold int default 5
) returns boolean
  language sql security definer set search_path = public, app, pg_temp as $$
  select count(*) >= p_threshold
    from public.login_attempts
   where email = p_email and success = false and created_at > now() - p_window
$$;

create or replace function public.register_failed_login(
  p_email citext,
  p_ip inet default null,
  p_window interval default '15 minutes',
  p_threshold int default 5,
  p_lock interval default '15 minutes'
) returns boolean
  language plpgsql security definer set search_path = public, auth, app, pg_temp as $$
declare
  v_fails int;
  v_id uuid;
begin
  insert into public.login_attempts (email, ip, success) values (p_email, p_ip, false);

  select count(*) into v_fails
    from public.login_attempts
   where email = p_email and success = false and created_at > now() - p_window;

  if v_fails >= p_threshold then
    select id into v_id from auth.users where email = p_email;
    if v_id is not null then
      update public.profiles
         set locked_until = now() + p_lock, failed_login_count = v_fails
       where id = v_id;
    end if;
    return true;
  end if;
  return false;
end $$;

create or replace function public.register_successful_login(
  p_email citext, p_ip inet default null
) returns void
  language plpgsql security definer set search_path = public, auth, app, pg_temp as $$
declare
  v_id uuid;
begin
  insert into public.login_attempts (email, ip, success) values (p_email, p_ip, true);
  select id into v_id from auth.users where email = p_email;
  if v_id is not null then
    update public.profiles
       set failed_login_count = 0, locked_until = null, last_login_at = now()
     where id = v_id;
  end if;
end $$;

revoke all on function public.login_is_locked(citext, interval, int) from public, anon, authenticated;
revoke all on function public.register_failed_login(citext, inet, interval, int, interval)
  from public, anon, authenticated;
revoke all on function public.register_successful_login(citext, inet) from public, anon, authenticated;
grant execute on function public.login_is_locked(citext, interval, int) to service_role;
grant execute on function public.register_failed_login(citext, inet, interval, int, interval)
  to service_role;
grant execute on function public.register_successful_login(citext, inet) to service_role;

-- ---- Navigation editor (Admin + Content Creator) ---------------------------
create table public.navigation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  location text not null check (location in ('header', 'footer')),
  parent_id uuid references public.navigation (id) on delete cascade,
  label jsonb not null,                 -- {en, ar} — AR is first-class (Pillar 3)
  href text not null,
  visible boolean not null default true,
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);
create index navigation_tenant_idx on public.navigation (tenant_id, location, sort_order);
alter table public.navigation enable row level security;
alter table public.navigation force row level security;
create trigger navigation_updated_at before update on public.navigation
  for each row execute function app.tg_set_updated_at();
create trigger navigation_actor before insert or update on public.navigation
  for each row execute function app.tg_set_actor();
create trigger navigation_version before update on public.navigation
  for each row execute function app.tg_bump_version();
-- Nav is rendered on every public page, so anon reads it (visible rows only are
-- selected by the loader; RLS scopes the tenant).
create policy navigation_read on public.navigation for select
  using (tenant_id = app.effective_tenant_id());
create policy navigation_write on public.navigation for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
create policy navigation_delete_admin on public.navigation
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- Per-entity SEO meta (Admin + SEO write · Content Creator view) ---------
create table public.entity_seo (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  entity_type text not null check (entity_type in ('service', 'blog_post', 'portfolio', 'page')),
  entity_id uuid not null,
  meta_title jsonb not null default '{}'::jsonb,        -- {en, ar}
  meta_description jsonb not null default '{}'::jsonb,  -- {en, ar}
  og_image text,
  canonical_override text,
  robots text,
  schema_type text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, entity_type, entity_id)
);
alter table public.entity_seo enable row level security;
alter table public.entity_seo force row level security;
create trigger entity_seo_updated_at before update on public.entity_seo
  for each row execute function app.tg_set_updated_at();
create trigger entity_seo_actor before insert or update on public.entity_seo
  for each row execute function app.tg_set_actor();
create trigger entity_seo_version before update on public.entity_seo
  for each row execute function app.tg_bump_version();
-- Meta tags are public by construction (they ship in the HTML head), so the read
-- policy is tenant-scoped only — this is also what gives Content Creator its
-- documented "view" access without a second policy.
create policy entity_seo_read on public.entity_seo for select
  using (tenant_id = app.effective_tenant_id());
create policy entity_seo_write on public.entity_seo for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'));

-- ---- Global SEO defaults (Admin + SEO) -------------------------------------
create table public.seo_defaults (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  title_template jsonb not null default '{}'::jsonb,     -- {en, ar} e.g. '%s | Braiin Station'
  default_title jsonb not null default '{}'::jsonb,
  default_description jsonb not null default '{}'::jsonb,
  default_og_image text,
  organization jsonb not null default '{}'::jsonb,       -- Organization JSON-LD source
  robots_directives text not null default 'index,follow',
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.seo_defaults enable row level security;
alter table public.seo_defaults force row level security;
create trigger seo_defaults_updated_at before update on public.seo_defaults
  for each row execute function app.tg_set_updated_at();
create trigger seo_defaults_version before update on public.seo_defaults
  for each row execute function app.tg_bump_version();
create policy seo_defaults_read on public.seo_defaults for select
  using (tenant_id = app.effective_tenant_id());
create policy seo_defaults_write on public.seo_defaults for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'));

-- ---- Integrations (Admin + SEO) — deliberately NOT site_settings ------------
create table public.site_integrations (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  ga4 jsonb not null default '{}'::jsonb,
  search_console jsonb not null default '{}'::jsonb,
  calendly jsonb not null default '{}'::jsonb,
  recaptcha jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.site_integrations enable row level security;
alter table public.site_integrations force row level security;
create trigger site_integrations_updated_at before update on public.site_integrations
  for each row execute function app.tg_set_updated_at();
create trigger site_integrations_version before update on public.site_integrations
  for each row execute function app.tg_bump_version();
-- Read is staff-wide: the GA4 measurement id is public once injected, and the consent
-- banner + analytics dashboards need it. Write is Admin + SEO per §5.
create policy site_integrations_read on public.site_integrations for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
create policy site_integrations_write on public.site_integrations for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'));

-- ---- AI Style-Finder authoring (Admin + Content Creator) -------------------
create table public.ai_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  prompt jsonb not null,                -- {en, ar}
  help_text jsonb,
  input_type text not null default 'single'
    check (input_type in ('single', 'multi', 'scale', 'text')),
  options jsonb not null default '[]'::jsonb,
  status content_status not null default 'draft',
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
alter table public.ai_questions enable row level security;
alter table public.ai_questions force row level security;
create trigger ai_questions_updated_at before update on public.ai_questions
  for each row execute function app.tg_set_updated_at();
create trigger ai_questions_actor before insert or update on public.ai_questions
  for each row execute function app.tg_set_actor();
create trigger ai_questions_version before update on public.ai_questions
  for each row execute function app.tg_bump_version();
create policy ai_questions_read on public.ai_questions for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy ai_questions_write on public.ai_questions for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
create policy ai_questions_delete_admin on public.ai_questions
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

create table public.ai_styles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  name jsonb not null,                  -- {en, ar}
  description jsonb,
  traits jsonb not null default '{}'::jsonb,
  image_url text,
  status content_status not null default 'draft',
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
alter table public.ai_styles enable row level security;
alter table public.ai_styles force row level security;
create trigger ai_styles_updated_at before update on public.ai_styles
  for each row execute function app.tg_set_updated_at();
create trigger ai_styles_actor before insert or update on public.ai_styles
  for each row execute function app.tg_set_actor();
create trigger ai_styles_version before update on public.ai_styles
  for each row execute function app.tg_bump_version();
create policy ai_styles_read on public.ai_styles for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy ai_styles_write on public.ai_styles for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
create policy ai_styles_delete_admin on public.ai_styles
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- AI results / logic config (Admin ONLY — `ai.config` in §5) -------------
-- Separate from ai_questions/ai_styles because the matrix gives Content Creator the
-- authoring capability but NOT this one. Same reason as site_integrations: a column
-- on a table Content Creator may write is not a boundary.
create table public.ai_config (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  enabled boolean not null default false,
  model text not null default 'claude-sonnet-5',
  daily_usd_cap numeric not null default 5,
  per_ip_hourly_limit int not null default 60,
  per_session_hourly_limit int not null default 20,
  system_prompt text,
  scoring jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.ai_config enable row level security;
alter table public.ai_config force row level security;
create trigger ai_config_updated_at before update on public.ai_config
  for each row execute function app.tg_set_updated_at();
create trigger ai_config_version before update on public.ai_config
  for each row execute function app.tg_bump_version();
create policy ai_config_admin_all on public.ai_config for all
  using (tenant_id = app.effective_tenant_id() and app.is_admin())
  with check (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- Consent ledger (PDPL) --------------------------------------------------
-- Stores a keyed hash of the consent subject, never a raw identifier: the ledger has
-- to prove "consent was given/withdrawn at T for categories C" without itself
-- becoming a new store of personal data to defend.
create table public.consent_log (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  subject_hash text not null,
  categories jsonb not null,
  policy_version text not null,
  action text not null default 'grant' check (action in ('grant', 'withdraw')),
  created_at timestamptz not null default now()
);
create index consent_log_tenant_idx on public.consent_log (tenant_id, created_at desc);
alter table public.consent_log enable row level security;
alter table public.consent_log force row level security;
-- Writes arrive via the service-role ingest path only; no insert policy.
create policy consent_log_read on public.consent_log for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));

-- ---- Notification ledger (lead notifications, §10) --------------------------
create table public.notification_log (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  channel text not null,
  status text not null check (status in ('queued', 'sent', 'failed')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index notification_log_tenant_idx on public.notification_log (tenant_id, created_at desc);
alter table public.notification_log enable row level security;
alter table public.notification_log force row level security;
create policy notification_log_read on public.notification_log for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));

-- ---- Search analytics (Admin + SEO + Developer — `analytics.search`) --------
create table public.search_queries (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  q text not null,
  locale text not null default 'en',
  results_count int not null default 0,
  occurred_at timestamptz not null default now()
);
create index search_queries_tenant_idx on public.search_queries (tenant_id, occurred_at desc);
alter table public.search_queries enable row level security;
alter table public.search_queries force row level security;
create policy search_queries_read on public.search_queries for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo', 'developer'));

-- ---- Privileged-op ledger (export rate limiting) ---------------------------
-- Backs the "3/hr/user AND tenant aggregate" limit on export-backup / export-csv.
-- Deliberately NOT the audit log: rate limiting needs cheap windowed counts and the
-- audit chain must stay append-only and unindexed-by-actor for its own integrity.
create table public.privileged_ops (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  actor_id uuid not null,
  op text not null,
  created_at timestamptz not null default now()
);
create index privileged_ops_window_idx on public.privileged_ops (tenant_id, op, created_at desc);
create index privileged_ops_actor_idx on public.privileged_ops (actor_id, op, created_at desc);
alter table public.privileged_ops enable row level security;
alter table public.privileged_ops force row level security;
-- No policies: the service-role export path is the only writer/reader.

-- ---- Let the snapshot trigger actually write ---------------------------------
-- content_versions is FORCE RLS, which subjects even the table owner to its policies,
-- so `security definer` alone does not guarantee app.tg_snapshot_version() can insert —
-- it would depend on the migration role happening to hold BYPASSRLS. 0001 granted
-- INSERT only to can_write_content (admin + content_creator), which would have dropped
-- history for every edit made by another role. Widen it to staff; the trigger is still
-- the only caller, and the chain of custody is auth.uid() on the row.
create policy content_versions_insert_staff on public.content_versions for insert
  with check (tenant_id = app.effective_tenant_id() and app.is_staff());

-- ---- Version snapshots on every editable content type ----------------------
create trigger services_actor before insert or update on public.services
  for each row execute function app.tg_set_actor();
create trigger services_version before update on public.services
  for each row execute function app.tg_bump_version();
create trigger services_snapshot after insert or update on public.services
  for each row execute function app.tg_snapshot_version('service');

create trigger blog_posts_actor before insert or update on public.blog_posts
  for each row execute function app.tg_set_actor();
create trigger blog_posts_version before update on public.blog_posts
  for each row execute function app.tg_bump_version();
create trigger blog_posts_snapshot after insert or update on public.blog_posts
  for each row execute function app.tg_snapshot_version('blog_post');

create trigger portfolio_actor before insert or update on public.portfolio
  for each row execute function app.tg_set_actor();
create trigger portfolio_version before update on public.portfolio
  for each row execute function app.tg_bump_version();
create trigger portfolio_snapshot after insert or update on public.portfolio
  for each row execute function app.tg_snapshot_version('portfolio');

create trigger pages_actor before insert or update on public.pages
  for each row execute function app.tg_set_actor();
create trigger pages_version before update on public.pages
  for each row execute function app.tg_bump_version();
create trigger pages_snapshot after insert or update on public.pages
  for each row execute function app.tg_snapshot_version('page');

create trigger page_sections_actor before insert or update on public.page_sections
  for each row execute function app.tg_set_actor();
create trigger page_sections_version before update on public.page_sections
  for each row execute function app.tg_bump_version();

create trigger team_members_actor before insert or update on public.team_members
  for each row execute function app.tg_set_actor();
create trigger team_members_version before update on public.team_members
  for each row execute function app.tg_bump_version();

create trigger certifications_actor before insert or update on public.certifications
  for each row execute function app.tg_set_actor();
create trigger certifications_version before update on public.certifications
  for each row execute function app.tg_bump_version();

create trigger statistics_actor before insert or update on public.statistics
  for each row execute function app.tg_set_actor();
create trigger statistics_version before update on public.statistics
  for each row execute function app.tg_bump_version();

create trigger categories_actor before insert or update on public.categories
  for each row execute function app.tg_set_actor();
create trigger categories_version before update on public.categories
  for each row execute function app.tg_bump_version();

create trigger partner_logos_actor before insert or update on public.partner_logos
  for each row execute function app.tg_set_actor();
create trigger partner_logos_version before update on public.partner_logos
  for each row execute function app.tg_bump_version();

create trigger redirects_actor before insert or update on public.redirects
  for each row execute function app.tg_set_actor();
create trigger redirects_version before update on public.redirects
  for each row execute function app.tg_bump_version();

create trigger media_assets_actor before insert or update on public.media_assets
  for each row execute function app.tg_set_actor();
create trigger media_assets_version before update on public.media_assets
  for each row execute function app.tg_bump_version();

create trigger custom_themes_actor before insert or update on public.custom_themes
  for each row execute function app.tg_set_actor();
create trigger custom_themes_version before update on public.custom_themes
  for each row execute function app.tg_bump_version();

create trigger site_settings_version before update on public.site_settings
  for each row execute function app.tg_bump_version();

create trigger seo_defaults_updater before insert or update on public.seo_defaults
  for each row execute function app.tg_set_updater();
create trigger site_integrations_updater before insert or update on public.site_integrations
  for each row execute function app.tg_set_updater();
create trigger ai_config_updater before insert or update on public.ai_config
  for each row execute function app.tg_set_updater();

-- ---- Scheduled publishing ---------------------------------------------------
-- Flips `scheduled` → `published` once scheduled_for has passed. security definer so
-- the cron job (which has no JWT) can act across the tenant. Operator schedules it on
-- the direct :5432 connection:
--   select cron.schedule('publish-scheduled', '*/5 * * * *', $$ select app.publish_scheduled() $$);
create or replace function app.publish_scheduled() returns int
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  n int := 0;
  c int;
begin
  update public.services set status = 'published', published_at = coalesce(published_at, now())
    where status = 'scheduled' and scheduled_for is not null and scheduled_for <= now();
  get diagnostics c = row_count; n := n + c;

  update public.blog_posts set status = 'published', published_at = coalesce(published_at, now())
    where status = 'scheduled' and scheduled_for is not null and scheduled_for <= now();
  get diagnostics c = row_count; n := n + c;

  update public.portfolio set status = 'published', published_at = coalesce(published_at, now())
    where status = 'scheduled' and scheduled_for is not null and scheduled_for <= now();
  get diagnostics c = row_count; n := n + c;

  update public.pages set status = 'published', published_at = coalesce(published_at, now())
    where status = 'scheduled' and scheduled_for is not null and scheduled_for <= now();
  get diagnostics c = row_count; n := n + c;

  return n;
end $$;

revoke all on function app.publish_scheduled() from public, anon, authenticated;

-- ---- Dashboard banners are DERIVED VIEWS, not tables (CLAUDE.md §8) --------
-- security_invoker so each staff member sees exactly the rows their own RLS allows.
create view public.dashboard_attention with (security_invoker = true) as
  select 'scheduled_today'::text as kind, 'service'::text as entity_type, s.id, s.slug::text,
         s.title, s.scheduled_for as at
    from public.services s
   where s.status = 'scheduled' and s.scheduled_for::date = current_date
  union all
  select 'scheduled_today', 'blog_post', b.id, b.slug::text, b.title, b.scheduled_for
    from public.blog_posts b
   where b.status = 'scheduled' and b.scheduled_for::date = current_date
  union all
  select 'stale', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and b.updated_at < now() - interval '180 days'
  union all
  select 'missing_image', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and (b.cover_image_url is null or b.cover_image_url = '');

revoke all on public.dashboard_attention from anon;
grant select on public.dashboard_attention to authenticated;
