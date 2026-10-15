-- pgTAP: applying a release (migration 0051, Admin v2 R4).
--
-- public.apply_release applies a set of pending changes as the person publishing them:
-- their live profile decides whether they may publish at all and in which tenant, and then
-- RLS, the RESTRICTIVE publish/archive/delete gates, CHECKs and guard triggers decide each
-- change as they would for that person's own write. This suite holds:
--   • who may call it (the service role only, never postgres), and the switch-on flag;
--   • the actor matrix over admin, content_creator, seo, developer, other_tenant, a sales
--     claim, inactive, locked and demoted (stale-token) people, and no profile at all;
--     anon and authenticated cannot call it;
--   • the drafts (each still the one the publisher saw), the registry allowlist (no column
--     it does not name, no immediate column, no per-item schedule, a singleton keyed by its
--     tenant), and that a crafted column name cannot inject (identifiers through %I);
--   • the typed three-way conflict check, atomicity, the ledger, audit and history a
--     publish leaves, the first-publish date, the apply order, the capture of cascades and
--     link sets, the dry run, and that the claims, role and token are put back;
--   • record_release_purge.
-- Releases are switched on for the test tenants inside this rolled-back transaction only.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.

begin;
select plan(100);

-- ── 0. The catalog, before this file creates any function ─────────────────────────────
-- (Its helpers below call set_config, and would show up here.)
select ok(
  has_function_privilege('service_role', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute')
  and not has_function_privilege('public', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute'),
  'apply_release is executable by the service role only');
select ok(
  has_function_privilege('service_role', 'public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)', 'execute')
  and not has_function_privilege('public', 'public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)', 'execute'),
  'record_release_purge is executable by the service role only');
select is(
  (select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname)
     from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname in ('public', 'graphql_public') and f.prosrc ~* 'set_config'
      and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e')),
  'public.apply_release, public.crm_delete_lead_note',
  'exposed functions calling set_config: apply_release and crm_delete_lead_note (app.acting_for) only');
select is(
  (select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname)
     from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname in ('public', 'graphql_public')
      and f.prosrc ~* 'set_config' and f.prosrc ~* 'request\.jwt\.claim'
      and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e')),
  'public.apply_release',
  'only apply_release sets claims (the stated CLAUDE.md §9 exception)');
select is(
  (select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname)
     from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and f.prosrc ~* 'app\.release_apply'
      and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e')),
  'app.release_token_valid, public.apply_release',
  'only apply_release sets the release token, and only app.release_token_valid reads it');
select ok(
  not has_function_privilege('anon', 'app.tg_release_capture()', 'execute')
  and not has_function_privilege('authenticated', 'app.tg_release_capture()', 'execute')
  and not has_function_privilege('service_role', 'app.tg_release_capture()', 'execute')
  and has_function_privilege('service_role', 'app.releases_enabled(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app.releases_enabled(uuid)', 'execute')
  and not has_function_privilege('anon', 'app.releases_enabled(uuid)', 'execute'),
  'the capture trigger is callable by no API role; the flag reader by the service role only');

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────────
insert into app.deployment (env) values ('staging')
  on conflict (singleton) do update set env = excluded.env;
insert into public.tenants (id, name) values
  ('51000000-0000-0000-0000-00000000000a', 'ApplyA'),
  ('51000000-0000-0000-0000-00000000000b', 'ApplyB');
insert into auth.users (id, email) values
  ('51000000-0000-0000-0000-0000000000a1', 'r4-admin@example.test'),
  ('51000000-0000-0000-0000-0000000000c1', 'r4-creator@example.test'),
  ('51000000-0000-0000-0000-0000000000e1', 'r4-seo@example.test'),
  ('51000000-0000-0000-0000-0000000000d1', 'r4-developer@example.test'),
  ('51000000-0000-0000-0000-0000000000a2', 'r4-inactive@example.test'),
  ('51000000-0000-0000-0000-0000000000a3', 'r4-locked@example.test'),
  ('51000000-0000-0000-0000-0000000000c2', 'r4-demoted@example.test'),
  ('51000000-0000-0000-0000-0000000000b1', 'r4-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('51000000-0000-0000-0000-0000000000a1', '51000000-0000-0000-0000-00000000000a', 'admin', true, null),
  ('51000000-0000-0000-0000-0000000000c1', '51000000-0000-0000-0000-00000000000a', 'content_creator', true, null),
  ('51000000-0000-0000-0000-0000000000e1', '51000000-0000-0000-0000-00000000000a', 'seo', true, null),
  ('51000000-0000-0000-0000-0000000000d1', '51000000-0000-0000-0000-00000000000a', 'developer', true, null),
  ('51000000-0000-0000-0000-0000000000a2', '51000000-0000-0000-0000-00000000000a', 'admin', false, null),
  ('51000000-0000-0000-0000-0000000000a3', '51000000-0000-0000-0000-00000000000a', 'admin', true, now() + interval '10 minutes'),
  -- Demoted: an admin until recently; the profile now says content creator.
  ('51000000-0000-0000-0000-0000000000c2', '51000000-0000-0000-0000-00000000000a', 'content_creator', true, null),
  ('51000000-0000-0000-0000-0000000000b1', '51000000-0000-0000-0000-00000000000b', 'admin', true, null);

insert into public.services (id, tenant_id, slug, title, status, preview_video_path, preview_start_s, preview_end_s) values
  ('51000000-0000-0000-0001-000000000001', '51000000-0000-0000-0000-00000000000a', 'r4-svc-1',
   '{"en":"One","ar":"واحد"}', 'published', '/media/showreel.mp4', 12.50, 14.00),
  ('51000000-0000-0000-0001-000000000002', '51000000-0000-0000-0000-00000000000a', 'r4-svc-2',
   '{"en":"Two","ar":"اثنان"}', 'published', null, null, null),
  ('51000000-0000-0000-0001-000000000003', '51000000-0000-0000-0000-00000000000a', 'r4-svc-3',
   '{"en":"Three","ar":"ثلاثة"}', 'draft', null, null, null),
  ('51000000-0000-0000-0001-000000000004', '51000000-0000-0000-0000-00000000000a', 'r4-svc-4',
   '{"en":"Four","ar":"أربعة"}', 'published', null, null, null),
  ('51000000-0000-0000-0001-000000000006', '51000000-0000-0000-0000-00000000000a', 'r4-svc-6',
   '{"en":"Six","ar":"ستة"}', 'published', null, null, null),
  ('51000000-0000-0000-0001-0000000000b1', '51000000-0000-0000-0000-00000000000b', 'r4-svc-b',
   '{"en":"B","ar":"ب"}', 'published', null, null, null);
insert into public.service_cases (id, tenant_id, service_id, title) values
  ('51000000-0000-0000-000a-000000000004', '51000000-0000-0000-0000-00000000000a',
   '51000000-0000-0000-0001-000000000004', '{"en":"Case","ar":"حالة"}');
insert into public.pages (id, tenant_id, slug, title, status) values
  ('51000000-0000-0000-0002-000000000001', '51000000-0000-0000-0000-00000000000a', 'r4-page-del',
   '{"en":"Gone","ar":"ذهب"}', 'draft');
insert into public.page_sections (id, tenant_id, page_id, type) values
  ('51000000-0000-0000-0003-000000000001', '51000000-0000-0000-0000-00000000000a',
   '51000000-0000-0000-0002-000000000001', 'cta'),
  ('51000000-0000-0000-0003-000000000002', '51000000-0000-0000-0000-00000000000a',
   '51000000-0000-0000-0002-000000000001', 'cta');
insert into public.navigation (id, tenant_id, location, label, href, is_key) values
  ('51000000-0000-0000-0004-000000000001', '51000000-0000-0000-0000-00000000000a', 'header',
   '{"en":"X","ar":"س"}', '/r4-x', true),
  ('51000000-0000-0000-0004-000000000002', '51000000-0000-0000-0000-00000000000a', 'header',
   '{"en":"Y","ar":"ص"}', '/r4-y', false);
insert into public.custom_themes (id, tenant_id, name, is_active) values
  ('51000000-0000-0000-0005-000000000001', '51000000-0000-0000-0000-00000000000a', 'r4 live theme', true),
  ('51000000-0000-0000-0005-000000000002', '51000000-0000-0000-0000-00000000000a', 'r4 next theme', false);
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('51000000-0000-0000-0007-000000000001', '51000000-0000-0000-0000-00000000000a', 'image', 'static', 'stills/work/p0.jpg'),
  ('51000000-0000-0000-0007-0000000000b1', '51000000-0000-0000-0000-00000000000b', 'image', 'static', 'stills/work/p1.jpg');
insert into public.portfolio (id, tenant_id, slug, title, status, is_placeholder) values
  ('51000000-0000-0000-0006-000000000001', '51000000-0000-0000-0000-00000000000a', 'r4-proj',
   '{"en":"Project","ar":"مشروع"}', 'draft', false),
  ('51000000-0000-0000-0006-000000000002', '51000000-0000-0000-0000-00000000000a', 'r4-proj-sample',
   '{"en":"Sample","ar":"عينة"}', 'draft', true);
insert into public.portfolio_services (tenant_id, portfolio_id, service_id, sort_order) values
  ('51000000-0000-0000-0000-00000000000a', '51000000-0000-0000-0006-000000000001',
   '51000000-0000-0000-0001-000000000002', 0);
insert into public.testimonials (id, tenant_id, slug, quote, author_name, status, is_placeholder) values
  ('51000000-0000-0000-0008-000000000001', '51000000-0000-0000-0000-00000000000a', 'r4-quote',
   '{"en":"Real","ar":"حقيقي"}', '{"en":"Rana","ar":"رنا"}', 'draft', false),
  ('51000000-0000-0000-0008-000000000002', '51000000-0000-0000-0000-00000000000a', 'r4-sample',
   '{"en":"Sample","ar":"عينة"}', '{"en":"Client name","ar":"اسم العميل"}', 'draft', true);
insert into public.team_members (id, tenant_id, slug, name) values
  ('51000000-0000-0000-0009-000000000001', '51000000-0000-0000-0000-00000000000a', 'r4-ada',
   '{"en":"Ada","ar":"آدا"}');
insert into public.redirects (id, tenant_id, source_path, target_path) values
  ('51000000-0000-0000-000b-000000000001', '51000000-0000-0000-0000-00000000000a', '/r4-old', '/r4-new');
insert into public.site_profile (tenant_id, brand_name, contact_email, location) values
  ('51000000-0000-0000-0000-00000000000a', '{"en":"Studio","ar":"استوديو"}', 'hello@example.com',
   '{"en":"Riyadh","ar":"الرياض"}');
-- A scheduled release of tenant A, to claim a draft with.
insert into public.content_releases (id, tenant_id, kind, status, scheduled_for, scheduled_by, payload) values
  ('51000000-0000-0000-000d-000000000001', '51000000-0000-0000-0000-00000000000a', 'publish',
   'scheduled', now() + interval '1 day', '51000000-0000-0000-0000-0000000000a1', '[]');

-- The staged items, by name.
create table _r4 (name text primary key, item jsonb not null);
create table _out (name text primary key, result jsonb);
grant all on _r4, _out to service_role;

-- Stage a pending change in tenant A: its draft (as the database holds it, version 1) and
-- the item a publish names. The base is the live values of the patched columns and the
-- base version the live version, so a change staged here is in step with the site.
create function _stage(p_name text, p_type text, p_entity uuid, p_op text, p_patch jsonb,
                       p_children jsonb default null, p_tenant uuid default '51000000-0000-0000-0000-00000000000a')
returns uuid language plpgsql as $$
declare
  v_reg app.release_entities;
  v_live jsonb;
  v_base jsonb := '{}'::jsonb;
  v_draft uuid := gen_random_uuid();
begin
  select * into v_reg from app.release_entities where entity_type = p_type;
  if p_op <> 'create' then
    execute format('select to_jsonb(t) from public.%I t where t.%I = $1', v_reg.table_name, v_reg.key_column)
      into v_live using p_entity;
    select coalesce(jsonb_object_agg(k, v_live -> k), '{}'::jsonb) into v_base
      from jsonb_object_keys(p_patch) k;
  end if;
  delete from public.content_drafts
   where tenant_id = p_tenant and entity_type = p_type and entity_id = p_entity;
  insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, base, base_version)
  values (v_draft, p_tenant, p_type, p_entity, p_op, v_base,
          case when p_op = 'create' then null else (v_live ->> 'version')::int end);
  insert into _r4 (name, item) values (p_name,
    jsonb_build_object('draft_id', v_draft, 'draft_version', 1, 'entity_type', p_type,
                       'entity_id', p_entity, 'op', p_op, 'patch', p_patch, 'base', v_base)
    || case when p_children is null then '{}'::jsonb else jsonb_build_object('children', p_children) end)
  on conflict (name) do update set item = excluded.item;
  return v_draft;
end $$;

-- A draft edited here directly moves to its next version (the draft lock): the item follows.
create function _sync(p_name text) returns void language sql as $$
  update _r4 r set item = r.item || jsonb_build_object('draft_version', d.version)
    from public.content_drafts d
   where r.name = p_name and d.id = (r.item ->> 'draft_id')::uuid
$$;

-- Publish (or dry-run) the named items, in that order, as p_actor in p_role.
create function _pub(p_actor text, p_role text, p_names text[], p_mode text default 'publish')
returns jsonb language sql as $$
  select public.apply_release(p_actor::uuid, p_role, p_mode,
    (select jsonb_agg(r.item order by array_position(p_names, r.name)) from _r4 r where r.name = any (p_names)))
$$;

-- An error, caught: its SQLSTATE, message and (JSON) detail; 'ok' when there was none.
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

-- SQLSTATE, then the code or the first refused item's SQLSTATE: 'BR422:42501'.
create function _fails(p_sql text) returns text language sql as $$
  select c ->> 'state' || coalesce(':' || coalesce(c -> 'detail' ->> 'code' || coalesce(':' || (c -> 'detail' -> 'items' -> 0 ->> 'sqlstate'), ''), null), '')
    from (select _catch(p_sql) as c) s
$$;

-- The service role's own claims, as PostgREST sets them for the Worker's key.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── 1. Who may call ──────────────────────────────────────────────────────────────────
select _stage('s1-title', 'service', '51000000-0000-0000-0001-000000000001', 'update',
              '{"title":{"en":"Uno","ar":"واحد"}}');
set local role authenticated;
select throws_ok(
  $$ select public.apply_release('51000000-0000-0000-0000-0000000000a1', 'admin', 'publish', '[]'::jsonb) $$,
  '42501', 'permission denied for function apply_release', 'authenticated CANNOT execute apply_release');
reset role;
set local role anon;
select throws_ok(
  $$ select public.apply_release('51000000-0000-0000-0000-0000000000a1', 'admin', 'publish', '[]'::jsonb) $$,
  '42501', 'permission denied for function apply_release', 'anon CANNOT execute apply_release');
reset role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['s1-title']) $$),
  '42501', 'postgres is refused too: the service role only (a postgres-owned definer cannot reach it)');

