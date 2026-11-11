-- pgTAP: the Sales role on the contacts and the tasks (Admin v2 C10b, crm.md §2.1 and §10;
-- the Sales contacts migration). Run with `supabase test db`.
--
-- Since C10b, app.role_crm_contacts and app.role_crm_tasks answer Admin and Sales, so every
-- policy, RESTRICTIVE live check, service-role door, owner rule and reader C5, C6 and C8 wrote
-- admits a live Sales token. This file proves what that gives Sales, and no more:
--   1. the helpers: Sales holds crm.contacts and crm.tasks, never crm.erase or crm.settings;
--      Developer still none (owner default O-7);
--   2. the contacts as a live Sales token: reads through C5's column grants (never a
--      channel's ciphertext or blind index, never the notes table), the readers (list,
--      summary, timeline, a whole address by its blind index), a detail change, the owner rule
--      (a Sales colleague may own a contact, a Developer may not), bulk; no insert or delete;
--   3. the doors as the service role with a Sales actor: add, channels, the phone match's
--      confirm, a new lead; never a note's deletion or the erasure (crm.erase stays Admin's);
--   4. the tasks as a live Sales token: add, read, change, tick (stamped with its own name),
--      remove, the badge; a Sales owner accepted, a Developer refused;
--   5. the retention door (public.crm_contact_retention_months): the tenant's horizon for a
--      live contacts holder, null for anyone else;
--   6. stale Sales tokens (demoted, switched off, locked), another tenant's Sales, a
--      Developer, a Content Creator, SEO and anon: no contact, no task, no door.
-- Personas: A admin, L sales, L2 a second sales, D developer, C content_creator, S seo, Lx
-- another tenant's sales, stale Sales tokens Ld (the profile now says content_creator), Lo
-- (switched off), Ll (locked); N anon. Helpers are named c10b_* (never a pgTAP internal).

begin;
select plan(55);

insert into public.tenants (id, name) values
  ('c1b00000-0000-4000-8000-000000000001', 'C10b T1'),
  ('c1b00000-0000-4000-8000-0000000000ff', 'C10b T2');

