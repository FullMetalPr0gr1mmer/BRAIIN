-- pgTAP: staged writes (migration 0062, Admin v2 R3a). Run with `supabase test db`.
--
-- Rows over admin, content_creator, seo, developer, a `sales` claim (the role arrives with
-- C10; the policies read the role from the claim), anon and another tenant's admin, plus
-- three stale Admin tokens: one whose profile was demoted to content_creator, one
-- deactivated and one locked, each still carrying an `admin` claim (CLAUDE.md §9 (b)).
--   • the catalog: public.releases_enabled is a definer over the flag, false for any
--     tenant but the caller's; public.write_drafts and app.draft_key_ok are invokers; all
--     three executable by authenticated alone; the grant set and the policy set on
--     content_drafts, every policy led by the tenant predicate;
--   • releases off (no app.release_tenants row): no role inserts or edits a draft, directly
--     or through write_drafts; a discard by a role that authors the type still works;
--   • releases on: who stages what, per area (content: Admin and Content Creator; public
--     identity and themes: Admin and Developer; SEO meta, SEO defaults and redirects: Admin
--     and SEO), removals by the delete roles, archives by Admin; sales and anon nothing;
--     another tenant neither writes nor reads tenant A's drafts;
--   • the stale tokens insert, edit and discard nothing, even for the role they claim;
--   • a singleton's draft is keyed by its tenant;
--   • write_drafts: a new draft, an edit, a discard; a moved version, a claimed draft and a
--     second draft for one entity are BR409 with their code; a batch with one bad change
--     keeps nothing; another tenant's id, a malformed call and too many changes refused;
--     RLS and CHECK refusals pass through; the changes run in a fixed order.
-- CLAUDE.md §3 (Pillar 1), §8 (Releases), §9.

begin;
select plan(81);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────
insert into public.tenants (id, name) values
  ('62000000-0000-0000-0000-00000000000a', 'R3A'),
  ('62000000-0000-0000-0000-00000000000b', 'R3B');

insert into auth.users (id, email) values
  ('62000000-0000-0000-0000-0000000000a1', 'r3-admin@example.test'),
  ('62000000-0000-0000-0000-0000000000a2', 'r3-demoted@example.test'),
  ('62000000-0000-0000-0000-0000000000a3', 'r3-inactive@example.test'),
  ('62000000-0000-0000-0000-0000000000a4', 'r3-locked@example.test'),
  ('62000000-0000-0000-0000-0000000000c1', 'r3-creator@example.test'),
  ('62000000-0000-0000-0000-0000000000e1', 'r3-seo@example.test'),
  ('62000000-0000-0000-0000-0000000000d1', 'r3-developer@example.test'),
  ('62000000-0000-0000-0000-0000000000f1', 'r3-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('62000000-0000-0000-0000-0000000000a1', '62000000-0000-0000-0000-00000000000a', 'admin', true, null, 'Amal'),
  -- Stale: each token below still says admin.
  ('62000000-0000-0000-0000-0000000000a2', '62000000-0000-0000-0000-00000000000a', 'content_creator', true, null, 'Demoted'),
  ('62000000-0000-0000-0000-0000000000a3', '62000000-0000-0000-0000-00000000000a', 'admin', false, null, 'Gone'),
  ('62000000-0000-0000-0000-0000000000a4', '62000000-0000-0000-0000-00000000000a', 'admin', true,
   now() + interval '10 minutes', 'Locked'),
  ('62000000-0000-0000-0000-0000000000c1', '62000000-0000-0000-0000-00000000000a', 'content_creator', true, null, 'Cyrus'),
  ('62000000-0000-0000-0000-0000000000e1', '62000000-0000-0000-0000-00000000000a', 'seo', true, null, 'Eli'),
  ('62000000-0000-0000-0000-0000000000d1', '62000000-0000-0000-0000-00000000000a', 'developer', true, null, 'Dana'),
  ('62000000-0000-0000-0000-0000000000f1', '62000000-0000-0000-0000-00000000000b', 'admin', true, null, 'Faris');

-- A scheduled release in tenant A, to claim a draft with.
insert into public.content_releases (id, tenant_id, kind, status, scheduled_for, scheduled_by, payload)
values ('62000000-0000-0000-0000-0000000001a2', '62000000-0000-0000-0000-00000000000a',
        'publish', 'scheduled', now() + interval '1 day',
        '62000000-0000-0000-0000-0000000000a1', '[]'::jsonb);

-- Drafts of tenant A (one claimed) and one of tenant B. With no role claim the draft lock
-- keeps the ids, versions and entities these name.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, release_id)
values
  ('62000000-0000-0000-0000-000000000d01', '62000000-0000-0000-0000-00000000000a', 'service',
   '62000000-0000-0000-0000-0000000e0001', 'update', '{"title":{"en":"One"}}', null),
  ('62000000-0000-0000-0000-000000000d02', '62000000-0000-0000-0000-00000000000a', 'service',
   '62000000-0000-0000-0000-0000000e0002', 'update', '{"title":{"en":"Claimed"}}',
   '62000000-0000-0000-0000-0000000001a2'),
  ('62000000-0000-0000-0000-000000000d03', '62000000-0000-0000-0000-00000000000a', 'service',
   '62000000-0000-0000-0000-0000000e0003', 'update', '{"title":{"en":"Stale target"}}', null),
  ('62000000-0000-0000-0000-000000000d04', '62000000-0000-0000-0000-00000000000a', 'service',
   '62000000-0000-0000-0000-0000000e0004', 'update', '{"title":{"en":"Thrown away"}}', null),
  ('62000000-0000-0000-0000-000000000d05', '62000000-0000-0000-0000-00000000000a', 'service',
   '62000000-0000-0000-0000-0000000e0005', 'update', '{"title":{"en":"Thrown away too"}}', null),
  ('62000000-0000-0000-0000-000000000db1', '62000000-0000-0000-0000-00000000000b', 'service',
   '62000000-0000-0000-0000-0000000e00b1', 'update', '{"title":{"en":"Theirs"}}', null);

