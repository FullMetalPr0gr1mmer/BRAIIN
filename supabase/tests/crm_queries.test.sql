-- pgTAP: reading the pipeline (0036, Admin v2 C2a) — leads_list, leads_board,
-- lead_summary, crm_people and the blind-index lookup. Run with `supabase test db`.
--
-- The readers run as the caller (SECURITY INVOKER), so RLS, the live check and the column
-- grants decide what they return: lead workers see their tenant, everyone else sees
-- nothing, and stale tokens see nothing. Every reader, and the two definers
-- (crm_people, app.leads_with_contact), has a row for admin, developer, content_creator,
-- seo, anon, another tenant's admin and the stale tokens (CLAUDE.md §9). The Worker names
-- the tenant too, and naming another one finds nothing. The filter is allow-listed and
-- bounded; search is "contains" over text folded the §8 way (alef, ة/ه); % and _ are
-- characters, not wildcards; a whole address is found by its blind index only, and one
-- sent as text is refused; the list's total survives a page past the end. CLAUDE.md §3,
-- §9 (incl. (e) search safety).

begin;
select plan(72);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'inactive@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null, 'Demoted'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'developer', false, null, 'Gone');

-- Distinct arrival times, oldest first: b1, b2, b3, b4 (T1), b5 (T2). b2's company ends in
-- ة and its message's first word in ه, so the fold is tested both ways.
insert into public.leads (id, tenant_id, name, company, email_enc, message, status, score, email_hmac, created_at) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'Sara', 'Acme', 'x',
   'We need a logo, 50% done', 'new', 25, repeat('a', 64), now() - interval '4 hours'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'أحمد', 'شركة', 'x',
   'هويه بصرية', 'new', 10, null, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000001', 'Omar', null, 'x',
   'cheap watches', 'spam', 0, null, now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000001', 'Lina', 'Studio', 'x',
   'A booth for the expo', 'new', 50, null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000ff', 'Sara', 'Acme', 'x',
   'Other tenant', 'new', 5, repeat('a', 64), now());
-- Lina is answered now, an hour after she wrote: her stage leaves New.
update public.leads set status = 'in_progress' where id = '00000000-0000-0000-0000-0000000000b4';

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

-- Ids the list returns for the token's own tenant, in order, as the CURRENT role.
create function _ids(p jsonb) returns text language sql as $$
  select coalesce(string_agg(right(r.value ->> 'id', 2), ',' order by r.ordinality), '')
    from jsonb_array_elements(public.leads_list(app.effective_tenant_id(), p) -> 'rows')
         with ordinality r
$$;

-- What the board holds for the token's own tenant: its stage rows, and the leads on it.
create function _board_leads(p jsonb) returns text language sql as $$
  select count(*)::int || ' stages/' || coalesce(sum(b.total), 0) || ' leads/'
         || coalesce(sum(jsonb_array_length(b.leads)), 0) || ' cards'
    from public.leads_board(app.effective_tenant_id(), p) b
$$;

-- The leads one blind index finds, as the CURRENT role (the definer itself, not a reader).
create function _contact(p_hmac text) returns text language sql as $$
  select coalesce(string_agg(right(x::text, 2), ',' order by x), '')
    from app.leads_with_contact('email', p_hmac) x
$$;

-- ---- anon -------------------------------------------------------------------------------
set local role anon;
select _as(null, null, null);
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{}') $$,
  '42501', null, 'anon cannot call leads_list');
select throws_ok($$ select * from public.leads_board('00000000-0000-0000-0000-000000000001', '{}') $$,
  '42501', null, 'anon cannot call leads_board');
select throws_ok($$ select public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') $$,
  '42501', null, 'anon cannot call lead_summary');
select throws_ok($$ select * from public.crm_people('00000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call crm_people');
select throws_ok($$ select * from app.leads_with_contact('email', repeat('a', 64)) $$,
  '42501', null, 'anon cannot call the blind-index lookup');

-- ---- content_creator and seo: nothing --------------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'content_creator lists no leads');
select is((select count(*)::int from public.leads_board('00000000-0000-0000-0000-000000000001', '{}')), 0,
  'content_creator gets no board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'content_creator counts nothing');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('a', 64))), '',
  'content_creator finds nothing by blind index');
