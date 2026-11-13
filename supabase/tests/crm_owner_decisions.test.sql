-- pgTAP: the owner's decisions of 2026-11-13 on the held CRM branch (Admin v2 C-int, section
-- 10 of docs/admin-v2/as-built/C-LAST-INTEGRATION.md; migration 0141). Run with
-- `supabase test db`.
--
-- Personas: A admin, L sales, C content_creator, S seo and D developer of T1; O an admin of
-- T2 (other_tenant); Ld, Lo and Ll Sales of T1 whose profile was since demoted, switched off
-- or locked (stale); and the anon and authenticated API roles for the doors' EXECUTE. The
-- doors are the service role's: each takes the acting profile and checks it live. Proven:
--   1. the reveal's door answers an Admin every e-mail and phone of a contact and a Sales
--      actor the main e-mail and the main phone only; every other actor is refused (42501),
--      a tombstone or another tenant's contact is P0002, and no API role executes it;
--   2. choosing the main e-mail or phone (naming one, or adding one marked primary) is an
--      Admin's: a Sales actor is refused and nothing changes, a plain add by Sales is kept
--      and stays hidden from its reveal; removing one stays an Admin's (C10B-SEC-2);
--   3. a merge where either record holds a file needs an Admin: Sales is refused before
--      anything moves, whichever side holds the file; a Sales merge of a pair with no file
--      still works; an Admin's merge of a pair with files works, and may leave the survivor
--      past the add door's 20 files (the owner's call: allowed).

begin;
select plan(30);

insert into public.tenants (id, name) values
  ('c1420000-0000-4000-8000-000000000001', 'C-int owner T1'),
  ('c1420000-0000-4000-8000-000000000002', 'C-int owner T2');

create table cod_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid);
insert into cod_persona values
  ('A', 'c1420000-0000-4000-8000-0000000000a1', 'admin', 'c1420000-0000-4000-8000-000000000001'),
  ('L', 'c1420000-0000-4000-8000-000000000051', 'sales', 'c1420000-0000-4000-8000-000000000001'),
  ('C', 'c1420000-0000-4000-8000-0000000000c1', 'content_creator', 'c1420000-0000-4000-8000-000000000001'),
  ('S', 'c1420000-0000-4000-8000-0000000000e1', 'seo', 'c1420000-0000-4000-8000-000000000001'),
  ('D', 'c1420000-0000-4000-8000-0000000000d1', 'developer', 'c1420000-0000-4000-8000-000000000001'),
  ('O', 'c1420000-0000-4000-8000-0000000000f1', 'admin', 'c1420000-0000-4000-8000-000000000002'),
  ('Ld', 'c1420000-0000-4000-8000-000000000052', 'sales', 'c1420000-0000-4000-8000-000000000001'),
  ('Lo', 'c1420000-0000-4000-8000-000000000053', 'sales', 'c1420000-0000-4000-8000-000000000001'),
  ('Ll', 'c1420000-0000-4000-8000-000000000054', 'sales', 'c1420000-0000-4000-8000-000000000001');
insert into auth.users (id, email)
  select sub, 'cod-' || lower(code) || '@example.test' from cod_persona;
insert into public.profiles (id, tenant_id, role, is_active, display_name)
  select sub, claim_tenant, claim_role::app_role, true, 'Owner ' || code from cod_persona;
-- The stale Sales actors: the profile moved on after the token was minted.
update public.profiles set role = 'content_creator' where id = 'c1420000-0000-4000-8000-000000000052';
update public.profiles set is_active = false where id = 'c1420000-0000-4000-8000-000000000053';
update public.profiles set locked_until = now() + interval '10 minutes' where id = 'c1420000-0000-4000-8000-000000000054';

create function cod_actor(p_code text) returns uuid language sql stable as $$
  select sub from cod_persona where code = p_code
$$;
create function cod_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from cod_persona p where p.code = p_code), ''), true)
$$;
-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function cod_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- The reveal's door for one actor and contact: its rows as `kind:primary:value_enc`, in order.
create function cod_reveal(p_code text, p_contact text, p_tenant text default '000000000001')
  returns text language sql as $$
  select cod_val(format($q$ select coalesce(string_agg(r.kind || ':' || r.is_primary || ':' || r.value_enc, ' '), '')
                              from public.crm_contact_reveal_channels(%L, %L, %L) r $q$,
                        ('c1420000-0000-4000-8000-' || p_tenant)::uuid,
                        ('c1420000-0000-4000-8000-' || p_contact)::uuid, cod_actor(p_code)))
