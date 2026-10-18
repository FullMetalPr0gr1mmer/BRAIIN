-- pgTAP: the page password (0061, Admin v2 U14b). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus the
-- three stale Developer tokens the live check exists for: one whose profile was demoted to
-- seo, one deactivated and one locked, each still carrying a `developer` claim (CLAUDE.md §9
-- (b)). page_visibility's own per-role matrix is page_visibility.test.sql (0057); this file
-- is about the secret and the fence:
--   • the secret: public.page_passwords holds one bcrypt hash per page and no API role holds
--     any privilege on it, table-wide or per column, so no token reads a hash at PostgREST;
--   • setting one: public.set_page_password is Admin and Developer, checked against the LIVE
--     profile, refuses the homepage, refuses a password outside 8 to 72 bytes and a message
--     that is not {en, ar} of plain text, writes the secret and the mode in one statement and
--     an audit row that names neither;
--   • checking one: public.page_password_check is the service role's alone, answers the
--     page's password_version on a match and null on a wrong password, a page with no secret
--     and another tenant's page alike;
--   • the fence: anon, and a signed-in token that is not staff, read no section of a page
--     behind a password and every section of a public one, staff are untouched, and
--     public.page_sections_unlocked (service role) returns exactly what anon would read
--     without the fence, and public.page_media_unlocked (service role) the images its
--     visible sections name, which the fence takes from anon too;
--   • leaving password mode deletes the secret, clears the message and moves the version, and
--     no writer can put a page into password mode without one.

begin;
select plan(61);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('61000000-0000-0000-0000-000000000001', 'P1'),
  ('61000000-0000-0000-0000-0000000000ff', 'P2');