set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['s1-title'], 'schedule') $$),
  '22023', 'mode schedule arrives with R11');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['s1-title'], 'fire') $$),
  '22023', 'mode fire arrives with R11');
select is(_fails($$ select public.apply_release('51000000-0000-0000-0000-0000000000a1', 'admin', 'publish',
                     (select jsonb_agg(item) from _r4, generate_series(1, 61))) $$),
  '22023', '61 changes are refused (RELEASE_MAX_ITEMS, P-15)');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['s1-title']) $$),
  '55000', 'releases off for the tenant: refused before any write');
reset role;
select is((select count(*)::int from public.content_releases where tenant_id = '51000000-0000-0000-0000-00000000000a'),
  1, 'nothing written while releases are off (only the fixture''s scheduled release)');

-- Switched on for tenant A only (rolled back with this file).
insert into app.release_tenants (tenant_id) values ('51000000-0000-0000-0000-00000000000a');

-- ── 2. A good publish, and everything it leaves ──────────────────────────────────────
set local role service_role;
select lives_ok(
  $$ insert into _out (name, result) select 'first', _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['s1-title']) $$,
  'content_creator publishes a service update');
select is(current_user::text || ' ' || current_setting('request.jwt.claims', true) || ' ['
          || coalesce(current_setting('app.release_apply', true), '') || ']',
  'service_role {"role":"service_role"} []',
  'after a publish, in the same transaction: the service role, its own claims, no release token');
