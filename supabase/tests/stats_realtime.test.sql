-- pgTAP: website stats v2, realtime (migration 0071, Admin v2 G1b). Run with
-- `supabase test db`.
--
--   • app.rollup_realtime recomputes the last three complete UTC minutes: a minute's page
--     views; the people active in the five minutes ending with it (the window's edges: an
--     event exactly five minutes before the minute's end is in, one a second earlier is
--     out; a null session is in no one's count; this minute's events wait for the next run);
--     the pages they are on (each session's latest page view, the path cut at ? and #), ten
--     at most; no row for a minute with nothing in it, and a recomputed minute that now has
--     nothing loses its row; rows older than 48 hours go; a second run writes nothing.
--   • the minute rollup reads its raw rows through the occurred_at index, not a scan of the
--     month (the plan, on a seeded partition).
--   • realtime_summary: the latest complete minute, its people and pages, 30 minutes of page
--     views with zeros filled; another tenant gets the empty shape; every analytics.read role
--     calls it, anon may not.
--   • who executes what: no API role runs the rollup; staff alone call the reader.
--
-- Fixtures are two tenants of this file's own; every count is scoped to them.

begin;
select plan(24);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- This month's partitions first (see stats_visits_events.test.sql).
select app.ensure_telemetry_partitions(2);
insert into public.tenants (id, name) values
  ('71b00000-0000-0000-0000-000000000001', 'G1b one'),
  ('71b00000-0000-0000-0000-0000000000ff', 'G1b two');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '71b00000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- The start of the current (incomplete) UTC minute, as the rollup computes it; `now()` is
-- the transaction's start, so it holds for the whole file.
create function _end() returns timestamptz language sql stable as $$
  select date_trunc('minute', now() at time zone 'UTC') at time zone 'UTC'
$$;
-- A moment s seconds after the current minute's start (negative: before it).
create function _t(s numeric) returns timestamptz language sql stable as $$
  select _end() + make_interval(secs => s)
$$;
create function _ev(p_tid uuid, p_s numeric, p_type text, p_path text, p_sid text)
  returns void language sql as $$
  insert into public.analytics_events (tenant_id, occurred_at, event_type, path, locale, session_id)
  values (p_tid, _t(p_s), p_type, p_path, 'en', p_sid)
$$;
create function _rollup() returns int language sql security definer as $$
  select app.rollup_realtime()
$$;
create function _row(p_tid uuid, p_min int) returns public.rollup_minute_activity
  language sql security definer as $$
  select m.* from public.rollup_minute_activity m
   where m.tenant_id = p_tid and m.minute = _end() - make_interval(mins => p_min)
$$;

-- Tenant one. M1 is the minute before the current one, M2 and M3 before it.
--   a  M3 + 5 s /            M1 + 10 s /services/logo     (latest page: /services/logo)
--   b  M1 + 20 s /contact?x=1#f                            (cut: /contact)
--   c  M2 + 30 s a click, no page view                     (active, on no page)
--   e  exactly 5 minutes before M1's end: /about           (in M1's window)
--   f  a second before that: /old                          (out of M1's, in M2's)
--   (no session) M1 + 40 s /                               (a view, nobody active)
--   g  in the current minute: /now                         (not counted yet)
select _ev('71b00000-0000-0000-0000-000000000001', -175, 'pageview', '/', 'a');
select _ev('71b00000-0000-0000-0000-000000000001', -50, 'pageview', '/services/logo', 'a');
select _ev('71b00000-0000-0000-0000-000000000001', -40, 'pageview', '/contact?x=1#f', 'b');
select _ev('71b00000-0000-0000-0000-000000000001', -90, 'cta_click', '/', 'c');
select _ev('71b00000-0000-0000-0000-000000000001', -300, 'pageview', '/about', 'e');
select _ev('71b00000-0000-0000-0000-000000000001', -301, 'pageview', '/old', 'f');
select _ev('71b00000-0000-0000-0000-000000000001', -20, 'pageview', '/', null);
select _ev('71b00000-0000-0000-0000-000000000001', 1, 'pageview', '/now', 'g');
-- Tenant two: twelve people on twelve pages in M1 (only ten pages are kept).
insert into public.analytics_events (tenant_id, occurred_at, event_type, path, session_id)
select '71b00000-0000-0000-0000-0000000000ff'::uuid, _t(-30), 'pageview', format('/p%s', lpad(g::text, 2, '0')), 'x' || g
  from generate_series(1, 12) g;
