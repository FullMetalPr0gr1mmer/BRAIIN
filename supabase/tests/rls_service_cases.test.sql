-- pgTAP: public.service_cases (migration 0028).
--
-- One "client problem we solved" block per service, tied to a portfolio project.
--   • Public only while the case AND its service are published — a RESTRICTIVE
--     published-parent fence (the portfolio_services pattern, 0022). The fence reads
--     services under the reader's own RLS, so a service hidden by its draft discipline
--     hides its case too.
--   • anon reads through a COLUMN grant: never is_placeholder, the schedule, the version
--     or the actor columns.
--   • A case's service and project must be the writer's own tenant's (the
--     portfolio_media_write pattern): a bare foreign key would accept another tenant's row.
--   • Admin + Content Creator author and publish; archive and delete are Admin-only
--     (RESTRICTIVE); SEO and Developer never write; another tenant sees and writes nothing.
-- The production placeholder guard on this table: placeholder_guard.test.sql.

begin;
select plan(29);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('68000000-0000-0000-0000-000000000001', 'CaseT'),
  ('68000000-0000-0000-0000-000000000002', 'CaseT2');
insert into public.services (id, tenant_id, slug, title, status) values
  ('68000000-0000-0000-0000-0000000000e1', '68000000-0000-0000-0000-000000000001', 'pg-case-svc', '{"en":"S1","ar":"خ"}', 'published'),
  ('68000000-0000-0000-0000-0000000000e2', '68000000-0000-0000-0000-000000000001', 'pg-case-svc2', '{"en":"S2","ar":"خ"}', 'published'),
  ('68000000-0000-0000-0000-0000000000e3', '68000000-0000-0000-0000-000000000001', 'pg-case-svc3', '{"en":"S3","ar":"خ"}', 'published'),
  ('68000000-0000-0000-0000-0000000000e9', '68000000-0000-0000-0000-000000000002', 'pg-case-svc-t2', '{"en":"T2","ar":"ت"}', 'published');
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('68000000-0000-0000-0000-0000000000c1', '68000000-0000-0000-0000-000000000001', 'pg-case-proj', '{"en":"P","ar":"م"}', 'published'),
  ('68000000-0000-0000-0000-0000000000c9', '68000000-0000-0000-0000-000000000002', 'pg-case-proj-t2', '{"en":"P2","ar":"م"}', 'published');
insert into public.service_cases (id, tenant_id, service_id, portfolio_id, title, status) values
  ('68000000-0000-0000-0000-0000000000a1', '68000000-0000-0000-0000-000000000001',
   '68000000-0000-0000-0000-0000000000e1', '68000000-0000-0000-0000-0000000000c1',
   '{"en":"Case one","ar":"حالة"}', 'published');

-- The launch tenant (anon fence): four published-or-draft combinations.
insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('68000000-0000-0000-0000-0000000000d1', app.default_tenant_id(), 'pgtap-case-disc-draft', '{"en":"D","ar":"د"}', 'draft');
insert into public.services (id, tenant_id, slug, title, status, discipline_id) values
  ('68000000-0000-0000-0000-0000000000f1', app.default_tenant_id(), 'pgtap-case-svc-pub', '{"en":"A","ar":"أ"}', 'published', null),
  ('68000000-0000-0000-0000-0000000000f2', app.default_tenant_id(), 'pgtap-case-svc-draft', '{"en":"B","ar":"ب"}', 'draft', null),
  ('68000000-0000-0000-0000-0000000000f3', app.default_tenant_id(), 'pgtap-case-svc-hid', '{"en":"C","ar":"ج"}', 'published',
   '68000000-0000-0000-0000-0000000000d1'),
  ('68000000-0000-0000-0000-0000000000f4', app.default_tenant_id(), 'pgtap-case-svc-pub2', '{"en":"D","ar":"د"}', 'published', null);
