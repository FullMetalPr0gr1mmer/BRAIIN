-- pgTAP: the footer's link columns (Admin v2 E6, navigation heading rows; CLAUDE.md §5
-- "Navigation editor", docs/admin-v2/README.md P-3 and P-9, ui.md AV-29). Run with
-- `supabase test db`.
--
--   • the catalog: is_heading (boolean, not null, false), href nullable, the shape CHECK, the
--     four-column trigger after the release guard, anon's read of the new column, the
--     registry row staging it;
--   • Admin and Content Creator add a column (nav.edit); SEO, Developer and Sales add none;
--     anon writes nothing; another tenant's Admin adds none to this tenant and reads none of
--     its hidden rows;
--   • the shape: a heading has no link, is in the footer, is top level and is never the key
--     link; every other row keeps its link (23514 each);
--   • at most four columns per tenant, hidden ones counted, as an INSERT and as an UPDATE that
--     makes a link a heading (23514 naming navigation_footer_columns_max); a heading's own
--     edits and another tenant's columns are not refused;
--   • a parent is in the writer's own tenant (navigation_parent_fk, review E6-SEC-1): a key
--     check bypasses RLS, so without the composite key an Admin could put a link under
--     another tenant's row by its id; refused as an insert and as an update (23503);
--   • anon reads a visible heading (no link) and a link under it, never a hidden heading;
--   • releases on: a direct write of a heading is refused by the release guard.
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(39);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name, created_at) values
  ('e6000000-0000-0000-0000-000000000001', 'E6 one', '2000-01-01T00:00:00Z'),
  ('e6000000-0000-0000-0000-0000000000ff', 'E6 two', '2000-01-02T00:00:00Z');
