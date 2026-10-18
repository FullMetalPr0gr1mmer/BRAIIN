-- pgTAP: the leads readers v2 (0063, Admin v2 C4a) — app.lead_filter v2, app.leads_matching,
-- app.lead_over_sla, leads_list, leads_board and lead_summary restated, lead_neighbours new.
-- Run with `supabase test db`.
--
-- Every reader runs as the caller (SECURITY INVOKER), so RLS, the RESTRICTIVE live check and
-- the column grants decide what it returns: lead workers see their tenant, everyone else
-- nothing, stale tokens (demoted, deactivated, locked) nothing. Each reader has a row for
-- admin, developer, content_creator, seo, anon, another tenant's admin and the stale tokens
-- (CLAUDE.md §9). The new filters (assignee with 'me' read in SQL, star, unread, source,
-- channel, discipline, the starred-first sort), the SLA flag against crm_settings.sla_hours,
-- the board's value sums, the summary's new figures, and Previous/Next in the list's own
-- order (decision D14: the two share one ordering, compared here lead by lead). 0036's
-- answers on 0036's keys are held by crm_queries.test.sql, on its own fixture.

begin;
select plan(101);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin2@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'inactive@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'locked@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'admin', true, null, 'Badr'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null, 'Demoted'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'developer', false, null, 'Gone'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-000000000001', 'developer', true, now() + interval '1 hour', 'Locked');

-- A one-hour response time for T1 (the tenant trigger seeded the row with 24).
update public.crm_settings set sla_hours = 1 where tenant_id = '00000000-0000-0000-0000-000000000001';

-- Two disciplines, a service in each (drafts: staff read every status).
insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('00000000-0000-0000-0000-0000000000e7', '00000000-0000-0000-0000-000000000001', 'pgc4-brand',
   '{"en":"Branding","ar":"الهوية"}', 'draft'),
  ('00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-000000000001', 'pgc4-prod',
   '{"en":"Production","ar":"الإنتاج"}', 'draft');
insert into public.services (tenant_id, slug, title, status, discipline_id) values
  ('00000000-0000-0000-0000-000000000001', 'pgc4-logo', '{"en":"Logo","ar":"شعار"}', 'draft',
   '00000000-0000-0000-0000-0000000000e7'),
  ('00000000-0000-0000-0000-000000000001', 'pgc4-motion', '{"en":"Motion","ar":"حركة"}', 'draft',
   '00000000-0000-0000-0000-0000000000e8');

create function _stage(p_tid text, p_key text) returns uuid language sql as $$
  select id from public.lead_stages where tenant_id = p_tid::uuid and key = p_key
$$;

-- T1's leads, oldest first (b1 … b6, and two spam: b5, b8), and one of T2's (b7):
--   b1  50 h  web form, New, never answered, Branding's logo, unread          over the SLA
--   b2  40 h  added by hand (phone), New, answered on arrival, "help me choose" Branding,
--             read, starred, Amal's
--   b3  30 h  web form, Contacted (answered after 2 h), Production's motion, read, Dana's,
--             20,000 SAR
--   b4  20 h  web form, Won (answered after 4 h), Branding's logo, read, starred, Amal's,
--             50,000 SAR
--   b5  10 h  spam, in Won, 70,000 SAR, starred, unread: in no count but spam
--   b8   5 h  spam
--   b6   3 h  web form, New, never answered, unread                          over the SLA
--   b7  T2's, now
insert into public.leads (id, tenant_id, name, company, email_enc, message, created_at, source,
                          channel, stage_id, is_spam, first_response_at, read_at, is_starred,
                          assigned_to, value_sar, service_of_interest, discipline_of_interest,
                          email_hmac) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'Sara', 'Acme', 'x',
   'A logo', now() - interval '50 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), false, null, null, false, null, null,
   'pgc4-logo', null, repeat('a', 64)),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'Omar', null, 'x',
   'Called about a brand', now() - interval '40 hours', 'manual', 'phone',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), false, now() - interval '40 hours',
   now() - interval '39 hours', true, '00000000-0000-0000-0000-0000000000a1', null, null,
   'pgc4-brand', null),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000001', 'Lina', 'Studio', 'x',
   'A motion piece', now() - interval '30 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'contacted'), false, now() - interval '28 hours',
   now() - interval '29 hours', false, '00000000-0000-0000-0000-0000000000d1', 20000,
   'pgc4-motion', null, null),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000001', 'Huda', 'Brandco', 'x',
   'A whole identity', now() - interval '20 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'won'), false, now() - interval '16 hours',
   now() - interval '19 hours', true, '00000000-0000-0000-0000-0000000000a1', 50000,
   'pgc4-logo', null, null),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-000000000001', 'Spam', null, 'x',
   'cheap watches', now() - interval '10 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'won'), true, null, null, true, null, 70000,
   null, null, null),
  ('00000000-0000-0000-0000-0000000000b8', '00000000-0000-0000-0000-000000000001', 'Spam 2', null, 'x',
   'cheap shoes', now() - interval '5 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), true, null, null, false, null, null,
   null, null, null),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-000000000001', 'Nour', null, 'x',
   'A booth', now() - interval '3 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), false, null, null, false, null, null,
   null, null, null),
  ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000ff', 'Sara', 'Acme', 'x',
   'Other tenant', now(), 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-0000000000ff', 'new'), false, null, null, false, null, null,
   null, null, repeat('a', 64));

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

