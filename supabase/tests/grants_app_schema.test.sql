-- pgTAP: schema `app` + schema `public` privileges (migration 0011).
--
-- This is the test that did not exist when it was needed. `anon` had no USAGE on schema
-- `app`, every RLS policy calls a helper that lives there, and so EVERY public read
-- failed with 42501 `permission denied for schema app` — the entire site, in production.
-- The 464-test Vitest suite was green throughout because it mocks the database: a GRANT
-- is invisible to a mock. Postgres authorization is two gates in sequence — GRANTs first,
-- RLS second — and only a test that talks to real Postgres as the real role sees the first.
--
-- Two halves, both blocking:
--   1. NOT BROKEN — anon/authenticated can reach what the policies need, or the site 500s.
--   2. NOT OPEN   — anon cannot reach anything else, or 0011 traded an outage for a leak.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §9.

begin;
select plan(53);

-- ---- 1. The schema gate itself -------------------------------------------------------
select ok(
  has_schema_privilege('anon', 'app', 'usage'),
  'anon has USAGE on schema app (without this every RLS policy fails 42501)'
);
select ok(
  has_schema_privilege('authenticated', 'app', 'usage'),
  'authenticated has USAGE on schema app'
);

-- ---- 2. The helper allowlist — what the policies actually call ------------------------
-- Every one of these appears in a USING/WITH CHECK expression. A policy is evaluated with
-- the QUERYING role's privileges, so a missing EXECUTE here is a hard outage, not a
-- degraded path. SECURITY DEFINER does not help: definer governs what the BODY may touch,
-- never the right to CALL.
select ok(has_function_privilege('anon', 'app.effective_tenant_id()', 'execute'),
  'anon can execute app.effective_tenant_id()');
select ok(has_function_privilege('anon', 'app.current_tenant_id()', 'execute'),
  'anon can execute app.current_tenant_id()');
select ok(has_function_privilege('anon', 'app.default_tenant_id()', 'execute'),
  'anon can execute app.default_tenant_id() (the anon fence)');
select ok(has_function_privilege('anon', 'app.current_role()', 'execute'),
  'anon can execute app.current_role()');
select ok(has_function_privilege('anon', 'app.is_staff()', 'execute'),
  'anon can execute app.is_staff() (the restrictive policies branch on it)');
select ok(has_function_privilege('anon', 'app.is_admin()', 'execute'),
  'anon can execute app.is_admin()');
select ok(has_function_privilege('anon', 'app.can_write_content()', 'execute'),
  'anon can execute app.can_write_content()');
select ok(has_function_privilege('authenticated', 'app.ar_tsvector(text)', 'execute'),
  'authenticated can execute app.ar_tsvector(text) — services/blog/portfolio search_ar are '
  'STORED generated columns re-evaluated in the WRITER''s session on every insert/update');

-- ---- 3. Default-deny — the privileged routines stay unreachable -----------------------
-- Postgres grants EXECUTE to PUBLIC by default, so opening the schema without revoking
-- first would have handed an anonymous visitor a data-deletion primitive.
select ok(not has_function_privilege('anon', 'app.purge_leads()', 'execute'),
  'anon CANNOT execute app.purge_leads()');
select ok(not has_function_privilege('anon', 'app.purge_telemetry()', 'execute'),
  'anon CANNOT execute app.purge_telemetry()');
select ok(not has_function_privilege('anon', 'app.run_retention()', 'execute'),
  'anon CANNOT execute app.run_retention()');
select ok(not has_function_privilege('anon', 'app.publish_scheduled()', 'execute'),
  'anon CANNOT execute app.publish_scheduled()');
select ok(not has_function_privilege('authenticated', 'app.purge_leads()', 'execute'),
  'authenticated CANNOT execute app.purge_leads() either — staff use the CMS, not the routine');
select ok(not has_function_privilege('anon', 'app.retention_max_int(text, int)', 'execute'),
  'anon CANNOT execute app.retention_max_int() — SECURITY DEFINER, reads site_settings '
  'past its staff-only policy with no tenant predicate');