-- A claim set (anon when p_role is null).
create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true)
$$;
create function _as_a(p_sub text, p_role text) returns void language sql as $$
  select _as(p_sub, p_role, '62000000-0000-0000-0000-00000000000a')
$$;

-- A direct staff write of a new draft in tenant A (a singleton's keyed by the tenant).
create function _stage(p_type text, p_op text, p_payload jsonb) returns void language sql as $$
  insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload)
  values ('62000000-0000-0000-0000-00000000000a', p_type,
          case when p_type in ('site_profile', 'seo_defaults')
               then '62000000-0000-0000-0000-00000000000a'::uuid
               else gen_random_uuid() end,
          p_op, p_payload)
$$;

-- Rows a statement touched, as the CURRENT role (a USING filter refuses silently).
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;

-- The outcome of a statement: 'ok', or its SQLSTATE (with BR409's code).
create function _catch(p_sql text) returns text language plpgsql as $f$
declare
  v_state text;
  v_detail text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_detail = pg_exception_detail;
  if v_state = 'BR409' then
    return v_state || ' ' || coalesce(v_detail::jsonb ->> 'code', '?');
  end if;
  return v_state;
end $f$;

-- One put through write_drafts, for tenant A.
create function _put(p_type text, p_entity text, p_op text, p_payload jsonb,
                     p_draft text default null, p_expected int default null) returns jsonb
  language sql as $$
  select public.write_drafts('62000000-0000-0000-0000-00000000000a',
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'action', 'put', 'entity_type', p_type, 'entity_id', p_entity, 'op', p_op,
      'payload', p_payload, 'base', '{}'::jsonb, 'fields', '[]'::jsonb,
      'draft_id', p_draft, 'expected_version', p_expected))))
$$;

-- Tenant A's drafts as the database holds them (a definer, so RLS does not filter it).
create function _drafts_in_a() returns int language sql security definer as $$
  select count(*)::int from public.content_drafts
   where tenant_id = '62000000-0000-0000-0000-00000000000a'
$$;
create function _draft_version(p_id uuid) returns int language sql security definer as $$
  select version from public.content_drafts where id = p_id
$$;

-- ── 1. The functions ─────────────────────────────────────────────────────────────
select ok(
  (select f.prosecdef and f.proconfig = array['search_path=""'] and (r.rolsuper or r.rolbypassrls)
     from pg_proc f join pg_roles r on r.oid = f.proowner
    where f.oid = 'public.releases_enabled(uuid)'::regprocedure),
  'public.releases_enabled: SECURITY DEFINER, empty search_path, owned by a role that bypasses RLS');
