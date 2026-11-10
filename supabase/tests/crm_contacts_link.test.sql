-- pgTAP: linking leads to contacts (0131, Admin v2 C5, crm.md §5.2, README C5 "phone
-- link-and-flag"). Run with `supabase test db`.
--
--   1. the doors are the service role's; the link core no API role's;
--   2. arrival links: a new address makes a contact from the lead (its ciphertext copied, its
--      indexes, no person); the same address again joins that contact and adds the new
--      phone; a new address with a known phone links to that contact FLAGGED ('phone') and
--      adds nothing to it; a lead without its indexes waits; the link is not an edit of the
--      lead; both timelines say so;
--   3. arrival fails open: a link that raises leaves the lead in, unlinked, and the backfill
--      links it later;
--   4. the backfill: counts only, idempotent, skips spam and leads with nothing to link by,
--      never brings back a contact that went (retention, erasure);
--   5. the rules: a won lead makes its contact a client; an assignee who holds crm.contacts
--      becomes an empty contact's owner, one who does not never does; what moves a contact's
--      last activity, and what does not.

begin;
select plan(35);

insert into public.tenants (id, name) values
  ('c5100000-0000-4000-8000-000000000001', 'C5 link T1'),
  ('c5100000-0000-4000-8000-0000000000ff', 'C5 link T2');
insert into auth.users (id, email) values
  ('c5100000-0000-4000-8000-0000000000a1', 'c5l-admin@example.test'),
  ('c5100000-0000-4000-8000-0000000000d1', 'c5l-dev@example.test');
insert into public.profiles (id, tenant_id, role, is_active, display_name) values
  ('c5100000-0000-4000-8000-0000000000a1', 'c5100000-0000-4000-8000-000000000001', 'admin', true, 'Amal'),
  ('c5100000-0000-4000-8000-0000000000d1', 'c5100000-0000-4000-8000-000000000001', 'developer', true, 'Dana');

-- A lead as the Worker sends it: the e-mail and phone (ciphertext and blind index, each
-- optional) and, when the Worker indexed it, its signals.
create function c5l_lead(p_id text, p_email text, p_phone text, p_indexed boolean default true)
  returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id, 'kind', 'contact', 'locale', 'ar', 'name', 'Huda ' || right(p_id, 2),
    'company', 'Acme', 'message', 'Hello', 'consent_marketing', true, 'source', 'web_form',
    'email_enc', 'enc-email-' || coalesce(p_email, 'none'),
    'email_hmac', case when p_email is not null then repeat(p_email, 64) end,
    'phone_enc', case when p_phone is not null then 'enc-phone-' || p_phone end,
    'phone_hmac', case when p_phone is not null then repeat(p_phone, 64) end,
    'score_signals', case when p_indexed then '[]'::jsonb end))
$$;
create function c5l_ingest(p_lead jsonb) returns uuid language sql as $$
  select public.crm_ingest_lead('c5100000-0000-4000-8000-000000000001', p_lead)
$$;
create function c5l_contact(p_lead text) returns uuid language sql as $$
  select contact_id from public.leads where id = p_lead::uuid
