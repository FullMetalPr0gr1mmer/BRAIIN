-- pgTAP: CRM companies (Admin v2 C11, crm.md §5.3, §9, §13 and "CRM-11"). Run with
-- `supabase test db`.
--
-- crm.contacts covers "contacts & companies" (crm.md §2.1): Admin's alone on this base
-- (Developer none, owner default O-7; Sales from C10b, whose helper change the policies follow).
-- Personas, each a token as PostgREST carries it: A admin, A2 a second admin, C
-- content_creator, S seo, D developer, L sales, O another tenant's admin, N anon; stale Admin
-- tokens Ad (the profile now says content_creator), Ao (switched off), Al (locked). Proven here:
--   1. writes by a live Admin through the INVOKER doors: a company with a sector, a client and
--      an owner; another tenant's sector, client or owner refused; the website's shape; the
--      allow-list; the version (40001); the tenant named must be the token's;
--   2. a contact's company: link (the free text follows the company, a person's edit), a stale
--      version, another tenant's company, unlink (the free text stays), "Create company from
--      this name" (found by C5's folding, or made), a contact naming none; a rename reaches
--      the linked contacts as the system's write; a removal unlinks and keeps the free text;
--   3. reads and writes by every other principal and the stale tokens: nothing read, nothing
--      written (the doors and the table); anon holds nothing; the domain index, the stamps,
--      staff_edited and the version are not staff's to read or write; the insert guard
--      answers 42501 before the owner rule (no membership oracle);
--   4. find-or-create at arrival: by name (made by the system, joined by a second inquiry
--      naming it differently cased, never for a phone match), by domain (the Worker's door:
--      an auto-company learns its domain once, but joins nobody to it until a person edits it;
--      then a contact with no company joins it; one domain, one company), the system's link
--      never marks a contact as a person's edit, a person-edited contact keeps its choice, an
--      arrival whose company step fails stays in and linked; an Admin forgets a learnt domain
--      (and nobody else can);
--   5. an auto-company goes with its last contact (a lead's erasure, a person's erasure,
--      retention, a person's unlink, which the door reports); one a person made or edited
--      stays, but its learnt domain goes with the last channel carrying it; an inquiry naming
--      a company a person made never teaches it a domain, and an auto-company's domain never
--      collects another person (C11 review);
--   6. the list's filter, sorts and derived totals.

begin;
select plan(115);

insert into public.tenants (id, name) values
  ('c1100000-0000-4000-8000-000000000001', 'C11 T1'),
  ('c1100000-0000-4000-8000-0000000000ff', 'C11 T2');

create table c11_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                          profile_role text, active boolean, locked boolean);
insert into c11_persona values
  ('A',  'c1100000-0000-4000-8000-0000000000a1', 'admin',           'c1100000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('A2', 'c1100000-0000-4000-8000-0000000000a5', 'admin',           'c1100000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c1100000-0000-4000-8000-0000000000c1', 'content_creator', 'c1100000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c1100000-0000-4000-8000-0000000000e1', 'seo',             'c1100000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c1100000-0000-4000-8000-0000000000d1', 'developer',       'c1100000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c1100000-0000-4000-8000-000000000051', 'sales',           'c1100000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c1100000-0000-4000-8000-0000000000f1', 'admin',           'c1100000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c1100000-0000-4000-8000-0000000000a2', 'admin',           'c1100000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c1100000-0000-4000-8000-0000000000a3', 'admin',           'c1100000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c1100000-0000-4000-8000-0000000000a4', 'admin',           'c1100000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c11-' || lower(code) || '@example.test' from c11_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C11 ' || code
    from c11_persona;

-- A sector and a client in each tenant; contacts in T1 (one to link, one with a free-text
-- company, one with none, a tombstone) and one in T2; a company in T2.
insert into public.sectors (id, tenant_id, slug, name) values
  ('c1100000-0000-4000-8000-00000000e501', 'c1100000-0000-4000-8000-000000000001', 'c11-retail', '{"en": "Retail", "ar": "تجزئة"}'),
  ('c1100000-0000-4000-8000-00000000e5ff', 'c1100000-0000-4000-8000-0000000000ff', 'c11-other', '{"en": "Other", "ar": "أخرى"}');
insert into public.clients (id, tenant_id, slug, name) values
  ('c1100000-0000-4000-8000-00000000c101', 'c1100000-0000-4000-8000-000000000001', 'c11-acme', '{"en": "Acme Logo", "ar": "أكمي"}'),
  ('c1100000-0000-4000-8000-00000000c1ff', 'c1100000-0000-4000-8000-0000000000ff', 'c11-theirs', '{"en": "Theirs", "ar": "لهم"}');
insert into public.crm_contacts (id, tenant_id, display_name, company_name) values
  ('c1100000-0000-4000-8000-00000000c001', 'c1100000-0000-4000-8000-000000000001', 'Huda Saleh', 'Something else'),
  ('c1100000-0000-4000-8000-00000000c002', 'c1100000-0000-4000-8000-000000000001', 'Rami Noor', 'Al Noor Studio'),
  ('c1100000-0000-4000-8000-00000000c003', 'c1100000-0000-4000-8000-000000000001', 'Nobody Inc', null),
  ('c1100000-0000-4000-8000-00000000c004', 'c1100000-0000-4000-8000-000000000001', 'Merged Away', null),
  ('c1100000-0000-4000-8000-00000000c0ff', 'c1100000-0000-4000-8000-0000000000ff', 'Other Person', null);
update public.crm_contacts set merged_into = 'c1100000-0000-4000-8000-00000000c001', merged_at = now()
 where id = 'c1100000-0000-4000-8000-00000000c004';
insert into public.crm_companies (id, tenant_id, name) values
  ('c1100000-0000-4000-8000-0000000000bf', 'c1100000-0000-4000-8000-0000000000ff', 'Theirs Co');

create function c11_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c11_persona p where p.code = p_code), ''), true)
$$;
-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function c11_run(p_sql text) returns text language plpgsql as $$
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
create function c11_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- An inquiry as the Worker sends it (ciphertext stand-ins, the blind indexes as 64 hex).
create function c11_lead(p_id text, p_name text, p_company text, p_email text, p_phone text default null)
  returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id, 'kind', 'contact', 'locale', 'en', 'name', p_name, 'company', p_company,
    'message', 'Hello', 'consent_marketing', true, 'source', 'web_form',
    'email_enc', 'enc-' || coalesce(p_email, 'none'),
    'email_hmac', case when p_email is not null then left(repeat(p_email, 64), 64) end,
    'phone_enc', case when p_phone is not null then 'enc-' || p_phone end,
    'phone_hmac', case when p_phone is not null then repeat(p_phone, 64) end,
    'score_signals', '[]'::jsonb))
