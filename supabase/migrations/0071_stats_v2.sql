-- ─────────────────────────────────────────────────────────────────────────────
-- 0071 — Website stats v2 on already-consented first-party data (Admin v2 G1, folded: G1a
-- visits and events, G1b realtime, G1c goals). Forward-only, expand only, plus one
-- narrowing no deployed code relies on (raw telemetry, below). Depends on 0001 (tenants,
-- app.current_role, app.effective_tenant_id), 0002 (analytics_events and its partitions,
-- web_vitals, rollup_daily_pageviews), 0010 (the pg_cron pattern), 0033 (app.live_role,
-- app.role_works_leads), 0034 (leads.is_spam), 0035 (the timezone allow-list), 0037 (the
-- partition RLS and the read-only tables' grants) and 0052 (app.role_analytics_read, the
-- rollup and reader templates).
--
-- WHAT IT ADDS
--   • An index on analytics_events (occurred_at), on the partitioned parent, so every
--     partition has it, the default and future ones included (app.ensure_telemetry_
--     partitions creates them with PARTITION OF). The minute rollup below reads the last
--     eight minutes through it; without it every run would scan the month.
--   • Raw telemetry is read by the service role only. analytics_events_read and
--     web_vitals_read (0002) are dropped and staff lose SELECT on both parents: with click
--     events beside page views a raw row is part of a per-tab trail, and no admin code reads
--     either table (tests/lib/rollupOnly.spec.ts). Not a contraction under migrations.md rule
--     6: nothing deployed reads them as a person. The service role keeps 0037's four writes.
--   • Three daily or hourly rollups, written every 15 minutes by app.rollup_visits:
--       rollup_daily_visits      per tenant and UTC day: visits (a visit is one session id
--                                on one UTC day; the id is per tab, src/lib/client/
--                                analytics.ts), one-page visits, the page views of visits,
--                                and the funnel's counts (a service page; an inquiry form;
--                                both in one visit);
--       rollup_daily_events      per tenant, day, type and key: clicks on the site's
--                                data-track links and interest in a discipline or service
--                                (events, and the visits they came from);
--       rollup_hourly_pageviews  page views per whole UTC hour (the busiest hours, grouped in
--                                the studio's time zone when read).
--     Kept 400 days (0052's vitals rule). Readers: visit_summary, event_summary, busy_hours.
--   • rollup_minute_activity (realtime): per tenant and UTC minute, the page views in it,
--     the people active in the five minutes ending with it and the pages they are on, from
--     app.rollup_realtime every minute by pg_cron. Kept 48 hours. Reader: realtime_summary.
--     A daily job keeps cron's own run history to seven days (the minute job adds 1,440 rows
--     a day there).
--   • Goals: a new capability, analytics.goals (Admin and SEO; CLAUDE.md §5), its helper
--     app.role_analytics_goals, the table analytics_goals (immediate, P-3: no release, no
--     history; at most 20 per tenant; a RESTRICTIVE live layer) and goal_progress (this
--     calendar month, in UTC days, from the rollups; inquiries only for lead workers).
--
-- DEFINITIONS (the help guide, the screens and tests/lib/analyticsVocabulary.spec.ts say the
-- same). Events with no session id (storage blocked) count as page views and clicks but in
-- no visit. A service page is a path matching '^(/ar)?/services/[^/?#]+/?$'. An inquiry form
-- is reached by a page view of '^(/ar)?/contact/?$' or a click on one of INQUIRY_CTAS
-- (packages/schemas/analytics.ts): skip_to_inquiry, start_project, contact_link.
--
-- DATA EFFECTS (measure read-only before the push): the index build reads every partition
-- of analytics_events once, holding a SHARE lock that blocks the ingest while it builds (a
-- lost beacon is silent and never breaks a page; the lock timeout fails the push rather than
-- queueing); app.rollup_visits(90) then scans the last 90 days once. Both modest at
-- production's volume; push at a quiet hour.
--
-- Production as of 2026-10-18: PostgreSQL 17.6; the ledger holds 0001-0038, 0041,
-- 0044-0046, 0048, 0050-0052, 0054-0057, 0060-0067 (C4c and H11 may land first: nothing
-- here depends on either; H11's catalog only changes how this slice's guide ships, the TODO
-- in section 12). Grants are stated for both Supabase
-- privilege regimes (README P-14). CLAUDE.md §3 (Pillars 1 and 4), §5, §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

-- ---- 1. The index the minute rollup reads through ------------------------------------------
create index if not exists analytics_events_occurred_at_idx
  on public.analytics_events (occurred_at);

-- ---- 2. Raw telemetry: the service role only ------------------------------------------------
drop policy if exists analytics_events_read on public.analytics_events;
drop policy if exists web_vitals_read on public.web_vitals;
revoke all on public.analytics_events from public, anon, authenticated;
revoke all on public.web_vitals from public, anon, authenticated;
-- The partitions as well (0037 already took everything from them; stated again so the
-- postcondition below holds under either grant regime).
do $$
declare
  p regclass;
begin
  for p in
    select i.inhrelid::regclass
      from pg_inherits i
     where i.inhparent in ('public.analytics_events'::regclass, 'public.web_vitals'::regclass)
  loop
    execute format('revoke all on %s from public, anon, authenticated', p);
  end loop;
end $$;

-- The check the postcondition below runs, kept as a function so pgTAP can prove it fires
-- (it grants a privilege back inside a rolled-back transaction and expects a finding): every
-- privilege PUBLIC, anon or authenticated holds on a raw telemetry parent or partition,
-- table-wide or per column, and every policy left on a parent; null when there is none.
create or replace function app.raw_telemetry_exposure() returns text
  language sql stable set search_path = '' as $$
  with rels as (
    select 'public.analytics_events'::regclass::oid as oid
    union all select 'public.web_vitals'::regclass::oid
    union all select i.inhrelid from pg_catalog.pg_inherits i
               where i.inhparent in ('public.analytics_events'::regclass, 'public.web_vitals'::regclass)
  ),
  privs as (
    select unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']
                  || case when pg_catalog.current_setting('server_version_num')::int >= 170000
                          then array['maintain'] else array[]::text[] end) as priv
  ),
  found as (
    select pg_catalog.format('%s %s %s', x.who, pr.priv, r.oid::regclass) as f
      from rels r
      cross join (values ('public'), ('anon'), ('authenticated')) as x(who)
      cross join privs pr
     where pg_catalog.has_table_privilege(x.who::name, r.oid, pr.priv)
        or (pr.priv in ('select', 'insert', 'update', 'references')
            and pg_catalog.has_any_column_privilege(x.who::name, r.oid, pr.priv))
    union all
    select pg_catalog.format('policy %s.%s', pp.tablename, pp.policyname)
      from pg_catalog.pg_policies pp
     where pp.schemaname = 'public' and pp.tablename in ('analytics_events', 'web_vitals')
  )
  select pg_catalog.string_agg(f, ', ' order by f) from found
$$;
revoke all on function app.raw_telemetry_exposure() from public, anon, authenticated, service_role;

