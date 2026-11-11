-- pgTAP: merging duplicate contacts (Admin v2 C12, crm.md §5.5 and CRM-12; migration 0138). Run
-- with `supabase test db`.
--
-- Personas, each a token as PostgREST carries it: A admin, C content_creator, S seo, D
-- developer, L sales, O another tenant's admin, N anon; stale Admin tokens Ad (the profile now
-- says content_creator), Ao (switched off), Al (locked). crm.contacts is Admin's alone (Sales
-- from C10b). Proven here:
--   1. the finder: only a live Admin of the tenant gets pairs (same phone; same name and
--      company), never a value, nothing across tenants, no tombstone; the limit is bounded;
--   2. "Not a duplicate": as the caller, both people seen, idempotent, never a tombstone, the
--      trigger refuses a stale or foreign insert before anything else; a dismissed pair is gone;
--   3. the merge door: the service role's alone, refusing every actor who may not; P0002 for
--      another tenant's id or a tombstone; 40001 on either version; the channel ceiling; a
--      failure after the moves (the audit row refused) leaves everything as it was;
--   4. a merge: channels, notes, tasks, leads, timeline lines and dismissals move; the survivor's
--      blanks fill and its stage follows precedence; the other becomes a scrubbed tombstone;
--      the audit row is there; tombstones follow the survivor;
--   5. the finder's plan reads through the indexes and answers at most 50 pairs;
--   6. retention: the next run removes tombstones, after moving what raced onto one;
--   7. the review's cases (C12 review): a flood of one name at one company is not offered; a
--      value both records hold keeps a person's source; a merge is a person's edit whatever it
--      fills; the ceiling counts only what the other adds; a tombstone is not erased.
--
-- C10b + C12 integration: these lines assert that Sales is refused (crm.contacts is Admin's
-- here). When C10b re-creates app.role_crm_contacts as ('admin', 'sales'), whichever of the
-- two merges second flips them to allowed and adds a Sales success row: section 1's "a
-- Content Creator, SEO, a Developer and Sales find nothing" (Sales finds the pairs), section
-- 2's "nobody but a live Admin of the tenant says so" (L) and "only a live Admin of the
-- tenant reads the dismissals" (L), and section 3's refused actors (the Sales actor ...051).

begin;
select plan(71);

insert into public.tenants (id, name) values
  ('c1200000-0000-4000-8000-000000000001', 'C12 T1'),
  ('c1200000-0000-4000-8000-0000000000ff', 'C12 T2');