$$;
-- As the service role carries no person: the claims an earlier c11_as set (transaction-local)
-- are cleared first, so the arrival's contact is the system's, as in production.
create function c11_ingest(p_lead jsonb) returns uuid language sql as $$
  select set_config('request.jwt.claims', '', true);
  select public.crm_ingest_lead('c1100000-0000-4000-8000-000000000001', p_lead)
$$;
create function c11_contact(p_lead text) returns uuid language sql as $$
  select contact_id from public.leads where id = p_lead::uuid
$$;
-- The company a lead's contact is linked to, by name ('(none)' when none).
create function c11_company_of(p_lead text) returns text language sql as $$
  select coalesce((select c.name from public.leads l
                     join public.crm_contacts k on k.tenant_id = l.tenant_id and k.id = l.contact_id
                     join public.crm_companies c on c.tenant_id = k.tenant_id and c.id = k.company_id
                    where l.id = p_lead::uuid), '(none)')
$$;
grant execute on function c11_as(text), c11_run(text), c11_val(text) to anon, authenticated;
grant select on c11_persona to anon, authenticated;
create temp table c11_out (who text, res text);
grant insert, select on c11_out to authenticated, anon;

-- ── 1. Writes by a live Admin, through the doors ──────────────────────────────────────────
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             jsonb_build_object('name', 'Acme Trading', 'website', 'https://acme.example/about',
               'sector_id', 'c1100000-0000-4000-8000-00000000e501',
               'client_id', 'c1100000-0000-4000-8000-00000000c101', 'size', '11-50',
               'city', 'Jeddah', 'stage', 'client',
               'owner_id', 'c1100000-0000-4000-8000-0000000000a1')) ->> 'sector_name' $$),
  'Retail', 'a live Admin adds a company with a sector, a client and an owner; the answer names the sector');
select is(c11_val($$ select (public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "Second"}'::jsonb) ->> 'auto') || ' ' ||
             (select client_name from (select public.crm_company_read('c1100000-0000-4000-8000-000000000001',
                (select id from public.crm_companies where name = 'Acme Trading')) -> 'company' ->> 'client_name' as client_name) x) $$),
  'false Acme Logo', 'a company a person adds is not the system''s; the read names the linked client');
reset role;
select is((select created_by || ' ' || version || ' ' || staff_edited from public.crm_companies where name = 'Acme Trading'),
  'c1100000-0000-4000-8000-0000000000a1 1 true', 'the company is the session''s, at version 1, a person''s');
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "sector_id": "c1100000-0000-4000-8000-00000000e5ff"}'::jsonb)::text $$),
  '23503', 'another tenant''s sector is refused (the composite key)');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "client_id": "c1100000-0000-4000-8000-00000000c1ff"}'::jsonb)::text $$),
  '23503', 'another tenant''s client is refused');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "owner_id": "c1100000-0000-4000-8000-0000000000c1"}'::jsonb)::text $$)
          || ' ' ||
          c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "owner_id": "c1100000-0000-4000-8000-0000000000f1"}'::jsonb)::text $$),
  '23514 23514', 'the owner must be an active contacts user of this tenant');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "website": "http://acme.example"}'::jsonb)::text $$)
          || ' ' ||
          c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             jsonb_build_object('name', 'X', 'website', 'https://a.example/' || repeat('x', 2040)))::text $$),
  '23514 23514', 'a website is https and at most 2048 characters');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "domain_hmac": "aa"}'::jsonb)::text $$)
          || ' ' ||
          c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "   "}'::jsonb)::text $$)
          || ' ' ||
          c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "X", "sector_id": "nope"}'::jsonb)::text $$),
  '22023 23514 22023', 'an unknown field, a blank name and a malformed id are refused');
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-0000000000ff',
             '{"name": "X"}'::jsonb)::text $$),
  '42501', 'the tenant named must be the token''s');
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Acme Trading'), 7, '{"city": "Riyadh"}')::text $$),
  '40001', 'a change at a stale version is a conflict');
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Acme Trading'), 1, '{"city": "Riyadh"}') ->> 'version' $$),
  '2', 'a change at the version read moves it');
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-0000000000bf', 1, '{"city": "Riyadh"}')::text $$),
  'P0002', 'another tenant''s company is not there');
