-- pgTAP: the media library's list (0064, Admin v2 U4): public.media_library.
--
--   1. who reads: Admin, Content Creator, SEO and Developer read their own tenant's library
--      and never another's; another tenant's admin naming this tenant reads nothing; anon
--      may not call it; an authenticated principal that is not staff reads nothing;
--   2. a stale token still reads (documented, not live: media_assets carries no live check,
--      and the Worker refuses a stale session at its next request, U12a's
--      resolveAuthContext; the roles guide says media keeps the role it was issued with);
--   3. the search: display name, alt text in both languages (Arabic folded on both sides),
--      tags and a still's file name; never an upload's random key; `%` and `_` literal; a
--      query under two characters is no filter;
--   4. the filters (kind, needs alt text), the paging (created_at desc, id desc; the total
--      apart from the page) and the refusals (22023);
--   5. the grants: authenticated alone executes it;
--   6. the rewritten media-library guide is what every tenant holds, and the roles read it.
--
-- Fixtures are two tenants of this file's own (A with 8 rows, B with 2), so the launch
-- tenant's seeded stills never enter a count.

begin;
select plan(56);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('64000000-0000-4000-8000-00000000000a', 'MediaLibraryA'),
  ('64000000-0000-4000-8000-00000000000b', 'MediaLibraryB');

-- A developer of tenant A whose profile was deactivated after the token was issued.
insert into auth.users (id, email) values
  ('64000000-0000-4000-8000-0000000000d9', 'u4-inactive@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('64000000-0000-4000-8000-0000000000d9', '64000000-0000-4000-8000-00000000000a', 'developer',
   false, null, 'Inactive');

