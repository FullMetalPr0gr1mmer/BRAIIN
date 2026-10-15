-- ─────────────────────────────────────────────────────────────────────────────
-- 0052 — Website stats and site health read rollups, never raw telemetry (Admin v2 U2,
-- AV-10). Forward-only, expand only. Depends on 0001 (tenants, pages, app.current_role,
-- app.effective_tenant_id), 0002 (web_vitals, rollup_daily_pageviews and its rollup_read),
-- 0009 (search_queries, entity_seo, seo_defaults), 0010 (app.rollup_pageviews and the
-- pg_cron pattern), 0025 and 0028 (dashboard_attention), 0037 (the read-only tables'
-- grants) and 0046 (the help set and its seed).
--
-- Three live defects, ended here:
--   1. SITE HEALTH READ RAW TELEMETRY. GET /api/admin/site-health selected up to 20,000
--      web_vitals rows and took a nearest-rank p75 in the Worker. CLAUDE.md Pillar 4 says
--      dashboards read rollup_* only; PostgREST returns 1,000 rows at most anyway, so the
--      p75 was of whichever 1,000 rows came back.
--   2. LONG RANGES WERE CUT. The stats routes asked for 5,000 rollup or search rows and got
--      1,000. Every reader below aggregates in SQL and returns one answer.
--   3. EVERY DAY'S PAGE VIEWS WERE UNDERCOUNTED. app.rollup_pageviews (0010) recomputed the
--      trailing 72 hours, not whole days, and its upsert is a SET: the earliest day in the
--      window was set to the count of its rows after the time of day of the run. Run every
--      15 minutes, each day's total was finally fixed at about its last quarter hour (the
--      last run that still saw a row of it). Restated over whole UTC days, and the raw
--      horizon (90 days, which the partition purge always keeps whole) re-rolled once below.
--
-- WHAT IT ADDS
--   • app.role_site_health(r) (siteHealth.view) and app.role_analytics_read(r)
--     (analytics.read): one helper per capability (CLAUDE.md §8), held equal to ROLE_CAPS by
--     tests/authz/sqlHelpers.spec.ts. rollup_read on rollup_daily_pageviews is restated on
--     the second (the same four roles app.is_staff() names today), so a role that gains
--     analytics.read gains the stats through one helper.
--   • public.rollup_daily_vitals: one row per tenant, UTC day, path and metric, with the
--     day's exact p75 (percentile_disc), its sample count and a histogram over fixed buckets
--     (app.vitals_edges). '*' is every path together. A derived rollup like
--     rollup_daily_pageviews: no id and no actor columns. Admin and Developer read their
--     tenant's rows (siteHealth.view); nothing but the service role and the rollup writes.
--   • app.rollup_vitals(p_days): recomputes the last p_days whole UTC days and today from
--     web_vitals for every tenant (a SET, so a late beacon corrects its day; rows the run no
--     longer produces in that window are removed), keeps the 100 busiest paths per tenant,
--     day and metric (the rest count in '*' only), then purges rows older than 400 days.
--     Hourly by pg_cron ('rollup-vitals', minute 7), not the Worker's cron, which is near its
--     50-subrequest budget.
--   • The readers, SECURITY INVOKER (RLS and the helpers decide): vitals_summary (any
--     range's p75 from the summed histograms), pageview_summary and pageview_paths (the
--     stats screens), search_summary (the search tab), content_health (the checklist's
--     content and SEO counts). Each takes the tenant from the Worker and answers nothing
--     unless it is the token's (crm_people's rule).
--   • The help set, restated from 0046's text: only "website-stats" and
--     "site-health-and-logs" change (the stats tabs and ranges; the score, the checklist,
--     Speed and Errors on the health screen, which no longer lists /admin/logs). Seeded
--     into every tenant again.
--
-- WHY HISTOGRAMS. A 28-day p75 cannot be built from 28 daily p75s. Each day keeps how many
-- samples fell in each fixed bucket; summing the buckets over a range and finding the one
-- that holds the 75th percentile gives that range's p75 to within one bucket. The CLAUDE.md
-- §6 budgets and web.dev's "poor" thresholds are bucket edges, and a bucket holds the values
-- above its lower edge up to and including its upper edge, so "within budget" (at most the
-- threshold, web.dev's "good") is exact even where the value shown is a bucket's edge.
--
-- THE BACKFILLS (data effects; check volumes read-only before the push). app.rollup_vitals(90)
-- aggregates the last 90 days of web_vitals and app.rollup_pageviews(90) the last 90 days of
-- page views in analytics_events, each in one pass: a grouped scan of the partitions in that
-- window. Measured on PGlite (PostgreSQL 17 in WebAssembly, slower than a server) at about
-- 2 s per 100,000 web_vitals rows and 0.4 s per 100,000 page views; production's volume is
-- modest, so a few seconds at most. Both are idempotent: run again, they write nothing.
--
-- Production as of 2026-10-15: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046,
-- 0048, 0050 and 0051. Grants are stated for both Supabase privilege regimes (README P-14).
-- CLAUDE.md §3 (Pillars 1 and 4), §5, §6, §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0051): restating rollup_read
-- takes an ACCESS EXCLUSIVE lock on rollup_daily_pageviews, which the 15-minute rollup writes.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. One helper per capability ----------------------------------------------------------
-- `language sql immutable`, so the planner inlines them (as app.role_works_leads, 0033). Staff
-- and the service role execute them: a policy runs its expression as the querying role.
create or replace function app.role_site_health(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- siteHealth.view
revoke all on function app.role_site_health(text) from public, anon, authenticated, service_role;
grant execute on function app.role_site_health(text) to authenticated, service_role;

create or replace function app.role_analytics_read(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'content_creator', 'developer', 'seo'), false) $$;  -- analytics.read
revoke all on function app.role_analytics_read(text) from public, anon, authenticated, service_role;
grant execute on function app.role_analytics_read(text) to authenticated, service_role;

-- ---- 2. rollup_read on the helper ----------------------------------------------------------
-- The same four roles as app.is_staff() (0002's text), through the analytics.read helper. TO
-- authenticated: anon holds no privilege on the table (0037), so it never reached the policy.
drop policy if exists rollup_read on public.rollup_daily_pageviews;
create policy rollup_read on public.rollup_daily_pageviews for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_read(app.current_role()));

-- ---- 3. The page-view rollup over whole UTC days -------------------------------------------
-- The same signature, kept privileges (0011: no API role executes it) and job; the window now
-- starts at midnight UTC p_days days ago, so the earliest day is counted whole. A row whose
-- count did not change is not rewritten.
create or replace function app.rollup_pageviews(p_days int default 3)
  returns int
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_since timestamptz :=
    (((pg_catalog.now() at time zone 'UTC')::date - least(greatest(coalesce(p_days, 3), 1), 90))
       ::timestamp at time zone 'UTC');
  n int;
begin
  insert into public.rollup_daily_pageviews as r (tenant_id, day, path, locale, views)
  select e.tenant_id,
         (e.occurred_at at time zone 'UTC')::date,
         e.path,
         coalesce(e.locale, 'en'),
         count(*)
    from public.analytics_events e
   where e.event_type = 'pageview'
     and e.path is not null
     and e.occurred_at >= v_since
   group by 1, 2, 3, 4
  on conflict (tenant_id, day, path, locale)
    do update set views = excluded.views
    where r.views is distinct from excluded.views;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function app.rollup_pageviews(int) from public, anon, authenticated, service_role;

-- ---- 4. The buckets ------------------------------------------------------------------------
-- 24 upper edges per metric (25 buckets, the last open above the last edge). The §6 budgets
-- (LCP 2500 ms, INP 200 ms, CLS 0.1, and FCP 1800 ms, TTFB 800 ms, which are informational)
-- and web.dev's "poor" thresholds (4000, 500, 0.25, 3000, 1800) are edges. Mirrored by
-- VITALS_EDGES in src/lib/admin/health/vitals.ts; tests/lib/vitals.spec.ts holds the two
-- equal. Milliseconds, except CLS (unitless).
create or replace function app.vitals_edges(p_metric text) returns double precision[]
  language sql immutable set search_path = ''
as $$
  select case p_metric
    when 'LCP' then array[250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000,
                          3250, 3500, 3750, 4000, 4500, 5000, 6000, 7000, 8000, 10000, 15000, 20000]
    when 'INP' then array[25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400,
                          450, 500, 600, 700, 800, 1000, 1250, 1500, 2000, 3000, 5000, 10000]
    when 'CLS' then array[0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.125, 0.15,
                          0.175, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2, 3]
    when 'FCP' then array[200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400,
                          2600, 2800, 3000, 3500, 4000, 5000, 6000, 8000, 10000, 15000, 20000, 30000]
    when 'TTFB' then array[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200,
                           1300, 1400, 1500, 1600, 1700, 1800, 2000, 2500, 3000, 4000, 6000, 10000]
  end::double precision[]
$$;
-- The rollup (as its owner) and vitals_summary (as its caller: an invoker, so RLS decides
-- what it reads) use it. The edges are constants published in this file.
revoke all on function app.vitals_edges(text) from public, anon, authenticated, service_role;
grant execute on function app.vitals_edges(text) to authenticated;

