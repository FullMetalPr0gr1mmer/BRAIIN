-- pgTAP: telemetry partitions (migration 0037, hotfix H8).
--
-- `analytics_events` and `web_vitals` are partitioned by month. A partition is a table of
-- its own, with its own RLS flags and ACL, and CREATE TABLE … PARTITION OF copies neither
-- from the parent. Until 0037 every partition had RLS off, with the GRANT layer alone
-- between it and a direct read. This file pins:
--
--   1. every partition the migrations leave is RLS ENABLE + FORCE and grants public, anon
--      and authenticated nothing (0037's catalog loop);
--   2. so is every partition app.ensure_telemetry_partitions() creates later: it is called
--      here, inside this transaction, 15 months ahead;
--   3. writes through the parents still land, in those RLS-forced partitions;
--   4. reads through the parents are unchanged: the PARENT's policies decide, over the §9
--      role set {admin, developer, seo, content_creator, other_tenant, anon};
--   5. naming a partition directly is refused at the GRANT layer, for anon and for staff;
--   6. and at the RLS layer if a grant ever slips back: no policy, so no row.
--
-- The fixture tenant is this file's own: anon is refused at the GRANT layer before the anon
-- tenant fence could matter, and every count is scoped to this file's rows (path '/__h8').
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §9.

begin;
select plan(32);

-- ── helpers (rolled back with the file) ─────────────────────────────────────────
create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- This month's partition of a parent, named exactly as app.ensure_telemetry_partitions()
-- names it (now() is fixed for the whole transaction).
create function _cur(p_parent text) returns text language sql stable as $$
  select p_parent || '_' || to_char((date_trunc('month', now()) + make_interval(months => 0))::date, 'YYYY_MM')
$$;

-- This file's rows in one relation, counted as the CURRENT role (security invoker), so a
-- partition can be named dynamically.
create function _count(p_rel text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute format('select count(*)::int from public.%I where path = %L', p_rel, '/__h8') into n;
  return n;
end $f$;

-- ── 1. the partitions the migrations leave ─────────────────────────────────────
select is(
  (select coalesce(string_agg(c.relname::text, ', ' order by c.relname), '')
     from pg_inherits i
     join pg_class c on c.oid = i.inhrelid
    where i.inhparent in ('public.analytics_events'::regclass, 'public.web_vitals'::regclass)
      and not (c.relrowsecurity and c.relforcerowsecurity)),
  '',
  'every existing telemetry partition has RLS enabled AND forced');
select ok(
  (select count(*) = 2 and bool_and(relrowsecurity and relforcerowsecurity)
     from pg_class
    where oid in (to_regclass('public.analytics_events_default'),
                  to_regclass('public.web_vitals_default'))),
  'both catch-all default partitions exist and have RLS enabled AND forced');
-- Table or column, any privilege. 'public' is the PUBLIC pseudo-role to has_*_privilege.
select is(
  (select coalesce(string_agg(format('%s on %s', g.grantee, c.relname), ', '
                              order by c.relname, g.grantee), '')
     from pg_inherits i
     join pg_class c on c.oid = i.inhrelid
     cross join (values ('public'::name), ('anon'::name), ('authenticated'::name)) as g(grantee)
    where i.inhparent in ('public.analytics_events'::regclass, 'public.web_vitals'::regclass)
      and (has_table_privilege(g.grantee, c.oid,
                               'select, insert, update, delete, truncate, references, trigger')
           or has_any_column_privilege(g.grantee, c.oid, 'select, insert, update, references'))),
  '',
  'no existing partition grants public, anon or authenticated anything');

-- ── 2. the partitions the roll-forward creates ──────────────────────────────────
-- In a fresh database only 0002's partitions exist (June and July 2026), so this creates
-- this month and the next 14 for both parents. Supabase's default privileges would hand each
-- new table to `authenticated`; the function must take that back and switch RLS on.
select cmp_ok(app.ensure_telemetry_partitions(14), '>', 0,
  'app.ensure_telemetry_partitions(14) creates partitions inside this transaction');
select is(
  (select count(*)::int
     from generate_series(0, 14) as m(i)
     cross join (values ('analytics_events'), ('web_vitals')) as p(parent)
     join pg_class c
       on c.relnamespace = 'public'::regnamespace
      and c.relname = p.parent || '_'
                      || to_char((date_trunc('month', now()) + make_interval(months => m.i))::date, 'YYYY_MM')
     join pg_inherits inh on inh.inhrelid = c.oid
     join pg_class par on par.oid = inh.inhparent and par.relname = p.parent
    where c.relrowsecurity and c.relforcerowsecurity),
  30,
  'all 30 partitions it owns (this month + 14, both parents) exist with RLS enabled AND forced');
select is(
  (select coalesce(string_agg(format('%s on %s', g.grantee, c.relname), ', '
                              order by c.relname, g.grantee), '')
     from pg_inherits i
     join pg_class c on c.oid = i.inhrelid
     cross join (values ('public'::name), ('anon'::name), ('authenticated'::name)) as g(grantee)
    where i.inhparent in ('public.analytics_events'::regclass, 'public.web_vitals'::regclass)
      and (has_table_privilege(g.grantee, c.oid,
                               'select, insert, update, delete, truncate, references, trigger')
           or has_any_column_privilege(g.grantee, c.oid, 'select, insert, update, references'))),
  '',
  'no partition, the new ones included, grants public, anon or authenticated anything');
select ok(
  not has_function_privilege('anon', 'app.ensure_telemetry_partitions(int)', 'execute')
  and not has_function_privilege('authenticated', 'app.ensure_telemetry_partitions(int)', 'execute')
  and not has_function_privilege('service_role', 'app.ensure_telemetry_partitions(int)', 'execute'),
  'no API role can execute app.ensure_telemetry_partitions() (0037 re-asserts 0011)');

-- ── 3. writes through the parents ──────────────────────────────────────────────
-- The fixture rows (after the roll-forward, so they route into this month's new partition
-- rather than the default one, which would then block creating it).
insert into public.analytics_events (tenant_id, event_type, path, locale)
  values ('37000000-0000-0000-0000-000000000001', 'pageview', '/__h8', 'en');
insert into public.web_vitals (tenant_id, metric, value, rating, path)
  values ('37000000-0000-0000-0000-000000000001', 'LCP', 1800, 'good', '/__h8');

-- The ingest (src/lib/data/telemetry.ts) inserts into the PARENTS as service_role; tuple
-- routing applies the parent's rules, never the partition's. Its own path, so the counts
-- below are the fixture's alone.
set local role service_role;
select lives_ok(
  $$ insert into public.analytics_events (tenant_id, event_type, path, locale)
     values ('37000000-0000-0000-0000-000000000001', 'pageview', '/__h8-ingest', 'en') $$,
  'service_role still ingests analytics events through the parent');
select lives_ok(
  $$ insert into public.web_vitals (tenant_id, metric, value, rating, path)
     values ('37000000-0000-0000-0000-000000000001', 'INP', 120, 'good', '/__h8-ingest') $$,
  'service_role still ingests web vitals through the parent');
reset role;
select is(
  _count(_cur('analytics_events')) + _count(_cur('web_vitals')),
  2,
  'the fixture rows sit in this month''s partitions, RLS enabled and forced, no policy');

-- ── 4. reads through the parents: the parents' policies decide ─────────────────────
-- 0002: analytics_events → admin, developer, seo; web_vitals → admin, developer (the site
-- health panel); both tenant-scoped. 0011 granted SELECT on both to authenticated, none to
-- anon. Every row read here lives in a partition whose own RLS would return nothing.
set local role authenticated;
select _claims('admin', '37000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.analytics_events where path = '/__h8'), 1,
  'admin reads analytics_events through the parent');
select is((select count(*)::int from public.web_vitals where path = '/__h8'), 1,
  'admin reads web_vitals through the parent');
select _claims('developer', '37000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.analytics_events where path = '/__h8'), 1,
  'developer reads analytics_events through the parent');
select is((select count(*)::int from public.web_vitals where path = '/__h8'), 1,
  'developer reads web_vitals through the parent (site health)');
select _claims('seo', '37000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.analytics_events where path = '/__h8'), 1,
  'seo reads analytics_events through the parent');
select is((select count(*)::int from public.web_vitals where path = '/__h8'), 0,
  'seo reads no web_vitals (Admin + Developer only)');
select _claims('content_creator', '37000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.analytics_events where path = '/__h8'), 0,
  'content_creator reads no analytics_events');
select is((select count(*)::int from public.web_vitals where path = '/__h8'), 0,
  'content_creator reads no web_vitals');
select _claims('admin', '37000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.analytics_events where path = '/__h8'), 0,
  'an admin of another tenant reads no analytics_events');
select is((select count(*)::int from public.web_vitals where path = '/__h8'), 0,
  'an admin of another tenant reads no web_vitals');
set local role anon;
select _claims(null, null);
select throws_ok($$ select count(*) from public.analytics_events $$, '42501', null,
  'anon is refused analytics_events at the GRANT layer');
select throws_ok($$ select count(*) from public.web_vitals $$, '42501', null,
  'anon is refused web_vitals at the GRANT layer');

-- ── 5. naming a partition directly: refused at the GRANT layer ─────────────────────
-- The defaults existed before 0037 (its catalog loop); this month's were created above (the
-- function). Still anon here.
select throws_ok($$ select count(*) from public.analytics_events_default $$, '42501', null,
  'anon cannot read analytics_events_default directly');
select throws_ok($$ select count(*) from public.web_vitals_default $$, '42501', null,
  'anon cannot read web_vitals_default directly');
select throws_ok(format('select count(*) from public.%I', _cur('analytics_events')), '42501', null,
  'anon cannot read this month''s analytics_events partition directly');
select throws_ok(format('select count(*) from public.%I', _cur('web_vitals')), '42501', null,
  'anon cannot read this month''s web_vitals partition directly');
-- Every staff role connects as `authenticated`, so the role claim cannot change a GRANT
-- decision; admin, the strongest claim, stands for all four.
set local role authenticated;
select _claims('admin', '37000000-0000-0000-0000-000000000001');
select throws_ok($$ select count(*) from public.analytics_events_default $$, '42501', null,
  'admin cannot read analytics_events_default directly');
select throws_ok($$ select count(*) from public.web_vitals_default $$, '42501', null,
  'admin cannot read web_vitals_default directly');
select throws_ok(format('select count(*) from public.%I', _cur('analytics_events')), '42501', null,
  'admin cannot read this month''s analytics_events partition directly');
select throws_ok(format('select count(*) from public.%I', _cur('web_vitals')), '42501', null,
  'admin cannot read this month''s web_vitals partition directly');

-- ── 6. …and at the RLS layer, if a grant ever slips back ──────────────────────────
-- The mistake 0011 and 0037 exist to prevent, made on purpose (rolled back with the file):
-- with SELECT granted, the partition's own RLS (enabled, no policy) still returns no row,
-- while the same admin reads that row through the parent in section 4.
reset role;
do $$
begin
  execute format('grant select on public.%I, public.%I to authenticated',
                 _cur('analytics_events'), _cur('web_vitals'));
end $$;
set local role authenticated;
select _claims('admin', '37000000-0000-0000-0000-000000000001');
select is(_count(_cur('analytics_events')), 0,
  'with a stray grant, admin still reads no row from the analytics_events partition (RLS, no policy)');
select is(_count(_cur('web_vitals')), 0,
  'with a stray grant, admin still reads no row from the web_vitals partition (RLS, no policy)');
reset role;

select * from finish();
rollback;