-- Ids the list returns for T1, in order, as the CURRENT role.
create function _ids(p jsonb) returns text language sql as $$
  select coalesce(string_agg(right(r.value ->> 'id', 2), ',' order by r.ordinality), '')
    from jsonb_array_elements(public.leads_list('00000000-0000-0000-0000-000000000001', p) -> 'rows')
         with ordinality r
$$;

-- The board for T1, as the CURRENT role: stage:count:value per stage.
create function _board(p jsonb) returns text language sql as $$
  select coalesce(string_agg(s.key || ':' || b.total || ':' || b.value_sum, ',' order by s.sort_order), '')
    from public.leads_board('00000000-0000-0000-0000-000000000001', p) b
    join public.lead_stages s on s.id = b.stage_id
$$;

-- A lead's neighbours in T1, as the CURRENT role: prev/next, by their last two characters.
create function _nb(p_id text, p jsonb default '{}') returns text language sql as $$
  select coalesce(right(n ->> 'prev', 2), '-') || '/' || coalesce(right(n ->> 'next', 2), '-')
    from (select public.lead_neighbours('00000000-0000-0000-0000-000000000001',
                                        ('00000000-0000-0000-0000-0000000000' || p_id)::uuid, p) n) x
$$;

-- The list for T1 under a filter, as the CURRENT role: each lead's id and its position.
create function _list_of(p jsonb) returns table (id text, n bigint) language sql as $$
  select r.value ->> 'id', r.ordinality
    from jsonb_array_elements(public.leads_list('00000000-0000-0000-0000-000000000001',
                                                p || '{"limit": 100}') -> 'rows') with ordinality r
$$;

-- What a stale or locked-out token gets from all four readers, in one line.
create function _stale() returns text language sql as $$
  select (public.leads_list('00000000-0000-0000-0000-000000000001', '{}') ->> 'total')
         || '/' || (select coalesce(sum(b.total), 0) || '+' || coalesce(sum(jsonb_array_length(b.leads)), 0)
                      from public.leads_board('00000000-0000-0000-0000-000000000001', '{}') b)
         || '/' || (public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total')
         || '/' || (select coalesce(sum(v::int), 0)
                      from jsonb_each_text(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}')
                                           -> 'per_stage') e(k, v))
         || '/' || _nb('b3')
$$;

-- The summary keys 0063 added.
create function _new_keys() returns text[] language sql as $$
  select array['in_progress', 'won_value', 'unread', 'starred', 'per_stage', 'sla_breached',
               'web_response_hours', 'web_response_n']
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
select throws_ok($$ select public.lead_neighbours('00000000-0000-0000-0000-000000000001',
                                                  '00000000-0000-0000-0000-0000000000b1', '{}') $$,
  '42501', null, 'anon cannot call lead_neighbours');
