-- pgTAP: the preview's help guide, previewing-changes (Admin v2 R9; its migration puts it
-- through H11's catalog, 0069). Run with `supabase test db`. help_centre.test.sql and
-- help_catalog.test.sql prove the guides' table, its RLS and the catalog; this file proves
-- only what R9's put leaves:
--   1. the catalog holds the guide once, as a new guide (revision 1), in R9's place (95),
--      naming the twelve capabilities of the preview's door and its three screens;
--   2. every tenant holds it as the catalog renders it, and so does a tenant made after it
--      (the tenants trigger, 0046);
--   3. each staff role reads its own tenant's copy (which guides a role is SHOWN is the
--      Worker's filter from ROLE_CAPS, tests/lib/previewGuide.spec.ts), another tenant's
--      admin reads none of it, and anon is refused.
-- Guide counts are never pinned here: other slices add guides (H11 rule 7).

begin;
select plan(13);

insert into public.tenants (id, name) values
  ('95000000-0000-4000-8000-00000000000a', 'PreviewGuideA'),
  ('95000000-0000-4000-8000-0000000000ff', 'PreviewGuideB');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '95000000-0000-4000-8000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The tenant A copy of the guide, as a role sees it under RLS.
create function _seen_a() returns int language sql as $$
  select count(*)::int from public.help_articles
   where tenant_id = '95000000-0000-4000-8000-00000000000a' and slug = 'previewing-changes'
$$;

-- ---- 1. the catalog (read as the migration role) --------------------------------------------
select is((select count(*)::int from app.help_guide_catalog where slug = 'previewing-changes'), 1,
  'the catalog holds previewing-changes once');
select ok((select revision = 1 and sort_order = 95 and minutes = 3
             from app.help_guide_catalog where slug = 'previewing-changes'),
  'as a new guide (revision 1), in R9''s place (95)');
select is((select array(select unnest(caps) order by 1)
             from app.help_guide_catalog where slug = 'previewing-changes'),
  array['blog.write', 'categories.manage', 'maintenance.manage', 'nav.edit', 'pages.write',
        'portfolio.write', 'redirects.manage', 'seo.entityMeta', 'seo.globalDefaults',
        'services.write', 'settings.general', 'theme.edit']::text[],
  'for the twelve capabilities of the preview''s door (PREVIEW_READ_CAPS)');
select is((select screens from app.help_guide_catalog where slug = 'previewing-changes'),
  array['/admin/preview', '/admin/pages', '/admin/visibility']::text[],
  'its screens: the preview, Pages and Page visibility');

-- ---- 2. every tenant holds it, a new one included ---------------------------------------------
select is((select count(*)::int
             from public.tenants t
            where not exists (
              select 1 from public.help_articles h
                join app.help_guide_catalog c on c.slug = h.slug
               where h.tenant_id = t.id and h.slug = 'previewing-changes'
                 and h.sort_order = c.sort_order and h.caps = c.caps and h.screens = c.screens
                 and h.title = c.title and h.title_ar = c.title_ar and h.body = c.body)),
  0, 'every tenant, the two made in this file included, holds the guide as the catalog has it');
select ok((select (a ->> 'sort_order')::int = 95
             from jsonb_array_elements(app.help_article_set()) a
            where a ->> 'slug' = 'previewing-changes'),
  'the set lists it in its place');

-- ---- 3. who reads it ----------------------------------------------------------------------------
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.help_articles where slug = 'previewing-changes' $$,
  '42501', null, 'anon cannot read the guide');

set local role authenticated;
select _as('admin', '95000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'admin reads its tenant''s copy');
select _as('content_creator', '95000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'content_creator reads its tenant''s copy');
select _as('seo', '95000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'seo reads its tenant''s copy');
select _as('developer', '95000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'developer reads its tenant''s copy');
select _as('admin', '95000000-0000-4000-8000-0000000000ff');
select is(_seen_a(), 0, 'another tenant''s admin reads none of tenant A''s copy');
select is((select count(*)::int from public.help_articles where slug = 'previewing-changes'), 1,
  'and reads its own tenant''s copy only');

reset role;
select * from finish();
rollback;
