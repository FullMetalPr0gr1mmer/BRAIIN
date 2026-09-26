-- pgTAP: portfolio_services + portfolio_media + save_portfolio() (migration 0022).
--
--   • The children are public only for a PUBLISHED parent (RESTRICTIVE fence created
--     before the anon grant, as 0011 §5 demands) — a draft case study's services and
--     media never leak.
--   • save_portfolio() writes the parent and both child sets in ONE transaction, SECURITY
--     INVOKER (RLS applies to every row it writes), with the optimistic version check,
--     and refuses links to another tenant's rows.

begin;
select plan(27);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('64000000-0000-0000-0000-000000000001', 'PcT'),
  ('64000000-0000-0000-0000-000000000002', 'PcT2');
insert into public.services (id, tenant_id, slug, title, status) values
  ('64000000-0000-0000-0000-00000000e001', '64000000-0000-0000-0000-000000000001', 'pg-svc-1', '{"en":"S1","ar":"خ١"}', 'published'),
  ('64000000-0000-0000-0000-00000000e002', '64000000-0000-0000-0000-000000000001', 'pg-svc-2', '{"en":"S2","ar":"خ٢"}', 'published');
insert into public.sectors (id, tenant_id, slug, name) values
  ('64000000-0000-0000-0000-00000000f002', '64000000-0000-0000-0000-000000000002', 'pg-sec-t2', '{"en":"T2","ar":"ت"}');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('64000000-0000-0000-0000-00000000a001', '64000000-0000-0000-0000-000000000001', 'image', 'static', 'stills/work/p0.jpg'),
  ('64000000-0000-0000-0000-00000000a002', '64000000-0000-0000-0000-000000000002', 'image', 'static', 'stills/work/p1.jpg');
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('64000000-0000-0000-0000-00000000c001', '64000000-0000-0000-0000-000000000001', 'pg-t1-proj', '{"en":"T1","ar":"ت"}', 'draft'),
  ('64000000-0000-0000-0000-00000000c002', '64000000-0000-0000-0000-000000000002', 'pg-t2-proj', '{"en":"T2","ar":"ت"}', 'published');

-- Launch tenant (anon fence): a published and a draft project, each with a service link
-- and a media item.
insert into public.services (id, tenant_id, slug, title, status) values
  ('64000000-0000-0000-0000-0000000000e9', app.default_tenant_id(), 'pgtap-pc-svc', '{"en":"S","ar":"خ"}', 'published');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('64000000-0000-0000-0000-0000000000a9', app.default_tenant_id(), 'image', 'static', 'stills/work/p2.jpg');
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('64000000-0000-0000-0000-0000000000c1', app.default_tenant_id(), 'pgtap-pc-pub', '{"en":"P","ar":"م"}', 'published'),
  ('64000000-0000-0000-0000-0000000000c2', app.default_tenant_id(), 'pgtap-pc-draft', '{"en":"D","ar":"م"}', 'draft');
insert into public.portfolio_services (tenant_id, portfolio_id, service_id) values
  (app.default_tenant_id(), '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e9'),
  (app.default_tenant_id(), '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e9');
insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id) values
  (app.default_tenant_id(), '64000000-0000-0000-0000-0000000000c1', 'gallery', 'image', '64000000-0000-0000-0000-0000000000a9'),
  (app.default_tenant_id(), '64000000-0000-0000-0000-0000000000c2', 'gallery', 'image', '64000000-0000-0000-0000-0000000000a9');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '64000000-0000-0000-0000-000000000001' $$;
create function _sp_id() returns uuid language sql as $$
  select id from public.portfolio where slug = 'pg-sp' and tenant_id = _tid()::uuid $$;
create function _sp_version() returns int language sql as $$
  select version from public.portfolio where id = _sp_id() $$;

-- ── 1. anon: children of a PUBLISHED parent only ─────────────────────────────
set local role anon;
select _claims(null, null);
select is((select count(*)::int from public.portfolio_services
            where portfolio_id = '64000000-0000-0000-0000-0000000000c1'), 1,
  'anon reads the services of a published case study');
select is((select count(*)::int from public.portfolio_services
            where portfolio_id = '64000000-0000-0000-0000-0000000000c2'), 0,
  'anon CANNOT read the services of a draft case study');
select is((select count(*)::int from public.portfolio_media
            where portfolio_id = '64000000-0000-0000-0000-0000000000c1'), 1,
  'anon reads the media of a published case study');
select is((select count(*)::int from public.portfolio_media
            where portfolio_id = '64000000-0000-0000-0000-0000000000c2'), 0,
  'anon CANNOT read the media of a draft case study');
select throws_ok(
  $$ select * from public.save_portfolio(null, null, '{"slug":"pg-anon","title":{"en":"A","ar":"أ"}}'::jsonb) $$,
  '42501', null, 'anon CANNOT execute save_portfolio()');

reset role;
set local role authenticated;
select _claims('content_creator', app.default_tenant_id()::text);
select is((select count(*)::int from public.portfolio_media
            where portfolio_id = '64000000-0000-0000-0000-0000000000c2'), 1,
  'staff read the children of a draft case study');

