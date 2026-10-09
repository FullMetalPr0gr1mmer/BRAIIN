-- pgTAP: Leads v2, part 4 (0041, Admin v2 C3) — writing the pipeline. Run with
-- `supabase test db`.
--
-- Covers: the crm.erase helper over every role; who may call each new door; the staff column
-- grant (exactly the pipeline's columns and the legacy pair); versioned writes through it (a
-- stale version changes nothing) and the unversioned marks (star, read, logged contact) that
-- never move the version, a star or a read mark not being an edit (who last changed the lead,
-- and when, stay); a contact logged on a lead past New answering nothing; the assignee rule
-- (an active lead worker of the lead's tenant); the tag and value rules; the read mark and the
-- logged contact taking the server's time and the session's person; the timeline's new events;
-- bulk over the six principals and a stale token, with every outcome (applied, conflict,
-- missing, skipped) and every refusal; erasure and note deletion as the service role, checking
-- the acting profile live (app.crm_eraser_ok: inactive, locked, a lock run out, another
-- tenant), who the service role writes as, and the note_deleted event; note counts; a manual
-- lead through ingest and who it names; a multi-row audit insert still chained row by row
-- (writeAuditMany); and the assignee key's SET NULL and its refusal to let an assigned profile
-- change tenant. CLAUDE.md §3, §5, §8, §9.

begin;
select plan(109);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'inactive-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'locked-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'unlocked-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'inactive-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'admin', false, null),
  -- locked out now (five failed sign-ins), and one whose lock has run out
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'admin', true, now() + interval '15 minutes'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000001', 'admin', true, now() - interval '15 minutes'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  -- demoted: the token still says developer
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'developer', false, null),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null);

insert into public.leads (id, tenant_id, name, email_enc, message) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000001', 'First', 'x', 'hi'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-000000000001', 'Second', 'x', 'hi'),
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-000000000001', 'To erase', 'x', 'hi'),
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-000000000001', 'Tagged', 'x', 'hi'),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000ff', 'Other', 'x', 'hi');
-- A lead already past New when it arrived (as the backfill leaves an old one): no first response.
insert into public.leads (id, tenant_id, name, email_enc, message, stage_id) values
  ('00000000-0000-0000-0000-00000000aa07', '00000000-0000-0000-0000-000000000001', 'Contacted already', 'x', 'hi',
   (select id from public.lead_stages
     where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'contacted'));

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

-- Rows a statement touched, as the CURRENT role.
create function _rows(p_sql text) returns int language plpgsql as $f$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;

-- One bulk call, as the CURRENT role: "<last four of the id>:<outcome>" per item, in id order.
create function _bulk(p_action text, p_value jsonb, p_items jsonb) returns text language sql as $$
  select string_agg(right(b.lead_id::text, 4) || ':' || b.outcome, ',' order by b.lead_id)
    from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', p_action, p_value, p_items) b
$$;

-- An item list: {id, version} per lead.
create function _item(p_id text, p_version int default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'version', p_version))
$$;

-- ---- The helper and who may call what -------------------------------------------------------
select is(
  (select array_agg(r::text order by r::text)
     from unnest(enum_range(null::public.app_role)) r
    where app.role_crm_erase(r::text)),
  array['admin'], 'app.role_crm_erase holds for exactly one role, admin (crm.erase, §5)');
select ok(not app.role_crm_erase(null) and not app.role_crm_erase('anon'),
  'and for no one without a role');
select ok(
  not has_function_privilege('anon', 'app.role_crm_erase(text)', 'execute')
  and has_function_privilege('authenticated', 'app.role_crm_erase(text)', 'execute')
  and has_function_privilege('service_role', 'app.role_crm_erase(text)', 'execute'),
  'app.role_crm_erase: staff and the service role execute it, anon does not');
