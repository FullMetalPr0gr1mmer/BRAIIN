-- pgTAP: contacts' retention from last activity and a person's erasure (0131, Admin v2 C5,
-- crm.md §8). Run with `supabase test db`.
--
--   1. app.run_retention() (as pg_cron runs it) actually deletes contacts idle past their
--      tenant's leads horizon and orphan auto-contacts, and keeps the rest: a contact a
--      person made or edited or starred, one with a lead or a note, a fresh one; a lead of an
--      expired contact stays, unlinked, and is never linked again;
--   2. crm_erase_preview and crm_erase_person: the service role's; the acting profile is
--      checked live (crm.erase: a Developer, a switched-off Admin and another tenant's Admin
--      are refused); a person's leads go (linked by e-mail or with the contact, or carrying
--      its e-mail index), a phone match only when ticked (and only a phone match may be
--      ticked); afterwards nothing references the contact or its e-mail index;
--   3. crm_erase_lead takes an auto-contact the lead leaves with nothing, and only that.

begin;
select plan(29);

insert into public.tenants (id, name) values
  ('c5200000-0000-4000-8000-000000000001', 'C5 keep T1'),
  ('c5200000-0000-4000-8000-0000000000ff', 'C5 keep T2');
insert into auth.users (id, email) values
  ('c5200000-0000-4000-8000-0000000000a1', 'c5k-admin@example.test'),
  ('c5200000-0000-4000-8000-0000000000a3', 'c5k-off@example.test'),
  ('c5200000-0000-4000-8000-0000000000d1', 'c5k-dev@example.test'),
  ('c5200000-0000-4000-8000-0000000000f1', 'c5k-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, display_name) values
  ('c5200000-0000-4000-8000-0000000000a1', 'c5200000-0000-4000-8000-000000000001', 'admin', true, 'Amal'),
  ('c5200000-0000-4000-8000-0000000000a3', 'c5200000-0000-4000-8000-000000000001', 'admin', false, 'Off'),
  ('c5200000-0000-4000-8000-0000000000d1', 'c5200000-0000-4000-8000-000000000001', 'developer', true, 'Dana'),
  ('c5200000-0000-4000-8000-0000000000f1', 'c5200000-0000-4000-8000-0000000000ff', 'admin', true, 'Faris');
-- T2 keeps leads (and so contacts) 12 months; T1 has no settings row: 24 by default.
insert into public.site_settings (tenant_id, retention) values
  ('c5200000-0000-4000-8000-0000000000ff', '{"leads_months": 12}')
  on conflict (tenant_id) do update set retention = excluded.retention;

create function c5k_lead(p_id text, p_email text, p_phone text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id, 'kind', 'contact', 'locale', 'en', 'name', 'Person ' || right(p_id, 2),
    'message', 'Hello', 'consent_marketing', true, 'source', 'web_form',
    'email_enc', 'enc-' || coalesce(p_email, 'none'),
    'email_hmac', case when p_email is not null then repeat(p_email, 64) end,
    'phone_enc', case when p_phone is not null then 'enc-' || p_phone end,
    'phone_hmac', case when p_phone is not null then repeat(p_phone, 64) end,
    'score_signals', '[]'::jsonb))
$$;
create function c5k_contact(p_lead text) returns uuid language sql as $$
  select contact_id from public.leads where id = p_lead::uuid
$$;
grant execute on function c5k_lead(text, text, text) to service_role;

