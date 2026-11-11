-- pgTAP: the CSV import's database half (Admin v2 C15, crm.md §12; migration
-- 0139_crm_contact_import.sql, a placeholder number). Run with `supabase test db`.
--
-- Personas, each a token as PostgREST carries it: A admin, B a second admin, C
-- content_creator, S seo, D developer, L sales, O another tenant's admin, N anon; stale Admin
-- tokens Ad (the profile now says content_creator), Ao (switched off), Al (locked). crm.import
-- is Admin's alone. Proven here:
--   1. the helper answers Admin alone, for every role;
--   2. the doors are the service role's alone and refuse every actor who is not a live Admin
--      of the tenant (C S D L O Ad Ao Al), at open, at each piece and at finish;
--   3. a piece: dedupe by blind index (an e-mail a contact holds; with no e-mail, a phone),
--      a repeat of an earlier row of the same import named by its row, a phone match listed,
--      a value the columns refuse not imported; counts only in the answer; the batch's running
--      totals; the limits (50 a piece, the declared rows, the bytes); a bad shape writes
--      nothing; someone else's, a finished or an old batch is unseen; opening again stops the
--      Admin's open batch;
--   4. what was made: source 'import', the Admin as creator, the channels primary and
--      'import', the lawful basis kept by row, and gone with the contact;
--   5. the tables: only a live crm.import holder reads the batches, only a live crm.contacts
--      holder the bases, nothing across tenants, anon nothing, and no token writes either;
--   7. one open import per Admin (a unique index, and the open door's lock), and the hourly
--      sweep: an import open longer than two hours, even one whose Admin was switched off, is
--      stopped and gets its outcome audit row (counts only, no actor); the fresh ones stay.

begin;
select plan(62);

insert into public.tenants (id, name) values
  ('c1500000-0000-4000-8000-000000000001', 'C15 T1'),
  ('c1500000-0000-4000-8000-0000000000ff', 'C15 T2');

create table c15_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                          profile_role text, active boolean, locked boolean);
insert into c15_persona values
  ('A',  'c1500000-0000-4000-8000-0000000000a1', 'admin',           'c1500000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('B',  'c1500000-0000-4000-8000-0000000000b1', 'admin',           'c1500000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c1500000-0000-4000-8000-0000000000c1', 'content_creator', 'c1500000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c1500000-0000-4000-8000-0000000000e1', 'seo',             'c1500000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c1500000-0000-4000-8000-0000000000d1', 'developer',       'c1500000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c1500000-0000-4000-8000-000000000051', 'sales',           'c1500000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c1500000-0000-4000-8000-0000000000f1', 'admin',           'c1500000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c1500000-0000-4000-8000-0000000000a2', 'admin',           'c1500000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c1500000-0000-4000-8000-0000000000a3', 'admin',           'c1500000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c1500000-0000-4000-8000-0000000000a4', 'admin',           'c1500000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c15-' || lower(code) || '@example.test' from c15_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C15 ' || code
    from c15_persona;

-- T1 holds one contact already: an e-mail (index '1…') and a phone (index '2…'). T2 holds a
-- contact with the same e-mail index (another tenant's person: never a duplicate here).
insert into public.crm_contacts (id, tenant_id, display_name) values
  ('c1500000-0000-4000-8000-00000000c001', 'c1500000-0000-4000-8000-000000000001', 'Already Here'),
  ('c1500000-0000-4000-8000-00000000c0ff', 'c1500000-0000-4000-8000-0000000000ff', 'Elsewhere');
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary) values
  ('c1500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-00000000c001', 'email', 'ct-e1', repeat('1', 64), true),
  ('c1500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-00000000c001', 'phone', 'ct-p1', repeat('2', 64), true),
  ('c1500000-0000-4000-8000-0000000000ff', 'c1500000-0000-4000-8000-00000000c0ff', 'email', 'ct-o1', repeat('3', 64), true);

create function c15_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c15_persona p where p.code = p_code), ''), true)
$$;
-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function c15_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- One statement as each persona in turn: the answers, space-separated.
create function c15_each(p_codes text[], p_sql text) returns text language plpgsql as $$
declare
  v_code text;
  v_out text[] := '{}';
