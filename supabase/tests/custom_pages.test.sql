-- pgTAP: custom pages (0123, Admin v2 E11). Run with `supabase test db`.
--
-- A custom page is a `pages` row whose slug is not a route slug; it renders at /<slug> and
-- /ar/<slug>. What 0123 adds is one rule on the slug, for every writer:
--   • the shape: lowercase kebab-case, 1 to 64 characters (23514 pages_slug_shape);
--   • a reserved word refused (23514 pages_slug_reserved): a path the site already answers;
--   • only on an insert or a slug that changes: a save sending the slug unchanged passes.
-- And what it leaves to the table's existing RLS, proved for a custom page over every role
-- (CLAUDE.md §5 "Pages & sections", "Publish / schedule", "Archive / delete content"; §9):
--   • Admin and Content Creator create, edit and publish one in their tenant;
--   • only Admin archives or deletes one (Content Creator: refused / no row);
--   • SEO, Developer, a Sales token and anon create nothing and change no row;
--   • another tenant's Admin neither sees nor changes this tenant's page;
--   • anon reads a published custom page and never a draft one.
-- No stale-token rows: no definer function or live check guards pages (its writes are the
-- token's role, as every content table's).

begin;
select plan(34);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('e1100000-0000-0000-0000-000000000001', 'E11-T1'),
  ('e1100000-0000-0000-0000-0000000000ff', 'E11-T2');

insert into public.pages (id, tenant_id, slug, title, status) values
  ('e1100000-0000-0000-0000-00000000a001', 'e1100000-0000-0000-0000-000000000001', 'about',
   '{"en":"About","ar":"من نحن"}', 'published'),
  ('e1100000-0000-0000-0000-00000000a002', 'e1100000-0000-0000-0000-000000000001', 'e11-live',
   '{"en":"Live","ar":"منشورة"}', 'published'),
  ('e1100000-0000-0000-0000-00000000a003', 'e1100000-0000-0000-0000-000000000001', 'e11-draft',
   '{"en":"Draft","ar":"مسودة"}', 'draft');
-- anon reads through the anon fence: the single launch tenant.
insert into public.pages (id, tenant_id, slug, title, status) values
  ('e1100000-0000-0000-0000-00000000b001', app.default_tenant_id(), 'e11-anon-live',
   '{"en":"Live","ar":"منشورة"}', 'published'),
  ('e1100000-0000-0000-0000-00000000b002', app.default_tenant_id(), 'e11-anon-draft',
   '{"en":"Draft","ar":"مسودة"}', 'draft');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', 'e1100000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
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

-- An insert of a page of T1 at `p_slug`, as the CURRENT role.
create function _new(p_slug text) returns text language sql as $$
  select _run(format(
    $f$insert into public.pages (tenant_id, slug, title, status)
       values ('e1100000-0000-0000-0000-000000000001', %L, '{"en":"New","ar":"جديدة"}', 'draft')$f$,
    p_slug))
$$;

-- The constraint a refused insert names (as the migration role), or 'ok'.
create function _refusal(p_slug text) returns text language plpgsql as $$
declare
  c text;
begin
  insert into public.pages (tenant_id, slug, title, status)
  values ('e1100000-0000-0000-0000-000000000001', p_slug, '{"en":"X","ar":"س"}', 'draft');
  return 'ok';
exception when check_violation then
  get stacked diagnostics c = constraint_name;
  return c;
end $$;

grant execute on function _as(text, text), _run(text), _new(text) to anon, authenticated, service_role;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok(exists (select 1 from pg_trigger
                   where tgrelid = 'public.pages'::regclass and tgname = 'pages_slug_rules'
                     and not tgisinternal),
  'pages carries the slug rule');
select ok((select not prosecdef and proconfig = array['search_path=""'] from pg_proc
            where oid = 'app.tg_pages_slug_rules()'::regprocedure),
  'the rule is SECURITY INVOKER with its search path pinned');
select ok(not has_function_privilege('authenticated', 'app.tg_pages_slug_rules()', 'execute')
          and not has_function_privilege('anon', 'app.tg_pages_slug_rules()', 'execute')
          and not has_function_privilege('service_role', 'app.tg_pages_slug_rules()', 'execute'),
  'no API role executes the rule itself');
select is(
  (select string_agg(polname::text, ',' order by polname) from pg_policy
    where polrelid = 'public.pages'::regclass),
  'pages_archive_admin,pages_delete_admin,pages_read,pages_write',
  'the policies on pages are unchanged');

