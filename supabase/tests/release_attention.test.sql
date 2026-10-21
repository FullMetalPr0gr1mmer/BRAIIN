-- pgTAP: dashboard_attention v4, releases and stale pending changes (migration 0066,
-- Admin v2 R5).
--
-- Five kinds join the attention list: a release scheduled for today (the Riyadh day, and
-- not yet five minutes late), a release more than five minutes late, a release that failed
-- in the last 7 days, a live release whose cache purge failed in the last 7 days, and a
-- pending change nobody has touched for 30 days (unclaimed). The view is security_invoker,
-- so RLS decides every row: the four CMS roles of the tenant see them; a sales claim, anon
-- and another tenant see none. The kinds the view had before (0028) are unchanged. No row
-- exists in production until R3, R7 or R11 writes one.
--
-- H13 (0100_attention_staff.sql): the whole list is for CMS staff. A row over public content
-- (a published post with no cover, which anon and Sales read in the table itself) is read by
-- the tenant's Admin, Content Creator, SEO and Developer; a Sales claim, a token with no role
-- claim, another tenant and anon read none of it. The owner's psql session (no switched
-- role, no role claim) still reads it, for the launch runbook's checks, and reads none once
-- it carries a Sales claim.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.

begin;
select plan(26);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────────
insert into public.tenants (id, name) values
  ('66200000-0000-0000-0000-00000000000a', 'AttentionA'),
  ('66200000-0000-0000-0000-00000000000b', 'AttentionB');

-- r1 today (the last minute of the Riyadh day), r2 ten minutes late, r3 failed two days ago,
-- r4 failed ten days ago, r5 live with a failed purge yesterday, r6 the same ten days ago,
-- r7 tomorrow half an hour after Riyadh midnight (the evening before, in UTC). B: r9 failed.
insert into public.content_releases (id, tenant_id, number, status, note, scheduled_for, scheduled_by,
                                     payload, published_at, purge_status, updated_at) values
  ('66200000-0000-0000-000d-000000000001', '66200000-0000-0000-0000-00000000000a', null, 'scheduled',
   'Evening drop', ((now() at time zone 'Asia/Riyadh')::date + 1)::timestamp at time zone 'Asia/Riyadh' - interval '1 minute',
   '66200000-0000-0000-0000-0000000000a1', '[]', null, 'pending', now()),
  ('66200000-0000-0000-000d-000000000002', '66200000-0000-0000-0000-00000000000a', null, 'scheduled',
   null, now() - interval '10 minutes', '66200000-0000-0000-0000-0000000000a1', '[]', null, 'pending', now()),
  ('66200000-0000-0000-000d-000000000003', '66200000-0000-0000-0000-00000000000a', null, 'failed',
   null, null, null, null, null, 'pending', now() - interval '2 days'),
  ('66200000-0000-0000-000d-000000000004', '66200000-0000-0000-0000-00000000000a', null, 'failed',
   null, null, null, null, null, 'pending', now() - interval '10 days'),
  ('66200000-0000-0000-000d-000000000005', '66200000-0000-0000-0000-00000000000a', 1, 'published',
   null, null, null, null, now() - interval '1 day', 'failed', now()),
  ('66200000-0000-0000-000d-000000000006', '66200000-0000-0000-0000-00000000000a', 2, 'published',
   null, null, null, null, now() - interval '10 days', 'failed', now()),
  ('66200000-0000-0000-000d-000000000007', '66200000-0000-0000-0000-00000000000a', null, 'scheduled',
   null, ((now() at time zone 'Asia/Riyadh')::date + 1)::timestamp at time zone 'Asia/Riyadh' + interval '30 minutes',
   '66200000-0000-0000-0000-0000000000a1', '[]', null, 'pending', now()),
  ('66200000-0000-0000-000d-000000000009', '66200000-0000-0000-0000-00000000000b', null, 'failed',
   null, null, null, null, null, 'pending', now() - interval '1 day');