select ok(not has_function_privilege('anon', 'app.tg_audit_chain()', 'execute'),
  'anon CANNOT execute app.tg_audit_chain() — it reads the Vault HMAC key');

-- ---- 4. Exhaustive: nothing outside the allowlist is reachable ------------------------
-- A named-function list rots the moment migration 0013 adds one. This assertion is a
-- property of the catalog instead, so a new PUBLIC-executable app.* routine fails here
-- rather than shipping.
-- Identity is `proname(oidvectortypes(proargtypes))`, and it took two runs of this suite
-- to get there — both failures being the assertion's own formatting, not a real leak:
--   `oid::regprocedure`               → app."current_role"()   (quotes reserved words)
--   `pg_get_function_identity_arguments` → normalize_ar(t text)  (includes param NAMES)
-- `oidvectortypes` yields bare type names with no quoting and no parameter names, which
-- is the only spelling of "which function is this" that is stable to both.
select is(
  (
    select coalesce(
             string_agg(
               p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')',
               ', ' order by p.proname
             ),
             ''
           )
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and has_function_privilege('anon', p.oid, 'execute')
       and p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' not in (
         'effective_tenant_id()', 'current_tenant_id()', 'default_tenant_id()',
         'current_role()', 'is_staff()', 'is_admin()', 'can_write_content()',
         'normalize_ar(text)', 'normalize_ar_q(text)', 'ar_fts_text(text, boolean)'
       )
  ),
  '',
  'no app.* routine outside the read-only allowlist is executable by anon'
);

-- ---- 5. Table privileges — RLS is only reached AFTER the GRANT passes -----------------
select ok(has_table_privilege('anon', 'public.services', 'select'),
  'anon has SELECT on services');
select ok(has_table_privilege('anon', 'public.entity_seo', 'select'),
  'anon has SELECT on entity_seo (src/lib/data/seo.ts reads it anonymously)');

-- SELECT and ONLY select. Supabase's stock bootstrap grants ALL on public tables to anon,
-- so an additive `grant select` would have left INSERT/UPDATE/DELETE/TRUNCATE in place —
-- RLS as the only guard, one layer not two, and TRUNCATE is not subject to RLS at all.
select is(
  (
    select coalesce(string_agg(distinct c.relname || ':' || pr.priv, ', '), '')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['insert', 'update', 'delete', 'truncate']) as pr(priv)
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and has_table_privilege('anon', c.oid, pr.priv)
  ),
  '',
  'anon holds NO insert/update/delete/truncate anywhere in schema public'
);

-- ---- 6. The tables anon must never reach at all --------------------------------------
select ok(not has_table_privilege('anon', 'public.leads', 'select'),
  'anon CANNOT select public.leads');
select ok(not has_table_privilege('anon', 'public.audit_log', 'select'),
  'anon CANNOT select public.audit_log');
select ok(not has_table_privilege('anon', 'public.profiles', 'select'),
  'anon CANNOT select public.profiles');
select ok(not has_table_privilege('anon', 'public.site_integrations', 'select'),
  'anon CANNOT select public.site_integrations (API keys)');

-- ---- 7. UI v2 additions (0016, 0019) --------------------------------------------------
-- The two new public surfaces are SELECT-only (the insert/update/delete/truncate sweep in
-- §5 above already covers their write side), and the deployment marker — which decides
-- whether the production-only guards are armed — is reachable by no API role at all.
select ok(has_table_privilege('anon', 'public.page_sections', 'select'),
  'anon has SELECT on page_sections (0016: CMS compositions reach visitors; 0011 fence applies)');
select ok(has_table_privilege('anon', 'public.site_profile', 'select'),
  'anon has SELECT on site_profile (0019: the public identity renders on every page)');
select ok(
  not has_table_privilege('anon', 'app.deployment', 'select')
  and not has_table_privilege('authenticated', 'app.deployment', 'select')
  and not has_table_privilege('service_role', 'app.deployment', 'select'),
  'app.deployment is unreadable by anon, authenticated and service_role');
