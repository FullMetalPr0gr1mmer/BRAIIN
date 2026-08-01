-- pgTAP: RLS for the Phase-3 CMS tables (migration 0009).
--
-- This is the PRIMARY authorization layer. The Vitest suite in
-- tests/authz/endpoints.spec.ts proves the SECONDARY one (assertCap) against a stubbed
-- database; only Postgres can prove a policy, so the three splits that migration 0009
-- exists for are asserted here:
--
--   entity_seo        Admin + SEO write · Content Creator read-only
--   site_integrations Admin + SEO        (NOT Developer, who owns general settings)
--   ai_config         Admin ALONE        (NOT Content Creator, who authors questions)
--
-- ── A note on how a denied write actually fails ──────────────────────────────────
-- It is tempting to assert `throws_ok(..., '42501')` for every refused write. That is
-- wrong for most of them, and the difference matters when reading these tests.
--
--   • A policy's USING clause FILTERS rows. An UPDATE or DELETE that matches no rows
--     affects zero rows and raises NOTHING. This is the common case below.
--   • 42501 is raised only when a row passes USING but its new value fails WITH CHECK
--     (the archive gates in migrations 0001/0007), or when an INSERT fails WITH CHECK.
--
-- So "cannot write" is asserted as "affects zero rows" unless the policy is genuinely a
-- WITH CHECK violation. An endpoint turns that zero into a 403 rather than a cheerful
-- no-op — see `deleteRow` in src/lib/admin/crud.ts.
--
-- Run with `supabase test db`.

begin;
select plan(26);

-- Setup runs as the migration role, where RLS is bypassed.
--
-- Fixtures go in the LAUNCH tenant rather than one this file invents. `anon` carries no
-- claims, so app.effective_tenant_id() falls through to app.default_tenant_id() — the
-- FIRST tenant by created_at, which `supabase start` has already created via seed.sql.
-- A locally-invented tenant is invisible to anon, which is why the three anon assertions
-- below read 0 the first time this suite ever ran.

-- Two REAL parent entities, one published and one draft. entity_seo's restrictive
-- SELECT policy (migration 0011) joins each row to its parent's status, so the fixture
-- has to contain a parent at all — before 0011 these rows pointed at a service id that
-- never existed, which made "anon reads entity_seo" pass for the wrong reason.
insert into public.services (id, tenant_id, slug, title, status) values
  ('00000000-0000-0000-0000-0000000000c1', app.default_tenant_id(),
   'live-service', '{"en":"Live","ar":"مباشر"}'::jsonb, 'published'),
  ('00000000-0000-0000-0000-0000000000c2', app.default_tenant_id(),
   'draft-service', '{"en":"Draft","ar":"مسودة"}'::jsonb, 'draft');

insert into public.entity_seo (id, tenant_id, entity_type, entity_id, meta_title, meta_description)
  values (
    '00000000-0000-0000-0000-0000000000e1',
    app.default_tenant_id(),
    'service',
    '00000000-0000-0000-0000-0000000000c1',
    '{"en":"T","ar":"ت"}'::jsonb,
    '{"en":"D","ar":"د"}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-0000000000e2',
    app.default_tenant_id(),
    'service',
    '00000000-0000-0000-0000-0000000000c2',   -- meta for the DRAFT service
    '{"en":"Unreleased","ar":"غير منشور"}'::jsonb,
    '{"en":"Unreleased","ar":"غير منشور"}'::jsonb
  );

insert into public.site_integrations (tenant_id) values (app.default_tenant_id());
insert into public.ai_config (tenant_id) values (app.default_tenant_id());
insert into public.navigation (tenant_id, location, label, href, visible)
  values (app.default_tenant_id(), 'header', '{"en":"Services","ar":"خدمات"}'::jsonb, '/services', true);
insert into public.seo_defaults (tenant_id) values (app.default_tenant_id());
insert into public.search_queries (tenant_id, q) values (app.default_tenant_id(), 'branding');
insert into public.consent_log (tenant_id, subject_hash, categories, policy_version)
  values (app.default_tenant_id(), 'hash', '{"analytics":true}'::jsonb, 'v1');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The launch tenant as text, for claim injection. Staff claims must name the SAME tenant
-- the fixtures live in, or every staff assertion silently measures an empty tenant.
create function _tid() returns text language sql as $$ select app.default_tenant_id()::text $$;

-- Rows actually affected by a statement — the honest way to assert a filtered write.
create function _updated_entity_seo() returns int language sql as $$
  with u as (update public.entity_seo set robots = 'noindex' returning 1) select count(*)::int from u
$$;
create function _updated_integrations() returns int language sql as $$
  with u as (update public.site_integrations set ga4 = '{"id":"G-X"}'::jsonb returning 1)
  select count(*)::int from u
