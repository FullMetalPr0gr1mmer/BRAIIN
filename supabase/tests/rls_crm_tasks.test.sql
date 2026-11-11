-- pgTAP: CRM tasks (0134, Admin v2 C8, crm.md §5.4, §8.1, §9, §13). Run with `supabase test db`.
--
-- crm.tasks is Admin's alone in C8 (Developer none, owner default O-7; Sales only from C10b).
-- Personas, each a token as PostgREST carries it: A admin, A2 a second admin, C content_creator,
-- S seo, D developer, L sales, O another tenant's admin, N anon; stale Admin tokens Ad (the
-- profile now says content_creator), Ao (switched off), Al (locked). Proven here:
--   1. reads: only a live Admin of the tenant reads tasks; every other principal and every
--      stale token reads none, through the table and through the readers;
--   2. writes: a live Admin adds, changes, ticks and removes tasks through the INVOKER doors
--      and the table; nobody else changes or removes one, and the stale tokens fail the live
--      check; anon holds nothing; the stamps, the version and done_by are not writable;
--   3. the rules: the version moves on an edit, never on a tick (40001 on a stale one); done
--      is stamped with the server's time and the session's person; the owner must be an
--      active tasks user of the tenant; a task cannot name another tenant's contact or lead,
--      one the caller cannot see, or a merge tombstone;
--   4. the timeline: task_created and task_done on the lead's and the contact's, with ids and
--      the type only; a task done is the contact's activity;
--   5. time: the day boundary in the studio's zone (21:30Z is tomorrow in Riyadh), the snooze
--      to tomorrow 10:00 local, a local date and time as an instant; the grouping and its
--      filter; the badge counts the caller's own overdue tasks;
--   6. cascade, retention, the orphan rule and the erasure counts;
--   7. grants (P-14) and the helper.
-- The C8 review added: the sidebar's leads count keeps C4a's rule (spam and a later stage left
-- out) for every role whose Leads badge reads it; an API session's direct insert is refused
-- before the owner and tombstone rules read anything (no membership oracle, C8-SEC-2); one
-- task read again (the drawer after a 409); clock changes in a zone with summer time; an
-- unlinked open task goes leads_months after it was made, whatever its due date (C8-SEC-1);
-- the erasure counts take a certain lead's, a ticked phone match's and an unticked one's
-- tasks apart (C8-SEC-4), and a lead's erasure counts its tasks (C8-SEC-3); every function
-- pins its search_path (C8-SEC-5).

begin;
select plan(87);

insert into public.tenants (id, name) values
  ('c8000000-0000-4000-8000-000000000001', 'C8 T1'),
  ('c8000000-0000-4000-8000-0000000000ff', 'C8 T2');

create table c8_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                         profile_role text, active boolean, locked boolean);
insert into c8_persona values
  ('A',  'c8000000-0000-4000-8000-0000000000a1', 'admin',           'c8000000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('A2', 'c8000000-0000-4000-8000-0000000000a5', 'admin',           'c8000000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c8000000-0000-4000-8000-0000000000c1', 'content_creator', 'c8000000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c8000000-0000-4000-8000-0000000000e1', 'seo',             'c8000000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c8000000-0000-4000-8000-0000000000d1', 'developer',       'c8000000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c8000000-0000-4000-8000-000000000051', 'sales',           'c8000000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c8000000-0000-4000-8000-0000000000f1', 'admin',           'c8000000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c8000000-0000-4000-8000-0000000000a2', 'admin',           'c8000000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c8000000-0000-4000-8000-0000000000a3', 'admin',           'c8000000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c8000000-0000-4000-8000-0000000000a4', 'admin',           'c8000000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c8-' || lower(code) || '@example.test' from c8_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C8 ' || code
    from c8_persona;

-- A contact and a lead in each tenant, the lead linked to the contact (as the link would), the
-- contact's activity in the past so a task done shows; a tombstone in T1.
insert into public.crm_contacts (id, tenant_id, display_name, company_name, last_activity_at) values
  ('c8000000-0000-4000-8000-00000000c001', 'c8000000-0000-4000-8000-000000000001', 'Huda Saleh', 'Acme', now() - interval '3 days'),
  ('c8000000-0000-4000-8000-00000000c002', 'c8000000-0000-4000-8000-000000000001', 'Merged Away', null, now()),
  ('c8000000-0000-4000-8000-00000000c0ff', 'c8000000-0000-4000-8000-0000000000ff', 'Other Person', null, now());
update public.crm_contacts set merged_into = 'c8000000-0000-4000-8000-00000000c001', merged_at = now()
 where id = 'c8000000-0000-4000-8000-00000000c002';
insert into public.leads (id, tenant_id, name, email_enc, message) values
  ('c8000000-0000-4000-8000-00000000aa01', 'c8000000-0000-4000-8000-000000000001', 'Huda', 'ciphertext-e', 'hello'),
  ('c8000000-0000-4000-8000-00000000aaff', 'c8000000-0000-4000-8000-0000000000ff', 'Other', 'ciphertext-o', 'hi');
update public.leads set contact_id = 'c8000000-0000-4000-8000-00000000c001', contact_link = 'email'
 where id = 'c8000000-0000-4000-8000-00000000aa01';
update public.crm_contacts set last_activity_at = now() - interval '3 days'
 where id = 'c8000000-0000-4000-8000-00000000c001';
-- One task in T2, as the migration role, for the cross-tenant reads.
insert into public.crm_tasks (id, tenant_id, title, due_at) values
  ('c8000000-0000-4000-8000-0000000077ff', 'c8000000-0000-4000-8000-0000000000ff', 'Theirs', now() + interval '1 day');

create function c8_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c8_persona p where p.code = p_code), ''), true)
$$;
-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function c8_run(p_sql text) returns text language plpgsql as $$
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
create function c8_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- A task body: tomorrow (local Riyadh) at 10:00 unless told otherwise.
create function c8_body(p_title text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title,
           'due_date', to_char((now() at time zone 'Asia/Riyadh')::date + 1, 'YYYY-MM-DD'),
           'due_time', '10:00') || p_extra
