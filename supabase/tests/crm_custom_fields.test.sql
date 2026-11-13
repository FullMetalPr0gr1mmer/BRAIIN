-- pgTAP: custom contact fields (Admin v2 C9b, crm.md §4.7, §5.1, "CRM-9"). Run with
-- `supabase test db`.
--
-- The definitions live in crm_settings.custom_fields (crm.settings: Admin); the values in
-- crm_contacts.custom (crm.contacts: Admin, and Sales since C10b). Personas, each a token as PostgREST
-- carries it, each naming a live profile unless it is a stale one (H16): A admin, C
-- content_creator, S seo, D developer, L sales, O another tenant's admin, N anon; stale Admin
-- tokens Ad (the profile now says content_creator), Ao (switched off), Al (locked). Proven here:
--   1. the definitions' CHECK: at most 12, exactly {key, label, type}, a snake_case key once,
--      a trimmed label of 1 to 60, a type of text, number or date;
--   2. who writes the definitions: a live Admin of the tenant; every other principal and every
--      stale token changes nothing (anon holds no grant); who reads them: lead workers and
--      crm.settings holders;
--   3. a save moves the row's version and stamps; a kept field keeps its type; a label can
--      change;
--   4. values: each new or changed key must be a field of the contact's tenant and fit its
--      type, through the staff column grant and through the create door; JSON null is allowed;
--      an unchanged value is not checked again; the definitions are read FOR SHARE (a removal
--      and a value write cannot pass each other); a key one tenant defines is refused on
--      another tenant's contact; every persona and stale token (C9b review);
--   5. removing a field deletes its values from every contact of the tenant (not another
--      tenant's), moves their version, says so on their timeline, and never marks them edited
--      by a person;
--   6. grants and the functions' pins (P-14).

begin;
select plan(41);

insert into public.tenants (id, name) values
  ('c9b00000-0000-4000-8000-000000000001', 'C9b T1'),
  ('c9b00000-0000-4000-8000-0000000000ff', 'C9b T2');

create table c9b_persona (code text primary key, sub uuid, claim_role text, claim_tenant uuid,
                          profile_role text, active boolean, locked boolean);
insert into c9b_persona values
  ('A',  'c9b00000-0000-4000-8000-0000000000a1', 'admin',           'c9b00000-0000-4000-8000-000000000001', 'admin',           true,  false),
  ('C',  'c9b00000-0000-4000-8000-0000000000c1', 'content_creator', 'c9b00000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('S',  'c9b00000-0000-4000-8000-0000000000e1', 'seo',             'c9b00000-0000-4000-8000-000000000001', 'seo',             true,  false),
  ('D',  'c9b00000-0000-4000-8000-0000000000d1', 'developer',       'c9b00000-0000-4000-8000-000000000001', 'developer',       true,  false),
  ('L',  'c9b00000-0000-4000-8000-000000000051', 'sales',           'c9b00000-0000-4000-8000-000000000001', 'sales',           true,  false),
  ('O',  'c9b00000-0000-4000-8000-0000000000f1', 'admin',           'c9b00000-0000-4000-8000-0000000000ff', 'admin',           true,  false),
  ('Ad', 'c9b00000-0000-4000-8000-0000000000a2', 'admin',           'c9b00000-0000-4000-8000-000000000001', 'content_creator', true,  false),
  ('Ao', 'c9b00000-0000-4000-8000-0000000000a3', 'admin',           'c9b00000-0000-4000-8000-000000000001', 'admin',           false, false),
  ('Al', 'c9b00000-0000-4000-8000-0000000000a4', 'admin',           'c9b00000-0000-4000-8000-000000000001', 'admin',           true,  true);
insert into auth.users (id, email)
  select sub, 'c9b-' || lower(code) || '@example.test' from c9b_persona;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'C9b ' || code
    from c9b_persona;

insert into public.crm_contacts (id, tenant_id, display_name) values
  ('c9b00000-0000-4000-8000-00000000c001', 'c9b00000-0000-4000-8000-000000000001', 'Huda Saleh'),
  ('c9b00000-0000-4000-8000-00000000c002', 'c9b00000-0000-4000-8000-000000000001', 'Omar Faris'),
  ('c9b00000-0000-4000-8000-00000000c0ff', 'c9b00000-0000-4000-8000-0000000000ff', 'Other Person');
-- T2 defines a field of the same key and one of its contacts holds a value: removing T1's field
-- must not touch it.
update public.crm_settings set custom_fields = '[{"key": "renewal", "label": "Renewal", "type": "date"}]'
 where tenant_id = 'c9b00000-0000-4000-8000-0000000000ff';
update public.crm_contacts set custom = '{"renewal": "2027-01-31"}'
 where id = 'c9b00000-0000-4000-8000-00000000c0ff';

create function c9b_as(p_code text) returns void language sql as $$
  select set_config('request.jwt.claims',
    coalesce((select jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p.claim_role, 'tenant_id', p.claim_tenant))::text
                from c9b_persona p where p.code = p_code), ''), true)
