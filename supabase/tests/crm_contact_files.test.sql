-- pgTAP: CRM contact files (0140, Admin v2 C16, crm.md §12 "Files"). Run with `supabase test db`.
--
-- crm.files is Admin's alone (Developer none, owner default O-7; Sales none). Personas, each a
-- token as PostgREST carries it: A admin, A2 a second admin, C content_creator, S seo,
-- D developer, L sales, O another tenant's admin, N anon; stale Admin tokens Ad (the profile
-- now says content_creator), Ao (switched off), Al (locked). Proven here:
--   1. reads: only a live Admin of the tenant reads the tenant's files, and never a file's
--      object path; every other principal and every stale token reads none; anon holds nothing;
--   2. no API role writes the table: the service role's doors add and remove, each checking
--      the acting profile live (every refused actor named), the contact (its tenant, not a
--      tombstone), the path (this tenant and contact), the keys, and the ceiling of 20;
--   3. the rules: the CHECKs (the path's shape and tenant, the type and its extension, the
--      name, the size); a file added is the contact's activity; removal answers the path;
--      the rows go with their contact; an auto-contact with a file is not an orphan;
--   4. grants (P-14) and the helper's parity for every role.
-- The bucket and the orphan reader: storage_crm_files.test.sql.

begin;
select plan(58);

insert into public.tenants (id, name) values
  ('c1600000-0000-4000-8000-000000000001', 'C16 T1'),
  ('c1600000-0000-4000-8000-0000000000ff', 'C16 T2');

create table c16_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                          profile_role text, active boolean, locked boolean);
insert into c16_persona values
  ('A',  'c1600000-0000-4000-8000-0000000000a1', 'admin',           'c1600000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('A2', 'c1600000-0000-4000-8000-0000000000a5', 'admin',           'c1600000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c1600000-0000-4000-8000-0000000000c1', 'content_creator', 'c1600000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c1600000-0000-4000-8000-0000000000e1', 'seo',             'c1600000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c1600000-0000-4000-8000-0000000000d1', 'developer',       'c1600000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c1600000-0000-4000-8000-000000000051', 'sales',           'c1600000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c1600000-0000-4000-8000-0000000000f1', 'admin',           'c1600000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c1600000-0000-4000-8000-0000000000a2', 'admin',           'c1600000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c1600000-0000-4000-8000-0000000000a3', 'admin',           'c1600000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c1600000-0000-4000-8000-0000000000a4', 'admin',           'c1600000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c16-' || lower(code) || '@example.test' from c16_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C16 ' || code
    from c16_persona;

-- Contacts: one a person made (T1), an auto-contact (T1, created_by null), a tombstone (T1),
-- another tenant's (T2). Activity in the past, so a file's activity shows.
insert into public.crm_contacts (id, tenant_id, display_name, created_by, last_activity_at) values
  ('c1600000-0000-4000-8000-00000000c001', 'c1600000-0000-4000-8000-000000000001', 'Huda Saleh',
   'c1600000-0000-4000-8000-0000000000a1', now() - interval '3 days'),
  ('c1600000-0000-4000-8000-00000000c003', 'c1600000-0000-4000-8000-000000000001', 'Auto Made',
   null, now() - interval '3 days'),
  ('c1600000-0000-4000-8000-00000000c002', 'c1600000-0000-4000-8000-000000000001', 'Merged Away',
   'c1600000-0000-4000-8000-0000000000a1', now()),
  ('c1600000-0000-4000-8000-00000000c0ff', 'c1600000-0000-4000-8000-0000000000ff', 'Other Person',
   null, now());
update public.crm_contacts set merged_into = 'c1600000-0000-4000-8000-00000000c001', merged_at = now()
 where id = 'c1600000-0000-4000-8000-00000000c002';
update public.crm_contacts set last_activity_at = now() - interval '3 days'
 where id in ('c1600000-0000-4000-8000-00000000c001', 'c1600000-0000-4000-8000-00000000c003');

-- One file in T2, as the migration role, for the cross-tenant reads.
insert into public.crm_contact_files (id, tenant_id, contact_id, object_path, name, content_type, bytes) values
  ('c1600000-0000-4000-8000-0000000f00ff', 'c1600000-0000-4000-8000-0000000000ff',
   'c1600000-0000-4000-8000-00000000c0ff',
   'c1600000-0000-4000-8000-0000000000ff/c1600000-0000-4000-8000-00000000c0ff/c1600000-0000-4000-8000-0000000fffff.pdf',
   'Theirs.pdf', 'application/pdf', 100);

create function c16_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c16_persona p where p.code = p_code), ''), true)
$$;
-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function c16_run(p_sql text) returns text language plpgsql as $$
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
create function c16_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- A file body for the add door: the path names T1 and the contact unless told otherwise.
create function c16_file(p_id text, p_contact text default 'c1600000-0000-4000-8000-00000000c001',
                         p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
           'id', p_id,
           'object_path', 'c1600000-0000-4000-8000-000000000001/' || p_contact || '/' || p_id || '.pdf',
           'name', 'Brief.pdf', 'content_type', 'application/pdf', 'bytes', 2048) || p_extra
