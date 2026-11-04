-- pgTAP: the loading screen's look (Admin v2 E7, the five intro_ columns of
-- public.site_appearance; CLAUDE.md §5 "Theme editor", docs/admin-v2/README.md P-2, P-3, P-9
-- and O-14). Run with `supabase test db`. E5's suite (site_appearance.test.sql) holds the row's
-- RLS, grants and triggers; this one holds what E7 adds to it:
--
--   • the catalog: the five columns with their defaults (the intro as built), the four CHECKs,
--     anon's SELECT on each, the registry row with the five appended;
--   • Admin and Developer change the intro's look (theme.edit); Content Creator (who keeps the
--     on/off switch on the home hero section, pages.write), SEO and Sales change nothing;
--   • stale tokens (a demoted Developer, a deactivated Admin, a locked Admin) and another
--     tenant's Admin change nothing;
--   • the CHECKs: the backdrop is a closed set; the hold is 500 to 1500 in steps of 100; the
--     fade 300 to 600 in steps of 50; the tagline plain bilingual text of at most 60 characters,
--     or none (23514 each);
--   • history: a save of the look is a content_versions row holding the intro columns;
--   • anon reads the launch tenant's look, never another tenant's, and writes nothing;
--   • releases on: a direct write of the look is refused by the release guard.
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(30);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name, created_at) values
  ('e7000000-0000-0000-0000-000000000001', 'E7 one', '2000-01-01T00:00:00Z'),
  ('e7000000-0000-0000-0000-0000000000ff', 'E7 two', '2000-01-02T00:00:00Z');
insert into auth.users (id, email) values
  ('e7000000-0000-0000-0000-0000000000a1', 'e7-admin@example.test'),
  ('e7000000-0000-0000-0000-0000000000c1', 'e7-creator@example.test'),
  ('e7000000-0000-0000-0000-0000000000e1', 'e7-seo@example.test'),
  ('e7000000-0000-0000-0000-0000000000d1', 'e7-developer@example.test'),
  ('e7000000-0000-0000-0000-0000000000b1', 'e7-sales@example.test'),
  ('e7000000-0000-0000-0000-0000000000d2', 'e7-demoted@example.test'),
  ('e7000000-0000-0000-0000-0000000000a3', 'e7-inactive@example.test'),
  ('e7000000-0000-0000-0000-0000000000a4', 'e7-locked@example.test'),
  ('e7000000-0000-0000-0000-0000000000f1', 'e7-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e7000000-0000-0000-0000-0000000000a1', 'e7000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('e7000000-0000-0000-0000-0000000000c1', 'e7000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e7000000-0000-0000-0000-0000000000e1', 'e7000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('e7000000-0000-0000-0000-0000000000d1', 'e7000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('e7000000-0000-0000-0000-0000000000b1', 'e7000000-0000-0000-0000-000000000001', 'sales', true, null),
  -- Stale: each token below still says developer or admin.
  ('e7000000-0000-0000-0000-0000000000d2', 'e7000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e7000000-0000-0000-0000-0000000000a3', 'e7000000-0000-0000-0000-000000000001', 'admin', false, null),
  ('e7000000-0000-0000-0000-0000000000a4', 'e7000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes'),
  ('e7000000-0000-0000-0000-0000000000f1', 'e7000000-0000-0000-0000-0000000000ff', 'admin', true, null);
-- T1's row as E5 left it (the header's options only), and the other tenant's row, with an intro
-- anon must never see.
insert into public.site_appearance (tenant_id) values ('e7000000-0000-0000-0000-000000000001');
insert into public.site_appearance (tenant_id, intro_backdrop, intro_hold_ms)
  values ('e7000000-0000-0000-0000-0000000000ff', 'light', 700);

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
-- One UPDATE of T1's row: its SQLSTATE ('' when it runs).
create function _set(p_assign text) returns text language sql as $$
  select _state(format('update public.site_appearance set %s where tenant_id = %L',
                       p_assign, 'e7000000-0000-0000-0000-000000000001'))
$$;
-- One UPDATE of T1's row as the given token: the rows it changed.
create function _change_as(p_sub text, p_role text, p_tid text) returns int language plpgsql as $f$
begin
  perform _as(p_sub, p_role, p_tid);
  return _rows(format('update public.site_appearance set intro_backdrop = %L where tenant_id = %L',
                      'light', 'e7000000-0000-0000-0000-000000000001'));
end $f$;
grant execute on function _as(text, text, text), _rows(text), _state(text), _set(text),
  _change_as(text, text, text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select is(
  (select string_agg(format('%s %s %s', a.attname, format_type(a.atttypid, a.atttypmod),
                            coalesce(pg_get_expr(d.adbin, d.adrelid), '-')),
                     ', ' order by a.attname::text collate "C")
     from pg_attribute a
     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0
      and not a.attisdropped and a.attname::text like 'intro\_%'),
  'intro_backdrop text ''video''::text, intro_bar boolean false, intro_fade_ms integer 450, '
  || 'intro_hold_ms integer 1000, intro_tagline jsonb -',
  'the five intro columns, each defaulting to the intro as built');
select is(
  (select format('%s/%s/%s/%s/%s', intro_backdrop, intro_bar, intro_tagline is null,
                 intro_hold_ms, intro_fade_ms)
     from public.site_appearance where tenant_id = 'e7000000-0000-0000-0000-000000000001'),
  'video/f/t/1000/450',
  'a row saved before E7 (or by the header) reads the intro as built');
select is(
  (select string_agg(conname::text, ',' order by conname::text collate "C")
     from pg_constraint
    where conrelid = 'public.site_appearance'::regclass and contype = 'c'
      and conname::text like 'site\_appearance\_intro\_%'),
  'site_appearance_intro_backdrop,site_appearance_intro_fade,site_appearance_intro_hold,'
  || 'site_appearance_intro_tagline',
  'the four intro CHECKs');
select ok(has_column_privilege('anon', 'public.site_appearance', 'intro_backdrop', 'select')
          and has_column_privilege('anon', 'public.site_appearance', 'intro_bar', 'select')
          and has_column_privilege('anon', 'public.site_appearance', 'intro_tagline', 'select')
          and has_column_privilege('anon', 'public.site_appearance', 'intro_hold_ms', 'select')
          and has_column_privilege('anon', 'public.site_appearance', 'intro_fade_ms', 'select')
          and not has_any_column_privilege('anon', 'public.site_appearance', 'insert, update, references'),
  'anon may read the five intro options (the home page''s intro), and write none');
select is(
  (select columns[13:17] from app.release_entities where entity_type = 'site_appearance'),
  array['intro_backdrop', 'intro_bar', 'intro_tagline', 'intro_hold_ms', 'intro_fade_ms'],
  'the registry row stages the five intro columns, after the header''s twelve');

-- ── 2. Admin and Developer write the look; nobody else does ──────────────────
set local role authenticated;
select _as('e7000000-0000-0000-0000-0000000000a1', 'admin', 'e7000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance
                     set intro_backdrop = 'black', intro_bar = true,
                         intro_tagline = '{"en":"From the brain to the real world.","ar":"من الفكرة إلى الواقع."}',
                         intro_hold_ms = 1500, intro_fade_ms = 600
                   where tenant_id = 'e7000000-0000-0000-0000-000000000001' $$), 1,
  'admin sets the intro''s look (theme.edit)');
select _as('e7000000-0000-0000-0000-0000000000d1', 'developer', 'e7000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.site_appearance set intro_hold_ms = 800
                   where tenant_id = 'e7000000-0000-0000-0000-000000000001' $$), 1,
  'developer changes it (theme.edit)');
