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
--
-- 0028 adds two references: a published discipline's poster and a published service's
-- poster — the service's read runs under anon's RLS, so its discipline must be published too.
--
-- 0066 (Admin v2 R5, media_usage v4) adds pending changes: a draft (not a removal, claimed
-- or not) whose payload holds the asset's id as a string anywhere, in any spelling uuid_in
-- reads, is a reference marked `pending`; the live branches answer `pending` false. The base
-- (live values) is never read; the drafts' own RLS decides who sees them (CMS staff).

begin;
select plan(44);

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
-- 0028: discipline and service posters.
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('65000000-0000-0000-0000-0000000000e1', app.default_tenant_id(), 'image', 'static', 'stills/services/write.jpg'),
  ('65000000-0000-0000-0000-0000000000e2', app.default_tenant_id(), 'image', 'static', 'stills/services/rider.jpg'),
  ('65000000-0000-0000-0000-0000000000e3', app.default_tenant_id(), 'image', 'static', 'stills/services/oven.jpg'),
  ('65000000-0000-0000-0000-0000000000e4', app.default_tenant_id(), 'image', 'static', 'stills/services/sun.jpg'),
  ('65000000-0000-0000-0000-0000000000e5', app.default_tenant_id(), 'image', 'static', 'stills/services/arm.jpg');
insert into public.disciplines (id, tenant_id, slug, name, status, poster_media_id) values
  ('65000000-0000-0000-0000-0000000000f1', app.default_tenant_id(), 'pgtap-mp-disc-pub', '{"en":"D","ar":"ت"}', 'published', '65000000-0000-0000-0000-0000000000e1'),
  ('65000000-0000-0000-0000-0000000000f2', app.default_tenant_id(), 'pgtap-mp-disc-draft', '{"en":"D","ar":"ت"}', 'draft', '65000000-0000-0000-0000-0000000000e2');
insert into public.services (tenant_id, slug, title, status, poster_media_id, discipline_id) values
  (app.default_tenant_id(), 'pgtap-mp-svc-pub', '{"en":"S","ar":"خ"}', 'published', '65000000-0000-0000-0000-0000000000e3', null),
  (app.default_tenant_id(), 'pgtap-mp-svc-draft', '{"en":"S","ar":"خ"}', 'draft', '65000000-0000-0000-0000-0000000000e4', null),
  (app.default_tenant_id(), 'pgtap-mp-svc-hidden', '{"en":"S","ar":"خ"}', 'published', '65000000-0000-0000-0000-0000000000e5',
   '65000000-0000-0000-0000-0000000000f2');

-- 0066: pending changes in the launch tenant (the draft lock keeps these ids: no claims).
insert into public.content_releases (id, tenant_id, kind, status, scheduled_for, scheduled_by, payload) values
  ('65000000-0000-0000-0000-000000000c99', app.default_tenant_id(), 'publish', 'scheduled',
   now() + interval '1 day', '65000000-0000-0000-0000-0000000000aa', '[]');
insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload, base, label, release_id) values
  -- a poster, by its camelCase key, with a label
  (app.default_tenant_id(), 'service', gen_random_uuid(), 'update',
   '{"posterMediaId":"65000000-0000-0000-0000-000000000d01"}', '{}', '{"en":"Poster swap","ar":"تبديل"}', null),
  -- nested in a section's content, with a slug and no label
  (app.default_tenant_id(), 'page_section', gen_random_uuid(), 'update',
   '{"slug":"pg-sec","content":{"items":[{"mediaId":"65000000-0000-0000-0000-000000000d02"}]}}', '{}', null, null),
  -- an element of an array, with neither label nor slug
  (app.default_tenant_id(), 'portfolio', gen_random_uuid(), 'update',
   '{"gallery":["x","65000000-0000-0000-0000-000000000d03"]}', '{}', null, null),
  -- upper case, no hyphens, braces: the spellings uuid_in reads
  (app.default_tenant_id(), 'client', gen_random_uuid(), 'update',
   '{"logoMediaId":"65000000-0000-0000-0000-000000000D0A"}', '{}', null, null),
  (app.default_tenant_id(), 'testimonial', gen_random_uuid(), 'update',
   '{"avatarMediaId":"65000000000000000000000000000d05"}', '{}', null, null),
  (app.default_tenant_id(), 'discipline', gen_random_uuid(), 'update',
   '{"posterMediaId":"{65000000-0000-0000-0000-000000000d06}"}', '{}', null, null),
  -- only in the base (a live value): not a pending reference
  (app.default_tenant_id(), 'service', gen_random_uuid(), 'update',
   '{"title":{"en":"T","ar":"ت"}}', '{"poster_media_id":"65000000-0000-0000-0000-000000000d07"}', null, null),
  -- a removal (its payload is empty by its shape): nothing pending to show
  (app.default_tenant_id(), 'service', gen_random_uuid(), 'delete',
   '{}', '{"poster_media_id":"65000000-0000-0000-0000-000000000d08"}', null, null),
  -- claimed by a scheduled release: still pending
  (app.default_tenant_id(), 'sector', gen_random_uuid(), 'update',
   '{"posterMediaId":"65000000-0000-0000-0000-000000000d09"}', '{}', null, '65000000-0000-0000-0000-000000000c99'),
  -- another tenant's
  ('65000000-0000-0000-0000-000000000002', 'service', gen_random_uuid(), 'update',
   '{"posterMediaId":"65000000-0000-0000-0000-000000000d10"}', '{}', null, null),
  -- a label longer than the list shows, naming a live poster too (e1)
  (app.default_tenant_id(), 'statistic', gen_random_uuid(), 'update',
   '{"posterMediaId":"65000000-0000-0000-0000-0000000000e1"}', '{}',
   jsonb_build_object('en', repeat('x', 200), 'ar', 'ع'), null);

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
select is(_seen('65000000-0000-0000-0000-0000000000e1'), 1, 'anon reads the poster of a PUBLISHED discipline (0028)');
select is(_seen('65000000-0000-0000-0000-0000000000e2'), 0, 'anon CANNOT read the poster of a draft discipline');
select is(_seen('65000000-0000-0000-0000-0000000000e3'), 1, 'anon reads the poster of a PUBLISHED service (0028)');
select is(_seen('65000000-0000-0000-0000-0000000000e4'), 0, 'anon CANNOT read the poster of a draft service');
select is(_seen('65000000-0000-0000-0000-0000000000e5'), 0,
  'anon CANNOT read the poster of a published service hidden by its draft discipline');
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
select is(
  (select entity_type || ':' || label from public.media_usage('65000000-0000-0000-0000-0000000000e2')),
  'discipline:pgtap-mp-disc-draft', 'media_usage finds a discipline poster, even a draft''s (0028)');
