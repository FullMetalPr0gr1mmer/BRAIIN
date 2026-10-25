-- pgTAP: scheduled releases and the two switches (migration 0107, Admin v2 R11).
--
-- A scheduled release is checked as a publish is, run as a dry run, then stored with its
-- drafts claimed; the minute cron claims it when due (leased), and apply_release fires it as
-- the person who scheduled it, so their live profile and RLS decide again; a release that
-- cannot go live is failed with a code and its drafts released. It can be moved or cancelled
-- by a person who may publish all of it. app.enable_releases converts the legacy schedule and
-- writes the baseline; app.disable_releases undoes the switch, refusing pending work unless
-- the discard is named. This suite holds:
--   • who may call each function (the service role, or the owner alone for the switches);
--   • releases off: nothing is scheduled (55000) and the claim finds nothing;
--   • a schedule and what it leaves; the bounds; a claimed draft read-only to staff; the
--     database's refusals found by its dry run; the actor matrix over admin, content_creator,
--     seo, developer, a sales role, inactive and other-tenant people;
--   • the claim and its lease; a fire as the scheduler and what it leaves; a second fire and an
--     early one doing nothing; a demoted, an inactive scheduler and a conflict refused, the
--     switch read again; the failure recorded and its drafts released;
--   • moving and cancelling, version-checked, per role; app.publish_scheduled() acting only for
--     a tenant with releases off;
--   • app.enable_releases (the legacy schedule converted, the fallback scheduler, the baseline,
--     the flag, the audit row) and app.disable_releases (refused over pending work, the discard
--     putting legacy schedules back, the flag gone).
-- Releases are switched on for the test tenants inside this rolled-back transaction only.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.

begin;
select plan(96);

-- ── 0. The catalog ──────────────────────────────────────────────────────────────────────
select ok(
  (select bool_and(has_function_privilege('service_role', f, 'execute')
                   and not has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute')
                   and not has_function_privilege('public', f, 'execute'))
     from unnest(array['public.claim_scheduled_releases(integer)',
                       'public.fail_scheduled_release(uuid, uuid, text, uuid[])',
                       'public.reschedule_release(uuid, text, uuid, integer, timestamp with time zone)',
                       'public.unschedule_release(uuid, text, uuid, integer)']) as f),
  'the claim, the failure, the move and the cancel are executable by the service role only');
select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
     from unnest(array['app.enable_releases(uuid, uuid, uuid)',
                       'app.disable_releases(uuid, uuid, boolean)']) as f,
          unnest(array['public', 'anon', 'authenticated', 'service_role']) as r),
  'the two switches are executable by no API role (the owner runs them)');
select is(
  (select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname)
     from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where f.proname in ('claim_scheduled_releases', 'fail_scheduled_release', 'reschedule_release',
                        'unschedule_release', 'enable_releases', 'disable_releases')
      and (f.prosrc ~* 'set_config' or f.prosrc ~* 'app\.release_apply'
           or f.prosrc ~* 'set\s+(local|session)\s+role\M' or f.prosrc ~* 'set\s+role\s+(?!=)')),
  null, 'none of them sets a setting, switches role or names the release token');
select ok(
  (select a.atttypid = 'timestamptz'::regtype and not a.attnotnull
     from pg_attribute a
    where a.attrelid = 'public.content_releases'::regclass and a.attname = 'fire_lease_until')
  and has_column_privilege('authenticated', 'public.content_releases', 'fire_lease_until', 'select')
  and not has_column_privilege('authenticated', 'public.content_releases', 'fire_lease_until', 'update')
  and not has_column_privilege('anon', 'public.content_releases', 'fire_lease_until', 'select'),
  'content_releases.fire_lease_until: a nullable time staff read with the row and nobody else writes');

-- ── Fixtures (as the migration role: RLS bypassed) ────────────────────────────────────
insert into app.deployment (env) values ('staging')
  on conflict (singleton) do update set env = excluded.env;
insert into public.tenants (id, name) values
  ('10700000-0000-0000-0000-00000000000a', 'ScheduleA'),
  ('10700000-0000-0000-0000-00000000000b', 'ScheduleB'),
  ('10700000-0000-0000-0000-00000000000c', 'ScheduleC');
insert into auth.users (id, email) values
  ('10700000-0000-0000-0000-0000000000a1', 'r11-admin@example.test'),
  ('10700000-0000-0000-0000-0000000000c1', 'r11-creator@example.test'),
  ('10700000-0000-0000-0000-0000000000e1', 'r11-seo@example.test'),
  ('10700000-0000-0000-0000-0000000000d1', 'r11-developer@example.test'),
  ('10700000-0000-0000-0000-0000000000a2', 'r11-inactive@example.test'),
  ('10700000-0000-0000-0000-0000000000a4', 'r11-demoted@example.test'),
  ('10700000-0000-0000-0000-0000000000a5', 'r11-leaving@example.test'),
  ('10700000-0000-0000-0000-0000000000f1', 'r11-sales@example.test'),
  ('10700000-0000-0000-0000-0000000000b1', 'r11-other-admin@example.test'),
  ('10700000-0000-0000-0000-0000000000ca', 'r11-c-admin@example.test'),
  ('10700000-0000-0000-0000-0000000000cc', 'r11-c-creator@example.test'),
  ('10700000-0000-0000-0000-0000000000cd', 'r11-c-left@example.test'),
  ('10700000-0000-0000-0000-0000000000ce', 'r11-c-seo@example.test');