$$;
grant execute on function c8_as(text), c8_run(text), c8_val(text), c8_body(text, jsonb) to anon, authenticated;
grant select on c8_persona to anon, authenticated;
create temp table c8_out (who text, res text);
grant insert, select on c8_out to authenticated, anon;

-- ── 1. Writes by a live Admin, through the door ───────────────────────────────────────────
set local role authenticated;
select c8_as('A');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('Call Huda about the logo', jsonb_build_object(
               'type', 'call', 'contact_id', 'c8000000-0000-4000-8000-00000000c001',
               'lead_id', 'c8000000-0000-4000-8000-00000000aa01',
               'owner_id', 'c8000000-0000-4000-8000-0000000000a1', 'note', 'Bring the samples'))) ->> 'due_time' $$),
  '10:00', 'a live Admin adds a task; the answer reads its due time in the studio''s zone');
reset role;
select is((select to_char(due_at at time zone 'UTC', 'HH24:MI') || ' ' || created_by || ' ' || version
             from public.crm_tasks where title = 'Call Huda about the logo'),
  '07:00 c8000000-0000-4000-8000-0000000000a1 1',
  '10:00 in Riyadh is 07:00 UTC; the task is the session''s, at version 1');
select is((select string_agg(kind || ' ' || (detail ? 'task_id')::text || ' ' || (detail ->> 'type')
                             || ' ' || (detail::text ~ 'Huda|logo|samples')::text, ',')
             from public.lead_events where lead_id = 'c8000000-0000-4000-8000-00000000aa01'
              and kind like 'task_%'),
  'task_created true call false', 'the lead''s timeline says a task was added: its id and type, never its words');
select is((select count(*)::int from public.crm_contact_events
            where contact_id = 'c8000000-0000-4000-8000-00000000c001' and kind = 'task_created'),
  1, 'and so does the contact''s');
select ok((select last_activity_at < now() - interval '2 days' from public.crm_contacts
            where id = 'c8000000-0000-4000-8000-00000000c001'),
  'planning a task is not the contact''s activity');

-- More tasks for the reads: one overdue (A's), one later today or tomorrow (A2's), one done
-- long ago (for retention), one about no one.
insert into public.crm_tasks (id, tenant_id, title, type, owner_id, due_at) values
  ('c8000000-0000-4000-8000-000000007701', 'c8000000-0000-4000-8000-000000000001', 'Overdue one', 'email',
   'c8000000-0000-4000-8000-0000000000a1', now() - interval '2 hours'),
  ('c8000000-0000-4000-8000-000000007702', 'c8000000-0000-4000-8000-000000000001', 'Someone else''s', 'todo',
   'c8000000-0000-4000-8000-0000000000a5', now() - interval '1 hour'),
  ('c8000000-0000-4000-8000-000000007703', 'c8000000-0000-4000-8000-000000000001', 'About no one', 'todo',
   null, now() + interval '20 days');

-- (C8 review, C8-TEST-1) Two leads the Leads badge must not count: spam in the initial stage,
-- and a lead moved on to a later stage.
insert into public.leads (id, tenant_id, name, email_enc, message, is_spam) values
  ('c8000000-0000-4000-8000-00000000ab51', 'c8000000-0000-4000-8000-000000000001', 'Spam', 'ciphertext-s', 'buy', true),
  ('c8000000-0000-4000-8000-00000000ab52', 'c8000000-0000-4000-8000-000000000001', 'Moved on', 'ciphertext-m', 'hi', false);