select ok(
  has_function_privilege('authenticated', 'public.releases_enabled(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.releases_enabled(uuid)', 'execute')
  and not has_function_privilege('public', 'public.releases_enabled(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.releases_enabled(uuid)', 'execute'),
  'public.releases_enabled is executable by authenticated alone');
select ok(
  (select not prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.write_drafts(uuid, jsonb)'::regprocedure)
  and has_function_privilege('authenticated', 'public.write_drafts(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.write_drafts(uuid, jsonb)', 'execute')
  and not has_function_privilege('public', 'public.write_drafts(uuid, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.write_drafts(uuid, jsonb)', 'execute'),
  'public.write_drafts: SECURITY INVOKER, empty search_path, authenticated alone');
select ok(
  (select not prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'app.draft_key_ok(text, uuid, uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'app.draft_key_ok(text, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'app.draft_key_ok(text, uuid, uuid)', 'execute')
  and not has_function_privilege('public', 'app.draft_key_ok(text, uuid, uuid)', 'execute')
  and not has_function_privilege('service_role', 'app.draft_key_ok(text, uuid, uuid)', 'execute'),
  'app.draft_key_ok: SECURITY INVOKER, empty search_path, authenticated alone');
select ok(
  not exists (select 1 from pg_proc
               where oid = 'public.write_drafts(uuid, jsonb)'::regprocedure
                 and prosrc ~* 'set_config'),
  'public.write_drafts sets no GUC');

-- ── 2. The grants and the policies ───────────────────────────────────────────────
select is(
  (select coalesce(string_agg(format('%s:%s', r.who, p.priv), ', ' order by r.who, p.priv), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(who)
     cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references',
                             'trigger']) as p(priv)
    where has_table_privilege(r.who::name, 'public.content_drafts', p.priv)),
  'authenticated:delete, authenticated:insert, authenticated:select, authenticated:update, '
  || 'service_role:delete, service_role:insert, service_role:select, service_role:update',
  'content_drafts: staff and the service role read and write it, nobody truncates, anon and PUBLIC nothing');
select is(
  (select count(*)::int from pg_attribute
    where attrelid = 'public.content_drafts'::regclass and attnum > 0 and not attisdropped
      and attacl is not null),
  0, 'content_drafts carries no column-level grant');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), '; ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'content_drafts'),
  'content_drafts_delete DELETE PERMISSIVE {authenticated}; '
  || 'content_drafts_insert INSERT PERMISSIVE {authenticated}; '
  || 'content_drafts_live_delete DELETE RESTRICTIVE {authenticated}; '
  || 'content_drafts_live_insert INSERT RESTRICTIVE {authenticated}; '
  || 'content_drafts_live_update UPDATE RESTRICTIVE {authenticated}; '
  || 'content_drafts_read SELECT PERMISSIVE {authenticated}; '
  || 'content_drafts_update UPDATE PERMISSIVE {authenticated}',
  'content_drafts: 0038''s four policies and 0062''s three RESTRICTIVE ones, exactly');
select is(
  (select count(*)::int from pg_policies
    cross join lateral (values (qual), (with_check)) as w(expr)
    where schemaname = 'public' and tablename = 'content_drafts' and w.expr is not null
      and w.expr !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '),
  0, 'every USING and WITH CHECK on content_drafts leads with the tenant predicate');

-- ── 3. Releases off: no draft is written, a discard still works ──────────────────
set local role authenticated;
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select is(public.releases_enabled('62000000-0000-0000-0000-00000000000a'), false,
  'releases off: the flag reader answers false for the caller''s tenant');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"A"}}') $$, '42501',
  'new row violates row-level security policy "content_drafts_live_insert" for table "content_drafts"',
  'releases off: admin CANNOT stage a change directly');
select is(_rows($$ update public.content_drafts set fields = '{title}'
                    where id = '62000000-0000-0000-0000-000000000d01' $$), 0,
  'releases off: admin CANNOT edit a draft');
select is(_catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0101', 'update',
                                '{"title":{"en":"A"}}') $$), '42501',
  'releases off: admin CANNOT stage a change through write_drafts');
select is(
  _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
              '[{"action":"discard","draft_id":"62000000-0000-0000-0000-000000000d04",
                 "expected_version":1}]') $$),
  'ok', 'releases off: admin still discards a pending change (a discard never changes the site)');
select _as_a('62000000-0000-0000-0000-0000000000c1', 'content_creator');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"C"}}') $$, '42501', null,
  'releases off: content creator CANNOT stage a change');
