-- pgTAP: complete capture (migration 0066, Admin v2 R5).
--
-- What the guard (release_guard.test.sql) lets through is recorded, so a restore (R10) sees
-- every change since a version:
--   • outside a release, a write to a registry table of a tenant with releases on is a
--     SYSTEM ITEM (content_release_items with no release and no draft): the migration role
--     with no claims (the runbook, a cron) and the service role alike; nothing is recorded
--     for a tenant with releases off, for a save that changes only the version and the
--     stamp, for an immediate column, or for team_members (owner item O-12);
--   • inside a release, items carry the release, never a system item;
--   • a case study's link sets (portfolio_services, portfolio_media) are recorded as ONE
--     `portfolio_children` item per case study per statement, with the sets before the
--     statement's first change and after its last, cascades included: a project removed
--     (both sets in one item), a service removed from two projects (one item each), one
--     statement removing two services of one project (one item holding both), a direct
--     write out of band; the apply's own link-set step keeps R4's synthetic item alone;
--   • staff read system items like release items; a sales claim, anon and another tenant
--     read none.
-- Releases are switched on for tenant A inside this rolled-back transaction only.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.

begin;
select plan(30);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────────
insert into app.deployment (env) values ('staging')
  on conflict (singleton) do update set env = excluded.env;
insert into public.tenants (id, name) values
  ('66100000-0000-0000-0000-00000000000a', 'CaptureA'),
  ('66100000-0000-0000-0000-00000000000b', 'CaptureB');
