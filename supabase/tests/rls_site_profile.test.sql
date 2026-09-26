-- pgTAP: public.site_profile (migration 0019) — the public identity singleton.
--
-- §5 "General settings (identity, footer, localization)": Admin + Developer write,
-- Content Creator / SEO no write, everyone reads (it renders on every public page).
-- Plus one column that is narrower than its row: `accepting_applications` opens the
-- public job-application form, and job applications are Admin-only HR data — so a
-- Developer may edit every other field and must NOT be able to open intake.
--
-- RLS UPDATE by a role with no matching policy FILTERS (0 rows, no error), so write
-- denials are asserted by re-reading the value as a staff role afterwards.

begin;
select plan(21);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- Dedicated tenants created AFTER the launch tenant, so app.default_tenant_id() — the
-- anon fence — keeps resolving to the launch tenant and never to these.
insert into public.tenants (id, name) values
  ('51000000-0000-0000-0000-000000000001', 'ProfileT'),
  ('51000000-0000-0000-0000-000000000002', 'ProfileT2');
insert into public.site_profile (tenant_id, brand_name, contact_email, location)
values ('51000000-0000-0000-0000-000000000001', '{"en":"PT","ar":"ب"}', 'pt@example.test',
        '{"en":"Jeddah","ar":"جدة"}');
-- The LAUNCH tenant's profile too — the one anon is fenced to — so the positive anon read
-- below does not depend on whether seed.sql ran (conflict → keep the seeded row).
insert into public.site_profile (tenant_id, brand_name, contact_email, location)
values (app.default_tenant_id(), '{"en":"Launch","ar":"ل"}', 'launch@example.test',
        '{"en":"Jeddah","ar":"جدة"}')
on conflict (tenant_id) do nothing;

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '51000000-0000-0000-0000-000000000001' $$;
-- Read-back helpers run with the CALLER's privileges (SECURITY INVOKER, the default).
create function _brand() returns text language sql as $$
  select brand_name ->> 'en' from public.site_profile where tenant_id = _tid()::uuid $$;
create function _open() returns boolean language sql as $$
  select accepting_applications from public.site_profile where tenant_id = _tid()::uuid $$;
create function _rows() returns int language sql as $$
  select count(*)::int from public.site_profile where tenant_id = _tid()::uuid $$;

-- ── read: every staff role, and the tenant fence ─────────────────────────────
set local role authenticated;
select _claims('content_creator', _tid()); select is(_rows(), 1, 'content_creator reads the profile');
select _claims('seo', _tid());             select is(_rows(), 1, 'seo reads the profile');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
                                           select is(_rows(), 0, 'other_tenant admin sees no row');

-- ── write: CC and SEO are filtered ───────────────────────────────────────────
select _claims('content_creator', _tid());
update public.site_profile set brand_name = '{"en":"CC","ar":"ب"}' where tenant_id = _tid()::uuid;
select _claims('seo', _tid());
update public.site_profile set brand_name = '{"en":"SEO","ar":"ب"}' where tenant_id = _tid()::uuid;
select _claims('admin', _tid());
select is(_brand(), 'PT', 'content_creator and seo updates affected 0 rows (brand unchanged)');

-- ── write: Developer and Admin may edit identity ─────────────────────────────
select _claims('developer', _tid());
select lives_ok(
  $$ update public.site_profile set brand_name = '{"en":"DEV","ar":"ب"}' where tenant_id = _tid()::uuid $$,
  'developer can edit the identity (§5 General settings)');
select is(_brand(), 'DEV', 'developer edit applied');
select _claims('admin', _tid());
select lives_ok(
  $$ update public.site_profile set brand_name = '{"en":"ADM","ar":"ب"}' where tenant_id = _tid()::uuid $$,
  'admin can edit the identity');

-- other_tenant: an admin of ANOTHER tenant, with no WHERE clause, so only the policy's
-- tenant predicate can filter the row.
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
update public.site_profile set brand_name = '{"en":"XT","ar":"ب"}';
select _claims('admin', _tid());
select is(_brand(), 'ADM', 'other_tenant admin update affected 0 rows (brand unchanged)');

-- ── accepting_applications: Admin only ───────────────────────────────────────
select _claims('developer', _tid());
select throws_ok(
  $$ update public.site_profile set accepting_applications = true where tenant_id = _tid()::uuid $$,
  '42501', null, 'developer CANNOT open job applications (Admin-only HR intake)');
select _claims('admin', _tid());
select lives_ok(
  $$ update public.site_profile set accepting_applications = true where tenant_id = _tid()::uuid $$,
  'admin can open job applications');
select is(_open(), true, 'the flag is open after the admin write');

-- A Developer editing OTHER fields while the flag is already open must still work —
-- the guard fires on a CHANGE to the flag, not on its value.
select _claims('developer', _tid());
select lives_ok(
  $$ update public.site_profile set founded_year = 2019 where tenant_id = _tid()::uuid $$,
  'developer can edit other fields while applications are open');
select throws_ok(
  $$ update public.site_profile set accepting_applications = false where tenant_id = _tid()::uuid $$,
  '42501', null, 'developer CANNOT close job applications either');

-- INSERT path: the first save of a singleton is an INSERT, so an UPDATE-only guard would
-- have let a Developer create the row with intake already open.
select _claims('developer', '51000000-0000-0000-0000-000000000002');
select throws_ok(
  $$ insert into public.site_profile (tenant_id, brand_name, contact_email, location, accepting_applications)
     values ('51000000-0000-0000-0000-000000000002', '{"en":"X","ar":"س"}', 'x@example.test',
             '{"en":"J","ar":"ج"}', true) $$,
  '42501', null, 'developer CANNOT insert a profile with applications open');
select lives_ok(
  $$ insert into public.site_profile (tenant_id, brand_name, contact_email, location)
     values ('51000000-0000-0000-0000-000000000002', '{"en":"X","ar":"س"}', 'x@example.test',
             '{"en":"J","ar":"ج"}') $$,
  'developer can create the singleton with applications closed');

-- ── authenticated can never delete the singleton (no DELETE privilege) ───────
select _claims('admin', _tid());
select throws_ok(
  $$ delete from public.site_profile where tenant_id = _tid()::uuid $$,
  '42501', null, 'even admin cannot delete the singleton (DELETE is not granted)');

-- ── requests with no role claim (migrations, seeds, psql, service_role) ──────
reset role;
select _claims(null, null);
select lives_ok(
  $$ update public.site_profile set accepting_applications = false where tenant_id = _tid()::uuid $$,
  'a request with no role claim (migration / seed / service_role) may set the flag');

-- ── anon ─────────────────────────────────────────────────────────────────────
set local role anon;
select _claims(null, null);
select is(_rows(), 0, 'anon is fenced to the launch tenant — cannot read another tenant''s profile');
select is((select count(*)::int from public.site_profile where tenant_id = app.default_tenant_id()), 1,
  'anon reads the launch tenant''s profile (the 0019 public read path)');
select throws_ok(
  $$ update public.site_profile set brand_name = '{"en":"Z","ar":"ز"}' $$,
  '42501', null, 'anon cannot write site_profile (no privilege)');

-- ── structural ───────────────────────────────────────────────────────────────
reset role;
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.site_profile'::regclass),
  'site_profile has RLS enabled AND forced');

select * from finish();
rollback;
