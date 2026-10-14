-- pgTAP: the help centre (0046, Admin v2 U16): help_articles, its search, and the guides
-- every tenant is seeded with. Run with `supabase test db`.
--
-- Every object has a row for admin, content_creator, seo, developer, anon and another
-- tenant's admin (CLAUDE.md §9):
--   • help_articles: each staff role reads every guide of its own tenant and none of another
--     tenant's; no staff role writes one (insert, update and delete are refused by the
--     grants, matched by the grant layer's message, since RLS alone would refuse an insert
--     with another: CLAUDE.md §5 gives help no capability); anon reads nothing. Which guides a
--     role is SHOWN is the Worker's filter (tests/lib/helpCentre.spec.ts), not RLS.
--   • help_search: staff find their own tenant's guides, folded the way §8 folds Arabic
--     (ta marbuta, alef forms, tashkeel) and in any case; `%` and `_` are characters, not
--     patterns; an over-long or control-character query is a 22023; a tenant other than
--     the token's gets nothing; anon may not call it.
--   • the rules the CHECKs hold for every writer, the service role included: a body is typed
--     blocks with no markup, both languages, known kinds and keys only; titles and keys are
--     plain; a guide keeps its tenant and slug, and its version moves only when it changes.
--   • the seed: a new tenant gets every guide of the set (the tenants trigger); seeding again
--     changes nothing, and brings back a guide an operator edited.
--
-- Fixtures are two tenants of this file's own, each seeded by the trigger; every count is
-- scoped to them (the launch tenant seed.sql creates holds the guides too).

begin;
select plan(62);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('46000000-0000-0000-0000-000000000001', 'T1'),
  ('46000000-0000-0000-0000-0000000000ff', 'T2');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '46000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- How many guides the set holds, read as the migration role (no API role may call it).
create function _set_size() returns int language sql security definer as $$
  select jsonb_array_length(app.help_article_set())
$$;

-- The guides the CURRENT role sees: all of them, and those of T1.
create function _seen() returns int language sql as $$
  select count(*)::int from public.help_articles
$$;
create function _seen_t1() returns int language sql as $$
  select count(*)::int from public.help_articles
   where tenant_id = '46000000-0000-0000-0000-000000000001'
$$;

-- A search as the CURRENT role: how many guides, and their slugs in order.
create function _hits(p_tenant uuid, p_q text) returns int language sql as $$
  select count(*)::int from public.help_search(p_tenant, p_q)
$$;
create function _slugs(p_tenant uuid, p_q text) returns text language sql as $$
  select coalesce(string_agg(s.slug, ',' order by s.n), '')
    from (select h.slug, row_number() over () as n from public.help_search(p_tenant, p_q) h) s
$$;

-- A valid body, for the writes below.
create function _body(p_en text) returns jsonb language sql as $$
  select jsonb_build_object('en', jsonb_build_array(jsonb_build_object('t', 'p', 'x', p_en)),
                            'ar', jsonb_build_array(jsonb_build_object('t', 'p', 'x', 'نص')))
$$;

-- ---- the catalog, and the seed (as the migration role) ----------------------------------
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.help_articles'::regclass),
  'help_articles: RLS enabled and forced');
select ok(_set_size() >= 12, 'the set holds the guides written for the built features');
select is((select count(*)::int from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001'), _set_size(),
  'a new tenant gets every guide of the set (the tenants trigger)');
select is((select count(*)::int from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-0000000000ff'), _set_size(),
  'and so does the other one');
select is((select count(*)::int from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001' and version = 1), _set_size(),
  'every seeded guide starts at version 1');
select ok(not has_function_privilege('authenticated', 'app.seed_help_articles(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'app.help_article_set()', 'execute')
          and not has_function_privilege('anon', 'app.seed_help_articles(uuid)', 'execute'),
  'no API role may seed guides or read the set itself');

-- ---- anon: nothing ----------------------------------------------------------------------
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.help_articles $$,
  '42501', null, 'anon cannot read help_articles');
select throws_ok($$ select * from public.help_search('46000000-0000-0000-0000-000000000001', 'password') $$,
  '42501', null, 'anon cannot call help_search');

-- ---- each staff role of T1: reads its tenant's guides, writes none ----------------------
set local role authenticated;

select _as('admin', '46000000-0000-0000-0000-000000000001');
select is(_seen(), _set_size(), 'admin reads every guide of its tenant, and only those');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'mine', 'Mine', 'لي', 1,
                            '{/admin}', _body('x')) $$,
  '42501', 'permission denied for table help_articles',
  'admin cannot insert a guide (no capability writes help)');
select throws_ok($$ update public.help_articles set title = 'Changed' $$,
  '42501', 'permission denied for table help_articles',
  'admin cannot update a guide');
select throws_ok($$ delete from public.help_articles $$,
  '42501', 'permission denied for table help_articles',
  'admin cannot delete a guide');

select _as('content_creator', '46000000-0000-0000-0000-000000000001');
select is(_seen(), _set_size(), 'content_creator reads every guide of its tenant, and only those');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'mine', 'Mine', 'لي', 1,
                            '{/admin}', _body('x')) $$,
  '42501', 'permission denied for table help_articles',
  'content_creator cannot insert a guide');
