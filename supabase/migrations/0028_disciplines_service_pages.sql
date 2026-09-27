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
--
-- Authorization (CLAUDE.md §3, §5, §8 — both new tables are content, Admin + Content
-- Creator write, archive/delete Admin-only, RESTRICTIVE):
--   • RLS ENABLE + FORCE, the updated_at / actor / version / snapshot triggers, and every
--     policy fenced on app.effective_tenant_id() — all BEFORE the anon grants (0011 §5).
--   • anon reads both through COLUMN grants: never is_placeholder, scheduled_for, version
--     or the actor columns.
--   • A service case is public only while the case AND its service are published (the
--     portfolio_services pattern, 0022); its service and project must be in the writer's
--     tenant (the portfolio_media_write pattern) — a bare foreign key would accept another
--     tenant's row.
--   • services gain a RESTRICTIVE read: a service under an unpublished discipline is hidden
--     from visitors everywhere RLS reaches — pages, search_content / search_suggest (both
--     SECURITY INVOKER, so no definer path to patch), sitemap, llms.txt, portfolio embeds,
--     entity_seo and media. `discipline_id is null` stays visible: the production renames
--     run before the disciplines exist (runbook §6d). "Published needs a discipline" is
--     the Worker's assertPublishable, not a CHECK, for the same reason.
--
-- Also: the override may now name testimonials and service_cases (the owner's audited
-- exception, runbook §6c); statistics gain a `services` placement; leads gain
-- discipline_of_interest (non-sensitive, in leads_safe); visitors may read discipline and
-- service posters; media_usage(), dashboard_attention and publish_scheduled() know the
-- new tables. Postconditions at the end, as in 0022–0027.
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

comment on column public.leads.discipline_of_interest is
  'Discipline slug from "{Discipline}, help me choose" on the inquiry forms. Non-sensitive: '
  'exposed via leads_safe to every lead-viewing role, like service_of_interest. 0028.';

-- ---- RLS + the standard triggers (the fence before any grant — 0011 §5) --------
do $$
declare
  t text;
  entity text;
begin
  for t, entity in values ('disciplines', 'discipline'), ('service_cases', 'service_case') loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function app.tg_set_updated_at()', t || '_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_actor', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function app.tg_set_actor()', t || '_actor', t);
    execute format('drop trigger if exists %I on public.%I', t || '_version', t);
    execute format('create trigger %I before update on public.%I for each row execute function app.tg_bump_version()', t || '_version', t);
    execute format('drop trigger if exists %I on public.%I', t || '_snapshot', t);
    execute format('create trigger %I after insert or update on public.%I for each row execute function app.tg_snapshot_version(%L)', t || '_snapshot', t, entity);
  end loop;
end $$;

-- ---- Disciplines: policies ------------------------------------------------------
-- Visitors see published rows; staff see their whole tenant. Authors write. Archive and
-- delete: Admin only (below).
--
-- No poster-tenant term in a write policy here or on services: 0024's media read policy
-- (extended below) reads disciplines and services, so a policy on either that reads
-- media_assets is a cycle, and Postgres refuses the query (42P17, infinite recursion). A
-- poster of another tenant stays invisible to visitors anyway — 0024's own tenant term —
-- the same fail-closed outcome portfolio.poster_media_id has had since 0022.
drop policy if exists disciplines_read on public.disciplines;
create policy disciplines_read on public.disciplines for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
drop policy if exists disciplines_write on public.disciplines;
create policy disciplines_write on public.disciplines for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Service cases: policies ----------------------------------------------------
drop policy if exists service_cases_read on public.service_cases;
create policy service_cases_read on public.service_cases for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
-- A published case of an unpublished service is not public (the portfolio_services
-- pattern, 0022). The subquery runs under the reader's own RLS on services — so a service
-- hidden by its discipline (below) hides its case too.
drop policy if exists service_cases_published_parent on public.service_cases;
create policy service_cases_published_parent on public.service_cases
  as restrictive for select
  using (app.is_staff() or exists (
    select 1 from public.services s
     where s.id = service_cases.service_id and s.status = 'published'));