insert into auth.users (id, email) values
  ('61000000-0000-0000-0000-0000000000a1', 'u14b-admin@example.test'),
  ('61000000-0000-0000-0000-0000000000d1', 'u14b-developer@example.test'),
  ('61000000-0000-0000-0000-0000000000d2', 'u14b-demoted@example.test'),
  ('61000000-0000-0000-0000-0000000000d3', 'u14b-inactive@example.test'),
  ('61000000-0000-0000-0000-0000000000d4', 'u14b-locked@example.test'),
  ('61000000-0000-0000-0000-0000000000c1', 'u14b-creator@example.test'),
  ('61000000-0000-0000-0000-0000000000e1', 'u14b-seo@example.test'),
  ('61000000-0000-0000-0000-0000000000f1', 'u14b-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('61000000-0000-0000-0000-0000000000a1', '61000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('61000000-0000-0000-0000-0000000000d1', '61000000-0000-0000-0000-000000000001', 'developer', true, null),
  -- Stale: each token below still says developer.
  ('61000000-0000-0000-0000-0000000000d2', '61000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('61000000-0000-0000-0000-0000000000d3', '61000000-0000-0000-0000-000000000001', 'developer', false, null),
  ('61000000-0000-0000-0000-0000000000d4', '61000000-0000-0000-0000-000000000001', 'developer', true,
   now() + interval '10 minutes'),
  ('61000000-0000-0000-0000-0000000000c1', '61000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('61000000-0000-0000-0000-0000000000e1', '61000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('61000000-0000-0000-0000-0000000000f1', '61000000-0000-0000-0000-0000000000ff', 'admin', true, null);

insert into public.pages (id, tenant_id, slug, title, status) values
  ('61000000-0000-0000-0000-00000000a001', '61000000-0000-0000-0000-000000000001', 'home',
   '{"en":"Home","ar":"الرئيسية"}', 'published'),
  ('61000000-0000-0000-0000-00000000a002', '61000000-0000-0000-0000-000000000001', 'about',
   '{"en":"About","ar":"من نحن"}', 'published'),
  ('61000000-0000-0000-0000-00000000a003', '61000000-0000-0000-0000-000000000001', 'contact',
   '{"en":"Contact","ar":"تواصل"}', 'published'),
  ('61000000-0000-0000-0000-00000000f002', '61000000-0000-0000-0000-0000000000ff', 'about',
   '{"en":"About","ar":"من نحن"}', 'published'),
  ('61000000-0000-0000-0000-00000000a004', '61000000-0000-0000-0000-000000000001', 'u14b-draft',
   '{"en":"Draft","ar":"مسودة"}', 'draft');
-- Four stills, each named by nothing but the sections below: About's visible section (m1),
-- About's hidden one (m2), nothing at all (m3) and a visible section of a draft page (m4).
insert into public.media_assets (id, tenant_id, kind, provider, storage_path, mime_type, width,
                                 height, folder, alt) values
  ('61000000-0000-4000-8000-000000000001', '61000000-0000-0000-0000-000000000001', 'image', 'static',
   'stills/work/u14b-1.jpg', 'image/jpeg', 1280, 720, 'stills', '{"en":"one","ar":"واحد"}'),
  ('61000000-0000-4000-8000-000000000002', '61000000-0000-0000-0000-000000000001', 'image', 'static',
   'stills/work/u14b-2.jpg', 'image/jpeg', 1280, 720, 'stills', '{"en":"two","ar":"اثنان"}'),
  ('61000000-0000-4000-8000-000000000003', '61000000-0000-0000-0000-000000000001', 'image', 'static',
   'stills/work/u14b-3.jpg', 'image/jpeg', 1280, 720, 'stills', '{"en":"three","ar":"ثلاثة"}'),
  ('61000000-0000-4000-8000-000000000004', '61000000-0000-0000-0000-000000000001', 'image', 'static',
   'stills/work/u14b-4.jpg', 'image/jpeg', 1280, 720, 'stills', '{"en":"four","ar":"أربعة"}');
-- Two sections on About (one hidden: anon never reads it, locked or not), one on Contact and
-- one on the draft page.
insert into public.page_sections (id, tenant_id, page_id, type, content, visible, sort_order) values
  ('61000000-0000-0000-0000-0000000051a1', '61000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-00000000a002', 'slogan',
   '{"body":{"en":"secret words"},"mediaId":"61000000-0000-4000-8000-000000000001"}', true, 10),
  ('61000000-0000-0000-0000-0000000051a2', '61000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-00000000a002', 'slogan',
   '{"body":{"en":"draft words"},"mediaId":"61000000-0000-4000-8000-000000000002"}', false, 20),
  ('61000000-0000-0000-0000-0000000051a3', '61000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-00000000a003', 'slogan', '{"body":{"en":"open words"}}', true, 10),
  ('61000000-0000-0000-0000-0000000051a4', '61000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-00000000a004', 'slogan',
   '{"body":{"en":"unpublished words"},"mediaId":"61000000-0000-4000-8000-000000000004"}', true, 10);

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

-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function _val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;

-- About's sections as the CURRENT role reads them, joined by ' | ' (sort order).
create function _about_sections() returns text language sql stable as $$
  select coalesce(string_agg(s.content -> 'body' ->> 'en', ' | ' order by s.sort_order), '')
    from public.page_sections s
   where s.page_id = '61000000-0000-0000-0000-00000000a002'
$$;

grant execute on function _as(text, text, text), _run(text), _val(text), _about_sections()
  to anon, authenticated, service_role;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.page_passwords'::regclass)
          and not exists (select 1 from pg_policies
                           where schemaname = 'public' and tablename = 'page_passwords'),
  'page_passwords: RLS enabled and forced, and not one policy');
select is(
  (select coalesce(string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv), '')
     from (select x.who, pr.priv
             from unnest(array['public', 'anon', 'authenticated', 'service_role']) as x(who)
             cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate',
                                     'references', 'trigger']) as pr(priv)
            where has_table_privilege(x.who::name, 'public.page_passwords', pr.priv)) g),
  '', 'no API role holds any privilege on page_passwords');
select ok(
  not has_any_column_privilege('anon', 'public.page_passwords', 'select, insert, update, references')
    and not has_any_column_privilege('authenticated', 'public.page_passwords', 'select, insert, update, references')
    and not has_any_column_privilege('service_role', 'public.page_passwords', 'select, insert, update, references')
    and not has_any_column_privilege('public', 'public.page_passwords', 'select, insert, update, references'),
  'nor a column privilege on it, the hash included');
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.page_passwords'::regclass and contype = 'p'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id, page_id)')
    and exists (select 1 from pg_constraint f
                 join pg_constraint k on k.conrelid = 'public.pages'::regclass
                                     and k.conname = 'pages_tenant_id_id' and k.conindid = f.conindid
                where f.conrelid = 'public.page_passwords'::regclass
                  and f.conname = 'page_passwords_page_fk'),
  'one row per page of its own tenant, keyed on (tenant_id, page_id), resting on pages_tenant_id_id');