$$;
-- The add door as a persona's actor (the service role calls it; the actor is checked live).
create function c16_add(p_actor text, p_file jsonb,
                        p_contact text default 'c1600000-0000-4000-8000-00000000c001',
                        p_tenant text default 'c1600000-0000-4000-8000-000000000001') returns text
  language plpgsql as $$
begin
  return (public.crm_file_add(p_tenant::uuid, p_contact::uuid, p_file,
                              (select sub from c16_persona where code = p_actor))) ->> 'name';
exception when others then
  return sqlstate;
end $$;
create function c16_remove(p_actor text, p_file text,
                           p_contact text default 'c1600000-0000-4000-8000-00000000c001') returns text
  language plpgsql as $$
begin
  return public.crm_file_remove('c1600000-0000-4000-8000-000000000001', p_contact::uuid, p_file::uuid,
                                (select sub from c16_persona where code = p_actor));
exception when others then
  return sqlstate;
end $$;
grant execute on function c16_as(text), c16_run(text), c16_val(text) to anon, authenticated;
grant execute on function c16_file(text, text, jsonb), c16_add(text, jsonb, text, text),
                          c16_remove(text, text, text) to anon, authenticated, service_role;
grant select on c16_persona to anon, authenticated, service_role;
create temp table c16_out (who text, res text);
grant insert, select, delete on c16_out to authenticated, anon, service_role;

-- ── 1. The add door, as the service role ──────────────────────────────────────────────────
set local role service_role;
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0001')), 'Brief.pdf',
  'the service role adds a file for a live Admin');
select is(c16_add('A2', c16_file('c1600000-0000-4000-8000-0000000f0002', p_extra => jsonb_build_object(
            'name', 'Logo.png', 'content_type', 'image/png',
            'object_path', 'c1600000-0000-4000-8000-000000000001/c1600000-0000-4000-8000-00000000c001/c1600000-0000-4000-8000-0000000f0002.png'))),
  'Logo.png', 'and for a second live Admin');
insert into c16_out
  select p.code, c16_add(p.code, c16_file(gen_random_uuid()::text))
    from c16_persona p where p.code in ('C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al');
select is((select string_agg(who || ':' || res, ' ' order by who collate "C") from c16_out),
  'Ad:42501 Al:42501 Ao:42501 C:42501 D:42501 L:42501 O:42501 S:42501',
  'every other actor is refused by the door: no files role, another tenant, demoted, switched off, locked');
delete from c16_out;
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0003', 'c1600000-0000-4000-8000-00000000c002'),
                  'c1600000-0000-4000-8000-00000000c002'),
  'P0002', 'a merge tombstone takes no file');
