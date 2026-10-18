-- pgTAP: the release guard (migration 0066, Admin v2 R5).
--
-- app.tg_release_guard is the first BEFORE trigger on every registry table and on both
-- case-study link tables. For a tenant with releases on it refuses (42501) every API write
-- outside the release of its own transaction, whatever its depth (no pg_trigger_depth
-- exemption: a trigger reached by a staff request is refused like the request), and lets
-- through: this transaction's release (the token); a write with no switched role and no
-- staff claim (migrations, seeds, the runbook, pg_cron, GoTrue); the service role with no
-- staff claim; and an UPDATE of the registry's immediate columns only. With releases off it
-- changes nothing (every other suite runs with them off). This suite holds:
--   • the catalog: one guard per table, first by name, a definer no API role can call, no
--     depth exemption, no TRUNCATE for any API role;
--   • releases off (tenant B): writes land as before;
--   • releases on (tenant A): every role RLS admits is refused, across the areas; the roles
--     RLS refuses (seo, developer, a sales claim, anon, another tenant) still meet RLS first;
--     a stale token, a switched role with no claims (through a definer) and the migration
--     role carrying a staff claim are refused too;
--   • the immediate column (accepting_applications) and its own 0019 guard;
--   • the token, inside a release (apply_release, publish and dry run) and outside;
--   • the allow paths really land (a BEFORE trigger that returned null would skip the row);
--   • no depth exemption (a test-only trigger reached by a staff write);
--   • app.publish_scheduled() skips a tenant with releases on.
-- Releases are switched on for tenant A inside this rolled-back transaction only.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.

begin;
select plan(56);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────────
insert into app.deployment (env) values ('staging')
  on conflict (singleton) do update set env = excluded.env;
insert into public.tenants (id, name) values
  ('66000000-0000-0000-0000-00000000000a', 'GuardA'),
  ('66000000-0000-0000-0000-00000000000b', 'GuardB');
insert into auth.users (id, email) values
  ('66000000-0000-0000-0000-0000000000a1', 'r5-admin@example.test'),
  ('66000000-0000-0000-0000-0000000000c1', 'r5-creator@example.test'),
  ('66000000-0000-0000-0000-0000000000e1', 'r5-seo@example.test'),
  ('66000000-0000-0000-0000-0000000000d1', 'r5-developer@example.test'),
  ('66000000-0000-0000-0000-0000000000a9', 'r5-demoted@example.test'),
  ('66000000-0000-0000-0000-0000000000b1', 'r5-other-admin@example.test'),
  ('66000000-0000-0000-0000-0000000000b2', 'r5-other-creator@example.test'),
  ('66000000-0000-0000-0000-0000000000f9', 'r5-leaving@example.test');
insert into public.profiles (id, tenant_id, role, is_active) values
  ('66000000-0000-0000-0000-0000000000a1', '66000000-0000-0000-0000-00000000000a', 'admin', true),
  ('66000000-0000-0000-0000-0000000000c1', '66000000-0000-0000-0000-00000000000a', 'content_creator', true),
  ('66000000-0000-0000-0000-0000000000e1', '66000000-0000-0000-0000-00000000000a', 'seo', true),
  ('66000000-0000-0000-0000-0000000000d1', '66000000-0000-0000-0000-00000000000a', 'developer', true),
  -- Demoted: an admin until recently; the profile now says seo (the stale token below).
  ('66000000-0000-0000-0000-0000000000a9', '66000000-0000-0000-0000-00000000000a', 'seo', true),
  ('66000000-0000-0000-0000-0000000000b1', '66000000-0000-0000-0000-00000000000b', 'admin', true),
  ('66000000-0000-0000-0000-0000000000b2', '66000000-0000-0000-0000-00000000000b', 'content_creator', true),
  ('66000000-0000-0000-0000-0000000000f9', '66000000-0000-0000-0000-00000000000a', 'content_creator', true);