select ok(
  has_function_privilege('authenticated', 'public.leads_bulk_update(uuid, text, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.leads_bulk_update(uuid, text, jsonb, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.leads_bulk_update(uuid, text, jsonb, jsonb)', 'execute')
  and not (select prosecdef from pg_proc
            where oid = 'public.leads_bulk_update(uuid, text, jsonb, jsonb)'::regprocedure),
  'leads_bulk_update is the caller''s door: authenticated only, SECURITY INVOKER');
select ok(
  (select bool_and(not has_function_privilege('anon', f, 'execute')
                   and not has_function_privilege('authenticated', f, 'execute')
                   and has_function_privilege('service_role', f, 'execute'))
     from unnest(array['public.crm_erase_lead(uuid, uuid, uuid)',
                       'public.crm_delete_lead_note(uuid, uuid, uuid, uuid)',
                       'public.crm_lead_note_counts(uuid, uuid[])',
                       'public.crm_ingest_lead(uuid, jsonb)',
                       'app.crm_eraser_ok(uuid, uuid)']) f),
  'the erase, note-delete, note-count and ingest doors are the service role''s alone');
select is(
  (select array_agg(a.attname::text order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'update')),
  array['assigned_to', 'internal_notes', 'is_spam', 'is_starred', 'last_contact_at',
        'last_contact_channel', 'read_at', 'stage_id', 'status', 'tags', 'value_sar'],
  'staff UPDATE on leads: the pipeline''s columns and the legacy pair, nothing else');
select ok(
  (select count(*) = 8 from information_schema.columns
    where table_schema = 'public' and table_name = 'leads_safe'
      and column_name in ('assigned_to', 'value_sar', 'is_starred', 'read_at', 'read_by', 'tags',
                          'last_contact_at', 'last_contact_channel')),
  'leads_safe carries the new pipeline columns');

-- ---- Versioned writes through the column grant ----------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads
                      set stage_id = (select id from public.lead_stages where key = 'contacted')
                    where id = '00000000-0000-0000-0000-00000000aa01' and version = 1 $$), 1,
  'admin moves a stage at the version it read');
select is(_rows($$ update public.leads
                      set stage_id = (select id from public.lead_stages where key = 'proposal')
                    where id = '00000000-0000-0000-0000-00000000aa01' and version = 1 $$), 0,
  'a write at a stale version changes nothing (the Worker answers 409)');
select is((select version from public.leads where id = '00000000-0000-0000-0000-00000000aa01'), 2,
  'the move bumped the version once');

