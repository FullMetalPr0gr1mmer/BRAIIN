-- pgTAP: section appearance (Admin v2 E9, the 0127 placeholder). Run with `supabase test db`.
--
--   • page_sections.background, .spacing, .reveal and .anchor: nullable text, no default, each
--     held by its CHECK to its bucket and the kinds that take it (packages/schemas/
--     sectionAppearance.ts; tests/lib/sectionAppearanceSql.spec.ts holds the lists equal).
--   • The anchor's shape: lower-case words joined by single hyphens, 1 to 40 characters, never
--     an id the site's code renders (by name, prefix or ending); unique on its page (a deferred
--     UNIQUE: a swap inside one transaction passes, a duplicate fails at its check).
--   • Who writes them (CLAUDE.md §5 "Pages & sections", §9): the table's own RLS, unchanged.
--     Admin and Content Creator; SEO, Developer, a Sales token and another tenant's Admin
--     change no row; anon has no UPDATE at all (42501).
--   • Who reads them: anon on a visible section of a published page (0016), never a hidden one.
--   • History keeps them; the release registry stages them; a password page's unlocked read
--     (service role only) returns them.

begin;
select plan(51);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('e9000000-0000-0000-0000-0000000000ff', 'T-E9');

insert into public.pages (id, tenant_id, slug, title, status) values
  ('e9000000-0000-0000-0000-00000000a001', app.default_tenant_id(), 'e9-look-page',
   '{"en":"E9 page","ar":"صفحة"}', 'published'),
  ('e9000000-0000-0000-0000-00000000a002', app.default_tenant_id(), 'e9-other-page',
   '{"en":"E9 other","ar":"أخرى"}', 'published');
insert into public.page_sections (id, tenant_id, page_id, type, content, visible, sort_order) values
  -- a Text block (takes every choice), shown
  ('e9000000-0000-0000-0000-0000000051a1', app.default_tenant_id(),
   'e9000000-0000-0000-0000-00000000a001', 'textBlock', '{}', true, 10),
  -- a call to action (a reveal and an anchor, no background or spacing), shown
  ('e9000000-0000-0000-0000-0000000051a2', app.default_tenant_id(),
   'e9000000-0000-0000-0000-00000000a001', 'cta', '{}', true, 20),
  -- a hero (no reveal), hidden
  ('e9000000-0000-0000-0000-0000000051a3', app.default_tenant_id(),
   'e9000000-0000-0000-0000-00000000a001', 'hero', '{}', false, 0),
  -- a Video (spacing), on the other page
  ('e9000000-0000-0000-0000-0000000051a4', app.default_tenant_id(),
   'e9000000-0000-0000-0000-00000000a002', 'video', '{}', true, 10);

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', 'e9000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- How many rows the CURRENT role changed by setting one appearance column of one section.
create function _set(p_id uuid, p_column text, p_value text) returns int language plpgsql as $$
declare n int;
begin
  execute format('update public.page_sections set %I = $1 where id = $2', p_column)
    using p_value, p_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- the columns -----------------------------------------------------------------------------
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'page_sections'
              and column_name in ('background', 'spacing', 'reveal', 'anchor')
              and data_type = 'text' and is_nullable = 'YES' and column_default is null),
  4, 'page_sections has background, spacing, reveal and anchor: nullable text, no default');
select is((select count(*)::int from public.page_sections
            where background is not null or spacing is not null or reveal is not null
               or anchor is not null),
  0, 'every section starts with its own look (null): nothing renders differently');

-- ---- who writes them -------------------------------------------------------------------------
set local role authenticated;
select _as('admin', app.default_tenant_id()::text);
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'background', 'ink'), 1,
  'admin gives a Text block a background');
select is((select background from public.page_sections where id = 'e9000000-0000-0000-0000-0000000051a1'),
  'ink', 'and it reads back');
select ok(exists (select 1 from public.content_versions
                   where entity_type = 'page_section'
                     and entity_id = 'e9000000-0000-0000-0000-0000000051a1'
                     and snapshot ->> 'background' = 'ink'),
  'the change is history: the snapshot keeps the background');
select _as('content_creator', app.default_tenant_id()::text);
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'spacing', 'roomy'), 1,
  'content_creator sets a spacing (pages.write)');
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'anchor', 'our-story'), 1,
  'content_creator sets an anchor');
select _as('seo', app.default_tenant_id()::text);
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'reveal', 'fade'), 0,
  'seo changes no section (no pages.write)');
select _as('developer', app.default_tenant_id()::text);
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'reveal', 'fade'), 0,
  'developer changes no section');
select _as('sales', app.default_tenant_id()::text);
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'reveal', 'fade'), 0,
  'a sales token changes no section');
select _as('admin', 'e9000000-0000-0000-0000-0000000000ff');
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'reveal', 'fade'), 0,
  'another tenant''s admin changes no section of T1');

-- ---- the buckets and the kinds (the CHECKs), as the admin --------------------------------------
select _as('admin', app.default_tenant_id()::text);
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'background', 'mist'), 1, 'mist is a background');
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'background', 'klein'), 1, 'klein is a background');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a1', 'background', 'paper') $$,
  '23514', null, 'a background outside the bucket is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'background', 'ink') $$,
  '23514', null, 'a call to action keeps its own background (only the Text block and the Gallery take one)');
select is(_set('e9000000-0000-0000-0000-0000000051a4', 'spacing', 'compact'), 1, 'a Video takes a spacing');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'spacing', 'compact') $$,
  '23514', null, 'a call to action keeps its own spacing');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a1', 'spacing', 'huge') $$,
  '23514', null, 'a spacing outside the bucket is refused');
