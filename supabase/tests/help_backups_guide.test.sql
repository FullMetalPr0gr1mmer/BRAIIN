-- pgTAP: the Backups & versions help guide, backups-and-versions (Admin v2 R13; its migration
-- puts it through H11's catalog). Run with `supabase test db`. help_centre.test.sql and
-- help_catalog.test.sql prove the guides' table, its RLS and the catalog; this file proves only
-- what R13's put leaves:
--   1. the catalog holds the guide once, as a new guide (revision 1), in R13's place (125),
--      naming the twelve release read capabilities and its one screen;
--   2. every tenant holds it as the catalog renders it, a tenant made after it included;
--   3. each staff role reads its own tenant's copy (which guides a role is SHOWN is the Worker's
--      filter from ROLE_CAPS, tests/lib/helpCentre.spec.ts), another tenant's admin reads none
--      of it, and anon is refused.
-- Guide counts are never pinned here: other slices add guides (H11 rule 7).

begin;
select plan(13);

insert into public.tenants (id, name) values
  ('13000000-0000-4000-8000-00000000000a', 'BackupsGuideA'),
  ('13000000-0000-4000-8000-0000000000ff', 'BackupsGuideB');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '13000000-0000-4000-8000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

create function _seen_a() returns int language sql as $$
  select count(*)::int from public.help_articles
   where tenant_id = '13000000-0000-4000-8000-00000000000a' and slug = 'backups-and-versions'
$$;

-- ---- 1. the catalog (read as the migration role) --------------------------------------------
select is((select count(*)::int from app.help_guide_catalog where slug = 'backups-and-versions'), 1,
  'the catalog holds backups-and-versions once');
select ok((select revision = 1 and sort_order = 125 and minutes = 3
             from app.help_guide_catalog where slug = 'backups-and-versions'),
  'as a new guide (revision 1), in R13''s place (125)');
select is((select array(select unnest(caps) order by 1)
             from app.help_guide_catalog where slug = 'backups-and-versions'),
  array['blog.write', 'categories.manage', 'maintenance.manage', 'nav.edit', 'pages.write',
        'portfolio.write', 'redirects.manage', 'seo.entityMeta', 'seo.globalDefaults',
        'services.write', 'settings.general', 'theme.edit']::text[],
  'for the twelve release read capabilities (RELEASE_READ_CAPS)');
select is((select screens from app.help_guide_catalog where slug = 'backups-and-versions'),
  array['/admin/backups']::text[],
  'its screen: Backups & versions');

-- ---- 2. every tenant holds it, a new one included ---------------------------------------------
select is((select count(*)::int
             from public.tenants t
            where not exists (
              select 1 from public.help_articles h
                join app.help_guide_catalog c on c.slug = h.slug
               where h.tenant_id = t.id and h.slug = 'backups-and-versions'
                 and h.sort_order = c.sort_order and h.caps = c.caps and h.screens = c.screens
                 and h.title = c.title and h.title_ar = c.title_ar and h.body = c.body)),
  0, 'every tenant, the two made in this file included, holds the guide as the catalog has it');
select ok((select (a ->> 'sort_order')::int = 125
             from jsonb_array_elements(app.help_article_set()) a
            where a ->> 'slug' = 'backups-and-versions'),
  'the set lists it in its place');

-- ---- 3. who reads it ----------------------------------------------------------------------------
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.help_articles where slug = 'backups-and-versions' $$,
  '42501', null, 'anon cannot read the guide');

set local role authenticated;
select _as('admin', '13000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'admin reads its tenant''s copy');
select _as('content_creator', '13000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'content_creator reads its tenant''s copy');
select _as('seo', '13000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'seo reads its tenant''s copy');
select _as('developer', '13000000-0000-4000-8000-00000000000a');
select is(_seen_a(), 1, 'developer reads its tenant''s copy');
select _as('admin', '13000000-0000-4000-8000-0000000000ff');
select is(_seen_a(), 0, 'another tenant''s admin reads none of tenant A''s copy');
select is((select count(*)::int from public.help_articles where slug = 'backups-and-versions'), 1,
  'and reads its own tenant''s copy only');

reset role;
select * from finish();
rollback;