$$;
-- The channel editor for one actor, at the contact's current version.
create function cod_edit(p_code text, p_contact text, p_add jsonb, p_remove uuid[], p_primary uuid[])
  returns text language sql as $$
  select cod_val(format($q$ select public.crm_edit_contact_channels(%L, %L,
                              (select c.version from public.crm_contacts c where c.id = %L),
                              %L::jsonb, %L::uuid[], %L::uuid[], %L)::text $q$,
                        'c1420000-0000-4000-8000-000000000001'::uuid,
                        ('c1420000-0000-4000-8000-' || p_contact)::uuid,
                        ('c1420000-0000-4000-8000-' || p_contact)::uuid,
                        p_add, p_remove, p_primary, cod_actor(p_code)))
$$;
-- The merge door for one actor, at both records' current versions.
create function cod_merge(p_code text, p_keep text, p_drop text) returns text language sql as $$
  select cod_val(format($q$ select (public.crm_merge_contacts(%1$L,
                              %2$L, (select c.version from public.crm_contacts c where c.id = %2$L),
                              %3$L, (select c.version from public.crm_contacts c where c.id = %3$L),
                              %4$L) ->> 'keep') is not null $q$,
                        'c1420000-0000-4000-8000-000000000001'::uuid,
                        ('c1420000-0000-4000-8000-' || p_keep)::uuid,
                        ('c1420000-0000-4000-8000-' || p_drop)::uuid, cod_actor(p_code)))
$$;
-- `n` file rows on a contact, as the add door would store them (stored directly: the door's
-- ceiling of 20 is what the Admin merge below is allowed to pass).
create function cod_files(p_contact text, p_n int) returns void language sql as $$
  insert into public.crm_contact_files (tenant_id, contact_id, object_path, name, content_type, bytes)
  select 'c1420000-0000-4000-8000-000000000001', ('c1420000-0000-4000-8000-' || p_contact)::uuid,
         'c1420000-0000-4000-8000-000000000001/c1420000-0000-4000-8000-' || p_contact || '/' || gen_random_uuid() || '.pdf',
         'File ' || g, 'application/pdf', 10
    from generate_series(1, p_n) g
$$;
grant execute on function cod_actor(text), cod_as(text), cod_val(text), cod_reveal(text, text, text),
  cod_edit(text, text, jsonb, uuid[], uuid[]), cod_merge(text, text, text)
  to anon, authenticated, service_role;
grant select on cod_persona to anon, authenticated, service_role;

-- Contacts (T1): aaaa..01 holds two e-mails and two phones, the first of each the main one;
-- bbbb..01 / bbbb..02 a pair where the first holds a file; cccc..01 / cccc..02 a pair with
-- none; dddd..01 / dddd..02 a pair holding 15 and 10 files. T2: ffff..01.
insert into public.crm_contacts (id, tenant_id, display_name, created_by)
  select ('c1420000-0000-4000-8000-' || x.id)::uuid, 'c1420000-0000-4000-8000-000000000001', x.name,
         'c1420000-0000-4000-8000-0000000000a1'
    from (values ('aaaa00000001', 'Person One'), ('bbbb00000001', 'Filed Keep'),
                 ('bbbb00000002', 'Filed Drop'), ('cccc00000001', 'Plain Keep'),
                 ('cccc00000002', 'Plain Drop'), ('dddd00000001', 'Many Keep'),
                 ('dddd00000002', 'Many Drop')) x (id, name);
insert into public.crm_contacts (id, tenant_id, display_name, created_by) values
  ('c1420000-0000-4000-8000-ffff00000001', 'c1420000-0000-4000-8000-000000000002', 'Other Tenant',
   'c1420000-0000-4000-8000-0000000000f1');
insert into public.crm_contact_channels (id, tenant_id, contact_id, kind, value_enc, value_hmac, is_primary, source) values
  ('c1420000-0000-4000-8000-0000000c0001', 'c1420000-0000-4000-8000-000000000001', 'c1420000-0000-4000-8000-aaaa00000001', 'email', 'e-main', repeat('1', 64), true, 'lead'),
  ('c1420000-0000-4000-8000-0000000c0002', 'c1420000-0000-4000-8000-000000000001', 'c1420000-0000-4000-8000-aaaa00000001', 'email', 'e-other', repeat('2', 64), false, 'manual'),
  ('c1420000-0000-4000-8000-0000000c0003', 'c1420000-0000-4000-8000-000000000001', 'c1420000-0000-4000-8000-aaaa00000001', 'phone', 'p-main', repeat('3', 64), true, 'lead'),
  ('c1420000-0000-4000-8000-0000000c0004', 'c1420000-0000-4000-8000-000000000001', 'c1420000-0000-4000-8000-aaaa00000001', 'phone', 'p-other', repeat('4', 64), false, 'lead'),
  ('c1420000-0000-4000-8000-0000000c0005', 'c1420000-0000-4000-8000-000000000002', 'c1420000-0000-4000-8000-ffff00000001', 'email', 'o-main', repeat('5', 64), true, 'lead');
