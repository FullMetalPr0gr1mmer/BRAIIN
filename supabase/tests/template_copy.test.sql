-- pgTAP: the template pages' shared text (Admin v2 E3, public.template_copy; CLAUDE.md §5
-- "Pages & sections", docs/admin-v2/README.md the E3 row and P-3). Run with `supabase test db`.
--
--   • the catalog: RLS forced, the exact policy set, the grants (anon reads the two templates
--     and the tenant, staff select, insert and update, never DELETE; nobody TRUNCATEs), the
--     registry row, the guard first among the BEFORE triggers, the helper;
--   • Admin and Content Creator add and change the row (pages.write); SEO, Developer and Sales
--     add and change nothing; every CMS role reads it (registry contract #1), Sales none;
--   • anon reads the launch tenant's two templates and nothing else of the row, never another
--     tenant's, and writes nothing;
--   • another tenant's Admin reads and writes none of this tenant's row;
--   • stale tokens (a demoted Content Creator, a deactivated Admin, a locked Admin) add and
--     change nothing (the RESTRICTIVE live checks, INSERT and UPDATE);
--   • the CHECKs: only the template's catalogue keys, a line is English AND Arabic, plain, not
--     blank, at most 300 characters, an accent is a word range (23514 each);
--   • history: every save is a content_versions row under 'template_copy';
--   • releases on: a direct write is refused by the release guard.
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(43);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- T3 ('…ee') has no row: a live Content Creator's first save there is an INSERT.
insert into public.tenants (id, name, created_at) values
  ('e3000000-0000-0000-0000-000000000001', 'E3 one', '2000-01-01T00:00:00Z'),
  ('e3000000-0000-0000-0000-0000000000ff', 'E3 two', '2000-01-02T00:00:00Z'),
  ('e3000000-0000-0000-0000-0000000000ee', 'E3 three', '2000-01-03T00:00:00Z');
insert into auth.users (id, email) values
  ('e3000000-0000-0000-0000-0000000000a1', 'e3-admin@example.test'),
  ('e3000000-0000-0000-0000-0000000000c1', 'e3-creator@example.test'),
  ('e3000000-0000-0000-0000-0000000000e1', 'e3-seo@example.test'),
  ('e3000000-0000-0000-0000-0000000000d1', 'e3-developer@example.test'),
  ('e3000000-0000-0000-0000-0000000000b1', 'e3-sales@example.test'),
  ('e3000000-0000-0000-0000-0000000000c2', 'e3-demoted@example.test'),
  ('e3000000-0000-0000-0000-0000000000a3', 'e3-inactive@example.test'),
  ('e3000000-0000-0000-0000-0000000000a4', 'e3-locked@example.test'),
  ('e3000000-0000-0000-0000-0000000000f1', 'e3-other@example.test'),
  ('e3000000-0000-0000-0000-0000000000c3', 'e3-creator-three@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e3000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('e3000000-0000-0000-0000-0000000000c1', 'e3000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e3000000-0000-0000-0000-0000000000e1', 'e3000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('e3000000-0000-0000-0000-0000000000d1', 'e3000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('e3000000-0000-0000-0000-0000000000b1', 'e3000000-0000-0000-0000-000000000001', 'sales', true, null),
  -- Stale: each token below still says content_creator or admin.
  ('e3000000-0000-0000-0000-0000000000c2', 'e3000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('e3000000-0000-0000-0000-0000000000a3', 'e3000000-0000-0000-0000-000000000001', 'admin', false, null),
  ('e3000000-0000-0000-0000-0000000000a4', 'e3000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes'),
  ('e3000000-0000-0000-0000-0000000000f1', 'e3000000-0000-0000-0000-0000000000ff', 'admin', true, null),
  ('e3000000-0000-0000-0000-0000000000c3', 'e3000000-0000-0000-0000-0000000000ee', 'content_creator', true, null);
-- The other tenant's row, with a line anon must never see.
insert into public.template_copy (tenant_id, service)
  values ('e3000000-0000-0000-0000-0000000000ff', '{"fab":{"en":"Other","ar":"آخر"}}');

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
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;
-- T1's rows as the CURRENT role.
create function _seen() returns int language sql as $$
  select count(*)::int from public.template_copy where tenant_id = 'e3000000-0000-0000-0000-000000000001'
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
-- T1's rows as a signed-in token of the given role.
create function _seen_as(p_sub text, p_role text) returns int language plpgsql as $f$
begin
  perform _as(p_sub, p_role, 'e3000000-0000-0000-0000-000000000001');
  return _seen();
end $f$;
-- One UPDATE of T1's row: its SQLSTATE ('' when it runs).
create function _set(p_assign text) returns text language sql as $$
  select _state(format('update public.template_copy set %s where tenant_id = %L',
                       p_assign, 'e3000000-0000-0000-0000-000000000001'))
$$;
grant execute on function _as(text, text, text), _rows(text), _seen(), _state(text),
  _seen_as(text, text), _set(text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.template_copy'::regclass),
  'template_copy is ENABLE + FORCE row level security');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', '
                     order by policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename = 'template_copy'),
  'template_copy_insert INSERT PERMISSIVE {authenticated}, '
  || 'template_copy_live_insert INSERT RESTRICTIVE {authenticated}, '
  || 'template_copy_live_update UPDATE RESTRICTIVE {authenticated}, '
  || 'template_copy_read SELECT PERMISSIVE {public}, '
  || 'template_copy_staff_columns SELECT RESTRICTIVE {authenticated}, '
  || 'template_copy_update UPDATE PERMISSIVE {authenticated}',
  'the policies: the tenant read, the non-staff block, pages.write by the token and live');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.template_copy'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', a.attrelid, a.attnum, 'select')),
  'project,service,tenant_id',
  'anon may read the two templates and the tenant, no other column');