select throws_ok($$ update public.help_articles set title = 'Changed' $$,
  '42501', 'permission denied for table help_articles',
  'content_creator cannot update a guide');
select throws_ok($$ delete from public.help_articles $$,
  '42501', 'permission denied for table help_articles',
  'content_creator cannot delete a guide');

select _as('seo', '46000000-0000-0000-0000-000000000001');
select is(_seen(), _set_size(), 'seo reads every guide of its tenant, and only those');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'mine', 'Mine', 'لي', 1,
                            '{/admin}', _body('x')) $$,
  '42501', 'permission denied for table help_articles',
  'seo cannot insert a guide');
select throws_ok($$ update public.help_articles set title = 'Changed' $$,
  '42501', 'permission denied for table help_articles',
  'seo cannot update a guide');
select throws_ok($$ delete from public.help_articles $$,
  '42501', 'permission denied for table help_articles',
  'seo cannot delete a guide');

select _as('developer', '46000000-0000-0000-0000-000000000001');
select is(_seen(), _set_size(), 'developer reads every guide of its tenant, and only those');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'mine', 'Mine', 'لي', 1,
                            '{/admin}', _body('x')) $$,
  '42501', 'permission denied for table help_articles',
  'developer cannot insert a guide');
select throws_ok($$ update public.help_articles set title = 'Changed' $$,
  '42501', 'permission denied for table help_articles',
  'developer cannot update a guide');
select throws_ok($$ delete from public.help_articles $$,
  '42501', 'permission denied for table help_articles',
  'developer cannot delete a guide');

-- A token with no staff role (a role this schema does not know) reads nothing.
select _as('visitor', '46000000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a token whose role is not staff reads no guide');
select is(_hits('46000000-0000-0000-0000-000000000001', 'password'), 0,
  'and finds none');

-- ---- search, as each staff role ---------------------------------------------------------
select _as('admin', '46000000-0000-0000-0000-000000000001');
select ok(_hits('46000000-0000-0000-0000-000000000001', 'password') > 0, 'admin finds a guide');
select _as('content_creator', '46000000-0000-0000-0000-000000000001');
select ok(_hits('46000000-0000-0000-0000-000000000001', 'password') > 0, 'content_creator finds a guide');
select _as('seo', '46000000-0000-0000-0000-000000000001');
select ok(_hits('46000000-0000-0000-0000-000000000001', 'password') > 0, 'seo finds a guide');
select _as('developer', '46000000-0000-0000-0000-000000000001');
select ok(_hits('46000000-0000-0000-0000-000000000001', 'password') > 0, 'developer finds a guide');

-- ---- another tenant's admin: its own guides only ------------------------------------------
select _as('admin', '46000000-0000-0000-0000-0000000000ff');
select is(_seen(), _set_size(), 'another tenant''s admin reads its own tenant''s guides');
select is(_seen_t1(), 0, 'and none of T1''s');
select is(_hits('46000000-0000-0000-0000-000000000001', 'password'), 0,
  'naming T1 in a search finds nothing');
select ok(_hits('46000000-0000-0000-0000-0000000000ff', 'password') > 0,
  'naming its own tenant finds its guides');

