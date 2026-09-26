-- pgTAP: public media reads (0024), media_usage() and update_media_meta() (0020/0024).
--
-- Anon may read a media asset ONLY while published/visible content references it — a
-- poster of a published project, a case-study item, a cleared client's logo, a published
-- quote's avatar, a published leader's portrait, or a visible section of a published page
-- — and only hosted providers, and only the granted columns. Everything else fails closed.
--
-- update_media_meta() is the SEO role's metadata path: §5 gives SEO "media: meta only",
-- but media_write never admitted SEO, so its UPDATE was filtered to 0 rows (the admin
-- reported a 409 on every save). The function writes alt/tags/folder and nothing else.

begin;
select plan(22);

-- ── fixtures in the LAUNCH tenant (the one anon is fenced to) ───────────────
insert into public.media_assets (id, tenant_id, kind, provider, storage_path, folder) values
  ('65000000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a2', app.default_tenant_id(), 'image', 'static', 'stills/work/p1.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a3', app.default_tenant_id(), 'image', 'static', 'stills/work/p2.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a4', app.default_tenant_id(), 'image', 'external', 'https://cdn.example/x.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a5', app.default_tenant_id(), 'image', 'static', 'stills/work/p3.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a6', app.default_tenant_id(), 'image', 'static', 'stills/work/p4.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a7', app.default_tenant_id(), 'image', 'static', 'stills/work/p5.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a8', app.default_tenant_id(), 'image', 'static', 'stills/work/ia.jpg', 'x'),
  ('65000000-0000-0000-0000-0000000000a9', app.default_tenant_id(), 'image', 'static', 'stills/work/ib.jpg', 'x');
insert into public.portfolio (id, tenant_id, slug, title, status, poster_media_id) values
  ('65000000-0000-0000-0000-0000000000c1', app.default_tenant_id(), 'pgtap-mp-pub', '{"en":"P","ar":"م"}', 'published', '65000000-0000-0000-0000-0000000000a1'),
  ('65000000-0000-0000-0000-0000000000c2', app.default_tenant_id(), 'pgtap-mp-draft', '{"en":"D","ar":"م"}', 'draft', '65000000-0000-0000-0000-0000000000a2'),
  ('65000000-0000-0000-0000-0000000000c3', app.default_tenant_id(), 'pgtap-mp-ext', '{"en":"E","ar":"م"}', 'published', '65000000-0000-0000-0000-0000000000a4');
insert into public.portfolio_media (tenant_id, portfolio_id, role, kind, media_id) values
  (app.default_tenant_id(), '65000000-0000-0000-0000-0000000000c1', 'gallery', 'image', '65000000-0000-0000-0000-0000000000a9');
insert into public.clients (tenant_id, slug, name, visible, logo_media_id) values
  (app.default_tenant_id(), 'pgtap-mp-cleared', '{"en":"C","ar":"ع"}', true, '65000000-0000-0000-0000-0000000000a5'),
  (app.default_tenant_id(), 'pgtap-mp-hidden', '{"en":"H","ar":"ع"}', false, '65000000-0000-0000-0000-0000000000a6');
insert into public.pages (id, tenant_id, slug, title, status) values
  ('65000000-0000-0000-0000-0000000000d1', app.default_tenant_id(), 'pgtap-mp-page', '{"en":"Pg","ar":"ص"}', 'published');
insert into public.page_sections (tenant_id, page_id, type, content, visible) values
  (app.default_tenant_id(), '65000000-0000-0000-0000-0000000000d1', 'hero',
   '{"poster":{"mediaId":"65000000-0000-0000-0000-0000000000a7"}}', true),
  (app.default_tenant_id(), '65000000-0000-0000-0000-0000000000d1', 'hero',
   '{"poster":{"mediaId":"65000000-0000-0000-0000-0000000000a8"}}', false);
-- Another tenant's asset, referenced by that tenant's PUBLISHED project.
insert into public.tenants (id, name) values ('65000000-0000-0000-0000-000000000002', 'MediaT2');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('65000000-0000-0000-0000-0000000000b1', '65000000-0000-0000-0000-000000000002', 'image', 'static', 'stills/work/p0.jpg');
insert into public.portfolio (tenant_id, slug, title, status, poster_media_id) values
  ('65000000-0000-0000-0000-000000000002', 'pg-mp-t2', '{"en":"T","ar":"ت"}', 'published', '65000000-0000-0000-0000-0000000000b1');
-- …and a LAUNCH-tenant visible section of the published page pointing at that asset
-- (section JSON has no FK, so this is reachable). Only 0024's own tenant term hides it.
insert into public.page_sections (tenant_id, page_id, type, content, visible) values
  (app.default_tenant_id(), '65000000-0000-0000-0000-0000000000d1', 'hero',
   '{"poster":{"mediaId":"65000000-0000-0000-0000-0000000000b1"}}', true);

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _seen(p_id text) returns int language sql as $$
  select count(id)::int from public.media_assets where id = p_id::uuid $$;