-- No staff grant reads the domain index, or writes the stamps, the version or staff_edited.
select is(c11_run($$ select domain_hmac from public.crm_companies $$) || ' ' ||
          c11_run($$ update public.crm_companies set version = 9 $$) || ' ' ||
          c11_run($$ update public.crm_companies set staff_edited = false $$) || ' ' ||
          c11_run($$ update public.crm_companies set domain_hmac = repeat('a', 64) $$) || ' ' ||
          c11_run($$ select domain_hmac from public.crm_contact_channels $$),
  '42501 42501 42501 42501 42501', 'staff never read the domain index nor write the stamps, version, staff_edited or the index');

-- ── 2. A contact's company ────────────────────────────────────────────────────────────────
select is(c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c001', 1, 'link',
             (select id from public.crm_companies where name = 'Acme Trading')) ->> 'how' $$),
  'linked', 'a live Admin links a contact to a company at its version');
reset role;
select is((select company_name || ' ' || version || ' ' || staff_edited from public.crm_contacts
            where id = 'c1100000-0000-4000-8000-00000000c001'),
  'Acme Trading 2 true', 'the free text becomes the company''s name; the version moves; a person''s edit');
select ok(exists (select 1 from public.crm_contact_events
                   where contact_id = 'c1100000-0000-4000-8000-00000000c001' and kind = 'details_changed'
                     and detail -> 'fields' ? 'company_name'),
  'the contact''s timeline says its company changed (field names only)');
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c001', 1, 'unlink')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c003', 1, 'link', 'c1100000-0000-4000-8000-0000000000bf')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c004', 1, 'unlink')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c003', 1, 'create')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c003', 1, 'swap')::text $$),
  '40001 23503 P0002 23514 22023',
  'a stale version, another tenant''s company, a tombstone, a contact naming no company and an unknown action are refused');
-- A company the folding matches ("Al Noor Studio" meets "Noor Studio") is found, not made.
select is(c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001',
             '{"name": "Noor Studio"}'::jsonb) ->> 'name' $$)
          || ' ' ||
          c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c002', 1, 'create') ->> 'how' $$),
  'Noor Studio found', '"Create company from this name" finds the company the name folds to');
select is(c11_val($$ select company_name from public.crm_contacts where id = 'c1100000-0000-4000-8000-00000000c002' $$),
  'Noor Studio', 'and the contact now shows that company''s name');
reset role;
update public.crm_contacts set company_name = 'Fresh Ideas' where id = 'c1100000-0000-4000-8000-00000000c003';
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c003',
             (select version from public.crm_contacts where id = 'c1100000-0000-4000-8000-00000000c003'),
             'create') ->> 'how' $$),
  'created', 'or makes it, as the caller''s');
reset role;
select is((select c.created_by::text || ' ' || c.staff_edited from public.crm_companies c where c.name = 'Fresh Ideas'),
  'c1100000-0000-4000-8000-0000000000a1 true', 'a company made from a contact''s name is the person''s');
-- A person edits the linked free text: it stays the company's while linked.
set local role authenticated;
select c11_as('A');
select is(c11_run($$ update public.crm_contacts set company_name = 'Typed over'
                      where id = 'c1100000-0000-4000-8000-00000000c003' $$)
          || ' ' ||
          c11_val($$ select company_name from public.crm_contacts where id = 'c1100000-0000-4000-8000-00000000c003' $$),
  'ok:1 Fresh Ideas', 'while linked, the free text is the company''s name');
-- A rename reaches the linked contacts (section 4 shows it is not their edit).
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Noor Studio'), 1, '{"name": "Noor Studio Co"}') ->> 'name' $$),
  'Noor Studio Co', 'a live Admin renames a company');
reset role;
select is((select company_name from public.crm_contacts where id = 'c1100000-0000-4000-8000-00000000c002'),
  'Noor Studio Co', 'its contacts show the new name');
-- A removal unlinks its contacts and leaves their last name as free text.
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_delete('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Noor Studio Co'), 1)::text $$),
  '40001', 'a removal at a stale version is a conflict');
select is(c11_val($$ select public.crm_company_delete('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Noor Studio Co'), 2) ->> 'contacts' $$),
  '1', 'a removal at the version read answers how many contacts it named');
reset role;
select is((select coalesce(company_id::text, 'null') || ' ' || company_name from public.crm_contacts
            where id = 'c1100000-0000-4000-8000-00000000c002'),
  'null Noor Studio Co', 'the contact keeps the name as free text');