select throws_ok($$ select * from app.leads_matching('00000000-0000-0000-0000-000000000001', '{}') $$,
  '42501', null, 'anon cannot call app.leads_matching');

-- ---- content_creator and seo: nothing ---------------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'content_creator lists no leads');
select is(_board('{}'), '', 'content_creator gets no board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'content_creator counts nothing');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') -> 'per_stage', '{}'::jsonb,
  'and sees no stage');
select is(_nb('b3'), '-/-', 'content_creator gets no neighbours');

select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), '', 'seo lists no leads');
select is(_board('{}'), '', 'seo gets no board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'seo counts nothing');
select is(_nb('b3'), '-/-', 'seo gets no neighbours');

-- ---- stale tokens: demoted, deactivated, locked -----------------------------------------
-- total / board leads+cards / summary total / per-stage sum / neighbours
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_stale(), '0/0+0/0/0/-/-', 'a demoted developer''s old token reads nothing from any reader');
select _as('00000000-0000-0000-0000-0000000000d3', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_stale(), '0/0+0/0/0/-/-', 'a deactivated developer''s token reads nothing');
select _as('00000000-0000-0000-0000-0000000000d4', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_stale(), '0/0+0/0/0/-/-', 'a locked developer''s token reads nothing');

-- ---- another tenant's admin -------------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(public.leads_list('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'another tenant''s admin naming T1 lists nothing');
select is((select count(*)::int from public.leads_board('00000000-0000-0000-0000-000000000001', '{}')), 0,
  'and gets no T1 board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '0',
  'and counts nothing of T1''s');
select is(_nb('b3'), '-/-', 'and gets no T1 neighbours');
select is((select string_agg(right(r ->> 'id', 2), ',')
             from jsonb_array_elements(public.leads_list('00000000-0000-0000-0000-0000000000ff', '{}') -> 'rows') r),
  'b7', 'naming its own tenant, it lists only its own lead');
select is(public.lead_neighbours('00000000-0000-0000-0000-0000000000ff',
                                 '00000000-0000-0000-0000-0000000000b7', '{}'),
  '{"prev": null, "next": null}'::jsonb, 'its only lead has no neighbours');

-- ---- a live developer: the tenant's leads -----------------------------------------------
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), 'b6,b4,b3,b2,b1', 'developer lists the tenant''s leads, newest first');
select is(_board('{}'), 'new:3:0,contacted:1:20000,proposal:0:0,won:1:50000,lost:0:0',
  'developer gets the board');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') ->> 'total', '5',
  'developer gets the counts');
select is(_nb('b3'), 'b4/b2', 'developer gets the neighbours');
select is(_ids('{"assigned": "me"}'), 'b3', '"me" is the developer''s own leads');

-- ---- The list, as a live admin ----------------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_ids('{}'), 'b6,b4,b3,b2,b1', 'newest first, spam left out');
select is((select string_agg(k, ',' order by k collate "C")
             from jsonb_object_keys(public.leads_list('00000000-0000-0000-0000-000000000001', '{"limit": 1}')
                                    -> 'rows' -> 0) k),
  'assigned_to,channel,company,created_at,discipline_of_interest,first_response_at,id,is_spam,is_starred,'
  || 'last_contact_at,last_contact_channel,lead_number,message_preview,name,over_sla,read_at,score,'
  || 'service_of_interest,source,stage_id,value_sar,version,won_at',
  'a row carries the safe and pipeline fields only: no tags, score reason, index or ciphertext');
select is((select string_agg(right(r ->> 'id', 2) || ':' || (r ->> 'over_sla'), ',' order by o)
             from jsonb_array_elements(public.leads_list('00000000-0000-0000-0000-000000000001', '{}') -> 'rows')
                  with ordinality x(r, o)),
  'b6:true,b4:false,b3:false,b2:false,b1:true',
  'over_sla: web-form leads in New, unanswered, older than the tenant''s hour (b6 at 3 h proves the setting is read); not by hand, not past New');
