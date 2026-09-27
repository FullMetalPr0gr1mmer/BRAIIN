-- ─────────────────────────────────────────────────────────────────────────────
-- 0028 — Disciplines, service pages, service cases; sample testimonials. UI v2 round 2.
-- Forward-only (expand). Depends on 0001, 0009, 0011, 0021–0027.
--
--   disciplines    the five groups the 28 services sit in (Branding, Production,
--                  Marketing, Website Development, Events & Exhibitions). Home cards,
--                  the /services explorer and each service page's crumb read them.
--   services       gain the service-page content: discipline, intro, value points,
--                  deliverables, a poster and a clip window of the showreel (EXC-009).
--   service_cases  one "client problem we solved" block per service, tied to a
--                  portfolio project (client + sector come from the project). Seeded as
--                  design samples (`is_placeholder`) — owner decision 2026-09-27.
--   testimonials   the owner decided (2026-09-27) to show the design's sample quotes
--                  until real ones replace them. The consent CHECK now lets a flagged
--                  sample through; 0025 still stops it in production unless the owner's
--                  audited override (0027) names the table; and a new trigger stops staff
--                  from creating a sample or editing one's words — only seeds do that.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Disciplines --------------------------------------------------------------
create table if not exists public.disciplines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name jsonb not null check (jsonb_typeof(name) = 'object' and name ? 'en' and name ? 'ar'),
  short jsonb check (short is null or (jsonb_typeof(short) = 'object' and short ? 'en' and short ? 'ar')),
  blurb jsonb check (blurb is null or (jsonb_typeof(blurb) = 'object' and blurb ? 'en' and blurb ? 'ar')),
  poster_media_id uuid references public.media_assets (id) on delete restrict,
  preview_video_path text check (preview_video_path ~ '^/media/[a-z0-9][a-z0-9/_-]*\.mp4$'),
  preview_start_s numeric(6, 2),
  preview_end_s numeric(6, 2),
  status content_status not null default 'draft',
  published_at timestamptz,
  scheduled_for timestamptz,
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug),
  -- The clip rules (VideoClipSchema — EXC-009), as portfolio_preview_window (0022).
  constraint disciplines_preview_window check (
    (preview_start_s is null) = (preview_end_s is null)
    and (preview_start_s is null
         or (preview_start_s >= 0 and preview_end_s > preview_start_s
             and preview_end_s - preview_start_s <= 30)))
);
create index if not exists disciplines_poster_idx on public.disciplines (poster_media_id);
create index if not exists disciplines_tenant_status_idx on public.disciplines (tenant_id, status, sort_order);
create index if not exists disciplines_scheduled_idx
  on public.disciplines (tenant_id, scheduled_for) where status = 'scheduled';

-- ---- Services: the service-page content ---------------------------------------
alter table public.services
  add column if not exists discipline_id uuid references public.disciplines (id) on delete restrict,
  add column if not exists intro jsonb
    check (intro is null or (jsonb_typeof(intro) = 'object' and intro ? 'en' and intro ? 'ar')),
  add column if not exists value_points jsonb not null default '[]'::jsonb
    check (jsonb_typeof(value_points) = 'array' and jsonb_array_length(value_points) <= 6),
  add column if not exists deliverables jsonb not null default '[]'::jsonb
    check (jsonb_typeof(deliverables) = 'array' and jsonb_array_length(deliverables) <= 12),
  add column if not exists poster_media_id uuid references public.media_assets (id) on delete restrict,
  add column if not exists preview_video_path text
    check (preview_video_path ~ '^/media/[a-z0-9][a-z0-9/_-]*\.mp4$'),
  add column if not exists preview_start_s numeric(6, 2),
  add column if not exists preview_end_s numeric(6, 2);
alter table public.services drop constraint if exists services_preview_window;
alter table public.services add constraint services_preview_window check (
  (preview_start_s is null) = (preview_end_s is null)
  and (preview_start_s is null
       or (preview_start_s >= 0 and preview_end_s > preview_start_s
           and preview_end_s - preview_start_s <= 30)));
create index if not exists services_discipline_idx on public.services (discipline_id);
create index if not exists services_poster_idx on public.services (poster_media_id);

-- ---- Service cases ------------------------------------------------------------
create table if not exists public.service_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  portfolio_id uuid references public.portfolio (id) on delete set null,
  title jsonb not null check (jsonb_typeof(title) = 'object' and title ? 'en' and title ? 'ar'),
  context jsonb check (context is null or (jsonb_typeof(context) = 'object' and context ? 'en' and context ? 'ar')),
  problems jsonb not null default '[]'::jsonb
    check (jsonb_typeof(problems) = 'array' and jsonb_array_length(problems) <= 6),
  results jsonb not null default '[]'::jsonb
    check (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 4),
  status content_status not null default 'draft',
  published_at timestamptz,
  scheduled_for timestamptz,
  is_placeholder boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, service_id)
);
create index if not exists service_cases_portfolio_idx on public.service_cases (portfolio_id);
create index if not exists service_cases_scheduled_idx
  on public.service_cases (tenant_id, scheduled_for) where status = 'scheduled';

-- ---- Leads: "{Discipline}, help me choose" ------------------------------------
alter table public.leads
  add column if not exists discipline_of_interest citext
    check (discipline_of_interest ~ '^[a-z0-9][a-z0-9-]{0,63}$');

-- ---- Grants (stated, never inherited — 0011 §5) -------------------------------
revoke all on public.disciplines, public.service_cases from anon, authenticated;
grant select (id, tenant_id, slug, name, short, blurb, poster_media_id, preview_video_path,
              preview_start_s, preview_end_s, status, sort_order, published_at, updated_at)
  on public.disciplines to anon;
-- Never is_placeholder / scheduled_for / version / created_by / updated_by.
grant select (id, tenant_id, service_id, portfolio_id, title, context, problems, results,
              status, published_at, updated_at)
  on public.service_cases to anon;
grant select, insert, update, delete on public.disciplines, public.service_cases to authenticated;

-- ── S1a: RLS + policies, triggers, the testimonials changes, the override CHECK, the
-- ── statistics CHECKs, leads_safe, media read + media_usage, placeholder guard +
-- ── dashboard_attention, publish_scheduled, and postconditions follow below.
