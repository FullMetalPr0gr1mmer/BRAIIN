-- pgTAP: public.redirects (migrations 0001, 0009, 0011) — Round 3, item A.
--
-- The authored half of the redirects module. §5 gives Admin + SEO the whole module
-- ("full": author, edit AND delete — the Worker names `deleteCap: 'redirects.manage'`
-- so its second layer agrees); Content Creator and Developer read (staff) and never
-- write; anon has no privilege on the table at all — the public request path never reads
-- it, it reads the KV snapshot every save rebuilds (src/lib/admin/redirectSync.ts); a
-- different tenant sees and writes nothing. One rule per (tenant, source); the status is
-- one of the three real redirect codes; every update bumps `version` for the optimistic
-- lock. A refused UPDATE/DELETE is a filtered no-op, a refused INSERT is 42501 — see the
-- note at the top of rls_admin_cms.test.sql.

begin;
select plan(23);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('68000000-0000-0000-0000-000000000001', 'RedirT');
insert into public.redirects (id, tenant_id, source_path, target_path, status) values
  ('68000000-0000-0000-0000-0000000000a1', '68000000-0000-0000-0000-000000000001',
   '/pg-old', '/about', 301),
  ('68000000-0000-0000-0000-0000000000a2', '68000000-0000-0000-0000-000000000001',
   '/pg-moved', '/portfolio', 308);

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
  select count(*)::int from public.redirects where tenant_id = _tid()::uuid $$;

-- ── 1. anon: no privilege on the table (the edge reads KV, never this) ───────
set local role anon;
select _claims(null, null);
select throws_ok(
  $$ select count(*) from public.redirects $$,
  '42501', null, 'anon CANNOT read redirects (no grant — the public path reads the KV snapshot)');
select throws_ok(
  $$ insert into public.redirects (source_path, target_path) values ('/pg-anon', '/about') $$,
  '42501', null, 'anon CANNOT write redirects');

-- ── 2. content_creator: reads, never writes ───────────────────────────────────
reset role;
set local role authenticated;
select _claims('content_creator', _tid());
select is(_n(), 2, 'content_creator reads redirects (staff)');
select throws_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path)
     values (_tid()::uuid, '/pg-cc', '/about') $$,
  '42501', null, 'content_creator CANNOT author a redirect (WITH CHECK)');
update public.redirects set target_path = '/contact' where source_path = '/pg-old';
delete from public.redirects where source_path = '/pg-moved';

-- ── 3. developer: reads, never writes ─────────────────────────────────────────
select _claims('developer', _tid());
select is(_n(), 2, 'developer reads redirects (staff) — and content_creator''s delete was a no-op');
select throws_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path)
     values (_tid()::uuid, '/pg-dev', '/about') $$,
  '42501', null, 'developer CANNOT author a redirect (leads and settings, not SEO)');
update public.redirects set target_path = '/contact' where source_path = '/pg-old';
delete from public.redirects where source_path = '/pg-moved';

-- ── 4. seo: the whole module ───────────────────────────────────────────────────
select _claims('seo', _tid());
select is(
  (select target_path || '/' || version::text from public.redirects where source_path = '/pg-old'),
  '/about/1', 'content_creator and developer updates affected 0 rows (no bump either)');
select is(_n(), 2, 'their deletes were no-ops too');
select lives_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path, status)
     values (_tid()::uuid, '/pg-seo', '/services', 302) $$,
  'seo creates a redirect');
select lives_ok(
  $$ update public.redirects set target_path = '/contact' where source_path = '/pg-old' $$,
  'seo edits a redirect');
select is(
  (select target_path || '/' || version::text from public.redirects where source_path = '/pg-old'),
  '/contact/2', 'the edit landed and bumped version (optimistic lock)');
select lives_ok(
  $$ delete from public.redirects where source_path = '/pg-moved' $$,
  'seo deletes a redirect (§5 "full", not the content default)');
select is(_n(), 2, 'and the row is gone');

-- ── 5. admin: the whole module ─────────────────────────────────────────────────
select _claims('admin', _tid());
select lives_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path)
     values (_tid()::uuid, '/pg-admin', '/about') $$,
  'admin creates a redirect');
select lives_ok(
  $$ delete from public.redirects where source_path = '/pg-seo' $$,
  'admin deletes a redirect');
select is(_n(), 2, 'two rules remain (/pg-old, /pg-admin)');

-- ── 6. other_tenant: sees nothing, writes nothing ──────────────────────────────
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is(_n(), 0, 'other_tenant admin sees none of this tenant''s redirects');
select throws_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path)
     values (_tid()::uuid, '/pg-x', '/about') $$,
  '42501', null, 'other_tenant admin cannot write into this tenant');
update public.redirects set target_path = '/evil' where source_path = '/pg-old';
select _claims('admin', _tid());
select is(
  (select target_path from public.redirects where source_path = '/pg-old'),
  '/contact', 'other_tenant update affected 0 rows');

-- ── 7. the row rules (hold for every role) ─────────────────────────────────────
select throws_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path)
     values (_tid()::uuid, '/pg-old', '/about') $$,
  '23505', null, 'one rule per (tenant, source)');
select throws_ok(
  $$ insert into public.redirects (tenant_id, source_path, target_path, status)
     values (_tid()::uuid, '/pg-307', '/about', 307) $$,
  '23514', null, 'status must be 301, 302 or 308');
-- ── structural ───────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.redirects'::regclass),
  'redirects has RLS enabled AND forced');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'redirects'),
  2, 'exactly the read (staff) and write (admin + seo) policies');

select * from finish();
rollback;