select is((select r ->> 'over_sla'
             from jsonb_array_elements(public.leads_list('00000000-0000-0000-0000-000000000001', '{"spam": true}') -> 'rows') r
            where r ->> 'id' like '%b8'),
  'false', 'a spam lead is never over the response time');
select is((select (r ->> 'value_sar') || '/' || (r ->> 'is_starred') || '/' || right(r ->> 'assigned_to', 2)
                  || '/' || ((r ->> 'read_at') is not null)
             from jsonb_array_elements(public.leads_list('00000000-0000-0000-0000-000000000001', '{}') -> 'rows') r
            where r ->> 'id' like '%b4'),
  '50000/true/a1/true', 'a row carries its value, star, assignee and read mark');

-- assigned
select is(_ids('{"assigned": "me"}'), 'b4,b2', '"me" is the caller''s own leads');
select is(_ids('{"assigned": "none"}'), 'b6,b1', '"none" is the leads nobody has');
select is(_ids('{"assigned": "00000000-0000-0000-0000-0000000000d1"}'), 'b3',
  'a person''s uuid filters on that person, never on the caller');
select _as('00000000-0000-0000-0000-0000000000a2', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_ids('{"assigned": "me"}'), '', '"me" for a caller with no leads is empty');
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');

-- star, read, source, channel, discipline
select is(_ids('{"starred": true}'), 'b4,b2', 'starred');
select is(_ids('{"starred": false}'), 'b6,b3,b1', 'not starred');
select is(_ids('{"unread": true}'), 'b6,b1', 'unread: nobody has looked');
select is(_ids('{"unread": false}'), 'b4,b3,b2', 'read');
select is(_ids('{"source": "manual"}'), 'b2', 'added by hand');
select is(_ids('{"source": "web_form"}'), 'b6,b4,b3,b1', 'from the web form');
select is(_ids('{"channel": "phone"}'), 'b2', 'by channel');
select is(_ids('{"discipline": "pgc4-brand"}'), 'b4,b2,b1',
  'a discipline: its services'' leads and its "help me choose" lead');
select is(_ids('{"discipline": "pgc4-prod"}'), 'b3', 'and not another discipline''s service');
select is(_ids('{"discipline": "pgc4-none"}'), '', 'a discipline nobody asked about finds nothing');
select is(_ids('{"assigned": "me", "starred": true, "discipline": "pgc4-brand"}'), 'b4,b2',
  'the filters combine');

-- sort
select is(_ids('{"sort": "newest"}'), 'b6,b4,b3,b2,b1', 'newest is unchanged: a starred older lead is not first');
select is(_ids('{"sort": "starred"}'), 'b4,b2,b6,b3,b1', 'starred first, then newest');
select is(_ids('{"sort": "oldest"}'), 'b1,b2,b3,b4,b6', 'oldest first');

-- 0036's keys still work
select is(_ids('{"spam": true}'), 'b8,b5', 'the spam view');
select is(_ids(jsonb_build_object('stage', _stage('00000000-0000-0000-0000-000000000001', 'contacted'))),
  'b3', 'one stage');
select is(_ids(jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('a', 64), 'spam', false)),
  'b1', 'the manual-add lookup: a blind index, with the spam flag');
select is(_ids('{"q": "brandco"}'), 'b4', 'contains-search');
select is(public.leads_list('00000000-0000-0000-0000-000000000001', '{"limit": 2, "offset": 1}') ->> 'total',
  '5', 'the total counts every match, not the page');
select is(_ids('{"limit": 2, "offset": 1}'), 'b4,b3', 'a page');

-- ---- The filter is allow-listed and bounded ----------------------------------------------
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"assignee": "me"}') $$,
  '22023', null, 'an unknown key is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"assigned": "x"}') $$,
  '22023', null, 'assigned is me, none or a uuid');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"assigned": "ME"}') $$,
  '22023', null, 'and exactly those words');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"source": "web"}') $$,
  '22023', null, 'an unknown source is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"channel": "fax"}') $$,
  '22023', null, 'an unknown channel is refused');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"discipline": "Bad Slug"}') $$,
  '22023', null, 'a discipline is a slug');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001',
                                             jsonb_build_object('discipline', repeat('a', 65))) $$,
  '22023', null, 'of at most 64 characters');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"starred": "maybe"}') $$,
  '22023', null, 'starred is a boolean');