-- ── 2. save_portfolio(): create ───────────────────────────────────────────────
select _claims('content_creator', _tid());
select lives_ok(
  $$ select * from public.save_portfolio(
       null, null,
       '{"slug":"pg-sp","title":{"en":"Project","ar":"مشروع"},"year":2026,"is_featured":true,
         "tenant_id":"64000000-0000-0000-0000-000000000002","version":99,"id":"64000000-0000-0000-0000-0000000000ff"}'::jsonb,
       array['64000000-0000-0000-0000-00000000e002', '64000000-0000-0000-0000-00000000e001']::uuid[],
       '[{"role":"hero","kind":"video","media_id":"64000000-0000-0000-0000-00000000a001",
          "video_path":"/media/showreel.mp4","clip_start_s":1,"clip_end_s":3.7},
         {"role":"gallery","kind":"image","media_id":"64000000-0000-0000-0000-00000000a001"}]'::jsonb) $$,
  'content_creator creates a case study with its services and media in one call');
select is((select tenant_id::text from public.portfolio where slug = 'pg-sp'), _tid(),
  'identity keys in p_values are ignored — the row is in the CALLER''s tenant, not the one named');
select isnt(_sp_id(), '64000000-0000-0000-0000-0000000000ff'::uuid, 'and it did not take the id named');
select is(_sp_version(), 1, 'a create is ONE insert: version 1 (one content_versions snapshot)');
select is(
  (select array_agg(service_id order by sort_order) from public.portfolio_services where portfolio_id = _sp_id()),
  array['64000000-0000-0000-0000-00000000e002', '64000000-0000-0000-0000-00000000e001']::uuid[],
  'services are stored in the order given');
select is((select count(*)::int from public.portfolio_media where portfolio_id = _sp_id()), 2,
  'media stored');

-- ── 3. update: the version check, partial patch, child replacement ──────────
select throws_ok(
  $$ select * from public.save_portfolio(_sp_id(), 5, '{"year":2025}'::jsonb) $$,
  '40001', null, 'a stale version is refused (409), nothing written');
select lives_ok(
  $$ select * from public.save_portfolio(_sp_id(), 1, '{"year":2025}'::jsonb) $$,
  'the current version saves');
select is(
  (select year::int || '/' || is_featured::text || '/' || version::text from public.portfolio where id = _sp_id()),
  '2025/true/2',
  'a partial patch keeps every column it did not name, and bumps the version');
select is((select count(*)::int from public.portfolio_services where portfolio_id = _sp_id()), 2,
  'null child sets are left untouched');
select lives_ok(
  $$ select * from public.save_portfolio(_sp_id(), 2, '{}'::jsonb,
       array['64000000-0000-0000-0000-00000000e001']::uuid[], '[]'::jsonb) $$,
  'child sets are replaced as a whole');
select is(
  (select count(*)::int from public.portfolio_services where portfolio_id = _sp_id())
  + (select count(*)::int from public.portfolio_media where portfolio_id = _sp_id()),
  1, 'one service left, no media');
select throws_ok(
  $$ select * from public.save_portfolio('64000000-0000-0000-0000-0000000000ee', 1, '{}'::jsonb) $$,
  'P0002', null, 'a missing id is 404');

-- ── 4. what the function refuses ─────────────────────────────────────────────
select throws_ok(
  $$ select * from public.save_portfolio(_sp_id(), 3, '{"sector_id":"64000000-0000-0000-0000-00000000f002"}'::jsonb) $$,
  '23503', null, 'linking ANOTHER tenant''s sector is refused (a bare FK would accept it)');
select throws_ok(
  $$ select * from public.save_portfolio(_sp_id(), 3, '{}'::jsonb, null,
       '[{"role":"gallery","kind":"image","media_id":"64000000-0000-0000-0000-00000000a002"}]'::jsonb) $$,
  '23503', null, 'linking ANOTHER tenant''s media is refused');
select throws_ok(
  $$ select * from public.save_portfolio(_sp_id(), 3, '{}'::jsonb, null,
       '[{"role":"hero","kind":"image","media_id":"64000000-0000-0000-0000-00000000a001"},
         {"role":"hero","kind":"image","media_id":"64000000-0000-0000-0000-00000000a001"}]'::jsonb) $$,
  '23505', null, 'two heroes are refused (the whole save rolls back)');
select throws_ok(
  $$ select * from public.save_portfolio(null, null, '{"slug":"all","title":{"en":"All","ar":"الكل"}}'::jsonb) $$,
  '23514', null, 'the slug "all" is reserved for the catalogue route');
select throws_ok(
  $$ select * from public.save_portfolio(_sp_id(), 3, '{"status":"archived"}'::jsonb) $$,
  '42501', null, 'content_creator CANNOT archive through the function (RLS applies inside it)');

select _claims('seo', _tid());
select throws_ok(
  $$ select * from public.save_portfolio(null, null, '{"slug":"pg-seo","title":{"en":"S","ar":"س"}}'::jsonb) $$,
  '42501', null, 'seo CANNOT write case studies');
select _claims('content_creator', '64000000-0000-0000-0000-000000000002');
select throws_ok(
  $$ select * from public.save_portfolio('64000000-0000-0000-0000-00000000c001', 1, '{"year":2020}'::jsonb) $$,
  'P0002', null, 'other_tenant: an author of tenant 2 cannot save (or even see) a tenant 1 project');

-- A direct child insert pointing at another tenant's project is refused by the policy.
select _claims('content_creator', _tid());
select throws_ok(
  $$ insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id)
     values (_tid()::uuid, '64000000-0000-0000-0000-00000000c002', 'gallery', 'image',
             '64000000-0000-0000-0000-00000000a001') $$,
  '42501', null, 'a media row cannot hang off another tenant''s project');

select * from finish();
rollback;