select ok(not has_table_privilege('anon', 'public.template_copy', 'select')
          and not has_any_column_privilege('anon', 'public.template_copy', 'insert, update, references'),
  'anon holds no table-level SELECT and no write');
select ok(has_table_privilege('authenticated', 'public.template_copy', 'select, insert, update')
          and not has_table_privilege('authenticated', 'public.template_copy', 'delete')
          and not has_table_privilege('authenticated', 'public.template_copy', 'truncate')
          and not has_table_privilege('service_role', 'public.template_copy', 'truncate')
          and has_table_privilege('service_role', 'public.template_copy', 'select, insert, update, delete'),
  'staff select, insert and update, never DELETE; the service role all four; nobody TRUNCATEs');
select ok(exists (select 1 from app.release_entities
                   where entity_type = 'template_copy' and table_name = 'template_copy'
                     and key_column = 'tenant_id' and area = 'pages'
                     and author_roles = '{admin,content_creator}' and delete_roles = '{}'
                     and columns = '{service,project}' and exempt_columns = '{}'),
  'the registry row: staged under pages, authored by Admin and Content Creator, never removed');
select is(
  (select tgname::text from pg_trigger
    where tgrelid = 'public.template_copy'::regclass and not tgisinternal
      and tgtype & 1 = 1 and tgtype & 2 = 2
    order by tgname collate "C" limit 1),
  'template_copy__release_guard', 'the release guard is the first BEFORE trigger');
select ok(app.role_edits_pages('admin') and app.role_edits_pages('content_creator')
          and not app.role_edits_pages('developer') and not app.role_edits_pages('seo')
          and not app.role_edits_pages('sales'),
  'app.role_edits_pages answers the holders of pages.write: Admin and Content Creator');
select is((select proconfig from pg_proc where oid = 'app.role_edits_pages(text)'::regprocedure),
  array['search_path=""'], 'app.role_edits_pages keeps its search_path pin');

-- ── 2. Admin and Content Creator write; every CMS role reads ─────────────────
set local role authenticated;
select _as('e3000000-0000-0000-0000-0000000000a1', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ insert into public.template_copy (tenant_id, service)
                   values ('e3000000-0000-0000-0000-000000000001',
                           '{"seeCase":{"en":"Read the story","ar":"اقرأ القصة"}}') $$), 1,
  'admin adds the row');
select is((select format('%s/%s/%s', version, service -> 'seeCase' ->> 'en', project)
             from public.template_copy
            where tenant_id = 'e3000000-0000-0000-0000-000000000001'), '1/Read the story/{}',
  'a first save: version 1, the line stored, the other template as built');
