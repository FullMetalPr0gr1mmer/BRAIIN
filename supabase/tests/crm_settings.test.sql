-- pgTAP: CRM settings for leads (0091, Admin v2 C9a). Run with `supabase test db`.
--
-- Covers: the crm.settings helper over every role; who runs each new function; the grants
-- (the configuration columns of crm_settings, the stage columns, nothing for anon or PUBLIC);
-- writes (crm_settings; lead_stages insert, update and delete; save_lead_stages) over admin,
-- content_creator, seo, developer, anon, another tenant's admin and a stale token (a demoted
-- admin, a deactivated one); a new stage's key set by the database, never by the writer; the version and stamps moving with the
-- configuration and never with the round-robin cursor; new points re-scoring every lead of
-- the tenant without making a lead look edited; the assignee rules; save_lead_stages (a whole
-- pipeline: rename, add, reorder, delete an empty stage; every refusal: a changed pipeline, the
-- set's rules, the initial stage, malformed stages, a stage that holds leads); the per-stage
-- counts; and the assignment at arrival (manual, always one person, round robin in pool order
-- skipping inactive people). CLAUDE.md §3, §5, §8, §9.

begin;
select plan(94);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'demoted-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'inactive-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'inactive-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'second-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  -- demoted: the token still says admin
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'admin', false, null),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'developer', false, null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null);

-- Two leads with reasons: one in Contacted, one in New. Their scores are set from the
-- default points, as arrival would have.
insert into public.leads (id, tenant_id, name, email_enc, message, score_signals, score) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-000000000001', 'First', 'x', 'hi',
   '{named_service,company_named}', 15),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-000000000001', 'Second', 'x', 'hi',
   '{budget_200k_plus}', 25),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000ff', 'Other', 'x', 'hi',
   '{named_service}', 10);
update public.leads set stage_id = (select id from public.lead_stages
                                     where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'contacted')
 where id = '00000000-0000-0000-0000-00000000aa01';

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

-- T1's pipeline as the screen loads it: [{id, version}].
create function _known() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('id', id, 'version', version))
    from public.lead_stages where tenant_id = '00000000-0000-0000-0000-000000000001'
$$;
grant execute on function _known() to authenticated;
-- One stage of T1 as the screen sends it back.
create function _stage(p_key text, p_label text default null, p_kind text default null)
  returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'label', coalesce(p_label, label), 'tone', tone,
                            'kind', coalesce(p_kind, kind))
    from public.lead_stages
   where tenant_id = '00000000-0000-0000-0000-000000000001' and key = p_key
$$;
grant execute on function _stage(text, text, text) to authenticated;
-- The five seeded stages, in order, with changes to name.
create function _pipeline(p_extra jsonb default '[]') returns jsonb language sql as $$
  select jsonb_build_array(_stage('new'), _stage('contacted'), _stage('proposal'),
                           _stage('won'), _stage('lost')) || p_extra
$$;
grant execute on function _pipeline(jsonb) to authenticated;
create function _save(p_stages jsonb) returns jsonb language sql as $$
  select public.save_lead_stages('00000000-0000-0000-0000-000000000001', _known(), p_stages)
$$;
grant execute on function _save(jsonb) to authenticated;

-- A lead as the Worker sends it.
create function _lead(p_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'kind', 'contact', 'locale', 'en', 'name', 'Sara', 'email_enc', 'ciphertext',
    'message', 'Hello', 'source', 'web_form')
$$;
create function _assignee(p_id text) returns uuid language sql as $$
  select assigned_to from public.leads where id = p_id::uuid
$$;

