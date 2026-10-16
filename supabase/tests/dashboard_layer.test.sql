-- pgTAP: the dashboard's shared layer (0060, Admin v2 U1). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus three
-- stale Admin tokens, each still carrying an `admin` claim: one whose profile was demoted to
-- seo, one deactivated and one locked (the RESTRICTIVE live policy and the definer rely on
-- app.live_role(); CLAUDE.md §9 (b)), and the service role.
--   • admin_role_defaults: Admin reads all four roles' presets and writes any; Content
--     Creator, SEO and Developer read their own role's only and write none (42501, or zero
--     rows); anon holds no privilege; another tenant's Admin reads only its own and cannot
--     insert into T1; each stale Admin reads and writes nothing; a preset carrying a link
--     fails the CHECK; a change of role is refused; the version moves only on a change.
--   • team_notes: all four live roles read; none inserts or updates it directly; the door,
--     public.save_team_notes, saves for each live role with one audit row each (the length
--     only), 40001 on a stale version, 22023 on 2,001 characters, an e-mail address, a
--     phone number in Western and in Arabic-Indic digits and a bidi override; another
--     tenant's Admin naming T1, each stale token, anon and the service role are refused;
--     the rule answers the shared table of inputs (tests/lib/teamNotes.spec.ts reads it);
--     app.expire_team_notes clears a note 181 days old and leaves one 179 days old.
--   • the catalog: RLS, the exact policy set (the tenant predicate first in each), the
--     grants, the retention job where pg_cron is installed, the guides in every tenant.

