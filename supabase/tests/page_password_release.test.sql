-- pgTAP: page passwords in release mode (Admin v2 R14e, owner item B1 option b). Run with
-- `supabase test db`. page_password.test.sql holds 0061's door with releases off; this file is
-- about what R14e adds:
--   1. the catalog: public.store_page_password and public.page_password_stored are definers
--      with an empty search_path, executable by authenticated alone (both grant regimes);
--   2. who may store a password: Admin and Developer, live (H16), in their profile's tenant,
--      with releases on; content_creator, seo, sales, anon, another tenant's admin and the three
--      stale Developer tokens (demoted, switched off, locked) are refused, and releases off the
--      function refuses everyone (the door keeps calling set_page_password then);
--   3. a stored hash is inert until a release publishes the mode: page_password_check admits no
--      one to a page whose live mode is not password; a hash a discarded change left behind
--      cannot be reached by a direct write with releases off (only a release enters the mode
--      without moving the version); a page already behind a password takes the new one at once
--      (its version moves, the old one stops);
--   4. a publish through apply_release puts the page behind the stored password (the entry moves
--      the version), a note-only change of a page already behind one publishes the message alone,
--      and a staged password mode with no stored hash is refused by the dry run;
--   5. the password is in no table a release, a version, an audit row or a log keeps, nor is
--      its hash.

begin;
select plan(57);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('14e00000-0000-4000-8000-000000000001', 'R14e-T1'),
  ('14e00000-0000-4000-8000-0000000000ff', 'R14e-T2');

-- Personas: code, user id, the token's role, the token's tenant, the profile's role, active,
-- locked. N (anon) has no profile.
create table r14e_persona (
  code text primary key, sub uuid, claim_role text, claim_tenant uuid,
  profile_role text, active boolean, locked boolean);