create table c12_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                          profile_role text, active boolean, locked boolean);
insert into c12_persona values
  ('A',  'c1200000-0000-4000-8000-0000000000a1', 'admin',           'c1200000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c1200000-0000-4000-8000-0000000000c1', 'content_creator', 'c1200000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c1200000-0000-4000-8000-0000000000e1', 'seo',             'c1200000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c1200000-0000-4000-8000-0000000000d1', 'developer',       'c1200000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c1200000-0000-4000-8000-000000000051', 'sales',           'c1200000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c1200000-0000-4000-8000-0000000000f1', 'admin',           'c1200000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c1200000-0000-4000-8000-0000000000a2', 'admin',           'c1200000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c1200000-0000-4000-8000-0000000000a3', 'admin',           'c1200000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c1200000-0000-4000-8000-0000000000a4', 'admin',           'c1200000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c12-' || lower(code) || '@example.test' from c12_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C12 ' || code
    from c12_persona;

-- T1: c001 Huda Saleh at Acme (an e-mail, a phone, a note, a lead linked by e-mail, a tag);
-- c002 "huda saleh" at "ACME" (made by a person; a title, its own e-mail and phone, a note, a
-- task, a lead, a tag, starred); c003 Omar Ali (Huda's phone: a shared line; a client); c004
-- Sara (no match); c0dd a tombstone of c001; c0de a tombstone of c003. T2: Huda Saleh at Acme.
insert into public.crm_contacts (id, tenant_id, display_name, company_name, tags, last_activity_at) values
  ('c1200000-0000-4000-8000-00000000c001', 'c1200000-0000-4000-8000-000000000001', 'Huda Saleh', 'Acme', '{vip}', now() - interval '3 days'),
  ('c1200000-0000-4000-8000-00000000c003', 'c1200000-0000-4000-8000-000000000001', 'Omar Ali', null, '{}', now() - interval '9 days'),
  ('c1200000-0000-4000-8000-00000000c004', 'c1200000-0000-4000-8000-000000000001', 'Sara Noor', null, '{}', now() - interval '1 day'),
  ('c1200000-0000-4000-8000-00000000c0ff', 'c1200000-0000-4000-8000-0000000000ff', 'Huda Saleh', 'Acme', '{}', now());
insert into public.crm_contacts (id, tenant_id, display_name, company_name, title, tags, is_starred, created_by, last_activity_at) values
  ('c1200000-0000-4000-8000-00000000c002', 'c1200000-0000-4000-8000-000000000001', 'huda saleh', 'ACME', 'Director',
   '{vip,fair}', true, 'c1200000-0000-4000-8000-0000000000a1', now() - interval '40 days');
update public.crm_contacts set stage = 'client' where id = 'c1200000-0000-4000-8000-00000000c003';
insert into public.crm_contacts (id, tenant_id, display_name, merged_into, merged_at) values
  ('c1200000-0000-4000-8000-00000000c0dd', 'c1200000-0000-4000-8000-000000000001', 'Merged contact',
   'c1200000-0000-4000-8000-00000000c001', now()),
  ('c1200000-0000-4000-8000-00000000c0de', 'c1200000-0000-4000-8000-000000000001', 'Merged contact',
   'c1200000-0000-4000-8000-00000000c003', now());
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary) values
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c001', 'email', 'enc-e1', repeat('1', 64), true),
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c001', 'phone', 'enc-p2', repeat('2', 64), true),
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c002', 'email', 'enc-e4', repeat('4', 64), true),
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c002', 'phone', 'enc-p3', repeat('3', 64), true),
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c003', 'phone', 'enc-p2b', repeat('2', 64), true),
  ('c1200000-0000-4000-8000-0000000000ff', 'c1200000-0000-4000-8000-00000000c0ff', 'phone', 'enc-o', repeat('2', 64), true);
insert into public.crm_contact_notes (id, tenant_id, contact_id, body, created_at) values
  ('c1200000-0000-4000-8000-0000000000b1', 'c1200000-0000-4000-8000-000000000001',
   'c1200000-0000-4000-8000-00000000c001', 'About Huda', now() - interval '5 days'),
  ('c1200000-0000-4000-8000-0000000000b2', 'c1200000-0000-4000-8000-000000000001',
   'c1200000-0000-4000-8000-00000000c002', 'Met at the fair', now() - interval '41 days');
insert into public.crm_tasks (id, tenant_id, title, type, contact_id, due_at) values
  ('c1200000-0000-4000-8000-0000000000d7', 'c1200000-0000-4000-8000-000000000001', 'Call back', 'call',
   'c1200000-0000-4000-8000-00000000c002', now() + interval '1 day');
insert into public.leads (id, tenant_id, name, email_enc, email_hmac, message, crm_indexed_at) values
  ('c1200000-0000-4000-8000-00000000aa01', 'c1200000-0000-4000-8000-000000000001', 'Huda', 'enc-e1',
   repeat('1', 64), 'hello', now()),
  ('c1200000-0000-4000-8000-00000000aa02', 'c1200000-0000-4000-8000-000000000001', 'Huda S', 'enc-e4',
   repeat('4', 64), 'hi', now()),
  ('c1200000-0000-4000-8000-00000000aa05', 'c1200000-0000-4000-8000-000000000001', 'Late', 'enc-e9',
   repeat('9', 64), 'raced', now());
update public.leads set contact_id = 'c1200000-0000-4000-8000-00000000c001', contact_link = 'email'
 where id = 'c1200000-0000-4000-8000-00000000aa01';
update public.leads set contact_id = 'c1200000-0000-4000-8000-00000000c002', contact_link = 'new'
 where id = 'c1200000-0000-4000-8000-00000000aa02';

-- The fixtures' own timeline lines happened before this test's "now" (a pgTAP run is one
-- transaction, so now() would otherwise be the same for all of them and for the merge).
update public.crm_contact_events set at = at - interval '10 days';
update public.lead_events set at = at - interval '10 days';

create function c12_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c12_persona p where p.code = p_code), ''), true)
$$;
-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function c12_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- The pairs the current token finds for T1 (or T2), as "a-b:reasons" by the ids' last four.
create function c12_pairs(p_tenant text default 'T1') returns text language sql as $$
  select c12_val(format($q$ select coalesce(string_agg(right(p -> 'a' ->> 'id', 4) || '-' || right(p -> 'b' ->> 'id', 4)
                                                       || ':' || array_to_string(array(select jsonb_array_elements_text(p -> 'reasons')), '+'),
                                                       ' ' order by n), '')
                              from jsonb_array_elements(public.crm_duplicate_pairs(%L::uuid)) with ordinality as x(p, n) $q$,
                       case p_tenant when 'T2' then 'c1200000-0000-4000-8000-0000000000ff'
                                     else 'c1200000-0000-4000-8000-000000000001' end))