reset role;
select is(app.release_token_valid(), false, 'and the release token is no longer valid');
select is((select title ->> 'en' from public.services where id = '51000000-0000-0000-0001-000000000001'),
  'Uno', 'the live row changed');
select is(
  (select format('%s %s %s %s %s', r.status, r.number, r.published_by, r.item_count, r.areas)
     from public.content_releases r, _out o
    where o.name = 'first' and r.id = (o.result ->> 'release_id')::uuid),
  'published 1 51000000-0000-0000-0000-0000000000c1 1 {services}',
  'the release is live, numbered 1, by the publisher, with its count and area');
select is((select count(*)::int from public.content_drafts d, _r4 r
            where r.name = 's1-title' and d.id = (r.item ->> 'draft_id')::uuid),
  0, 'the draft it published is consumed');
select is(
  (select format('%s %s %s %s %s', a.actor_id, a.actor_role, a.entity_type, a.hash <> '', a.detail)
     from public.audit_log a, _out o
    where a.action = 'release.publish' and a.entity_id = o.result ->> 'release_id' and o.name = 'first'),
  format('51000000-0000-0000-0000-0000000000c1 content_creator release t %s',
         jsonb_build_object('kind', 'publish', 'items', jsonb_build_array(jsonb_build_object(
           'id', '51000000-0000-0000-0001-000000000001', 'op', 'update', 'type', 'service')),
           'number', 1, 'restores', null, 'item_count', 1)),
  'one release.publish audit row, written as the publisher, chained, with ids and counts only');
select is(
  (select count(*)::int from public.content_versions v, _out o
    where o.name = 'first' and v.entity_id = '51000000-0000-0000-0001-000000000001'
      and v.release_id = (o.result ->> 'release_id')::uuid),
  1, 'the history row names the release');
select is(
  (select format('%s %s %s %s %s', i.op, i.draft_id = (r.item ->> 'draft_id')::uuid, i.actor_id,
                 i.before -> 'title' ->> 'en', i.after -> 'title' ->> 'en')
     from public.content_release_items i, _out o, _r4 r
    where o.name = 'first' and r.name = 's1-title'
      and i.release_id = (o.result ->> 'release_id')::uuid),
  'update t 51000000-0000-0000-0000-0000000000c1 One Uno',
  'one captured item: the op, its draft, the publisher, the row before and after');
select ok(
  (select bool_and(not (i.before ? 'search_en') and not (i.before ? 'search_ar')
                   and not (i.after ? 'search_en') and not (i.after ? 'search_ar'))
     from public.content_release_items i, _out o
    where o.name = 'first' and i.release_id = (o.result ->> 'release_id')::uuid),
  'the generated search columns are not in the images');
select is(
  (select jsonb_array_length(o.result -> 'items') || ' ' || (o.result -> 'items' -> 0 ->> 'entity_type')
          || ' ' || (o.result -> 'items' -> 0 ->> 'release_id' = o.result ->> 'release_id')
     from _out o where o.name = 'first'),
  '1 service true', 'it returns the release, its number and its items');

-- ── 3. The actor matrix ──────────────────────────────────────────────────────────────
select _stage('svc-new', 'service', '51000000-0000-0000-0001-000000000005', 'create',
              '{"slug":"r4-svc-5","title":{"en":"Five","ar":"خمسة"},"status":"published"}');
select _stage('s3-delete', 'service', '51000000-0000-0000-0001-000000000003', 'delete', '{}');
select _stage('s2-blurb', 'service', '51000000-0000-0000-0001-000000000002', 'update',
              '{"blurb":{"en":"Blurb","ar":"نبذة"}}');
select _stage('profile-year', 'site_profile', '51000000-0000-0000-0000-00000000000a', 'update', '{"founded_year":2020}');
select _stage('seo-create', 'entity_seo', '51000000-0000-0000-000c-000000000001', 'create',
              '{"entity_type":"service","entity_id":"51000000-0000-0000-0001-000000000001","meta_title":{"en":"Meta","ar":"ميتا"}}');
select _stage('redirect-target', 'redirect', '51000000-0000-0000-000b-000000000001', 'update', '{"target_path":"/r4-newer"}');