create table c10b_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                           profile_role text, active boolean, locked boolean);
insert into c10b_persona values
  ('A',  'c1b00000-0000-4000-8000-0000000000a1', 'admin',           'c1b00000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('L',  'c1b00000-0000-4000-8000-0000000000b1', 'sales',           'c1b00000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('L2', 'c1b00000-0000-4000-8000-0000000000b2', 'sales',           'c1b00000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('D',  'c1b00000-0000-4000-8000-0000000000d1', 'developer',       'c1b00000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('C',  'c1b00000-0000-4000-8000-0000000000c1', 'content_creator', 'c1b00000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c1b00000-0000-4000-8000-0000000000e1', 'seo',             'c1b00000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('Lx', 'c1b00000-0000-4000-8000-0000000000f1', 'sales',           'c1b00000-0000-4000-8000-0000000000ff', 'sales',           true,  false),
  ('Ld', 'c1b00000-0000-4000-8000-0000000000b3', 'sales',           'c1b00000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Lo', 'c1b00000-0000-4000-8000-0000000000b4', 'sales',           'c1b00000-0000-4000-8000-000000000001', 'sales',           false, false),
  ('Ll', 'c1b00000-0000-4000-8000-0000000000b5', 'sales',           'c1b00000-0000-4000-8000-000000000001', 'sales',           true,  true);
insert into auth.users (id, email)
  select sub, 'c10b-' || lower(code) || '@example.test' from c10b_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C10b ' || code
    from c10b_persona;

-- T1 keeps leads, and so contacts, 18 months; T2 has no settings row (24 by default).
insert into public.site_settings (tenant_id, retention) values
  ('c1b00000-0000-4000-8000-000000000001', '{"leads_months": 18}')
  on conflict (tenant_id) do update set retention = excluded.retention;

-- T1: Huda (an e-mail and a phone, a note, her own lead aa01) and a lead aa02 matched to her
-- by phone alone (its own e-mail '9…'); T2: one contact and one task.
insert into public.crm_contacts (id, tenant_id, display_name, company_name) values
  ('c1b00000-0000-4000-8000-00000000c001', 'c1b00000-0000-4000-8000-000000000001', 'Huda Saleh', 'Acme'),
  ('c1b00000-0000-4000-8000-00000000c0ff', 'c1b00000-0000-4000-8000-0000000000ff', 'Other Person', null);
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary) values
  ('c1b00000-0000-4000-8000-000000000001', 'c1b00000-0000-4000-8000-00000000c001', 'email', 'ciphertext-e', repeat('1', 64), true),
  ('c1b00000-0000-4000-8000-000000000001', 'c1b00000-0000-4000-8000-00000000c001', 'phone', 'ciphertext-p', repeat('2', 64), true);
insert into public.crm_contact_notes (id, tenant_id, contact_id, body) values
  ('c1b00000-0000-4000-8000-0000000000e1', 'c1b00000-0000-4000-8000-000000000001',
   'c1b00000-0000-4000-8000-00000000c001', 'Secret words about Huda');
insert into public.leads (id, tenant_id, name, email_enc, email_hmac, phone_enc, phone_hmac, message,
                          crm_indexed_at) values
  ('c1b00000-0000-4000-8000-00000000aa01', 'c1b00000-0000-4000-8000-000000000001', 'Huda', 'ciphertext-e',
   repeat('1', 64), 'ciphertext-p', repeat('2', 64), 'hello', now()),
  ('c1b00000-0000-4000-8000-00000000aa02', 'c1b00000-0000-4000-8000-000000000001', 'Someone', 'ciphertext-9',
   repeat('9', 64), 'ciphertext-p', repeat('2', 64), 'hi', now());
update public.leads set contact_id = 'c1b00000-0000-4000-8000-00000000c001', contact_link = 'email'
 where id = 'c1b00000-0000-4000-8000-00000000aa01';
update public.leads set contact_id = 'c1b00000-0000-4000-8000-00000000c001', contact_link = 'phone'
 where id = 'c1b00000-0000-4000-8000-00000000aa02';
insert into public.crm_tasks (id, tenant_id, title, due_at, contact_id, owner_id) values
  ('c1b00000-0000-4000-8000-000000007701', 'c1b00000-0000-4000-8000-000000000001', 'Call Huda',
   now() - interval '1 day', 'c1b00000-0000-4000-8000-00000000c001', 'c1b00000-0000-4000-8000-0000000000a1'),
  ('c1b00000-0000-4000-8000-0000000077ff', 'c1b00000-0000-4000-8000-0000000000ff', 'Theirs',
   now() + interval '1 day', null, null);

create function c10b_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c10b_persona p where p.code = p_code), ''), true)
$$;
-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function c10b_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- One statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function c10b_run(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;
-- What a token reads of the CRM it now holds: contacts / channels / events / tasks / the
-- list's total / the summary's total / the badge, as one string.
create function c10b_reads() returns text language sql as $$
  select concat_ws('/',
    c10b_val('select count(*) from public.crm_contacts'),
    c10b_val('select count(*) from public.crm_contact_channels'),
    c10b_val('select (count(*) > 0)::text from public.crm_contact_events'),
    c10b_val('select count(*) from public.crm_tasks'),
    c10b_val($q$ select public.crm_contacts_list('c1b00000-0000-4000-8000-000000000001') ->> 'total' $q$),
    c10b_val($q$ select public.crm_contact_summary('c1b00000-0000-4000-8000-000000000001') ->> 'total' $q$),
    c10b_val($q$ select public.crm_nav_counts('c1b00000-0000-4000-8000-000000000001') ->> 'tasks' $q$))
$$;
create function c10b_task(p_title text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title,
           'due_date', to_char((now() at time zone 'Asia/Riyadh')::date + 1, 'YYYY-MM-DD'),
           'due_time', '10:00') || p_extra
$$;
-- One door call (its actor written %L) with each of the given personas as the actor.
create function c10b_actors(p_codes text[], p_sql text) returns text language plpgsql as $$
declare
  v_code text;
  v_out text[] := '{}';
begin
  foreach v_code in array p_codes loop
    v_out := v_out || c10b_val(format(p_sql, (select sub from c10b_persona where code = v_code)));
  end loop;
  return array_to_string(v_out, ' ');
end $$;
-- The retention door's answer as each of the given personas: 'code=answer', space-separated.
create function c10b_retention_each(p_codes text[]) returns text language plpgsql as $$
declare
  v_code text;
  v_out text[] := '{}';
begin
  foreach v_code in array p_codes loop
    perform c10b_as(v_code);
    v_out := v_out || (v_code || '=' || c10b_val('select public.crm_contact_retention_months()'));
  end loop;
  return array_to_string(v_out, ' ');
end $$;
grant execute on function c10b_as(text), c10b_val(text), c10b_run(text), c10b_reads(),
  c10b_task(text, jsonb), c10b_actors(text[], text), c10b_retention_each(text[])
  to anon, authenticated, service_role;
grant select on c10b_persona to anon, authenticated, service_role;

-- ── 1. The helpers ────────────────────────────────────────────────────────────────────────
select is((select string_agg(r || ':' || app.role_crm_contacts(r)::int || app.role_crm_tasks(r)::int
                             || app.role_crm_erase(r)::int || app.role_crm_settings(r)::int, ' ' order by r)
             from unnest(enum_range(null::public.app_role)::text[]) r),
  'admin:1111 content_creator:0000 developer:0000 sales:1100 seo:0000',
  'contacts and tasks: Admin and Sales; erasure and the CRM settings: Admin alone; Developer none (O-7)');

-- ── 2. The contacts, as a live Sales token ───────────────────────────────────────────────────
set local role authenticated;
select c10b_as('L');
select is(c10b_reads(), '1/2/true/1/1/1/0',
  'Sales reads its tenant''s contact, its channels, its timeline and the task, and lists and counts it');
select is(c10b_val('select value_enc from public.crm_contact_channels limit 1') || ' '
          || c10b_val('select value_hmac from public.crm_contact_channels limit 1') || ' '
          || c10b_val('select count(*) from public.crm_contact_notes'),
  '42501 42501 42501', 'never a channel''s ciphertext or blind index, nor the notes table (the audited door reads it)');
select is(c10b_val($$ select public.crm_contacts_list('c1b00000-0000-4000-8000-000000000001',
             jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('1', 64))) ->> 'total' $$),
  '1', 'a whole e-mail finds its person by the blind index (the list''s filter)');