-- ── 1. anon: exactly the assets public content shows ─────────────────────────
set local role anon;
select _claims(null, null);
select is(_seen('65000000-0000-0000-0000-0000000000a1'), 1, 'anon reads the poster of a PUBLISHED project');
select is(_seen('65000000-0000-0000-0000-0000000000a2'), 0, 'anon CANNOT read the poster of a draft project');
select is(_seen('65000000-0000-0000-0000-0000000000a3'), 0, 'anon CANNOT read an unreferenced asset');
select is(_seen('65000000-0000-0000-0000-0000000000a4'), 0, 'anon CANNOT read a legacy external URL, even on a published project');
select is(_seen('65000000-0000-0000-0000-0000000000a5'), 1, 'anon reads a cleared client''s logo');
select is(_seen('65000000-0000-0000-0000-0000000000a6'), 0, 'anon CANNOT read an uncleared client''s logo');
select is(_seen('65000000-0000-0000-0000-0000000000a7'), 1, 'anon reads an image in a visible section of a published page');
select is(_seen('65000000-0000-0000-0000-0000000000a8'), 0, 'anon CANNOT read an image in a hidden section');
select is(_seen('65000000-0000-0000-0000-0000000000a9'), 1, 'anon reads a published case study''s gallery image');
select is(_seen('65000000-0000-0000-0000-0000000000b1'), 0,
  'anon is fenced to the launch tenant — even when launch-tenant content references another tenant''s asset');
select throws_ok(
  $$ select folder from public.media_assets $$,
  '42501', null, 'anon CANNOT read internal columns (folder)');
select throws_ok(
  $$ select * from public.media_usage('65000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'anon CANNOT execute media_usage()');
select throws_ok(
  $$ select * from public.update_media_meta('65000000-0000-0000-0000-0000000000a3', 1, '{}'::jsonb) $$,
  '42501', null, 'anon CANNOT execute update_media_meta()');

-- ── 2. media_usage(): every reference, for staff ─────────────────────────────
reset role;
set local role authenticated;
select _claims('content_creator', app.default_tenant_id()::text);
select is(
  (select entity_type || ':' || entity_id from public.media_usage('65000000-0000-0000-0000-0000000000a1')),
  'portfolio:65000000-0000-0000-0000-0000000000c1', 'media_usage finds a project poster');
select is(
  (select count(*)::int from public.media_usage('65000000-0000-0000-0000-0000000000a8')),
  1, 'media_usage finds a section reference even when the section is hidden (staff see it)');
select is(
  (select count(*)::int from public.media_usage('65000000-0000-0000-0000-0000000000a3')),
  0, 'an unreferenced asset is unused');

-- ── 3. update_media_meta(): SEO's metadata path ──────────────────────────────
select _claims('seo', app.default_tenant_id()::text);
update public.media_assets set alt = '{"en":"direct","ar":"مباشر"}' where id = '65000000-0000-0000-0000-0000000000a3';
select ok(
  (select alt is null from public.media_assets where id = '65000000-0000-0000-0000-0000000000a3'),
  'a direct UPDATE by seo is filtered (media_write never admitted seo — why the function exists)');
select is(
  (select count(*)::int from public.update_media_meta('65000000-0000-0000-0000-0000000000a3', 1,
     '{"alt":{"en":"A frame","ar":"لقطة"},"tags":["reel"],"storage_path":"stills/evil.jpg","kind":"video"}'::jsonb)),
  1, 'seo updates alt text and tags through update_media_meta()');
select is(
  (select alt ->> 'en' || '|' || tags[1] || '|' || storage_path || '|' || kind || '|' || version
     from public.media_assets where id = '65000000-0000-0000-0000-0000000000a3'),
  'A frame|reel|stills/work/p2.jpg|image|2',
  'only alt/tags changed — storage_path and kind in the patch were ignored — and the version moved');
select is(
  (select count(*)::int from public.update_media_meta('65000000-0000-0000-0000-0000000000a3', 1,
     '{"folder":"stale"}'::jsonb)),
  0, 'a stale version returns no row (the route answers 409)');
select _claims('seo', '00000000-0000-0000-0000-0000000000ff');
select is(
  (select count(*)::int from public.update_media_meta('65000000-0000-0000-0000-0000000000a3', 2,
     '{"folder":"xt"}'::jsonb)),
  0, 'other_tenant: an seo of another tenant writes nothing');

-- ── structural ───────────────────────────────────────────────────────────────
reset role;
select ok(
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'media_assets'
             and policyname = 'media_assets_public_read' and cmd = 'SELECT'),
  'the 0024 public read policy exists');

select * from finish();
rollback;