begin;
select plan(72);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('60000000-0000-0000-0000-000000000001', 'T1'),
  ('60000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('60000000-0000-0000-0000-0000000000a1', 'u1-admin@example.test'),
  ('60000000-0000-0000-0000-0000000000a2', 'u1-demoted@example.test'),
  ('60000000-0000-0000-0000-0000000000a3', 'u1-inactive@example.test'),
  ('60000000-0000-0000-0000-0000000000a4', 'u1-locked@example.test'),
  ('60000000-0000-0000-0000-0000000000c1', 'u1-creator@example.test'),
  ('60000000-0000-0000-0000-0000000000e1', 'u1-seo@example.test'),
  ('60000000-0000-0000-0000-0000000000d1', 'u1-developer@example.test'),
  ('60000000-0000-0000-0000-0000000000f1', 'u1-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('60000000-0000-0000-0000-0000000000a1', '60000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  -- Stale: each token below still says admin.
  ('60000000-0000-0000-0000-0000000000a2', '60000000-0000-0000-0000-000000000001', 'seo', true, null, 'Demoted'),
  ('60000000-0000-0000-0000-0000000000a3', '60000000-0000-0000-0000-000000000001', 'admin', false, null, 'Gone'),
  ('60000000-0000-0000-0000-0000000000a4', '60000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes', 'Locked'),
  ('60000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('60000000-0000-0000-0000-0000000000e1', '60000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('60000000-0000-0000-0000-0000000000d1', '60000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('60000000-0000-0000-0000-0000000000f1', '60000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris');

-- A preset for every role of T1, one for T2's Admin.
insert into public.admin_role_defaults (tenant_id, role, dashboard, quick_actions) values
  ('60000000-0000-0000-0000-000000000001', 'admin', '{"top": ["kpis"]}', '[{"id": "add-service"}]'),
  ('60000000-0000-0000-0000-000000000001', 'content_creator', '{"top": ["kpis"]}', '[]'),
  ('60000000-0000-0000-0000-000000000001', 'seo', '{"top": ["kpis"]}', '[]'),
  ('60000000-0000-0000-0000-000000000001', 'developer', '{"top": ["kpis"]}', '[]'),
  ('60000000-0000-0000-0000-0000000000ff', 'admin', '{"top": ["kpis"]}', '[]');

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

-- The presets the CURRENT role reads, as "t1/t2", and T1's roles it reads, sorted.
create function _presets() returns text language sql stable as $$
  select (select count(*) from public.admin_role_defaults where tenant_id = '60000000-0000-0000-0000-000000000001')::text
         || '/' ||
         (select count(*) from public.admin_role_defaults where tenant_id = '60000000-0000-0000-0000-0000000000ff')::text
         || ' ' ||
         coalesce((select string_agg(role::text, ',' order by role::text) from public.admin_role_defaults
                    where tenant_id = '60000000-0000-0000-0000-000000000001'), '-')
$$;

-- Rewrites T1's preset for a role as the CURRENT role; how many rows it changed.
create function _touch(p_role text, p_n int) returns int language plpgsql as $$
declare v int;
begin
  update public.admin_role_defaults set dashboard = jsonb_build_object('top', jsonb_build_array('kpis'), 'n', p_n)
   where tenant_id = '60000000-0000-0000-0000-000000000001' and role = p_role::public.app_role;
  get diagnostics v = row_count;
  return v;
end $$;

-- Deletes T1's preset for a role as the CURRENT role; how many rows went.
create function _drop(p_role text) returns int language plpgsql as $$
declare v int;
begin
  delete from public.admin_role_defaults
   where tenant_id = '60000000-0000-0000-0000-000000000001' and role = p_role::public.app_role;
  get diagnostics v = row_count;
  return v;
end $$;

-- How many team notes the CURRENT role reads, as "t1/t2".
create function _notes() returns text language sql stable as $$
  select (select count(*) from public.team_notes where tenant_id = '60000000-0000-0000-0000-000000000001')::text
         || '/' ||
         (select count(*) from public.team_notes where tenant_id = '60000000-0000-0000-0000-0000000000ff')::text
$$;

-- The retention job, read dynamically: cron.job exists only where pg_cron is installed.
create function _cron_ok() returns boolean language plpgsql as $$
declare v boolean;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return true;
  end if;
  execute $q$ select exists (select 1 from cron.job where jobname = 'team-notes-retention'
                               and schedule = '25 3 * * *' and command ~ 'app\.expire_team_notes\(\)') $q$
     into v;
  return v;
end $$;

grant execute on function _as(text, text, text), _presets(), _touch(text, int), _drop(text), _notes()
  to anon, authenticated, service_role;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
    where oid in ('public.admin_role_defaults'::regclass, 'public.team_notes'::regclass)),
  'both tables are ENABLE + FORCE row level security');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename in ('admin_role_defaults', 'team_notes')),
  'admin_role_defaults_delete DELETE PERMISSIVE {authenticated}, '
  'admin_role_defaults_insert INSERT PERMISSIVE {authenticated}, '
  'admin_role_defaults_live ALL RESTRICTIVE {authenticated}, '
  'admin_role_defaults_read SELECT PERMISSIVE {authenticated}, '
  'admin_role_defaults_update UPDATE PERMISSIVE {authenticated}, '
  'team_notes_read SELECT PERMISSIVE {authenticated}',
  'the presets carry the read, the three Admin writes and the RESTRICTIVE live check; the notes one read');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('admin_role_defaults', 'team_notes')
      and coalesce(qual, with_check) ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '),
  6, 'each policy names the tenant predicate first');
select ok(
  has_table_privilege('authenticated', 'public.team_notes', 'select')
    and not has_table_privilege('authenticated', 'public.team_notes', 'insert')
    and not has_table_privilege('authenticated', 'public.team_notes', 'update')
    and not has_table_privilege('authenticated', 'public.team_notes', 'delete')
    and not has_any_column_privilege('authenticated', 'public.team_notes', 'insert, update')
    and not has_table_privilege('anon', 'public.team_notes', 'select')
    and not has_table_privilege('anon', 'public.admin_role_defaults', 'select')
    and has_table_privilege('authenticated', 'public.admin_role_defaults', 'select')
    and has_column_privilege('authenticated', 'public.admin_role_defaults', 'dashboard', 'update')
    and not has_column_privilege('authenticated', 'public.admin_role_defaults', 'role', 'update')
    and not has_column_privilege('authenticated', 'public.admin_role_defaults', 'version', 'update'),
  'staff read both tables, write no column of the notes, and update only a preset''s two columns');
