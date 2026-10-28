-- The release switch-on's read-back (Admin v2 R14-prep; docs/launch-runbook.md §6p). ONE row.
-- Run as `postgres` (the SQL editor or psql) on production, BEFORE `app.enable_releases` (the
-- "before" column) and AFTER it (the "after" column), and again after the drill and after any
-- `app.disable_releases`. Read-only: catalog reads and counts of the launch tenant (the first
-- tenant, as the Worker's crons resolve it); no row contents, no personal data. The ledger is
-- looked up by version, never by the max. tests/lib/releasesRunbook.spec.ts holds every column
-- below to the two lists, and the eight tables to app.enable_releases's own (0112).
--
-- Expected before the switch:
--   runner_bypasses_rls          = true    (else the counts below are RLS-filtered)
--   tenants                      = 1
--   ledger_has_0112              = true    (R11: the two switches)
--   ledger_has_0116              = true    (R13: main's highest at R14-prep)
--   switches_owner_only          = true    (no API role holds EXECUTE on either switch)
--   releases_on                  = false
--   release_tenants              = 0
--   pending_changes              = 0       (else enable refuses, 55000)
--   scheduled_releases           = 0
--   applying_releases            = 0       (else enable refuses, 55P03: try again)
--   published_versions           = 0
--   baselines                    = 0
--   live_version                 = null
--   legacy_to_convert            = n       (enable's `converted`: rows scheduled with a time)
--   left_scheduled               = m       (enable's `left_scheduled`: left as they are)
--   active_admins                = >= 1    (the operator and the fallback scheduler are among them)
--   identity_rows                = 1       (the intake switch updates it; the guard refuses an
--                                          insert outside a release once releases are on)
--   publish_scheduled_job        = true    (pg_cron: still publishes for a tenant with releases off)
--   enable_audits                = 0
-- Expected after the switch (and before the drill):
--   runner_bypasses_rls, tenants, ledger_*, switches_owner_only, active_admins, identity_rows
--   and publish_scheduled_job as before, and:
--   releases_on                  = true
--   release_tenants              = 1
--   pending_changes              = n       (the converted rows, each claimed by its release)
--   scheduled_releases           = enable's `legacy_releases`
--   applying_releases            = 0
--   published_versions           = 1
--   baselines                    = 1
--   live_version                 = 1
--   legacy_to_convert            = 0
--   left_scheduled               = m
--   enable_audits                = 1
-- After the drill: published_versions = 3 and live_version = 3 (the publish and its rollback),
-- pending_changes and scheduled_releases as right after the switch. After a switch-off:
-- releases_on = false, release_tenants = 0, pending_changes = 0, scheduled_releases = 0.

with
t as (
  select tn.id from public.tenants tn order by tn.created_at asc limit 1
),
lg as (
  select m.version::text as version from supabase_migrations.schema_migrations m
),
switches as (
  select p.oid from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname in ('enable_releases', 'disable_releases')
)
select
  coalesce((select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r
             where r.rolname = current_user), false) as runner_bypasses_rls,
  (select count(*) from public.tenants) as tenants,
  exists (select 1 from lg where lg.version = '0112') as ledger_has_0112,
  exists (select 1 from lg where lg.version = '0116') as ledger_has_0116,
  (select count(*) = 2
          and bool_and(not pg_catalog.has_function_privilege('anon', s.oid, 'execute')
                       and not pg_catalog.has_function_privilege('authenticated', s.oid, 'execute')
                       and not pg_catalog.has_function_privilege('service_role', s.oid, 'execute'))
     from switches s) as switches_owner_only,
  app.releases_enabled((select id from t)) as releases_on,
  (select count(*) from app.release_tenants) as release_tenants,
  (select count(*) from public.content_drafts d where d.tenant_id = (select id from t))
    as pending_changes,
  (select count(*) from public.content_releases r
    where r.tenant_id = (select id from t) and r.status = 'scheduled') as scheduled_releases,
  (select count(*) from public.content_releases r
    where r.tenant_id = (select id from t) and r.status = 'applying') as applying_releases,
  (select count(*) from public.content_releases r
    where r.tenant_id = (select id from t) and r.status = 'published') as published_versions,
  (select count(*) from public.content_releases r
    where r.tenant_id = (select id from t) and r.status = 'published' and r.kind = 'baseline')
    as baselines,
  (select max(r.number) from public.content_releases r
    where r.tenant_id = (select id from t) and r.status = 'published') as live_version,
  (select
       (select count(*) from public.disciplines x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.services x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.blog_posts x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.portfolio x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.pages x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.testimonials x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.service_cases x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
     + (select count(*) from public.faq_items x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is not null)
  ) as legacy_to_convert,
  (select
       (select count(*) from public.disciplines x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.services x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.blog_posts x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.portfolio x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.pages x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.testimonials x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.service_cases x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.faq_items x where x.tenant_id = (select id from t) and x.status = 'scheduled' and x.scheduled_for is null)
     + (select count(*) from public.team_members x where x.tenant_id = (select id from t) and x.status = 'scheduled')
     + (select count(*) from public.statistics x where x.tenant_id = (select id from t) and x.status = 'scheduled')
     + (select count(*) from public.certifications x where x.tenant_id = (select id from t) and x.status = 'scheduled')
  ) as left_scheduled,
  (select count(*) from public.profiles p
    where p.tenant_id = (select id from t) and p.role::text = 'admin' and p.is_active
      and (p.locked_until is null or p.locked_until <= pg_catalog.now())) as active_admins,
  (select count(*) from public.site_profile s where s.tenant_id = (select id from t))
    as identity_rows,
  exists (select 1 from cron.job j where j.jobname = 'publish-scheduled') as publish_scheduled_job,
  (select count(*) from public.audit_log a
    where a.tenant_id = (select id from t) and a.action = 'releases.enable') as enable_audits;