select is(_rows($$ delete from public.content_drafts
                    where id = '62000000-0000-0000-0000-000000000d05' $$), 1,
  'releases off: content creator discards a service change (it authors services)');
select _as_a('62000000-0000-0000-0000-0000000000e1', 'seo');
select throws_ok($$ select _stage('entity_seo', 'update', '{"robots":"noindex"}') $$, '42501', null,
  'releases off: seo CANNOT stage a change');
select is(_rows($$ delete from public.content_drafts
                    where id = '62000000-0000-0000-0000-000000000d01' $$), 0,
  'releases off: seo CANNOT discard a service change (it does not author services)');
select _as_a('62000000-0000-0000-0000-0000000000d1', 'developer');
select throws_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$, '42501', null,
  'releases off: developer CANNOT stage a change');
reset role;
set local role anon;
select _as(null, null, null);
select throws_ok($$ select public.releases_enabled('62000000-0000-0000-0000-00000000000a') $$,
  '42501', null, 'anon CANNOT ask the flag reader');
select throws_ok($$ select _put('service', '62000000-0000-0000-0000-0000000e0102', 'update', '{}') $$,
  '42501', null, 'anon CANNOT call the draft writer');
reset role;

-- From here on tenant A has releases on (inside this rolled-back transaction).
insert into app.release_tenants (tenant_id) values ('62000000-0000-0000-0000-00000000000a');

-- ── 4. Releases on: the flag reader is per tenant ────────────────────────────────
set local role authenticated;
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select is(public.releases_enabled('62000000-0000-0000-0000-00000000000a'), true,
  'releases on: the flag reader answers true for the caller''s tenant');
select is(public.releases_enabled('62000000-0000-0000-0000-00000000000b'), false,
  'the flag reader answers false for another tenant''s id');
select _as('62000000-0000-0000-0000-0000000000f1', 'admin', '62000000-0000-0000-0000-00000000000b');
select is(public.releases_enabled('62000000-0000-0000-0000-00000000000a'), false,
  'another tenant''s admin learns nothing about tenant A''s flag');

-- ── 5. Who stages what, per area ─────────────────────────────────────────────────
-- Content (services): Admin and Content Creator.
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select lives_ok($$ select _stage('service', 'update', '{"title":{"en":"A"}}') $$,
  'admin stages a service change');
select _as_a('62000000-0000-0000-0000-0000000000c1', 'content_creator');
select lives_ok($$ select _stage('service', 'update', '{"title":{"en":"C"}}') $$,
  'content creator stages a service change');
select _as_a('62000000-0000-0000-0000-0000000000e1', 'seo');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"S"}}') $$, '42501', null,
  'seo CANNOT stage a service change');
select _as_a('62000000-0000-0000-0000-0000000000d1', 'developer');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"D"}}') $$, '42501', null,
  'developer CANNOT stage a service change');
-- Public identity and themes: Admin and Developer.
select lives_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$,
  'developer stages the public identity');
select lives_ok($$ select _stage('custom_theme', 'update', '{"name":"Dark"}') $$,
  'developer stages a theme change');
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select lives_ok($$ select _stage('custom_theme', 'update', '{"name":"Light"}') $$,
  'admin stages a theme change');
select _as_a('62000000-0000-0000-0000-0000000000c1', 'content_creator');
select throws_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$, '42501', null,
  'content creator CANNOT stage the public identity');
select _as_a('62000000-0000-0000-0000-0000000000e1', 'seo');
select throws_ok($$ select _stage('custom_theme', 'update', '{"name":"Seo"}') $$, '42501', null,
  'seo CANNOT stage a theme change');
-- SEO meta, SEO defaults and redirects: Admin and SEO.
select lives_ok($$ select _stage('entity_seo', 'update', '{"robots":"noindex"}') $$,
  'seo stages SEO meta');
select lives_ok($$ select _stage('seo_defaults', 'update', '{"defaultTitle":{"en":"T"}}') $$,
  'seo stages the SEO defaults');
select lives_ok($$ select _stage('redirect', 'update', '{"targetPath":"/x"}') $$,
  'seo stages a redirect');
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select lives_ok($$ select _stage('redirect', 'update', '{"targetPath":"/y"}') $$,
  'admin stages a redirect');
select _as_a('62000000-0000-0000-0000-0000000000c1', 'content_creator');
select throws_ok($$ select _stage('redirect', 'update', '{"targetPath":"/z"}') $$, '42501', null,
  'content creator CANNOT stage a redirect');