insert into public.services (id, tenant_id, slug, title, status, scheduled_for) values
  ('66000000-0000-0000-0001-000000000001', '66000000-0000-0000-0000-00000000000a', 'r5-svc-1',
   '{"en":"One","ar":"واحد"}', 'published', null),
  ('66000000-0000-0000-0001-000000000002', '66000000-0000-0000-0000-00000000000a', 'r5-svc-2',
   '{"en":"Two","ar":"اثنان"}', 'published', null),
  ('66000000-0000-0000-0001-000000000003', '66000000-0000-0000-0000-00000000000a', 'r5-svc-due',
   '{"en":"Due","ar":"مستحق"}', 'scheduled', now() - interval '1 hour'),
  ('66000000-0000-0000-0001-0000000000b1', '66000000-0000-0000-0000-00000000000b', 'r5-svc-b',
   '{"en":"B","ar":"ب"}', 'published', null),
  ('66000000-0000-0000-0001-0000000000b3', '66000000-0000-0000-0000-00000000000b', 'r5-svc-b-due',
   '{"en":"B due","ar":"ب مستحق"}', 'scheduled', now() - interval '1 hour');
insert into public.navigation (id, tenant_id, location, label, href) values
  ('66000000-0000-0000-0004-000000000001', '66000000-0000-0000-0000-00000000000a', 'header',
   '{"en":"A","ar":"أ"}', '/r5-a'),
  ('66000000-0000-0000-0004-0000000000b1', '66000000-0000-0000-0000-00000000000b', 'header',
   '{"en":"B","ar":"ب"}', '/r5-b');
insert into public.pages (id, tenant_id, slug, title, status) values
  ('66000000-0000-0000-0002-000000000001', '66000000-0000-0000-0000-00000000000a', 'r5-page',
   '{"en":"Page","ar":"صفحة"}', 'published');
insert into public.page_sections (id, tenant_id, page_id, type) values
  ('66000000-0000-0000-0003-000000000001', '66000000-0000-0000-0000-00000000000a',
   '66000000-0000-0000-0002-000000000001', 'cta');
insert into public.page_visibility (id, tenant_id, page_id, mode) values
  ('66000000-0000-0000-000f-000000000001', '66000000-0000-0000-0000-00000000000a',
   '66000000-0000-0000-0002-000000000001', 'hidden');
insert into public.entity_seo (id, tenant_id, entity_type, entity_id, meta_title) values
  ('66000000-0000-0000-000e-000000000001', '66000000-0000-0000-0000-00000000000a', 'service',
   '66000000-0000-0000-0001-000000000001', '{"en":"One"}');
insert into public.custom_themes (id, tenant_id, name) values
  ('66000000-0000-0000-0005-000000000001', '66000000-0000-0000-0000-00000000000a', 'r5 theme');
insert into public.team_members (id, tenant_id, slug, name, profile_user_id) values
  ('66000000-0000-0000-0009-000000000001', '66000000-0000-0000-0000-00000000000a', 'r5-ada',
   '{"en":"Ada","ar":"آدا"}', null),
  ('66000000-0000-0000-0009-000000000002', '66000000-0000-0000-0000-00000000000a', 'r5-leaving',
   '{"en":"Lina","ar":"لينا"}', '66000000-0000-0000-0000-0000000000f9');
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('66000000-0000-0000-0006-000000000001', '66000000-0000-0000-0000-00000000000a', 'r5-proj',
   '{"en":"Project","ar":"مشروع"}', 'draft');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('66000000-0000-0000-0007-000000000001', '66000000-0000-0000-0000-00000000000a', 'image', 'static', 'stills/work/p0.jpg');
insert into public.site_profile (tenant_id, brand_name, contact_email, location) values
  ('66000000-0000-0000-0000-00000000000a', '{"en":"Studio","ar":"استوديو"}', 'hello@example.com',
   '{"en":"Riyadh","ar":"الرياض"}');
insert into public.content_releases (id, tenant_id, status) values
  ('66000000-0000-0000-000d-000000000001', '66000000-0000-0000-0000-00000000000a', 'applying');

-- A staff member (or anon when p_role is null).
create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true)
$$;
create function _a(p_sub text, p_role text) returns void language sql as $$
  select _as(p_sub, p_role, '66000000-0000-0000-0000-00000000000a')
