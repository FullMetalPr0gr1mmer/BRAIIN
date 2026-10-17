-- pgTAP: page visibility (0057, Admin v2 U14a). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus the
-- three stale Developer tokens the live policies exist for: one whose profile was demoted to
-- seo, one deactivated and one locked, each still carrying a `developer` claim (CLAUDE.md §9
-- (b)).
--   • who writes: Admin and Developer insert and update their tenant's rows; Content
--     Creator and SEO write nothing (an insert is refused, an update reaches no row); a stale
--     token writes nothing either; another tenant's Admin cannot write into this tenant;
--     nobody deletes through the API, not even an Admin;
--   • who reads: every CMS role reads its own tenant's rows and no other tenant's; anon holds
--     no privilege at all (decision D3);
--   • the rules: the homepage is always public, for every writer, the service role included;
--     templates take public or hidden only; one target per row and one row per target; a
--     redirect and a window only on a hidden row, the window in order, no redirect to the page
--     itself, and no page or redirect of another tenant (the composite keys); a row's target
--     never moves; a deleted redirect target leaves the row hidden, with a 404;
--   • the route-bound slugs: no writer renames a page a public route renders, gives a page
--     such a slug, or renames a page that has a setting (the edge enforces settings by slug);
--   • the history and actor triggers fire; the catalog: the helper, the exact policy set (the
--     tenant predicate first in each), the grants, the triggers and the registry row.

begin;
select plan(66);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('57000000-0000-0000-0000-000000000001', 'T1'),
  ('57000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('57000000-0000-0000-0000-0000000000a1', 'u14-admin@example.test'),
  ('57000000-0000-0000-0000-0000000000d1', 'u14-developer@example.test'),
  ('57000000-0000-0000-0000-0000000000d2', 'u14-demoted@example.test'),
  ('57000000-0000-0000-0000-0000000000d3', 'u14-inactive@example.test'),
  ('57000000-0000-0000-0000-0000000000d4', 'u14-locked@example.test'),
  ('57000000-0000-0000-0000-0000000000c1', 'u14-creator@example.test'),
  ('57000000-0000-0000-0000-0000000000e1', 'u14-seo@example.test'),
  ('57000000-0000-0000-0000-0000000000f1', 'u14-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('57000000-0000-0000-0000-0000000000a1', '57000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('57000000-0000-0000-0000-0000000000d1', '57000000-0000-0000-0000-000000000001', 'developer', true, null),
  -- Stale: each token below still says developer.
  ('57000000-0000-0000-0000-0000000000d2', '57000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('57000000-0000-0000-0000-0000000000d3', '57000000-0000-0000-0000-000000000001', 'developer', false, null),
  ('57000000-0000-0000-0000-0000000000d4', '57000000-0000-0000-0000-000000000001', 'developer', true,
   now() + interval '10 minutes'),
  ('57000000-0000-0000-0000-0000000000c1', '57000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('57000000-0000-0000-0000-0000000000e1', '57000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('57000000-0000-0000-0000-0000000000f1', '57000000-0000-0000-0000-0000000000ff', 'admin', true, null);

insert into public.pages (id, tenant_id, slug, title, status) values
  ('57000000-0000-0000-0000-00000000a001', '57000000-0000-0000-0000-000000000001', 'home',
   '{"en":"Home","ar":"الرئيسية"}', 'published'),
  ('57000000-0000-0000-0000-00000000a002', '57000000-0000-0000-0000-000000000001', 'about',
   '{"en":"About","ar":"من نحن"}', 'published'),
  ('57000000-0000-0000-0000-00000000a003', '57000000-0000-0000-0000-000000000001', 'contact',
   '{"en":"Contact","ar":"تواصل"}', 'published'),
  ('57000000-0000-0000-0000-00000000a004', '57000000-0000-0000-0000-000000000001', 'join',
   '{"en":"Join","ar":"انضم"}', 'published'),
  ('57000000-0000-0000-0000-00000000f002', '57000000-0000-0000-0000-0000000000ff', 'about',
   '{"en":"About","ar":"من نحن"}', 'published'),
  -- Two pages no public route renders (the slug freeze leaves them alone, until one is set).
  ('57000000-0000-0000-0000-00000000a0e1', '57000000-0000-0000-0000-000000000001', 'u14-free',
   '{"en":"Free","ar":"حرة"}', 'draft'),
  ('57000000-0000-0000-0000-00000000a0e2', '57000000-0000-0000-0000-000000000001', 'u14-set',
   '{"en":"Set","ar":"محددة"}', 'draft');

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true
  )
$$;

-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function _run(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;

-- The T1 and T2 rows the CURRENT role reads, as "t1/t2".
create function _seen() returns text language sql stable as $$
  select (select count(*) from public.page_visibility where tenant_id = '57000000-0000-0000-0000-000000000001')::text
         || '/' ||
         (select count(*) from public.page_visibility where tenant_id = '57000000-0000-0000-0000-0000000000ff')::text
$$;

grant execute on function _as(text, text, text), _run(text), _seen() to anon, authenticated, service_role;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.page_visibility'::regclass),
  'page_visibility: RLS enabled and forced');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'page_visibility'),
  'page_visibility_insert INSERT PERMISSIVE {authenticated}, '
  'page_visibility_live_delete DELETE RESTRICTIVE {authenticated}, '
  'page_visibility_live_insert INSERT RESTRICTIVE {authenticated}, '
  'page_visibility_live_update UPDATE RESTRICTIVE {authenticated}, '
  'page_visibility_read SELECT PERMISSIVE {authenticated}, '
  'page_visibility_update UPDATE PERMISSIVE {authenticated}',
  'exactly the staff read, the JWT insert and update, and the three RESTRICTIVE live checks');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'page_visibility'
      and coalesce(qual, with_check) ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '),
  6, 'each policy names the tenant predicate first');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'page_visibility' and permissive = 'RESTRICTIVE'
      and coalesce(qual, with_check) ~ 'role_manages_visibility\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$'),
  3, 'the three live checks ask maintenance.manage of the live role');