-- ---- 5. The vitals rollup table ------------------------------------------------------------
create table if not exists public.rollup_daily_vitals (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,                     -- UTC day, as rollup_daily_pageviews
  path text not null,                    -- normalised; '*' is every path together
  metric text not null check (metric in ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')),
  p75 double precision not null,         -- percentile_disc(0.75): exact for the day
  samples integer not null check (samples > 0),
  -- Counts per bucket of app.vitals_edges(metric): 24 edges for every metric, so 25 buckets.
  -- A constant rather than a call, so a writer needs no EXECUTE on the edges.
  hist integer[] not null
    check (cardinality(hist) = 25 and array_ndims(hist) = 1 and array_lower(hist, 1) = 1
           and array_position(hist, null) is null),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day, path, metric)
);
alter table public.rollup_daily_vitals enable row level security;
alter table public.rollup_daily_vitals force row level security;

-- Admin and Developer read their tenant's rows (siteHealth.view). No write policy: the rollup
-- writes as its owner and the service role bypasses RLS.
drop policy if exists rollup_vitals_read on public.rollup_daily_vitals;
create policy rollup_vitals_read on public.rollup_daily_vitals for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_site_health(app.current_role()));

-- Stated for both grant regimes (P-14, as 0037 states the tables staff only read): staff
-- SELECT, the service role SELECT, INSERT, UPDATE and DELETE, PUBLIC and anon nothing. No
-- sequence (the key is natural).
revoke all on public.rollup_daily_vitals from public, anon, authenticated, service_role;
grant select on public.rollup_daily_vitals to authenticated;
grant select, insert, update, delete on public.rollup_daily_vitals to service_role;

-- ---- 6. The vitals rollup ------------------------------------------------------------------
-- A path is cut at its query and its fragment, then at 200 characters; one that does not
-- start with '/' afterwards (none, an empty one, a '*' sent by a client) counts in '*' only, so
-- it can never collide with the site-wide row. Of the rest, the 100 paths with the most
-- samples per tenant, day and metric keep their own row. A bucket holds the values above its
-- lower edge up to and including its upper edge: width_bucket counts the edges at or below
-- the value, so a value equal to an edge is moved down one.
create or replace function app.rollup_vitals(p_days int default 3)
  returns int
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_day date := ((pg_catalog.now() at time zone 'UTC')::date
                 - least(greatest(coalesce(p_days, 3), 1), 90));
  v_since timestamptz := (v_day::timestamp at time zone 'UTC');
  n int;
begin
  -- This run's rows, kept for the upsert and the clean-up after it (dropped at commit; a
  -- second run in the same transaction empties it).
  if to_regclass('pg_temp._vitals_rollup') is null then
    create temporary table _vitals_rollup (
      tenant_id uuid, day date, path text, metric text, p75 double precision, samples int,
      hist int[]
    ) on commit drop;
  else
    truncate pg_temp._vitals_rollup;
  end if;

  with raw as (
    select w.tenant_id,
           (w.occurred_at at time zone 'UTC')::date as day,
           case when left(split_part(split_part(w.path, '?', 1), '#', 1), 200) like '/%'
                then left(split_part(split_part(w.path, '?', 1), '#', 1), 200) end as path,
           w.metric,
           w.value,
           width_bucket(w.value, app.vitals_edges(w.metric))
             - (w.value = any (app.vitals_edges(w.metric)))::int + 1 as b
      from public.web_vitals w
     where w.occurred_at >= v_since
       and w.metric in ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')
  ),
  paths as (
    select r.tenant_id, r.day, r.path, r.metric, count(*) as samples,
           row_number() over (partition by r.tenant_id, r.day, r.metric
                              order by count(*) desc, r.path) as rn
      from raw r
     where r.path is not null
     group by r.tenant_id, r.day, r.path, r.metric
  ),
  rows_in as (
    -- Each sample once per row it counts in: its path's (when kept) and '*'.
    select r.tenant_id, r.day, r.path, r.metric, r.value, r.b
      from raw r
      join paths p using (tenant_id, day, path, metric)
     where p.rn <= 100
    union all
    select r.tenant_id, r.day, '*', r.metric, r.value, r.b
      from raw r
  ),
  stats as (
    select i.tenant_id, i.day, i.path, i.metric,
           percentile_disc(0.75) within group (order by i.value) as p75,
           count(*)::int as samples
      from rows_in i
     group by i.tenant_id, i.day, i.path, i.metric
  ),
  counts as (
    select i.tenant_id, i.day, i.path, i.metric, i.b, count(*)::int as c
      from rows_in i
     group by i.tenant_id, i.day, i.path, i.metric, i.b
  ),
  hists as (
    -- Every bucket of every row, the empty ones as 0, in bucket order.
    select s.tenant_id, s.day, s.path, s.metric,
           array_agg(coalesce(c.c, 0) order by k.k) as hist
      from stats s
      cross join generate_series(1, 25) as k(k)
      left join counts c
        on c.tenant_id = s.tenant_id and c.day = s.day and c.path = s.path
       and c.metric = s.metric and c.b = k.k
     group by s.tenant_id, s.day, s.path, s.metric
  )
  insert into pg_temp._vitals_rollup (tenant_id, day, path, metric, p75, samples, hist)
  select s.tenant_id, s.day, s.path, s.metric, s.p75, s.samples, h.hist
    from stats s
    join hists h using (tenant_id, day, path, metric);

  -- A SET, not an increment: a late beacon corrects its day.
  insert into public.rollup_daily_vitals as v (tenant_id, day, path, metric, p75, samples, hist)
  select t.tenant_id, t.day, t.path, t.metric, t.p75, t.samples, t.hist
    from pg_temp._vitals_rollup t
  on conflict (tenant_id, day, path, metric) do update
     set p75 = excluded.p75, samples = excluded.samples, hist = excluded.hist,
         updated_at = pg_catalog.now()
   where (v.p75, v.samples, v.hist) is distinct from (excluded.p75, excluded.samples, excluded.hist);
  get diagnostics n = row_count;

  -- In the window, a row this run did not produce (a path that left the busiest 100) goes.
  delete from public.rollup_daily_vitals v
   where v.day >= v_day
     and not exists (select 1 from pg_temp._vitals_rollup t
                      where t.tenant_id = v.tenant_id and t.day = v.day
                        and t.path = v.path and t.metric = v.metric);

  -- Thirteen months, so a month has its year-ago twin (paths and numbers: not personal data).
  delete from public.rollup_daily_vitals v
   where v.day < (pg_catalog.now() at time zone 'UTC')::date - 400;

  return n;
end $$;
revoke all on function app.rollup_vitals(int) from public, anon, authenticated, service_role;

-- ---- 7. Scheduled every hour (the 0010 pattern) --------------------------------------------
-- Vitals move slowly, and each run scans four days of raw rows (three whole days and today).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job where jobname = 'rollup-vitals';
    perform cron.schedule('rollup-vitals', '7 * * * *', $job$ select app.rollup_vitals(3) $job$);
  else
    raise notice 'pg_cron not installed: schedule app.rollup_vitals(3) hourly by hand';
  end if;
end $$;

-- ---- 8. The backfills ----------------------------------------------------------------------
-- The raw horizon (RAW_TELEMETRY_RETENTION, 90 days), once each. See the header for the cost.
select app.rollup_vitals(90);
select app.rollup_pageviews(90);

-- ---- 9. The readers (INVOKER: RLS and the helpers decide) ----------------------------------
-- Each takes the tenant from the Worker as well, and answers nothing unless it is the
-- token's: a handler that forgot to scope gets nothing rather than a guess. A bound the
-- Worker would never send is a 22023.

-- Any range's vitals: per path and metric, the samples and the p75. One day's p75 is the
-- rollup's exact value; over more days it is the upper edge of the bucket that holds the 75th
-- percentile of the summed histograms (`approx`), and `open` when that is the last, open
-- bucket (the value is then the last edge: "over"). '*' always; of the paths, the 100 with the
-- most samples in the range.
create or replace function public.vitals_summary(p_tenant uuid, p_days int)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
declare
  v_from date;
