-- pgTAP: the Style-Finder and job applications guides (Admin v2 U8, put by the u8_editors
-- migration through H11's catalog, 0069). Run with `supabase test db`.
--
--   • style-finder is in the catalog (revision 1, place 115, its caps and three screens) and
--     in every tenant: the launch tenant and a tenant made after the migration (the tenants
--     trigger seeds it from the catalog).
--   • job-applications carries the drawer's first step in the catalog (revision 2) and in the
--     launch tenant.
--   • Who reads it (CLAUDE.md §9): RLS on help_articles is staff-wide, so Admin, Content
--     Creator, SEO and Developer each read style-finder in their own tenant (which guides a
--     role is SHOWN is the Worker's filter, tests/lib/helpCentre.spec.ts); anon is refused
--     (42501, no grant); another tenant's admin reads none of the launch tenant's guides.
--   • Seeding again changes nothing: the guide's version stays where it was.
-- No stale-token rows: no definer function or live check is involved in reading a guide.

begin;
select plan(13);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('74000000-0000-0000-0000-0000000000ff', 'T-U8');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '74000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- How many style-finder guides the CURRENT role reads in the launch tenant.
create function _sf_launch() returns int language sql as $$
  select count(*)::int from public.help_articles
   where tenant_id = app.default_tenant_id() and slug = 'style-finder'
$$;

-- ---- the catalog and the seed (as the migration role) -------------------------------------
select ok(exists (select 1 from app.help_guide_catalog
                   where slug = 'style-finder' and revision >= 1 and sort_order = 115
                     and caps = array['ai.editContent', 'ai.config']
                     and screens = array['/admin/ai-questions', '/admin/ai-styles', '/admin/ai-config']),
  'the catalog holds style-finder for the three Style-Finder screens');
select is((select count(*)::int from public.help_articles
            where tenant_id = app.default_tenant_id() and slug = 'style-finder'
              and title = 'Style-Finder' and caps = array['ai.editContent', 'ai.config']), 1,
  'the launch tenant holds style-finder with the catalog''s caps');
select is((select count(*)::int from public.help_articles
            where tenant_id = '74000000-0000-0000-0000-0000000000ff' and slug = 'style-finder'), 1,
  'a tenant made after the migration gets style-finder too (the tenants trigger)');
select ok(exists (select 1 from app.help_guide_catalog h
                   join public.help_articles a
                     on a.slug = h.slug and a.tenant_id = app.default_tenant_id()
                  where h.slug = 'job-applications' and h.revision >= 2
                    and a.body -> 'en' -> 1 -> 'x' ->> 0 like 'Open an application to read it,%'),
  'job-applications carries the drawer''s first step, in the catalog and the launch tenant');

-- ---- anon: nothing ----------------------------------------------------------------------
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.help_articles where slug = 'style-finder' $$,
  '42501', null, 'anon cannot read the guide');

-- ---- each staff role of the launch tenant reads it ----------------------------------------
set local role authenticated;
select _as('admin', app.default_tenant_id()::text);
select is(_sf_launch(), 1, 'admin reads style-finder');
select _as('content_creator', app.default_tenant_id()::text);
select is(_sf_launch(), 1, 'content_creator reads style-finder');
select _as('seo', app.default_tenant_id()::text);
select is(_sf_launch(), 1, 'seo reads style-finder (RLS is staff-wide; the Worker filters by caps)');
select _as('developer', app.default_tenant_id()::text);
select is(_sf_launch(), 1, 'developer reads style-finder (the same)');

-- ---- another tenant's admin: its own guide, none of the launch tenant's ---------------------
select _as('admin', '74000000-0000-0000-0000-0000000000ff');
select is(_sf_launch(), 0, 'another tenant''s admin reads none of the launch tenant''s guides');
select is((select count(*)::int from public.help_articles where slug = 'style-finder'), 1,
  'and reads its own tenant''s style-finder');

-- ---- seeding again (as the migration role) changes nothing --------------------------------
reset role;
select _as(null, null);
create temporary table _v as
  select tenant_id, version from public.help_articles where slug = 'style-finder';
select app.seed_help_articles(app.default_tenant_id());
select app.seed_help_articles('74000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.help_articles a join _v using (tenant_id)
            where a.slug = 'style-finder' and a.version = _v.version),
  (select count(*)::int from _v),
  'seeding again leaves the guide''s version where it was');
select is((select count(*)::int from public.help_articles
            where tenant_id = '74000000-0000-0000-0000-0000000000ff' and slug = 'style-finder'), 1,
  'and adds no second copy');

select * from finish();
rollback;