set local role service_role;
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['svc-new']) $$,
  'content_creator publishes a new service');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000e1', 'seo', array['s2-blurb']) $$),
  'BR422:refused:42501', 'seo CANNOT change a service (RLS refuses it as the publisher)');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000d1', 'developer', array['s2-blurb']) $$),
  'BR422:refused:42501', 'developer CANNOT change a service');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['s3-delete']) $$),
  'BR422:refused:42501', 'content_creator CANNOT remove a service (the RESTRICTIVE delete gate)');
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000d1', 'developer', array['profile-year']) $$,
  'developer publishes a site_profile change');
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000e1', 'seo', array['seo-create', 'redirect-target']) $$,
  'seo publishes a new entity_seo row and a redirect change');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'sales', array['s2-blurb']) $$),
  'BR403:actor', 'a sales role is refused (not a CMS role)');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a2', 'admin', array['s2-blurb']) $$),
  'BR403:actor', 'an inactive admin is refused');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a3', 'admin', array['s2-blurb']) $$),
  'BR403:actor', 'a locked admin is refused');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c2', 'admin', array['s2-blurb']) $$),
  'BR403:actor', 'a demoted person''s stale token (role admin, profile content_creator) is refused');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000ff', 'admin', array['s2-blurb']) $$),
  'BR403:actor', 'a person with no profile is refused');
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['s3-delete']) $$,
  'admin removes a service');
reset role;
select is(
  (select format('%s|%s|%s|%s',
     (select status from public.services where id = '51000000-0000-0000-0001-000000000005'),
     (select founded_year from public.site_profile where tenant_id = '51000000-0000-0000-0000-00000000000a'),
     (select target_path from public.redirects where id = '51000000-0000-0000-000b-000000000001'),
     (select count(*) from public.services where id = '51000000-0000-0000-0001-000000000003'))),
  'published|2020|/r4-newer|0',
  'what those publishes changed is live');
-- other_tenant: an admin of tenant B (switched on too, for this row) naming tenant A's drafts.
insert into app.release_tenants (tenant_id) values ('51000000-0000-0000-0000-00000000000b');
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000b1', 'admin', array['s2-blurb']) $$),
  'BR409:pending-changed', 'other_tenant: an admin of tenant B cannot publish tenant A''s pending changes');
select _stage('archive-cc', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"status":"archived"}');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['archive-cc']) $$),
  'BR422:refused:42501', 'content_creator CANNOT archive (the archive gate binds under impersonation)');
reset role;
delete from public.content_drafts where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'archive-cc');

-- ── 4. The drafts and the allowlist ──────────────────────────────────────────────────
select _stage('d-base', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"sort_order":7}');
insert into _r4 (name, item)
select 'd-unknown', item || jsonb_build_object('draft_id', gen_random_uuid()) from _r4 where name = 'd-base'
union all
select 'd-version', item || '{"draft_version":2}' from _r4 where name = 'd-base'
union all
select 'd-op', item || '{"op":"delete","patch":{}}' from _r4 where name = 'd-base';
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-unknown']) $$),
  'BR409:pending-changed', 'an unknown draft is refused (pending-changed)');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-version']) $$),
  'BR409:pending-changed', 'a draft at another version is refused');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-op']) $$),
  'BR409:pending-changed', 'an item whose operation, type or id is not its draft''s is refused');
reset role;
update public.content_drafts set release_id = '51000000-0000-0000-000d-000000000001'
 where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'd-base');
select _sync('d-base');
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-base']) $$),
  'BR409:pending-changed', 'a draft claimed by a scheduled release is refused');
reset role;
select _stage('d-singleton', 'site_profile', '51000000-0000-0000-0000-00000000000a', 'update', '{"founded_year":2021}');
update _r4 set item = item || '{"entity_id":"51000000-0000-0000-0000-0000000000ff"}' where name = 'd-singleton';
update public.content_drafts set entity_id = '51000000-0000-0000-0000-0000000000ff'
 where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'd-singleton');
select _sync('d-singleton');
select _stage('d-column', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"version":99}');
select _stage('d-exempt', 'site_profile', '51000000-0000-0000-0000-00000000000a', 'update', '{"accepting_applications":true}');
select _stage('d-scheduled', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"status":"scheduled"}');
select _stage('d-inject', 'service', '51000000-0000-0000-0001-000000000002', 'update',
              jsonb_build_object('title" = ''{}''::jsonb, "slug', 'x'));
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000d1', 'developer', array['d-singleton']) $$),
  '22023', 'a singleton change must be keyed by its tenant');
select ok(
  (select c ->> 'state' = '22023' and c ->> 'message' ~ 'version on services'
     from (select _catch($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-column']) $$) c) s),
  'a column the registry does not allow is refused, by name (loud drift)');
select ok(
  (select c ->> 'state' = '22023' and c ->> 'message' ~ 'accepting_applications'
     from (select _catch($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['d-exempt']) $$) c) s),
  'an immediate column (accepting_applications) is never part of a release');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-scheduled']) $$),
  '22023', 'a change is never scheduled on its own');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-inject']) $$),
  '22023', 'a crafted column name in a patch is refused before any SQL is built');
reset role;
-- A crafted name that the registry itself carried (only a migration can write it) would
-- still be one quoted identifier: an unknown column, nothing injected.
update app.release_entities set columns = columns || array['title" = ''{}''::jsonb, "slug']
 where entity_type = 'service';
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['d-inject']) $$),
  'BR422:refused:42703', 'even a crafted name from the registry is one quoted identifier (42703, no injection)');
reset role;
select is((select format('%s %s', title ->> 'en', slug) from public.services where id = '51000000-0000-0000-0001-000000000002'),
  'Two r4-svc-2', 'and the live row is untouched');
update app.release_entities set columns = array_remove(columns, 'title" = ''{}''::jsonb, "slug')
 where entity_type = 'service';

-- ── 5. Conflicts ─────────────────────────────────────────────────────────────────────
select _stage('c-title', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"title":{"en":"Mine","ar":"لي"}}');
update public.services set title = '{"en":"Theirs","ar":"لهم"}' where id = '51000000-0000-0000-0001-000000000002';
set local role service_role;
select is(
  (select c -> 'detail' from (select _catch($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-title']) $$) c) s),
  jsonb_build_object('code', 'conflict', 'items', jsonb_build_array(jsonb_build_object(
    'draftId', (select item ->> 'draft_id' from _r4 where name = 'c-title'), 'columns', jsonb_build_array('title')))),
  'the live row moved on a column the draft changes: 409, naming the column');
reset role;
-- A writer that sends the old version back (app.tg_bump_version keeps a version that differs
-- from the stored one): the version equals the draft's base version, the column moved.
select _stage('c-version', 'service', '51000000-0000-0000-0001-000000000005', 'update', '{"title":{"en":"Mine","ar":"لي"}}');
update public.services set title = '{"en":"Sneaky","ar":"خفي"}' where id = '51000000-0000-0000-0001-000000000005';
update public.services s set version = d.base_version
  from public.content_drafts d, _r4 r
 where s.id = '51000000-0000-0000-0001-000000000005' and r.name = 'c-version'
   and d.id = (r.item ->> 'draft_id')::uuid;
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-version']) $$),
  'BR409:conflict', 'a moved column is a conflict even when the version was sent back to the base version');
reset role;
delete from public.content_drafts where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'c-version');
-- Typed: the base carries "12.5" (text) where the column holds 12.50; the version moved.
select _stage('c-typed', 'service', '51000000-0000-0000-0001-000000000001', 'update',
              '{"preview_start_s":13,"preview_end_s":15}');
update _r4 set item = jsonb_set(item, '{base,preview_start_s}', '"12.5"') where name = 'c-typed';
update public.content_drafts set base = jsonb_set(base, '{preview_start_s}', '"12.5"'), base_version = base_version - 1
 where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'c-typed');