begin
  foreach v_code in array p_codes loop
    perform c15_as(v_code);
    v_out := v_out || c15_val(p_sql);
  end loop;
  return array_to_string(v_out, ' ');
end $$;
-- One door call (its actor written %L) with each actor who may not import for T1.
create function c15_refusals(p_sql text) returns text language plpgsql as $$
declare
  v_actor text;
  v_out text[] := '{}';
begin
  foreach v_actor in array array['c1500000-0000-4000-8000-0000000000c1', 'c1500000-0000-4000-8000-0000000000e1',
                                 'c1500000-0000-4000-8000-0000000000d1', 'c1500000-0000-4000-8000-000000000051',
                                 'c1500000-0000-4000-8000-0000000000f1', 'c1500000-0000-4000-8000-0000000000a2',
                                 'c1500000-0000-4000-8000-0000000000a3', 'c1500000-0000-4000-8000-0000000000a4'] loop
    v_out := v_out || c15_val(format(p_sql, v_actor));
  end loop;
  return array_to_string(v_out, ' ');
end $$;
-- A row of a piece: its number, its basis, its name, its e-mail and phone indexes (null: none).
create function c15_row(p_row int, p_basis text, p_name text, p_email text, p_phone text,
                        p_extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('row', p_row, 'basis', p_basis, 'display_name', p_name,
           'channels', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (
              select jsonb_build_object('kind', 'email', 'value_enc', 'ct-' || p_row || 'e',
                                        'value_hmac', repeat(p_email, 64)) c where p_email is not null
              union all
              select jsonb_build_object('kind', 'phone', 'value_enc', 'ct-' || p_row || 'p',
                                        'value_hmac', repeat(p_phone, 64)) where p_phone is not null) x))
         || p_extra
$$;
create table c15_ids (k text primary key, id uuid);
grant execute on function c15_as(text), c15_val(text), c15_each(text[], text), c15_refusals(text),
  c15_row(int, text, text, text, text, jsonb) to anon, authenticated, service_role;
grant select on c15_persona to anon, authenticated, service_role;
grant all on c15_ids to service_role;

-- ── 1. The helper ─────────────────────────────────────────────────────────────────────────
select is(
  (select string_agg(r || ':' || app.role_crm_import(r)::int, ' ' order by r)
     from unnest(enum_range(null::public.app_role)::text[] || array['anon']) r),
  'admin:1 anon:0 content_creator:0 developer:0 sales:0 seo:0',
  'crm.import: Admin alone, for every role (CLAUDE.md §5)');

-- ── 2. The doors: the service role's alone ────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.crm_import_open(uuid, uuid, integer, integer, text)', 'execute')
          and not has_function_privilege('anon', 'public.crm_import_open(uuid, uuid, integer, integer, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_import_rows(uuid, uuid, uuid, jsonb, integer, integer)', 'execute')
          and not has_function_privilege('anon', 'public.crm_import_rows(uuid, uuid, uuid, jsonb, integer, integer)', 'execute')
          and not has_function_privilege('authenticated', 'public.crm_import_finish(uuid, uuid, uuid, boolean)', 'execute')
          and not has_function_privilege('anon', 'public.crm_import_finish(uuid, uuid, uuid, boolean)', 'execute')
          and has_function_privilege('service_role', 'public.crm_import_rows(uuid, uuid, uuid, jsonb, integer, integer)', 'execute'),
  'the three doors are executable by the service role only');