$$;
-- One statement as each persona in turn: the answers, space-separated.
create function c12_each(p_codes text[], p_sql text) returns text language plpgsql as $$
declare
  v_code text;
  v_out text[] := '{}';
begin
  foreach v_code in array p_codes loop
    perform c12_as(v_code);
    v_out := v_out || c12_val(p_sql);
  end loop;
  return array_to_string(v_out, ' ');
end $$;
-- The merge door (its actor written %L) with each actor who may not act for T1.
create function c12_refusals(p_sql text) returns text language plpgsql as $$
declare
  v_actor text;
  v_out text[] := '{}';
begin
  foreach v_actor in array array['c1200000-0000-4000-8000-0000000000c1', 'c1200000-0000-4000-8000-0000000000e1',
                                 'c1200000-0000-4000-8000-0000000000d1', 'c1200000-0000-4000-8000-000000000051',
                                 'c1200000-0000-4000-8000-0000000000f1', 'c1200000-0000-4000-8000-0000000000a2',
                                 'c1200000-0000-4000-8000-0000000000a3', 'c1200000-0000-4000-8000-0000000000a4'] loop
    v_out := v_out || c12_val(format(p_sql, v_actor));
  end loop;
  return array_to_string(v_out, ' ');
end $$;
grant execute on function c12_as(text), c12_val(text), c12_pairs(text), c12_each(text[], text),
  c12_refusals(text) to anon, authenticated, service_role;
grant select on c12_persona to anon, authenticated, service_role;

-- ── 1. The finder ─────────────────────────────────────────────────────────────────────────
set local role authenticated;
select c12_as('A');
select is(c12_pairs(), 'c001-c003:phone c001-c002:name_company',
  'a live Admin finds the shared phone first, then the same name at the same company (folded)');