begin
  if p_days is null or p_days not between 1 and 90 then
    raise exception using errcode = '22023', message = 'vitals_summary: p_days is 1 to 90';
  end if;
  v_from := (pg_catalog.now() at time zone 'UTC')::date - (p_days - 1);
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('days', p_days, 'from', v_from, 'rolled_up_at', null,
                              'rows', '[]'::jsonb);
  end if;
  return (
    with r as (
      select v.path, v.metric, v.day, v.p75, v.samples, v.hist, v.updated_at
        from public.rollup_daily_vitals v
       where v.tenant_id = p_tenant and v.day >= v_from
    ),
    g as (
      select r.path, r.metric, sum(r.samples)::bigint as samples, count(*)::int as days,
             min(r.p75) as day_p75
        from r
       group by r.path, r.metric
    ),
    kept as (
      select x.path
        from (select g.path, row_number() over (order by sum(g.samples) desc, g.path) as rn
                from g
               where g.path <> '*'
               group by g.path) x
       where x.rn <= 100
      union all
      select '*'
    ),
    buckets as (
      select r.path, r.metric, b.i::int as i, sum(b.c)::bigint as c
        from r
        cross join lateral unnest(r.hist) with ordinality as b(c, i)
       where r.path in (select k.path from kept k)
       group by r.path, r.metric, b.i
    ),
    running as (
      select b.path, b.metric, b.i,
             sum(b.c) over (partition by b.path, b.metric order by b.i) as upto
        from buckets b
    ),
    picked as (
      select u.path, u.metric, min(u.i) as k
        from running u
        join g on g.path = u.path and g.metric = u.metric
       where u.upto >= ceil(0.75 * g.samples)
       group by u.path, u.metric
    ),
    out as (
      select g.path, g.metric, g.samples, g.days,
             case when g.days = 1 then g.day_p75
                  else (app.vitals_edges(g.metric))[least(p.k, 24)] end as p75,
             g.days > 1 as approx,
             g.days > 1 and p.k = 25 as open
        from g
        join picked p on p.path = g.path and p.metric = g.metric
    )
    select jsonb_build_object(
             'days', p_days,
             'from', v_from,
             'rolled_up_at', (select max(r.updated_at) from r),
             'rows', coalesce((select jsonb_agg(jsonb_build_object(
                                        'path', o.path, 'metric', o.metric,
                                        'samples', o.samples, 'p75', o.p75,
                                        'approx', o.approx, 'open', o.open)
                                      order by (o.path = '*') desc, o.samples desc, o.path, o.metric)
                                 from out o), '[]'::jsonb))
  );
end $$;

-- The stats overview: page views in [p_from, p_to] (UTC days, both ends included), at most
-- 400 days. `first_day` is the tenant's earliest rollup day, so the screen shows a change
-- only when the rollups hold the previous period too.
create or replace function public.pageview_summary(p_tenant uuid, p_from date, p_to date)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= 400 then
    raise exception using errcode = '22023', message = 'pageview_summary: a range of 1 to 400 days';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('total', 0, 'by_day', '[]'::jsonb, 'by_locale', '[]'::jsonb,
                              'top_paths', '[]'::jsonb, 'first_day', null);
  end if;
  return (
    with r as (
      select v.day, v.path, v.locale, v.views
        from public.rollup_daily_pageviews v
       where v.tenant_id = p_tenant and v.day between p_from and p_to
    )
    select jsonb_build_object(
             'total', coalesce((select sum(r.views) from r), 0),
             'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'en', d.en, 'ar', d.ar)
                                                  order by d.day)
                                   from (select r.day,
                                                coalesce(sum(r.views) filter (where r.locale = 'en'), 0) as en,
                                                coalesce(sum(r.views) filter (where r.locale = 'ar'), 0) as ar
                                           from r group by r.day) d), '[]'::jsonb),
             'by_locale', coalesce((select jsonb_agg(jsonb_build_object('locale', l.locale, 'views', l.views)
                                                     order by l.views desc, l.locale)
                                      from (select r.locale, sum(r.views) as views
                                              from r group by r.locale) l), '[]'::jsonb),
             'top_paths', coalesce((select jsonb_agg(jsonb_build_object('path', t.path, 'views', t.views)
                                                     order by t.views desc, t.path)
                                      from (select r.path, sum(r.views) as views
                                              from r group by r.path
                                             order by sum(r.views) desc, r.path
                                             limit 20) t), '[]'::jsonb),
             'first_day', (select min(v.day) from public.rollup_daily_pageviews v
                            where v.tenant_id = p_tenant))
  );
end $$;

-- The Pages tab: one page of paths, the busiest first (ties by path, so paging is stable),
-- each row carrying the number of paths in the range.
create or replace function public.pageview_paths(p_tenant uuid, p_from date, p_to date,
                                                 p_limit int, p_offset int)
  returns table (path text, views bigint, views_en bigint, views_ar bigint, total_rows bigint)
  language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= 400 then
    raise exception using errcode = '22023', message = 'pageview_paths: a range of 1 to 400 days';
  end if;
  if p_limit is null or p_limit not between 1 and 100
     or p_offset is null or p_offset not between 0 and 100000 then
    raise exception using errcode = '22023', message = 'pageview_paths: a page bound is out of range';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    return;
  end if;
  return query
    select x.path, x.views, x.views_en, x.views_ar, count(*) over () as total_rows
      from (select v.path,
                   sum(v.views)::bigint as views,
                   coalesce(sum(v.views) filter (where v.locale = 'en'), 0)::bigint as views_en,
                   coalesce(sum(v.views) filter (where v.locale = 'ar'), 0)::bigint as views_ar
              from public.rollup_daily_pageviews v
             where v.tenant_id = p_tenant and v.day between p_from and p_to
             group by v.path) x
     order by x.views desc, x.path
     limit p_limit offset p_offset;
end $$;

-- The search tab: the searches of the last p_days days (search_queries' RLS keeps Content
-- Creator out), the 50 most frequent and the 50 that found nothing most often.
create or replace function public.search_summary(p_tenant uuid, p_days int, p_locale text default null)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_days is null or p_days not between 1 and 90 then
    raise exception using errcode = '22023', message = 'search_summary: p_days is 1 to 90';
  end if;
  if p_locale is not null and p_locale not in ('en', 'ar') then
    raise exception using errcode = '22023', message = 'search_summary: p_locale is en or ar';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('total', 0, 'top', '[]'::jsonb, 'zero', '[]'::jsonb);
  end if;
  return (
    with q as (
      select s.q, s.locale, count(*)::int as hits,
             (count(*) filter (where s.results_count = 0))::int as zero
        from public.search_queries s
       where s.tenant_id = p_tenant
         and s.occurred_at >= pg_catalog.now() - make_interval(days => p_days)
         and (p_locale is null or s.locale = p_locale)
       group by s.q, s.locale
    )
    select jsonb_build_object(
             'total', coalesce((select sum(q.hits) from q), 0),
             'top', coalesce((select jsonb_agg(jsonb_build_object('q', t.q, 'locale', t.locale,
                                                                  'hits', t.hits, 'zero', t.zero)
                                               order by t.hits desc, t.q, t.locale)
                                from (select * from q order by q.hits desc, q.q, q.locale limit 50) t),
                             '[]'::jsonb),
             'zero', coalesce((select jsonb_agg(jsonb_build_object('q', t.q, 'locale', t.locale,
                                                                   'hits', t.hits, 'zero', t.zero)
                                                order by t.zero desc, t.hits desc, t.q, t.locale)
                                 from (select * from q where q.zero > 0
                                        order by q.zero desc, q.hits desc, q.q, q.locale
                                        limit 50) t),
                              '[]'::jsonb))
  );
end $$;

-- The checklist's content and SEO counts in one read (site health, src/lib/admin/health):
-- live design placeholders, published projects with an image missing alt text and placed
-- testimonials without consent (dashboard_attention, as the dashboard lists them); the
-- published services, posts, projects and pages, how many have their own search
-- description, and how many have English search text with no Arabic beside it; and whether
-- the site's default description is written in each language. Every row read is one staff
-- may read; nothing here is gated past app.is_staff().
create or replace function public.content_health(p_tenant uuid)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_tenant is distinct from app.effective_tenant_id() then
    return null;
  end if;
  return (
    with pub as (
      select 'service'::text as kind, s.id from public.services s
       where s.tenant_id = p_tenant and s.status = 'published'
      union all
      select 'blog_post', b.id from public.blog_posts b
       where b.tenant_id = p_tenant and b.status = 'published'
      union all
      select 'portfolio', p.id from public.portfolio p
       where p.tenant_id = p_tenant and p.status = 'published'
      union all
      select 'page', g.id from public.pages g
       where g.tenant_id = p_tenant and g.status = 'published'
    ),
    seo as (
      select nullif(btrim(e.meta_title ->> 'en'), '') as title_en,
             nullif(btrim(e.meta_title ->> 'ar'), '') as title_ar,
             nullif(btrim(e.meta_description ->> 'en'), '') as desc_en,
             nullif(btrim(e.meta_description ->> 'ar'), '') as desc_ar
        from pub
        left join public.entity_seo e
          on e.tenant_id = p_tenant and e.entity_type = pub.kind and e.entity_id = pub.id
    ),
    attention as (
      select a.kind from public.dashboard_attention a
       where a.kind in ('placeholder_live', 'missing_alt', 'consent_missing')
    ),
    defaults as (
      select nullif(btrim(d.default_description ->> 'en'), '') as en,
             nullif(btrim(d.default_description ->> 'ar'), '') as ar
        from public.seo_defaults d
       where d.tenant_id = p_tenant
    )
    select jsonb_build_object(
             'placeholders_live', (select count(*) from attention where kind = 'placeholder_live'),
             'missing_alt', (select count(*) from attention where kind = 'missing_alt'),
             'consent_missing', (select count(*) from attention where kind = 'consent_missing'),
             'published', (select count(*) from seo),
             'own_description', (select count(*) from seo where desc_en is not null),
             'missing_arabic', (select count(*) from seo
                                 where (title_en is not null and title_ar is null)
                                    or (desc_en is not null and desc_ar is null)),
             'default_description_en', coalesce((select en is not null from defaults), false),
             'default_description_ar', coalesce((select ar is not null from defaults), false))
  );