select throws_ok($$ select public.leads_list('00000000-0000-0000-0000-000000000001', '{"sort": "name"}') $$,
  '22023', null, 'an unknown sort is refused');

-- ---- The board --------------------------------------------------------------------------------
select is(_board('{}'), 'new:3:0,contacted:1:20000,proposal:0:0,won:1:50000,lost:0:0',
  'every stage with its count and its value; spam (b5, 70,000 in Won) left out');
select is(_board('{"assigned": "none"}'), 'new:2:0,contacted:0:0,proposal:0:0,won:0:0,lost:0:0',
  'the board by assignee');
select is(_board('{"source": "manual", "channel": "phone"}'), 'new:1:0,contacted:0:0,proposal:0:0,won:0:0,lost:0:0',
  'by source and channel');
select is(_board('{"discipline": "pgc4-brand"}'), 'new:2:0,contacted:0:0,proposal:0:0,won:1:50000,lost:0:0',
  'by discipline');
select is((select string_agg(k, ',' order by k collate "C")
             from public.leads_board('00000000-0000-0000-0000-000000000001', '{}') b
             cross join lateral jsonb_object_keys(b.leads -> 0) k
            where b.stage_id = _stage('00000000-0000-0000-0000-000000000001', 'won')),
  'assigned_to,company,created_at,discipline_of_interest,id,is_starred,lead_number,name,read_at,'
  || 'score,service_of_interest,stage_id,value_sar,version',
  'a card carries the safe and pipeline fields only');
select is((select string_agg(right(c ->> 'id', 2), ',' order by o)
             from public.leads_board('00000000-0000-0000-0000-000000000001', '{"per_stage": 2}') b
             cross join lateral jsonb_array_elements(b.leads) with ordinality x(c, o)
            where b.stage_id = _stage('00000000-0000-0000-0000-000000000001', 'new')),
  'b6,b2', 'a column''s newest cards, at most per_stage');
select throws_ok($$ select * from public.leads_board('00000000-0000-0000-0000-000000000001', '{"spam": true}') $$,
  '22023', null, 'the board takes no spam flag');
select throws_ok($$ select * from public.leads_board('00000000-0000-0000-0000-000000000001', '{"limit": 5}') $$,
  '22023', null, 'nor a page');
select throws_ok($$ select * from public.leads_board('00000000-0000-0000-0000-000000000001', '{"sort": "oldest"}') $$,
  '22023', null, 'nor a sort');

-- ---- The summary -----------------------------------------------------------------------------
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') - _new_keys(),
  '{"new": 3, "won": 1, "lost": 0, "open": 4, "spam": 2, "total": 5, "avg_first_response_hours": 2.0}'::jsonb,
  '0036''s keys: their meaning unchanged (b2 answered on arrival, b3 after 2 h, b4 after 4 h)');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001', '{}') - 'per_stage'
          - array['new', 'won', 'lost', 'open', 'spam', 'total', 'avg_first_response_hours'],
  '{"in_progress": 1, "won_value": 50000, "unread": 2, "starred": 2, "sla_breached": 2,
    "web_response_hours": 3.0, "web_response_n": 2}'::jsonb,
  'the new figures: in progress, won value, unread, starred, SLA breaches, the web form''s first response');
select is((select string_agg(s.key || ':' || (public.lead_summary('00000000-0000-0000-0000-000000000001', '{}')
                                              -> 'per_stage' ->> s.id::text), ',' order by s.sort_order)
             from public.lead_stages s where s.tenant_id = '00000000-0000-0000-0000-000000000001'),
  'new:3,contacted:1,proposal:0,won:1,lost:0', 'per stage: every stage, zeros included, spam left out');
select is(public.lead_summary('00000000-0000-0000-0000-000000000001',
            jsonb_build_object('from', now() - interval '45 hours', 'to', now() - interval '15 hours'))
          - array['avg_first_response_hours', 'web_response_hours', 'per_stage'],
  '{"new": 1, "won": 1, "lost": 0, "open": 2, "spam": 0, "total": 3, "in_progress": 1, "won_value": 50000,
    "unread": 0, "starred": 2, "sla_breached": 0, "web_response_n": 2}'::jsonb,
  'a date range: b2, b3 and b4 only');