select ok(not has_function_privilege('authenticated', 'app.crm_import_actor_ok(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'app.crm_import_actor_ok(uuid, uuid)', 'execute'),
  'and so is the actor check');

set local role authenticated;
select c15_as('A');
select is(c15_val($$ select public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                      'c1500000-0000-4000-8000-0000000000a1', 10, 1000, 'c15-v1') ->> 'id' $$),
  '42501', 'even a live Admin''s token cannot open an import directly');
reset role;

set local role service_role;
select is(c15_refusals($$ select public.crm_import_open('c1500000-0000-4000-8000-000000000001', %L, 10, 1000,
                         'c15-v1') ->> 'id' $$),
  '42501 42501 42501 42501 42501 42501 42501 42501',
  'open refuses C, S, D, L, another tenant''s Admin, and the demoted, switched-off and locked Admins');
select is(c15_val($$ select public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                      'c1500000-0000-4000-8000-0000000000a1', 5001, 1000, 'c15-v1') ->> 'id' $$),
  '54000', 'more than 5,000 people is over the limit');
select is(c15_val($$ select public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                      'c1500000-0000-4000-8000-0000000000a1', 10, 2097153, 'c15-v1') ->> 'id' $$),
  '54000', 'and so is more than 2 MB');
select is(c15_val($$ select public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                      'c1500000-0000-4000-8000-0000000000a1', 10, 1000, 'c15-v0') ->> 'id' $$),
  '22023', 'an unknown attestation is refused');

insert into c15_ids
  select 'batch', (public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                     'c1500000-0000-4000-8000-0000000000a1', 10, 4000, 'c15-v1') ->> 'id')::uuid;
select is((select status || ' ' || expected_rows || ' ' || created_by::text || ' ' || attestation
             from public.crm_import_batches where id = (select id from c15_ids where k = 'batch')),
  'open 10 c1500000-0000-4000-8000-0000000000a1 c15-v1', 'a live Admin opens an import of their own');

-- ── 3. A piece ────────────────────────────────────────────────────────────────────────────
-- Row 2: new (e-mail 4, phone 5); 3: the existing contact's e-mail; 4: row 2's e-mail again;
-- 5: no e-mail, the existing contact's phone; 6: new e-mail 6 with the existing phone 2;
-- 7: no e-mail, row 2's phone; 8: a country the column refuses; 9: T2's e-mail index (a
-- stranger here). Plus one row the Worker refused (p_failed 1).
select is(c15_refusals(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                         %%L, jsonb_build_array(c15_row(2, 'consent', 'New Person', '4', '5')), 0, 100) ->> 'created' $$,
                         (select id from c15_ids where k = 'batch'))),
  '42501 42501 42501 42501 42501 42501 42501 42501', 'a piece refuses every actor who is not a live Admin of the tenant');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000b1', jsonb_build_array(c15_row(2, 'consent', 'X', '4', null)), 0, 10)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  'P0002', 'another Admin cannot add to this Admin''s import');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1',
                    jsonb_build_array(c15_row(2, 'consent', 'X', '4', null, '{"note": "x"}')), 0, 10)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  '22023', 'a row with a key the door does not know is refused');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1', jsonb_build_array(c15_row(2, 'consent', 'X', null, null)), 0, 10)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  '22023', 'and so is a row with neither an e-mail nor a phone');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1',
                    (select jsonb_agg(c15_row(g, 'consent', 'X', null, 'a')) from generate_series(2, 52) g), 0, 10)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  '22023', 'a piece holds at most 50 rows');
select is((select rows_seen || ' ' || pieces from public.crm_import_batches where id = (select id from c15_ids where k = 'batch')),
  '0 0', 'and a refused piece writes nothing');

