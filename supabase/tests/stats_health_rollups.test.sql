-- pgTAP: website stats and site health read rollups (0052, Admin v2 U2). Run with
-- `supabase test db`.
--
--   • app.rollup_vitals: each day's p75 is percentile_disc(0.75) of its samples, per path
--     and for '*' (every path, null paths included); the histogram adds up to the samples; a
--     query string and a fragment fold into the bare path; a second run changes nothing; a
--     late beacon corrects its day; the busiest 100 paths keep their own row and the 101st
--     counts in '*' only, and a path that drops out of the 100 loses its row; a row older
--     than 400 days is purged.
--   • app.rollup_pageviews counts the earliest day of its window whole (0010 counted it from
--     the time of day of the run only).
--   • rollup_daily_vitals: Admin and Developer read their tenant's rows (siteHealth.view),
--     Content Creator and SEO none, anon is refused by the grant layer, another tenant's
--     Admin reads its own rows and none of this tenant's. A demoted Developer whose token
--     still says developer reads them until it expires (the stale-token gap: the policy
--     reads the token, as every non-lead table's does; the data is not sensitive).
--   • vitals_summary: a range's p75 is the edge of the bucket holding its 75th percentile,
--     "within budget" exact at the threshold either side; one day's is exact; another tenant
--     gets nothing; 0 and 91 days are 22023; Content Creator gets no rows; anon may not call.
--   • pageview_summary and pageview_paths: 1,500 rollup rows in range add up whole (no
--     1,000-row cut), pages are stable, bounds are 22023, another tenant gets nothing.
--   • search_summary: SEO sees the searches, Content Creator none (search_queries' RLS),
--     the locale filter, bounds.
--   • content_health: the checklist's counts, the same for every staff role, nothing for
--     another tenant.
--   • who may execute or read what, for every API role.
--
-- Fixtures are two tenants of this file's own; every count is scoped to them.

begin;
select plan(78);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('52000000-0000-0000-0000-000000000001', 'U2 one'),
  ('52000000-0000-0000-0000-0000000000ff', 'U2 two');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '52000000-0000-0000-0000-0000000000a1',
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

-- Raw vitals, as the Worker's beacon writes them.
create function _vital(p_tid uuid, p_day int, p_metric text, p_value double precision, p_path text)
  returns void language sql as $$
  insert into public.web_vitals (tenant_id, occurred_at, metric, value, path)
  values (p_tid, _at(p_day, 10), p_metric, p_value, p_path)
$$;

-- One rollup row, read as the CURRENT role (RLS applies), or null.
create function _row(p_tid uuid, p_day int, p_path text, p_metric text)
  returns public.rollup_daily_vitals language sql as $$
  select v.* from public.rollup_daily_vitals v
   where v.tenant_id = p_tid and v.day = _d(p_day) and v.path = p_path and v.metric = p_metric
$$;

-- Everything the rollup holds for the two tenants, as one string (owner's view).
create function _snapshot() returns text language sql security definer as $$
  select coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s', v.tenant_id, v.day, v.path, v.metric,
                                    v.p75, v.samples, v.hist), ';'
                             order by v.tenant_id, v.day, v.path, v.metric), '')
    from public.rollup_daily_vitals v
   where v.tenant_id in ('52000000-0000-0000-0000-000000000001',
                         '52000000-0000-0000-0000-0000000000ff')
$$;
create function _rollup(p_days int) returns int language sql security definer as $$
  select app.rollup_vitals(p_days)
$$;
-- The same, for a step that is not itself an assertion (prints nothing).
create function _run(p_days int) returns void language plpgsql security definer as $$
begin
  perform app.rollup_vitals(p_days);
end $$;

-- Rows the CURRENT role sees of each tenant.
create function _seen(p_tid uuid) returns int language sql as $$
  select count(*)::int from public.rollup_daily_vitals where tenant_id = p_tid
$$;

-- A summary row of vitals_summary, as the CURRENT role.
create function _vs(p_tid uuid, p_days int, p_path text, p_metric text) returns jsonb language sql as $$
  select r from jsonb_array_elements(public.vitals_summary(p_tid, p_days) -> 'rows') r
   where r ->> 'path' = p_path and r ->> 'metric' = p_metric
$$;

