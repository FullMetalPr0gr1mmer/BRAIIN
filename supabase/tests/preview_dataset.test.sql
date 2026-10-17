-- pgTAP: the facts the releases preview stands on (Admin v2 R8; no migration).
--
-- The preview (src/lib/preview) reads live rows through the signed-in person's OWN client and
-- keeps what a visitor would read with a TypeScript mirror of anon's RLS. That is only right
-- while these hold, so this file pins them:
--   1. each CMS role (admin, content_creator, seo, developer) reads every row of the 21 tables
--      a public loader reads, in its tenant, whatever the status or visible flag, with the
--      dataset's projection (`*`, or anon's columns on the four column-granted tables); a
--      `sales` claim and anon read only what is public; another tenant's admin reads none;
--   2. the CMS roles read their tenant's pending changes (content_drafts); a `sales` claim
--      and another tenant read none, and anon holds no privilege;
--   3. anon's column grants on testimonials, media_assets, disciplines and service_cases
--      equal the literal in _anon_columns() below, and the other 17 tables are granted to
--      anon whole; staff also read _dataset_only_columns() (a quote's consent record);
--   4. the column defaults a pending create starts from equal _create_defaults() below;
--   5. the policies that apply to an anon SELECT on each table equal _anon_policies() below,
--      so a migration that adds, drops or renames one (U14b's page_sections_password_fence,
--      0061) fails here until the mirror (src/lib/preview/visibility.ts) gains its rule;
--   6. page visibility (0057) is no row security: anon holds nothing on page_visibility.
-- The literals are held equal to ANON_COLUMNS, DATASET_ONLY_COLUMNS, CREATE_DEFAULTS and MIRRORED_POLICIES
-- by tests/lib/previewMirror.spec.ts, which parses this file: a grant, default or policy
-- that moves fails one side until the other follows.
--
-- Rows run over admin, content_creator, seo, developer, a `sales` claim (the role arrives
-- with C10; the policies read the role from the claim), anon and other_tenant (CLAUDE.md
-- §9). No stale-token row: R8 adds no policy and no definer relying on app.live_role(); the
-- dataset reads exactly what the person's token reads. R9's gate is where a live recheck
-- would go.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8, §9.

begin;
select plan(20);

-- ── The literals (parsed by tests/lib/previewMirror.spec.ts; keep one row per line) ──────
create function _anon_columns() returns table (tbl text, cols text) language sql immutable as $$
  values
    ('disciplines', 'id,tenant_id,slug,name,short,blurb,poster_media_id,preview_video_path,preview_start_s,preview_end_s,status,sort_order,published_at,updated_at'),
    ('media_assets', 'id,tenant_id,kind,provider,storage_path,width,height,alt,stream_uid,mime_type,updated_at'),
    ('service_cases', 'id,tenant_id,service_id,portfolio_id,title,context,problems,results,status,published_at,updated_at'),
    ('testimonials', 'id,tenant_id,slug,quote,author_name,author_role,client_id,portfolio_id,avatar_media_id,placements,status,sort_order,published_at,updated_at')
$$;

-- Columns the dataset also reads for its own checks (a quote's consent record), never
-- answered to a loader: staff read them; anon's grant (above) does not hold them.
create function _dataset_only_columns() returns table (tbl text, cols text) language sql immutable as $$
  values
    ('testimonials', 'consent_obtained_at,is_placeholder')
$$;

create function _create_defaults() returns table (tbl text, col text, dflt text) language sql immutable as $$
  values
    ('blog_posts', 'status', $d$'draft'::content_status$d$),
    ('certifications', 'sort_order', $d$0$d$),
    ('certifications', 'status', $d$'draft'::content_status$d$),
    ('clients', 'is_placeholder', $d$false$d$),
    ('clients', 'show_in_marquee', $d$false$d$),
    ('clients', 'sort_order', $d$0$d$),
    ('clients', 'visible', $d$false$d$),
    ('disciplines', 'sort_order', $d$0$d$),
    ('disciplines', 'status', $d$'draft'::content_status$d$),
    ('entity_seo', 'meta_description', $d$'{}'::jsonb$d$),
    ('entity_seo', 'meta_title', $d$'{}'::jsonb$d$),
    ('navigation', 'is_key', $d$false$d$),
    ('navigation', 'sort_order', $d$0$d$),
    ('navigation', 'visible', $d$true$d$),
    ('page_sections', 'content', $d$'{}'::jsonb$d$),
    ('page_sections', 'is_placeholder', $d$false$d$),
    ('page_sections', 'sort_order', $d$0$d$),
    ('page_sections', 'style', $d$'{}'::jsonb$d$),
    ('page_sections', 'visible', $d$true$d$),
    ('pages', 'nav_visible', $d$true$d$),
    ('pages', 'status', $d$'draft'::content_status$d$),
    ('portfolio', 'is_featured', $d$false$d$),
    ('portfolio', 'is_placeholder', $d$false$d$),
    ('portfolio', 'keywords', $d$'[]'::jsonb$d$),
    ('portfolio', 'results', $d$'[]'::jsonb$d$),
    ('portfolio', 'scope', $d$'[]'::jsonb$d$),
    ('portfolio', 'sort_order', $d$0$d$),
    ('portfolio', 'status', $d$'draft'::content_status$d$),
    ('sectors', 'sort_order', $d$0$d$),
    ('sectors', 'visible', $d$true$d$),
    ('seo_defaults', 'default_description', $d$'{}'::jsonb$d$),
    ('seo_defaults', 'default_title', $d$'{}'::jsonb$d$),
    ('seo_defaults', 'organization', $d$'{}'::jsonb$d$),
    ('seo_defaults', 'robots_directives', $d$'index,follow'::text$d$),
    ('seo_defaults', 'title_template', $d$'{}'::jsonb$d$),
    ('service_cases', 'is_placeholder', $d$false$d$),
    ('service_cases', 'problems', $d$'[]'::jsonb$d$),
    ('service_cases', 'results', $d$'[]'::jsonb$d$),
    ('service_cases', 'status', $d$'draft'::content_status$d$),
    ('services', 'deliverables', $d$'[]'::jsonb$d$),
    ('services', 'is_teaser', $d$false$d$),
    ('services', 'sort_order', $d$0$d$),
    ('services', 'status', $d$'draft'::content_status$d$),
    ('services', 'value_points', $d$'[]'::jsonb$d$),
    ('site_profile', 'accepting_applications', $d$false$d$),
    ('site_profile', 'address_country', $d$'SA'::text$d$),
    ('site_profile', 'socials', $d$'[]'::jsonb$d$),
    ('statistics', 'is_placeholder', $d$false$d$),
    ('statistics', 'placement_labels', $d$'{}'::jsonb$d$),
    ('statistics', 'placements', $d$'{}'::text[]$d$),
    ('statistics', 'sort_order', $d$0$d$),
    ('statistics', 'status', $d$'draft'::content_status$d$),
    ('team_members', 'is_leadership', $d$false$d$),
    ('team_members', 'is_placeholder', $d$false$d$),
    ('team_members', 'sort_order', $d$0$d$),
    ('team_members', 'status', $d$'draft'::content_status$d$),
    ('testimonials', 'is_placeholder', $d$false$d$),
    ('testimonials', 'placements', $d$'{}'::text[]$d$),
    ('testimonials', 'sort_order', $d$0$d$),
    ('testimonials', 'status', $d$'draft'::content_status$d$)
$$;

create function _anon_policies() returns table (tbl text, policies text) language sql immutable as $$
  values
    ('blog_posts', 'blog_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c'),
    ('categories', 'categories_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54,categories_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('certifications', 'certifications_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,certifications_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('clients', 'clients_read:PERMISSIVE:db9934fa0ab3f173e346a67310b57bac,clients_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('disciplines', 'disciplines_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,disciplines_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('entity_seo', 'entity_seo_published_only:RESTRICTIVE:df5c9a7d7588fed51b9e8704523bf0a3,entity_seo_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54,entity_seo_write:PERMISSIVE:763c5ebb7d12ee38b8e17d30ad1570df'),
    ('media_assets', 'media_assets_public_read:PERMISSIVE:88fb58b63c6cf01b1652b4f3959970a6,media_read:PERMISSIVE:392446073406bce5902ebbac287245a1,media_write:PERMISSIVE:4f9223ffe3d088ba7a0a4098c7d190d6'),
    ('navigation', 'navigation_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54,navigation_visible_only:RESTRICTIVE:d3e6a42adad1d6a81062627de227ba33,navigation_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('page_sections', 'page_sections_published_only:RESTRICTIVE:1f97d3d1084c993ca178204580b8d11d,page_sections_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54,page_sections_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('pages', 'pages_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,pages_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('portfolio', 'portfolio_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,portfolio_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('portfolio_media', 'portfolio_media_read:PERMISSIVE:89df8ca10e4d24f57e626287d4263bdb,portfolio_media_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('portfolio_services', 'portfolio_services_published_only:RESTRICTIVE:ebe8eb7b2d30d7fa86ce01cf9d110773,portfolio_services_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54,portfolio_services_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('sectors', 'sectors_read:PERMISSIVE:db9934fa0ab3f173e346a67310b57bac,sectors_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('seo_defaults', 'seo_defaults_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54,seo_defaults_write:PERMISSIVE:763c5ebb7d12ee38b8e17d30ad1570df'),
    ('service_cases', 'service_cases_published_parent:RESTRICTIVE:5ec4bd1be2ede2fd328e9818b89a640d,service_cases_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,service_cases_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('services', 'services_discipline_in_tenant:RESTRICTIVE:b326b5062b2f0e69046810717534cb09,services_discipline_published:RESTRICTIVE:c37eff0d6d10d79117aab9034276c0fa,services_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c'),
    ('site_profile', 'site_profile_read:PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54'),
    ('statistics', 'statistics_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,statistics_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('team_members', 'team_members_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,team_members_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060'),
    ('testimonials', 'testimonials_read:PERMISSIVE:a3adeda401046be963dd172ac14b795c,testimonials_write:PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060')
$$;

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ──────────────────────────
-- Launch-tenant rows (the tenant anon is fenced to), every id under the 8a000000- prefix: one
-- public row per table and the hidden ones (draft, archived, not visible, under a draft
-- parent); another tenant for the other_tenant row.
select set_config('pv.launch', app.default_tenant_id()::text, true);
insert into public.tenants (id, name) values ('8b000000-0000-4000-8000-00000000000b', 'PreviewOther');

insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('8a000000-0000-4000-8000-000000000101', app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg'),
  ('8a000000-0000-4000-8000-000000000102', app.default_tenant_id(), 'image', 'static', 'stills/work/p1.jpg');

insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('8a000000-0000-4000-8000-000000000201', app.default_tenant_id(), 'pv-disc-pub', '{"en":"P","ar":"ب"}', 'published'),
  ('8a000000-0000-4000-8000-000000000202', app.default_tenant_id(), 'pv-disc-draft', '{"en":"D","ar":"د"}', 'draft'),
  ('8a000000-0000-4000-8000-000000000203', app.default_tenant_id(), 'pv-disc-arch', '{"en":"A","ar":"أ"}', 'archived');

insert into public.services (id, tenant_id, slug, title, status, discipline_id) values
  ('8a000000-0000-4000-8000-000000000211', app.default_tenant_id(), 'pv-svc-pub', '{"en":"P","ar":"ب"}', 'published', '8a000000-0000-4000-8000-000000000201'),
  ('8a000000-0000-4000-8000-000000000212', app.default_tenant_id(), 'pv-svc-draft', '{"en":"D","ar":"د"}', 'draft', '8a000000-0000-4000-8000-000000000201'),
  ('8a000000-0000-4000-8000-000000000213', app.default_tenant_id(), 'pv-svc-arch', '{"en":"A","ar":"أ"}', 'archived', null);

insert into public.service_cases (id, tenant_id, service_id, title, status) values
  ('8a000000-0000-4000-8000-000000000221', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000211', '{"en":"P","ar":"ب"}', 'published'),
  ('8a000000-0000-4000-8000-000000000222', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000212', '{"en":"D","ar":"د"}', 'published'),
  ('8a000000-0000-4000-8000-000000000223', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000213', '{"en":"A","ar":"أ"}', 'draft');

insert into public.sectors (id, tenant_id, slug, name, visible) values
  ('8a000000-0000-4000-8000-000000000301', app.default_tenant_id(), 'pv-sec-vis', '{"en":"V","ar":"ظ"}', true),
  ('8a000000-0000-4000-8000-000000000302', app.default_tenant_id(), 'pv-sec-hid', '{"en":"H","ar":"خ"}', false);

insert into public.clients (id, tenant_id, slug, name, visible) values
  ('8a000000-0000-4000-8000-000000000311', app.default_tenant_id(), 'pv-cl-vis', '{"en":"V","ar":"ظ"}', true),
  ('8a000000-0000-4000-8000-000000000312', app.default_tenant_id(), 'pv-cl-hid', '{"en":"H","ar":"خ"}', false);

insert into public.portfolio (id, tenant_id, slug, title, status, poster_media_id) values
  ('8a000000-0000-4000-8000-000000000321', app.default_tenant_id(), 'pv-pf-pub', '{"en":"P","ar":"ب"}', 'published', '8a000000-0000-4000-8000-000000000101'),
  ('8a000000-0000-4000-8000-000000000322', app.default_tenant_id(), 'pv-pf-draft', '{"en":"D","ar":"د"}', 'draft', null),
  ('8a000000-0000-4000-8000-000000000323', app.default_tenant_id(), 'pv-pf-arch', '{"en":"A","ar":"أ"}', 'archived', null);

insert into public.portfolio_services (tenant_id, portfolio_id, service_id) values
  (app.default_tenant_id(), '8a000000-0000-4000-8000-000000000321', '8a000000-0000-4000-8000-000000000211'),
  (app.default_tenant_id(), '8a000000-0000-4000-8000-000000000322', '8a000000-0000-4000-8000-000000000211');

insert into public.portfolio_media (id, tenant_id, portfolio_id, role, kind, media_id) values
  ('8a000000-0000-4000-8000-000000000331', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000321',
   'gallery', 'image', '8a000000-0000-4000-8000-000000000101'),
  -- the draft project's frame: the second asset stays hidden
  ('8a000000-0000-4000-8000-000000000332', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000322',
   'gallery', 'image', '8a000000-0000-4000-8000-000000000102');

insert into public.testimonials (id, tenant_id, slug, quote, author_name, status, consent_obtained_at) values
  ('8a000000-0000-4000-8000-000000000341', app.default_tenant_id(), 'pv-t-pub', '{"en":"Q","ar":"ق"}', '{"en":"N","ar":"ن"}', 'published', now()),
  ('8a000000-0000-4000-8000-000000000342', app.default_tenant_id(), 'pv-t-draft', '{"en":"Q","ar":"ق"}', '{"en":"N","ar":"ن"}', 'draft', null),
  ('8a000000-0000-4000-8000-000000000343', app.default_tenant_id(), 'pv-t-arch', '{"en":"Q","ar":"ق"}', '{"en":"N","ar":"ن"}', 'archived', null);

insert into public.team_members (id, tenant_id, slug, name, status) values
  ('8a000000-0000-4000-8000-000000000401', app.default_tenant_id(), 'pv-tm-pub', '{"en":"P","ar":"ب"}', 'published'),
  ('8a000000-0000-4000-8000-000000000402', app.default_tenant_id(), 'pv-tm-draft', '{"en":"D","ar":"د"}', 'draft'),
  ('8a000000-0000-4000-8000-000000000403', app.default_tenant_id(), 'pv-tm-arch', '{"en":"A","ar":"أ"}', 'archived');

insert into public.statistics (id, tenant_id, slug, label, value, status) values
  ('8a000000-0000-4000-8000-000000000411', app.default_tenant_id(), 'pv-st-pub', '{"en":"P","ar":"ب"}', '1', 'published'),
  ('8a000000-0000-4000-8000-000000000412', app.default_tenant_id(), 'pv-st-draft', '{"en":"D","ar":"د"}', '2', 'draft'),
  ('8a000000-0000-4000-8000-000000000413', app.default_tenant_id(), 'pv-st-arch', '{"en":"A","ar":"أ"}', '3', 'archived');

insert into public.certifications (id, tenant_id, slug, name, status) values
  ('8a000000-0000-4000-8000-000000000421', app.default_tenant_id(), 'pv-ce-pub', '{"en":"P","ar":"ب"}', 'published'),
  ('8a000000-0000-4000-8000-000000000422', app.default_tenant_id(), 'pv-ce-draft', '{"en":"D","ar":"د"}', 'draft'),
  ('8a000000-0000-4000-8000-000000000423', app.default_tenant_id(), 'pv-ce-arch', '{"en":"A","ar":"أ"}', 'archived');

insert into public.categories (id, tenant_id, slug, name) values
  ('8a000000-0000-4000-8000-000000000431', app.default_tenant_id(), 'pv-cat', '{"en":"C","ar":"ك"}');

insert into public.blog_posts (id, tenant_id, slug, title, status) values
  ('8a000000-0000-4000-8000-000000000441', app.default_tenant_id(), 'pv-b-pub', '{"en":"P","ar":"ب"}', 'published'),
  ('8a000000-0000-4000-8000-000000000442', app.default_tenant_id(), 'pv-b-draft', '{"en":"D","ar":"د"}', 'draft'),
  ('8a000000-0000-4000-8000-000000000443', app.default_tenant_id(), 'pv-b-arch', '{"en":"A","ar":"أ"}', 'archived');

insert into public.navigation (id, tenant_id, location, label, href, visible) values
  ('8a000000-0000-4000-8000-000000000451', app.default_tenant_id(), 'footer', '{"en":"V","ar":"ظ"}', '/pv-vis', true),
  ('8a000000-0000-4000-8000-000000000452', app.default_tenant_id(), 'footer', '{"en":"H","ar":"خ"}', '/pv-hid', false);

insert into public.pages (id, tenant_id, slug, title, status) values
  ('8a000000-0000-4000-8000-000000000501', app.default_tenant_id(), 'pv-page-pub', '{"en":"P","ar":"ب"}', 'published'),
  ('8a000000-0000-4000-8000-000000000502', app.default_tenant_id(), 'pv-page-draft', '{"en":"D","ar":"د"}', 'draft'),
  ('8a000000-0000-4000-8000-000000000503', app.default_tenant_id(), 'pv-page-arch', '{"en":"A","ar":"أ"}', 'archived');

insert into public.page_sections (id, tenant_id, page_id, type, visible) values
  ('8a000000-0000-4000-8000-000000000511', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000501', 'cta', true),
  ('8a000000-0000-4000-8000-000000000512', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000501', 'cta', false),
  ('8a000000-0000-4000-8000-000000000513', app.default_tenant_id(), '8a000000-0000-4000-8000-000000000502', 'cta', true);

insert into public.entity_seo (id, tenant_id, entity_type, entity_id) values
  ('8a000000-0000-4000-8000-000000000601', app.default_tenant_id(), 'service', '8a000000-0000-4000-8000-000000000211'),
  ('8a000000-0000-4000-8000-000000000602', app.default_tenant_id(), 'service', '8a000000-0000-4000-8000-000000000212');

-- The singletons: the seed may already hold the launch tenant's row; either way there is one.
insert into public.site_profile (tenant_id, brand_name, contact_email, location)
values (app.default_tenant_id(), '{"en":"Fixture","ar":"تجربة"}', 'hello@example.test', '{"en":"Riyadh","ar":"الرياض"}')
on conflict (tenant_id) do nothing;
insert into public.seo_defaults (tenant_id) values (app.default_tenant_id()) on conflict (tenant_id) do nothing;

-- Pending changes: two of the launch tenant's and one of the other tenant's.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload) values
  ('8a000000-0000-4000-8000-000000000701', app.default_tenant_id(), 'service',
   '8a000000-0000-4000-8000-000000000211', 'update', '{"title":{"en":"New","ar":"جديد"}}'),
  ('8a000000-0000-4000-8000-000000000702', app.default_tenant_id(), 'page',
   '8a000000-0000-4000-8000-000000000502', 'update', '{"status":"published"}'),
  ('8a000000-0000-4000-8000-000000000703', '8b000000-0000-4000-8000-00000000000b', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Theirs","ar":"لهم"}}');

-- A claim for the launch tenant (or anon when p_role is null), and the other tenant's admin.
create function _as(p_role text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object(
                'sub', '8a000000-0000-4000-8000-0000000000f1',
                'app_metadata', json_build_object('role', p_role, 'tenant_id', current_setting('pv.launch')))::text
    end,
    true)
$$;
create function _as_other() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', '8a000000-0000-4000-8000-0000000000f2',
      'app_metadata', json_build_object('role', 'admin', 'tenant_id', '8b000000-0000-4000-8000-00000000000b'))::text,
    true)
$$;

-- What the caller reads of the fixtures, table by table, with the DATASET's projection:
-- anon's columns on the four column-granted tables (plus the dataset-only columns for a
-- staff token), `*` on the rest (src/lib/preview/dataset.ts). Anon reads anon's columns.
create function _seen() returns text language plpgsql as $$
declare
  t text;
  cols text;
  pred text;
  n int;
  out text := '';
begin
  foreach t in array array['blog_posts', 'categories', 'certifications', 'clients', 'disciplines',
    'entity_seo', 'media_assets', 'navigation', 'page_sections', 'pages', 'portfolio',
    'portfolio_media', 'portfolio_services', 'sectors', 'seo_defaults', 'service_cases',
    'services', 'site_profile', 'statistics', 'team_members', 'testimonials'] loop
    select a.cols into cols from _anon_columns() a where a.tbl = t;
    if current_user <> 'anon' and exists (select 1 from _dataset_only_columns() d where d.tbl = t) then
      cols := cols || ',' || (select d.cols from _dataset_only_columns() d where d.tbl = t);
    end if;
    pred := case
      when t in ('site_profile', 'seo_defaults') then format('tenant_id::text = %L', current_setting('pv.launch'))
      when t = 'portfolio_services' then $p$portfolio_id::text like '8a000000-%'$p$
      else $p$id::text like '8a000000-%'$p$
    end;
    execute format('select count(*)::int from (select %s from public.%I where %s) s',
                   coalesce(cols, '*'), t, pred) into n;
    out := out || format('%s=%s ', t, n);
  end loop;
  return rtrim(out);
end $$;

-- The launch tenant's fixture drafts the caller reads.
create function _drafts() returns int language sql as $$
  select count(*)::int from public.content_drafts
   where id::text in ('8a000000-0000-4000-8000-000000000701', '8a000000-0000-4000-8000-000000000702')
$$;

-- ── 1. Each CMS role reads every row; sales and anon only the public ones; other_tenant none
set local role authenticated;
select _as('admin');
select is(_seen(),
  'blog_posts=3 categories=1 certifications=3 clients=2 disciplines=3 entity_seo=2 media_assets=2 navigation=2 page_sections=3 pages=3 portfolio=3 portfolio_media=2 portfolio_services=2 sectors=2 seo_defaults=1 service_cases=3 services=3 site_profile=1 statistics=3 team_members=3 testimonials=3',
  'admin reads every fixture row of the 21 tables, whatever its status or visible flag');
select _as('content_creator');
select is(_seen(),
  'blog_posts=3 categories=1 certifications=3 clients=2 disciplines=3 entity_seo=2 media_assets=2 navigation=2 page_sections=3 pages=3 portfolio=3 portfolio_media=2 portfolio_services=2 sectors=2 seo_defaults=1 service_cases=3 services=3 site_profile=1 statistics=3 team_members=3 testimonials=3',
  'content_creator reads every fixture row of the 21 tables');
select _as('seo');
select is(_seen(),
  'blog_posts=3 categories=1 certifications=3 clients=2 disciplines=3 entity_seo=2 media_assets=2 navigation=2 page_sections=3 pages=3 portfolio=3 portfolio_media=2 portfolio_services=2 sectors=2 seo_defaults=1 service_cases=3 services=3 site_profile=1 statistics=3 team_members=3 testimonials=3',
  'seo reads every fixture row of the 21 tables');
select _as('developer');
select is(_seen(),
  'blog_posts=3 categories=1 certifications=3 clients=2 disciplines=3 entity_seo=2 media_assets=2 navigation=2 page_sections=3 pages=3 portfolio=3 portfolio_media=2 portfolio_services=2 sectors=2 seo_defaults=1 service_cases=3 services=3 site_profile=1 statistics=3 team_members=3 testimonials=3',
  'developer reads every fixture row of the 21 tables');
select _as('sales');
select is(_seen(),
  'blog_posts=1 categories=1 certifications=1 clients=1 disciplines=1 entity_seo=1 media_assets=1 navigation=1 page_sections=1 pages=1 portfolio=1 portfolio_media=1 portfolio_services=1 sectors=1 seo_defaults=1 service_cases=1 services=1 site_profile=1 statistics=1 team_members=1 testimonials=1',
  'a sales claim reads only the public fixture rows (no draft, archived or hidden row)');
select _as_other();
select is(_seen(),
  'blog_posts=0 categories=0 certifications=0 clients=0 disciplines=0 entity_seo=0 media_assets=0 navigation=0 page_sections=0 pages=0 portfolio=0 portfolio_media=0 portfolio_services=0 sectors=0 seo_defaults=0 service_cases=0 services=0 site_profile=0 statistics=0 team_members=0 testimonials=0',
  'other_tenant reads no row of the launch tenant');
reset role;
set local role anon;
select _as(null);
select is(_seen(),
  'blog_posts=1 categories=1 certifications=1 clients=1 disciplines=1 entity_seo=1 media_assets=1 navigation=1 page_sections=1 pages=1 portfolio=1 portfolio_media=1 portfolio_services=1 sectors=1 seo_defaults=1 service_cases=1 services=1 site_profile=1 statistics=1 team_members=1 testimonials=1',
  'anon reads only the public fixture rows, with the dataset''s projection');

-- ── 2. Pending changes ─────────────────────────────────────────────────────────────────
select throws_ok($$ select _drafts() $$, '42501', null,
  'anon CANNOT read content_drafts (no privilege)');
reset role;
set local role authenticated;
select _as('admin');
select is(_drafts(), 2, 'admin reads its tenant''s pending changes');
select _as('content_creator');
select is(_drafts(), 2, 'content_creator reads its tenant''s pending changes');
select _as('seo');
select is(_drafts(), 2, 'seo reads its tenant''s pending changes');
select _as('developer');
select is(_drafts(), 2, 'developer reads its tenant''s pending changes (the preview filters by area)');
select _as('sales');
select is(_drafts(), 0, 'a sales claim reads no pending change');
select _as_other();
select is(_drafts(), 0, 'other_tenant reads none of the launch tenant''s pending changes');
reset role;

-- ── 3. Anon's grants ───────────────────────────────────────────────────────────────────
select is(
  (select string_agg(format('%s: %s', c.relname,
            (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
               from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                and has_column_privilege('anon', c.oid, a.attnum, 'SELECT'))),
          E'\n' order by c.relname::text collate "C")
     from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relname in (select tbl from _anon_columns())),
  (select string_agg(format('%s: %s', a.tbl,
            (select string_agg(x, ',' order by x collate "C") from unnest(string_to_array(a.cols, ',')) x)),
          E'\n' order by a.tbl collate "C")
     from _anon_columns() a),
  'anon''s SELECT columns on the four column-granted tables equal ANON_COLUMNS');
select ok(
  (select bool_and(not has_table_privilege('anon', format('public.%I', tbl), 'SELECT')) from _anon_columns()),
  'the four column-granted tables have no table-level anon SELECT');
select is(
  (select string_agg(t, ',' order by t collate "C")
     from unnest(array['blog_posts', 'categories', 'certifications', 'clients', 'disciplines',
       'entity_seo', 'media_assets', 'navigation', 'page_sections', 'pages', 'portfolio',
       'portfolio_media', 'portfolio_services', 'sectors', 'seo_defaults', 'service_cases',
       'services', 'site_profile', 'statistics', 'team_members', 'testimonials']) t
    where has_table_privilege('anon', format('public.%I', t), 'SELECT')),
  'blog_posts,categories,certifications,clients,entity_seo,navigation,page_sections,pages,portfolio,portfolio_media,portfolio_services,sectors,seo_defaults,services,site_profile,statistics,team_members',
  'the other 17 preview tables are granted to anon whole');

-- ── 4. The defaults a pending create starts from ───────────────────────────────────────
select is(
  (select string_agg(format('%s.%s = %s', d.tbl, d.col, coalesce(pg_get_expr(ad.adbin, ad.adrelid), 'NULL')),
          E'\n' order by d.tbl collate "C", d.col collate "C")
     from _create_defaults() d
     left join pg_attribute a
       on a.attrelid = format('public.%I', d.tbl)::regclass and a.attname = d.col and not a.attisdropped
     left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum),
  (select string_agg(format('%s.%s = %s', d.tbl, d.col, d.dflt), E'\n' order by d.tbl collate "C", d.col collate "C")
     from _create_defaults() d),
  'every column default CREATE_DEFAULTS copies is the database''s');

-- ── 5. The policies an anon SELECT goes through ────────────────────────────────────────
-- Name, kind and the md5 of the USING expression as PostgreSQL prints it, so a policy
-- recreated under the same name with another USING fails too. Printed with a fixed
-- search_path (a function SET clause), as relation names are qualified by it.
create function _anon_policy_pins() returns text language sql stable
  set search_path = public, pg_catalog as $$
  select string_agg(format('%s: %s', s.tablename, s.pins), E'\n' order by s.tablename::text collate "C")
    from (select p.tablename,
                 string_agg(format('%s:%s:%s', p.policyname, p.permissive, md5(coalesce(p.qual, ''))),
                            ',' order by p.policyname::text collate "C") as pins
            from pg_catalog.pg_policies p
           where p.schemaname = 'public'
             and p.tablename in (select tbl from _anon_policies())
             and p.cmd in ('SELECT', 'ALL')
             and p.roles && array['public', 'anon']::name[]
           group by p.tablename) s
$$;
select is(
  _anon_policy_pins(),
  (select string_agg(format('%s: %s', tbl,
            (select string_agg(x, ',' order by x collate "C") from unnest(string_to_array(policies, ',')) x)),
          E'\n' order by tbl collate "C")
     from _anon_policies()),
  'the policies on an anon SELECT of each preview table, with their kind and USING, are the ones the mirror copies');

-- ── 6. Page visibility is no row security ──────────────────────────────────────────────
select ok(
  not has_table_privilege('anon', 'public.page_visibility', 'SELECT')
  and not has_table_privilege('anon', 'public.page_visibility', 'INSERT')
  and not has_table_privilege('anon', 'public.page_visibility', 'UPDATE')
  and not has_table_privilege('anon', 'public.page_visibility', 'DELETE')
  and not has_table_privilege('anon', 'public.content_drafts', 'SELECT'),
  'anon holds nothing on page_visibility (0057: the edge decides, not RLS) or content_drafts');

select * from finish();
rollback;