create temp table c15_answer as
  select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', (select id from c15_ids where k = 'batch'),
           'c1500000-0000-4000-8000-0000000000a1',
           jsonb_build_array(
             c15_row(2, 'consent', 'New Person', '4', '5', '{"company_name": "Acme", "tags": ["vip"], "locale": "ar"}'),
             c15_row(3, 'contract', 'Already Again', '1', null),
             c15_row(4, 'consent', 'Repeat Person', '4', null),
             c15_row(5, 'consent', 'Phone Only', null, '2'),
             c15_row(6, 'contract', 'Shares A Line', '6', '2'),
             c15_row(7, 'consent', 'Phone Repeat', null, '5'),
             c15_row(8, 'consent', 'Bad Country', '7', null, '{"country": "xx"}'),
             c15_row(10, 'legitimate_interest', 'Stranger Here', '3', null)),
           1, 900) as a;
select is((select a::text from c15_answer),
  '{"created": 3, "refused": [8], "repeats": [{"of": 2, "row": 4}, {"of": 2, "row": 7}], "duplicates": [3, 5], "phone_matches": [6]}',
  'added 2, 6 and 10; 3 and 5 already contacts; 4 and 7 repeat row 2; 6 a phone match; 8 refused: row numbers only');
select is((select rows_seen || ' ' || bytes_seen || ' ' || pieces || ' ' || created_count || ' ' || duplicate_count
                  || ' ' || repeat_count || ' ' || failed_count || ' ' || phone_match_count || ' ' || basis_counts::text
             from public.crm_import_batches where id = (select id from c15_ids where k = 'batch')),
  '9 900 1 3 2 2 2 1 {"consent": 1, "contract": 1, "legitimate_interest": 1}',
  'the batch keeps the running totals (the Worker''s refused row among the failed) and the count per basis');
select is((select count(*)::int from public.crm_contacts where tenant_id = 'c1500000-0000-4000-8000-000000000001'),
  4, 'three contacts were added to the one already there; nothing for a duplicate, a repeat or a refused row');
select is((select c.source || ' ' || c.created_by::text || ' ' || c.stage || ' ' || c.locale || ' '
                  || c.company_name || ' ' || array_to_string(c.tags, ',')
             from public.crm_contacts c where c.display_name = 'New Person'),
  'import c1500000-0000-4000-8000-0000000000a1 lead ar Acme vip',
  'an imported contact: source import, the Admin as its creator, stage lead unless given');
select is((select string_agg(ch.kind || ':' || ch.source || ':' || ch.is_primary, ' ' order by ch.kind)
             from public.crm_contact_channels ch join public.crm_contacts c on c.id = ch.contact_id
            where c.display_name = 'New Person'),
  'email:import:true phone:import:true', 'its e-mail and phone, from the import, each the primary');
select is((select ci.row_number || ' ' || ci.basis from public.crm_contact_imports ci
             join public.crm_contacts c on c.id = ci.contact_id where c.display_name = 'Shares A Line'),
  '6 contract', 'the lawful basis is kept with the row it came from');
select is((select count(*)::int from public.crm_contact_events e join public.crm_contacts c on c.id = e.contact_id
            where c.display_name = 'New Person' and e.kind = 'created' and e.detail ->> 'source' = 'import'),
  1, 'its timeline says it was created by an import');
select is((select count(*)::int from public.crm_contacts where display_name in ('Repeat Person', 'Bad Country', 'Phone Only')),
  0, 'no contact for a repeat, a duplicate or a refused row');

-- The limits.
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1',
                    jsonb_build_array(c15_row(11, 'consent', 'A', 'a', null), c15_row(12, 'consent', 'B', 'b', null)), 0, 10)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  '54000', 'a piece past the rows the file declared is over the limit (9 seen of 10)');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1', '[]'::jsonb, 1, 262145)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  '22023', 'a piece is at most 256 KB');
update public.crm_import_batches set bytes_seen = 2621000 where id = (select id from c15_ids where k = 'batch');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1', '[]'::jsonb, 1, 1000)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  '54000', 'the batch''s bytes stop at the file''s limit and a quarter');
update public.crm_import_batches set bytes_seen = 900 where id = (select id from c15_ids where k = 'batch');

