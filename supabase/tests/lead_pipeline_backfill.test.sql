-- pgTAP: the 0034 backfill after the leads contract (Admin v2 C14b). Run with
-- `supabase test db`.
--
-- 0034's app.backfill_lead_pipeline() put every lead that predated the pipeline into it, once
-- (this file used to run it on legacy-shaped rows: a status and notes, no stage). It read the
-- legacy `status`, which C14b dropped, so C14b dropped the function too, with the legacy
-- sync's helper app.lead_stage_for_status. What the backfill left behind stays valid: the
-- `legacy_backfill` timeline kind still marks the leads it mapped for re-triage, and the notes
-- it copied (source 'legacy') are notes like any other. CLAUDE.md §8.

begin;
select plan(4);

select ok(to_regprocedure('app.backfill_lead_pipeline()') is null,
  'the one-off backfill is gone (C14b): it read the dropped status');
select ok(to_regprocedure('app.lead_stage_for_status(uuid, text, uuid)') is null,
  'and so is the legacy sync''s helper');
select ok(
  (select pg_get_constraintdef(oid) like '%''legacy_backfill''%'
     from pg_constraint
    where conrelid = 'public.lead_events'::regclass and conname = 'lead_events_kind_check'),
  'a lead the backfill mapped keeps its re-triage mark: the timeline still takes the kind');
select ok(
  (select bool_or(pg_get_constraintdef(oid) like '%''legacy''%')
     from pg_constraint
    where conrelid = 'public.lead_notes'::regclass and contype = 'c'),
  'the notes it copied stay notes: the thread still takes their source');

select * from finish();
rollback;
