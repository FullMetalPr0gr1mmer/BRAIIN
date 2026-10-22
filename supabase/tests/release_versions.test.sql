-- pgTAP: numbered versions (migration 0104, Admin v2 R10). Run with `supabase test db`.
--
--   • the catalog: content_versions.seq NOT NULL and unique per entity; one trigger on the
--     table, the numbering, a definer no API role calls; public.release_as_of an invoker
--     executable by authenticated alone;
--   • the numbering on every path: a direct insert as the migration role (a number it sends is
--     ignored), a staff edit through the snapshot trigger, a writer that sends its version
--     back (the snapshot keeps that version, the number still moves on), two entities and two
--     tenants numbered apart, an UPDATE that keeps the number, and the unique index as the
--     backstop when the trigger is switched off;
--   • releases off (every tenant until R14): a staff save behaves as before, its history row
--     only gains its number;
--   • release_as_of over a ledger of three versions with a system item, a removal, link sets,
--     a page and its section, and a team member (never answered): the state at v1, v2 and v3,
--     the page scope (a section moved onto the page since included), the limit; refusals
--     (another tenant, a bad number or limit, no such version); per role: admin, content_creator, seo and developer read it, a sales claim
--     and another tenant's admin read no version, anon cannot call it;
--   • the draft lock (restated): the restore's mark by the service role sets the provenance
--     and keeps the change's author; a staff caller is stamped as before.
-- CLAUDE.md §3 (Pillar 4), §8 (versioning; Admin v2 lanes, Releases), §9.

begin;
select plan(54);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────
insert into public.tenants (id, name) values
  ('10400000-0000-0000-0000-00000000000a', 'R10A'),
  ('10400000-0000-0000-0000-00000000000b', 'R10B');

insert into auth.users (id, email) values
  ('10400000-0000-0000-0000-0000000000a1', 'r10-admin@example.test'),
  ('10400000-0000-0000-0000-0000000000c1', 'r10-creator@example.test'),
  ('10400000-0000-0000-0000-0000000000e1', 'r10-seo@example.test'),
  ('10400000-0000-0000-0000-0000000000d1', 'r10-developer@example.test'),
  ('10400000-0000-0000-0000-0000000000f1', 'r10-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, display_name) values
  ('10400000-0000-0000-0000-0000000000a1', '10400000-0000-0000-0000-00000000000a', 'admin', true, 'Amal'),
  ('10400000-0000-0000-0000-0000000000c1', '10400000-0000-0000-0000-00000000000a', 'content_creator', true, 'Cyrus'),
  ('10400000-0000-0000-0000-0000000000e1', '10400000-0000-0000-0000-00000000000a', 'seo', true, 'Eli'),
  ('10400000-0000-0000-0000-0000000000d1', '10400000-0000-0000-0000-00000000000a', 'developer', true, 'Dana'),
  ('10400000-0000-0000-0000-0000000000f1', '10400000-0000-0000-0000-00000000000b', 'admin', true, 'Faris');

insert into public.services (id, tenant_id, slug, title, status) values
  ('10400000-0000-0000-0001-000000000001', '10400000-0000-0000-0000-00000000000a', 'r10-svc',
   '{"en":"One","ar":"واحد"}', 'published');

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
  select _as(p_sub, p_role, '10400000-0000-0000-0000-00000000000a')
$$;

-- The outcome of a statement: 'ok', or its SQLSTATE.
create function _catch(p_sql text) returns text language plpgsql as $f$
declare
  v_state text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $f$;

-- An entity's numbers in tenant A, in order (created as the setup role: staff cannot create
-- functions).
create function _seqs(p_type text, p_id text) returns text language sql as $$
  select string_agg(seq::text, ',' order by seq) from public.content_versions
   where tenant_id = '10400000-0000-0000-0000-00000000000a'
     and entity_type = p_type and entity_id = p_id::uuid