$$;

-- A statement as the CURRENT role: 'ok:<rows>', or 'SQLSTATE: message'.
create function _try(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- The SQLSTATE alone ('ok:<rows>' when none).
create function _state(p_sql text) returns text language plpgsql as $$
declare
  v text := _try(p_sql);
begin
  return case when v like 'ok:%' then v else split_part(v, ':', 1) end;
end $$;

-- An update of A's first service, through a SECURITY DEFINER (owned by the migration role,
-- which bypasses RLS): the role setting is unchanged inside it, so the guard still sees the
-- request that reached it.
create function _definer_touch() returns int language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  update public.services set sort_order = 99 where id = '66000000-0000-0000-0001-000000000001';
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function _definer_touch() to authenticated;

-- ── 1. The catalog ───────────────────────────────────────────────────────────────────
select ok(
  (select f.prosecdef and f.proconfig = array['search_path=""']
          and f.proowner = (select proowner from pg_proc where oid = 'app.tg_snapshot_version()'::regprocedure)
     from pg_proc f where f.oid = 'app.tg_release_guard()'::regprocedure)
  and not has_function_privilege('anon', 'app.tg_release_guard()', 'execute')
  and not has_function_privilege('authenticated', 'app.tg_release_guard()', 'execute')
  and not has_function_privilege('service_role', 'app.tg_release_guard()', 'execute')
  and not has_function_privilege('public', 'app.tg_release_guard()', 'execute'),
  'the guard is a SECURITY DEFINER under the snapshot owner, search_path pinned, callable by no API role');
select ok(
  (select prosrc from pg_proc where oid = 'app.tg_release_guard()'::regprocedure) !~* 'pg_trigger_depth',
  'the guard has no depth exemption (verification claim 8)');
select is(
  (select coalesce(string_agg(t, ', ' order by t), '')
     from (select e.table_name as t from app.release_entities e
           union all select 'portfolio_services' union all select 'portfolio_media') x
    where (select count(*) from pg_trigger tg
            where tg.tgrelid = format('public.%I', x.t)::regclass and not tg.tgisinternal
              and tg.tgfoid = 'app.tg_release_guard()'::regprocedure
              and tg.tgname = x.t || '__release_guard' and tg.tgtype = 31 and tg.tgenabled = 'O') <> 1
       or (select tg.tgname from pg_trigger tg
            where tg.tgrelid = format('public.%I', x.t)::regclass and not tg.tgisinternal
              and tg.tgtype & 3 = 3
            order by tg.tgname collate "C" limit 1) is distinct from x.t || '__release_guard'),
  '',
  'every registry table (team_members included) and both link tables carry one guard, the first BEFORE row trigger');
select is(
  (select coalesce(string_agg(tg.tgrelid::regclass::text, ', '), '')
     from pg_trigger tg
    where tg.tgfoid = 'app.tg_release_guard()'::regprocedure
      and tg.tgrelid not in (select format('public.%I', e.table_name)::regclass from app.release_entities e)
      and tg.tgrelid not in ('public.portfolio_services'::regclass, 'public.portfolio_media'::regclass)),
  '', 'no other table carries the guard');
select is(
  (select coalesce(string_agg(format('%s %s', r, t), ', '), '')
     from (select e.table_name as t from app.release_entities e
           union all select 'portfolio_services' union all select 'portfolio_media') x
     cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as r
    where has_table_privilege(r::name, format('public.%I', x.t), 'truncate')),
  '', 'no API role may TRUNCATE a guarded table (TRUNCATE fires no row trigger)');

-- ── 2. Releases off (tenant B): writes land as before ────────────────────────────────
set local role authenticated;
select _as('66000000-0000-0000-0000-0000000000b1', 'admin', '66000000-0000-0000-0000-00000000000b');
select is(_try($$ insert into public.services (id, tenant_id, slug, title)
                  values ('66000000-0000-0000-0001-0000000000b2', '66000000-0000-0000-0000-00000000000b',
                          'r5-svc-b-new', '{"en":"New","ar":"جديد"}') $$),
  'ok:1', 'releases off: admin inserts a service');