end $$;

-- ---- 10. Grants on the readers (P-14) ------------------------------------------------------
revoke all on function public.vitals_summary(uuid, int) from public, anon, authenticated, service_role;
revoke all on function public.pageview_summary(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.pageview_paths(uuid, date, date, int, int) from public, anon, authenticated, service_role;
revoke all on function public.search_summary(uuid, int, text) from public, anon, authenticated, service_role;
revoke all on function public.content_health(uuid) from public, anon, authenticated, service_role;
grant execute on function public.vitals_summary(uuid, int) to authenticated;
grant execute on function public.pageview_summary(uuid, date, date) to authenticated;
grant execute on function public.pageview_paths(uuid, date, date, int, int) to authenticated;
grant execute on function public.search_summary(uuid, int, text) to authenticated;
grant execute on function public.content_health(uuid) to authenticated;

-- ---- 11. The guides ------------------------------------------------------------------------
-- 0046's set, restated: every guide as 0046 wrote it except "website-stats" and
-- "site-health-and-logs" (U2). A later slice that restates the set starts from this text.
-- packages/schemas/help.ts and tests/lib/helpCentre.spec.ts hold it as they hold 0046's.
create or replace function app.help_article_set() returns jsonb
  language sql immutable set search_path = '' as $fn$
  select $help$
[
  {
    "slug": "finding-your-way",
    "sort_order": 10,
    "minutes": 2,
    "tags": [
      "basics"
    ],
    "screens": [
      "/admin",
      "/admin/search",
      "/admin/help"
    ],
    "caps": [],
    "title": "Finding your way around",
    "title_ar": "التنقل في لوحة الإدارة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The menu on the left shows only the screens your role can use. If you expect a screen and cannot find it, your role does not include it: ask an Admin."
        },
        {
          "t": "h",
          "x": "Getting around faster"
        },
        {
          "t": "ol",
          "x": [
            "Search: press Ctrl K, or ⌘K on a Mac, or click Search anything at the top. Type a few letters to jump to a screen or to find a page, service, project or post.",
            "The bell lists what arrived or changed for you lately.",
            "Your name at the bottom of the menu opens your account.",
            "View site opens the public site in a new tab, so you can check your work.",
            "The Help centre button at the top, an i in a circle, opens these guides, starting with the ones for the screen you are on."
          ]
        },
        {
          "t": "tip",
          "x": "Search never lists leads or job applications. They hold personal details, so they have their own screens, and every look at contact details is logged."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعرض القائمة على اليسار الشاشات التي يتيحها دورك فقط. إذا توقعت شاشة ولم تجدها فهي ليست ضمن صلاحيات دورك، فاطلبها من أحد المسؤولين (Admin)."
        },
        {
          "t": "h",
          "x": "للتنقل بسرعة أكبر"
        },
        {
          "t": "ol",
          "x": [
            "البحث: اضغط Ctrl K، أو ⌘K على أجهزة ماك، أو انقر على Search anything في الأعلى. اكتب بضعة أحرف للانتقال إلى شاشة أو للعثور على صفحة أو خدمة أو مشروع أو مقال.",
            "يعرض الجرس ما وصلك أو تغيّر لك مؤخرًا.",
            "يفتح اسمك أسفل القائمة صفحة حسابك.",
            "يفتح View site الموقع العام في تبويب جديد لتتحقق من عملك.",
            "يفتح زر Help centre في الأعلى، وهو حرف i داخل دائرة، هذه الأدلة، بدءًا بأدلة الشاشة التي أنت عليها."
          ]
        },
        {
          "t": "tip",
          "x": "لا يعرض البحث العملاء المحتملين ولا طلبات التوظيف أبدًا، لأنها تحتوي على بيانات شخصية، فلها شاشاتها الخاصة، وكل اطلاع على بيانات التواصل يُسجَّل."
        }
      ]
    }
  },
  {
    "slug": "your-account",
    "sort_order": 20,
    "minutes": 3,
    "tags": [
      "account",
      "basics"
    ],
    "screens": [
      "/admin/account",
      "/admin/notifications"
    ],
    "caps": [],
    "title": "Your account, password and bell",
    "title_ar": "حسابك وكلمة المرور والإشعارات",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Your account holds your display name (shown at the bottom of the menu and, to Admins, in Users & roles), your password, and a plain list of what your role can do. Open it from your name at the bottom of the menu."
        },
        {
          "t": "h",
          "x": "Changing your password"
        },
        {
          "t": "ol",
          "x": [
            "Type your current password, then the new one twice. A new password has at least 10 characters.",
            "Five wrong current passwords within 15 minutes lock your account for 15 minutes, as on the sign-in page.",
            "Once the change goes through, every other device you are signed in on is signed out. This one stays signed in."
          ]
        },
        {
          "t": "h",
          "x": "Your e-mail address"
        },
        {
          "t": "p",
          "x": "Changing it needs outgoing e-mail, which is not set up yet, so your account shows Not set up for now."
        },
        {
          "t": "h",
          "x": "The bell"
        },
        {
          "t": "ol",
          "x": [
            "It shows up to 30 items from the last 14 days: new inquiries and job applications for the roles that handle them, services and posts going live today for the roles that write them, and maintenance switched on or off for everyone.",
            "Mark all as read marks what you were shown. Anything that arrives while the list is open stays new."
          ]
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يضم حسابك اسم العرض (ويظهر أسفل القائمة، وللمسؤولين في Users & roles)، وكلمة المرور، وقائمة واضحة بما يستطيع دورك فعله. افتحه من اسمك أسفل القائمة."
        },
        {
          "t": "h",
          "x": "تغيير كلمة المرور"
        },
        {
          "t": "ol",
          "x": [
            "اكتب كلمة المرور الحالية، ثم الجديدة مرتين. يجب ألا تقل كلمة المرور الجديدة عن 10 أحرف.",
            "خمس محاولات خاطئة لكلمة المرور الحالية خلال 15 دقيقة تقفل حسابك 15 دقيقة، كما في صفحة تسجيل الدخول.",
            "بعد نجاح التغيير يُسجَّل خروجك من كل جهاز آخر كنت مسجّلًا فيه، ويبقى هذا الجهاز مسجّلًا."
          ]
        },
        {
          "t": "h",
          "x": "بريدك الإلكتروني"
        },
        {
          "t": "p",
          "x": "يحتاج تغييره إلى خدمة إرسال البريد، وهي غير مُعدّة بعد، لذلك يظهر في حسابك Not set up حاليًا."
        },
        {
          "t": "h",
          "x": "الجرس"
        },
        {
          "t": "ol",
          "x": [
            "يعرض حتى 30 عنصرًا من آخر 14 يومًا: الاستفسارات الجديدة وطلبات التوظيف للأدوار التي تتولاها، والخدمات والمقالات التي تُنشر اليوم للأدوار التي تكتبها، وتشغيل وضع الصيانة أو إيقافه للجميع.",
            "يحدّد Mark all as read ما عُرض عليك كمقروء، وما يصل أثناء فتح القائمة يبقى جديدًا."
          ]
        }
      ]
    }
  },
  {
    "slug": "roles-and-access",
    "sort_order": 30,
    "minutes": 3,
    "tags": [
      "account",
      "team"
    ],
    "screens": [
      "/admin/account",
      "/admin/users"
    ],
    "caps": [],
    "title": "Roles: who can do what",
    "title_ar": "الأدوار: من يستطيع فعل ماذا",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "There are four roles. Each sees only the screens it can use, and the server checks the role again on every save, so a hidden button is never the only lock."
        },
        {
          "t": "ol",
          "x": [
            "Admin: everything, including people and their roles, archiving and deleting, and job applications.",
            "Content Creator: writes and publishes the site's content (services, projects, posts, pages, testimonials and the rest) and manages media. No settings and no leads.",
            "SEO: SEO defaults, redirects, integrations, and the website and search stats. It can open pages, services, projects and posts without changing their content.",
            "Developer: general settings, maintenance, the theme editor (saved themes do not change the site yet), media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications."
          ]
        },
        {
          "t": "h",
          "x": "Changing someone's role"
        },
        {
          "t": "p",
          "x": "Only an Admin can, in Settings › Users & roles. The admin checks a person's role and account again on every request, so a role taken away stops working at their next click, and someone whose account is switched off is signed out at that click. A role given reaches every save once their sign-in renews, within the hour, or at once if they sign out and in again."
        },
        {
          "t": "p",
          "x": "One limit to know: a sign-in already handed out lasts up to an hour. Until it runs out, it can still reach the database directly, outside the admin, with the role it was issued with. Leads and job applications check the person's account on every read, so those close at once."
        },
        {
          "t": "tip",
          "x": "Roles are fixed: there are no exceptions for one person. If someone needs more, they need a different role."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "هناك أربعة أدوار. يرى كل دور الشاشات التي يستطيع استخدامها فقط، ويتحقق الخادم من الدور مرة أخرى عند كل حفظ، فلا يكون إخفاء الزر هو القفل الوحيد أبدًا."
        },
        {
          "t": "ol",
          "x": [
            "Admin (مسؤول): كل شيء، بما في ذلك الأشخاص وأدوارهم، والأرشفة والحذف، وطلبات التوظيف.",
            "Content Creator (صانع محتوى): يكتب محتوى الموقع وينشره (الخدمات والمشاريع والمقالات والصفحات والتوصيات وغيرها) ويدير الوسائط. لا إعدادات ولا عملاء محتملين.",
            "SEO (تحسين محركات البحث): إعدادات SEO الافتراضية، وإعادة التوجيه، والتكاملات، وإحصاءات الموقع والبحث. يستطيع فتح الصفحات والخدمات والمشاريع والمقالات دون تغيير محتواها.",
            "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، ومحرر المظهر (لا تغيّر المظاهر المحفوظة الموقع بعد)، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف."
          ]
        },
        {
          "t": "h",
          "x": "تغيير دور شخص ما"
        },
        {
          "t": "p",
          "x": "يستطيع ذلك المسؤول (Admin) فقط، من Settings › Users & roles. تتحقق لوحة الإدارة من دور الشخص وحسابه من جديد عند كل طلب، فالدور الذي يُسحب يتوقف عن العمل عند نقرته التالية، ومن أُوقف حسابه يُسجَّل خروجه عند تلك النقرة. أما الدور الجديد فيشمل كل حفظ بعد تجديد جلسة دخوله، خلال ساعة، أو فورًا إن سجّل خروجه ثم دخل من جديد."
        },
        {
          "t": "p",
          "x": "وهناك حدّ ينبغي معرفته: جلسة الدخول التي صدرت بالفعل تبقى صالحة حتى ساعة. وإلى أن تنتهي، يمكن استخدامها للوصول إلى قاعدة البيانات مباشرة، خارج لوحة الإدارة، بالدور الذي صدرت به. أما العملاء المحتملون وطلبات التوظيف فتتحقق من حساب الشخص عند كل قراءة، فيُغلق الوصول إليها فورًا."
        },
        {
          "t": "tip",
          "x": "الأدوار ثابتة، ولا استثناءات لشخص بعينه. من يحتاج إلى صلاحيات أكثر يحتاج إلى دور مختلف."
        }
      ]
    }
  },
  {
    "slug": "saving-and-publishing",
    "sort_order": 40,
    "minutes": 4,
    "tags": [
      "content"
    ],
    "screens": [
      "/admin/pages",
      "/admin/sections",
      "/admin/services",
      "/admin/disciplines",
      "/admin/service-cases",
      "/admin/portfolio",
      "/admin/sectors",
      "/admin/blog",
      "/admin/categories",
      "/admin/testimonials",
      "/admin/clients",
      "/admin/team",
      "/admin/statistics",
      "/admin/certifications",
      "/admin/navigation"
    ],
    "caps": [
      "pages.write",
      "services.write",
      "portfolio.write",
      "blog.write",
      "nav.edit",
      "categories.manage"
    ],
    "title": "Saving, publishing and scheduling",
    "title_ar": "الحفظ والنشر والجدولة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Every editor works the same way: change the fields, then press Save changes. What you save is what the site shows, so a change to something already published is live as soon as it is saved."
        },
        {
          "t": "h",
          "x": "Status"
        },
        {
          "t": "p",
          "x": "Most items have a status:"
        },
        {
          "t": "ol",
          "x": [
            "Draft: saved, not on the site.",
            "Scheduled: goes live by itself within five minutes of its Scheduled for time. Team, Statistics and Certifications have no Scheduled for field, so there Scheduled keeps an item off the site until you set it to Published.",
            "Published: on the site.",
            "Archived: off the site and kept. Only an Admin can archive or delete."
          ]
        },
        {
          "t": "h",
          "x": "If someone else saved first"
        },
        {
          "t": "p",
          "x": "When a colleague saves the same item while you are editing it, your save is stopped with a message instead of overwriting their work. Reload to see their version, then make your change again."
        },
        {
          "t": "h",
          "x": "Both languages"
        },
        {
          "t": "p",
          "x": "The site is in English and Arabic, so most text fields come in pairs. Fill both, so Arabic visitors see the same page as English ones."
        },
        {
          "t": "tip",
          "x": "An item marked Placeholder (design sample), or Design placeholder on a page section, came with the design delivery. On the live site it cannot be published or shown until you replace its content and untick the box, unless the site's owner has allowed design samples for that kind of item."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعمل جميع المحررات بالطريقة نفسها: عدّل الحقول ثم اضغط Save changes. ما تحفظه هو ما يعرضه الموقع، لذا يظهر أي تغيير على محتوى منشور فور حفظه."
        },
        {
          "t": "h",
          "x": "الحالة"
        },
        {
          "t": "p",
          "x": "لمعظم العناصر حالة:"
        },
        {
          "t": "ol",
          "x": [
            "Draft (مسودة): محفوظ، وليس على الموقع.",
            "Scheduled (مجدول): يُنشر تلقائيًا خلال خمس دقائق من وقت Scheduled for. ولا يوجد حقل Scheduled for في Team وStatistics وCertifications، لذا تُبقي حالة Scheduled العنصر هناك خارج الموقع حتى تجعله Published.",
            "Published (منشور): على الموقع.",
            "Archived (مؤرشف): أُزيل من الموقع مع الاحتفاظ به. الأرشفة والحذف للمسؤول (Admin) فقط."
          ]
        },
        {
          "t": "h",
          "x": "إذا حفظ أحد قبلك"
        },
        {
          "t": "p",
          "x": "إذا حفظ زميل العنصر نفسه أثناء تعديلك له، يتوقف حفظك برسالة بدل أن يكتب فوق عمله. أعد تحميل الصفحة لترى نسخته، ثم أعد تعديلك."
        },
        {
          "t": "h",
          "x": "اللغتان"
        },
        {
          "t": "p",
          "x": "الموقع باللغتين الإنجليزية والعربية، لذا تأتي معظم الحقول النصية في أزواج. املأ الاثنين ليرى زوار العربية الصفحة نفسها التي يراها زوار الإنجليزية."
        },
        {
          "t": "tip",
          "x": "العنصر المعلَّم بـ Placeholder (design sample)، أو بـ Design placeholder في أقسام الصفحات، جاء مع تسليم التصميم. ولا يمكن نشره أو عرضه على الموقع المباشر حتى تستبدل محتواه وتزيل العلامة، إلا إذا سمح مالك الموقع بعرض عينات التصميم لهذا النوع من العناصر."
        }
      ]
    }
  },
  {
    "slug": "media-library",
    "sort_order": 50,
    "minutes": 2,
    "tags": [
      "content",
      "media"
    ],
    "screens": [
      "/admin/media"
    ],
    "caps": [
      "media.write"
    ],
    "title": "The media library and alt text",
    "title_ar": "مكتبة الوسائط والنص البديل",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The media library lists the images, videos and files the site uses. Each keeps its alt text: the short description screen readers read aloud and search engines index."
        },
        {
          "t": "ol",
          "x": [
            "Every image needs alt text in English and Arabic. Say what the image shows in a sentence, not the file name.",
            "Folders and tags help you find things here. Visitors never see them.",
            "Only an Admin can delete an asset for good, and only once nothing on the site uses it."
          ]
        },
        {
          "t": "tip",
          "x": "Good alt text helps twice: people using a screen reader hear it, and search engines read it."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعرض مكتبة الوسائط الصور والفيديوهات والملفات التي يستخدمها الموقع، ولكل منها نص بديل: وصف قصير تقرؤه برامج قراءة الشاشة بصوت عالٍ وتفهرسه محركات البحث."
        },
        {
          "t": "ol",
          "x": [
            "تحتاج كل صورة إلى نص بديل بالإنجليزية والعربية. صف ما تُظهره الصورة في جملة، لا اسم الملف.",
            "تساعدك المجلدات والوسوم على إيجاد الملفات هنا، ولا يراها الزوار أبدًا.",
            "حذف الملف نهائيًا للمسؤول (Admin) فقط، وفقط حين لا يستخدمه أي جزء من الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "النص البديل الجيد يفيد مرتين: يسمعه من يستخدم قارئ الشاشة، وتقرؤه محركات البحث."
        }
      ]
    }
  },
  {
    "slug": "seo-and-redirects",
    "sort_order": 60,
    "minutes": 4,
    "tags": [
      "seo"
    ],
    "screens": [
      "/admin/seo",
      "/admin/redirects"
    ],
    "caps": [
      "seo.globalDefaults",
      "redirects.manage"
    ],
    "title": "SEO defaults and redirects",
    "title_ar": "إعدادات SEO الافتراضية وإعادة التوجيه",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "SEO defaults are the titles, descriptions and link-preview image that search engines and social sites see wherever a page has none of its own. Set them once, the text in both languages."
        },
        {
          "t": "h",
          "x": "Redirects"
        },
        {
          "t": "p",
          "x": "A redirect sends visitors and search engines from an old address to a new one, so links shared before a rename keep working."
        },
        {
          "t": "ol",
          "x": [
            "From is the old path, such as /old-page. A path that still shows a page is refused: a redirect only covers addresses that would otherwise find nothing.",
            "To is where it leads: a path on this site or a full https:// address. Point at the final address, because a redirect to another redirect is refused.",
            "301 is a permanent move and 302 a temporary one. 308 is permanent too, for addresses that receive forms.",
            "A rule takes effect within a minute of saving, and a rule for an English path also covers its Arabic twin under /ar."
          ]
        },
        {
          "t": "tip",
          "x": "Browsers can remember a permanent redirect for up to a day. If you are not sure a move is final, start with 302: it can be changed or removed at once."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "إعدادات SEO الافتراضية هي العناوين والأوصاف وصورة معاينة الروابط التي تراها محركات البحث ومواقع التواصل حيثما لا تملك الصفحة ما يخصها. اضبطها مرة واحدة، والنصوص باللغتين."
        },
        {
          "t": "h",
          "x": "إعادة التوجيه"
        },
        {
          "t": "p",
          "x": "تنقل إعادة التوجيه الزوار ومحركات البحث من عنوان قديم إلى عنوان جديد، فتبقى الروابط التي تمت مشاركتها قبل تغيير الاسم صالحة."
        },
        {
          "t": "ol",
          "x": [
            "From هو المسار القديم، مثل /old-page. يُرفض المسار الذي ما زال يعرض صفحة، فإعادة التوجيه تغطي فقط العناوين التي لن تجد شيئًا بدونها.",
            "To هو الوجهة: مسار في هذا الموقع أو عنوان كامل يبدأ بـ https://. وجّهها إلى العنوان النهائي، لأن إعادة التوجيه إلى إعادة توجيه أخرى تُرفض.",
            "301 نقل دائم و302 نقل مؤقت، و308 نقل دائم أيضًا للعناوين التي تستقبل النماذج.",
            "تسري القاعدة خلال دقيقة من الحفظ، والقاعدة الخاصة بمسار إنجليزي تشمل نظيره العربي تحت /ar."
          ]
        },
        {
          "t": "tip",
          "x": "قد تتذكر المتصفحات إعادة التوجيه الدائمة حتى يوم كامل. إن لم تكن متأكدًا من أن النقل نهائي فابدأ بـ 302، إذ يمكن تغييرها أو حذفها فورًا."
        }
      ]
    }
  },
  {
    "slug": "working-with-leads",
    "sort_order": 70,
    "minutes": 3,
    "tags": [
      "leads"
    ],
    "screens": [
      "/admin/leads"
    ],
    "caps": [
      "leads.manage"
    ],
    "title": "Working with leads",
    "title_ar": "التعامل مع العملاء المحتملين",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Every inquiry sent through the site's contact forms arrives here as a lead. The list shows when it came in, the person's name and what they asked about. Contact details stay hidden until you ask for them."
        },
        {
          "t": "ol",
          "x": [
            "Set each lead's status as you work on it: new, in progress, done or spam. The filter above the list shows one status at a time.",
            "View opens the message. Reveal contact details and notes shows the e-mail, phone, budget and timeline. Each reveal is logged against your account, up to 60 an hour.",
            "Internal notes appear after a reveal, for the roles that may see contact details.",
            "Export CSV downloads the leads as a file, at most three times an hour. Every export is logged."
          ]
        },
        {
          "t": "tip",
          "x": "A lead marked as spam is deleted sooner: after 30 days by default, instead of 24 months."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يصل هنا كل استفسار يُرسل عبر نماذج التواصل في الموقع على هيئة عميل محتمل. تعرض القائمة وقت وصوله واسم صاحبه وما سأل عنه، وتبقى بيانات التواصل مخفية حتى تطلبها."
        },
        {
          "t": "ol",
          "x": [
            "حدّد حالة كل عميل محتمل أثناء العمل عليه: new أو in progress أو done أو spam. ويعرض المرشّح أعلى القائمة حالة واحدة في كل مرة.",
            "يفتح View الرسالة، ويُظهر Reveal contact details and notes البريد الإلكتروني والهاتف والميزانية والمدة الزمنية. يُسجَّل كل كشف باسم حسابك، بحد أقصى 60 مرة في الساعة.",
            "تظهر الملاحظات الداخلية بعد الكشف، للأدوار المخوّلة برؤية بيانات التواصل.",
            "ينزّل Export CSV العملاء المحتملين في ملف، بحد أقصى ثلاث مرات في الساعة، ويُسجَّل كل تصدير."
          ]
        },
        {
          "t": "tip",
          "x": "العميل المحتمل المعلَّم كرسالة مزعجة (spam) يُحذف أسرع: بعد 30 يومًا افتراضيًا بدلًا من 24 شهرًا."
        }
      ]
    }
  },
  {
    "slug": "personal-data",
    "sort_order": 80,
    "minutes": 4,
    "tags": [
      "privacy",
      "leads",
      "hiring"
    ],
    "screens": [
      "/admin/leads",
      "/admin/applications"
    ],
    "caps": [
      "leads.pii",
      "applications.pii"
    ],
    "title": "Personal data and the PDPL",
    "title_ar": "البيانات الشخصية ونظام حمايتها",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Saudi Arabia's Personal Data Protection Law (PDPL) covers everything visitors send through the site. The admin makes the careful way the default, so there is little to remember."
        },
        {
          "t": "ol",
          "x": [
            "Contact details are stored encrypted. They are shown one person at a time, only when you ask, and each look is recorded against your account, with the time.",
            "Visits are counted only for visitors who accept analytics cookies on the site.",
            "Leads are deleted after 24 months by default, spam after 30 days. Job applications go after 12 months, or 24 if the applicant agreed to be kept for future roles.",
            "Exports and CV downloads are logged too, and exports are limited per hour.",
            "When an applicant asks for their data to be deleted, an Admin can erase the application, CV included."
          ]
        },
        {
          "t": "tip",
          "x": "Reveal contact details only when you are about to get in touch. Each look is recorded against the account that made it, and the activity log lists it with its time and that account's role."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يشمل نظام حماية البيانات الشخصية في المملكة العربية السعودية كل ما يرسله الزوار عبر الموقع. وتجعل لوحة الإدارة الطريقة الحذرة هي الطريقة الافتراضية، فلا يبقى الكثير لتتذكره."
        },
        {
          "t": "ol",
          "x": [
            "تُحفظ بيانات التواصل مشفّرة، وتُعرض بيانات شخص واحد في كل مرة وعند طلبك فقط، ويُسجَّل كل اطلاع على حسابك مع وقته.",
            "لا تُحتسب الزيارات إلا لمن يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات.",
            "يُحذف العملاء المحتملون بعد 24 شهرًا افتراضيًا، والرسائل المزعجة بعد 30 يومًا. وتُحذف طلبات التوظيف بعد 12 شهرًا، أو 24 شهرًا إذا وافق المتقدم على الاحتفاظ بطلبه لوظائف مستقبلية.",
            "يُسجَّل التصدير وتنزيل السير الذاتية أيضًا، ولعمليات التصدير حد في الساعة.",
            "عندما يطلب متقدم حذف بياناته، يستطيع المسؤول (Admin) محو طلبه بما فيه سيرته الذاتية."
          ]
        },
        {
          "t": "tip",
          "x": "اكشف بيانات التواصل فقط حين توشك على التواصل. يُسجَّل كل اطلاع على الحساب الذي قام به، ويعرضه سجل النشاط مع وقته ودور ذلك الحساب."
        }
      ]
    }
  },
  {
    "slug": "job-applications",
    "sort_order": 90,
    "minutes": 3,
    "tags": [
      "hiring"
    ],
    "screens": [
      "/admin/applications"
    ],
    "caps": [
      "applications.manage"
    ],
    "title": "Job applications",
    "title_ar": "طلبات التوظيف",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Applications sent from the Join page arrive here. The form on the site is open only while Accepting job applications is ticked in General settings, which only an Admin can change."
        },
        {
          "t": "ol",
          "x": [
            "Set each application's status as you review it.",
            "Reveal contact details shows the e-mail and phone, and Download CV fetches the file. Both are logged against your account.",
            "Erase application removes the application and its CV for good. Use it when someone asks for their data to be deleted.",
            "Applications are kept 12 months, or 24 if the applicant agreed to be considered for future roles. One marked spam goes after 30 days."
          ]
        },
        {
          "t": "tip",
          "x": "CVs are not scanned for viruses. Open them with care, and keep them inside the team."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تصل هنا الطلبات المرسلة من صفحة Join. ولا يكون النموذج في الموقع مفتوحًا إلا عند تفعيل Accepting job applications في الإعدادات العامة، وتغييره للمسؤول (Admin) فقط."
        },
        {
          "t": "ol",
          "x": [
            "حدّد حالة كل طلب أثناء مراجعته.",
            "يُظهر Reveal contact details البريد الإلكتروني والهاتف، ويجلب Download CV الملف، ويُسجَّل الاثنان باسم حسابك.",
            "يحذف Erase application الطلب وسيرته الذاتية نهائيًا. استخدمه عندما يطلب أحد حذف بياناته.",
            "تُحفظ الطلبات 12 شهرًا، أو 24 شهرًا إذا وافق المتقدم على النظر في طلبه لوظائف مستقبلية. والطلب المعلَّم كرسالة مزعجة (spam) يُحذف بعد 30 يومًا."
          ]
        },
        {
          "t": "tip",
          "x": "لا تُفحص السير الذاتية بحثًا عن الفيروسات. افتحها بحذر وأبقِها داخل الفريق."
        }
      ]
    }
  },
  {
    "slug": "maintenance-mode",
    "sort_order": 100,
    "minutes": 2,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/maintenance"
    ],
    "caps": [
      "maintenance.manage"
    ],
    "title": "Maintenance mode",
    "title_ar": "وضع الصيانة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Maintenance mode puts a short notice in front of the public site while you fix something. It takes effect within about a minute, and the admin keeps working as usual."
        },
        {
          "t": "ol",
          "x": [
            "Tick Maintenance mode is on and save. Visitors see the maintenance notice instead of the site.",
            "To keep seeing the real site yourself, add your IP address to the allowlist, one per line.",
            "While it is on, everyone in the admin sees Maintenance on in the top bar, and the bell says when it was switched on or off.",
            "Untick it and save to bring the site back."
          ]
        },
        {
          "t": "tip",
          "x": "Switch it off as soon as the fix is in, so visitors and search engines are not kept waiting."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يضع وضع الصيانة إشعارًا قصيرًا أمام الموقع العام أثناء إصلاحك لشيء ما. يسري خلال دقيقة تقريبًا، وتستمر لوحة الإدارة في العمل كالمعتاد."
        },
        {
          "t": "ol",
          "x": [
            "فعّل Maintenance mode is on واحفظ، فيرى الزوار إشعار الصيانة بدل الموقع.",
            "لتواصل رؤية الموقع الحقيقي بنفسك، أضف عنوان IP الخاص بك إلى قائمة السماح، عنوانًا في كل سطر.",
            "أثناء تفعيله يرى الجميع في لوحة الإدارة Maintenance on في الشريط العلوي، ويُعلمك الجرس بوقت تشغيله أو إيقافه.",
            "ألغِ التفعيل واحفظ لإعادة الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "أوقفه فور انتهاء الإصلاح، حتى لا يطول انتظار الزوار ومحركات البحث."
        }
      ]
    }
  },
  {
    "slug": "website-stats",
    "sort_order": 110,
    "minutes": 2,
    "tags": [
      "stats"
    ],
    "screens": [
      "/admin/analytics",
      "/admin/analytics/search"
    ],
    "caps": [
      "analytics.read"
    ],
    "title": "Website stats",
    "title_ar": "إحصاءات الموقع",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Website stats counts page views by page and by language. The numbers are the site's own, with no outside tracker, and only visitors who accept analytics cookies are counted."
        },
        {
          "t": "ol",
          "x": [
            "Pick 7, 30 or 90 days at the top. Overview shows page views, the Arabic share, English and Arabic views day by day and the top pages; Pages lists every page with its views in each language. If you work with leads, Overview also shows new leads and inquiries per 1,000 page views.",
            "A change against the previous period shows only when there is a previous period to compare: the same number of days just before.",
            "Counts are added up every 15 minutes, by days that run midnight to midnight UTC (3 am in Riyadh), so the latest visits can take a while to show.",
            "Where your role has a Search tab, it shows what visitors typed into the site's search, and which searches found nothing. A search that finds nothing is often a page worth writing.",
            "Raw visit records are kept 90 days; the daily totals the screen reads are kept after that."
          ]
        },
        {
          "t": "tip",
          "x": "A low number can simply mean few visitors accepted cookies, not few visitors."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تحتسب إحصاءات الموقع مشاهدات الصفحات حسب الصفحة واللغة. الأرقام خاصة بالموقع نفسه دون أي أداة تتبع خارجية، ولا يُحتسب إلا من يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات."
        },
        {
          "t": "ol",
          "x": [
            "اختر 7 أو 30 أو 90 يومًا في الأعلى. يعرض تبويب Overview مشاهدات الصفحات وحصة العربية والمشاهدات بالإنجليزية والعربية يومًا بيوم وأكثر الصفحات زيارة، ويسرد تبويب Pages كل صفحة مع مشاهداتها بكل لغة. وإذا كنت تعمل على العملاء المحتملين فسيعرض Overview أيضًا العملاء الجدد والاستفسارات لكل 1,000 مشاهدة.",
            "لا يظهر التغيّر مقارنة بالفترة السابقة إلا إذا وُجدت فترة سابقة للمقارنة، أي العدد نفسه من الأيام التي تسبقها مباشرة.",
            "تُجمع الأرقام كل 15 دقيقة، بأيام تمتد من منتصف الليل إلى منتصف الليل بتوقيت UTC (الثالثة فجرًا بتوقيت الرياض)، لذا قد تتأخر أحدث الزيارات في الظهور.",
            "إذا كان لدورك تبويب Search فهو يعرض ما كتبه الزوار في بحث الموقع، وعمليات البحث التي لم تجد شيئًا. والبحث الذي لا يجد شيئًا كثيرًا ما يشير إلى صفحة تستحق الكتابة.",
            "تُحفظ سجلات الزيارات الأولية 90 يومًا، وتبقى المجاميع اليومية التي تقرؤها الشاشة بعد ذلك."
          ]
        },
        {
          "t": "tip",
          "x": "قد يعني الرقم المنخفض ببساطة أن قلة من الزوار قبلوا ملفات تعريف الارتباط، لا أن الزوار قليلون."
        }
      ]
    }
  },
  {
    "slug": "site-health-and-logs",
    "sort_order": 120,
    "minutes": 3,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/site-health",
      "/admin/audit"
    ],
    "caps": [
      "siteHealth.view",
      "logs.view",
      "audit.view"
    ],
    "title": "Site health, errors and the activity log",
    "title_ar": "صحة الموقع والأخطاء وسجل النشاط",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Site health shows how fast the site feels to real visitors (Core Web Vitals), measured in their own browsers when they accept analytics cookies, beside a checklist of things worth fixing."
        },
        {
          "t": "ol",
          "x": [
            "The score is half speed and half checklist. Speed comes from real visits over the last 28 days: each of LCP, INP and CLS counts in full when it is within budget, half when it needs work and not at all when it is poor. Uptime is not measured here yet.",
            "The checklist groups what it checks: content, SEO, speed, errors, security and backups. A row that needs fixing links to the screen where you fix it, and a row your role cannot check says so.",
            "Speed lists each page's figures from visitors' browsers, added up every hour and kept 400 days. Lab scores run in CI on every change, so none are shown here.",
            "Errors lists problems the site ran into. Every night, entries older than 30 days are deleted by themselves; an Admin can clear them sooner with Clear logs, choosing entries older than 7 days, older than 30 days, or all of them, and the clearing itself is recorded in the activity log.",
            "The activity log records saves, publishes, reveals of contact details and exports, each against the account that made it, with the time. The screen lists the time, the role, the action and what it touched. Nobody can edit or delete it, not even an Admin."
          ]
        },
        {
          "t": "tip",
          "x": "To find out when something changed, and which role changed it, look in the activity log."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تُظهر صحة الموقع مدى سرعة الموقع كما يشعر بها الزوار الحقيقيون (Core Web Vitals)، وتُقاس في متصفحاتهم عندما يقبلون ملفات تعريف الارتباط الخاصة بالتحليلات، إلى جانب قائمة تحقق بما يستحق الإصلاح."
        },
        {
          "t": "ol",
          "x": [
            "نصف الدرجة للسرعة ونصفها لقائمة التحقق. تأتي السرعة من زيارات حقيقية خلال آخر 28 يومًا: يُحتسب كل من LCP وINP وCLS كاملًا إذا كان ضمن الحد المستهدف، ونصفه إذا احتاج إلى تحسين، ولا يُحتسب إذا كان ضعيفًا. ولا يُقاس وقت التشغيل هنا بعد.",
            "تجمع قائمة التحقق ما تفحصه في مجموعات: المحتوى وSEO والسرعة والأخطاء والأمان والنسخ الاحتياطية. والبند الذي يحتاج إلى إصلاح يرتبط بالشاشة التي تصلحه منها، والبند الذي لا يستطيع دورك فحصه يذكر ذلك.",
            "يعرض تبويب Speed أرقام كل صفحة من متصفحات الزوار، تُجمع كل ساعة وتُحفظ 400 يوم. أما درجات المختبر فتُشغَّل في CI مع كل تغيير، لذا لا تظهر هنا.",
            "يعرض تبويب Errors المشكلات التي واجهها الموقع. تُحذف كل ليلة الإدخالات الأقدم من 30 يومًا تلقائيًا، ويستطيع المسؤول (Admin) مسحها قبل ذلك بزر Clear logs، فيختار الإدخالات الأقدم من 7 أيام أو الأقدم من 30 يومًا أو كلها، ويُسجَّل المسح نفسه في سجل النشاط.",
            "يسجّل سجل النشاط الحفظ والنشر وكشف بيانات التواصل والتصدير، كلًّا على الحساب الذي قام به مع وقته. وتعرض الشاشة الوقت والدور والإجراء وما تناوله. ولا يستطيع أحد تعديله أو حذفه، ولا حتى المسؤول (Admin)."
          ]
        },
        {
          "t": "tip",
          "x": "لمعرفة متى تغيّر شيء وأي دور غيّره، ارجع إلى سجل النشاط."
        }
      ]
    }
  }
]
$help$::jsonb
$fn$;
revoke all on function app.help_article_set() from public, anon, authenticated, service_role;

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair; a function's schema printed only when
-- app is not on the search path, so the patterns allow both).
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_have text[];
  v_bad text;
  v_n int;
  p text;
  m text;
