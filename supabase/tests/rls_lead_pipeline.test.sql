-- pgTAP: Leads v2, part 1 (0034) — the pipeline, the spam horizon, the timeline and the
-- notes thread. Run with `supabase test db`.
--
-- Covers: who reads stages and the timeline (six principals plus a stale token); that
-- nobody writes them through the API, and nobody reaches the notes thread at all; the
-- legacy sync both ways (old status writes move the stage, new stage writes set the
-- status); the spam horizon (D2) applied to a LEGACY status='spam' write, and restored
-- on clearing; the stamps, the version rule and per-tenant lead numbers; the stage-set
-- rules; and the grants. CLAUDE.md §3, §8, §9.

begin;
select plan(53);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');
-- T1 keeps spam for 10 days, not the default 30, to prove the setting is read.
insert into public.site_settings (tenant_id, retention)
values ('00000000-0000-0000-0000-000000000001',
        jsonb_build_object('raw_telemetry_days', 90, 'leads_months', 24, 'spam_days', 10));

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted-developer@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null),
  -- demoted: the token still says developer
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null);

insert into public.leads (id, tenant_id, name, email_enc, message) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000001', 'First', 'x', 'hi'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-000000000001', 'Second', 'x', 'hi'),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000ff', 'Other', 'x', 'hi');

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

-- The stage key of a lead, read as the CURRENT role.
create function _stage(p_lead uuid) returns text language sql as $$
  select s.key from public.leads l join public.lead_stages s on s.id = l.stage_id where l.id = p_lead
$$;

-- Timeline rows of one kind for a lead, read as the CURRENT role.
create function _events(p_lead uuid, p_kind text) returns int language sql as $$
  select count(*)::int from public.lead_events where lead_id = p_lead and kind = p_kind
$$;

-- Rows a statement touched, as the CURRENT role.
create function _rows(p_sql text) returns int language plpgsql as $f$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;

-- ---- The seeded pipeline, numbers and the first event (as the owner) -------------------
select is((select count(*)::int from public.lead_stages
            where tenant_id = '00000000-0000-0000-0000-000000000001'),
  5, 'a new tenant gets the five default stages');
select is((select string_agg(key, ',') from public.lead_stages
            where tenant_id = '00000000-0000-0000-0000-000000000001' and is_initial),
  'new', 'exactly one initial stage: New');
select is(_stage('00000000-0000-0000-0000-00000000aa01'), 'new', 'a new lead starts in the initial stage');
select is((select status || '/' || version from public.leads
            where id = '00000000-0000-0000-0000-00000000aa01'),
  'new/1', 'its legacy status says new, at version 1');
select is((select array_agg(lead_number order by name) from public.leads),
  array[1, 1, 2], 'lead numbers count per tenant (First 1, Other 1 in T2, Second 2)');
select is(_events('00000000-0000-0000-0000-00000000aa01', 'created'), 1,
  'a new lead''s timeline starts with a created event');

-- ---- Who reads the pipeline ---------------------------------------------------------------
set local role anon;
select _as(null, null, null);
select throws_ok($$ select count(*) from public.lead_stages $$, '42501', null, 'anon is denied lead_stages');
select throws_ok($$ select count(*) from public.lead_events $$, '42501', null, 'anon is denied lead_events');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.lead_stages), 5, 'admin reads the pipeline');
select is(_events('00000000-0000-0000-0000-00000000aa01', 'created'), 1, 'admin reads the timeline');
select lives_ok(
  $$ select lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at, version,
            created_by, updated_by from public.leads $$,
  'admin reads the pipeline columns of leads');
select throws_ok($$ select retention_before_spam from public.leads $$, '42501', null,
  'admin cannot read the saved spam horizon');
select throws_ok(
  $$ insert into public.lead_stages (tenant_id, key, label, tone, kind)
     values ('00000000-0000-0000-0000-000000000001', 'extra', 'Extra', 'gray', 'open') $$,
  '42501', null, 'admin cannot add a stage through the API (CRM settings, C9)');
select throws_ok($$ update public.lead_stages set label = 'Renamed' $$, '42501', null,
  'admin cannot rename a stage through the API');
select throws_ok(
  $$ insert into public.lead_events (tenant_id, lead_id, kind)
     values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000aa01', 'created') $$,
  '42501', null, 'admin cannot forge a timeline event');
select throws_ok($$ select count(*) from public.lead_notes $$, '42501', null,
  'admin cannot read the notes thread through the API (the audited path only)');
select throws_ok(
  $$ insert into public.lead_notes (tenant_id, lead_id, body, source)
     values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000aa01', 'x', 'staff') $$,
  '42501', null, 'admin cannot write the notes thread through the API');