-- The service and the project must be the writer's own tenant's (a bare FK would accept
-- another tenant's row — the portfolio_media_write pattern, 0022).
drop policy if exists service_cases_write on public.service_cases;
create policy service_cases_write on public.service_cases for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content()
              and exists (select 1 from public.services s
                           where s.id = service_cases.service_id
                             and s.tenant_id = app.effective_tenant_id())
              and (service_cases.portfolio_id is null or exists (
                     select 1 from public.portfolio p
                      where p.id = service_cases.portfolio_id
                        and p.tenant_id = app.effective_tenant_id())));

-- Archive and delete are Admin-only on both (§5), RESTRICTIVE: they AND with the write
-- policy. A non-admin DELETE filters to 0 rows; a non-admin archive fails WITH CHECK.
do $$
declare
  t text;
begin
  foreach t in array array['disciplines', 'service_cases'] loop
    execute format('drop policy if exists %I on public.%I', t || '_delete_admin', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete
         using (tenant_id = app.effective_tenant_id() and app.is_admin())',
      t || '_delete_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_archive_admin', t);
    execute format(
      'create policy %I on public.%I as restrictive for update
         using (tenant_id = app.effective_tenant_id())
         with check (app.is_admin() or status <> ''archived'')',
      t || '_archive_admin', t);
  end loop;
end $$;

-- ---- Services: hidden while their discipline is not published --------------------
-- RESTRICTIVE, so it ANDs with services_read (0001). `is_staff()` is the escape every
-- admin path needs (a restrictive SELECT policy also filters UPDATE/DELETE row lookups).
drop policy if exists services_discipline_published on public.services;
create policy services_discipline_published on public.services
  as restrictive for select
  using (app.is_staff() or services.discipline_id is null or exists (
    select 1 from public.disciplines d
     where d.id = services.discipline_id and d.status = 'published'));

-- A service's discipline must be the writer's own tenant's: another tenant's would pass the
-- foreign key. RESTRICTIVE over insert + update (USING true: it narrows no read), so the
-- existing services_insert / services_update keep deciding WHO may write.
drop policy if exists services_discipline_in_tenant on public.services;
create policy services_discipline_in_tenant on public.services
  as restrictive for all
  using (true)
  with check (services.discipline_id is null or exists (
    select 1 from public.disciplines d
     where d.id = services.discipline_id and d.tenant_id = app.effective_tenant_id()));

-- ---- Testimonials: the sample quotes (owner decision R1, 2026-09-27) ----------------
-- A real quote still needs recorded consent. A flagged design sample may be published
-- without it — where 0025 lets it go live at all: outside production, or in production
-- under the owner's audited override (0027, widened below). NOT VALID then VALIDATE, as
-- 0022/0023: the new rule is strictly looser than 0021's, so validation cannot fail.
alter table public.testimonials drop constraint if exists testimonials_consent_gate;
alter table public.testimonials add constraint testimonials_consent_gate check (
  status not in ('published', 'scheduled') or consent_obtained_at is not null or is_placeholder
) not valid;
alter table public.testimonials validate constraint testimonials_consent_gate;