$$;
-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function c9b_run(p_sql text) returns text language plpgsql as $$
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
create function c9b_val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;
-- T1's definitions written as the CURRENT role.
create function c9b_define(p_defs text) returns text language sql as $$
  select c9b_run(format(
    'update public.crm_settings set custom_fields = %L::jsonb where tenant_id = %L',
    p_defs, 'c9b00000-0000-4000-8000-000000000001'))
$$;
-- Huda's custom values written as the CURRENT role.
create function c9b_fill(p_custom text) returns text language sql as $$
  select c9b_run(format(
    'update public.crm_contacts set custom = %L::jsonb where id = %L',
    p_custom, 'c9b00000-0000-4000-8000-00000000c001'))
$$;
grant execute on function c9b_as(text), c9b_run(text), c9b_val(text), c9b_define(text),
  c9b_fill(text) to anon, authenticated;
grant select on c9b_persona to anon, authenticated;
create temp table c9b_out (who text, res text);
grant insert, select on c9b_out to authenticated, anon;

-- The set an Admin saves below.
create function c9b_two() returns text language sql as $$
  select '[{"key": "industry_note", "label": "Industry note", "type": "text"},
           {"key": "renewal", "label": "Renewal date", "type": "date"},
           {"key": "seats", "label": "Seats", "type": "number"}]'
$$;
grant execute on function c9b_two() to anon, authenticated;

-- ── 1. What a set of definitions may hold (the CHECK, as the migration role) ─────────────────
select is(c9b_define(c9b_two()), 'ok:1', 'three fields, each key once, are a valid set');
update public.crm_settings set custom_fields = '[]' where tenant_id = 'c9b00000-0000-4000-8000-000000000001';
select is(c9b_define((select jsonb_agg(jsonb_build_object('key', 'f' || i, 'label', 'Field ' || i, 'type', 'text'))::text
                        from generate_series(1, 12) i)),
  'ok:1', 'twelve fields are allowed');
select is(c9b_define((select jsonb_agg(jsonb_build_object('key', 'f' || i, 'label', 'Field ' || i, 'type', 'text'))::text
                        from generate_series(1, 13) i)),
  '23514', 'a thirteenth is refused');
select is(
  (select string_agg(c9b_define(d), ' ' order by n)
     from unnest(array[
       '[{"key": "a", "label": "A", "type": "text"}, {"key": "a", "label": "B", "type": "date"}]',
       '[{"key": "Renewal", "label": "A", "type": "text"}]',
       '[{"key": "1st", "label": "A", "type": "text"}]',
       '[{"key": "a", "label": "A", "type": "select"}]',
       '[{"key": "a", "label": "A", "type": "text", "options": []}]',
       '[{"key": "a", "label": "", "type": "text"}]',
       '[{"key": "a", "label": " A", "type": "text"}]',
       '[{"key": "a", "label": "A", "type": 3}]',
       '{"key": "a"}',
       '[{"key": "a", "label": "Line\nbreak", "type": "text"}]',
       '[{"key": "a", "label": "Next\u0085line", "type": "text"}]',
       '[{"key": "a", "label": "Line\u2029sep", "type": "text"}]']) with ordinality u(d, n)),
  '23514 23514 23514 23514 23514 23514 23514 23514 23514 23514 23514 23514',
  'refused: a key twice, a key not snake_case or not starting with a letter, an unknown type, an unknown key in a field, an empty or untrimmed label, a type that is not text, an object for a set, a control character in a label, a C1 control and a paragraph separator (named, C9B-COR-4)');
