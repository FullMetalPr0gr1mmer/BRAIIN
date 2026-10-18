-- pgTAP: website stats v2, visits, events and busiest hours (migration 0071, Admin v2 G1a).
-- Run with `supabase test db`.
--
--   • app.rollup_visits: a visit is one session id on one UTC day (a null session counts in
--     no visit); one-page visits are one page view and nothing else; pages per visit come
--     from the visits' page views; the service path rule (/services/logo yes, /services no,
--     /ar/services/logo/ yes); the inquiry rule (the contact page, each of INQUIRY_CTAS, a
--     click that is not one of them no); the strict step (both in one visit); event keys, the
--     busiest 100 per tenant, day and type with every event in '*' and a malformed key in
--     '*' only; page views per whole UTC hour; a second run writes nothing; rows of the window
--     the run no longer produces go; rows older than 400 days go.
--   • the readers: visit_summary, event_summary and busy_hours (an event at 21:30 UTC is hour
--     0 in Riyadh; 24 rows always); bounds are 22023; another tenant gets the empty shape;
--     every analytics.read role reads, anon may not call or read.
--   • the four rollup tables: RLS on and forced, one read policy each, staff SELECT and the
--     service role the four writes, no column grant; anon is refused by the grant layer;
--     another tenant reads none of these rows. The stale-token read gap is U2's (the policy
--     reads the token's role; sessions are revoked on a role change since 0055, so it is the
--     access token's hour, and the data is counts).
--   • raw telemetry: no API role but the service role holds anything on either parent or any
--     partition; staff SELECT is refused; the service role still ingests; a partition
--     app.ensure_telemetry_partitions() creates later carries the occurred_at index; and the
--     migration's own check (app.raw_telemetry_exposure) fires when a grant slips back.
--
-- Fixtures are two tenants of this file's own; every count is scoped to them.

begin;
select plan(56);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- This month's partitions first, as the monthly job keeps them, so the fixtures below land in
-- a month's partition rather than the default one (which would refuse that month's partition
-- later in this file).
select app.ensure_telemetry_partitions(2);
insert into public.tenants (id, name) values
  ('71000000-0000-0000-0000-000000000001', 'G1 one'),
  ('71000000-0000-0000-0000-0000000000ff', 'G1 two');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '71000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The UTC day n days ago, and a moment in it (h hours after its midnight).
create function _d(n int) returns date language sql stable as $$
  select (now() at time zone 'UTC')::date - n
$$;
create function _at(n int, h numeric) returns timestamptz language sql stable as $$
  select (_d(n)::timestamp + make_interval(secs => h * 3600)) at time zone 'UTC'
$$;

-- One raw event, as the ingest writes it (tenant one unless named).
create function _ev(p_day int, p_h numeric, p_type text, p_path text, p_sid text,
                    p_props jsonb default '{}'::jsonb,
                    p_tid uuid default '71000000-0000-0000-0000-000000000001')
  returns void language sql as $$
  insert into public.analytics_events (tenant_id, occurred_at, event_type, path, locale, session_id, props)
  values (p_tid, _at(p_day, p_h), p_type, p_path, 'en', p_sid, p_props)
$$;

create function _rollup(p_days int) returns int language sql security definer as $$
  select app.rollup_visits(p_days)
$$;
create function _run(p_days int) returns void language plpgsql security definer as $$
begin
  perform app.rollup_visits(p_days);
end $$;

-- Everything the three rollups hold for the two tenants, as one string (owner's view).
create function _snapshot() returns text language sql security definer as $$
  select concat_ws(' | ',
    (select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', v.tenant_id, v.day, v.visits, v.one_page_visits,
                              v.visit_views, v.service_visits, v.service_inquiry_visits, v.inquiry_visits),
                       ';' order by v.tenant_id, v.day)
       from public.rollup_daily_visits v where v.tenant_id::text like '71000000-%'),
    (select string_agg(format('%s|%s|%s|%s|%s|%s', e.tenant_id, e.day, e.event_type, e.key, e.events, e.visits),
                       ';' order by e.tenant_id, e.day, e.event_type, e.key)
       from public.rollup_daily_events e where e.tenant_id::text like '71000000-%'),
    (select string_agg(format('%s|%s|%s', h.tenant_id, h.hour, h.views), ';' order by h.tenant_id, h.hour)
       from public.rollup_hourly_pageviews h where h.tenant_id::text like '71000000-%'))