select ok(
  not has_function_privilege('authenticated', 'app.is_production()', 'execute')
  and not has_function_privilege('authenticated', 'app.tg_site_profile_guard()', 'execute'),
  'the 0016/0019 app.* routines are not executable by authenticated either');
select ok(not has_table_privilege('authenticated', 'public.site_profile', 'delete'),
  'authenticated CANNOT delete the site_profile singleton');

-- ---- 8. The deploy guard can actually READ the marker (0016) ------------------------
-- RLS on app.deployment is forced, and deploy_guard is NOBYPASSRLS. Without its policy
-- the guard read '<unset>' and blocked every production deploy — a grant is not enough.
-- Roles created here are rolled back with the transaction. PG15 does not make the creator
-- a member of a role it creates, hence the explicit grant before SET ROLE. The two roles
-- also get USAGE on pgTAP's own schema: the assertions run AS them, and a schema without
-- USAGE is silently skipped on the search_path — is() would "not exist".
do $$
declare
  v_pgtap text;
begin
  if not exists (select 1 from pg_roles where rolname = 'deploy_guard') then
    create role deploy_guard nologin nobypassrls;
  end if;
  create role pgtap_other_reader nologin nobypassrls;
  execute format('grant deploy_guard, pgtap_other_reader to %I', current_user);
  select n.nspname into v_pgtap
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgtap';
  execute format('grant usage on schema %I to deploy_guard, pgtap_other_reader', v_pgtap);
end $$;
grant usage on schema app to deploy_guard, pgtap_other_reader;
grant select on app.deployment to deploy_guard, pgtap_other_reader;
insert into app.deployment (env) values ('staging')
  on conflict (singleton) do update set env = excluded.env;

set local role deploy_guard;
select is((select env from app.deployment), 'staging',
  'deploy_guard (NOBYPASSRLS) reads the marker through its SELECT policy');
select throws_ok($$ update app.deployment set env = 'production' $$, '42501', null,
  'deploy_guard cannot re-label the database (no write privilege)');
reset role;

set local role pgtap_other_reader;
select is((select count(*)::int from app.deployment), 0,
  'any OTHER grantee still reads zero rows — the policy admits deploy_guard only');
reset role;