update public.crm_settings set custom_fields = '[]' where tenant_id = 'c9b00000-0000-4000-8000-000000000001';

-- ── 2. Who writes and reads the definitions ───────────────────────────────────────────────────
set local role authenticated;
select c9b_as('C');  insert into c9b_out values ('C', c9b_define(c9b_two()));
select c9b_as('S');  insert into c9b_out values ('S', c9b_define(c9b_two()));
select c9b_as('D');  insert into c9b_out values ('D', c9b_define(c9b_two()));
select c9b_as('L');  insert into c9b_out values ('L', c9b_define(c9b_two()));
select c9b_as('O');  insert into c9b_out values ('O', c9b_define(c9b_two()));
select c9b_as('Ad'); insert into c9b_out values ('Ad', c9b_define(c9b_two()));
select c9b_as('Ao'); insert into c9b_out values ('Ao', c9b_define(c9b_two()));
select c9b_as('Al'); insert into c9b_out values ('Al', c9b_define(c9b_two()));
reset role;
set local role anon;
select c9b_as('N');  insert into c9b_out values ('N', c9b_define(c9b_two()));
reset role;
select is((select string_agg(who || '=' || res, ' ' order by who collate "C") from c9b_out),
  'Ad=ok:0 Al=ok:0 Ao=ok:0 C=ok:0 D=ok:0 L=ok:0 N=42501 O=ok:0 S=ok:0',
  'nobody but a live Admin of the tenant changes the definitions: other roles, another tenant''s admin and the stale tokens touch no row, anon holds no grant');