select is(_rows($$ update public.leads set assigned_to = '00000000-0000-0000-0000-0000000000d1'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1,
  'admin assigns a lead to a developer');
select ok((select assigned_to = '00000000-0000-0000-0000-0000000000d1' and version = 3
             from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'the assignee is set, and the assignment is versioned');
select is((select count(*)::int from public.lead_events
            where lead_id = '00000000-0000-0000-0000-00000000aa01' and kind = 'assigned'
              and detail ->> 'to' = '00000000-0000-0000-0000-0000000000d1'),
  1, 'the timeline records the assignment, by id');
select throws_ok(
  $$ update public.leads set assigned_to = '00000000-0000-0000-0000-0000000000c1'
      where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'a content creator cannot be given a lead');
select throws_ok(
  $$ update public.leads set assigned_to = '00000000-0000-0000-0000-0000000000d3'
      where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'nor can a deactivated lead worker');
select throws_ok(
  $$ update public.leads set assigned_to = '00000000-0000-0000-0000-0000000000f1'
      where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'nor another tenant''s admin');

select is(_rows($$ update public.leads set value_sar = 50000
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1, 'admin sets a value');
select ok((select version = 4 from public.leads where id = '00000000-0000-0000-0000-00000000aa01')
          and (select count(*) = 1 from public.lead_events
                where lead_id = '00000000-0000-0000-0000-00000000aa01' and kind = 'value_set'
                  and (detail ->> 'value_sar')::int = 50000),
  'a value is versioned and on the timeline');
select throws_ok(
  $$ update public.leads set value_sar = -1 where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'a negative value is refused');
select is(_rows($$ update public.leads set tags = '{VIP,Urgent}'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1, 'admin tags a lead');
select is((select version from public.leads where id = '00000000-0000-0000-0000-00000000aa01'), 5,
  'tags are versioned');
select throws_ok(
  $$ update public.leads set tags = '{a,b,c,d,e,f,g,h,i,j,k}'
      where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'eleven tags are refused');
select throws_ok(
  $$ update public.leads set tags = '{VIP,VIP}' where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'a repeated tag is refused');
select throws_ok(
  $$ update public.leads set tags = array[' padded'] where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '23514', null, 'a tag with surrounding spaces is refused');

-- ---- The unversioned marks ------------------------------------------------------------------
select is(_rows($$ update public.leads set is_starred = true
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1, 'admin stars a lead');
select is(_rows($$ update public.leads set read_at = '2000-01-01'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1, 'and marks it read');
select ok((select version = 5 and is_starred and read_at = now()
                  and read_by = '00000000-0000-0000-0000-0000000000a1'
             from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'a star and a read mark move no version; the mark is the server''s time and the session''s person');

-- Nor are they edits: the lead keeps when it was last changed, and by whom. aa06 was last
-- changed long ago by the developer (inserted under her claims, with an old updated_at).
reset role;
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
insert into public.leads (id, tenant_id, name, email_enc, message, updated_at)
values ('00000000-0000-0000-0000-00000000aa06', '00000000-0000-0000-0000-000000000001', 'Untouched',
        'x', 'hi', '2000-01-01T00:00:00Z');
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set is_starred = true
                    where id = '00000000-0000-0000-0000-00000000aa06' $$), 1,
  'admin stars a lead the developer last changed');
select is(_rows($$ update public.leads set read_at = now()
                    where id = '00000000-0000-0000-0000-00000000aa06' $$), 1, 'and marks it read');
select is(_bulk('star', 'false', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa06'))),
  'aa06:applied', 'and clears the star in bulk');
select ok((select updated_at = '2000-01-01T00:00:00Z'
                  and updated_by = '00000000-0000-0000-0000-0000000000d1'
                  and read_by = '00000000-0000-0000-0000-0000000000a1' and not is_starred
             from public.leads where id = '00000000-0000-0000-0000-00000000aa06'),
  'a star or a read mark is not an edit: updated_at and updated_by stay the developer''s');
select is(_rows($$ update public.leads set value_sar = 1
                    where id = '00000000-0000-0000-0000-00000000aa06' $$), 1, 'a value is an edit');
select ok((select updated_at = now() and updated_by = '00000000-0000-0000-0000-0000000000a1'
             from public.leads where id = '00000000-0000-0000-0000-00000000aa06'),
  'so it moves both, to now and the admin');

select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set read_at = now() + interval '1 day'
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1,
  'a second look, by the developer');
select ok((select read_at = now() and read_by = '00000000-0000-0000-0000-0000000000a1'
             from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'the first look stands');
select throws_ok(
  $$ update public.leads set read_by = '00000000-0000-0000-0000-0000000000d1'
      where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '42501', null, 'who looked is never the client''s to say (no grant on read_by)');
select throws_ok(
  $$ update public.leads set score = 100 where id = '00000000-0000-0000-0000-00000000aa01' $$,
  '42501', null, 'the score is not writable through the API');
select is(_rows($$ update public.leads set read_at = null
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 1, 'marked unread');
select ok((select read_at is null and read_by is null
             from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'unread clears the mark and the person');

select is(_rows($$ update public.leads set last_contact_channel = 'call', last_contact_at = '2000-01-01'
                    where id = '00000000-0000-0000-0000-00000000aa02' $$), 1,
  'the developer logs a call on a new lead');
select ok((select last_contact_at = now() and first_response_at = now() and version = 1
             from public.leads where id = '00000000-0000-0000-0000-00000000aa02'),
  'the call takes the server''s time, answers the new lead, and moves no version');
select is((select count(*)::int from public.lead_events
            where lead_id = '00000000-0000-0000-0000-00000000aa02' and kind = 'contact_logged'
              and detail ->> 'channel' = 'call'),
  1, 'the timeline records the contact, by channel');
select is(_rows($$ update public.leads set last_contact_channel = 'email', last_contact_at = now()
                    where id = '00000000-0000-0000-0000-00000000aa07' $$), 1,
  'the developer logs an e-mail on a lead already past New');
select ok((select last_contact_at = now() and first_response_at is null and status = 'in_progress'
                  and version = 1
             from public.leads where id = '00000000-0000-0000-0000-00000000aa07'),
  'it does not answer that lead: when it was first answered is not known, so it stays unknown');
select throws_ok(
  $$ update public.leads set last_contact_channel = 'pigeon'
      where id = '00000000-0000-0000-0000-00000000aa02' $$,
  '23514', null, 'an unknown channel is refused');

-- ---- Who changes nothing --------------------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set is_starred = false
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 0,
  'content_creator changes no lead');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set is_starred = false
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 0,
  'seo changes no lead');
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.leads set is_starred = false
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 0,
  'a demoted developer''s old token changes no lead (live check)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_rows($$ update public.leads set is_starred = false
                    where id = '00000000-0000-0000-0000-00000000aa01' $$), 0,
  'another tenant''s admin changes no lead of T1');

-- ---- Bulk -----------------------------------------------------------------------------------
set local role anon;
select _as(null, null, null);
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'star', 'true',
       '[{"id": "00000000-0000-0000-0000-00000000aa01"}]') $$,
  '42501', null, 'anon cannot call leads_bulk_update');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
-- aa01 is at version 5; 9 is not aa02's version; bb01 is T2's; cc01 does not exist.
select is(
  _bulk('stage', to_jsonb((select id from public.lead_stages where key = 'won')::text),
        jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa01', 5),
                          _item('00000000-0000-0000-0000-00000000aa02', 9),
                          _item('00000000-0000-0000-0000-00000000bb01', 1),
                          _item('00000000-0000-0000-0000-00000000cc01', 1))),
  'aa01:applied,aa02:conflict,bb01:missing,cc01:missing',
  'bulk stage: applied where the version holds, a conflict where it moved on, missing elsewhere');
select ok((select version = 6 and status = 'done' and won_at = now()
             from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  'the applied lead is Won, one version on');
select is(
  (select b.lead_version from public.leads_bulk_update('00000000-0000-0000-0000-000000000001',
     'star', 'false', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa01'))) b),
  6, 'a bulk star needs no version and moves none');
select is(
  (select b.outcome || '/' || b.lead_version
     from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'tagAdd', '"Hot"',
            jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa01', 6))) b),
  'applied/7', 'a bulk tag is versioned');
select is((select tags from public.leads where id = '00000000-0000-0000-0000-00000000aa01'),
  '{VIP,Urgent,Hot}'::text[], 'the tag is appended');
select is(_bulk('tagRemove', '"VIP"', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa01', 7))),
  'aa01:applied', 'a bulk tag removal');
select is(_rows($$ update public.leads set tags = '{t1,t2,t3,t4,t5,t6,t7,t8,t9,t10}'
                    where id = '00000000-0000-0000-0000-00000000aa04' $$), 1, 'a lead with ten tags');
select is(_bulk('tagAdd', '"t11"', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa04', 2))),
  'aa04:skipped', 'an eleventh tag skips that lead instead of failing the batch');
-- The leftovers are judged in a second statement, against the lead as it is now: a version
-- that moved on is a conflict even where the tag guard would also have left the lead alone.
-- (A race lost DURING the call needs two sessions, which a pgTAP file cannot open; the
-- second statement's fresh snapshot is what answers it, tests/lib/crmLeadsWriteSql.spec.ts.)
select is(_bulk('tagAdd', '"t11"', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa04', 1))),
  'aa04:conflict', 'a stale version is a conflict, not a skip');
select is(_bulk('assign', 'null', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa01', 8))),
  'aa01:applied', 'a bulk unassignment');
select is((select count(*)::int from public.lead_events
            where lead_id = '00000000-0000-0000-0000-00000000aa01' and kind = 'unassigned'),
  1, 'the timeline records it');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'assign',
       '"00000000-0000-0000-0000-0000000000c1"',
       '[{"id": "00000000-0000-0000-0000-00000000aa02", "version": 1}]') $$,
  '23514', null, 'assigning a non-worker fails the whole batch');
select is(_bulk('read', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa03'))),
  'aa03:applied', 'a bulk read mark');
select ok((select read_at = now() and read_by = '00000000-0000-0000-0000-0000000000a1'
             from public.leads where id = '00000000-0000-0000-0000-00000000aa03'),
  'it is the session''s mark');
select is(_bulk('spam', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa03', 1))),
  'aa03:applied', 'a bulk spam mark');

select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'delete', 'true',
       '[{"id": "00000000-0000-0000-0000-00000000aa01"}]') $$,
  '22023', null, 'an unknown action is refused (there is no bulk delete)');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'stage',
       to_jsonb(gen_random_uuid()::text), '[{"id": "00000000-0000-0000-0000-00000000aa01"}]') $$,
  '22023', null, 'a versioned action needs each lead''s version');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'star', 'true',
       '[{"id": "00000000-0000-0000-0000-00000000aa01"}, {"id": "00000000-0000-0000-0000-00000000aa01"}]') $$,
  '22023', null, 'each lead once');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'star', 'true',
       (select jsonb_agg(jsonb_build_object('id', gen_random_uuid())) from generate_series(1, 101))) $$,
  '22023', null, 'at most 100 leads at a time');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'star', 'true',
       '[{"id": "00000000-0000-0000-0000-00000000aa01", "name": "x"}]') $$,
  '22023', null, 'an item is {id, version} and nothing else');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'star', '"yes"',
       '[{"id": "00000000-0000-0000-0000-00000000aa01"}]') $$,
  '22023', null, 'a star is true or false');