insert into public.service_cases (tenant_id, service_id, title, status) values
  (app.default_tenant_id(), '68000000-0000-0000-0000-0000000000f1', '{"en":"pgtap-case-visible","ar":"ح"}', 'published'),
  (app.default_tenant_id(), '68000000-0000-0000-0000-0000000000f2', '{"en":"pgtap-case-parent-draft","ar":"ح"}', 'published'),
  (app.default_tenant_id(), '68000000-0000-0000-0000-0000000000f3', '{"en":"pgtap-case-disc-hidden","ar":"ح"}', 'published'),
  (app.default_tenant_id(), '68000000-0000-0000-0000-0000000000f4', '{"en":"pgtap-case-own-draft","ar":"ح"}', 'draft');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '68000000-0000-0000-0000-000000000001' $$;
create function _n() returns int language sql as $$
  select count(*)::int from public.service_cases where tenant_id = _tid()::uuid $$;
create function _seen(p_title text) returns int language sql as $$
  select count(id)::int from public.service_cases where title ->> 'en' = p_title $$;

-- ── 1. anon: a published case of a published service, nothing else ───────────
set local role anon;
select _claims(null, null);
select is(
  (select count(id)::int from public.service_cases where title ->> 'en' like 'pgtap-case-%'),
  1, 'anon reads exactly one of the four: the published case of a published service');
select is(_seen('pgtap-case-parent-draft'), 0,
  'anon CANNOT read a published case whose service is a draft (published-parent fence)');
select is(_seen('pgtap-case-disc-hidden'), 0,
  'nor one whose service is hidden by its draft discipline (the fence reads services under anon''s RLS)');
select throws_ok(
  $$ select is_placeholder from public.service_cases $$,
  '42501', null, 'anon CANNOT read is_placeholder (column not granted)');
select throws_ok(
  $$ select * from public.service_cases $$,
  '42501', null, 'anon CANNOT select * (the schedule, version and actor columns are outside its grant)');
select throws_ok(
  $$ insert into public.service_cases (service_id, title)
     values ('68000000-0000-0000-0000-0000000000f4', '{"en":"x","ar":"س"}') $$,
  '42501', null, 'anon cannot write service cases (no privilege)');
select is(
  (select count(id)::int from public.service_cases where tenant_id = _tid()::uuid),
  0, 'anon is fenced to the launch tenant');

-- ── 2. staff see every case ──────────────────────────────────────────────────
reset role;
set local role authenticated;
select _claims('content_creator', app.default_tenant_id()::text);
select is(
  (select count(*)::int from public.service_cases where title ->> 'en' like 'pgtap-case-%'),
  4, 'staff see all four, drafts and fenced ones included');

-- ── 3. content_creator: authors and publishes, inside its own tenant ──────────
select _claims('content_creator', _tid());
select lives_ok(
  $$ insert into public.service_cases (tenant_id, service_id, portfolio_id, title, problems)
     values (_tid()::uuid, '68000000-0000-0000-0000-0000000000e2', '68000000-0000-0000-0000-0000000000c1',
             '{"en":"Case two","ar":"حالة"}',
             '[{"problem":{"en":"P","ar":"م"},"solution":{"en":"S","ar":"ح"}}]') $$,
  'content_creator creates a case for its own service and project');
select throws_ok(
  $$ insert into public.service_cases (tenant_id, service_id, title)
     values (_tid()::uuid, '68000000-0000-0000-0000-0000000000e9', '{"en":"X","ar":"س"}') $$,
  '42501', null, 'but not for ANOTHER tenant''s service (a bare FK would accept it)');
select throws_ok(
  $$ update public.service_cases set portfolio_id = '68000000-0000-0000-0000-0000000000c9'
      where id = '68000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'nor link ANOTHER tenant''s project');
select throws_ok(
  $$ insert into public.service_cases (tenant_id, service_id, title)
     values (_tid()::uuid, '68000000-0000-0000-0000-0000000000e1', '{"en":"Dup","ar":"م"}') $$,
  '23505', null, 'one case per service (unique per tenant)');
select lives_ok(
  $$ update public.service_cases set status = 'published', published_at = now()
      where service_id = '68000000-0000-0000-0000-0000000000e2' $$,
  'content_creator publishes a case');
select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'service_case'
      and entity_id = (select id from public.service_cases
                        where service_id = '68000000-0000-0000-0000-0000000000e2')),
  2, 'each write is a content_versions snapshot, entity "service_case" (insert + publish)');