-- ---- what search matches (as T1's admin) --------------------------------------------------
select _as('admin', '46000000-0000-0000-0000-000000000001');
select ok(position('your-account' in _slugs('46000000-0000-0000-0000-000000000001', 'PASSWORD')) > 0,
  'search ignores case');
select is(split_part(_slugs('46000000-0000-0000-0000-000000000001', 'leads'), ',', 1),
  'working-with-leads', 'a guide whose title holds the words comes first');
select ok(position('your-account' in _slugs('46000000-0000-0000-0000-000000000001', 'كلمه المرور')) > 0,
  'Arabic: ta marbuta and ha are one letter (كلمه finds كلمة)');
select ok(position('job-applications' in _slugs('46000000-0000-0000-0000-000000000001', 'الاعدادات العامة')) > 0,
  'Arabic: alef forms are one letter (الاعدادات finds الإعدادات)');
select ok(position('saving-and-publishing' in _slugs('46000000-0000-0000-0000-000000000001', 'مُسَوَّدة')) > 0,
  'Arabic: tashkeel is ignored (مُسَوَّدة finds مسودة)');
select is(_hits('46000000-0000-0000-0000-000000000001', 'a%b'), 0,
  'a % in the query is a character, not a wildcard');
select is(_hits('46000000-0000-0000-0000-000000000001', 'e_mail'), 0,
  'an _ in the query is a character (it would match e-mail as a pattern)');
select ok(_hits('46000000-0000-0000-0000-000000000001', 'e-mail') > 0,
  'the same words, typed as written, are found');
select is(_hits('46000000-0000-0000-0000-000000000001', 'a'), 0,
  'a single character finds nothing');
select throws_ok($$ select * from public.help_search('46000000-0000-0000-0000-000000000001', repeat('x', 65)) $$,
  '22023', null, 'a query over 64 characters is refused');
select throws_ok($$ select * from public.help_search('46000000-0000-0000-0000-000000000001', E'pass\nword') $$,
  '22023', null, 'a control character is refused');

-- ---- the rules every writer is held to (the service role, past RLS) ------------------------
set local role service_role;
select _as(null, null);
select lives_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                   values ('46000000-0000-0000-0000-000000000001', 'operator-note', 'An operator note',
                           'ملاحظة', 1, '{/admin}', _body('Plain words.')) $$,
  'the service role may add a guide that keeps the rules');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-markup', 'Markup', 'وسم', 1,
                            '{/admin}', _body('<script>alert(1)</script>')) $$,
  '23514', null, 'markup in a body is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-kind', 'Kind', 'نوع', 1, '{/admin}',
                            '{"en": [{"t": "html", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}') $$,
  '23514', null, 'a block kind the shape does not know is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-lang', 'Lang', 'لغة', 1, '{/admin}',
                            '{"en": [{"t": "p", "x": "a"}]}') $$,
  '23514', null, 'a body without its Arabic is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-key', 'Key', 'مفتاح', 1, '{/admin}',
                            '{"en": [{"t": "p", "x": "a", "html": "b"}], "ar": [{"t": "p", "x": "ب"}]}') $$,
  '23514', null, 'a block with a key the shape does not know is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-title', '<b>Title</b>', 'عنوان', 1,
                            '{/admin}', _body('a')) $$,
  '23514', null, 'markup in a title is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-screen', 'Screen', 'شاشة', 1,
                            '{/public/page}', _body('a')) $$,
  '23514', null, 'a screen outside /admin is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, tags, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'x-tags', 'Tags', 'وسوم', 1,
                            '{leads,leads}', '{/admin}', _body('a')) $$,
  '23514', null, 'a repeated tag is refused');
select throws_ok($$ insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, body)
                    values ('46000000-0000-0000-0000-000000000001', 'X-Upper', 'Upper', 'كبير', 1,
                            '{/admin}', _body('a')) $$,
  '23514', null, 'a slug with an upper-case letter is refused (slugs are lower case)');

-- The guard: a guide keeps its tenant and slug; its version moves only when it changes.
select throws_ok($$ update public.help_articles set tenant_id = '46000000-0000-0000-0000-0000000000ff'
                    where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'operator-note' $$,
  '23514', null, 'a guide cannot move to another tenant');
select throws_ok($$ update public.help_articles set slug = 'renamed'
                    where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'operator-note' $$,
  '23514', null, 'a guide keeps its slug');
update public.help_articles set title = 'An operator note'
 where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'operator-note';
select is((select version from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'operator-note'), 1,
  'saving a guide unchanged keeps its version');
update public.help_articles set title = 'An operator note, edited'
 where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'operator-note';
select is((select version from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'operator-note'), 2,
  'changing a guide moves its version');

-- The search's cap: more guides match than it answers. Added here (staff write none), read
-- as T1's admin, then removed so the counts below are the set's.
insert into public.help_articles (tenant_id, slug, title, title_ar, minutes, screens, sort_order, body)
select '46000000-0000-0000-0000-000000000001', 'bulk-' || n, 'Bulk guide ' || n, 'دليل', 1,
       '{/admin}', 1000 + n, _body('Quokka facts.')
  from generate_series(1, 25) n;
set local role authenticated;
select _as('admin', '46000000-0000-0000-0000-000000000001');
select is(_hits('46000000-0000-0000-0000-000000000001', 'quokka'), 20,
  'a search answers at most 20 guides (25 match)');
set local role service_role;
select _as(null, null);
delete from public.help_articles
 where tenant_id = '46000000-0000-0000-0000-000000000001' and slug like 'bulk-%';

-- An operator edits a seeded guide, for the seed below to bring back.
update public.help_articles set title = 'Edited by hand'
 where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'finding-your-way';

-- ---- seeding again (as the migration role) ------------------------------------------------
reset role;
select _as(null, null);
select app.seed_help_articles('46000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001'), _set_size() + 1,
  'seeding again adds nothing, and leaves a guide the set does not hold alone');
select is((select title from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001' and slug = 'finding-your-way'),
  (select a.title from jsonb_to_recordset(app.help_article_set()) as a (slug text, title text)
    where a.slug = 'finding-your-way'),
  'seeding again brings an edited guide back to the set''s text');
select is((select count(*)::int from public.help_articles
            where tenant_id = '46000000-0000-0000-0000-000000000001' and version = 1
              and slug <> 'finding-your-way' and slug <> 'operator-note'), _set_size() - 1,
  'and leaves every other guide''s version where it was');

select * from finish();
rollback;
