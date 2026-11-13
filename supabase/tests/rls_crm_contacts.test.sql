-- pgTAP: the contacts' authorization layer (0131, Admin v2 C5, crm.md §3 and §5.1). Run with
-- `supabase test db`.
--
-- crm.contacts is Admin's in C5, and Sales' too since C10b (Developer none, owner default
-- O-7; Sales' own reads, writes and stale tokens are proven in crm_sales_contacts.test.sql,
-- here it reads as an Admin does). Personas, each a token as PostgREST carries it: A admin,
-- C content_creator, S seo, D developer, L sales, O another tenant's admin, N anon; stale
-- Admin tokens Ad (the profile now says content_creator), Ao (switched off), Al (locked).
-- Proven here:
--   1. reads: only a live Admin (or, since C10b, Sales) of the tenant reads contacts,
--      channels (the safe columns, never the value or its index) and events; nobody reads
--      notes through the API;
--   2. writes: a live Admin changes a contact's details (the column grant; the version moves,
--      the person and the time are the session's, the timeline names the fields); nobody
--      else, stale tokens included, changes a row; nobody inserts or deletes a contact or
--      writes a channel, note or event; the activity time, the version and the stamps are
--      not writable; a star is not an edit;
--   3. the owner rule and the composite keys: an owner must be an active contacts user of
--      the tenant; a channel, a note or a lead cannot point at another tenant's contact;
--   4. leads: lead workers read the link, nobody writes it through the API; leads_safe
--      carries it.

begin;
select plan(42);

insert into public.tenants (id, name) values
  ('c5000000-0000-4000-8000-000000000001', 'C5 T1'),
  ('c5000000-0000-4000-8000-0000000000ff', 'C5 T2');

create table c5_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                         profile_role text, active boolean, locked boolean);
insert into c5_persona values
  ('A',  'c5000000-0000-4000-8000-0000000000a1', 'admin',           'c5000000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c5000000-0000-4000-8000-0000000000c1', 'content_creator', 'c5000000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c5000000-0000-4000-8000-0000000000e1', 'seo',             'c5000000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c5000000-0000-4000-8000-0000000000d1', 'developer',       'c5000000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c5000000-0000-4000-8000-000000000051', 'sales',           'c5000000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c5000000-0000-4000-8000-0000000000f1', 'admin',           'c5000000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c5000000-0000-4000-8000-0000000000a2', 'admin',           'c5000000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c5000000-0000-4000-8000-0000000000a3', 'admin',           'c5000000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c5000000-0000-4000-8000-0000000000a4', 'admin',           'c5000000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c5-' || lower(code) || '@example.test' from c5_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C5 ' || code
    from c5_persona;

-- A contact in each tenant (as the migration role, as the link would make one), with an
-- e-mail and a phone, a note, and a lead linked to the first. Its activity is set in the past
-- so a change that counts as activity shows.
insert into public.crm_contacts (id, tenant_id, display_name, company_name, last_activity_at) values
  ('c5000000-0000-4000-8000-00000000c001', 'c5000000-0000-4000-8000-000000000001', 'Huda Saleh', 'Acme', now() - interval '3 days'),
  ('c5000000-0000-4000-8000-00000000c0ff', 'c5000000-0000-4000-8000-0000000000ff', 'Other Person', null, now());
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary) values
  ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001', 'email', 'ciphertext-e', repeat('1', 64), true),
  ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001', 'phone', 'ciphertext-p', repeat('2', 64), true),
  ('c5000000-0000-4000-8000-0000000000ff', 'c5000000-0000-4000-8000-00000000c0ff', 'email', 'ciphertext-o', repeat('1', 64), true);
insert into public.crm_contact_notes (tenant_id, contact_id, body) values
  ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001', 'Met at the fair');
insert into public.leads (id, tenant_id, name, email_enc, message) values
  ('c5000000-0000-4000-8000-00000000aa01', 'c5000000-0000-4000-8000-000000000001', 'Huda', 'ciphertext-e', 'hello');
update public.leads set contact_id = 'c5000000-0000-4000-8000-00000000c001', contact_link = 'email'
 where id = 'c5000000-0000-4000-8000-00000000aa01';