insert into auth.users (id, email) values
  ('66100000-0000-0000-0000-0000000000a1', 'r5c-admin@example.test'),
  ('66100000-0000-0000-0000-0000000000c1', 'r5c-creator@example.test'),
  ('66100000-0000-0000-0000-0000000000e1', 'r5c-seo@example.test'),
  ('66100000-0000-0000-0000-0000000000d1', 'r5c-developer@example.test'),
  ('66100000-0000-0000-0000-0000000000b1', 'r5c-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active) values
  ('66100000-0000-0000-0000-0000000000a1', '66100000-0000-0000-0000-00000000000a', 'admin', true),
  ('66100000-0000-0000-0000-0000000000c1', '66100000-0000-0000-0000-00000000000a', 'content_creator', true),
  ('66100000-0000-0000-0000-0000000000e1', '66100000-0000-0000-0000-00000000000a', 'seo', true),
  ('66100000-0000-0000-0000-0000000000d1', '66100000-0000-0000-0000-00000000000a', 'developer', true),
  ('66100000-0000-0000-0000-0000000000b1', '66100000-0000-0000-0000-00000000000b', 'admin', true);

insert into public.services (id, tenant_id, slug, title, status) values
  ('66100000-0000-0000-0001-000000000001', '66100000-0000-0000-0000-00000000000a', 'r5c-s1', '{"en":"S1","ar":"خ١"}', 'published'),
  ('66100000-0000-0000-0001-000000000002', '66100000-0000-0000-0000-00000000000a', 'r5c-s2', '{"en":"S2","ar":"خ٢"}', 'published'),
  ('66100000-0000-0000-0001-000000000003', '66100000-0000-0000-0000-00000000000a', 'r5c-s3', '{"en":"S3","ar":"خ٣"}', 'published'),
  ('66100000-0000-0000-0001-000000000004', '66100000-0000-0000-0000-00000000000a', 'r5c-s4', '{"en":"S4","ar":"خ٤"}', 'published'),
  ('66100000-0000-0000-0001-000000000005', '66100000-0000-0000-0000-00000000000a', 'r5c-s5', '{"en":"S5","ar":"خ٥"}', 'published'),
  ('66100000-0000-0000-0001-0000000000b1', '66100000-0000-0000-0000-00000000000b', 'r5c-sb', '{"en":"SB","ar":"خب"}', 'published');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('66100000-0000-0000-0007-000000000001', '66100000-0000-0000-0000-00000000000a', 'image', 'static', 'stills/work/p0.jpg'),
  ('66100000-0000-0000-0007-000000000002', '66100000-0000-0000-0000-00000000000a', 'image', 'static', 'stills/work/p1.jpg'),
  ('66100000-0000-0000-0007-000000000003', '66100000-0000-0000-0000-00000000000a', 'image', 'static', 'stills/work/p2.jpg'),
  ('66100000-0000-0000-0007-0000000000b1', '66100000-0000-0000-0000-00000000000b', 'image', 'static', 'stills/work/p3.jpg');
-- P1: removed in a release (C6). P2 and P3 share S3 (C7). P4 links S4 and S5 (C8). P5: the
-- apply's own link-set step (C9). P6: out-of-band media (C10). PB: tenant B.
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('66100000-0000-0000-0006-000000000001', '66100000-0000-0000-0000-00000000000a', 'r5c-p1', '{"en":"P1","ar":"م١"}', 'draft'),
  ('66100000-0000-0000-0006-000000000002', '66100000-0000-0000-0000-00000000000a', 'r5c-p2', '{"en":"P2","ar":"م٢"}', 'draft'),
  ('66100000-0000-0000-0006-000000000003', '66100000-0000-0000-0000-00000000000a', 'r5c-p3', '{"en":"P3","ar":"م٣"}', 'draft'),
  ('66100000-0000-0000-0006-000000000004', '66100000-0000-0000-0000-00000000000a', 'r5c-p4', '{"en":"P4","ar":"م٤"}', 'draft'),
  ('66100000-0000-0000-0006-000000000005', '66100000-0000-0000-0000-00000000000a', 'r5c-p5', '{"en":"P5","ar":"م٥"}', 'draft'),
  ('66100000-0000-0000-0006-000000000006', '66100000-0000-0000-0000-00000000000a', 'r5c-p6', '{"en":"P6","ar":"م٦"}', 'draft'),
  ('66100000-0000-0000-0006-0000000000b1', '66100000-0000-0000-0000-00000000000b', 'r5c-pb', '{"en":"PB","ar":"مب"}', 'draft');
insert into public.portfolio_services (tenant_id, portfolio_id, service_id, sort_order) values
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000001', '66100000-0000-0000-0001-000000000001', 0),
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000002', '66100000-0000-0000-0001-000000000003', 0),
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000003', '66100000-0000-0000-0001-000000000003', 0),
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000004', '66100000-0000-0000-0001-000000000004', 0),
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000004', '66100000-0000-0000-0001-000000000005', 1),
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000005', '66100000-0000-0000-0001-000000000002', 0);
insert into public.portfolio_media (id, tenant_id, portfolio_id, role, kind, media_id, sort_order) values
  ('66100000-0000-0000-0008-000000000001', '66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000001',
   'gallery', 'image', '66100000-0000-0000-0007-000000000001', 0),
  ('66100000-0000-0000-0008-000000000002', '66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000001',
   'gallery', 'image', '66100000-0000-0000-0007-000000000002', 1);
insert into public.team_members (id, tenant_id, slug, name) values
  ('66100000-0000-0000-0009-000000000001', '66100000-0000-0000-0000-00000000000a', 'r5c-ada', '{"en":"Ada","ar":"آدا"}');
insert into public.site_profile (tenant_id, brand_name, contact_email, location) values
  ('66100000-0000-0000-0000-00000000000a', '{"en":"Studio","ar":"استوديو"}', 'hello@example.com',
   '{"en":"Riyadh","ar":"الرياض"}');
insert into public.content_releases (id, tenant_id, status) values
  ('66100000-0000-0000-000d-000000000001', '66100000-0000-0000-0000-00000000000a', 'applying');

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
  select _as(p_sub, p_role, '66100000-0000-0000-0000-00000000000a')
$$;
-- Items recorded after a mark, as the migration role reads them.
create table _mark (n bigint);
create function _mark() returns void language sql as $$
  delete from _mark;
  insert into _mark select coalesce(max(id), 0) from public.content_release_items;
$$;
create function _since() returns setof public.content_release_items language sql as $$
  select * from public.content_release_items where id > (select n from _mark) order by id
$$;
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
-- The release token of THIS transaction, as apply_release sets it (the migration role sets
-- it here; no exposed function can).
create function _token(p_on boolean) returns void language sql as $$
  select set_config('app.release_id', case when p_on then '66100000-0000-0000-000d-000000000001' else '' end, true);
  select set_config('app.release_apply', case when p_on then pg_current_xact_id()::text else '' end, true);
$$;

-- ── 1. Releases off: nothing is recorded out of band ─────────────────────────────────
select _mark();
update public.services set blurb = '{"en":"B","ar":"ب"}' where id = '66100000-0000-0000-0001-0000000000b1';
insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id)
values ('66100000-0000-0000-0000-00000000000b', '66100000-0000-0000-0006-0000000000b1', 'gallery', 'image',
        '66100000-0000-0000-0007-0000000000b1');