$$;
-- The state at version N for tenant A, as the current role.
create function _as_of(p_number int, p_limit int default 200, p_page text default null)
  returns jsonb language sql as $$
  select public.release_as_of('10400000-0000-0000-0000-00000000000a', p_number, p_limit,
                              p_page::uuid)
$$;
-- One entity of an as-of answer, by its id.
create function _entity(p_state jsonb, p_id text) returns jsonb language sql as $$
  select e from jsonb_array_elements(p_state -> 'entities') e where e ->> 'entity_id' = p_id
$$;

-- ── 1. The catalog ─────────────────────────────────────────────────────────────────
select ok((select attnotnull from pg_attribute
            where attrelid = 'public.content_versions'::regclass and attname = 'seq'),
  'content_versions.seq is NOT NULL');
select ok(exists (select 1 from pg_index x join pg_class i on i.oid = x.indexrelid
                   where x.indrelid = 'public.content_versions'::regclass and x.indisunique
                     and i.relname = 'content_versions_entity_seq_key'),
  'one number per entity: a unique index on (tenant_id, entity_type, entity_id, seq)');
select is(
  (select string_agg(tg.tgname || ' ' || tg.tgtype, ', ') from pg_trigger tg
    where tg.tgrelid = 'public.content_versions'::regclass and not tg.tgisinternal),
  'content_versions_seq 23',
  'the numbering is the one trigger on content_versions (BEFORE INSERT OR UPDATE, per row)');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc
            where oid = 'app.tg_content_version_seq()'::regprocedure),
  'the numbering is a definer with an empty search path');
select ok(not has_function_privilege('authenticated', 'app.tg_content_version_seq()', 'execute')
          and not has_function_privilege('anon', 'app.tg_content_version_seq()', 'execute')
          and not has_function_privilege('service_role', 'app.tg_content_version_seq()', 'execute'),
  'no API role may call the numbering');
select ok((select not prosecdef and provolatile = 's' from pg_proc
            where oid = 'public.release_as_of(uuid, int, int, uuid)'::regprocedure),
  'release_as_of is a STABLE invoker: the ledger''s RLS decides');
select ok(has_function_privilege('authenticated', 'public.release_as_of(uuid, int, int, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.release_as_of(uuid, int, int, uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.release_as_of(uuid, int, int, uuid)', 'execute'),
  'release_as_of: authenticated only');

-- ── 2. The numbering ───────────────────────────────────────────────────────────────
-- The seeded service's own first snapshot (its insert above) is number 1.
select is(_seqs('service', '10400000-0000-0000-0001-000000000001'), '1',
  'a new row''s first snapshot is number 1');

-- Direct inserts as the migration role: numbered in order, a number sent is ignored.
insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot)
values ('10400000-0000-0000-0000-00000000000a', 'statistic', '10400000-0000-0000-0002-000000000001', 7, '{}');
insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot, seq)
values ('10400000-0000-0000-0000-00000000000a', 'statistic', '10400000-0000-0000-0002-000000000001', 7, '{}', 99);
insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot, seq)
values ('10400000-0000-0000-0000-00000000000a', 'statistic', '10400000-0000-0000-0002-000000000001', 1, '{}', 1);
select is(_seqs('statistic', '10400000-0000-0000-0002-000000000001'), '1,2,3',
  'direct inserts are numbered 1, 2, 3 whatever number or version they send');
-- Another entity and another tenant start from 1.
insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot)
values ('10400000-0000-0000-0000-00000000000a', 'statistic', '10400000-0000-0000-0002-000000000002', 1, '{}'),
       ('10400000-0000-0000-0000-00000000000b', 'statistic', '10400000-0000-0000-0002-000000000001', 1, '{}');
