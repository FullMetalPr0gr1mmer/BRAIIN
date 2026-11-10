-- pgTAP: the contacts API's database half (Admin v2 C6, crm.md CRM-6; migration 0133). Run
-- with `supabase test db`.
--
-- Personas, each a token as PostgREST carries it: A admin, C content_creator, S seo, D
-- developer, L sales, O another tenant's admin, N anon; stale Admin tokens Ad (the profile
-- now says content_creator), Ao (switched off), Al (locked). crm.contacts is Admin's alone
-- (Developer none, O-7; Sales from C10b). Proven here:
--   1. the readers (INVOKER): only a live Admin of the tenant lists, counts, pages a timeline
--      or bulk-changes contacts; the tenant the caller names must be the token's; the filter is
--      allow-listed; an address is found by its blind index only; no value or index leaves;
--   2. the timeline: the contact's events and those of its leads linked other than by phone,
--      never a note's words, one keyset with no repeats, nothing across tenants;
--   3. bulk: versioned actions conflict on a stale version, a star moves none, a refused owner
--      fails the whole statement;
--   4. the doors: the service role's alone, each refusing an actor who is not a live contacts
--      user of the tenant; add (a taken e-mail is a duplicate, nothing written), channels, a
--      note's deletion (crm.erase), the phone match's confirm and detach, a new lead.

begin;
select plan(74);

insert into public.tenants (id, name) values
  ('c6000000-0000-4000-8000-000000000001', 'C6 T1'),
  ('c6000000-0000-4000-8000-0000000000ff', 'C6 T2');

create table c6_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                         profile_role text, active boolean, locked boolean);
insert into c6_persona values
  ('A',  'c6000000-0000-4000-8000-0000000000a1', 'admin',           'c6000000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c6000000-0000-4000-8000-0000000000c1', 'content_creator', 'c6000000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c6000000-0000-4000-8000-0000000000e1', 'seo',             'c6000000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c6000000-0000-4000-8000-0000000000d1', 'developer',       'c6000000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c6000000-0000-4000-8000-000000000051', 'sales',           'c6000000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c6000000-0000-4000-8000-0000000000f1', 'admin',           'c6000000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c6000000-0000-4000-8000-0000000000a2', 'admin',           'c6000000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c6000000-0000-4000-8000-0000000000a3', 'admin',           'c6000000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c6000000-0000-4000-8000-0000000000a4', 'admin',           'c6000000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c6-' || lower(code) || '@example.test' from c6_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C6 ' || code
    from c6_persona;

-- T1: Huda (an e-mail and a phone, a note), Omar (the same phone: a shared office line), and
-- a tombstone; T2: one contact. Leads of T1: aa01 Huda's own (by e-mail, won, worth 5,000,
-- score 40), aa02 matched to Huda by phone alone (its own e-mail '9…'), aa03 matched to Omar
-- by phone alone.
insert into public.crm_contacts (id, tenant_id, display_name, company_name, last_activity_at) values
  ('c6000000-0000-4000-8000-00000000c001', 'c6000000-0000-4000-8000-000000000001', 'Huda Saleh', 'Acme', now() - interval '3 days'),
  ('c6000000-0000-4000-8000-00000000c002', 'c6000000-0000-4000-8000-000000000001', 'Omar Ali', null, now() - interval '700 days'),
  ('c6000000-0000-4000-8000-00000000c0ff', 'c6000000-0000-4000-8000-0000000000ff', 'Other Person', null, now());
insert into public.crm_contacts (id, tenant_id, display_name, merged_into, merged_at) values
  ('c6000000-0000-4000-8000-00000000c0dd', 'c6000000-0000-4000-8000-000000000001', 'Merged Away',
   'c6000000-0000-4000-8000-00000000c001', now());
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary) values
  ('c6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-00000000c001', 'email', 'ciphertext-e', repeat('1', 64), true),
  ('c6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-00000000c001', 'phone', 'ciphertext-p', repeat('2', 64), true),
  ('c6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-00000000c002', 'phone', 'ciphertext-p2', repeat('2', 64), true),
  ('c6000000-0000-4000-8000-0000000000ff', 'c6000000-0000-4000-8000-00000000c0ff', 'email', 'ciphertext-o', repeat('1', 64), true);