-- ── 3. Every other principal, and the stale tokens ────────────────────────────────────────
set local role authenticated;
do $do$
declare
  p text;
begin
  foreach p in array array['A', 'A2', 'C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'] loop
    perform c11_as(p);
    insert into c11_out values ('read:' || p,
      c11_val($$ select count(*)::text from public.crm_companies where tenant_id = 'c1100000-0000-4000-8000-000000000001' $$)
      || ' ' ||
      c11_val($$ select public.crm_companies_list('c1100000-0000-4000-8000-000000000001', '{}') ->> 'total' $$));
  end loop;
end $do$;
select is((select string_agg(who || '=' || res, ',' order by who collate "C") from c11_out where who like 'read:%'),
  'read:A=3 3,read:A2=3 3,read:Ad=0 0,read:Al=0 0,read:Ao=0 0,read:C=0 0,read:D=0 0,read:L=0 0,read:O=0 42501,read:S=0 0',
  'only a live Admin of the tenant reads its companies; every other principal and stale token reads none');
do $do$
declare
  p text;
begin
  foreach p in array array['C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'] loop
    perform c11_as(p);
    insert into c11_out values ('write:' || p,
      c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001', '{"name": "Mine"}')::text $$)
      || ' ' ||
      c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
                  (select id from public.crm_companies where name = 'Second'), 1, '{"city": "Abha"}')::text $$)
      || ' ' ||
      c11_val($$ select public.crm_company_delete('c1100000-0000-4000-8000-000000000001',
                  (select id from public.crm_companies where name = 'Second'), 1)::text $$)
      || ' ' ||
      c11_val($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
                  'c1100000-0000-4000-8000-00000000c001', 3, 'unlink')::text $$)
      || ' ' ||
      c11_run($$ insert into public.crm_companies (tenant_id, name, owner_id) values
                  ('c1100000-0000-4000-8000-000000000001', 'Probe', 'c1100000-0000-4000-8000-0000000000f1') $$)
      || ' ' ||
      c11_run($$ delete from public.crm_companies where tenant_id = 'c1100000-0000-4000-8000-000000000001' $$));
  end loop;
end $do$;
select is((select string_agg(who || '=' || res, ',' order by who collate "C") from c11_out where who like 'write:%'),
  'write:Ad=42501 P0002 P0002 P0002 42501 ok:0,write:Al=42501 P0002 P0002 P0002 42501 ok:0,'
  || 'write:Ao=42501 P0002 P0002 P0002 42501 ok:0,write:C=42501 P0002 P0002 P0002 42501 ok:0,'
  || 'write:D=42501 P0002 P0002 P0002 42501 ok:0,write:L=42501 P0002 P0002 P0002 42501 ok:0,'
  || 'write:O=42501 42501 42501 42501 42501 ok:0,write:S=42501 P0002 P0002 P0002 42501 ok:0',
  'nobody else adds, changes, removes or links a company; a direct insert naming an owner of any tenant is refused before the owner rule (no oracle)');
reset role;
select is((select count(*)::int from public.crm_companies where name in ('Mine', 'Probe')), 0,
  'and nothing was written');
set local role anon;
select is(c11_run($$ select id from public.crm_companies $$) || ' ' ||
          c11_val($$ select public.crm_companies_list('c1100000-0000-4000-8000-000000000001', '{}')::text $$) || ' ' ||
          c11_val($$ select public.crm_company_create('c1100000-0000-4000-8000-000000000001', '{"name": "Anon"}')::text $$) || ' ' ||
          c11_val($$ select public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
                       'c1100000-0000-4000-8000-0000000000aa', repeat('a', 64)) $$),
  '42501 42501 42501 42501', 'anon reads, writes and executes nothing');
reset role;
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-0000000000aa', repeat('a', 64)) $$),
  '42501', 'the domain door is not a staff token''s');
reset role;

-- ── 4. Find-or-create at arrival ──────────────────────────────────────────────────────────
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab01', 'Sara', 'Blue Fig', '1', '7')) $$,
  'an inquiry naming a company arrives');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab01'), 'Blue Fig',
  'its new contact is linked to a company made from the name');
select is((select coalesce(created_by::text, 'system') || ' ' || staff_edited || ' ' || coalesce(domain_hmac, 'no domain')
             from public.crm_companies where name = 'Blue Fig'),
  'system false no domain', 'the company is the system''s, edited by no one, with no domain yet');
select is((select staff_edited::text || ' ' || company_name from public.crm_contacts
            where id = c11_contact('c1100000-0000-4000-8000-00000000ab01')),
  'false Blue Fig', 'the system''s link is not a person''s edit of the contact (C5-SEC-1 holds)');
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab02', 'Omar', '  blue FIG ', '2')) $$,
  'a second inquiry names the company differently');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab02') || ' ' ||
          (select count(*) from public.crm_companies where tenant_id = 'c1100000-0000-4000-8000-000000000001'
                                                         and name_key = 'blue fig'),
  'Blue Fig 1', 'it joins the same company (one company, the folding matches)');