select is(c10b_val($$ select jsonb_array_length(public.crm_contact_timeline('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001') -> 'events') > 0 $$),
  'true', 'and pages the contact''s timeline');
select is(c10b_val($$ select (public.crm_contact_timeline('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001')::text ~ 'Secret words')::text $$),
  'false', 'the timeline never carries a note''s words');
select is(c10b_run($$ update public.crm_contacts set title = 'Founder'
                      where id = 'c1b00000-0000-4000-8000-00000000c001' $$),
  'ok:1', 'Sales changes a contact''s details (C5''s column grant)');
reset role;
select is((select title || ' ' || version || ' ' || staff_edited || ' ' || updated_by from public.crm_contacts
            where id = 'c1b00000-0000-4000-8000-00000000c001'),
  'Founder 2 true c1b00000-0000-4000-8000-0000000000b1',
  'the version moves, it is a person''s edit, and the row names the Sales user');
set local role authenticated;
select c10b_as('L');
select is(c10b_run($$ update public.crm_contacts set owner_id = 'c1b00000-0000-4000-8000-0000000000b2'
                      where id = 'c1b00000-0000-4000-8000-00000000c001' $$),
  'ok:1', 'a Sales colleague may own a contact (an active crm.contacts holder)');
select is(c10b_run($$ update public.crm_contacts set owner_id = 'c1b00000-0000-4000-8000-0000000000d1'
                      where id = 'c1b00000-0000-4000-8000-00000000c001' $$),
  '23514', 'a Developer may not (owner default O-7): the owner rule refuses it');
select is(c10b_run($$ insert into public.crm_contacts (tenant_id, display_name)
                      values ('c1b00000-0000-4000-8000-000000000001', 'x') $$) || ' '
          || c10b_run('delete from public.crm_contacts') || ' '
          || c10b_run($$ update public.crm_contact_channels set is_primary = false $$) || ' '
          || c10b_run($$ update public.crm_contacts set staff_edited = false $$),
  '42501 42501 42501 42501',
  'no contact insert or delete, no channel write, no bookkeeping column (the doors add and erase)');