-- The note moved the activity to now; put it back in the past for section 2.
update public.crm_contacts set last_activity_at = now() - interval '3 days'
 where id = 'c5000000-0000-4000-8000-00000000c001';

create function c5_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c5_persona p where p.code = p_code), ''), true)
$$;
-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function c5_run(p_sql text) returns text language plpgsql as $$
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
create function c5_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- What the current token reads: contacts/channels/events/notes.
create function c5_reads() returns text language sql as $$
  select c5_val('select count(*) from public.crm_contacts') || '/'
      || c5_val('select count(*) from public.crm_contact_channels') || '/'
      || c5_val('select count(*) from public.crm_contact_events') || '/'
      || c5_val('select count(*) from public.crm_contact_notes')
$$;
grant execute on function c5_as(text), c5_run(text), c5_val(text), c5_reads() to anon, authenticated;
grant select on c5_persona to anon, authenticated;

-- ── 1. Reads ──────────────────────────────────────────────────────────────────────────────
-- T1's contact has 5 events: created, two channels added, the note, the lead linked.
select is((select count(*)::int from public.crm_contact_events
            where contact_id = 'c5000000-0000-4000-8000-00000000c001'), 5,
  'the triggers wrote the fixture contact''s timeline: created, two channels, a note, a lead linked');

set local role authenticated;
select c5_as('A');
select is(c5_reads(), '1/2/5/42501', 'a live Admin reads the tenant''s contact, its channels and timeline; notes only through the audited door');
select is(c5_val($$ select value_enc from public.crm_contact_channels limit 1 $$), '42501',
  'not a channel''s ciphertext');
select is(c5_val($$ select value_hmac from public.crm_contact_channels limit 1 $$), '42501',
  'nor its blind index');
select is(c5_val($$ select string_agg(kind || ':' || is_primary, ',' order by kind) from public.crm_contact_channels $$),
  'email:true,phone:true', 'only whether a channel exists, of which kind');
select c5_as('C');
select is(c5_reads(), '0/0/0/42501', 'a Content Creator reads no contact');
select c5_as('S');
select is(c5_reads(), '0/0/0/42501', 'SEO reads no contact');
select c5_as('D');
select is(c5_reads(), '0/0/0/42501', 'a Developer reads no contact (owner default O-7)');
select c5_as('L');
select is(c5_reads(), '1/2/5/42501', 'Sales reads the contact, its channels and timeline as an Admin does (C10b), notes neither');
select c5_as('O');
select is(c5_reads(), '1/1/2/42501', 'another tenant''s Admin reads only its own tenant''s contact');
select c5_as('Ad');
select is(c5_reads(), '0/0/0/42501', 'a demoted Admin''s token reads nothing (the live check)');
select c5_as('Ao');
select is(c5_reads(), '0/0/0/42501', 'a switched-off Admin''s token reads nothing');
select c5_as('Al');
select is(c5_reads(), '0/0/0/42501', 'a locked Admin''s token reads nothing');
reset role;
set local role anon;
select c5_as('N');
select is(c5_reads(), '42501/42501/42501/42501', 'anon holds no privilege on any of the four');
reset role;

-- ── 2. Writes ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
select c5_as('A');
select is(c5_run($$ update public.crm_contacts set title = 'Founder', is_starred = false
                    where id = 'c5000000-0000-4000-8000-00000000c001' and version = 1 $$), 'ok:1',
  'a live Admin changes a contact''s details at the version it read');
reset role;
select is((select version || ' ' || updated_by || ' ' || (updated_at > now() - interval '1 minute')
                  || ' ' || (last_activity_at < now() - interval '2 days')
             from public.crm_contacts where id = 'c5000000-0000-4000-8000-00000000c001'),
  '2 c5000000-0000-4000-8000-0000000000a1 true true',
  'the version moved, the edit is the session''s, and a detail edit is no activity');
select is((select detail::text from public.crm_contact_events
            where contact_id = 'c5000000-0000-4000-8000-00000000c001' and kind = 'details_changed'),
  '{"fields": ["title"]}', 'the timeline names the field, never the value');
