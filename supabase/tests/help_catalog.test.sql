-- pgTAP: the help-guide catalog (0069, Admin v2 H11). Run with `supabase test db`.
-- help_centre.test.sql proves the guides as every tenant reads them (RLS, the CHECKs, the
-- search, the seed); this file proves what 0069 changes:
--   1. app.help_guide_catalog: RLS enabled and forced, no policy, the rules help_articles
--      holds word for word, and no API role reads or writes it: admin, content_creator, seo,
--      developer, another tenant's admin, anon and the service role are each refused (42501).
--   2. app.help_article_set() is the catalog, rendered: the same nine keys per guide, in
--      sort_order, at least the fifteen guides main held when the catalog was made. (That the
--      text did not move, byte for byte, is the migration's own postcondition: an md5 of the
--      set before the function was replaced, compared after. Only the migration sees both.)
--   3. app.put_help_guide: putting a guide unchanged changes nothing (the set's text, every
--      tenant's versions, the guide's revision); changing one changes that guide alone, in
--      every tenant, its version and its revision moved once; a new guide reaches every tenant
--      and each new one; bad shapes are refused (22023), so are the rules' breaches (23514), a
--      place another guide holds (23505) and a revision the guide is not at (55000: the
--      sibling-overwrite guard), and nothing reaches the catalog or a tenant.
--   4. app.drop_help_guide: retires one guide everywhere and touches no other; the set's text
--      is then what it was before the guide was put; a slug the catalog lacks is refused, and
--      so is a revision the guide is not at.
--   5. No API role may call put, drop or the set.
--
-- Fixtures are two tenants of this file's own, each seeded by the tenants trigger (0046); the
-- launch tenant seed.sql creates holds the guides too, and every "every tenant" check counts it.

begin;
select plan(85);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('69000000-0000-4000-8000-00000000000a', 'CatalogA'),
  ('69000000-0000-4000-8000-0000000000ff', 'CatalogB');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '69000000-0000-4000-8000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The set's fingerprint, and one guide of it, read as the migration role.
create function _set_md5() returns text language sql security definer as $$
  select md5(app.help_article_set()::text)
$$;
create function _guide(p_slug text) returns jsonb language sql security definer as $$
  select a from jsonb_array_elements(app.help_article_set()) a where a ->> 'slug' = p_slug
$$;
-- Every tenant's copy of every guide: tenant, slug, version, stamp and content.
create function _copies() returns table (tenant_id uuid, slug text, version int,
                                         updated_at timestamptz, body jsonb, title text)
  language sql security definer as $$
  select h.tenant_id, h.slug, h.version, h.updated_at, h.body, h.title from public.help_articles h
$$;
-- The copies and the set as they were at a point the test chooses (filled below).
create temp table _snap as select * from _copies() limit 0;
create temp table _before (set_json jsonb, md5 text);
-- How many copies differ from a snapshot, the given slug left out.
create function _moved(p_except text) returns int language sql as $$
  select count(*)::int from (
    (select tenant_id, slug, version, updated_at, body, title from _snap where slug <> p_except
     except
     select * from _copies() where slug <> p_except)
    union all
    (select * from _copies() where slug <> p_except
     except
     select tenant_id, slug, version, updated_at, body, title from _snap where slug <> p_except)) d
$$;
-- A guide's revision in the catalog (0 for none).
create function _rev(p_slug text) returns int language sql as $$
  select coalesce((select revision from app.help_guide_catalog where slug = p_slug), 0)
$$;
-- A valid new guide, with one field replaced.
create function _new(p_key text, p_value jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', 'h11-test-guide', 'sort_order', 9999, 'minutes', 2, 'tags', '["basics"]'::jsonb,
    'screens', '["/admin/help"]'::jsonb, 'caps', '[]'::jsonb, 'title', 'A test guide',
    'title_ar', 'دليل تجريبي',
    'body', '{"en": [{"t": "p", "x": "Plain words."}], "ar": [{"t": "p", "x": "كلمات بسيطة."}]}'::jsonb)
    || case when p_key is null then '{}'::jsonb else jsonb_build_object(p_key, p_value) end
