-- pgTAP: archive/delete gates (migration 0007). Content Creator may author/edit but may
-- NOT delete or archive portfolio/pages/page_sections, nor hard-delete media; Admin may.
-- (CLAUDE.md §5.) RLS DELETE filters silently (row survives, no error) → assert by row
-- count; archive is a WITH CHECK violation → assert it throws 42501. Run: `supabase test db`.

begin;
select * from no_plan();

insert into public.tenants (id, name, created_at)
values ('33333333-3333-3333-3333-333333333333', 'DelGateT', '2000-01-01T00:00:00Z');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- ── seed rows as admin ──────────────────────────────────────────────────────
set local role authenticated;
select _claims('admin', '33333333-3333-3333-3333-333333333333');

insert into public.portfolio (tenant_id, slug, title, status)
  values ('33333333-3333-3333-3333-333333333333', 'pf-del', '{"en":"P","ar":"ب"}', 'published');
insert into public.pages (tenant_id, slug, title, status)
  values ('33333333-3333-3333-3333-333333333333', 'pg-del', '{"en":"Pg","ar":"ص"}', 'published');
insert into public.page_sections (tenant_id, page_id, type)
  select '33333333-3333-3333-3333-333333333333', id, 'hero'
  from public.pages where slug = 'pg-del';
insert into public.media_assets (tenant_id, kind, storage_path)
  values ('33333333-3333-3333-3333-333333333333', 'image', '/seed/x.png');
-- 0018: the content tables 0007 missed.
insert into public.team_members (tenant_id, slug, name, status)
  values ('33333333-3333-3333-3333-333333333333', 'tm-del', '{"en":"T","ar":"ت"}', 'published');
insert into public.certifications (tenant_id, slug, name, status)
  values ('33333333-3333-3333-3333-333333333333', 'cert-del', '{"en":"C","ar":"ش"}', 'published');
insert into public.statistics (tenant_id, slug, label, value, status)
  values ('33333333-3333-3333-3333-333333333333', 'stat-del', '{"en":"S","ar":"إ"}', '1', 'published');
insert into public.categories (tenant_id, slug, name)
  values ('33333333-3333-3333-3333-333333333333', 'cat-del', '{"en":"K","ar":"ف"}');
insert into public.partner_logos (tenant_id, name, logo_url)
  values ('33333333-3333-3333-3333-333333333333', 'logo-del', 'https://example.test/l.svg');
-- 0018: the Style-Finder tables' missing archive gate (their delete gate is 0009's).
insert into public.ai_questions (tenant_id, slug, prompt, status)
  values ('33333333-3333-3333-3333-333333333333', 'q-del', '{"en":"Q","ar":"س"}', 'published');
insert into public.ai_styles (tenant_id, slug, name, status)
  values ('33333333-3333-3333-3333-333333333333', 's-del', '{"en":"S","ar":"ط"}', 'published');

-- ── Content Creator: CANNOT delete (RLS filters → row survives) ─────────────
select _claims('content_creator', '33333333-3333-3333-3333-333333333333');

delete from public.portfolio where slug = 'pf-del';
select is((select count(*) from public.portfolio where slug = 'pf-del')::int, 1,
  'content_creator delete of portfolio is a no-op (row survives)');

delete from public.pages where slug = 'pg-del';
select is((select count(*) from public.pages where slug = 'pg-del')::int, 1,
  'content_creator delete of pages is a no-op (row survives)');

delete from public.page_sections;
select is((select count(*) from public.page_sections)::int, 1,
  'content_creator delete of page_sections is a no-op (row survives)');

delete from public.media_assets;
select is((select count(*) from public.media_assets)::int, 1,
  'content_creator hard-delete of media is a no-op (row survives)');

delete from public.team_members where slug = 'tm-del';
select is((select count(*) from public.team_members where slug = 'tm-del')::int, 1,
  'content_creator delete of team_members is a no-op (0018)');
delete from public.certifications where slug = 'cert-del';
select is((select count(*) from public.certifications where slug = 'cert-del')::int, 1,
  'content_creator delete of certifications is a no-op (0018)');
delete from public.statistics where slug = 'stat-del';
select is((select count(*) from public.statistics where slug = 'stat-del')::int, 1,
  'content_creator delete of statistics is a no-op (0018)');
delete from public.categories where slug = 'cat-del';
select is((select count(*) from public.categories where slug = 'cat-del')::int, 1,
  'content_creator delete of categories is a no-op (0018)');
