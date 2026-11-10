-- pgTAP: what keeps an auto-contact, and what a phone link may do (0131, Admin v2 C5, the
-- C5 review: C5-SEC-1, C5-COR-1, C5-COR-2, C5-SEC-2, C5-SEC-3, C5-SEC-5). Run with
-- `supabase test db`.
--
--   1. the system's own writes (the owner filled from the assignment rule, the won rule) do
--      not make an auto-contact "edited by a person", so erasing its lead, or the spam
--      purge, still takes it; a stranger's lead linked by phone does not keep it either, and
--      keeps no link line naming it;
--   2. a person's edit keeps the contact, but not the erased lead's copied details or a
--      timeline line naming that lead;
--   3. the won rule is not activity: an old won lead backfilled keeps its arrival as its
--      contact's last activity; a person's stage change still is;
--   4. a lead linked by phone alone is not the contact's activity, and its moves, notes,
--      win and assignee do not change the contact, until a person confirms the link (C6);
--   5. erasing a person removes the line another contact's timeline kept for one of the
--      person's leads;
--   6. no API role holds a privilege on the events' identity sequence;
--   7. staff_edited: set by a person's edit only, never by the system's, and no staff
--      token writes it.

begin;
select plan(26);

insert into public.tenants (id, name) values
  ('c5300000-0000-4000-8000-000000000001', 'C5 orphans T1');
insert into auth.users (id, email) values
  ('c5300000-0000-4000-8000-0000000000a1', 'c5o-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, display_name) values
  ('c5300000-0000-4000-8000-0000000000a1', 'c5300000-0000-4000-8000-000000000001', 'admin', true, 'Amal');
insert into public.crm_settings (tenant_id) values ('c5300000-0000-4000-8000-000000000001')
  on conflict (tenant_id) do nothing;
-- app.purge_leads walks the site_settings rows (0008), so the spam purge below needs one.
insert into public.site_settings (tenant_id, retention) values
  ('c5300000-0000-4000-8000-000000000001', '{"leads_months": 24}')
  on conflict (tenant_id) do update set retention = excluded.retention;

-- A lead as the Worker sends it. A blind index is 64 hex characters: each fixture index
-- repeats a two-digit hex pair.
create function c5o_lead(p_id text, p_email text, p_phone text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id, 'kind', 'contact', 'locale', 'en', 'name', 'Person ' || right(p_id, 4),
    'message', 'Hello', 'consent_marketing', true, 'source', 'web_form',
    'email_enc', 'enc-' || coalesce(p_email, 'none'),
    'email_hmac', case when p_email is not null then repeat(p_email, 32) end,
    'phone_enc', case when p_phone is not null then 'enc-' || p_phone end,
    'phone_hmac', case when p_phone is not null then repeat(p_phone, 32) end,
    'score_signals', '[]'::jsonb))
$$;
create function c5o_ingest(p_lead jsonb) returns uuid language sql as $$
  select public.crm_ingest_lead('c5300000-0000-4000-8000-000000000001', p_lead)
$$;
create function c5o_erase(p_lead text) returns jsonb language sql as $$
  select public.crm_erase_lead('c5300000-0000-4000-8000-000000000001', p_lead::uuid,
                               'c5300000-0000-4000-8000-0000000000a1')
$$;
create function c5o_contact(p_lead text) returns uuid language sql as $$
  select contact_id from public.leads where id = p_lead::uuid