select is(
  (select coalesce(string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', '
                              order by policyname), '')
     from pg_policies where schemaname = 'public' and tablename = 'page_sections'),
  'page_sections_delete_admin DELETE RESTRICTIVE {public}, '
  'page_sections_password_fence SELECT RESTRICTIVE {anon,authenticated}, '
  'page_sections_published_only SELECT RESTRICTIVE {public}, '
  'page_sections_read SELECT PERMISSIVE {public}, '
  'page_sections_write ALL PERMISSIVE {public}',
  'the fence is one more RESTRICTIVE SELECT policy, for anon and every signed-in token');
select is(
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'page_sections'
      and policyname = 'page_sections_password_fence'),
  '((tenant_id = app.effective_tenant_id()) AND (app.is_staff() OR (NOT app.page_is_password_locked(page_id))))',
  'the fence names the tenant first, then lets staff through and holds everyone else to the lock');
select is(
  (select coalesce(string_agg(format('%s %s', f.fn, who.r), ', ' order by f.fn, who.r), '')
     from (values ('public.set_page_password(uuid,uuid,text,jsonb)', 'authenticated'),
                  ('public.page_password_check(uuid,uuid,text)', 'service_role'),
                  ('public.page_sections_unlocked(uuid,uuid)', 'service_role'),
                  ('public.page_media_unlocked(uuid,uuid,uuid[])', 'service_role')) as f(fn, allowed)
     cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as who(r)
    where has_function_privilege(who.r, f.fn::regprocedure, 'execute') <> (who.r = f.allowed)),
  '', 'one API role each: authenticated sets, the service role checks and reads unlocked');
select ok(
  (select bool_and(prosecdef
                   and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                where c in ('search_path=""', 'search_path=')))
     from pg_proc
    where oid in ('public.set_page_password(uuid,uuid,text,jsonb)'::regprocedure,
                  'public.page_password_check(uuid,uuid,text)'::regprocedure,
                  'public.page_sections_unlocked(uuid,uuid)'::regprocedure,
                  'public.page_media_unlocked(uuid,uuid,uuid[])'::regprocedure,
                  'app.page_is_password_locked(uuid)'::regprocedure,
                  'app.tg_page_password_sync()'::regprocedure))
    and not has_function_privilege('anon', 'app.tg_page_password_sync()', 'execute')
    and not has_function_privilege('authenticated', 'app.tg_page_password_sync()', 'execute')
    and not has_function_privilege('service_role', 'app.tg_page_password_sync()', 'execute'),
  'every password function is SECURITY DEFINER with an empty search path; no API role runs the trigger');
select ok(
  has_function_privilege('anon', 'app.page_is_password_locked(uuid)', 'execute')
    and has_function_privilege('authenticated', 'app.page_is_password_locked(uuid)', 'execute')
    and not has_function_privilege('service_role', 'app.page_is_password_locked(uuid)', 'execute'),
  'the fence''s predicate is callable by the roles whose policies use it, and no other');
select is(
  (select string_agg(t.tgname::text, ',' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.page_visibility'::regclass and not t.tgisinternal),
  'page_visibility__release_guard,page_visibility_actor,page_visibility_guard,'
  'page_visibility_password,page_visibility_release_capture,page_visibility_snapshot,'
  'page_visibility_updated_at,page_visibility_version',
  '0057''s six triggers, the password sync (which sorts after the guard) and 0066''s release '
  'guard, which sorts first');
select ok(
  not has_column_privilege('authenticated', 'public.page_visibility', 'note', 'insert')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'note', 'update')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'password_version', 'insert')
    and not has_column_privilege('authenticated', 'public.page_visibility', 'password_version', 'update')
    and has_column_privilege('authenticated', 'public.page_visibility', 'note', 'select'),
  'staff read the message and the version but write neither: set_page_password is the only door');