insert into public.crm_contact_notes (id, tenant_id, contact_id, body) values
  ('c6000000-0000-4000-8000-0000000000b1', 'c6000000-0000-4000-8000-000000000001',
   'c6000000-0000-4000-8000-00000000c001', 'Secret words about Huda');
insert into public.leads (id, tenant_id, name, email_enc, email_hmac, phone_enc, phone_hmac, message,
                          crm_indexed_at, value_sar, score) values
  ('c6000000-0000-4000-8000-00000000aa01', 'c6000000-0000-4000-8000-000000000001', 'Huda', 'ciphertext-e',
   repeat('1', 64), 'ciphertext-p', repeat('2', 64), 'hello', now(), 5000, 40),
  ('c6000000-0000-4000-8000-00000000aa02', 'c6000000-0000-4000-8000-000000000001', 'Someone', 'ciphertext-9',
   repeat('9', 64), 'ciphertext-p', repeat('2', 64), 'hi', now(), 900, 90),
  ('c6000000-0000-4000-8000-00000000aa03', 'c6000000-0000-4000-8000-000000000001', 'Stranger', 'ciphertext-8',
   repeat('8', 64), 'ciphertext-p', repeat('2', 64), 'hey', now(), null, 10);
update public.leads set stage_id = (select s.id from public.lead_stages s
                                     where s.tenant_id = 'c6000000-0000-4000-8000-000000000001' and s.kind = 'won'
                                     order by s.sort_order limit 1)
 where id = 'c6000000-0000-4000-8000-00000000aa01';
update public.leads set contact_id = 'c6000000-0000-4000-8000-00000000c001', contact_link = 'email'
 where id = 'c6000000-0000-4000-8000-00000000aa01';
update public.leads set contact_id = 'c6000000-0000-4000-8000-00000000c001', contact_link = 'phone'
 where id = 'c6000000-0000-4000-8000-00000000aa02';
update public.leads set contact_id = 'c6000000-0000-4000-8000-00000000c002', contact_link = 'phone'
 where id = 'c6000000-0000-4000-8000-00000000aa03';
-- The fixture's own writes moved Huda's activity; put it back, and keep Omar's old (within 30
-- days of the 24-month horizon).
update public.crm_contacts set last_activity_at = now() - interval '3 days'
 where id = 'c6000000-0000-4000-8000-00000000c001';
update public.crm_contacts set last_activity_at = now() - interval '715 days'
 where id = 'c6000000-0000-4000-8000-00000000c002';

create function c6_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c6_persona p where p.code = p_code), ''), true)
$$;
-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function c6_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- The list's total for T1 (or T2), as the current token.
create function c6_total(p_tenant text, p_filter text default '{}') returns text language sql as $$
  select c6_val(format($q$ select public.crm_contacts_list(%L::uuid, %L::jsonb) ->> 'total' $q$,
                       case p_tenant when 'T2' then 'c6000000-0000-4000-8000-0000000000ff'
                                     else 'c6000000-0000-4000-8000-000000000001' end, p_filter))
$$;
grant execute on function c6_as(text), c6_val(text), c6_total(text, text) to anon, authenticated, service_role;
grant select on c6_persona to anon, authenticated, service_role;

