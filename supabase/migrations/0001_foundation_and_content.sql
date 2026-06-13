-- ─────────────────────────────────────────────────────────────────────────────
-- 0001 — Foundation + core content
-- Tenant-ready (single-tenant launch): every table carries tenant_id and has RLS
-- ENABLEd + FORCEd. Tenant + role are read from the JWT app_metadata (set by the
-- Custom Access Token Hook) — NEVER user_metadata. RLS is the PRIMARY authz layer;
-- Edge Functions add assertCap() as the secondary layer.
-- Forward-only migration (expand/contract). CLAUDE.md §3 / §8 / architecture §2–§3.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;   -- gen_random_uuid, digest/hmac
create extension if not exists citext;      -- case-insensitive slugs/emails
create extension if not exists pg_trgm;     -- did-you-mean / fuzzy search

-- ---- Private helper schema -------------------------------------------------
create schema if not exists app;

-- tenant_id from JWT app_metadata (null for anonymous requests).
create or replace function app.current_tenant_id() returns uuid
  language sql stable as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,tenant_id}',
    ''
  )::uuid
$$;

-- The single launch tenant. security definer so anon can resolve it past RLS.
create or replace function app.default_tenant_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.tenants order by created_at asc limit 1
$$;

-- Effective tenant: the JWT tenant, else the single launch tenant (the anon fence —
-- anon can only ever resolve to ONE tenant and can never target another).
create or replace function app.effective_tenant_id() returns uuid
  language sql stable as $$
  select coalesce(app.current_tenant_id(), app.default_tenant_id())
$$;

create or replace function app.current_role() returns text
  language sql stable as $$
  select coalesce(
    current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,role}',
    'anon'
  )
$$;

create or replace function app.is_staff() returns boolean
  language sql stable as $$
  select app.current_role() in ('admin', 'content_creator', 'seo', 'developer')
$$;

create or replace function app.is_admin() returns boolean
  language sql stable as $$ select app.current_role() = 'admin' $$;

-- Roles allowed to author/edit content bodies (CLAUDE.md §5).
create or replace function app.can_write_content() returns boolean
  language sql stable as $$ select app.current_role() in ('admin', 'content_creator') $$;

create or replace function app.tg_set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---- Enums -----------------------------------------------------------------
create type app_role as enum ('admin', 'content_creator', 'seo', 'developer');
-- One lifecycle for all content. Gaming teaser = published + is_teaser, not a 5th status.
create type content_status as enum ('draft', 'scheduled', 'published', 'archived');

-- ---- Tenants + profiles ----------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  primary_domain text,
  created_at timestamptz not null default now()
);
alter table public.tenants enable row level security;
alter table public.tenants force row level security;
-- Members see their own tenant; only admins edit it.
create policy tenants_select on public.tenants for select
  using (id = app.effective_tenant_id());
create policy tenants_admin_write on public.tenants for all
  using (id = app.effective_tenant_id() and app.is_admin())
  with check (id = app.effective_tenant_id() and app.is_admin());

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role app_role not null default 'content_creator',
  is_active boolean not null default true,      -- live-rechecked by privileged Edge Functions
  display_name text,
  avatar_url text,
  locked_until timestamptz,                      -- login lockout
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_tenant_idx on public.profiles (tenant_id);
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function app.tg_set_updated_at();
-- A user reads their own row; admins manage profiles within the tenant.
create policy profiles_self_select on public.profiles for select
  using (id = auth.uid() or (tenant_id = app.effective_tenant_id() and app.is_admin()));
create policy profiles_admin_write on public.profiles for all
  using (tenant_id = app.effective_tenant_id() and app.is_admin())
  with check (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- Site settings (singleton per tenant) ----------------------------------
create table public.site_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  identity jsonb not null default '{}'::jsonb,
  integrations jsonb not null default '{}'::jsonb,
  maintenance jsonb not null default jsonb_build_object('active', false, 'allowlist', '[]'::jsonb),
  -- RAW_TELEMETRY_RETENTION lives here as the single source (CLAUDE.md Pillar 4).
  retention jsonb not null default jsonb_build_object('raw_telemetry_days', 90, 'leads_months', 24, 'spam_days', 30),
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;
alter table public.site_settings force row level security;
create trigger site_settings_updated_at before update on public.site_settings
  for each row execute function app.tg_set_updated_at();
create policy site_settings_staff_read on public.site_settings for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
-- General settings gated to admin + developer (SEO edits integrations via Edge Fn).
create policy site_settings_write on public.site_settings for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));