select _sync('c-typed');
-- An unpatched column moved under another draft: no conflict either.
select _stage('c-other', 'service', '51000000-0000-0000-0001-000000000004', 'update', '{"sort_order":3}');
update public.services set blurb = '{"en":"Moved","ar":"تغير"}' where id = '51000000-0000-0000-0001-000000000004';
set local role service_role;
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-typed']) $$,
  'a numeric written 12.50 and 12.5 is the same value: no conflict');
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-other']) $$,
  'a column the draft does not change may move: no conflict');
reset role;
select _stage('c-nobase', 'service', '51000000-0000-0000-0001-000000000001', 'update', '{"sort_order":4}');
update _r4 set item = jsonb_set(item, '{base}', '{}') where name = 'c-nobase';
update public.content_drafts set base = '{}'
 where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'c-nobase');
select _sync('c-nobase');
-- A request whose base is not its draft's: the draft is the one that counts.
select _stage('c-otherbase', 'service', '51000000-0000-0000-0001-000000000005', 'update', '{"sort_order":8}');
update _r4 set item = jsonb_set(item, '{base,sort_order}', '999') where name = 'c-otherbase';
select _stage('c-gone', 'service', '51000000-0000-0000-0001-000000000004', 'update', '{"sort_order":9}');
delete from public.services where id = '51000000-0000-0000-0001-000000000004';
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-nobase']) $$),
  'BR422:base-missing', 'a draft with no base for a column it changes is refused (422)');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-otherbase']) $$),
  'BR409:pending-changed', 'a request whose base differs from its draft''s is refused (the draft''s base counts)');
select is(
  (select c -> 'detail' -> 'items' -> 0 from (select _catch($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['c-gone']) $$) c) s),
  jsonb_build_object('draftId', (select item ->> 'draft_id' from _r4 where name = 'c-gone'), 'removed', true),
  'a row removed under a pending change is a conflict: removed');
reset role;
delete from public.content_drafts
 where id in (select (item ->> 'draft_id')::uuid from _r4 where name in ('c-title', 'c-nobase', 'c-gone', 'c-otherbase'));

-- ── 6. Atomic: one refused change keeps nothing ──────────────────────────────────────
select _stage('a-1', 'service', '51000000-0000-0000-0001-000000000001', 'update', '{"sort_order":11}');
select _stage('a-2', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"slug":"r4-svc-1"}');
select _stage('a-3', 'redirect', '51000000-0000-0000-000b-000000000001', 'update', '{"target_path":"/r4-atomic"}');
create table _before as
  select (select count(*) from public.content_releases where tenant_id = '51000000-0000-0000-0000-00000000000a') as releases,
         (select count(*) from public.content_release_items where tenant_id = '51000000-0000-0000-0000-00000000000a') as items,
         (select count(*) from public.audit_log where tenant_id = '51000000-0000-0000-0000-00000000000a') as audit,
         (select count(*) from public.content_drafts where tenant_id = '51000000-0000-0000-0000-00000000000a') as drafts;
grant select on _before to service_role;
set local role service_role;
select is(
  (select format('%s %s %s', c ->> 'state', c -> 'detail' -> 'items' -> 0 ->> 'draftId' = (select item ->> 'draft_id' from _r4 where name = 'a-2'),
                 c -> 'detail' -> 'items' -> 0 ->> 'constraint')
     from (select _catch($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['a-1', 'a-2', 'a-3']) $$) c) s),
  'BR422 t services_tenant_id_slug_key',
  'a slug collision in a three-change publish: 422 naming that change and the constraint');
reset role;
select is(
  (select format('%s %s %s %s %s %s',
     (select sort_order from public.services where id = '51000000-0000-0000-0001-000000000001') <> 11,
     (select target_path from public.redirects where id = '51000000-0000-0000-000b-000000000001'),
     (select count(*) from public.content_releases where tenant_id = '51000000-0000-0000-0000-00000000000a') = b.releases,
     (select count(*) from public.content_release_items where tenant_id = '51000000-0000-0000-0000-00000000000a') = b.items,
     (select count(*) from public.audit_log where tenant_id = '51000000-0000-0000-0000-00000000000a') = b.audit,
     (select count(*) from public.content_drafts where tenant_id = '51000000-0000-0000-0000-00000000000a') = b.drafts)
     from _before b),
  't /r4-newer t t t t',
  'nothing kept: no live change, no release, no item, no audit row, the drafts intact');
delete from public.content_drafts
 where id in (select (item ->> 'draft_id')::uuid from _r4 where name in ('a-1', 'a-2', 'a-3'));

-- ── 7. published_at: stamped on a first publish, never rewritten ─────────────────────
select is((select published_at is not null from public.services where id = '51000000-0000-0000-0001-000000000005'),
  true, 'a service created published in a release gets published_at');
update public.services set published_at = null where id = '51000000-0000-0000-0001-000000000002';
update public.services set status = 'draft' where id = '51000000-0000-0000-0001-000000000002';
select _stage('p-first', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"status":"published"}');
set local role service_role;
select lives_ok($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['p-first']) $$,
  'a first publish of the service applies');
reset role;
create table _stamp as select published_at as at from public.services where id = '51000000-0000-0000-0001-000000000002';
select _stage('p-unpub', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"status":"draft"}');
set local role service_role;
select lives_ok($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['p-unpub']) $$,
  'an unpublish applies');
reset role;
select _stage('p-again', 'service', '51000000-0000-0000-0001-000000000002', 'update', '{"status":"published"}');
set local role service_role;
select lives_ok($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['p-again']) $$,
  'a republish applies');
reset role;
select is(
  (select format('%s %s', s.status, s.published_at = t.at and t.at is not null)
     from public.services s, _stamp t where s.id = '51000000-0000-0000-0001-000000000002'),
  'published t',
  'a first publish stamps published_at; unpublish and republish keep it (truthful dates)');