select cod_files('bbbb00000001', 1);
select cod_files('dddd00000001', 15);
select cod_files('dddd00000002', 10);

-- ── 1. The reveal's door ────────────────────────────────────────────────────────────────────
set local role service_role;
select is(cod_reveal('A', 'aaaa00000001'),
  'email:true:e-main email:false:e-other phone:true:p-main phone:false:p-other',
  'an Admin''s reveal reads every e-mail and phone, the main one first');
select is(cod_reveal('L', 'aaaa00000001'), 'email:true:e-main phone:true:p-main',
  'a Sales reveal reads the main e-mail and the main phone only');
select is(cod_reveal('C', 'aaaa00000001') || ' ' || cod_reveal('S', 'aaaa00000001') || ' '
          || cod_reveal('D', 'aaaa00000001'),
  '42501 42501 42501', 'Content Creator, SEO and Developer actors are refused');
select is(cod_reveal('Ld', 'aaaa00000001') || ' ' || cod_reveal('Lo', 'aaaa00000001') || ' '
          || cod_reveal('Ll', 'aaaa00000001'),
  '42501 42501 42501', 'a demoted, switched-off or locked Sales actor is refused');
select is(cod_reveal('O', 'aaaa00000001') || ' ' || cod_reveal('O', 'aaaa00000001', '000000000002'),
  '42501 P0002', 'another tenant''s Admin is refused for T1, and finds no T1 contact under its own');
select is(cod_reveal('A', 'ffff00000001') || ' '
          || cod_val($$ select count(*)::text from public.crm_contact_reveal_channels(null, null, null) $$),
  'P0002 22023', 'another tenant''s contact is not found; a call without its arguments is 22023');
reset role;
set local role anon;
select is(cod_reveal('A', 'aaaa00000001'), '42501', 'anon cannot execute the reveal''s door');
reset role;
set local role authenticated;
select cod_as('A');
select is(cod_reveal('A', 'aaaa00000001'), '42501',
  'nor can an Admin token (authenticated): only the Worker, as the service role, reads ciphertext');
select set_config('request.jwt.claims', '', true);
reset role;

-- ── 2. The main e-mail or phone is an Admin's choice; removing one stays an Admin's ──────────
set local role service_role;
select is(cod_edit('L', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]),
  '42501', 'Sales cannot make another e-mail the main one');
select is(cod_edit('L', 'aaaa00000001',
                   jsonb_build_array(jsonb_build_object('kind', 'email', 'value_enc', 'e-sales-main',
                                     'value_hmac', repeat('6', 64), 'is_primary', true)), '{}', '{}'),
  '42501', 'nor add one marked as the main one');
select is((select string_agg(ch.value_enc, ' ' order by ch.value_enc) from public.crm_contact_channels ch
            where ch.contact_id = 'c1420000-0000-4000-8000-aaaa00000001'
              and (ch.is_primary or ch.value_enc like 'e-sales%')),
  'e-main p-main', 'and nothing changed: the main ones stay, nothing was added');
select is(cod_edit('L', 'aaaa00000001',
                   jsonb_build_array(jsonb_build_object('kind', 'email', 'value_enc', 'e-sales',
                                     'value_hmac', repeat('7', 64), 'is_primary', false)), '{}', '{}'),
  '{"added": 1, "removed": 0}', 'Sales still adds an e-mail');
select is(cod_reveal('L', 'aaaa00000001'), 'email:true:e-main phone:true:p-main',
  'which is kept and stays out of its reveal (not the main one)');
select is(cod_edit('L', 'aaaa00000001', '[]', array['c1420000-0000-4000-8000-0000000c0002'::uuid], '{}'),
  '42501', 'Sales cannot remove an e-mail (C10B-SEC-2, confirmed)');