select is(
  (select entity_type || ':' || label from public.media_usage('65000000-0000-0000-0000-0000000000e4')),
  'service:pgtap-mp-svc-draft', 'media_usage finds a service poster (0028)');

-- 0066: pending changes are references too.
select is(
  (select format('%s %s %s', entity_type, label, pending) from public.media_usage('65000000-0000-0000-0000-000000000d01')),
  'service Poster swap t', 'v4: a pending change naming the asset is a reference, marked pending, labelled');
select is(
  (select format('%s %s %s', entity_type, label, pending) from public.media_usage('65000000-0000-0000-0000-000000000d02')),
  'page_section pg-sec t', 'v4: nested anywhere in the payload (a section''s items); its slug when it has no label');
select is(
  (select format('%s %s', entity_type, label) from public.media_usage('65000000-0000-0000-0000-000000000d03')),
  'portfolio pending change', 'v4: an element of an array; "pending change" when it has neither label nor slug');
select is((select entity_type from public.media_usage('65000000-0000-0000-0000-000000000d0a')),
  'client', 'v4: the id in upper case is the same id');
select is((select entity_type from public.media_usage('65000000-0000-0000-0000-000000000d05')),
  'testimonial', 'v4: the id with no hyphens is the same id');
select is((select entity_type from public.media_usage('65000000-0000-0000-0000-000000000d06')),
  'discipline', 'v4: the id in braces is the same id');
select is((select count(*)::int from public.media_usage('65000000-0000-0000-0000-000000000d07')),
  0, 'v4: an id only in a draft''s base (a live value) is not a pending reference');
select is((select count(*)::int from public.media_usage('65000000-0000-0000-0000-000000000d08')),
  0, 'v4: a pending removal is not a reference');
select is((select format('%s %s', entity_type, pending) from public.media_usage('65000000-0000-0000-0000-000000000d09')),
  'sector t', 'v4: a change a scheduled release has claimed is still pending, so still a reference');
select is((select count(*)::int from public.media_usage('65000000-0000-0000-0000-000000000d10')),
  0, 'v4: another tenant''s pending change is not listed');
select is(
  (select string_agg(format('%s %s %s', entity_type, pending, char_length(label)), ', ' order by pending, entity_type)
     from public.media_usage('65000000-0000-0000-0000-0000000000e1')),
  'discipline f 17, statistic t 120',
  'v4: live references answer pending false; a pending label is cut at 120 characters');
select _claims('seo', app.default_tenant_id()::text);
select is((select format('%s %s', entity_type, pending) from public.media_usage('65000000-0000-0000-0000-000000000d01')),
  'service t', 'v4: seo (media meta) sees pending references too');
select _claims('sales', app.default_tenant_id()::text);
select is((select count(*)::int from public.media_usage('65000000-0000-0000-0000-000000000d01')),
  0, 'v4: a sales claim sees no pending change (drafts are CMS staff''s)');
select _claims('admin', '65000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.media_usage('65000000-0000-0000-0000-000000000d01')),
  0, 'v4: other_tenant: another tenant''s admin sees none of the launch tenant''s pending changes');
select _claims('content_creator', app.default_tenant_id()::text);
reset role;
select ok(
  (select not prosecdef and proconfig = array['search_path=""']
          and pg_get_function_result(oid) = 'TABLE(entity_type text, entity_id uuid, label text, pending boolean)'
     from pg_proc where oid = 'public.media_usage(uuid)'::regprocedure),
  'v4: media_usage is INVOKER, search_path pinned, and answers four columns');
set local role authenticated;

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