-- Tenant one: LCP on two days and four paths ('/a' through a query and a fragment, '/b' on
-- one day only, '/c' just over the budget, and no path at all), CLS at its budget.
--   day 1  /a  1000 (/a?q=1), 2000 (/a#x), 2500, 3000   p75 2500
--          /b  5000                                       p75 5000
--          /c  2501                                       p75 2501
--          (no path) 100                                  '*' only
--          *   100 1000 2000 2500 2501 3000 5000          p75 3000 (rank 6 of 7)
--   day 2  /a  1500, 1500                                 p75 1500
--          /c  2501                                       p75 2501
--   CLS    /a  0.1 on day 1 and day 2
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 1000, '/a?q=1');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 2000, '/a#x');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 2500, '/a');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 3000, '/a');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 5000, '/b');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 2501, '/c');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 100, null);
select _vital('52000000-0000-0000-0000-000000000001', 2, 'LCP', 1500, '/a');
select _vital('52000000-0000-0000-0000-000000000001', 2, 'LCP', 1500, '/a');
select _vital('52000000-0000-0000-0000-000000000001', 2, 'LCP', 2501, '/c');
select _vital('52000000-0000-0000-0000-000000000001', 1, 'CLS', 0.1, '/a');
select _vital('52000000-0000-0000-0000-000000000001', 2, 'CLS', 0.1, '/a');
-- Tenant two: one LCP sample.
select _vital('52000000-0000-0000-0000-0000000000ff', 1, 'LCP', 1234, '/z');

select ok(_rollup(3) > 0, 'app.rollup_vitals writes the rows');

-- ── 1. the rollup's arithmetic (as the migration role) ──────────────────────────
select is(
  (select count(*)::int from public.rollup_daily_vitals v
    where v.tenant_id = '52000000-0000-0000-0000-000000000001' and v.path <> '*'
      and v.p75 is distinct from (
        select percentile_disc(0.75) within group (order by w.value)
          from public.web_vitals w
         where w.tenant_id = v.tenant_id and w.metric = v.metric
           and (w.occurred_at at time zone 'UTC')::date = v.day
           and left(split_part(split_part(w.path, '?', 1), '#', 1), 200) = v.path)),
  0, 'each path row''s p75 is percentile_disc(0.75) of its day''s samples');
select is(
  (select count(*)::int from public.rollup_daily_vitals v
    where v.tenant_id = '52000000-0000-0000-0000-000000000001' and v.path = '*'
      and v.p75 is distinct from (
        select percentile_disc(0.75) within group (order by w.value)
          from public.web_vitals w
         where w.tenant_id = v.tenant_id and w.metric = v.metric
           and (w.occurred_at at time zone 'UTC')::date = v.day)),
  0, 'each ''*'' row''s p75 is percentile_disc(0.75) of every sample of its day');
select is(
  (select count(*)::int from public.rollup_daily_vitals v
    where v.tenant_id = '52000000-0000-0000-0000-000000000001'
      and v.samples <> (select sum(x) from unnest(v.hist) x)),
  0, 'every histogram adds up to its samples');
select is((_row('52000000-0000-0000-0000-000000000001', 1, '/a', 'LCP')).samples, 4,
  '/a?q=1 and /a#x fold into /a');
select is(
  (select count(*)::int from public.rollup_daily_vitals
    where tenant_id = '52000000-0000-0000-0000-000000000001' and path ~ '[?#]'),
  0, 'no row keeps a query string or a fragment');