select _as('e3000000-0000-0000-0000-0000000000c1', 'content_creator', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy
                     set project = '{"nextProject":{"en":"Up next","ar":"التالي"},"breakdownHeadingAccent":{"en":{"from":1}}}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$), 1,
  'content_creator changes the row (pages.write)');
select is((select version from public.template_copy
            where tenant_id = 'e3000000-0000-0000-0000-000000000001'), 2,
  'each save moves the version');
select _as('e3000000-0000-0000-0000-0000000000e1', 'seo', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$), 0,
  'seo CANNOT change the shared text');
select _as('e3000000-0000-0000-0000-0000000000d1', 'developer', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$), 0,
  'developer CANNOT change the shared text (no content authoring)');
select _as('e3000000-0000-0000-0000-0000000000b1', 'sales', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$)
          + _seen(), 0,
  'sales reads and changes nothing (the non-staff block)');
select _as('e3000000-0000-0000-0000-0000000000a1', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_state($$ delete from public.template_copy
                    where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$), '42501',
  'nobody signed in deletes the row (no grant)');
select is(_seen_as('e3000000-0000-0000-0000-0000000000a1', 'admin')
          + _seen_as('e3000000-0000-0000-0000-0000000000c1', 'content_creator')
          + _seen_as('e3000000-0000-0000-0000-0000000000e1', 'seo')
          + _seen_as('e3000000-0000-0000-0000-0000000000d1', 'developer'),
  4, 'admin, content_creator, seo and developer each read the row (registry contract #1)');
select _as('e3000000-0000-0000-0000-0000000000a1', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.template_copy (tenant_id)
                    values ('e3000000-0000-0000-0000-0000000000ff') $$), '42501',
  'admin CANNOT add a row for another tenant (the tenant predicate)');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-0000000000ff' $$), 0,
  'admin CANNOT change another tenant''s row');
-- T1's row exists, so an RLS refusal (42501) is told apart from the key's (23505).
select _as('e3000000-0000-0000-0000-0000000000d1', 'developer', 'e3000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.template_copy (tenant_id)
                    values ('e3000000-0000-0000-0000-000000000001') $$), '42501',
  'developer CANNOT add a row (refused by RLS before the key)');
select _as('e3000000-0000-0000-0000-0000000000e1', 'seo', 'e3000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.template_copy (tenant_id)
                    values ('e3000000-0000-0000-0000-000000000001') $$), '42501',
  'seo CANNOT add a row (refused by RLS before the key)');
select _as('e3000000-0000-0000-0000-0000000000b1', 'sales', 'e3000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.template_copy (tenant_id)
                    values ('e3000000-0000-0000-0000-000000000001') $$), '42501',
  'sales CANNOT add a row (refused by RLS before the key)');
select _as('e3000000-0000-0000-0000-0000000000c3', 'content_creator', 'e3000000-0000-0000-0000-0000000000ee');
select is(_rows($$ insert into public.template_copy (tenant_id)
                   values ('e3000000-0000-0000-0000-0000000000ee') $$), 1,
  'a live content_creator adds its own tenant''s first row (pages.write, by the token and live)');

-- ── 3. Stale tokens and another tenant ───────────────────────────────────────
select _as('e3000000-0000-0000-0000-0000000000c2', 'content_creator', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$)
          || _state($$ insert into public.template_copy (tenant_id)
                       values ('e3000000-0000-0000-0000-000000000001') $$), '042501',
  'a demoted content_creator''s token changes and adds nothing (live checks)');
select _as('e3000000-0000-0000-0000-0000000000a3', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$)
          || _state($$ insert into public.template_copy (tenant_id)
                       values ('e3000000-0000-0000-0000-000000000001') $$), '042501',
  'a deactivated admin''s token changes and adds nothing (live checks)');
select _as('e3000000-0000-0000-0000-0000000000a4', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.template_copy set service = '{}'
                   where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$)
          || _state($$ insert into public.template_copy (tenant_id)
                       values ('e3000000-0000-0000-0000-000000000001') $$), '042501',
  'a locked admin''s token changes and adds nothing (live checks)');