-- ── 8. Guards bind under impersonation ───────────────────────────────────────────────
select _stage('g-consent', 'testimonial', '51000000-0000-0000-0008-000000000001', 'update', '{"status":"published"}');
select _stage('g-sample', 'testimonial', '51000000-0000-0000-0008-000000000002', 'update',
              '{"quote":{"en":"Rewritten","ar":"معاد"}}');
select _stage('g-placeholder', 'portfolio', '51000000-0000-0000-0006-000000000002', 'update', '{"status":"published"}');
set local role service_role;
select ok(
  (select c ->> 'state' = 'BR422' and c -> 'detail' -> 'items' -> 0 ->> 'constraint' = 'testimonials_consent_gate'
     from (select _catch($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['g-consent']) $$) c) s),
  'a quote with no recorded consent cannot go live (the consent CHECK)');
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['g-sample']) $$),
  'BR422:refused:42501', 'a design sample''s words cannot change (the 0028 sample lock, as staff)');
reset role;
update app.deployment set env = 'production';
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['g-placeholder']) $$),
  'BR422:refused:42501', 'production: a placeholder cannot go live, even for an admin (the 0025 guard)');
reset role;
update app.deployment set env = 'staging';
delete from public.content_drafts
 where id in (select (item ->> 'draft_id')::uuid from _r4 where name in ('g-consent', 'g-sample', 'g-placeholder'));

-- ── 9. The order ─────────────────────────────────────────────────────────────────────
-- The navigation key moves from X to Y: X's cleared flag lands before Y's.
select _stage('o-key-y', 'nav_item', '51000000-0000-0000-0004-000000000002', 'update', '{"is_key":true}');
select _stage('o-key-x', 'nav_item', '51000000-0000-0000-0004-000000000001', 'update', '{"is_key":false}');
-- A project created with its "next" pointing at another project created in the same release.
select _stage('o-proj-a', 'portfolio', '51000000-0000-0000-0006-0000000000a1', 'create',
              '{"slug":"r4-next-a","title":{"en":"A","ar":"أ"},"next_portfolio_id":"51000000-0000-0000-0006-0000000000a2"}');
select _stage('o-proj-b', 'portfolio', '51000000-0000-0000-0006-0000000000a2', 'create',
              '{"slug":"r4-next-b","title":{"en":"B","ar":"ب"}}');
-- A page and its section, created together (pages apply before sections).
select _stage('o-section', 'page_section', '51000000-0000-0000-0003-0000000000a1', 'create',
              '{"page_id":"51000000-0000-0000-0002-0000000000a1","type":"cta"}');
select _stage('o-page', 'page', '51000000-0000-0000-0002-0000000000a1', 'create',
              '{"slug":"r4-page-new","title":{"en":"New","ar":"جديد"}}');
set local role service_role;
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['o-key-y', 'o-key-x']) $$,
  'the navigation key moves from one link to another in one release');
select lives_ok(
  $$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['o-proj-a', 'o-proj-b', 'o-section', 'o-page']) $$,
  'a self-reference to a row created in the same release, and a section of a new page, apply');
reset role;
select is(
  (select format('%s %s %s',
     (select string_agg(id::text || '=' || is_key, ',' order by id) from public.navigation
       where tenant_id = '51000000-0000-0000-0000-00000000000a'),
     (select next_portfolio_id from public.portfolio where id = '51000000-0000-0000-0006-0000000000a1'),
     (select page_id from public.page_sections where id = '51000000-0000-0000-0003-0000000000a1'))),
  '51000000-0000-0000-0004-000000000001=false,51000000-0000-0000-0004-000000000002=true '
  || '51000000-0000-0000-0006-0000000000a2 51000000-0000-0000-0002-0000000000a1',
  'the key moved, the self-reference was set in the second pass, the section sits on its page');
select is(
  (select string_agg(i.op || ':' || coalesce(i.after ->> 'next_portfolio_id', '-'), ' ' order by i.id)
     from public.content_release_items i
    where i.entity_id = '51000000-0000-0000-0006-0000000000a1'),
  'create:- update:51000000-0000-0000-0006-0000000000a2',
  'the second pass is captured as its own item (a restore reads the earliest image)');

-- ── 10. Cascades between registry tables are captured ───────────────────────────────
select _stage('x-page', 'page', '51000000-0000-0000-0002-000000000001', 'delete', '{}');
select _stage('x-svc6', 'service', '51000000-0000-0000-0001-000000000006', 'delete', '{}');
insert into public.service_cases (id, tenant_id, service_id, title) values
  ('51000000-0000-0000-000a-000000000006', '51000000-0000-0000-0000-00000000000a',
   '51000000-0000-0000-0001-000000000006', '{"en":"Case six","ar":"حالة ٦"}');
select _stage('x-theme', 'custom_theme', '51000000-0000-0000-0005-000000000002', 'update', '{"is_active":true}');
set local role service_role;
insert into _out (name, result)
select 'cascade', _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['x-page', 'x-svc6', 'x-theme']);
reset role;
select is(
  (select string_agg(format('%s %s %s', i.entity_type, i.op, i.draft_id is null), ', ' order by i.entity_type, i.entity_id)
     from public.content_release_items i, _out o
    where o.name = 'cascade' and i.release_id = (o.result ->> 'release_id')::uuid
      and i.entity_type in ('page_section', 'service_case')),
  'page_section delete t, page_section delete t, service_case delete t',
  'removing a page captures its sections, removing a service its case: items with no draft');
select is(
  (select string_agg(format('%s %s %s', i.entity_id, i.after ->> 'is_active', i.draft_id is null), ', ' order by i.id)
     from public.content_release_items i, _out o
    where o.name = 'cascade' and i.release_id = (o.result ->> 'release_id')::uuid
      and i.entity_type = 'custom_theme'),
  '51000000-0000-0000-0005-000000000001 false t, 51000000-0000-0000-0005-000000000002 true f',
  'activating a theme switches the live one off first, captured with no draft');
select is((select count(*)::int from public.custom_themes
            where tenant_id = '51000000-0000-0000-0000-00000000000a' and is_active),
  1, 'one active theme');

-- Removing a menu link and its child together, whichever id sorts first: the parent's
-- removal cascades to the child, whose own removal then finds it gone, and is done.
insert into public.navigation (id, tenant_id, location, parent_id, label, href) values
  ('51000000-0000-0000-0004-0000000000a1', '51000000-0000-0000-0000-00000000000a', 'footer', null,
   '{"en":"P1","ar":"أ١"}', '/r4-p1'),
  ('51000000-0000-0000-0004-0000000000a2', '51000000-0000-0000-0000-00000000000a', 'footer',
   '51000000-0000-0000-0004-0000000000a1', '{"en":"C1","ar":"ب١"}', '/r4-c1'),
  ('51000000-0000-0000-0004-0000000000b2', '51000000-0000-0000-0000-00000000000a', 'footer', null,
   '{"en":"P2","ar":"أ٢"}', '/r4-p2'),
  ('51000000-0000-0000-0004-0000000000b1', '51000000-0000-0000-0000-00000000000a', 'footer',
   '51000000-0000-0000-0004-0000000000b2', '{"en":"C2","ar":"ب٢"}', '/r4-c2');