-- ── 1. The readers, per persona ───────────────────────────────────────────────────────────
set local role authenticated;
select c6_as('A');
select is(c6_total('T1'), '2', 'a live Admin lists the tenant''s two contacts (never a tombstone)');
select is(c6_total('T2'), '0', 'and nothing of a tenant it names that is not its token''s');
select is(c6_val($$ select concat_ws(' ', r ->> 'display_name', r ->> 'value', r ->> 'score', r ->> 'leads',
                                     r ->> 'to_check', r ->> 'has_email', r ->> 'has_phone')
                      from jsonb_array_elements(public.crm_contacts_list('c6000000-0000-4000-8000-000000000001',
                             '{"sort": "name"}') -> 'rows') r
                     where r ->> 'display_name' = 'Huda Saleh' $$),
  'Huda Saleh 5000 40 1 1 true true',
  'value and score come from the leads linked other than by phone (the phone match is to check)');
select is(c6_val($$ select string_agg(k, ',' order by k)
                      from jsonb_array_elements(public.crm_contacts_list('c6000000-0000-4000-8000-000000000001') -> 'rows') r,
                           jsonb_object_keys(r) k
                     where k ~ '(_enc|_hmac|^email$|^phone$|^custom$)' $$),
  '(null)', 'no row carries a channel''s value, its index, or the custom values');
select is(c6_total('T1', '{"q": "huda"}'), '1', 'a contains search over name and company');
select is(c6_total('T1', '{"contact_kind": "email", "contact_hmac": "' || repeat('1', 64) || '"}'), '1',
  'a whole e-mail is found by its blind index');
select is(c6_total('T1', '{"q": "huda@example.test"}'), '22023', 'an address sent as text is refused');
select is(c6_total('T1', '{"q": "0501234567"}'), '22023', 'and so is a number');
select is(c6_total('T1', '{"secret": true}'), '22023', 'an unknown filter key is refused');
select is(c6_total('T1', '{"limit": 101}'), '22023', 'a page is at most 100');
select is(c6_total('T1', '{"expiring": true}'), '1', 'Omar, idle near the horizon, is expiring soon');
select is(c6_val($$ select public.crm_contact_summary('c6000000-0000-4000-8000-000000000001')::text $$),
  '{"lead": 1, "mine": 0, "past": 0, "total": 2, "client": 1, "partner": 0, "starred": 0, "expiring": 1, "to_check": 2}',
  'the counts (Huda a client by her won lead; two contacts with a phone match to check)');
select c6_as('C');
select is(c6_total('T1') || ' ' || c6_val($$ select public.crm_contact_summary('c6000000-0000-4000-8000-000000000001') ->> 'total' $$),
  '0 0', 'a Content Creator lists and counts no contact');
select c6_as('S');
select is(c6_total('T1'), '0', 'SEO lists none');
select c6_as('D');
select is(c6_total('T1') || ' ' || c6_total('T1', '{"contact_kind": "email", "contact_hmac": "' || repeat('1', 64) || '"}'),
  '0 0', 'a Developer lists none and finds no address (owner default O-7)');
select c6_as('L');
select is(c6_total('T1'), '0', 'Sales lists none (not until C10b)');
select c6_as('O');
select is(c6_total('T1') || ' ' || c6_total('T2'), '0 1', 'another tenant''s Admin lists only its own tenant''s');
select c6_as('Ad');
select is(c6_total('T1'), '0', 'a demoted Admin''s token lists nothing (the live check)');
select c6_as('Ao');
select is(c6_total('T1'), '0', 'a switched-off Admin''s token lists nothing');
select c6_as('Al');
select is(c6_total('T1') || ' ' || c6_total('T1', '{"contact_kind": "email", "contact_hmac": "' || repeat('1', 64) || '"}'),
  '0 0', 'a locked Admin''s token lists nothing and finds no address');