-- ---- 9. UI v2 content model (0020–0025): the exact anon read surface ------------------
-- A property of the catalog, not a list of spot checks: any table or view anon can SELECT
-- at table level is named here, so a future grant (or a Supabase default that slipped
-- back in) fails this line instead of quietly publishing a table.
select is(
  (select string_agg(c.relname::text, ', ' order by c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and has_table_privilege('anon', c.oid, 'select')),
  'ai_questions, ai_styles, blog_posts, categories, certifications, clients, entity_seo, '
  'navigation, page_sections, pages, partner_logos, portfolio, portfolio_media, '
  'portfolio_services, sectors, seo_defaults, services, site_profile, statistics, team_members',
  'anon''s table-level SELECT is exactly the public content tables');

-- Column-level surfaces: testimonials without the consent record, media without internals.
select ok(not has_table_privilege('anon', 'public.testimonials', 'select'),
  'anon has no TABLE-level select on testimonials (column grant only)');
select ok(has_column_privilege('anon', 'public.testimonials', 'quote', 'select'),
  'anon reads testimonial quotes');
select ok(not has_column_privilege('anon', 'public.testimonials', 'consent_reference', 'select')
          and not has_column_privilege('anon', 'public.testimonials', 'consent_obtained_at', 'select'),
  'anon CANNOT read the testimonial consent record');
select ok(not has_table_privilege('anon', 'public.media_assets', 'select'),
  'anon has no TABLE-level select on media_assets (column grant only)');
select ok(has_column_privilege('anon', 'public.media_assets', 'storage_path', 'select'),
  'anon reads media storage keys (the 0024 policy decides which rows)');
select ok(not has_column_privilege('anon', 'public.media_assets', 'folder', 'select')
          and not has_column_privilege('anon', 'public.media_assets', 'provider_ref', 'select')
          and not has_column_privilege('anon', 'public.media_assets', 'tags', 'select'),
  'anon CANNOT read media internals (folder, tags, provider_ref)');

-- RPCs: staff only.
select ok(not has_function_privilege('anon', 'public.update_media_meta(uuid, int, jsonb)', 'execute'),
  'anon CANNOT execute update_media_meta()');
select ok(not has_function_privilege('anon', 'public.media_usage(uuid)', 'execute'),
  'anon CANNOT execute media_usage()');
select ok(not has_function_privilege('anon', 'public.save_portfolio(uuid, int, jsonb, uuid[], jsonb)', 'execute'),
  'anon CANNOT execute save_portfolio()');
select ok(has_function_privilege('authenticated', 'public.save_portfolio(uuid, int, jsonb, uuid[], jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.media_usage(uuid)', 'execute'),
  'authenticated can execute the three staff RPCs (RLS / role checks decide the rest)');
select ok(not has_function_privilege('authenticated', 'app.tg_placeholder_guard()', 'execute'),
  'the 0025 placeholder guard is not callable by authenticated');

-- ---- 10. Round 2 (0028): disciplines and service cases are column-granted ------------
-- Neither is in the table-level list above: anon reads the listed columns only, never the
-- schedule, version, actor or placeholder columns.
select ok(not has_table_privilege('anon', 'public.disciplines', 'select'),
  'anon has no TABLE-level select on disciplines (column grant only)');
select ok(has_column_privilege('anon', 'public.disciplines', 'name', 'select')
          and has_column_privilege('anon', 'public.disciplines', 'preview_video_path', 'select'),
  'anon reads the public discipline columns');
select ok(not has_column_privilege('anon', 'public.disciplines', 'scheduled_for', 'select')
          and not has_column_privilege('anon', 'public.disciplines', 'version', 'select')
          and not has_column_privilege('anon', 'public.disciplines', 'created_by', 'select')
          and not has_column_privilege('anon', 'public.disciplines', 'updated_by', 'select'),
  'anon CANNOT read discipline internals (scheduled_for, version, created_by, updated_by)');
select ok(not has_table_privilege('anon', 'public.service_cases', 'select'),
  'anon has no TABLE-level select on service_cases (column grant only)');
select ok(has_column_privilege('anon', 'public.service_cases', 'title', 'select')
          and has_column_privilege('anon', 'public.service_cases', 'results', 'select'),
  'anon reads the public case columns');
select ok(not has_column_privilege('anon', 'public.service_cases', 'is_placeholder', 'select')
          and not has_column_privilege('anon', 'public.service_cases', 'scheduled_for', 'select')
          and not has_column_privilege('anon', 'public.service_cases', 'version', 'select')
          and not has_column_privilege('anon', 'public.service_cases', 'created_by', 'select')
          and not has_column_privilege('anon', 'public.service_cases', 'updated_by', 'select'),
  'anon CANNOT read case internals (is_placeholder, scheduled_for, version, created_by, updated_by)');
select ok(has_table_privilege('authenticated', 'public.disciplines', 'insert')
          and has_table_privilege('authenticated', 'public.disciplines', 'delete')
          and has_table_privilege('authenticated', 'public.service_cases', 'update')
          and has_table_privilege('authenticated', 'public.service_cases', 'delete'),
  'the CMS can write both (RLS and assertCap() decide who)');
select ok(not has_function_privilege('authenticated', 'app.tg_testimonial_sample_lock()', 'execute')
          and not has_function_privilege('anon', 'app.tg_testimonial_sample_lock()', 'execute')
          and not has_function_privilege('service_role', 'app.tg_testimonial_sample_lock()', 'execute'),
  'the 0028 testimonial sample lock is not callable by any API role');

select * from finish();
rollback;