insert into public.profiles (id, tenant_id, role, is_active) values
  ('10700000-0000-0000-0000-0000000000a1', '10700000-0000-0000-0000-00000000000a', 'admin', true),
  ('10700000-0000-0000-0000-0000000000c1', '10700000-0000-0000-0000-00000000000a', 'content_creator', true),
  ('10700000-0000-0000-0000-0000000000e1', '10700000-0000-0000-0000-00000000000a', 'seo', true),
  ('10700000-0000-0000-0000-0000000000d1', '10700000-0000-0000-0000-00000000000a', 'developer', true),
  ('10700000-0000-0000-0000-0000000000a2', '10700000-0000-0000-0000-00000000000a', 'admin', false),
  ('10700000-0000-0000-0000-0000000000a4', '10700000-0000-0000-0000-00000000000a', 'admin', true),
  ('10700000-0000-0000-0000-0000000000a5', '10700000-0000-0000-0000-00000000000a', 'admin', true),
  ('10700000-0000-0000-0000-0000000000f1', '10700000-0000-0000-0000-00000000000a', 'sales', true),
  ('10700000-0000-0000-0000-0000000000b1', '10700000-0000-0000-0000-00000000000b', 'admin', true),
  ('10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-00000000000c', 'admin', true),
  ('10700000-0000-0000-0000-0000000000cc', '10700000-0000-0000-0000-00000000000c', 'content_creator', true),
  ('10700000-0000-0000-0000-0000000000cd', '10700000-0000-0000-0000-00000000000c', 'content_creator', true),
  ('10700000-0000-0000-0000-0000000000ce', '10700000-0000-0000-0000-00000000000c', 'seo', true);

insert into public.services (id, tenant_id, slug, title, status) values
  ('10700000-0000-0000-0001-000000000001', '10700000-0000-0000-0000-00000000000a', 'r11-s1', '{"en":"One","ar":"واحد"}', 'published'),
  ('10700000-0000-0000-0001-000000000002', '10700000-0000-0000-0000-00000000000a', 'r11-s2', '{"en":"Two","ar":"اثنان"}', 'published'),
  ('10700000-0000-0000-0001-000000000003', '10700000-0000-0000-0000-00000000000a', 'r11-s3', '{"en":"Three","ar":"ثلاثة"}', 'published'),
  ('10700000-0000-0000-0001-000000000004', '10700000-0000-0000-0000-00000000000a', 'r11-s4', '{"en":"Four","ar":"أربعة"}', 'published'),
  ('10700000-0000-0000-0001-000000000005', '10700000-0000-0000-0000-00000000000a', 'r11-s5', '{"en":"Five","ar":"خمسة"}', 'published'),
  ('10700000-0000-0000-0001-000000000006', '10700000-0000-0000-0000-00000000000a', 'r11-s6', '{"en":"Six","ar":"ستة"}', 'published'),
  ('10700000-0000-0000-0001-000000000007', '10700000-0000-0000-0000-00000000000a', 'r11-s7', '{"en":"Seven","ar":"سبعة"}', 'published'),
  ('10700000-0000-0000-0001-000000000008', '10700000-0000-0000-0000-00000000000a', 'r11-s8', '{"en":"Eight","ar":"ثمانية"}', 'published'),
  ('10700000-0000-0000-0001-000000000009', '10700000-0000-0000-0000-00000000000a', 'r11-s9', '{"en":"Nine","ar":"تسعة"}', 'published'),
  ('10700000-0000-0000-0001-00000000000a', '10700000-0000-0000-0000-00000000000a', 'r11-s10', '{"en":"Ten","ar":"عشرة"}', 'published'),
  ('10700000-0000-0000-0001-0000000000c3', '10700000-0000-0000-0000-00000000000c', 'r11-c-s3', '{"en":"C three","ar":"ج ثلاثة"}', 'draft'),
  ('10700000-0000-0000-0001-0000000000b1', '10700000-0000-0000-0000-00000000000b', 'r11-sb', '{"en":"B","ar":"ب"}', 'published');
-- Legacy scheduled rows, due: one in tenant A (releases on below) and one in tenant B (off).
insert into public.services (id, tenant_id, slug, title, status, scheduled_for) values
  ('10700000-0000-0000-0001-0000000000a9', '10700000-0000-0000-0000-00000000000a', 'r11-sa-legacy',
   '{"en":"Legacy A","ar":"قديم أ"}', 'scheduled', now() - interval '1 minute'),
  ('10700000-0000-0000-0001-0000000000b9', '10700000-0000-0000-0000-00000000000b', 'r11-sb-legacy',
   '{"en":"Legacy B","ar":"قديم ب"}', 'scheduled', now() - interval '1 minute');

-- Tenant C, for the switches: the rows that would have gone live by themselves, each last
-- edited by someone (auth.uid() is what the actor trigger records); a FAQ scheduled with no
-- time and a scheduled team member, which the legacy path never publishes.
select set_config('request.jwt.claim.sub', '10700000-0000-0000-0000-0000000000cc', true);
insert into public.services (id, tenant_id, slug, title, status, scheduled_for) values
  ('10700000-0000-0000-0001-0000000000c1', '10700000-0000-0000-0000-00000000000c', 'r11-c-s1',
   '{"en":"C one","ar":"ج واحد"}', 'scheduled', now() + interval '1 hour');
select set_config('request.jwt.claim.sub', '10700000-0000-0000-0000-0000000000cd', true);
insert into public.services (id, tenant_id, slug, title, status, scheduled_for) values
  ('10700000-0000-0000-0001-0000000000c2', '10700000-0000-0000-0000-00000000000c', 'r11-c-s2',
   '{"en":"C two","ar":"ج اثنان"}', 'scheduled', now() + interval '1 hour');
select set_config('request.jwt.claim.sub', '', true);
insert into public.faq_items (id, tenant_id, question, answer, status, scheduled_for) values
  ('10700000-0000-0000-0003-0000000000c1', '10700000-0000-0000-0000-00000000000c',
   '{"en":"Why?","ar":"لماذا؟"}', '{"en":"Because.","ar":"لأن."}', 'scheduled', null);