select _as_a('62000000-0000-0000-0000-0000000000d1', 'developer');
select throws_ok($$ select _stage('entity_seo', 'update', '{"robots":"noindex"}') $$, '42501', null,
  'developer CANNOT stage SEO meta');
-- Removals and archives.
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select lives_ok($$ select _stage('service', 'delete', '{}') $$, 'admin stages a service removal');
select lives_ok($$ select _stage('service', 'update', '{"status":"archived"}') $$,
  'admin stages an archive');
select _as_a('62000000-0000-0000-0000-0000000000c1', 'content_creator');
select throws_ok($$ select _stage('service', 'delete', '{}') $$, '42501', null,
  'content creator CANNOT stage a removal');
select throws_ok($$ select _stage('service', 'update', '{"status":"archived"}') $$, '42501', null,
  'content creator CANNOT stage an archive');
select _as_a('62000000-0000-0000-0000-0000000000e1', 'seo');
select lives_ok($$ select _stage('redirect', 'delete', '{}') $$, 'seo stages a redirect removal');
-- Sales, anon and another tenant.
select _as_a('62000000-0000-0000-0000-0000000000b5', 'sales');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"B"}}') $$, '42501', null,
  'a sales claim CANNOT stage anything');
select is((select count(*)::int from public.content_drafts), 0, 'a sales claim reads no draft');
select _as('62000000-0000-0000-0000-0000000000f1', 'admin', '62000000-0000-0000-0000-00000000000b');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"F"}}') $$, '42501', null,
  'another tenant''s admin CANNOT stage into tenant A');
select is((select count(*)::int from public.content_drafts), 1,
  'another tenant''s admin reads only its own tenant''s draft');
select is(_catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0103', 'update', '{}') $$),
  '42501', 'another tenant''s admin CANNOT name tenant A to the draft writer');
select is(_rows($$ delete from public.content_drafts
                    where id = '62000000-0000-0000-0000-000000000d01' $$), 0,
  'another tenant''s admin CANNOT discard tenant A''s draft');
reset role;

-- ── 6. Stale tokens write nothing, whatever role they claim ──────────────────────
set local role authenticated;
select _as_a('62000000-0000-0000-0000-0000000000a2', 'admin');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"Demoted"}}') $$, '42501',
  'new row violates row-level security policy "content_drafts_live_insert" for table "content_drafts"',
  'a demoted admin token CANNOT stage a change');
select is(_rows($$ update public.content_drafts set fields = '{title}'
                    where id = '62000000-0000-0000-0000-000000000d03' $$), 0,
  'a demoted admin token CANNOT edit a draft');
select is(_rows($$ delete from public.content_drafts
                    where id = '62000000-0000-0000-0000-000000000d03' $$), 0,
  'a demoted admin token CANNOT discard a draft');
select _as_a('62000000-0000-0000-0000-0000000000a3', 'admin');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"Gone"}}') $$, '42501', null,
  'a deactivated admin token CANNOT stage a change');
select is(_rows($$ update public.content_drafts set fields = '{title}'
                    where id = '62000000-0000-0000-0000-000000000d03' $$), 0,
  'a deactivated admin token CANNOT edit a draft');
select is(_rows($$ delete from public.content_drafts
                    where id = '62000000-0000-0000-0000-000000000d03' $$), 0,
  'a deactivated admin token CANNOT discard a draft');
select _as_a('62000000-0000-0000-0000-0000000000a4', 'admin');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"Locked"}}') $$, '42501', null,
  'a locked admin token CANNOT stage a change');
select is(_rows($$ update public.content_drafts set fields = '{title}'
                    where id = '62000000-0000-0000-0000-000000000d03' $$), 0,
  'a locked admin token CANNOT edit a draft');
select is(_rows($$ delete from public.content_drafts
                    where id = '62000000-0000-0000-0000-000000000d03' $$), 0,
  'a locked admin token CANNOT discard a draft');
select is(
  _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
              '[{"action":"discard","draft_id":"62000000-0000-0000-0000-000000000d03",
                 "expected_version":1}]') $$)
  || ' ' || _draft_version('62000000-0000-0000-0000-000000000d03')::text,
  '42501 1', 'a locked admin token discards nothing through the draft writer either');