select is(c10b_val($$ select string_agg(outcome, ',') from public.crm_contacts_bulk_update(
             'c1b00000-0000-4000-8000-000000000001', 'tagAdd', '"VIP"',
             '[{"id": "c1b00000-0000-4000-8000-00000000c001", "version": 3},
               {"id": "c1b00000-0000-4000-8000-00000000c0ff", "version": 1}]') $$),
  'applied,missing', 'bulk: Sales tags its tenant''s contact; another tenant''s is missing');
select is(c10b_val($$ select public.crm_contacts_list('c1b00000-0000-4000-8000-0000000000ff') ->> 'total' $$),
  '0', 'naming another tenant to a reader answers nothing');
reset role;

-- ── 3. The doors, as the service role, with a Sales actor ───────────────────────────────────
set local role service_role;
select is(c10b_val($$ select (public.crm_create_contact('c1b00000-0000-4000-8000-000000000001',
             jsonb_build_object('display_name', 'Nadia', 'channels', jsonb_build_array(
               jsonb_build_object('kind', 'email', 'value_enc', 'enc-n', 'value_hmac', repeat('5', 64)))),
             'c1b00000-0000-4000-8000-0000000000b1') ? 'id')::text $$),
  'true', 'Sales adds a contact (crm_create_contact checks the actor live: crm.contacts)');
select is(c10b_val($$ select public.crm_create_contact('c1b00000-0000-4000-8000-000000000001',
             jsonb_build_object('display_name', 'Huda Again', 'channels', jsonb_build_array(
               jsonb_build_object('kind', 'email', 'value_enc', 'enc', 'value_hmac', repeat('1', 64)))),
             'c1b00000-0000-4000-8000-0000000000b1')::text $$),
  '{"duplicate": "c1b00000-0000-4000-8000-00000000c001"}',
  'a taken e-mail is a duplicate for Sales too, and nothing is written');
select is(c10b_val($$ select public.crm_edit_contact_channels('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001',
             (select version from public.crm_contacts where id = 'c1b00000-0000-4000-8000-00000000c001'),
             jsonb_build_array(jsonb_build_object('kind', 'phone', 'value_enc', 'enc-p2', 'value_hmac', repeat('6', 64))),
             null, null, 'c1b00000-0000-4000-8000-0000000000b1')::text $$),
  '{"added": 1, "removed": 0}', 'Sales adds a phone to a contact at the version it read');
select is(c10b_val($$ select public.crm_contact_link_lead('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001', 'c1b00000-0000-4000-8000-00000000aa02', 'confirm',
             'c1b00000-0000-4000-8000-0000000000b1')::text $$),
  '{"link": "staff", "email": "added", "phone": "kept"}',
  'Sales confirms a phone match (the Worker spends a reveal slot first, C10b)');
select is(c10b_val($$ select (public.crm_contact_new_lead('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001',
             '{"id": "c1b00000-0000-4000-8000-00000000ab01", "name": "Huda", "message": "Rebrand", "channel": "phone", "score_signals": []}',
             'c1b00000-0000-4000-8000-0000000000b1') ->> 'link') $$),
  'email', 'Sales adds a new lead for a contact (crm.contacts, leads.manage and leads.pii): her own e-mail links it');
select is(c10b_val($$ select public.crm_delete_contact_note('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001', 'c1b00000-0000-4000-8000-0000000000e1',
             'c1b00000-0000-4000-8000-0000000000b1')::text $$),
  '42501', 'but never deletes a note (crm.erase stays Admin''s)');
select is(c10b_val($$ select public.crm_erase_preview('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001', 'c1b00000-0000-4000-8000-0000000000b1')::text $$) || ' '
          || c10b_val($$ select public.crm_erase_person('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000c001', '{}'::uuid[], 'c1b00000-0000-4000-8000-0000000000b1')::text $$) || ' '
          || c10b_val($$ select public.crm_erase_lead('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-00000000aa01', 'c1b00000-0000-4000-8000-0000000000b1')::text $$),
  '42501 42501 42501', 'nor previews or runs an erasure, of a person or of a lead');
select is(c10b_actors(array['D', 'C', 'S', 'Lx', 'Ld', 'Lo', 'Ll'],
            $$ select public.crm_create_contact('c1b00000-0000-4000-8000-000000000001',
                 '{"display_name": "X"}', %L)::text $$),
  '42501 42501 42501 42501 42501 42501 42501',
  'the add door refuses a Developer, a Content Creator, SEO, another tenant''s Sales and the stale Sales actors');
select is(c10b_actors(array['D', 'Lx', 'Ld', 'Lo', 'Ll'],
            $$ select public.crm_contact_link_lead('c1b00000-0000-4000-8000-000000000001',
                 'c1b00000-0000-4000-8000-00000000c001', 'c1b00000-0000-4000-8000-00000000aa01', 'detach', %L)::text $$),
  '42501 42501 42501 42501 42501', 'and so does the link door');
reset role;
select is((select string_agg(e.kind, ',' order by e.id) from public.crm_contact_events e
            where e.contact_id = 'c1b00000-0000-4000-8000-00000000c001' and e.actor_id = 'c1b00000-0000-4000-8000-0000000000b1'
              and e.kind in ('details_changed', 'owner_changed', 'channel_added')) is not null, true,
  'the contact''s timeline names the Sales user for its changes');
select is((select count(*)::int from public.crm_contact_notes where id = 'c1b00000-0000-4000-8000-0000000000e1'), 1,
  'the note Sales could not delete is still there');

-- ── 4. The tasks, as a live Sales token ─────────────────────────────────────────────────────
set local role authenticated;
select c10b_as('L');
select is(c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001',
             c10b_task('Send Huda the deck', jsonb_build_object('type', 'email',
               'contact_id', 'c1b00000-0000-4000-8000-00000000c001',
               'owner_id', 'c1b00000-0000-4000-8000-0000000000b1'))) ->> 'version' $$),
  '1', 'Sales adds a task about a contact, for itself');