select is(cod_edit('C', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]) || ' '
          || cod_edit('S', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]) || ' '
          || cod_edit('D', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]) || ' '
          || cod_edit('O', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]),
  '42501 42501 42501 42501', 'nor can Content Creator, SEO, Developer or another tenant''s Admin choose one');
select is(cod_edit('Ld', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]) || ' '
          || cod_edit('Lo', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]) || ' '
          || cod_edit('Ll', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]),
  '42501 42501 42501', 'nor a stale Sales actor');
select is(cod_edit('A', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0002'::uuid]),
  '{"added": 0, "removed": 0}', 'an Admin makes another e-mail the main one');
select is(cod_reveal('L', 'aaaa00000001'), 'email:true:e-other phone:true:p-main',
  'and the next Sales reveal shows that one');
select is(cod_edit('A', 'aaaa00000001', '[]', array['c1420000-0000-4000-8000-0000000c0004'::uuid], '{}'),
  '{"added": 0, "removed": 1}', 'an Admin removes a phone');
reset role;
set local role authenticated;
select cod_as('L');
select is(cod_edit('L', 'aaaa00000001', '[]', '{}', array['c1420000-0000-4000-8000-0000000c0001'::uuid]),
  '42501', 'a Sales token cannot reach the editor at all (the service role''s door)');
select set_config('request.jwt.claims', '', true);
reset role;

-- ── 3. A merge where either record holds a file needs an Admin ─────────────────────────────
set local role service_role;
select is(cod_merge('L', 'cccc00000001', 'bbbb00000001') || ' ' || cod_merge('L', 'bbbb00000001', 'bbbb00000002'),
  '42501 42501', 'Sales cannot merge a pair when the record going away or the one kept holds a file');
select is((select count(*)::text from public.crm_contacts c
            where c.id in ('c1420000-0000-4000-8000-bbbb00000001', 'c1420000-0000-4000-8000-bbbb00000002',
                           'c1420000-0000-4000-8000-cccc00000001')
              and c.merged_into is null and c.version = 1)
          || ' ' || (select count(*)::text from public.crm_contact_files f
                      where f.contact_id = 'c1420000-0000-4000-8000-bbbb00000001')
          || ' ' || (select count(*)::text from public.audit_log a
                      where a.tenant_id = 'c1420000-0000-4000-8000-000000000001'
                        and a.action like 'crm.contact.merge%'),
  '3 1 0', 'and nothing moved: no tombstone, no version moved, the file where it was, no audit row');
select is(cod_merge('C', 'bbbb00000001', 'bbbb00000002') || ' ' || cod_merge('S', 'bbbb00000001', 'bbbb00000002')
          || ' ' || cod_merge('D', 'bbbb00000001', 'bbbb00000002') || ' ' || cod_merge('O', 'bbbb00000001', 'bbbb00000002'),
  '42501 42501 42501 42501', 'Content Creator, SEO, Developer and another tenant''s Admin are refused too');
select is(cod_merge('Ld', 'bbbb00000001', 'bbbb00000002') || ' ' || cod_merge('Lo', 'bbbb00000001', 'bbbb00000002')
          || ' ' || cod_merge('Ll', 'bbbb00000001', 'bbbb00000002'),
  '42501 42501 42501', 'and a stale Sales actor');
select is(cod_merge('L', 'cccc00000001', 'cccc00000002'), 'true',
  'Sales still merges a pair where neither record holds a file');
select is(cod_merge('A', 'bbbb00000002', 'bbbb00000001'), 'true',
  'an Admin merges a pair where one holds a file');
select is((select count(*)::text from public.crm_contact_files f
            where f.contact_id = 'c1420000-0000-4000-8000-bbbb00000002'),
  '1', 'and the file follows the record kept');
select is(cod_merge('A', 'dddd00000001', 'dddd00000002'), 'true',
  'an Admin merge that leaves the record kept past 20 files is allowed (the owner''s call)');
select is((select count(*)::text from public.crm_contact_files f
            where f.contact_id = 'c1420000-0000-4000-8000-dddd00000001')
          || ' ' || cod_reveal('A', 'dddd00000002'),
  '25 P0002', 'it holds all 25, and the record merged away is a tombstone the reveal does not find');
reset role;
set local role authenticated;
select cod_as('L');
select is(cod_merge('L', 'cccc00000001', 'dddd00000001'), '42501',
  'a Sales token cannot reach the merge door at all (the service role''s)');
select set_config('request.jwt.claims', '', true);
reset role;

select * from finish();
rollback;