-- ---- 3. One helper for the new capability (G1c) ------------------------------------------------
-- analytics.goals: Admin and SEO (CLAUDE.md §5 "Analytics goals — set"). Held equal to
-- ROLE_CAPS by tests/authz/sqlHelpers.spec.ts.
create or replace function app.role_analytics_goals(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'seo'), false) $$;  -- analytics.goals
revoke all on function app.role_analytics_goals(text) from public, anon, authenticated, service_role;
grant execute on function app.role_analytics_goals(text) to authenticated, service_role;

-- ---- 4. The visits, events and hours rollups ---------------------------------------------------
-- Derived rollups like rollup_daily_vitals (0052, U2's recorded §8 departure): keyed by what
-- they aggregate, no id and no actor columns (no person writes a row; the rollup recomputes
-- it), tenant_id first, RLS ENABLE + FORCE.
create table if not exists public.rollup_daily_visits (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,                                   -- UTC day
  visits bigint not null check (visits >= 0),
  one_page_visits bigint not null check (one_page_visits >= 0),
  visit_views bigint not null check (visit_views >= 0),
  service_visits bigint not null check (service_visits >= 0),
  service_inquiry_visits bigint not null check (service_inquiry_visits >= 0),
  inquiry_visits bigint not null check (inquiry_visits >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

create table if not exists public.rollup_daily_events (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,                                   -- UTC day
  event_type text not null check (event_type in ('cta_click', 'service_interest')),
  -- The click's id, or 'd:<discipline>' / 's:<service>'; '*' is every key together.
  key text not null check (key = '*' or key ~ '^[a-z0-9_:-]{1,66}$'),
  events bigint not null check (events >= 0),
  visits bigint not null check (visits >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day, event_type, key)
);

create table if not exists public.rollup_hourly_pageviews (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The start of a whole UTC hour. Grouped by the studio's local hour when read, so a time
  -- zone setting never needs a re-roll.
  hour timestamptz not null
    check (hour = date_trunc('hour', hour at time zone 'UTC') at time zone 'UTC'),
  views bigint not null check (views >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, hour)
);

-- ---- 5. The realtime rollup (G1b) ------------------------------------------------------------
create table if not exists public.rollup_minute_activity (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The start of a whole UTC minute.
  minute timestamptz not null
    check (minute = date_trunc('minute', minute at time zone 'UTC') at time zone 'UTC'),
  views integer not null check (views >= 0),           -- page views in the minute
  active_visits integer not null check (active_visits >= 0),  -- sessions active in the 5 minutes ending with it
  -- Up to ten {path, visits}: the pages those people are on (each one's latest page view).
  top_paths jsonb not null default '[]'::jsonb
    check (jsonb_typeof(top_paths) = 'array' and jsonb_array_length(top_paths) <= 10),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, minute)
);

-- RLS, one read policy each (the tenant predicate first, then analytics.read on the token's
-- role), grants stated (P-14): staff SELECT, the service role the four writes, PUBLIC and
-- anon nothing. No write policy: the rollups write as their owner and the service role
-- bypasses RLS. No sequence (the keys are natural).
do $$
declare
  t text;
begin
  foreach t in array array['rollup_daily_visits', 'rollup_daily_events', 'rollup_hourly_pageviews',
                           'rollup_minute_activity'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using '
                   '(tenant_id = app.effective_tenant_id() and app.role_analytics_read(app.current_role()))',
                   t || '_read', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ---- 6. app.rollup_visits ---------------------------------------------------------------------
-- The last p_days whole UTC days and today (1 to 90), every tenant: a SET (a late beacon
-- corrects its day), unchanged rows not rewritten, rows of the window the run no longer
-- produces removed, rows older than 400 days purged. Per tenant, day and type, the 100 keys
-- with most events keep their own row; every event counts in '*'; a key that is not a plain
-- id counts in '*' only.
create or replace function app.rollup_visits(p_days int default 3)
  returns int
  language plpgsql
  security definer
  set search_path = ''
  set statement_timeout = '60s'
as $$
declare
  v_day date := ((pg_catalog.now() at time zone 'UTC')::date
                 - least(greatest(coalesce(p_days, 3), 1), 90));
  v_since timestamptz := (v_day::timestamp at time zone 'UTC');
  v_purge date := (pg_catalog.now() at time zone 'UTC')::date - 400;
  n int := 0;
  k int;
begin
  -- This run's rows (dropped at commit; a second run in the same transaction empties them).
  if to_regclass('pg_temp._g1_visits') is null then
    create temporary table _g1_visits (
      tenant_id uuid, day date, visits bigint, one_page_visits bigint, visit_views bigint,
      service_visits bigint, service_inquiry_visits bigint, inquiry_visits bigint
    ) on commit drop;
    create temporary table _g1_events (
      tenant_id uuid, day date, event_type text, key text, events bigint, visits bigint
    ) on commit drop;
    create temporary table _g1_hours (tenant_id uuid, hour timestamptz, views bigint) on commit drop;
  else
    truncate pg_temp._g1_visits, pg_temp._g1_events, pg_temp._g1_hours;
  end if;

  -- Visits: one per session id and UTC day.
  insert into pg_temp._g1_visits
  with v as (
    select e.tenant_id,
           (e.occurred_at at time zone 'UTC')::date as day,
           e.session_id,
           count(*) filter (where e.event_type = 'pageview') as views,
           count(*) filter (where e.event_type <> 'pageview') as others,
           coalesce(bool_or(e.event_type = 'pageview'
                            and e.path ~ '^(/ar)?/services/[^/?#]+/?$'), false) as service,
           coalesce(bool_or((e.event_type = 'pageview' and e.path ~ '^(/ar)?/contact/?$')
                            or (e.event_type = 'cta_click'
                                and (e.props ->> 'cta') in ('skip_to_inquiry', 'start_project',
                                                            'contact_link'))), false) as inquiry
      from public.analytics_events e
     where e.occurred_at >= v_since
       and e.session_id is not null and e.session_id <> ''
     group by e.tenant_id, (e.occurred_at at time zone 'UTC')::date, e.session_id
  )
  select v.tenant_id, v.day,
         count(*),
         count(*) filter (where v.views = 1 and v.others = 0),
         coalesce(sum(v.views), 0),
         count(*) filter (where v.service),
         count(*) filter (where v.service and v.inquiry),
         count(*) filter (where v.inquiry)
    from v
   group by v.tenant_id, v.day;

  -- Events: clicks by id, interest by 'd:'/'s:' key.
  insert into pg_temp._g1_events
  with raw as (
    select e.tenant_id,
           (e.occurred_at at time zone 'UTC')::date as day,
           e.event_type,
           case
             when e.event_type = 'cta_click' then e.props ->> 'cta'
             when (e.props ->> 'discipline') is not null then 'd:' || (e.props ->> 'discipline')
             when (e.props ->> 'service') is not null then 's:' || (e.props ->> 'service')
           end as k,
           nullif(e.session_id, '') as sid
      from public.analytics_events e
     where e.occurred_at >= v_since
       and e.event_type in ('cta_click', 'service_interest')
  ),
  keyed as (
    select r.tenant_id, r.day, r.event_type, r.sid,
           case when r.k ~ '^[a-z0-9_:-]{1,66}$' then r.k end as key
      from raw r
  ),
  ranked as (
    select k.tenant_id, k.day, k.event_type, k.key,
           count(*) as events, count(distinct k.sid) as visits,
           row_number() over (partition by k.tenant_id, k.day, k.event_type
                              order by count(*) desc, k.key) as rn
      from keyed k
     where k.key is not null
     group by k.tenant_id, k.day, k.event_type, k.key
  )
  select r.tenant_id, r.day, r.event_type, r.key, r.events, r.visits
    from ranked r
   where r.rn <= 100
  union all
  select k.tenant_id, k.day, k.event_type, '*', count(*), count(distinct k.sid)
    from keyed k
   group by k.tenant_id, k.day, k.event_type;

  -- Page views per whole UTC hour.
  insert into pg_temp._g1_hours
  select e.tenant_id,
         date_trunc('hour', e.occurred_at at time zone 'UTC') at time zone 'UTC',
         count(*)
    from public.analytics_events e
   where e.occurred_at >= v_since
     and e.event_type = 'pageview'
     and e.path is not null
   group by 1, 2;

  insert into public.rollup_daily_visits as r
    (tenant_id, day, visits, one_page_visits, visit_views, service_visits,
     service_inquiry_visits, inquiry_visits)
  select t.tenant_id, t.day, t.visits, t.one_page_visits, t.visit_views, t.service_visits,
         t.service_inquiry_visits, t.inquiry_visits
    from pg_temp._g1_visits t
  on conflict (tenant_id, day) do update
     set visits = excluded.visits, one_page_visits = excluded.one_page_visits,
         visit_views = excluded.visit_views, service_visits = excluded.service_visits,
         service_inquiry_visits = excluded.service_inquiry_visits,
         inquiry_visits = excluded.inquiry_visits, updated_at = pg_catalog.now()
   where (r.visits, r.one_page_visits, r.visit_views, r.service_visits,
          r.service_inquiry_visits, r.inquiry_visits)
         is distinct from
         (excluded.visits, excluded.one_page_visits, excluded.visit_views,
          excluded.service_visits, excluded.service_inquiry_visits, excluded.inquiry_visits);
  get diagnostics k = row_count;
  n := n + k;

  insert into public.rollup_daily_events as r (tenant_id, day, event_type, key, events, visits)
  select t.tenant_id, t.day, t.event_type, t.key, t.events, t.visits
    from pg_temp._g1_events t
  on conflict (tenant_id, day, event_type, key) do update
     set events = excluded.events, visits = excluded.visits, updated_at = pg_catalog.now()
   where (r.events, r.visits) is distinct from (excluded.events, excluded.visits);
  get diagnostics k = row_count;
  n := n + k;

  insert into public.rollup_hourly_pageviews as r (tenant_id, hour, views)
  select t.tenant_id, t.hour, t.views
    from pg_temp._g1_hours t
  on conflict (tenant_id, hour) do update
     set views = excluded.views, updated_at = pg_catalog.now()
   where r.views is distinct from excluded.views;
  get diagnostics k = row_count;
  n := n + k;

  -- In the window, a row this run did not produce goes (a key that left the busiest 100).
  delete from public.rollup_daily_visits r
   where r.day >= v_day
     and not exists (select 1 from pg_temp._g1_visits t
                      where t.tenant_id = r.tenant_id and t.day = r.day);
  delete from public.rollup_daily_events r
   where r.day >= v_day
     and not exists (select 1 from pg_temp._g1_events t
                      where t.tenant_id = r.tenant_id and t.day = r.day
                        and t.event_type = r.event_type and t.key = r.key);
  delete from public.rollup_hourly_pageviews r
   where r.hour >= v_since
     and not exists (select 1 from pg_temp._g1_hours t
                      where t.tenant_id = r.tenant_id and t.hour = r.hour);

  -- Thirteen months, so a month has its year-ago twin (counts only: not personal data).
  delete from public.rollup_daily_visits r where r.day < v_purge;
  delete from public.rollup_daily_events r where r.day < v_purge;
  delete from public.rollup_hourly_pageviews r
   where r.hour < (v_purge::timestamp at time zone 'UTC');

  return n;
end $$;
revoke all on function app.rollup_visits(int) from public, anon, authenticated, service_role;

-- ---- 7. app.rollup_realtime (G1b) ---------------------------------------------------------------
-- The last three complete UTC minutes, recomputed every minute (a beacon a minute late still
-- lands), from the eight minutes of raw rows they need, read through the index above. A
-- minute with no page view and nobody active writes no row (a missing minute reads as zero),
-- and a recomputed minute that now has neither loses its row. Rows older than 48 hours go.
-- One statement and no temporary table: a job that runs 1,440 times a day should not create
-- and drop a table in the catalog each time (app.rollup_visits, every 15 minutes, may).
create or replace function app.rollup_realtime()
  returns int
  language plpgsql
  security definer
  set search_path = ''
  set statement_timeout = '20s'
as $$
declare
  v_end timestamptz := date_trunc('minute', pg_catalog.now() at time zone 'UTC') at time zone 'UTC';
  v_first timestamptz := v_end - interval '3 minutes';
  n int;
begin
  with ev as (
    select e.tenant_id, e.occurred_at, e.event_type,
           nullif(e.session_id, '') as sid,
           case when e.event_type = 'pageview'
                 and left(split_part(split_part(e.path, '?', 1), '#', 1), 200) like '/%'
                then left(split_part(split_part(e.path, '?', 1), '#', 1), 200) end as path
      from public.analytics_events e
     where e.occurred_at >= v_first - interval '4 minutes'
       and e.occurred_at < v_end
  ),
  grid as (
    select t.tenant_id, g.m
      from (select distinct ev.tenant_id from ev) t
     cross join generate_series(v_first, v_end - interval '1 minute', interval '1 minute') as g(m)
  ),
  computed as (
    select g.tenant_id, g.m as minute,
           (select count(*) from ev
             where ev.tenant_id = g.tenant_id and ev.event_type = 'pageview'
               and ev.occurred_at >= g.m and ev.occurred_at < g.m + interval '1 minute')::int
             as views,
           (select count(distinct ev.sid) from ev
             where ev.tenant_id = g.tenant_id and ev.sid is not null
               and ev.occurred_at >= g.m - interval '4 minutes'
               and ev.occurred_at < g.m + interval '1 minute')::int
             as active_visits,
           (select coalesce(jsonb_agg(jsonb_build_object('path', p.path, 'visits', p.visits)
                                      order by p.visits desc, p.path), '[]'::jsonb)
              from (select l.path, count(*)::int as visits
                      from (select distinct on (ev.sid) ev.sid, ev.path
                              from ev
                             where ev.tenant_id = g.tenant_id and ev.sid is not null
                               and ev.path is not null
                               and ev.occurred_at >= g.m - interval '4 minutes'
                               and ev.occurred_at < g.m + interval '1 minute'
                             order by ev.sid, ev.occurred_at desc) l
                     group by l.path
                     order by count(*) desc, l.path
                     limit 10) p)
             as top_paths
      from grid g
  ),
  kept as (
    select c.* from computed c where c.views > 0 or c.active_visits > 0
  ),
  -- In the window, a minute this run no longer produces goes (its rows and the upserted
  -- ones are disjoint, so the two writes never meet one row).
  gone as (
    delete from public.rollup_minute_activity r
     where r.minute >= v_first and r.minute < v_end
       and not exists (select 1 from kept k
                        where k.tenant_id = r.tenant_id and k.minute = r.minute)
  ),
  written as (
    insert into public.rollup_minute_activity as r (tenant_id, minute, views, active_visits, top_paths)
    select k.tenant_id, k.minute, k.views, k.active_visits, k.top_paths
      from kept k
    on conflict (tenant_id, minute) do update
       set views = excluded.views, active_visits = excluded.active_visits,
           top_paths = excluded.top_paths, updated_at = pg_catalog.now()
     where (r.views, r.active_visits, r.top_paths)
           is distinct from (excluded.views, excluded.active_visits, excluded.top_paths)
    returning 1
  )
  select count(*)::int into n from written;

  delete from public.rollup_minute_activity r where r.minute < pg_catalog.now() - interval '48 hours';

  return n;
end $$;
revoke all on function app.rollup_realtime() from public, anon, authenticated, service_role;

-- ---- 8. Scheduled by pg_cron (the 0010 pattern), not the Worker's cron (near its 50
-- subrequests). rollup-visits is offset from rollup-pageviews (0010, */15).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job
     where jobname in ('rollup-visits', 'rollup-realtime', 'cron-history-purge');
    perform cron.schedule('rollup-visits', '4-59/15 * * * *', $job$ select app.rollup_visits(3) $job$);
    perform cron.schedule('rollup-realtime', '* * * * *', $job$ select app.rollup_realtime() $job$);
    -- The minute job adds 1,440 rows a day to cron's own run history: keep seven days of it.
    if has_table_privilege(current_user, 'cron.job_run_details', 'delete') then
      perform cron.schedule('cron-history-purge', '40 3 * * *',
        $job$ delete from cron.job_run_details where end_time < now() - interval '7 days' $job$);
    else
      raise notice 'cannot delete from cron.job_run_details as %: purge it by hand (runbook)', current_user;
    end if;
  else
    raise notice 'pg_cron not installed: schedule app.rollup_visits(3) every 15 minutes and app.rollup_realtime() every minute by hand';
  end if;
end $$;

-- ---- 9. The backfill ---------------------------------------------------------------------------
-- The raw horizon (RAW_TELEMETRY_RETENTION, 90 days), once. Idempotent: run again, it writes
-- nothing. Realtime needs none (it covers the last minutes only).
select app.rollup_visits(90);

-- ---- 10. Goals (G1c) ------------------------------------------------------------------------------
-- Admin text, English only (the admin is English, L7): not public content, so §8's `_ar` rule
-- does not apply. Immediate (P-3): no release registry row, no snapshot, no content_versions.
create table if not exists public.analytics_goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 80 and btrim(name) <> ''
           and name !~ '[<>\u0001-\u001f\u007f-\u009f]'),
  metric text not null
    check (metric in ('visits', 'pageviews', 'service_visits', 'inquiry_visits', 'cta',
                      'interest', 'inquiries')),
  -- The click id a 'cta' goal counts (CTA_IDS); no other metric names one.
  cta text check (cta is null or cta ~ '^[a-z0-9_]{1,40}$'),
  target integer not null check (target between 1 and 1000000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint analytics_goals_cta_pair check ((metric = 'cta') = (cta is not null))
);
alter table public.analytics_goals enable row level security;
alter table public.analytics_goals force row level security;

-- At most 20 per tenant, counted under a per-tenant transaction lock so two saves at once
-- cannot both pass (the second waits for the first to commit, then counts it: each statement
-- of a volatile function reads a fresh snapshot under READ COMMITTED). A definer, so the
-- count sees every goal of the tenant whatever the caller reads; the refusal names a
-- constraint, as a CHECK's does (crud.ts maps it to a message). AFTER INSERT, so it runs
-- only once RLS's WITH CHECK has accepted the row: as a BEFORE trigger it answered another
-- tenant's admin naming this tenant with 23514 at 20 goals and 42501 below, telling it how
-- many goals this tenant has (the G1 self-review; supabase/tests/stats_goals.test.sql).
create or replace function app.tg_analytics_goals_limit() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('analytics_goals:' || new.tenant_id::text, 0));
  if (select count(*) from public.analytics_goals g where g.tenant_id = new.tenant_id) > 20 then
    raise exception using
      errcode = '23514',
      message = 'new row for relation "analytics_goals" violates check constraint "analytics_goals_limit"',
      constraint = 'analytics_goals_limit',
      table = 'analytics_goals',
      schema = 'public';
  end if;
  return null;
end $$;
revoke all on function app.tg_analytics_goals_limit() from public, anon, authenticated, service_role;

-- BEFORE triggers fire in name order: the actor, the timestamp, the version; the limit is
-- the one AFTER trigger (above).
drop trigger if exists analytics_goals_actor on public.analytics_goals;
create trigger analytics_goals_actor before insert or update on public.analytics_goals
  for each row execute function app.tg_set_actor();
drop trigger if exists analytics_goals_limit on public.analytics_goals;
create trigger analytics_goals_limit after insert on public.analytics_goals
  for each row execute function app.tg_analytics_goals_limit();
drop trigger if exists analytics_goals_updated_at on public.analytics_goals;
create trigger analytics_goals_updated_at before update on public.analytics_goals
  for each row execute function app.tg_set_updated_at();
drop trigger if exists analytics_goals_version on public.analytics_goals;
create trigger analytics_goals_version before update on public.analytics_goals
  for each row execute function app.tg_bump_version();

-- The JWT layer: every analytics.read role reads the tenant's goals; analytics.goals writes.
drop policy if exists analytics_goals_read on public.analytics_goals;
create policy analytics_goals_read on public.analytics_goals for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_read(app.current_role()));
drop policy if exists analytics_goals_insert on public.analytics_goals;
create policy analytics_goals_insert on public.analytics_goals for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_analytics_goals(app.current_role()));
drop policy if exists analytics_goals_update on public.analytics_goals;
create policy analytics_goals_update on public.analytics_goals for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_goals(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_analytics_goals(app.current_role()));
drop policy if exists analytics_goals_delete on public.analytics_goals;
create policy analytics_goals_delete on public.analytics_goals for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_goals(app.current_role()));
-- The live layer (RESTRICTIVE, as 0055's): the profile, read now, must still hold the
-- capability, so a demoted, deactivated or locked token changes nothing and reads nothing.
drop policy if exists analytics_goals_live_read on public.analytics_goals;
create policy analytics_goals_live_read on public.analytics_goals
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_read((select app.live_role())));
drop policy if exists analytics_goals_live_insert on public.analytics_goals;
create policy analytics_goals_live_insert on public.analytics_goals
  as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_analytics_goals((select app.live_role())));