-- Tenant A: eight rows, newest last (each id ends in its row's number, a1 to a8).
--   a1 a still with alt in both languages (its file name is searched: p0.jpg)
--   a2 an upload named "Desert dunes.jpg" (its key's random part is never searched)
--   a3 a still whose Arabic alt is stored with tashkeel and a hamza on its alef
--   a4 a still missing its Arabic alt
--   a5 a still whose English alt is only spaces
--   a6 a still tagged brand
--   a7 a video
--   a8 a still named 50%_off
insert into public.media_assets
  (id, tenant_id, kind, provider, storage_path, display_name, alt, tags, width, height,
   mime_type, size_bytes, created_at) values
  ('64a00000-0000-4000-8000-000000000001', '64000000-0000-4000-8000-00000000000a', 'image',
   'static', 'stills/p0.jpg', null, '{"en": "Studio wall", "ar": "جدار الاستوديو"}', '{}',
   1600, 1200, null, null, '2026-01-01T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-00000000000a', 'image',
   'storage',
   '64000000-0000-4000-8000-00000000000a/7e3f9c2a-1b4d-4e8f-9a6b-5c3d2e1f0a9b_2560x1707.webp',
   'Desert dunes.jpg', '{"en": "Sand at dusk", "ar": "رمال عند الغروب"}', '{}',
   2560, 1707, 'image/webp', 412000, '2026-01-02T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000003', '64000000-0000-4000-8000-00000000000a', 'image',
   'static', 'stills/p1.jpg', null, '{"en": "A framed print", "ar": "صُورَة الإِطار"}', '{}',
   1600, 1200, null, null, '2026-01-03T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000004', '64000000-0000-4000-8000-00000000000a', 'image',
   'static', 'stills/p2.jpg', null, '{"en": "Night street", "ar": ""}', '{}',
   1600, 1200, null, null, '2026-01-04T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000005', '64000000-0000-4000-8000-00000000000a', 'image',
   'static', 'stills/p3.jpg', null, '{"en": "   ", "ar": "شارع"}', '{}',
   1600, 1200, null, null, '2026-01-05T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000006', '64000000-0000-4000-8000-00000000000a', 'image',
   'static', 'stills/p4.jpg', null, '{"en": "Logo board", "ar": "لوحة الشعار"}', '{brand}',
   1600, 1200, null, null, '2026-01-06T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000007', '64000000-0000-4000-8000-00000000000a', 'video',
   'external', 'https://videos.example.test/reel.mp4', null, null, '{}',
   null, null, null, null, '2026-01-07T00:00:00Z'),
  ('64a00000-0000-4000-8000-000000000008', '64000000-0000-4000-8000-00000000000a', 'image',
   'static', 'stills/p5.jpg', '50%_off', '{"en": "Sale card", "ar": "بطاقة التخفيض"}', '{}',
   1600, 1200, null, null, '2026-01-08T00:00:00Z');

-- A visible client of A whose logo is a6: media_assets_public_read (0028, 0045) shows a6 to
-- any principal that can read the client, a non-staff authenticated one included, so the
-- non-staff checks below can fail: only 0064's `not app.is_staff()` belt keeps them at zero.
insert into public.clients (tenant_id, slug, name, visible, logo_media_id) values
  ('64000000-0000-4000-8000-00000000000a', 'u4-visible-client',
   '{"en": "U4 visible client", "ar": "عميل ظاهر"}', true,
   '64a00000-0000-4000-8000-000000000006');

-- Tenant B: two rows, one of them as findable as A's ("dunes").
insert into public.media_assets
  (id, tenant_id, kind, provider, storage_path, display_name, alt, tags, width, height,
   created_at) values
  ('64b00000-0000-4000-8000-000000000001', '64000000-0000-4000-8000-00000000000b', 'image',
   'static', 'stills/p0.jpg', null, '{"en": "Other dunes", "ar": "كثبان أخرى"}', '{}',
   1600, 1200, '2026-01-01T00:00:00Z'),
  ('64b00000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-00000000000b', 'image',
   'static', 'stills/p1.jpg', null, '{"en": "Other wall", "ar": "جدار آخر"}', '{}',
   1600, 1200, '2026-01-02T00:00:00Z');

create function _as(p_role text, p_tid text, p_sub text default '64000000-0000-4000-8000-0000000000a1')
  returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The CURRENT role's view: the total, and the page's rows by their number ("a8,a7,…").
create function _total(p_tenant text, p_q text default null, p_kind text default null,
                       p_alt boolean default null) returns int language sql as $$
  select (public.media_library(p_tenant::uuid, p_q, p_kind, p_alt, 100, 0) ->> 'total')::int
$$;
create function _rows(p_tenant text, p_q text default null, p_kind text default null,
                      p_alt boolean default null, p_limit int default 100, p_offset int default 0)
  returns text language sql as $$
  select coalesce(string_agg(
           case when r.v ->> 'id' like '64a%' then 'a' else 'b' end || right(r.v ->> 'id', 1),
           ',' order by r.n), '')
    from jsonb_array_elements(
           public.media_library(p_tenant::uuid, p_q, p_kind, p_alt, p_limit, p_offset) -> 'rows')
           with ordinality as r(v, n)
$$;

-- ---- 1. anon: may not call it ------------------------------------------------------------
set local role anon;
select _as(null, null);
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, 10, 0) $$,
  '42501', null, 'anon cannot call media_library');
reset role;

-- ---- 2. the four staff roles of A: A's rows, never B's ------------------------------------
set local role authenticated;
select _as('admin', '64000000-0000-4000-8000-00000000000a');
select is(_total('64000000-0000-4000-8000-00000000000a'), 8, 'admin reads its tenant''s 8 rows');
select is(_rows('64000000-0000-4000-8000-00000000000a'), 'a8,a7,a6,a5,a4,a3,a2,a1',
  'admin: newest first, none of B''s');
select is(_total('64000000-0000-4000-8000-00000000000a', 'dunes'), 1,
  'admin: a search never reaches another tenant''s matching row');
select _as('content_creator', '64000000-0000-4000-8000-00000000000a');
select is(_total('64000000-0000-4000-8000-00000000000a'), 8, 'content_creator reads the 8 rows');
select is(_rows('64000000-0000-4000-8000-00000000000a'), 'a8,a7,a6,a5,a4,a3,a2,a1',
  'content_creator: none of B''s');
select _as('seo', '64000000-0000-4000-8000-00000000000a');
select is(_total('64000000-0000-4000-8000-00000000000a'), 8,
  'seo reads the 8 rows (media.write at meta: it opens the library)');
select is(_rows('64000000-0000-4000-8000-00000000000a'), 'a8,a7,a6,a5,a4,a3,a2,a1',
  'seo: none of B''s');