$$;
create function c5l_run(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;
grant execute on function c5l_lead(text, text, text, boolean), c5l_ingest(jsonb), c5l_run(text)
  to service_role, authenticated;

-- ── 1. The doors ──────────────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.crm_link_lead(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.crm_link_backfill(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_link_lead(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_link_backfill(integer)', 'execute')
  and not has_function_privilege('anon', 'public.crm_link_lead(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.crm_link_backfill(integer)', 'execute'),
  'crm_link_lead and crm_link_backfill: the service role''s alone');
select ok(
  not has_function_privilege('authenticated', 'app.crm_link_lead_core(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'app.crm_link_lead_core(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app.purge_crm()', 'execute')
  and not has_function_privilege('service_role', 'app.purge_crm()', 'execute'),
  'the link core is no API role''s but the service role''s doors, the purge nobody''s');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c5100000-0000-4000-8000-0000000000a1","role":"authenticated","app_metadata":{"role":"admin","tenant_id":"c5100000-0000-4000-8000-000000000001"}}', true);
select is(c5l_run($$ select public.crm_link_backfill(10) $$), '42501', 'an Admin cannot run the backfill through the API');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 2. Arrival links ──────────────────────────────────────────────────────────────────────
set local role service_role;
select c5l_ingest(c5l_lead('c5100000-0000-4000-8000-00000000aa01', 'a', '1'));
reset role;
select is((select contact_link from public.leads where id = 'c5100000-0000-4000-8000-00000000aa01'),
  'new', 'a new address: a contact is made and the lead linked to it');
select is(
  (select c.display_name || ' | ' || c.company_name || ' | ' || c.locale || ' | ' || c.source || ' | '
          || coalesce(c.created_by::text, 'system') || ' | v' || c.version || ' | ' || c.stage
     from public.crm_contacts c where c.id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'Huda 01 | Acme | ar | web_form | system | v1 | lead',
  'from what the lead says about itself, made by the system, never edited');
select is(
  (select string_agg(ch.kind || ':' || ch.value_enc || ':' || ch.is_primary || ':' || ch.source, ', ' order by ch.kind)
     from public.crm_contact_channels ch where ch.contact_id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'email:enc-email-a:true:lead, phone:enc-phone-1:true:lead',
  'its channels are the lead''s ciphertext, copied as it is, with the lead''s indexes');
select ok(
  (select bool_and(ch.value_hmac in (repeat('a', 64), repeat('1', 64))) from public.crm_contact_channels ch
    where ch.contact_id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'each channel carries the lead''s blind index');
select is(
  (select l.version || ' ' || coalesce(l.updated_by::text, 'nobody') || ' ' || l.stage_id::text
          = '1 nobody ' || s.id::text
     from public.leads l join public.lead_stages s on s.tenant_id = l.tenant_id and s.is_initial
    where l.id = 'c5100000-0000-4000-8000-00000000aa01'),
  true, 'linking is not an edit of the lead: its version and its editor stay');
select is(
  (select string_agg(e.kind || ' ' || (e.detail ->> 'by'), ', ' order by e.id) from public.lead_events e
    where e.lead_id = 'c5100000-0000-4000-8000-00000000aa01' and e.kind = 'contact_linked'),
  'contact_linked new', 'the lead''s timeline says it was linked, and how');
select is(
  (select string_agg(e.kind, ', ' order by e.id) from public.crm_contact_events e
    where e.contact_id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'created, channel_added, channel_added, lead_linked', 'and so does the contact''s');

set local role service_role;
select c5l_ingest(c5l_lead('c5100000-0000-4000-8000-00000000aa02', 'a', '2'));
reset role;
select is(
  (select l.contact_link || ' ' || (l.contact_id = c5l_contact('c5100000-0000-4000-8000-00000000aa01'))
     from public.leads l where l.id = 'c5100000-0000-4000-8000-00000000aa02'),
  'email true', 'the same address again joins that contact');
select is(
  (select string_agg(ch.kind || ':' || ch.value_enc || ':' || ch.is_primary, ', ' order by ch.kind, ch.value_enc)
     from public.crm_contact_channels ch where ch.contact_id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'email:enc-email-a:true, phone:enc-phone-1:true, phone:enc-phone-2:false',
  'and brings its new phone, not as the primary one');
select is((select count(*)::int from public.crm_contacts where tenant_id = 'c5100000-0000-4000-8000-000000000001'), 1,
  'one address, one person: still one contact');

set local role service_role;
select c5l_ingest(c5l_lead('c5100000-0000-4000-8000-00000000aa03', 'b', '1'));
reset role;
select is(
  (select l.contact_link || ' ' || (l.contact_id = c5l_contact('c5100000-0000-4000-8000-00000000aa01'))
     from public.leads l where l.id = 'c5100000-0000-4000-8000-00000000aa03'),
  'phone true', 'a new address with a known phone: linked to that contact and flagged');
select is(
  (select count(*)::int from public.crm_contact_channels ch
    where ch.tenant_id = 'c5100000-0000-4000-8000-000000000001' and ch.value_hmac = repeat('b', 64)),
  0, 'and its address is added to nobody until a person checks');

set local role service_role;
select c5l_ingest(c5l_lead('c5100000-0000-4000-8000-00000000aa04', 'c', null, false));
reset role;
select is(
  (select coalesce(contact_link, 'unlinked') from public.leads where id = 'c5100000-0000-4000-8000-00000000aa04'),
  'unlinked', 'a lead that arrived without its indexes waits for them');

-- Another tenant's identical index is another person (the index is tenant-salted anyway).
set local role service_role;
select public.crm_ingest_lead('c5100000-0000-4000-8000-0000000000ff', c5l_lead('c5100000-0000-4000-8000-00000000ab01', 'a', '1'));
reset role;
select is(
  (select l.contact_link || ' ' || (c.tenant_id = l.tenant_id)
     from public.leads l join public.crm_contacts c on c.id = l.contact_id
    where l.id = 'c5100000-0000-4000-8000-00000000ab01'),
  'new true', 'the same index in another tenant makes that tenant its own contact');

-- ── 3. Arrival fails open ─────────────────────────────────────────────────────────────────
create function c5l_boom() returns trigger language plpgsql as $$
begin
  raise exception 'c5l: the contact cannot be made';
end $$;
create trigger c5l_boom before insert on public.crm_contacts for each row execute function c5l_boom();
set local role service_role;
select is(c5l_ingest(c5l_lead('c5100000-0000-4000-8000-00000000aa05', 'd', '5')),
  'c5100000-0000-4000-8000-00000000aa05'::uuid, 'a link that fails still answers with the lead');
reset role;
select is(
  (select count(*)::int || ' ' || coalesce(max(contact_link), 'unlinked') from public.leads
    where id = 'c5100000-0000-4000-8000-00000000aa05'),
  '1 unlinked', 'the lead is in, unlinked: the public form never loses a lead to the link');
drop trigger c5l_boom on public.crm_contacts;

-- ── 4. The backfill ───────────────────────────────────────────────────────────────────────
-- aa04 gets its indexes (as the index cron writes them); a spam lead and a lead with nothing
-- to link by are waiting too.
set local role service_role;
select public.crm_index_lead('c5100000-0000-4000-8000-000000000001', 'c5100000-0000-4000-8000-00000000aa04',
                             repeat('c', 64), null, '{}');
reset role;
insert into public.leads (id, tenant_id, name, email_enc, message, email_hmac, crm_indexed_at, is_spam) values
  ('c5100000-0000-4000-8000-00000000aa06', 'c5100000-0000-4000-8000-000000000001', 'Spam', 'enc', 'buy',
   repeat('e', 64), now(), true);
insert into public.leads (id, tenant_id, name, email_enc, message, crm_indexed_at) values
  ('c5100000-0000-4000-8000-00000000aa07', 'c5100000-0000-4000-8000-000000000001', 'Unreadable', 'enc', 'hi', now());
-- An old lead: the link does not make it look edited, and its contact's activity starts at
-- the lead's arrival, not at the link.
insert into public.leads (id, tenant_id, name, email_enc, message, email_hmac, crm_indexed_at,
                          created_at, updated_at) values
  ('c5100000-0000-4000-8000-00000000aa08', 'c5100000-0000-4000-8000-000000000001', 'Old', 'enc-old',
   'hi', repeat('f', 64), now(), '2026-01-05T10:00:00Z', '2026-01-06T10:00:00Z');

set local role service_role;
select is(public.crm_link_backfill(50),
  '{"new": 3, "email": 0, "phone": 0, "failed": 0, "scanned": 3, "skipped": 0}'::jsonb,
  'the backfill links the waiting leads (aa04, aa05, aa08) and skips spam and the unindexable');
select is(public.crm_link_backfill(50),
  '{"new": 0, "email": 0, "phone": 0, "failed": 0, "scanned": 0, "skipped": 0}'::jsonb,
  'run again, it has nothing to do');
reset role;
select is(
  (select l.updated_at = '2026-01-06T10:00:00Z'::timestamptz
          and c.last_activity_at = '2026-01-05T10:00:00Z'::timestamptz
     from public.leads l join public.crm_contacts c on c.id = l.contact_id
    where l.id = 'c5100000-0000-4000-8000-00000000aa08'),
  true,
  'an old lead keeps its last edit, and its contact''s activity is the lead''s arrival');
select is(
  (select string_agg(coalesce(contact_link, 'unlinked'), ' ' order by id) from public.leads
    where id in ('c5100000-0000-4000-8000-00000000aa06', 'c5100000-0000-4000-8000-00000000aa07')),
  'unlinked unlinked', 'spam is never linked; a lead with no index to link by waits');

-- A contact that went (retention, erasure) is not made again.
delete from public.crm_contacts where id = c5l_contact('c5100000-0000-4000-8000-00000000aa04');
set local role service_role;
select is(
  (select coalesce(l.contact_id::text, 'none') || ' ' || l.contact_link || ' ' || public.crm_link_lead(l.tenant_id, l.id)
     from public.leads l where l.id = 'c5100000-0000-4000-8000-00000000aa04'),
  'none new done', 'its lead keeps how it was linked, and is never linked again');
select is((public.crm_link_backfill(50) ->> 'scanned')::int, 0, 'the backfill does not see it either');
select is(public.crm_link_lead('c5100000-0000-4000-8000-000000000001', 'c5100000-0000-4000-8000-0000000000ee'),
  'missing', 'a lead that is not there is reported, not raised');
reset role;

-- ── 5. The rules ──────────────────────────────────────────────────────────────────────────
-- Activity: a note on a linked lead moves its contact's last activity; a value does not.
update public.crm_contacts set last_activity_at = '2026-02-01T00:00:00Z'
 where id = c5l_contact('c5100000-0000-4000-8000-00000000aa01');
update public.leads set value_sar = 5000 where id = 'c5100000-0000-4000-8000-00000000aa01';
select is((select last_activity_at = '2026-02-01T00:00:00Z'::timestamptz from public.crm_contacts
            where id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  true, 'a value set on a linked lead is no activity');
insert into public.lead_notes (tenant_id, lead_id, body, source)
  values ('c5100000-0000-4000-8000-000000000001', 'c5100000-0000-4000-8000-00000000aa01', 'Called back', 'staff');
select ok((select last_activity_at > now() - interval '1 minute' from public.crm_contacts
            where id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'a note on a linked lead is');

-- A won lead makes its contact a client; a partner stays a partner.
update public.leads set stage_id = (select id from public.lead_stages
                                     where tenant_id = 'c5100000-0000-4000-8000-000000000001' and kind = 'won' limit 1)
 where id = 'c5100000-0000-4000-8000-00000000aa01';
select is((select stage from public.crm_contacts where id = c5l_contact('c5100000-0000-4000-8000-00000000aa01')),
  'client', 'a linked lead won: its contact is a client');
update public.crm_contacts set stage = 'partner' where id = c5l_contact('c5100000-0000-4000-8000-00000000aa05');
update public.leads set stage_id = (select id from public.lead_stages
                                     where tenant_id = 'c5100000-0000-4000-8000-000000000001' and kind = 'won' limit 1)
 where id = 'c5100000-0000-4000-8000-00000000aa05';
select is((select stage from public.crm_contacts where id = c5l_contact('c5100000-0000-4000-8000-00000000aa05')),
  'partner', 'a partner stays a partner');

-- The assignee fills an empty owner when they hold crm.contacts (an Admin), never otherwise.
update public.leads set assigned_to = 'c5100000-0000-4000-8000-0000000000d1'
 where id = 'c5100000-0000-4000-8000-00000000aa08';
select is((select coalesce(owner_id::text, 'none') from public.crm_contacts
            where id = c5l_contact('c5100000-0000-4000-8000-00000000aa08')),
  'none', 'a Developer assigned to the lead does not own the contact (no crm.contacts)');
update public.leads set assigned_to = 'c5100000-0000-4000-8000-0000000000a1'
 where id = 'c5100000-0000-4000-8000-00000000aa08';
select is((select owner_id::text from public.crm_contacts
            where id = c5l_contact('c5100000-0000-4000-8000-00000000aa08')),
  'c5100000-0000-4000-8000-0000000000a1', 'an Admin assigned to it fills the empty owner');
update public.leads set assigned_to = 'c5100000-0000-4000-8000-0000000000d1'
 where id = 'c5100000-0000-4000-8000-00000000aa08';
select is((select owner_id::text from public.crm_contacts
            where id = c5l_contact('c5100000-0000-4000-8000-00000000aa08')),
  'c5100000-0000-4000-8000-0000000000a1', 'and a later assignee does not replace an owner');

-- A lead's own triggers are unchanged for an unlinked lead: no contact line, no contact write.
select is((select count(*)::int from public.lead_events
            where lead_id = 'c5100000-0000-4000-8000-00000000aa07' and kind = 'contact_linked'), 0,
  'an unlinked lead has no link line');
select is((select count(*)::int from public.leads
            where tenant_id = 'c5100000-0000-4000-8000-000000000001' and contact_id is not null), 5,
  'five leads are linked in this tenant (aa01, aa02, aa03, aa05, aa08: aa04''s contact went)');

select * from finish();
rollback;