select is(c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001',
             c10b_task('For a colleague', jsonb_build_object('owner_id', 'c1b00000-0000-4000-8000-0000000000b2'))) ->> 'version' $$)
          || ' ' || c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001',
             c10b_task('For a Developer', jsonb_build_object('owner_id', 'c1b00000-0000-4000-8000-0000000000d1'))) $$),
  '1 23514', 'for a Sales colleague too; never for a Developer (the owner rule: crm.tasks)');
select is(c10b_val($$ select (public.crm_tasks_grouped('c1b00000-0000-4000-8000-000000000001', '{}') -> 'counts')::text $$),
  '{"done": 0, "today": 0, "overdue": 1, "upcoming": 2}', 'and reads its tenant''s tasks, grouped');
select is(c10b_val($$ select public.crm_task_update('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-000000007701', 1, '{"title": "Call Huda again"}') ->> 'version' $$),
  '2', 'changes a task at the version read');
select is(c10b_val($$ select public.crm_task_update('c1b00000-0000-4000-8000-000000000001',
             'c1b00000-0000-4000-8000-000000007701', null, '{"done": true}') ->> 'version' $$),
  '2', 'and ticks it off (a tick moves no version)');
reset role;
select is((select (done_at is not null)::text || ' ' || done_by from public.crm_tasks
            where id = 'c1b00000-0000-4000-8000-000000007701'),
  'true c1b00000-0000-4000-8000-0000000000b1', 'done is stamped by the server with the Sales user''s name');
set local role authenticated;
select c10b_as('L');
select is(c10b_run($$ insert into public.crm_tasks (tenant_id, title, due_at, owner_id)
                      values ('c1b00000-0000-4000-8000-000000000001', 'Direct', now() - interval '1 hour',
                              'c1b00000-0000-4000-8000-0000000000b1') $$),
  'ok:1', 'a direct insert through the table passes the insert guard for a live Sales token');
select is(c10b_val($$ select public.crm_my_overdue_tasks('c1b00000-0000-4000-8000-000000000001') $$) || ' '
          || c10b_val($$ select public.crm_nav_counts('c1b00000-0000-4000-8000-000000000001') ->> 'tasks' $$),
  '1 1', 'the badge counts its own overdue task (owner item O-9)');
select is(c10b_run($$ delete from public.crm_tasks where title = 'Direct' $$), 'ok:1', 'and removes a task');
select is(c10b_val('select count(*) from public.crm_tasks where tenant_id = ''c1b00000-0000-4000-8000-0000000000ff'''),
  '0', 'never another tenant''s task');
reset role;

-- ── 5. The retention door ───────────────────────────────────────────────────────────────────
set local role authenticated;
select c10b_as('L');
select is(c10b_val('select public.crm_contact_retention_months()'), '18',
  'Sales reads its tenant''s horizon (T1 keeps 18 months), which site_settings would not give it');
select is(c10b_val('select count(*) from public.site_settings'), '0',
  'site_settings itself stays CMS staff''s');
select c10b_as('A');
select is(c10b_val('select public.crm_contact_retention_months()'), '18', 'an Admin reads the same');
select c10b_as('Lx');
select is(c10b_val('select public.crm_contact_retention_months()'), '24',
  'another tenant''s Sales reads its own tenant''s (no row: 24 by default)');