update public.leads
   set stage_id = (select s.id from public.lead_stages s
                    where s.tenant_id = 'c8000000-0000-4000-8000-000000000001' and not s.is_initial
                    order by s.id limit 1)
 where id = 'c8000000-0000-4000-8000-00000000ab52';

-- ── 2. Reads ──────────────────────────────────────────────────────────────────────────────
set local role authenticated;
select c8_as('A');
select is(c8_val($$ select count(*) from public.crm_tasks $$), '4', 'a live Admin reads the tenant''s tasks, and only them');
select is(c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$),
  '{"done": 0, "today": 0, "overdue": 2, "upcoming": 2}', 'the grouping counts everyone''s');
select is(c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{"view":"mine"}') -> 'counts')::text $$),
  '{"done": 0, "today": 0, "overdue": 1, "upcoming": 1}', 'My tasks counts the caller''s own');
select is(c8_val($$ select public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') ->> 'mine_open' $$),
  '2', 'mine_open counts the caller''s open tasks');
select is(c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001',
                     '{"lead":"c8000000-0000-4000-8000-00000000aa01"}') -> 'upcoming' -> 0) ->> 'contact_name' $$),
  'Huda Saleh', 'a lead''s tasks, each naming its contact');
select is(c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001',
                     '{"contact":"c8000000-0000-4000-8000-00000000c001"}') -> 'upcoming' -> 0) ->> 'lead_number' $$)
          <> '(null)', true, 'a contact''s tasks, each naming its lead');
select is(c8_val($$ select string_agg(x ->> 'title', ',' order by x ->> 'title')
                     from jsonb_array_elements(public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'overdue') x $$),
  'Overdue one,Someone else''s', 'the overdue list');
select is(c8_val($$ select public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{"q":"x"}') $$),
  '22023', 'an unknown filter key is refused');
select is(c8_val($$ select public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{"view":"theirs"}') $$),
  '22023', 'so is an unknown view');
select is(c8_val($$ select public.crm_tasks_grouped('c8000000-0000-4000-8000-0000000000ff', '{}') $$),
  '42501', 'naming another tenant is refused');
select is(c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$),
  '1', 'the badge: my overdue tasks only');
select is(c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001')::text $$),
  '{"leads": 1, "tasks": 1}',
  'the sidebar''s one CRM read: new leads (the initial stage, no spam) and my overdue tasks');
select is(c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001')::text $$),
  (select jsonb_build_object('leads', count(*)::int, 'tasks', 1)::text
     from public.leads_safe l join public.lead_stages s on s.tenant_id = l.tenant_id and s.id = l.stage_id
    where l.tenant_id = 'c8000000-0000-4000-8000-000000000001' and not l.is_spam and s.is_initial),
  'its leads count is the leads counter''s rule (C4a: the initial stage, spam left out)');
select c8_as('O');
select is(c8_val($$ select string_agg(title, ',') from public.crm_tasks $$), 'Theirs',
  'another tenant''s Admin reads only its own tenant''s task');
reset role;

set local role authenticated;
select c8_as('C');
insert into c8_out select 'C', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select c8_as('S');
insert into c8_out select 'S', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select c8_as('D');
insert into c8_out select 'D', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select c8_as('L');
insert into c8_out select 'L', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select c8_as('Ad');
insert into c8_out select 'Ad', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select c8_as('Ao');
insert into c8_out select 'Ao', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select c8_as('Al');
insert into c8_out select 'Al', c8_val($$ select count(*) from public.crm_tasks $$) || '/'
  || c8_val($$ select (public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$) || '/'
  || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$);
select is((select string_agg(who || '=' || res, ' ' order by who) from c8_out),
  'Ad=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0 '
  || 'Al=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0 '
  || 'Ao=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0 '
  || 'C=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0 '
  || 'D=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0 '
  || 'L=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0 '
  || 'S=0/{"done": 0, "today": 0, "overdue": 0, "upcoming": 0}/0',
  'no other role, and no stale Admin token (demoted, switched off, locked), reads a task through the table, the grouping or the badge');
select c8_as('Ao');
select is(c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001')::text $$),
  '{"leads": 0, "tasks": 0}', 'a switched-off Admin''s token counts no lead and no task in the sidebar''s read');
select c8_as('D');
select is(c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001')::text $$),
  '{"leads": 1, "tasks": 0}',
  'a Developer''s Leads badge keeps C4a''s rule (spam and the later stage left out), and counts no task');
select c8_as('L');
select is(c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001')::text $$),
  '{"leads": 1, "tasks": 0}', 'and so does a Sales token''s');
select c8_as('C');
select is(c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001')::text $$),
  '{"leads": 0, "tasks": 0}', 'a Content Creator counts neither');
reset role;
set local role anon;
select c8_as('N');
select is(c8_val($$ select count(*) from public.crm_tasks $$) || ' '
          || c8_val($$ select public.crm_tasks_grouped('c8000000-0000-4000-8000-000000000001', '{}') $$) || ' '
          || c8_val($$ select public.crm_my_overdue_tasks('c8000000-0000-4000-8000-000000000001') $$) || ' '
          || c8_val($$ select public.crm_nav_counts('c8000000-0000-4000-8000-000000000001') $$) || ' '
          || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$),
  '42501 42501 42501 42501 42501', 'anon holds nothing: no read, no reader, no door');