select ok(
  app.role_manages_visibility('admin') and app.role_manages_visibility('developer')
    and not app.role_manages_visibility('content_creator') and not app.role_manages_visibility('seo')
    and not app.role_manages_visibility('anon') and not app.role_manages_visibility(null),
  'app.role_manages_visibility is maintenance.manage: Admin and Developer');
select ok(
  has_table_privilege('authenticated', 'public.page_visibility', 'select')
    and not has_table_privilege('authenticated', 'public.page_visibility', 'insert')
    and not has_table_privilege('authenticated', 'public.page_visibility', 'update')
    and not has_table_privilege('authenticated', 'public.page_visibility', 'delete')
    and not has_table_privilege('authenticated', 'public.page_visibility', 'truncate')
    and has_column_privilege('authenticated', 'public.page_visibility', 'mode', 'insert')
    and has_column_privilege('authenticated', 'public.page_visibility', 'page_id', 'insert')
    and has_column_privilege('authenticated', 'public.page_visibility', 'mode', 'update')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'page_id', 'update')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'template', 'update')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'tenant_id', 'update')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'version', 'insert'),
  'staff read the table, insert the row''s own columns and update only the mode and its extras');
select ok(
  has_table_privilege('service_role', 'public.page_visibility', 'select')
    and has_table_privilege('service_role', 'public.page_visibility', 'update')
    and not has_table_privilege('service_role', 'public.page_visibility', 'insert')
    and not has_table_privilege('service_role', 'public.page_visibility', 'delete')
    and not has_table_privilege('service_role', 'public.page_visibility', 'truncate')
    and not has_any_column_privilege('anon', 'public.page_visibility', 'select, insert, update, references')
    and not has_any_column_privilege('public', 'public.page_visibility', 'select, insert, update, references'),
  'the service role reads and locks (the cron, the release apply); anon and PUBLIC hold nothing');
