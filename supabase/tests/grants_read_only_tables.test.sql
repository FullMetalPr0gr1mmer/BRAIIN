-- pgTAP: the tables staff only read, and their GRANT layer (migration 0037 part B, hotfix H8).
--
-- 0011 §5d treats eight tables as read-only for staff: analytics_events, web_vitals,
-- rollup_daily_pageviews, search_queries, consent_log, notification_log, tenants and
-- profiles. It granted `authenticated` SELECT on them and never revoked Supabase's default
-- INSERT/UPDATE/DELETE/TRUNCATE, so RLS alone stood in front of a staff write, and TRUNCATE
-- is not subject to RLS. 0037 withdraws them; the users screen keeps UPDATE on
-- profiles.role, is_active and display_name. This file pins:
--
--   1. the catalog: authenticated holds SELECT only at table level, and UPDATE on exactly
--      those three columns at column level; anon and PUBLIC hold nothing; the service role
--      holds SELECT/INSERT/UPDATE/DELETE, and USAGE on the three bigserial sequences;
--   2. for each of admin, developer, seo and content_creator: every table still reads
--      exactly as its RLS policy allows (the reads that work today), and a direct INSERT,
--      UPDATE, DELETE and TRUNCATE on every table is refused by the GRANT layer;
--   3. the users screen still works: an admin changes a colleague's role, status and name,
--      and no other role changes a profile, not even its own;
--   4. the service role still writes telemetry.
--
-- The refusals check the message as well as 42501. RLS raises 42501 too ("new row violates
-- row-level security policy"), and only "permission denied for table …" shows that the GRANT
-- layer refused. Each probe touches no row (WHERE false) and runs in a DO block that raises
-- P0001 if it was NOT refused, so a regression fails with its own diagnostic and rolls back.
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §5, §9.

begin;
-- 5 catalog + 4 roles × (8 reads + 32 refusals) + 4 users screen + 3 service-role writes
select plan(172);

-- ── helpers (rolled back with the file) ─────────────────────────────────────────
create function _claims(p_role text, p_tid text, p_sub text default null) returns void
  language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true
  )
$$;

-- Rows a statement touched, as the CURRENT role.
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;

create function _tables() returns setof regclass language sql stable as $$
  values ('public.analytics_events'::regclass), ('public.web_vitals'::regclass),
         ('public.rollup_daily_pageviews'::regclass), ('public.search_queries'::regclass),
         ('public.consent_log'::regclass), ('public.notification_log'::regclass),
         ('public.tenants'::regclass), ('public.profiles'::regclass)
$$;

-- One role's row of the matrix, as the CURRENT role: 8 reads, then 32 refusals.
create function _matrix(p_role text, p_sub text) returns setof text language plpgsql as $f$
declare
  t constant text := '37000000-0000-0000-0000-000000000001';
  r record;
  n int;