-- ---- The guide (H11's put) -------------------------------------------------------------------
select ok(exists (select 1 from public.help_articles h
                   where h.tenant_id = '00000000-0000-0000-0000-000000000001'
                     and h.slug = 'crm-settings' and h.caps = '{crm.settings}'
                     and h.screens = '{/admin/crm/settings}' and h.sort_order = 75),
  'a new tenant is seeded with the CRM settings guide, Admin''s, on its screen');

-- ---- The helper and who runs what --------------------------------------------------------------
select is(
  (select array_agg(r::text order by r::text)
     from unnest(enum_range(null::public.app_role)) r
    where app.role_crm_settings(r::text)),
  array['admin'], 'app.role_crm_settings holds for exactly one role, admin (crm.settings, §5)');
select ok(not app.role_crm_settings(null) and not app.role_crm_settings('anon'),
  'and for no one without a role');
select ok(
  has_function_privilege('authenticated', 'public.save_lead_stages(uuid, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.save_lead_stages(uuid, jsonb, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.save_lead_stages(uuid, jsonb, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.lead_stage_counts(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.lead_stage_counts(uuid)', 'execute')
  and not (select bool_or(prosecdef) from pg_proc
            where oid in ('public.save_lead_stages(uuid, jsonb, jsonb)'::regprocedure,
                          'public.lead_stage_counts(uuid)'::regprocedure)),
  'save_lead_stages and lead_stage_counts are the caller''s doors: authenticated only, SECURITY INVOKER');
select ok(
  has_function_privilege('service_role', 'app.crm_pick_assignee(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app.crm_pick_assignee(uuid)', 'execute')
  and not has_function_privilege('anon', 'app.crm_pick_assignee(uuid)', 'execute'),
  'picking an assignee is the service role''s alone (arrival)');

-- ---- The grants --------------------------------------------------------------------------------
select is(
  (select array_agg(a.attname::text order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.crm_settings'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.crm_settings', a.attname::text, 'update')),
  array['assignment_fixed_to', 'assignment_pool', 'assignment_rule', 'scoring', 'sla_hours'],
  'staff UPDATE on crm_settings: the configuration, never the time zone, the cursor or the stamps');
select is(
  (select array_agg(a.attname::text order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.lead_stages'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.lead_stages', a.attname::text, 'update')),
  array['kind', 'label', 'label_ar', 'sort_order', 'tone'],
  'staff UPDATE on lead_stages: never the key, the initial flag or the tenant');
select is(
  (select array_agg(a.attname::text order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.lead_stages'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.lead_stages', a.attname::text, 'insert')),
  array['kind', 'label', 'label_ar', 'sort_order', 'tone'],
  'staff INSERT on lead_stages: never the key (the database sets it), the initial flag or the tenant');
select ok(
  not has_table_privilege('anon', 'public.crm_settings', 'select, insert, update, delete, truncate, references, trigger')
  and not has_any_column_privilege('anon', 'public.crm_settings', 'select, insert, update, references')
  and not has_table_privilege('anon', 'public.lead_stages', 'select, insert, update, delete, truncate, references, trigger')
  and not has_any_column_privilege('anon', 'public.lead_stages', 'select, insert, update, references')
  and not has_table_privilege('public', 'public.crm_settings', 'select, insert, update, delete, truncate, references, trigger')
  and not has_table_privilege('public', 'public.lead_stages', 'select, insert, update, delete, truncate, references, trigger')
  and not has_table_privilege('authenticated', 'public.crm_settings', 'insert, delete, truncate, references, trigger')
  and not has_table_privilege('authenticated', 'public.lead_stages', 'insert, update, truncate, references, trigger'),
  'anon and PUBLIC hold nothing; staff never insert or delete settings, nor write stages table-wide');

-- ---- crm_settings: who writes it ---------------------------------------------------------------
set local role anon;
select _as(null, null, null);
select throws_ok($$ update public.crm_settings set sla_hours = 12 $$, '42501', null,
  'anon cannot write CRM settings');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.crm_settings set sla_hours = 12 $$), 0, 'content_creator changes no settings');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.crm_settings set sla_hours = 12 $$), 0, 'seo changes no settings');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.crm_settings set sla_hours = 12 $$), 0,
  'developer reads the settings but changes none (crm.settings is Admin''s)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_rows($$ update public.crm_settings set sla_hours = 12
                    where tenant_id = '00000000-0000-0000-0000-000000000001' $$), 0,
  'another tenant''s admin changes none of T1''s settings');
select _as('00000000-0000-0000-0000-0000000000a2', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.crm_settings set sla_hours = 12 $$), 0,
  'a demoted admin''s old token changes nothing (live check)');
select _as('00000000-0000-0000-0000-0000000000a3', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.crm_settings set sla_hours = 12 $$), 0,
  'a deactivated admin''s token changes nothing (live check)');

select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.crm_settings set sla_hours = 12 where version = 1 $$), 1,
  'admin changes the response time at the version it read');
select is(_rows($$ update public.crm_settings set sla_hours = 6 where version = 1 $$), 0,
  'a write at a stale version changes nothing (the Worker answers 409)');
select ok((select sla_hours = 12 and version = 2 and updated_by = '00000000-0000-0000-0000-0000000000a1'
             from public.crm_settings),
  'the change moved the version once and names who made it');
