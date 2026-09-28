-- pgTAP: public.disciplines (migration 0028).
--
-- The five groups the services sit in. A content table like services (§5): Admin + Content
-- Creator author and publish; archive and delete are Admin-only (RESTRICTIVE); SEO and
-- Developer read (staff) but never write; anon reads published rows through a COLUMN grant
-- (never the schedule, version or actor columns); another tenant sees and writes nothing.
-- The clip columns carry the EXC-009 rules (a /media/*.mp4 path, a window of at most 30s),
-- every write is snapshotted into content_versions, and a scheduled row is published by
-- app.publish_scheduled(). How a draft discipline hides its services: rls_services.

begin;
select plan(29);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('67000000-0000-0000-0000-000000000001', 'DiscT');
insert into public.disciplines (id, tenant_id, slug, name, status, sort_order) values
  ('67000000-0000-0000-0000-0000000000d1', '67000000-0000-0000-0000-000000000001', 'pg-disc-pub',
   '{"en":"Branding","ar":"الهوية"}', 'published', 10),
  ('67000000-0000-0000-0000-0000000000d2', '67000000-0000-0000-0000-000000000001', 'pg-disc-draft',
   '{"en":"Events","ar":"الفعاليات"}', 'draft', 20);
-- The launch tenant's — the ones anon is fenced to.
insert into public.disciplines (tenant_id, slug, name, short, status) values
  (app.default_tenant_id(), 'pgtap-disc-pub', '{"en":"Pub","ar":"منشور"}', '{"en":"S","ar":"ق"}', 'published'),
  (app.default_tenant_id(), 'pgtap-disc-draft', '{"en":"Draft","ar":"مسودة"}', null, 'draft');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '67000000-0000-0000-0000-000000000001' $$;
create function _n() returns int language sql as $$
  select count(*)::int from public.disciplines where tenant_id = _tid()::uuid $$;

-- ── 1. anon: published rows, public columns, launch tenant only ─────────────
set local role anon;
select _claims(null, null);
select is(
  (select count(id)::int from public.disciplines where slug in ('pgtap-disc-pub', 'pgtap-disc-draft')),
  1, 'anon reads the published discipline and not the draft');
select is(
  (select name ->> 'en' || '/' || (short ->> 'en') from public.disciplines where slug = 'pgtap-disc-pub'),
  'Pub/S', 'anon reads the public columns');
select throws_ok(
  $$ select * from public.disciplines $$,
  '42501', null, 'anon CANNOT select * (schedule, version and actor columns are outside its grant)');
select throws_ok(
  $$ select scheduled_for from public.disciplines $$,
  '42501', null, 'anon CANNOT read scheduled_for');
select throws_ok(
  $$ insert into public.disciplines (slug, name) values ('pgtap-disc-anon', '{"en":"A","ar":"أ"}') $$,
  '42501', null, 'anon cannot write disciplines (no privilege)');
select is(
  (select count(id)::int from public.disciplines where tenant_id = _tid()::uuid),
  0, 'anon is fenced to the launch tenant');

-- ── 2. content_creator: authors and publishes; no archive, no delete ─────────
reset role;
set local role authenticated;
select _claims('content_creator', _tid());
select is(_n(), 2, 'content_creator sees drafts too');
select lives_ok(
  $$ insert into public.disciplines (tenant_id, slug, name, status)
     values (_tid()::uuid, 'pg-disc-new', '{"en":"New","ar":"جديد"}', 'draft') $$,
  'content_creator creates a discipline');
select lives_ok(
  $$ update public.disciplines set status = 'published', published_at = now() where slug = 'pg-disc-draft' $$,
  'content_creator publishes a discipline');
select throws_ok(
  $$ update public.disciplines set status = 'archived' where slug = 'pg-disc-pub' $$,
  '42501', null, 'content_creator CANNOT archive a discipline (RESTRICTIVE, Admin-only)');
delete from public.disciplines where slug = 'pg-disc-new';
select is(_n(), 3, 'content_creator delete is a no-op (RESTRICTIVE, Admin-only)');

-- ── 3. seo and developer: staff read, no write ───────────────────────────────
select _claims('seo', _tid());
select is(_n(), 3, 'seo reads disciplines (staff)');
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name) values (_tid()::uuid, 'pg-disc-seo', '{"en":"S","ar":"س"}') $$,
  '42501', null, 'seo CANNOT author disciplines');
update public.disciplines set sort_order = 99 where slug = 'pg-disc-pub';
select _claims('developer', _tid());
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name) values (_tid()::uuid, 'pg-disc-dev', '{"en":"D","ar":"د"}') $$,
  '42501', null, 'developer CANNOT author disciplines');
update public.disciplines set sort_order = 98 where slug = 'pg-disc-pub';
select _claims('admin', _tid());
select is((select sort_order from public.disciplines where slug = 'pg-disc-pub'), 10,
  'seo and developer updates affected 0 rows');

-- ── 4. admin: archive and delete ───────────────────────────────────────────────
select lives_ok(
  $$ update public.disciplines set status = 'archived' where slug = 'pg-disc-pub' $$,
  'admin archives a discipline');
select lives_ok(
  $$ delete from public.disciplines where slug = 'pg-disc-new' $$,
  'admin deletes a discipline');
select is(_n(), 2, 'and the row is gone');

-- ── 5. other_tenant: sees nothing, writes nothing ──────────────────────────────
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is(_n(), 0, 'other_tenant admin sees none of this tenant''s disciplines');
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name) values (_tid()::uuid, 'pg-disc-x', '{"en":"X","ar":"س"}') $$,
  '42501', null, 'other_tenant admin cannot write into this tenant');

-- ── 6. the row rules (CHECKs hold for every role) ──────────────────────────────
select _claims('admin', _tid());
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name, preview_video_path, preview_start_s, preview_end_s)
     values (_tid()::uuid, 'pg-disc-long', '{"en":"L","ar":"ل"}', '/media/showreel.mp4', 5, 40) $$,
  '23514', null, 'a clip window longer than 30s is refused (EXC-009)');
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name, preview_video_path)
     values (_tid()::uuid, 'pg-disc-url', '{"en":"U","ar":"ر"}', 'https://cdn.example/x.mp4') $$,
  '23514', null, 'a clip must be a same-origin /media/*.mp4 path (EXC-009)');
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name) values (_tid()::uuid, 'pg-disc-draft', '{"en":"D","ar":"د"}') $$,
  '23505', null, 'slugs are unique per tenant');
select throws_ok(
  $$ insert into public.disciplines (tenant_id, slug, name) values (_tid()::uuid, 'pg-disc-en', '{"en":"Only EN"}') $$,
  '23514', null, 'a name needs both en and ar');

-- ── 7. scheduling and history ──────────────────────────────────────────────────
reset role;
select _claims(null, null);
insert into public.disciplines (tenant_id, slug, name, status, scheduled_for) values
  ('67000000-0000-0000-0000-000000000001', 'pg-disc-sched', '{"en":"S","ar":"ج"}', 'scheduled',
   now() - interval '1 minute');
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() ran');
select is(
  (select status::text from public.disciplines where slug = 'pg-disc-sched' and tenant_id = _tid()::uuid),
  'published', 'a due discipline is published by the cron (0028 joins its table array)');
select is(
  (select count(*)::int || '/' || max(version)::text from public.content_versions
    where entity_type = 'discipline' and entity_id = '67000000-0000-0000-0000-0000000000d2'),
  '2/2', 'every write is a content_versions snapshot, entity "discipline" (insert + publish)');

-- ── structural ───────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.disciplines'::regclass),
  'disciplines has RLS enabled AND forced');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'disciplines'
      and policyname in ('disciplines_delete_admin', 'disciplines_archive_admin') and permissive = 'RESTRICTIVE'),
  2, 'the archive and delete gates are RESTRICTIVE');

select * from finish();
rollback;