-- The looser CHECK opens one hole, closed here. With the override granted, a staff user
-- talking to PostgREST directly (past the Worker's refusePlaceholder) could flag a REAL
-- person's quote as a sample and publish it without consent — or keep a live sample's
-- flag and rewrite its words to a real name. 0025's guard fires only on status and the
-- flag. So, for staff (a JWT carrying a staff role; seeds, psql and the cron carry none):
--   • a sample can never be created, nor a quote turned into one (flag false → true);
--   • a sample's words and attribution never change while it stays a sample.
-- Clearing the flag is always allowed, in the same save as the new words — and from that
-- moment the consent CHECK applies to publishing. "Make it real" is one admin save.
create or replace function app.tg_testimonial_sample_lock() returns trigger
  language plpgsql set search_path = public, app, pg_temp as $$
begin
  if not app.is_staff() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.is_placeholder then
      raise exception 'testimonial % cannot be created as a design sample', new.slug
        using errcode = '42501',
              hint = 'Design samples come only from the seed files; a real quote needs recorded consent.';
    end if;
    return new;
  end if;
  if new.is_placeholder and not old.is_placeholder then
    raise exception 'testimonial % cannot be turned into a design sample', old.slug
      using errcode = '42501',
            hint = 'is_placeholder can be cleared, never set; a real quote needs recorded consent.';
  end if;
  if old.is_placeholder and new.is_placeholder
     and (new.quote is distinct from old.quote
          or new.author_name is distinct from old.author_name
          or new.author_role is distinct from old.author_role
          or new.avatar_media_id is distinct from old.avatar_media_id
          or new.client_id is distinct from old.client_id
          or new.portfolio_id is distinct from old.portfolio_id) then
    raise exception 'testimonial % is a design sample: its words and attribution are locked', old.slug
      using errcode = '42501',
            hint = 'Make it real in one save: the real words, the consent record, and is_placeholder cleared.';
  end if;
  return new;
end $$;
-- A trigger function: fired by the table, never called. Default-deny (0011 §6c).
revoke all on function app.tg_testimonial_sample_lock() from public, anon, authenticated, service_role;

drop trigger if exists testimonials_sample_lock on public.testimonials;
create trigger testimonials_sample_lock
  before insert or update of is_placeholder, quote, author_name, author_role, avatar_media_id,
                             client_id, portfolio_id
  on public.testimonials
  for each row execute function app.tg_testimonial_sample_lock();

-- ---- The owner's override may name testimonials and service_cases (0027) ----------
-- The CHECK is looked up by the column it constrains, not by an assumed name.
do $$
declare
  v_attnum smallint;
  v_con name;
  n int := 0;
begin
  select attnum into v_attnum from pg_attribute
   where attrelid = 'app.placeholder_live_override'::regclass
     and attname = 'table_name' and not attisdropped;
  for v_con in
    select conname from pg_constraint
     where conrelid = 'app.placeholder_live_override'::regclass
       and contype = 'c' and conkey = array[v_attnum]
  loop
    execute format('alter table app.placeholder_live_override drop constraint %I', v_con);
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception '0028: expected exactly one CHECK on app.placeholder_live_override.table_name (0027), found %', n;
  end if;
end $$;
alter table app.placeholder_live_override add constraint placeholder_live_override_table check (
  table_name in ('portfolio', 'team_members', 'statistics', 'clients', 'page_sections',
                 'testimonials', 'service_cases')
);
comment on table app.placeholder_live_override is
  'Owner-granted, per (tenant, table) exceptions to the 0025 production placeholder guard. '
  'Testimonials since 0028 (owner decision 2026-09-27): only flagged samples, which staff can '
  'neither create nor edit (app.tg_testimonial_sample_lock). Set only by the runbook (§6c); '
  'every change is audit-logged. 0027, 0028.';

-- ---- Statistics: a Services-page placement ------------------------------------------
-- 0023:26 declared the placements CHECK inline, unnamed, so Postgres named it
-- statistics_placements_check. Asserted from the catalog before it is replaced.
do $$
declare
  v_attnum smallint;
  v_names text[];
begin
  select attnum into v_attnum from pg_attribute
   where attrelid = 'public.statistics'::regclass and attname = 'placements' and not attisdropped;
  select array_agg(conname::text order by conname) into v_names from pg_constraint
   where conrelid = 'public.statistics'::regclass and contype = 'c' and conkey = array[v_attnum];
  if v_names is distinct from array['statistics_placements_check'] then
    raise exception '0028: expected the 0023 placements CHECK to be statistics_placements_check, found %',
      coalesce(v_names::text, 'none');
  end if;
end $$;
alter table public.statistics drop constraint statistics_placements_check;
-- A superset of 0023's list, so every existing row satisfies it.
alter table public.statistics add constraint statistics_placements_check
  check (placements <@ array['home', 'about', 'work', 'services']::text[]);

-- 0023:35 with a `services` branch — a Services-page label would otherwise fail 23514.
alter table public.statistics drop constraint if exists statistics_placement_labels_shape;
alter table public.statistics add constraint statistics_placement_labels_shape check (
  placement_labels - 'home' - 'about' - 'work' - 'services' = '{}'::jsonb
  and (not placement_labels ? 'home'
       or (jsonb_typeof(placement_labels -> 'home') = 'object'
           and placement_labels -> 'home' ?& array['en', 'ar']))
  and (not placement_labels ? 'about'
       or (jsonb_typeof(placement_labels -> 'about') = 'object'
           and placement_labels -> 'about' ?& array['en', 'ar']))
  and (not placement_labels ? 'work'
       or (jsonb_typeof(placement_labels -> 'work') = 'object'
           and placement_labels -> 'work' ?& array['en', 'ar']))
  and (not placement_labels ? 'services'
       or (jsonb_typeof(placement_labels -> 'services') = 'object'
           and placement_labels -> 'services' ?& array['en', 'ar']))
) not valid;
do $$
begin
  alter table public.statistics validate constraint statistics_placement_labels_shape;
exception when check_violation then
  raise warning '0028: statistics_placement_labels_shape left NOT VALID — legacy statistics rows violate it (still enforced on every new or edited row)';
end $$;

-- ---- leads_safe carries the discipline (the 0015 pattern) ---------------------------
-- `security_invoker` MUST be restated: create or replace view does not inherit it, and a
-- definer-rights leads_safe would hand every authenticated role — Content Creator and SEO
-- included — every tenant's leads (0015's header). The column is APPENDED: create or
-- replace view matches columns positionally and can only add at the end.
-- Insert path: public submissions insert as service_role through a table-level privilege
-- (src/lib/data/leads.ts → the Supabase default grant; no column-scoped INSERT, no RPC),
-- so the new column is insertable exactly like service_of_interest with no grant change.
create or replace view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  status, consent_marketing, created_at, updated_at, company, discipline_of_interest
from public.leads;