insert into public.team_members (id, tenant_id, slug, name, status) values
  ('10700000-0000-0000-0004-0000000000c1', '10700000-0000-0000-0000-00000000000c', 'r11-c-ada',
   '{"en":"Ada","ar":"آدا"}', 'scheduled');
-- The person who last edited c-s2 has left since.
update public.profiles set is_active = false where id = '10700000-0000-0000-0000-0000000000cd';

create table _r11 (name text primary key, item jsonb not null);
create table _out (name text primary key, result jsonb);
grant all on _r11, _out to service_role, authenticated;

-- A pending change in a tenant (its draft, version 1, and the item a schedule names), the
-- base the live values of its columns, as release_apply.test.sql stages one.
create function _stage(p_name text, p_entity uuid, p_patch jsonb,
                       p_tenant uuid default '10700000-0000-0000-0000-00000000000a')
returns uuid language plpgsql as $$
declare
  v_live jsonb;
  v_base jsonb;
  v_draft uuid := gen_random_uuid();
begin
  select to_jsonb(s) into v_live from public.services s where s.id = p_entity;
  select coalesce(jsonb_object_agg(k, v_live -> k), '{}'::jsonb) into v_base from jsonb_object_keys(p_patch) k;
  delete from public.content_drafts
   where tenant_id = p_tenant and entity_type = 'service' and entity_id = p_entity;
  insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, base, base_version)
  values (v_draft, p_tenant, 'service', p_entity, 'update', p_patch, v_base, (v_live ->> 'version')::int);
  insert into _r11 (name, item) values (p_name,
    jsonb_build_object('draft_id', v_draft, 'draft_version', 1, 'entity_type', 'service',
                       'entity_id', p_entity, 'op', 'update', 'patch', p_patch, 'base', v_base))
  on conflict (name) do update set item = excluded.item;
  return v_draft;
end $$;

-- Schedule the named items as p_actor in p_role, at p_at.
create function _sched(p_actor text, p_role text, p_names text[], p_at timestamptz,
                       p_kind text default 'publish', p_restores uuid default null)
returns jsonb language sql as $$
  select public.apply_release(p_actor::uuid, p_role, 'schedule',
    (select jsonb_agg(r.item order by array_position(p_names, r.name)) from _r11 r where r.name = any (p_names)),
    null, p_kind, p_restores, null, p_at)
$$;
-- Fire a scheduled release as p_actor in p_role.
create function _fire(p_actor text, p_role text, p_release uuid) returns jsonb language sql as $$
  select public.apply_release(p_actor::uuid, p_role, 'fire', null, null, 'publish', null, p_release, null)
$$;
-- The release a schedule stored, by its name in _out.
create function _rel(p_name text) returns uuid language sql as $$
  select (result ->> 'release_id')::uuid from _out where name = p_name
$$;

create function _catch(p_sql text) returns jsonb language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_det text;
begin
  execute p_sql;
  return jsonb_build_object('state', 'ok');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
  return jsonb_build_object('state', v_state, 'message', v_msg,
    'detail', case when v_det ~ '^\s*[\{\[]' then v_det::jsonb else to_jsonb(v_det) end);
end $$;
-- SQLSTATE, then the code or the first refused item's SQLSTATE: 'BR422:refused:42501'.
create function _fails(p_sql text) returns text language sql as $$
  select c ->> 'state' || coalesce(':' || coalesce(c -> 'detail' ->> 'code' || coalesce(':' || (c -> 'detail' -> 'items' -> 0 ->> 'sqlstate'), ''), null), '')
    from (select _catch(p_sql) as c) s
$$;
-- The rows a statement touched.
create function _rows(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function _stage(text, uuid, jsonb, uuid), _sched(text, text, text[], timestamptz, text, uuid),
  _fire(text, text, uuid), _rel(text), _catch(text), _fails(text), _rows(text) to service_role, authenticated;

-- The service role's own claims, as PostgREST sets them for the Worker's key.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── 1. Releases off (tenant B): nothing is scheduled, and the claim finds nothing ─────
select _stage('b-title', '10700000-0000-0000-0001-0000000000b1', '{"title":{"en":"Bee","ar":"ب"}}',
              '10700000-0000-0000-0000-00000000000b');
set local role service_role;
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000b1', 'admin', array['b-title'], now() + interval '1 hour') $$),
  '55000', 'releases off: a schedule is refused before anything is written');
select is(public.claim_scheduled_releases(1), '[]'::jsonb,
  'releases off: the minute cron''s claim finds nothing (no release can be scheduled)');
reset role;

-- Switched on for tenant A only (rolled back with this file).
insert into app.release_tenants (tenant_id) values ('10700000-0000-0000-0000-00000000000a');

-- ── 2. Scheduling ──────────────────────────────────────────────────────────────────────
select _stage('s1-title', '10700000-0000-0000-0001-000000000001', '{"title":{"en":"Uno","ar":"واحد"}}');
set local role service_role;
select lives_ok(
  $$ insert into _out (name, result) select 'sch', _sched('10700000-0000-0000-0000-0000000000c1',
       'content_creator', array['s1-title'], now() + interval '1 hour') $$,
  'content_creator schedules a service change an hour ahead');
reset role;
select is(
  (select format('%s %s %s', result ->> 'mode', result ->> 'item_count', (result ->> 'scheduled_for')::timestamptz = now() + interval '1 hour')
     from _out where name = 'sch'),
  'schedule 1 t', 'it answers the scheduled release, its time and its count');
select is(
  (select format('%s %s %s %s %s %s %s', r.status, r.kind, r.scheduled_by, r.item_count, r.areas,
                 coalesce(r.number::text, 'none'), r.payload -> 0 ->> 'draft_version')
     from public.content_releases r where r.id = _rel('sch')),
  'scheduled publish 10700000-0000-0000-0000-0000000000c1 1 {services} none 2',
  'the release is scheduled, by them, with its count and area, no number, its change at the version it claimed');