$$;

-- Day 1, tenant one: seven visits and one page view with no session.
--   s1  /services/logo, then the skip pill               service, inquiry
--   s2  /                                                 one page
--   s3  /ar/services/logo/, /ar/contact                   service, inquiry
--   s4  /contact                                          inquiry, one page
--   s5  /services (not a service page), WhatsApp, interest in branding twice
--   s6  start_project (no page view), interest in logo-design         inquiry
--   s7  /about, contact_link, interest with a malformed key           inquiry
--   (no session) /, interest in branding
select _ev(1, 9, 'pageview', '/services/logo', 's1');
select _ev(1, 9.1, 'cta_click', '/services/logo', 's1', '{"cta":"skip_to_inquiry"}');
select _ev(1, 10, 'pageview', '/', 's2');
select _ev(1, 11, 'pageview', '/ar/services/logo/', 's3');
select _ev(1, 11.2, 'pageview', '/ar/contact', 's3');
select _ev(1, 12, 'pageview', '/contact', 's4');
select _ev(1, 13, 'pageview', '/services', 's5');
select _ev(1, 13.1, 'cta_click', '/services', 's5', '{"cta":"whatsapp"}');
select _ev(1, 13.2, 'service_interest', '/services', 's5', '{"discipline":"branding"}');
select _ev(1, 13.3, 'service_interest', '/services', 's5', '{"discipline":"branding"}');
select _ev(1, 14, 'cta_click', '/services', 's6', '{"cta":"start_project"}');
select _ev(1, 14.1, 'service_interest', '/services', 's6', '{"service":"logo-design"}');
select _ev(1, 15, 'pageview', '/about', 's7');
select _ev(1, 15.1, 'cta_click', '/about', 's7', '{"cta":"contact_link"}');
select _ev(1, 15.2, 'service_interest', '/services', 's7', '{"discipline":"BAD KEY"}');
select _ev(1, 16, 'pageview', '/', null);
select _ev(1, 16.1, 'service_interest', '/services', null, '{"discipline":"branding"}');
-- Day 2, tenant one: 101 click keys, k000 twice and the rest once (the busiest 100 keep rows).
insert into public.analytics_events (tenant_id, occurred_at, event_type, path, session_id, props)
select '71000000-0000-0000-0000-000000000001'::uuid, _at(2, 10), 'cta_click', '/', 'k' || g,
       jsonb_build_object('cta', 'k' || lpad(g::text, 3, '0'))
  from generate_series(0, 100) g
union all
select '71000000-0000-0000-0000-000000000001', _at(2, 11), 'cta_click', '/', 'kk', '{"cta":"k000"}';
-- Day 3, tenant one: a page view at 21:30 UTC (00:30 the next day in Riyadh).
select _ev(3, 21.5, 'pageview', '/late', 's9');
-- Tenant two: one visit on day 1.
select _ev(1, 8, 'pageview', '/', 't1', '{}', '71000000-0000-0000-0000-0000000000ff');
-- Rows the run must remove: a key in the window it no longer produces, a day in the window
-- with no events, and rows older than 400 days.
insert into public.rollup_daily_events (tenant_id, day, event_type, key, events, visits) values
  ('71000000-0000-0000-0000-000000000001', _d(2), 'cta_click', 'stale', 9, 9),
  ('71000000-0000-0000-0000-000000000001', _d(401), 'cta_click', 'old', 1, 1);
insert into public.rollup_daily_visits (tenant_id, day, visits, one_page_visits, visit_views,
                                        service_visits, service_inquiry_visits, inquiry_visits) values
  ('71000000-0000-0000-0000-0000000000ff', _d(2), 5, 0, 5, 0, 0, 0),
  ('71000000-0000-0000-0000-0000000000ff', _d(401), 5, 0, 5, 0, 0, 0);
insert into public.rollup_hourly_pageviews (tenant_id, hour, views) values
  ('71000000-0000-0000-0000-0000000000ff', _at(401, 3), 1);

