-- pgTAP: the 0034 backfill, app.backfill_lead_pipeline(), on legacy-shaped leads. Run with
-- `supabase test db`.
--
-- CI applies 0034 to an empty leads table, so the backfill never meets a row there. This
-- builds the shape it meets in production (leads with a status and notes, and no stage,
-- number, timeline or spam flag: the pipeline's triggers off, as they are while 0034
-- runs) and calls the function the migration calls. Covers the stage map (done → Lost,
-- owner item O-8), the spam cap and the saved horizon (docs/retention.md), numbers after
-- the ones already given out, the first events, the notes copy, the first response and
-- the timestamps left alone, and a second run that changes nothing. CLAUDE.md §8.

begin;
select plan(17);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');
-- T1 keeps spam for 10 days, not the default 30, to prove the setting is read.
insert into public.site_settings (tenant_id, retention)
values ('00000000-0000-0000-0000-000000000001',
        jsonb_build_object('raw_telemetry_days', 90, 'leads_months', 24, 'spam_days', 10));

-- A lead that arrived through the new path first: number 1 is taken.
insert into public.leads (id, tenant_id, name, email_enc, message)
values ('00000000-0000-0000-0000-0000000000c0', '00000000-0000-0000-0000-000000000001',
        'Arrived new', 'x', 'hi');

-- The legacy shape. Oldest first: c4, d1 (T2), c1, c2, c3, c5.
alter table public.leads disable trigger leads_pipeline;
alter table public.leads disable trigger leads_timeline;
alter table public.leads alter column stage_id drop not null, alter column lead_number drop not null;
insert into public.leads (id, tenant_id, name, email_enc, message, status, internal_notes,
                          created_at, updated_at, retention_delete_after) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'Waiting', 'x', 'hi',
   'new', null, now() - interval '40 days', now() - interval '40 days', null),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000001', 'Working', 'x', 'hi',
   'in_progress', 'Called twice', now() - interval '30 days', now() - interval '5 days', null),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-000000000001', 'Closed', 'x', 'hi',
   'done', '   ', now() - interval '20 days', now() - interval '2 days', null),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-000000000001', 'Old junk', 'x', 'buy',
   'spam', null, now() - interval '24 months' + interval '3 days', now() - interval '1 day', null),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-000000000001', 'Kept junk', 'x', 'buy',
   'spam', null, now() - interval '10 days', now() - interval '10 days', now() + interval '400 days'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000ff', 'Other', 'x', 'hi',
   'done', null, now() - interval '50 days', now() - interval '50 days', null);

select lives_ok($$ select app.backfill_lead_pipeline() $$, 'the backfill runs on legacy leads');

-- ---- The pipeline -----------------------------------------------------------------------
select is(
  (select string_agg(right(l.id::text, 2) || ':' || s.key, ',' order by l.id)
     from public.leads l join public.lead_stages s on s.id = l.stage_id
    where l.id <> '00000000-0000-0000-0000-0000000000c0'),
  'c1:new,c2:contacted,c3:lost,c4:new,c5:new,d1:lost',
  'statuses map to stages in their own tenant (done is Lost, O-8; spam keeps New)');
select ok(
  (select is_spam and spam_marked_at = now() and retention_before_spam is null
          and retention_delete_after = created_at + interval '24 months'
     from public.leads where id = '00000000-0000-0000-0000-0000000000c4'),
  'old spam keeps its own horizon: the cap never lengthens one due in three days');
select ok(
  (select is_spam and retention_delete_after = now() + interval '10 days'
          and retention_before_spam = now() + interval '400 days'
     from public.leads where id = '00000000-0000-0000-0000-0000000000c5'),
  'spam with a long horizon is capped at spam_days, and the horizon is saved');
select is(
  (select count(*)::int from public.leads
    where id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2',
                 '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000d1')
      and not is_spam and spam_marked_at is null and retention_delete_after is null),
  4, 'no other lead is flagged or given a horizon');

-- ---- Numbers ------------------------------------------------------------------------------
select is(
  (select string_agg(right(id::text, 2) || '=' || lead_number, ',' order by lead_number)
     from public.leads where tenant_id = '00000000-0000-0000-0000-000000000001'),
  'c0=1,c4=2,c1=3,c2=4,c3=5,c5=6',
  'legacy leads are numbered in arrival order, after the numbers already given out');
select is(
  (select lead_number from public.leads where id = '00000000-0000-0000-0000-0000000000d1'),
  1, 'numbers count per tenant');
select is(
  (select string_agg(last_number::text, ',' order by tenant_id) from app.lead_counters
    where tenant_id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000ff')),
  '6,1', 'each counter carries on from its tenant''s last number');

-- ---- Timeline and notes -------------------------------------------------------------------
select is(
  (select count(*)::int from public.lead_events e join public.leads l on l.id = e.lead_id
    where e.kind = 'created' and e.at = l.created_at and e.actor_id is null
      and l.id <> '00000000-0000-0000-0000-0000000000c0'),
  6, 'every legacy timeline starts with a created event at the lead''s arrival');
select is(
  (select string_agg(right(lead_id::text, 2) || ':' || (detail ->> 'from'), ',' order by lead_id)
     from public.lead_events where kind = 'legacy_backfill'),
  'c2:in_progress,c3:done,c4:spam,c5:spam,d1:done',
  'every mapped status is marked for re-triage, with what it was');
select is(
  (select count(*)::int || '/' || max(body) || '/'
          || bool_and(created_by is null and created_at = now() - interval '5 days')::text
     from public.lead_notes where source = 'legacy'),
  '1/Called twice/true',
  'notes are copied once, at the time their lead was last edited; a blank field is not');
select is(
  (select count(*)::int from public.lead_events e
     join public.lead_notes n on n.id = (e.detail ->> 'note_id')::uuid
    where e.kind = 'note_added' and e.at = n.created_at
      and n.lead_id = '00000000-0000-0000-0000-0000000000c2'),
  1, 'the copied note has its timeline event, at the note''s time');

-- ---- What the backfill leaves alone -------------------------------------------------------
select is(
  (select count(*)::int from public.leads
    where id <> '00000000-0000-0000-0000-0000000000c0' and first_response_at is not null),
  0, 'no legacy lead is given a first response: when it was answered is not known');
select ok(
  (select updated_at = now() - interval '5 days' and updated_by is null
     from public.leads where id = '00000000-0000-0000-0000-0000000000c2'),
  'no lead looks freshly edited');

select lives_ok($$ select app.backfill_lead_pipeline() $$, 'a second run');
select is(
  (select count(*)::int from public.lead_events where lead_id <> '00000000-0000-0000-0000-0000000000c0')
    || '/' || (select count(*) from public.lead_notes)
    || '/' || (select last_number from app.lead_counters
                where tenant_id = '00000000-0000-0000-0000-000000000001'),
  '12/1/6', 'changes nothing (6 created, 5 re-triage marks, 1 note event; one note; the counter)');
select lives_ok(
  $$ alter table public.leads alter column stage_id set not null, alter column lead_number set not null $$,
  'every lead has a stage and a number (the migration''s postcondition)');

select * from finish();
rollback;