select is(c16_add('A', jsonb_build_object(
            'id', 'c1600000-0000-4000-8000-0000000f0004',
            'object_path', 'c1600000-0000-4000-8000-000000000001/c1600000-0000-4000-8000-00000000c0ff/c1600000-0000-4000-8000-0000000f0004.pdf',
            'name', 'x.pdf', 'content_type', 'application/pdf', 'bytes', 1),
                  'c1600000-0000-4000-8000-00000000c0ff'),
  'P0002', 'another tenant''s contact is no contact here');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0005', 'c1600000-0000-4000-8000-00000000c003')),
  '22023', 'the path must name the contact the file is for');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0006') || '{"created_by": null}'::jsonb),
  '22023', 'an unknown key is refused');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0007', p_extra => '{"name": "a/b.pdf"}'::jsonb)),
  '23514', 'a name with a slash is refused');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0008', p_extra => '{"content_type": "image/png"}'::jsonb)),
  '23514', 'a type that does not match the extension is refused');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0009', p_extra => '{"bytes": 10485761}'::jsonb)),
  '23514', 'a file over 10 MiB is refused');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f000a', p_extra => '{"content_type": "image/svg+xml"}'::jsonb)),
  '23514', 'a type outside the five is refused');
reset role;

select is((select created_by::text || ' ' || name from public.crm_contact_files
            where id = 'c1600000-0000-4000-8000-0000000f0001'),
  'c1600000-0000-4000-8000-0000000000a1 Brief.pdf', 'the file is the actor''s, under the name given');
select ok((select last_activity_at > now() - interval '1 minute' from public.crm_contacts
            where id = 'c1600000-0000-4000-8000-00000000c001'),
  'a file added is the contact''s activity');
select is(c16_run($$ insert into public.crm_contact_files (tenant_id, contact_id, object_path, name, content_type, bytes)
            values ('c1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-00000000c001',
                    'c1600000-0000-4000-8000-0000000000ff/c1600000-0000-4000-8000-00000000c001/c1600000-0000-4000-8000-0000000f00aa.pdf',
                    'x.pdf', 'application/pdf', 1) $$),
  '23514', 'a path under another tenant is refused (the tenant prefix)');
select is(c16_run($$ insert into public.crm_contact_files (tenant_id, contact_id, object_path, name, content_type, bytes)
            values ('c1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-00000000c001',
                    'c1600000-0000-4000-8000-000000000001/Huda Saleh passport.pdf',
                    'x.pdf', 'application/pdf', 1) $$),
  '23514', 'a path that carries a name, not the Worker''s shape, is refused');
select is(c16_run($$ insert into public.crm_contact_files (tenant_id, contact_id, object_path, name, content_type, bytes)
            values ('c1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-00000000c0ff',
                    'c1600000-0000-4000-8000-000000000001/c1600000-0000-4000-8000-00000000c0ff/c1600000-0000-4000-8000-0000000f00ab.pdf',
                    'x.pdf', 'application/pdf', 1) $$),
  '23503', 'a row cannot name another tenant''s contact (the composite key)');

-- ── 2. Reads ──────────────────────────────────────────────────────────────────────────────
set local role authenticated;
select c16_as('A');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '2',
  'a live Admin reads the tenant''s files, and only them');
select is(c16_val($$ select string_agg(name, ',' order by name) from public.crm_contact_files $$),
  'Brief.pdf,Logo.png', 'their names');
select is(c16_val($$ select object_path from public.crm_contact_files limit 1 $$), '42501',
  'never a file''s object path (the column grant)');
select is(c16_val($$ select count(*) from public.crm_contact_files where tenant_id = 'c1600000-0000-4000-8000-0000000000ff' $$), '0',
  'and never another tenant''s, even when asked');