-- ── 1. Retention ──────────────────────────────────────────────────────────────────────────
-- As the migration role (pg_cron's): created_by is kept as given, so "made by a person" is
-- a profile id and "made by the system" null.
insert into public.crm_contacts (id, tenant_id, display_name, created_by, last_activity_at, is_starred) values
  ('c5200000-0000-4000-8000-00000000c001', 'c5200000-0000-4000-8000-000000000001', 'Idle 25 months', 'c5200000-0000-4000-8000-0000000000a1', now() - interval '25 months', false),
  ('c5200000-0000-4000-8000-00000000c002', 'c5200000-0000-4000-8000-000000000001', 'Idle 13 months', 'c5200000-0000-4000-8000-0000000000a1', now() - interval '13 months', false),
  ('c5200000-0000-4000-8000-00000000c003', 'c5200000-0000-4000-8000-000000000001', 'Orphan', null, now(), false),
  ('c5200000-0000-4000-8000-00000000c004', 'c5200000-0000-4000-8000-000000000001', 'Orphan, edited', null, now(), false),
  ('c5200000-0000-4000-8000-00000000c005', 'c5200000-0000-4000-8000-000000000001', 'Orphan, starred', null, now(), true),
  ('c5200000-0000-4000-8000-00000000c006', 'c5200000-0000-4000-8000-000000000001', 'Auto, with a note', null, now(), false),
  ('c5200000-0000-4000-8000-00000000c007', 'c5200000-0000-4000-8000-000000000001', 'Idle, with a lead', null, now() - interval '25 months', false),
  ('c5200000-0000-4000-8000-00000000c0f1', 'c5200000-0000-4000-8000-0000000000ff', 'T2 idle 13 months', 'c5200000-0000-4000-8000-0000000000f1', now() - interval '13 months', false);
update public.crm_contacts set title = 'Owner' where id = 'c5200000-0000-4000-8000-00000000c004';
-- A merge tombstone (C12's shape): it goes with the contact it was merged into.
insert into public.crm_contacts (id, tenant_id, display_name, created_by, merged_into, merged_at) values
  ('c5200000-0000-4000-8000-00000000c008', 'c5200000-0000-4000-8000-000000000001', 'Tombstone',
   'c5200000-0000-4000-8000-0000000000a1', 'c5200000-0000-4000-8000-00000000c001', now());
insert into public.crm_contact_notes (tenant_id, contact_id, body) values
  ('c5200000-0000-4000-8000-000000000001', 'c5200000-0000-4000-8000-00000000c006', 'Kept for this');
-- The note and the link are activity: put both back where the fixture says.
update public.crm_contacts set last_activity_at = now() - interval '25 months'
 where id = 'c5200000-0000-4000-8000-00000000c007';
insert into public.leads (id, tenant_id, name, email_enc, message, contact_id, contact_link) values
  ('c5200000-0000-4000-8000-00000000ab07', 'c5200000-0000-4000-8000-000000000001', 'Lead of an idle contact',
   'enc', 'hi', 'c5200000-0000-4000-8000-00000000c007', 'new');
update public.crm_contacts set last_activity_at = now() - interval '25 months'
 where id = 'c5200000-0000-4000-8000-00000000c007';

select is((app.run_retention() ->> 'contacts_purged')::int, 4,
  'the nightly run purges four contacts and says so');
select is(
  (select string_agg(display_name, ', ' order by display_name) from public.crm_contacts
    where tenant_id in ('c5200000-0000-4000-8000-000000000001', 'c5200000-0000-4000-8000-0000000000ff')),
  'Auto, with a note, Idle 13 months, Orphan, edited, Orphan, starred',
  'gone: idle past the horizon (25 months in T1, 13 in T2''s 12), the untouched orphan, the idle one with a lead; kept: the rest');
select is((select count(*)::int from public.crm_contacts where id = 'c5200000-0000-4000-8000-00000000c008'), 0,
  'a tombstone went with the contact it was merged into');
select is(
  (select coalesce(contact_id::text, 'none') || ' ' || contact_link from public.leads
    where id = 'c5200000-0000-4000-8000-00000000ab07'),
  'none new', 'an expired contact''s lead stays, unlinked, and remembers it was linked');
select is((select count(*)::int from public.crm_contact_events
            where contact_id in ('c5200000-0000-4000-8000-00000000c001', 'c5200000-0000-4000-8000-00000000c003'))
          + (select count(*)::int from public.crm_contact_notes
              where contact_id in ('c5200000-0000-4000-8000-00000000c001', 'c5200000-0000-4000-8000-00000000c003')),
  0, 'their timelines and notes went with them');
select ok(
  (select detail ? 'contacts_purged' from public.system_logs
    where source = 'retention' order by created_at desc, id desc limit 1),
  'the run''s summary row counts the contacts');

-- ── 2. A person's erasure ─────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.crm_erase_preview(uuid, uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.crm_erase_person(uuid, uuid, uuid[], uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_erase_preview(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_erase_person(uuid, uuid, uuid[], uuid)', 'execute')
  and not has_function_privilege('anon', 'public.crm_erase_preview(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.crm_erase_person(uuid, uuid, uuid[], uuid)', 'execute'),
  'the erasure doors are the service role''s alone');