revoke all on public.leads_safe from anon;
grant select on public.leads_safe to authenticated;

-- ---- Media: visitors may read discipline and service posters (0024) ---------------
-- 0024's policy, unchanged, plus two fail-closed branches. Each subquery runs under anon's
-- own RLS on the joined table, so a draft discipline — or a service hidden by its
-- discipline — keeps its poster private. Backed by disciplines_poster_idx and
-- services_poster_idx (the portfolio_poster_idx precedent).
drop policy if exists media_assets_public_read on public.media_assets;
create policy media_assets_public_read on public.media_assets for select using (
  tenant_id = app.effective_tenant_id()
  and provider in ('static', 'cf_images', 'stream')
  and (
    exists (select 1 from public.portfolio p
             where p.poster_media_id = media_assets.id and p.status = 'published')
    or exists (select 1 from public.portfolio_media pm
                 join public.portfolio p on p.id = pm.portfolio_id
                where pm.media_id = media_assets.id and p.status = 'published')
    or exists (select 1 from public.clients c
                where c.logo_media_id = media_assets.id and c.visible)
    or exists (select 1 from public.testimonials t
                where t.avatar_media_id = media_assets.id and t.status = 'published')
    or exists (select 1 from public.team_members m
                where m.portrait_media_id = media_assets.id and m.status = 'published')
    or exists (select 1 from public.page_sections s
                 join public.pages pg on pg.id = s.page_id
                where s.visible and pg.status = 'published'
                  and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                                        jsonb_build_object('id', media_assets.id::text)))
    -- 0028
    or exists (select 1 from public.disciplines d
                where d.poster_media_id = media_assets.id and d.status = 'published')
    or exists (select 1 from public.services sv
                where sv.poster_media_id = media_assets.id and sv.status = 'published')
  )
);

-- media_usage v3: 0024's references plus the two posters. SECURITY INVOKER, as before.
create or replace function public.media_usage(p_media_id uuid)
  returns table (entity_type text, entity_id uuid, label text)
  language sql stable security invoker set search_path = public, app, pg_temp as $$
  select 'portfolio'::text, p.id, p.slug::text
    from public.portfolio p
   where p.tenant_id = app.effective_tenant_id() and p.poster_media_id = p_media_id
  union all
  select 'portfolio_media', pm.portfolio_id, pm.role
    from public.portfolio_media pm
   where pm.tenant_id = app.effective_tenant_id() and pm.media_id = p_media_id
  union all
  select 'client', c.id, c.slug::text
    from public.clients c
   where c.tenant_id = app.effective_tenant_id() and c.logo_media_id = p_media_id
  union all
  select 'testimonial', t.id, t.slug::text
    from public.testimonials t
   where t.tenant_id = app.effective_tenant_id() and t.avatar_media_id = p_media_id
  union all
  select 'team_member', m.id, m.slug::text
    from public.team_members m
   where m.tenant_id = app.effective_tenant_id() and m.portrait_media_id = p_media_id
  union all
  select 'page_section', s.id, s.type
    from public.page_sections s
   where s.tenant_id = app.effective_tenant_id()
     and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                           jsonb_build_object('id', p_media_id::text))
  union all
  select 'discipline', d.id, d.slug::text
    from public.disciplines d
   where d.tenant_id = app.effective_tenant_id() and d.poster_media_id = p_media_id
  union all
  select 'service', sv.id, sv.slug::text
    from public.services sv
   where sv.tenant_id = app.effective_tenant_id() and sv.poster_media_id = p_media_id