-- ── 7. A singleton's draft is keyed by its tenant ────────────────────────────────
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload)
     values ('62000000-0000-0000-0000-00000000000a', 'site_profile', gen_random_uuid(),
             'update', '{"brandName":{"en":"X"}}') $$,
  '42501',
  'new row violates row-level security policy "content_drafts_live_insert" for table "content_drafts"',
  'a public-identity draft keyed by anything but the tenant is refused');
select throws_ok(
  $$ update public.content_drafts set entity_id = gen_random_uuid()
      where entity_type = 'site_profile' $$,
  '42501',
  'new row violates row-level security policy "content_drafts_live_update" for table "content_drafts"',
  'a public-identity draft cannot be re-keyed away from its tenant');
select is((select count(*)::int from public.content_drafts
            where entity_type in ('site_profile', 'seo_defaults')
              and entity_id = '62000000-0000-0000-0000-00000000000a'), 2,
  'the singleton drafts staged above are keyed by the tenant (equal accepted)');

-- ── 8. The draft writer ──────────────────────────────────────────────────────────
select set_config('pgtap.new',
  _put('service', '62000000-0000-0000-0000-0000000e0201', 'create', '{"slug":"new"}')::text, true);
select is(
  (select format('%s %s %s %s', x ->> 'action', x ->> 'entity_type', x ->> 'entity_id', x ->> 'version')
     from (select current_setting('pgtap.new')::jsonb -> 0 as x) s),
  'put service 62000000-0000-0000-0000-0000000e0201 1',
  'a put of a new change answers it at version 1');
select is(
  (select format('%s %s %s', d.op, d.created_by, d.payload ->> 'slug')
     from public.content_drafts d
    where d.id = (current_setting('pgtap.new')::jsonb -> 0 ->> 'draft_id')::uuid),
  'create 62000000-0000-0000-0000-0000000000a1 new',
  'the new draft is stored under the id it answered, its author the caller');
select is(
  _put('service', '62000000-0000-0000-0000-0000000e0201', 'create', '{"slug":"newer"}',
       current_setting('pgtap.new')::jsonb -> 0 ->> 'draft_id', 1) -> 0 ->> 'version',
  '2', 'a put naming the draft at its version edits it (version 2)');
select is(
  _catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0201', 'create', '{}',
                        current_setting('pgtap.new')::jsonb -> 0 ->> 'draft_id', 1) $$),
  'BR409 draft-conflict', 'a put at a version that moved on is BR409 draft-conflict');
select is(
  _catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0002', 'update', '{}',
                        '62000000-0000-0000-0000-000000000d02', 1) $$),
  'BR409 scheduled', 'a put on a draft claimed by a scheduled release is BR409 scheduled');
select is(
  _catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0201', 'update', '{}') $$),
  'BR409 draft-conflict', 'a second new draft for one entity is BR409 draft-conflict');
select is(
  _catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0201', 'create', '{}',
                        '62000000-0000-0000-0000-0000000e0999', 1) $$),
  'BR409 draft-conflict', 'a put naming a draft that does not exist is BR409 draft-conflict');
select _as_a('62000000-0000-0000-0000-0000000000e1', 'seo');
select is(
  _catch($$ select _put('entity_seo', '62000000-0000-0000-0000-0000000e0301', 'create',
                        '{"entityType":"service","entityId":"62000000-0000-0000-0000-0000000e0001"}') $$)
  || ' ' || _catch($$ select _put('entity_seo', '62000000-0000-0000-0000-0000000e0302', 'create',
                        '{"entityType":"service","entityId":"62000000-0000-0000-0000-0000000e0001"}') $$),
  'ok BR409 draft-conflict', 'a second pending SEO create for one target is BR409 draft-conflict');
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select set_config('pgtap.discarded',
  public.write_drafts('62000000-0000-0000-0000-00000000000a',
    jsonb_build_array(jsonb_build_object(
      'action', 'discard', 'draft_id', current_setting('pgtap.new')::jsonb -> 0 ->> 'draft_id',
      'expected_version', 2)))::text, true);
select ok(
  (current_setting('pgtap.discarded')::jsonb -> 0 ->> 'version') is null
  and (current_setting('pgtap.discarded')::jsonb -> 0 ->> 'action') = 'discard'
  and not exists (select 1 from public.content_drafts
                   where entity_id = '62000000-0000-0000-0000-0000000e0201'),
  'a discard at the version read removes the draft and answers no version');