select ok(_rollup(3) > 0, 'app.rollup_visits writes the rows');
create temporary table _first as select _snapshot() as s;

-- ── 1. the rollup's arithmetic (as the migration role) ──────────────────────────
select is(
  (select row(v.visits, v.one_page_visits, v.visit_views, v.service_visits,
              v.service_inquiry_visits, v.inquiry_visits)::text
     from public.rollup_daily_visits v
    where v.tenant_id = '71000000-0000-0000-0000-000000000001' and v.day = _d(1)),
  '(7,2,7,2,2,5)',
  'day 1: seven visits (no null session), two one-page, seven page views, two service, two strict, five inquiry');
select is(
  (select string_agg(format('%s %s/%s', e.key, e.events, e.visits), ', ' order by e.key)
     from public.rollup_daily_events e
    where e.tenant_id = '71000000-0000-0000-0000-000000000001' and e.day = _d(1)
      and e.event_type = 'cta_click'),
  '* 4/4, contact_link 1/1, skip_to_inquiry 1/1, start_project 1/1, whatsapp 1/1',
  'clicks per id, and every click in *');
select is(
  (select string_agg(format('%s %s/%s', e.key, e.events, e.visits), ', ' order by e.key)
     from public.rollup_daily_events e
    where e.tenant_id = '71000000-0000-0000-0000-000000000001' and e.day = _d(1)
      and e.event_type = 'service_interest'),
  '* 5/3, d:branding 3/1, s:logo-design 1/1',
  'interest by d:/s: key; a null session counts as an event in no visit; a malformed key in * only');
select is(
  (select count(*)::int from public.rollup_daily_events e
    where e.tenant_id = '71000000-0000-0000-0000-000000000001' and e.day = _d(2)
      and e.event_type = 'cta_click' and e.key <> '*'),
  100, 'the busiest 100 keys keep their own row');
select is(
  (select string_agg(e.key || ' ' || e.events, ', ' order by e.key)
     from public.rollup_daily_events e
    where e.tenant_id = '71000000-0000-0000-0000-000000000001' and e.day = _d(2)
      and e.event_type = 'cta_click' and e.key in ('*', 'k000', 'k099', 'k100')),
  '* 102, k000 2, k099 1',
  'the 101st key counts in * only (ties by key), * holds every click');
select is(
  (select count(*)::int from public.rollup_daily_events e
    where e.tenant_id = '71000000-0000-0000-0000-000000000001' and e.key = 'stale'),
  0, 'a key in the window the run no longer produces is removed');
select is(
  (select count(*)::int from public.rollup_daily_visits v
    where v.tenant_id = '71000000-0000-0000-0000-0000000000ff' and v.day = _d(2)),
  0, 'so is a day in the window with no visits');
select is(
  (select count(*)::int from public.rollup_daily_visits v where v.tenant_id::text like '71000000-%' and v.day = _d(401))
  + (select count(*)::int from public.rollup_daily_events e where e.tenant_id::text like '71000000-%' and e.day = _d(401))
  + (select count(*)::int from public.rollup_hourly_pageviews h where h.tenant_id::text like '71000000-%'
       and h.hour < _at(400, 0)),
  0, 'rows older than 400 days are purged from all three');
select is(
  (select string_agg(format('%s %s', to_char(h.hour at time zone 'UTC', 'HH24:MI'), h.views), ', ' order by h.hour)
     from public.rollup_hourly_pageviews h
    where h.tenant_id = '71000000-0000-0000-0000-000000000001' and h.hour >= _at(3, 0) and h.hour < _at(2, 0)),
  '21:00 1', 'page views per whole UTC hour');
select is(
  (select sum(h.views)::int from public.rollup_hourly_pageviews h
    where h.tenant_id = '71000000-0000-0000-0000-000000000001' and h.hour >= _at(1, 0) and h.hour < _at(0, 0)),
  8, 'the hours of day 1 hold its eight page views, the one with no session included');
select throws_ok(
  $$ insert into public.rollup_hourly_pageviews (tenant_id, hour, views)
     values ('71000000-0000-0000-0000-000000000001', _at(5, 1.5), 1) $$,
  '23514', null, 'an hour row must start on a whole UTC hour');