reset role;

-- ── 3. Changes, the version and the done stamps ─────────────────────────────────────────────
set local role authenticated;
select c8_as('A');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', 1, '{"title":"Overdue, renamed"}') ->> 'version' $$),
  '2', 'an edit at the version read moves the version');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', 1, '{"title":"Again"}') $$),
  '40001', 'an edit at a stale version is a conflict');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', null, '{"title":"No version"}') $$),
  '22023', 'an edit without a version is refused');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', null, '{"done":true}') ->> 'version' $$),
  '2', 'a tick needs no version and moves none');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', 2, '{"colour":"red"}') $$),
  '22023', 'an unknown key is refused');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-0000000077ff', null, '{"done":true}') $$),
  'P0002', 'another tenant''s task is not there');
select is(c8_run($$ update public.crm_tasks set done_at = '2001-01-01' where id = 'c8000000-0000-4000-8000-000000007702' $$),
  'ok:1', 'a tick written to the table directly');
reset role;
select is((select (done_at > now() - interval '1 minute')::text || ' ' || done_by
             from public.crm_tasks where id = 'c8000000-0000-4000-8000-000000007702'),
  'true c8000000-0000-4000-8000-0000000000a1', 'takes the server''s time and the session''s person, never the client''s');
set local role authenticated;
select c8_as('A');
select is(
  c8_run($$ update public.crm_tasks set version = 9 $$) || ' '
  || c8_run($$ update public.crm_tasks set done_by = null $$) || ' '
  || c8_run($$ update public.crm_tasks set created_by = null $$) || ' '
  || c8_run($$ update public.crm_tasks set tenant_id = 'c8000000-0000-4000-8000-0000000000ff' $$) || ' '
  || c8_run($$ insert into public.crm_tasks (title, due_at, done_by) values ('x', now(), null) $$),
  '42501 42501 42501 42501 42501', 'the version, done_by, the stamps and the tenant are not writable');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007703', 1, '{"snooze":"tomorrow_10"}') ->> 'due_time' $$)
          || ' ' || c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007703', 2, '{"snooze":"tomorrow_10"}') ->> 'due_date' $$),
  '10:00 ' || to_char((now() at time zone 'Asia/Riyadh')::date + 1, 'YYYY-MM-DD'),
  'snoozed: tomorrow at 10:00 in the studio''s zone (twice: the second moves nothing, so no version)');
select is(c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701') ->> 'version' $$)
          || ' ' || c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701') ->> 'title' $$)
          || ' ' || c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-0000000077ff') $$),
  '2 Overdue, renamed P0002',
  'one task read again as it is now (the drawer after a 409); another tenant''s is not there');
select c8_as('C');
insert into c8_out select 'rC', c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701') $$);
select c8_as('Ad');
insert into c8_out select 'rAd', c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701') $$);
select c8_as('O');
insert into c8_out select 'rO', c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701') $$);
select is((select string_agg(who || '=' || res, ' ' order by who) from c8_out where who like 'r%'),
  'rAd=P0002 rC=P0002 rO=42501',
  'nobody else reads it: another role and a stale token find no task, another tenant''s Admin cannot name this tenant');
reset role;
set local role anon;
select is(c8_val($$ select public.crm_task_read('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701') $$), '42501', 'anon cannot call it');
reset role;

-- Everyone else changes and removes nothing.
delete from c8_out;
set local role authenticated;
select c8_as('C');
insert into c8_out select 'C', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('S');
insert into c8_out select 'S', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('D');
insert into c8_out select 'D', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('L');
insert into c8_out select 'L', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('O');
insert into c8_out select 'O', c8_run($$ update public.crm_tasks set title = 'x' where tenant_id = 'c8000000-0000-4000-8000-000000000001' $$)
  || ',' || c8_run($$ delete from public.crm_tasks where tenant_id = 'c8000000-0000-4000-8000-000000000001' $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('Ad');
insert into c8_out select 'Ad', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('Ao');
insert into c8_out select 'Ao', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select c8_as('Al');
insert into c8_out select 'Al', c8_run($$ update public.crm_tasks set title = 'x' $$) || ',' || c8_run($$ delete from public.crm_tasks $$)
  || ',' || c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001', c8_body('x')) $$);
select is((select string_agg(who || '=' || res, ' ' order by who) from c8_out),
  'Ad=ok:0,ok:0,42501 Al=ok:0,ok:0,42501 Ao=ok:0,ok:0,42501 C=ok:0,ok:0,42501 D=ok:0,ok:0,42501 '
  || 'L=ok:0,ok:0,42501 O=ok:0,ok:0,42501 S=ok:0,ok:0,42501',
  'no other principal, and no stale Admin token, changes, removes or adds a task');
select c8_as('O');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', 2, '{"title":"x"}') $$),
  '42501', 'another tenant''s Admin cannot name this tenant to the door');