select throws_ok(
  $$ select * from public.leads_bulk_update('00000000-0000-0000-0000-000000000001', 'tagAdd', '""',
       '[{"id": "00000000-0000-0000-0000-00000000aa01", "version": 1}]') $$,
  '22023', null, 'an empty tag is refused');

select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_bulk('star', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa02'))),
  'aa02:missing', 'content_creator: every lead is missing');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_bulk('star', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa02'))),
  'aa02:missing', 'seo: every lead is missing');
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_bulk('star', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa02'))),
  'aa02:missing', 'a demoted developer''s old token: every lead is missing (live check)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_bulk('star', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa02'))),
  'aa02:missing', 'another tenant''s admin naming T1: missing');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_bulk('star', 'true', jsonb_build_array(_item('00000000-0000-0000-0000-00000000aa02'))),
  'aa02:applied', 'a developer works leads in bulk');

-- ---- Erasure, as the service role ------------------------------------------------------------
-- aa03 gets a thread note, so its timeline holds three events: created, spam_marked and the
-- note's note_added.
reset role;
select _as(null, null, null);
insert into public.lead_notes (id, tenant_id, lead_id, body, source, created_by) values
  ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000aa03', 'Asked for a quote', 'staff',
   '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000ee02', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000aa02', 'Sent the proposal', 'staff',
   '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000ee03', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000aa01', 'First note', 'staff',
   '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000ee04', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000aa01', 'Second note', 'staff',
   '00000000-0000-0000-0000-0000000000a1');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'admin cannot call crm_erase_lead through the API (no API role deletes a lead)');