select throws_ok($$ update public.crm_settings set timezone = 'UTC' $$, '42703', null,
  'the CRM keeps no time zone: C14b dropped it, site_settings.timezone is the studio''s one zone');
select throws_ok($$ update public.crm_settings set rr_cursor = 3 $$, '42501', null,
  'nor the round-robin cursor (arrival moves it)');

-- ---- New points re-score every lead ------------------------------------------------------------
select is(_rows($$ update public.crm_settings
                     set scoring = scoring || '{"named_service": 40, "budget_200k_plus": 0}' $$), 1,
  'admin changes the points');
reset role;
select is(
  (select string_agg(right(id::text, 4) || ':' || score, ',' order by id) from public.leads),
  'aa01:45,aa02:0,bb01:10',
  'every lead of the tenant is re-scored from the new points; another tenant''s is not');
select ok(
  (select bool_and(version = 1 and updated_by is null) from public.leads
    where tenant_id = '00000000-0000-0000-0000-000000000001'
      and id <> '00000000-0000-0000-0000-00000000aa01')
  and (select count(*) = 0 from public.lead_events where kind not in ('created', 'stage_changed')),
  'a re-score is not an edit: no version, no editor, no timeline event');

-- ---- The assignees -----------------------------------------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ update public.crm_settings set assignment_rule = 'round_robin',
            assignment_pool = '{00000000-0000-0000-0000-0000000000c1}' $$,
  '23514', null, 'a content creator cannot be in the pool');
select throws_ok(
  $$ update public.crm_settings set assignment_rule = 'fixed',
            assignment_fixed_to = '00000000-0000-0000-0000-0000000000d2' $$,
  '23514', null, 'a deactivated lead worker cannot be the one person');
select throws_ok(
  $$ update public.crm_settings set assignment_rule = 'fixed',
            assignment_fixed_to = '00000000-0000-0000-0000-0000000000f1' $$,
  '23514', null, 'nor another tenant''s admin (the key, or the rule)');
select throws_ok($$ update public.crm_settings set assignment_rule = 'fixed' $$,
  '23514', null, 'always to one person needs the person');
select throws_ok($$ update public.crm_settings set assignment_rule = 'round_robin' $$,
  '23514', null, 'round robin needs someone in the pool');
select throws_ok(
  $$ update public.crm_settings set assignment_pool =
       '{00000000-0000-0000-0000-0000000000d1,00000000-0000-0000-0000-0000000000d1}' $$,
  '23514', null, 'a person is in the pool once');
select throws_ok($$ update public.crm_settings set assignment_rule = 'by_service' $$,
  '23514', null, 'the rule is one of manual, round robin and always one person');

-- ---- The stages, row by row --------------------------------------------------------------------
select is(_rows($$ update public.lead_stages set label = 'Reached out' where key = 'contacted' $$), 1,
  'admin renames a stage');
select throws_ok(
  $$ insert into public.lead_stages (key, label, tone, kind, is_initial)
     values ('second_new', 'Second new', 'gray', 'open', true) $$,
  '42501', null, 'nobody adds a second initial stage (the flag is not granted)');
select is(_rows($$ delete from public.lead_stages where is_initial $$), 0,
  'the initial stage is never deleted');
select throws_ok(
  $$ insert into public.lead_stages (key, label, tone, kind, sort_order)
     values ('lost_old', 'Different', 'err', 'lost', 98) $$,
  '42501', null,
  'nobody names a key, so no writer reuses a deleted stage''s key (timeline events name keys)');
select lives_ok(
  $$ insert into public.lead_stages (label, tone, kind, sort_order) values ('Extra step', 'gray', 'open', 35) $$,
  'admin adds a stage directly (the tenant is the token''s)');
select ok(exists (select 1 from public.lead_stages
                   where label = 'Extra step' and key ~ '^extra_step_[0-9a-f]{6}$'
                     and tenant_id = '00000000-0000-0000-0000-000000000001'),
  'its key is the database''s: the label plus a random suffix');
select is(_rows($$ delete from public.lead_stages where label = 'Extra step' $$), 1,
  'admin deletes an empty stage');
select throws_ok($$ update public.lead_stages set tone = '#ff0000' where key = 'won' $$,
  '23514', null, 'a tone outside the palette is refused (no free colours, CSP)');