select throws_ok(
  $$ update public.service_cases set status = 'archived' where id = '68000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'content_creator CANNOT archive a case (RESTRICTIVE, Admin-only)');
delete from public.service_cases where service_id = '68000000-0000-0000-0000-0000000000e2';
select is(_n(), 2, 'content_creator delete is a no-op (RESTRICTIVE, Admin-only)');

-- ── 4. seo and developer: no write ─────────────────────────────────────────────
select _claims('seo', _tid());
select throws_ok(
  $$ insert into public.service_cases (tenant_id, service_id, title)
     values (_tid()::uuid, '68000000-0000-0000-0000-0000000000e3', '{"en":"S","ar":"س"}') $$,
  '42501', null, 'seo CANNOT author cases');
select _claims('developer', _tid());
select throws_ok(
  $$ insert into public.service_cases (tenant_id, service_id, title)
     values (_tid()::uuid, '68000000-0000-0000-0000-0000000000e3', '{"en":"D","ar":"د"}') $$,
  '42501', null, 'developer CANNOT author cases');
update public.service_cases set title = '{"en":"Dev edit","ar":"د"}' where id = '68000000-0000-0000-0000-0000000000a1';
select _claims('admin', _tid());
select is((select title ->> 'en' from public.service_cases where id = '68000000-0000-0000-0000-0000000000a1'),
  'Case one', 'a developer update affects 0 rows');

-- ── 5. admin: archive and delete ───────────────────────────────────────────────
select lives_ok(
  $$ update public.service_cases set status = 'archived' where id = '68000000-0000-0000-0000-0000000000a1' $$,
  'admin archives a case');
select lives_ok(
  $$ delete from public.service_cases where service_id = '68000000-0000-0000-0000-0000000000e2' $$,
  'admin deletes a case');
select is(_n(), 1, 'and the row is gone');

-- ── 6. other_tenant ─────────────────────────────────────────────────────────────
select _claims('admin', '68000000-0000-0000-0000-000000000002');
select is(_n(), 0, 'other_tenant admin sees none of this tenant''s cases');
select throws_ok(
  $$ insert into public.service_cases (tenant_id, service_id, title)
     values (_tid()::uuid, '68000000-0000-0000-0000-0000000000e3', '{"en":"X","ar":"س"}') $$,
  '42501', null, 'other_tenant admin cannot write into this tenant');

-- ── 7. the links: a deleted project leaves the case, unlinked ─────────────────
reset role;
select _claims(null, null);
delete from public.portfolio where id = '68000000-0000-0000-0000-0000000000c1';
select is(
  (select coalesce(portfolio_id::text, 'unlinked') from public.service_cases
    where id = '68000000-0000-0000-0000-0000000000a1'),
  'unlinked', 'deleting the project sets the case''s portfolio_id to null (the case survives)');

-- ── 8. scheduling ────────────────────────────────────────────────────────────────
insert into public.service_cases (tenant_id, service_id, title, status, scheduled_for) values
  ('68000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-0000000000e3',
   '{"en":"Soon","ar":"قريباً"}', 'scheduled', now() - interval '1 minute');
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() ran');
select is(
  (select status::text from public.service_cases where service_id = '68000000-0000-0000-0000-0000000000e3'),
  'published', 'a due case is published by the cron (0028 joins its table array)');

-- ── structural ───────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.service_cases'::regclass),
  'service_cases has RLS enabled AND forced');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'service_cases'
      and policyname in ('service_cases_published_parent', 'service_cases_delete_admin',
                         'service_cases_archive_admin')
      and permissive = 'RESTRICTIVE'),
  3, 'the published-parent fence and the archive/delete gates are RESTRICTIVE');

select * from finish();
rollback;