select ok(
  has_function_privilege('authenticated', 'public.save_team_notes(uuid, text, integer)', 'execute')
    and not has_function_privilege('anon', 'public.save_team_notes(uuid, text, integer)', 'execute')
    and not has_function_privilege('service_role', 'public.save_team_notes(uuid, text, integer)', 'execute')
    and not has_function_privilege('authenticated', 'app.expire_team_notes()', 'execute')
    and not has_function_privilege('service_role', 'app.expire_team_notes()', 'execute')
    and not has_function_privilege('authenticated', 'app.team_note_ok(text)', 'execute')
    and not has_function_privilege('anon', 'app.quick_library_only(jsonb)', 'execute')
    and (select prosecdef from pg_proc where oid = 'public.save_team_notes(uuid, text, integer)'::regprocedure),
  'the door is a definer staff alone call; the retention and the rules are no API role''s door');
select ok(_cron_ok(), 'the team-notes-retention job runs daily at 03:25 UTC where pg_cron is installed');
select is(
  (select count(*)::int from public.help_articles
    where tenant_id = '60000000-0000-0000-0000-000000000001'
      and ((slug = 'your-dashboard' and screens = '{/admin}')
           or (slug = 'finding-your-way' and screens = '{/admin/search,/admin/help}'))),
  2, 'a new tenant holds your-dashboard on /admin, and finding-your-way without it');
select is(jsonb_array_length(app.help_article_set()), 13, 'the help set holds 13 guides');

-- ── 2. the presets: who reads ─────────────────────────────────────────────────
set local role authenticated;
select _as('60000000-0000-0000-0000-0000000000a1', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '4/0 admin,content_creator,developer,seo', 'admin reads every role''s preset of its tenant');
select _as('60000000-0000-0000-0000-0000000000c1', 'content_creator', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '1/0 content_creator', 'content_creator reads its own role''s preset only');
select _as('60000000-0000-0000-0000-0000000000e1', 'seo', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '1/0 seo', 'seo reads its own role''s preset only');
select _as('60000000-0000-0000-0000-0000000000d1', 'developer', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '1/0 developer', 'developer reads its own role''s preset only');
select _as('60000000-0000-0000-0000-0000000000f1', 'admin', '60000000-0000-0000-0000-0000000000ff');
select is(_presets(), '0/1 -', 'other_tenant: another tenant''s Admin reads its own preset, none of T1''s');
select _as('60000000-0000-0000-0000-0000000000a2', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '0/0 -', 'a demoted Admin''s token (profile seo) reads no preset');
select _as('60000000-0000-0000-0000-0000000000a3', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '0/0 -', 'a deactivated Admin''s token reads no preset');
select _as('60000000-0000-0000-0000-0000000000a4', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_presets(), '0/0 -', 'a locked Admin''s token reads no preset');

-- ── 3. the presets: who writes ────────────────────────────────────────────────
select _as('60000000-0000-0000-0000-0000000000a1', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_touch('seo', 1), 1, 'admin rewrites the SEO preset');
select is(
  (select version || ' ' || updated_by::text from public.admin_role_defaults
    where tenant_id = '60000000-0000-0000-0000-000000000001' and role = 'seo'),
  '2 60000000-0000-0000-0000-0000000000a1', 'the change moved the version and named the Admin');
select is(_touch('seo', 1), 1, 'admin saves the same preset again');
select is(
  (select version from public.admin_role_defaults
    where tenant_id = '60000000-0000-0000-0000-000000000001' and role = 'seo'),
  2, 'a save that changes nothing keeps the version');
select is(_drop('developer'), 1, 'admin deletes the Developer preset');
select lives_ok(
  $$ insert into public.admin_role_defaults (tenant_id, role, dashboard, quick_actions)
     values ('60000000-0000-0000-0000-000000000001', 'developer', '{"top": ["kpis"]}', '[{"id": "open-leads"}]') $$,
  'admin adds a Developer preset');
select throws_ok(
  $$ update public.admin_role_defaults set quick_actions = '[{"id": "x", "href": "https://evil.example"}]'
      where tenant_id = '60000000-0000-0000-0000-000000000001' and role = 'admin' $$,
  '23514', null, 'a preset carrying a link fails the CHECK: library actions only');
