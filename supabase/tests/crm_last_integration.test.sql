-- pgTAP: the six-slice CRM integration (Admin v2 C-int: C10b, C9b, C11, C12, C15, C16;
-- docs/admin-v2/as-built/C-LAST-INTEGRATION.md; migration 0141). Run with `supabase test db`.
--
-- Personas, each a token as PostgREST carries it: A admin and L sales of T1, each naming a live
-- profile (H16); O an admin of T2; Ld, Lo and Ll Sales tokens of T1 whose profile was since
-- demoted, switched off or locked. Proven here:
--   1. Sales holds crm.contacts since C10b, so it works what the other slices hung on that
--      capability: it finds and dismisses duplicates and the merge door takes it as an actor
--      (C12, crm.md CRM-12), adds, changes and removes a company and links, unlinks and
--      creates a contact's company (C11, the per-role rows the integration took out of C11's
--      write loop: C-int review CINT-SEC-3 / XS-3), fills a custom value (C9b) and reads an
--      import's lawful basis (C15); it never reads a file and the file doors refuse it (C16,
--      C16-Q3: crm.files stays Admin's); a stale Sales token reads and writes none of it;
--   2. a merge carries what the later slices added: the dropped record's files follow the
--      survivor and keep their object paths (C16), its custom values fill the survivor's gaps
--      for fields that still exist and never a removed field's (C9b), the survivor takes its
--      company when it names none or names the same one, and keeps its own otherwise, its own
--      free text included (CINT-W-1 / XS-1), after which an auto-company only the dropped
--      record named goes (C11) and an audit row names it (CINT-W-4 / XS-5), and its import's
--      lawful-basis rows follow the survivor, which keeps both bases when it has its own
--      (CINT-SEC-2 / XS-2), so an import's dedupe still names the row (C15); a file added to
--      the tombstone is refused, and a removal named on it finds the file on the survivor
--      (CINT-W-3 / XS-4);
--   3. retention: a file or a basis row that reached a tombstone follows it before the
--      tombstone goes, and a tombstone erased while the nightly run works does not stop it
--      (CINT-SEC-1 / XS-6);
--   4. erasure of a merged survivor takes the moved files' rows, the basis row and the custom
--      values with the contact, and its learnt e-mail domain with the last channel carrying
--      it (C11-SEC-5);
--   5. the follow function's shape: a tombstone only, the service role's alone.

begin;
select plan(50);

insert into public.tenants (id, name) values
  ('c1410000-0000-4000-8000-000000000001', 'C-int T1'),
  ('c1410000-0000-4000-8000-000000000002', 'C-int T2');

create table cint_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid);
insert into cint_persona values
  ('A', 'c1410000-0000-4000-8000-0000000000a1', 'admin', 'c1410000-0000-4000-8000-000000000001'),
  ('L', 'c1410000-0000-4000-8000-000000000051', 'sales', 'c1410000-0000-4000-8000-000000000001'),
  ('O', 'c1410000-0000-4000-8000-0000000000f1', 'admin', 'c1410000-0000-4000-8000-000000000002'),
  ('Ld', 'c1410000-0000-4000-8000-000000000052', 'sales', 'c1410000-0000-4000-8000-000000000001'),
  ('Lo', 'c1410000-0000-4000-8000-000000000053', 'sales', 'c1410000-0000-4000-8000-000000000001'),
  ('Ll', 'c1410000-0000-4000-8000-000000000054', 'sales', 'c1410000-0000-4000-8000-000000000001');
insert into auth.users (id, email)
  select sub, 'cint-' || lower(code) || '@example.test' from cint_persona;
insert into public.profiles (id, tenant_id, role, is_active, display_name)
  select sub, claim_tenant, claim_role::app_role, true, 'C-int ' || code from cint_persona;
-- The stale Sales tokens: the profile moved on after the token was minted.
update public.profiles set role = 'content_creator' where id = 'c1410000-0000-4000-8000-000000000052';
update public.profiles set is_active = false where id = 'c1410000-0000-4000-8000-000000000053';
update public.profiles set locked_until = now() + interval '10 minutes' where id = 'c1410000-0000-4000-8000-000000000054';
create table cint_out (who text primary key, res text);
grant all on cint_out to anon, authenticated, service_role;