delete from public.partner_logos where name = 'logo-del';
select is((select count(*) from public.partner_logos where name = 'logo-del')::int, 1,
  'content_creator delete of partner_logos is a no-op (0018)');

-- ── Content Creator: CANNOT archive (WITH CHECK → 42501) ────────────────────
select throws_ok(
  $$ update public.portfolio set status = 'archived' where slug = 'pf-del' $$,
  '42501', null, 'content_creator cannot archive portfolio');
select throws_ok(
  $$ update public.pages set status = 'archived' where slug = 'pg-del' $$,
  '42501', null, 'content_creator cannot archive pages');
select throws_ok(
  $$ update public.team_members set status = 'archived' where slug = 'tm-del' $$,
  '42501', null, 'content_creator cannot archive team_members (0018)');
select throws_ok(
  $$ update public.certifications set status = 'archived' where slug = 'cert-del' $$,
  '42501', null, 'content_creator cannot archive certifications (0018)');
select throws_ok(
  $$ update public.statistics set status = 'archived' where slug = 'stat-del' $$,
  '42501', null, 'content_creator cannot archive statistics (0018)');
select throws_ok(
  $$ update public.ai_questions set status = 'archived' where slug = 'q-del' $$,
  '42501', null, 'content_creator cannot archive ai_questions (0018)');
select throws_ok(
  $$ update public.ai_styles set status = 'archived' where slug = 's-del' $$,
  '42501', null, 'content_creator cannot archive ai_styles (0018)');
select lives_ok(
  $$ update public.ai_questions set sort_order = 3 where slug = 'q-del' $$,
  'content_creator can still edit ai_questions (ai.editContent)');

-- ── Content Creator: CAN still edit (non-archive update) ────────────────────
select lives_ok(
  $$ update public.portfolio set sort_order = 9 where slug = 'pf-del' $$,
  'content_creator can still edit portfolio (non-archive)');

-- ── Admin: CAN archive + delete everything ──────────────────────────────────
select _claims('admin', '33333333-3333-3333-3333-333333333333');
select lives_ok(
  $$ update public.pages set status = 'archived' where slug = 'pg-del' $$,
  'admin can archive pages');
select lives_ok($$ delete from public.media_assets $$, 'admin can hard-delete media');
select lives_ok($$ delete from public.page_sections $$, 'admin can delete page_sections');
select lives_ok($$ delete from public.pages where slug = 'pg-del' $$, 'admin can delete pages');
select lives_ok($$ delete from public.portfolio where slug = 'pf-del' $$, 'admin can delete portfolio');
select lives_ok(
  $$ update public.statistics set status = 'archived' where slug = 'stat-del' $$,
  'admin can archive statistics (0018)');
select lives_ok(
  $$ update public.ai_questions set status = 'archived' where slug = 'q-del' $$,
  'admin can archive ai_questions (0018)');
select lives_ok(
  $$ update public.ai_styles set status = 'archived' where slug = 's-del' $$,
  'admin can archive ai_styles (0018)');
delete from public.team_members where slug = 'tm-del';
delete from public.certifications where slug = 'cert-del';
delete from public.statistics where slug = 'stat-del';
delete from public.categories where slug = 'cat-del';
delete from public.partner_logos where name = 'logo-del';
select is(
  (select count(*)::int from (
     select 1 from public.team_members where slug = 'tm-del'
     union all select 1 from public.certifications where slug = 'cert-del'
     union all select 1 from public.statistics where slug = 'stat-del'
     union all select 1 from public.categories where slug = 'cat-del'
     union all select 1 from public.partner_logos where name = 'logo-del') x),
  0, 'admin can delete team_members, certifications, statistics, categories, partner_logos (0018)');

-- The gates themselves are RESTRICTIVE — a permissive policy would OR with the write
-- policy and narrow nothing, with every assertion above still green.
reset role;
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and permissive = 'RESTRICTIVE'
      and policyname in (
        'team_members_delete_admin', 'certifications_delete_admin', 'statistics_delete_admin',
        'categories_delete_admin', 'partner_logos_delete_admin',
        'team_members_archive_admin', 'certifications_archive_admin', 'statistics_archive_admin',
        'ai_questions_archive_admin', 'ai_styles_archive_admin')),
  10, 'the ten 0018 gates are RESTRICTIVE');

reset role;
select _claims(null, null);
select * from finish();
rollback;