select throws_ok(
  $$ update public.admin_role_defaults set role = 'seo'
      where tenant_id = '60000000-0000-0000-0000-000000000001' and role = 'admin' $$,
  '42501', null, 'a staff token cannot move a preset to another role (no UPDATE on the key)');

select _as('60000000-0000-0000-0000-0000000000c1', 'content_creator', '60000000-0000-0000-0000-000000000001');
select is(_touch('content_creator', 2), 0, 'content_creator cannot rewrite even its own role''s preset');
select throws_ok(
  $$ insert into public.admin_role_defaults (tenant_id, role) values ('60000000-0000-0000-0000-000000000001', 'content_creator') $$,
  '42501', null, 'content_creator cannot add a preset');
select is(_drop('content_creator'), 0, 'content_creator cannot delete a preset');
select _as('60000000-0000-0000-0000-0000000000e1', 'seo', '60000000-0000-0000-0000-000000000001');
select is(_touch('seo', 3), 0, 'seo cannot rewrite a preset');
select throws_ok(
  $$ insert into public.admin_role_defaults (tenant_id, role) values ('60000000-0000-0000-0000-000000000001', 'seo') $$,
  '42501', null, 'seo cannot add a preset');
select _as('60000000-0000-0000-0000-0000000000d1', 'developer', '60000000-0000-0000-0000-000000000001');
select is(_touch('developer', 4), 0, 'developer cannot rewrite a preset');
select throws_ok(
  $$ insert into public.admin_role_defaults (tenant_id, role) values ('60000000-0000-0000-0000-000000000001', 'developer') $$,
  '42501', null, 'developer cannot add a preset');
select _as('60000000-0000-0000-0000-0000000000f1', 'admin', '60000000-0000-0000-0000-0000000000ff');
select throws_ok(
  $$ insert into public.admin_role_defaults (tenant_id, role) values ('60000000-0000-0000-0000-000000000001', 'seo') $$,
  '42501', null, 'other_tenant: another tenant''s Admin cannot add a preset to T1');
select is(_touch('admin', 5), 0, 'other_tenant: nor rewrite one of T1''s');
select _as('60000000-0000-0000-0000-0000000000a2', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_touch('admin', 6) + _drop('seo'), 0, 'a demoted Admin''s token writes no preset');
select _as('60000000-0000-0000-0000-0000000000a3', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_touch('admin', 7) + _drop('seo'), 0, 'a deactivated Admin''s token writes no preset');
select _as('60000000-0000-0000-0000-0000000000a4', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_touch('admin', 8) + _drop('seo'), 0, 'a locked Admin''s token writes no preset');
select throws_ok(
  $$ insert into public.admin_role_defaults (tenant_id, role) values ('60000000-0000-0000-0000-000000000001', 'seo') $$,
  '42501', null, 'and adds none');

reset role;
select _as(null, null, null);
set local role anon;
select throws_ok($$ select count(*) from public.admin_role_defaults $$, '42501', null,
  'anon holds no privilege on the presets');
reset role;

set local role service_role;
select throws_ok(
  $$ update public.admin_role_defaults set role = 'seo'
      where tenant_id = '60000000-0000-0000-0000-000000000001' and role = 'admin' $$,
  '23514', null, 'the service role cannot move a preset either: the trigger refuses it');
reset role;

-- ── 4. team notes: the door ───────────────────────────────────────────────────
set local role authenticated;
select _as('60000000-0000-0000-0000-0000000000a1', 'admin', '60000000-0000-0000-0000-000000000001');
select is(
  (select public.save_team_notes('60000000-0000-0000-0000-000000000001', E'Shoot moved to the 14th.  \n\n', 0) ->> 'version'),
  '1', 'admin saves the first note (version 0: no row yet)');
select is(
  (select body from public.team_notes where tenant_id = '60000000-0000-0000-0000-000000000001'),
  'Shoot moved to the 14th.', 'trailing whitespace is trimmed');
select _as('60000000-0000-0000-0000-0000000000c1', 'content_creator', '60000000-0000-0000-0000-000000000001');
select is(
  (select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'Swap the sample quotes.', 1) ->> 'version'),
  '2', 'content_creator saves');