drop policy if exists analytics_goals_live_update on public.analytics_goals;
create policy analytics_goals_live_update on public.analytics_goals
  as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_goals((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_analytics_goals((select app.live_role())));
drop policy if exists analytics_goals_live_delete on public.analytics_goals;
create policy analytics_goals_live_delete on public.analytics_goals
  as restrictive for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_analytics_goals((select app.live_role())));

-- Grants, stated (P-14). Staff: read; insert the tenant and the four fields; update the four
-- (crud.updateRow sends only the changed fields and matches `version` in its WHERE, which
-- SELECT covers; the trigger bumps it); delete. The service role: the four.
revoke all on public.analytics_goals from public, anon, authenticated, service_role;
grant select, delete on public.analytics_goals to authenticated;
grant insert (tenant_id, name, metric, cta, target) on public.analytics_goals to authenticated;
grant update (name, metric, cta, target) on public.analytics_goals to authenticated;
grant select, insert, update, delete on public.analytics_goals to service_role;

-- ---- 11. The readers (INVOKER: RLS and the helpers decide) ---------------------------------------
-- Each takes the tenant from the Worker and answers the empty shape unless it is the token's
-- (crm_people's rule). A bound the Worker would never send is a 22023.

-- The stats overview and the funnel: visits in [p_from, p_to] (UTC days, both included).
-- `first_day` is the tenant's earliest visits day, so a change shows only with a previous
-- period.
create or replace function public.visit_summary(p_tenant uuid, p_from date, p_to date)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= 400 then
    raise exception using errcode = '22023', message = 'visit_summary: a range of 1 to 400 days';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('visits', 0, 'one_page_visits', 0, 'visit_views', 0,
                              'service_visits', 0, 'service_inquiry_visits', 0,
                              'inquiry_visits', 0, 'by_day', '[]'::jsonb, 'first_day', null);
  end if;
  return (
    with r as (
      select v.day, v.visits, v.one_page_visits, v.visit_views, v.service_visits,
             v.service_inquiry_visits, v.inquiry_visits
        from public.rollup_daily_visits v
       where v.tenant_id = p_tenant and v.day between p_from and p_to
    )
    select jsonb_build_object(
             'visits', coalesce(sum(r.visits), 0),
             'one_page_visits', coalesce(sum(r.one_page_visits), 0),
             'visit_views', coalesce(sum(r.visit_views), 0),
             'service_visits', coalesce(sum(r.service_visits), 0),
             'service_inquiry_visits', coalesce(sum(r.service_inquiry_visits), 0),
             'inquiry_visits', coalesce(sum(r.inquiry_visits), 0),
             'by_day', coalesce(jsonb_agg(jsonb_build_object('day', r.day, 'visits', r.visits)
                                          order by r.day) filter (where r.day is not null),
                                '[]'::jsonb),
             'first_day', (select min(v.day) from public.rollup_daily_visits v
                            where v.tenant_id = p_tenant))
      from r
  );
end $$;

-- The Events card: clicks and interest in the range, the 20 busiest keys of each type (ties
-- by key), and each type's total over every key.
create or replace function public.event_summary(p_tenant uuid, p_from date, p_to date)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= 400 then
    raise exception using errcode = '22023', message = 'event_summary: a range of 1 to 400 days';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('cta', '[]'::jsonb, 'interest', '[]'::jsonb, 'cta_total', 0,
                              'interest_total', 0);
  end if;
  return (
    with r as (
      select e.event_type, e.key, sum(e.events) as events, sum(e.visits) as visits
        from public.rollup_daily_events e
       where e.tenant_id = p_tenant and e.day between p_from and p_to
       group by e.event_type, e.key
    )
    select jsonb_build_object(
             'cta', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'events', t.events,
                                                                  'visits', t.visits)
                                               order by t.events desc, t.key)
                                from (select * from r
                                       where r.event_type = 'cta_click' and r.key <> '*'
                                       order by r.events desc, r.key limit 20) t), '[]'::jsonb),
             'interest', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'events', t.events,
                                                                       'visits', t.visits)
                                                    order by t.events desc, t.key)
                                     from (select * from r
                                            where r.event_type = 'service_interest' and r.key <> '*'
                                            order by r.events desc, r.key limit 20) t), '[]'::jsonb),
             'cta_total', coalesce((select r.events from r
                                     where r.event_type = 'cta_click' and r.key = '*'), 0),
             'interest_total', coalesce((select r.events from r
                                          where r.event_type = 'service_interest' and r.key = '*'), 0))
  );