create function cint_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from cint_persona p where p.code = p_code), ''), true)
$$;
-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function cint_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function cint_run(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;
-- A file row as the Worker's add door would store it (the object path names its contact).
create function cint_file(p_contact text, p_file text) returns void language sql as $$
  insert into public.crm_contact_files (id, tenant_id, contact_id, object_path, name, content_type, bytes)
  values (('c1410000-0000-4000-8000-' || p_file)::uuid, 'c1410000-0000-4000-8000-000000000001',
          ('c1410000-0000-4000-8000-' || p_contact)::uuid,
          'c1410000-0000-4000-8000-000000000001/c1410000-0000-4000-8000-' || p_contact
            || '/c1410000-0000-4000-8000-' || p_file || '.pdf',
          'File ' || p_file, 'application/pdf', 10)
$$;
grant execute on function cint_as(text), cint_val(text), cint_run(text) to anon, authenticated, service_role;
grant select on cint_persona to anon, authenticated, service_role;

-- Fixtures (T1). Custom fields: seats (a number) and renewal (a date).
update public.crm_settings
   set custom_fields = '[{"key": "seats", "label": "Seats", "type": "number"},
                         {"key": "renewal", "label": "Renewal", "type": "date"}]'
 where tenant_id = 'c1410000-0000-4000-8000-000000000001';