select throws_ok(
  $$ insert into public.rollup_daily_events (tenant_id, day, event_type, key, events, visits)
     values ('71000000-0000-0000-0000-000000000001', _d(5), 'cta_click', 'Bad Key', 1, 1) $$,
  '23514', null, 'an event key is a plain id or *');
select is(_rollup(3), 0, 'a second run writes nothing');
select is(_snapshot(), (select s from _first), 'and changes nothing');

-- ── 2. the readers, as each role ───────────────────────────────────────────────
set local role authenticated;
select _as('content_creator', '71000000-0000-0000-0000-000000000001');
select is(public.visit_summary('71000000-0000-0000-0000-000000000001', _d(1), _d(1)) - 'first_day',
  jsonb_build_object('visits', 7, 'one_page_visits', 2, 'visit_views', 7, 'service_visits', 2,
                     'service_inquiry_visits', 2, 'inquiry_visits', 5,
                     'by_day', jsonb_build_array(jsonb_build_object('day', _d(1), 'visits', 7))),
  'visit_summary: the day''s figures, by day');
select is((public.visit_summary('71000000-0000-0000-0000-000000000001', _d(3), _d(0)) ->> 'visits')::int,
  110, 'over three days: a session with a click and no page view is a visit too (7 + 102 + 1)');
select is(public.visit_summary('71000000-0000-0000-0000-000000000001', _d(0), _d(0)) ->> 'first_day',
  (select min(day)::text from public.rollup_daily_visits where tenant_id = '71000000-0000-0000-0000-000000000001'),
  'first_day is the earliest visits day, whatever the range');
select is(public.event_summary('71000000-0000-0000-0000-000000000001', _d(1), _d(1)),
  '{"cta": [{"key": "contact_link", "events": 1, "visits": 1}, {"key": "skip_to_inquiry", "events": 1, "visits": 1},
            {"key": "start_project", "events": 1, "visits": 1}, {"key": "whatsapp", "events": 1, "visits": 1}],
    "interest": [{"key": "d:branding", "events": 3, "visits": 1}, {"key": "s:logo-design", "events": 1, "visits": 1}],
    "cta_total": 4, "interest_total": 5}'::jsonb,
  'event_summary: keys by events then key, the totals over every key');
select is(jsonb_array_length(public.event_summary('71000000-0000-0000-0000-000000000001', _d(2), _d(2)) -> 'cta'),
  20, 'twenty keys at most per type');
select is((select count(*)::int from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(3), _d(3), 'Asia/Riyadh')),
  24, 'busy_hours: 24 rows');
select is((select string_agg(format('%s:%s', b.hour, b.views), ',')
             from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(3), _d(3), 'Asia/Riyadh') b
            where b.views > 0),
  '0:1', 'an event at 21:30 UTC is hour 0 in Riyadh');
select is((select string_agg(format('%s:%s', b.hour, b.views), ',')
             from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(3), _d(3), 'UTC') b
            where b.views > 0),
  '21:1', 'and hour 21 in UTC');
select is((select sum(b.views)::int from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(1), _d(1), 'Asia/Riyadh') b),
  8, 'a range''s hours add up to its page views');
select is((select string_agg(b.hour::text, ',' order by b.hour)
             from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(1), _d(1), 'Asia/Riyadh') b),
  (select string_agg(g::text, ',' order by g) from generate_series(0, 23) g),
  'every hour 0 to 23, in order, zeros included');
select throws_ok($$ select public.visit_summary('71000000-0000-0000-0000-000000000001', _d(0), _d(1)) $$,
  '22023', null, 'visit_summary: a reversed range is refused');
select throws_ok($$ select public.visit_summary('71000000-0000-0000-0000-000000000001', _d(400), _d(0)) $$,
  '22023', null, 'visit_summary: 401 days is refused');
select throws_ok($$ select public.event_summary('71000000-0000-0000-0000-000000000001', _d(400), _d(0)) $$,
  '22023', null, 'event_summary: 401 days is refused');
select throws_ok($$ select * from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(1), _d(1), 'Mars/Olympus') $$,
  '22023', null, 'busy_hours: a time zone outside the allow-list is refused');