select _as('developer', '64000000-0000-4000-8000-00000000000a');
select is(_total('64000000-0000-4000-8000-00000000000a'), 8, 'developer reads the 8 rows');
select is(_rows('64000000-0000-4000-8000-00000000000a'), 'a8,a7,a6,a5,a4,a3,a2,a1',
  'developer: none of B''s');

-- Each row carries the list columns and mime_type, never provider_ref or stream_uid.
select _as('admin', '64000000-0000-4000-8000-00000000000a');
select is(
  (select array_agg(k order by k)
     from jsonb_object_keys(public.media_library('64000000-0000-4000-8000-00000000000a',
            'dunes', null, null, 1, 0) -> 'rows' -> 0) k),
  array['alt', 'created_at', 'display_name', 'folder', 'height', 'id', 'kind', 'mime_type',
        'provider', 'ref_count', 'size_bytes', 'storage_path', 'tags', 'version', 'width'],
  'a row holds exactly the list columns and mime_type');

-- ---- 3. another tenant's admin ------------------------------------------------------------
select _as('admin', '64000000-0000-4000-8000-00000000000b');
select is(_total('64000000-0000-4000-8000-00000000000a'), 0,
  'other_tenant naming A: total 0');
select is(_rows('64000000-0000-4000-8000-00000000000a'), '', 'other_tenant naming A: no rows');
select is(_rows('64000000-0000-4000-8000-00000000000b'), 'b2,b1',
  'other_tenant naming its own tenant: its 2 rows only');

-- ---- 4. not staff: an authenticated principal with a role no CMS role is -----------------
select _as('viewer', '64000000-0000-4000-8000-00000000000a');
select is(_total('64000000-0000-4000-8000-00000000000a'), 0, 'a non-staff principal: total 0');
select is(_rows('64000000-0000-4000-8000-00000000000a'), '', 'a non-staff principal: no rows');

-- ---- 5. a stale token: NOT live, by design (D18) ------------------------------------------
-- The profile says inactive; the token still says developer. media_assets has no live check
-- (its RLS reads the JWT, as the roles guide says of media), and the Worker refuses this
-- session at its next request (U12a's resolveAuthContext). See the stale-token gap note.
select _as('developer', '64000000-0000-4000-8000-00000000000a',
           '64000000-0000-4000-8000-0000000000d9');
select is(_total('64000000-0000-4000-8000-00000000000a'), 8,
  'a deactivated developer''s unexpired token still reads (no live check on media)');

-- ---- 6. the search (as A's admin) ---------------------------------------------------------
select _as('admin', '64000000-0000-4000-8000-00000000000a');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'dunes'), 'a2', 'by display name');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'DUNES'), 'a2', 'case folded');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'at dusk'), 'a2', 'by English alt text');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'الغروب'), 'a2', 'by Arabic alt text');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'صوره الاطار'), 'a3',
  'Arabic folded: no tashkeel, ه for ة and a bare alef find the stored spelling');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'صُورَة الإِطار'), 'a3',
  'and the stored spelling finds itself');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'brand'), 'a6', 'by tag');
select is(_rows('64000000-0000-4000-8000-00000000000a', 'p0.jpg'), 'a1', 'by a still''s file name');
select is(_total('64000000-0000-4000-8000-00000000000a', '7e'), 0,
  'an upload''s random key is never searched (a 2-hex fragment of it finds nothing)');
select is(_total('64000000-0000-4000-8000-00000000000a', '1707'), 0,
  'nor the size in its key');
select is(_rows('64000000-0000-4000-8000-00000000000a', '50%_off'), 'a8', '% and _ are characters');
select is(_rows('64000000-0000-4000-8000-00000000000a', '%_'), 'a8',
  '"%_" finds only the name that holds them');
select is(_total('64000000-0000-4000-8000-00000000000a', 'd'), 8,
  'one character is no filter: the whole list');
select is(_total('64000000-0000-4000-8000-00000000000a', '  '), 8,
  'blank is no filter');
select is(_total('64000000-0000-4000-8000-00000000000a', 'nothing like this'), 0,
  'no match: total 0');

-- ---- 7. the filters -----------------------------------------------------------------------
select is(_rows('64000000-0000-4000-8000-00000000000a', null, 'image'),
  'a8,a6,a5,a4,a3,a2,a1', 'kind image leaves the video out');
