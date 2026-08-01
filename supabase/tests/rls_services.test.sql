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

begin;
select plan(7);

-- Setup runs as the migration/superuser role (RLS bypassed here).
insert into public.services (id, tenant_id, slug, title, status) values
  ('00000000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'pgtap-published-svc', '{"en":"P","ar":"ب"}', 'published'),
  ('00000000-0000-0000-0000-0000000000a2', app.default_tenant_id(), 'pgtap-draft-svc',     '{"en":"D","ar":"د"}', 'draft');

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

reset role;
select _claims(null, null);

select * from finish();
rollback;
