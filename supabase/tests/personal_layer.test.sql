-- pgTAP: the personal layer (0044, Admin v2 F8) — preferences, the people directory,
-- renaming yourself and the environment pill. Run with `supabase test db`.
--
-- Every object has a row for admin, content_creator, seo, developer, anon and another
-- tenant's admin, plus the stale tokens the live check exists for: a demoted developer
-- (its profile now says seo), a deactivated one and a locked one (CLAUDE.md §9).
--   • admin_user_prefs is self only: each role reads and writes its own row and no one
--     else's, an admin included; another tenant reads none of T1's; a stale token reads
--     and writes nothing, not even its own row. Staff may not touch the version, the key
--     or delete a row. The version moves with a preference, never with the watermark; the
--     watermark only moves forward and never past now().
--   • staff_directory: every active member of the caller's tenant (locked people too),
--     names and roles only, never an e-mail; nothing for a stale token or for a tenant the
--     caller does not belong to. crm_people, restated over it, answers what 0036 did.
--   • update_my_profile changes the caller's display name and nothing else.
--   • admin_environment names the marker's environment to live members, NULL otherwise.

begin;
select plan(90);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('44000000-0000-0000-0000-000000000001', 'T1'),
  ('44000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('44000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('44000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('44000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('44000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('44000000-0000-0000-0000-0000000000f1', 'other-admin@example.test'),
  ('44000000-0000-0000-0000-0000000000d2', 'demoted@example.test'),
  ('44000000-0000-0000-0000-0000000000d3', 'inactive@example.test'),
  ('44000000-0000-0000-0000-0000000000d4', 'locked@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('44000000-0000-0000-0000-0000000000a1', '44000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  ('44000000-0000-0000-0000-0000000000c1', '44000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('44000000-0000-0000-0000-0000000000e1', '44000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('44000000-0000-0000-0000-0000000000d1', '44000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('44000000-0000-0000-0000-0000000000f1', '44000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  -- Demoted: the profile says seo, the token below still says developer.
  ('44000000-0000-0000-0000-0000000000d2', '44000000-0000-0000-0000-000000000001', 'seo', true, null, 'Demoted'),
  ('44000000-0000-0000-0000-0000000000d3', '44000000-0000-0000-0000-000000000001', 'developer', false, null, 'Gone'),
  ('44000000-0000-0000-0000-0000000000d4', '44000000-0000-0000-0000-000000000001', 'developer', true,
   now() + interval '10 minutes', 'Locked');

-- Rows that exist before anyone signs in: an admin's, another tenant's, and the stale
-- tokens' own (so "reads nothing" is not trivially true).
insert into public.admin_user_prefs (tenant_id, user_id) values
  ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000a1'),
  ('44000000-0000-0000-0000-0000000000ff', '44000000-0000-0000-0000-0000000000f1'),
  ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000d2'),
  ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000d3'),
  ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000d4');

-- Unmarked to start with, whatever this database says (rolled back at the end).
delete from app.deployment;

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true
  )
$$;

-- An UPDATE of someone's preferences as the CURRENT role; how many rows it changed.
create function _upd(p_user uuid) returns int language plpgsql as $$
declare
  n int;
begin
  update public.admin_user_prefs set notifications = '{"muted": ["leads"]}'::jsonb
   where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;

-- The preferences rows the CURRENT role can see.
create function _seen() returns int language sql as $$
  select count(*)::int from public.admin_user_prefs
$$;

-- The directory as the CURRENT role, names in order.
create function _names(p_tenant uuid) returns text language sql as $$
  select coalesce(string_agg(display_name, ',' order by display_name), '')
    from public.staff_directory(p_tenant)
$$;

create function _people(p_tenant uuid) returns text language sql as $$
  select coalesce(string_agg(display_name, ',' order by display_name), '')
    from public.crm_people(p_tenant)
$$;

-- ---- anon: nothing --------------------------------------------------------------------
set local role anon;
select _as(null, null, null);
select throws_ok($$ select * from public.admin_user_prefs $$,
  '42501', null, 'anon cannot read preferences');
select throws_ok($$ insert into public.admin_user_prefs (tenant_id, user_id)
                    values ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000c1') $$,
  '42501', null, 'anon cannot write preferences');
select throws_ok($$ select * from public.staff_directory('44000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call staff_directory');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', 'x') $$,
  '42501', null, 'anon cannot call update_my_profile');
select throws_ok($$ select public.admin_environment('44000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call admin_environment');

-- ---- preferences: content_creator --------------------------------------------------------
set local role authenticated;
select _as('44000000-0000-0000-0000-0000000000c1', 'content_creator', '44000000-0000-0000-0000-000000000001');
select lives_ok($$ insert into public.admin_user_prefs (tenant_id, user_id, notifications)
                   values ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000c1',
                           '{"muted": ["scheduled"]}') $$,
  'content_creator creates its own preferences');
select is(_seen(), 1, 'and sees exactly one row: its own (not the admin''s)');
select is((select version from public.admin_user_prefs where user_id = '44000000-0000-0000-0000-0000000000c1'),
  1, 'a new row starts at version 1');
select throws_ok($$ insert into public.admin_user_prefs (tenant_id, user_id)
                    values ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000d1') $$,
  '42501', null, 'content_creator cannot create a row for someone else');
select is(_upd('44000000-0000-0000-0000-0000000000a1'), 0, 'nor change the admin''s preferences');
select throws_ok($$ update public.admin_user_prefs set version = 99
                    where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  '42501', null, 'staff cannot set the version');
select throws_ok($$ update public.admin_user_prefs set user_id = '44000000-0000-0000-0000-0000000000d1'
                    where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  '42501', null, 'nor move the row to another person');
select throws_ok($$ delete from public.admin_user_prefs
                    where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  '42501', null, 'nor delete it');
select is(_upd('44000000-0000-0000-0000-0000000000c1'), 1, 'content_creator changes its own preferences');
select is((select version from public.admin_user_prefs where user_id = '44000000-0000-0000-0000-0000000000c1'),
  2, 'a preference change moves the version');
select lives_ok($$ update public.admin_user_prefs set notifications_seen_at = now() + interval '1 day'
                   where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  'marking the bell read');
select is((select notifications_seen_at from public.admin_user_prefs
            where user_id = '44000000-0000-0000-0000-0000000000c1'),
  now(), 'the watermark never passes now()');
select is((select version from public.admin_user_prefs where user_id = '44000000-0000-0000-0000-0000000000c1'),
  2, 'and moving it leaves the version alone (no 409 for a save in between)');
select lives_ok($$ update public.admin_user_prefs set notifications_seen_at = now() - interval '1 day'
                   where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  'an older watermark is accepted');
select is((select notifications_seen_at from public.admin_user_prefs
            where user_id = '44000000-0000-0000-0000-0000000000c1'),
  now(), 'but the watermark only moves forward');
select lives_ok($$ update public.admin_user_prefs set notifications_seen_at = null
                   where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  'clearing the watermark is accepted');
select is((select notifications_seen_at from public.admin_user_prefs
            where user_id = '44000000-0000-0000-0000-0000000000c1'),
  now(), 'but it cannot be cleared');
select throws_ok($$ update public.admin_user_prefs set notifications = '[]'::jsonb
                    where user_id = '44000000-0000-0000-0000-0000000000c1' $$,
  '23514', null, 'the notification preferences must be an object');

-- ---- preferences: seo, developer, admin --------------------------------------------------
select _as('44000000-0000-0000-0000-0000000000e1', 'seo', '44000000-0000-0000-0000-000000000001');
select lives_ok($$ insert into public.admin_user_prefs (tenant_id, user_id, notifications_seen_at)
                   values ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000e1',
                           now() + interval '1 hour') $$,
  'seo creates its own preferences');
select is((select notifications_seen_at from public.admin_user_prefs
            where user_id = '44000000-0000-0000-0000-0000000000e1'),
  now(), 'a new watermark is held to now() too');
select is(_seen(), 1, 'seo sees only its own row');

select _as('44000000-0000-0000-0000-0000000000d1', 'developer', '44000000-0000-0000-0000-000000000001');
select lives_ok($$ insert into public.admin_user_prefs (tenant_id, user_id)
                   values ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000d1') $$,
  'developer creates its own preferences');
select is(_seen(), 1, 'developer sees only its own row');

select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is(_seen(), 1, 'admin sees only its own row, not its colleagues''');
select is(_upd('44000000-0000-0000-0000-0000000000c1'), 0,
  'and cannot change anyone else''s preferences either');

-- ---- preferences: another tenant's admin ---------------------------------------------------
select _as('44000000-0000-0000-0000-0000000000f1', 'admin', '44000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.admin_user_prefs
            where tenant_id = '44000000-0000-0000-0000-000000000001'), 0,
  'another tenant''s admin reads none of T1''s preferences');
select is(_seen(), 1, 'only its own');
select throws_ok($$ insert into public.admin_user_prefs (tenant_id, user_id)
                    values ('44000000-0000-0000-0000-000000000001', '44000000-0000-0000-0000-0000000000f1') $$,
  '42501', null, 'and cannot write a row into T1');

-- ---- preferences: stale tokens -----------------------------------------------------------
select _as('44000000-0000-0000-0000-0000000000d2', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a demoted token reads nothing, not even its own row');
select is(_upd('44000000-0000-0000-0000-0000000000d2'), 0, 'and changes nothing');
select _as('44000000-0000-0000-0000-0000000000d3', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a deactivated token reads nothing');
select _as('44000000-0000-0000-0000-0000000000d4', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a locked token reads nothing');

-- ---- the people directory ----------------------------------------------------------------
select _as('44000000-0000-0000-0000-0000000000c1', 'content_creator', '44000000-0000-0000-0000-000000000001');
select is(_names('44000000-0000-0000-0000-000000000001'), 'Amal,Cyrus,Dana,Demoted,Eli,Locked',
  'content_creator sees every active member of its tenant (locked people too, never the inactive)');
select is(pg_get_function_result('public.staff_directory(uuid)'::regprocedure),
  'TABLE(id uuid, display_name text, role text)', 'names and roles only: no e-mail');
select is(_names('44000000-0000-0000-0000-0000000000ff'), '',
  'naming another tenant finds nobody');
select throws_ok($$ select * from app.staff_directory() $$,
  '42501', null, 'the directory itself is callable by no API role');

select _as('44000000-0000-0000-0000-0000000000e1', 'seo', '44000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.staff_directory('44000000-0000-0000-0000-000000000001')), 6,
  'seo sees the same six');
select _as('44000000-0000-0000-0000-0000000000d1', 'developer', '44000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.staff_directory('44000000-0000-0000-0000-000000000001')), 6,
  'developer sees the same six');
select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is((select role from public.staff_directory('44000000-0000-0000-0000-000000000001')
            where display_name = 'Demoted'), 'seo',
  'admin sees each person''s role as the profile says it');

select _as('44000000-0000-0000-0000-0000000000f1', 'admin', '44000000-0000-0000-0000-0000000000ff');
select is(_names('44000000-0000-0000-0000-0000000000ff'), 'Faris', 'another tenant sees its own people');
select is(_names('44000000-0000-0000-0000-000000000001'), '', 'and none of T1''s');

select _as('44000000-0000-0000-0000-0000000000d2', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_names('44000000-0000-0000-0000-000000000001'), '', 'a demoted token sees nobody');
select _as('44000000-0000-0000-0000-0000000000d3', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_names('44000000-0000-0000-0000-000000000001'), '', 'a deactivated token sees nobody');
select _as('44000000-0000-0000-0000-0000000000d4', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_names('44000000-0000-0000-0000-000000000001'), '', 'a locked token sees nobody');

-- ---- crm_people, restated over the directory: the same answer as 0036 ----------------------
select _as('44000000-0000-0000-0000-0000000000d1', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_people('44000000-0000-0000-0000-000000000001'), 'Amal,Dana',
  'crm_people: the assignable lead workers (not the locked developer, not the demoted one)');
select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is(_people('44000000-0000-0000-0000-000000000001'), 'Amal,Dana', 'the same for admin');
select _as('44000000-0000-0000-0000-0000000000c1', 'content_creator', '44000000-0000-0000-0000-000000000001');
select is(_people('44000000-0000-0000-0000-000000000001'), '', 'crm_people is empty for a content creator');
select _as('44000000-0000-0000-0000-0000000000e1', 'seo', '44000000-0000-0000-0000-000000000001');
select is(_people('44000000-0000-0000-0000-000000000001'), '', 'and for seo');
select _as('44000000-0000-0000-0000-0000000000f1', 'admin', '44000000-0000-0000-0000-0000000000ff');
select is(_people('44000000-0000-0000-0000-0000000000ff') || '/' || _people('44000000-0000-0000-0000-000000000001'),
  'Faris/', 'another tenant: its own people, none of T1''s');
select _as('44000000-0000-0000-0000-0000000000d2', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_people('44000000-0000-0000-0000-000000000001'), '', 'a demoted token lists nobody');
select _as('44000000-0000-0000-0000-0000000000d4', 'developer', '44000000-0000-0000-0000-000000000001');
select is(_people('44000000-0000-0000-0000-000000000001'), '', 'a locked token lists nobody');

-- ---- renaming yourself -------------------------------------------------------------------
select _as('44000000-0000-0000-0000-0000000000c1', 'content_creator', '44000000-0000-0000-0000-000000000001');
select is(public.update_my_profile('44000000-0000-0000-0000-000000000001', '  Cyrus Q  '), 'Cyrus Q',
  'content_creator renames itself (trimmed)');
select is((select display_name || '/' || role::text || '/' || is_active::text || '/' || tenant_id::text
             from public.profiles where id = '44000000-0000-0000-0000-0000000000c1'),
  'Cyrus Q/content_creator/true/44000000-0000-0000-0000-000000000001',
  'only the name changed: not the role, the active flag or the tenant');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', repeat('x', 81)) $$,
  '22023', null, 'a name over 80 characters is refused');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', E'a\tb') $$,
  '22023', null, 'a name with a control character is refused');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-0000000000ff', 'x') $$,
  '42501', null, 'naming another tenant is refused');
select is(public.update_my_profile('44000000-0000-0000-0000-000000000001', '   '), null::text,
  'a blank name clears it (the shell then shows the e-mail)');

reset role;
select is((select string_agg(display_name, ',' order by display_name) from public.profiles
            where id in ('44000000-0000-0000-0000-0000000000a1', '44000000-0000-0000-0000-0000000000e1',
                         '44000000-0000-0000-0000-0000000000d1', '44000000-0000-0000-0000-0000000000f1')),
  'Amal,Dana,Eli,Faris', 'nobody else''s name changed');
set local role authenticated;

select _as('44000000-0000-0000-0000-0000000000e1', 'seo', '44000000-0000-0000-0000-000000000001');
select is(public.update_my_profile('44000000-0000-0000-0000-000000000001', 'Eli S'), 'Eli S', 'seo renames itself');
select _as('44000000-0000-0000-0000-0000000000d1', 'developer', '44000000-0000-0000-0000-000000000001');
select is(public.update_my_profile('44000000-0000-0000-0000-000000000001', 'Dana D'), 'Dana D',
  'developer renames itself');
select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is(public.update_my_profile('44000000-0000-0000-0000-000000000001', 'Amal A'), 'Amal A',
  'admin renames itself');
select _as('44000000-0000-0000-0000-0000000000f1', 'admin', '44000000-0000-0000-0000-0000000000ff');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', 'x') $$,
  '42501', null, 'another tenant''s admin cannot rename itself into T1');
select is(public.update_my_profile('44000000-0000-0000-0000-0000000000ff', 'Faris B'), 'Faris B',
  'but renames itself in its own tenant');
select _as('44000000-0000-0000-0000-0000000000d2', 'developer', '44000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', 'x') $$,
  '42501', null, 'a demoted token cannot rename itself');
select _as('44000000-0000-0000-0000-0000000000d3', 'developer', '44000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', 'x') $$,
  '42501', null, 'a deactivated token cannot');