$$;
-- CREATE OR REPLACE keeps the ACL; re-asserted.
revoke all on function public.media_usage(uuid) from public, anon, service_role;
grant execute on function public.media_usage(uuid) to authenticated;

-- ---- Placeholder guard (0025) on service cases --------------------------------------
-- The guard branches on its argument only ('status' vs 'visible') and consults the
-- override by tg_table_name (0027) — no table list to extend.
drop trigger if exists service_cases_placeholder_guard on public.service_cases;
create trigger service_cases_placeholder_guard
  before insert or update of status, is_placeholder on public.service_cases
  for each row execute function app.tg_placeholder_guard('status');

-- ---- dashboard_attention v3: + service cases -----------------------------------------
-- 0025's definition, plus the case rows in the same six columns (slug from the service).
-- security_invoker restated: create or replace view does not inherit it.
create or replace view public.dashboard_attention with (security_invoker = true) as
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
   where b.status = 'published' and (b.cover_image_url is null or b.cover_image_url = '')
  -- ---- v2 ----
  union all
  select case when p.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.is_placeholder and p.status <> 'archived'
  union all
  select case when t.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where t.is_placeholder and t.status <> 'archived'
  union all
  select case when m.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'team_member', m.id, m.slug::text, m.name, m.updated_at
    from public.team_members m
   where m.is_placeholder and m.status <> 'archived'
  union all
  select case when st.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'statistic', st.id, st.slug::text, st.label, st.updated_at
    from public.statistics st
   where st.is_placeholder and st.status <> 'archived'
  union all
  select case when c.visible then 'placeholder_live' else 'placeholder_pending' end,
         'client', c.id, c.slug::text, c.name, c.updated_at
    from public.clients c
   where c.is_placeholder
  union all
  select case when ps.visible and pg.status = 'published' then 'placeholder_live'
              else 'placeholder_pending' end,
         'page_section', ps.id, pg.slug::text,
         jsonb_build_object('en', ps.type, 'ar', ps.type), ps.updated_at
    from public.page_sections ps
    join public.pages pg on pg.id = ps.page_id
   where ps.is_placeholder
  -- ---- v3 (0028) ----
  union all
  select case when sc.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'service_case', sc.id, sv.slug::text, sc.title, sc.updated_at
    from public.service_cases sc
    join public.services sv on sv.id = sc.service_id
   where sc.is_placeholder and sc.status <> 'archived'
  union all
  select 'missing_alt', 'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.status = 'published'
     and exists (
       select 1 from public.media_assets ma
        where ma.kind = 'image'
          and (ma.id = p.poster_media_id
               or ma.id in (select pm.media_id from public.portfolio_media pm
                             where pm.portfolio_id = p.id))
          and (coalesce(ma.alt ->> 'en', '') = '' or coalesce(ma.alt ->> 'ar', '') = ''))
  union all
  select 'consent_missing', 'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where cardinality(t.placements) > 0 and t.consent_obtained_at is null
     and t.status <> 'archived';

revoke all on public.dashboard_attention from anon;
grant select on public.dashboard_attention to authenticated;

-- ---- Scheduled publishing: disciplines and service cases join the cron ----------------
-- 0021's body; each table is still its own sub-transaction, so one that cannot publish is
-- logged and skipped without holding the others back. (A scheduled placeholder case is
-- refused by the 0025 guard when it is scheduled, not only when the cron flips it.)
create or replace function app.publish_scheduled() returns int
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  n int := 0;
  c int;
  t text;