$$;
create function _tenants() returns int language sql as $$
  select count(*)::int from public.tenants
$$;

-- ---- 1. the catalog ------------------------------------------------------------------------
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'app.help_guide_catalog'::regclass),
  'help_guide_catalog: RLS enabled and forced');
select is((select count(*)::int from pg_policies
            where schemaname = 'app' and tablename = 'help_guide_catalog'), 0,
  'help_guide_catalog has no policy: only the migration role (BYPASSRLS) reads it');
select is(
  (select array_agg(replace(conname::text, 'help_guide_catalog_', '') || ' ' || pg_get_constraintdef(oid)
                    order by conname::text collate "C")
     from pg_constraint where conrelid = 'app.help_guide_catalog'::regclass and contype = 'c'
      and conname <> 'help_guide_catalog_revision_positive'),
  (select array_agg(replace(conname::text, 'help_articles_', '') || ' ' || pg_get_constraintdef(oid)
                    order by conname::text collate "C")
     from pg_constraint where conrelid = 'public.help_articles'::regclass and contype = 'c'),
  'the catalog holds every rule help_articles holds, word for word');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, pr.priv), ', ' order by w.who, pr.priv), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) w(who)
     cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references',
                             'trigger']) pr(priv)
    where has_table_privilege(w.who, 'app.help_guide_catalog', pr.priv)),
  '', 'no API role holds any privilege on the catalog');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, f.fn), ', ' order by w.who, f.fn), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) w(who)
     cross join unnest(array['app.help_article_set()', 'app.put_help_guide(jsonb, integer)',
                             'app.drop_help_guide(text, integer)']) f(fn)
    where has_function_privilege(w.who, f.fn, 'execute')),
  '', 'no API role may call the set, put or drop');

-- ---- 2. the set is the catalog, rendered ---------------------------------------------------
select is((select count(*)::int from app.help_guide_catalog where revision < 1), 0,
  'every catalog guide has a revision, 1 or more');
select ok((select count(*) from app.help_guide_catalog) >= 15
          and (select count(*) from app.help_guide_catalog)
              = jsonb_array_length(app.help_article_set()),
  'the set holds every catalog guide, at least fifteen');
select ok(array['finding-your-way', 'your-dashboard', 'your-account', 'roles-and-access',
                'inviting-people', 'saving-and-publishing', 'media-library',
                'seo-and-redirects', 'working-with-leads', 'personal-data',
                'job-applications', 'maintenance-mode', 'page-visibility', 'website-stats',
                'site-health-and-logs']
          <@ (select array_agg(slug::text) from app.help_guide_catalog),
  'the catalog holds the fifteen guides main held when it was made');
select is(
  (select count(*)::int from jsonb_array_elements(app.help_article_set()) a
    where (select array_agg(k order by k collate "C") from jsonb_object_keys(a) k)
          is distinct from array['body', 'caps', 'minutes', 'screens', 'slug', 'sort_order',
                                 'tags', 'title', 'title_ar']),
  0, 'every guide of the set has exactly the nine keys it had');
select is(
  (select array_agg((a ->> 'slug') order by n)
     from jsonb_array_elements(app.help_article_set()) with ordinality as s(a, n)),
  (select array_agg(slug::text order by sort_order) from app.help_guide_catalog),
  'the set lists the guides in their places (sort_order)');
select is(app.help_article_set(),
  (select jsonb_agg(jsonb_build_object('slug', c.slug, 'sort_order', c.sort_order,
                                       'minutes', c.minutes, 'tags', c.tags,
                                       'screens', c.screens, 'caps', c.caps, 'title', c.title,
                                       'title_ar', c.title_ar, 'body', c.body)
                    order by c.sort_order)
     from app.help_guide_catalog c),
  'each guide of the set is its catalog row, field for field');
select is((select count(*)::int from public.help_articles
            where tenant_id = '69000000-0000-4000-8000-00000000000a'),
  (select count(*)::int from app.help_guide_catalog),
  'a new tenant gets every catalog guide (the tenants trigger reads the set)');