-- Companies: X and P made by a person (the Admin), Q by the system from an inquiry.
insert into public.crm_companies (id, tenant_id, name, created_by) values
  ('c1410000-0000-4000-8000-0000000000c1', 'c1410000-0000-4000-8000-000000000001', 'Xenon Trading', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-0000000000c2', 'c1410000-0000-4000-8000-000000000001', 'Palm Studio', 'c1410000-0000-4000-8000-0000000000a1');
insert into public.crm_companies (id, tenant_id, name) values
  ('c1410000-0000-4000-8000-0000000000c3', 'c1410000-0000-4000-8000-000000000001', 'Quill Works'),
  ('c1410000-0000-4000-8000-0000000000c4', 'c1410000-0000-4000-8000-000000000001', 'Orchid Auto');
-- Contacts: k001 / d001 (the first merge), k002 / d002 (the second), k003 / d003 (the third),
-- s001 / s002 (Sales' merge), e001 (an erasure-free bystander holding nothing).
insert into public.crm_contacts (id, tenant_id, display_name, custom, created_by) values
  ('c1410000-0000-4000-8000-00000000a001', 'c1410000-0000-4000-8000-000000000001', 'Keep One', '{"seats": 3}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000a002', 'c1410000-0000-4000-8000-000000000001', 'Keep Two', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000a003', 'c1410000-0000-4000-8000-000000000001', 'Keep Three', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000b001', 'c1410000-0000-4000-8000-000000000001', 'Drop One', '{"seats": 5, "renewal": "2027-01-01"}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000b002', 'c1410000-0000-4000-8000-000000000001', 'Drop Two', '{}', null),
  ('c1410000-0000-4000-8000-00000000b003', 'c1410000-0000-4000-8000-000000000001', 'Drop Three', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000e001', 'c1410000-0000-4000-8000-000000000001', 'Sami Keep', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000e002', 'c1410000-0000-4000-8000-000000000001', 'Sami Drop', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  -- Sales' company doors (s003 at the auto-company Orchid Auto, named by it alone).
  ('c1410000-0000-4000-8000-00000000e003', 'c1410000-0000-4000-8000-000000000001', 'Sales Probe', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  -- CINT-W-1: f001 types a company of its own (no link), f002 is linked to Xenon Trading;
  -- g001 types Palm Studio's name, g002 is linked to Palm Studio.
  ('c1410000-0000-4000-8000-00000000f001', 'c1410000-0000-4000-8000-000000000001', 'Keep Typed', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000f002', 'c1410000-0000-4000-8000-000000000001', 'Drop Linked', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000f003', 'c1410000-0000-4000-8000-000000000001', 'Keep Same', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000f004', 'c1410000-0000-4000-8000-000000000001', 'Drop Same', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  -- CINT-SEC-1: two more pairs, merged and then raced at retention.
  ('c1410000-0000-4000-8000-00000000d101', 'c1410000-0000-4000-8000-000000000001', 'Race Keep One', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000d102', 'c1410000-0000-4000-8000-000000000001', 'Race Drop One', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000d201', 'c1410000-0000-4000-8000-000000000001', 'Race Keep Two', '{}', 'c1410000-0000-4000-8000-0000000000a1'),
  ('c1410000-0000-4000-8000-00000000d202', 'c1410000-0000-4000-8000-000000000001', 'Race Drop Two', '{}', 'c1410000-0000-4000-8000-0000000000a1');
update public.crm_contacts set company_id = 'c1410000-0000-4000-8000-0000000000c4'
 where id = 'c1410000-0000-4000-8000-00000000e003';
update public.crm_contacts set company_name = 'Foo Typed Ltd'
 where id = 'c1410000-0000-4000-8000-00000000f001';
update public.crm_contacts set company_id = 'c1410000-0000-4000-8000-0000000000c1'
 where id = 'c1410000-0000-4000-8000-00000000f002';
update public.crm_contacts set company_name = '  palm studio '
 where id = 'c1410000-0000-4000-8000-00000000f003';
update public.crm_contacts set company_id = 'c1410000-0000-4000-8000-0000000000c2'
 where id = 'c1410000-0000-4000-8000-00000000f004';
-- A value of a field that no longer exists (the removal's cascade would have taken it; it is
-- planted past the value trigger, so only the merge's own filter can keep it out).
alter table public.crm_contacts disable trigger crm_contacts_custom_fields;
update public.crm_contacts set custom = custom || '{"gone_key": "x"}'
 where id = 'c1410000-0000-4000-8000-00000000b001';
alter table public.crm_contacts enable trigger crm_contacts_custom_fields;
-- Companies: d001 at X (k001 has none); k002 at P, d002 at Q (Q named by d002 alone).
update public.crm_contacts set company_id = 'c1410000-0000-4000-8000-0000000000c1'
 where id = 'c1410000-0000-4000-8000-00000000b001';
update public.crm_contacts set company_id = 'c1410000-0000-4000-8000-0000000000c2'
 where id = 'c1410000-0000-4000-8000-00000000a002';
update public.crm_contacts set company_id = 'c1410000-0000-4000-8000-0000000000c3'
 where id = 'c1410000-0000-4000-8000-00000000b002';
-- Channels: d001's e-mail (it carries a learnt domain index later), s001 / s002 share a phone.
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary) values
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000b001', 'email', 'enc-d1', repeat('d', 64), true),
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000e001', 'phone', 'enc-s1', repeat('5', 64), true),
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000e002', 'phone', 'enc-s2', repeat('5', 64), true);
-- Files: k001 one, d001 two, d003 none yet.
select cint_file('00000000a001', '0000000f0001');
select cint_file('00000000b001', '0000000f0002');
select cint_file('00000000b001', '0000000f0003');
-- An import, open, by the Admin: d001 came from its row 7, k002 from row 8, d002 from row 9.
insert into public.crm_import_batches (id, tenant_id, created_by, attestation, expected_rows, expected_bytes) values
  ('c1410000-0000-4000-8000-0000000000bb', 'c1410000-0000-4000-8000-000000000001',
   'c1410000-0000-4000-8000-0000000000a1', 'c15-v1', 100, 1000);
insert into public.crm_contact_imports (tenant_id, contact_id, batch_id, row_number, basis) values
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000b001', 'c1410000-0000-4000-8000-0000000000bb', 7, 'consent'),
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000a002', 'c1410000-0000-4000-8000-0000000000bb', 8, 'contract'),
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000b002', 'c1410000-0000-4000-8000-0000000000bb', 9, 'consent');

-- ── 1. Sales across the slices (C10b x C9b, C11, C12, C15, C16) ───────────────────────────
set local role authenticated;
select cint_as('L');
select ok(cint_val($$ select public.crm_duplicate_pairs('c1410000-0000-4000-8000-000000000001')::text $$)
            like '%c1410000-0000-4000-8000-00000000e00%',
  'Sales finds a likely duplicate (C12 x C10b)');
select is(cint_val($$ select public.crm_dismiss_duplicate('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003', 'c1410000-0000-4000-8000-00000000b003')::text $$),
  'true', 'and says two people are not one');
select is(cint_val($$ select count(*)::text from public.crm_merge_dismissals $$), '1',
  'and reads the dismissals');
select ok(cint_val($$ select public.crm_company_create('c1410000-0000-4000-8000-000000000001',
             '{"name": "Sales Made Co"}')::text $$) like '%Sales Made Co%',
  'Sales adds a company (C11 x C10b)');
select is(cint_run($$ update public.crm_contacts set custom = '{"seats": 7}'
                      where id = 'c1410000-0000-4000-8000-00000000a003' $$),
  'ok:1', 'Sales fills a custom value (C9b x C10b)');
select is(cint_val($$ select count(*)::text from public.crm_contact_imports $$), '3',
  'Sales reads the imports'' lawful bases (crm.contacts'', C15 x C10b)');
select is(cint_val($$ select count(*)::text from public.crm_import_batches $$) || ' '
          || cint_val($$ select count(*)::text from public.crm_contact_files $$),
  '0 0', 'but no import batch (crm.import) and no file (crm.files stays Admin''s, C16-Q3)');
reset role;
select set_config('request.jwt.claims', '', true);
set local role service_role;
select is(cint_val($$ select public.crm_file_add('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003',
             jsonb_build_object('id', 'c1410000-0000-4000-8000-0000000f0009',
               'object_path', 'c1410000-0000-4000-8000-000000000001/c1410000-0000-4000-8000-00000000a003/c1410000-0000-4000-8000-0000000f0009.pdf',
               'name', 'x.pdf', 'content_type', 'application/pdf', 'bytes', 10),
             'c1410000-0000-4000-8000-000000000051')::text $$)
          || ' ' ||
          cint_val($$ select public.crm_file_remove('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a001', 'c1410000-0000-4000-8000-0000000f0001',
             'c1410000-0000-4000-8000-000000000051') $$),
  '42501 42501', 'the file doors refuse a Sales actor (C16-Q3)');
select is(cint_val($$ select (public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000e001', 1, 'c1410000-0000-4000-8000-00000000e002', 1,
             'c1410000-0000-4000-8000-000000000051') ->> 'keep') $$),
  'c1410000-0000-4000-8000-00000000e001',
  'the merge door takes a live Sales actor (crm.md CRM-12; the Worker claims its reveal slot first)');
reset role;

-- Sales' company writes, row by row (CINT-SEC-3 / XS-3: the integration took Sales out of
-- C11's refused-writes loop; these are its rows at the database layer).
set local role authenticated;
select cint_as('L');
select is(cint_val($$ select public.crm_company_update('c1410000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Sales Made Co'),
             (select version from public.crm_companies where name = 'Sales Made Co'),
             '{"city": "Abha"}') ->> 'city' $$),
  'Abha', 'Sales changes a company at the version it read (C11 x C10b)');
select is(cint_val($$ select public.crm_contact_company('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000e003',
             (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000e003'),
             'unlink') ->> 'removed_company' $$),
  'c1410000-0000-4000-8000-0000000000c4',
  'Sales unlinks a contact''s company, and the door names the auto-company that went with it');
select is(cint_val($$ select public.crm_contact_company('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000e003',
             (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000e003'),
             'create') ->> 'how' $$)
          || ' ' ||
          cint_val($$ select public.crm_contact_company('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000e003',
             (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000e003'),
             'link', (select id from public.crm_companies where name = 'Sales Made Co')) ->> 'how' $$),
  'created linked', 'Sales makes a company from a contact''s free text, and links one');
select is(cint_val($$ select public.crm_company_delete('c1410000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Sales Made Co'),
             (select version from public.crm_companies where name = 'Sales Made Co')) ->> 'contacts' $$),
  '1', 'Sales removes a company at the version it read');
select is(cint_run($$ insert into public.crm_companies (tenant_id, name, owner_id) values
             ('c1410000-0000-4000-8000-000000000001', 'Probe', 'c1410000-0000-4000-8000-0000000000f1') $$)
          || ' ' ||
          cint_run($$ insert into public.crm_companies (tenant_id, name, owner_id) values
             ('c1410000-0000-4000-8000-000000000001', 'Probe', 'c1410000-0000-4000-8000-000000000053') $$),
  '23514 23514',
  'a live Sales user''s direct insert naming another tenant''s person is the owner rule''s answer, the same as an inactive colleague''s (no membership oracle)');
do $do$
declare
  p text;
begin
  foreach p in array array['Ld', 'Lo', 'Ll'] loop
    perform cint_as(p);
    insert into cint_out values ('stale:' || p,
      cint_val($$ select count(*)::text from public.crm_companies $$) || '/'
      || cint_val($$ select count(*)::text from public.crm_merge_dismissals $$) || '/'
      || cint_val($$ select count(*)::text from public.crm_contact_imports $$) || ' '
      || cint_val($$ select public.crm_company_create('c1410000-0000-4000-8000-000000000001', '{"name": "Stale"}')::text $$)
      || ' ' ||
      cint_val($$ select public.crm_company_update('c1410000-0000-4000-8000-000000000001',
                  'c1410000-0000-4000-8000-0000000000c2', 1, '{"city": "Abha"}')::text $$)
      || ' ' ||
      cint_val($$ select public.crm_company_delete('c1410000-0000-4000-8000-000000000001',
                  'c1410000-0000-4000-8000-0000000000c2', 1)::text $$)
      || ' ' ||
      cint_val($$ select public.crm_contact_company('c1410000-0000-4000-8000-000000000001',
                  'c1410000-0000-4000-8000-00000000a002', 1, 'unlink')::text $$)
      || ' ' ||
      cint_run($$ insert into public.crm_companies (tenant_id, name, owner_id) values
                  ('c1410000-0000-4000-8000-000000000001', 'Probe', 'c1410000-0000-4000-8000-0000000000f1') $$)
      || ' ' ||
      cint_run($$ delete from public.crm_companies where tenant_id = 'c1410000-0000-4000-8000-000000000001' $$));
  end loop;
end $do$;
select is((select string_agg(who || '=' || res, ',' order by who collate "C") from cint_out where who like 'stale:%'),
  'stale:Ld=0/0/0 42501 P0002 P0002 P0002 42501 ok:0,stale:Ll=0/0/0 42501 P0002 P0002 P0002 42501 ok:0,'
  || 'stale:Lo=0/0/0 42501 P0002 P0002 P0002 42501 ok:0',
  'a demoted, switched-off or locked Sales token reads no company, dismissal or lawful basis, and every company door and direct write refuses it (the insert before the owner rule)');
reset role;
select set_config('request.jwt.claims', '', true);
set local role service_role;
select is(cint_val($$ select public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003', 1, 'c1410000-0000-4000-8000-00000000b003', 1,
             'c1410000-0000-4000-8000-000000000052')::text $$)
          || ' ' ||
          cint_val($$ select public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003', 1, 'c1410000-0000-4000-8000-00000000b003', 1,
             'c1410000-0000-4000-8000-000000000053')::text $$)
          || ' ' ||
          cint_val($$ select public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003', 1, 'c1410000-0000-4000-8000-00000000b003', 1,
             'c1410000-0000-4000-8000-000000000054')::text $$),
  '42501 42501 42501', 'and the merge door refuses a stale Sales actor');
reset role;
select is((select count(*)::int from public.crm_companies where name in ('Probe', 'Stale')), 0,
  'nothing the refused writes tried was stored');

-- ── 2. A merge carries the later slices' data ─────────────────────────────────────────────
set local role service_role;
select ok((public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a001', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a001'),
             'c1410000-0000-4000-8000-00000000b001', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000b001'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null,
  'an Admin merges Drop One into Keep One');
reset role;
select is((select string_agg(right(id::text, 4) || '@' || right(contact_id::text, 4), ' ' order by id)
             from public.crm_contact_files where tenant_id = 'c1410000-0000-4000-8000-000000000001'),
  '0001@a001 0002@a001 0003@a001',
  'the dropped record''s files follow the survivor (C12 x C16)');
select is((select count(*)::int from public.crm_contact_files
            where contact_id = 'c1410000-0000-4000-8000-00000000a001'
              and object_path like 'c1410000-0000-4000-8000-000000000001/c1410000-0000-4000-8000-00000000b001/%'),
  2, 'and keep their object paths (a path is a name, never read back as a link)');
-- CINT-W-3 / XS-4: a removal the route began on the record a merge then emptied (it read the
-- path and removed the object first) still removes the row, now on the survivor.
set local role service_role;
select is(cint_val($$ select public.crm_file_remove('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000b001', 'c1410000-0000-4000-8000-0000000f0003',
             'c1410000-0000-4000-8000-0000000000a1') $$),
  'c1410000-0000-4000-8000-000000000001/c1410000-0000-4000-8000-00000000b001/c1410000-0000-4000-8000-0000000f0003.pdf',
  'a file removal named on the record merged away removes the file on its survivor (CINT-W-3)');
select is(cint_val($$ select public.crm_file_remove('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a002', 'c1410000-0000-4000-8000-0000000f0002',
             'c1410000-0000-4000-8000-0000000000a1') $$)
          || ' ' ||
          cint_val($$ select public.crm_file_remove('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000b001', 'c1410000-0000-4000-8000-0000000f0002',
             'c1410000-0000-4000-8000-000000000051') $$),
  'P0002 42501', 'but never one on another live record, and never for a Sales actor');
reset role;
select is((select string_agg(right(id::text, 4), ' ' order by id) from public.crm_contact_files
            where tenant_id = 'c1410000-0000-4000-8000-000000000001'),
  '0001 0002', 'so no row is left naming an object that is gone');
select is((select custom::text from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a001'),
  '{"seats": 3, "renewal": "2027-01-01"}',
  'the survivor''s value wins, the other''s fills a gap, a removed field''s value is never carried (C12 x C9b)');
select is((select coalesce(company_id::text, 'none') || ' ' || coalesce(company_name, 'none')
             from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a001'),
  'c1410000-0000-4000-8000-0000000000c1 Xenon Trading',
  'a survivor with no company takes the other''s (C12 x C11)');
select is((select coalesce(company_id::text, 'none') || ' ' || custom::text
             from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000b001'),
  'none {}', 'the tombstone keeps no company and no value');
select is((select right(contact_id::text, 4) || ' ' || row_number from public.crm_contact_imports
            where batch_id = 'c1410000-0000-4000-8000-0000000000bb' and row_number = 7),
  'a001 7', 'its import''s lawful-basis row follows the survivor (C12 x C15)');
set local role service_role;
select is(cint_val($$ select (public.crm_import_rows('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-0000000000bb', 'c1410000-0000-4000-8000-0000000000a1',
             jsonb_build_array(jsonb_build_object('row', 40, 'basis', 'consent', 'display_name', 'Drop One again',
               'channels', jsonb_build_array(jsonb_build_object('kind', 'email', 'value_enc', 'enc-x',
                                                                'value_hmac', repeat('d', 64))))),
             0, 50) -> 'repeats')::text $$),
  '[{"of": 7, "row": 40}]',
  'so the import''s dedupe still names the row that person came from');
select is(cint_val($$ select public.crm_file_add('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000b001',
             jsonb_build_object('id', 'c1410000-0000-4000-8000-0000000f0008',
               'object_path', 'c1410000-0000-4000-8000-000000000001/c1410000-0000-4000-8000-00000000b001/c1410000-0000-4000-8000-0000000f0008.pdf',
               'name', 'late.pdf', 'content_type', 'application/pdf', 'bytes', 10),
             'c1410000-0000-4000-8000-0000000000a1')::text $$),
  'P0002', 'a file added to the record merged away is refused');
select ok((public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a002', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a002'),
             'c1410000-0000-4000-8000-00000000b002', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000b002'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null,
  'an Admin merges Drop Two (at the auto-company Quill Works) into Keep Two (at Palm Studio)');
reset role;
select is((select company_id::text from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a002'),
  'c1410000-0000-4000-8000-0000000000c2', 'the survivor keeps its own company');
select is((select string_agg(name, ', ' order by name) from public.crm_companies
            where tenant_id = 'c1410000-0000-4000-8000-000000000001'),
  'Orchid Auto, Palm Studio, Xenon Trading',
  'and the auto-company only the dropped record named is gone (C11''s orphan rule after a merge)');
select is((select string_agg(right(contact_id::text, 4) || ':' || row_number, ' ' order by row_number)
             from public.crm_contact_imports where batch_id = 'c1410000-0000-4000-8000-0000000000bb'),
  'a001:7 a002:8 a002:9',
  'a survivor with a basis row of its own keeps it and gains the other''s: both bases stay (CINT-SEC-2)');
-- CINT-W-1 / XS-1: a survivor's own free-text company is never replaced by the other's link.
set local role service_role;
select ok((public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000f001', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000f001'),
             'c1410000-0000-4000-8000-00000000f002', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000f002'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null
          and (public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000f003', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000f003'),
             'c1410000-0000-4000-8000-00000000f004', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000f004'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null,
  'an Admin merges Drop Linked into Keep Typed, and Drop Same into Keep Same');
reset role;
select is((select coalesce(company_id::text, 'none') || ' / ' || coalesce(company_name, 'none')
             from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000f001'),
  'none / Foo Typed Ltd',
  'a survivor that typed a company of its own keeps its words and stays unlinked (CINT-W-1)');
select is((select coalesce(company_id::text, 'none') || ' / ' || coalesce(company_name, 'none')
             from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000f003'),
  'c1410000-0000-4000-8000-0000000000c2 / Palm Studio',
  'one whose words name the other''s company is linked to it');
-- CINT-W-4 / XS-5: the merge that removed an auto-company says which, in its own transaction.
select is((select string_agg(entity_id || ' ' || (detail ->> 'drop') || ' ' || (detail ->> 'removed_company')
                             || ' ' || actor_role, ',')
             from public.audit_log where action = 'crm.contact.merge.company_removed'
              and tenant_id = 'c1410000-0000-4000-8000-000000000001'),
  'c1410000-0000-4000-8000-00000000a002 c1410000-0000-4000-8000-00000000b002 c1410000-0000-4000-8000-0000000000c3 admin',
  'a merge that removed an auto-company audits its id (and only that merge: no company went in the others)');

-- ── 3. Retention: what reached a tombstone follows it before it goes ──────────────────────
set local role service_role;
select ok((public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a003'),
             'c1410000-0000-4000-8000-00000000b003', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000b003'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null,
  'an Admin merges Drop Three into Keep Three');
reset role;
-- A file and a basis row that raced onto the tombstone (written past the doors, as only a race
-- could put them there).
select cint_file('00000000b003', '0000000f0004');
insert into public.crm_contact_imports (tenant_id, contact_id, batch_id, row_number, basis) values
  ('c1410000-0000-4000-8000-000000000001', 'c1410000-0000-4000-8000-00000000b003', 'c1410000-0000-4000-8000-0000000000bb', 11, 'contract');
select ok(app.purge_crm() >= 3, 'the nightly run removes the tombstones');
select is((select count(*)::int from public.crm_contacts
            where tenant_id = 'c1410000-0000-4000-8000-000000000001' and merged_into is not null),
  0, 'none is left');
select is((select right(contact_id::text, 4) from public.crm_contact_files where id = 'c1410000-0000-4000-8000-0000000f0004')
          || ' ' ||
          (select right(contact_id::text, 4) from public.crm_contact_imports where row_number = 11),
  'a003 a003', 'the raced file and basis row followed the survivor first (C-int purge lines)');
select is((select right(contact_id::text, 4) from public.crm_contact_imports where row_number = 9), 'a002',
  'a basis row moved onto a survivor that had its own is still there after the night''s run (CINT-SEC-2)');

-- CINT-SEC-1 / XS-6: a tombstone erased while the night's run works does not stop it. Two
-- pairs merged, a file raced onto each tombstone; while the run moves the first file, the
-- other pair's survivor is erased (its tombstone goes with it by cascade), as an Admin's
-- erasure committing at that moment would.
set local role service_role;
select ok((public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000d101', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000d101'),
             'c1410000-0000-4000-8000-00000000d102', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000d102'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null
          and (public.crm_merge_contacts('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000d201', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000d201'),
             'c1410000-0000-4000-8000-00000000d202', (select version from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000d202'),
             'c1410000-0000-4000-8000-0000000000a1') ->> 'version') is not null,
  'two more pairs merged');
reset role;
select cint_file('00000000d102', '0000000f0005');
select cint_file('00000000d202', '0000000f0006');
create table cint_race_done (done boolean);
create function cint_race() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.cint_race_done) then
    insert into public.cint_race_done values (true);
    delete from public.crm_contacts c
     where c.id in ('c1410000-0000-4000-8000-00000000d101', 'c1410000-0000-4000-8000-00000000d201')
       and c.id <> new.contact_id;
  end if;
  return null;
end $$;
create trigger cint_race after update on public.crm_contact_files
  for each row execute function cint_race();
select ok(cint_val($$ select app.purge_crm()::text $$) ~ '^[0-9]+$',
  'the night''s run finishes when a tombstone it found is erased before it is followed (CINT-SEC-1)');
drop trigger cint_race on public.crm_contact_files;
select is((select count(*)::int from public.crm_contacts
            where tenant_id = 'c1410000-0000-4000-8000-000000000001' and merged_into is not null)
          || ' ' || (select count(*)::int from cint_race_done)
          || ' ' || (select count(*)::int from public.crm_contact_files
                      where id in ('c1410000-0000-4000-8000-0000000f0005', 'c1410000-0000-4000-8000-0000000f0006')
                        and contact_id in ('c1410000-0000-4000-8000-00000000d101', 'c1410000-0000-4000-8000-00000000d201')),
  '0 1 1', 'no tombstone is left, the race ran, and the surviving pair''s file is on its survivor');

-- ── 4. Erasure of a merged survivor ───────────────────────────────────────────────────────
-- Keep One's moved e-mail carries Xenon Trading's learnt domain index (as C11's domain step
-- would have left it): the company forgets it when its last carrier goes.
update public.crm_companies set domain_hmac = repeat('e', 64) where id = 'c1410000-0000-4000-8000-0000000000c1';
update public.crm_contact_channels set domain_hmac = repeat('e', 64)
 where contact_id = 'c1410000-0000-4000-8000-00000000a001' and kind = 'email';
set local role service_role;
select ok((public.crm_erase_person('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a001', '{}', 'c1410000-0000-4000-8000-0000000000a1')
             ->> 'contacts') = '1', 'an Admin erases Keep One');
reset role;
select is((select count(*)::int from public.crm_contact_files
            where contact_id = 'c1410000-0000-4000-8000-00000000a001')
          + (select count(*)::int from public.crm_contact_imports
              where contact_id = 'c1410000-0000-4000-8000-00000000a001')
          + (select count(*)::int from public.crm_contacts where id = 'c1410000-0000-4000-8000-00000000a001'),
  0, 'its own and its moved files'' rows, its basis row and its values go with it (objects: the Worker, after the door)');
select is((select coalesce(domain_hmac, 'none') from public.crm_companies where id = 'c1410000-0000-4000-8000-0000000000c1'),
  'none', 'and the company forgets the domain its e-mail carried (C11-SEC-5)');

-- ── 5. The follow ─────────────────────────────────────────────────────────────────────────
set local role service_role;
select is(cint_val($$ select app.crm_tombstone_follow('c1410000-0000-4000-8000-000000000001',
             'c1410000-0000-4000-8000-00000000a003')::text $$),
  'P0002', 'the follow moves nothing off a live record');
reset role;
select ok(has_function_privilege('service_role', 'app.crm_tombstone_follow(uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'app.crm_tombstone_follow(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'app.crm_tombstone_follow(uuid, uuid)', 'execute'),
  'and is the service role''s alone');

select * from finish();
rollback;