select _as('60000000-0000-0000-0000-0000000000e1', 'seo', '60000000-0000-0000-0000-000000000001');
select is(
  (select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'Titles reviewed.', 2) ->> 'version'),
  '3', 'seo saves');
select _as('60000000-0000-0000-0000-0000000000d1', 'developer', '60000000-0000-0000-0000-000000000001');
select is(
  (select public.save_team_notes('60000000-0000-0000-0000-000000000001', E'Deploy on Sunday.\tAfter 6.', 3) ->> 'version'),
  '4', 'developer saves (a tab is allowed)');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'An old copy.', 2) $$,
  '40001', null, 'a stale version is a conflict, never an overwrite');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', repeat('x', 2001), 4) $$,
  '22023', 'team_notes_length', '2,001 characters are refused');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'Write to sam@client.example', 4) $$,
  '22023', 'team_notes_contact', 'an e-mail address is refused');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'Call +966 55 123 4567', 4) $$,
  '22023', 'team_notes_contact', 'a phone number is refused');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'الرقم ٠٥٥١٢٣٤٥٦٧', 4) $$,
  '22023', 'team_notes_contact', 'a phone number in Arabic-Indic digits is refused');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', E'gnp.‮exe', 4) $$,
  '22023', 'team_notes_chars', 'a bidi override is refused');
select is(
  (select version || ' ' || body from public.team_notes where tenant_id = '60000000-0000-0000-0000-000000000001'),
  E'4 Deploy on Sunday.\tAfter 6.', 'the refusals changed nothing');

-- Everyone with analytics.read reads it, live.
select _as('60000000-0000-0000-0000-0000000000a1', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_notes(), '1/0', 'admin reads its tenant''s note');
select _as('60000000-0000-0000-0000-0000000000c1', 'content_creator', '60000000-0000-0000-0000-000000000001');
select is(_notes(), '1/0', 'content_creator reads it');
select _as('60000000-0000-0000-0000-0000000000e1', 'seo', '60000000-0000-0000-0000-000000000001');
select is(_notes(), '1/0', 'seo reads it');
select _as('60000000-0000-0000-0000-0000000000d1', 'developer', '60000000-0000-0000-0000-000000000001');
select is(_notes(), '1/0', 'developer reads it');
select throws_ok(
  $$ update public.team_notes set body = 'direct' where tenant_id = '60000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'no staff token updates the note directly');
select throws_ok(
  $$ insert into public.team_notes (tenant_id, body) values ('60000000-0000-0000-0000-0000000000ff', 'direct') $$,
  '42501', null, 'nor inserts one');

select _as('60000000-0000-0000-0000-0000000000f1', 'admin', '60000000-0000-0000-0000-0000000000ff');
select is(_notes(), '0/0', 'other_tenant: another tenant''s Admin reads none of T1''s');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'From T2', 4) $$,
  '42501', null, 'other_tenant: and cannot save T1''s by naming its id');
select _as('60000000-0000-0000-0000-0000000000a2', 'admin', '60000000-0000-0000-0000-000000000001');
select is(_notes(), '0/0', 'a demoted Admin''s token reads no note');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'stale', 4) $$,
  '42501', null, 'and cannot save one');
select _as('60000000-0000-0000-0000-0000000000a3', 'admin', '60000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'stale', 4) $$,
  '42501', null, 'a deactivated Admin''s token cannot save');
select _as('60000000-0000-0000-0000-0000000000a4', 'admin', '60000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'stale', 4) $$,
  '42501', null, 'a locked Admin''s token cannot save');

reset role;
select _as(null, null, null);
set local role anon;
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'anon', 4) $$,
  '42501', null, 'anon cannot execute the door');
reset role;
set local role service_role;
select throws_ok(
  $$ select public.save_team_notes('60000000-0000-0000-0000-000000000001', 'service', 4) $$,
  '42501', null, 'nor can the service role: the door is for a signed-in member');
select throws_ok(
  $$ insert into public.team_notes (tenant_id, body) values ('60000000-0000-0000-0000-0000000000ff', 'Call 0551234567') $$,
  '23514', null, 'the service role''s own write is held to the rule by the CHECK');