-- The person: e1 (address a, phone 7) makes the contact; e2 (a) joins by e-mail; e3 (b, 7)
-- links by phone, flagged; e5 (d, 7) is a phone match never linked; e6 (a) carries the
-- address but never linked (no index time); e9 (c, 8) is someone else. (A blind index is
-- 64 hex characters, so each fixture index repeats one hex digit.)
set local role service_role;
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000e1', 'a', '7'));
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000e2', 'a', null));
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000e3', 'b', '7'));
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000e9', 'c', '8'));
reset role;
insert into public.leads (id, tenant_id, name, email_enc, message, email_hmac, phone_hmac) values
  ('c5200000-0000-4000-8000-0000000000e5', 'c5200000-0000-4000-8000-000000000001', 'Shared line', 'enc-d', 'hi', repeat('d', 64), repeat('7', 64)),
  ('c5200000-0000-4000-8000-0000000000e6', 'c5200000-0000-4000-8000-000000000001', 'Same address', 'enc-a', 'hi', repeat('a', 64), null);
insert into public.lead_notes (tenant_id, lead_id, body, source) values
  ('c5200000-0000-4000-8000-000000000001', 'c5200000-0000-4000-8000-0000000000e1', 'A lead note', 'staff');
insert into public.crm_contact_notes (tenant_id, contact_id, body) values
  ('c5200000-0000-4000-8000-000000000001', c5k_contact('c5200000-0000-4000-8000-0000000000e1'), 'A contact note');
select is(
  (select string_agg(coalesce(contact_link, '-'), ' ' order by id) from public.leads
    where id in ('c5200000-0000-4000-8000-0000000000e1', 'c5200000-0000-4000-8000-0000000000e2',
                 'c5200000-0000-4000-8000-0000000000e3', 'c5200000-0000-4000-8000-0000000000e5',
                 'c5200000-0000-4000-8000-0000000000e6')),
  'new email phone - -', 'the fixture: made, joined by e-mail, linked by phone, two never linked');

set local role service_role;
select throws_ok(
  format($$ select public.crm_erase_preview('c5200000-0000-4000-8000-000000000001', %L,
              'c5200000-0000-4000-8000-0000000000d1') $$, c5k_contact('c5200000-0000-4000-8000-0000000000e1')),
  '42501', null, 'a Developer (no crm.erase) is refused by the door itself');
select throws_ok(
  format($$ select public.crm_erase_preview('c5200000-0000-4000-8000-000000000001', %L,
              'c5200000-0000-4000-8000-0000000000a3') $$, c5k_contact('c5200000-0000-4000-8000-0000000000e1')),
  '42501', null, 'so is a switched-off Admin');
select throws_ok(
  format($$ select public.crm_erase_person('c5200000-0000-4000-8000-000000000001', %L, '{}',
              'c5200000-0000-4000-8000-0000000000f1') $$, c5k_contact('c5200000-0000-4000-8000-0000000000e1')),
  '42501', null, 'and another tenant''s Admin');
select throws_ok(
  $$ select public.crm_erase_preview('c5200000-0000-4000-8000-000000000001',
       'c5200000-0000-4000-8000-00000000c0f1', 'c5200000-0000-4000-8000-0000000000a1') $$,
  'P0002', null, 'another tenant''s contact is not found');