select _as('e3000000-0000-0000-0000-0000000000f1', 'admin', 'e3000000-0000-0000-0000-0000000000ff');
select is(_seen() + _rows($$ update public.template_copy set service = '{}'
                             where tenant_id = 'e3000000-0000-0000-0000-000000000001' $$), 0,
  'other_tenant reads and changes none of this tenant''s row');

-- ── 4. The CHECKs ────────────────────────────────────────────────────────────
-- _set runs each UPDATE in a subtransaction it rolls back: '' means the row would take it.
select _as('e3000000-0000-0000-0000-0000000000a1', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_set($$ service = '{"nope":{"en":"a","ar":"ب"}}' $$)
          || _set($$ project = '{"seeCase":{"en":"a","ar":"ب"}}' $$)
          || _set($$ service = '{"confidential":{"en":"a","ar":"ب"}}' $$),
  '235142351423514', 'only the template''s own catalogue keys (another template''s and "confidential" refused)');
select is(_set($$ service = '{"seeCase":{"en":"Only English"}}' $$)
          || _set($$ service = '{"seeCase":{"en":"a","ar":"  "}}' $$)
          || _set($$ service = '{"seeCase":{"en":"a","ar":"ب","note":"x"}}' $$)
          || _set($$ service = '{"seeCase":"a"}' $$),
  '23514235142351423514', 'a line is exactly English and Arabic, neither blank');
select is(_set($$ service = '{"seeCase":{"en":"<b>a</b>","ar":"ب"}}' $$)
          || _set($$ service = '{"seeCase":{"en":"a\nb","ar":"ب"}}' $$)
          || _set(format('service = %L', jsonb_build_object('seeCase', jsonb_build_object('en', repeat('a', 301), 'ar', 'ب')))),
  '235142351423514', 'plain text: no markup, no line break, at most 300 characters');
select is(_set($$ service = '{"valueHeadingAccent":{"en":{"from":3,"to":2}}}' $$)
          || _set($$ service = '{"valueHeadingAccent":{"en":{"from":31}}}' $$)
          || _set($$ service = '{"valueHeadingAccent":{"fr":{"from":1}}}' $$)
          || _set($$ service = '{"valueHeadingAccent":{"en":{"from":1.5}}}' $$),
  '23514235142351423514', 'an accent is a word range per language, in order and in bounds');
select is(_set($$ service = '{"valueHeading":{"en":"Why us","ar":"ليش نحن"},"valueHeadingAccent":{"en":{"from":1},"ar":{"from":1,"to":2}}}' $$),
  '', 'a heading and its accent are taken');
select is(_set($$ service = '[]' $$) || _set($$ project = '"text"' $$),
  '2351423514', 'a template is an object');
select is(_set($$ service = '{}', project = '{}' $$), '',
  'both templates as built are taken');
reset role;

select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'template_copy' and entity_id = 'e3000000-0000-0000-0000-000000000001'),
  2, 'every save is a history row under template_copy, keyed by the tenant');

-- ── 5. anon ──────────────────────────────────────────────────────────────────
set local role anon;
select _as(null, null, null);
select is((select format('%s/%s', service -> 'seeCase' ->> 'en', project -> 'nextProject' ->> 'en')
             from public.template_copy),
  'Read the story/Up next', 'anon reads the launch tenant''s two templates, never another tenant''s');
select is((select count(*)::int from public.template_copy), 1,
  'anon reads one row: its own tenant''s');
select is(_state($$ select version from public.template_copy $$), '42501',
  'anon CANNOT read the version (no column grant)');
select is(_state($$ select updated_by from public.template_copy $$), '42501',
  'anon CANNOT read who saved it');
select is(_state($$ update public.template_copy set service = '{}' $$), '42501',
  'anon CANNOT change the shared text');
select is(_state($$ insert into public.template_copy (tenant_id) values ('e3000000-0000-0000-0000-000000000001') $$),
  '42501', 'anon CANNOT add a row');
reset role;

-- ── 6. Releases on: the guard refuses a direct write ─────────────────────────
insert into app.release_tenants (tenant_id) values ('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select _as('e3000000-0000-0000-0000-0000000000a1', 'admin', 'e3000000-0000-0000-0000-000000000001');
select is(_set($$ service = '{}' $$), '42501',
  'releases on: admin CANNOT write the shared text directly (the release guard)');
reset role;

select * from finish();
rollback;