select ok(
  exists (select 1 from app.release_entities
           where entity_type = 'page_visibility'
             and columns = array['page_id', 'template', 'mode', 'redirect_page_id', 'hide_from',
                                 'show_on', 'note']
             and exempt_columns = array['password_version'])
    and not exists (select 1 from app.release_entities where table_name = 'page_passwords'),
  'a release may carry the message, never the secret or its version');

-- ── 2. setting a password ──────────────────────────────────────────────────────
set local role authenticated;

select _as('61000000-0000-0000-0000-0000000000c1', 'content_creator', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22', null)::text $$),
  '42501', 'content_creator cannot put a page behind a password');
select _as('61000000-0000-0000-0000-0000000000e1', 'seo', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22', null)::text $$),
  '42501', 'seo cannot either');
select _as('61000000-0000-0000-0000-0000000000d2', 'developer', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22', null)::text $$),
  '42501', 'a demoted Developer''s token (profile seo) cannot');
select _as('61000000-0000-0000-0000-0000000000d3', 'developer', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22', null)::text $$),
  '42501', 'nor a deactivated one');
select _as('61000000-0000-0000-0000-0000000000d4', 'developer', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22', null)::text $$),
  '42501', 'nor a locked one');
select _as('61000000-0000-0000-0000-0000000000f1', 'admin', '61000000-0000-0000-0000-0000000000ff');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22', null)::text $$),
  '42501', 'other_tenant: another tenant''s Admin cannot name a page of this one');

select _as('61000000-0000-0000-0000-0000000000a1', 'admin', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a001', 'letmein22', null)::text $$),
  '23514', 'the homepage cannot go behind a password either (use maintenance mode)');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'short7', null)::text $$),
  '22023', 'a password under 8 bytes is refused');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', repeat('x', 73), null)::text $$),
  '22023', 'and one over 72, which bcrypt would silently cut');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22',
                    '{"en":"<b>open sesame</b>"}'::jsonb)::text $$),
  '23514', 'a message holding markup is refused');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22',
                    jsonb_build_object('en', repeat('a', 141)))::text $$),
  '23514', 'and one over 140 characters');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22',
                    '{"fr":"ouvrez"}'::jsonb)::text $$),
  '23514', 'and one in a language the gate does not render');

select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22',
                    '{"en":"Ask the studio for the password.","ar":"اطلب كلمة المرور من الاستوديو."}'::jsonb)
                  ->> 'passwordVersion' $$),
  '1', 'admin puts About behind a password: its first version');
select is(
  (select format('%s %s %s', mode, password_version, note ->> 'en') from public.page_visibility
    where tenant_id = '61000000-0000-0000-0000-000000000001'
      and page_id = '61000000-0000-0000-0000-00000000a002'),
  'password 1 Ask the studio for the password.',
  'the row is in password mode, with the message and the version');
reset role;
select ok(
  (select password_hash ~ '^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$' from public.page_passwords
    where tenant_id = '61000000-0000-0000-0000-000000000001'
      and page_id = '61000000-0000-0000-0000-00000000a002')
    and not exists (select 1 from public.page_passwords where password_hash like '%letmein22%'),
  'the secret is a bcrypt hash, and the password itself is nowhere in the row');
select is(
  (select format('%s %s %s', action, entity_id, detail::text) from public.audit_log
    where action = 'page_visibility.password_set' order by id desc limit 1),
  'page_visibility.password_set 61000000-0000-0000-0000-00000000a002 '
  '{"mode": "password", "note": true, "passwordVersion": 1}',
  'the audit row names the page, the version and that a message was set, and no secret');
select is(
  (select count(*)::int from public.audit_log
    where action = 'page_visibility.password_set' and detail::text like '%letmein22%'),
  0, 'no audit row anywhere holds the password');

set local role authenticated;
select _as('61000000-0000-0000-0000-0000000000d1', 'developer', '61000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'second-password', null)
                  ->> 'passwordVersion' $$),
  '2', 'developer sets a new password: the version moves, so every old cookie stops working');