-- A new address sharing a company-less contact's phone links by phone (flagged): no company
-- step, so a stranger on a shared line never gives that contact a company.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab12', 'No Co', null, 'e', '6')) $$,
  'an inquiry naming no company, with a phone, arrives');
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab03', 'Someone', 'Red Co', '3', '6')) $$,
  'an inquiry matched by phone alone arrives');
reset role;
select is((select contact_link from public.leads where id = 'c1100000-0000-4000-8000-00000000ab03') || ' ' ||
          (select count(*) from public.crm_companies where name = 'Red Co') || ' ' ||
          c11_company_of('c1100000-0000-4000-8000-00000000ab12'),
  'phone 0 (none)', 'a phone match makes no company and gives the matched contact none (it may be someone else''s)');
-- The domain: the Worker's door records it; the contact's company learns it, once.
set local role service_role;
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab01', repeat('d', 64)),
  'recorded', 'the domain index is recorded on the inquiry''s e-mail channel');
reset role;
select is((select domain_hmac = repeat('d', 64) and version = 1 from public.crm_companies where name = 'Blue Fig')::text,
  'true', 'the contact''s company learns the domain, which is not an edit (no version)');
-- An inquiry naming no company, from that domain, joins the company holding it.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab04', 'Lina', null, '4')) $$,
  'an inquiry naming no company arrives');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab04'), '(none)', 'no name, no domain yet: no company');
set local role service_role;
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab04', repeat('d', 64)), 'recorded', 'its domain is recorded');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab04'), '(none)',
  'an auto-company no person has edited joins nobody to it by its domain (C11-SEC-2)');
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_read('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Blue Fig')) -> 'company' ->> 'domain' $$),
  'learnt', 'the drawer says the auto-company holds a learnt domain (never which), not yet joining');
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Blue Fig'), 1, '{"city": "Riyadh"}') ->> 'domain' $$),
  'joins', 'once a person edits the company, its domain joins');
reset role;
set local role service_role;
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab04', repeat('d', 64)), 'recorded', 'the domain is recorded again');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab04') || ' ' ||
          (select staff_edited from public.crm_contacts where id = c11_contact('c1100000-0000-4000-8000-00000000ab04')),
  'Blue Fig false', 'now it joins the company holding the domain, as the system''s link');
-- A company named differently, from a domain another company holds: no second holder.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab05', 'Faris', 'Green Leaf', '5')) $$,
  'an inquiry naming another company arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab05', repeat('d', 64)), 'recorded', 'from the same domain');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab05') || ' ' ||
          coalesce((select domain_hmac from public.crm_companies where name = 'Green Leaf'), 'no domain'),
  'Green Leaf no domain', 'its own company stays, and does not take a domain another company holds');
-- The door's other answers.
set local role service_role;
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-00000000ab03', repeat('d', 64))
          || ' ' ||
          public.crm_lead_domain('c1100000-0000-4000-8000-0000000000ff', 'c1100000-0000-4000-8000-00000000ab01', repeat('d', 64))
          || ' ' ||
          c11_val($$ select public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
                       'c1100000-0000-4000-8000-00000000ab01', 'not-hex') $$),
  'unlinked missing 22023', 'a phone match is unlinked here, another tenant''s lead is missing, a bad index is refused');
-- A person-edited contact keeps its choice: no company by domain.
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab06', 'Edited', null, '6')) $$,
  'an inquiry naming no company arrives');
reset role;
set local role authenticated;
select c11_as('A');
select is(c11_run(format($$ update public.crm_contacts set city = 'Abha' where id = %L $$,
                         c11_contact('c1100000-0000-4000-8000-00000000ab06'))), 'ok:1',
  'a person edits its contact');
reset role;
set local role service_role;
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab06', repeat('d', 64)), 'recorded', 'its domain is recorded');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab06'), '(none)',
  'a contact a person edited is not given a company by the system');
-- The arrival is never blocked: a company step that fails leaves the inquiry in, linked.
alter table public.crm_companies add constraint c11_boom check (name <> 'Boom Co') not valid;
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab07', 'Boom', 'Boom Co', '8')) $$,
  'an inquiry whose company step fails arrives');
reset role;
select is((select (contact_id is not null)::text || ' ' || contact_link from public.leads
            where id = 'c1100000-0000-4000-8000-00000000ab07') || ' ' || c11_company_of('c1100000-0000-4000-8000-00000000ab07'),
  'true new (none)', 'the inquiry is in and linked to its contact; only the company step was undone');
alter table public.crm_companies drop constraint c11_boom;
-- A person's rename reaches an auto-linked contact as the system's write.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab11', 'Plain', 'Plain Co', 'c')) $$,
  'an inquiry naming a plain company arrives');
reset role;
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Plain Co'), 1, '{"name": "Plain Co Ltd"}') ->> 'name' $$),
  'Plain Co Ltd', 'a person renames the auto-company');
reset role;
select is((select company_name || ' ' || staff_edited || ' ' || version from public.crm_contacts
            where id = c11_contact('c1100000-0000-4000-8000-00000000ab11')),
  'Plain Co Ltd false 3', 'its contact shows the new name; its version moves; it is not a person''s edit of the contact');