begin
  perform _claims(p_role, t, p_sub);

  -- Reads: this file's rows, as each table's RLS policy shows them (0037 changes none).
  -- profiles: an admin sees the tenant's four, everyone else only their own row.
  for r in
    select * from (values
      ('analytics_events',       'tenant_id', 1, 1, 1, 0),
      ('web_vitals',             'tenant_id', 1, 1, 0, 0),
      ('rollup_daily_pageviews', 'tenant_id', 1, 1, 1, 1),
      ('search_queries',         'tenant_id', 1, 1, 1, 0),
      ('consent_log',            'tenant_id', 1, 1, 0, 0),
      ('notification_log',       'tenant_id', 1, 1, 0, 0),
      ('tenants',                'id',        1, 1, 1, 1),
      ('profiles',               'tenant_id', 4, 1, 1, 1)
    ) as v(tbl, col, admin, developer, seo, content_creator)
  loop
    execute format('select count(*)::int from public.%I where %I = %L', r.tbl, r.col, t) into n;
    return next is(
      n,
      case p_role when 'admin' then r.admin when 'developer' then r.developer
                  when 'seo' then r.seo else r.content_creator end,
      format('%s reads %s as its policy allows', p_role, r.tbl));
  end loop;

  -- Writes: every command on every table, refused before RLS is consulted. The profiles
  -- UPDATE names locked_until, a column outside the users screen's three.
  for r in
    select * from (values
      ('analytics_events', 'insert', $$insert into public.analytics_events (tenant_id, event_type) select gen_random_uuid(), 'probe' where false$$),
      ('analytics_events', 'update', $$update public.analytics_events set path = path where false$$),
      ('analytics_events', 'delete', $$delete from public.analytics_events where false$$),
      ('analytics_events', 'truncate', $$truncate public.analytics_events$$),
      ('web_vitals', 'insert', $$insert into public.web_vitals (tenant_id, metric, value) select gen_random_uuid(), 'LCP', 1 where false$$),
      ('web_vitals', 'update', $$update public.web_vitals set path = path where false$$),
      ('web_vitals', 'delete', $$delete from public.web_vitals where false$$),
      ('web_vitals', 'truncate', $$truncate public.web_vitals$$),
      ('rollup_daily_pageviews', 'insert', $$insert into public.rollup_daily_pageviews (tenant_id, day, path) select gen_random_uuid(), current_date, '/' where false$$),
      ('rollup_daily_pageviews', 'update', $$update public.rollup_daily_pageviews set views = views where false$$),
      ('rollup_daily_pageviews', 'delete', $$delete from public.rollup_daily_pageviews where false$$),
      ('rollup_daily_pageviews', 'truncate', $$truncate public.rollup_daily_pageviews$$),
      ('search_queries', 'insert', $$insert into public.search_queries (tenant_id, q) select gen_random_uuid(), 'probe' where false$$),
      ('search_queries', 'update', $$update public.search_queries set q = q where false$$),
      ('search_queries', 'delete', $$delete from public.search_queries where false$$),
      ('search_queries', 'truncate', $$truncate public.search_queries$$),
      ('consent_log', 'insert', $$insert into public.consent_log (tenant_id, subject_hash, categories, policy_version) select gen_random_uuid(), 'probe', '{}'::jsonb, 'probe' where false$$),
      ('consent_log', 'update', $$update public.consent_log set action = action where false$$),
      ('consent_log', 'delete', $$delete from public.consent_log where false$$),
      ('consent_log', 'truncate', $$truncate public.consent_log$$),
      ('notification_log', 'insert', $$insert into public.notification_log (tenant_id, channel, status) select gen_random_uuid(), 'email', 'queued' where false$$),
      ('notification_log', 'update', $$update public.notification_log set status = status where false$$),
      ('notification_log', 'delete', $$delete from public.notification_log where false$$),
      ('notification_log', 'truncate', $$truncate public.notification_log$$),
      ('tenants', 'insert', $$insert into public.tenants (id, name) select gen_random_uuid(), 'probe' where false$$),
      ('tenants', 'update', $$update public.tenants set name = name where false$$),
      ('tenants', 'delete', $$delete from public.tenants where false$$),
      ('tenants', 'truncate', $$truncate public.tenants$$),
      ('profiles', 'insert', $$insert into public.profiles (id, tenant_id) select gen_random_uuid(), gen_random_uuid() where false$$),
      ('profiles', 'update (locked_until)', $$update public.profiles set locked_until = null where false$$),
      ('profiles', 'delete', $$delete from public.profiles where false$$),
      ('profiles', 'truncate', $$truncate public.profiles$$)
    ) as v(tbl, cmd, stmt)
  loop
    return next throws_ok(
      format('do $p$ begin %s; raise exception %L using errcode = %L; end $p$',
             r.stmt, 'not refused', 'P0001'),
      '42501',
      format('permission denied for table %s', r.tbl),
      format('%s: %s on %s is refused by the GRANT layer', p_role, r.cmd, r.tbl));
  end loop;
end $f$;

-- ── fixtures (as the migration role) ─────────────────────────────────────────────
-- A tenant of this file's own, four staff (one per role) and one row in every table.
insert into public.tenants (id, name) values ('37000000-0000-0000-0000-000000000001', 'H8');
insert into auth.users (id, email) values
  ('37000000-0000-0000-0000-0000000000a1', 'h8-admin@example.test'),
  ('37000000-0000-0000-0000-0000000000a2', 'h8-developer@example.test'),
  ('37000000-0000-0000-0000-0000000000a3', 'h8-seo@example.test'),
  ('37000000-0000-0000-0000-0000000000a4', 'h8-creator@example.test');
insert into public.profiles (id, tenant_id, role) values
  ('37000000-0000-0000-0000-0000000000a1', '37000000-0000-0000-0000-000000000001', 'admin'),
  ('37000000-0000-0000-0000-0000000000a2', '37000000-0000-0000-0000-000000000001', 'developer'),
  ('37000000-0000-0000-0000-0000000000a3', '37000000-0000-0000-0000-000000000001', 'seo'),
  ('37000000-0000-0000-0000-0000000000a4', '37000000-0000-0000-0000-000000000001', 'content_creator');
insert into public.analytics_events (tenant_id, event_type, path)
  values ('37000000-0000-0000-0000-000000000001', 'pageview', '/__h8');
insert into public.web_vitals (tenant_id, metric, value, path)
  values ('37000000-0000-0000-0000-000000000001', 'LCP', 1800, '/__h8');
insert into public.rollup_daily_pageviews (tenant_id, day, path, locale, views)
  values ('37000000-0000-0000-0000-000000000001', current_date, '/__h8', 'en', 1);
insert into public.search_queries (tenant_id, q)
  values ('37000000-0000-0000-0000-000000000001', 'h8');
insert into public.consent_log (tenant_id, subject_hash, categories, policy_version)
  values ('37000000-0000-0000-0000-000000000001', 'h8-subject', '{"analytics": true}', '2026-10-07');
insert into public.notification_log (tenant_id, channel, status)
  values ('37000000-0000-0000-0000-000000000001', 'email', 'queued');

-- ── 1. the catalog (both grant regimes: table and column) ─────────────────────────
select is(
  (select coalesce(string_agg(format('%s %s', p.priv, c.relname), ', '
                              order by c.relname, p.priv), '')
     from pg_class c
     cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                        ('references'), ('trigger')) as p(priv)
    where c.oid in (select * from _tables())
      and has_table_privilege('authenticated', c.oid, p.priv) is distinct from (p.priv = 'select')),
  '',
  'authenticated holds SELECT and nothing else on the eight tables (table level)');