select _as('66000000-0000-0000-0000-0000000000b2', 'content_creator', '66000000-0000-0000-0000-00000000000b');
select is(_try($$ update public.services set sort_order = 3 where id = '66000000-0000-0000-0001-0000000000b1' $$),
  'ok:1', 'releases off: content creator updates a service');
select is(_try($$ update public.navigation set href = '/r5-b2' where id = '66000000-0000-0000-0004-0000000000b1' $$),
  'ok:1', 'releases off: content creator updates a navigation link');
select is(_try($$ insert into public.pages (id, tenant_id, slug, title)
                  values ('66000000-0000-0000-0002-0000000000b1', '66000000-0000-0000-0000-00000000000b',
                          'r5-page-b', '{"en":"B","ar":"ب"}') $$),
  'ok:1', 'releases off: content creator inserts a page');
select _as('66000000-0000-0000-0000-0000000000b1', 'admin', '66000000-0000-0000-0000-00000000000b');
select is(_try($$ delete from public.pages where id = '66000000-0000-0000-0002-0000000000b1' $$),
  'ok:1', 'releases off: admin deletes a page');
select is(_try($$ delete from public.services where id = '66000000-0000-0000-0001-0000000000b2' $$),
  'ok:1', 'releases off: admin deletes a service');
reset role;

-- From here on, tenant A has releases on (inside this rolled-back transaction).
insert into app.release_tenants (tenant_id) values ('66000000-0000-0000-0000-00000000000a');

-- ── 3. Releases on: every role RLS admits is refused, area by area ───────────────────
set local role authenticated;
select _a('66000000-0000-0000-0000-0000000000a1', 'admin');
select is(_try($$ insert into public.services (tenant_id, slug, title)
                  values ('66000000-0000-0000-0000-00000000000a', 'r5-svc-new', '{"en":"N","ar":"ن"}') $$),
  '42501: Live content changes only through a release.', 'releases on: admin CANNOT insert a service');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: admin CANNOT update a service');
select is(_try($$ delete from public.services where id = '66000000-0000-0000-0001-000000000002' $$),
  '42501: Live content changes only through a release.', 'releases on: admin CANNOT delete a service');
select is(_try($$ update public.team_members set bio = '{"en":"Bio","ar":"نبذة"}' where id = '66000000-0000-0000-0009-000000000001' $$),
  '42501: Live content changes only through a release.',
  'releases on: admin CANNOT update a team member (guarded, though not captured: O-12)');