select _as('44000000-0000-0000-0000-0000000000d4', 'developer', '44000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.update_my_profile('44000000-0000-0000-0000-000000000001', 'x') $$,
  '42501', null, 'a locked token cannot');

-- ---- the environment pill ------------------------------------------------------------------
select _as('44000000-0000-0000-0000-0000000000c1', 'content_creator', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), null::text,
  'an unmarked database names no environment (the pill is hidden, never guessed)');

reset role;
insert into app.deployment (env) values ('staging');
set local role authenticated;

select _as('44000000-0000-0000-0000-0000000000c1', 'content_creator', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), 'staging', 'content_creator: staging');
select _as('44000000-0000-0000-0000-0000000000e1', 'seo', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), 'staging', 'seo: staging');
select _as('44000000-0000-0000-0000-0000000000d1', 'developer', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), 'staging', 'developer: staging');
select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), 'staging', 'admin: staging');

reset role;
update app.deployment set env = 'production';
set local role authenticated;
select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), 'production',
  'production reads as production');

reset role;
update app.deployment set env = 'development';
set local role authenticated;
select _as('44000000-0000-0000-0000-0000000000a1', 'admin', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), 'local',
  'a development database reads as local');

select _as('44000000-0000-0000-0000-0000000000f1', 'admin', '44000000-0000-0000-0000-0000000000ff');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), null::text,
  'another tenant''s admin naming T1 gets nothing');