select _stage('n-p1', 'nav_item', '51000000-0000-0000-0004-0000000000a1', 'delete', '{}');
select _stage('n-c1', 'nav_item', '51000000-0000-0000-0004-0000000000a2', 'delete', '{}');
select _stage('n-p2', 'nav_item', '51000000-0000-0000-0004-0000000000b2', 'delete', '{}');
select _stage('n-c2', 'nav_item', '51000000-0000-0000-0004-0000000000b1', 'delete', '{}');
set local role service_role;
select is(
  (select r ->> 'ok' from (select _pub('51000000-0000-0000-0000-0000000000a1', 'admin',
     array['n-p1', 'n-c1', 'n-p2', 'n-c2'], 'dry_run') r) s),
  'true', 'a dry run removing two links and their children, parent id first and child id first, is clean');
insert into _out (name, result)
select 'nav-tree', _pub('51000000-0000-0000-0000-0000000000a1', 'admin', array['n-p1', 'n-c1', 'n-p2', 'n-c2']);
reset role;
select is(
  (select format('%s %s',
     (select count(*) from public.navigation where location = 'footer'
         and tenant_id = '51000000-0000-0000-0000-00000000000a'),
     (select count(*) from public.content_release_items i, _out o
       where o.name = 'nav-tree' and i.release_id = (o.result ->> 'release_id')::uuid
         and i.entity_type = 'nav_item' and i.op = 'delete'))),
  '0 4', 'and the publish removes all four, each captured once');

-- ── 11. A case study's link sets ─────────────────────────────────────────────────────
select _stage('l-sets', 'portfolio', '51000000-0000-0000-0006-000000000001', 'update', '{"year":2026}',
              '{"service_ids":["51000000-0000-0000-0001-000000000001"],
                "media":[{"role":"gallery","kind":"image","media_id":"51000000-0000-0000-0007-000000000001"}]}');
set local role service_role;
insert into _out (name, result)
select 'links', _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['l-sets']);
reset role;
select is(
  (select format('%s %s',
     (select string_agg(service_id::text, ',') from public.portfolio_services where portfolio_id = '51000000-0000-0000-0006-000000000001'),
     (select string_agg(media_id::text, ',') from public.portfolio_media where portfolio_id = '51000000-0000-0000-0006-000000000001'))),
  '51000000-0000-0000-0001-000000000001 51000000-0000-0000-0007-000000000001',
  'the new link sets are applied');
select is(
  (select format('%s %s %s %s %s', i.op, i.draft_id = (r.item ->> 'draft_id')::uuid,
                 i.before -> 'service_ids', i.after -> 'service_ids', jsonb_array_length(i.after -> 'media'))
     from public.content_release_items i, _out o, _r4 r
    where o.name = 'links' and r.name = 'l-sets' and i.entity_type = 'portfolio_children'
      and i.release_id = (o.result ->> 'release_id')::uuid),
  'update t ["51000000-0000-0000-0001-000000000002"] ["51000000-0000-0000-0001-000000000001"] 1',
  'a synthetic portfolio_children item records the sets before and after');
select _stage('l-foreign', 'portfolio', '51000000-0000-0000-0006-000000000001', 'update', '{"year":2025}',
              '{"media":[{"role":"gallery","kind":"image","media_id":"51000000-0000-0000-0007-0000000000b1"}]}');
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['l-foreign']) $$),
  'BR422:refused:23503', 'another tenant''s media in a link set is refused');
reset role;
-- A change to the link sets alone, by someone who may not write case studies: refused, not
-- consumed with nothing done; and link sets that name no set are refused.
select _stage('l-empty', 'portfolio', '51000000-0000-0000-0006-000000000001', 'update', '{}', '{}');
select _stage('l-seo', 'portfolio', '51000000-0000-0000-0006-000000000001', 'update', '{}',
              '{"service_ids":[]}');
update _r4 set item = item || jsonb_build_object('draft_id', (select item ->> 'draft_id' from _r4 where name = 'l-seo'))
 where name = 'l-empty';
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000e1', 'seo', array['l-seo']) $$)
          || ' ' || _fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['l-empty']) $$),
  'BR422:refused:42501 22023',
  'seo CANNOT change a case study''s links alone; link sets that name no set are refused');
reset role;
select is((select count(*)::int from public.portfolio_services where portfolio_id = '51000000-0000-0000-0006-000000000001'),
  1, 'and the links are as they were');
delete from public.content_drafts where id in (select (item ->> 'draft_id')::uuid from _r4 where name in ('l-foreign', 'l-seo', 'l-empty'));

-- ── 12. The dry run ──────────────────────────────────────────────────────────────────
select _stage('v-ok', 'nav_item', '51000000-0000-0000-0004-000000000002', 'update', '{"label":{"en":"Why","ar":"لماذا"}}');
select _stage('v-bad1', 'service', '51000000-0000-0000-0001-000000000005', 'update', '{"slug":"r4-svc-1"}');
select _stage('v-bad2', 'service', '51000000-0000-0000-0001-000000000001', 'update', '{"status":"archived"}');
create table _dry_before as
  select (select max(number) from public.content_releases where tenant_id = '51000000-0000-0000-0000-00000000000a') as top,
         (select count(*) from public.content_releases where tenant_id = '51000000-0000-0000-0000-00000000000a') as releases;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role","note":"before the dry run"}', true);
insert into _out (name, result)
select 'dry', _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['v-ok', 'v-bad1', 'v-bad2'], 'dry_run');
select is(current_user::text || ' ' || current_setting('request.jwt.claims', true) || ' ['
          || coalesce(current_setting('app.release_apply', true), '') || ']',
  'service_role {"role":"service_role","note":"before the dry run"} []',
  'after a dry run: the same role, the same claims, no release token');
reset role;
select is(
  (select format('%s %s %s', o.result ->> 'ok', o.result -> 'conflicts',
                 (select string_agg(e ->> 'draftId', ',' order by e ->> 'draftId') from jsonb_array_elements(o.result -> 'errors') e)
                 = (select string_agg(item ->> 'draft_id', ',' order by item ->> 'draft_id') from _r4 where name in ('v-bad1', 'v-bad2')))
     from _out o where o.name = 'dry'),
  'false [] t',
  'the dry run reports both refused changes, each by its draft');
select is(
  (select format('%s %s %s',
     (select count(*) from public.content_releases where tenant_id = '51000000-0000-0000-0000-00000000000a') = b.releases,
     (select label ->> 'en' from public.navigation where id = '51000000-0000-0000-0004-000000000002'),
     (select count(*) from public.content_drafts d, _r4 r
       where r.name in ('v-ok', 'v-bad1', 'v-bad2') and d.id = (r.item ->> 'draft_id')::uuid))
     from _dry_before b),
  't Y 3',
  'and keeps nothing: no release, no live change, the drafts intact');
