-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — CMS page compositions reach visitors + the deployment marker.
-- Forward-only (expand). Depends on 0001–0015. UI v2 PR1.
--
-- 1. `grant select on public.page_sections to anon`.
--    The section engine has been CMS-driven since 2caf2d1 on paper only: 0011 left
--    page_sections out of the anon grant list ("no anonymous reader yet"), so
--    getPageSections() has thrown 42501, caught it and rendered the hard-coded
--    DEFAULT_*_SECTIONS on every request — nothing an editor composes has ever reached a
--    visitor. 0011 §5b already installed the restrictive fence this grant needs
--    (page_sections_published_only: visible section of a PUBLISHED page, or staff), and
--    rls_restrictive_0011.test.sql pinned the grant with a throws_ok "that will fail and
--    demand a decision" the day it is added. This is that decision.
--
--    ⚠ PRE-FLIGHT before applying to production: this makes every already-published,
--    visible section live on the next request. Review them first —
--      select pg.slug, s.type, s.sort_order, s.visible
--        from public.page_sections s join public.pages pg on pg.id = s.page_id
--       where pg.status = 'published' order by pg.slug, s.sort_order;
--
-- 2. `page_sections.is_placeholder` — design-delivery placeholder rows (UI v2 decision 7)
--    are seeded published in local/CI/staging and as drafts in production; 0025 adds the
--    production-only guard that stops one being made visible there.
--
-- 3. Section history: page_sections joins the polymorphic content_versions snapshot
--    (it was the one CMS surface with no history at all).
--
-- 4. `app.deployment` — which environment this database IS. Nothing could tell staging
--    from production at the database layer, so "seed placeholders published, but never in
--    production" could only be a convention. The marker is set ONCE per environment by
--    the launch runbook, read by supabase/seed.sql (which refuses to run in production),
--    by the 0025 placeholder guard, and by scripts/deploy-guard.sh.
--
-- CLAUDE.md §3 (Pillar 1), §8, §9. Plan: check-latest-folder-in-dazzling-widget.md.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Deployment marker (private schema; not reachable through PostgREST) ------
-- Environment-scoped, not tenant-scoped: it describes the database, so it carries no
-- tenant_id. RLS is still enabled + forced with NO policy, so even a future grant would
-- read zero rows — the only readers are the table owner and SECURITY DEFINER code.
create table if not exists app.deployment (
  singleton boolean primary key default true check (singleton),
  env text not null check (env in ('production', 'staging', 'development')),
  set_at timestamptz not null default now()
);
alter table app.deployment enable row level security;
alter table app.deployment force row level security;
revoke all on app.deployment from public, anon, authenticated, service_role;
comment on table app.deployment is
  'Which environment this database is. Set once by the launch runbook (production) — '
  'read by seed.sql, the placeholder guard (0025) and scripts/deploy-guard.sh.';

-- The runbook creates a read-only `deploy_guard` login role for the CI deploy guard.
-- Where it already exists, give it exactly this table; the runbook re-grants otherwise.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'deploy_guard') then
    execute 'grant usage on schema app to deploy_guard';
    execute 'grant select on app.deployment to deploy_guard';
  end if;
end $$;

-- True only on the database the runbook has marked 'production'. SECURITY DEFINER so a
-- trigger can consult it without the caller holding any privilege on the marker. Not
-- executable by any API role: nothing needs to ASK the question, only to be governed by
-- the answer.
create or replace function app.is_production() returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.deployment where env = 'production')
$$;
revoke all on function app.is_production() from public, anon, authenticated, service_role;

-- ---- 2. page_sections: placeholder flag + history -------------------------------
alter table public.page_sections
  add column if not exists is_placeholder boolean not null default false;

drop trigger if exists page_sections_snapshot on public.page_sections;
create trigger page_sections_snapshot after insert or update on public.page_sections
  for each row execute function app.tg_snapshot_version('page_section');

-- ---- 3. The grant ---------------------------------------------------------------
grant select on public.page_sections to anon;

-- ---- 4. Postconditions ----------------------------------------------------------
do $$
begin
  if not has_table_privilege('anon', 'public.page_sections', 'select') then
    raise exception 'anon still cannot select page_sections';
  end if;
  if has_table_privilege('anon', 'public.page_sections', 'insert')
     or has_table_privilege('anon', 'public.page_sections', 'update')
     or has_table_privilege('anon', 'public.page_sections', 'delete')
     or has_table_privilege('anon', 'public.page_sections', 'truncate') then
    raise exception 'anon holds a write privilege on page_sections';
  end if;
  -- The grant is only safe BEHIND the 0011 fence. If someone dropped it or recreated it
  -- permissive, every draft page body would now be one anonymous request away.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'page_sections'
       and policyname = 'page_sections_published_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'page_sections_published_only is missing or not RESTRICTIVE — refusing to open anon reads';
  end if;
  if has_table_privilege('anon', 'app.deployment', 'select')
     or has_table_privilege('authenticated', 'app.deployment', 'select')
     or has_table_privilege('service_role', 'app.deployment', 'select') then
    raise exception 'app.deployment is readable by an API role';
  end if;
  if has_function_privilege('anon', 'app.is_production()', 'execute')
     or has_function_privilege('authenticated', 'app.is_production()', 'execute') then
    raise exception 'app.is_production() is executable by an API role';
  end if;
end $$;