select is(_contact(repeat('a', 64)), '', 'content_creator gets nothing from the lookup itself');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-000000000001')), 0,
  'crm_people is empty for a content creator');

select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'seo lists no leads');
select is((select count(*)::int from public.leads_board('00000000-0000-0000-0000-000000000001', '{}')), 0,
  'seo gets no board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'seo counts nothing');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-000000000001')), 0,
  'crm_people is empty for seo');
select is(_contact(repeat('a', 64)), '', 'seo gets nothing from the lookup');

-- ---- a live developer: the tenant's leads ----------------------------------------------
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), 'b4,b2,b1', 'developer lists the tenant''s leads, newest first');
select is(_board_leads('{}'), '5 stages/3 leads/3 cards', 'developer gets the board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '3',
  'developer gets the counts');
select is((select string_agg(display_name, ',' order by display_name)
             from public.crm_people('00000000-0000-0000-0000-000000000001')),
  'Amal,Dana', 'developer gets the people a lead can go to');
select is(_contact(repeat('a', 64)), 'b1', 'developer finds a lead by its blind index');

-- ---- stale tokens: a demoted developer (now seo) and a deactivated one ------------------
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'a demoted developer''s old token lists no leads');
select is(_board_leads('{}'), '5 stages/0 leads/0 cards',
  'and its board shows the stages (configuration) but no lead (live check)');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'and counts nothing');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-000000000001')), 0,
  'and lists nobody (crm_people checks the live role)');
select is(_contact(repeat('a', 64)), '', 'and finds nothing by blind index (the definer checks it too)');
select _as('00000000-0000-0000-0000-0000000000d3', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'a deactivated developer''s token lists no leads');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-000000000001')), 0,
  'and lists nobody');
select is(_contact(repeat('a', 64)), '', 'and finds nothing by blind index');

-- ---- another tenant's admin: its own tenant only, and nothing by naming T1 -------------
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_ids('{}'), 'b5', 'another tenant''s admin lists only its own lead');
select is(public.leads_list('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'and naming T1 finds nothing');
select is(_board_leads('{}'), '5 stages/1 leads/1 cards', 'its board holds its own stages and lead');
select is((select count(*)::int from public.leads_board('00000000-0000-0000-0000-000000000001', '{}')), 0,
  'and T1''s board is empty to it');
select is(public.lead_summary('00000000-0000-0000-0000-0000000000ff', '{}') ->> 'total', '1',
  'its counts are its own');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'and T1''s are zero to it');
select is((select string_agg(display_name, ',') from public.crm_people('00000000-0000-0000-0000-0000000000ff'))
          || '/' || (select count(*) from public.crm_people('00000000-0000-0000-0000-000000000001')),
  'Faris/0', 'crm_people: its own people, and none of T1''s');
select is(_contact(repeat('a', 64)), 'b5', 'the same blind index finds only its own tenant''s lead');

-- ---- The list, as a live admin --------------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), 'b4,b2,b1', 'newest first, spam left out');
select is(public.leads_list('00000000-0000-0000-0000-000000000001', '{"limit": 1}') ->> 'total', '3',
  'total counts every match, not the page');
select is(public.leads_list('00000000-0000-0000-0000-000000000001', '{"limit": 1, "offset": 5}')::text,
  '{"rows": [], "total": 3}', 'a page past the end is empty, and still knows the total');
select is(_ids('{"spam": true}'), 'b3', 'the spam view');
select is(_ids('{"q": "ACME"}'), 'b1', 'contains-search, any case');
select is(_ids('{"q": "احمد"}'), 'b2', 'Arabic search folds alef forms (أحمد is found by احمد)');
select is(_ids('{"q": "شركه"}'), 'b2', 'teh marbuta folds: شركة is found by شركه');
select is(_ids('{"q": "هوية"}'), 'b2', 'and the other way: هويه is found by هوية');
select is(_ids('{"q": "%"}'), 'b1', 'a % in the query is a character, not a wildcard');
select is(_ids('{"q": "_"}'), '', 'an _ in the query is a character, not a wildcard');
select is(_ids(jsonb_build_object('stage',
            (select id from public.lead_stages where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'contacted'))),
  'b4', 'filtered to one stage');