select is((select format('%s/%s/%s/%s/%s', intro_backdrop, intro_bar, intro_tagline ->> 'en',
                         intro_hold_ms, intro_fade_ms)
             from public.site_appearance
            where tenant_id = 'e7000000-0000-0000-0000-000000000001'),
  'black/t/From the brain to the real world./800/600',
  'the row holds what the two saved');
select is(_change_as('e7000000-0000-0000-0000-0000000000c1', 'content_creator',
                     'e7000000-0000-0000-0000-000000000001'), 0,
  'content_creator CANNOT change the look (its switch is the home hero section, pages.write)');
select is(_change_as('e7000000-0000-0000-0000-0000000000e1', 'seo',
                     'e7000000-0000-0000-0000-000000000001'), 0,
  'seo CANNOT change the look');
select is(_change_as('e7000000-0000-0000-0000-0000000000b1', 'sales',
                     'e7000000-0000-0000-0000-000000000001'), 0,
  'sales CANNOT change the look (the non-staff block: it reads no row either)');

-- ── 3. Stale tokens and another tenant ───────────────────────────────────────
select is(_change_as('e7000000-0000-0000-0000-0000000000d2', 'developer',
                     'e7000000-0000-0000-0000-000000000001'), 0,
  'a demoted developer''s token changes nothing (live check)');
select is(_change_as('e7000000-0000-0000-0000-0000000000a3', 'admin',
                     'e7000000-0000-0000-0000-000000000001'), 0,
  'a deactivated admin''s token changes nothing (live check)');
select is(_change_as('e7000000-0000-0000-0000-0000000000a4', 'admin',
                     'e7000000-0000-0000-0000-000000000001'), 0,
  'a locked admin''s token changes nothing (live check)');