select c8_as('Ad');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007701', null, '{"done":false}') $$),
  'P0002', 'a demoted token''s tick finds no task');
reset role;
set local role anon;
select is(c8_run($$ update public.crm_tasks set title = 'x' $$) || ' ' || c8_run($$ delete from public.crm_tasks $$),
  '42501 42501', 'anon cannot try');
reset role;
select is((select title from public.crm_tasks where id = 'c8000000-0000-4000-8000-000000007701'),
  'Overdue, renamed', 'and the task is as the live Admin left it');

-- ── 4. The rules: the owner and the links ──────────────────────────────────────────────────
set local role authenticated;
select c8_as('A');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"owner_id":"c8000000-0000-4000-8000-0000000000d1"}')) $$),
  '23514', 'an owner without crm.tasks (a Developer) is refused');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"owner_id":"c8000000-0000-4000-8000-0000000000a3"}')) $$),
  '23514', 'so is a switched-off Admin');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"owner_id":"c8000000-0000-4000-8000-0000000000f1"}')) $$),
  '23514', 'and another tenant''s Admin');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"contact_id":"c8000000-0000-4000-8000-00000000c0ff"}')) $$),
  '23503', 'a contact of another tenant is not there');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"lead_id":"c8000000-0000-4000-8000-00000000aaff"}')) $$),
  '23503', 'nor a lead of another tenant');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"contact_id":"c8000000-0000-4000-8000-00000000c002"}')) $$),
  '23503', 'nor a merged contact');
select is(c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, contact_id)
                    values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-00000000c002') $$),
  '23514', 'a direct insert naming a merged contact meets the trigger');
select is(c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, contact_id)
                    values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-00000000c0ff') $$),
  '23503', 'and one naming another tenant''s contact meets the composite key');
select is(c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
                    values ('c8000000-0000-4000-8000-0000000000ff', 'x', now(), 'c8000000-0000-4000-8000-0000000000f1') $$)
          || ' ' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
                    values ('c8000000-0000-4000-8000-0000000000ff', 'x', now(), 'c8000000-0000-4000-8000-0000000000a1') $$),
  '42501 42501',
  'an Admin''s direct insert into another tenant is refused before the owner rule looks (an Admin there or not, the same answer)');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('   ')) $$), '23514', 'a blank title is refused');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             jsonb_build_object('title', 'x', 'due_date', '2026-11-10')) $$),
  '22023', 'a due date without a time is refused');
select is(c8_val($$ select public.crm_task_create('c8000000-0000-4000-8000-000000000001',
             c8_body('x', '{"type":"fax"}')) $$), '23514', 'an unknown type is refused');
reset role;

-- (C8 review, C8-SEC-2) Every other token, inserting straight into the table, gets RLS's answer
-- whatever the row names: another tenant's Admin as owner, a made-up uuid, a merged contact.
delete from c8_out;
set local role authenticated;
select c8_as('C');
insert into c8_out select 'C',
  c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
            values ('c8000000-0000-4000-8000-0000000000ff', 'x', now(), 'c8000000-0000-4000-8000-0000000000f1') $$)
  || ',' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
            values ('c8000000-0000-4000-8000-0000000000ff', 'x', now(), 'c8000000-0000-4000-8000-0000000000e9') $$)
  || ',' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, contact_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-00000000c002') $$);
select c8_as('L');
insert into c8_out select 'L',
  c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-0000000000a1') $$)
  || ',' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-0000000000e9') $$)
  || ',' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, contact_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-00000000c002') $$);
select c8_as('Ad');
insert into c8_out select 'Ad',
  c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-0000000000a1') $$)
  || ',' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-0000000000e9') $$)
  || ',' || c8_run($$ insert into public.crm_tasks (tenant_id, title, due_at, contact_id)
            values ('c8000000-0000-4000-8000-000000000001', 'x', now(), 'c8000000-0000-4000-8000-00000000c002') $$);
select is((select string_agg(who || '=' || res, ' ' order by who) from c8_out),
  'Ad=42501,42501,42501 C=42501,42501,42501 L=42501,42501,42501',
  'no token without a live tasks role learns who is an Admin, or which contact was merged, from a direct insert');
reset role;