select throws_ok($$ update public.lead_stages set kind = 'won' where key = 'contacted' $$,
  '23503', null, 'a stage that holds a lead keeps its kind, written directly too');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ insert into public.lead_stages (label, tone, kind, sort_order) values ('CC', 'gray', 'open', 99) $$,
  '42501', null, 'content_creator adds no stage');
select is(_rows($$ update public.lead_stages set label = 'CC' $$), 0, 'content_creator renames no stage');
select is(_rows($$ delete from public.lead_stages where key = 'proposal' $$), 0,
  'content_creator deletes no stage');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ insert into public.lead_stages (label, tone, kind, sort_order) values ('SEO', 'gray', 'open', 99) $$,
  '42501', null, 'seo adds no stage');
select is(_rows($$ update public.lead_stages set label = 'SEO' $$), 0, 'seo renames no stage');
select is(_rows($$ delete from public.lead_stages where key = 'proposal' $$), 0, 'seo deletes no stage');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.lead_stages set label = 'Dev' $$)
          + _rows($$ delete from public.lead_stages where key = 'proposal' $$), 0,
  'developer reads the stages but changes none');
select throws_ok($$ insert into public.lead_stages (label, tone, kind, sort_order) values ('Dev', 'gray', 'open', 99) $$,
  '42501', null, 'developer adds no stage');
select _as('00000000-0000-0000-0000-0000000000a2', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.lead_stages set label = 'Stale' $$), 0,
  'a demoted admin''s old token changes no stage (live check)');
select throws_ok($$ insert into public.lead_stages (label, tone, kind, sort_order) values ('Stale', 'gray', 'open', 99) $$,
  '42501', null, 'nor adds one (live check)');
select is(_rows($$ delete from public.lead_stages where key = 'proposal' $$), 0,
  'nor deletes one (live check)');
select _as('00000000-0000-0000-0000-0000000000a3', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.lead_stages set label = 'Inactive' $$), 0,
  'a deactivated admin''s token changes no stage (live check)');
select throws_ok($$ insert into public.lead_stages (label, tone, kind, sort_order) values ('Inactive', 'gray', 'open', 99) $$,
  '42501', null, 'nor adds one (live check)');
select is(_rows($$ delete from public.lead_stages where key = 'proposal' $$), 0,
  'nor deletes one (live check)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_rows($$ update public.lead_stages set label = 'Theirs'
                    where tenant_id = '00000000-0000-0000-0000-000000000001' $$), 0,
  'another tenant''s admin changes none of T1''s stages');
select is(_rows($$ delete from public.lead_stages
                    where tenant_id = '00000000-0000-0000-0000-000000000001' $$), 0,
  'nor deletes any');
select throws_ok(
  $$ insert into public.lead_stages (tenant_id, label, tone, kind, sort_order)
     values ('00000000-0000-0000-0000-000000000001', 'Theirs', 'gray', 'open', 99) $$,
  '42501', null, 'nor adds one to T1 (no API caller names a tenant)');

-- ---- save_lead_stages --------------------------------------------------------------------------
select throws_ok($$ select _save(_pipeline()) $$, '42501', null,
  'another tenant''s admin cannot save T1''s pipeline');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ select _save(_pipeline()) $$, '42501', null, 'nor can developer');
select _as('00000000-0000-0000-0000-0000000000a2', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ select _save(_pipeline()) $$, '42501', null, 'nor a demoted admin''s old token');
select _as('00000000-0000-0000-0000-0000000000a3', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ select _save(_pipeline()) $$, '42501', null, 'nor a deactivated admin''s token');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ select _save(_pipeline()) $$, '42501', null, 'nor content_creator');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select throws_ok($$ select _save(_pipeline()) $$, '42501', null, 'nor seo');
set local role anon;
select _as(null, null, null);
select throws_ok($$ select _save(_pipeline()) $$, '42501', null, 'nor anon');
select throws_ok($$ insert into public.lead_stages (label, tone, kind, sort_order) values ('Anon', 'gray', 'open', 99) $$,
  '42501', null, 'anon adds no stage');
select throws_ok($$ delete from public.lead_stages $$, '42501', null, 'nor deletes one');
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');

select throws_ok(
  $$ select public.save_lead_stages('00000000-0000-0000-0000-000000000001',
       '[]'::jsonb, _pipeline()) $$,
  '40001', null, 'a pipeline that changed since it was loaded is refused');
select throws_ok($$ select _save(jsonb_build_array(_stage('new'))) $$, '23514', null,
  'one stage is refused');
