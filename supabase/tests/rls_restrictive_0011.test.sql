-- pgTAP: the four RESTRICTIVE SELECT policies added by migration 0011 §5b, over the full
-- role set CLAUDE.md §9 requires — {admin, content_creator, seo, developer, anon,
-- other_tenant}. Closes EXC-002 item 3. Run with `supabase test db`.
--
-- WHY THESE FOUR POLICIES NEED THEIR OWN FILE
--
-- 0011 had to grant `anon` SELECT on 14 relations to bring the site back up. Four of those
-- relations had SELECT policies with NO status and NO visibility predicate — they had been
-- tenant-only since 0001/0009. That was harmless for exactly as long as the missing
-- `usage on schema app` failed every anonymous read closed. Granting SELECT without also
-- writing the missing rule down would have CREATED four disclosures rather than restored a
-- site: hidden nav hrefs, unannounced client logos, the `content` jsonb of every draft page,
-- and the meta title/description of every unreleased service, post and case study.
--
-- So the accident was doing the enforcing. These assertions are what replaced it, and they
-- are the reason the accident cannot come back: each policy is `as restrictive`, so it ANDs
-- with the permissive one and can only ever narrow.
--
-- THE SHAPE OF EVERY ASSERTION BELOW
--
--   4 staff roles  → see BOTH rows  (the `app.is_staff()` escape — editors are unaffected)
--   anon           → sees ONLY the visible/published row
--   other_tenant   → sees ZERO rows (the permissive tenant predicate, not these policies)
--
-- Fixtures live in the LAUNCH tenant and every count is scoped to this file's own rows.
-- Both halves of that matter, and the second is not optional: `anon` carries no claims, so
-- app.effective_tenant_id() falls through to app.default_tenant_id() — the FIRST tenant by
-- created_at, which `supabase start` creates via seed.sql. A test that invents its own
-- tenant is invisible to anon, and any GLOBAL count(*) measures the seed instead of the
-- fixture. Both mistakes were live in this suite until 2026-08-01.
--
-- `other_tenant` names a tenant id that does not exist rather than inserting a second row,
-- deliberately: `app.default_tenant_id()` is "earliest by created_at", so every extra tenant
-- a test inserts is one more chance to move the anchor the anon assertions depend on.
-- `tenant_id = <nonexistent>` is false for the same reason `tenant_id = <other real tenant>`
-- is, and it cannot perturb the fence it is testing.

begin;
select plan(28);

-- ── fixtures (setup runs as the migration role; RLS bypassed here) ───────────

-- navigation: one visible, one hidden. §5 gives Admin+Developer a "hidden pages / page
-- visibility" capability; before 0011 the hrefs it exists to hide were anonymously
-- enumerable, because the `visible = true` filter lived only in the query in
-- src/lib/data/navigation.ts and PostgREST lets a caller send `?visible=eq.false`.
insert into public.navigation (tenant_id, location, label, href, visible) values
  (app.default_tenant_id(), 'header', '{"en":"Shown","ar":"ظاهر"}'::jsonb, '/exc002-visible', true),
  (app.default_tenant_id(), 'header', '{"en":"Hidden","ar":"مخفي"}'::jsonb, '/exc002-hidden',  false);

-- partner_logos: same shape. A hidden partner logo is typically an unannounced client.
insert into public.partner_logos (tenant_id, name, logo_url, visible) values
  (app.default_tenant_id(), 'exc002-shown',  'https://example.test/a.svg', true),
  (app.default_tenant_id(), 'exc002-hidden', 'https://example.test/b.svg', false);

-- Parents for the two join-based policies: one published and one draft of every entity
-- type entity_seo can point at, so all four branches of its policy are exercised.
insert into public.pages (id, tenant_id, slug, title, status) values
  ('0b110000-0000-0000-0000-000000000001', app.default_tenant_id(), 'exc002-live',  '{"en":"Live","ar":"مباشر"}'::jsonb,  'published'),
  ('0b110000-0000-0000-0000-000000000002', app.default_tenant_id(), 'exc002-draft', '{"en":"Draft","ar":"مسودة"}'::jsonb, 'draft');

insert into public.services (id, tenant_id, slug, title, status) values
  ('0b110000-0000-0000-0000-000000000011', app.default_tenant_id(), 'exc002-svc-live',  '{"en":"Live","ar":"مباشر"}'::jsonb,  'published'),
  ('0b110000-0000-0000-0000-000000000012', app.default_tenant_id(), 'exc002-svc-draft', '{"en":"Draft","ar":"مسودة"}'::jsonb, 'draft');

