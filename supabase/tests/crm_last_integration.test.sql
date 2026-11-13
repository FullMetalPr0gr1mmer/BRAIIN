-- pgTAP: the six-slice CRM integration (Admin v2 C-int: C10b, C9b, C11, C12, C15, C16;
-- docs/admin-v2/as-built/C-LAST-INTEGRATION.md; migration 0141). Run with `supabase test db`.
--
-- Personas, each a token as PostgREST carries it and each naming a live profile (H16): A admin
-- and L sales of T1. Proven here:
--   1. Sales holds crm.contacts since C10b, so it works what the other slices hung on that
--      capability: it finds and dismisses duplicates and the merge door takes it as an actor
--      (C12, crm.md CRM-12), adds a company (C11), fills a custom value (C9b) and reads an
--      import's lawful basis (C15); it never reads a file and the file doors refuse it (C16,
--      C16-Q3: crm.files stays Admin's);
--   2. a merge carries what the later slices added: the dropped record's files follow the
--      survivor and keep their object paths (C16), its custom values fill the survivor's gaps
--      for fields that still exist and never a removed field's (C9b), the survivor takes its
--      company when it has none and keeps its own otherwise, after which an auto-company only
--      the dropped record named goes (C11), and its import's lawful-basis row follows the
--      survivor so an import's dedupe still names the row (C15); a file added to the tombstone
--      is refused;
--   3. retention: a file or a basis row that reached a tombstone follows it before the
--      tombstone goes; a basis row the survivor already has one of goes with the tombstone;
--   4. erasure of a merged survivor takes the moved files' rows, the basis row and the custom
--      values with the contact, and its learnt e-mail domain with the last channel carrying
--      it (C11-SEC-5);
--   5. the follow function's shape: a tombstone only, the service role's alone.

begin;
select plan(32);

insert into public.tenants (id, name) values ('c1410000-0000-4000-8000-000000000001', 'C-int T1');

create table cint_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid);
insert into cint_persona values
  ('A', 'c1410000-0000-4000-8000-0000000000a1', 'admin', 'c1410000-0000-4000-8000-000000000001'),
  ('L', 'c1410000-0000-4000-8000-000000000051', 'sales', 'c1410000-0000-4000-8000-000000000001');
insert into auth.users (id, email)
  select sub, 'cint-' || lower(code) || '@example.test' from cint_persona;
insert into public.profiles (id, tenant_id, role, is_active, display_name)
  select sub, claim_tenant, claim_role::app_role, true, 'C-int ' || code from cint_persona;

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
  ('c1410000-0000-4000-8000-0000000000c3', 'c1410000-0000-4000-8000-000000000001', 'Quill Works');
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
  ('c1410000-0000-4000-8000-00000000e002', 'c1410000-0000-4000-8000-000000000001', 'Sami Drop', '{}', 'c1410000-0000-4000-8000-0000000000a1');
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
  'Palm Studio, Sales Made Co, Xenon Trading',
  'and the auto-company only the dropped record named is gone (C11''s orphan rule after a merge)');
select is((select string_agg(right(contact_id::text, 4) || ':' || row_number, ' ' order by row_number)
             from public.crm_contact_imports where batch_id = 'c1410000-0000-4000-8000-0000000000bb'),
  'a001:7 a002:8 b002:9', 'a survivor with a basis row of its own keeps it; the other''s stays on the tombstone');

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
select is((select count(*)::int from public.crm_contact_imports where row_number = 9), 0,
  'a basis row the survivor already had one of went with the tombstone');

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