-- ---- 3. put: unchanged, changed, new ---------------------------------------------------------
insert into _snap select * from _copies();
insert into _before select app.help_article_set(), _set_md5();

create temp table _rev0 as select _rev('website-stats') as r;
select lives_ok($$ select app.put_help_guide(_guide('website-stats'), _rev('website-stats')) $$,
  'putting a guide exactly as it stands is accepted');
select is(_rev('website-stats'), (select r from _rev0), 'and keeps its revision');
select is(_set_md5(), (select md5 from _before),
  'and leaves the set''s text as it was, byte for byte');
select is(_moved(''), 0, 'and no tenant''s copy of any guide (version and stamp included)');

select throws_ok(
  $$ select app.put_help_guide(_guide('website-stats') || '{"title": "Stale"}'::jsonb,
                               _rev('website-stats') - 1) $$,
  '55000', null, 'a change written against an older revision is refused (a sibling changed it first)');
select throws_ok(
  $$ select app.put_help_guide(_guide('website-stats') || '{"title": "Fresh"}'::jsonb, 0) $$,
  '55000', null, 'so is one that takes an existing guide for a new one');
select throws_ok(
  $$ select app.put_help_guide(_guide('website-stats') || '{"title": "None"}'::jsonb, null) $$,
  '55000', null, 'and one that names no revision');
select is(_guide('website-stats') ->> 'title', (select set_json from _before) -> (
            select (n - 1)::int from jsonb_array_elements((select set_json from _before))
              with ordinality s(a, n) where a ->> 'slug' = 'website-stats') ->> 'title',
  'a refused change leaves the guide as it was');
select lives_ok(
  $$ select app.put_help_guide(_guide('website-stats') || '{"title": "Website stats, read"}'::jsonb,
                               _rev('website-stats')) $$,
  'a changed guide, named at its revision, is accepted');
select is(_rev('website-stats'), (select r + 1 from _rev0), 'its revision moves by one');
select is(_guide('website-stats') ->> 'title', 'Website stats, read', 'the set has the new text');
select is(
  (select jsonb_agg(a order by n) from jsonb_array_elements(app.help_article_set())
     with ordinality s(a, n) where a ->> 'slug' <> 'website-stats'),
  (select jsonb_agg(a order by n) from jsonb_array_elements((select set_json from _before))
     with ordinality s(a, n) where a ->> 'slug' <> 'website-stats'),
  'every other guide of the set is as it was');
select is((select count(*)::int from public.help_articles h join _snap s using (tenant_id, slug)
            where h.slug = 'website-stats' and h.title = 'Website stats, read'
              and h.version = s.version + 1),
  _tenants(), 'every tenant gets the change, its version moved once');
select is(_moved('website-stats'), 0, 'no other guide of any tenant moves');
select lives_ok(
  $$ select app.put_help_guide(_guide('website-stats') || '{"title": "Website stats, read"}'::jsonb,
                               _rev('website-stats')) $$,
  'putting it again is accepted');
select is((select count(*)::int from public.help_articles h join _snap s using (tenant_id, slug)
            where h.slug = 'website-stats' and h.version = s.version + 1),
  _tenants(), 'and moves no version again');
select is(_rev('website-stats'), (select r + 1 from _rev0), 'nor the revision');

-- A new guide, in a place no guide holds.
truncate _snap;
insert into _snap select * from _copies();
update _before set set_json = app.help_article_set(), md5 = _set_md5();
select throws_ok($$ select app.put_help_guide(_new(null, null), 1) $$, '55000', null,
  'a new guide named at a revision it does not have is refused');
select lives_ok($$ select app.put_help_guide(_new(null, null), 0) $$, 'a new guide, at 0, is accepted');
select is(_rev('h11-test-guide'), 1, 'and starts at revision 1');
select is((select count(*)::int from public.help_articles
            where slug = 'h11-test-guide' and version = 1 and title = 'A test guide'),
  _tenants(), 'every tenant gets it, at version 1');