update public.services set blurb = '{"en":"A","ar":"أ"}' where id = '66100000-0000-0000-0001-000000000002';
select is((select count(*)::int from _since()), 0,
  'releases off (tenant A before switch-on, tenant B): no item for a claimless write or a link write');

insert into app.release_tenants (tenant_id) values ('66100000-0000-0000-0000-00000000000a');

-- ── 2. System items ──────────────────────────────────────────────────────────────────
select _mark();
update public.services set title = '{"en":"S2 edited","ar":"خ٢ معدل"}' where id = '66100000-0000-0000-0001-000000000002';
select is(
  (select format('%s %s %s %s %s %s %s %s', count(*), min(entity_type), min(op), bool_and(release_id is null),
                 bool_and(draft_id is null), bool_and(actor_id is null),
                 min(before -> 'title' ->> 'en') || '>' || min(after -> 'title' ->> 'en'),
                 bool_or(after ? 'search_en' or before ? 'search_en'))
     from _since()),
  '1 service update t t t S2>S2 edited f',
  'a claimless update in tenant A is one system item: no release, draft or actor; no generated columns');
select _mark();
insert into public.services (id, tenant_id, slug, title)
values ('66100000-0000-0000-0001-000000000009', '66100000-0000-0000-0000-00000000000a', 'r5c-s9', '{"en":"S9","ar":"خ٩"}');
delete from public.services where id = '66100000-0000-0000-0001-000000000009';
select is(
  (select string_agg(format('%s %s %s', op, before is null, after is null), ', ' order by id) from _since()),
  'create t f, delete f t',
  'a claimless insert and delete are system items too (create: no before; delete: no after)');
select _mark();
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.services set sort_order = 3 where id = '66100000-0000-0000-0001-000000000002';
reset role;
select _as(null, null, null);
select is(
  (select format('%s %s %s', count(*), bool_and(release_id is null), min(after ->> 'sort_order')) from _since()),
  '1 t 3', 'a service-role write (the Worker''s privileged client) is a system item');

-- ── 3. What is not recorded ──────────────────────────────────────────────────────────
select _mark();
update public.services set version = version + 1, updated_at = now() where id = '66100000-0000-0000-0001-000000000002';
select is((select count(*)::int from _since()), 0, 'a save that moves only the version and the stamp records nothing');
set local role authenticated;
select _a('66100000-0000-0000-0000-0000000000a1', 'admin');
update public.site_profile set accepting_applications = true where tenant_id = '66100000-0000-0000-0000-00000000000a';
reset role;
select _as(null, null, null);
update public.site_profile set accepting_applications = false where tenant_id = '66100000-0000-0000-0000-00000000000a';
select is((select count(*)::int from _since()), 0,
  'the immediate column (accepting_applications), by an admin or the runbook, records nothing');
update public.team_members set bio = '{"en":"Bio","ar":"نبذة"}' where id = '66100000-0000-0000-0009-000000000001';
select is((select count(*)::int from _since()), 0, 'a team member records nothing (owner item O-12)');
set local role authenticated;
select _a('66100000-0000-0000-0000-0000000000c1', 'content_creator');
select is(_try($$ insert into public.portfolio_services (tenant_id, portfolio_id, service_id)
                  values ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000006',
                          '66100000-0000-0000-0001-000000000002') $$),
  '42501: Live content changes only through a release.', 'a staff link write outside a release is refused');
reset role;
select _as(null, null, null);
select is((select count(*)::int from _since()) + (select count(*)::int from app.release_link_pending), 0,
  'and the refused write records nothing (no item, nothing kept pending)');

-- ── 4. Inside a release ──────────────────────────────────────────────────────────────
select _mark();
select _token(true);
set local role authenticated;
select _a('66100000-0000-0000-0000-0000000000c1', 'content_creator');
update public.services set blurb = '{"en":"In","ar":"في"}' where id = '66100000-0000-0000-0001-000000000002';
reset role;
select _as(null, null, null);
update public.services set sort_order = 8 where id = '66100000-0000-0000-0001-000000000002';
select is(
  (select string_agg(coalesce(release_id::text, 'system'), ', ' order by id) from _since()),
  '66100000-0000-0000-000d-000000000001, 66100000-0000-0000-000d-000000000001',
  'inside a release every item carries it (a staff write and a claimless one), never a system item');