select is((select custom_fields::text from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001'),
  '[]', 'and the definitions are still empty');
create temp table c9b_v as
  select version from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001';
grant select on c9b_v to authenticated;

set local role authenticated;
select c9b_as('A');
select is(c9b_define(c9b_two()), 'ok:1', 'a live Admin saves three fields');
reset role;
select is((select (version = (select version from c9b_v) + 1)::text || ' ' || updated_by
             from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001'),
  'true c9b00000-0000-4000-8000-0000000000a1',
  'the save moves the row''s version and names who saved (the cards share the version)');

truncate c9b_out;
set local role authenticated;
select c9b_as('A');  insert into c9b_out values ('A', c9b_val($$ select jsonb_array_length(custom_fields) from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001' $$));
select c9b_as('D');  insert into c9b_out values ('D', c9b_val($$ select jsonb_array_length(custom_fields) from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001' $$));
select c9b_as('L');  insert into c9b_out values ('L', c9b_val($$ select jsonb_array_length(custom_fields) from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001' $$));
select c9b_as('C');  insert into c9b_out values ('C', c9b_val($$ select jsonb_array_length(custom_fields) from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001' $$));
select c9b_as('S');  insert into c9b_out values ('S', c9b_val($$ select jsonb_array_length(custom_fields) from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001' $$));
select c9b_as('O');  insert into c9b_out values ('O', c9b_val($$ select jsonb_array_length(custom_fields) from public.crm_settings where tenant_id = 'c9b00000-0000-4000-8000-000000000001' $$));
reset role;
select is((select string_agg(who || '=' || res, ' ' order by who collate "C") from c9b_out),
  'A=3 C=(null) D=3 L=3 O=(null) S=(null)',
  'the lead workers (Admin, Developer, Sales) read the definitions; Content Creator, SEO and another tenant''s admin read none');

-- ── 3. A field keeps its type; a label changes freely ───────────────────────────────────────
set local role authenticated;
select c9b_as('A');
select is(c9b_define('[{"key": "industry_note", "label": "Industry note", "type": "text"},
                      {"key": "renewal", "label": "Renewal date", "type": "text"},
                      {"key": "seats", "label": "Seats", "type": "number"}]'),
  '23514', 'a kept field cannot change its type');
select is(c9b_define('[{"key": "industry_note", "label": "Sector notes", "type": "text"},
                      {"key": "renewal", "label": "Renewal date", "type": "date"},
                      {"key": "seats", "label": "Seats", "type": "number"}]'),
  'ok:1', 'its label can change');

-- ── 4. Values fit their fields ─────────────────────────────────────────────────────────────
-- The value trigger reads the definitions FOR SHARE (C9b review, C9B-SEC-1 / C9B-COR-1), so a
-- removal and a value write cannot pass each other. pgTAP runs in one session and one
-- transaction, which already holds the row it updated, so neither the race nor the lock can be
-- seen here (a lock taken by the transaction that wrote the row changes nothing on it); the
-- installed function is checked instead, as tests/lib/crmCustomFields.spec.ts checks the file.
select ok(pg_get_functiondef('app.tg_crm_contact_custom()'::regprocedure)
            ~ 'from public\.crm_settings s where s\.tenant_id = new\.tenant_id\s+for share;',
  'the value trigger reads its tenant''s definitions FOR SHARE');
select is(c9b_fill('{"industry_note": "Retail, three branches", "renewal": "2027-02-28", "seats": 12}'),
  'ok:1', 'a live Admin fills text, a date and a number');
select is(c9b_fill('{"industry_note": "Retail, three branches", "renewal": null, "seats": 12.5}'),
  'ok:1', 'null empties a field; a number may have decimals');
select is(
  (select string_agg(c9b_fill(v), ' ' order by n)
     from unnest(array[
       '{"unknown_key": "x"}',
       '{"renewal": "2027-02-30"}',
       '{"renewal": "28/02/2027"}',
       '{"renewal": 20270228}',
       '{"seats": "12"}',
       '{"seats": 1e16}',
       '{"industry_note": 7}',
       '{"industry_note": "line\nbreak"}',
       '{"industry_note": "next\u0085line"}',
       '{"industry_note": "line separator"}',
       '{"renewal": "0000-01-01"}']) with ordinality u(v, n)),
  '23514 23514 23514 23514 23514 23514 23514 23514 23514 23514 23514',
  'refused: a key no field has, a date that does not exist, another date form, a date as a number, a number as text, a number past 10^15, text as a number, a control character in text, a C1 control and a line separator (named, not the locale''s [[:cntrl:]]: C9B-COR-4), year 0000');
select is(c9b_fill(format('{"industry_note": "%s"}', repeat('a', 501))), '23514',
  'text past 500 characters is refused');
select is(c9b_fill(format('{"industry_note": "%s"}', repeat('ب', 500))), 'ok:1',
  '500 characters of Arabic fit');
select is(c9b_run($$ update public.crm_contacts set city = 'Jeddah'
                      where id = 'c9b00000-0000-4000-8000-00000000c001' $$),
  'ok:1', 'a write that leaves the values alone is not checked again');
reset role;
truncate c9b_out;
set local role authenticated;
select c9b_as('O');  insert into c9b_out values ('O', c9b_fill('{"seats": 3}'));
select c9b_as('C');  insert into c9b_out values ('C', c9b_fill('{"seats": 3}'));
select c9b_as('S');  insert into c9b_out values ('S', c9b_fill('{"seats": 3}'));
select c9b_as('D');  insert into c9b_out values ('D', c9b_fill('{"seats": 3}'));
select c9b_as('Ad'); insert into c9b_out values ('Ad', c9b_fill('{"seats": 3}'));
select c9b_as('Ao'); insert into c9b_out values ('Ao', c9b_fill('{"seats": 3}'));
select c9b_as('Al'); insert into c9b_out values ('Al', c9b_fill('{"seats": 3}'));
reset role;
set local role anon;
select c9b_as('N');  insert into c9b_out values ('N', c9b_fill('{"seats": 3}'));
reset role;
select is((select string_agg(who || '=' || res, ' ' order by who collate "C") from c9b_out),
  'Ad=ok:0 Al=ok:0 Ao=ok:0 C=ok:0 D=ok:0 N=42501 O=ok:0 S=ok:0',
  'nobody but a live contacts user of the tenant fills a value: every other role, another tenant''s admin and every stale token reach no row, anon holds no grant (C9B-SEC-2, C9B-COR-5; Sales holds crm.contacts since C10b, so it left this row and fills a value in crm_last_integration.test.sql)');
select is((select custom::text from public.crm_contacts where id = 'c9b00000-0000-4000-8000-00000000c001'),
  '{"industry_note": "' || repeat('ب', 500) || '"}', 'and Huda''s values are as the Admin left them');

-- A key one tenant defines is refused on another tenant's contact, even as the migration role
-- (C9B-SEC-2). Every other tenant defines both keys, so only the trigger's filter on the
-- contact's tenant refuses them: without it the trigger reads whichever definitions row comes
-- first, and at least one of the two writes would pass.
select set_config('request.jwt.claims', '', true);
update public.crm_settings
   set custom_fields = custom_fields || '[{"key": "c9b_t1_only", "label": "T1 only", "type": "number"}]'
 where tenant_id = 'c9b00000-0000-4000-8000-000000000001';
update public.crm_settings
   set custom_fields = custom_fields || '[{"key": "c9b_t2_only", "label": "T2 only", "type": "number"}]'
 where tenant_id = 'c9b00000-0000-4000-8000-0000000000ff';
update public.crm_settings
   set custom_fields = custom_fields || '[{"key": "c9b_t1_only", "label": "T1 only", "type": "number"},
                                          {"key": "c9b_t2_only", "label": "T2 only", "type": "number"}]'
 where tenant_id not in ('c9b00000-0000-4000-8000-000000000001', 'c9b00000-0000-4000-8000-0000000000ff');
select is(
  c9b_run($$ update public.crm_contacts set custom = custom || '{"c9b_t1_only": 1}'
              where id = 'c9b00000-0000-4000-8000-00000000c0ff' $$)
  || ' ' ||
  c9b_run($$ update public.crm_contacts set custom = custom || '{"c9b_t2_only": 1}'
              where id = 'c9b00000-0000-4000-8000-00000000c001' $$),
  '23514 23514',
  'a key only T1 defines is refused on T2''s contact, and one only T2 defines on T1''s');

-- The create door (the service role, acting for a live Admin) is checked the same way.
set local role service_role;
select is(c9b_val($$ select public.crm_create_contact('c9b00000-0000-4000-8000-000000000001',
             '{"display_name": "Nadia", "custom": {"nope": 1}}'::jsonb,
             'c9b00000-0000-4000-8000-0000000000a1') ->> 'id' $$),
  '23514', 'the create door refuses a value no field has');
select ok(c9b_val($$ select public.crm_create_contact('c9b00000-0000-4000-8000-000000000001',
             '{"display_name": "Nadia", "custom": {"seats": 4, "renewal": "2026-12-01"}}'::jsonb,
             'c9b00000-0000-4000-8000-0000000000a1') ->> 'id' $$) ~ '^[0-9a-f-]{36}$',
  'and adds a contact whose values fit');
reset role;
select is((select custom::text from public.crm_contacts where display_name = 'Nadia'),
  '{"seats": 4, "renewal": "2026-12-01"}', 'with those values');

-- ── 5. Removing a field takes its values ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '', true);
update public.crm_contacts set custom = '{"seats": 2}' where id = 'c9b00000-0000-4000-8000-00000000c002';
create temp table c9b_before as
  select id, version, staff_edited from public.crm_contacts
   where tenant_id = 'c9b00000-0000-4000-8000-000000000001';
set local role authenticated;
select c9b_as('A');
select is(c9b_define('[{"key": "industry_note", "label": "Sector notes", "type": "text"},
                      {"key": "renewal", "label": "Renewal date", "type": "date"}]'),
  'ok:1', 'a live Admin removes the Seats field');
reset role;
select is((select string_agg(display_name || ':' || custom::text, ' | ' order by display_name)
             from public.crm_contacts where tenant_id = 'c9b00000-0000-4000-8000-000000000001'),
  'Huda Saleh:{"industry_note": "' || repeat('ب', 500) || '"} | Nadia:{"renewal": "2026-12-01"} | Omar Faris:{}',
  'every T1 contact loses its Seats value, and keeps the others');
select is((select custom::text from public.crm_contacts where id = 'c9b00000-0000-4000-8000-00000000c0ff'),
  '{"renewal": "2027-01-31"}', 'another tenant''s contact keeps its own');
select is((select string_agg(c.display_name, ',' order by c.display_name) from public.crm_contacts c
             join c9b_before b using (id) where c.version = b.version + 1),
  'Nadia,Omar Faris',
  'the contacts that lost a value moved their version (an open screen cannot save the old set); Huda, who held none, did not');
select is((select count(*)::int from public.crm_contacts c join c9b_before b using (id)
            where c.staff_edited is distinct from b.staff_edited),
  0, 'and none is marked as edited by a person (the orphan rule reads that)');
select is((select string_agg(e.kind || ':' || (e.detail -> 'fields')::text || ':' || e.actor_id, ',')
             from public.crm_contact_events e
            where e.contact_id = 'c9b00000-0000-4000-8000-00000000c002' and e.kind = 'details_changed'),
  'details_changed:["custom"]:c9b00000-0000-4000-8000-0000000000a1',
  'the timeline says the details changed, by the Admin who removed the field, naming no value');
select is((select custom::text from public.crm_contacts where id = 'c9b00000-0000-4000-8000-00000000c001'),
  '{"industry_note": "' || repeat('ب', 500) || '"}', '(Huda keeps the field that stayed)');

-- A field removed and added back under the same key starts empty: no value comes back.
set local role authenticated;
select c9b_as('A');
select is(c9b_define('[{"key": "industry_note", "label": "Sector notes", "type": "text"},
                      {"key": "renewal", "label": "Renewal date", "type": "date"},
                      {"key": "seats", "label": "Seats", "type": "text"}]'),
  'ok:1', 'a key removed can come back, even as another type');
reset role;
select is((select count(*)::int from public.crm_contacts
            where tenant_id = 'c9b00000-0000-4000-8000-000000000001' and custom ? 'seats'),
  0, 'and no contact holds a value under it');

-- ── 6. Grants and pins ────────────────────────────────────────────────────────────────────────
select is(
  (select array_agg(a.attname::text order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.crm_settings'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.crm_settings', a.attname::text, 'update')),
  array['assignment_fixed_to', 'assignment_pool', 'assignment_rule', 'custom_fields', 'scoring', 'sla_hours'],
  'staff UPDATE on crm_settings: the configuration with the definitions, nothing else');
select ok(not has_any_column_privilege('anon', 'public.crm_settings', 'select')
          and not has_any_column_privilege('anon', 'public.crm_settings', 'update'),
  'anon reads and writes nothing on crm_settings');
select ok(has_function_privilege('authenticated', 'app.crm_custom_fields_ok(jsonb)', 'execute')
          and not has_function_privilege('anon', 'app.crm_custom_fields_ok(jsonb)', 'execute'),
  'the CHECK''s helper is run by its writers, never anon');
select is(
  (select count(*)::int from unnest(array['app.crm_custom_date_ok(text)',
                                          'app.tg_crm_settings_custom_fields()',
                                          'app.tg_crm_settings_custom_removed()',
                                          'app.tg_crm_contact_custom()']) f
    where has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('service_role', f, 'execute')
       or has_function_privilege('anon', f, 'execute')),
  0, 'no API role runs the date check or the triggers'' functions');
select is(
  (select count(*)::int from pg_proc
    where oid in ('app.crm_custom_fields_ok(jsonb)'::regprocedure, 'app.crm_custom_date_ok(text)'::regprocedure,
                  'app.tg_crm_settings_custom_fields()'::regprocedure,
                  'app.tg_crm_settings_custom_removed()'::regprocedure,
                  'app.tg_crm_contact_custom()'::regprocedure)
      and proconfig @> array['search_path=""']),
  5, 'every new function pins an empty search_path');
select is(
  (select string_agg(p::text, ',' order by p::text)
     from unnest(array['app.tg_crm_settings_custom_removed()'::regprocedure,
                       'app.tg_crm_contact_custom()'::regprocedure]) p
     join pg_proc f on f.oid = p where f.prosecdef),
  'app.tg_crm_contact_custom(),app.tg_crm_settings_custom_removed()',
  'the two that read or write every row are definers');
select ok(app.crm_custom_date_ok('2028-02-29') and not app.crm_custom_date_ok('2027-02-29')
          and not app.crm_custom_date_ok('2027-2-1') and not app.crm_custom_date_ok(null)
          and not app.crm_custom_date_ok('0000-01-01'),
  'a date is a real calendar day written YYYY-MM-DD (a leap day only in a leap year)');
select ok(exists (select 1 from public.help_articles
                   where tenant_id = 'c9b00000-0000-4000-8000-000000000001' and slug = 'crm-settings'
                     and body::text like '%Custom fields%' and body::text like '%Save fields%'),
  'a new tenant gets the CRM settings guide with the custom fields');

select * from finish();
rollback;