select is(_change_as('e7000000-0000-0000-0000-0000000000f1', 'admin',
                     'e7000000-0000-0000-0000-0000000000ff'), 0,
  'other_tenant''s admin changes none of this tenant''s look');

-- ── 4. The CHECKs ────────────────────────────────────────────────────────────
-- _set runs each UPDATE in a subtransaction it rolls back: '' means the row would take it.
select _as('e7000000-0000-0000-0000-0000000000a1', 'admin', 'e7000000-0000-0000-0000-000000000001');
select is(_set($$ intro_backdrop = 'none' $$) || _set($$ intro_backdrop = 'Video' $$)
          || _set($$ intro_backdrop = 'image' $$),
  '235142351423514', 'the backdrop is video, black or light (23514 for anything else)');
select is(_set($$ intro_backdrop = 'video' $$) || _set($$ intro_backdrop = 'light' $$), '',
  'video and light are taken');
select is(_set($$ intro_hold_ms = 400 $$) || _set($$ intro_hold_ms = 1600 $$)
          || _set($$ intro_hold_ms = 750 $$) || _set($$ intro_hold_ms = 2000 $$),
  '23514235142351423514',
  'the hold: never under 500 ms, never over 1500 ms (the site rule), always a step of 100');
select is(_set($$ intro_hold_ms = 500 $$) || _set($$ intro_hold_ms = 1500 $$)
          || _set($$ intro_hold_ms = 1100 $$),
  '', 'the hold''s ends and its steps are taken');
select is(_set($$ intro_fade_ms = 250 $$) || _set($$ intro_fade_ms = 650 $$)
          || _set($$ intro_fade_ms = 325 $$),
  '235142351423514', 'the fade: 300 to 600 ms, a step of 50');
select is(_set($$ intro_fade_ms = 300 $$) || _set($$ intro_fade_ms = 600 $$)
          || _set($$ intro_fade_ms = 450 $$),
  '', 'the fade''s ends and its steps are taken');
select is(_set($$ intro_tagline = '{"en":"Only English"}' $$)
          || _set($$ intro_tagline = '{"en":" Padded","ar":"ب"}' $$)
          || _set(format('intro_tagline = %L', jsonb_build_object('en', repeat('a', 61), 'ar', 'ب')))
          || _set(format('intro_tagline = %L', jsonb_build_object('en', E'two\nlines', 'ar', 'ب')))
          || _set($$ intro_tagline = '{"en":"a","ar":"ب","extra":"x"}' $$)
          || _set($$ intro_tagline = '"just text"' $$),
  '235142351423514235142351423514',
  'the tagline: both languages, trimmed, one line, at most 60 characters, no other key');
select is(_set(format('intro_tagline = %L', jsonb_build_object('en', repeat('a', 60), 'ar', 'ب')))
          || _set($$ intro_tagline = null $$),
  '', 'sixty characters are taken, and so is no tagline');
select is(_set($$ intro_bar = null $$) || _set($$ intro_hold_ms = null $$),
  '2350223502', 'the bar and the timing are never null (23502)');
reset role;

select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'site_appearance' and entity_id = 'e7000000-0000-0000-0000-000000000001'
      and snapshot ->> 'intro_hold_ms' = '800' and snapshot ->> 'intro_backdrop' = 'black'),
  1, 'a save of the look is a history row under site_appearance, holding the intro columns');

-- ── 5. anon ──────────────────────────────────────────────────────────────────
set local role anon;
select _as(null, null, null);
select is((select format('%s/%s/%s/%s', intro_backdrop, intro_bar, intro_hold_ms, intro_fade_ms)
             from public.site_appearance),
  'black/t/800/600', 'anon reads the launch tenant''s look, never another tenant''s');
select is((select intro_tagline ->> 'ar' from public.site_appearance), 'من الفكرة إلى الواقع.',
  'anon reads the tagline in both languages');
select is(_state($$ update public.site_appearance set intro_bar = false $$), '42501',
  'anon CANNOT change the look');
reset role;

-- ── 6. Releases on: the guard refuses a direct write ─────────────────────────
insert into app.release_tenants (tenant_id) values ('e7000000-0000-0000-0000-000000000001');
set local role authenticated;
select _as('e7000000-0000-0000-0000-0000000000a1', 'admin', 'e7000000-0000-0000-0000-000000000001');
select is(_set($$ intro_backdrop = 'light' $$), '42501',
  'releases on: admin CANNOT write the look directly (the release guard)');
reset role;

-- The other tenant's row was never touched.
select is((select format('%s/%s', intro_backdrop, intro_hold_ms) from public.site_appearance
            where tenant_id = 'e7000000-0000-0000-0000-0000000000ff'), 'light/700',
  'the other tenant''s look is as it was');

select * from finish();
rollback;