set local role authenticated;
select c5_as('A');
select is(c5_run($$ update public.crm_contacts set title = 'Again'
                    where id = 'c5000000-0000-4000-8000-00000000c001' and version = 1 $$), 'ok:0',
  'a save at the old version matches nothing (the Worker answers 409)');
select is(c5_run($$ update public.crm_contacts set is_starred = true
                    where id = 'c5000000-0000-4000-8000-00000000c001' $$), 'ok:1', 'a star');
select is(c5_val($$ select version from public.crm_contacts where id = 'c5000000-0000-4000-8000-00000000c001' $$),
  '2', 'is not an edit: the version stays');
select is(c5_run($$ update public.crm_contacts set stage = 'client'
                    where id = 'c5000000-0000-4000-8000-00000000c001' $$), 'ok:1', 'a stage change');
reset role;
select is((select (last_activity_at > now() - interval '1 minute')::text || ' '
                  || (select detail::text from public.crm_contact_events
                       where contact_id = c.id and kind = 'stage_changed')
             from public.crm_contacts c where c.id = 'c5000000-0000-4000-8000-00000000c001'),
  'true {"to": "client", "from": "lead"}', 'is activity, and the timeline says from and to');
set local role authenticated;
select c5_as('A');
select is(
  c5_run($$ update public.crm_contacts set last_activity_at = now() + interval '1 year' $$) || ' '
  || c5_run($$ update public.crm_contacts set version = 9 $$) || ' '
  || c5_run($$ update public.crm_contacts set created_by = null $$) || ' '
  || c5_run($$ update public.crm_contacts set tenant_id = 'c5000000-0000-4000-8000-0000000000ff' $$),
  '42501 42501 42501 42501', 'the activity time, the version, the stamps and the tenant are not writable');
select is(
  c5_run($$ insert into public.crm_contacts (display_name) values ('New') $$) || ' '
  || c5_run($$ delete from public.crm_contacts $$) || ' '
  || c5_run($$ insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
              values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001',
                      'phone', 'x', repeat('3', 64)) $$) || ' '
  || c5_run($$ update public.crm_contact_channels set is_primary = false $$) || ' '
  || c5_run($$ delete from public.crm_contact_channels $$) || ' '
  || c5_run($$ insert into public.crm_contact_notes (tenant_id, contact_id, body)
              values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001', 'x') $$) || ' '
  || c5_run($$ insert into public.crm_contact_events (tenant_id, contact_id, kind)
              values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001', 'created') $$) || ' '
  || c5_run($$ delete from public.crm_contact_events $$),
  '42501 42501 42501 42501 42501 42501 42501 42501',
  'not even an Admin inserts or deletes a contact, or writes a channel, a note or an event, through the API');

-- Everyone else changes nothing: no row matches (RLS), and the stale tokens fail the live check.
-- (Sales does change one since C10b: crm_sales_contacts.test.sql.)
create temp table c5_upd (who text, res text);
grant insert, select on c5_upd to authenticated;
select c5_as('C');
insert into c5_upd select 'C', c5_run($$ update public.crm_contacts set title = 'x' $$);
select c5_as('S');
insert into c5_upd select 'S', c5_run($$ update public.crm_contacts set title = 'x' $$);
select c5_as('D');
insert into c5_upd select 'D', c5_run($$ update public.crm_contacts set title = 'x' $$);
select c5_as('O');
insert into c5_upd select 'O', c5_run($$ update public.crm_contacts set title = 'x'
                                           where id = 'c5000000-0000-4000-8000-00000000c001' $$);
select c5_as('Ad');
insert into c5_upd select 'Ad', c5_run($$ update public.crm_contacts set title = 'x' $$);
select c5_as('Ao');
insert into c5_upd select 'Ao', c5_run($$ update public.crm_contacts set title = 'x' $$);
select c5_as('Al');
insert into c5_upd select 'Al', c5_run($$ update public.crm_contacts set title = 'x' $$);
select is((select string_agg(who || '=' || res, ' ' order by who) from c5_upd),
  'Ad=ok:0 Al=ok:0 Ao=ok:0 C=ok:0 D=ok:0 O=ok:0 S=ok:0',
  'no other principal, and no stale Admin token, changes a contact');
reset role;
set local role anon;
select c5_as('N');
select is(c5_run($$ update public.crm_contacts set title = 'x' $$), '42501', 'anon cannot try');
reset role;
select is((select title from public.crm_contacts where id = 'c5000000-0000-4000-8000-00000000c001'),
  'Founder', 'and the contact is as the live Admin left it');

-- ── 3. The owner rule and the composite keys ─────────────────────────────────────────────
set local role authenticated;
select c5_as('A');
select is(c5_run($$ update public.crm_contacts set owner_id = 'c5000000-0000-4000-8000-0000000000d1'
                    where id = 'c5000000-0000-4000-8000-00000000c001' $$), '23514',
  'an owner without crm.contacts (a Developer) is refused, naming the rule');
select is(c5_run($$ update public.crm_contacts set owner_id = 'c5000000-0000-4000-8000-0000000000a3'
                    where id = 'c5000000-0000-4000-8000-00000000c001' $$), '23514',
  'so is a switched-off Admin');
select is(c5_run($$ update public.crm_contacts set owner_id = 'c5000000-0000-4000-8000-0000000000f1'
                    where id = 'c5000000-0000-4000-8000-00000000c001' $$), '23514',
  'and another tenant''s Admin');
select is(c5_run($$ update public.crm_contacts set owner_id = 'c5000000-0000-4000-8000-0000000000a1'
                    where id = 'c5000000-0000-4000-8000-00000000c001' $$), 'ok:1',
  'a live Admin of the tenant may own it');
reset role;
select is((select detail ->> 'to' from public.crm_contact_events
            where contact_id = 'c5000000-0000-4000-8000-00000000c001' and kind = 'owner_changed'),
  'c5000000-0000-4000-8000-0000000000a1', 'the timeline names the new owner by id');
set local role service_role;
select is(c5_run($$ insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
                    values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c0ff',
                            'phone', 'x', repeat('4', 64)) $$), '23503',
  'even the service role cannot hang a channel in one tenant on another tenant''s contact');