-- The doors' own check, read live: active, not locked out now, in the tenant, holding crm.erase.
reset role;
select ok(app.crm_eraser_ok('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1'),
  'app.crm_eraser_ok: an active, unlocked admin of the tenant may erase');
select ok(not app.crm_eraser_ok('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3'),
  'not an admin locked out right now (locked_until still ahead)');
select ok(app.crm_eraser_ok('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a4'),
  'a lock that has run out no longer counts');
select ok(not app.crm_eraser_ok('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2'),
  'not an inactive admin');
select ok(not app.crm_eraser_ok('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000a1'),
  'not in a tenant that is not the profile''s');

set local role service_role;
select _as(null, null, null);
select throws_ok(
  $$ select public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000d1') $$,
  '42501', null, 'the door refuses an actor who does not hold crm.erase (a developer)');
select throws_ok(
  $$ select public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'or a deactivated admin (checked live)');
select throws_ok(
  $$ select public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a3') $$,
  '42501', null, 'or an admin locked out right now');
select throws_ok(
  $$ select public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000f1') $$,
  '42501', null, 'or another tenant''s admin');
select throws_ok(
  $$ select public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000a1') $$,
  'P0002', null, 'another tenant''s lead is not found');
select is(
  public.crm_erase_lead('00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a1') - 'lead_number',
  '{"leads": 1, "notes": 1, "events": 3}'::jsonb,
  'an admin erases a lead; the counts say what went');