reset role;

-- The audit rows: one per save, the length only.
select is(
  (select count(*)::int || ' ' || bool_and(detail ? 'length' and (select count(*) from jsonb_object_keys(detail)) = 1)::text
     from public.audit_log
    where tenant_id = '60000000-0000-0000-0000-000000000001' and action = 'dashboard.notes.update'),
  '4 true', 'four saves wrote four audit rows, each with the length only');
select is(
  (select string_agg(actor_role || ':' || (detail ->> 'length'), ',' order by id) from public.audit_log
    where tenant_id = '60000000-0000-0000-0000-000000000001' and action = 'dashboard.notes.update'),
  'admin:24,content_creator:23,seo:16,developer:26', 'each names its saver''s live role and the stored length');

-- ── 5. the rule, on the table tests/lib/teamNotes.spec.ts holds the Worker's schema to ─────
-- team-note-table:begin
create temporary table _note_cases (input text, expected text) on commit drop;
insert into _note_cases values
  (E'', null),
  (E'Shoot moved to the 14th.\nSwap the sample quotes before launch.', null),
  (E'Tabs\tare\tfine', null),
  (E'Budget 1,500,000 SAR', null),
  (E'Call on 14/10/2026', null),
  (E'Seven digits 1234567 are fine', null),
  (E'سبعة أرقام ١٢٣٤٥٦٧', null),
  (E'Meet @ noon', null),
  (E'Mail sam@client.example', 'team_notes_contact'),
  (E'sam.lee+x@sub.client.sa', 'team_notes_contact'),
  (E'Call +966 55 123 4567', 'team_notes_contact'),
  (E'0551234567', 'team_notes_contact'),
  (E'055-123-4567', 'team_notes_contact'),
  (E'12345678', 'team_notes_contact'),
  (E'٠٥٥١٢٣٤٥٦٧', 'team_notes_contact'),
  (E'۰۵۵ ۱۲۳ ۴۵۶۷', 'team_notes_contact'),
  (E'05٥١٢3٤5٦7', 'team_notes_contact'),
  (E'2026-10-14', 'team_notes_contact'),
  (E'a\rb', 'team_notes_chars'),
  (E'bell\u0007', 'team_notes_chars'),
  (E'next\u0085line', 'team_notes_chars'),
  (E'gnp.‮exe', 'team_notes_chars'),
  (E'iso⁦late', 'team_notes_chars'),
  (E'zero​width', 'team_notes_chars'),
  (E'soft­hyphen', 'team_notes_chars'),
  (E'bom﻿', 'team_notes_chars');
-- team-note-table:end
select is(
  (select string_agg(format('%L→%s', input, coalesce(app.team_note_problem(input), 'ok')), '; ')
     from _note_cases where app.team_note_problem(input) is distinct from expected),
  null, 'app.team_note_problem answers every row of the shared table');

-- ── 6. retention ───────────────────────────────────────────────────────────────
insert into public.team_notes (tenant_id, body, version, updated_at)
values ('60000000-0000-0000-0000-0000000000ff', 'Recent enough.', 3, now() - interval '179 days');
update public.team_notes set updated_at = now() - interval '181 days'
 where tenant_id = '60000000-0000-0000-0000-000000000001';
select is(app.expire_team_notes(), 1, 'the retention clears one note');
select is(
  (select string_agg(tenant_id::text || ' ' || version || ' [' || body || '] ' || coalesce(updated_by::text, '-'),
                     '; ' order by tenant_id)
     from public.team_notes),
  '60000000-0000-0000-0000-000000000001 5 [] -; 60000000-0000-0000-0000-0000000000ff 3 [Recent enough.] -',
  'the note 181 days old is blanked (version moved, no one named); the one 179 days old stays');
select is(
  (select count(*)::int from public.audit_log
    where action = 'dashboard.notes.expire' and actor_id is null and detail = '{"days": 180}'
      and tenant_id = '60000000-0000-0000-0000-000000000001'),
  1, 'the clearing is audited with no actor and the rule''s days');

select * from finish();
rollback;