-- An Admin forgets a learnt domain (C11-SEC-1); nobody else can, through the door or its core.
set local role authenticated;
do $do$
declare
  p text;
begin
  foreach p in array array['C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'] loop
    perform c11_as(p);
    insert into c11_out values ('forget:' || p,
      c11_val($$ select public.crm_company_forget_domain('c1100000-0000-4000-8000-000000000001',
                  (select id from public.crm_companies where name = 'Blue Fig'), 2)::text $$)
      || ' ' ||
      c11_val($$ select app.crm_company_forget_domain_core('c1100000-0000-4000-8000-000000000001',
                  (select id from public.crm_companies where name = 'Blue Fig'))::text $$));
  end loop;
end $do$;
select is((select string_agg(who || '=' || res, ',' order by who collate "C") from c11_out where who like 'forget:%'),
  'forget:Ad=42501 42501,forget:Al=42501 42501,forget:Ao=42501 42501,forget:C=42501 42501,'
  || 'forget:D=42501 42501,forget:L=42501 42501,forget:O=42501 42501,forget:S=42501 42501',
  'no other role, other tenant or stale token forgets a domain, through the door or its core');
reset role;
select is((select domain_hmac from public.crm_companies where name = 'Blue Fig'), repeat('d', 64),
  'and the domain is still there');
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_forget_domain('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Blue Fig'), 1)::text $$),
  '40001', 'forgetting at a stale version is a conflict');
select is(c11_val($$ select x ->> 'forgot' || ' ' || coalesce(x ->> 'domain', 'none') || ' ' || (x ->> 'version')
                      from public.crm_company_forget_domain('c1100000-0000-4000-8000-000000000001',
                        (select id from public.crm_companies where name = 'Blue Fig'), 2) x $$),
  'true none 2', 'a live Admin forgets the learnt domain at the version read; not an edit (no version)');
reset role;
select is(coalesce((select domain_hmac from public.crm_companies where name = 'Blue Fig'), 'no domain'), 'no domain',
  'the index is gone from the company');
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab20', 'After', null, 'a7')) $$,
  'an inquiry naming no company arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab20', repeat('d', 64)), 'recorded', 'from the forgotten domain');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab20') || ' ' ||
          coalesce((select domain_hmac from public.crm_companies where name = 'Blue Fig'), 'no domain'),
  '(none) no domain', 'it joins nothing, and a company a person edited never learns the domain again');

-- ── 5. An auto-company goes with its last contact ─────────────────────────────────────────
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab08', 'Tiny', 'Tiny Shop', '9')) $$,
  'an inquiry naming a small shop arrives');
select is(public.crm_erase_lead('c1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-00000000ab08',
                                'c1100000-0000-4000-8000-0000000000a1') ->> 'contacts', '1',
  'erasing the inquiry takes its auto-contact (C5)');
reset role;
select is((select count(*)::int from public.crm_companies where name = 'Tiny Shop'), 0,
  'and the company its free text made');
-- A person's erasure takes the auto-company too, but not one shared with another contact.
select is((select (public.crm_erase_person('c1100000-0000-4000-8000-000000000001',
                    c11_contact('c1100000-0000-4000-8000-00000000ab05'), '{}',
                    'c1100000-0000-4000-8000-0000000000a1') ->> 'contacts')),
  '1', 'a person is erased');
select is((select count(*)::int from public.crm_companies where name = 'Green Leaf') || ' ' ||
          (select count(*)::int from public.crm_companies where name = 'Blue Fig'),
  '0 1', 'their auto-company goes; a company other contacts are linked to stays');
-- Retention: a contact idle past the horizon goes, and its auto-company with it.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab09', 'Old', 'Old Co', 'a')) $$,
  'an inquiry naming an old company arrives');
reset role;
update public.crm_contacts set last_activity_at = now() - interval '30 months'
 where id = c11_contact('c1100000-0000-4000-8000-00000000ab09');
select lives_ok($$ select app.purge_crm() $$, 'the nightly purge runs');
select is((select count(*)::int from public.crm_companies where name = 'Old Co'), 0,
  'the idle contact''s auto-company went with it');
-- A company a person edited stays when its last contact goes.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab10', 'Kept', 'Kept Co', 'b')) $$,
  'an inquiry naming a company arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab10', repeat('9', 64)), 'recorded', 'its domain is recorded');
reset role;
select is((select domain_learnt::text from public.crm_companies where name = 'Kept Co'), 'true',
  'and its auto-company learns it');
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select public.crm_company_update('c1100000-0000-4000-8000-000000000001',
             (select id from public.crm_companies where name = 'Kept Co'), 1, '{"notes": "Met at the fair"}') ->> 'version' $$),
  '2', 'a person edits the auto-company');
reset role;
select is((select public.crm_erase_lead('c1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-00000000ab10',
                                        'c1100000-0000-4000-8000-0000000000a1') ->> 'contacts')
          || ' ' || (select count(*)::int from public.crm_companies where name = 'Kept Co'),
  '1 1', 'its last contact goes; the company a person edited stays');
select is(coalesce((select domain_hmac from public.crm_companies where name = 'Kept Co'), 'no domain'), 'no domain',
  'but its learnt domain went with the last channel carrying it (C11-SEC-5)');