end $$;

-- The busiest hours: page views per local hour of day (0 to 23, every hour, zeros
-- included) over the whole UTC days [p_from, p_to], in p_tz (0035's allow-list).
create or replace function public.busy_hours(p_tenant uuid, p_from date, p_to date, p_tz text)
  returns table (hour integer, views bigint)
  language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= 400 then
    raise exception using errcode = '22023', message = 'busy_hours: a range of 1 to 400 days';
  end if;
  if p_tz is null or p_tz not in ('Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar',
                                  'Asia/Bahrain', 'Asia/Muscat', 'Africa/Cairo', 'Asia/Amman',
                                  'Europe/London', 'UTC') then
    raise exception using errcode = '22023', message = 'busy_hours: an unknown time zone';
  end if;
  return query
    with h as (
      select date_part('hour', r.hour at time zone p_tz)::int as hod, sum(r.views)::bigint as v
        from public.rollup_hourly_pageviews r
       where p_tenant is not distinct from app.effective_tenant_id()
         and r.tenant_id = p_tenant
         and r.hour >= (p_from::timestamp at time zone 'UTC')
         and r.hour < ((p_to + 1)::timestamp at time zone 'UTC')
       group by 1
    )
    select g.n, coalesce(h.v, 0)::bigint
      from generate_series(0, 23) as g(n)
      left join h on h.hod = g.n
     order by g.n;
end $$;

-- Realtime (G1b): the latest complete minute the rollup has written (this minute's run may
-- not have landed yet, so the one before stands in), the people active in the five minutes
-- ending with it and their pages, and page views per minute for the last 30 minutes, zeros
-- filled.
create or replace function public.realtime_summary(p_tenant uuid)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
declare
  v_last timestamptz := date_trunc('minute', pg_catalog.now() at time zone 'UTC') at time zone 'UTC'
                        - interval '1 minute';
  v_active int;
  v_paths jsonb;
begin
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('as_of', v_last, 'active_visits', 0, 'top_paths', '[]'::jsonb,
                              'per_minute', '[]'::jsonb);
  end if;
  select m.active_visits, m.top_paths into v_active, v_paths
    from public.rollup_minute_activity m
   where m.tenant_id = p_tenant and m.minute between v_last - interval '1 minute' and v_last
   order by m.minute desc
   limit 1;
  return jsonb_build_object(
    'as_of', v_last,
    'active_visits', coalesce(v_active, 0),
    'top_paths', coalesce(v_paths, '[]'::jsonb),
    'per_minute', (select jsonb_agg(jsonb_build_object('minute', g.m, 'views', coalesce(r.views, 0))
                                    order by g.m)
                     from generate_series(v_last - interval '29 minutes', v_last, interval '1 minute') as g(m)
                     left join public.rollup_minute_activity r
                       on r.tenant_id = p_tenant and r.minute = g.m));
end $$;

-- Goals (G1c), the oldest first, then by name: each goal with what it has counted this
-- calendar month (UTC days, the first of the month to today) from the rollups. Inquiries are
-- leads that arrived this month and are not spam, counted only for a role that works leads
-- (null for the others; RLS and the live check on leads still apply underneath).
create or replace function public.goal_progress(p_tenant uuid)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
declare
  v_month date := date_trunc('month', (pg_catalog.now() at time zone 'UTC'))::date;
  v_leads boolean := app.role_works_leads(app.current_role());
begin
  if p_tenant is distinct from app.effective_tenant_id() then
    return jsonb_build_object('month_start', v_month, 'goals', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'month_start', v_month,
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'metric', g.metric, 'cta', g.cta,
               'target', g.target, 'version', g.version,
               'done', case g.metric
                 when 'visits' then (select coalesce(sum(v.visits), 0) from public.rollup_daily_visits v
                                      where v.tenant_id = p_tenant and v.day >= v_month)
                 when 'service_visits' then (select coalesce(sum(v.service_visits), 0)
                                               from public.rollup_daily_visits v
                                              where v.tenant_id = p_tenant and v.day >= v_month)
                 when 'inquiry_visits' then (select coalesce(sum(v.inquiry_visits), 0)
                                               from public.rollup_daily_visits v
                                              where v.tenant_id = p_tenant and v.day >= v_month)
                 when 'pageviews' then (select coalesce(sum(p.views), 0)
                                          from public.rollup_daily_pageviews p
                                         where p.tenant_id = p_tenant and p.day >= v_month)
                 when 'cta' then (select coalesce(sum(e.events), 0) from public.rollup_daily_events e
                                   where e.tenant_id = p_tenant and e.day >= v_month
                                     and e.event_type = 'cta_click' and e.key = g.cta)
                 when 'interest' then (select coalesce(sum(e.events), 0)
                                         from public.rollup_daily_events e
                                        where e.tenant_id = p_tenant and e.day >= v_month
                                          and e.event_type = 'service_interest' and e.key = '*')
                 when 'inquiries' then case when v_leads then
                   (select count(*) from public.leads l
                     where l.tenant_id = p_tenant and not l.is_spam
                       and l.created_at >= (v_month::timestamp at time zone 'UTC')) end
               end)
             order by g.created_at, g.name, g.id)
        from public.analytics_goals g
       where g.tenant_id = p_tenant), '[]'::jsonb));