select is(
  _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
    '[{"action":"put","entity_type":"service","entity_id":"62000000-0000-0000-0000-0000000e0000","op":"update","payload":{}},
      {"action":"put","entity_type":"service","entity_id":"62000000-0000-0000-0000-0000000e0001","op":"update","payload":{},
       "draft_id":"62000000-0000-0000-0000-000000000d01","expected_version":9}]') $$)
  || ' ' || (select count(*) from public.content_drafts
              where entity_id = '62000000-0000-0000-0000-0000000e0000')::text,
  'BR409 draft-conflict 0', 'a batch with one bad change keeps nothing, not even its good one');
select is(
  _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000b',
    '[{"action":"put","entity_type":"service","entity_id":"62000000-0000-0000-0000-0000000e0402","op":"update"}]') $$),
  '42501', 'a call naming another tenant is refused (42501)');
select is(
  _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
    (select jsonb_agg(jsonb_build_object('action', 'put', 'entity_type', 'service',
                                         'entity_id', gen_random_uuid(), 'op', 'update'))
       from generate_series(1, 201))) $$),
  '22023', 'more than 200 changes in one call are refused (22023)');
select is(
  _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a', '[]') $$)
  || ' ' || _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
    '[{"action":"discard","draft_id":"62000000-0000-0000-0000-000000000d01"}]') $$)
  || ' ' || _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
    '[{"action":"put","entity_type":"service","entity_id":"62000000-0000-0000-0000-0000000e0403","op":"update","tenant_id":"62000000-0000-0000-0000-00000000000b"}]') $$)
  || ' ' || _catch($$ select public.write_drafts('62000000-0000-0000-0000-00000000000a',
    '[{"action":"put","entity_type":"service","entity_id":"62000000-0000-0000-0000-0000000e0404","op":"update","draft_id":"62000000-0000-0000-0000-000000000d01"}]') $$),
  '22023 22023 22023 22023',
  'an empty call, a discard with no version, an unknown key and a draft id without its version are 22023');
select _as_a('62000000-0000-0000-0000-0000000000c1', 'content_creator');
select is(
  _catch($$ select _put('redirect', '62000000-0000-0000-0000-0000000e0501', 'update', '{"targetPath":"/r"}') $$),
  '42501', 'an RLS refusal passes through the draft writer (content creator, a redirect)');
select is(
  _catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0502', 'delete', '{"title":{"en":"x"}}') $$),
  '42501', 'content creator CANNOT stage a removal through the draft writer');
select _as_a('62000000-0000-0000-0000-0000000000a1', 'admin');
select is(
  _catch($$ select _put('service', '62000000-0000-0000-0000-0000000e0503', 'delete', '{"title":{"en":"x"}}') $$),
  '23514', 'a CHECK refusal passes through the draft writer (a removal with a payload)');
select is(
  (select string_agg(x ->> 'entity_id', ' ' order by o)
     from jsonb_array_elements(public.write_drafts('62000000-0000-0000-0000-00000000000a',
       '[{"action":"put","entity_type":"statistic","entity_id":"62000000-0000-0000-0000-0000000e0602","op":"update","payload":{}},
         {"action":"put","entity_type":"category","entity_id":"62000000-0000-0000-0000-0000000e0603","op":"update","payload":{}},
         {"action":"put","entity_type":"statistic","entity_id":"62000000-0000-0000-0000-0000000e0601","op":"update","payload":{}}]'))
          with ordinality as t(x, o)),
  '62000000-0000-0000-0000-0000000e0603 62000000-0000-0000-0000-0000000e0601 62000000-0000-0000-0000-0000000e0602',
  'the changes of one call run in (entity type, entity) order, whatever order they came in');
select set_config('pgtap.edited',
  _put('service', '62000000-0000-0000-0000-0000000e0001', 'update',
       '{"title":{"en":"One, edited"}}', '62000000-0000-0000-0000-000000000d01', 1)::text, true);
select is(
  (select format('%s %s %s %s', d.id, d.version, d.updated_by, d.payload -> 'title' ->> 'en')
     from public.content_drafts d
    where d.id = '62000000-0000-0000-0000-000000000d01'),
  '62000000-0000-0000-0000-000000000d01 2 62000000-0000-0000-0000-0000000000a1 One, edited',
  'an edit through the writer keeps the id, lands on old + 1 and names the editor (the draft lock binds)');
reset role;

select * from finish();
rollback;