-- An inquiry naming a company a person made never teaches it a domain (C11-SEC-1), so a
-- later inquiry naming no company from that domain does not join it.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab14', 'Mallory', 'ACME trading', 'a1')) $$,
  'an inquiry naming a company a person made arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab14', repeat('e', 64)), 'recorded', 'its domain is recorded');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab14') || ' ' ||
          coalesce((select domain_hmac from public.crm_companies where name = 'Acme Trading'), 'no domain'),
  'Acme Trading no domain', 'its contact joins the company by name, which learns no domain');
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab15', 'Next', null, 'a2')) $$,
  'an inquiry naming no company arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab15', repeat('e', 64)), 'recorded', 'from the same domain');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab15'), '(none)',
  'it does not join the company a person made');
-- A sole trader's auto-company learns a consumer domain the Worker's list missed: another
-- person from it never joins, and the trader's erasure takes the company (C11-SEC-2).
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab16', 'Sara', 'Sara Design', 'a3')) $$,
  'a sole trader''s inquiry arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab16', repeat('8', 64)), 'recorded', 'its domain is recorded');
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab17', 'Bilal', null, 'a4')) $$,
  'a stranger on the same mailbox provider arrives');
select is(public.crm_lead_domain('c1100000-0000-4000-8000-000000000001',
            'c1100000-0000-4000-8000-00000000ab17', repeat('8', 64)), 'recorded', 'from the same domain');
reset role;
select is(c11_company_of('c1100000-0000-4000-8000-00000000ab16') || ', ' ||
          c11_company_of('c1100000-0000-4000-8000-00000000ab17'),
  'Sara Design, (none)', 'the stranger is not joined to the trader''s auto-company');
select is(public.crm_erase_lead('c1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-00000000ab16',
                                'c1100000-0000-4000-8000-0000000000a1') ->> 'contacts',
  '1', 'the trader''s inquiry is erased, with its contact');
select is((select count(*)::int from public.crm_companies where name = 'Sara Design'), 0,
  'and the trader''s company with it');
-- A person's unlink of an auto-company's last contact removes it, and the door says which
-- (C11-SEC-4, C11-COR-5); an unlink from a company a person made removes nothing.
set local role service_role;
select lives_ok($$ select c11_ingest(c11_lead('c1100000-0000-4000-8000-00000000ab19', 'Gone', 'Gone Co', 'a5')) $$,
  'an inquiry naming a company arrives');
reset role;
create temp table c11_gone as select id from public.crm_companies where name = 'Gone Co';
grant select on c11_gone to authenticated;
set local role authenticated;
select c11_as('A');
select is(c11_val(format($$ select public.crm_contact_company('c1100000-0000-4000-8000-000000000001', %L,
             (select version from public.crm_contacts where id = %L), 'unlink') ->> 'removed_company' $$,
             c11_contact('c1100000-0000-4000-8000-00000000ab19'), c11_contact('c1100000-0000-4000-8000-00000000ab19'))),
  (select id::text from c11_gone), 'a person unlinks its last contact: the door answers the company it removed');
select is(c11_val($$ select coalesce(public.crm_contact_company('c1100000-0000-4000-8000-000000000001',
             'c1100000-0000-4000-8000-00000000c003',
             (select version from public.crm_contacts where id = 'c1100000-0000-4000-8000-00000000c003'),
             'unlink') ->> 'removed_company', 'none') $$),
  'none', 'unlinking from a company a person made removes nothing');
reset role;
select is((select count(*)::int from public.crm_companies where name = 'Gone Co') || ' ' ||
          (select count(*)::int from public.crm_companies where name = 'Fresh Ideas'),
  '0 1', 'the auto-company went; the one a person made stays');
-- A company a person made stays when its last contact is unlinked.
select is((select count(*)::int from public.crm_companies where name = 'Acme Trading'), 1,
  'a company a person made stays with no contacts');

-- ── 6. The list ───────────────────────────────────────────────────────────────────────────
-- Blue Fig: three contacts (Sara, Omar, Lina); a won lead of Sara's with a value.
update public.leads set stage_id = (select id from public.lead_stages
                                     where tenant_id = 'c1100000-0000-4000-8000-000000000001' and kind = 'won'
                                     order by sort_order limit 1),
                        value_sar = 50000
 where id = 'c1100000-0000-4000-8000-00000000ab01';
-- One transaction has one now(): Lina's activity is put an hour later so the order is not a tie.
update public.crm_contacts set last_activity_at = now() + interval '1 hour'
 where id = c11_contact('c1100000-0000-4000-8000-00000000ab04');
set local role authenticated;
select c11_as('A');
select is(c11_val($$ select (x ->> 'name') || ' ' || (x ->> 'contacts') || ' ' || (x ->> 'won_value') || ' ' || (x ->> 'auto')
                      from jsonb_array_elements(public.crm_companies_list('c1100000-0000-4000-8000-000000000001',
                             '{"sort": "contacts", "limit": 1}') -> 'rows') x $$),
  'Blue Fig 3 50000 true', 'the list derives contacts and the won value, and sorts by them');