select is(((_row('52000000-0000-0000-0000-000000000001', 1, '*', 'LCP')).samples,
           (_row('52000000-0000-0000-0000-000000000001', 1, '*', 'LCP')).p75),
          (7, 3000::double precision),
  '''*'' holds every path and the sample with no path');
select is((_row('52000000-0000-0000-0000-000000000001', 1, '/a', 'LCP')).hist,
          array[0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'a value on an edge is in the bucket that edge closes (1000, 2000, 2500, 3000)');
select is((_row('52000000-0000-0000-0000-000000000001', 1, '/c', 'LCP')).hist[11], 1,
  'a value just over an edge is in the next bucket (2501 above 2500)');

select is(_rollup(3), 0, 'a second run rewrites nothing');
select is(_snapshot(), _snapshot(), 'and the snapshot is stable');

-- ── 2. reads (RLS, the grant layer) ─────────────────────────────────────────────
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.rollup_daily_vitals $$,
  '42501', null, 'anon cannot read rollup_daily_vitals (no privilege)');

set local role authenticated;
select _as('admin', '52000000-0000-0000-0000-000000000001');
select ok(_seen('52000000-0000-0000-0000-000000000001') > 0
          and _seen('52000000-0000-0000-0000-0000000000ff') = 0,
  'admin reads its tenant''s rows and none of another');
select _as('developer', '52000000-0000-0000-0000-000000000001');
select ok(_seen('52000000-0000-0000-0000-000000000001') > 0
          and _seen('52000000-0000-0000-0000-0000000000ff') = 0,
  'developer reads its tenant''s rows and none of another');
select _as('content_creator', '52000000-0000-0000-0000-000000000001');
select is(_seen('52000000-0000-0000-0000-000000000001'), 0, 'content_creator reads no rows');
select _as('seo', '52000000-0000-0000-0000-000000000001');
select is(_seen('52000000-0000-0000-0000-000000000001'), 0, 'seo reads no rows');
select _as('admin', '52000000-0000-0000-0000-0000000000ff');
select ok(_seen('52000000-0000-0000-0000-0000000000ff') = 2
          and _seen('52000000-0000-0000-0000-000000000001') = 0,
  'another tenant''s admin reads its own two rows and none of this tenant''s');
select throws_ok($$ insert into public.rollup_daily_vitals (tenant_id, day, path, metric, p75, samples, hist)
                    values ('52000000-0000-0000-0000-0000000000ff', current_date, '/x', 'LCP', 1, 1,
                            array_fill(0, array[25])) $$,
  '42501', 'permission denied for table rollup_daily_vitals', 'no staff role writes a rollup row');
select throws_ok($$ select app.rollup_vitals(3) $$,
  '42501', null, 'no staff role runs the rollup');
-- The stale-token gap, documented: the policy reads the token's role, as every table's but
-- the lead and application tables' does, so a Developer demoted a minute ago still reads
-- vitals until the token expires (up to an hour). Paths and timings, nothing personal.
reset role;
insert into auth.users (id, email) values ('52000000-0000-0000-0000-0000000000a1', 'u2@example.test');
insert into public.profiles (id, tenant_id, role, is_active)
  values ('52000000-0000-0000-0000-0000000000a1', '52000000-0000-0000-0000-000000000001',
          'content_creator', true);
set local role authenticated;
select _as('developer', '52000000-0000-0000-0000-000000000001');
select ok(_seen('52000000-0000-0000-0000-000000000001') > 0,
  'a demoted Developer whose token still says developer reads vitals until it expires (the stale-token gap)');

-- ── 3. vitals_summary ───────────────────────────────────────────────────────────
select _as('admin', '52000000-0000-0000-0000-000000000001');
--   /a LCP over 28 days: 1000 1500 1500 2000 2500 3000, rank 5 of 6 is 2500, in the bucket
--   2500 closes: the value shown is 2500 and it is within the budget (at most 2500).
select is((_vs('52000000-0000-0000-0000-000000000001', 28, '/a', 'LCP') ->> 'p75')::double precision,
  2500::double precision, 'a range''s p75 is the edge of the bucket holding its 75th percentile');
select is(_vs('52000000-0000-0000-0000-000000000001', 28, '/a', 'LCP') -> 'approx', 'true'::jsonb,
  'and is flagged approximate');
select is((_vs('52000000-0000-0000-0000-000000000001', 28, '/a', 'LCP') ->> 'samples')::int, 6,
  'with the range''s samples');
select ok((_vs('52000000-0000-0000-0000-000000000001', 28, '/a', 'LCP') ->> 'p75')::double precision <= 2500,
  'a true p75 of exactly 2500 is within budget');
select ok((_vs('52000000-0000-0000-0000-000000000001', 28, '/c', 'LCP') ->> 'p75')::double precision > 2500,
  'a true p75 of 2501 is over it (2750)');
select ok((_vs('52000000-0000-0000-0000-000000000001', 28, '/a', 'CLS') ->> 'p75')::double precision <= 0.1,
  'CLS of exactly 0.1 is within its budget');
select is(_vs('52000000-0000-0000-0000-000000000001', 28, '/b', 'LCP'),
  '{"path": "/b", "metric": "LCP", "samples": 1, "p75": 5000, "approx": false, "open": false}'::jsonb,
  'one day''s p75 is the rollup''s exact value');
select is((_vs('52000000-0000-0000-0000-000000000001', 1, '/a', 'LCP')), null,
  'one day back is today only (nothing yet)');
select ok(public.vitals_summary('52000000-0000-0000-0000-000000000001', 28) ->> 'rolled_up_at' is not null,
  'it says when the rollup last changed');
select is(jsonb_array_length(public.vitals_summary('52000000-0000-0000-0000-0000000000ff', 28) -> 'rows'), 0,
  'another tenant named by the Worker: nothing');
select throws_ok($$ select public.vitals_summary('52000000-0000-0000-0000-000000000001', 0) $$,
  '22023', null, 'vitals_summary: 0 days is refused');
select throws_ok($$ select public.vitals_summary('52000000-0000-0000-0000-000000000001', 91) $$,
  '22023', null, 'vitals_summary: 91 days is refused');
select _as('content_creator', '52000000-0000-0000-0000-000000000001');
select is(jsonb_array_length(public.vitals_summary('52000000-0000-0000-0000-000000000001', 28) -> 'rows'), 0,
  'content_creator gets no rows (RLS)');
set local role anon;
select _as(null, null);
select throws_ok($$ select public.vitals_summary('52000000-0000-0000-0000-000000000001', 28) $$,
  '42501', null, 'anon cannot call vitals_summary');

-- ── 4. a late beacon, the busiest 100, the 400-day purge (as the migration role) ──
reset role;
select _vital('52000000-0000-0000-0000-000000000001', 1, 'LCP', 1000, '/b');
select _run(3);
select is(((_row('52000000-0000-0000-0000-000000000001', 1, '/b', 'LCP')).samples,
           (_row('52000000-0000-0000-0000-000000000001', 1, '*', 'LCP')).samples),
          (2, 8), 'a late beacon corrects its day');

-- Day 3, TTFB: paths /p001 to /p100 with two samples each, /p101 with one.
insert into public.web_vitals (tenant_id, occurred_at, metric, value, path)
select '52000000-0000-0000-0000-000000000001', _at(3, 9), 'TTFB', 300, format('/p%s', lpad(g::text, 3, '0'))
  from generate_series(1, 101) g, generate_series(1, 2) r
 where g <= 100 or r = 1;
select _run(3);
select is(
  (select count(*)::int from public.rollup_daily_vitals
    where tenant_id = '52000000-0000-0000-0000-000000000001' and day = _d(3) and metric = 'TTFB'
      and path <> '*'),
  100, 'the 100 busiest paths of a day keep their own row');
select ok(_row('52000000-0000-0000-0000-000000000001', 3, '/p101', 'TTFB') is null
          and (_row('52000000-0000-0000-0000-000000000001', 3, '*', 'TTFB')).samples = 201,
  'the 101st counts in ''*'' only');
delete from public.web_vitals
 where tenant_id = '52000000-0000-0000-0000-000000000001' and path = '/p050';
select _run(3);
select ok(_row('52000000-0000-0000-0000-000000000001', 3, '/p050', 'TTFB') is null
          and _row('52000000-0000-0000-0000-000000000001', 3, '/p101', 'TTFB') is not null,
  'a path that leaves the 100 loses its row, and the next one gains its own');

insert into public.rollup_daily_vitals (tenant_id, day, path, metric, p75, samples, hist) values
  ('52000000-0000-0000-0000-000000000001', _d(401), '*', 'LCP', 1, 1, array_fill(1, array[1]) || array_fill(0, array[24])),
  ('52000000-0000-0000-0000-000000000001', _d(399), '*', 'LCP', 1, 1, array_fill(1, array[1]) || array_fill(0, array[24]));
select _run(3);
select ok(_row('52000000-0000-0000-0000-000000000001', 401, '*', 'LCP') is null
          and _row('52000000-0000-0000-0000-000000000001', 399, '*', 'LCP') is not null,
  'a row older than 400 days is purged; one inside 400 days, outside the window, stays');
select throws_ok($$ insert into public.rollup_daily_vitals (tenant_id, day, path, metric, p75, samples, hist)
                    values ('52000000-0000-0000-0000-000000000001', current_date, '/short', 'LCP', 1, 1, array[1]) $$,
  '23514', null, 'a histogram has 25 buckets (a CHECK)');

-- ── 5. the page-view rollup counts whole days (as the migration role) ─────────────
-- Tenant two, day 3 (the earliest day of a 3-day window): one view just after midnight UTC
-- and one just before the next. 0010 counted from the time of day of the run.
insert into public.analytics_events (tenant_id, occurred_at, event_type, path, locale) values
  ('52000000-0000-0000-0000-0000000000ff', _at(3, 0.01), 'pageview', '/__u2', 'en'),
  ('52000000-0000-0000-0000-0000000000ff', _at(3, 23.99), 'pageview', '/__u2', 'en'),
  ('52000000-0000-0000-0000-0000000000ff', _at(4, 12), 'pageview', '/__u2', 'en');
do $$ begin perform app.rollup_pageviews(3); end $$;
select is((select views::int from public.rollup_daily_pageviews
            where tenant_id = '52000000-0000-0000-0000-0000000000ff' and day = _d(3) and path = '/__u2'),
  2, 'app.rollup_pageviews counts the earliest day of its window whole');
select is((select count(*)::int from public.rollup_daily_pageviews
            where tenant_id = '52000000-0000-0000-0000-0000000000ff' and day = _d(4) and path = '/__u2'),
  0, 'and nothing before it');
select is(app.rollup_pageviews(3), 0, 'a second run rewrites nothing');

-- ── 6. pageview_summary and pageview_paths ────────────────────────────────────────
-- 1,500 rollup rows for tenant one: 30 days, 50 paths; path n has n views a day, English
-- for an even n and Arabic for an odd one. 30 x (1 + ... + 50) = 38,250 views.
insert into public.rollup_daily_pageviews (tenant_id, day, path, locale, views)
select '52000000-0000-0000-0000-000000000001', _d(d), format('/p%s', lpad(p::text, 2, '0')),
       case when p % 2 = 0 then 'en' else 'ar' end, p
  from generate_series(0, 29) d, generate_series(1, 50) p;

set local role authenticated;
select _as('content_creator', '52000000-0000-0000-0000-000000000001');
select is((public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(29), _d(0)) ->> 'total')::int,
  38250, '1,500 rollup rows in range add up whole (no 1,000-row cut)');
select is((select sum((x ->> 'en')::int + (x ->> 'ar')::int)::int
             from jsonb_array_elements(public.pageview_summary('52000000-0000-0000-0000-000000000001',
                                                               _d(29), _d(0)) -> 'by_day') x),
  38250, 'the days add up to the total, English and Arabic apart');
select is(jsonb_array_length(public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(29), _d(0)) -> 'by_day'),
  30, 'one entry per day');
select is(public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(29), _d(0)) -> 'by_locale',
  '[{"locale": "en", "views": 19500}, {"locale": "ar", "views": 18750}]'::jsonb,
  'views by language, the larger first');
select is(public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(29), _d(0)) -> 'top_paths' -> 0,
  '{"path": "/p50", "views": 1500}'::jsonb, 'the busiest page first');
select is(jsonb_array_length(public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(29), _d(0)) -> 'top_paths'),
  20, 'twenty top pages');
select is(public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(6), _d(0)) ->> 'first_day',
  _d(29)::text, 'first_day is the earliest rollup day, whatever the range');
select is((select count(*)::int from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(29), _d(0), 25, 0)),
  25, 'a page of 25 paths');
select is((select max(total_rows)::int from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(29), _d(0), 25, 0)),
  50, 'each row carries the number of paths in range');
select is((select string_agg(p.path, ',' order by p.n)
             from (select x.path, x.n
                     from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(29), _d(0), 25, 0)
                          with ordinality as x(path, views, views_en, views_ar, total_rows, n)
                   union all
                   select y.path, 25 + y.n
                     from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(29), _d(0), 25, 25)
                          with ordinality as y(path, views, views_en, views_ar, total_rows, n)) p),
  (select string_agg(format('/p%s', lpad(g::text, 2, '0')), ',' order by g desc) from generate_series(1, 50) g),
  'two pages are every path once, the busiest first');
select is((select row(x.views, x.views_en, x.views_ar)::text
             from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(29), _d(0), 1, 0) x),
  '(1500,1500,0)', 'a row splits its views by language');
select throws_ok($$ select public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(0), _d(1)) $$,
  '22023', null, 'pageview_summary: a range that ends before it starts is refused');
select throws_ok($$ select public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(400), _d(0)) $$,
  '22023', null, 'pageview_summary: 401 days is refused');
select lives_ok($$ select public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(399), _d(0)) $$,
  'pageview_summary: 400 days is allowed');
select throws_ok($$ select * from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(1), _d(0), 101, 0) $$,
  '22023', null, 'pageview_paths: a page of 101 is refused');
select throws_ok($$ select * from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(1), _d(0), 25, -1) $$,
  '22023', null, 'pageview_paths: a negative offset is refused');
select _as('admin', '52000000-0000-0000-0000-0000000000ff');
select ok((public.pageview_summary('52000000-0000-0000-0000-000000000001', _d(29), _d(0)) ->> 'total')::int = 0
          and (select count(*) from public.pageview_paths('52000000-0000-0000-0000-000000000001', _d(29), _d(0), 25, 0)) = 0,
  'another tenant''s admin naming this tenant gets nothing');

-- ── 7. search_summary ─────────────────────────────────────────────────────────────
reset role;
insert into public.search_queries (tenant_id, q, locale, results_count) values
  ('52000000-0000-0000-0000-000000000001', 'logo', 'en', 5),
  ('52000000-0000-0000-0000-000000000001', 'logo', 'en', 5),
  ('52000000-0000-0000-0000-000000000001', 'logo', 'en', 4),
  ('52000000-0000-0000-0000-000000000001', 'شعار', 'ar', 0),
  ('52000000-0000-0000-0000-000000000001', 'شعار', 'ar', 0),
  ('52000000-0000-0000-0000-000000000001', 'xyz', 'en', 0);
set local role authenticated;
select _as('seo', '52000000-0000-0000-0000-000000000001');
select is((public.search_summary('52000000-0000-0000-0000-000000000001', 30) ->> 'total')::int, 6,
  'seo sees every search');
select is(public.search_summary('52000000-0000-0000-0000-000000000001', 30) -> 'top' -> 0,
  '{"q": "logo", "locale": "en", "hits": 3, "zero": 0}'::jsonb, 'the most frequent first');
select is(public.search_summary('52000000-0000-0000-0000-000000000001', 30) -> 'zero',
  '[{"q": "شعار", "locale": "ar", "hits": 2, "zero": 2}, {"q": "xyz", "locale": "en", "hits": 1, "zero": 1}]'::jsonb,
  'searches that found nothing, the most frequent first');
select is((public.search_summary('52000000-0000-0000-0000-000000000001', 30, 'ar') ->> 'total')::int, 2,
  'filtered to one language');
select throws_ok($$ select public.search_summary('52000000-0000-0000-0000-000000000001', 91) $$,
  '22023', null, 'search_summary: 91 days is refused');
select throws_ok($$ select public.search_summary('52000000-0000-0000-0000-000000000001', 30, 'fr') $$,
  '22023', null, 'search_summary: a language other than en or ar is refused');
select _as('content_creator', '52000000-0000-0000-0000-000000000001');
select is((public.search_summary('52000000-0000-0000-0000-000000000001', 30) ->> 'total')::int, 0,
  'content_creator sees no searches (search_queries'' RLS)');

-- ── 8. content_health ─────────────────────────────────────────────────────────────
reset role;
insert into public.pages (id, tenant_id, slug, title, status) values
  ('52000000-0000-0000-0000-0000000000d1', '52000000-0000-0000-0000-000000000001', 'u2-one', '{"en":"One","ar":"واحد"}', 'published'),
  ('52000000-0000-0000-0000-0000000000d2', '52000000-0000-0000-0000-000000000001', 'u2-two', '{"en":"Two","ar":"اثنان"}', 'published'),
  ('52000000-0000-0000-0000-0000000000d3', '52000000-0000-0000-0000-000000000001', 'u2-draft', '{"en":"Draft","ar":"مسودة"}', 'draft');
insert into public.entity_seo (tenant_id, entity_type, entity_id, meta_title, meta_description) values
  ('52000000-0000-0000-0000-000000000001', 'page', '52000000-0000-0000-0000-0000000000d1',
   '{"en":"One","ar":"واحد"}', '{"en":"About one"}'),
  ('52000000-0000-0000-0000-000000000001', 'page', '52000000-0000-0000-0000-0000000000d3',
   '{"en":"Draft"}', '{"en":"A draft"}');
insert into public.seo_defaults (tenant_id, default_description) values
  ('52000000-0000-0000-0000-000000000001', '{"en":"A studio","ar":" "}');
insert into public.portfolio (tenant_id, slug, title, status, is_placeholder) values
  ('52000000-0000-0000-0000-000000000001', 'u2-sample', '{"en":"S","ar":"ع"}', 'published', true);
insert into public.testimonials (tenant_id, slug, quote, author_name, status, placements) values
  ('52000000-0000-0000-0000-000000000001', 'u2-quote', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'draft', '{home}');
set local role authenticated;
select _as('developer', '52000000-0000-0000-0000-000000000001');
select is(public.content_health('52000000-0000-0000-0000-000000000001'),
  '{"placeholders_live": 1, "missing_alt": 0, "consent_missing": 1, "published": 3,
    "own_description": 1, "missing_arabic": 1, "default_description_en": true,
    "default_description_ar": false}'::jsonb,
  'the checklist''s counts: a live sample, a quote without consent, three published entities, one with its own description, one with English search text and no Arabic, the default in English only');
select _as('content_creator', '52000000-0000-0000-0000-000000000001');
select is((public.content_health('52000000-0000-0000-0000-000000000001') ->> 'published')::int, 3,
  'every staff role counts the same rows');
select _as('admin', '52000000-0000-0000-0000-0000000000ff');
select is(public.content_health('52000000-0000-0000-0000-000000000001'), null,
  'another tenant''s admin naming this tenant gets nothing');

-- ── 9. who executes and reads what ────────────────────────────────────────────────
reset role;
select ok(app.role_site_health('admin') and app.role_site_health('developer')
          and not app.role_site_health('content_creator') and not app.role_site_health('seo')
          and not app.role_site_health(null),
  'app.role_site_health answers siteHealth.view: Admin and Developer');
select ok(app.role_analytics_read('admin') and app.role_analytics_read('content_creator')
          and app.role_analytics_read('seo') and app.role_analytics_read('developer')
          and not app.role_analytics_read('anon') and not app.role_analytics_read(null),
  'app.role_analytics_read answers analytics.read: the four staff roles');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, f.fn), ', ' order by f.fn, w.who), '')
     from (values ('public.vitals_summary(uuid, integer)'),
                  ('public.pageview_summary(uuid, date, date)'),
                  ('public.pageview_paths(uuid, date, date, integer, integer)'),
                  ('public.search_summary(uuid, integer, text)'),
                  ('public.content_health(uuid)')) as f(fn)
     cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, f.fn, 'execute') is distinct from (w.who = 'authenticated')),
  '', 'the five readers: authenticated executes them, PUBLIC, anon and the service role do not');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, f.fn), ', ' order by f.fn, w.who), '')
     from (values ('app.rollup_vitals(integer)'), ('app.rollup_pageviews(integer)'),
                  ('app.help_article_set()')) as f(fn)
     cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, f.fn, 'execute')),
  '', 'no API role runs a rollup or reads the help set');
select is(
  (select coalesce(string_agg(w.who, ', ' order by w.who), '')
     from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, 'app.vitals_edges(text)', 'execute')
          is distinct from (w.who = 'authenticated')),
  '', 'the bucket edges: authenticated alone (vitals_summary reads them as its caller)');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, p.priv), ', ' order by w.who, p.priv), '')
     from (values ('public', array[]::text[]), ('anon', array[]::text[]),
                  ('authenticated', array['select']),
                  ('service_role', array['select', 'insert', 'update', 'delete'])) as w(who, allowed)
     cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                        ('references'), ('trigger')) as p(priv)
    where has_table_privilege(w.who, 'public.rollup_daily_vitals', p.priv)
          is distinct from (p.priv = any (w.allowed))),
  '', 'rollup_daily_vitals: staff SELECT, the service role the four writes, PUBLIC and anon nothing');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, p.priv), ', ' order by w.who, p.priv), '')
     from (values ('public'), ('anon'), ('authenticated')) as w(who)
     cross join (values ('select'), ('insert'), ('update'), ('references')) as p(priv)
    where has_any_column_privilege(w.who, 'public.rollup_daily_vitals', p.priv)
          and not (w.who = 'authenticated' and p.priv = 'select')),
  '', 'and no column grant widens it');
select is(
  (select coalesce(string_agg(format('%s %s %s', policyname, cmd, roles), '; ' order by tablename, policyname), '')
     from pg_policies
    where schemaname = 'public' and tablename in ('rollup_daily_vitals', 'rollup_daily_pageviews')),
  'rollup_read SELECT {authenticated}; rollup_vitals_read SELECT {authenticated}',
  'one read policy on each rollup, for staff');

select * from finish();
rollback;