select is(
  (select string_agg(t.tgname::text, ',' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.page_visibility'::regclass and not t.tgisinternal),
  'page_visibility_actor,page_visibility_guard,page_visibility_password,'
  'page_visibility_release_capture,page_visibility_snapshot,page_visibility_updated_at,'
  'page_visibility_version',
  'the actor, guard, stamp and version triggers, history, release capture and (0061) the '
  'password sync');
select ok(
  exists (select 1 from app.release_entities
           where entity_type = 'page_visibility' and table_name = 'page_visibility'
             and area = 'settings' and author_roles = array['admin', 'developer']
             and delete_roles = '{}'::text[] and apply_order = 85
             and columns = array['page_id', 'template', 'mode', 'redirect_page_id', 'hide_from',
                                 'show_on', 'note']),
  'the registry row: Admin and Developer stage it, no release removes one, after pages '
  '(0061 added the password gate''s message to it)');
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.pages'::regclass and conname = 'pages_tenant_id_id'
             and pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'),
  'pages carries the composite key the two foreign keys rest on');

-- ── 2. who writes ──────────────────────────────────────────────────────────────
set local role authenticated;

select _as('57000000-0000-0000-0000-0000000000a1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (id, tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-0000000b0001', '57000000-0000-0000-0000-000000000001',
                          '57000000-0000-0000-0000-00000000a002', 'hidden') $$),
  'ok:1', 'admin hides About');