insert into public.blog_posts (id, tenant_id, slug, title, status) values
  ('0b110000-0000-0000-0000-000000000021', app.default_tenant_id(), 'exc002-post-live',  '{"en":"Live","ar":"مباشر"}'::jsonb,  'published'),
  ('0b110000-0000-0000-0000-000000000022', app.default_tenant_id(), 'exc002-post-draft', '{"en":"Draft","ar":"مسودة"}'::jsonb, 'draft');

insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('0b110000-0000-0000-0000-000000000031', app.default_tenant_id(), 'exc002-pf-live',  '{"en":"Live","ar":"مباشر"}'::jsonb,  'published'),
  ('0b110000-0000-0000-0000-000000000032', app.default_tenant_id(), 'exc002-pf-draft', '{"en":"Draft","ar":"مسودة"}'::jsonb, 'draft');

-- page_sections: a visible section of a LIVE page (the only one a visitor may see), a
-- hidden section of that same live page, and a visible section of a DRAFT page. The third
-- is the disclosure 0011 closed: `pages` was correctly gated to published-or-staff since
-- 0001, so without the restrictive policy the parent was hidden and the body was not.
insert into public.page_sections (tenant_id, page_id, type, content, visible) values
  (app.default_tenant_id(), '0b110000-0000-0000-0000-000000000001', 'exc002-live-visible', '{"h":"public"}'::jsonb,   true),
  (app.default_tenant_id(), '0b110000-0000-0000-0000-000000000001', 'exc002-live-hidden',  '{"h":"unreleased"}'::jsonb, false),
  (app.default_tenant_id(), '0b110000-0000-0000-0000-000000000002', 'exc002-draft-visible','{"h":"unreleased"}'::jsonb, true);

-- entity_seo: published + draft for each of the four entity_type branches, plus an ORPHAN
-- whose parent does not exist. 0011 claims that orphan fails CLOSED — it matches none of
-- the four branches and stays hidden. That is an assertion, not a comment, at #19/#20.
insert into public.entity_seo (tenant_id, entity_type, entity_id, meta_title) values
  (app.default_tenant_id(), 'service',   '0b110000-0000-0000-0000-000000000011', '{"en":"EXC002 service live"}'::jsonb),
  (app.default_tenant_id(), 'service',   '0b110000-0000-0000-0000-000000000012', '{"en":"EXC002 service draft"}'::jsonb),
  (app.default_tenant_id(), 'blog_post', '0b110000-0000-0000-0000-000000000021', '{"en":"EXC002 post live"}'::jsonb),
  (app.default_tenant_id(), 'blog_post', '0b110000-0000-0000-0000-000000000022', '{"en":"EXC002 post draft"}'::jsonb),
  (app.default_tenant_id(), 'portfolio', '0b110000-0000-0000-0000-000000000031', '{"en":"EXC002 pf live"}'::jsonb),
  (app.default_tenant_id(), 'portfolio', '0b110000-0000-0000-0000-000000000032', '{"en":"EXC002 pf draft"}'::jsonb),
  (app.default_tenant_id(), 'page',      '0b110000-0000-0000-0000-000000000001', '{"en":"EXC002 page live"}'::jsonb),
  (app.default_tenant_id(), 'page',      '0b110000-0000-0000-0000-000000000002', '{"en":"EXC002 page draft"}'::jsonb),
  (app.default_tenant_id(), 'service',   '0b110000-0000-0000-0000-0000000000ff', '{"en":"EXC002 orphan"}'::jsonb);

-- ── helpers ──────────────────────────────────────────────────────────────────

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- Staff claims must name the SAME tenant the fixtures live in.
create function _tid() returns text language sql as $$ select app.default_tenant_id()::text $$;

-- Counts scoped to this file's own rows. SECURITY INVOKER (the default) is load-bearing:
-- the body must resolve with the CALLER's privileges so both gates — the table GRANT and
-- then RLS — apply exactly as they would to the real query.
create function _nav()      returns int language sql as $$ select count(*)::int from public.navigation    where href like '/exc002-%' $$;
create function _logos()    returns int language sql as $$ select count(*)::int from public.partner_logos where name like 'exc002-%' $$;
create function _sections() returns int language sql as $$ select count(*)::int from public.page_sections where type like 'exc002-%' $$;
create function _seo()      returns int language sql as $$ select count(*)::int from public.entity_seo    where meta_title ->> 'en' like 'EXC002 %' $$;
create function _orphan()   returns int language sql as $$ select count(*)::int from public.entity_seo    where meta_title ->> 'en' = 'EXC002 orphan' $$;

-- ── 1. navigation_visible_only ───────────────────────────────────────────────
set local role authenticated;
select _claims('admin', _tid());           select is(_nav(), 2, 'navigation · admin sees hidden items');
select _claims('content_creator', _tid()); select is(_nav(), 2, 'navigation · content_creator sees hidden items');
select _claims('seo', _tid());             select is(_nav(), 2, 'navigation · seo sees hidden items');
select _claims('developer', _tid());       select is(_nav(), 2, 'navigation · developer sees hidden items');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
                                           select is(_nav(), 0, 'navigation · other_tenant sees nothing');
