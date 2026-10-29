-- pgTAP: the site's appearance settings (Admin v2 E5, public.site_appearance; CLAUDE.md §5
-- "Theme editor", docs/admin-v2/README.md P-2, P-3 and P-9). Run with `supabase test db`.
--
--   • the catalog: RLS forced, the exact policy set, the grants (anon reads the header's options
--     and the tenant, staff select, insert and update, never DELETE; nobody TRUNCATEs), the
--     registry row, the guard first among the BEFORE triggers;
--   • Admin and Developer add and change the row (theme.edit); Content Creator, SEO and Sales
--     change nothing; every CMS role reads it (registry contract #1), Sales none;
--   • anon reads the launch tenant's options and nothing else of the row, never another
--     tenant's, and writes nothing;
--   • another tenant's Admin reads and writes none of this tenant's row;
--   • stale tokens (a demoted Developer, a deactivated Admin, a locked Admin) change nothing
--     (the RESTRICTIVE live check);
--   • the CHECKs: every bucket is a closed set; the button needs its words and its link; its
--     link is a site path or an https link; its words are plain bilingual text; a bar that
--     stays see-through after the hero takes the darkest tint (23514 each);
--   • history: every save is a content_versions row under 'site_appearance';
--   • releases on: a direct write is refused by the release guard.
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(45);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name, created_at) values
  ('e5000000-0000-0000-0000-000000000001', 'E5 one', '2000-01-01T00:00:00Z'),
  ('e5000000-0000-0000-0000-0000000000ff', 'E5 two', '2000-01-02T00:00:00Z');
insert into auth.users (id, email) values
  ('e5000000-0000-0000-0000-0000000000a1', 'e5-admin@example.test'),
  ('e5000000-0000-0000-0000-0000000000c1', 'e5-creator@example.test'),
  ('e5000000-0000-0000-0000-0000000000e1', 'e5-seo@example.test'),
  ('e5000000-0000-0000-0000-0000000000d1', 'e5-developer@example.test'),
  ('e5000000-0000-0000-0000-0000000000b1', 'e5-sales@example.test'),
  ('e5000000-0000-0000-0000-0000000000d2', 'e5-demoted@example.test'),
  ('e5000000-0000-0000-0000-0000000000a3', 'e5-inactive@example.test'),
  ('e5000000-0000-0000-0000-0000000000a4', 'e5-locked@example.test'),
  ('e5000000-0000-0000-0000-0000000000f1', 'e5-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e5000000-0000-0000-0000-0000000000a1', 'e5000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('e5000000-0000-0000-0000-0000000000c1', 'e5000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e5000000-0000-0000-0000-0000000000e1', 'e5000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('e5000000-0000-0000-0000-0000000000d1', 'e5000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('e5000000-0000-0000-0000-0000000000b1', 'e5000000-0000-0000-0000-000000000001', 'sales', true, null),
  -- Stale: each token below still says developer or admin.
  ('e5000000-0000-0000-0000-0000000000d2', 'e5000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e5000000-0000-0000-0000-0000000000a3', 'e5000000-0000-0000-0000-000000000001', 'admin', false, null),
  ('e5000000-0000-0000-0000-0000000000a4', 'e5000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes'),
  ('e5000000-0000-0000-0000-0000000000f1', 'e5000000-0000-0000-0000-0000000000ff', 'admin', true, null);
-- The other tenant's row, with a setting anon must never see.
insert into public.site_appearance (tenant_id, header_logo_size)
  values ('e5000000-0000-0000-0000-0000000000ff', 's');

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
  select count(*)::int from public.site_appearance where tenant_id = 'e5000000-0000-0000-0000-000000000001'
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
  perform _as(p_sub, p_role, 'e5000000-0000-0000-0000-000000000001');
  return _seen();
end $f$;
-- One UPDATE of T1's row: its SQLSTATE ('' when it runs).
create function _set(p_assign text) returns text language sql as $$
  select _state(format('update public.site_appearance set %s where tenant_id = %L',
                       p_assign, 'e5000000-0000-0000-0000-000000000001'))
$$;
grant execute on function _as(text, text, text), _rows(text), _seen(), _state(text),
  _seen_as(text, text), _set(text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.site_appearance'::regclass),
  'site_appearance is ENABLE + FORCE row level security');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', '
                     order by policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename = 'site_appearance'),
  'site_appearance_insert INSERT PERMISSIVE {authenticated}, '
  || 'site_appearance_live_insert INSERT RESTRICTIVE {authenticated}, '
  || 'site_appearance_live_update UPDATE RESTRICTIVE {authenticated}, '
  || 'site_appearance_read SELECT PERMISSIVE {public}, '
  || 'site_appearance_staff_columns SELECT RESTRICTIVE {authenticated}, '
  || 'site_appearance_update UPDATE PERMISSIVE {authenticated}',
  'the policies: the tenant read, the non-staff block, theme.edit by the token and live');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', a.attrelid, a.attnum, 'select')),
  'header_blur,header_cta_href,header_cta_label,header_cta_show,header_hide_on_scroll,'
  || 'header_logo_position,header_logo_size,header_menu_align,header_mobile_menu,'
  || 'header_solid_after_hero,header_sticky,header_tint,tenant_id',
  'anon may read the header''s options and the tenant, no other column');