select c16_as('O');
select is(c16_val($$ select string_agg(name, ',') from public.crm_contact_files $$), 'Theirs.pdf',
  'another tenant''s Admin reads its own tenant''s file only');
select c16_as('C');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0', 'Content Creator reads no file');
select c16_as('S');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0', 'SEO reads no file');
select c16_as('D');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0', 'Developer reads no file');
select c16_as('L');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0', 'Sales reads no file');
select c16_as('Ad');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0',
  'a demoted Admin''s old token reads no file (the live check)');
select c16_as('Ao');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0',
  'a switched-off Admin''s token reads no file');
select c16_as('Al');
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '0',
  'a locked Admin''s token reads no file');
reset role;
set local role anon;
select c16_as(null);
select is(c16_val($$ select count(*) from public.crm_contact_files $$), '42501', 'anon holds nothing on the table');
reset role;

-- ── 3. No API role writes the table ───────────────────────────────────────────────────────
set local role authenticated;
select c16_as('A');
select is(c16_run($$ insert into public.crm_contact_files (tenant_id, contact_id, object_path, name, content_type, bytes)
            values ('c1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-00000000c001',
                    'c1600000-0000-4000-8000-000000000001/c1600000-0000-4000-8000-00000000c001/c1600000-0000-4000-8000-0000000f00ac.pdf',
                    'x.pdf', 'application/pdf', 1) $$),
  '42501', 'a live Admin''s token cannot insert a file row (the Worker''s door writes it)');
select is(c16_run($$ update public.crm_contact_files set name = 'Renamed.pdf' $$), '42501',
  'nor rename one (a file row is immutable)');
select is(c16_run($$ delete from public.crm_contact_files $$), '42501', 'nor delete one');
select is(c16_val($$ select public.crm_file_add('c1600000-0000-4000-8000-000000000001',
            'c1600000-0000-4000-8000-00000000c001', c16_file('c1600000-0000-4000-8000-0000000f00ad'),
            'c1600000-0000-4000-8000-0000000000a1')::text $$),
  '42501', 'nor call the add door: the service role''s only');
select is(c16_val($$ select public.crm_file_remove('c1600000-0000-4000-8000-000000000001',
            'c1600000-0000-4000-8000-00000000c001', 'c1600000-0000-4000-8000-0000000f0001',
            'c1600000-0000-4000-8000-0000000000a1') $$),
  '42501', 'nor the remove door');
select is(c16_val($$ select count(*) from public.crm_file_orphans(0, 10) $$), '42501',
  'nor the orphan reader');
reset role;
set local role anon;
select c16_as(null);
select is(c16_val($$ select public.crm_file_remove('c1600000-0000-4000-8000-000000000001',
            'c1600000-0000-4000-8000-00000000c001', 'c1600000-0000-4000-8000-0000000f0001',
            'c1600000-0000-4000-8000-0000000000a1') $$),
  '42501', 'anon calls no door');
reset role;

-- ── 4. The remove door ────────────────────────────────────────────────────────────────────
set local role service_role;
insert into c16_out
  select p.code, c16_remove(p.code, 'c1600000-0000-4000-8000-0000000f0002')
    from c16_persona p where p.code in ('C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al');
select is((select string_agg(who || ':' || res, ' ' order by who collate "C") from c16_out),
  'Ad:42501 Al:42501 Ao:42501 C:42501 D:42501 L:42501 O:42501 S:42501',
  'every other actor is refused by the remove door');
delete from c16_out;
select is(c16_remove('A', 'c1600000-0000-4000-8000-0000000f0002', 'c1600000-0000-4000-8000-00000000c003'),
  'P0002', 'a file is removed only from its own contact');
select is(c16_remove('A', 'c1600000-0000-4000-8000-0000000f0002'),
  'c1600000-0000-4000-8000-000000000001/c1600000-0000-4000-8000-00000000c001/c1600000-0000-4000-8000-0000000f0002.png',
  'a live Admin''s removal answers the path the Worker already removed');