begin
  -- ---- The helpers: exactly the holders of their capability; staff and the service role
  -- execute them, anon and PUBLIC do not; inlinable (immutable, invoker).
  if not (app.role_site_health('admin') and app.role_site_health('developer')
          and not app.role_site_health('content_creator') and not app.role_site_health('seo')
          and not app.role_site_health('anon') and not app.role_site_health(null)) then
    raise exception '0052: app.role_site_health does not answer siteHealth.view (Admin, Developer)';
  end if;
  if not (app.role_analytics_read('admin') and app.role_analytics_read('content_creator')
          and app.role_analytics_read('seo') and app.role_analytics_read('developer')
          and not app.role_analytics_read('anon') and not app.role_analytics_read(null)) then
    raise exception '0052: app.role_analytics_read does not answer analytics.read (the four staff roles)';
  end if;
  foreach p in array array['app.role_site_health(text)', 'app.role_analytics_read(text)'] loop
    if not exists (select 1 from pg_proc where oid = p::regprocedure
                      and provolatile = 'i' and not prosecdef) then
      raise exception '0052: % must be IMMUTABLE and SECURITY INVOKER', p;
    end if;
    if not has_function_privilege('authenticated', p, 'execute')
       or not has_function_privilege('service_role', p, 'execute')
       or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('public', p, 'execute') then
      raise exception '0052: % must be executable by authenticated and service_role only', p;
    end if;
  end loop;

  -- ---- rollup_daily_vitals: RLS on and forced, and exactly one policy, a read for staff.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.rollup_daily_vitals'::regclass) then
    raise exception '0052: rollup_daily_vitals is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                            order by policyname), '{}') into v_have
    from pg_policies where schemaname = 'public' and tablename = 'rollup_daily_vitals';
  if v_have is distinct from array['rollup_vitals_read SELECT PERMISSIVE {authenticated}'] then
    raise exception '0052: rollup_daily_vitals policies are %, expected rollup_vitals_read alone', v_have;
  end if;
  select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                            order by policyname), '{}') into v_have
    from pg_policies where schemaname = 'public' and tablename = 'rollup_daily_pageviews';
  if v_have is distinct from array['rollup_read SELECT PERMISSIVE {authenticated}'] then
    raise exception '0052: rollup_daily_pageviews policies are %, expected rollup_read alone', v_have;
  end if;
  -- Each policy's expression: the tenant predicate first, then its helper on the token's role;
  -- a read has no WITH CHECK.
  select string_agg(x.tab, ', ') into v_bad
    from (values ('rollup_daily_vitals', 'rollup_vitals_read', 'role_site_health'),
                 ('rollup_daily_pageviews', 'rollup_read', 'role_analytics_read')) as x(tab, pol, fn)
    left join pg_policies pp
      on pp.schemaname = 'public' and pp.tablename = x.tab and pp.policyname = x.pol
   where pp.policyname is null
      or pp.with_check is not null
      or pp.qual !~ ('^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?' || x.fn
                     || '\((app\.)?"current_role"\(\)\)\)$');
  if v_bad is not null then
    raise exception '0052: the read policy on % is not the tenant predicate then its helper', v_bad;
  end if;

  -- ---- Its privileges, as each API role holds them: PUBLIC and anon nothing; authenticated
  -- SELECT; the service role SELECT, INSERT, UPDATE and DELETE; no TRUNCATE, REFERENCES,
  -- TRIGGER or MAINTAIN for anyone; no column grant.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.rollup_daily_vitals', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select', 'insert', 'update', 'delete']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0052: wrong table privileges on rollup_daily_vitals (role privilege): %', v_bad;
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.rollup_daily_vitals'::regclass and a.attnum > 0
                and not a.attisdropped and cardinality(coalesce(a.attacl, '{}'::aclitem[])) > 0) then
    raise exception '0052: rollup_daily_vitals carries a column grant';
  end if;
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.rollup_daily_vitals', 'select, insert, update, references') then
      raise exception '0052: % holds a column privilege on rollup_daily_vitals', p;
    end if;
  end loop;

  -- ---- The edges: 24 per metric, strictly rising, the §6 budgets and the poor thresholds
  -- among them; the table's 25 buckets follow.
  foreach m in array array['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] loop
    if cardinality(app.vitals_edges(m)) <> 24
       or exists (select 1 from unnest(app.vitals_edges(m)) with ordinality as e(v, i)
                   where i > 1 and v <= (app.vitals_edges(m))[i - 1]) then
      raise exception '0052: app.vitals_edges(%) is not 24 rising edges', m;
    end if;
  end loop;
  if not (2500 = any (app.vitals_edges('LCP')) and 4000 = any (app.vitals_edges('LCP'))
          and 200 = any (app.vitals_edges('INP')) and 500 = any (app.vitals_edges('INP'))
          and 0.1::double precision = any (app.vitals_edges('CLS'))
          and 0.25::double precision = any (app.vitals_edges('CLS'))
          and 1800 = any (app.vitals_edges('FCP')) and 3000 = any (app.vitals_edges('FCP'))
          and 800 = any (app.vitals_edges('TTFB')) and 1800 = any (app.vitals_edges('TTFB'))) then
    raise exception '0052: a threshold is not a bucket edge';
  end if;

  -- ---- Functions: who executes what. The rollups run as their owner and no API role calls
  -- them; the edges only through vitals_summary (authenticated); the readers staff alone.
  foreach p in array array['app.rollup_vitals(integer)', 'app.rollup_pageviews(integer)',
                           'app.help_article_set()'] loop
    if has_function_privilege('public', p, 'execute') or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0052: an API role may execute %', p;
    end if;
  end loop;
  if has_function_privilege('public', 'app.vitals_edges(text)', 'execute')
     or has_function_privilege('anon', 'app.vitals_edges(text)', 'execute')
     or has_function_privilege('service_role', 'app.vitals_edges(text)', 'execute')
     or not has_function_privilege('authenticated', 'app.vitals_edges(text)', 'execute') then
    raise exception '0052: app.vitals_edges must be executable by authenticated alone';
  end if;
  foreach p in array array['public.vitals_summary(uuid, integer)',
                           'public.pageview_summary(uuid, date, date)',
                           'public.pageview_paths(uuid, date, date, integer, integer)',
                           'public.search_summary(uuid, integer, text)',
                           'public.content_health(uuid)'] loop
    if has_function_privilege('public', p, 'execute') or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('service_role', p, 'execute')
       or not has_function_privilege('authenticated', p, 'execute') then
      raise exception '0052: % must be executable by authenticated alone', p;
    end if;
    if exists (select 1 from pg_proc where oid = p::regprocedure and prosecdef) then
      raise exception '0052: % must be SECURITY INVOKER (RLS decides what it returns)', p;
    end if;
    if not exists (select 1 from pg_proc where oid = p::regprocedure
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0052: % must set an empty search_path', p;
    end if;
  end loop;
  -- The two rollups: definers with an empty search_path.
  foreach p in array array['app.rollup_vitals(integer)', 'app.rollup_pageviews(integer)'] loop
    if not exists (select 1 from pg_proc where oid = p::regprocedure and prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0052: % must be SECURITY DEFINER with an empty search_path', p;
    end if;
  end loop;

  -- ---- The job, when pg_cron is there: hourly at minute 7, the rollup over three days.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select count(*)::int from cron.job
                where jobname = 'rollup-vitals' and schedule = '7 * * * *'
                  and command ~ 'app\.rollup_vitals\(3\)'$q$ into v_n;
    if v_n <> 1 then
      raise exception '0052: the rollup-vitals job is not scheduled hourly';
    end if;
  end if;

  -- ---- The guides: still 0046's twelve slugs, every tenant holding each.
  select coalesce(array_agg(a.slug order by a.slug), '{}') into v_have
    from jsonb_to_recordset(app.help_article_set()) as a (slug text);
  if v_have is distinct from array['finding-your-way', 'job-applications', 'maintenance-mode',
                                   'media-library', 'personal-data', 'roles-and-access',
                                   'saving-and-publishing', 'seo-and-redirects',
                                   'site-health-and-logs', 'website-stats',
                                   'working-with-leads', 'your-account'] then
    raise exception '0052: the help set holds %, expected 0046''s twelve guides', v_have;
  end if;
  select count(*) into v_n
    from public.tenants t
    cross join jsonb_to_recordset(app.help_article_set()) as a (slug text, body jsonb)
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = a.slug and h.body = a.body);
  if v_n > 0 then
    raise exception '0052: % guide(s) of the set are missing or out of date in a tenant', v_n;
  end if;
end $$;