select is(c12_val($$ select string_agg(distinct k, ',')
                      from jsonb_array_elements(public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001')) p,
                           jsonb_object_keys(p -> 'a') k $$),
  'company_name,created_at,display_name,emails,id,last_activity_at,leads,phones,stage,title,version',
  'each person carries who they are and counts, never a value or an index');
select is(c12_val($$ select (p -> 'b' ->> 'leads') || ' ' || (p -> 'b' ->> 'emails') || ' ' || (p -> 'b' ->> 'phones')
                      from jsonb_array_elements(public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001')) p
                     where p -> 'b' ->> 'id' = 'c1200000-0000-4000-8000-00000000c002' $$),
  '1 1 1', 'and how many leads, e-mails and phones would move');
select is(c12_pairs('T2'), '', 'a tenant that is not the token''s gives nothing');
select is(c12_val($$ select public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001', 51)::text $$),
  '22023', 'a limit past 50 is refused');
select is(c12_each(array['C', 'S', 'D', 'L'], $$ select public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001')::text $$),
  '[] [] [] []', 'a Content Creator, SEO, a Developer and Sales find nothing');
select c12_as('O');
select is(c12_pairs('T1') || '|' || c12_pairs('T2'), '|',
  'another tenant''s Admin finds nothing of T1, and its own tenant has one Huda');
select is(c12_each(array['Ad', 'Ao', 'Al'], $$ select public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001')::text $$),
  '[] [] []', 'demoted, switched-off and locked Admin tokens find nothing (the live check)');
select is(c12_each(array['C', 'Ad'], $$ select count(*)::text from app.crm_duplicate_candidates(50) $$),
  '0 0', 'nor does the definer answer them directly');
reset role;
set local role anon;
select is(c12_val($$ select public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001')::text $$),
  '42501', 'anon may not call the finder');
select is(c12_val($$ select count(*)::text from app.crm_duplicate_candidates(50) $$), '42501',
  'nor its definer');
reset role;

-- ── 2. "Not a duplicate" ──────────────────────────────────────────────────────────────────
set local role authenticated;
select is(c12_each(array['C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'],
                   $$ select public.crm_dismiss_duplicate('c1200000-0000-4000-8000-000000000001',
                        'c1200000-0000-4000-8000-00000000c001', 'c1200000-0000-4000-8000-00000000c003')::text $$),
  'P0002 P0002 P0002 P0002 P0002 P0002 P0002 P0002', 'nobody but a live Admin of the tenant says so');
select c12_as('A');
select is(c12_val($$ select public.crm_dismiss_duplicate('c1200000-0000-4000-8000-000000000001',
             'c1200000-0000-4000-8000-00000000c003', 'c1200000-0000-4000-8000-00000000c001')::text $$),
  'true', 'a live Admin says the shared phone is two people (the pair in either order)');
select is(c12_val($$ select public.crm_dismiss_duplicate('c1200000-0000-4000-8000-000000000001',
             'c1200000-0000-4000-8000-00000000c001', 'c1200000-0000-4000-8000-00000000c003')::text $$),
  'false', 'saying it twice is not an error');
select is(c12_pairs(), 'c001-c002:name_company', 'and that pair is not offered again');
select is(c12_val($$ select public.crm_dismiss_duplicate('c1200000-0000-4000-8000-000000000001',
             'c1200000-0000-4000-8000-00000000c001', 'c1200000-0000-4000-8000-00000000c0dd')::text $$),
  'P0002', 'a tombstone is unseen');
select is(c12_val($$ select public.crm_dismiss_duplicate('c1200000-0000-4000-8000-000000000001',
             'c1200000-0000-4000-8000-00000000c001', 'c1200000-0000-4000-8000-00000000c0ff')::text $$),
  'P0002', 'and so is another tenant''s contact');
select is(c12_val($$ select public.crm_dismiss_duplicate('c1200000-0000-4000-8000-000000000001',
             'c1200000-0000-4000-8000-00000000c001', 'c1200000-0000-4000-8000-00000000c001')::text $$),
  '22023', 'a person is not their own duplicate');
select is(c12_val($$ insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b)
                     values ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c001',
                             'c1200000-0000-4000-8000-00000000c0dd') returning 'x' $$),
  '23514', 'a direct insert naming a tombstone is refused');
select is(c12_val($$ insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b)
                     values ('c1200000-0000-4000-8000-0000000000ff', 'c1200000-0000-4000-8000-00000000c0ff',
                             'c1200000-0000-4000-8000-00000000c0ff') returning 'x' $$),
  '42501', 'and one naming another tenant is refused before any rule reads the row');
select is(c12_each(array['Ad', 'C'],
                   $$ insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b)
                      values ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c001',
                              'c1200000-0000-4000-8000-00000000c0dd') returning 'x' $$),
  '42501 42501', 'a stale or unentitled token is refused first too (no tombstone oracle)');
select is(c12_each(array['A', 'C', 'S', 'D', 'L', 'O', 'Ad', 'Ao', 'Al'],
                   $$ select count(*)::text from public.crm_merge_dismissals $$),
  '1 0 0 0 0 0 0 0 0',
  'only a live Admin of the tenant reads the dismissals (not another tenant''s Admin, nor a stale token)');
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select is(c12_val($$ select count(*)::text from public.crm_merge_dismissals $$), '42501',
  'anon reads no dismissal');
select is(c12_val($$ insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b)
                     values ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c001',
                             'c1200000-0000-4000-8000-00000000c004') returning 'x' $$),
  '42501', 'nor adds one');
reset role;
select is((select created_by::text from public.crm_merge_dismissals),
  'c1200000-0000-4000-8000-0000000000a1', 'a dismissal is put down to the person who made it');
-- Sara is not Huda either (c002 vs c004): it follows c002 into c001 below. (No token from here.)
select set_config('request.jwt.claims', '', true);
insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b, created_by)
values ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c002',
        'c1200000-0000-4000-8000-00000000c004', 'c1200000-0000-4000-8000-0000000000a1');

-- ── 3. The merge door's refusals ──────────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.crm_merge_contacts(uuid, uuid, integer, uuid, integer, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.crm_merge_contacts(uuid, uuid, integer, uuid, integer, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.crm_merge_contacts(uuid, uuid, integer, uuid, integer, uuid)', 'execute'),
  'the merge is the service role''s door alone');