insert into auth.users (id, email) values
  ('e6000000-0000-0000-0000-0000000000a1', 'e6-admin@example.test'),
  ('e6000000-0000-0000-0000-0000000000c1', 'e6-creator@example.test'),
  ('e6000000-0000-0000-0000-0000000000e1', 'e6-seo@example.test'),
  ('e6000000-0000-0000-0000-0000000000d1', 'e6-developer@example.test'),
  ('e6000000-0000-0000-0000-0000000000b1', 'e6-sales@example.test'),
  ('e6000000-0000-0000-0000-0000000000f1', 'e6-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e6000000-0000-0000-0000-0000000000a1', 'e6000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('e6000000-0000-0000-0000-0000000000c1', 'e6000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e6000000-0000-0000-0000-0000000000e1', 'e6000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('e6000000-0000-0000-0000-0000000000d1', 'e6000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('e6000000-0000-0000-0000-0000000000b1', 'e6000000-0000-0000-0000-000000000001', 'sales', true, null),
  ('e6000000-0000-0000-0000-0000000000f1', 'e6000000-0000-0000-0000-0000000000ff', 'admin', true, null);
-- T1: a hidden heading (anon must not read it) and a footer link (the one an UPDATE tries to
-- turn into a fifth heading).
insert into public.navigation (id, tenant_id, location, label, href, visible, is_heading, sort_order) values
  ('e6000000-0000-0000-0000-00000000c0d0', 'e6000000-0000-0000-0000-000000000001', 'footer',
   '{"en":"Hidden","ar":"مخفي"}', null, false, true, 9),
  ('e6000000-0000-0000-0000-00000000f001', 'e6000000-0000-0000-0000-000000000001', 'footer',
   '{"en":"About","ar":"من نحن"}', '/about', true, false, 1);
-- T2: a footer link, the parent another tenant's writer must not be able to name.
insert into public.navigation (id, tenant_id, location, label, href, sort_order) values
  ('e6000000-0000-0000-0000-00000000f0f1', 'e6000000-0000-0000-0000-0000000000ff', 'footer',
   '{"en":"Elsewhere","ar":"مكان آخر"}', '/elsewhere', 1);

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
-- The SQLSTATE a statement raises ('' when it runs), in a subtransaction it rolls back.
create function _state(p_sql text) returns text language plpgsql as $f$
begin
  begin
    execute p_sql;
    raise exception using errcode = 'P0004', message = 'ran';
  exception
    when sqlstate 'P0004' then return '';
    when others then return sqlstate;
  end;
end $f$;
-- The message a statement raises ('' when it runs).
create function _message(p_sql text) returns text language plpgsql as $f$
begin
  begin
    execute p_sql;
    raise exception using errcode = 'P0004', message = 'ran';
  exception
    when sqlstate 'P0004' then return '';
    when others then return sqlerrm;
  end;
end $f$;
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;
-- A new footer heading of T1 (another tenant's with p_tid), by the CURRENT token.
create function _heading(p_id text, p_tid text default 'e6000000-0000-0000-0000-000000000001')
returns text language sql as $$
  select _state(format(
    'insert into public.navigation (id, tenant_id, location, label, href, is_heading) '
    'values (%L, %L, ''footer'', ''{"en":"Studio","ar":"الاستوديو"}'', null, true)',
    p_id, p_tid))
$$;
-- The same insert, kept (_state rolls back what it runs): the rows it added.
create function _put(p_id text, p_tid text default 'e6000000-0000-0000-0000-000000000001')
returns int language sql as $$
  select _rows(format(
    'insert into public.navigation (id, tenant_id, location, label, href, is_heading) '
    'values (%L, %L, ''footer'', ''{"en":"Studio","ar":"الاستوديو"}'', null, true)',
    p_id, p_tid))
$$;
grant execute on function _as(text, text, text), _state(text), _message(text), _rows(text),
  _heading(text, text), _put(text, text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select ok(exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'navigation'
                     and column_name = 'is_heading' and data_type = 'boolean'
                     and is_nullable = 'NO' and column_default = 'false'),
  'navigation.is_heading is boolean, not null, default false');
select ok(exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'navigation'
                     and column_name = 'href' and is_nullable = 'YES'),
  'navigation.href is nullable (a heading has no link)');
select ok(exists (select 1 from pg_constraint
                   where conrelid = 'public.navigation'::regclass
                     and conname = 'navigation_heading_shape' and contype = 'c' and convalidated),
  'the shape CHECK exists and is validated');
select is(
  (select string_agg(tg.tgname, ',' order by tg.tgname collate "C")
     from pg_trigger tg
    where tg.tgrelid = 'public.navigation'::regclass and not tg.tgisinternal
      and tg.tgtype & 2 = 2),
  'navigation__release_guard,navigation_actor,navigation_footer_columns,navigation_updated_at,navigation_version',
  'the BEFORE triggers in firing order: the release guard first, the column limit before the stamps');
select ok(has_column_privilege('anon', 'public.navigation', 'is_heading', 'select'),
  'anon reads is_heading as every other column (0011''s table grant)');
select ok(exists (select 1 from pg_constraint
                   where conrelid = 'public.navigation'::regclass
                     and conname = 'navigation_parent_fk' and contype = 'f' and convalidated
                     and confdeltype = 'c'
                     and pg_get_constraintdef(oid) ~ '^FOREIGN KEY \(tenant_id, parent_id\)')
          and (select count(*) from pg_constraint
                where conrelid = 'public.navigation'::regclass and contype = 'f'
                  and confrelid = 'public.navigation'::regclass) = 1,
  'a parent is keyed with its tenant (tenant_id, parent_id), the only key to itself');
select is((select columns from app.release_entities where entity_type = 'nav_item'),
  array['location', 'parent_id', 'label', 'href', 'visible', 'is_key', 'sort_order', 'is_heading'],
  'the registry stages is_heading with the rest of a menu link');

-- ── 2. Who adds a column (nav.edit: Admin, Content Creator) ──────────────────
set local role authenticated;
select _as('e6000000-0000-0000-0000-0000000000a1', 'admin', 'e6000000-0000-0000-0000-000000000001');
select is(_put('e6000000-0000-0000-0000-0000000000c1'), 1, 'admin adds a footer column');
select _as('e6000000-0000-0000-0000-0000000000c1', 'content_creator', 'e6000000-0000-0000-0000-000000000001');
select is(_put('e6000000-0000-0000-0000-0000000000c2'), 1, 'content_creator adds a footer column');
select is(_rows($$ insert into public.navigation (tenant_id, location, label, href, parent_id)
                   values ('e6000000-0000-0000-0000-000000000001', 'footer',
                           '{"en":"Contact","ar":"تواصل"}', '/contact',
                           'e6000000-0000-0000-0000-0000000000c1') $$), 1,
  'content_creator puts a link under a column (its parent)');
select _as('e6000000-0000-0000-0000-0000000000e1', 'seo', 'e6000000-0000-0000-0000-000000000001');
select is(_heading('e6000000-0000-0000-0000-0000000000e9'), '42501', 'seo CANNOT add a column');
select _as('e6000000-0000-0000-0000-0000000000d1', 'developer', 'e6000000-0000-0000-0000-000000000001');
select is(_heading('e6000000-0000-0000-0000-0000000000d9'), '42501',
  'developer CANNOT add a column (no nav.edit)');
select _as('e6000000-0000-0000-0000-0000000000b1', 'sales', 'e6000000-0000-0000-0000-000000000001');
select is(_heading('e6000000-0000-0000-0000-0000000000b9'), '42501', 'sales CANNOT add a column');
select _as('e6000000-0000-0000-0000-0000000000f1', 'admin', 'e6000000-0000-0000-0000-0000000000ff');
select is(_heading('e6000000-0000-0000-0000-0000000000f9'), '42501',
  'another tenant''s admin CANNOT add a column to this tenant (the tenant predicate)');
select is((select count(*)::int from public.navigation
            where tenant_id = 'e6000000-0000-0000-0000-000000000001'), 0,
  'another tenant''s admin reads none of this tenant''s rows');
select is(_rows($$ update public.navigation set visible = true
                   where id = 'e6000000-0000-0000-0000-00000000c0d0' $$), 0,
  'another tenant''s admin CANNOT show this tenant''s hidden column');

-- ── 3. The shape ─────────────────────────────────────────────────────────────
select _as('e6000000-0000-0000-0000-0000000000a1', 'admin', 'e6000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.navigation (tenant_id, location, label, href, is_heading)
                    values ('e6000000-0000-0000-0000-000000000001', 'footer',
                            '{"en":"A","ar":"أ"}', '/about', true) $$), '23514',
  'a heading CANNOT carry a link');
select is(_state($$ insert into public.navigation (tenant_id, location, label, href, is_heading)
                    values ('e6000000-0000-0000-0000-000000000001', 'header',
                            '{"en":"A","ar":"أ"}', null, true) $$), '23514',
  'a heading CANNOT be in the header');
select is(_state($$ insert into public.navigation (tenant_id, location, label, href, is_heading, parent_id)
                    values ('e6000000-0000-0000-0000-000000000001', 'footer',
                            '{"en":"A","ar":"أ"}', null, true,
                            'e6000000-0000-0000-0000-0000000000c1') $$), '23514',
  'a heading CANNOT sit under another row');
select is(_state($$ insert into public.navigation (tenant_id, location, label, href, is_heading, is_key)
                    values ('e6000000-0000-0000-0000-000000000001', 'footer',
                            '{"en":"A","ar":"أ"}', null, true, true) $$), '23514',
  'a heading CANNOT be the key link');
select is(_state($$ insert into public.navigation (tenant_id, location, label, href)
                    values ('e6000000-0000-0000-0000-000000000001', 'footer',
                            '{"en":"A","ar":"أ"}', null) $$), '23514',
  'a link CANNOT lose its href');
select is(_state($$ update public.navigation set href = null
                    where id = 'e6000000-0000-0000-0000-00000000f001' $$), '23514',
  'a stored link CANNOT be cleared of its href');
select is(_state($$ update public.navigation set location = 'header'
                    where id = 'e6000000-0000-0000-0000-0000000000c1' $$), '23514',
  'a heading CANNOT move to the header');

-- ── 3b. A parent of this tenant only ─────────────────────────────────────────
select is(_state($$ insert into public.navigation (tenant_id, location, label, href, parent_id)
                    values ('e6000000-0000-0000-0000-000000000001', 'footer',
                            '{"en":"A","ar":"أ"}', '/a',
                            'e6000000-0000-0000-0000-00000000f0f1') $$), '23503',
  'admin CANNOT put a link under another tenant''s row (the key checks the tenant)');
select ok(_message($$ insert into public.navigation (tenant_id, location, label, href, parent_id)
                      values ('e6000000-0000-0000-0000-000000000001', 'footer',
                              '{"en":"A","ar":"أ"}', '/a',
                              'e6000000-0000-0000-0000-00000000f0f1') $$)
          ~ 'navigation_parent_fk',
  'the refusal names navigation_parent_fk (the Worker''s 422 on parentId)');
select is(_state($$ update public.navigation set parent_id = 'e6000000-0000-0000-0000-00000000f0f1'
                    where id = 'e6000000-0000-0000-0000-00000000f001' $$), '23503',
  'admin CANNOT move a stored link under another tenant''s row');

-- ── 4. At most four columns per tenant (hidden ones counted) ─────────────────
-- T1 holds three: the hidden one, admin's and content_creator's.
select is(_put('e6000000-0000-0000-0000-0000000000c4'), 1, 'the fourth column is taken');
select is(_heading('e6000000-0000-0000-0000-0000000000c5'), '23514',
  'a fifth column is refused (the hidden one counts)');
select ok(_message($$ insert into public.navigation (tenant_id, location, label, href, is_heading)
                      values ('e6000000-0000-0000-0000-000000000001', 'footer',
                              '{"en":"Five","ar":"خمسة"}', null, true) $$)
          ~ 'navigation_footer_columns_max',
  'the refusal names navigation_footer_columns_max (the Worker''s 422 on the field)');
select is(_state($$ update public.navigation set href = null, is_heading = true
                    where id = 'e6000000-0000-0000-0000-00000000f001' $$), '23514',
  'turning a link into a fifth column is refused');
select is(_rows($$ update public.navigation set label = '{"en":"Studio","ar":"الاستوديو"}',
                          visible = false, sort_order = 3
                   where id = 'e6000000-0000-0000-0000-0000000000c1' $$), 1,
  'a column''s own edits pass at four (its title, the eye, the order)');
select is(_rows($$ delete from public.navigation where id = 'e6000000-0000-0000-0000-0000000000c4' $$), 1,
  'admin removes a column');
select is(_put('e6000000-0000-0000-0000-0000000000c5'), 1,
  'with one removed, a fourth is taken again');
select _as('e6000000-0000-0000-0000-0000000000f1', 'admin', 'e6000000-0000-0000-0000-0000000000ff');
select is(_put('e6000000-0000-0000-0000-0000000000f2', 'e6000000-0000-0000-0000-0000000000ff'), 1,
  'another tenant''s first column is not counted against this tenant''s four');

-- ── 5. What anon reads ───────────────────────────────────────────────────────
reset role;
update public.navigation set visible = true where id = 'e6000000-0000-0000-0000-0000000000c1';
set local role anon;
select _as(null, null, null);
select is((select format('%s %s', is_heading, coalesce(href, 'none'))
             from public.navigation where id = 'e6000000-0000-0000-0000-0000000000c1'),
  't none', 'anon reads a visible column: a heading with no link');
select is((select count(*)::int from public.navigation
            where parent_id = 'e6000000-0000-0000-0000-0000000000c1'), 1,
  'anon reads the link under it');
select is((select count(*)::int from public.navigation
            where id = 'e6000000-0000-0000-0000-00000000c0d0'), 0,
  'anon CANNOT read a hidden column');
select is(_heading('e6000000-0000-0000-0000-0000000000a9'), '42501', 'anon CANNOT add a column');
reset role;

-- ── 6. Releases on: the guard refuses a direct write ─────────────────────────
insert into app.release_tenants (tenant_id) values ('e6000000-0000-0000-0000-000000000001');
set local role authenticated;
select _as('e6000000-0000-0000-0000-0000000000a1', 'admin', 'e6000000-0000-0000-0000-000000000001');
select is(_heading('e6000000-0000-0000-0000-0000000000c6'), '42501',
  'releases on: admin CANNOT add a column directly (the release guard)');
reset role;

select * from finish();
rollback;