-- ── 5. Done is the contact's activity; the timeline ─────────────────────────────────────────
set local role authenticated;
select c8_as('A');
select is(c8_val($$ select public.crm_task_update('c8000000-0000-4000-8000-000000000001',
             (select id from public.crm_tasks where title = 'Call Huda about the logo'), null, '{"done":true}') ->> 'done_at' $$)
          <> '(null)', true, 'the call is ticked done');
reset role;
select is((select count(*)::int from public.lead_events
            where lead_id = 'c8000000-0000-4000-8000-00000000aa01' and kind = 'task_done')
          || '/' || (select count(*)::int from public.crm_contact_events
                      where contact_id = 'c8000000-0000-4000-8000-00000000c001' and kind = 'task_done'),
  '1/1', 'task_done on the lead''s timeline and the contact''s');
select ok((select last_activity_at > now() - interval '1 minute' from public.crm_contacts
            where id = 'c8000000-0000-4000-8000-00000000c001'),
  'a task done is the contact''s activity');

-- ── 6. Time ────────────────────────────────────────────────────────────────────────────────
select is(app.crm_task_bucket('2026-11-10T21:30:00Z', null, '2026-11-10T12:00:00Z', 'Asia/Riyadh'),
  'upcoming', '21:30Z is 00:30 tomorrow in Riyadh: upcoming, not today');
select is(app.crm_task_bucket('2026-11-10T20:30:00Z', null, '2026-11-10T12:00:00Z', 'Asia/Riyadh'),
  'today', '20:30Z is 23:30 today in Riyadh');
select is(app.crm_task_bucket('2026-11-10T20:30:00Z', null, '2026-11-10T12:00:00Z', 'UTC'),
  'today', 'and today in UTC too');
select is(app.crm_task_bucket('2026-11-10T11:59:00Z', null, '2026-11-10T12:00:00Z', 'Asia/Riyadh'),
  'overdue', 'due a minute ago: overdue');
select is(app.crm_task_bucket('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-10T12:00:00Z', 'Asia/Riyadh'),
  'done', 'done is done, whenever it was due');
select is(app.crm_task_snooze_at('2026-11-10T21:30:00Z', 'Asia/Riyadh'), '2026-11-12T07:00:00Z'::timestamptz,
  'snoozed at 00:30 local on the 11th: 10:00 local on the 12th');
select is(app.crm_local_at('2026-11-11', '10:00', 'Asia/Riyadh'), '2026-11-11T07:00:00Z'::timestamptz,
  'a local 10:00 in Riyadh is 07:00Z');
select is(app.crm_local_at('2026-07-01', '10:00', 'Europe/London'), '2026-07-01T09:00:00Z'::timestamptz,
  'and in London in summer, 09:00Z');
-- (C8 review, C8-TEST-2) A zone with summer time (U9 lets the studio pick one): the snooze and
-- the day across both of London's 2026 clock changes (29 March, 25 October).
select is(app.crm_task_snooze_at('2026-03-28T12:00:00Z', 'Europe/London')::text
          || ' ' || app.crm_task_snooze_at('2026-10-24T12:00:00Z', 'Europe/London')::text,
  (timestamptz '2026-03-29T09:00:00Z')::text || ' ' || (timestamptz '2026-10-25T10:00:00Z')::text,
  'snoozed the day before a clock change: 10:00 local on the day, at that day''s offset (09:00Z in summer time, 10:00Z after it)');
select is(app.crm_task_bucket('2026-03-29T22:30:00Z', null, '2026-03-29T00:30:00Z', 'Europe/London')
          || ' ' || app.crm_task_bucket('2026-03-29T23:30:00Z', null, '2026-03-29T00:30:00Z', 'Europe/London')
          || ' ' || app.crm_task_bucket('2026-10-25T23:30:00Z', null, '2026-10-25T00:30:00Z', 'Europe/London')
          || ' ' || app.crm_task_bucket('2026-10-26T00:30:00Z', null, '2026-10-25T00:30:00Z', 'Europe/London'),
  'today upcoming today upcoming',
  'the local day on a clock-change day: 23:30 local is today, 00:30 local the next day is not');
select is(app.crm_local_at('2026-03-29', '01:30', 'Europe/London'), '2026-03-29T01:30:00Z'::timestamptz,
  'a local time the clocks skip (01:30 on 29 March) moves forward: 02:30 summer time, 01:30Z');

-- ── 7. Removal, cascade, retention, the orphan rule, erasure counts ─────────────────────────
set local role authenticated;
select c8_as('A');
select is(c8_val($$ select public.crm_task_delete('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007703', 1) $$), '40001', 'a removal at a stale version is a conflict');
select is(c8_val($$ select public.crm_task_delete('c8000000-0000-4000-8000-000000000001',
             'c8000000-0000-4000-8000-000000007703', 2)::text $$),
  '{"done": false, "lead_id": null, "contact_id": null}', 'a live Admin removes a task at the version read');