select throws_ok(
  $$ update public.leads set stage_id = stage_id where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '42501', null, 'admin cannot move a stage directly yet (the versioned write API is C3)');

select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.lead_stages), 5, 'developer reads the pipeline');
select is(_events('00000000-0000-0000-0000-00000000aa01', 'created'), 1, 'developer reads the timeline');

select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.lead_stages) + (select count(*)::int from public.lead_events),
  0, 'content_creator reads no stage and no event');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.lead_stages) + (select count(*)::int from public.lead_events),
  0, 'seo reads no stage and no event');
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.lead_events), 0,
  'a demoted developer''s old token reads no timeline (live check)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.lead_stages
            where tenant_id = '00000000-0000-0000-0000-000000000001')
          + (select count(*)::int from public.lead_events
              where lead_id = '00000000-0000-0000-0000-00000000aa01'),
  0, 'another tenant''s admin reads none of T1''s stages or events');

-- ---- Legacy writes move the pipeline (the current admin, through the sync) --------------
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set status = 'in_progress'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1,
  'a legacy status write still works');
select is(_stage('00000000-0000-0000-0000-00000000aa01') || '/' ||
          (select version from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'contacted/2', 'in progress moves New to Contacted, and the version moves');
select ok((select first_response_at is not null from public.leads
            where id = '00000000-0000-0000-0000-00000000aa01'),
  'leaving the initial stage stamps the first response');
select is((select detail::text from public.lead_events
            where lead_id = '00000000-0000-0000-0000-00000000aa01' and kind = 'stage_changed'),
  '{"to": "contacted", "from": "new"}', 'the timeline records the move, by stage key');

-- Spam, written the OLD way: the flag follows, and so does the horizon (D2).
select is(_rows($$ update public.leads set status = 'spam'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1,
  'a legacy spam write');
select is((select is_spam::text || '/' || status from public.leads
            where id = '00000000-0000-0000-0000-00000000aa01')
          || '/' || _stage('00000000-0000-0000-0000-00000000aa01'),
  'true/spam/contacted', 'spam is a flag: the stage stays where it was');
select is(_events('00000000-0000-0000-0000-00000000aa01', 'spam_marked'), 1, 'the timeline records the spam mark');
reset role;
select ok(
  (select retention_delete_after > now() + interval '9 days'
          and retention_delete_after <= now() + interval '10 days'
          and retention_before_spam is null and spam_marked_at is not null
     from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'marking spam caps retention at the tenant''s spam_days (10), and saves the old horizon');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set status = 'new'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1,
  'a legacy write clears spam');
select is(_events('00000000-0000-0000-0000-00000000aa01', 'spam_cleared'), 1, 'the timeline records the clearing');
reset role;
select ok(
  (select not is_spam and retention_delete_after is null and spam_marked_at is null
          and status = 'new'
     from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'clearing spam restores the horizon it had (the default here) and the initial stage');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set status = 'done'
                    where id = '00000000-0000-0000-0000-00000000aa02' $$), 1, 'a legacy done write');
select is(_stage('00000000-0000-0000-0000-00000000aa02'), 'lost', 'legacy done maps to Lost (owner item O-8)');

-- A notes-only write: no version change, and the note joins the thread.
select is(_rows($$ update public.leads set internal_notes = 'Call back on Sunday'
                    where id = '00000000-0000-0000-0000-00000000aa02' $$), 1, 'a legacy notes write');
reset role;
select is((select version from public.leads where id = '00000000-0000-0000-0000-00000000aa02'), 2,
  'writing a note does not move the version (no spurious 409)');
select is((select body || '/' || source || '/' || created_by::text from public.lead_notes
            where lead_id = '00000000-0000-0000-0000-00000000aa02'),
  'Call back on Sunday/legacy/00000000-0000-0000-0000-0000000000a1',
  'the note is copied into the thread, attributed to its author');
select is((select count(*)::int from public.lead_events
            where lead_id = '00000000-0000-0000-0000-00000000aa02' and kind = 'note_added'
              and detail ? 'note_id' and not detail ? 'body'),
  1, 'the timeline records the note by id, never its text');

-- ---- New-style writes set the status (as the service role will, from C3) ---------------
update public.leads set stage_id = (select id from public.lead_stages
  where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'won')
 where id = '00000000-0000-0000-0000-00000000aa02';
select ok((select status = 'done' and won_at is not null from public.leads
            where id = '00000000-0000-0000-0000-00000000aa02'),
  'moving to Won sets status done and stamps won_at');
update public.leads set stage_id = (select id from public.lead_stages
  where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'proposal')
 where id = '00000000-0000-0000-0000-00000000aa02';
select ok((select status = 'in_progress' and won_at is null from public.leads
            where id = '00000000-0000-0000-0000-00000000aa02'),
  'leaving Won clears won_at; an open stage reads as in progress');
select throws_ok(
  $$ update public.leads set stage_id = (select id from public.lead_stages
       where tenant_id = '00000000-0000-0000-0000-0000000000ff' and key = 'won')
      where id = '00000000-0000-0000-0000-00000000aa02' $$,
  '23503', null, 'a lead cannot point at another tenant''s stage (composite key)');

-- The public form writes as the SERVICE ROLE, through every new trigger (the actor trigger
-- calls auth.uid() in that role). The suites above insert as the owner, so prove this one.
set local role service_role;
select _as(null, null, null);
select lives_ok(
  $$ insert into public.leads (id, tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-000000000001',
             'From the form', 'x', 'hi') $$,
  'the service role (the public contact form) still inserts a lead');
reset role;

-- A lead that arrives as spam is capped at once.
insert into public.leads (id, tenant_id, name, email_enc, message, status)
values ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000001', 'Junk', 'x', 'buy', 'spam');
select ok((select is_spam and retention_delete_after <= now() + interval '10 days'
             from public.leads where id = '00000000-0000-0000-0000-00000000aa03'),
  'a lead inserted as spam gets the spam horizon');

-- ---- The stage set ------------------------------------------------------------------------
select throws_ok(
  $$ delete from public.lead_stages where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'proposal' $$,
  '23503', null, 'a stage with leads in it cannot be deleted');
select throws_ok(
  $$ update public.lead_stages set is_initial = true
      where tenant_id = '00000000-0000-0000-0000-0000000000ff' and key = 'contacted' $$,
  '23505', null, 'a second initial stage is refused');
set constraints all immediate;
select throws_ok(
  $$ delete from public.lead_stages where tenant_id = '00000000-0000-0000-0000-0000000000ff' and key = 'won' $$,
  '23514', null, 'a pipeline without a won stage is refused');
select throws_ok(
  $$ insert into public.lead_stages (tenant_id, key, label, tone, kind) values
       ('00000000-0000-0000-0000-0000000000ff', 's1', 'S1', 'gray', 'open'),
       ('00000000-0000-0000-0000-0000000000ff', 's2', 'S2', 'gray', 'open'),
       ('00000000-0000-0000-0000-0000000000ff', 's3', 'S3', 'gray', 'open'),
       ('00000000-0000-0000-0000-0000000000ff', 's4', 'S4', 'gray', 'open'),
       ('00000000-0000-0000-0000-0000000000ff', 's5', 'S5', 'gray', 'open'),
       ('00000000-0000-0000-0000-0000000000ff', 's6', 'S6', 'gray', 'open') $$,
  '23514', null, 'a pipeline of more than 10 stages is refused');
set constraints all deferred;

-- ---- The catalog ---------------------------------------------------------------------------
select ok(
  (select count(*) = 22 from information_schema.columns
    where table_schema = 'public' and table_name = 'leads_safe')
  and exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'stage_id')
  and not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'leads_safe'
                     and column_name = 'retention_before_spam'),
  'leads_safe carries the pipeline columns and not the saved horizon');
select ok(
  has_table_privilege('authenticated', 'public.lead_stages', 'select')
  and has_table_privilege('authenticated', 'public.lead_events', 'select')
  and not has_table_privilege('authenticated', 'public.lead_stages', 'insert')
  and not has_table_privilege('authenticated', 'public.lead_events', 'insert')
  and not has_table_privilege('authenticated', 'public.lead_notes', 'select')
  and not has_table_privilege('authenticated', 'public.lead_notes', 'insert')
  and has_table_privilege('service_role', 'public.lead_notes', 'select')
  and has_table_privilege('service_role', 'public.lead_notes', 'insert')
  and has_table_privilege('service_role', 'public.lead_events', 'insert'),
  'grants: staff read stages and events only; the notes thread is service-role only');
select ok(
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'lead_events' and policyname = 'lead_events_live'
             and permissive = 'RESTRICTIVE'
             and qual like '%live_role%' and qual like '%effective_tenant_id%')
  and (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
        where oid in ('public.lead_stages'::regclass, 'public.lead_events'::regclass,
                      'public.lead_notes'::regclass, 'app.lead_counters'::regclass)),
  'the timeline carries the live check; every new table forces RLS');

select * from finish();
rollback;