select is(
  (select format('%s %s', mode, coalesce(note ->> 'en', '(none)')) from public.page_visibility
    where page_id = '61000000-0000-0000-0000-00000000a002'),
  'password (none)', 'the new call replaced the message as well: one call sets both');
select is(_val($$ select password_hash from public.page_passwords
                   where page_id = '61000000-0000-0000-0000-00000000a002' $$),
  '42501', 'a staff token cannot read the hash at all');
select is(_val($$ select public.page_password_check('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'second-password')::text $$),
  '42501', 'nor check a password itself: that is the service role''s, behind the limiter');
select is(_val($$ select type from public.page_sections_unlocked(
                    '61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-00000000a002') $$),
  '42501', 'nor read a locked page''s sections through the unlocked reader');
select is(_val($$ select count(*)::text from public.page_media_unlocked(
                    '61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-00000000a002',
                    array['61000000-0000-4000-8000-000000000001']::uuid[]) $$),
  '42501', 'nor its images through the unlocked media reader');
reset role;

-- ── 3. checking a password (the service role) ─────────────────────────────────
set local role service_role;
select is(_val($$ select public.page_password_check('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'second-password')::text $$),
  '2', 'the right password answers the page''s current version');
select is(_val($$ select public.page_password_check('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', 'letmein22')::text $$),
  '(null)', 'the password it replaced does not');
select is(_val($$ select public.page_password_check('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a003', 'second-password')::text $$),
  '(null)', 'nor the right password on a page that has none');
select is(_val($$ select public.page_password_check('61000000-0000-0000-0000-0000000000ff',
                    '61000000-0000-0000-0000-00000000a002', 'second-password')::text $$),
  '(null)', 'other_tenant: nor the right password under another tenant''s id');
select is(_val($$ select public.page_password_check('61000000-0000-0000-0000-000000000001',
                    '61000000-0000-0000-0000-00000000a002', null)::text $$),
  '(null)', 'nor no password at all');
reset role;

-- ── 4. the fence ───────────────────────────────────────────────────────────────
set local role anon;
select _as(null, 'anon', '61000000-0000-0000-0000-000000000001');
select is(_about_sections(), '', 'anon reads no section of a page behind a password');
select is(
  (select coalesce(string_agg(s.content -> 'body' ->> 'en', ' | '), '') from public.page_sections s
    where s.page_id = '61000000-0000-0000-0000-00000000a003'),
  'open words', 'and every published, visible section of a page that is not');
select is(_val($$ select type from public.page_sections_unlocked(
                    '61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-00000000a002') $$),
  '42501', 'and cannot reach the unlocked reader');
select is(_val($$ select count(*)::text from public.page_media_unlocked(
                    '61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-00000000a002',
                    array['61000000-0000-4000-8000-000000000001']::uuid[]) $$),
  '42501', 'nor the unlocked media reader');
-- Why that reader exists: 0045's media policy asks page_sections under anon's own RLS, the
-- fence included, so a still that only the locked page names is no longer anon's to read.
select is((select count(*)::int from public.media_assets where id = '61000000-0000-4000-8000-000000000001'), 0,
  'the fence takes the locked page''s own images from anon too');
select is(_val($$ select mode from public.page_visibility
                   where page_id = '61000000-0000-0000-0000-00000000a002' $$),
  '42501', 'nor page_visibility, which would list every page that is not public (D3)');
reset role;

set local role authenticated;
select _as('61000000-0000-0000-0000-0000000000c1', 'content_creator', '61000000-0000-0000-0000-000000000001');
select is(_about_sections(), 'secret words | draft words',
  'staff are untouched by the fence: the editor still sees the page it is writing');
select _as('61000000-0000-0000-0000-0000000000e1', 'seo', '61000000-0000-0000-0000-000000000001');
select is(_about_sections(), 'secret words | draft words',
  'so is every staff role, one that writes no content included (seo)');
-- A signed-in role that is not one of the four (the planned Sales role, which app.is_staff()
-- leaves out by design, P-6): page_sections_read is TO public and 0011's fence lets it read
-- what anon reads, so without the fence covering authenticated it would read the page.
select _as('61000000-0000-0000-0000-0000000000b9', 'sales', '61000000-0000-0000-0000-000000000001');
select is(_about_sections(), '',
  'a signed-in token that is not staff reads no section of a page behind a password');
reset role;

-- What a visitor who typed the password gets, against what anon reads once the page is
-- public again: the same rows, in the same order.
set local role service_role;
select is(
  (select string_agg(u.type || ':' || (u.content -> 'body' ->> 'en'), ' | ' order by u.sort_order)
     from public.page_sections_unlocked('61000000-0000-0000-0000-000000000001',
                                        '61000000-0000-0000-0000-00000000a002') u),
  'slogan:secret words',
  'the unlocked reader returns the visible sections of the published page, and no hidden one');
select is(
  (select coalesce(string_agg(format('%s %s %s %s %s', m.id, m.provider, m.storage_path,
                                     m.width, m.alt ->> 'en'), ' | ' order by m.id), '')
     from public.page_media_unlocked('61000000-0000-0000-0000-000000000001',
                                     '61000000-0000-0000-0000-00000000a002',
                                     array['61000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000003']::uuid[]) m),
  '61000000-0000-4000-8000-000000000001 static stills/work/u14b-1.jpg 1280 one',
  'the media reader answers what a visible section of the unlocked page names, and nothing a '
  'hidden section or no section names');
select is(
  (select count(*)::int from public.page_media_unlocked('61000000-0000-0000-0000-000000000001',
                                                       '61000000-0000-0000-0000-00000000a004',
                                                       array['61000000-0000-4000-8000-000000000004']::uuid[])),
  0, 'nothing for a page that is not published');
select is(
  (select count(*)::int from public.page_media_unlocked('61000000-0000-0000-0000-0000000000ff',
                                                       '61000000-0000-0000-0000-00000000a002',
                                                       array['61000000-0000-4000-8000-000000000001']::uuid[])),
  0, 'other_tenant: nothing under another tenant''s id');
reset role;

-- ── 5. leaving password mode ───────────────────────────────────────────────────
set local role authenticated;
select _as('61000000-0000-0000-0000-0000000000a1', 'admin', '61000000-0000-0000-0000-000000000001');
select is(_run($$ update public.page_visibility set mode = 'public'
                   where page_id = '61000000-0000-0000-0000-00000000a002' $$),
  'ok:1', 'admin takes About back out from behind the password');
reset role;
select is(
  (select count(*)::int from public.page_passwords
    where page_id = '61000000-0000-0000-0000-00000000a002'),
  0, 'the secret is deleted with the mode: nothing is kept to be leaked later');
select is(
  (select format('%s %s %s', mode, password_version, coalesce(note::text, '(none)'))
     from public.page_visibility where page_id = '61000000-0000-0000-0000-00000000a002'),
  'public 3 (none)',
  'the message is cleared and the version moves again, so no cookie outlives the mode');

set local role anon;
select _as(null, 'anon', '61000000-0000-0000-0000-000000000001');
select is(_about_sections(), 'secret words',
  'anon reads the page again, exactly what the unlocked reader returned while it was locked');
reset role;

-- Nobody puts a page behind a password without one: not a staff token, not the service role,
-- not the migration role.
set local role authenticated;
select _as('61000000-0000-0000-0000-0000000000a1', 'admin', '61000000-0000-0000-0000-000000000001');
select is(_run($$ update public.page_visibility set mode = 'password'
                   where page_id = '61000000-0000-0000-0000-00000000a002' $$),
  '23514', 'a staff token that names the mode directly is refused: no secret, no password mode');
reset role;
set local role service_role;
select is(_run($$ update public.page_visibility set mode = 'password'
                   where page_id = '61000000-0000-0000-0000-00000000a002' $$),
  '23514', 'the service role is refused by the guard: no secret, no password mode');
reset role;
select throws_ok(
  $$ insert into public.page_visibility (tenant_id, page_id, mode, password_version)
     values ('61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-00000000a003',
             'password', 1) $$,
  '23514', null, 'and so is the migration role, on an insert');
select throws_ok(
  $$ insert into public.page_visibility (tenant_id, template, mode, password_version)
     values ('61000000-0000-0000-0000-000000000001', 'service', 'password', 1) $$,
  '23514', null, 'a template takes public or hidden only, never a password (decision D1)');

select * from finish();
rollback;