select is(_ids('{"sort": "score"}'), 'b4,b1,b2', 'sorted by score');
select is(_ids('{"sort": "oldest"}'), 'b1,b2,b4', 'sorted oldest first');
select is(_ids('{"limit": 1, "offset": 1}'), 'b2', 'a page');
select is(_ids(jsonb_build_object('from', now() - interval '3 hours', 'to', now() - interval '1 hour')), 'b2',
  'a date range takes its start (b2, exactly at it) and stops before its end (b4, exactly at it)');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('a', 64))), 'b1',
  'a whole e-mail is found by its blind index (this tenant''s only)');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('c', 64))), '',
  'an index that matches nothing finds nothing');
select is(_contact(repeat('a', 64)), 'b1', 'the lookup itself finds this tenant''s lead only');

-- ---- The filter is allow-listed and bounded ----------------------------------------------
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"email": "sara@acme.sa"}') $$,
  '22023', null, 'an unknown key is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"q": "sara@acme.sa"}') $$,
  '22023', null, 'an e-mail address sent as text is refused (its blind index is the only way)');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"q": "050 123 4567"}') $$,
  '22023', null, 'and so is a phone number');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"limit": 101}') $$,
  '22023', null, 'a page over 100 is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"sort": "name"}') $$,
  '22023', null, 'an unknown sort is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', jsonb_build_object('q', repeat('x', 65))) $$,
  '22023', null, 'a query over 64 characters is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"stage": "not-a-uuid"}') $$,
  '22023', null, 'a malformed stage is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"contact_kind": "email"}') $$,
  '22023', null, 'a contact kind without its index is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '[]') $$,
  '22023', null, 'a non-object filter is refused');

-- ---- The board and the KPIs -----------------------------------------------------------------
select is((select string_agg(s.key || ':' || b.total || ':' || jsonb_array_length(b.leads), ',' order by s.sort_order)
             from public.leads_board('00000000-0000-0000-0000-000000000001', '{"per_stage": 1}') b
             join public.lead_stages s on s.id = b.stage_id),
  'new:2:1,contacted:1:1,proposal:0:0,won:0:0,lost:0:0',
  'every stage, its count and at most per_stage cards, spam left out');
select throws_ok($$ select * from public.leads_board('00000000-0000-0000-0000-000000000001',
                                                     '{"stage": "00000000-0000-0000-0000-000000000000"}') $$,
  '22023', null, 'the board takes no stage');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}')::text,
  '{"new": 2, "won": 0, "lost": 0, "open": 3, "spam": 1, "total": 3, "avg_first_response_hours": 1.0}',
  'the KPIs (Lina was answered an hour after she wrote)');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001',
            jsonb_build_object('from', now() - interval '3 hours', 'to', now() - interval '1 hour'))::text,
  '{"new": 1, "won": 0, "lost": 0, "open": 1, "spam": 1, "total": 1, "avg_first_response_hours": null}',
  'the KPIs for a date range: its start in, its end out');
select throws_ok($$ select public.lead_summary('00000000-0000-0000-0000-000000000001', '{"q": "acme"}') $$,
  '22023', null, 'the KPIs take a date range only');

-- ---- The people a lead can be assigned to ------------------------------------------------
select is((select string_agg(display_name || '/' || role, ',' order by display_name)
             from public.crm_people('00000000-0000-0000-0000-000000000001')),
  'Amal/admin,Dana/developer', 'crm_people: active lead workers only (not CC, SEO, demoted or inactive)');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-0000000000ff')), 0,
  'crm_people for a tenant that is not the token''s is empty');

-- ---- The catalog ---------------------------------------------------------------------------
reset role;
select ok(
  not exists (select 1 from pg_proc
               where oid in ('public.leads_list(uuid, jsonb)'::regprocedure,
                             'public.leads_board(uuid, jsonb)'::regprocedure,
                             'public.lead_summary(uuid, jsonb)'::regprocedure)
                 and prosecdef),
  'the three readers are SECURITY INVOKER: RLS decides what they return');

select * from finish();
rollback;