reset role;
-- An auto-contact (made by the system: no session) with a task is not an orphan.
select set_config('request.jwt.claims', '', true);
insert into public.crm_contacts (id, tenant_id, display_name) values
  ('c8000000-0000-4000-8000-00000000c003', 'c8000000-0000-4000-8000-000000000001', 'Auto');
select ok(app.crm_contact_is_orphan('c8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-00000000c003'),
  'an untouched auto-contact is an orphan');
insert into public.crm_tasks (tenant_id, title, due_at, contact_id) values
  ('c8000000-0000-4000-8000-000000000001', 'Follow up', now() + interval '1 day', 'c8000000-0000-4000-8000-00000000c003');
select ok(not app.crm_contact_is_orphan('c8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-00000000c003'),
  'with a task it is not (a person is working with them)');
-- Retention: a task done long ago goes; so does an open one about no one made long ago, even
-- edited today and due in 2099 (C8-SEC-1: crm.md §8.1, "Unlinked: created_at + horizon"); one
-- made today stays, however long ago it was due.
insert into public.crm_tasks (id, tenant_id, title, due_at) values
  ('c8000000-0000-4000-8000-000000007704', 'c8000000-0000-4000-8000-000000000001', 'Old done', now() - interval '3 years'),
  ('c8000000-0000-4000-8000-000000007705', 'c8000000-0000-4000-8000-000000000001', 'Old open', '2099-06-01T07:00:00Z'),
  ('c8000000-0000-4000-8000-000000007706', 'c8000000-0000-4000-8000-000000000001', 'New, due long ago', now() - interval '3 years');
alter table public.crm_tasks disable trigger crm_tasks_row;
update public.crm_tasks set done_at = now() - interval '3 years', done_by = null
 where id = 'c8000000-0000-4000-8000-000000007704';
update public.crm_tasks set created_at = now() - interval '3 years', updated_at = now()
 where id = 'c8000000-0000-4000-8000-000000007705';
alter table public.crm_tasks enable trigger crm_tasks_row;
select is((app.run_retention() ->> 'tasks_purged')::int, 2,
  'the nightly run removes a task done past the horizon and an open one about no one made past it (edited today, due in 2099)');
select is((select string_agg(title, ',' order by title) from public.crm_tasks
            where tenant_id = 'c8000000-0000-4000-8000-000000000001'),
  'Call Huda about the logo,Follow up,New, due long ago,Overdue, renamed,Someone else''s', 'and keeps the rest');
select ok(exists (select 1 from public.crm_contacts where id = 'c8000000-0000-4000-8000-00000000c003'),
  'the auto-contact with a task stays');
-- Erasure counts the tasks that go (C8-SEC-4): Huda's second lead (certain: linked by e-mail)
-- with a task on it alone, two phone matches (one to tick, one not) each with a task on it
-- alone, and a task about Huda AND the ticked match (counted once, with Huda).
insert into public.leads (id, tenant_id, name, email_enc, message) values
  ('c8000000-0000-4000-8000-00000000aa02', 'c8000000-0000-4000-8000-000000000001', 'Huda again', 'ciphertext-2', 'hi'),
  ('c8000000-0000-4000-8000-00000000aa03', 'c8000000-0000-4000-8000-000000000001', 'Same phone', 'ciphertext-3', 'hi'),
  ('c8000000-0000-4000-8000-00000000aa04', 'c8000000-0000-4000-8000-000000000001', 'Same phone too', 'ciphertext-4', 'hi');
update public.leads set contact_id = 'c8000000-0000-4000-8000-00000000c001', contact_link = 'email'
 where id = 'c8000000-0000-4000-8000-00000000aa02';
update public.leads set contact_id = 'c8000000-0000-4000-8000-00000000c001', contact_link = 'phone'
 where id in ('c8000000-0000-4000-8000-00000000aa03', 'c8000000-0000-4000-8000-00000000aa04');
insert into public.crm_tasks (tenant_id, title, due_at, contact_id, lead_id) values
  ('c8000000-0000-4000-8000-000000000001', 'On the second lead', now(), null, 'c8000000-0000-4000-8000-00000000aa02'),
  ('c8000000-0000-4000-8000-000000000001', 'On the ticked match', now(), null, 'c8000000-0000-4000-8000-00000000aa03'),
  ('c8000000-0000-4000-8000-000000000001', 'On the unticked match', now(), null, 'c8000000-0000-4000-8000-00000000aa04'),
  ('c8000000-0000-4000-8000-000000000001', 'About Huda and the match', now(),
   'c8000000-0000-4000-8000-00000000c001', 'c8000000-0000-4000-8000-00000000aa03');