select throws_ok($$ select public.lead_summary('00000000-0000-0000-0000-000000000001', '{"assigned": "me"}') $$,
  '22023', null, 'the summary takes a date range only (not an assignee)');
select throws_ok($$ select public.lead_summary('00000000-0000-0000-0000-000000000001', '{"starred": true}') $$,
  '22023', null, 'nor a star');
select throws_ok($$ select public.lead_summary('00000000-0000-0000-0000-000000000001', '{"discipline": "pgc4-brand"}') $$,
  '22023', null, 'nor a discipline');

-- ---- Previous and Next -------------------------------------------------------------------------
select is(_nb('b6'), '-/b4', 'the newest lead has no previous');
select is(_nb('b1'), 'b2/-', 'the oldest has no next');
select is(_nb('b3'), 'b4/b2', 'one in the middle has both');
select is(_nb('b2', '{"assigned": "me"}'), 'b4/-', 'under a filter, within the filter');
select is(_nb('b2', '{"sort": "starred"}'), 'b4/b6', 'under the starred sort');
select is(_nb('b5', '{"spam": true}'), 'b8/-', 'a spam lead, in the spam view');
select is(_nb('b5'), '-/-', 'a lead the filter leaves out has none');
select is(_nb('b7'), '-/-', 'another tenant''s lead has none');
select ok((select bool_and(
             (z.nb ->> 'prev') is not distinct from (select x.id from _list_of(s.f) x where x.n = l.n - 1)
             and (z.nb ->> 'next') is not distinct from (select x.id from _list_of(s.f) x where x.n = l.n + 1))
            from (values ('{"sort": "newest"}'::jsonb), ('{"sort": "oldest"}'), ('{"sort": "score"}'),
                         ('{"sort": "starred"}'), ('{"spam": true}'), ('{"unread": false, "sort": "oldest"}')) s(f)
            cross join lateral _list_of(s.f) l
            cross join lateral (select public.lead_neighbours('00000000-0000-0000-0000-000000000001',
                                                              l.id::uuid, s.f) as nb) z),
  'Previous and Next follow the list''s own order, lead by lead, under every sort and a filter (D14)');
select throws_ok($$ select public.lead_neighbours('00000000-0000-0000-0000-000000000001',
                                                  '00000000-0000-0000-0000-0000000000b1', '{"q": "acme"}') $$,
  '22023', null, 'neighbours take no search (a URL never carries one)');
select throws_ok($$ select public.lead_neighbours('00000000-0000-0000-0000-000000000001',
                                                  '00000000-0000-0000-0000-0000000000b1', '{"limit": 5}') $$,
  '22023', null, 'nor a page');
select throws_ok($$ select public.lead_neighbours('00000000-0000-0000-0000-000000000001',
                                                  '00000000-0000-0000-0000-0000000000b1',
                                                  jsonb_build_object('contact_kind', 'email', 'contact_hmac', repeat('a', 64))) $$,
  '22023', null, 'nor a contact lookup');

-- ---- The catalog -----------------------------------------------------------------------------
reset role;
select ok(not has_function_privilege('anon', f, 'execute')
          and has_function_privilege('authenticated', f, 'execute')
          and not has_function_privilege('service_role', f, 'execute')
          and not (select prosecdef from pg_proc where oid = f::regprocedure),
          f || ': staff only, SECURITY INVOKER')
  from unnest(array[
    'app.lead_filter(jsonb, boolean)',
    'app.lead_over_sla(text, boolean, timestamp with time zone, timestamp with time zone, boolean, integer)',
    'app.leads_matching(uuid, jsonb, boolean)',
    'public.leads_list(uuid, jsonb)',
    'public.leads_board(uuid, jsonb)',
    'public.lead_summary(uuid, jsonb)',
    'public.lead_neighbours(uuid, uuid, jsonb)']) f;

select * from finish();
rollback;