$$;
create function c5o_run(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;
grant execute on function c5o_lead(text, text, text), c5o_ingest(jsonb), c5o_erase(text), c5o_run(text)
  to service_role, authenticated;
-- Contact ids, kept before their leads go.
create temp table c5o_ids (k text primary key, id uuid);
grant select on c5o_ids to service_role, authenticated;
create function c5o_won() returns uuid language sql as $$
  select id from public.lead_stages
   where tenant_id = 'c5300000-0000-4000-8000-000000000001' and kind = 'won' order by sort_order, id limit 1
$$;

-- ── 1. The system's writes do not keep an auto-contact ──────────────────────────────────────
-- The assignment rule names the Admin, so the owner is filled at arrival.
update public.crm_settings set assignment_rule = 'fixed',
       assignment_fixed_to = 'c5300000-0000-4000-8000-0000000000a1'
 where tenant_id = 'c5300000-0000-4000-8000-000000000001';
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab01', '11', '12'));
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab02', '21', null));
reset role;
insert into c5o_ids values ('ab01', c5o_contact('c5300000-0000-4000-8000-00000000ab01')),
                           ('ab02', c5o_contact('c5300000-0000-4000-8000-00000000ab02'));
select is(
  (select coalesce(owner_id::text, 'none') from public.crm_contacts where id = (select id from c5o_ids where k = 'ab01')),
  'c5300000-0000-4000-8000-0000000000a1', 'the fixture: the assigned Admin fills the auto-contact''s owner');
set local role service_role;
select is(c5o_erase('c5300000-0000-4000-8000-00000000ab01') ->> 'contacts', '1',
  'erasing its only lead still takes the auto-contact: the owner fill is no person''s edit');
reset role;
select is(
  (select count(*)::int from public.crm_contacts
    where tenant_id = 'c5300000-0000-4000-8000-000000000001' and display_name = 'Person ab01')
  + (select count(*)::int from public.crm_contact_channels
      where tenant_id = 'c5300000-0000-4000-8000-000000000001'
        and value_hmac in (repeat('11', 32), repeat('12', 32))),
  0, 'no name, e-mail or phone of the erased lead is left in any contact');

-- A spam lead's purge (30 days after marking) takes its auto-contact too.
update public.leads set is_spam = true where id = 'c5300000-0000-4000-8000-00000000ab02';
update public.leads set retention_delete_after = now() - interval '1 day'
 where id = 'c5300000-0000-4000-8000-00000000ab02';
select lives_ok($$ select app.run_retention() $$, 'the nightly run');
select is(
  (select count(*)::int from public.leads where id = 'c5300000-0000-4000-8000-00000000ab02') || ' '
  || (select count(*)::int from public.crm_contacts where id = (select id from c5o_ids where k = 'ab02')),
  '0 0', 'a purged spam lead leaves no auto-contact behind, owner filled or not');
update public.crm_settings set assignment_rule = 'manual', assignment_fixed_to = null
 where tenant_id = 'c5300000-0000-4000-8000-000000000001';

-- The won rule is no person's edit either.
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab03', '31', null));
reset role;
update public.leads set stage_id = c5o_won() where id = 'c5300000-0000-4000-8000-00000000ab03';
insert into c5o_ids values ('ab03', c5o_contact('c5300000-0000-4000-8000-00000000ab03'));
select is((select stage from public.crm_contacts where id = (select id from c5o_ids where k = 'ab03')),
  'client', 'the fixture: the won lead made its contact a client');
set local role service_role;
select is(c5o_erase('c5300000-0000-4000-8000-00000000ab03') ->> 'contacts', '1',
  'erasing a won lead takes its auto-contact');
reset role;

-- A stranger's lead linked by phone does not keep the person's auto-contact.
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab04', '41', '42'));
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab05', '43', '42'));
reset role;
insert into c5o_ids values ('ab04', c5o_contact('c5300000-0000-4000-8000-00000000ab04'));
select is(
  (select contact_link || ' ' || (contact_id = (select id from c5o_ids where k = 'ab04')) from public.leads
    where id = 'c5300000-0000-4000-8000-00000000ab05'),
  'phone true', 'the fixture: another address with the same phone is linked by phone');
set local role service_role;
select is(c5o_erase('c5300000-0000-4000-8000-00000000ab04') ->> 'contacts', '1',
  'erasing the person''s only lead takes the contact, though a phone match is linked to it');
reset role;
select is(
  (select coalesce(contact_id::text, 'none') || ' ' || contact_link || ' '
          || (select count(*) from public.lead_events e
               where e.lead_id = l.id and e.kind = 'contact_linked')
     from public.leads l where l.id = 'c5300000-0000-4000-8000-00000000ab05'),
  'none phone 0', 'the phone match stays, unlinked, with no line naming the contact that went');

-- ── 2. A person's edit keeps the contact, not the erased lead's copies ───────────────────────
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab06', '51', '52'));
reset role;
insert into c5o_ids values ('ab06', c5o_contact('c5300000-0000-4000-8000-00000000ab06'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c5300000-0000-4000-8000-0000000000a1","role":"authenticated","app_metadata":{"role":"admin","tenant_id":"c5300000-0000-4000-8000-000000000001"}}', true);
select is(c5o_run($$ update public.crm_contacts set title = 'Buyer'
                      where id = (select id from c5o_ids where k = 'ab06') $$),
  'ok:1', 'the fixture: an Admin edits the contact''s title');
reset role;
select set_config('request.jwt.claims', '', true);
set local role service_role;
select is(c5o_erase('c5300000-0000-4000-8000-00000000ab06') ->> 'contacts', '0',
  'a contact a person edited stays when its last lead goes');
reset role;
select is(
  (select count(*)::int from public.crm_contact_channels where contact_id = (select id from c5o_ids where k = 'ab06'))
  || ' ' || (select count(*)::int from public.crm_contact_events
              where detail ->> 'lead_id' = 'c5300000-0000-4000-8000-00000000ab06'),
  '0 0', 'but keeps no copy of the erased lead''s e-mail or phone, and no line naming it');

-- ── 3. The won rule is not activity; a person's stage change is ─────────────────────────────
insert into public.leads (id, tenant_id, name, email_enc, message, email_hmac, crm_indexed_at,
                          created_at, stage_id) values
  ('c5300000-0000-4000-8000-00000000ab07', 'c5300000-0000-4000-8000-000000000001', 'Old winner',
   'enc-61', 'hi', repeat('61', 32), now(), '2025-03-01T10:00:00Z', c5o_won());
set local role service_role;
select is(public.crm_link_lead('c5300000-0000-4000-8000-000000000001', 'c5300000-0000-4000-8000-00000000ab07'),
  'new', 'the backfill links an old won lead');
reset role;
insert into c5o_ids values ('ab07', c5o_contact('c5300000-0000-4000-8000-00000000ab07'));
select is(
  (select stage || ' ' || (last_activity_at = '2025-03-01T10:00:00Z'::timestamptz) from public.crm_contacts
    where id = (select id from c5o_ids where k = 'ab07')),
  'client true', 'its contact is a client whose last activity is still the lead''s arrival');
update public.crm_contacts set last_activity_at = '2025-01-01T00:00:00Z'
 where id = (select id from c5o_ids where k = 'ab06');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c5300000-0000-4000-8000-0000000000a1","role":"authenticated","app_metadata":{"role":"admin","tenant_id":"c5300000-0000-4000-8000-000000000001"}}', true);
select is(c5o_run($$ update public.crm_contacts set stage = 'past'
                      where id = (select id from c5o_ids where k = 'ab06') $$),
  'ok:1', 'an Admin moves a contact''s stage');
reset role;
select set_config('request.jwt.claims', '', true);
select ok((select last_activity_at > now() - interval '1 minute' from public.crm_contacts
            where id = (select id from c5o_ids where k = 'ab06')),
  'and that is activity');

-- ── 4. A phone link is not the contact's activity ────────────────────────────────────────────
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab08', '71', '72'));
reset role;
insert into c5o_ids values ('ab08', c5o_contact('c5300000-0000-4000-8000-00000000ab08'));
update public.crm_contacts set last_activity_at = '2025-01-01T00:00:00Z'
 where id = (select id from c5o_ids where k = 'ab08');
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab09', '73', '72'));
reset role;
select is(
  (select l.contact_link || ' ' || (k.last_activity_at = '2025-01-01T00:00:00Z'::timestamptz)
     from public.leads l join public.crm_contacts k on k.id = l.contact_id
    where l.id = 'c5300000-0000-4000-8000-00000000ab09'),
  'phone true', 'a lead linked by phone does not move the contact''s last activity');
insert into public.lead_notes (tenant_id, lead_id, body, source)
  values ('c5300000-0000-4000-8000-000000000001', 'c5300000-0000-4000-8000-00000000ab09', 'Called', 'staff');
update public.leads set stage_id = c5o_won(), assigned_to = 'c5300000-0000-4000-8000-0000000000a1'
 where id = 'c5300000-0000-4000-8000-00000000ab09';
select is(
  (select stage || ' ' || coalesce(owner_id::text, 'none') || ' '
          || (last_activity_at = '2025-01-01T00:00:00Z'::timestamptz)
     from public.crm_contacts where id = (select id from c5o_ids where k = 'ab08')),
  'lead none true', 'nor do its note, its win or its assignee: the contact is unchanged');

-- ── 5. Erasing a person takes the lines other contacts kept for the person's leads ──────────
set local role service_role;
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab11', '81', '82'));
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab12', '83', '82'));
select c5o_ingest(c5o_lead('c5300000-0000-4000-8000-00000000ab13', '83', '84'));
reset role;
insert into c5o_ids values ('ab11', c5o_contact('c5300000-0000-4000-8000-00000000ab11')),
                           ('ab13', c5o_contact('c5300000-0000-4000-8000-00000000ab13'));
select is(
  (select string_agg(contact_link, ' ' order by id) from public.leads
    where id in ('c5300000-0000-4000-8000-00000000ab12', 'c5300000-0000-4000-8000-00000000ab13')),
  'phone new', 'the fixture: the person''s first lead is linked to a stranger by phone, the second makes their contact');
set local role service_role;
select is(
  (public.crm_erase_person('c5300000-0000-4000-8000-000000000001', (select id from c5o_ids where k = 'ab13'),
     '{}', 'c5300000-0000-4000-8000-0000000000a1') ->> 'leads')::int,
  2, 'erasing the person takes both their leads (one by its e-mail index)');
reset role;
select is(
  (select count(*)::int from public.crm_contact_events
    where detail ->> 'lead_id' in ('c5300000-0000-4000-8000-00000000ab12', 'c5300000-0000-4000-8000-00000000ab13')),
  0, 'and the stranger''s timeline keeps no line naming the erased lead');
select is(
  (select count(*)::int from public.crm_contact_events
    where contact_id = (select id from c5o_ids where k = 'ab11') and kind = 'lead_linked'
      and detail ->> 'lead_id' = 'c5300000-0000-4000-8000-00000000ab11'),
  1, 'the stranger''s own line stays');

-- ── 6. The events' identity sequence ────────────────────────────────────────────────────────
select ok(
  not has_sequence_privilege('anon', pg_get_serial_sequence('public.crm_contact_events', 'id'), 'usage, select, update')
  and not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.crm_contact_events', 'id'), 'usage, select, update')
  and not has_sequence_privilege('service_role', pg_get_serial_sequence('public.crm_contact_events', 'id'), 'usage, select, update'),
  'no API role holds USAGE, SELECT or UPDATE (setval) on the events'' sequence');

-- ── 7. staff_edited ─────────────────────────────────────────────────────────────────────────
select is(
  (select string_agg(k.k || ':' || c.staff_edited, ' ' order by k.k)
     from c5o_ids k join public.crm_contacts c on c.id = k.id
    where k.k in ('ab06', 'ab07', 'ab08')),
  'ab06:true ab07:false ab08:false',
  'set by a person''s edit, never by the system''s (the won rule, the activity time)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c5300000-0000-4000-8000-0000000000a1","role":"authenticated","app_metadata":{"role":"admin","tenant_id":"c5300000-0000-4000-8000-000000000001"}}', true);
select is(c5o_run($$ update public.crm_contacts set staff_edited = false
                      where id = (select id from c5o_ids where k = 'ab06') $$),
  '42501', 'no staff token writes it');
reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