set local role service_role;
select is((select (p ->> 'tasks') || ' ' || string_agg(right(m ->> 'id', 4) || ':' || (m ->> 'tasks'), ' ' order by m ->> 'id')
             from public.crm_erase_preview('c8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-00000000c001',
                    'c8000000-0000-4000-8000-0000000000a1') p,
                  jsonb_array_elements(p -> 'phone_matches') m
            group by p ->> 'tasks'),
  '3 aa03:1 aa04:1',
  'the preview counts the tasks about the person or a certain lead (3), and each phone match its own (the shared one is counted once, above)');
select is((public.crm_erase_person('c8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-00000000c001',
            array['c8000000-0000-4000-8000-00000000aa03']::uuid[], 'c8000000-0000-4000-8000-0000000000a1') ->> 'tasks')::int, 4,
  'the erasure with one match ticked counts the preview''s 3 and that match''s 1');
reset role;
select is((select string_agg(title, ',' order by title) from public.crm_tasks
            where title in ('Call Huda about the logo', 'On the second lead', 'On the ticked match',
                            'On the unticked match', 'About Huda and the match')),
  'On the unticked match', 'and those went with the person, by cascade; the unticked match''s stays');
-- (C8-SEC-3) A lead's erasure counts its tasks, which go with it.
insert into public.crm_tasks (tenant_id, title, due_at, lead_id) values
  ('c8000000-0000-4000-8000-000000000001', 'Lead erase one', now(), 'c8000000-0000-4000-8000-00000000aa04'),
  ('c8000000-0000-4000-8000-000000000001', 'Lead erase two', now(), 'c8000000-0000-4000-8000-00000000aa04');
set local role service_role;
select is((public.crm_erase_lead('c8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-00000000aa04',
            'c8000000-0000-4000-8000-0000000000a1') ->> 'tasks')::int, 3,
  'a lead''s erasure counts the tasks on it');
reset role;
select is((select count(*)::int from public.crm_tasks where lead_id = 'c8000000-0000-4000-8000-00000000aa04'
              or title in ('Lead erase one', 'Lead erase two', 'On the unticked match')), 0,
  'and they went with it');
-- A lead's tasks go with the lead.
insert into public.crm_tasks (tenant_id, title, due_at, lead_id) values
  ('c8000000-0000-4000-8000-0000000000ff', 'Lead task', now(), 'c8000000-0000-4000-8000-00000000aaff');
delete from public.leads where id = 'c8000000-0000-4000-8000-00000000aaff';
select is((select count(*)::int from public.crm_tasks where title = 'Lead task'), 0, 'a lead''s tasks go with the lead');

-- ── 8. Grants and the helper ────────────────────────────────────────────────────────────────
select ok(not has_table_privilege('anon', 'public.crm_tasks', 'select')
          and not has_any_column_privilege('anon', 'public.crm_tasks', 'select, insert, update')
          and not has_table_privilege('authenticated', 'public.crm_tasks', 'insert')
          and not has_table_privilege('authenticated', 'public.crm_tasks', 'update')
          and not has_column_privilege('authenticated', 'public.crm_tasks', 'done_by', 'update')
          and not has_column_privilege('authenticated', 'public.crm_tasks', 'version', 'update')
          and has_table_privilege('service_role', 'public.crm_tasks', 'select, insert, update, delete'),
  'grants as stated: anon nothing; staff named columns only; the service role the table');
select ok(not has_function_privilege('anon', 'public.crm_tasks_grouped(uuid, jsonb)', 'execute')
          and not has_function_privilege('service_role', 'public.crm_task_create(uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'app.role_crm_tasks(text)', 'execute')
          and not has_function_privilege('authenticated', 'app.purge_crm_tasks()', 'execute'),
  'the readers and doors are staff''s alone; the purge no API role''s');
select is((select string_agg(f, ',' order by f) from unnest(array[
              'app.crm_local_at(date, time without time zone, text)',
              'app.crm_task_bucket(timestamp with time zone, timestamp with time zone, timestamp with time zone, text)',
              'app.crm_task_snooze_at(timestamp with time zone, text)', 'app.crm_task_tenant_ok(uuid)',
              'app.crm_task_input(jsonb, boolean)']) f
             where not exists (select 1 from pg_proc p, unnest(p.proconfig) c
                                where p.oid = f::regprocedure and c = 'search_path=""')),
  null, 'the zone and input helpers pin an empty search_path (C8-SEC-5)');
select is((select string_agg(r || ':' || app.role_crm_tasks(r)::int, ' ' order by r)
             from unnest(enum_range(null::public.app_role)::text[] || array['anon']) r),
  'admin:1 anon:0 content_creator:0 developer:0 sales:0 seo:0',
  'app.role_crm_tasks answers Admin alone (CLAUDE.md §5: Sales from C10b)');

select * from finish();
rollback;
