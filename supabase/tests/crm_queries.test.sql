-- pgTAP: reading the pipeline (0036, Admin v2 C2a) — leads_list, leads_board,
-- lead_summary, crm_people and the blind-index lookup. Run with `supabase test db`.
--
-- The readers run as the caller (SECURITY INVOKER), so RLS, the live check and the column
-- grants decide what they return: lead workers see their tenant, everyone else sees
-- nothing, and stale tokens see nothing. The filter is allow-listed and bounded; search is
-- "contains" over normalised text (Arabic folds; % and _ are characters, not wildcards);
-- a whole address is found by its blind index only. CLAUDE.md §3, §9 (incl. (e) search
-- safety).

begin;
select plan(35);

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

-- Distinct arrival times, oldest first: b1, b2, b3, b4 (T1), b5 (T2).
insert into public.leads (id, tenant_id, name, company, email_enc, message, status, score, email_hmac, created_at) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'Sara', 'Acme', 'x',
   'We need a logo, 50% done', 'new', 25, repeat('a', 64), now() - interval '4 hours'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'أحمد', 'شركة', 'x',
   'هوية بصرية', 'new', 10, null, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000001', 'Omar', null, 'x',
   'cheap watches', 'spam', 0, null, now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000001', 'Lina', 'Studio', 'x',
   'A booth for the expo', 'in_progress', 50, null, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000ff', 'Sara', 'Acme', 'x',
   'Other tenant', 'new', 5, repeat('a', 64), now());

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

-- Ids a list returns, in order, as the CURRENT role.
create function _ids(p jsonb) returns text language sql as $$
  select coalesce(string_agg(right(l.id::text, 2), ',' order by l.ordinality), '')
    from public.leads_list(p) with ordinality l
$$;

-- ---- Who sees what ----------------------------------------------------------------------
set local role anon;
select _as(null, null, null);
select throws_ok($$ select * from public.leads_list('{}') $$, '42501', null, 'anon cannot call leads_list');

set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'content_creator lists no leads');
select is((select count(*)::int from public.leads_board('{}')), 0, 'content_creator gets no board');
select is(public.lead_summary('{}') ->> 'total', '0', 'content_creator counts nothing');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('a', 64))), '',
  'content_creator finds nothing by blind index');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'seo lists no leads');
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'a demoted developer''s old token lists no leads');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_ids('{}'), 'b5', 'another tenant''s admin lists only its own lead');

-- ---- The list, as a live admin --------------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), 'b4,b2,b1', 'newest first, spam left out');
select is((select max(total)::int from public.leads_list('{}')), 3, 'total counts every match, not the page');
select is(_ids('{"spam": true}'), 'b3', 'the spam view');
select is(_ids('{"q": "ACME"}'), 'b1', 'contains-search, any case');
select is(_ids('{"q": "احمد"}'), 'b2', 'Arabic search folds alef forms (أحمد is found by احمد)');
select is(_ids('{"q": "%"}'), 'b1', 'a % in the query is a character, not a wildcard');
select is(_ids('{"q": "_"}'), '', 'an _ in the query is a character, not a wildcard');
select is(_ids(jsonb_build_object('stage',
            (select id from public.lead_stages where tenant_id = '00000000-0000-0000-0000-000000000001' and key = 'contacted'))),
  'b4', 'filtered to one stage');
select is(_ids('{"sort": "score"}'), 'b4,b1,b2', 'sorted by score');
select is(_ids('{"limit": 1, "offset": 1}'), 'b2', 'a page');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('a', 64))), 'b1',
  'a whole e-mail is found by its blind index (this tenant''s only)');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('c', 64))), '',
  'an index that matches nothing finds nothing');

-- ---- The filter is allow-listed and bounded ----------------------------------------------
select throws_ok($$ select * from public.leads_list('{"email": "sara@acme.sa"}') $$, '22023', null,
  'an unknown key is refused');
select throws_ok($$ select * from public.leads_list('{"limit": 101}') $$, '22023', null, 'a page over 100 is refused');
select throws_ok($$ select * from public.leads_list('{"sort": "name"}') $$, '22023', null, 'an unknown sort is refused');
select throws_ok($$ select * from public.leads_list(jsonb_build_object('q', repeat('x', 65))) $$, '22023', null,
  'a query over 64 characters is refused');
select throws_ok($$ select * from public.leads_list('{"stage": "not-a-uuid"}') $$, '22023', null,
  'a malformed stage is refused');
select throws_ok($$ select * from public.leads_list('{"contact_kind": "email"}') $$, '22023', null,
  'a contact kind without its index is refused');
select throws_ok($$ select * from public.leads_list('[]') $$, '22023', null, 'a non-object filter is refused');

-- ---- The board and the KPIs -----------------------------------------------------------------
select is((select string_agg(s.key || ':' || b.total || ':' || jsonb_array_length(b.leads), ',' order by s.sort_order)
             from public.leads_board('{"per_stage": 1}') b join public.lead_stages s on s.id = b.stage_id),
  'new:2:1,contacted:1:1,proposal:0:0,won:0:0,lost:0:0',
  'every stage, its count and at most per_stage cards, spam left out');
select throws_ok($$ select * from public.leads_board('{"stage": "00000000-0000-0000-0000-000000000000"}') $$,
  '22023', null, 'the board takes no stage');
select is(public.lead_summary('{}')::text,
  '{"new": 2, "won": 0, "lost": 0, "open": 3, "spam": 1, "total": 3, "avg_first_response_hours": 1.0}',
  'the KPIs (Lina was answered an hour after she wrote: her stage moved at arrival)');
select throws_ok($$ select public.lead_summary('{"q": "acme"}') $$, '22023', null,
  'the KPIs take a date range only');

-- ---- The people a lead can be assigned to ------------------------------------------------
select is((select string_agg(display_name || '/' || role, ',' order by display_name)
             from public.crm_people('00000000-0000-0000-0000-000000000001')),
  'Amal/admin,Dana/developer', 'crm_people: active lead workers only (not CC, SEO, demoted or inactive)');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-0000000000ff')), 0,
  'crm_people for a tenant that is not the token''s is empty');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.crm_people('00000000-0000-0000-0000-000000000001')), 0,
  'crm_people is empty for a content creator');

-- ---- The catalog ---------------------------------------------------------------------------
reset role;
select ok(
  not exists (select 1 from pg_proc
               where oid in ('public.leads_list(jsonb)'::regprocedure, 'public.leads_board(jsonb)'::regprocedure,
                             'public.lead_summary(jsonb)'::regprocedure)
                 and prosecdef),
  'the three readers are SECURITY INVOKER: RLS decides what they return');

select * from finish();
rollback;