select throws_ok(
  $$ select _save(_pipeline((select jsonb_agg(jsonb_build_object('label', 'S' || i, 'tone', 'gray', 'kind', 'open'))
                               from generate_series(1, 6) i))) $$,
  '23514', null, 'eleven stages are refused');
select throws_ok(
  $$ select _save(jsonb_build_array(_stage('new'), _stage('contacted'), _stage('lost'))) $$,
  '23514', null, 'a pipeline with no won stage is refused');
select throws_ok(
  $$ select _save(jsonb_build_array(_stage('new'), _stage('contacted'), _stage('won'))) $$,
  '23514', null, 'a pipeline with no lost stage is refused');
select throws_ok(
  $$ select _save(jsonb_build_array(_stage('contacted'), _stage('new'), _stage('proposal'),
                                    _stage('won'), _stage('lost'))) $$,
  '22023', null, 'the initial stage stays first');
select throws_ok(
  $$ select _save(_pipeline(jsonb_build_array(_stage('won')))) $$,
  '22023', null, 'a stage named twice is refused');
select throws_ok(
  $$ select _save(_pipeline(jsonb_build_array(jsonb_build_object(
       'id', '00000000-0000-0000-0000-00000000dead', 'label', 'Ghost', 'tone', 'gray', 'kind', 'open')))) $$,
  '22023', null, 'a stage that is not in the pipeline is refused');
select throws_ok(
  $$ select _save(_pipeline(jsonb_build_array(jsonb_build_object(
       'label', 'Extra', 'tone', 'gray', 'kind', 'open', 'is_initial', true)))) $$,
  '22023', null, 'an unknown key on a stage is refused (no second initial stage this way either)');
select throws_ok(
  $$ select _save(jsonb_build_array(_stage('new'), _stage('proposal'), _stage('won'), _stage('lost'))) $$,
  '23503', null, 'a stage that holds a lead cannot be removed (Move its leads first)');
select throws_ok(
  $$ select _save(jsonb_build_array(_stage('new'), _stage('contacted', null, 'won'), _stage('proposal'),
                                    _stage('won'), _stage('lost'))) $$,
  '23503', null, 'nor change kind while it holds one');
select is((select count(*)::int from public.lead_stages), 5, 'a refused save changes nothing');

-- A whole save: rename, reorder, delete the empty Proposal sent, add two.
select is(
  (select string_agg(s ->> 'label' || '/' || (s ->> 'kind') || '/' || (s ->> 'sort_order'), ','
                     order by (s ->> 'sort_order')::int)
     from jsonb_array_elements(_save(jsonb_build_array(
            _stage('new'), _stage('won', 'Signed'), _stage('contacted'),
            jsonb_build_object('label', 'Qualified!', 'tone', 'sky', 'kind', 'open'),
            jsonb_build_object('label', 'مؤجل', 'tone', 'warn', 'kind', 'lost'),
            _stage('lost')))) s),
  'New/open/10,Signed/won/20,Reached out/open/30,Qualified!/open/40,مؤجل/lost/50,Lost/lost/60',
  'admin saves a whole pipeline: renamed, reordered, one deleted, two added, in board order');
select ok(
  (select bool_and(key ~ '^[a-z][a-z0-9_]{0,31}$') from public.lead_stages)
  and exists (select 1 from public.lead_stages where key ~ '^qualified_[0-9a-f]{6}$')
  and exists (select 1 from public.lead_stages where key ~ '^stage_[0-9a-f]{6}$')
  and not exists (select 1 from public.lead_stages where key = 'proposal'),
  'new stages get keys from their label (or "stage"), with a suffix no deleted stage used');
select ok(
  (select version = 1 from public.lead_stages where key = 'new')
  and (select version = 2 from public.lead_stages where key = 'won'),
  'only the stages that changed move their version');
select throws_ok($$ select public.save_lead_stages('00000000-0000-0000-0000-000000000001',
                     '[]'::jsonb, '[]'::jsonb) $$,
  '23514', null, 'an empty pipeline is refused');

-- ---- How many leads each stage holds -----------------------------------------------------------
select is(
  (select string_agg(s.key || ':' || c.leads, ',' order by s.key)
     from public.lead_stage_counts('00000000-0000-0000-0000-000000000001') c
     join public.lead_stages s on s.id = c.stage_id),
  'contacted:1,new:1', 'admin reads how many leads each stage holds');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.lead_stage_counts('00000000-0000-0000-0000-000000000001')), 0,
  'content_creator reads no counts');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.lead_stage_counts('00000000-0000-0000-0000-000000000001')), 0,
  'another tenant''s admin reads none of T1''s counts');