select is(c16_remove('A', 'c1600000-0000-4000-8000-0000000f0002'), 'P0002', 'a second removal finds nothing');
reset role;
select ok((select last_activity_at > now() - interval '1 minute' from public.crm_contacts
            where id = 'c1600000-0000-4000-8000-00000000c001'),
  'removing a file leaves the activity where the add put it');

-- ── 5. The ceiling ────────────────────────────────────────────────────────────────────────
set local role service_role;
select is((select count(*)::int from generate_series(1, 19) i
            where c16_add('A', c16_file(gen_random_uuid()::text)) = 'Brief.pdf'), 19,
  'a contact takes files up to the ceiling (1 there already, 19 more)');
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0021')), '23514',
  'the 21st is refused (crm_contact_files_cap)');
select is(c16_val($$ select app.crm_files_cap()::text $$), '20', 'the ceiling is 20');
reset role;
select is((select count(*)::int from public.crm_contact_files
            where contact_id = 'c1600000-0000-4000-8000-00000000c001'), 20, 'twenty, no more');

-- ── 6. The orphan rule and cascade ────────────────────────────────────────────────────────
select ok(app.crm_contact_is_orphan('c1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-00000000c003'),
  'an auto-contact with nothing of a person''s is an orphan');
set local role service_role;
select is(c16_add('A', c16_file('c1600000-0000-4000-8000-0000000f0031', 'c1600000-0000-4000-8000-00000000c003'),
                  'c1600000-0000-4000-8000-00000000c003'),
  'Brief.pdf', 'a person adds a file to the auto-contact');
reset role;
select ok(not app.crm_contact_is_orphan('c1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-00000000c003'),
  'an auto-contact with a file a person added is not an orphan (C16)');
delete from public.crm_contacts where id = 'c1600000-0000-4000-8000-00000000c003';
select is((select count(*)::int from public.crm_contact_files
            where contact_id = 'c1600000-0000-4000-8000-00000000c003'), 0,
  'the file rows go with their contact (the cascade); the sweep removes the objects');

-- ── 7. Grants and the helper ──────────────────────────────────────────────────────────────
select ok(not has_table_privilege('anon', 'public.crm_contact_files', 'select'), 'anon: no SELECT');
select ok(not has_column_privilege('authenticated', 'public.crm_contact_files', 'object_path', 'select'),
  'authenticated: never the object path');
select ok(has_column_privilege('authenticated', 'public.crm_contact_files', 'name', 'select'),
  'authenticated: the name, under RLS');
select ok(not has_table_privilege('service_role', 'public.crm_contact_files', 'update'),
  'not even the service role updates a file row');
select ok(not has_function_privilege('authenticated', 'app.crm_files_actor_ok(uuid, uuid)', 'execute'),
  'the actor check is the service role''s');
select is((select string_agg(policyname || ':' || permissive, ' ' order by policyname)
             from pg_policies where tablename = 'crm_contact_files'),
  'crm_contact_files_live:RESTRICTIVE crm_contact_files_read:PERMISSIVE',
  'a read policy and the RESTRICTIVE live check, nothing else');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.crm_contact_files'::regclass), 'RLS enabled and forced');
select is(
  (select string_agg(r || ':' || app.role_crm_files(r)::int, ' ' order by r)
     from unnest(enum_range(null::public.app_role)::text[] || array['anon']) r),
  'admin:1 anon:0 content_creator:0 developer:0 sales:0 seo:0',
  'app.role_crm_files answers crm.files for each role: Admin only (CLAUDE.md §5)');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname || '.' || p.proname in ('public.crm_file_add', 'public.crm_file_remove',
                                                    'public.crm_file_orphans')
              and not p.prosecdef and 'search_path=""' = any (p.proconfig)), 3,
  'the doors and the orphan reader are INVOKER with an empty search_path');

select * from finish();
rollback;