select is(_rows('64000000-0000-4000-8000-00000000000a', null, 'video'), 'a7', 'kind video');
select is(_rows('64000000-0000-4000-8000-00000000000a', null, null, true), 'a5,a4',
  'needs alt: exactly the blank English and the missing Arabic');
select is(_rows('64000000-0000-4000-8000-00000000000a', null, 'image', true), 'a5,a4',
  'kind image and needs alt together');
select is(_total('64000000-0000-4000-8000-00000000000a', null, 'video', true), 0,
  'a video never needs alt text here');
select is(_total('64000000-0000-4000-8000-00000000000a', 'street', 'image', true), 1,
  'search, kind and needs alt together');

-- ---- 8. the paging ------------------------------------------------------------------------
select is(_rows('64000000-0000-4000-8000-00000000000a', null, null, null, 3, 0), 'a8,a7,a6',
  'page 1 of 3');
select is(_rows('64000000-0000-4000-8000-00000000000a', null, null, null, 3, 3), 'a5,a4,a3',
  'page 2 of 3');
select is(_rows('64000000-0000-4000-8000-00000000000a', null, null, null, 3, 6), 'a2,a1',
  'page 3 of 3: every row once');
select is(public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, 3, 9),
  '{"total": 8, "rows": []}'::jsonb, 'past the end: no rows, and the total still 8');

-- ---- 9. the refusals (22023) --------------------------------------------------------------
select throws_ok(
  format($$ select public.media_library('64000000-0000-4000-8000-00000000000a', %L, null, null, 10, 0) $$,
         repeat('a', 65)),
  '22023', null, 'a query of 65 characters');
select throws_ok(
  format($$ select public.media_library('64000000-0000-4000-8000-00000000000a', %L, null, null, 10, 0) $$,
         'bell' || chr(7)),
  '22023', null, 'a query holding a control character');
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, 'svg', null, 10, 0) $$,
  '22023', null, 'a kind that is not one of the four');
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, 0, 0) $$,
  '22023', null, 'a limit of 0');
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, 101, 0) $$,
  '22023', null, 'a limit of 101');
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, null, 0) $$,
  '22023', null, 'no limit');
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, 10, -1) $$,
  '22023', null, 'an offset of -1');
select throws_ok(
  $$ select public.media_library('64000000-0000-4000-8000-00000000000a', null, null, null, 10, 10001) $$,
  '22023', null, 'an offset of 10001');
reset role;

-- ---- 10. the grants (as the migration role) ----------------------------------------------
select ok(has_function_privilege('authenticated',
            'public.media_library(uuid, text, text, boolean, integer, integer)', 'execute')
          and not has_function_privilege('anon',
            'public.media_library(uuid, text, text, boolean, integer, integer)', 'execute')
          and not has_function_privilege('service_role',
            'public.media_library(uuid, text, text, boolean, integer, integer)', 'execute'),
  'authenticated executes media_library; anon and the service role do not');
select ok(not exists (
            select 1 from pg_proc p, aclexplode(p.proacl) a
             where p.oid = 'public.media_library(uuid, text, text, boolean, integer, integer)'::regprocedure
               and a.grantee = 0),
  'PUBLIC holds no EXECUTE on media_library');

-- ---- 11. the rewritten guide --------------------------------------------------------------
create function _guide() returns jsonb language sql security definer as $$
  select a from jsonb_array_elements(app.help_article_set()) a where a ->> 'slug' = 'media-library'
$$;
select ok(exists (select 1 from public.help_articles h
                   where h.tenant_id = '64000000-0000-4000-8000-00000000000a'
                     and h.slug = 'media-library' and h.body = _guide() -> 'body'
                     and h.title = _guide() ->> 'title' and h.minutes = 3),
  'a tenant holds the media-library guide as the set states it');
set local role authenticated;
select _as('content_creator', '64000000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.help_articles where slug = 'media-library'), 1,
  'content_creator reads the media guide');
select _as('seo', '64000000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.help_articles where slug = 'media-library'), 1,
  'seo reads the media guide');
select _as('developer', '64000000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.help_articles where slug = 'media-library'), 1,
  'developer reads the media guide');
reset role;

select * from finish();
rollback;