select is(app.release_token_valid(), false, 'no release token is left after a dry run');
set local role service_role;
insert into _out (name, result)
select 'after-dry', _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['v-ok']);
reset role;
select is((select (o.result ->> 'number')::int = b.top + 1 from _out o, _dry_before b where o.name = 'after-dry'),
  true, 'the next publish takes the next number: a dry run uses none');
-- A conflict in a dry run comes with the live and base values, for "Compare".
update public.services set sort_order = 42 where id = '51000000-0000-0000-0001-000000000001';
update public.content_drafts set base = '{"sort_order":41}', base_version = 1
 where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'v-bad2');
update _r4 set item = jsonb_set(item, '{patch}', '{"sort_order":43}') || '{"base":{"sort_order":41}}' where name = 'v-bad2';
select _sync('v-bad2');
set local role service_role;
select is(
  (select (r -> 'conflicts' -> 0) - 'draftId'
     from (select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['v-bad2'], 'dry_run') r) s),
  '{"base": {"sort_order": 41}, "live": {"sort_order": 42}, "columns": ["sort_order"]}'::jsonb,
  'a dry run reports a conflict with the live and the base values');
reset role;

-- ── 13. What is not captured ─────────────────────────────────────────────────────────
create table _n as select count(*) as items from public.content_release_items;
grant select on _n to service_role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '51000000-0000-0000-0000-0000000000c1',
  'app_metadata', json_build_object('role', 'content_creator', 'tenant_id', '51000000-0000-0000-0000-00000000000a'))::text, true);
update public.services set sort_order = 5 where id = '51000000-0000-0000-0001-000000000005';
reset role;
select is((select count(*) from public.content_release_items) - (select items from _n), 0::bigint,
  'a staff write outside a release records no item');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Upper-case ids are the same ids: one draft listed in both spellings is listed twice, and
-- a change named in upper case is captured under its draft.
select _stage('u-lower', 'service', '51000000-0000-0000-0001-000000000005', 'update', '{"sort_order":6}');
insert into _r4 (name, item)
select 'u-upper', item || jsonb_build_object('draft_id', upper(item ->> 'draft_id'),
                                             'entity_id', upper(item ->> 'entity_id'))
  from _r4 where name = 'u-lower';
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['u-lower', 'u-upper']) $$),
  '22023', 'one draft named in two spellings is a change listed twice');
insert into _out (name, result)
select 'upper', _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['u-upper']);
reset role;
select is(
  (select format('%s %s', i.entity_id, i.draft_id = (r.item ->> 'draft_id')::uuid)
     from public.content_release_items i, _out o, _r4 r
    where o.name = 'upper' and r.name = 'u-lower' and i.release_id = (o.result ->> 'release_id')::uuid),
  '51000000-0000-0000-0001-000000000005 t',
  'a change named in upper case is applied and captured under its draft');

-- Busy is not refused: a lock wait past lock_timeout (stood in for by a trigger raising its
-- SQLSTATE) leaves the apply as it is, in both modes, for the caller to retry.
create function _busy() returns trigger language plpgsql as $$
begin
  raise exception 'pgTAP stand-in for a lock wait past lock_timeout' using errcode = '55P03';
end $$;
create trigger r4_busy before update on public.services
  for each row when (new.sort_order = 777) execute function _busy();
select _stage('b-busy', 'service', '51000000-0000-0000-0001-000000000005', 'update', '{"sort_order":777}');
set local role service_role;
select is(_fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['b-busy']) $$)
          || ' ' || _fails($$ select _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['b-busy'], 'dry_run') $$),
  '55P03 55P03', 'a lock timeout passes through unchanged (publish and dry run), never as BR422');
reset role;
drop trigger r4_busy on public.services;
delete from public.content_drafts where id = (select (item ->> 'draft_id')::uuid from _r4 where name = 'b-busy');

select _stage('t-bio', 'team_member', '51000000-0000-0000-0009-000000000001', 'update', '{"bio":{"en":"Bio","ar":"نبذة"}}');
set local role service_role;
insert into _out (name, result)
select 'team', _pub('51000000-0000-0000-0000-0000000000c1', 'content_creator', array['t-bio']);
reset role;
select is(
  (select format('%s %s %s',
     (select bio ->> 'en' from public.team_members where id = '51000000-0000-0000-0009-000000000001'),
     (select count(*) from public.content_release_items i where i.release_id = (o.result ->> 'release_id')::uuid),
     (o.result -> 'items' -> 0) - 'draft_id')
     from _out o where o.name = 'team'),
  'Bio 0 {"op": "update", "entity_id": "51000000-0000-0000-0009-000000000001", "entity_type": "team_member"}',
  'a team-member change is applied, captured by nothing (O-12), and returned as a minimal item');

-- ── 14. record_release_purge ─────────────────────────────────────────────────────────
set local role authenticated;
select throws_ok(
  $$ select public.record_release_purge('51000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'done', null) $$,
  '42501', 'permission denied for function record_release_purge', 'authenticated CANNOT record a purge');
reset role;
set local role service_role;
select lives_ok(
  $$ select public.record_release_purge('51000000-0000-0000-0000-00000000000a',
       (select (result ->> 'release_id')::uuid from _out where name = 'first'), 'done',
       array['service:r4-svc-1', 'tenant:default', 'service:r4-svc-1'], null, '{"kvSynced":true}') $$,
  'the service role records a purge');
select is(_fails($$ select public.record_release_purge('51000000-0000-0000-0000-00000000000a',
       (select (result ->> 'release_id')::uuid from _out where name = 'first'), 'sent', null) $$),
  '22023', 'an unknown purge status is refused');
select is(_fails($$ select public.record_release_purge('51000000-0000-0000-0000-00000000000a',
       (select (result ->> 'release_id')::uuid from _out where name = 'first'), 'done', array['Bad Tag']) $$),
  '22023', 'a malformed tag is refused');
select lives_ok(
  $$ select public.record_release_purge('51000000-0000-0000-0000-00000000000a',
       (select (result ->> 'release_id')::uuid from _out where name = 'first'), 'not_needed', null) $$,
  'not_needed is recorded');
select is(_fails($$ select public.record_release_purge('51000000-0000-0000-0000-00000000000b',
       (select (result ->> 'release_id')::uuid from _out where name = 'first'), 'done', null) $$),
  'P0002', 'another tenant''s release is not found');
reset role;
select is(
  (select format('%s %s %s %s %s', r.purge_status, r.purge_attempts, r.purged_at is not null, r.tags, r.side_effects)
     from public.content_releases r, _out o
    where o.name = 'first' and r.id = (o.result ->> 'release_id')::uuid),
  'not_needed 1 t {service:r4-svc-1,tenant:default} {"kvSynced": true}',
  'attempts count every outcome but not_needed; tags kept once each; side effects merged');

select * from finish();
rollback;