select throws_ok($$ select * from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(0), _d(1), 'UTC') $$,
  '22023', null, 'busy_hours: a reversed range is refused');
select _as('seo', '71000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.rollup_daily_visits where tenant_id = '71000000-0000-0000-0000-000000000001'),
  3, 'seo reads the visits rollup (analytics.read)');
select _as('developer', '71000000-0000-0000-0000-000000000001');
select ok((select count(*) from public.rollup_daily_events where tenant_id = '71000000-0000-0000-0000-000000000001') > 100
          and (select count(*) from public.rollup_hourly_pageviews where tenant_id = '71000000-0000-0000-0000-000000000001') > 0,
  'developer reads the events and hours rollups');
select _as('admin', '71000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.rollup_daily_visits where tenant_id = '71000000-0000-0000-0000-000000000001')
          + (select count(*)::int from public.rollup_daily_events where tenant_id = '71000000-0000-0000-0000-000000000001')
          + (select count(*)::int from public.rollup_hourly_pageviews where tenant_id = '71000000-0000-0000-0000-000000000001'),
  0, 'another tenant''s admin reads none of this tenant''s rollup rows');
select is(public.visit_summary('71000000-0000-0000-0000-000000000001', _d(3), _d(0)),
  '{"visits": 0, "one_page_visits": 0, "visit_views": 0, "service_visits": 0, "service_inquiry_visits": 0,
    "inquiry_visits": 0, "by_day": [], "first_day": null}'::jsonb,
  'naming this tenant gets visit_summary''s empty shape');
select is(public.event_summary('71000000-0000-0000-0000-000000000001', _d(3), _d(0)),
  '{"cta": [], "interest": [], "cta_total": 0, "interest_total": 0}'::jsonb,
  'and event_summary''s');
select is((select sum(b.views)::int + count(*)::int
             from public.busy_hours('71000000-0000-0000-0000-000000000001', _d(3), _d(0), 'UTC') b),
  24, 'and 24 empty hours');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.rollup_daily_visits $$, '42501', null,
  'anon is refused rollup_daily_visits at the grant layer');
select throws_ok($$ select public.visit_summary('71000000-0000-0000-0000-000000000001', _d(1), _d(1)) $$,
  '42501', null, 'anon may not call visit_summary');
reset role;

-- ── 3. raw telemetry: the service role only ────────────────────────────────────────
select is(app.raw_telemetry_exposure(), null,
  'no policy on either parent, and PUBLIC, anon and authenticated hold nothing on a parent or partition');
set local role authenticated;
select _as('admin', '71000000-0000-0000-0000-000000000001');
select throws_ok($$ select count(*) from public.analytics_events $$, '42501', null,
  'admin is refused analytics_events');
select throws_ok($$ select count(*) from public.web_vitals $$, '42501', null,
  'admin is refused web_vitals');
reset role;
set local role service_role;
select lives_ok(
  $$ insert into public.analytics_events (tenant_id, event_type, path, session_id, props)
     values ('71000000-0000-0000-0000-000000000001', 'cta_click', '/', 'svc', '{"cta":"email"}') $$,
  'the service role still ingests');
select is((select count(*)::int from public.analytics_events where session_id = 'svc'), 1,
  'and reads what it wrote');
reset role;
-- A grant slipping back is found by the migration's own check (this transaction rolls back).
grant select on public.analytics_events to authenticated;
select is(app.raw_telemetry_exposure(), 'authenticated select public.analytics_events',
  'the check names a table grant that slipped back');
revoke select on public.analytics_events from authenticated;
grant select (path) on public.web_vitals to anon;
select ok(app.raw_telemetry_exposure() like '%anon select public.web_vitals%',
  'and a column grant');
revoke select (path) on public.web_vitals from anon;
create policy _g1_probe on public.web_vitals for select to authenticated using (false);
select is(app.raw_telemetry_exposure(), 'policy web_vitals._g1_probe', 'and a policy');
drop policy _g1_probe on public.web_vitals;
-- Partitions made later carry the index and grant nothing.
select lives_ok($$ select app.ensure_telemetry_partitions(15) $$,
  'partitions are created 15 months ahead');