set local role service_role;
select is(c12_refusals($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c002', 1, %L)::text $$),
  '42501 42501 42501 42501 42501 42501 42501 42501',
  'it refuses a Content Creator, SEO, a Developer, Sales, another tenant''s Admin, a demoted, a switched-off and a locked Admin');
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c0ff', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  'P0002', 'another tenant''s contact is unseen');
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-0000000000ff',
            'c1200000-0000-4000-8000-00000000c0ff', 1, 'c1200000-0000-4000-8000-00000000c001', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  '42501', 'naming another tenant, this Admin may not act');
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c0dd', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  'P0002', 'a tombstone is unseen as either side');
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c001', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  '22023', 'a contact is not merged into itself');
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 9, 'c1200000-0000-4000-8000-00000000c002', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$)
          || ' ' ||
          c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c002', 9,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  '40001 40001', 'a version that moved on, on either side, is a conflict');
reset role;

-- A failure after every move (the audit row refused): nothing has changed.
create function c12_refuse_audit() returns trigger language plpgsql as $$
begin
  if new.action = 'crm.contact.merge' then
    raise exception using errcode = 'P0001', message = 'the audit log is down';
  end if;
  return new;
end $$;
create trigger c12_refuse_audit before insert on public.audit_log
  for each row execute function c12_refuse_audit();
set local role service_role;
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c002', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  'P0001', 'when the audit row cannot be written, the merge fails');
reset role;
drop trigger c12_refuse_audit on public.audit_log;
select is((select concat_ws(' ', c.merged_into is null, c.display_name,
                            (select count(*) from public.crm_contact_channels ch where ch.contact_id = c.id),
                            (select count(*) from public.crm_contact_notes n where n.contact_id = c.id),
                            (select count(*) from public.crm_tasks t where t.contact_id = c.id),
                            (select count(*) from public.leads l where l.contact_id = c.id))
             from public.crm_contacts c where c.id = 'c1200000-0000-4000-8000-00000000c002'),
  't huda saleh 2 1 1 1', 'and everything it had moved is back where it was');

-- The ceiling: eleven e-mails between them is refused whole.
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
select 'c1200000-0000-4000-8000-000000000001',
       case when g <= 6 then 'c1200000-0000-4000-8000-00000000c003'::uuid else 'c1200000-0000-4000-8000-00000000c004'::uuid end,
       'email', 'enc-x' || g, lpad(to_hex(1000 + g), 64, 'e')
  from generate_series(1, 11) g;
set local role service_role;
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c003', 2, 'c1200000-0000-4000-8000-00000000c004', 1,
            'c1200000-0000-4000-8000-0000000000a1')::text $$),
  '23514', 'two records holding more than ten e-mails between them are not merged');
reset role;
delete from public.crm_contact_channels where value_enc like 'enc-x%';

-- ── 4. A merge ────────────────────────────────────────────────────────────────────────────
set local role service_role;
create temp table c12_out (k text primary key, v jsonb);
grant all on c12_out to service_role;
insert into c12_out select 'one', public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-00000000c001', 1, 'c1200000-0000-4000-8000-00000000c002', 1,
  'c1200000-0000-4000-8000-0000000000a1');
reset role;
select is((select (v - 'keep' - 'version')::text from c12_out where k = 'one'),
  '{"leads": 1, "notes": 1, "tasks": 1, "events": 4, "channels": 2, "duplicates": 0}',
  'it answers counts: one lead, its two channels, one note, one task and its timeline lines');
