-- pgTAP: how a lead arrives (0035, Admin v2 C1b) — crm_ingest_lead, crm_index_lead,
-- crm_settings and the score. Run with `supabase test db`.
--
-- The two doors are the service role's alone; arrival is idempotent on the Worker's id
-- (a retry spends no lead number) and takes every field the Worker sends; a lead that
-- arrives without its indexes waits for the cron; `returning` and the score are the
-- database's to decide; the backfill door writes only what the CRM derives (since the leads
-- contract, C14b, there is no plaintext band left to move, and the timeline it once filled
-- is never touched) and is not an edit; a lead that names no stage (the fallback insert)
-- starts in the initial one; staff read the score, never the indexes or the reasons;
-- crm_settings over the six principals, with no time zone of its own (C14b).
-- CLAUDE.md §3, §9.

begin;
select plan(48);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null);

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
  (select l.source = 'web_form' and l.channel = 'unknown' and l.crm_indexed_at is not null
          and l.lead_number = 1 and s.is_initial
     from public.leads l join public.lead_stages s on s.id = l.stage_id
    where l.id = '00000000-0000-0000-0000-00000000ee01'),
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
select is(
  (select lead_number from public.leads where id = '00000000-0000-0000-0000-00000000ee02'), 2,
  'the retry spent no lead number: the next lead is L2');
set local role service_role;
select lives_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       (_lead('00000000-0000-0000-0000-00000000ee06', null, '[]') - 'email_enc')
         || '{"phone_enc": "ciphertext", "source": "manual",
              "created_by": "00000000-0000-0000-0000-0000000000a1"}') $$,
  'a phone-only lead is accepted (manual adds name who added them, 0041)');
-- createLead could not compute the indexes (it sends no signals then): the lead still
-- arrives, unindexed, for the daily cron.
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
    _lead('00000000-0000-0000-0000-00000000ee08', null, '[]') - 'score_signals' - 'email_hmac'),
  '00000000-0000-0000-0000-00000000ee08'::uuid, 'a lead without its indexes still arrives');
-- Every key createLead sends (src/lib/data/leads.ts; tests/lib/createLead.spec.ts holds
-- that list inside the allow-list), each into its own column.
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', jsonb_build_object(
    'id', '00000000-0000-0000-0000-00000000ee09', 'kind', 'project_inquiry', 'locale', 'ar',
    'name', 'Huda', 'company', 'Dar', 'email_enc', 'enc-email', 'phone_enc', 'enc-phone',
    'budget_enc', 'enc-budget', 'timeline_text_enc', 'enc-timeline', 'message', 'A booth',
    'service_of_interest', 'booth-production', 'discipline_of_interest', 'events-exhibitions',
    'consent_marketing', true, 'source', 'web_form', 'email_hmac', repeat('d', 64),
    'phone_hmac', repeat('e', 64), 'score_signals', '["named_service", "budget_given"]'::jsonb)),
  '00000000-0000-0000-0000-00000000ee09'::uuid, 'every field createLead sends is accepted');
-- The fallback path: createLead's plain insert, as the service role, through every trigger.
select lives_ok(
  $$ insert into public.leads (id, tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-00000000ee07', '00000000-0000-0000-0000-000000000001',
             'Fallback', 'ciphertext', 'hi') $$,
  'the service role''s plain insert (the fail-open fallback) still works');
reset role;
select ok(
  (select crm_indexed_at is null and email_hmac is null and score = 0
     from public.leads where id = '00000000-0000-0000-0000-00000000ee08'),
  'an unindexed arrival is left for the daily cron: crm_indexed_at stays null');
select ok(
  (select s.is_initial and s.tenant_id = l.tenant_id
     from public.leads l join public.lead_stages s on s.id = l.stage_id
    where l.id = '00000000-0000-0000-0000-00000000ee07'),
  'the fallback insert, naming no stage, starts in its tenant''s initial stage (C14b)');
select is(
  (select concat_ws('|', kind, locale, name, company, email_enc, phone_enc, budget_enc,
                    timeline_text_enc, message, service_of_interest::text,
                    discipline_of_interest::text, consent_marketing::text, source,
                    (email_hmac = repeat('d', 64))::text, (phone_hmac = repeat('e', 64))::text,
                    array_to_string(score_signals, ','), (crm_indexed_at is not null)::text)
     from public.leads where id = '00000000-0000-0000-0000-00000000ee09'),
  'project_inquiry|ar|Huda|Dar|enc-email|enc-phone|enc-budget|enc-timeline|A booth|booth-production|events-exhibitions|true|web_form|true|true|budget_given,named_service|true',
  'and each one lands in its own column');