select _a('66000000-0000-0000-0000-0000000000c1', 'content_creator');
select is(_try($$ update public.services set title = '{"en":"Changed","ar":"تغير"}' where id = '66000000-0000-0000-0001-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: content creator CANNOT update a service');
select is(_try($$ update public.page_sections set content = '{"x":1}' where id = '66000000-0000-0000-0003-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: content creator CANNOT update a page section');
select is(_try($$ update public.navigation set href = '/r5-x' where id = '66000000-0000-0000-0004-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: content creator CANNOT update a navigation link');
select is(_try($$ insert into public.portfolio_services (tenant_id, portfolio_id, service_id, sort_order)
                  values ('66000000-0000-0000-0000-00000000000a', '66000000-0000-0000-0006-000000000001',
                          '66000000-0000-0000-0001-000000000001', 0) $$),
  '42501: Live content changes only through a release.',
  'releases on: content creator CANNOT link a service to a case study (portfolio_services)');
select is(_try($$ insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id)
                  values ('66000000-0000-0000-0000-00000000000a', '66000000-0000-0000-0006-000000000001',
                          'gallery', 'image', '66000000-0000-0000-0007-000000000001') $$),
  '42501: Live content changes only through a release.',
  'releases on: content creator CANNOT add a case-study image (portfolio_media)');
select is(_try($$ select * from public.save_portfolio('66000000-0000-0000-0006-000000000001', 1,
                    '{"summary":{"en":"S","ar":"م"}}'::jsonb) $$),
  '42501: Live content changes only through a release.',
  'releases on: save_portfolio is refused on the project row');
select _a('66000000-0000-0000-0000-0000000000e1', 'seo');
select is(_try($$ update public.entity_seo set meta_title = '{"en":"Two"}' where id = '66000000-0000-0000-000e-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: seo CANNOT update search meta');
select is(_try($$ insert into public.redirects (tenant_id, source_path, target_path)
                  values ('66000000-0000-0000-0000-00000000000a', '/r5-old', '/r5-new') $$),
  '42501: Live content changes only through a release.', 'releases on: seo CANNOT add a redirect');
select _a('66000000-0000-0000-0000-0000000000d1', 'developer');
select is(_try($$ update public.site_profile set brand_name = '{"en":"Other","ar":"آخر"}'
                   where tenant_id = '66000000-0000-0000-0000-00000000000a' $$),
  '42501: Live content changes only through a release.', 'releases on: developer CANNOT rename the brand');
select is(_try($$ update public.custom_themes set name = 'r5 renamed' where id = '66000000-0000-0000-0005-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: developer CANNOT edit a theme');
select is(_try($$ update public.page_visibility set mode = 'public' where id = '66000000-0000-0000-000f-000000000001' $$),
  '42501: Live content changes only through a release.', 'releases on: developer CANNOT change a page''s visibility');
reset role;
select is(
  (select format('%s %s %s %s', count(*), min(title ->> 'en'), min(sort_order), max(sort_order))
     from public.services where tenant_id = '66000000-0000-0000-0000-00000000000a'),
  '3 Due 0 0', 'and nothing changed: no service added, removed or edited in tenant A');

-- ── 4. The roles RLS refuses meet RLS first ──────────────────────────────────────────
set local role authenticated;
select _a('66000000-0000-0000-0000-0000000000e1', 'seo');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  'ok:0', 'seo: a service update matches no row (RLS, before the guard)');
select _a('66000000-0000-0000-0000-0000000000d1', 'developer');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  'ok:0', 'developer: a service update matches no row (RLS)');
select _a('66000000-0000-0000-0000-0000000000b5', 'sales');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  'ok:0', 'a sales claim: a service update matches no row (RLS)');
select _as('66000000-0000-0000-0000-0000000000b1', 'admin', '66000000-0000-0000-0000-00000000000b');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  'ok:0', 'other_tenant: another tenant''s admin updates no row of tenant A');
reset role;
set local role anon;
select _as(null, null, null);
select is(_state($$ insert into public.services (tenant_id, slug, title)
                    values ('66000000-0000-0000-0000-00000000000a', 'r5-anon', '{"en":"X","ar":"س"}') $$),
  '42501', 'anon: no privilege to write a service at all');
reset role;

-- ── 5. Stale tokens, a switched role with no claims, the migration role with a claim ──
set local role authenticated;
select _a('66000000-0000-0000-0000-0000000000a9', 'admin');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  '42501: Live content changes only through a release.',
  'a stale token (claim admin, profile seo) is refused like any staff token');
select _as(null, null, null);
select is(_try($$ select _definer_touch() $$),
  '42501: Live content changes only through a release.',
  'a switched role (authenticated) with no claims, reaching the table through a definer, is refused');
reset role;
select _a('66000000-0000-0000-0000-0000000000a1', 'admin');
select is(_try($$ update public.services set sort_order = 1 where id = '66000000-0000-0000-0001-000000000001' $$),
  '42501: Live content changes only through a release.',
  'the migration role carrying a staff claim is refused (a staff claim is an API request)');
select _as(null, null, null);

-- ── 6. The immediate column (accepting_applications) ──────────────────────────────────
set local role authenticated;
select _a('66000000-0000-0000-0000-0000000000a1', 'admin');
select is(_try($$ update public.site_profile set accepting_applications = true
                   where tenant_id = '66000000-0000-0000-0000-00000000000a' $$),
  'ok:1', 'admin opens job applications: an immediate column only, so it lands');
select is(_try($$ update public.site_profile set accepting_applications = false,
                   brand_name = '{"en":"Other","ar":"آخر"}'
                   where tenant_id = '66000000-0000-0000-0000-00000000000a' $$),
  '42501: Live content changes only through a release.',
  'with a staged column beside it, the same update is refused');