reset role;
set local role anon;
select c6_as('N');
select is(c6_total('T1') || ' '
          || c6_val($$ select public.crm_contact_summary('c6000000-0000-4000-8000-000000000001')::text $$) || ' '
          || c6_val($$ select public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-00000000c001')::text $$),
  '42501 42501 42501', 'anon executes none of the readers');
reset role;

-- ── 2. The timeline ───────────────────────────────────────────────────────────────────────
set local role authenticated;
select c6_as('A');
select is(c6_val($$ select string_agg(e ->> 'src' || ':' || (e ->> 'kind'), ',' order by e ->> 'src', e ->> 'kind')
                      from jsonb_array_elements(public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
                             'c6000000-0000-4000-8000-00000000c001', '{"limit": 60}') -> 'events') e $$),
  'contact:channel_added,contact:channel_added,contact:created,contact:lead_linked,contact:lead_linked,contact:note_added,contact:stage_changed,lead:created,lead:stage_changed',
  'the contact''s own lines, and its own lead''s (never the phone match''s events, nor the link''s twin line)');
select is(c6_val($$ select position('Secret' in public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
                             'c6000000-0000-4000-8000-00000000c001', '{"limit": 60}')::text)::text $$),
  '0', 'never a note''s words');
select is(c6_val($$ select string_agg(e ->> 'kind', ',')
                      from jsonb_array_elements(public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
                             'c6000000-0000-4000-8000-00000000c001', '{"kind": "notes"}') -> 'events') e $$),
  'note_added', 'the notes filter');
create temp table c6_page (n int, body jsonb);
grant insert, select on c6_page to authenticated;
insert into c6_page select 1, public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
  'c6000000-0000-4000-8000-00000000c001', '{"limit": 3}');
insert into c6_page select 2, public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
  'c6000000-0000-4000-8000-00000000c001',
  jsonb_build_object('limit', 60) || ((select body -> 'next' from c6_page where n = 1)));
select is((select (jsonb_array_length(a.body -> 'events') || '+' || jsonb_array_length(b.body -> 'events'))
             from c6_page a, c6_page b where a.n = 1 and b.n = 2), '3+6',
  'a page of 3, then the rest after its cursor');
select is((select count(*)::int from c6_page p, jsonb_array_elements(p.body -> 'events') e
            group by e ->> 'src', e ->> 'id' having count(*) > 1 limit 1), null,
  'no event shows on both pages');
