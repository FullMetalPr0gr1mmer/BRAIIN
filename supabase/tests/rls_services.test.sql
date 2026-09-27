-- pgTAP: services RLS — public sees only published; Content Creator authors + publishes
-- but cannot archive; SEO cannot write; Admin can archive/delete. Run with `supabase test db`.
--
-- TWO THINGS THIS FILE HAS TO GET RIGHT, both learned the hard way when the suite ran for
-- the first time (it had been staged on `workflow_dispatch` and never executed):
--
-- 1. FIXTURES MUST LIVE IN THE LAUNCH TENANT. `anon` has no JWT claims, so
--    `app.effective_tenant_id()` falls through to `app.default_tenant_id()` — the FIRST
--    tenant by created_at. `supabase start` runs seed.sql, which creates that tenant and
--    14 published services. A test that inserts its own tenant is therefore invisible to
--    anon, and the original's `count(*) = 1` was measuring the seed (it got 14).
--
-- 2. ASSERTIONS MUST BE SCOPED. Any global `count(*)` on a seeded database measures the
--    seed. Every count here is filtered to this file's own `pgtap-` slugs, so the numbers
--    mean what they say regardless of what else exists.

--
-- 0028 adds the discipline fence: a RESTRICTIVE read that hides a service whose discipline
-- is not published — from visitors only (staff see everything), and everywhere RLS reaches,
-- search_content included (SECURITY INVOKER). Its fixtures use a separate `pgdisc-` prefix
-- so the `pgtap-%` counts above keep meaning what they say.

begin;
select plan(19);

-- Setup runs as the migration/superuser role (RLS bypassed here).
insert into public.services (id, tenant_id, slug, title, status) values
  ('00000000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'pgtap-published-svc', '{"en":"P","ar":"ب"}', 'published'),
  ('00000000-0000-0000-0000-0000000000a2', app.default_tenant_id(), 'pgtap-draft-svc',     '{"en":"D","ar":"د"}', 'draft');

-- 0028: one published and one draft discipline in the launch tenant, a published service
-- under each, and another tenant's discipline.
insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('00000000-0000-0000-0000-0000000000d1', app.default_tenant_id(), 'pgtap-disc-live',  '{"en":"L","ar":"ل"}', 'published'),
  ('00000000-0000-0000-0000-0000000000d2', app.default_tenant_id(), 'pgtap-disc-draft', '{"en":"D","ar":"د"}', 'draft');
insert into public.services (tenant_id, slug, title, status, discipline_id) values
  (app.default_tenant_id(), 'pgdisc-svc-live',   '{"en":"Pgdiscwombat","ar":"و"}', 'published', '00000000-0000-0000-0000-0000000000d1'),
  (app.default_tenant_id(), 'pgdisc-svc-hidden', '{"en":"Pgdiscquokka","ar":"ك"}', 'published', '00000000-0000-0000-0000-0000000000d2');
insert into public.tenants (id, name) values ('00000000-0000-0000-0000-0000000000f2', 'SvcT2');
insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000f2', 'pgtap-disc-t2', '{"en":"T","ar":"ت"}', 'published');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The launch tenant, as text, for claim injection.
create function _tid() returns text language sql as $$ select app.default_tenant_id()::text $$;

-- anon sees only the published one of OUR two
set local role anon;
select _claims(null, null);
select is(
  (select count(*) from public.services where slug like 'pgtap-%')::int,
  1,
  'anon sees only published services'
);

set local role authenticated;

-- content_creator sees drafts too
select _claims('content_creator', _tid());
select is(
  (select count(*) from public.services where slug like 'pgtap-%')::int,
  2,
  'content_creator sees drafts'
);

-- content_creator can insert
select lives_ok(
  $$ insert into public.services (tenant_id, slug, title, status)
     values (app.default_tenant_id(), 'pgtap-new-svc', '{"en":"N","ar":"ن"}', 'draft') $$,
  'content_creator can insert a service'
);

-- content_creator CANNOT archive (WITH CHECK blocks status=archived for non-admin)
select throws_ok(
  $$ update public.services set status = 'archived' where slug = 'pgtap-published-svc' $$,
  '42501', null, 'content_creator cannot archive'
);

-- seo cannot write services
select _claims('seo', _tid());
select throws_ok(
  $$ insert into public.services (tenant_id, slug, title)
     values (app.default_tenant_id(), 'pgtap-seo-svc', '{"en":"S","ar":"س"}') $$,
  '42501', null, 'seo cannot write services'
);

-- admin can archive and delete
select _claims('admin', _tid());
select lives_ok(
  $$ update public.services set status = 'archived' where slug = 'pgtap-published-svc' $$,
  'admin can archive'
);
select lives_ok(
  $$ delete from public.services where slug = 'pgtap-draft-svc' $$,
  'admin can delete'
);

-- ── the discipline fence (0028) ──────────────────────────────────────────────
reset role;
set local role anon;
select _claims(null, null);
select is((select count(*)::int from public.services where slug = 'pgdisc-svc-live'), 1,
  'anon sees a published service whose discipline is published');
select is((select count(*)::int from public.services where slug = 'pgdisc-svc-hidden'), 0,
  'anon CANNOT see a published service whose discipline is a draft (RESTRICTIVE)');
select is((select count(*)::int from public.search_content('Pgdiscquokka', 'en')), 0,
  'nor find it through search_content (SECURITY INVOKER: the same RLS, no definer path)');
select is((select count(*)::int from public.search_content('Pgdiscwombat', 'en')), 1,
  'while a service under a published discipline is found');

reset role;
set local role authenticated;
select _claims('content_creator', _tid());
select is((select count(*)::int from public.services where slug like 'pgdisc-svc-%'), 2,
  'content_creator sees both (staff are not fenced)');
select _claims('seo', _tid());
select is((select count(*)::int from public.services where slug like 'pgdisc-svc-%'), 2,
  'seo sees both');
select _claims('developer', _tid());
select is((select count(*)::int from public.services where slug like 'pgdisc-svc-%'), 2,
  'developer sees both');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.services where slug like 'pgdisc-svc-%'), 0,
  'other_tenant admin sees neither');

select _claims('content_creator', _tid());
select throws_ok(
  $$ update public.services set discipline_id = '00000000-0000-0000-0000-0000000000d9'
      where slug = 'pgdisc-svc-live' $$,
  '42501', null, 'a service cannot be filed under ANOTHER tenant''s discipline (a bare FK would accept it)');

select _claims('admin', _tid());
select lives_ok(
  $$ update public.disciplines set status = 'archived' where slug = 'pgtap-disc-live' $$,
  'admin archives the discipline');
reset role;
set local role anon;
select _claims(null, null);
select is((select count(*)::int from public.services where slug = 'pgdisc-svc-live'), 0,
  'archiving a discipline hides its services from visitors at once');

reset role;
select ok(
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'services'
             and policyname = 'services_discipline_published' and permissive = 'RESTRICTIVE'),
  'the discipline fence is RESTRICTIVE (a permissive policy would narrow nothing)');

reset role;
select _claims(null, null);

select * from finish();
rollback;