end $$;

revoke all on function public.visit_summary(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.event_summary(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.busy_hours(uuid, date, date, text) from public, anon, authenticated, service_role;
revoke all on function public.realtime_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function public.goal_progress(uuid) from public, anon, authenticated, service_role;
grant execute on function public.visit_summary(uuid, date, date) to authenticated;
grant execute on function public.event_summary(uuid, date, date) to authenticated;
grant execute on function public.busy_hours(uuid, date, date, text) to authenticated;
grant execute on function public.realtime_summary(uuid) to authenticated;
grant execute on function public.goal_progress(uuid) to authenticated;

-- ---- 12. The help guide ----------------------------------------------------------------------------
-- website-stats, rewritten for the tabs this slice adds (Overview v2, Conversions with the goals,
-- Audience, Realtime). One guide through H11's catalog (0069): the put takes the nine keys and the
-- revision main leaves the guide at (1: no put has changed it since the catalog was seeded), moves
-- it to 2 and re-seeds that one slug into every tenant; a stale revision is refused (55000). The
-- text is docs/admin-v2/guides/website-stats.json byte for byte (tests/lib/helpCentre.spec.ts).
select app.put_help_guide($guide$
{
  "slug": "website-stats",
  "sort_order": 110,
  "minutes": 3,
  "tags": ["stats", "goals"],
  "screens": ["/admin/analytics", "/admin/analytics/search"],
  "caps": ["analytics.read"],
  "title": "Website stats",
  "title_ar": "إحصاءات الموقع",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Website stats counts visits, page views and what people do on the site. The numbers are the site's own, with no outside tracker, and only visitors who accept analytics cookies are counted."
      },
      {
        "t": "ol",
        "x": [
          "Pick 7, 30 or 90 days at the top. Overview shows visits, page views, pages per visit, one-page visits, the Arabic share and the top pages; Pages lists every page with its views in each language. If you work with leads, Overview also shows new leads and inquiries per 1,000 page views.",
          "A visit is one browser tab on one day: a tab kept open past midnight UTC counts again the next day. Pages per visit is page views divided by visits; a one-page visit saw one page and did nothing else.",
          "Conversions shows the funnel: visits, then the visits that opened a service page, then the ones that went on to an inquiry form in the same visit. Inquiries received are shown apart, and only to people who work with leads, because they count everyone who wrote, including visitors who declined cookies. Events lists clicks on the contact, language, project and service links, and the interest shown in the services explorer.",
          "Audience shows the busiest hours of the day in Riyadh time over the days you picked, and English and Arabic views day by day. Devices, countries and sources are not collected.",
          "Realtime counts people who accepted analytics cookies and did something on the site in the last 5 minutes, and the pages they are on. It updates every minute while the tab is open; Pause updates stops it, and it stops by itself after 30 minutes. Minute counts are kept 48 hours.",
          "Admins and the SEO role can add goals on the Conversions tab: a name, what it counts and a target. Progress counts this calendar month, from the first, in UTC days. You can keep up to 20 goals.",
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
        "x": "تحتسب إحصاءات الموقع الزيارات ومشاهدات الصفحات وما يفعله الزوار في الموقع. الأرقام خاصة بالموقع نفسه دون أي أداة تتبع خارجية، ولا يُحتسب إلا من يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات."
      },
      {
        "t": "ol",
        "x": [
          "اختر 7 أو 30 أو 90 يومًا في الأعلى. يعرض تبويب Overview الزيارات ومشاهدات الصفحات وعدد الصفحات لكل زيارة وزيارات الصفحة الواحدة وحصة العربية وأكثر الصفحات زيارة، ويسرد تبويب Pages كل صفحة مع مشاهداتها بكل لغة. وإذا كنت تعمل على العملاء المحتملين فسيعرض Overview أيضًا العملاء الجدد والاستفسارات لكل 1,000 مشاهدة.",
          "الزيارة هي علامة تبويب واحدة في المتصفح خلال يوم واحد، فإذا بقيت علامة التبويب مفتوحة بعد منتصف الليل بتوقيت UTC احتُسبت زيارة جديدة في اليوم التالي. عدد الصفحات لكل زيارة هو المشاهدات مقسومة على الزيارات، وزيارة الصفحة الواحدة هي زيارة رأت صفحة واحدة ولم تفعل شيئًا آخر.",
          "يعرض تبويب Conversions مسار التحويل: الزيارات، ثم الزيارات التي فتحت صفحة خدمة، ثم التي وصلت بعدها إلى نموذج استفسار في الزيارة نفسها. وتظهر الاستفسارات الواردة منفصلة، ولمن يعمل على العملاء المحتملين فقط، لأنها تحتسب كل من كتب إلينا بمن فيهم الزوار الذين رفضوا ملفات تعريف الارتباط. ويسرد قسم Events النقرات على روابط التواصل واللغة والمشاريع والخدمات، والاهتمام الذي يظهره الزوار في مستكشف الخدمات.",
          "يعرض تبويب Audience أكثر ساعات اليوم نشاطًا بتوقيت الرياض خلال الأيام التي اخترتها، والمشاهدات بالإنجليزية والعربية يومًا بيوم. لا تُجمع بيانات الأجهزة أو الدول أو المصادر.",
          "يحتسب تبويب Realtime الأشخاص الذين قبلوا ملفات تعريف الارتباط الخاصة بالتحليلات وقاموا بأي نشاط في الموقع خلال آخر 5 دقائق، والصفحات التي يتصفحونها. ويتحدّث كل دقيقة ما دام التبويب مفتوحًا، ويوقفه زر Pause updates، ويتوقف من تلقاء نفسه بعد 30 دقيقة. وتُحفظ أرقام الدقائق 48 ساعة.",
          "يستطيع المسؤولون (Admin) ودور SEO إضافة أهداف في تبويب Conversions: اسم، وما يحتسبه الهدف، ورقم مستهدف. ويُحتسب التقدم خلال الشهر الحالي من أوله، بأيام توقيت UTC. ويمكن الاحتفاظ بما يصل إلى 20 هدفًا.",
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
}
$guide$::jsonb, 1);

-- ---- Postconditions ---------------------------------------------------------------------
-- Expressions are read as pg_get_expr prints them (each operator in parentheses, each AND list
-- in one pair; a function's schema printed only when app is not on the search path, so the
-- patterns allow both).
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_rollups constant text[] := array['rollup_daily_events', 'rollup_daily_visits',
                                     'rollup_hourly_pageviews', 'rollup_minute_activity'];
  v_have text[];
  v_bad text;
  v_n int;
  t text;
  p text;
begin
  -- ---- The index: on the parent and on every partition.
  if not exists (select 1 from pg_index x
                   join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
                  where x.indrelid = 'public.analytics_events'::regclass
                    and x.indnatts = 1 and a.attname = 'occurred_at') then
    raise exception '0071: analytics_events has no index on (occurred_at)';
  end if;
  select string_agg(c.relname, ', ') into v_bad
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
   where i.inhparent = 'public.analytics_events'::regclass
     and not exists (select 1 from pg_index x
                      join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
                     where x.indrelid = i.inhrelid and x.indnatts = 1 and a.attname = 'occurred_at');
  if v_bad is not null then
    raise exception '0071: partitions without the occurred_at index: %', v_bad;
  end if;

  -- ---- Raw telemetry: no policy on either parent; PUBLIC, anon and authenticated hold no
  -- privilege on a parent or a partition, table-wide or per column; the service role keeps
  -- SELECT, INSERT, UPDATE and DELETE on the parents.
  v_bad := app.raw_telemetry_exposure();
  if v_bad is not null then
    raise exception '0071: raw telemetry is still exposed: %', v_bad;
  end if;
  if has_function_privilege('public', 'app.raw_telemetry_exposure()', 'execute')
     or has_function_privilege('anon', 'app.raw_telemetry_exposure()', 'execute')
     or has_function_privilege('authenticated', 'app.raw_telemetry_exposure()', 'execute')
     or has_function_privilege('service_role', 'app.raw_telemetry_exposure()', 'execute') then
    raise exception '0071: an API role may execute app.raw_telemetry_exposure()';
  end if;
  foreach t in array array['public.analytics_events', 'public.web_vitals'] loop
    foreach p in array array['select', 'insert', 'update', 'delete'] loop
      if not has_table_privilege('service_role', t, p) then
        raise exception '0071: service_role lost % on %', p, t;
      end if;
    end loop;
  end loop;

  -- ---- The helper: exactly analytics.goals (Admin, SEO); staff and the service role execute
  -- it, anon and PUBLIC do not; inlinable (immutable, invoker).
  if not (app.role_analytics_goals('admin') and app.role_analytics_goals('seo')
          and not app.role_analytics_goals('content_creator')
          and not app.role_analytics_goals('developer')
          and not app.role_analytics_goals('anon') and not app.role_analytics_goals(null)) then
    raise exception '0071: app.role_analytics_goals does not answer analytics.goals (Admin, SEO)';
  end if;
  if not exists (select 1 from pg_proc where oid = 'app.role_analytics_goals(text)'::regprocedure
                    and provolatile = 'i' and not prosecdef)
     or not has_function_privilege('authenticated', 'app.role_analytics_goals(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_analytics_goals(text)', 'execute')
     or has_function_privilege('anon', 'app.role_analytics_goals(text)', 'execute')
     or has_function_privilege('public', 'app.role_analytics_goals(text)', 'execute') then
    raise exception '0071: app.role_analytics_goals must be immutable, invoker, executed by staff and the service role only';
  end if;

  -- ---- The four rollups: RLS on and forced; exactly one policy each, the tenant predicate
  -- then analytics.read on the token's role, no WITH CHECK.
  foreach t in array v_rollups loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = format('public.%I', t)::regclass) then
      raise exception '0071: % is not ENABLE + FORCE row level security', t;
    end if;
    select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                              order by policyname), '{}') into v_have
      from pg_policies where schemaname = 'public' and tablename = t;
    if v_have is distinct from array[format('%s_read SELECT PERMISSIVE {authenticated}', t)] then
      raise exception '0071: % policies are %, expected %_read alone', t, v_have, t;
    end if;
    if exists (select 1 from pg_policies pp
                where pp.schemaname = 'public' and pp.tablename = t
                  and (pp.with_check is not null
                       or pp.qual !~ ('^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?'
                                      || 'role_analytics_read\((app\.)?"current_role"\(\)\)\)$'))) then
      raise exception '0071: the read policy on % is not the tenant predicate then analytics.read', t;
    end if;
    -- Privileges: PUBLIC and anon nothing; authenticated SELECT; the service role the four;
    -- no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN for anyone; no column grant.
    select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
      from (select x.who, pr.priv,
                   has_table_privilege(x.who::name, format('public.%I', t), pr.priv) as held,
                   pr.priv = any (x.allowed) as wanted
              from (values ('public', array[]::text[]),
                           ('anon', array[]::text[]),
                           ('authenticated', array['select']),
                           ('service_role', array['select', 'insert', 'update', 'delete']))
                     as x(who, allowed)
              cross join unnest(v_privs) as pr(priv)) g
     where g.held is distinct from g.wanted;
    if v_bad is not null then
      raise exception '0071: wrong table privileges on % (role privilege): %', t, v_bad;
    end if;
    if exists (select 1 from pg_attribute a
                where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0
                  and not a.attisdropped and cardinality(coalesce(a.attacl, '{}'::aclitem[])) > 0) then
      raise exception '0071: % carries a column grant', t;
    end if;
  end loop;

  -- ---- analytics_goals: RLS on and forced; the exact policy set, each with the tenant
  -- predicate first (the RESTRICTIVE ones included).
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.analytics_goals'::regclass) then
    raise exception '0071: analytics_goals is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                            order by policyname), '{}') into v_have
    from pg_policies where schemaname = 'public' and tablename = 'analytics_goals';
  if v_have is distinct from array[
       'analytics_goals_delete DELETE PERMISSIVE {authenticated}',
       'analytics_goals_insert INSERT PERMISSIVE {authenticated}',
       'analytics_goals_live_delete DELETE RESTRICTIVE {authenticated}',
       'analytics_goals_live_insert INSERT RESTRICTIVE {authenticated}',
       'analytics_goals_live_read SELECT RESTRICTIVE {authenticated}',
       'analytics_goals_live_update UPDATE RESTRICTIVE {authenticated}',
       'analytics_goals_read SELECT PERMISSIVE {authenticated}',
       'analytics_goals_update UPDATE PERMISSIVE {authenticated}'] then
    raise exception '0071: analytics_goals policies are %', v_have;
  end if;
  select string_agg(pp.policyname, ', ') into v_bad
    from pg_policies pp
   where pp.schemaname = 'public' and pp.tablename = 'analytics_goals'
     and (not (coalesce(pp.qual, '') ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '
               or (pp.qual is null and pp.cmd = 'INSERT'))
          or (pp.with_check is not null
              and pp.with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '));
  if v_bad is not null then
    raise exception '0071: analytics_goals policies without the tenant predicate first: %', v_bad;
  end if;
  select string_agg(pp.policyname, ', ') into v_bad
    from pg_policies pp
   where pp.schemaname = 'public' and pp.tablename = 'analytics_goals'
     and (((pp.policyname like '%live%') is distinct from
           (coalesce(pp.qual, pp.with_check) ~ 'live_role\(\)'))
          or (pp.cmd <> 'SELECT' and coalesce(pp.qual, pp.with_check) !~ 'role_analytics_goals\(')
          or (pp.cmd = 'SELECT' and pp.qual !~ 'role_analytics_read\('));
  if v_bad is not null then
    raise exception '0071: analytics_goals policies with the wrong helper or layer: %', v_bad;
  end if;

  -- Its privileges: authenticated SELECT and DELETE table-wide, INSERT on the five columns and
  -- UPDATE on the four, nothing else; the service role the four; PUBLIC and anon nothing.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.analytics_goals', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select', 'delete']),
                         ('service_role', array['select', 'insert', 'update', 'delete']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0071: wrong table privileges on analytics_goals (role privilege): %', v_bad;
  end if;
  select string_agg(format('%s %s.%s', x.who, pr.priv, a.attname), ', ' order by a.attname, pr.priv)
    into v_bad
    from pg_attribute a
    cross join (values ('insert'), ('update'), ('references')) as pr(priv)
    cross join (values ('authenticated'), ('anon'), ('public')) as x(who)
   where a.attrelid = 'public.analytics_goals'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege(x.who::name, 'public.analytics_goals', a.attname, pr.priv)
         is distinct from (x.who = 'authenticated'
                           and ((pr.priv = 'insert' and a.attname in ('tenant_id', 'name', 'metric', 'cta', 'target'))
                                or (pr.priv = 'update' and a.attname in ('name', 'metric', 'cta', 'target'))));
  if v_bad is not null then
    raise exception '0071: wrong column privileges on analytics_goals: %', v_bad;
  end if;
  if has_any_column_privilege('anon', 'public.analytics_goals', 'select')
     or has_any_column_privilege('public', 'public.analytics_goals', 'select') then
    raise exception '0071: anon or PUBLIC may read analytics_goals';
  end if;

  -- Its triggers, in their firing order.
  select coalesce(array_agg(tg.tgname::text order by tg.tgname), '{}') into v_have
    from pg_trigger tg
   where tg.tgrelid = 'public.analytics_goals'::regclass and not tg.tgisinternal;
  if v_have is distinct from array['analytics_goals_actor', 'analytics_goals_limit',
                                   'analytics_goals_updated_at', 'analytics_goals_version'] then
    raise exception '0071: analytics_goals triggers are %', v_have;
  end if;
  -- The limit counts after RLS accepted the row (AFTER INSERT, FOR EACH ROW): see above.
  if not exists (select 1 from pg_trigger tg
                  where tg.tgrelid = 'public.analytics_goals'::regclass
                    and tg.tgname = 'analytics_goals_limit'
                    and pg_get_triggerdef(tg.oid) ~ 'AFTER INSERT ON public\.analytics_goals FOR EACH ROW') then
    raise exception '0071: analytics_goals_limit must be an AFTER INSERT row trigger';
  end if;

  -- ---- Functions: the rollups and the limit are definers with an empty search path that no
  -- API role executes; the readers are invokers with an empty search path that staff alone
  -- execute.
  foreach p in array array['app.rollup_visits(integer)', 'app.rollup_realtime()',
                           'app.tg_analytics_goals_limit()'] loop
    if has_function_privilege('public', p, 'execute') or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0071: an API role may execute %', p;
    end if;
    if not exists (select 1 from pg_proc where oid = p::regprocedure and prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0071: % must be SECURITY DEFINER with an empty search_path', p;
    end if;
  end loop;
  foreach p in array array['public.visit_summary(uuid, date, date)',
                           'public.event_summary(uuid, date, date)',
                           'public.busy_hours(uuid, date, date, text)',
                           'public.realtime_summary(uuid)',
                           'public.goal_progress(uuid)'] loop
    if has_function_privilege('public', p, 'execute') or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('service_role', p, 'execute')
       or not has_function_privilege('authenticated', p, 'execute') then
      raise exception '0071: % must be executable by authenticated alone', p;
    end if;
    if exists (select 1 from pg_proc where oid = p::regprocedure and prosecdef) then
      raise exception '0071: % must be SECURITY INVOKER (RLS decides what it returns)', p;
    end if;
    if not exists (select 1 from pg_proc where oid = p::regprocedure
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0071: % must set an empty search_path', p;
    end if;
  end loop;

  -- ---- The help guide: the catalog holds this slice's website-stats, and every tenant a copy.
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'website-stats' and c.revision >= 2
                    and c.tags = array['stats', 'goals']) then
    raise exception '0071: the catalog does not hold G1''s website-stats guide';
  end if;
  select count(*)::int into v_n
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'website-stats'
                        and h.tags = array['stats', 'goals']);
  if v_n <> 0 then
    raise exception '0071: % tenant(s) lack G1''s website-stats guide', v_n;
  end if;

  -- ---- The jobs, when pg_cron is there.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select count(*)::int from cron.job
                where (jobname = 'rollup-visits' and schedule = '4-59/15 * * * *'
                       and command ~ 'app\.rollup_visits\(3\)')
                   or (jobname = 'rollup-realtime' and schedule = '* * * * *'
                       and command ~ 'app\.rollup_realtime\(\)')$q$ into v_n;
    if v_n <> 2 then
      raise exception '0071: the rollup-visits and rollup-realtime jobs are not both scheduled';
    end if;
  end if;
end $$;
