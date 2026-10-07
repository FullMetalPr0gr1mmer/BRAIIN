-- ─────────────────────────────────────────────────────────────────────────────
-- 0037 — Telemetry partitions: RLS enabled and forced on every one (hotfix H8).
-- Forward-only. Depends on 0002, 0008, 0011.
--
-- `analytics_events` and `web_vitals` are RLS ENABLE + FORCE partitioned parents (0002).
-- Their monthly partitions are not: RLS is a property of each relation, and CREATE TABLE …
-- PARTITION OF copies neither the parent's RLS flags nor its policies. So every partition
-- — `<parent>_YYYY_MM` and `<parent>_default`, made by 0002 and since then by
-- app.ensure_telemetry_partitions() — has RLS off. None is exposed today: 0011 §5e revoked
-- anon and authenticated on each partition and in the function, so a direct read stops at
-- the GRANT layer. That is one layer, not the two §3 requires, and it breaks the rule that
-- every table is RLS ENABLE + FORCE and revokes public, anon and authenticated (CLAUDE.md
-- §3, Admin v2 P-14); the Supabase linter flags every partition.
--
-- So, on every current partition of either parent (catalog-driven over pg_inherits, the
-- default partitions included) and on each one the function creates from now on: RLS
-- enabled, RLS forced, ALL revoked from public, anon and authenticated. No policy: a
-- partition is not an API surface, so a non-bypass role that names one directly reads and
-- writes nothing. (The linter now lists them as INFO "RLS enabled, no policy", as it lists
-- login_attempts and privileged_ops; deny-all is the intent.)
--
-- Why nothing that works changes: a partition's own policies and privileges apply only
-- when the partition is the table NAMED in a query. Rows reached through the parent get the
-- parent's privilege check and the parent's policies (the planner gives each partition the
-- parent's security quals and none of its own; tuple routing applies the parent's WITH
-- CHECK). The service-role ingest (src/lib/data/telemetry.ts) and the site-health panel's
-- read of web_vitals name the parents; app.rollup_pageviews() reads the parent; the
-- retention job DROPs whole partitions, which RLS does not govern; and the check a new
-- partition makes of the default partition's rows is an internal scan, not a query.
-- Catalog-only: nothing is rewritten or scanned; each ALTER briefly locks its partition.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Every partition that exists now -------------------------------------------------
-- Catalog-driven, like 0011 §5e, so it covers whatever the roll-forward has created in each
-- environment (production holds more partitions than a fresh database). The partition's own
-- schema is used, not the parent's. Idempotent: enabling what is enabled is a no-op.
do $$
declare
  p record;
begin
  for p in
    select cn.nspname as schema_name, c.relname as table_name
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_namespace cn on cn.oid = c.relnamespace
      join pg_class par on par.oid = i.inhparent
      join pg_namespace pn on pn.oid = par.relnamespace
     where pn.nspname = 'public'
       and par.relname in ('analytics_events', 'web_vitals')
     order by 1, 2
  loop
    execute format('alter table %I.%I enable row level security', p.schema_name, p.table_name);
    execute format('alter table %I.%I force row level security', p.schema_name, p.table_name);
    execute format('revoke all on %I.%I from public, anon, authenticated', p.schema_name, p.table_name);
  end loop;
end $$;