select is(_try($$ update public.site_profile set brand_name = brand_name
                   where tenant_id = '66000000-0000-0000-0000-00000000000a' $$),
  '42501: Live content changes only through a release.',
  'a save that changes nothing (stamps only) is still a write outside a release: refused');
select is(_try($$ update public.site_profile set accepting_applications = false, version = version,
                   updated_at = now() - interval '1 minute'
                   where tenant_id = '66000000-0000-0000-0000-00000000000a' $$),
  'ok:1', 'the immediate column with the version and the stamp sent back still lands');
select _a('66000000-0000-0000-0000-0000000000d1', 'developer');
select is(_try($$ update public.site_profile set accepting_applications = true
                   where tenant_id = '66000000-0000-0000-0000-00000000000a' $$),
  '42501: only an admin may open or close job applications',
  'developer: the guard lets the immediate column through, and 0019''s own guard refuses it');
reset role;

-- ── 7. The release token ─────────────────────────────────────────────────────────────
select _as(null, null, null);
select set_config('app.release_id', '66000000-0000-0000-000d-000000000001', true);
select set_config('app.release_apply', pg_current_xact_id()::text, true);
set local role authenticated;
select _a('66000000-0000-0000-0000-0000000000c1', 'content_creator');
select is(_try($$ update public.services set sort_order = 2 where id = '66000000-0000-0000-0001-000000000002' $$),
  'ok:1', 'inside this transaction''s release, the content creator''s update lands');
reset role;
select is(
  (select count(*)::int from public.content_release_items
    where release_id = '66000000-0000-0000-000d-000000000001'
      and entity_id = '66000000-0000-0000-0001-000000000002'),
  1, 'and it is captured under that release');
select set_config('app.release_apply', '1', true);
set local role authenticated;
select is(_try($$ update public.services set sort_order = 3 where id = '66000000-0000-0000-0001-000000000002' $$),
  '42501: Live content changes only through a release.', 'a token naming another transaction is refused');
reset role;
select set_config('app.release_apply', '', true);
set local role authenticated;
select is(_try($$ update public.services set sort_order = 3 where id = '66000000-0000-0000-0001-000000000002' $$),
  '42501: Live content changes only through a release.', 'an empty token is refused');
reset role;
select set_config('app.release_id', '', true);
select _as(null, null, null);

-- ── 8. Inside apply_release ──────────────────────────────────────────────────────────
-- A pending change staged here (the draft lock keeps the id with no claims), then published
-- by the content creator: the guard binds the impersonated publisher, the token is valid.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, base, base_version)
select '66000000-0000-0000-00dd-000000000001', s.tenant_id, 'service', s.id, 'update',
       jsonb_build_object('sort_order', s.sort_order), s.version
  from public.services s where s.id = '66000000-0000-0000-0001-000000000001';
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, base, base_version)
select '66000000-0000-0000-00dd-000000000002', s.tenant_id, 'service', s.id, 'update',
       jsonb_build_object('blurb', s.blurb), s.version
  from public.services s where s.id = '66000000-0000-0000-0001-000000000002';
create table _r5_out (result jsonb);
grant insert, select on _r5_out to service_role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into _r5_out (result)
select public.apply_release('66000000-0000-0000-0000-0000000000c1'::uuid, 'content_creator', 'publish',
         jsonb_build_array(jsonb_build_object(
           'draft_id', '66000000-0000-0000-00dd-000000000001', 'draft_version', 1,
           'entity_type', 'service', 'entity_id', '66000000-0000-0000-0001-000000000001',
           'op', 'update', 'patch', '{"sort_order":7}'::jsonb, 'base', '{"sort_order":0}'::jsonb)));
select is(
  (select format('%s %s', (o.result ->> 'number') is not null,
                 (select sort_order from public.services where id = '66000000-0000-0000-0001-000000000001'))
     from _r5_out o),
  't 7', 'a content creator''s publish in a tenant with releases on lands (the token is valid)');