select is(public.admin_environment('44000000-0000-0000-0000-0000000000ff'), 'local',
  'naming its own tenant, it reads the database''s environment');

select _as('44000000-0000-0000-0000-0000000000d2', 'developer', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), null::text,
  'a demoted token gets nothing');
select _as('44000000-0000-0000-0000-0000000000d3', 'developer', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), null::text,
  'a deactivated token gets nothing');
select _as('44000000-0000-0000-0000-0000000000d4', 'developer', '44000000-0000-0000-0000-000000000001');
select is(public.admin_environment('44000000-0000-0000-0000-000000000001'), null::text,
  'a locked token gets nothing');
select throws_ok($$ select env from app.deployment $$,
  '42501', null, 'and no staff token reads the marker itself');

-- ---- grants (P-14: what must and must not be held) -------------------------------------------
reset role;
select ok(not has_table_privilege('anon', 'public.admin_user_prefs', 'select')
          and not has_any_column_privilege('anon', 'public.admin_user_prefs', 'select'),
  'anon holds nothing on admin_user_prefs');
select ok(not has_table_privilege('authenticated', 'public.admin_user_prefs', 'delete')
          and not has_table_privilege('authenticated', 'public.admin_user_prefs', 'truncate'),
  'staff can neither delete nor truncate preferences');
select ok(not has_column_privilege('authenticated', 'public.admin_user_prefs', 'version', 'update')
          and not has_column_privilege('authenticated', 'public.admin_user_prefs', 'tenant_id', 'update')
          and not has_column_privilege('authenticated', 'public.admin_user_prefs', 'user_id', 'update')
          and has_column_privilege('authenticated', 'public.admin_user_prefs', 'notifications_seen_at', 'update'),
  'staff update the preference columns only');
select ok(has_table_privilege('service_role', 'public.admin_user_prefs', 'select')
          and has_table_privilege('service_role', 'public.admin_user_prefs', 'delete'),
  'the service role''s grants are stated');
select ok(not has_function_privilege('authenticated', 'app.staff_directory()', 'execute')
          and not has_function_privilege('anon', 'app.staff_directory()', 'execute')
          and not has_function_privilege('service_role', 'app.staff_directory()', 'execute'),
  'app.staff_directory() is executable by no API role');
select ok(has_function_privilege('authenticated', 'public.update_my_profile(uuid, text)', 'execute')
          and has_function_privilege('authenticated', 'public.admin_environment(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.staff_directory(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.crm_people(uuid)', 'execute'),
  'the four public functions are for staff tokens only');

select * from finish();
rollback;
