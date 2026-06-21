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

-- ── Content Creator: CANNOT archive (WITH CHECK → 42501) ────────────────────
select throws_ok(
  $$ update public.portfolio set status = 'archived' where slug = 'pf-del' $$,
  '42501', null, 'content_creator cannot archive portfolio');
select throws_ok(
  $$ update public.pages set status = 'archived' where slug = 'pg-del' $$,
  '42501', null, 'content_creator cannot archive pages');

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

reset role;
select _claims(null, null);
select * from finish();
rollback;