select is(c11_val($$ select (public.crm_companies_list('c1100000-0000-4000-8000-000000000001',
                      '{"q": "BLUE", "limit": 5}') ->> 'total') || ' ' ||
                    (public.crm_companies_list('c1100000-0000-4000-8000-000000000001',
                      '{"q": "100%", "limit": 5}') ->> 'total') $$),
  '1 0', 'the search folds the query as the names are, and a % is a character');
select is(c11_val($$ select (public.crm_companies_list('c1100000-0000-4000-8000-000000000001',
                      '{"stage": "client"}') ->> 'total') || ' ' ||
                    (public.crm_companies_list('c1100000-0000-4000-8000-000000000001',
                      '{"owner": "me"}') ->> 'total') || ' ' ||
                    (public.crm_companies_list('c1100000-0000-4000-8000-000000000001',
                      '{"owner": "none", "sort": "value"}') ->> 'total') $$),
  '1 1 5', 'stage and owner filters (Acme Trading is a client owned by the Admin; five have no owner)');
select is(c11_val($$ select public.crm_companies_list('c1100000-0000-4000-8000-000000000001', '{"limit": 0}')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_companies_list('c1100000-0000-4000-8000-000000000001', '{"q": "a@b.c", "x": 1}')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_companies_list('c1100000-0000-4000-8000-000000000001', '{"sort": "age"}')::text $$)
          || ' ' ||
          c11_val($$ select public.crm_companies_list('c1100000-0000-4000-8000-000000000001', '{"owner": "someone"}')::text $$),
  '22023 22023 22023 22023', 'the filter is allow-listed and bounded');
select is(c11_val($$ select (public.crm_company_read('c1100000-0000-4000-8000-000000000001',
                      (select id from public.crm_companies where name = 'Blue Fig')) -> 'contacts' -> 0 ->> 'display_name') || ' ' ||
                    jsonb_array_length(public.crm_company_read('c1100000-0000-4000-8000-000000000001',
                      (select id from public.crm_companies where name = 'Blue Fig')) -> 'contacts') $$),
  'Lina 3', 'one company lists its contacts, most recently active first, names only');
select is(c11_val($$ select (public.crm_company_read('c1100000-0000-4000-8000-000000000001',
                      (select id from public.crm_companies where name = 'Blue Fig')) -> 'company') ? 'domain_hmac' $$)
          || ' ' ||
          c11_val($$ select public.crm_company_read('c1100000-0000-4000-8000-000000000001',
                      'c1100000-0000-4000-8000-0000000000bf')::text $$),
  'false P0002', 'the answer never carries the domain index; another tenant''s company is not there');
reset role;

-- ── 7. Grants and structure (P-14) ────────────────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.crm_companies', 'select')
          and has_column_privilege('authenticated', 'public.crm_companies', 'name', 'select')
          and not has_column_privilege('authenticated', 'public.crm_companies', 'domain_hmac', 'select')
          and has_column_privilege('authenticated', 'public.crm_contacts', 'company_id', 'update')
          and not has_column_privilege('authenticated', 'public.crm_contact_channels', 'domain_hmac', 'select')
          and not has_table_privilege('anon', 'public.crm_companies', 'select'),
  'staff read the companies but the domain index, link a contact''s company, never read a channel''s domain index; anon nothing');
select ok(has_function_privilege('service_role', 'public.crm_lead_domain(uuid, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_lead_domain(uuid, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'app.crm_company_autolink(uuid, uuid, text, text)', 'execute')
          and not has_function_privilege('service_role', 'app.crm_company_autolink(uuid, uuid, text, text)', 'execute')
          and has_function_privilege('authenticated', 'public.crm_companies_list(uuid, jsonb)', 'execute')
          and not has_function_privilege('service_role', 'public.crm_companies_list(uuid, jsonb)', 'execute'),
  'the domain door is the service role''s; the find-or-create step no API role''s; the readers authenticated''s');
select is((select string_agg(tgname, ',' order by tgname collate "C") from pg_trigger
            where tgrelid = 'public.crm_contacts'::regclass and not tgisinternal
              and tgname in ('crm_contacts_company', 'crm_contacts_company_orphan', 'crm_contacts_row')),
  'crm_contacts_company,crm_contacts_company_orphan,crm_contacts_row',
  'the mirror fires before C5''s row rules (name order)');
select is((select proconfig::text from pg_proc where oid = to_regprocedure('app.crm_lead_domain_core(uuid, uuid, text)'))
          || ' ' ||
          (select proconfig::text from pg_proc where oid = to_regprocedure('public.crm_lead_domain(uuid, uuid, text)')),
  '{"search_path=\"\"",lock_timeout=2s} {"search_path=\"\""}',
  'the domain step waits at most 2 s for a lock, a setting on its app.* core only (C11-SEC-3)');
select ok(exists (select 1 from pg_constraint where conname = 'sectors_tenant_id_id')
          and exists (select 1 from pg_constraint where conname = 'clients_tenant_id_id')
          and exists (select 1 from pg_constraint where conname = 'crm_contacts_company_fk'),
  'the composite keys are in place');

select * from finish();
rollback;