-- Rows the run must remove: a recomputed minute with nothing in it now, and one 49 hours old.
insert into public.rollup_minute_activity (tenant_id, minute, views, active_visits) values
  ('71b00000-0000-0000-0000-0000000000ff', _end() - interval '3 minutes', 9, 9),
  ('71b00000-0000-0000-0000-0000000000ff', _end() - interval '49 hours', 1, 1);

select ok(_rollup() > 0, 'app.rollup_realtime writes the rows');

-- ── 1. the arithmetic (as the migration role) ─────────────────────────────────────
select is((_row('71b00000-0000-0000-0000-000000000001', 1)).views, 3,
  'M1: three page views, the one with no session included');
select is((_row('71b00000-0000-0000-0000-000000000001', 1)).active_visits, 4,
  'M1: four people active (a, b, c and e, whose view is exactly five minutes before its end; not f, nor the null session)');
select is((_row('71b00000-0000-0000-0000-000000000001', 1)).top_paths,
  '[{"path": "/about", "visits": 1}, {"path": "/contact", "visits": 1}, {"path": "/services/logo", "visits": 1}]'::jsonb,
  'M1: each person on their latest page, the path cut at ? and #, c on none');
select is((_row('71b00000-0000-0000-0000-000000000001', 2)).active_visits, 4,
  'M2: four people (a, c, e and f)');
select is((_row('71b00000-0000-0000-0000-000000000001', 2)).views, 0,
  'M2 has no page view of its own, but a row for its people');
select is((_row('71b00000-0000-0000-0000-000000000001', 3)).top_paths,
  '[{"path": "/", "visits": 1}, {"path": "/about", "visits": 1}, {"path": "/old", "visits": 1}]'::jsonb,
  'M3: a was on / then');
select is((select count(*)::int from public.rollup_minute_activity m
            where m.tenant_id = '71b00000-0000-0000-0000-000000000001' and m.minute >= _end()),
  0, 'the current minute waits for the next run');
select is(jsonb_array_length((_row('71b00000-0000-0000-0000-0000000000ff', 1)).top_paths), 10,
  'ten pages at most');
select is((_row('71b00000-0000-0000-0000-0000000000ff', 1)).active_visits, 12,
  'while everyone active is counted');
select is((select count(*)::int from public.rollup_minute_activity m
            where m.tenant_id = '71b00000-0000-0000-0000-0000000000ff'
              and m.minute in (_end() - interval '3 minutes', _end() - interval '49 hours')),
  0, 'a recomputed minute with nothing in it loses its row; one older than 48 hours goes');
select is(_rollup(), 0, 'a second run writes nothing');
select throws_ok(
  $$ insert into public.rollup_minute_activity (tenant_id, minute, views, active_visits)
     values ('71b00000-0000-0000-0000-000000000001', _t(-90.5), 1, 1) $$,
  '23514', null, 'a minute row must start on a whole UTC minute');
select throws_ok(
  $$ insert into public.rollup_minute_activity (tenant_id, minute, views, active_visits, top_paths)
     values ('71b00000-0000-0000-0000-000000000001', _end() - interval '30 minutes', 1, 1,
             (select jsonb_agg(jsonb_build_object('path', '/x', 'visits', 1)) from generate_series(1, 11))) $$,
  '23514', null, 'top_paths holds ten pages at most');