$$;
create function _updated_navigation() returns int language sql as $$
  with u as (update public.navigation set href = '/x' returning 1) select count(*)::int from u
$$;
create function _deleted_navigation() returns int language sql as $$
  with d as (delete from public.navigation returning 1) select count(*)::int from d
$$;

-- ---- entity_seo: public READ, Admin + SEO WRITE ----------------------------
-- Meta tags of PUBLISHED content ship in the HTML head, so anon reading those is by
-- design. Meta of a draft is the title and description of unreleased work, so anon
-- reading THAT is a disclosure — hence the two rows in the fixture and the 1-of-2 here.
-- This is the §9 regression assertion for the restrictive policy added in 0011.
set local role anon;
select _claims(null, null);
select is((select count(*) from public.entity_seo)::int, 1,
  'anon reads entity_seo for PUBLISHED entities only (draft meta stays hidden)');

set local role authenticated;

select _claims('content_creator', _tid());
select is((select count(*) from public.entity_seo)::int, 2, 'content_creator READS entity_seo (its "view" access)');
select is(_updated_entity_seo(), 0, 'content_creator cannot WRITE entity_seo');

select _claims('developer', _tid());
select is(_updated_entity_seo(), 0, 'developer cannot write entity_seo');

select _claims('seo', _tid());
select is(_updated_entity_seo(), 2, 'seo can write entity_seo');

select _claims('admin', _tid());
select is(_updated_entity_seo(), 2, 'admin can write entity_seo');

select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*) from public.entity_seo)::int, 0, 'admin of another tenant sees no entity_seo');

-- ---- site_integrations: Admin + SEO write, Developer refused ----------------
select _claims('developer', _tid());
select is((select count(*) from public.site_integrations)::int, 1, 'developer READS integrations (staff read)');
select is(_updated_integrations(), 0, 'developer cannot write integrations — that is SEO''s capability');

select _claims('seo', _tid());
select is(_updated_integrations(), 1, 'seo can write integrations');

select _claims('content_creator', _tid());
select is((select count(*) from public.site_integrations)::int, 1, 'content_creator reads integrations (staff read)');
select is(_updated_integrations(), 0, 'content_creator cannot write integrations');

-- ---- ai_config: Admin ALONE -------------------------------------------------
select _claims('content_creator', _tid());
select is((select count(*) from public.ai_config)::int, 0, 'content_creator cannot even read ai_config');

select _claims('developer', _tid());
select is((select count(*) from public.ai_config)::int, 0, 'developer cannot read ai_config');

select _claims('admin', _tid());
select is((select count(*) from public.ai_config)::int, 1, 'admin reads ai_config');
select lives_ok($$ update public.ai_config set daily_usd_cap = 7 $$, 'admin writes ai_config');

-- ---- navigation: public read, content authors write, Admin-only delete ------
set local role anon;
select _claims(null, null);
select is((select count(*) from public.navigation)::int, 1, 'anon reads navigation (it renders on every page)');

set local role authenticated;
select _claims('seo', _tid());
select is(_updated_navigation(), 0, 'seo cannot edit navigation');

select _claims('content_creator', _tid());
select is(_updated_navigation(), 1, 'content_creator can edit navigation');
-- The RESTRICTIVE delete policy filters rather than raising, so this is zero rows.
select is(_deleted_navigation(), 0, 'content_creator delete on navigation affects zero rows');

select _claims('admin', _tid());
select is(_deleted_navigation(), 1, 'admin can delete navigation');

-- ---- search_queries: Admin + SEO + Developer, NOT Content Creator -----------
select _claims('content_creator', _tid());
select is((select count(*) from public.search_queries)::int, 0, 'content_creator has no search analytics');
select _claims('seo', _tid());
select is((select count(*) from public.search_queries)::int, 1, 'seo reads search analytics');

-- ---- consent_log: Admin + Developer only -----------------------------------
select _claims('seo', _tid());
select is((select count(*) from public.consent_log)::int, 0, 'seo cannot read the consent ledger');
select _claims('developer', _tid());
select is((select count(*) from public.consent_log)::int, 1, 'developer reads the consent ledger');

-- ---- privileged_ops: service_role only, now denied one gate EARLIER ---------
-- This used to assert "readable, but RLS filters it to zero rows" — true when the table
-- had no policies but `authenticated` still held Supabase's stock GRANT. 0011 revoked
-- that GRANT outright (`revoke all on public.login_attempts, public.privileged_ops from
-- authenticated`), so the statement is now rejected before RLS is reached. Two gates in
-- sequence; this table no longer clears the first, which is the stronger property.
select _claims('admin', _tid());
select throws_ok(
  $$ select count(*) from public.privileged_ops $$,
  '42501', null, 'even admin is denied privileged_ops at the GRANT layer (service-role only)'
);

reset role;
select _claims(null, null);

select * from finish();
rollback;