-- Drafts, back-dated: the draft lock stamps updated_at itself, so it is switched off for the
-- fixtures only (the migration role owns the table; the transaction rolls back). d1 untouched
-- for 31 days, d2 for 2, d3 for 40 but claimed by the scheduled r1, d9 tenant B's.
alter table public.content_drafts disable trigger content_drafts_lock;
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, label, release_id, updated_at) values
  ('66200000-0000-0000-00dd-000000000001', '66200000-0000-0000-0000-00000000000a', 'service',
   '66200000-0000-0000-0001-000000000001', 'update', '{"slug":"r5a-old","sortOrder":2}',
   '{"en":"Old change","ar":"تغيير قديم"}', null, now() - interval '31 days'),
  ('66200000-0000-0000-00dd-000000000002', '66200000-0000-0000-0000-00000000000a', 'service',
   '66200000-0000-0000-0001-000000000002', 'update', '{"sortOrder":3}', null, null, now() - interval '2 days'),
  ('66200000-0000-0000-00dd-000000000003', '66200000-0000-0000-0000-00000000000a', 'service',
   '66200000-0000-0000-0001-000000000003', 'update', '{"sortOrder":4}', null,
   '66200000-0000-0000-000d-000000000001', now() - interval '40 days'),
  ('66200000-0000-0000-00dd-000000000009', '66200000-0000-0000-0000-00000000000b', 'service',
   '66200000-0000-0000-0001-000000000009', 'update', '{"sortOrder":5}', null, null, now() - interval '40 days');
alter table public.content_drafts enable trigger content_drafts_lock;

-- A v3 row (0028's kinds are unchanged): a placeholder project awaiting real content.
insert into public.portfolio (id, tenant_id, slug, title, status, is_placeholder) values
  ('66200000-0000-0000-0006-000000000001', '66200000-0000-0000-0000-00000000000a', 'r5a-sample',
   '{"en":"Sample","ar":"عينة"}', 'draft', true);

-- A v1 row over public content (H13): a published post with no cover in A (missing_image).
insert into public.blog_posts (id, tenant_id, slug, title, status) values
  ('66200000-0000-0000-000b-000000000001', '66200000-0000-0000-0000-00000000000a', 'h13-post',
   '{"en":"Post","ar":"مقال"}', 'published');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '66200000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true)
$$;
-- The ids of one kind the current role sees, by their last character.
create function _kind(p_kind text) returns text language sql stable as $$
  select coalesce(string_agg(right(id::text, 1), ',' order by id::text), '')
    from public.dashboard_attention where kind = p_kind
$$;
-- Every v4 row the current role sees.
create function _v4() returns text language sql stable as $$
  select coalesce(string_agg(kind || ':' || right(id::text, 1), ',' order by kind, id::text), '')
    from public.dashboard_attention
   where kind in ('release_scheduled_today', 'release_overdue', 'release_failed', 'purge_failed', 'draft_stale')
$$;
-- Every row the current role sees about the published post (H13).
create function _post() returns text language sql stable as $$
  select coalesce(string_agg(kind, ',' order by kind), '')
    from public.dashboard_attention where id = '66200000-0000-0000-000b-000000000001'
$$;

-- ── 1. The catalog ───────────────────────────────────────────────────────────────────
select ok(
  (select reloptions @> array['security_invoker=true'] from pg_class where oid = 'public.dashboard_attention'::regclass)
  and has_table_privilege('authenticated', 'public.dashboard_attention', 'select')
  and not has_table_privilege('anon', 'public.dashboard_attention', 'select')
  and not has_table_privilege('service_role', 'public.dashboard_attention', 'select'),
  'dashboard_attention stays security_invoker, readable by authenticated only');

-- ── 2. One row per kind, as an admin of tenant A sees them ───────────────────────────
set local role authenticated;
select _as('admin', '66200000-0000-0000-0000-00000000000a');
select is(_kind('release_scheduled_today'), '1',
  'scheduled today in Riyadh: the late-evening release, not the late one, not tomorrow''s just after midnight');
select is(_kind('release_overdue'), '2', 'more than five minutes late: overdue, and not also "today"');
select is(_kind('release_failed'), '3', 'failed within 7 days (an older failure no longer nags)');
select is(_kind('purge_failed'), '5', 'a live release whose purge failed within 7 days');
select is(_kind('draft_stale'), '1',
  'a pending change untouched for 30 days (not a recent one, not one a scheduled release claims)');
select is(
  (select format('%s|%s|%s', slug, title ->> 'en', title ->> 'ar') from public.dashboard_attention
    where kind = 'release_scheduled_today'),
  '|Evening drop|Evening drop', 'a scheduled release has no number yet; its note is its title');
select is(
  (select format('%s|%s|%s|%s', entity_type, slug, title ->> 'en',
                 (select slug from public.dashboard_attention where kind = 'purge_failed'))
     from public.dashboard_attention where kind = 'draft_stale'),
  'service|r5a-old|Old change|v1', 'a stale change names its type, its slug and its label; a live release its number');
select is(_kind('placeholder_pending'), '1', 'the kinds 0028 lists are unchanged');

-- ── 3. Who sees them ─────────────────────────────────────────────────────────────────
select _as('content_creator', '66200000-0000-0000-0000-00000000000a');
select is(_v4(), 'draft_stale:1,purge_failed:5,release_failed:3,release_overdue:2,release_scheduled_today:1',
  'content creator sees all five');
select _as('seo', '66200000-0000-0000-0000-00000000000a');
select is(_v4(), 'draft_stale:1,purge_failed:5,release_failed:3,release_overdue:2,release_scheduled_today:1',
  'seo sees all five');
select _as('developer', '66200000-0000-0000-0000-00000000000a');
select is(_v4(), 'draft_stale:1,purge_failed:5,release_failed:3,release_overdue:2,release_scheduled_today:1',
  'developer sees all five');
select _as('sales', '66200000-0000-0000-0000-00000000000a');
select is(_v4(), '', 'a sales claim sees none');
select _as('admin', '66200000-0000-0000-0000-00000000000b');
select is(_v4(), 'draft_stale:9,release_failed:9', 'other_tenant: another tenant''s admin sees only its own');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.dashboard_attention $$, '42501', null,
  'anon cannot read the attention list at all');