-- A later piece: a repeat is named against the earlier piece's row (a 5,000-row file is 100 pieces).
select is((select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', (select id from c15_ids where k = 'batch'),
             'c1500000-0000-4000-8000-0000000000a1',
             jsonb_build_array(c15_row(11, 'consent', 'Later Repeat', '4', null)), 0, 10)::text),
  '{"created": 0, "refused": [], "repeats": [{"of": 2, "row": 11}], "duplicates": [], "phone_matches": []}',
  'a later piece names a repeat of a row an earlier piece added, and adds nobody');

-- Finish.
select is(c15_refusals(format($$ select public.crm_import_finish('c1500000-0000-4000-8000-000000000001', %L, %%L, false)::text $$,
                         (select id from c15_ids where k = 'batch'))),
  '42501 42501 42501 42501 42501 42501 42501 42501', 'finish refuses every actor who is not a live Admin of the tenant');
select is((select (a - 'id' - 'bases')::text from (select public.crm_import_finish('c1500000-0000-4000-8000-000000000001',
             (select id from c15_ids where k = 'batch'), 'c1500000-0000-4000-8000-0000000000a1', false) a) x),
  '{"rows": 10, "failed": 2, "status": "done", "created": 3, "repeats": 3, "duplicates": 2, "phone_matches": 1}',
  'finish closes the import and answers its counts');
select is(c15_val(format($$ select public.crm_import_finish('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1', false)::text $$, (select id from c15_ids where k = 'batch'))),
  'P0002', 'a finished import cannot be finished again');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1', jsonb_build_array(c15_row(11, 'consent', 'Late', 'c', null)), 0, 10)::text $$,
                    (select id from c15_ids where k = 'batch'))),
  'P0002', 'nor take another piece');
select ok((select finished_at is not null from public.crm_import_batches where id = (select id from c15_ids where k = 'batch')),
  'a finished import has its time');

-- A second import: an old open one is unseen; opening again stops the Admin's open one.
insert into c15_ids
  select 'second', (public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                      'c1500000-0000-4000-8000-0000000000a1', 3, 100, 'c15-v1') ->> 'id')::uuid;
update public.crm_import_batches set created_at = now() - interval '3 hours'
 where id = (select id from c15_ids where k = 'second');
select is(c15_val(format($$ select public.crm_import_rows('c1500000-0000-4000-8000-000000000001', %L,
                    'c1500000-0000-4000-8000-0000000000a1', jsonb_build_array(c15_row(2, 'consent', 'Old', 'c', null)), 0, 10)::text $$,
                    (select id from c15_ids where k = 'second'))),
  'P0002', 'an import opened more than two hours ago takes no more pieces');
select is((select jsonb_array_length(o -> 'stopped') || ' ' || (o -> 'stopped' -> 0 ->> 'id') || ' ' || (o -> 'stopped' -> 0 ->> 'status')
             from (select public.crm_import_open('c1500000-0000-4000-8000-000000000001',
                     'c1500000-0000-4000-8000-0000000000a1', 3, 100, 'c15-v1') o) x),
  '1 ' || (select id from c15_ids where k = 'second')::text || ' stopped',
  'opening again stops the Admin''s open import and answers its counts');
select is((select count(*)::int from public.crm_import_batches
            where tenant_id = 'c1500000-0000-4000-8000-000000000001' and status = 'open'),
  1, 'so an Admin has one open import at most');
-- B's own import in T1, and O's in T2, for the reads below.
select ok((public.crm_import_open('c1500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-0000000000b1',
             1, 10, 'c15-v1') ->> 'id') is not null, 'another Admin opens an import of their own');
select ok((public.crm_import_open('c1500000-0000-4000-8000-0000000000ff', 'c1500000-0000-4000-8000-0000000000f1',
             1, 10, 'c15-v1') ->> 'id') is not null, 'and another tenant''s Admin one in their tenant');
reset role;