reset role;
select ok(
  not exists (select 1 from public.leads where id = '00000000-0000-0000-0000-00000000aa03')
  and not exists (select 1 from public.lead_notes where lead_id = '00000000-0000-0000-0000-00000000aa03')
  and not exists (select 1 from public.lead_events where lead_id = '00000000-0000-0000-0000-00000000aa03'),
  'the lead, its notes and its timeline are gone');
set local role service_role;
insert into public.leads (id, tenant_id, name, email_enc, message)
values ('00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-000000000001', 'After', 'x', 'hi');
reset role;
select ok((select lead_number > 4 from public.leads where id = '00000000-0000-0000-0000-00000000aa05'),
  'an erased lead''s number is never given to anyone else');

-- ---- Deleting one note, as the service role ------------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.crm_delete_lead_note('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000ee02',
       '00000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'admin cannot call crm_delete_lead_note through the API');
set local role service_role;
select _as(null, null, null);
select throws_ok(
  $$ select public.crm_delete_lead_note('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000ee02',
       '00000000-0000-0000-0000-0000000000d1') $$,
  '42501', null, 'a developer may not delete notes');
select throws_ok(
  $$ select public.crm_delete_lead_note('00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000ee02',
       '00000000-0000-0000-0000-0000000000a1') $$,
  'P0002', null, 'a note is found on its own lead only');
select is(
  public.crm_delete_lead_note('00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000ee02',
    '00000000-0000-0000-0000-0000000000a1'),
  'staff', 'an admin deletes a thread note');
reset role;
update public.leads set internal_notes = 'Words in the old field'
 where id = '00000000-0000-0000-0000-00000000aa02';
set local role service_role;
select is(
  public.crm_delete_lead_note('00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-00000000aa02',
    (select id from public.lead_notes
      where lead_id = '00000000-0000-0000-0000-00000000aa02' and source = 'legacy'),
    '00000000-0000-0000-0000-0000000000a1'),
  'legacy', 'the legacy mirror is deleted too');
reset role;
select ok(
  (select internal_notes is null from public.leads where id = '00000000-0000-0000-0000-00000000aa02')
  and not exists (select 1 from public.lead_notes where lead_id = '00000000-0000-0000-0000-00000000aa02'),
  'its words leave the old field as well, so no later save can bring them back');
-- The field was last saved with no session (updated_by null); the door clears it as the admin.
select ok(
  (select updated_by = '00000000-0000-0000-0000-0000000000a1'
     from public.leads where id = '00000000-0000-0000-0000-00000000aa02'),
  'the service role clears the field as the admin who deleted the note, not as no one');
select is(
  (select string_agg((e.detail ->> 'source') || ':' || (e.detail - 'note_id' - 'source' = '{}'::jsonb)::text,
                     ',' order by e.id)
     from public.lead_events e
    where e.lead_id = '00000000-0000-0000-0000-00000000aa02' and e.kind = 'note_deleted'
      and e.actor_id = '00000000-0000-0000-0000-0000000000a1'),
  'staff:true,legacy:true',
  'each deleted note leaves a note_deleted event naming who removed it: its id and source, no words');

-- ---- Note counts (the CSV export) ------------------------------------------------------------
set local role service_role;
select is(
  public.crm_lead_note_counts('00000000-0000-0000-0000-000000000001',
    array['00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02']::uuid[]),
  jsonb_build_object('00000000-0000-0000-0000-00000000aa01', 2),
  'note counts per lead; a lead with none is absent');
select is(
  public.crm_lead_note_counts('00000000-0000-0000-0000-0000000000ff',
    array['00000000-0000-0000-0000-00000000aa01']::uuid[]),
  '{}'::jsonb, 'and nothing across tenants');

-- ---- A lead added by hand -------------------------------------------------------------------
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', jsonb_build_object(
    'id', '00000000-0000-0000-0000-00000000ab01', 'name', 'Walk-in', 'phone_enc', 'ciphertext',
    'message', 'Came by the office', 'source', 'manual', 'channel', 'walk_in',
    'created_by', '00000000-0000-0000-0000-0000000000a1', 'score_signals', '[]'::jsonb)),
  '00000000-0000-0000-0000-00000000ab01'::uuid, 'a manual lead arrives through crm_ingest_lead');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
       '{"id": "00000000-0000-0000-0000-00000000ab02", "name": "x", "phone_enc": "c",
         "message": "m", "source": "manual"}') $$,
  '22023', null, 'a manual lead must name who added it');