select is((select body ->> 'next' from c6_page where n = 2), null, 'and the last page has no cursor');
select is(c6_val($$ select public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', '{"before": "2026-01-01T00:00:00Z"}')::text $$),
  '22023', 'a cursor is whole (instant, source and id) or absent');
select c6_as('O');
select is(c6_val($$ select public.crm_contact_timeline('c6000000-0000-4000-8000-0000000000ff',
             'c6000000-0000-4000-8000-00000000c001')::text $$) || ' '
       || c6_val($$ select public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001')::text $$),
  'P0002 P0002', 'another tenant''s Admin gets nothing, whichever tenant it names');
select c6_as('D');
select is(c6_val($$ select public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001')::text $$), 'P0002', 'a Developer gets nothing');
select c6_as('Ad');
select is(c6_val($$ select public.crm_contact_timeline('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001')::text $$), 'P0002', 'nor does a stale token');
reset role;

-- ── 3. Bulk ───────────────────────────────────────────────────────────────────────────────
set local role authenticated;
select c6_as('A');
select is(c6_val($$ select string_agg(outcome || ':' || coalesce(contact_version::text, '-'), ',' order by contact_id)
                      from public.crm_contacts_bulk_update('c6000000-0000-4000-8000-000000000001', 'tagAdd', '"VIP"',
                        '[{"id": "c6000000-0000-4000-8000-00000000c001", "version": 2},
                          {"id": "c6000000-0000-4000-8000-00000000c002", "version": 7},
                          {"id": "c6000000-0000-4000-8000-00000000c0ff", "version": 1},
                          {"id": "c6000000-0000-4000-8000-00000000c0dd", "version": 1}]') $$),
  'applied:3,conflict:1,missing:-,missing:-',
  'a tag at the version read applies; a stale version conflicts; another tenant''s contact and a tombstone are missing');
select is(c6_val($$ select string_agg(outcome || ':' || contact_version, ',')
                      from public.crm_contacts_bulk_update('c6000000-0000-4000-8000-000000000001', 'star', 'true',
                        '[{"id": "c6000000-0000-4000-8000-00000000c001"}]') $$),
  'applied:3', 'a star needs no version and moves none');
select is(c6_val($$ select count(*) from public.crm_contacts_bulk_update('c6000000-0000-4000-8000-000000000001', 'owner',
                        '"c6000000-0000-4000-8000-0000000000d1"', '[{"id": "c6000000-0000-4000-8000-00000000c001", "version": 3}]') $$),
  '23514', 'an owner who is not a contacts user fails the whole change');
select is(c6_val($$ select count(*) from public.crm_contacts_bulk_update('c6000000-0000-4000-8000-000000000001', 'stage',
                        '"vip"', '[{"id": "c6000000-0000-4000-8000-00000000c001", "version": 3}]') $$),
  '22023', 'a stage outside the list is refused');
select c6_as('D');
select is(c6_val($$ select string_agg(outcome, ',') from public.crm_contacts_bulk_update('c6000000-0000-4000-8000-000000000001', 'star', 'true',
                        '[{"id": "c6000000-0000-4000-8000-00000000c001"}]') $$), 'missing', 'a Developer changes nothing');
select c6_as('Ao');
select is(c6_val($$ select string_agg(outcome, ',') from public.crm_contacts_bulk_update('c6000000-0000-4000-8000-000000000001', 'star', 'false',
                        '[{"id": "c6000000-0000-4000-8000-00000000c001"}]') $$), 'missing', 'nor does a switched-off Admin''s token');
reset role;
select is((select array_to_string(tags, ',') || ' ' || is_starred || ' ' || version from public.crm_contacts
            where id = 'c6000000-0000-4000-8000-00000000c001'), 'VIP true 3', 'what applied, applied once (the won rule had moved Huda to version 2)');

-- ── 4. The doors ──────────────────────────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.crm_create_contact(uuid, jsonb, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.crm_create_contact(uuid, jsonb, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_contact_new_lead(uuid, uuid, jsonb, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_contact_link_lead(uuid, uuid, uuid, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_edit_contact_channels(uuid, uuid, integer, jsonb, uuid[], uuid[], uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_delete_contact_note(uuid, uuid, uuid, uuid)', 'execute'),
  'no staff token executes a door: the Worker''s audited routes are the way in');
set local role authenticated;
select c6_as('A');
select is(c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001',
             '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000a1')::text $$), '42501',
  'not even an Admin''s token');
reset role;

set local role service_role;
create temp table c6_made (k text primary key, v jsonb);
grant all on c6_made to service_role;
insert into c6_made select 'new', public.crm_create_contact('c6000000-0000-4000-8000-000000000001',
  jsonb_build_object('display_name', 'Lina Haddad', 'company_name', 'Studio', 'tags', jsonb_build_array('Fair'),
                     'channels', jsonb_build_array(
                       jsonb_build_object('kind', 'email', 'value_enc', 'enc-lina', 'value_hmac', repeat('a', 64)),
                       jsonb_build_object('kind', 'phone', 'value_enc', 'enc-lina-p', 'value_hmac', repeat('b', 64)))),
  'c6000000-0000-4000-8000-0000000000a1');
reset role;
select is((select concat_ws(' ', c.display_name, c.created_by, c.source, array_to_string(c.tags, ','),
                            (select string_agg(ch.kind || ':' || ch.source || ':' || ch.is_primary || ':' || ch.created_by,
                                               ',' order by ch.kind)
                               from public.crm_contact_channels ch where ch.contact_id = c.id))
             from public.crm_contacts c where c.id = ((select v ->> 'id' from c6_made where k = 'new'))::uuid),
  'Lina Haddad c6000000-0000-4000-8000-0000000000a1 manual Fair email:manual:true:c6000000-0000-4000-8000-0000000000a1,phone:manual:true:c6000000-0000-4000-8000-0000000000a1',
  'a contact added by hand: its creator the acting person, its channels marked manual, a primary each');
select is((select string_agg(kind, ',' order by kind) from public.crm_contact_events
            where contact_id = ((select v ->> 'id' from c6_made where k = 'new'))::uuid),
  'channel_added,channel_added,created', 'its timeline starts');
set local role service_role;
select is(c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001',
             jsonb_build_object('display_name', 'Huda Again', 'channels', jsonb_build_array(
               jsonb_build_object('kind', 'email', 'value_enc', 'enc', 'value_hmac', repeat('1', 64)))),
             'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '{"duplicate": "c6000000-0000-4000-8000-00000000c001"}', 'an e-mail another contact holds is a duplicate');
select is(c6_val($$ select count(*) from public.crm_contacts where display_name = 'Huda Again' $$), '0',
  'and nothing was written');
select is(c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001',
             '{"display_name": "X", "email": "x@example.test"}', 'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '22023', 'a field outside the allow-list is refused');
select is(
  c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000d1')::text $$) || ' '
  || c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-000000000051')::text $$) || ' '
  || c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000c1')::text $$) || ' '
  || c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000f1')::text $$) || ' '
  || c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000a2')::text $$) || ' '
  || c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000a3')::text $$) || ' '
  || c6_val($$ select public.crm_create_contact('c6000000-0000-4000-8000-000000000001', '{"display_name": "X"}', 'c6000000-0000-4000-8000-0000000000a4')::text $$),
  '42501 42501 42501 42501 42501 42501 42501',
  'the door refuses an actor who is a Developer, Sales, a Content Creator, another tenant''s Admin, demoted, switched off or locked');

-- Channels.
select is(c6_val($$ select public.crm_edit_contact_channels('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 9, null, null, null, 'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '40001', 'a channel edit at a version that moved on is refused');
select is(c6_val($$ select public.crm_edit_contact_channels('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 1,
             jsonb_build_array(jsonb_build_object('kind', 'email', 'value_enc', 'e', 'value_hmac', repeat('1', 64))),
             null, null, 'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '{"duplicate": "c6000000-0000-4000-8000-00000000c001"}', 'adding an e-mail another contact holds is a duplicate');
select is(c6_val($$ select public.crm_edit_contact_channels('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 1, null,
             array[(select id from public.crm_contact_channels where contact_id = 'c6000000-0000-4000-8000-00000000c001' and kind = 'email')],
             null, 'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '22023', 'another contact''s channel cannot be removed through this one');
select is(c6_val($$ select public.crm_edit_contact_channels('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 1,
             jsonb_build_array(jsonb_build_object('kind', 'phone', 'value_enc', 'e2', 'value_hmac', repeat('c', 64), 'is_primary', true)),
             array[(select id from public.crm_contact_channels where contact_id = 'c6000000-0000-4000-8000-00000000c002' and kind = 'phone')],
             null, 'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '{"added": 1, "removed": 1}', 'a phone swapped');
select is(c6_val($$ select string_agg((value_hmac = repeat('c', 64)) || ':' || is_primary || ':' || source, ',')
                      from public.crm_contact_channels where contact_id = 'c6000000-0000-4000-8000-00000000c002' $$),
  'true:true:manual', 'the new one is the primary, marked manual');
select is(c6_val($$ select detail::text from public.crm_contact_events
                     where contact_id = 'c6000000-0000-4000-8000-00000000c002' and kind = 'channel_removed' $$),
  '{"kind": "phone", "source": "lead"}', 'the removal is on the timeline (kind and source, never the value)');
select is(c6_val($$ select public.crm_edit_contact_channels('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 1, null, null, null, 'c6000000-0000-4000-8000-0000000000d1')::text $$),
  '42501', 'a Developer may not edit channels');

-- A note's deletion (crm.erase).
select is(c6_val($$ select public.crm_delete_contact_note('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 'c6000000-0000-4000-8000-0000000000b1',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), 'P0002', 'a note is deleted only from its own contact');
select is(c6_val($$ select public.crm_delete_contact_note('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', 'c6000000-0000-4000-8000-0000000000b1',
             'c6000000-0000-4000-8000-0000000000a2')::text $$), '42501', 'a demoted Admin may not delete it');
select is(c6_val($$ select public.crm_delete_contact_note('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', 'c6000000-0000-4000-8000-0000000000b1',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), 'c6000000-0000-4000-8000-0000000000b1', 'an Admin may');
select is(c6_val($$ select (select count(*) from public.crm_contact_notes where id = 'c6000000-0000-4000-8000-0000000000b1')
                           || ' ' || (select detail::text from public.crm_contact_events
                                       where contact_id = 'c6000000-0000-4000-8000-00000000c001' and kind = 'note_deleted') $$),
  '0 {"note_id": "c6000000-0000-4000-8000-0000000000b1"}', 'the note is gone; the timeline names its id only');

-- The phone match's check.
select is(c6_val($$ select public.crm_contact_link_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', 'c6000000-0000-4000-8000-00000000aa01', 'confirm',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), '22023', 'only a phone match is confirmed');
select is(c6_val($$ select public.crm_contact_link_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', 'c6000000-0000-4000-8000-00000000aa02', 'confirm',
             'c6000000-0000-4000-8000-0000000000d1')::text $$), '42501', 'a Developer may not confirm one');
select is(c6_val($$ select public.crm_contact_link_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', 'c6000000-0000-4000-8000-00000000aa02', 'confirm',
             'c6000000-0000-4000-8000-0000000000a1')::text $$),
  '{"link": "staff", "email": "added", "phone": "kept"}', 'an Admin confirms Huda''s phone match');
reset role;
select is((select l.contact_link || ' ' || (c.last_activity_at > now() - interval '1 minute') || ' '
                  || (select count(*) from public.crm_contact_channels ch
                       where ch.contact_id = c.id and ch.kind = 'email' and ch.value_hmac = repeat('9', 64))
             from public.leads l join public.crm_contacts c on c.id = l.contact_id
            where l.id = 'c6000000-0000-4000-8000-00000000aa02'),
  'staff true 1', 'a staff link: the lead''s e-mail joins the contact, and its activity is the person''s now');
set local role authenticated;
select c6_as('A');
select is(c6_val($$ select concat_ws(' ', r ->> 'value', r ->> 'score', r ->> 'leads', r ->> 'to_check')
                      from jsonb_array_elements(public.crm_contacts_list('c6000000-0000-4000-8000-000000000001') -> 'rows') r
                     where r ->> 'display_name' = 'Huda Saleh' $$),
  '5000 90 2 0', 'the confirmed lead counts for the person now (score 90; not won, so no value)');
reset role;
set local role service_role;
select is(c6_val($$ select public.crm_contact_link_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002', 'c6000000-0000-4000-8000-00000000aa03', 'detach',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), '{"link": "detached"}', 'a stranger''s phone match is detached');
reset role;
select is((select coalesce(l.contact_id::text, 'none') || ' ' || l.contact_link || ' '
                  || (select count(*) from public.crm_contact_events e
                       where e.kind = 'lead_linked' and e.detail ->> 'lead_id' = l.id::text) || ' '
                  || (select count(*) from public.lead_events e
                       where e.lead_id = l.id and e.kind = 'contact_linked')
             from public.leads l where l.id = 'c6000000-0000-4000-8000-00000000aa03'),
  'none staff 0 0', 'the lead leaves the contact for good, and no line names the pair');
do $$ begin perform public.crm_link_backfill(500); end $$;
select is((select coalesce(contact_id::text, 'none') || ' ' || contact_link from public.leads
            where id = 'c6000000-0000-4000-8000-00000000aa03'), 'none staff',
  'the nightly backfill never links it again');

-- A new lead for a contact.
set local role service_role;
select is(c6_val($$ select public.crm_contact_new_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', '{"id": "c6000000-0000-4000-8000-00000000ab01", "email_enc": "x"}',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), '22023',
  'a contact detail is the door''s to copy, never the caller''s to send');
select is(c6_val($$ select public.crm_contact_new_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001', '{"id": "c6000000-0000-4000-8000-00000000ab01", "name": "Huda", "message": "Rebrand"}',
             'c6000000-0000-4000-8000-0000000000d1')::text $$), '42501',
  'a Developer, who works leads but not contacts, may not');
select is(c6_val($$ select public.crm_contact_new_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c001',
             '{"id": "c6000000-0000-4000-8000-00000000ab01", "name": "Huda", "message": "Rebrand", "channel": "phone", "score_signals": []}',
             'c6000000-0000-4000-8000-0000000000a1') ->> 'link' $$), 'email',
  'an Admin adds one for Huda: her own e-mail links it to her');
reset role;
select is((select concat_ws(' ', l.contact_id, l.email_enc, (l.email_hmac = repeat('1', 64))::text, l.phone_enc,
                            l.source, l.created_by, (l.crm_indexed_at is not null)::text)
             from public.leads l where l.id = 'c6000000-0000-4000-8000-00000000ab01'),
  'c6000000-0000-4000-8000-00000000c001 ciphertext-e true ciphertext-p manual c6000000-0000-4000-8000-0000000000a1 true',
  'the lead carries the contact''s own ciphertext and indexes, copied, and names who added it');
set local role service_role;
select is(c6_val($$ select public.crm_contact_new_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002',
             '{"id": "c6000000-0000-4000-8000-00000000ab02", "name": "Omar", "message": "Video", "channel": "phone", "score_signals": []}',
             'c6000000-0000-4000-8000-0000000000a1') ->> 'link' $$), 'staff',
  'for Omar (a phone only): linked to him by a person, whatever the arrival matched');
reset role;
select is((select l.contact_id || ' ' || l.contact_link || ' '
                  || (select count(*) from public.crm_contact_events e
                       where e.kind = 'lead_linked' and e.detail ->> 'lead_id' = l.id::text
                         and e.contact_id <> l.contact_id)
             from public.leads l where l.id = 'c6000000-0000-4000-8000-00000000ab02'),
  'c6000000-0000-4000-8000-00000000c002 staff 0', 'and no other contact''s timeline names it');
delete from public.crm_contact_channels where contact_id = 'c6000000-0000-4000-8000-00000000c002';
set local role service_role;
select is(c6_val($$ select public.crm_contact_new_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c002',
             '{"id": "c6000000-0000-4000-8000-00000000ab03", "name": "Omar", "message": "Video", "channel": "phone", "score_signals": []}',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), '22023',
  'a contact with no e-mail or phone has nothing to copy');
select is(c6_val($$ select public.crm_contact_new_lead('c6000000-0000-4000-8000-000000000001',
             'c6000000-0000-4000-8000-00000000c0ff',
             '{"id": "c6000000-0000-4000-8000-00000000ab04", "name": "X", "message": "Y", "channel": "phone", "score_signals": []}',
             'c6000000-0000-4000-8000-0000000000a1')::text $$), 'P0002',
  'another tenant''s contact is not found');
reset role;

-- ── 5. Helpers ────────────────────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'app.crm_contacts_with_channel(text, text)', 'execute')
          and not has_function_privilege('authenticated', 'app.crm_staff_link(uuid, uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'app.crm_contacts_actor_ok(uuid, uuid, boolean)', 'execute'),
  'staff reach the blind-index lookup only through a reader, and none of the doors'' helpers');

select * from finish();
rollback;