-- ── 5. The tables, per token ──────────────────────────────────────────────────────────────
set local role authenticated;
select is(c15_each(array['A', 'B', 'C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'],
                   $$ select count(*)::text from public.crm_import_batches $$),
  '4 4 0 0 0 0 1 0 0 0',
  'the batches: a live Admin reads the tenant''s four, another tenant''s Admin only theirs, every other token none');
select is(c15_each(array['A', 'C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'],
                   $$ select count(*)::text from public.crm_contact_imports $$),
  '3 0 0 0 0 0 0 0 0',
  'the bases: a live crm.contacts holder reads the tenant''s three, every other token none');
select c15_as('A');
select is(c15_val($$ insert into public.crm_import_batches (tenant_id, attestation, expected_rows, expected_bytes)
                     values ('c1500000-0000-4000-8000-000000000001', 'c15-v1', 1, 1) returning 'written' $$),
  '42501', 'no token inserts a batch');
select is(c15_val($$ with u as (update public.crm_import_batches set created_count = 99 returning 1)
                     select count(*)::text from u $$),
  '42501', 'or changes one');
select is(c15_val($$ with d as (delete from public.crm_import_batches returning 1) select count(*)::text from d $$),
  '42501', 'or deletes one');
select is(c15_val($$ insert into public.crm_contact_imports (tenant_id, contact_id, batch_id, row_number, basis)
                     values ('c1500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-00000000c001',
                             (select id from public.crm_import_batches limit 1), 2, 'consent') returning 'written' $$),
  '42501', 'no token records a basis');
select is(c15_val($$ with u as (update public.crm_contact_imports set basis = 'consent' returning 1)
                     select count(*)::text from u $$),
  '42501', 'or changes one');
select is(c15_val($$ with d as (delete from public.crm_contact_imports returning 1) select count(*)::text from d $$),
  '42501', 'or deletes one');
reset role;
set local role anon;
select is(c15_val($$ select count(*)::text from public.crm_import_batches $$), '42501', 'anon reads no batch');
select is(c15_val($$ select count(*)::text from public.crm_contact_imports $$), '42501', 'and no basis');
reset role;

-- ── 4 (cont.). The basis goes with the contact ───────────────────────────────────────────
delete from public.crm_contacts where display_name = 'New Person';
select is((select count(*)::int from public.crm_contact_imports where row_number = 2), 0,
  'a contact deleted (retention, erasure) takes its lawful-basis row with it');
select is((select count(*)::int from public.crm_contact_imports), 2, 'and only its own');

-- ── 7. Imports left open: one per Admin, and the hourly sweep closes the abandoned ────────
set local role service_role;
select is(c15_val($$ insert into public.crm_import_batches (tenant_id, created_by, attestation, expected_rows, expected_bytes)
                     values ('c1500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-0000000000a1',
                             'c15-v1', 1, 1) returning 'written' $$),
  '23505', 'the database holds an Admin to one open import, even outside the open door (two tabs at once)');
reset role;
select ok((select prosrc ~ 'pg_advisory_xact_lock\(hashtextextended\(''crm-import:'''
             from pg_proc where oid = 'public.crm_import_open(uuid, uuid, integer, integer, text)'::regprocedure),
  'and the open door takes the Admin''s lock before it stops and opens, so a second open waits for the first');
-- B's import is abandoned (opened three hours ago), then B is switched off: B's doors now
-- refuse B, so only the sweep can close it.
update public.crm_import_batches set created_at = now() - interval '3 hours'
 where created_by = 'c1500000-0000-4000-8000-0000000000b1';
update public.profiles set is_active = false where id = 'c1500000-0000-4000-8000-0000000000b1';
set local role service_role;
select is(c15_val($$ select public.crm_import_finish('c1500000-0000-4000-8000-000000000001',
                      (select id from public.crm_import_batches where created_by = 'c1500000-0000-4000-8000-0000000000b1'),
                      'c1500000-0000-4000-8000-0000000000b1', true)::text $$),
  '42501', 'a switched-off Admin cannot close their own import');