select throws_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, after, draft_id)
     values ('66100000-0000-0000-0000-00000000000a', null, 'service', gen_random_uuid(), 'create', '{}', gen_random_uuid()) $$,
  '23514', 'new row for relation "content_release_items" violates check constraint "content_release_items_system_shape"',
  'a system item never names a draft (content_release_items_system_shape)');

-- ── 5. Link sets, cascades inside a release ──────────────────────────────────────────
-- C6: a project removed. Both of its sets go by cascade; one item holds them both before.
select _mark();
set local role authenticated;
select _a('66100000-0000-0000-0000-0000000000a1', 'admin');
delete from public.portfolio where id = '66100000-0000-0000-0006-000000000001';
reset role;
select _as(null, null, null);
select is(
  (select format('%s %s %s %s %s %s', count(*), min(op), bool_and(release_id = '66100000-0000-0000-000d-000000000001'),
                 bool_and(draft_id is null),
                 min((select string_agg(m ->> 'id', ',' order by m ->> 'id') from jsonb_array_elements(before -> 'media') m))
                   || '|' || min(before -> 'service_ids' ->> 0),
                 min(after::text))
     from _since() where entity_type = 'portfolio_children' and entity_id = '66100000-0000-0000-0006-000000000001'),
  '1 update t t 66100000-0000-0000-0008-000000000001,66100000-0000-0000-0008-000000000002|66100000-0000-0000-0001-000000000001 {"media": [], "service_ids": []}',
  'a project removed in a release: ONE portfolio_children item, both sets before, none after');
-- C7: a service linked to two projects removed: one item per project.
select _mark();
set local role authenticated;
select _a('66100000-0000-0000-0000-0000000000a1', 'admin');
delete from public.services where id = '66100000-0000-0000-0001-000000000003';
reset role;
select _as(null, null, null);
select is(
  (select string_agg(format('%s %s>%s', right(entity_id::text, 1), before -> 'service_ids', after -> 'service_ids'), ', ' order by entity_id)
     from _since() where entity_type = 'portfolio_children'),
  '2 ["66100000-0000-0000-0001-000000000003"]>[], 3 ["66100000-0000-0000-0001-000000000003"]>[]',
  'a service removed in a release: one item for each project it was linked to');
select _token(false);

-- ── 6. Link sets out of band ─────────────────────────────────────────────────────────
-- C8: one claimless statement removes two services of the same project.
select _mark();
delete from public.services where id in ('66100000-0000-0000-0001-000000000004', '66100000-0000-0000-0001-000000000005');
select is(
  (select format('%s %s %s>%s', count(*), bool_and(release_id is null), min(before -> 'service_ids' ->> 0) || ',' || min(before -> 'service_ids' ->> 1),
                 min((after -> 'service_ids')::text))
     from _since() where entity_type = 'portfolio_children'),
  '1 t 66100000-0000-0000-0001-000000000004,66100000-0000-0000-0001-000000000005>[]',
  'one statement removing two services of one project: one system item whose before holds both');
-- C10: media added out of band, two rows in one statement: one item.
select _mark();
insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id, sort_order) values
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000006', 'gallery', 'image',
   '66100000-0000-0000-0007-000000000003', 0),
  ('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000006', 'gallery', 'image',
   '66100000-0000-0000-0007-000000000002', 1);
select is(
  (select format('%s %s %s %s>%s', count(*), min(entity_id::text) = '66100000-0000-0000-0006-000000000006',
                 bool_and(release_id is null), jsonb_array_length(min(before::text)::jsonb -> 'media'),
                 jsonb_array_length(min(after::text)::jsonb -> 'media'))
     from _since() where entity_type = 'portfolio_children'),
  '1 t t 0>2', 'two media rows added out of band in one statement: one system item, before none, after both');
select is(
  (select i.after from _since() i where i.entity_type = 'portfolio_children'),
  app.portfolio_link_sets('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000006'),
  'its after is the case study''s sets as app.portfolio_link_sets reads them');
select _mark();
update public.portfolio_media set sort_order = 5
 where portfolio_id = '66100000-0000-0000-0006-000000000006' and media_id = '66100000-0000-0000-0007-000000000003';
select is(
  (select format('%s %s', count(*), min(before -> 'media' -> 0 ->> 'media_id') <> min(after -> 'media' -> 0 ->> 'media_id'))
     from _since() where entity_type = 'portfolio_children'),
  '1 t', 'a reorder out of band is one item, its before and after in their own orders');