select is(_run($$ update public.page_visibility set mode = 'link'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:1', 'admin makes it link only');

select _as('57000000-0000-0000-0000-0000000000d1', 'developer', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (id, tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-0000000b0002', '57000000-0000-0000-0000-000000000001',
                          '57000000-0000-0000-0000-00000000a003', 'link') $$),
  'ok:1', 'developer sets Contact to link only');
select is(_run($$ update public.page_visibility
                    set mode = 'hidden', redirect_page_id = '57000000-0000-0000-0000-00000000a001'
                  where id = '57000000-0000-0000-0000-0000000b0002' $$),
  'ok:1', 'developer hides it, sending visitors to the homepage');

select _as('57000000-0000-0000-0000-0000000000c1', 'content_creator', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004', 'hidden') $$),
  '42501', 'content_creator cannot hide a page');
select is(_run($$ update public.page_visibility set mode = 'public'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:0', 'content_creator''s update reaches no row');

select _as('57000000-0000-0000-0000-0000000000e1', 'seo', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004', 'hidden') $$),
  '42501', 'seo cannot hide a page');
select is(_run($$ update public.page_visibility set mode = 'public'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:0', 'seo''s update reaches no row');

-- The stale tokens: each claims developer, which the JWT layer still admits.
select _as('57000000-0000-0000-0000-0000000000d2', 'developer', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004', 'hidden') $$),
  '42501', 'a demoted Developer''s token (profile seo) cannot insert');
select is(_run($$ update public.page_visibility set mode = 'public'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:0', 'nor update');
select _as('57000000-0000-0000-0000-0000000000d3', 'developer', '57000000-0000-0000-0000-000000000001');
select is(_run($$ update public.page_visibility set mode = 'public'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:0', 'a deactivated Developer''s token updates no row');
select _as('57000000-0000-0000-0000-0000000000d4', 'developer', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004', 'hidden') $$),
  '42501', 'a locked Developer''s token cannot insert');
-- A token that claims more than the profile holds: a Content Creator claiming admin.
select _as('57000000-0000-0000-0000-0000000000c1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_run($$ update public.page_visibility set mode = 'public'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:0', 'a token whose claim disagrees with the profile updates no row');

select _as('57000000-0000-0000-0000-0000000000f1', 'admin', '57000000-0000-0000-0000-0000000000ff');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004', 'hidden') $$),
  '42501', 'other_tenant: another tenant''s Admin cannot write into T1');
select is(_run($$ update public.page_visibility set mode = 'public'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:0', 'other_tenant: nor reach a T1 row');

select _as('57000000-0000-0000-0000-0000000000a1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_run($$ delete from public.page_visibility where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '42501', 'nobody deletes a row through the API, not even an Admin');
select is(_run($$ update public.page_visibility set page_id = '57000000-0000-0000-0000-00000000a004'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '42501', 'staff cannot move a row to another page (no UPDATE on the target)');

-- ── 3. who reads ───────────────────────────────────────────────────────────────
select _as('57000000-0000-0000-0000-0000000000a1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_seen(), '2/0', 'admin reads its tenant''s rows and no other tenant''s');
select _as('57000000-0000-0000-0000-0000000000d1', 'developer', '57000000-0000-0000-0000-000000000001');
select is(_seen(), '2/0', 'developer reads them');
select _as('57000000-0000-0000-0000-0000000000c1', 'content_creator', '57000000-0000-0000-0000-000000000001');
select is(_seen(), '2/0', 'content_creator reads them (registry contract #1)');
select _as('57000000-0000-0000-0000-0000000000e1', 'seo', '57000000-0000-0000-0000-000000000001');
select is(_seen(), '2/0', 'seo reads them');
select _as('57000000-0000-0000-0000-0000000000f1', 'admin', '57000000-0000-0000-0000-0000000000ff');
select is(_seen(), '0/0', 'other_tenant: another tenant''s Admin reads none of T1''s');
reset role;

select _as(null, null, null);
set local role anon;
select is(_run($$ select * from public.page_visibility $$), '42501',
  'anon cannot read the table (decision D3)');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004', 'link') $$),
  '42501', 'nor write it');
reset role;

-- ── 4. the homepage is always public ─────────────────────────────────────────
set local role authenticated;
select _as('57000000-0000-0000-0000-0000000000a1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a001', 'hidden') $$),
  '23514', 'admin cannot hide the homepage');
select _as('57000000-0000-0000-0000-0000000000d1', 'developer', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a001', 'link') $$),
  '23514', 'developer cannot make it link only');
select is(_run($$ insert into public.page_visibility (id, tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-0000000b0003', '57000000-0000-0000-0000-000000000001',
                          '57000000-0000-0000-0000-00000000a001', 'public') $$),
  'ok:1', 'a public row for it is fine');
reset role;
set local role service_role;
select is(_run($$ update public.page_visibility set mode = 'hidden'
                  where id = '57000000-0000-0000-0000-0000000b0003' $$),
  '23514', 'and not even the service role can hide it');
reset role;
select throws_ok(
  $$ update public.page_visibility set mode = 'link' where id = '57000000-0000-0000-0000-0000000b0003' $$,
  '23514', 'The homepage cannot be hidden. Use maintenance mode instead.',
  'nor the migration role, with the words the admin shows');

-- ── 5. templates and the table's rules ───────────────────────────────────────
set local role authenticated;
select _as('57000000-0000-0000-0000-0000000000a1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.page_visibility (id, tenant_id, template, mode)
                  values ('57000000-0000-0000-0000-0000000b0004', '57000000-0000-0000-0000-000000000001',
                          'service', 'hidden') $$),
  'ok:1', 'admin hides the service template');
select is(_run($$ update public.page_visibility set mode = 'link'
                  where id = '57000000-0000-0000-0000-0000000b0004' $$),
  '23514', 'a template is never link only (D1)');
select is(_run($$ insert into public.page_visibility (tenant_id, template, mode)
                  values ('57000000-0000-0000-0000-000000000001', 'blog', 'hidden') $$),
  '23514', 'only the two templates exist');
select is(_run($$ insert into public.page_visibility (tenant_id, template, mode)
                  values ('57000000-0000-0000-0000-000000000001', 'service', 'public') $$),
  '23505', 'one row per template');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a002', 'public') $$),
  '23505', 'one row per page');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, template, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a004',
                          'case_study', 'hidden') $$),
  '23514', 'a row is about a page or a template, not both');
select is(_run($$ insert into public.page_visibility (tenant_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', 'hidden') $$),
  '23514', 'and not neither');
select is(_run($$ update public.page_visibility
                    set redirect_page_id = '57000000-0000-0000-0000-00000000a003'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '23514', 'a redirect belongs to a hidden row only (About is link only)');
select is(_run($$ update public.page_visibility set hide_from = now()
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '23514', 'and so does a window');
select is(_run($$ update public.page_visibility
                    set mode = 'hidden', hide_from = '2026-11-02T00:00:00+03', show_on = '2026-11-01T00:00:00+03'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '23514', 'a window ends after it starts');
select is(_run($$ update public.page_visibility
                    set mode = 'hidden', redirect_page_id = '57000000-0000-0000-0000-00000000a002'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '23514', 'a page never redirects to itself');
select is(_run($$ update public.page_visibility
                    set mode = 'hidden', redirect_page_id = '57000000-0000-0000-0000-00000000f002'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '23503', 'nor to another tenant''s page (the composite key)');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000f002', 'hidden') $$),
  '23503', 'and no row names another tenant''s page');
select is(_run($$ update public.page_visibility
                    set mode = 'hidden', redirect_page_id = '57000000-0000-0000-0000-00000000a004',
                        hide_from = '2026-11-01T00:00:00+03', show_on = '2026-11-08T00:00:00+03'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  'ok:1', 'About hidden for a week, its visitors sent to Join');
reset role;
set local role service_role;
select is(_run($$ update public.page_visibility set page_id = '57000000-0000-0000-0000-00000000a004'
                  where id = '57000000-0000-0000-0000-0000000b0001' $$),
  '23514', 'a row''s target never moves, whoever writes it');
reset role;

-- ── 5b. the route-bound slugs never move (a setting is stored by id, enforced by slug) ──
set local role authenticated;
select _as('57000000-0000-0000-0000-0000000000c1', 'content_creator', '57000000-0000-0000-0000-000000000001');
select is(_run($$ update public.pages set slug = 'about-old'
                  where id = '57000000-0000-0000-0000-00000000a002' $$),
  '23514', 'content_creator cannot rename a hidden page off its route (it would show again)');
select is(_run($$ update public.pages set slug = 'services'
                  where id = '57000000-0000-0000-0000-00000000a0e1' $$),
  '23514', 'nor give a page a slug a public route renders (a swap would move a setting)');
select is(_run($$ update public.pages set slug = 'u14-free-2'
                  where id = '57000000-0000-0000-0000-00000000a0e1' $$),
  'ok:1', 'a page no route renders, with no setting, is renamed as before');
select is(_run($$ update public.pages set slug = 'about', title = '{"en":"About us","ar":"من نحن"}'
                  where id = '57000000-0000-0000-0000-00000000a002' $$),
  'ok:1', 'a save that sends the slug unchanged is not a rename');
select _as('57000000-0000-0000-0000-0000000000a1', 'admin', '57000000-0000-0000-0000-000000000001');
select is(_run($$ update public.pages set slug = 'contact-2'
                  where id = '57000000-0000-0000-0000-00000000a003' $$),
  '23514', 'nor can an Admin rename a route-bound page');
select is(_run($$ insert into public.page_visibility (tenant_id, page_id, mode)
                  values ('57000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-00000000a0e2', 'link') $$),
  'ok:1', 'admin sets a page no route renders (RLS allows any page of the tenant)');
select is(_run($$ update public.pages set slug = 'about-2'
                  where id = '57000000-0000-0000-0000-00000000a0e2' $$),
  '23514', 'and that page keeps its slug from then on');
reset role;
set local role service_role;
select is(_run($$ update public.pages set slug = 'home-2'
                  where id = '57000000-0000-0000-0000-00000000a001' $$),
  '23514', 'not even the service role renames one');
reset role;

-- ── 6. the triggers, and a deleted target ────────────────────────────────────
select is(
  (select format('%s %s %s', version, created_by, updated_by) from public.page_visibility
    where id = '57000000-0000-0000-0000-0000000b0001'),
  '3 57000000-0000-0000-0000-0000000000a1 57000000-0000-0000-0000-0000000000a1',
  'the database owns the version and names who wrote the row');
select is(
  (select string_agg(version::text || ':' || (snapshot ->> 'mode'), ',' order by version)
     from public.content_versions
    where entity_type = 'page_visibility' and entity_id = '57000000-0000-0000-0000-0000000b0001'),
  '1:hidden,2:link,3:hidden', 'every write is in the history, under its entity type');
delete from public.pages where id = '57000000-0000-0000-0000-00000000a004';
select is(
  (select format('%s %s', mode, coalesce(redirect_page_id::text, '404')) from public.page_visibility
    where id = '57000000-0000-0000-0000-0000000b0001'),
  'hidden 404', 'a deleted redirect target leaves the page hidden, answering 404');
delete from public.pages where id = '57000000-0000-0000-0000-00000000a003';
select is(
  (select count(*)::int from public.page_visibility where id = '57000000-0000-0000-0000-0000000b0002'),
  0, 'a deleted page takes its row with it');

select * from finish();
rollback;