select is(
  (select p - 'phone_matches' from public.crm_erase_preview('c5200000-0000-4000-8000-000000000001',
            c5k_contact('c5200000-0000-4000-8000-0000000000e1'), 'c5200000-0000-4000-8000-0000000000a1') p),
  '{"leads": 3, "notes": 1, "channels": 2, "unindexed": 3}'::jsonb,
  'the preview counts the person''s three leads (e1, e2, e6), its two channels and its note, and the tenant''s leads not indexed yet (ab07, e5, e6), which no erasure can compare');
select is(
  (select string_agg((m ->> 'id') || ':' || (m ->> 'linked'), ' ' order by m ->> 'id')
     from public.crm_erase_preview('c5200000-0000-4000-8000-000000000001',
            c5k_contact('c5200000-0000-4000-8000-0000000000e1'), 'c5200000-0000-4000-8000-0000000000a1') p,
          jsonb_array_elements(p -> 'phone_matches') m),
  'c5200000-0000-4000-8000-0000000000e3:true c5200000-0000-4000-8000-0000000000e5:false',
  'and lists the phone matches for the Admin to tick: the flagged link and the unlinked one');
select ok(
  (select bool_and(not (m ? 'email_enc') and not (m ? 'phone_enc') and not (m ? 'email_hmac'))
     from public.crm_erase_preview('c5200000-0000-4000-8000-000000000001',
            c5k_contact('c5200000-0000-4000-8000-0000000000e1'), 'c5200000-0000-4000-8000-0000000000a1') p,
          jsonb_array_elements(p -> 'phone_matches') m),
  'the matches carry lead columns staff read anyway, never contact details');
select throws_ok(
  format($$ select public.crm_erase_person('c5200000-0000-4000-8000-000000000001', %L,
              array['c5200000-0000-4000-8000-0000000000e9']::uuid[], 'c5200000-0000-4000-8000-0000000000a1') $$,
         c5k_contact('c5200000-0000-4000-8000-0000000000e1')),
  '22023', null, 'only a phone match may be ticked: this door erases no other lead');
reset role;
select is((select count(*)::int from public.leads where id = 'c5200000-0000-4000-8000-0000000000e9'), 1,
  'and the refusal erased nothing');

create temp table c5k_person as
  select c5k_contact('c5200000-0000-4000-8000-0000000000e1') as contact_id;
grant select on c5k_person to service_role;
set local role service_role;
select is(
  public.crm_erase_person('c5200000-0000-4000-8000-000000000001', (select contact_id from c5k_person),
    array['c5200000-0000-4000-8000-0000000000e5']::uuid[], 'c5200000-0000-4000-8000-0000000000a1')
    - 'lead_events',
  '{"contacts": 1, "leads": 3, "phone_leads": 1, "lead_notes": 1, "link_lines": 1, "channels": 2, "notes": 1, "events": 7, "unindexed": 1}'::jsonb,
  'an Admin erases the person: three leads, the ticked phone match, the unticked one''s link line, the contact, its channels, note and timeline; one lead it could not check is left (ab07)');
reset role;
select is(
  (select string_agg(id::text, ' ' order by id) from public.leads
    where id in ('c5200000-0000-4000-8000-0000000000e1', 'c5200000-0000-4000-8000-0000000000e2',
                 'c5200000-0000-4000-8000-0000000000e3', 'c5200000-0000-4000-8000-0000000000e5',
                 'c5200000-0000-4000-8000-0000000000e6', 'c5200000-0000-4000-8000-0000000000e9')),
  'c5200000-0000-4000-8000-0000000000e3 c5200000-0000-4000-8000-0000000000e9',
  'left: the unticked phone match and someone else''s lead');
select is(
  (select coalesce(contact_id::text, 'none') || ' ' || contact_link from public.leads
    where id = 'c5200000-0000-4000-8000-0000000000e3'),
  'none phone', 'the unticked match is unlinked, not erased');