select is(_set('e9000000-0000-0000-0000-0000000051a2', 'reveal', 'rise'), 1, 'a call to action takes a reveal');
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'reveal', 'fade'), 1, 'a Text block takes a reveal');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a3', 'reveal', 'fade') $$,
  '23514', null, 'a hero opens a page: it takes no reveal');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a1', 'reveal', 'slide') $$,
  '23514', null, 'a reveal outside the bucket is refused');
select throws_ok($$ update public.page_sections set type = 'cta'
                    where id = 'e9000000-0000-0000-0000-0000000051a1' $$,
  '23514', null, 'a kind change that leaves a background its new kind does not take is refused');
select is(_set('e9000000-0000-0000-0000-0000000051a1', 'background', null), 1,
  'null puts the section''s own background back');

-- ---- the anchor's shape ------------------------------------------------------------------------
select is(_set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'next-step-2'), 1,
  'an anchor of words, digits and single hyphens is taken');
select is(_set('e9000000-0000-0000-0000-0000000051a2', 'anchor', repeat('a', 40)), 1,
  'an anchor of 40 characters is taken');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', repeat('a', 41)) $$,
  '23514', null, 'an anchor of 41 characters is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'Our-Story') $$,
  '23514', null, 'capitals are refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'our--story') $$,
  '23514', null, 'a double hyphen is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', '2-story') $$,
  '23514', null, 'an anchor starting with a digit is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', '') $$,
  '23514', null, 'an empty anchor is refused (null is none)');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'main') $$,
  '23514', null, '#main (the skip link''s target) is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'inquiry') $$,
  '23514', null, 'a code anchor (#inquiry) is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'story-heading') $$,
  '23514', null, 'a heading''s id pattern (-heading) is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'cf-name') $$,
  '23514', null, 'a form control''s id pattern (cf-) is refused');
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'svc-tab-events') $$,
  '23514', null, 'the explorer''s id pattern (svc-) is refused');

-- ---- one anchor, one section of its page -------------------------------------------------------
select is(_set('e9000000-0000-0000-0000-0000000051a2', 'anchor', 'next-step'), 1, 'the call to action takes next-step');
select is(_set('e9000000-0000-0000-0000-0000000051a4', 'anchor', 'next-step'), 1,
  'a section of ANOTHER page takes the same anchor');
set constraints public.page_sections_anchor_unique immediate;
select throws_ok($$ select _set('e9000000-0000-0000-0000-0000000051a1', 'anchor', 'next-step') $$,
  '23505', null, 'a second section of the same page cannot take it');
set constraints public.page_sections_anchor_unique deferred;
select lives_ok($$
  update public.page_sections set anchor = 'our-story' where id = 'e9000000-0000-0000-0000-0000000051a2';
  update public.page_sections set anchor = 'next-step' where id = 'e9000000-0000-0000-0000-0000000051a1';
  set constraints public.page_sections_anchor_unique immediate;
$$, 'two sections swap their anchors in one transaction (the release apply''s case: deferred)');
set constraints public.page_sections_anchor_unique deferred;
select is((select string_agg(anchor, ',' order by sort_order) from public.page_sections
            where page_id = 'e9000000-0000-0000-0000-00000000a001' and anchor is not null),
  'next-step,our-story', 'and each holds the other''s');

-- ---- who reads them ----------------------------------------------------------------------------
set local role anon;
select _as(null, null);
select is((select format('%s %s %s', coalesce(background, '-'), spacing, anchor)
             from public.page_sections where id = 'e9000000-0000-0000-0000-0000000051a1'),
  '- roomy next-step', 'anon reads a visible section''s appearance on a published page (0016)');
select is((select count(*)::int from public.page_sections
            where id = 'e9000000-0000-0000-0000-0000000051a3'), 0,
  'anon reads no hidden section, its appearance included');
select throws_ok($$ update public.page_sections set reveal = 'fade' $$, '42501', null,
  'anon cannot write an appearance (no UPDATE grant)');

-- ---- the registry and the unlocked read (as the migration role) --------------------------------
reset role;
select _as(null, null);
select is((select columns from app.release_entities where entity_type = 'page_section'),
  array['page_id', 'type', 'content', 'style', 'visible', 'sort_order', 'is_placeholder', 'label',
        'background', 'spacing', 'reveal', 'anchor'],
  'the release registry stages them: page_section''s columns end with the four');
select ok((select condeferrable and condeferred from pg_constraint
            where conrelid = 'public.page_sections'::regclass
              and conname = 'page_sections_anchor_unique'),
  'the anchor''s UNIQUE is deferred to the commit');
select ok(not has_function_privilege('anon', 'public.page_sections_unlocked(uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.page_sections_unlocked(uuid, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.page_sections_unlocked(uuid, uuid)', 'execute'),
  'the unlocked read stays the service role''s alone');
select ok(exists (select 1 from pg_proc
                   where oid = 'public.page_sections_unlocked(uuid, uuid)'::regprocedure
                     and prosecdef and proconfig @> array['search_path=""']),
  'and stays a definer with its search_path pinned');
set local role service_role;
select is((select format('%s %s %s %s', type, coalesce(background, '-'), spacing, anchor)
             from public.page_sections_unlocked(app.default_tenant_id(),
                                                'e9000000-0000-0000-0000-00000000a001')
            where type = 'textBlock'),
  'textBlock - roomy next-step', 'a password page''s unlocked read returns the appearance');
select is((select count(*)::int
             from public.page_sections_unlocked(app.default_tenant_id(),
                                                'e9000000-0000-0000-0000-00000000a001')),
  2, 'and, as before, only the visible sections of the published page');
select is((select reveal from public.page_sections_unlocked(app.default_tenant_id(),
                                                'e9000000-0000-0000-0000-00000000a001')
            where type = 'cta'),
  'rise', 'with the reveal');
reset role;

select * from finish();
rollback;