-- ---- The backfill door ---------------------------------------------------------------------
-- Old leads, last changed by the admin (the owner inserts them under her claims, so
-- updated_by names her) on the day they arrived. ff02 holds the visitor's own timeline; ff03
-- arrived already past New.
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
insert into public.leads (id, tenant_id, name, email_enc, message, timeline_text_enc, stage_id,
                          created_at, updated_at)
values ('00000000-0000-0000-0000-00000000ff01', '00000000-0000-0000-0000-000000000001', 'Old',
        'ciphertext', 'hi', null, null, now() - interval '30 days', now() - interval '30 days'),
       ('00000000-0000-0000-0000-00000000ff02', '00000000-0000-0000-0000-000000000001', 'Old 2',
        'ciphertext', 'hi', 'visitor-words', null, now() - interval '20 days', now() - interval '20 days'),
       ('00000000-0000-0000-0000-00000000ff03', '00000000-0000-0000-0000-000000000001', 'Old 3',
        'ciphertext', 'hi', null,
        (select id from public.lead_stages
          where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'contacted'),
        now() - interval '10 days', now() - interval '10 days');
set local role service_role;
select _as(null, null, null);
select ok(
  public.crm_index_lead('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000ff01',
    repeat('a', 64), null, array['timeline_given'], 'encrypted-band-label'),
  'crm_index_lead writes an old lead (an older cron''s last argument still resolves)');
select ok(
  public.crm_index_lead('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000ff02',
    repeat('b', 64), null, array['timeline_given'], 'encrypted-band-label'),
  'and another, that holds the visitor''s own timeline');
select ok(
  not public.crm_index_lead('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000ff01',
    null, null, array[]::text[], null),
  'crm_index_lead finds nothing across tenants');
select ok(
  public.crm_index_lead('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000ff03',
    repeat('f', 64), null, array[]::text[], null),
  'and a lead that is past New');
reset role;
select ok(
  (select email_hmac = repeat('a', 64) and crm_indexed_at is not null
          and timeline_text_enc is null
          and not ('returning' = any(score_signals)) and score = 5
     from public.leads where id = '00000000-0000-0000-0000-00000000ff01'),
  'indexed: not returning (the first with this address); the last argument is ignored, no band is left to move (C14b)');
select ok(
  (select timeline_text_enc = 'visitor-words' and email_hmac = repeat('b', 64)
     from public.leads where id = '00000000-0000-0000-0000-00000000ff02'),
  'the door never writes the timeline: the visitor''s own words stay as they were');
select ok(
  (select updated_at = now() - interval '30 days'
          and updated_by = '00000000-0000-0000-0000-0000000000a1'
     from public.leads where id = '00000000-0000-0000-0000-00000000ff01'),
  'indexing is not an edit: the lead keeps its updated_at and who last changed it');
select ok(
  (select first_response_at is null and updated_at = now() - interval '10 days'
     from public.leads where id = '00000000-0000-0000-0000-00000000ff03'),
  'and indexing a lead past New stamps no first response');
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
select is((select sla_hours from public.crm_settings), 24::smallint,
  'admin reads its tenant''s settings (default: 24 hours)');
select throws_ok($$ select timezone from public.crm_settings $$, '42703', null,
  'the CRM keeps no time zone of its own: site_settings.timezone is the studio''s one zone (C14b)');
select lives_ok($$ select score, source, channel from public.leads $$, 'admin reads the score, source and channel');
select throws_ok($$ select email_hmac from public.leads $$, '42501', null,
  'admin cannot read the blind indexes');
select throws_ok($$ select score_signals from public.leads $$, '42501', null,
  'admin cannot read the reasons (two derive from budget and timeline)');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.crm_settings), 0, 'content_creator reads no CRM settings');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.crm_settings), 0, 'seo reads no CRM settings');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is((select string_agg(tenant_id::text, ',') from public.crm_settings),
  '00000000-0000-0000-0000-000000000001', 'developer reads its tenant''s settings, and only those');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is((select string_agg(tenant_id::text, ',') from public.crm_settings),
  '00000000-0000-0000-0000-0000000000ff', 'another tenant''s admin reads its own settings and none of T1''s');

reset role;
select * from finish();
rollback;