-- ── 2. the plan: an index, not a scan of the month ─────────────────────────────────
-- 20,000 page views over the last 20 days in tenant two, then the rollup's read, explained.
insert into public.analytics_events (tenant_id, occurred_at, event_type, path, session_id)
select '71b00000-0000-0000-0000-0000000000ff'::uuid, now() - make_interval(secs => g * 86.4),
       'pageview', '/bulk', 'bulk' || (g % 500)
  from generate_series(1, 20000) g;
analyze public.analytics_events;
create function _plan() returns jsonb language plpgsql as $f$
declare
  p jsonb;
begin
  execute $q$explain (format json)
    select e.tenant_id, e.occurred_at from public.analytics_events e
     where e.occurred_at >= date_trunc('minute', now()) - interval '7 minutes'
       and e.occurred_at < date_trunc('minute', now())$q$ into p;
  return p;
end $f$;
select is(
  (select count(*)::int
     from jsonb_path_query(_plan(), '$.** ? (@."Node Type" like_regex "Seq Scan")') n
     join pg_class c on c.relname = n ->> 'Relation Name'
    where c.reltuples > 1000),
  0, 'the minute rollup''s read does not scan a seeded partition');
-- The occurred_at index by name: without it the planner may still walk the primary key
-- (id, occurred_at) from end to end, which is the cost this index exists to avoid.
select ok(
  jsonb_path_exists(_plan(), '$.** ? (@."Index Name" like_regex "occurred_at_idx$")'),
  'it reads through the occurred_at index');

-- ── 3. the reader, as each role ───────────────────────────────────────────────────
set local role authenticated;
select _as('content_creator', '71b00000-0000-0000-0000-000000000001');
select is((public.realtime_summary('71b00000-0000-0000-0000-000000000001') ->> 'as_of')::timestamptz,
  _end() - interval '1 minute', 'as_of is the latest complete minute');
select is(public.realtime_summary('71b00000-0000-0000-0000-000000000001') - 'as_of' - 'per_minute',
  '{"active_visits": 4, "top_paths": [{"path": "/about", "visits": 1}, {"path": "/contact", "visits": 1},
                                       {"path": "/services/logo", "visits": 1}]}'::jsonb,
  'its people and their pages');
select is(jsonb_array_length(public.realtime_summary('71b00000-0000-0000-0000-000000000001') -> 'per_minute'),
  30, 'thirty minutes of page views');
select is((select string_agg((m ->> 'views'), ',' order by (m ->> 'minute')::timestamptz)
             from jsonb_array_elements(public.realtime_summary('71b00000-0000-0000-0000-000000000001') -> 'per_minute') m
            where (m ->> 'minute')::timestamptz >= _end() - interval '4 minutes'),
  '0,1,0,3', 'the last four minutes, zeros filled, oldest first');
select _as('developer', '71b00000-0000-0000-0000-000000000001');
select is((public.realtime_summary('71b00000-0000-0000-0000-000000000001') ->> 'active_visits')::int, 4,
  'developer reads it too (analytics.read)');
select _as('admin', '71b00000-0000-0000-0000-0000000000ff');
select is(public.realtime_summary('71b00000-0000-0000-0000-000000000001') - 'as_of',
  '{"active_visits": 0, "top_paths": [], "per_minute": []}'::jsonb,
  'another tenant''s admin naming this tenant gets the empty shape');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select public.realtime_summary('71b00000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon may not call realtime_summary');
reset role;
select is(
  (select coalesce(string_agg(format('%s %s', w.who, f.fn), ', ' order by f.fn, w.who), '')
     from (values ('public.realtime_summary(uuid)', 'authenticated'),
                  ('app.rollup_realtime()', '')) as f(fn, runner)
     cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, f.fn, 'execute') is distinct from (w.who = f.runner)),
  '', 'staff alone call the reader; no API role runs the rollup');

select * from finish();
rollback;