select is(
  (select format('%s %s %s',
     public.apply_release('66000000-0000-0000-0000-0000000000c1'::uuid, 'content_creator', 'dry_run',
        jsonb_build_array(jsonb_build_object(
          'draft_id', '66000000-0000-0000-00dd-000000000002', 'draft_version', 1,
          'entity_type', 'service', 'entity_id', '66000000-0000-0000-0001-000000000002',
          'op', 'update', 'patch', '{"blurb":{"en":"Dry","ar":"جاف"}}'::jsonb,
          'base', jsonb_build_object('blurb', null)))) ->> 'ok',
     (select coalesce(blurb ->> 'en', '-') from public.services where id = '66000000-0000-0000-0001-000000000002'),
     (select count(*) from public.content_drafts where id = '66000000-0000-0000-00dd-000000000002'))),
  'true - 1', 'a dry run passes and leaves nothing: the live row and the draft as they were');
reset role;
select _as(null, null, null);

-- ── 9. Not an API request: the allow paths land ──────────────────────────────────────
select is(_try($$ insert into public.services (id, tenant_id, slug, title)
                  values ('66000000-0000-0000-0001-000000000009', '66000000-0000-0000-0000-00000000000a',
                          'r5-svc-runbook', '{"en":"Runbook","ar":"دليل"}') $$),
  'ok:1', 'the migration role with no claims inserts in tenant A (a seed, the runbook)');
select is(_try($$ update public.services set sort_order = 4 where id = '66000000-0000-0000-0001-000000000009' $$),
  'ok:1', 'the migration role with no claims updates in tenant A');
select is(_try($$ delete from public.services where id = '66000000-0000-0000-0001-000000000009' $$),
  'ok:1', 'the migration role with no claims deletes in tenant A');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(_try($$ update public.services set sort_order = 5 where id = '66000000-0000-0000-0001-000000000002' $$),
  'ok:1', 'the service role with no staff claim updates in tenant A (out of band, recorded)');
reset role;
select _as(null, null, null);
-- GoTrue removes an account: the profile goes, and the team member's link is set to null by
-- the foreign key's own action, with no switched role and no claims.
delete from auth.users where id = '66000000-0000-0000-0000-0000000000f9';
select is((select profile_user_id is null from public.team_members where id = '66000000-0000-0000-0009-000000000002'),
  true, 'an account removed by Auth sets its team member''s link to null in tenant A');

-- ── 10. No depth exemption ───────────────────────────────────────────────────────────
-- A test-only table whose AFTER INSERT trigger updates tenant A's service: a staff insert
-- reaches the service one trigger deep, and is refused like a direct write.
create table _r5_t (x int);
create function _r5_t_touch() returns trigger language plpgsql as $$
begin
  update public.services set sort_order = sort_order + 10 where id = '66000000-0000-0000-0001-000000000002';
  return null;
end $$;
create trigger _r5_t_after after insert on _r5_t for each row execute function _r5_t_touch();
grant insert on _r5_t to authenticated;
set local role authenticated;
select _a('66000000-0000-0000-0000-0000000000c1', 'content_creator');
select is(_try($$ insert into _r5_t (x) values (1) $$),
  '42501: Live content changes only through a release.',
  'a trigger reached by a staff write is refused like the write itself (no depth exemption)');
reset role;
select _as(null, null, null);
select is(_try($$ insert into _r5_t (x) values (2) $$), 'ok:1',
  'the same trigger reached by the migration role lands');
select is((select sort_order from public.services where id = '66000000-0000-0000-0001-000000000002'), 15,
  'and its update of the service is there');

-- ── 11. Scheduled publishing skips a tenant with releases on ─────────────────────────
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() ran');
select is(
  (select string_agg(slug::text || '=' || status, ', ' order by slug)
     from public.services where id in ('66000000-0000-0000-0001-000000000003', '66000000-0000-0000-0001-0000000000b3')),
  'r5-svc-b-due=published, r5-svc-due=scheduled',
  'a due service goes live in tenant B (releases off) and waits in tenant A (releases on)');

select * from finish();
rollback;