-- ---- Who a new lead goes to --------------------------------------------------------------------
reset role;
set local role service_role;
select is(public.crm_ingest_lead('00000000-0000-0000-0000-000000000001',
            _lead('00000000-0000-0000-0000-00000000cc01'))::text,
  '00000000-0000-0000-0000-00000000cc01', 'a lead arrives');
reset role;
select is(_assignee('00000000-0000-0000-0000-00000000cc01'), null::uuid,
  'manual assignment (the default, O-9): nobody');

update public.crm_settings set assignment_rule = 'fixed',
       assignment_fixed_to = '00000000-0000-0000-0000-0000000000d1'
 where tenant_id = '00000000-0000-0000-0000-000000000001';
set local role service_role;
select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', _lead('00000000-0000-0000-0000-00000000cc02'));
reset role;
select is(_assignee('00000000-0000-0000-0000-00000000cc02'), '00000000-0000-0000-0000-0000000000d1'::uuid,
  'always one person: theirs');
update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000d1';
set local role service_role;
select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', _lead('00000000-0000-0000-0000-00000000cc03'));
reset role;
select is(_assignee('00000000-0000-0000-0000-00000000cc03'), null::uuid,
  'and nobody while that person is switched off');
update public.profiles set is_active = true where id = '00000000-0000-0000-0000-0000000000d1';

-- Round robin over three active lead workers, in pool order; then one is switched off.
update public.crm_settings set assignment_rule = 'round_robin',
       assignment_pool = '{00000000-0000-0000-0000-0000000000d3,00000000-0000-0000-0000-0000000000d1,00000000-0000-0000-0000-0000000000a1}'
 where tenant_id = '00000000-0000-0000-0000-000000000001';
create temp table _before as
  select version, updated_at from public.crm_settings
   where tenant_id = '00000000-0000-0000-0000-000000000001';
set local role service_role;
select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', _lead('00000000-0000-0000-0000-00000000cc0' || i))
  from generate_series(4, 7) i;
reset role;
select is(
  (select string_agg(right(id::text, 4) || ':' || right(assigned_to::text, 2), ',' order by id)
     from public.leads where id::text like '00000000-0000-0000-0000-00000000cc0%'
      and id >= '00000000-0000-0000-0000-00000000cc04'),
  'cc04:d3,cc05:d1,cc06:a1,cc07:d3', 'round robin: each new lead to the next person, in pool order');
update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000d1';
set local role service_role;
select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', _lead('00000000-0000-0000-0000-00000000cc0' || i))
  from generate_series(8, 9) i;
-- A retry of a lead that arrived moves nobody.
select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', _lead('00000000-0000-0000-0000-00000000cc09'));
reset role;
select is(
  (select string_agg(right(id::text, 4) || ':' || right(assigned_to::text, 2), ',' order by id)
     from public.leads where id >= '00000000-0000-0000-0000-00000000cc08'
      and id <= '00000000-0000-0000-0000-00000000cc09'),
  'cc08:d3,cc09:a1', 'a switched-off person is skipped, and the turn goes on');
select ok(
  (select c.version = b.version and c.updated_at = b.updated_at and c.rr_cursor = 6
     from public.crm_settings c, _before b
    where c.tenant_id = '00000000-0000-0000-0000-000000000001'),
  'arrival moves the cursor once per new lead (never for a retry), and never the version');
delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';
select ok(
  (select assignment_pool @> '{00000000-0000-0000-0000-0000000000a1}' from public.crm_settings
    where tenant_id = '00000000-0000-0000-0000-000000000001'),
  'a profile that goes may stay in the pool (arrival skips it)');
update public.crm_settings set assignment_rule = 'fixed',
       assignment_fixed_to = '00000000-0000-0000-0000-0000000000d3'
 where tenant_id = '00000000-0000-0000-0000-000000000001';
delete from public.profiles where id = '00000000-0000-0000-0000-0000000000d3';
select ok(
  (select assignment_rule = 'fixed' and assignment_fixed_to is null from public.crm_settings
    where tenant_id = '00000000-0000-0000-0000-000000000001'),
  'and the one person who goes leaves the rule without a person, not a refused delete');

select * from finish();
rollback;