select is(
  (select format('%s %s %s', d.release_id = _rel('sch'), d.version, s.title ->> 'en')
     from public.content_drafts d, public.services s, _r11 r
    where r.name = 's1-title' and d.id = (r.item ->> 'draft_id')::uuid and s.id = d.entity_id),
  't 2 One', 'its draft is claimed (at version 2) and the live row is unchanged');
select is(
  (select format('%s %s %s %s', a.actor_id, a.actor_role, a.detail ->> 'item_count', a.hash <> '')
     from public.audit_log a where a.action = 'release.schedule' and a.entity_id = _rel('sch')::text),
  '10700000-0000-0000-0000-0000000000c1 content_creator 1 t',
  'one release.schedule audit row, naming the scheduler, chained, in the same transaction');
-- A claimed draft is read-only to every staff token (the claim's RLS and the draft lock).
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('sub', '10700000-0000-0000-0000-0000000000a1',
  'role', 'authenticated', 'app_metadata', jsonb_build_object('role', 'admin',
  'tenant_id', '10700000-0000-0000-0000-00000000000a'))::text, true);
select is(_rows(format($$ update public.content_drafts set label = '{"en":"x"}'::jsonb where id = %L $$,
                       (select item ->> 'draft_id' from _r11 where name = 's1-title'))),
  0, 'an Admin cannot edit a draft a scheduled release claimed');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select _stage('s2-blurb', '10700000-0000-0000-0001-000000000002', '{"blurb":{"en":"Blurb","ar":"نبذة"}}');
set local role service_role;
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s2-blurb'], now() + interval '30 seconds') $$),
  '22023', 'a schedule less than a minute ahead is refused');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s2-blurb'], now() + interval '400 days') $$),
  '22023', 'a schedule more than 366 days ahead is refused');
select is(_fails($$ select public.apply_release('10700000-0000-0000-0000-0000000000a1', 'admin', 'schedule',
                     (select jsonb_agg(item) from _r11 where name = 's2-blurb')) $$),
  '22023', 'a schedule names its time');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s2-blurb'],
                     now() + interval '1 hour', 'rollback', '10700000-0000-0000-0000-0000000000ee') $$),
  '22023', 'a rollback is never scheduled');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s1-title'], now() + interval '2 hours') $$),
  'BR409:pending-changed', 'a draft another scheduled release claimed cannot be scheduled again');
reset role;

select _stage('s9-archive', '10700000-0000-0000-0001-000000000009', '{"status":"archived"}');
select _stage('s3-blurb', '10700000-0000-0000-0001-000000000003', '{"blurb":{"en":"Mine","ar":"لي"}}');
update public.services set blurb = '{"en":"Theirs","ar":"لهم"}' where id = '10700000-0000-0000-0001-000000000003';
set local role service_role;
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000c1', 'content_creator', array['s9-archive'], now() + interval '1 hour') $$),
  'BR422:refused:42501', 'its dry run finds what the database refuses this person (a content creator''s archive)');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s3-blurb'], now() + interval '1 hour') $$),
  'BR409:conflict', 'and a live row that moved under a change');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000e1', 'seo', array['s2-blurb'], now() + interval '1 hour') $$),
  'BR422:refused:42501', 'seo CANNOT schedule a service change (RLS refuses it as them)');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000d1', 'developer', array['s2-blurb'], now() + interval '1 hour') $$),
  'BR422:refused:42501', 'developer CANNOT schedule a service change');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000f1', 'sales', array['s2-blurb'], now() + interval '1 hour') $$),
  'BR403:actor', 'a sales role is refused (not a CMS role)');
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000a2', 'admin', array['s2-blurb'], now() + interval '1 hour') $$),
  'BR403:actor', 'an inactive admin is refused');
reset role;
select is(
  (select format('%s %s',
     (select count(*) from public.content_releases where tenant_id = '10700000-0000-0000-0000-00000000000a'),
     (select count(*) from public.content_drafts where tenant_id = '10700000-0000-0000-0000-00000000000a' and release_id is not null))),
  '1 1', 'the refused schedules left nothing: one release, one claimed draft');
-- other_tenant: an admin of tenant B (switched on for these rows) naming tenant A's drafts.
insert into app.release_tenants (tenant_id) values ('10700000-0000-0000-0000-00000000000b');
set local role service_role;
select is(_fails($$ select _sched('10700000-0000-0000-0000-0000000000b1', 'admin', array['s2-blurb'], now() + interval '1 hour') $$),
  'BR409:pending-changed', 'other_tenant: an admin of tenant B cannot schedule tenant A''s pending changes');
reset role;
delete from app.release_tenants where tenant_id = '10700000-0000-0000-0000-00000000000b';

-- ── 3. The claim and the fire ──────────────────────────────────────────────────────────
update public.content_releases set scheduled_for = now() - interval '1 minute' where id = _rel('sch');
set local role service_role;
select is(
  (select format('%s %s %s %s %s', c -> 0 ->> 'release_id' = _rel('sch')::text, c -> 0 -> 'scheduler' ->> 'role',
                 c -> 0 -> 'scheduler' ->> 'live', c -> 0 -> 'items', jsonb_array_length(c))
     from (select public.claim_scheduled_releases(1) as c) s),
  't content_creator true [{"op": "update", "status": null, "entity_type": "service"}] 1',
  'a due release is claimed with its scheduler as they are now and each change''s type, operation and status');
reset role;
select ok((select fire_lease_until > now() from public.content_releases where id = _rel('sch')),
  'the claim leases it');