select _mark();
insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id)
values ('66100000-0000-0000-0000-00000000000b', '66100000-0000-0000-0006-0000000000b1', 'gallery', 'image',
        '66100000-0000-0000-0007-0000000000b1');
select is((select count(*)::int from _since()), 0, 'the same in tenant B (releases off) records nothing');
select is((select count(*)::int from app.release_link_pending), 0,
  'nothing is left pending between statements');

-- ── 7. The apply's own link-set step: R4's synthetic item alone ──────────────────────
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, base, base_version)
select '66100000-0000-0000-00dd-000000000001', p.tenant_id, 'portfolio', p.id, 'update',
       jsonb_build_object('year', p.year), p.version
  from public.portfolio p where p.id = '66100000-0000-0000-0006-000000000005';
create table _r5c_out (result jsonb);
grant insert, select on _r5c_out to service_role;
select _mark();
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into _r5c_out (result)
select public.apply_release('66100000-0000-0000-0000-0000000000c1'::uuid, 'content_creator', 'publish',
         jsonb_build_array(jsonb_build_object(
           'draft_id', '66100000-0000-0000-00dd-000000000001', 'draft_version', 1,
           'entity_type', 'portfolio', 'entity_id', '66100000-0000-0000-0006-000000000005',
           'op', 'update', 'patch', '{"year":2026}'::jsonb, 'base', '{"year":null}'::jsonb,
           'children', jsonb_build_object('service_ids', jsonb_build_array(
             '66100000-0000-0000-0001-000000000002', '66100000-0000-0000-0001-000000000001')))));
reset role;
select _as(null, null, null);
select is(
  (select format('%s %s %s', count(*), bool_and(i.release_id = (o.result ->> 'release_id')::uuid),
                 bool_and(i.draft_id = '66100000-0000-0000-00dd-000000000001'))
     from _since() i, _r5c_out o where i.entity_type = 'portfolio_children'),
  '1 t t', 'a link-set change published: exactly R4''s synthetic item, under its draft, and no statement item');
select is(
  (select i.after from _since() i where i.entity_type = 'portfolio_children'),
  app.portfolio_link_sets('66100000-0000-0000-0000-00000000000a', '66100000-0000-0000-0006-000000000005'),
  'R4''s synthetic item and app.portfolio_link_sets read the sets the same way');
select is(
  (select i.before -> 'service_ids' from _since() i where i.entity_type = 'portfolio_children'),
  '["66100000-0000-0000-0001-000000000002"]'::jsonb, 'and its before is the set as it was');

-- ── 8. Who reads system items ────────────────────────────────────────────────────────
create table _sys as
  select count(*)::int as n from public.content_release_items
   where tenant_id = '66100000-0000-0000-0000-00000000000a' and release_id is null;
grant select on _sys to authenticated, anon;
set local role authenticated;
select _a('66100000-0000-0000-0000-0000000000a1', 'admin');
select is((select count(*)::int from public.content_release_items where release_id is null), (select n from _sys),
  'admin reads its tenant''s system items');
select _a('66100000-0000-0000-0000-0000000000c1', 'content_creator');
select is((select count(*)::int from public.content_release_items where release_id is null), (select n from _sys),
  'content creator reads them');
select _a('66100000-0000-0000-0000-0000000000e1', 'seo');
select is((select count(*)::int from public.content_release_items where release_id is null), (select n from _sys),
  'seo reads them');
select _a('66100000-0000-0000-0000-0000000000d1', 'developer');
select is((select count(*)::int from public.content_release_items where release_id is null), (select n from _sys),
  'developer reads them');
select _a('66100000-0000-0000-0000-0000000000b5', 'sales');
select is((select count(*)::int from public.content_release_items), 0, 'a sales claim reads none');
select _as('66100000-0000-0000-0000-0000000000b1', 'admin', '66100000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.content_release_items
            where tenant_id = '66100000-0000-0000-0000-00000000000a'), 0,
  'other_tenant: another tenant''s admin reads none of tenant A''s');
reset role;
set local role anon;
select _as(null, null, null);
select throws_ok($$ select count(*) from public.content_release_items $$, '42501', null,
  'anon cannot read release items at all');
reset role;
select ok((select n from _sys) >= 8, 'tenant A has the system items this suite wrote');

select * from finish();
rollback;