begin
  foreach t in array array['disciplines', 'services', 'blog_posts', 'portfolio', 'pages',
                           'testimonials', 'service_cases'] loop
    begin
      -- testimonials: consent is already guaranteed — the CHECK refuses a scheduled row
      -- without it, unless it is a flagged sample (0028), which 0025 governs.
      execute format(
        'update public.%I set status = ''published'', published_at = coalesce(published_at, now())
          where status = ''scheduled'' and scheduled_for is not null and scheduled_for <= now()', t);
      get diagnostics c = row_count;
      n := n + c;
    exception when others then
      raise warning 'publish_scheduled: % skipped (%: %)', t, sqlstate, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke all on function app.publish_scheduled() from public, anon, authenticated, service_role;

-- ---- Grants (stated, never inherited — 0011 §5; after the policies above) -------------
revoke all on public.disciplines, public.service_cases from anon, authenticated;
grant select (id, tenant_id, slug, name, short, blurb, poster_media_id, preview_video_path,
              preview_start_s, preview_end_s, status, sort_order, published_at, updated_at)
  on public.disciplines to anon;
-- Never is_placeholder / scheduled_for / version / created_by / updated_by.
grant select (id, tenant_id, service_id, portfolio_id, title, context, problems, results,
              status, published_at, updated_at)
  on public.service_cases to anon;
grant select, insert, update, delete on public.disciplines, public.service_cases to authenticated;

-- ---- Postconditions ------------------------------------------------------------------
do $$
declare
  t text;
  c text;
  v_def text;
begin
  -- The new tables: forced RLS, the Admin-only gates, no anon write, column grants only.
  foreach t in array array['disciplines', 'service_cases'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = format('public.%I', t)::regclass) then
      raise exception '0028: %: RLS must be enabled AND forced', t;
    end if;
    foreach c in array array[t || '_delete_admin', t || '_archive_admin'] loop
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                      and policyname = c and permissive = 'RESTRICTIVE') then
        raise exception '0028: % is missing or not RESTRICTIVE', c;
      end if;
    end loop;
    if has_table_privilege('anon', format('public.%I', t), 'select') then
      raise exception '0028: anon holds TABLE-level select on % (column grant only)', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'insert')
       or has_table_privilege('anon', format('public.%I', t), 'update')
       or has_table_privilege('anon', format('public.%I', t), 'delete')
       or has_table_privilege('anon', format('public.%I', t), 'truncate') then
      raise exception '0028: anon holds a write privilege on %', t;
    end if;
    foreach c in array array['scheduled_for', 'version', 'created_by', 'updated_by'] loop
      if has_column_privilege('anon', format('public.%I', t), c, 'select') then
        raise exception '0028: anon can read %.%', t, c;
      end if;
    end loop;
    if not exists (select 1 from pg_trigger
                    where tgrelid = format('public.%I', t)::regclass
                      and tgname = t || '_snapshot' and not tgisinternal) then
      raise exception '0028: % has no content_versions snapshot trigger', t;
    end if;
  end loop;
  if has_column_privilege('anon', 'public.service_cases', 'is_placeholder', 'select') then
    raise exception '0028: anon can read service_cases.is_placeholder';
  end if;
  if not has_column_privilege('anon', 'public.disciplines', 'name', 'select')
     or not has_column_privilege('anon', 'public.service_cases', 'problems', 'select') then
    raise exception '0028: anon cannot read the public discipline / case columns';
  end if;
  -- services keep their TABLE-level anon grant (0011), so the new columns are public as the
  -- rows are (the 0023 postcondition style).
  if not has_column_privilege('anon', 'public.services', 'discipline_id', 'select')
     or not has_column_privilege('anon', 'public.services', 'value_points', 'select')
     or not has_column_privilege('anon', 'public.services', 'poster_media_id', 'select') then
    raise exception '0028: anon cannot read a new services column (a table grant was narrowed?)';
  end if;
  foreach c in array array['service_cases_published_parent', 'services_discipline_published',
                           'services_discipline_in_tenant'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public'
                    and policyname = c and permissive = 'RESTRICTIVE') then
      raise exception '0028: % is missing or not RESTRICTIVE', c;
    end if;
  end loop;

  -- Testimonials: consent-or-sample, validated; the sample lock is in place.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.testimonials'::regclass and conname = 'testimonials_consent_gate'
     and contype = 'c' and convalidated;
  if v_def is null or v_def not like '%consent_obtained_at IS NOT NULL%'
     or v_def not like '%is_placeholder%' then
    raise exception '0028: testimonials_consent_gate is not the validated consent-or-sample rule (%)', v_def;
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.testimonials'::regclass
                    and tgname = 'testimonials_sample_lock' and not tgisinternal) then
    raise exception '0028: the testimonial sample lock trigger is missing';
  end if;

  -- The override: exactly the seven tables.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'app.placeholder_live_override'::regclass
     and conname = 'placeholder_live_override_table';
  foreach c in array array['portfolio', 'team_members', 'statistics', 'clients',
                           'page_sections', 'testimonials', 'service_cases'] loop
    if v_def is null or v_def not like format('%%''%s''%%', c) then
      raise exception '0028: the override CHECK does not allow % (%)', c, v_def;
    end if;
  end loop;
  if (select count(*) from pg_constraint
       where conrelid = 'app.placeholder_live_override'::regclass and contype = 'c') <> 2 then
    raise exception '0028: app.placeholder_live_override must carry exactly its table and reason CHECKs';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'placeholder_live_override_audit'
                  and tgrelid = 'app.placeholder_live_override'::regclass and not tgisinternal) then
    raise exception '0028: the override audit trigger (0027) is missing';
  end if;

  -- The guard now covers seven tables.
  foreach t in array array['portfolio', 'testimonials', 'team_members', 'statistics',
                           'clients', 'page_sections', 'service_cases'] loop
    if not exists (select 1 from pg_trigger
                    where tgrelid = format('public.%I', t)::regclass
                      and tgname = t || '_placeholder_guard' and not tgisinternal) then
      raise exception '0028: % has no placeholder guard', t;
    end if;
  end loop;

  -- Statistics accept the services placement.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.statistics'::regclass and conname = 'statistics_placements_check';
  if v_def is null or v_def not like '%''services''%' then
    raise exception '0028: statistics_placements_check does not allow services (%)', v_def;
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.statistics'::regclass and conname = 'statistics_placement_labels_shape';
  if v_def is null or v_def not like '%''services''%' then
    raise exception '0028: statistics_placement_labels_shape has no services branch (%)', v_def;
  end if;

  -- leads_safe: invoker rights, the new column, and still none of the gated ones.
  if not (select coalesce(reloptions::text[] @> array['security_invoker=true'], false)
            from pg_class where oid = 'public.leads_safe'::regclass) then
    raise exception '0028: leads_safe lost security_invoker — every authenticated role would read all leads';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'leads_safe' and column_name = 'discipline_of_interest') then
    raise exception '0028: leads_safe is missing discipline_of_interest';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'leads_safe'
              and column_name in ('email_enc', 'phone_enc', 'budget_enc', 'timeline_band',
                                  'timeline_text_enc', 'internal_notes', 'ip_inet',
                                  'retention_delete_after')) then
    raise exception '0028: leads_safe exposes a gated lead column';
  end if;
  if has_table_privilege('anon', 'public.leads_safe', 'select') then
    raise exception '0028: anon can select leads_safe';
  end if;

  -- The views and functions this migration replaced keep their rights.
  if not (select coalesce((select option_value = 'true' from pg_options_to_table(c2.reloptions)
                            where option_name = 'security_invoker'), false)
            from pg_class c2 where c2.oid = 'public.dashboard_attention'::regclass) then
    raise exception '0028: dashboard_attention must stay security_invoker';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'media_usage' and p.prosecdef) then
    raise exception '0028: media_usage must stay SECURITY INVOKER';
  end if;
  foreach c in array array['app.tg_testimonial_sample_lock()', 'app.publish_scheduled()',
                           'app.tg_placeholder_guard()', 'public.media_usage(uuid)'] loop
    if has_function_privilege('anon', c, 'execute') then
      raise exception '0028: anon can execute %', c;
    end if;
  end loop;
  foreach c in array array['app.tg_testimonial_sample_lock()', 'app.publish_scheduled()'] loop
    if has_function_privilege('authenticated', c, 'execute')
       or has_function_privilege('service_role', c, 'execute') then
      raise exception '0028: an API role can execute %', c;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'media_assets' and policyname = 'media_assets_public_read') then
    raise exception '0028: media_assets_public_read is missing';
  end if;
end $$;