insert into r14e_persona values
  ('A',  '14e00000-0000-4000-8000-0000000000a1', 'admin',           '14e00000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  '14e00000-0000-4000-8000-0000000000c1', 'content_creator', '14e00000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  '14e00000-0000-4000-8000-0000000000e1', 'seo',             '14e00000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  '14e00000-0000-4000-8000-0000000000d1', 'developer',       '14e00000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  '14e00000-0000-4000-8000-000000000051', 'sales',           '14e00000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  '14e00000-0000-4000-8000-0000000000f1', 'admin',           '14e00000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('N',  null,                                   null,              null,                                   null,              null,  null),
  -- Stale: each token says developer; the profile no longer agrees.
  ('Dd', '14e00000-0000-4000-8000-0000000000d2', 'developer',       '14e00000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('Do', '14e00000-0000-4000-8000-0000000000d3', 'developer',       '14e00000-0000-4000-8000-000000000001', 'developer',       false, false),
  ('Dl', '14e00000-0000-4000-8000-0000000000d4', 'developer',       '14e00000-0000-4000-8000-000000000001', 'developer',       true,  true);
insert into auth.users (id, email)
  select sub, 'r14e-' || lower(code) || '@example.test' from r14e_persona where sub is not null;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'R14e ' || code
    from r14e_persona where sub is not null;

-- Pages of T1: home; about (no setting: public); contact (live behind a password); join (live
-- hidden, never a password); faq and blog (no setting, for the dry run and the discard).
insert into public.pages (id, tenant_id, slug, title, status) values
  ('14e00000-0000-4000-8000-00000000a001', '14e00000-0000-4000-8000-000000000001', 'home', '{"en":"Home","ar":"الرئيسية"}', 'published'),
  ('14e00000-0000-4000-8000-00000000a002', '14e00000-0000-4000-8000-000000000001', 'about', '{"en":"About","ar":"من نحن"}', 'published'),
  ('14e00000-0000-4000-8000-00000000a003', '14e00000-0000-4000-8000-000000000001', 'contact', '{"en":"Contact","ar":"تواصل"}', 'published'),
  ('14e00000-0000-4000-8000-00000000a004', '14e00000-0000-4000-8000-000000000001', 'join', '{"en":"Join","ar":"انضم"}', 'published'),
  ('14e00000-0000-4000-8000-00000000a005', '14e00000-0000-4000-8000-000000000001', 'faq', '{"en":"FAQ","ar":"أسئلة"}', 'published'),
  ('14e00000-0000-4000-8000-00000000a006', '14e00000-0000-4000-8000-000000000001', 'blog', '{"en":"Blog","ar":"مدونة"}', 'published');
-- Contact behind a password before releases are on (the migration role: the guard lets it).
insert into public.page_passwords (tenant_id, page_id, password_hash)
values ('14e00000-0000-4000-8000-000000000001', '14e00000-0000-4000-8000-00000000a003',
        extensions.crypt('r14e-old-contact', extensions.gen_salt('bf', 10)));
insert into public.page_visibility (id, tenant_id, page_id, mode, note, password_version) values
  ('14e00000-0000-4000-8000-0000000c0003', '14e00000-0000-4000-8000-000000000001',
   '14e00000-0000-4000-8000-00000000a003', 'password', '{"en":"Ask the studio"}', 4),
  ('14e00000-0000-4000-8000-0000000c0004', '14e00000-0000-4000-8000-000000000001',
   '14e00000-0000-4000-8000-00000000a004', 'hidden', null, 0);

create function r14e_as(p_code text) returns void language plpgsql as $$
declare
  p r14e_persona;
begin
  select * into p from r14e_persona where code = p_code;
  perform set_config('request.jwt.claims',
    case when p.sub is null then ''
         else jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text end,
    true);
  if p.sub is null then
    execute 'set local role anon';
  else
    execute 'set local role authenticated';
  end if;
end $$;

-- A statement as the CURRENT role: its value as text, '(null)', or the SQLSTATE it raised.
create function r14e_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;

-- One persona's answer to a statement, the role and claims put back afterwards.
create function r14e_by(p_code text, p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  perform r14e_as(p_code);
  v := r14e_val(p_sql);
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- page_password_check as the service role (its only caller, the unlock route).
create function r14e_check(p_page uuid, p_password text) returns text language plpgsql as $$
declare
  v text;
begin
  execute 'set local role service_role';
  v := coalesce(public.page_password_check('14e00000-0000-4000-8000-000000000001', p_page, p_password)::text, '(null)');
  execute 'reset role';
  return v;
end $$;

grant select on r14e_persona to anon, authenticated, service_role;
grant execute on function r14e_as(text), r14e_val(text), r14e_by(text, text), r14e_check(uuid, text)
  to anon, authenticated, service_role;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc
            where oid = 'public.store_page_password(uuid, text)'::regprocedure),
  'store_page_password is a definer with an empty search_path');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc
            where oid = 'public.page_password_stored(uuid)'::regprocedure),
  'page_password_stored is a definer with an empty search_path');
select is(array[has_function_privilege('authenticated', 'public.store_page_password(uuid, text)', 'execute'),
                has_function_privilege('anon', 'public.store_page_password(uuid, text)', 'execute'),
                has_function_privilege('service_role', 'public.store_page_password(uuid, text)', 'execute')],
  array[true, false, false], 'store_page_password: authenticated alone may execute it');
select is(array[has_function_privilege('authenticated', 'public.page_password_stored(uuid)', 'execute'),
                has_function_privilege('anon', 'public.page_password_stored(uuid)', 'execute'),
                has_function_privilege('service_role', 'public.page_password_stored(uuid)', 'execute')],
  array[true, false, false], 'page_password_stored: authenticated alone may execute it');
select is((select count(*)::int from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.oid in ('public.store_page_password(uuid, text)'::regprocedure,
                            'public.page_password_stored(uuid)'::regprocedure)
              and a.grantee = 0),
  0, 'neither is executable by PUBLIC (the default privilege revoked)');
select is(array[has_function_privilege('authenticated', 'app.in_release_write()', 'execute'),
                has_function_privilege('anon', 'app.in_release_write()', 'execute'),
                has_function_privilege('service_role', 'app.in_release_write()', 'execute')],
  array[true, false, false], 'app.in_release_write (the message guard''s question): authenticated alone');
select ok(not exists (select 1 from app.release_entities where table_name = 'page_passwords'),
  'page_passwords is never a registry table: no release carries the secret');