select is(
  (select count(*)::int from public.crm_contacts where id = (select contact_id from c5k_person))
  + (select count(*)::int from public.crm_contact_channels where contact_id = (select contact_id from c5k_person))
  + (select count(*)::int from public.crm_contact_notes where contact_id = (select contact_id from c5k_person))
  + (select count(*)::int from public.crm_contact_events where contact_id = (select contact_id from c5k_person))
  + (select count(*)::int from public.leads where contact_id = (select contact_id from c5k_person))
  + (select count(*)::int from public.lead_events where detail ->> 'contact_id' = (select contact_id from c5k_person)::text),
  0, 'nothing references the contact any more');
select is(
  (select count(*)::int from public.leads
    where tenant_id = 'c5200000-0000-4000-8000-000000000001' and email_hmac = repeat('a', 64))
  + (select count(*)::int from public.crm_contact_channels
      where tenant_id = 'c5200000-0000-4000-8000-000000000001' and value_hmac = repeat('a', 64)),
  0, 'nor its e-mail index');
select is(
  (select count(*)::int from public.lead_notes where lead_id = 'c5200000-0000-4000-8000-0000000000e1')
  + (select count(*)::int from public.lead_events
      where lead_id in ('c5200000-0000-4000-8000-0000000000e1', 'c5200000-0000-4000-8000-0000000000e5')),
  0, 'the erased leads'' notes and timelines went with them');
set local role service_role;
select throws_ok(
  $$ select public.crm_erase_person('c5200000-0000-4000-8000-000000000001',
       (select contact_id from c5k_person), '{}', 'c5200000-0000-4000-8000-0000000000a1') $$,
  'P0002', null, 'erasing again finds no one');
reset role;

-- ── 3. A lead's erasure takes its orphaned auto-contact ────────────────────────────────────
set local role service_role;
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000f5', 'e', null));
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000f6', 'f', null));
select public.crm_ingest_lead('c5200000-0000-4000-8000-000000000001', c5k_lead('c5200000-0000-4000-8000-0000000000f7', 'f', null));
reset role;
create temp table c5k_auto as
  select c5k_contact('c5200000-0000-4000-8000-0000000000f5') as solo,
         c5k_contact('c5200000-0000-4000-8000-0000000000f6') as shared;
grant select on c5k_auto to service_role;
set local role service_role;
select is(
  public.crm_erase_lead('c5200000-0000-4000-8000-000000000001', 'c5200000-0000-4000-8000-0000000000f5',
                        'c5200000-0000-4000-8000-0000000000a1') ->> 'contacts',
  '1', 'erasing a contact''s only lead takes the auto-contact (its channels copy the lead)');
select is(
  public.crm_erase_lead('c5200000-0000-4000-8000-000000000001', 'c5200000-0000-4000-8000-0000000000f6',
                        'c5200000-0000-4000-8000-0000000000a1') ->> 'contacts',
  '0', 'a contact with another lead stays');
reset role;
select is(
  (select count(*)::int from public.crm_contacts where id = (select solo from c5k_auto)) || ' '
  || (select count(*)::int from public.crm_contacts where id = (select shared from c5k_auto)),
  '0 1', 'the orphan is gone, the other contact kept');
update public.crm_contacts set title = 'Edited' where id = (select shared from c5k_auto);
set local role service_role;
select is(
  public.crm_erase_lead('c5200000-0000-4000-8000-000000000001', 'c5200000-0000-4000-8000-0000000000f7',
                        'c5200000-0000-4000-8000-0000000000a1') ->> 'contacts',
  '0', 'a contact a person edited stays when its last lead goes (retention or a person''s erasure decides)');
reset role;
select is(
  (select count(*)::int from public.crm_contact_channels where contact_id = (select shared from c5k_auto)),
  0, 'but the erased lead''s e-mail, which no lead of the person still carries, leaves it');

select * from finish();
rollback;