-- ---- Team members (E-E-A-T authors) ----------------------------------------
create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  profile_user_id uuid references public.profiles (id) on delete set null,
  slug citext not null,
  name jsonb not null,                  -- {en, ar}
  bio jsonb,                            -- {en, ar}
  avatar_url text,
  status content_status not null default 'draft',
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
alter table public.team_members enable row level security;
alter table public.team_members force row level security;
create trigger team_members_updated_at before update on public.team_members
  for each row execute function app.tg_set_updated_at();
create policy team_members_read on public.team_members for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy team_members_write on public.team_members for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Categories ------------------------------------------------------------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  name jsonb not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
alter table public.categories enable row level security;
alter table public.categories force row level security;
create policy categories_read on public.categories for select
  using (tenant_id = app.effective_tenant_id());
create policy categories_write on public.categories for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Services (EXEMPLAR: full RLS incl. publish/archive gating + FTS) -------
create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  title jsonb not null,                 -- {en, ar}
  blurb jsonb,                          -- {en, ar}
  body jsonb,                           -- locale-keyed Tiptap JSON
  body_html jsonb,                      -- derived sanitized HTML cache (locale-keyed)
  hero_video_uid text,                  -- Cloudflare Stream UID
  category text,
  status content_status not null default 'draft',
  is_teaser boolean not null default false,   -- Gaming "coming soon"
  sort_order int not null default 0,
  version int not null default 1,             -- optimistic locking (409 on mismatch)
  -- FTS. NOTE: Arabic normalization (tashkeel/alef/ة/kashida) via an immutable
  -- helper is added before Phase 1 search; CLAUDE.md §8 sets the recall@5 pass bar.
  search_en tsvector generated always as (
    to_tsvector('english', coalesce(title ->> 'en', '') || ' ' || coalesce(blurb ->> 'en', ''))
  ) stored,
  search_ar tsvector generated always as (
    to_tsvector('arabic', coalesce(title ->> 'ar', '') || ' ' || coalesce(blurb ->> 'ar', ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
create index services_search_en_idx on public.services using gin (search_en);
create index services_search_ar_idx on public.services using gin (search_ar);
create index services_tenant_status_idx on public.services (tenant_id, status);
alter table public.services enable row level security;
alter table public.services force row level security;
create trigger services_updated_at before update on public.services
  for each row execute function app.tg_set_updated_at();
-- Public sees published; staff see all (within tenant).
create policy services_read on public.services for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
-- Authors create within tenant.
create policy services_insert on public.services for insert
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
-- Authors update; only admin may archive (RESTRICTIVE-style gate in WITH CHECK).
create policy services_update on public.services for update
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (
    tenant_id = app.effective_tenant_id()
    and app.can_write_content()
    and (app.is_admin() or status <> 'archived')
  );
-- Delete = admin only (archive/delete is not granted to Content Creator).
create policy services_delete on public.services for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- Blog posts ------------------------------------------------------------
create table public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  title jsonb not null,
  excerpt jsonb,
  body jsonb,
  body_html jsonb,
  author_id uuid references public.team_members (id) on delete set null,  -- no anonymous authorship
  category_id uuid references public.categories (id) on delete set null,
  cover_image_url text,
  status content_status not null default 'draft',
  published_at timestamptz,
  scheduled_for timestamptz,
  reading_minutes int,
  version int not null default 1,
  search_en tsvector generated always as (
    to_tsvector('english', coalesce(title ->> 'en', '') || ' ' || coalesce(excerpt ->> 'en', ''))
  ) stored,
  search_ar tsvector generated always as (
    to_tsvector('arabic', coalesce(title ->> 'ar', '') || ' ' || coalesce(excerpt ->> 'ar', ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
create index blog_search_en_idx on public.blog_posts using gin (search_en);
create index blog_search_ar_idx on public.blog_posts using gin (search_ar);
create index blog_tenant_status_idx on public.blog_posts (tenant_id, status);
alter table public.blog_posts enable row level security;
alter table public.blog_posts force row level security;
create trigger blog_posts_updated_at before update on public.blog_posts
  for each row execute function app.tg_set_updated_at();
create policy blog_read on public.blog_posts for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy blog_insert on public.blog_posts for insert
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
create policy blog_update on public.blog_posts for update
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (
    tenant_id = app.effective_tenant_id()
    and app.can_write_content()
    and (app.is_admin() or status <> 'archived')
  );
create policy blog_delete on public.blog_posts for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- Portfolio + relation --------------------------------------------------
create table public.portfolio (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  title jsonb not null,
  summary jsonb,
  body jsonb,
  body_html jsonb,
  status content_status not null default 'draft',
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
alter table public.portfolio enable row level security;
alter table public.portfolio force row level security;
create trigger portfolio_updated_at before update on public.portfolio
  for each row execute function app.tg_set_updated_at();
create policy portfolio_read on public.portfolio for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy portfolio_write on public.portfolio for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

create table public.portfolio_services (
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  portfolio_id uuid not null references public.portfolio (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (portfolio_id, service_id)
);
alter table public.portfolio_services enable row level security;
alter table public.portfolio_services force row level security;
create policy portfolio_services_read on public.portfolio_services for select
  using (tenant_id = app.effective_tenant_id());
create policy portfolio_services_write on public.portfolio_services for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Pages + sections (CMS engine) -----------------------------------------
create table public.pages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  title jsonb not null,
  status content_status not null default 'draft',
  nav_visible boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
alter table public.pages enable row level security;
alter table public.pages force row level security;
create trigger pages_updated_at before update on public.pages
  for each row execute function app.tg_set_updated_at();
create policy pages_read on public.pages for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy pages_write on public.pages for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

create table public.page_sections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  page_id uuid not null references public.pages (id) on delete cascade,
  type text not null,                 -- typed section variant
  content jsonb not null default '{}'::jsonb,
  style jsonb not null default '{}'::jsonb,
  visible boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index page_sections_page_idx on public.page_sections (page_id, sort_order);
alter table public.page_sections enable row level security;
alter table public.page_sections force row level security;
create trigger page_sections_updated_at before update on public.page_sections
  for each row execute function app.tg_set_updated_at();
create policy page_sections_read on public.page_sections for select
  using (tenant_id = app.effective_tenant_id());
create policy page_sections_write on public.page_sections for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Polymorphic content versions (there is NO page_versions table) --------
create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  entity_type text not null,          -- 'service' | 'blog_post' | 'portfolio' | 'page' | ...
  entity_id uuid not null,
  version int not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index content_versions_entity_idx on public.content_versions (entity_type, entity_id, version desc);
alter table public.content_versions enable row level security;
alter table public.content_versions force row level security;
create policy content_versions_read on public.content_versions for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
create policy content_versions_write on public.content_versions for insert
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Media assets ----------------------------------------------------------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  kind text not null,                 -- image | video | audio | pdf
  storage_path text not null,
  folder text,
  alt jsonb,                          -- {en, ar} — missing-alt warnings derive from this
  tags text[] not null default '{}',
  width int,
  height int,
  ref_count int not null default 0,   -- GC for unused media
  created_at timestamptz not null default now()
);
alter table public.media_assets enable row level security;
alter table public.media_assets force row level security;
-- Read for staff; write for content authors + developer (SEO edits metadata via Edge Fn).
create policy media_read on public.media_assets for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
create policy media_write on public.media_assets for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'content_creator', 'developer'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'content_creator', 'developer'));

-- ---- Redirects (v1 SEO module) ---------------------------------------------
create table public.redirects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  source_path text not null,
  target_path text not null,
  status smallint not null default 301 check (status in (301, 302, 308)),
  created_at timestamptz not null default now(),
  unique (tenant_id, source_path)
);
alter table public.redirects enable row level security;
alter table public.redirects force row level security;
-- Managed by Admin + SEO (CLAUDE.md §5).
create policy redirects_read on public.redirects for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
create policy redirects_write on public.redirects for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'seo'));

-- ---- Partner logos + custom themes -----------------------------------------
create table public.partner_logos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  name text not null,
  logo_url text not null,
  scale numeric not null default 1,
  offset_y numeric not null default 0,
  sort_order int not null default 0,
  visible boolean not null default true
);
alter table public.partner_logos enable row level security;
alter table public.partner_logos force row level security;
create policy partner_logos_read on public.partner_logos for select
  using (tenant_id = app.effective_tenant_id());
create policy partner_logos_write on public.partner_logos for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

create table public.custom_themes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  name text not null,
  tokens jsonb not null default '{}'::jsonb,   -- CSS custom properties only (CSP-safe)
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.custom_themes enable row level security;
alter table public.custom_themes force row level security;
create trigger custom_themes_updated_at before update on public.custom_themes
  for each row execute function app.tg_set_updated_at();
-- Theme editor gated to Admin + Developer (CLAUDE.md §5).
create policy custom_themes_read on public.custom_themes for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
create policy custom_themes_write on public.custom_themes for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));