select is(c5_run($$ insert into public.crm_contact_notes (tenant_id, contact_id, body)
                    values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c0ff', 'x') $$), '23503',
  'nor a note');
select is(c5_run($$ update public.leads set contact_id = 'c5000000-0000-4000-8000-00000000c0ff', contact_link = 'staff'
                    where id = 'c5000000-0000-4000-8000-00000000aa01' $$), '23503',
  'nor link a lead to another tenant''s contact');
select is(c5_run($$ insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
                    values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001',
                            'email', 'x', repeat('1', 64)) $$), '23505',
  'one e-mail, one person: the same address cannot be added twice in a tenant');
select is(c5_run($$ insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
                    values ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-00000000c001',
                            'phone', 'x', 'not-an-index') $$), '23514',
  'a channel''s index has the blind index''s shape');
reset role;

-- ── 4. Leads: the link ──────────────────────────────────────────────────────────────────────
set local role authenticated;
select c5_as('D');
select is(c5_val($$ select contact_id || ' ' || contact_link from public.leads
                     where id = 'c5000000-0000-4000-8000-00000000aa01' $$),
  'c5000000-0000-4000-8000-00000000c001 email', 'a lead worker reads which contact a lead is linked to, and how');
select is(c5_val($$ select contact_link from public.leads_safe
                     where id = 'c5000000-0000-4000-8000-00000000aa01' $$),
  'email', 'and leads_safe carries it');
select is(c5_run($$ update public.leads set contact_id = null where id = 'c5000000-0000-4000-8000-00000000aa01' $$)
          || ' ' || c5_run($$ update public.leads set contact_link = 'staff' where id = 'c5000000-0000-4000-8000-00000000aa01' $$),
  '42501 42501', 'but writes neither through the API (C6''s)');
select c5_as('A');
select is(c5_run($$ update public.leads set contact_id = null where id = 'c5000000-0000-4000-8000-00000000aa01' $$),
  '42501', 'nor does an Admin');
select c5_as('C');
select is(c5_val($$ select count(*) from public.leads where contact_id is not null $$), '0',
  'a Content Creator reads no lead, linked or not');
reset role;

select * from finish();
rollback;