reset role;
select ok(
  (select first_response_at = created_at and read_at = created_at
          and read_by = '00000000-0000-0000-0000-0000000000a1'
          and created_by = '00000000-0000-0000-0000-0000000000a1'
          and updated_by = '00000000-0000-0000-0000-0000000000a1'
          and source = 'manual' and channel = 'walk_in' and status = 'new'
     from public.leads where id = '00000000-0000-0000-0000-00000000ab01'),
  'it arrives answered and read by the person who added it, in the initial stage, last changed by them');
select is(
  (select actor_id from public.lead_events
    where lead_id = '00000000-0000-0000-0000-00000000ab01' and kind = 'created'),
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'its created event names who added it, though the service role wrote it');
select ok(
  (select first_response_at is null and read_at is null
     from public.leads where id = '00000000-0000-0000-0000-00000000aa05'),
  'a lead from the form arrives unanswered and unread');

-- ---- writeAuditMany: one insert, many rows, still one chain ----------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'admin',
   'lead.update', 'lead', '00000000-0000-0000-0000-00000000aa01', '{"fields": ["tags"]}'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'admin',
   'lead.update', 'lead', '00000000-0000-0000-0000-00000000aa02', '{"fields": ["tags"]}'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'admin',
   'lead.bulk', 'lead', null, '{"action": "tagAdd", "applied": 2}');
reset role;
select ok(
  (select count(*) = 3
          and bool_and(a.hash ~ '^[0-9a-f]{64}$')
          and bool_and(a.prev_hash is not distinct from (
                select b.hash from public.audit_log b
                 where b.tenant_id = a.tenant_id and b.id < a.id
                 order by b.id desc limit 1))
     from public.audit_log a
    where a.tenant_id = '00000000-0000-0000-0000-000000000001'),
  'a multi-row audit insert is chained row by row, in id order');

-- ---- The assignee key ------------------------------------------------------------------------
update public.leads set assigned_to = '00000000-0000-0000-0000-0000000000d1'
 where id = '00000000-0000-0000-0000-00000000aa04';
select throws_ok(
  $$ update public.profiles set tenant_id = '00000000-0000-0000-0000-0000000000ff'
      where id = '00000000-0000-0000-0000-0000000000d1' $$,
  '23503', null, 'a profile holding leads cannot move to another tenant (unassign them first)');
delete from public.profiles where id = '00000000-0000-0000-0000-0000000000d1';
select ok(
  (select assigned_to is null and name = 'Tagged'
     from public.leads where id = '00000000-0000-0000-0000-00000000aa04'),
  'a profile that goes takes its assignments with it, and nothing else of the lead');

select * from finish();
rollback;