reset role;

-- ── 4. Only CMS staff read the list (H13, 0100_attention_staff.sql) ─────────────────
set local role authenticated;
select _as('admin', '66200000-0000-0000-0000-00000000000a');
select is(_post(), 'missing_image', 'admin of the tenant reads the published post''s missing_image row');
select _as('content_creator', '66200000-0000-0000-0000-00000000000a');
select is(_post(), 'missing_image', 'content creator of the tenant reads it');
select _as('seo', '66200000-0000-0000-0000-00000000000a');
select is(_post(), 'missing_image', 'seo of the tenant reads it');
select _as('developer', '66200000-0000-0000-0000-00000000000a');
select is(_post(), 'missing_image', 'developer of the tenant reads it (site health counts the list through content_health)');
select _as('sales', '66200000-0000-0000-0000-00000000000a');
select is((select count(*)::int from public.blog_posts where id = '66200000-0000-0000-000b-000000000001'), 1,
  'a sales claim of the tenant reads the post itself, as anon does');
select is((select count(*)::int from public.dashboard_attention), 0,
  'but no row of the attention list at all, the post''s included: it is for CMS staff');
select _as(null, null);
select is((select count(*)::int from public.dashboard_attention), 0,
  'a signed-in token with no role claim reads none either');
select _as('admin', '66200000-0000-0000-0000-00000000000b');
select is(_post(), '', 'other_tenant: another tenant''s admin reads none of it');
reset role;
set local role anon;
select _as(null, null);
select throws_ok(
  $$ select count(*) from public.dashboard_attention where id = '66200000-0000-0000-000b-000000000001' $$,
  '42501', null, 'anon reads none of it (no privilege on the view)');
reset role;
-- The owner's psql session: no switched role. With no role claim it reads the list, for the
-- launch runbook's checks; a role claim is judged like a token's.
select _as(null, null);
select is(_post(), 'missing_image', 'the owner''s session (no switched role, no role claim) still reads it');
select _as('sales', '66200000-0000-0000-0000-00000000000a');
select is((select count(*)::int from public.dashboard_attention), 0,
  'the owner''s session carrying a Sales claim reads no row');
select _as(null, null);

select * from finish();
rollback;
