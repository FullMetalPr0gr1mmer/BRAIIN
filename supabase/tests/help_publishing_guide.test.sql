-- pgTAP: the publishing guide and the page-visibility guide for both ways of publishing (Admin
-- v2 R14b; its migration puts both through H11's catalog). Run with `supabase test db`.
-- help_centre.test.sql and help_catalog.test.sql prove the guides' table, its RLS and the
-- catalog; this file proves only what R14b's two puts leave:
--   1. the catalog holds each guide once, at revision 2, in its place, with its capabilities,
--      and with the words release mode adds;
--   2. every tenant holds both as the catalog renders them, a tenant made after them included;
--   3. a writer role reads its own tenant's copy, another tenant's admin reads none of it, and
--      anon is refused.
-- Guide counts are never pinned here: other slices add guides (H11 rule 7).

begin;
select plan(11);

insert into public.tenants (id, name) values
  ('14b00000-0000-4000-8000-00000000000a', 'PublishingGuideA'),
  ('14b00000-0000-4000-8000-0000000000ff', 'PublishingGuideB');

create function r14b_as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '14b00000-0000-4000-8000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

create function r14b_seen_a() returns int language sql as $$
  select count(*)::int from public.help_articles
   where tenant_id = '14b00000-0000-4000-8000-00000000000a'
     and slug in ('saving-and-publishing', 'page-visibility')
$$;

-- ---- 1. the catalog (read as the migration role) --------------------------------------------
select ok((select revision = 2 and sort_order = 40 and cardinality(caps) = 6
             from app.help_guide_catalog where slug = 'saving-and-publishing'),
  'saving-and-publishing is at revision 2, in its place (40), with its six capabilities');
select ok((select body #>> '{en,0,x}' like '%Until it is, what you save is what the site shows%'
             from app.help_guide_catalog where slug = 'saving-and-publishing'),
  'it says a save is live until publishing in releases is switched on');
select ok((select body #>> '{en,5,x}' like 'Save no longer changes the site.%'
             from app.help_guide_catalog where slug = 'saving-and-publishing'),
  'and what Save does once it is');
select ok((select revision = 2 and sort_order = 105 and caps = array['maintenance.manage']
             from app.help_guide_catalog where slug = 'page-visibility'),
  'page-visibility is at revision 2, in its place (105), for maintenance.manage');
select ok((select body #>> '{en,2,x}' like 'Once publishing in releases is switched on, a change here waits%'
             from app.help_guide_catalog where slug = 'page-visibility'),
  'it says a setting waits for a release once releases are on');

-- ---- 2. every tenant holds both, a new one included -------------------------------------------
select is((select count(*)::int
             from public.tenants t
             cross join (values ('saving-and-publishing'), ('page-visibility')) g(slug)
            where not exists (
              select 1 from public.help_articles h
                join app.help_guide_catalog c on c.slug = h.slug
               where h.tenant_id = t.id and h.slug = g.slug
                 and h.sort_order = c.sort_order and h.caps = c.caps and h.screens = c.screens
                 and h.title = c.title and h.title_ar = c.title_ar and h.body = c.body)),
  0, 'every tenant, the two made in this file included, holds both as the catalog has them');

-- ---- 3. who reads them --------------------------------------------------------------------------
set local role anon;
select r14b_as(null, null);
select throws_ok($$ select count(*) from public.help_articles where slug = 'saving-and-publishing' $$,
  '42501', null, 'anon cannot read the guides');

set local role authenticated;
select r14b_as('admin', '14b00000-0000-4000-8000-00000000000a');
select is(r14b_seen_a(), 2, 'admin reads its tenant''s copies');
select r14b_as('content_creator', '14b00000-0000-4000-8000-00000000000a');
select is(r14b_seen_a(), 2, 'content_creator reads its tenant''s copies');
select r14b_as('developer', '14b00000-0000-4000-8000-00000000000a');
select is(r14b_seen_a(), 2, 'developer reads its tenant''s copies');
select r14b_as('admin', '14b00000-0000-4000-8000-0000000000ff');
select is(r14b_seen_a(), 0, 'another tenant''s admin reads none of this tenant''s copies');

select * from finish();
rollback;