select is((select count(*)::int from app.help_guide_catalog), jsonb_array_length(app.help_article_set()),
  'the set grows with the catalog');
select is(app.help_article_set() -> -1 ->> 'slug', 'h11-test-guide', 'listed in its place, last');
select is(_moved('h11-test-guide'), 0, 'no other guide of any tenant moves');
insert into public.tenants (id, name) values ('69000000-0000-4000-8000-0000000000c3', 'CatalogC');
select is((select count(*)::int from public.help_articles
            where tenant_id = '69000000-0000-4000-8000-0000000000c3'),
  (select count(*)::int from app.help_guide_catalog),
  'a tenant made after the put gets every guide, the new one included');
-- The copies as they now stand (the new tenant's included), for the drop below.
truncate _snap;
insert into _snap select * from _copies();

-- ---- 3b. what put refuses (nothing reaches the catalog or a tenant) ----------------------------
-- The rules' breaches name h11-test-guide at its revision (1), so the rule, not the revision,
-- is what refuses them.
select throws_ok($$ select app.put_help_guide(null, 0) $$, '22023', null, 'no guide at all is refused');
select throws_ok($$ select app.put_help_guide('[]'::jsonb, 0) $$, '22023', null, 'a list is not a guide');
select throws_ok($$ select app.put_help_guide(_new(null, null) - 'caps', 0) $$, '22023', null,
  'a guide missing a key is refused');
select throws_ok($$ select app.put_help_guide(_new('extra', '1'), 0) $$, '22023', null,
  'a guide with a key the set does not know is refused');
select throws_ok($$ select app.put_help_guide(_new('tags', '[1]'), 0) $$, '22023', null,
  'a number where a tag belongs is refused, never cast');
select throws_ok($$ select app.put_help_guide(_new('sort_order', '1.5'), 0) $$, '22023', null,
  'a place that is not a whole number is refused');
select throws_ok($$ select app.put_help_guide(_new('minutes', '"3"'), 0) $$, '22023', null,
  'minutes as text is refused');
select throws_ok($$ select app.put_help_guide(_new('body', '[]'), 0) $$, '22023', null,
  'a body that is not an object is refused');
select throws_ok($$ select app.put_help_guide(_new('title', '"<b>Bold</b>"'), 1) $$, '23514', null,
  'markup in a title is refused (help_text_ok)');
select throws_ok($$ select app.put_help_guide(_new('body', '{"en": [{"t": "p", "x": "a"}]}'), 1) $$,
  '23514', null, 'a body without its Arabic is refused (help_body_ok)');
select throws_ok($$ select app.put_help_guide(_new('screens', '["/public/page"]'), 1) $$, '23514', null,
  'a screen outside /admin is refused (help_keys_ok)');
select throws_ok($$ select app.put_help_guide(_new('tags', '["leads", "leads"]'), 1) $$, '23514', null,
  'a repeated tag is refused');
select throws_ok($$ select app.put_help_guide(_new('slug', '"X-Upper"'), 0) $$, '23514', null,
  'a slug with an upper-case letter is refused');
select throws_ok($$ select app.put_help_guide(_new('minutes', '0'), 1) $$, '23514', null,
  'a guide read in no minutes is refused');
select throws_ok($$ select app.put_help_guide(_new('slug', '"h11-other"') || '{"sort_order": 10}'::jsonb, 0) $$,
  '23505', null, 'a place another guide holds is refused');
select is((select count(*)::int from app.help_guide_catalog where slug in ('X-Upper', 'h11-other')),
  0, 'no refused guide reached the catalog');
select is((select count(*)::int from public.help_articles where slug = 'h11-other'), 0,
  'nor any tenant');
select is((select title from app.help_guide_catalog where slug = 'h11-test-guide'), 'A test guide',
  'and the guide the refused puts named is as it was');
-- A number with an exponent is not refused: jsonb keeps no exponent, so 2e0 arrives as 2, the
-- whole number the guide already holds, and the put is the guide unchanged.
select lives_ok($$ select app.put_help_guide(_new('minutes', '2e0'), 1) $$,
  'minutes written 2e0 is the whole number 2 (jsonb stores no exponent)');
select is(_rev('h11-test-guide'), 1, 'and, the guide unchanged, its revision stays');

-- ---- 4. drop ---------------------------------------------------------------------------------
select throws_ok($$ select app.drop_help_guide('h11-test-guide', 2) $$, '55000', null,
  'a drop written against another revision is refused');
select lives_ok($$ select app.drop_help_guide('h11-test-guide', 1) $$, 'a guide is retired');
select is((select count(*)::int from public.help_articles where slug = 'h11-test-guide'), 0,
  'from every tenant');
select is((select count(*)::int from app.help_guide_catalog where slug = 'h11-test-guide'), 0,
  'and from the catalog');
select is(_set_md5(), (select md5 from _before),
  'the set''s text is again what it was before the guide was put, byte for byte');
select is(_moved('h11-test-guide'), 0, 'no other guide of any tenant moves');
select throws_ok($$ select app.drop_help_guide('h11-test-guide', 1) $$, 'P0002', null,
  'a slug the catalog does not hold is refused');
select throws_ok($$ select app.drop_help_guide(null, 1) $$, 'P0002', null, 'so is no slug');

-- ---- 5. who may read or call it: nobody but the migration role ---------------------------------
set local role authenticated;
select _as('admin', '69000000-0000-4000-8000-00000000000a');
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'admin cannot read the catalog');
select throws_ok($$ select app.put_help_guide('{}'::jsonb, 0) $$, '42501', null,
  'admin cannot put a guide');
