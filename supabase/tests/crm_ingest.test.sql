-- pgTAP: how a lead arrives (0035, Admin v2 C1b) — crm_ingest_lead, crm_index_lead,
-- crm_settings and the score. Run with `supabase test db`.
--
-- The two doors are the service role's alone; arrival is idempotent on the Worker's id;
-- `returning` and the score are the database's to decide; the backfill moves a legacy
-- plaintext timeline band into the encrypted field without ever dropping it with nothing
-- in its place; staff read the score, never the indexes or the reasons. CLAUDE.md §3, §9.

begin;
select plan(36);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null);

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true
  )
$$;

-- A lead as the Worker sends it.
create function _lead(p_id text, p_hmac text, p_signals jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'kind', 'contact', 'locale', 'en', 'name', 'Sara', 'company', 'Acme',
    'email_enc', 'ciphertext', 'message', 'Hello', 'consent_marketing', true,
    'email_hmac', p_hmac, 'score_signals', p_signals, 'source', 'web_form')
$$;

-- ---- The doors are the service role's -------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.crm_ingest_lead(uuid, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_ingest_lead(uuid, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.crm_ingest_lead(uuid, jsonb)', 'execute'),
  'crm_ingest_lead: service role only');
select ok(
  not has_function_privilege('anon', 'public.crm_index_lead(uuid, uuid, text, text, text[], text)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_index_lead(uuid, uuid, text, text, text[], text)', 'execute')
  and has_function_privilege('service_role', 'public.crm_index_lead(uuid, uuid, text, text, text[], text)', 'execute'),
  'crm_index_lead: service role only');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       _lead('00000000-0000-0000-0000-00000000ee01', null, '[]')) $$,
  '42501', null, 'admin cannot call crm_ingest_lead through the API');
reset role;

-- ---- Arrival ---------------------------------------------------------------------------------
set local role service_role;
select _as(null, null, null);
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
    _lead('00000000-0000-0000-0000-00000000ee01', repeat('a', 64),
          '["named_service", "company_email", "company_named", "returning"]')),
  '00000000-0000-0000-0000-00000000ee01'::uuid, 'crm_ingest_lead returns the Worker''s id');
reset role;
select is(
  (select array_to_string(score_signals, ',') || '/' || score from public.leads
    where id = '00000000-0000-0000-0000-00000000ee01'),
  'company_email,company_named,named_service/25',
  'the caller''s `returning` is ignored (the database decides it); default points: 10 + 10 + 5');
select ok(
  (select source = 'web_form' and channel = 'unknown' and crm_indexed_at is not null
          and lead_number = 1 and status = 'new' and timeline_band is null
     from public.leads where id = '00000000-0000-0000-0000-00000000ee01'),
  'arrival sets source, channel, the index time, the number and the initial stage');
select is(
  (select count(*)::int from public.lead_events
    where lead_id = '00000000-0000-0000-0000-00000000ee01' and kind = 'created'),
  1, 'arrival writes the created event in the same transaction');

set local role service_role;
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
    _lead('00000000-0000-0000-0000-00000000ee01', repeat('a', 64), '[]')),
  '00000000-0000-0000-0000-00000000ee01'::uuid, 'the same id again returns quietly');
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
    _lead('00000000-0000-0000-0000-00000000ee02', repeat('a', 64), '["named_service"]')),
  '00000000-0000-0000-0000-00000000ee02'::uuid, 'a second lead from the same address');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       _lead('00000000-0000-0000-0000-00000000ee03', null, '[]') || '{"ip_inet": "203.0.113.1"}') $$,
  '22023', null, 'a field outside the allow-list is refused, not ignored');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       _lead('', null, '[]')) $$,
  '22023', null, 'a lead without the Worker''s id is refused');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       _lead('00000000-0000-0000-0000-00000000ee04', null, '["made_up"]')) $$,
  '23514', null, 'an unknown signal is refused by the column CHECK');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       _lead('00000000-0000-0000-0000-00000000ee05', null, '[]') - 'email_enc') $$,
  '23514', null, 'a lead with no e-mail and no phone is refused (at least one channel)');
reset role;
select is(
  (select count(*)::int from public.leads where id = '00000000-0000-0000-0000-00000000ee01'),
  1, 'the retried id made no second lead');
select is(
  (select array_to_string(score_signals, ',') || '/' || score from public.leads
    where id = '00000000-0000-0000-0000-00000000ee02'),
  'named_service,returning/20', 'an address seen before is `returning` (+10)');