select ok(not has_function_privilege('service_role', 'app.crm_import_sweep()', 'execute')
          and not has_function_privilege('authenticated', 'app.crm_import_sweep()', 'execute')
          and not has_function_privilege('anon', 'app.crm_import_sweep()', 'execute'),
  'no API role runs the sweep (pg_cron runs it as its owner)');
reset role;
select is(app.crm_import_sweep(), 1, 'the sweep stops the one import open longer than two hours');
select is((select string_agg(coalesce(p.display_name, '?') || ':' || b.status || ':' || (b.finished_at is not null)::text,
                             ' ' order by p.display_name)
             from public.crm_import_batches b left join public.profiles p on p.id = b.created_by
            where b.status = 'open' or b.created_by = 'c1500000-0000-4000-8000-0000000000b1'),
  'C15 A:open:false C15 B:stopped:true C15 O:open:false',
  'B''s abandoned import is stopped with its time; the imports opened within two hours stay open');
select is((select a.detail::text || ' ' || (a.actor_id is null)::text || ' ' || a.tenant_id::text
             from public.audit_log a
            where a.action = 'crm.import.outcome' and a.entity_type = 'contact_import'
              and a.entity_id = (select id::text from public.crm_import_batches
                                  where created_by = 'c1500000-0000-4000-8000-0000000000b1')),
  '{"rows": 0, "swept": true, "failed": 0, "status": "stopped", "created": 0, "repeats": 0, "left_open": true, '
  '"duplicates": 0, "phone_matches": 0} true c1500000-0000-4000-8000-000000000001',
  'and gets its outcome audit row in its own tenant: counts only, no actor, said to be left open');
update public.crm_import_batches set rows_seen = 2, created_count = 2, basis_counts = '{"consent": 1, "contract": 1}',
                                     created_at = now() - interval '5 hours'
 where created_by = 'c1500000-0000-4000-8000-0000000000a1' and status = 'open';
select is(app.crm_import_sweep(), 1, 'a later run stops only what is newly stale');
select is((select (a.detail - 'status' - 'left_open' - 'swept')::text from public.audit_log a
            where a.action = 'crm.import.outcome' and a.detail ->> 'created' = '2'),
  '{"rows": 2, "failed": 0, "created": 2, "repeats": 0, "duplicates": 0, "basis_consent": 1, '
  '"phone_matches": 0, "basis_contract": 1}',
  'the outcome carries the count per lawful basis, by name, as the Worker''s outcome row does');
select is(app.crm_import_sweep(), 0, 'and a run with nothing stale stops nothing');

-- ── 6. The catalog ────────────────────────────────────────────────────────────────────────
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
            where oid in ('public.crm_import_batches'::regclass, 'public.crm_contact_imports'::regclass)),
  'both tables have RLS enabled and forced');
select is((select string_agg(tablename || ':' || policyname || ':' || permissive, ' ' order by tablename, policyname)
             from pg_policies where schemaname = 'public' and tablename in ('crm_import_batches', 'crm_contact_imports')),
  'crm_contact_imports:crm_contact_imports_live:RESTRICTIVE crm_contact_imports:crm_contact_imports_read:PERMISSIVE '
  'crm_import_batches:crm_import_batches_live:RESTRICTIVE crm_import_batches:crm_import_batches_read:PERMISSIVE',
  'each a read policy and a RESTRICTIVE live check, nothing else');
select ok(not has_table_privilege('anon', 'public.crm_import_batches', 'select')
          and not has_table_privilege('anon', 'public.crm_contact_imports', 'select')
          and not has_table_privilege('authenticated', 'public.crm_import_batches', 'insert')
          and not has_table_privilege('authenticated', 'public.crm_contact_imports', 'insert'),
  'anon holds nothing, staff only SELECT');

select * from finish();
rollback;