-- ---- 2. Every partition the roll-forward makes from now on ------------------------------
-- 0011's body, unchanged, plus the same three statements, so the diff against 0011 is purely
-- additive (the third widens 0011's revoke to PUBLIC). They run in the caller's transaction
-- with the CREATE, so no partition is ever visible without RLS. CREATE OR REPLACE keeps the
-- function's owner and ACL; the revoke after it re-asserts 0011 §1 anyway.
create or replace function app.ensure_telemetry_partitions(p_months_ahead int default 2)
  returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  parent text;
  i int;
  m_start date;
  m_end date;
  part_name text;
  made int := 0;
begin
  foreach parent in array array['analytics_events', 'web_vitals'] loop
    for i in 0..p_months_ahead loop
      m_start := (date_trunc('month', now()) + make_interval(months => i))::date;
      m_end := (m_start + interval '1 month')::date;
      part_name := parent || '_' || to_char(m_start, 'YYYY_MM');
      if not exists (select 1 from pg_class where relname = part_name) then
        execute format(
          'create table public.%I partition of public.%I for values from (%L) to (%L)',
          part_name, parent, m_start, m_end
        );
        -- 0011: born closed. A partition is separately addressable and does not inherit
        -- the parent's policies; access through the parent is unaffected by this.
        execute format('revoke all on public.%I from anon, authenticated', part_name);
        -- 0037: and born under RLS, forced, with no policy: the three statements 0037 ran
        -- on every partition that already existed.
        execute format('alter table public.%I enable row level security', part_name);
        execute format('alter table public.%I force row level security', part_name);
        execute format('revoke all on public.%I from public, anon, authenticated', part_name);
        made := made + 1;
      end if;
    end loop;
  end loop;
  return made;
end $$;

revoke all on function app.ensure_telemetry_partitions(int)
  from public, anon, authenticated, service_role;

-- ---- 3. Postconditions ------------------------------------------------------------------
-- The function's half is checked against its source here, because calling it would create
-- real partitions (and scan the default ones) in production. pgTAP calls it, inside a
-- rolled-back transaction: supabase/tests/telemetry_partitions.test.sql.
do $$
declare
  v_bad text;
  v_src text;
begin
  -- Every partition of both parents: RLS enabled AND forced.
  select string_agg(format('%I.%I', cn.nspname, c.relname), ', ' order by cn.nspname, c.relname)
    into v_bad
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace cn on cn.oid = c.relnamespace
    join pg_class par on par.oid = i.inhparent
    join pg_namespace pn on pn.oid = par.relnamespace
   where pn.nspname = 'public'
     and par.relname in ('analytics_events', 'web_vitals')
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception '0037: telemetry partitions without RLS enabled and forced: %', v_bad;
  end if;

  -- …and no privilege at all, on the table or on any column, for public, anon or
  -- authenticated. ('public' is the PUBLIC pseudo-role to has_*_privilege.)
  select string_agg(format('%s on %I.%I', g.grantee, cn.nspname, c.relname), ', '
                    order by cn.nspname, c.relname, g.grantee)
    into v_bad
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace cn on cn.oid = c.relnamespace
    join pg_class par on par.oid = i.inhparent
    join pg_namespace pn on pn.oid = par.relnamespace
    cross join (values ('public'::name), ('anon'::name), ('authenticated'::name)) as g(grantee)
   where pn.nspname = 'public'
     and par.relname in ('analytics_events', 'web_vitals')
     and (has_table_privilege(g.grantee, c.oid,
                              'select, insert, update, delete, truncate, references, trigger')
          or has_any_column_privilege(g.grantee, c.oid, 'select, insert, update, references'));
  if v_bad is not null then
    raise exception '0037: an API role holds a privilege on a telemetry partition: %', v_bad;
  end if;

  -- The roll-forward does the same to every partition it creates…
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = 'app.ensure_telemetry_partitions(int)'::regprocedure;
  if v_src is null
     or v_src !~* 'alter\s+table\s+public\.%I\s+enable\s+row\s+level\s+security'
     or v_src !~* 'alter\s+table\s+public\.%I\s+force\s+row\s+level\s+security'
     or v_src !~* 'revoke\s+all\s+on\s+public\.%I\s+from\s+public\s*,\s*anon\s*,\s*authenticated' then
    raise exception '0037: app.ensure_telemetry_partitions() does not enable and force RLS and revoke public, anon and authenticated on the partitions it creates';
  end if;

  -- …and is still nobody's to call but its owner's (the cron jobs and app.run_retention()).
  if has_function_privilege('anon', 'app.ensure_telemetry_partitions(int)', 'execute')
     or has_function_privilege('authenticated', 'app.ensure_telemetry_partitions(int)', 'execute')
     or has_function_privilege('service_role', 'app.ensure_telemetry_partitions(int)', 'execute') then
    raise exception '0037: an API role can execute app.ensure_telemetry_partitions()';
  end if;
end $$;