set local role service_role;
select is(public.claim_scheduled_releases(5), '[]'::jsonb, 'a leased release is not claimed again');
reset role;
update public.content_releases set fire_lease_until = now() - interval '1 second' where id = _rel('sch');
set local role service_role;
select is(jsonb_array_length(public.claim_scheduled_releases(5)), 1, 'once its lease ends, it is claimed again');
select is(_fails($$ select public.claim_scheduled_releases(0) $$), '22023', 'a claim takes 1 to 5');
select is(_fails($$ select _fire('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('sch')) $$),
  '22023', 'a release goes live as the person who scheduled it, never another');
select lives_ok(
  $$ insert into _out (name, result) select 'fired', _fire('10700000-0000-0000-0000-0000000000c1', 'content_creator', _rel('sch')) $$,
  'the scheduler''s fire publishes it');
reset role;
select is(
  (select format('%s %s %s %s %s', r.status, r.number, r.published_by, r.fire_lease_until is null, r.item_count)
     from public.content_releases r where r.id = _rel('sch')),
  'published 1 10700000-0000-0000-0000-0000000000c1 t 1',
  'the scheduled release is the published one: numbered, by the scheduler, its lease gone');
select is(
  (select format('%s %s', s.title ->> 'en',
     (select count(*) from public.content_drafts d where d.release_id is not distinct from _rel('sch')))
     from public.services s where s.id = '10700000-0000-0000-0001-000000000001'),
  'Uno 0', 'the live row changed and the draft it claimed is consumed');
select is(
  (select format('%s %s %s %s', a.actor_id, a.actor_role, a.detail ->> 'scheduled', a.detail ->> 'number')
     from public.audit_log a where a.action = 'release.publish' and a.entity_id = _rel('sch')::text),
  '10700000-0000-0000-0000-0000000000c1 content_creator true 1',
  'its release.publish audit row names the scheduler and says it was scheduled');
select is(
  (select format('%s %s', jsonb_array_length(o.result -> 'items'),
     (select count(*) from public.content_release_items i where i.release_id = _rel('sch')))
     from _out o where o.name = 'fired'),
  '1 1', 'it answers its items as a publish does, each captured in the ledger');
set local role service_role;
select is(
  (select format('%s %s', f ->> 'skipped', f ->> 'status')
     from (select _fire('10700000-0000-0000-0000-0000000000c1', 'content_creator', _rel('sch')) as f) s),
  'true published', 'a second fire of the same release does nothing');
reset role;
select is((select count(*)::int from public.content_releases
            where tenant_id = '10700000-0000-0000-0000-00000000000a' and status = 'published'),
  1, 'and uses no second number');

select _stage('s4-title', '10700000-0000-0000-0001-000000000004', '{"title":{"en":"Cuatro","ar":"أربعة"}}');
set local role service_role;
insert into _out (name, result) select 'early',
  _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s4-title'], now() + interval '1 hour');
select is(
  (select format('%s %s', f ->> 'skipped', f ->> 'status')
     from (select _fire('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('early')) as f) s),
  'true scheduled', 'a release fired before its time is left scheduled');
reset role;
select is((select title ->> 'en' from public.services where id = '10700000-0000-0000-0001-000000000004'),
  'Four', 'and changes nothing live');

-- ── 4. A fire fails closed, and the failure is recorded ────────────────────────────────
-- Scheduled by an Admin, who is a Content Creator by the time it is due: an archive is an
-- Admin's to publish.
select _stage('s5-archive', '10700000-0000-0000-0001-000000000005', '{"status":"archived"}');
set local role service_role;
insert into _out (name, result) select 'demoted',
  _sched('10700000-0000-0000-0000-0000000000a4', 'admin', array['s5-archive'], now() + interval '1 hour');
reset role;
update public.content_releases set scheduled_for = now() - interval '1 minute' where id = _rel('demoted');
update public.profiles set role = 'content_creator' where id = '10700000-0000-0000-0000-0000000000a4';
set local role service_role;
select is(_fails($$ select _fire('10700000-0000-0000-0000-0000000000a4', 'admin', _rel('demoted')) $$),
  'BR403:actor', 'a demoted scheduler is refused under the role they scheduled with');
select is(_fails($$ select _fire('10700000-0000-0000-0000-0000000000a4', 'content_creator', _rel('demoted')) $$),
  'BR422:refused:42501', 'and under their live role the archive gate refuses it: RLS binds as the scheduler');
reset role;
select is(
  (select format('%s %s', r.status, (select count(*) from public.content_drafts d where d.release_id = r.id))
     from public.content_releases r where r.id = _rel('demoted')),
  'scheduled 1', 'a refused fire changes nothing: still scheduled, its draft still claimed');
set local role service_role;
select is(
  (select format('%s %s', f ->> 'failed', f ->> 'released')
     from (select public.fail_scheduled_release('10700000-0000-0000-0000-00000000000a', _rel('demoted'), 'forbidden') as f) s),
  'true 1', 'fail_scheduled_release fails it and releases its one draft');
reset role;
select is(
  (select format('%s %s %s %s', r.status, r.failure, r.fire_lease_until is null, coalesce(r.number::text, 'none'))
     from public.content_releases r where r.id = _rel('demoted')),
  'failed {"code": "forbidden"} t none', 'the release is failed with its code (never a message), no lease, no number');
select is(
  (select count(*)::int from public.content_drafts d, _r11 r
    where r.name = 's5-archive' and d.id = (r.item ->> 'draft_id')::uuid and d.release_id is null),
  1, 'its change is a pending change again');
select is(
  (select count(*)::int from public.dashboard_attention a
    where a.kind = 'release_failed' and a.id = _rel('demoted')),
  1, 'the dashboard lists it (release_failed)');
set local role service_role;
select is(
  (select format('%s %s', f ->> 'failed', f ->> 'status')
     from (select public.fail_scheduled_release('10700000-0000-0000-0000-00000000000a', _rel('demoted'), 'error') as f) s),
  'false failed', 'a release no longer scheduled is left as it is');
select is(_fails($$ select public.fail_scheduled_release('10700000-0000-0000-0000-00000000000a', _rel('early'), 'because') $$),
  '22023', 'only a known failure code is recorded');
select is(_fails($$ select public.fail_scheduled_release('10700000-0000-0000-0000-00000000000b', _rel('early'), 'error') $$),
  'P0002', 'other_tenant: a release is failed only in its own tenant');
-- A release that is not due, as one a person moved later after the cron claimed it would be.
select is(
  (select format('%s %s', f ->> 'failed', f ->> 'status')
     from (select public.fail_scheduled_release('10700000-0000-0000-0000-00000000000a', _rel('early'), 'scheduler') as f) s),
  'false scheduled', 'a release that is no longer due (moved since its claim) is left scheduled, its drafts claimed');
reset role;

-- An inactive scheduler.
select _stage('s6-title', '10700000-0000-0000-0001-000000000006', '{"title":{"en":"Seis","ar":"ستة"}}');
set local role service_role;
insert into _out (name, result) select 'leaving',
  _sched('10700000-0000-0000-0000-0000000000a5', 'admin', array['s6-title'], now() + interval '1 hour');
reset role;
update public.content_releases set scheduled_for = now() - interval '1 minute' where id = _rel('leaving');
update public.profiles set is_active = false where id = '10700000-0000-0000-0000-0000000000a5';
set local role service_role;
select is(
  (select c -> 0 -> 'scheduler' ->> 'live' from (select public.claim_scheduled_releases(1) as c) s),
  'false', 'the claim tells the Worker the scheduler is no longer live');
select is(_fails($$ select _fire('10700000-0000-0000-0000-0000000000a5', 'admin', _rel('leaving')) $$),
  'BR403:actor', 'and the fire refuses an inactive scheduler');
reset role;

-- The live site moving under a scheduled change.
select _stage('s7-title', '10700000-0000-0000-0001-000000000007', '{"title":{"en":"Siete","ar":"سبعة"}}');
set local role service_role;
insert into _out (name, result) select 'moved',
  _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s7-title'], now() + interval '1 hour');
reset role;
update public.content_releases set scheduled_for = now() - interval '1 minute' where id = _rel('moved');
update public.services set title = '{"en":"Seven!","ar":"سبعة!"}' where id = '10700000-0000-0000-0001-000000000007';
set local role service_role;
select is(_fails($$ select _fire('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('moved')) $$),
  'BR409:conflict', 'a conflict with live refuses the fire');
reset role;
-- Switched off meanwhile.
delete from app.release_tenants where tenant_id = '10700000-0000-0000-0000-00000000000a';
set local role service_role;
select is(_fails($$ select _fire('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('moved')) $$),
  '55000', 'a tenant switched off since refuses the fire');
reset role;
insert into app.release_tenants (tenant_id) values ('10700000-0000-0000-0000-00000000000a');

-- ── 5. Moving and cancelling ──────────────────────────────────────────────────────────
select _stage('s8-title', '10700000-0000-0000-0001-000000000008', '{"title":{"en":"Ocho","ar":"ثمانية"}}');
set local role service_role;
insert into _out (name, result) select 'mv',
  _sched('10700000-0000-0000-0000-0000000000c1', 'content_creator', array['s8-title'], now() + interval '1 hour');
select is(
  (select format('%s %s', f ->> 'version', (f ->> 'scheduled_for')::timestamptz = now() + interval '2 hours')
     from (select public.reschedule_release('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('mv'),
             (select version from public.content_releases where id = _rel('mv')), now() + interval '2 hours') as f) s),
  '2 t', 'an Admin moves it two hours ahead (version 1 to 2)');
reset role;
select is(
  (select format('%s %s', r.scheduled_by, a.actor_id)
     from public.content_releases r
     join public.audit_log a on a.action = 'release.reschedule' and a.entity_id = r.id::text
    where r.id = _rel('mv')),
  '10700000-0000-0000-0000-0000000000a1 10700000-0000-0000-0000-0000000000a1',
  'it goes live as the person who moved it, and their release.reschedule audit row says so');
set local role service_role;
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('mv'), 1, now() + interval '3 hours') $$),
  'BR409:conflict', 'a stale version is refused');
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000e1', 'seo', _rel('mv'), 2, now() + interval '3 hours') $$),
  'BR403:forbidden', 'seo CANNOT move a release of content changes');
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000d1', 'developer', _rel('mv'), 2, now() + interval '3 hours') $$),
  'BR403:forbidden', 'developer CANNOT move it either');
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000c1', 'content_creator', _rel('mv'), 2, now() + interval '20 seconds') $$),
  '22023', 'a new time is at least a minute ahead');
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000a2', 'admin', _rel('mv'), 2, now() + interval '3 hours') $$),
  'BR403:actor', 'an inactive admin cannot move it');
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000f1', 'sales', _rel('mv'), 2, now() + interval '3 hours') $$),
  'BR403:actor', 'a sales role cannot');
reset role;
insert into app.release_tenants (tenant_id) values ('10700000-0000-0000-0000-00000000000b');
set local role service_role;
select is(_fails($$ select public.reschedule_release('10700000-0000-0000-0000-0000000000b1', 'admin', _rel('mv'), 2, now() + interval '3 hours') $$),
  'P0002', 'other_tenant: an admin of tenant B finds no such release');
reset role;
delete from app.release_tenants where tenant_id = '10700000-0000-0000-0000-00000000000b';
set local role service_role;
select is(_fails($$ select public.unschedule_release('10700000-0000-0000-0000-0000000000b1', 'admin', _rel('mv'), 2) $$),
  '55000', 'releases off for that tenant: refused first');

-- A release holding an archive is an Admin's to move or cancel.
reset role;
select _stage('s10-archive', '10700000-0000-0000-0001-00000000000a', '{"status":"archived"}');
set local role service_role;
insert into _out (name, result) select 'arch',
  _sched('10700000-0000-0000-0000-0000000000a1', 'admin', array['s10-archive'], now() + interval '1 hour');
select is(_fails($$ select public.unschedule_release('10700000-0000-0000-0000-0000000000c1', 'content_creator', _rel('arch'), 1) $$),
  'BR403:forbidden', 'content_creator CANNOT cancel a release holding an archive');
select is(
  (select format('%s %s %s', f ->> 'status', f ->> 'released', f ->> 'release_id' = _rel('mv')::text)
     from (select public.unschedule_release('10700000-0000-0000-0000-0000000000c1', 'content_creator', _rel('mv'), 2) as f) s),
  'cancelled 1 t', 'content_creator cancels a release of content changes, its draft released');
reset role;
select is(
  (select format('%s %s %s', r.status,
     (select count(*) from public.content_drafts d, _r11 x
       where x.name = 's8-title' and d.id = (x.item ->> 'draft_id')::uuid and d.release_id is null),
     (select a.actor_id from public.audit_log a where a.action = 'release.unschedule' and a.entity_id = r.id::text))
     from public.content_releases r where r.id = _rel('mv')),
  'cancelled 1 10700000-0000-0000-0000-0000000000c1',
  'cancelled, its change pending again, a release.unschedule audit row naming who cancelled it');
set local role service_role;
select is(_fails($$ select public.unschedule_release('10700000-0000-0000-0000-0000000000a1', 'admin', _rel('mv'), 3) $$),
  'BR409:not-scheduled', 'a cancelled release cannot be cancelled again');
reset role;

-- ── 6. app.publish_scheduled() and scheduled releases never both act ───────────────────
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() runs');
select is(
  (select string_agg(slug || ':' || status, ' ' order by slug) from public.services
    where id in ('10700000-0000-0000-0001-0000000000a9', '10700000-0000-0000-0001-0000000000b9')),
  'r11-sa-legacy:scheduled r11-sb-legacy:published',
  'it publishes a due row of a tenant with releases off, and skips one of a tenant with releases on');

-- ── 7. The switches (tenant C) ────────────────────────────────────────────────────────
-- Two overdue posts (written now: app.publish_scheduled() above would have published them), one
-- last edited by C's content creator, one with no recorded editor.
select set_config('request.jwt.claim.sub', '10700000-0000-0000-0000-0000000000cc', true);
insert into public.blog_posts (id, tenant_id, slug, title, status, scheduled_for) values
  ('10700000-0000-0000-0002-0000000000c1', '10700000-0000-0000-0000-00000000000c', 'r11-c-post',
   '{"en":"C post","ar":"ج مقال"}', 'scheduled', now() - interval '1 minute');
select set_config('request.jwt.claim.sub', '', true);
insert into public.blog_posts (id, tenant_id, slug, title, status, scheduled_for) values
  ('10700000-0000-0000-0002-0000000000c2', '10700000-0000-0000-0000-00000000000c', 'r11-c-news',
   '{"en":"C news","ar":"ج خبر"}', 'scheduled', now() - interval '1 minute');
set local role service_role;
select throws_ok(
  $$ select app.enable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-0000000000ca') $$,
  '42501', null, 'the service role CANNOT switch releases on');
select throws_ok(
  $$ select app.disable_releases('10700000-0000-0000-0000-00000000000a', '10700000-0000-0000-0000-0000000000a1', true) $$,
  '42501', null, 'nor off');
reset role;
set local role authenticated;
select throws_ok(
  $$ select app.enable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-0000000000ca') $$,
  '42501', null, 'authenticated CANNOT switch releases on');
reset role;
-- The owner, as a definer an API request reached would be: a role claim is refused.
select is(_fails($$ select app.enable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-0000000000ca') $$),
  '42501', 'the owner with a role claim (an API request) is refused');
select set_config('request.jwt.claims', '', true);
select is(_fails($$ select app.enable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ce', '10700000-0000-0000-0000-0000000000ca') $$),
  '22023', 'the operator is an Admin of the site');
select is(_fails($$ select app.enable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-0000000000cd') $$),
  '22023', 'the fallback scheduler is an active Admin of the site');
select lives_ok(
  $$ insert into _out (name, result) select 'enable', app.enable_releases('10700000-0000-0000-0000-00000000000c',
       '10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-0000000000ca') $$,
  'the owner switches releases on for tenant C');
select is(
  (select format('%s %s %s %s %s', result ->> 'converted', result ->> 'legacy_releases',
                 result ->> 'fallback_scheduled', result ->> 'left_scheduled', result -> 'baseline' ->> 'number')
     from _out where name = 'enable'),
  '4 4 2 2 1',
  'four legacy rows in four releases (two on the fallback); the timeless FAQ and the team member left; baseline v1');
select is(
  (select string_agg(x, ' ' order by x) from (
     select slug::text || ':' || status::text as x from public.services where tenant_id = '10700000-0000-0000-0000-00000000000c'
     union all select slug::text || ':' || status::text from public.blog_posts where tenant_id = '10700000-0000-0000-0000-00000000000c'
     union all select 'faq:' || status::text from public.faq_items where tenant_id = '10700000-0000-0000-0000-00000000000c'
     union all select slug::text || ':' || status::text from public.team_members where tenant_id = '10700000-0000-0000-0000-00000000000c') s),
  'faq:scheduled r11-c-ada:scheduled r11-c-news:draft r11-c-post:draft r11-c-s1:draft r11-c-s2:draft r11-c-s3:draft',
  'the converted rows are drafts now; the FAQ with no time and the team member (never published by the legacy path) are left');
select is(
  (select string_agg(format('%s:%s:%s', d.entity_type, d.payload, d.base), ' ' order by d.entity_type, d.entity_id)
     from public.content_drafts d where d.tenant_id = '10700000-0000-0000-0000-00000000000c' and d.release_id is not null),
  'blog_post:{"status": "published"}:{"status": "draft"} blog_post:{"status": "published"}:{"status": "draft"} '
  || 'service:{"status": "published"}:{"status": "draft"} service:{"status": "published"}:{"status": "draft"}',
  'each became a claimed pending change: published, from draft');
select is(
  (select string_agg(format('%s:%s', d.entity_id, r.scheduled_by), ' ' order by d.entity_id)
     from public.content_drafts d join public.content_releases r on r.id = d.release_id
    where d.tenant_id = '10700000-0000-0000-0000-00000000000c' and r.kind = 'legacy_schedule' and r.status = 'scheduled'),
  '10700000-0000-0000-0001-0000000000c1:10700000-0000-0000-0000-0000000000cc '
  || '10700000-0000-0000-0001-0000000000c2:10700000-0000-0000-0000-0000000000ca '
  || '10700000-0000-0000-0002-0000000000c1:10700000-0000-0000-0000-0000000000cc '
  || '10700000-0000-0000-0002-0000000000c2:10700000-0000-0000-0000-0000000000ca',
  'each goes live as its last editor while they may still publish it, else the fallback scheduler');
select is(
  (select format('%s %s %s %s %s', r.kind, r.status, r.number, r.purge_status, r.published_by)
     from public.content_releases r where r.id = (select (result -> 'baseline' ->> 'id')::uuid from _out where name = 'enable')),
  'baseline published 1 not_needed 10700000-0000-0000-0000-0000000000ca',
  'the baseline is version 1, live, nothing to purge, by the operator');
select is(
  (select format('%s %s %s', app.releases_enabled('10700000-0000-0000-0000-00000000000c'), a.actor_id, a.detail ->> 'converted')
     from public.audit_log a where a.action = 'releases.enable' and a.tenant_id = '10700000-0000-0000-0000-00000000000c'),
  't 10700000-0000-0000-0000-0000000000ca 4', 'releases are on, and the releases.enable audit row names the operator');
select is(_fails($$ select app.enable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca', '10700000-0000-0000-0000-0000000000ca') $$),
  '55000', 'switching on twice is refused');
-- The overdue post's legacy release fires as its scheduler.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok(
  $$ select _fire('10700000-0000-0000-0000-0000000000cc', 'content_creator',
       (select d.release_id from public.content_drafts d where d.entity_id = '10700000-0000-0000-0002-0000000000c1')) $$,
  'a legacy schedule goes live as a release, as its scheduler');
reset role;
select is(
  (select format('%s %s', p.status, r.kind)
     from public.blog_posts p, public.content_releases r
    where p.id = '10700000-0000-0000-0002-0000000000c1' and r.tenant_id = p.tenant_id and r.number = 2),
  'published legacy_schedule', 'the post is live, in version 2 of kind legacy_schedule');

-- Switching off.
select _stage('c-pending', '10700000-0000-0000-0001-0000000000c3', '{"title":{"en":"C tres","ar":"ج ثلاثة"}}',
              '10700000-0000-0000-0000-00000000000c');
select set_config('request.jwt.claims', '', true);
select is(_fails($$ select app.disable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca') $$),
  '55000', 'switching off is refused while changes are pending or releases scheduled');
select lives_ok(
  $$ insert into _out (name, result) select 'disable', app.disable_releases('10700000-0000-0000-0000-00000000000c',
       '10700000-0000-0000-0000-0000000000ca', true) $$,
  'the owner switches releases off, naming the discard');
select is(
  (select format('%s %s %s %s', result ->> 'discarded', result ->> 'cancelled', result ->> 'restored_schedules',
                 result ->> 'not_restored')
     from _out where name = 'disable'),
  '4 3 3 0', 'three legacy releases cancelled, their three rows back on their own schedule, all four pending changes thrown away');
select is(
  (select string_agg(x, ' ' order by x) from (
     select slug::text || ':' || status::text || ':' || (scheduled_for = now() + interval '1 hour') as x
       from public.services
      where id in ('10700000-0000-0000-0001-0000000000c1', '10700000-0000-0000-0001-0000000000c2')
     union all select slug::text || ':' || status::text || ':' || (scheduled_for = now() - interval '1 minute')
       from public.blog_posts where id = '10700000-0000-0000-0002-0000000000c2') s),
  'r11-c-news:scheduled:true r11-c-s1:scheduled:true r11-c-s2:scheduled:true',
  'each row is scheduled again at the time its release held');
select is(
  (select format('%s %s %s %s', app.releases_enabled('10700000-0000-0000-0000-00000000000c'),
     (select count(*) from public.content_drafts where tenant_id = '10700000-0000-0000-0000-00000000000c'),
     (select count(*) from public.content_releases where tenant_id = '10700000-0000-0000-0000-00000000000c' and status = 'scheduled'),
     (select a.actor_id from public.audit_log a where a.action = 'releases.disable' and a.tenant_id = '10700000-0000-0000-0000-00000000000c'))),
  'f 0 0 10700000-0000-0000-0000-0000000000ca',
  'releases are off, nothing pending or scheduled, and the releases.disable audit row names the operator');
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() runs for tenant C again');
select is((select status::text from public.blog_posts where id = '10700000-0000-0000-0002-0000000000c2'),
  'published', 'and publishes the due row the switch put back');
select is(
  (select format('%s %s', status, scheduled_for is null) from public.faq_items
    where id = '10700000-0000-0000-0003-0000000000c1'),
  'scheduled t', 'a row scheduled with no time is never published: not by the legacy path, nor by a switch');
select is(_fails($$ select app.disable_releases('10700000-0000-0000-0000-00000000000c', '10700000-0000-0000-0000-0000000000ca') $$),
  '55000', 'switching off twice is refused');

select * from finish();
rollback;