select is(
  (select string_agg(tenant_id::text || '/' || entity_id::text || '=' || seq, ',' order by tenant_id, entity_id, seq)
     from public.content_versions
    where entity_type = 'statistic' and (entity_id = '10400000-0000-0000-0002-000000000002'
                                         or tenant_id = '10400000-0000-0000-0000-00000000000b')),
  '10400000-0000-0000-0000-00000000000a/10400000-0000-0000-0002-000000000002=1,'
  '10400000-0000-0000-0000-00000000000b/10400000-0000-0000-0002-000000000001=1',
  'each entity, and each tenant, numbers its own history');
-- An UPDATE keeps the number.
update public.content_versions set seq = 42
 where entity_type = 'statistic' and entity_id = '10400000-0000-0000-0002-000000000001'
   and tenant_id = '10400000-0000-0000-0000-00000000000a' and seq = 3;
select is(_seqs('statistic', '10400000-0000-0000-0002-000000000001'), '1,2,3',
  'a number is never rewritten (an UPDATE keeps it)');
-- The unique index stands without the trigger.
alter table public.content_versions disable trigger content_versions_seq;
select is(_catch($$ insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot, seq)
                    values ('10400000-0000-0000-0000-00000000000a', 'statistic',
                            '10400000-0000-0000-0002-000000000001', 1, '{}', 2) $$),
  '23505', 'a number taken twice is refused by the index (the backstop)');
alter table public.content_versions enable trigger content_versions_seq;

-- ── 3. Releases off: a staff save behaves as before, its history numbered ──────────
set local role authenticated;
select _as_a('10400000-0000-0000-0000-0000000000c1', 'content_creator');
select is(_catch($$ update public.services set title = '{"en":"Two","ar":"اثنان"}'
                    where id = '10400000-0000-0000-0001-000000000001' $$),
  'ok', 'releases off: the content creator''s edit lands, as on main');
-- A writer that sends a version back (the optimistic-lock column): app.tg_bump_version keeps it.
select is(_catch($$ update public.services set title = '{"en":"Three","ar":"ثلاثة"}', version = 1
                    where id = '10400000-0000-0000-0001-000000000001' $$),
  'ok', 'releases off: an edit that sends version 1 back lands too');
reset role;
select is(
  (select title ->> 'en' || ' v' || version from public.services
    where id = '10400000-0000-0000-0001-000000000001'),
  'Three v1', 'the live row is exactly what the two saves wrote (the version as sent)');
select is(
  (select string_agg(seq || ':v' || version || ':' || coalesce(created_by::text, '-') || ':'
                     || coalesce(release_id::text, '-'), ',' order by seq)
     from public.content_versions
    where entity_type = 'service' and entity_id = '10400000-0000-0000-0001-000000000001'),
  '1:v1:-:-,2:v2:10400000-0000-0000-0000-0000000000c1:-,3:v1:10400000-0000-0000-0000-0000000000c1:-',
  'history: numbers 1, 2, 3 in order, the row''s own versions (1, 2, 1) kept beside them, the '
  'editor named, no release');

-- ── 4. The state at a version ──────────────────────────────────────────────────────
-- Three versions of tenant A, as the apply and the capture leave them (as the migration
-- role: items are written only by the capture, never by an API role). In ledger order:
--   v1  baseline, no item
--   v2  service S1 edited (A → B); page P and its section X created; team member T edited
--   --  a system item (out of band): S1 edited again (B → C)
--   v3  service S2 removed; project J's link sets emptied; section X edited
insert into public.content_releases (id, tenant_id, number, kind, status, published_at, published_by) values
  ('10400000-0000-0000-0003-000000000001', '10400000-0000-0000-0000-00000000000a', 1, 'baseline', 'published', now() - interval '3 days', '10400000-0000-0000-0000-0000000000a1'),
  ('10400000-0000-0000-0003-000000000002', '10400000-0000-0000-0000-00000000000a', 2, 'publish', 'published', now() - interval '2 days', '10400000-0000-0000-0000-0000000000a1'),
  ('10400000-0000-0000-0003-000000000003', '10400000-0000-0000-0000-00000000000a', 3, 'publish', 'published', now() - interval '1 day', '10400000-0000-0000-0000-0000000000c1');