select is((select concat_ws(' ', display_name, coalesce(title, '-'), coalesce(company_name, '-'),
                            array_to_string(tags, ','), custom::text, is_starred, merged_into, merged_at is not null)
             from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c002'),
  'Merged contact - -  {} f c1200000-0000-4000-8000-00000000c001 t',
  'the other record is a scrubbed tombstone pointing at the survivor');
select is((select concat_ws(' ', display_name, title, company_name, array_to_string(tags, ','), is_starred, stage,
                            staff_edited, last_activity_at > now() - interval '1 minute')
             from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c001'),
  'Huda Saleh Director Acme vip,fair t lead t t',
  'the survivor keeps its name and company, fills its title, unites the tags, takes the star; a person made the other, so a person edited this');
select is((select (v ->> 'version')::int from c12_out where k = 'one'),
  (select version from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c001'),
  'and the answer carries its new version');
select is((select string_agg(ch.kind || ':' || ch.value_enc || ':' || ch.is_primary || ':' || ch.source, ','
                             order by ch.kind, ch.value_enc)
             from public.crm_contact_channels ch where ch.contact_id = 'c1200000-0000-4000-8000-00000000c001'),
  'email:enc-e1:true:lead,email:enc-e4:false:lead,phone:enc-p2:true:lead,phone:enc-p3:false:lead',
  'the channels moved as they were (one main of each kind, where each came from kept)');
select is((select concat_ws(' ', n.contact_id, n.body, n.created_at < now() - interval '40 days')
             from public.crm_contact_notes n where n.id = 'c1200000-0000-4000-8000-0000000000b2'),
  'c1200000-0000-4000-8000-00000000c001 Met at the fair t', 'the note moved with its id, words and time');
select is((select concat_ws(' ', (select contact_id from public.crm_tasks where id = 'c1200000-0000-4000-8000-0000000000d7'),
                            (select contact_id || ':' || contact_link from public.leads where id = 'c1200000-0000-4000-8000-00000000aa02'))),
  'c1200000-0000-4000-8000-00000000c001 c1200000-0000-4000-8000-00000000c001:new',
  'the task and the lead follow; the lead keeps how it was linked');
select is((select string_agg(e.kind || ':' || (e.detail ->> 'contact_id') || ':' || coalesce(e.actor_id::text, '-'), ',' order by e.at, e.id)
             from public.lead_events e
            where e.lead_id = 'c1200000-0000-4000-8000-00000000aa02' and e.kind = 'contact_linked'),
  'contact_linked:c1200000-0000-4000-8000-00000000c001:-,contact_linked:c1200000-0000-4000-8000-00000000c001:c1200000-0000-4000-8000-0000000000a1',
  'the lead''s link lines name the survivor; the one drawn now is the actor''s');
select is((select string_agg(e.kind, ',' order by e.kind) from public.crm_contact_events e
            where e.contact_id = 'c1200000-0000-4000-8000-00000000c001' and e.at = now()),
  'details_changed,merged',
  'the survivor''s new lines: the details the merge filled and the merge (no second link line)');
select is((select concat_ws(' ', actor_id, detail::text) from public.crm_contact_events
            where contact_id = 'c1200000-0000-4000-8000-00000000c001' and kind = 'merged'),
  'c1200000-0000-4000-8000-0000000000a1 {"leads": 1, "notes": 1, "tasks": 1, "channels": 2}',
  'the merged line is the actor''s, counts only');
select is((select count(*)::int from public.crm_contact_events
            where contact_id = 'c1200000-0000-4000-8000-00000000c001' and kind = 'created')
          + (select count(*)::int from public.crm_contact_events where contact_id = 'c1200000-0000-4000-8000-00000000c002'),
  1, 'the other record''s own creation line does not move, and the tombstone keeps no line');
select is((select string_agg(e.kind, ',' order by e.kind) from public.crm_contact_events e
            where e.contact_id = 'c1200000-0000-4000-8000-00000000c001' and e.at < now()),
  'channel_added,channel_added,channel_added,channel_added,created,lead_linked,lead_linked,note_added,note_added,task_created',
  'its own history, and the other''s moved: its channels'', its lead''s first link, its task''s and its note''s lines (at the note''s time)');
select is((select concat_ws(' ', actor_id, actor_role, entity_id, detail ->> 'drop', detail ->> 'leads')
             from public.audit_log where action = 'crm.contact.merge'),
  'c1200000-0000-4000-8000-0000000000a1 admin c1200000-0000-4000-8000-00000000c001 c1200000-0000-4000-8000-00000000c002 1',
  'the audit row is there, the actor''s, naming both records');
select is((select string_agg(right(contact_a::text, 4) || '-' || right(contact_b::text, 4), ',' order by contact_a, contact_b)
             from public.crm_merge_dismissals),
  'c001-c003,c001-c004', 'the other record''s dismissal follows the survivor');

-- A second merge: Omar (a client, a tombstone of his own) into Huda, sharing her phone.
set local role service_role;
insert into c12_out select 'two', public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-00000000c001', (select version from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c001'),
  'c1200000-0000-4000-8000-00000000c003', (select version from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c003'),
  'c1200000-0000-4000-8000-0000000000a1');
reset role;
select is((select concat_ws(' ', v ->> 'channels', v ->> 'duplicates') from c12_out where k = 'two'),
  '0 1', 'a phone both held stays once');
select is((select stage from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c001'),
  'client', 'the stage follows precedence (a client wins over a lead)');
select is((select merged_into::text from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c0de'),
  'c1200000-0000-4000-8000-00000000c001', 'a tombstone of the merged record now points at the survivor');
select is((select count(*)::int from public.crm_merge_dismissals),
  1, 'a dismissal between the two merged records goes with the other');

set local role authenticated;
select c12_as('A');
select is(c12_pairs(), '', 'no tombstone is offered');
reset role;

-- ── 7. The review's cases (C12 review) ────────────────────────────────────────────────────
-- (C12-SEC-R2-4) One name at one company six times (the public form makes a contact named as
-- anyone likes): a flood, which the name rule leaves out; five are offered, every pair.
insert into public.crm_contacts (id, tenant_id, display_name, company_name)
select ('c1200000-0000-4000-8000-0000000020' || lpad(g::text, 2, '0'))::uuid,
       'c1200000-0000-4000-8000-000000000001', 'Flood Person', 'Flood Co'
  from generate_series(1, 6) g;
set local role authenticated;
select c12_as('A');
select is(c12_pairs(), '', 'six records of one name at one company are a flood: the name rule offers none');
reset role;
delete from public.crm_contacts where id = 'c1200000-0000-4000-8000-000000002006';
set local role authenticated;
select c12_as('A');
select is(c12_val($$ select jsonb_array_length(public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001'))::text $$),
  '10', 'five are offered, every pair of them, for a person to decide');
reset role;
delete from public.crm_contacts where display_name = 'Flood Person';

-- Two records the system made (no person, nothing to fill between them): c005 holds a lead's
-- phone and ten more from arrivals (eleven: an arrival adds a phone without the ceiling);
-- c006 holds the same phone, typed by a person.
insert into public.crm_contacts (id, tenant_id, display_name, last_activity_at) values
  ('c1200000-0000-4000-8000-00000000c005', 'c1200000-0000-4000-8000-000000000001', 'Reem Hamad', now() - interval '20 days'),
  ('c1200000-0000-4000-8000-00000000c006', 'c1200000-0000-4000-8000-000000000001', 'Reem H', now() - interval '2 days');
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac, is_primary, source, created_by) values
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c005', 'phone', 'enc-p6', repeat('6', 64), true, 'lead', null),
  ('c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c006', 'phone', 'enc-p6m', repeat('6', 64), true, 'manual',
   'c1200000-0000-4000-8000-0000000000a1');
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
select 'c1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-00000000c005', 'phone', 'enc-arr' || g,
       lpad(to_hex(2000 + g), 64, 'f')
  from generate_series(1, 10) g;
insert into public.leads (id, tenant_id, name, email_enc, email_hmac, phone_enc, phone_hmac, message, crm_indexed_at) values
  ('c1200000-0000-4000-8000-00000000aa06', 'c1200000-0000-4000-8000-000000000001', 'Reem', 'enc-e8',
   repeat('8', 64), 'enc-p6', repeat('6', 64), 'call me', now());
update public.leads set contact_id = 'c1200000-0000-4000-8000-00000000c005', contact_link = 'new'
 where id = 'c1200000-0000-4000-8000-00000000aa06';
set local role service_role;
select is(c12_val($$ select public.crm_merge_contacts('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c005', (select version from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c005'),
            'c1200000-0000-4000-8000-00000000c006', (select version from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c006'),
            'c1200000-0000-4000-8000-0000000000a1') ->> 'duplicates' $$),
  '1', 'a survivor already past ten phones takes a record that adds it none (C12-COR-5: only what the other adds counts)');
reset role;
select is((select concat_ws(' ', ch.value_enc, ch.source, ch.created_by, ch.is_primary) from public.crm_contact_channels ch
            where ch.contact_id = 'c1200000-0000-4000-8000-00000000c005' and ch.kind = 'phone' and ch.value_hmac = repeat('6', 64)),
  'enc-p6 manual c1200000-0000-4000-8000-0000000000a1 t',
  'a phone both held stays once, and the copy kept takes the person''s source and maker (C12-COR-1)');
select is((select staff_edited from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c005'), true,
  'two records the system made, nothing filled: the survivor is a person''s edit all the same (C12-COR-4)');
set local role service_role;
select is(c12_val($$ select public.crm_erase_lead('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000aa06', 'c1200000-0000-4000-8000-0000000000a1') ->> 'leads' $$),
  '1', 'the lead that brought the phone is erased');
reset role;
select is((select count(*)::int from public.crm_contact_channels
            where contact_id = 'c1200000-0000-4000-8000-00000000c005' and kind = 'phone' and value_hmac = repeat('6', 64)),
  1, 'and the phone a person typed stays on the survivor');
set local role service_role;
select is(c12_val($$ select public.crm_erase_person('c1200000-0000-4000-8000-000000000001',
            'c1200000-0000-4000-8000-00000000c006', '{}', 'c1200000-0000-4000-8000-0000000000a1')::text $$),
  'P0002', 'erasing the tombstone a merge left is refused: the person is on the survivor (C12-COR-3)');
reset role;
select ok(exists (select 1 from public.crm_contacts
                   where id = 'c1200000-0000-4000-8000-00000000c006'
                     and merged_into = 'c1200000-0000-4000-8000-00000000c005'),
  'and the tombstone stays for the next run');

-- ── 5. The plan, and the bound ────────────────────────────────────────────────────────────
-- Twelve people on one office line: 66 pairs.
insert into public.crm_contacts (id, tenant_id, display_name)
select ('c1200000-0000-4000-8000-0000000010' || lpad(g::text, 2, '0'))::uuid,
       'c1200000-0000-4000-8000-000000000001', 'Office ' || g
  from generate_series(1, 12) g;
insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac)
select 'c1200000-0000-4000-8000-000000000001',
       ('c1200000-0000-4000-8000-0000000010' || lpad(g::text, 2, '0'))::uuid, 'phone', 'enc-office', repeat('7', 64)
  from generate_series(1, 12) g;
set local role authenticated;
select c12_as('A');
select is(c12_val($$ select jsonb_array_length(public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001'))::text $$)
          || ' ' ||
          c12_val($$ select jsonb_array_length(public.crm_duplicate_pairs('c1200000-0000-4000-8000-000000000001', 5))::text $$),
  '50 5', 'at most 50 pairs, or the limit asked for');
reset role;
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'crm_contacts_name_key_idx')
          and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'crm_contact_channels_lookup_idx'),
  'the finder''s two indexes exist');
create function c12_plan(p_sql text) returns text language plpgsql as $f$
declare
  r record;
  v text := '';
begin
  perform set_config('enable_seqscan', 'off', true);
  for r in execute 'explain (costs off) ' || p_sql loop
    v := v || r."QUERY PLAN" || chr(10);
  end loop;
  perform set_config('enable_seqscan', 'on', true);
  return v;
end $f$;
select ok(c12_plan($$ select x.contact_id, y.contact_id from public.crm_contact_channels x
                        join public.crm_contact_channels y
                          on y.tenant_id = x.tenant_id and y.kind = 'phone' and y.value_hmac = x.value_hmac
                         and y.contact_id > x.contact_id
                       where x.tenant_id = 'c1200000-0000-4000-8000-000000000001' and x.kind = 'phone' $$)
          ~ 'crm_contact_channels_lookup_idx',
  'the phone rule reads through the channels'' lookup index');
select ok(c12_plan($$ select c.id, c.name_key from public.crm_contacts c
                       where c.tenant_id = 'c1200000-0000-4000-8000-000000000001' and c.merged_into is null
                         and c.name_key <> '' $$)
          ~ 'crm_contacts_name_key_idx',
  'the name rule reads the tenant''s live named records through the name index');

-- ── 6. Retention: tombstones go on the next run ───────────────────────────────────────────
-- An inquiry and a task that raced onto a tombstone in the instant it was made.
update public.leads set contact_id = 'c1200000-0000-4000-8000-00000000c003', contact_link = 'email'
 where id = 'c1200000-0000-4000-8000-00000000aa05';
-- (The task's own rule refuses a tombstone, so the race is staged with it off.)
alter table public.crm_tasks disable trigger crm_tasks_row;
update public.crm_tasks set contact_id = 'c1200000-0000-4000-8000-00000000c003'
 where id = 'c1200000-0000-4000-8000-0000000000d7';
alter table public.crm_tasks enable trigger crm_tasks_row;
select ok(app.purge_crm() >= 4, 'the run removes contacts');
select is((select count(*)::int from public.crm_contacts
            where tenant_id = 'c1200000-0000-4000-8000-000000000001' and merged_into is not null),
  0, 'every tombstone is gone');
select is((select concat_ws(' ', (select contact_id from public.leads where id = 'c1200000-0000-4000-8000-00000000aa05'),
                            (select contact_id from public.crm_tasks where id = 'c1200000-0000-4000-8000-0000000000d7'))),
  'c1200000-0000-4000-8000-00000000c001 c1200000-0000-4000-8000-00000000c001',
  'what raced onto a tombstone moved to its survivor first');
select ok(exists (select 1 from public.crm_contacts where id = 'c1200000-0000-4000-8000-00000000c001'),
  'the survivor stays');

select * from finish();
rollback;
