-- pgTAP: public.sectors + public.clients (migration 0021).
--
-- Same shape as the other content tables (§5 "Categories management" / content authoring):
-- Admin + Content Creator write, SEO / Developer read only, delete is Admin-only
-- (RESTRICTIVE), anon reads what is public. For clients "public" means `visible`, which IS
-- the disclosure permission — a client nobody has cleared is invisible to anon, fail-closed.
--
-- RLS UPDATE/DELETE by a role no policy admits FILTERS (0 rows, no error), so those denials
-- are asserted by reading the value back as a staff role afterwards.

begin;
select plan(21);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- A dedicated tenant, created AFTER the launch tenant so app.default_tenant_id() (the
-- anon fence) keeps resolving to the launch tenant.
insert into public.tenants (id, name) values ('62000000-0000-0000-0000-000000000001', 'TaxT');
insert into public.sectors (id, tenant_id, slug, name, visible) values
  ('62000000-0000-0000-0000-00000000a001', '62000000-0000-0000-0000-000000000001',
   'pg-sector-vis', '{"en":"Visible","ar":"ظاهر"}', true),
  ('62000000-0000-0000-0000-00000000a002', '62000000-0000-0000-0000-000000000001',
   'pg-sector-hid', '{"en":"Hidden","ar":"مخفي"}', false);
insert into public.clients (id, tenant_id, slug, name, visible) values
  ('62000000-0000-0000-0000-00000000b001', '62000000-0000-0000-0000-000000000001',
   'pg-client-vis', '{"en":"Cleared","ar":"مسموح"}', true),
  ('62000000-0000-0000-0000-00000000b002', '62000000-0000-0000-0000-000000000001',
   'pg-client-hid', '{"en":"Uncleared","ar":"غير مسموح"}', false);
-- The launch tenant's rows — the ones anon is fenced to.
insert into public.sectors (tenant_id, slug, name, visible) values
  (app.default_tenant_id(), 'pgtap-sector-vis', '{"en":"V","ar":"ف"}', true),
  (app.default_tenant_id(), 'pgtap-sector-hid', '{"en":"H","ar":"ه"}', false);
insert into public.clients (tenant_id, slug, name, visible) values
  (app.default_tenant_id(), 'pgtap-client-vis', '{"en":"V","ar":"ف"}', true),
  (app.default_tenant_id(), 'pgtap-client-hid', '{"en":"H","ar":"ه"}', false);

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '62000000-0000-0000-0000-000000000001' $$;
create function _n(p_table text) returns int language plpgsql as $$
declare n int;
begin
  execute format('select count(*)::int from public.%I where tenant_id = %L::uuid', p_table, _tid()) into n;
  return n;
end $$;
create function _client_name() returns text language sql as $$
  select name ->> 'en' from public.clients where id = '62000000-0000-0000-0000-00000000b001' $$;
create function _sector_name() returns text language sql as $$
  select name ->> 'en' from public.sectors where id = '62000000-0000-0000-0000-00000000a001' $$;

-- ── read: staff see the whole tenant, hidden rows included ───────────────────
set local role authenticated;
select _claims('content_creator', _tid()); select is(_n('sectors'), 2, 'content_creator reads every sector of its tenant');
select _claims('seo', _tid());             select is(_n('clients'), 2, 'seo reads every client, hidden ones too');
select _claims('developer', _tid());       select is(_n('clients'), 2, 'developer reads every client');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is(_n('sectors') + _n('clients'), 0, 'other_tenant admin sees none of them');

-- ── write: Admin + Content Creator ───────────────────────────────────────────
select _claims('content_creator', _tid());
select lives_ok(
  $$ insert into public.sectors (tenant_id, slug, name) values (_tid()::uuid, 'pg-sector-new', '{"en":"N","ar":"ن"}') $$,
  'content_creator can create a sector');
select lives_ok(
  $$ update public.clients set name = '{"en":"CC edit","ar":"ت"}' where id = '62000000-0000-0000-0000-00000000b001' $$,
  'content_creator can edit a client');
select is(_client_name(), 'CC edit', 'the content_creator edit applied');

select _claims('seo', _tid());
select throws_ok(
  $$ insert into public.clients (tenant_id, slug, name) values (_tid()::uuid, 'pg-seo', '{"en":"S","ar":"س"}') $$,
  '42501', null, 'seo CANNOT create a client (no content authoring)');
update public.sectors set name = '{"en":"SEO edit","ar":"س"}' where id = '62000000-0000-0000-0000-00000000a001';
select _claims('developer', _tid());
update public.sectors set name = '{"en":"DEV edit","ar":"د"}' where id = '62000000-0000-0000-0000-00000000a001';
select throws_ok(
  $$ insert into public.sectors (tenant_id, slug, name) values (_tid()::uuid, 'pg-dev', '{"en":"D","ar":"د"}') $$,
  '42501', null, 'developer CANNOT create a sector');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
update public.sectors set name = '{"en":"XT edit","ar":"خ"}';
select _claims('admin', _tid());
select is(_sector_name(), 'Visible', 'seo, developer and other_tenant updates all affected 0 rows');

-- ── delete: Admin only (RESTRICTIVE) ─────────────────────────────────────────
select _claims('content_creator', _tid());
delete from public.sectors where id = '62000000-0000-0000-0000-00000000a002';
delete from public.clients where id = '62000000-0000-0000-0000-00000000b002';
select _claims('admin', _tid());
select is(_n('sectors') + _n('clients'), 5, 'content_creator deletes are no-ops (3 sectors + 2 clients remain)');
select lives_ok(
  $$ delete from public.clients where id = '62000000-0000-0000-0000-00000000b002' $$,
  'admin can delete a client');
select is(_n('clients'), 1, 'the admin delete removed it');

-- ── anon: visible rows of the launch tenant only ─────────────────────────────
reset role;
set local role anon;
select _claims(null, null);
select is((select count(*)::int from public.sectors where slug like 'pgtap-sector-%'), 1,
  'anon reads the visible sector and not the hidden one');
select is((select count(*)::int from public.clients where slug like 'pgtap-client-%'), 1,
  'anon reads the cleared client and not the uncleared one (visible = disclosure permission)');
select is((select count(*)::int from public.clients where tenant_id = _tid()::uuid), 0,
  'anon is fenced to the launch tenant — nothing of another tenant, visible or not');
select throws_ok(
  $$ insert into public.sectors (slug, name) values ('pg-anon', '{"en":"A","ar":"أ"}') $$,
  '42501', null, 'anon cannot write sectors (no privilege)');
select throws_ok(
  $$ update public.clients set visible = true $$,
  '42501', null, 'anon cannot write clients (no privilege)');

-- ── structural ───────────────────────────────────────────────────────────────
reset role;
select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
    where oid in ('public.sectors'::regclass, 'public.clients'::regclass)),
  'sectors and clients have RLS enabled AND forced');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
      and policyname in ('sectors_delete_admin', 'clients_delete_admin') and permissive = 'RESTRICTIVE'),
  2, 'both carry the RESTRICTIVE admin-only delete gate');
select is(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'visible'),
  'false', 'a new client is hidden by default (fail-closed disclosure)');

select * from finish();
rollback;