-- Tenant B has a version 1 of its own.
insert into public.content_releases (id, tenant_id, number, kind, status, published_at) values
  ('10400000-0000-0000-0003-0000000000b1', '10400000-0000-0000-0000-00000000000b', 1, 'baseline', 'published', now());
insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after) values
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000002', 'service',
   '10400000-0000-0000-0004-000000000001', 'update', '{"title":{"en":"A"}}', '{"title":{"en":"B"}}'),
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000002', 'page',
   '10400000-0000-0000-0004-0000000000f1', 'create', null, '{"slug":"r10-page"}'),
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000002', 'page_section',
   '10400000-0000-0000-0004-0000000000e1', 'create', null,
   '{"page_id":"10400000-0000-0000-0004-0000000000f1","type":"text"}'),
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000002', 'team_member',
   '10400000-0000-0000-0004-0000000000d1', 'update', '{"name":"Old"}', '{"name":"New"}');
insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after) values
  ('10400000-0000-0000-0000-00000000000a', null, 'service',
   '10400000-0000-0000-0004-000000000001', 'update', '{"title":{"en":"B"}}', '{"title":{"en":"C"}}');
insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after) values
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000003', 'service',
   '10400000-0000-0000-0004-000000000002', 'delete', '{"slug":"gone"}', null),
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000003', 'portfolio_children',
   '10400000-0000-0000-0004-0000000000c1', 'update',
   '{"service_ids":["10400000-0000-0000-0004-000000000002"],"media":[]}',
   '{"service_ids":[],"media":[]}'),
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000003', 'page_section',
   '10400000-0000-0000-0004-0000000000e1', 'update',
   '{"page_id":"10400000-0000-0000-0004-0000000000f1","type":"text","visible":true}',
   '{"page_id":"10400000-0000-0000-0004-0000000000f1","type":"text","visible":false}');
-- Tenant B's ledger: nothing of A's is ever answered for it.
insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after) values
  ('10400000-0000-0000-0000-00000000000b', null, 'service',
   '10400000-0000-0000-0004-0000000000b1', 'update', '{"title":{"en":"Theirs"}}', '{"title":{"en":"Theirs 2"}}');

set local role authenticated;
select _as_a('10400000-0000-0000-0000-0000000000a1', 'admin');
select is((_as_of(1) ->> 'total')::int, 5,
  'at v1: five entities touched since (two services, the page, its section, the project); no team member');