select is(
  (select coalesce(string_agg(format('%s %s.%s', p.priv, c.relname, a.attname), ', '
                              order by c.relname, a.attname, p.priv), '')
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     cross join (values ('insert'), ('update'), ('references')) as p(priv)
    where c.oid in (select * from _tables())
      and has_column_privilege('authenticated', c.oid, a.attnum, p.priv)),
  'update profiles.display_name, update profiles.is_active, update profiles.role',
  'at column level authenticated may UPDATE profiles.role, is_active and display_name, nothing else');
-- 'public' is the PUBLIC pseudo-role to has_*_privilege.
select is(
  (select coalesce(string_agg(format('%s on %s', g.grantee, c.relname), ', '
                              order by c.relname, g.grantee), '')
     from pg_class c
     cross join (values ('public'::name), ('anon'::name)) as g(grantee)
    where c.oid in (select * from _tables())
      and (has_table_privilege(g.grantee, c.oid,
                               'select, insert, update, delete, truncate, references, trigger')
           or has_any_column_privilege(g.grantee, c.oid, 'select, insert, update, references'))),
  '',
  'anon and PUBLIC hold nothing on them');
select is(
  (select coalesce(string_agg(format('%s %s', p.priv, c.relname), ', '
                              order by c.relname, p.priv), '')
     from pg_class c
     cross join (values ('select'), ('insert'), ('update'), ('delete')) as p(priv)
    where c.oid in (select * from _tables())
      and not has_table_privilege('service_role', c.oid, p.priv)),
  '',
  'the service role holds SELECT, INSERT, UPDATE and DELETE on each (stated, not inherited)');
select is(
  (select coalesce(string_agg(s.seq::text, ', ' order by s.seq::text), '')
     from (select pg_get_serial_sequence(format('public.%I', t), 'id')::regclass as seq
             from unnest(array['search_queries', 'consent_log', 'notification_log']) as t) as s
    where not has_sequence_privilege('service_role', s.seq, 'usage')
       or has_sequence_privilege('authenticated', s.seq, 'usage, select, update')
       or has_sequence_privilege('anon', s.seq, 'usage, select, update')),
  '',
  'the three bigserial sequences: USAGE for the service role, nothing for anon or authenticated');

-- ── 2. per staff role: the reads that work today, and no direct write ───────────────
-- All four staff roles connect as `authenticated`; the claims decide what RLS shows.
set local role authenticated;
select * from _matrix('admin', '37000000-0000-0000-0000-0000000000a1');
select * from _matrix('developer', '37000000-0000-0000-0000-0000000000a2');
select * from _matrix('seo', '37000000-0000-0000-0000-0000000000a3');
select * from _matrix('content_creator', '37000000-0000-0000-0000-0000000000a4');

-- ── 3. the users screen (PATCH /api/admin/users/[id], through the session client) ────
select _claims('admin', '37000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-0000000000a1');
select is(
  _rows($$ update public.profiles set role = 'seo', is_active = false, display_name = 'Renamed'
           where tenant_id = '37000000-0000-0000-0000-000000000001'
             and id = '37000000-0000-0000-0000-0000000000a4' $$),
  1,
  'admin still changes a colleague''s role, status and name (the users screen)');
select _claims('developer', '37000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-0000000000a2');
select is(
  _rows($$ update public.profiles set display_name = 'Self'
           where id = '37000000-0000-0000-0000-0000000000a2' $$),
  0,
  'developer changes no profile, not even its own (RLS: Admin only)');
select _claims('seo', '37000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-0000000000a3');
select is(
  _rows($$ update public.profiles set display_name = 'Self'
           where id = '37000000-0000-0000-0000-0000000000a3' $$),
  0,
  'seo changes no profile, not even its own (RLS: Admin only)');
select _claims('content_creator', '37000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-0000000000a4');
select is(
  _rows($$ update public.profiles set display_name = 'Self'
           where id = '37000000-0000-0000-0000-0000000000a4' $$),
  0,
  'content_creator changes no profile, not even its own (RLS: Admin only)');

-- ── 4. the service role still writes telemetry ──────────────────────────────────────
reset role;
set local role service_role;
select lives_ok(
  $$ insert into public.analytics_events (tenant_id, event_type, path)
     values ('37000000-0000-0000-0000-000000000001', 'pageview', '/__h8-svc') $$,
  'the service role still ingests analytics events');
select lives_ok(
  $$ insert into public.web_vitals (tenant_id, metric, value, path)
     values ('37000000-0000-0000-0000-000000000001', 'CLS', 0.01, '/__h8-svc') $$,
  'the service role still ingests web vitals');
select lives_ok(
  $$ insert into public.search_queries (tenant_id, q, locale, results_count)
     values ('37000000-0000-0000-0000-000000000001', 'h8', 'ar', 2) $$,
  'the service role still logs searches, drawing the id from the sequence');
reset role;

select * from finish();
rollback;