select ok(not has_table_privilege('anon', 'public.site_appearance', 'select')
          and not has_any_column_privilege('anon', 'public.site_appearance', 'insert, update, references'),
  'anon holds no table-level SELECT and no write');
select ok(has_table_privilege('authenticated', 'public.site_appearance', 'select, insert, update')
          and not has_table_privilege('authenticated', 'public.site_appearance', 'delete')
          and not has_table_privilege('authenticated', 'public.site_appearance', 'truncate')
          and not has_table_privilege('service_role', 'public.site_appearance', 'truncate')
          and has_table_privilege('service_role', 'public.site_appearance', 'select, insert, update, delete'),
  'staff select, insert and update, never DELETE; the service role all four; nobody TRUNCATEs');
select ok(exists (select 1 from app.release_entities
                   where entity_type = 'site_appearance' and table_name = 'site_appearance'
                     and key_column = 'tenant_id' and area = 'appearance'
                     and author_roles = '{admin,developer}' and delete_roles = '{}'
                     and 'header_tint' = any (columns) and 'header_cta_href' = any (columns)
                     and cardinality(columns) = 12 and exempt_columns = '{}'),
  'the registry row: staged under appearance, authored by Admin and Developer, never removed');
select is(
  (select tgname::text from pg_trigger
    where tgrelid = 'public.site_appearance'::regclass and not tgisinternal
      and tgtype & 1 = 1 and tgtype & 2 = 2
    order by tgname collate "C" limit 1),
  'site_appearance__release_guard', 'the release guard is the first BEFORE trigger');
select ok(app.role_edits_theme('admin') and app.role_edits_theme('developer')
          and not app.role_edits_theme('content_creator') and not app.role_edits_theme('seo')
          and not app.role_edits_theme('sales'),
  'app.role_edits_theme answers the holders of theme.edit: Admin and Developer');

-- ── 2. Admin and Developer write; every CMS role reads ───────────────────────
set local role authenticated;
select _as('e5000000-0000-0000-0000-0000000000a1', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ insert into public.site_appearance (tenant_id, header_logo_size)
                   values ('e5000000-0000-0000-0000-000000000001', 'l') $$), 1,
  'admin adds the row');
select is((select format('%s/%s/%s/%s', version, header_logo_size, header_menu_align, header_tint)
             from public.site_appearance
            where tenant_id = 'e5000000-0000-0000-0000-000000000001'), '1/l/center/none',
  'a first save: version 1, the option set, every other option the header as built');