select is((_as_of(1) #>> '{release,number}')::int, 1, 'the answer names the version');
select is(_entity(_as_of(1), '10400000-0000-0000-0004-000000000001') #>> '{before,title,en}', 'A',
  'at v1: S1 is its earliest before-image since v1 (A)');
select is((_entity(_as_of(1), '10400000-0000-0000-0004-000000000001') ->> 'exists_now')::boolean, true,
  'and it still exists');
select ok((_entity(_as_of(1), '10400000-0000-0000-0004-0000000000f1') -> 'before') = 'null'::jsonb,
  'at v1: the page did not exist (a null before)');
select is(_entity(_as_of(1), '10400000-0000-0000-0004-0000000000e1') ->> 'page_id',
  '10400000-0000-0000-0004-0000000000f1', 'a section created since names its page');
select is((_entity(_as_of(1), '10400000-0000-0000-0004-000000000002') ->> 'exists_now')::boolean, false,
  'at v1: S2 existed (its before) and is gone now');
select is(_entity(_as_of(1), '10400000-0000-0000-0004-0000000000c1') ->> 'entity_type', 'portfolio_children',
  'the project''s link sets are answered as portfolio_children');
select is(_entity(_as_of(1), '10400000-0000-0000-0004-0000000000d1'), null,
  'a team member is never answered (never captured, O-12)');
select is(_entity(_as_of(2), '10400000-0000-0000-0004-000000000001') #>> '{before,title,en}', 'B',
  'at v2: S1''s state is the system item''s before (B): out-of-band writes count');
select is((_as_of(2) ->> 'total')::int, 4, 'at v2: four entities touched since');
select is(_entity(_as_of(2), '10400000-0000-0000-0004-0000000000e1') #>> '{before,visible}', 'true',
  'at v2: the section''s state is v3''s before-image');
select is((_as_of(3) ->> 'total')::int, 0, 'at v3, the latest version: nothing has changed since');
select is((_as_of(1, 200, '10400000-0000-0000-0004-0000000000f1') ->> 'total')::int, 2,
  'scoped to the page: the page and its section only');
select is(jsonb_array_length(_as_of(1, 2) -> 'entities'), 2, 'the limit caps the entities');
select is((_as_of(1, 2) ->> 'total')::int, 5, 'and the total still counts them all');
select is(_entity(_as_of(1), '10400000-0000-0000-0004-0000000000b1'), null,
  'another tenant''s ledger is never answered');

-- Refusals.
select is(_catch($$ select _as_of(9) $$), 'P0002', 'no such version: P0002');
select is(_catch($$ select _as_of(0) $$), '22023', 'a version number below 1: 22023');
select is(_catch($$ select _as_of(1, 0) $$), '22023', 'a limit of 0: 22023');
select is(_catch($$ select _as_of(1, 2001) $$), '22023', 'a limit above 2000: 22023');
select is(_catch($$ select public.release_as_of('10400000-0000-0000-0000-00000000000b', 1) $$), '42501',
  'another tenant named: 42501');

-- Per role.
select _as_a('10400000-0000-0000-0000-0000000000c1', 'content_creator');
select is((_as_of(1) ->> 'total')::int, 5, 'the content creator reads the state at v1');
select _as_a('10400000-0000-0000-0000-0000000000e1', 'seo');
select is((_as_of(1) ->> 'total')::int, 5, 'SEO reads it');
select _as_a('10400000-0000-0000-0000-0000000000d1', 'developer');
select is((_as_of(1) ->> 'total')::int, 5, 'the developer reads it (the Worker filters by area)');
select _as_a('10400000-0000-0000-0000-0000000000c1', 'sales');
select is(_catch($$ select _as_of(1) $$), 'P0002', 'a sales claim reads no version (the ledger is CMS staff''s)');
select _as('10400000-0000-0000-0000-0000000000f1', 'admin', '10400000-0000-0000-0000-00000000000b');
select is(_catch($$ select _as_of(1) $$), '42501', 'another tenant''s admin cannot name tenant A');
select is((public.release_as_of('10400000-0000-0000-0000-00000000000b', 1) ->> 'total')::int, 1,
  'and reads only its own tenant''s ledger');
reset role;
set local role anon;
select _as(null, null, null);
select is(_catch($$ select public.release_as_of('10400000-0000-0000-0000-00000000000a', 1) $$), '42501',
  'anon cannot call it');
reset role;

-- ── 5. Nothing was written by reading ──────────────────────────────────────────────
select is((select count(*)::int from public.content_drafts
            where tenant_id = '10400000-0000-0000-0000-00000000000a'), 0,
  'reading a version stages nothing');
select ok(not exists (select 1 from app.release_tenants),
  'releases stay off for every tenant');
select is(
  (select count(*)::int from public.content_release_items
    where tenant_id = '10400000-0000-0000-0000-00000000000a'),
  8, 'and the ledger is as written (eight items)');

-- ── 5b. A page's restore follows a section moved onto it since ─────────────────────
-- v4 moves section Y from page Q (where it was at v3) onto page P (F1): restoring P to v3
-- takes Y too (it is on P now), and sends it back to Q (its image at v3).
insert into public.content_releases (id, tenant_id, number, kind, status, published_at, published_by) values
  ('10400000-0000-0000-0003-000000000004', '10400000-0000-0000-0000-00000000000a', 4, 'publish', 'published', now(), '10400000-0000-0000-0000-0000000000a1');
insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after) values
  ('10400000-0000-0000-0000-00000000000a', '10400000-0000-0000-0003-000000000004', 'page_section',
   '10400000-0000-0000-0004-0000000000e2', 'update',
   '{"page_id":"10400000-0000-0000-0004-0000000000f2","type":"text"}',
   '{"page_id":"10400000-0000-0000-0004-0000000000f1","type":"text"}');
set local role authenticated;
select _as_a('10400000-0000-0000-0000-0000000000a1', 'admin');
select is(
  _entity(_as_of(3, 200, '10400000-0000-0000-0004-0000000000f1'), '10400000-0000-0000-0004-0000000000e2')
    #>> '{before,page_id}',
  '10400000-0000-0000-0004-0000000000f2',
  'restoring a page: a section moved onto it since is in its scope, as it was (on its old page)');
select is((_as_of(3, 200, '10400000-0000-0000-0004-0000000000f2') ->> 'total')::int, 1,
  'and in the scope of the page it was on at that version');
reset role;

-- ── 6. The restore's mark keeps the change's author (0104's draft lock) ────────────
-- A change the content creator staged (written as the migration role naming them: no role
-- claim, so the lock does not bind, and the insert names its user).
select set_config('request.jwt.claims', '{"sub":"10400000-0000-0000-0000-0000000000c1"}', true);
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload)
values ('10400000-0000-0000-0005-000000000001', '10400000-0000-0000-0000-00000000000a', 'service',
        '10400000-0000-0000-0001-000000000001', 'update', '{"title":{"en":"Back","ar":"عودة"}}');
select is(
  (select format('%s v%s %s', updated_by, version, coalesce(origin_kind, '-'))
     from public.content_drafts where id = '10400000-0000-0000-0005-000000000001'),
  '10400000-0000-0000-0000-0000000000c1 v1 -', 'a staged change names the person who staged it');
-- The restore's mark: the service role with its own key's claims (no user, no role claim).
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.content_drafts
   set origin_kind = 'restore', origin_release_id = '10400000-0000-0000-0003-000000000002'
 where id = '10400000-0000-0000-0005-000000000001';
reset role;
select is(
  (select format('%s %s %s v%s', origin_kind, origin_release_id, updated_by, version)
     from public.content_drafts where id = '10400000-0000-0000-0005-000000000001'),
  'restore 10400000-0000-0000-0003-000000000002 10400000-0000-0000-0000-0000000000c1 v2',
  'the service role''s mark sets the provenance and keeps the author (it names no user)');
-- A staff caller (a role claim: the lock binds it) is stamped as before and cannot clear the
-- provenance.
select _as_a('10400000-0000-0000-0000-0000000000a1', 'admin');
update public.content_drafts
   set payload = '{"title":{"en":"Edited","ar":"معدل"}}', origin_kind = null, origin_release_id = null
 where id = '10400000-0000-0000-0005-000000000001';
select is(
  (select format('%s %s v%s', origin_kind, updated_by, version)
     from public.content_drafts where id = '10400000-0000-0000-0005-000000000001'),
  'restore 10400000-0000-0000-0000-0000000000a1 v3',
  'a staff edit names its editor, as before, and keeps the restore''s provenance');
-- An unbound write that names a user is stamped with them (the runbook, a seed).
select set_config('request.jwt.claims', '{"sub":"10400000-0000-0000-0000-0000000000d1"}', true);
update public.content_drafts set payload = '{}' where id = '10400000-0000-0000-0005-000000000001';
select is(
  (select updated_by::text from public.content_drafts
    where id = '10400000-0000-0000-0005-000000000001'),
  '10400000-0000-0000-0000-0000000000d1', 'an unbound write that names a user is stamped with them');

select * from finish();
rollback;