-- ── 2. the shape and the reserved words, for every writer ─────────────────────
select is(_refusal('Our-Story'), 'pages_slug_shape', 'an upper-case letter is refused');
select is(_refusal('our--story'), 'pages_slug_shape', 'a doubled hyphen is refused');
select is(_refusal('our_story'), 'pages_slug_shape', 'an underscore is refused');
select is(_refusal('-story'), 'pages_slug_shape', 'a leading hyphen is refused');
select is(_refusal(repeat('a', 65)), 'pages_slug_shape', 'more than 64 characters is refused');
select is(_refusal('admin'), 'pages_slug_reserved', 'the admin is a reserved word, even for the migration role');
select is(_refusal('cdn-cgi'), 'pages_slug_reserved', 'so is Cloudflare''s own path');
select is(_refusal(repeat('a', 64)), 'ok', 'exactly 64 characters is an address');

set local role service_role;
select is(_new('api'), '23514', 'the service role cannot take a reserved word either');
reset role;

-- ── 3. who creates one ─────────────────────────────────────────────────────────
set local role authenticated;
select _as('admin', 'e1100000-0000-0000-0000-000000000001');
select is(_new('e11-admin-page'), 'ok:1', 'admin creates a custom page');
select is(_new('search'), '23514', 'but not at a reserved word');
select is(_new('about'), '23505', 'nor at a route page''s slug while that page exists');
select _as('content_creator', 'e1100000-0000-0000-0000-000000000001');
select is(_new('e11-creator-page'), 'ok:1', 'content_creator creates a custom page');
select is(_run($$ update public.pages set status = 'published'
                  where slug = 'e11-creator-page' $$),
  'ok:1', 'and publishes it (content.publish)');
select is(_run($$ update public.pages set slug = 'privacy' where slug = 'e11-creator-page' $$),
  '23514', 'a rename to a reserved word is refused');
select is(_run($$ update public.pages set slug = 'e11-creator-page', title = '{"en":"Ours","ar":"لنا"}'
                  where slug = 'e11-creator-page' $$),
  'ok:1', 'a save that sends the slug unchanged is not a rename');
select is(_run($$ update public.pages set status = 'archived' where slug = 'e11-creator-page' $$),
  '42501', 'content_creator cannot archive it (Admin only)');
select is(_run($$ delete from public.pages where slug = 'e11-creator-page' $$),
  'ok:0', 'nor delete it');
select _as('seo', 'e1100000-0000-0000-0000-000000000001');
select is(_new('e11-seo-page'), '42501', 'seo creates no page');
select is(_run($$ update public.pages set status = 'draft' where slug = 'e11-live' $$),
  'ok:0', 'nor changes one');
select _as('developer', 'e1100000-0000-0000-0000-000000000001');
select is(_new('e11-dev-page'), '42501', 'developer creates no page');
select _as('sales', 'e1100000-0000-0000-0000-000000000001');
select is(_new('e11-sales-page'), '42501', 'a sales token creates no page');
select _as('admin', 'e1100000-0000-0000-0000-0000000000ff');
select is(_run($$ update public.pages set status = 'draft' where slug = 'e11-live'
                  and tenant_id = 'e1100000-0000-0000-0000-000000000001' $$),
  'ok:0', 'another tenant''s admin changes no page of this tenant');
select is((select count(*)::int from public.pages
            where tenant_id = 'e1100000-0000-0000-0000-000000000001'),
  0, 'and sees none of them');
select _as('admin', 'e1100000-0000-0000-0000-000000000001');
select is(_run($$ update public.pages set status = 'archived' where slug = 'e11-creator-page' $$),
  'ok:1', 'admin archives a custom page');
select is(_run($$ delete from public.pages where slug = 'e11-creator-page' $$),
  'ok:1', 'and deletes it');
reset role;

-- ── 4. anon ──────────────────────────────────────────────────────────────────
set local role anon;
select _as(null, null);
select is(_new('e11-anon-page'), '42501', 'anon creates no page');
select is((select count(*)::int from public.pages where slug = 'e11-anon-live'), 1,
  'anon reads a published custom page');
select is((select count(*)::int from public.pages where slug = 'e11-anon-draft'), 0,
  'and never a draft one');
reset role;

-- ── 5. a history row, as for every page ───────────────────────────────────────
select ok(exists (select 1 from public.content_versions v
                   join public.pages p on p.id = v.entity_id
                  where v.entity_type = 'page' and p.slug = 'e11-admin-page'),
  'a custom page keeps history like every page');

select * from finish();
rollback;