select is(_rows($$ update public.site_appearance
                     set header_cta_show = true,
                         header_cta_label = '{"en":"Start a project","ar":"ابدأ مشروعك"}',
                         header_cta_href = '/contact#inquiry'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 1,
  'admin shows a button with its words and its link');
select _as('e5000000-0000-0000-0000-0000000000d1', 'developer', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_menu_align = 'end'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 1,
  'developer changes the row (theme.edit)');
select is((select version from public.site_appearance
            where tenant_id = 'e5000000-0000-0000-0000-000000000001'), 3,
  'each save moves the version');
select _as('e5000000-0000-0000-0000-0000000000c1', 'content_creator', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_logo_size = 's'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 0,
  'content_creator CANNOT change the header''s options (nav.edit is the menu, not the bar)');
select _as('e5000000-0000-0000-0000-0000000000e1', 'seo', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_logo_size = 's'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 0,
  'seo CANNOT change the header''s options');
select _as('e5000000-0000-0000-0000-0000000000b1', 'sales', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_logo_size = 's'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$)
          + _seen(), 0,
  'sales reads and changes nothing (the non-staff block)');
select _as('e5000000-0000-0000-0000-0000000000c1', 'content_creator', 'e5000000-0000-0000-0000-0000000000ff');
select is(_state($$ insert into public.site_appearance (tenant_id)
                    values ('e5000000-0000-0000-0000-0000000000ff') $$), '42501',
  'content_creator CANNOT add a row, even its own tenant''s first one');
select _as('e5000000-0000-0000-0000-0000000000a1', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_state($$ delete from public.site_appearance
                    where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), '42501',
  'nobody signed in deletes the row (no grant)');
select is(_seen_as('e5000000-0000-0000-0000-0000000000a1', 'admin')
          + _seen_as('e5000000-0000-0000-0000-0000000000c1', 'content_creator')
          + _seen_as('e5000000-0000-0000-0000-0000000000e1', 'seo')
          + _seen_as('e5000000-0000-0000-0000-0000000000d1', 'developer'),
  4, 'admin, content_creator, seo and developer each read the row (registry contract #1)');
select _as('e5000000-0000-0000-0000-0000000000a1', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.site_appearance (tenant_id)
                    values ('e5000000-0000-0000-0000-0000000000ff') $$), '42501',
  'admin CANNOT add a row for another tenant (the tenant predicate)');
select is(_rows($$ update public.site_appearance set header_logo_size = 'm'
                   where tenant_id = 'e5000000-0000-0000-0000-0000000000ff' $$), 0,
  'admin CANNOT change another tenant''s row');

-- ── 3. Stale tokens and another tenant ───────────────────────────────────────
select _as('e5000000-0000-0000-0000-0000000000d2', 'developer', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_logo_size = 's'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 0,
  'a demoted developer''s token changes nothing (live check)');
select _as('e5000000-0000-0000-0000-0000000000a3', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_logo_size = 's'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 0,
  'a deactivated admin''s token changes nothing (live check)');
select _as('e5000000-0000-0000-0000-0000000000a4', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set header_logo_size = 's'
                   where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 0,
  'a locked admin''s token changes nothing (live check)');
select _as('e5000000-0000-0000-0000-0000000000f1', 'admin', 'e5000000-0000-0000-0000-0000000000ff');
select is(_seen() + _rows($$ update public.site_appearance set header_logo_size = 's'
                             where tenant_id = 'e5000000-0000-0000-0000-000000000001' $$), 0,
  'other_tenant reads and changes none of this tenant''s row');

-- ── 4. The CHECKs ────────────────────────────────────────────────────────────
-- _set runs each UPDATE in a subtransaction it rolls back: '' means the row would take it.
select _as('e5000000-0000-0000-0000-0000000000a1', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_set($$ header_logo_size = 'xl' $$) || _set($$ header_logo_position = 'end' $$)
          || _set($$ header_menu_align = 'justify' $$) || _set($$ header_tint = 'black' $$)
          || _set($$ header_blur = 'max' $$) || _set($$ header_mobile_menu = 'sheet' $$),
  '235142351423514235142351423514', 'every bucket is a closed set (23514 for each value outside it)');