select throws_ok($$ select app.drop_help_guide('website-stats', 1) $$, '42501', null,
  'admin cannot drop a guide');
select _as('content_creator', '69000000-0000-4000-8000-00000000000a');
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'content_creator cannot read the catalog');
select throws_ok($$ select app.put_help_guide('{}'::jsonb, 0) $$, '42501', null,
  'content_creator cannot put a guide');
select throws_ok($$ select app.drop_help_guide('website-stats', 1) $$, '42501', null,
  'content_creator cannot drop a guide');
select _as('seo', '69000000-0000-4000-8000-00000000000a');
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'seo cannot read the catalog');
select throws_ok($$ select app.put_help_guide('{}'::jsonb, 0) $$, '42501', null,
  'seo cannot put a guide');
select throws_ok($$ select app.drop_help_guide('website-stats', 1) $$, '42501', null,
  'seo cannot drop a guide');
select _as('developer', '69000000-0000-4000-8000-00000000000a');
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'developer cannot read the catalog');
select throws_ok($$ select app.put_help_guide('{}'::jsonb, 0) $$, '42501', null,
  'developer cannot put a guide');
select throws_ok($$ select app.help_article_set() $$, '42501', null,
  'developer cannot read the set itself');
select _as('admin', '69000000-0000-4000-8000-0000000000ff');
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'another tenant''s admin cannot read the catalog');
select throws_ok($$ select app.drop_help_guide('website-stats', 1) $$, '42501', null,
  'another tenant''s admin cannot drop a guide');
reset role;

set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'anon cannot read the catalog');
select throws_ok($$ select app.put_help_guide('{}'::jsonb, 0) $$, '42501', null,
  'anon cannot put a guide');
reset role;

set local role service_role;
select _as(null, null);
select throws_ok($$ select count(*) from app.help_guide_catalog $$, '42501', null,
  'the service role cannot read the catalog (it writes help_articles, never the catalog)');
select throws_ok($$ select app.put_help_guide('{}'::jsonb, 0) $$, '42501', null,
  'the service role cannot put a guide');
select throws_ok($$ select app.drop_help_guide('website-stats', 1) $$, '42501', null,
  'the service role cannot drop a guide');
reset role;

select is((select count(*)::int from public.help_articles where slug = 'website-stats'), _tenants(),
  'no refused caller removed a guide');

select * from finish();
rollback;