set local role service_role;
select lives_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       (_lead('00000000-0000-0000-0000-00000000ee06', null, '[]') - 'email_enc')
         || '{"phone_enc": "ciphertext", "source": "manual"}') $$,
  'a phone-only lead is accepted (manual adds, C3)');
-- The fallback path: createLead's plain insert, as the service role, through every trigger.
select lives_ok(
  $$ insert into public.leads (id, tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-00000000ee07', '00000000-0000-0000-0000-000000000001',
             'Fallback', 'ciphertext', 'hi') $$,
  'the service role''s plain insert (the fail-open fallback) still works');
reset role;

-- ---- The backfill door ---------------------------------------------------------------------
insert into public.leads (id, tenant_id, name, email_enc, message, timeline_band, created_at)
values ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-000000000001', 'Old',
        'ciphertext', 'hi', '3_6m', now() - interval '30 days'),
       ('00000000-0000-0000-0000-00000000ff02', '00000000-0000-0000-0000-000000000001', 'Old 2',
        'ciphertext', 'hi', 'asap', now() - interval '20 days');
set local role service_role;
select ok(
  public.crm_index_lead('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000ff01',
    repeat('a', 64), null, array['timeline_given'], 'encrypted-band-label'),
  'crm_index_lead writes an old lead');
select ok(
  public.crm_index_lead('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000ff02',
    repeat('b', 64), null, array['timeline_given'], null),
  'and another, with no replacement for its band');
select ok(
  not public.crm_index_lead('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000ff01',
    null, null, array[]::text[], null),
  'crm_index_lead finds nothing across tenants');
reset role;
select ok(
  (select email_hmac = repeat('a', 64) and crm_indexed_at is not null
          and timeline_text_enc = 'encrypted-band-label' and timeline_band is null
          and not ('returning' = any(score_signals)) and score = 5
     from public.leads where id = '00000000-0000-0000-0000-00000000ff01'),
  'indexed: the band moved into the encrypted timeline; not returning (the first with this address)');
select ok(
  (select timeline_band = 'asap' and timeline_text_enc is null
     from public.leads where id = '00000000-0000-0000-0000-00000000ff02'),
  'a band with nothing to replace it is kept, never silently dropped');
set local role service_role;
select ok(
  public.crm_index_lead('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000ee01',
    repeat('a', 64), null, array['named_service'], null),
  'reindexing a lead that arrived after an older one with the same address');
reset role;
select ok(
  (select 'returning' = any(score_signals) from public.leads
    where id = '00000000-0000-0000-0000-00000000ee01'),
  'the backfill counts only EARLIER leads as returning');

-- ---- crm_settings and what staff may read ---------------------------------------------------
select is((select count(*)::int from public.crm_settings
            where tenant_id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000ff')),
  2, 'every new tenant gets a crm_settings row');
select throws_ok(
  $$ update public.crm_settings set scoring = '{"returning": 99}'
      where tenant_id = '00000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'points above 50 are refused');
select throws_ok(
  $$ update public.crm_settings set scoring = '{"made_up": 5}'
      where tenant_id = '00000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'an unknown signal key is refused');
select throws_ok(
  $$ update public.crm_settings set scoring = '{"returning": "ten"}'
      where tenant_id = '00000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'a non-number is a CHECK failure, not a cast error');
select throws_ok(
  $$ update public.crm_settings set scoring = '[10, 20]'
      where tenant_id = '00000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'a non-object is a CHECK failure, not a jsonb_each error');

set local role anon;
select _as(null, null, null);
select throws_ok($$ select count(*) from public.crm_settings $$, '42501', null, 'anon is denied crm_settings');
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select sla_hours || '/' || timezone from public.crm_settings), '24/Asia/Riyadh',
  'admin reads its tenant''s settings (defaults: 24 hours, Riyadh)');
select throws_ok($$ update public.crm_settings set sla_hours = 48 $$, '42501', null,
  'admin cannot change settings through the API yet (C9)');
select lives_ok($$ select score, source, channel from public.leads $$, 'admin reads the score, source and channel');
select throws_ok($$ select email_hmac from public.leads $$, '42501', null,
  'admin cannot read the blind indexes');
select throws_ok($$ select score_signals from public.leads $$, '42501', null,
  'admin cannot read the reasons (two derive from budget and timeline)');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.crm_settings), 0, 'content_creator reads no CRM settings');

reset role;
select * from finish();
rollback;