select is(_set($$ header_cta_label = null $$), '23514',
  'a button that shows keeps its words');
select is(_set($$ header_cta_href = null $$), '23514',
  'a button that shows keeps its link');
select is(_set($$ header_cta_href = '//evil.example' $$), '23514',
  'a protocol-relative link is refused (it leaves the site)');
select is(_set($$ header_cta_href = 'javascript:alert(1)' $$) || _set($$ header_cta_href = 'http://plain.example' $$),
  '2351423514', 'a link that is neither a site path nor https is refused');
select is(_set($$ header_cta_href = '/\evil.example' $$) || _set($$ header_cta_href = '/a b' $$)
          || _set($$ header_cta_href = '/a"onmouseover=x' $$),
  '235142351423514', 'a backslash, a space or a quote in the link is refused');
select is(_set($$ header_cta_href = 'https://calendly.example/studio' $$), '',
  'an https link is taken');
select is(_set($$ header_cta_label = '{"en":"Only English"}' $$)
          || _set($$ header_cta_label = '{"en":" Padded","ar":"ب"}' $$)
          || _set(format('header_cta_label = %L', jsonb_build_object('en', repeat('a', 41), 'ar', 'ب'))),
  '235142351423514', 'the button''s words: both languages, trimmed, at most 40 characters');
select is(_set($$ header_solid_after_hero = false $$), '23514',
  'a sticky bar that stays see-through after the hero, with no tint, is refused (the tint''s minimum)');
select is(_set($$ header_solid_after_hero = false, header_tint = 'medium' $$), '23514',
  'a medium tint is not enough for a bar that stays see-through');
select is(_set($$ header_solid_after_hero = false, header_tint = 'dark' $$), '',
  'the darkest tint is');
select is(_set($$ header_sticky = false, header_solid_after_hero = false, header_tint = 'none' $$), '',
  'a bar that scrolls away with the page needs no minimum (it never covers the page below the hero)');
select is(_set($$ header_cta_show = false, header_cta_label = null, header_cta_href = null $$), '',
  'a hidden button needs neither words nor a link');
reset role;

select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'site_appearance' and entity_id = 'e5000000-0000-0000-0000-000000000001'),
  3, 'every save is a history row under site_appearance, keyed by the tenant');

-- ── 5. anon ──────────────────────────────────────────────────────────────────
set local role anon;
select _as(null, null, null);
select is((select format('%s/%s', header_logo_size, header_menu_align) from public.site_appearance), 'l/end',
  'anon reads the launch tenant''s options, never another tenant''s');
select is(_state($$ select version from public.site_appearance $$), '42501',
  'anon CANNOT read the version (no column grant)');
select is(_state($$ select updated_by from public.site_appearance $$), '42501',
  'anon CANNOT read who saved it');
select is(_state($$ update public.site_appearance set header_logo_size = 's' $$), '42501',
  'anon CANNOT change the header''s options');
select is(_state($$ insert into public.site_appearance (tenant_id) values ('e5000000-0000-0000-0000-000000000001') $$),
  '42501', 'anon CANNOT add a row');
reset role;

-- ── 6. Releases on: the guard refuses a direct write ─────────────────────────
insert into app.release_tenants (tenant_id) values ('e5000000-0000-0000-0000-000000000001');
set local role authenticated;
select _as('e5000000-0000-0000-0000-0000000000a1', 'admin', 'e5000000-0000-0000-0000-000000000001');
select is(_set($$ header_logo_size = 's' $$), '42501',
  'releases on: admin CANNOT write the header''s options directly (the release guard)');
reset role;

select * from finish();
rollback;