set local role anon; select _claims(null, null);
                                           select is(_nav(), 1, 'navigation · anon sees ONLY the visible item');

-- ── 2. partner_logos_visible_only ────────────────────────────────────────────
set local role authenticated;
select _claims('admin', _tid());           select is(_logos(), 2, 'partner_logos · admin sees hidden logos');
select _claims('content_creator', _tid()); select is(_logos(), 2, 'partner_logos · content_creator sees hidden logos');
select _claims('seo', _tid());             select is(_logos(), 2, 'partner_logos · seo sees hidden logos');
select _claims('developer', _tid());       select is(_logos(), 2, 'partner_logos · developer sees hidden logos');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
                                           select is(_logos(), 0, 'partner_logos · other_tenant sees nothing');
set local role anon; select _claims(null, null);
                                           select is(_logos(), 1, 'partner_logos · anon sees ONLY the visible logo');

-- ── 3. entity_seo_published_only ─────────────────────────────────────────────
-- 9 fixture rows: 4 published parents, 4 unpublished parents, 1 orphan. anon may see the
-- four published ones and nothing else — meta of a draft is the title and description of
-- unreleased work, and before 0011 the entire unreleased pipeline was one request away.
set local role authenticated;
select _claims('admin', _tid());           select is(_seo(), 9, 'entity_seo · admin sees draft meta');
select _claims('content_creator', _tid()); select is(_seo(), 9, 'entity_seo · content_creator sees draft meta (its "view" access)');
select _claims('seo', _tid());             select is(_seo(), 9, 'entity_seo · seo sees draft meta');
select _claims('developer', _tid());       select is(_seo(), 9, 'entity_seo · developer sees draft meta');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
                                           select is(_seo(), 0, 'entity_seo · other_tenant sees nothing');
select _claims('admin', _tid());           select is(_orphan(), 1, 'entity_seo · staff see an orphan row (is_staff escape)');
set local role anon; select _claims(null, null);
select is(_seo(), 4, 'entity_seo · anon sees the 4 PUBLISHED parents only (service/blog_post/portfolio/page)');
select is(_orphan(), 0, 'entity_seo · an orphan whose parent is gone fails CLOSED for anon');

-- ── 4. page_sections_published_only ──────────────────────────────────────────
-- 3 fixture rows; only one is publicly eligible (visible section of a published page).
set local role authenticated;
select _claims('admin', _tid());           select is(_sections(), 3, 'page_sections · admin sees draft-page bodies');
select _claims('content_creator', _tid()); select is(_sections(), 3, 'page_sections · content_creator sees draft-page bodies');
select _claims('seo', _tid());             select is(_sections(), 3, 'page_sections · seo sees draft-page bodies');
select _claims('developer', _tid());       select is(_sections(), 3, 'page_sections · developer sees draft-page bodies');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
                                           select is(_sections(), 0, 'page_sections · other_tenant sees nothing');

-- The non-staff branch of the predicate, exercised by a signed-in visitor with no role
-- claim. This row exists because `anon` CANNOT reach this table at all (below), so anon
-- proves the grant and this proves the policy — and the policy is the half that has to
-- keep working the day the section renderer ships and the grant is added.
select _claims(null, null);
select is(_sections(), 1, 'page_sections · non-staff session sees ONLY the visible section of a PUBLISHED page');

-- anon is denied one gate EARLIER: 0011 deliberately left page_sections out of the anon
-- grant list, because nothing reads it anonymously yet. Two independent layers, and today
-- the outer one is shut — so this is a throws_ok, not a count. When the renderer lands and
-- the grant is added, THIS is the assertion that will fail and demand a decision.
set local role anon; select _claims(null, null);
select throws_ok(
  $$ select count(*) from public.page_sections $$,
  '42501', null, 'page_sections · anon is denied at the GRANT layer (no anonymous reader yet)'
);

-- ── 5. the policies are RESTRICTIVE, not permissive ──────────────────────────
-- A permissive policy ORs with the others and would narrow nothing. Recreating any of
-- these four without `as restrictive` reopens the exact disclosure it closed, silently and
-- with every other assertion in this file still green — so assert the modifier itself.
reset role;
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and permissive = 'RESTRICTIVE'
      and policyname in ('navigation_visible_only', 'partner_logos_visible_only',
                         'page_sections_published_only', 'entity_seo_published_only')),
  4,
  'all four 0011 §5b policies are still RESTRICTIVE'
);

select _claims(null, null);
select * from finish();
rollback;