select is(c10b_retention_each(array['D', 'C', 'S', 'Ld', 'Lo', 'Ll']),
  'D=(null) C=(null) S=(null) Ld=(null) Lo=(null) Ll=(null)',
  'a Developer, a Content Creator, SEO and the stale Sales tokens read null');
reset role;
set local role anon;
select c10b_as('N');
select is(c10b_val('select public.crm_contact_retention_months()'), '42501', 'anon may not call it');
reset role;

-- ── 6. Everyone else ───────────────────────────────────────────────────────────────────────
set local role authenticated;
select c10b_as('Ld');
select is(c10b_reads(), '0/0/false/0/0/0/0', 'a demoted Sales token (the profile says content_creator) reads nothing');
select is(c10b_run('update public.crm_contacts set title = ''x''') || ' ' || c10b_run('update public.crm_tasks set title = ''x''')
          || ' ' || c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001', c10b_task('x')) $$),
  'ok:0 ok:0 42501', 'and changes or adds nothing');
select c10b_as('Lo');
select is(c10b_reads(), '0/0/false/0/0/0/0', 'a switched-off Sales token reads nothing');
select is(c10b_run('update public.crm_contacts set title = ''x''') || ' '
          || c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001', c10b_task('x')) $$),
  'ok:0 42501', 'and changes or adds nothing');
select c10b_as('Ll');
select is(c10b_reads(), '0/0/false/0/0/0/0', 'a locked Sales token reads nothing');
select is(c10b_run('update public.crm_contacts set title = ''x''') || ' '
          || c10b_run($$ insert into public.crm_tasks (tenant_id, title, due_at)
                         values ('c1b00000-0000-4000-8000-000000000001', 'x', now()) $$),
  'ok:0 42501', 'and changes or adds nothing, through the table either');
select c10b_as('Lx');
select is(c10b_val('select count(*) from public.crm_contacts where tenant_id = ''c1b00000-0000-4000-8000-000000000001''')
          || '/' || c10b_val('select count(*) from public.crm_tasks where tenant_id = ''c1b00000-0000-4000-8000-000000000001''')
          || '/' || c10b_val($$ select public.crm_contacts_list('c1b00000-0000-4000-8000-000000000001') ->> 'total' $$)
          || '/' || c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001', c10b_task('x')) $$),
  '0/0/0/42501', 'another tenant''s Sales reads none of T1''s contacts or tasks, lists none of them, adds none');
select is(c10b_val('select count(*) from public.crm_contacts') || '/' || c10b_val('select count(*) from public.crm_tasks'),
  '1/1', 'and reads its own tenant''s');
select c10b_as('D');
select is(c10b_val('select count(*) from public.crm_contacts') || '/' || c10b_val('select count(*) from public.crm_tasks')
          || '/' || c10b_val($$ select public.crm_task_create('c1b00000-0000-4000-8000-000000000001', c10b_task('x')) $$),
  '0/0/42501', 'a Developer still reads no contact or task and adds none (owner default O-7)');
select c10b_as('C');
select is(c10b_val('select count(*) from public.crm_contacts') || '/' || c10b_val('select count(*) from public.crm_tasks'),
  '0/0', 'nor does a Content Creator');
select c10b_as('S');
select is(c10b_val('select count(*) from public.crm_contacts') || '/' || c10b_val('select count(*) from public.crm_tasks'),
  '0/0', 'nor SEO');
reset role;
set local role anon;
select c10b_as('N');
select is(c10b_val('select count(*) from public.crm_contacts') || ' ' || c10b_val('select count(*) from public.crm_tasks')
          || ' ' || c10b_val($$ select public.crm_contacts_list('c1b00000-0000-4000-8000-000000000001')::text $$),
  '42501 42501 42501', 'anon holds nothing');
reset role;

-- ── 7. What stayed as it was ───────────────────────────────────────────────────────────────
select is((select string_agg(title, ',' order by title) from public.crm_tasks
            where tenant_id = 'c1b00000-0000-4000-8000-000000000001'),
  'Call Huda again,For a colleague,Send Huda the deck', 'T1''s tasks are the ones the live Sales token made or changed');
select is((select title from public.crm_contacts where id = 'c1b00000-0000-4000-8000-00000000c001'),
  'Founder', 'and the contact as the live Sales token left it');
select is((select title from public.crm_tasks where id = 'c1b00000-0000-4000-8000-0000000077ff'),
  'Theirs', 'another tenant''s task is untouched');

select * from finish();
rollback;