-- ── 2. releases off: refused for everyone ────────────────────────────────────────
select is(r14e_by('A', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '55000', 'releases off: even an Admin is refused (the door calls set_page_password then)');
select is((select count(*)::int from public.page_passwords where page_id = '14e00000-0000-4000-8000-00000000a002'),
  0, 'and nothing was stored');
-- The message: a release writes it as the publisher, so authenticated holds the column; outside a
-- release no API token writes it (the guard answers what the missing privilege used to).
select ok(has_column_privilege('authenticated', 'public.page_visibility', 'note', 'update')
          and has_column_privilege('authenticated', 'public.page_visibility', 'note', 'insert')
          and not has_column_privilege('authenticated', 'public.page_visibility', 'password_version', 'update'),
  'authenticated may write the message (inside a release) and never the password version');
select is(r14e_by('A', $$ with u as (update public.page_visibility set note = '{"en":"Changed"}'
                                    where id = '14e00000-0000-4000-8000-0000000c0003' returning 1)
                         select count(*)::text from u $$),
  '42501', 'releases off: an Admin''s direct write of the message is refused, as before');
select is((select note ->> 'en' from public.page_visibility where id = '14e00000-0000-4000-8000-0000000c0003'),
  'Ask the studio', 'and the message is as it was');
-- The INSERT (note) grant's side of the guard: a new row carrying a message (R14e review).
select is(r14e_by('A', $$ with i as (insert into public.page_visibility (tenant_id, page_id, mode, note)
                                    values ('14e00000-0000-4000-8000-000000000001',
                                            '14e00000-0000-4000-8000-00000000a005', 'hidden', '{"en":"Hi"}')
                                    returning 1)
                         select count(*)::text from i $$),
  '42501', 'releases off: an Admin''s direct insert carrying a message is refused (the guard''s insert branch)');
select is(r14e_by('C', $$ with i as (insert into public.page_visibility (tenant_id, page_id, mode, note)
                                    values ('14e00000-0000-4000-8000-000000000001',
                                            '14e00000-0000-4000-8000-00000000a005', 'hidden', '{"en":"Hi"}')
                                    returning 1)
                         select count(*)::text from i $$),
  '42501', 'and a content_creator''s too');

insert into app.release_tenants (tenant_id) values
  ('14e00000-0000-4000-8000-000000000001'), ('14e00000-0000-4000-8000-0000000000ff');

-- ── 3. who may store a password (releases on) ────────────────────────────────────
select is(r14e_by('C', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'content_creator is refused');
select is(r14e_by('S', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'seo is refused');
select is(r14e_by('L', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'sales is refused');
select is(r14e_by('N', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'anon is refused (no EXECUTE)');
select is(r14e_by('Dd', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'a stale token (demoted to seo, still claiming developer) is refused');
select is(r14e_by('Do', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'a stale token (switched off) is refused');
select is(r14e_by('Dl', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  '42501', 'a stale token (locked) is refused');
select is(r14e_by('O', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1') $$),
  'P0002', 'another tenant''s Admin cannot reach this tenant''s page (its own tenant, from its profile: no such page)');
select is((select count(*)::int from public.page_passwords where page_id = '14e00000-0000-4000-8000-00000000a002'),
  0, 'no refused caller stored anything');
select is(r14e_by('A', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a001', 'r14e-secret-1') $$),
  '23514', 'the homepage is refused');
select is(r14e_by('A', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'short') $$),
  '22023', 'a password under 8 bytes is refused');
select is(r14e_by('A', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', repeat('x', 73)) $$),
  '22023', 'a password over 72 bytes is refused');

select is(r14e_by('A', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1')::text $$),
  '{"live": false, "passwordVersion": null}', 'an Admin stores About''s password; About asks for none live');
select is(r14e_by('D', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1')::text $$),
  '{"live": false, "passwordVersion": null}', 'a Developer may too');

-- ── 4. the stored hash is inert until a release publishes the mode ───────────────────
select is((select count(*)::int from public.page_passwords where page_id = '14e00000-0000-4000-8000-00000000a002'),
  1, 'About has one stored hash');
select ok(not exists (select 1 from public.page_visibility where page_id = '14e00000-0000-4000-8000-00000000a002'),
  'and still no setting: it is visible to everyone');
select is(r14e_check('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1'), '(null)',
  'page_password_check admits no one with the right password: About is not behind one live');
select is(r14e_by('A', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$),
  'true', 'page_password_stored: an Admin reads that a password is stored');
select is(r14e_by('D', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a005')::text $$),
  'false', 'and a Developer that FAQ has none');
select is(r14e_by('O', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$),
  'false', 'another tenant''s Admin reads nothing of this tenant''s pages');
select is(r14e_by('C', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$)
          || r14e_by('S', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$)
          || r14e_by('L', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$)
          || r14e_by('N', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$)
          || r14e_by('Dd', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$)
          || r14e_by('Do', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$)
          || r14e_by('Dl', $$ select public.page_password_stored('14e00000-0000-4000-8000-00000000a002')::text $$),
  '42501425014250142501425014250142501',
  'page_password_stored refuses content_creator, seo, sales, anon and the three stale tokens');

-- Join is hidden live: storing a password moves nothing of its row.
select is(r14e_by('A', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a004', 'r14e-secret-3')::text $$),
  '{"live": false, "passwordVersion": null}', 'Join (hidden live) stores a password');
select is((select format('%s %s %s', mode, password_version, version) from public.page_visibility
            where page_id = '14e00000-0000-4000-8000-00000000a004'),
  'hidden 0 1', 'Join''s live row is untouched: hidden, its version and its password version as they were');
-- A pending change to password mode, then discarded: the hash stays inert.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, base, base_version, fields)
values ('14e00000-0000-4000-8000-0000000dd004', '14e00000-0000-4000-8000-000000000001', 'page_visibility',
        '14e00000-0000-4000-8000-0000000c0004', 'update',
        '{"target":{"pageId":"14e00000-0000-4000-8000-00000000a004"},"mode":"password","note":{"en":"Soon"},"redirectPageId":null,"hideFrom":null,"showOn":null}',
        '{"mode":"hidden","note":null}', 1, '{mode,note}');
delete from public.content_drafts where id = '14e00000-0000-4000-8000-0000000dd004';
-- The hash the discarded change left behind (R14e review): with releases off again, an Admin's
-- direct write of the mode (it holds UPDATE (mode), never the version) must not put Join behind
-- it. Before R14e a hash existed only while its page was in password mode, so the sync's
-- existence check was the fence; now only a release may enter the mode without moving the version.
delete from app.release_tenants where tenant_id = '14e00000-0000-4000-8000-000000000001';
select is(r14e_by('A', $$ with u as (update public.page_visibility set mode = 'password'
                                    where page_id = '14e00000-0000-4000-8000-00000000a004' returning 1)
                         select count(*)::text from u $$),
  '23514', 'releases off: an Admin''s direct write cannot put a page behind a leftover password');
select is((select format('%s %s', mode, password_version) from public.page_visibility
            where page_id = '14e00000-0000-4000-8000-00000000a004')
          || ' ' || r14e_check('14e00000-0000-4000-8000-00000000a004', 'r14e-secret-3'),
  'hidden 0 (null)', 'Join stays hidden and its hash inert: it admits no one');
insert into app.release_tenants (tenant_id) values ('14e00000-0000-4000-8000-000000000001');

-- Contact asks for a password live: the new one works at once, the old one stops.
select is(r14e_by('D', $$ select public.store_page_password('14e00000-0000-4000-8000-00000000a003', 'r14e-secret-2')::text $$),
  '{"live": true, "passwordVersion": 5}', 'Contact (behind a password live) takes the new one at once, version 4 to 5');
select is((select format('%s %s %s', mode, note ->> 'en', password_version) from public.page_visibility
            where page_id = '14e00000-0000-4000-8000-00000000a003'),
  'password Ask the studio 5', 'only the exempt version moved: the mode and the message are as they were');
select is(r14e_check('14e00000-0000-4000-8000-00000000a003', 'r14e-secret-2'), '5',
  'the new password opens Contact at the new version');
select is(r14e_check('14e00000-0000-4000-8000-00000000a003', 'r14e-old-contact'), '(null)',
  'and the old one no longer does');
select is((select count(*)::int from public.content_release_items
            where entity_id = '14e00000-0000-4000-8000-0000000c0003'),
  0, 'an exempt-only change is not a system item (the capture skips it)');

-- ── 5. a release publishes the mode ─────────────────────────────────────────────
-- About: a pending create in password mode, as the door stages it, published by the Admin.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, base, base_version, fields)
values ('14e00000-0000-4000-8000-0000000dd002', '14e00000-0000-4000-8000-000000000001', 'page_visibility',
        '14e00000-0000-4000-8000-0000000c0002', 'create',
        '{"target":{"pageId":"14e00000-0000-4000-8000-00000000a002"},"mode":"password","note":{"en":"Ask us"},"redirectPageId":null,"hideFrom":null,"showOn":null}',
        '{}', null, '{mode,note,page_id}'),
       ('14e00000-0000-4000-8000-0000000dd005', '14e00000-0000-4000-8000-000000000001', 'page_visibility',
        '14e00000-0000-4000-8000-0000000c0005', 'create',
        '{"target":{"pageId":"14e00000-0000-4000-8000-00000000a005"},"mode":"password","note":null,"redirectPageId":null,"hideFrom":null,"showOn":null}',
        '{}', null, '{mode,page_id}');
create table r14e_out (k text primary key, result jsonb);
grant insert, select on r14e_out to service_role;

-- FAQ has no stored hash: the dry run refuses the change, and nothing is applied.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into r14e_out (k, result)
select 'dry', public.apply_release('14e00000-0000-4000-8000-0000000000a1'::uuid, 'admin', 'dry_run',
         jsonb_build_array(jsonb_build_object(
           'draft_id', '14e00000-0000-4000-8000-0000000dd005', 'draft_version', 1,
           'entity_type', 'page_visibility', 'entity_id', '14e00000-0000-4000-8000-0000000c0005',
           'op', 'create',
           'patch', '{"page_id":"14e00000-0000-4000-8000-00000000a005","template":null,"mode":"password","note":null,"redirect_page_id":null,"hide_from":null,"show_on":null}'::jsonb,
           'base', '{}'::jsonb)));
reset role;
select set_config('request.jwt.claims', '', true);
select is((select format('%s %s', result ->> 'ok', result #>> '{errors,0,constraint}') from r14e_out where k = 'dry'),
  'false page_visibility_password_required',
  'a staged password mode with no stored hash is refused by the dry run, naming the rule');
select ok(not exists (select 1 from public.page_visibility where page_id = '14e00000-0000-4000-8000-00000000a005'),
  'and FAQ is as it was');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into r14e_out (k, result)
select 'publish', public.apply_release('14e00000-0000-4000-8000-0000000000a1'::uuid, 'admin', 'publish',
         jsonb_build_array(jsonb_build_object(
           'draft_id', '14e00000-0000-4000-8000-0000000dd002', 'draft_version', 1,
           'entity_type', 'page_visibility', 'entity_id', '14e00000-0000-4000-8000-0000000c0002',
           'op', 'create',
           'patch', '{"page_id":"14e00000-0000-4000-8000-00000000a002","template":null,"mode":"password","note":{"en":"Ask us"},"redirect_page_id":null,"hide_from":null,"show_on":null}'::jsonb,
           'base', '{}'::jsonb)));
reset role;
select set_config('request.jwt.claims', '', true);
select ok((select (result ->> 'number') is not null from r14e_out where k = 'publish'),
  'the Admin publishes About''s password change');
select is((select format('%s %s %s', mode, note ->> 'en', password_version) from public.page_visibility
            where page_id = '14e00000-0000-4000-8000-00000000a002'),
  'password Ask us 1', 'About is behind a password live, with its message; entering the mode moved the version to 1');
select is(r14e_check('14e00000-0000-4000-8000-00000000a002', 'r14e-secret-1'), '1',
  'the stored password now opens About');
select is(r14e_check('14e00000-0000-4000-8000-00000000a002', 'r14e-wrong-one'), '(null)',
  'and a wrong one does not');

-- Contact, already behind a password live: the door's other staged shape, a note-only update,
-- published (R14e review). It runs the UPDATE (note) grant and the guard's update branch inside
-- a release; the password and its version stay as they are.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, base, base_version, fields)
select '14e00000-0000-4000-8000-0000000dd003', '14e00000-0000-4000-8000-000000000001', 'page_visibility',
       '14e00000-0000-4000-8000-0000000c0003', 'update',
       '{"target":{"pageId":"14e00000-0000-4000-8000-00000000a003"},"mode":"password","note":{"en":"Ask the studio first"},"redirectPageId":null,"hideFrom":null,"showOn":null}',
       '{"note":{"en":"Ask the studio"}}', v.version, '{note}'
  from public.page_visibility v where v.id = '14e00000-0000-4000-8000-0000000c0003';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into r14e_out (k, result)
select 'note', public.apply_release('14e00000-0000-4000-8000-0000000000a1'::uuid, 'admin', 'publish',
         jsonb_build_array(jsonb_build_object(
           'draft_id', '14e00000-0000-4000-8000-0000000dd003', 'draft_version', 1,
           'entity_type', 'page_visibility', 'entity_id', '14e00000-0000-4000-8000-0000000c0003',
           'op', 'update',
           'patch', '{"note":{"en":"Ask the studio first"}}'::jsonb,
           'base', '{"note":{"en":"Ask the studio"}}'::jsonb)));
reset role;
select set_config('request.jwt.claims', '', true);
select ok((select (result ->> 'number') is not null from r14e_out where k = 'note'),
  'the Admin publishes Contact''s new message');
select is((select format('%s %s %s', mode, note ->> 'en', password_version) from public.page_visibility
            where page_id = '14e00000-0000-4000-8000-00000000a003'),
  'password Ask the studio first 5', 'the message changed; the mode and the password version did not');
select is(r14e_check('14e00000-0000-4000-8000-00000000a003', 'r14e-secret-2'), '5',
  'and the current password still opens Contact');

-- ── 6. the secret, and its hash, are nowhere a release, a version, an audit row or a log keeps
select is((select count(*)::int from public.audit_log
            where tenant_id = '14e00000-0000-4000-8000-000000000001'
              and action = 'page_visibility.password_stored'),
  4, 'each stored password wrote its audit row (About twice, Join, Contact)');
select is((select string_agg(distinct pg_catalog.array_to_string(array(select jsonb_object_keys(detail) order by 1), ','), ' ')
             from public.audit_log
            where tenant_id = '14e00000-0000-4000-8000-000000000001'
              and action = 'page_visibility.password_stored'),
  'live,passwordVersion', 'and each names only whether the live gate changed and its version');
select is((select count(*)::int
             from (select to_jsonb(d)::text as t from public.content_drafts d
                   union all select to_jsonb(v)::text from public.content_versions v
                   union all select to_jsonb(i)::text from public.content_release_items i
                   union all select to_jsonb(r)::text from public.content_releases r
                   union all select to_jsonb(a)::text from public.audit_log a
                   union all select to_jsonb(s)::text from public.system_logs s
                   union all select to_jsonb(pv)::text from public.page_visibility pv) x
            where x.t like '%r14e-secret-%' or x.t like '%r14e-old-contact%'),
  0, 'no password is in a draft, a version, a release, an audit row, a log or a setting');
select is((select count(*)::int
             from (select to_jsonb(d)::text as t from public.content_drafts d
                   union all select to_jsonb(v)::text from public.content_versions v
                   union all select to_jsonb(i)::text from public.content_release_items i
                   union all select to_jsonb(a)::text from public.audit_log a
                   union all select to_jsonb(s)::text from public.system_logs s
                   union all select to_jsonb(pv)::text from public.page_visibility pv) x,
                  public.page_passwords pw
            where pw.tenant_id = '14e00000-0000-4000-8000-000000000001'
              and position(pw.password_hash in x.t) > 0),
  0, 'nor is any stored hash');

select * from finish();
rollback;