select is(
  (select coalesce(string_agg(c.relname, ', '), '')
     from pg_inherits i
     join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.analytics_events'::regclass
      and not exists (select 1 from pg_index x
                       join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
                      where x.indrelid = i.inhrelid and x.indnatts = 1 and a.attname = 'occurred_at')),
  '', 'every partition, the new ones included, has the occurred_at index');
select is(app.raw_telemetry_exposure(), null, 'and the new partitions grant nothing');

-- ── 4. the four rollup tables' catalog ─────────────────────────────────────────────
select is(
  (select string_agg(format('%s %s', c.relname, c.relrowsecurity and c.relforcerowsecurity), ', ' order by c.relname)
     from pg_class c
    where c.oid in ('public.rollup_daily_visits'::regclass, 'public.rollup_daily_events'::regclass,
                    'public.rollup_hourly_pageviews'::regclass, 'public.rollup_minute_activity'::regclass)),
  'rollup_daily_events t, rollup_daily_visits t, rollup_hourly_pageviews t, rollup_minute_activity t',
  'RLS enabled and forced on all four');
select is(
  (select string_agg(format('%s %s %s %s', tablename, policyname, cmd, roles), '; ' order by tablename)
     from pg_policies
    where schemaname = 'public'
      and tablename in ('rollup_daily_visits', 'rollup_daily_events', 'rollup_hourly_pageviews',
                        'rollup_minute_activity')),
  'rollup_daily_events rollup_daily_events_read SELECT {authenticated}; '
  || 'rollup_daily_visits rollup_daily_visits_read SELECT {authenticated}; '
  || 'rollup_hourly_pageviews rollup_hourly_pageviews_read SELECT {authenticated}; '
  || 'rollup_minute_activity rollup_minute_activity_read SELECT {authenticated}',
  'one read policy each, for staff');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('rollup_daily_visits', 'rollup_daily_events', 'rollup_hourly_pageviews',
                        'rollup_minute_activity')
      and with_check is null
      and qual ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_analytics_read\((app\.)?"current_role"\(\)\)\)$'),
  4, 'each the tenant predicate first, then analytics.read on the token''s role');
select is(
  (select coalesce(string_agg(format('%s %s %s', t.t, w.who, p.priv), ', ' order by t.t, w.who, p.priv), '')
     from (values ('public.rollup_daily_visits'), ('public.rollup_daily_events'),
                  ('public.rollup_hourly_pageviews'), ('public.rollup_minute_activity')) as t(t)
     cross join (values ('public', array[]::text[]), ('anon', array[]::text[]),
                        ('authenticated', array['select']),
                        ('service_role', array['select', 'insert', 'update', 'delete'])) as w(who, allowed)
     cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                        ('references'), ('trigger')) as p(priv)
    where has_table_privilege(w.who, t.t, p.priv) is distinct from (p.priv = any (w.allowed))),
  '', 'staff SELECT, the service role the four writes, PUBLIC and anon nothing, on each');
select is(
  (select count(*)::int from pg_attribute a
    where a.attrelid in ('public.rollup_daily_visits'::regclass, 'public.rollup_daily_events'::regclass,
                         'public.rollup_hourly_pageviews'::regclass, 'public.rollup_minute_activity'::regclass)
      and a.attnum > 0 and cardinality(coalesce(a.attacl, '{}'::aclitem[])) > 0),
  0, 'and no column grant widens them');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, f.fn), ', ' order by f.fn, w.who), '')
     from (values ('public.visit_summary(uuid, date, date)'), ('public.event_summary(uuid, date, date)'),
                  ('public.busy_hours(uuid, date, date, text)')) as f(fn)
     cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, f.fn, 'execute') is distinct from (w.who = 'authenticated')),
  '', 'the three readers: authenticated executes them, PUBLIC, anon and the service role do not');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, f.fn), ', ' order by f.fn, w.who), '')
     from (values ('app.rollup_visits(integer)'), ('app.raw_telemetry_exposure()')) as f(fn)
     cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, f.fn, 'execute')),
  '', 'no API role runs the rollup or the exposure check');

select * from finish();
rollback;
