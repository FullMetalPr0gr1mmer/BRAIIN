-- ─────────────────────────────────────────────────────────────────────────────
-- 0037 — The tables staff only read (hotfix H8): RLS on every telemetry partition, and a
--        GRANT layer that says SELECT on the eight tables 0011 §5d treats as read-only.
-- Forward-only. Depends on 0001, 0002, 0008, 0009, 0010, 0011.
--
-- A. Telemetry partitions. `analytics_events` and `web_vitals` are RLS ENABLE + FORCE
--    partitioned parents (0002), but RLS is a property of each relation, and CREATE TABLE …
--    PARTITION OF copies neither the parent's flags nor its policies: every partition
--    (0002's, and each one app.ensure_telemetry_partitions() has made since) had RLS off,
--    with 0011 §5e's revoke of anon and authenticated as its only layer. Every current
--    partition (pg_inherits, the `_default` ones included), and each one the function
--    creates from now on, is now RLS enabled and forced, with ALL revoked from public, anon
--    and authenticated and no policy: a partition is not an API surface. (The linter lists
--    them as INFO "RLS enabled, no policy", like login_attempts and privileged_ops.)
--
-- B. The read-only tables: analytics_events, web_vitals, rollup_daily_pageviews,
--    search_queries, consent_log, notification_log, tenants and profiles. 0011 §5d granted
--    `authenticated` SELECT on them and never revoked Supabase's bootstrap grant of ALL.
--    Production holds it (checked 2026-10-07: analytics_events, web_vitals,
--    rollup_daily_pageviews, search_queries and profiles; consent_log, notification_log and
--    tenants were created the same way and no migration revoked it). So RLS was the only
--    layer in front of a staff write, and TRUNCATE is not subject to RLS.
--    profiles_admin_write and tenants_admin_write are FOR ALL, so an admin token could
--    rewrite any profile column (tenant_id, locked_until) past the audited users endpoint,
--    or delete its own tenant row, which cascades to every table. Now anon and PUBLIC hold
--    nothing. authenticated holds SELECT, plus UPDATE on profiles.role, is_active and
--    display_name: the users screen (PATCH /api/admin/users/[id]) writes those three
--    through the staff session client, the only staff write the code makes to any of the
--    eight. The service role's grants, and its USAGE on the three bigserial sequences, are
--    stated rather than inherited (Admin v2 P-14; Supabase stops auto-granting on
--    2026-10-30). Revokes are idempotent, so this is right whether or not the defaults were
--    ever applied, and the postconditions check what must and what must not be held.
--
-- Why nothing that works changes. A partition's own policies and privileges apply only when
-- the partition is the table NAMED in a query; rows reached through the parent get the
-- parent's (the planner gives each partition the parent's security quals and none of its
-- own, and tuple routing applies the parent's WITH CHECK). Every write to the eight tables
-- is the service role's or a SECURITY DEFINER function's (src/lib/data/telemetry.ts,
-- app.rollup_pageviews(), record_consent(), notify-lead, the user invite, the login RPCs),
-- except that PATCH. The staff reads (site health, analytics, search analytics, the users
-- list) are SELECTs. The retention job DROPs whole partitions, which RLS does not govern,
-- and the check a new partition makes of the default partition's rows is an internal scan,
-- not a query. Catalog-only: nothing is rewritten or scanned; each ALTER briefly locks its
-- partition.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══ A. Telemetry partitions ═════════════════════════════════════════════════════════════

-- ---- A1. Every partition that exists now ------------------------------------------------
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

-- ---- A2. Every partition the roll-forward makes from now on -----------------------------
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

-- ═══ B. The read-only tables: SELECT for staff, writes for the service role ══════════════

-- ---- B1. anon and PUBLIC: nothing -------------------------------------------------------
-- anon held nothing on these already (0011 §5a); stated so the postcondition can demand it.
revoke all on
  public.analytics_events,
  public.web_vitals,
  public.rollup_daily_pageviews,
  public.search_queries,
  public.consent_log,
  public.notification_log,
  public.tenants,
  public.profiles
from public, anon;

-- ---- B2. authenticated: SELECT, stated; the defaults' writes withdrawn -------------------
-- A table-level REVOKE also clears that privilege on every column (SQL spec), so any column
-- grant has to come after it, which is why B3 follows.
revoke insert, update, delete, truncate, references, trigger on
  public.analytics_events,
  public.web_vitals,
  public.rollup_daily_pageviews,
  public.search_queries,
  public.consent_log,
  public.notification_log,
  public.tenants,
  public.profiles
from authenticated;

grant select on
  public.analytics_events,
  public.web_vitals,
  public.rollup_daily_pageviews,
  public.search_queries,
  public.consent_log,
  public.notification_log,
  public.tenants,
  public.profiles
to authenticated;

-- ---- B3. The users screen: three profile columns -----------------------------------------
-- PATCH /api/admin/users/[id] reads the target and writes role, is_active and display_name
-- through the RLS-bound session client; profiles_admin_write limits that to an Admin of the
-- same tenant, and the endpoint adds assertCap, liveRecheck and the audit row. Named the way
-- 0030 named leads.status and internal_notes. No other column: tenant_id, the lockout
-- columns (written by the SECURITY DEFINER login RPCs) and avatar_url (no screen writes it)
-- stay out of reach of a staff token.
grant update (role, is_active, display_name) on public.profiles to authenticated;

-- ---- B4. The service role: the writer of record, stated ---------------------------------
-- The ingest (analytics_events, web_vitals, search_queries), the notify-lead ledger, the
-- user invite, and the auth-context and liveRecheck reads of profiles all run as service_role.
grant select, insert, update, delete on
  public.analytics_events,
  public.web_vitals,
  public.rollup_daily_pageviews,
  public.search_queries,
  public.consent_log,
  public.notification_log,
  public.tenants,
  public.profiles
to service_role;

-- ---- B5. The three bigserial sequences ----------------------------------------------------
-- The service role draws ids from them (the search log, notifications). No API role else
-- inserts into these tables any more, and UPDATE on a sequence is setval.
do $$
declare
  t text;
  s text;
begin
  foreach t in array array['search_queries', 'consent_log', 'notification_log'] loop
    s := pg_get_serial_sequence(format('public.%I', t), 'id');
    if s is null then
      raise exception '0037: public.%.id owns no sequence', t;
    end if;
    execute format('revoke all on sequence %s from public, anon, authenticated', s);
    execute format('grant usage on sequence %s to service_role', s);
  end loop;
end $$;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════

-- ---- A. The partitions ----------------------------------------------------------------------
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

-- ---- B. The read-only tables ------------------------------------------------------------------
-- Both grant regimes are checked: table privileges (has_table_privilege) and column
-- privileges (has_column_privilege, which a table-level check cannot see), each for what
-- must be held AND for what must not. The per-role behaviour is pgTAP's:
-- supabase/tests/grants_read_only_tables.test.sql.
do $$
declare
  v_tables constant regclass[] := array[
    'public.analytics_events', 'public.web_vitals', 'public.rollup_daily_pageviews',
    'public.search_queries', 'public.consent_log', 'public.notification_log',
    'public.tenants', 'public.profiles'
  ]::regclass[];
  v_bad text;
begin
  -- Table level: authenticated holds SELECT and nothing else.
  select string_agg(format('%s %s', p.priv, c.relname), ', ' order by c.relname, p.priv)
    into v_bad
    from pg_class c
    cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                       ('references'), ('trigger')) as p(priv)
   where c.oid = any (v_tables)
     and has_table_privilege('authenticated', c.oid, p.priv) is distinct from (p.priv = 'select');
  if v_bad is not null then
    raise exception '0037: authenticated must hold SELECT and only SELECT on the read-only tables; wrong: %', v_bad;
  end if;

  -- Column level: no INSERT or REFERENCES on any column, and UPDATE on exactly
  -- profiles.role, is_active and display_name.
  select string_agg(format('%s %s.%s', p.priv, c.relname, a.attname), ', '
                    order by c.relname, a.attname, p.priv)
    into v_bad
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join (values ('insert'), ('update'), ('references')) as p(priv)
   where c.oid = any (v_tables)
     and has_column_privilege('authenticated', c.oid, a.attnum, p.priv)
         is distinct from (c.oid = 'public.profiles'::regclass
                           and p.priv = 'update'
                           and a.attname in ('role', 'is_active', 'display_name'));
  if v_bad is not null then
    raise exception '0037: authenticated must hold column UPDATE on profiles.role, is_active and display_name and no other column privilege; wrong: %', v_bad;
  end if;

  -- anon and PUBLIC: nothing, on the table or on any column.
  select string_agg(format('%s on %s', g.grantee, c.relname), ', ' order by c.relname, g.grantee)
    into v_bad
    from pg_class c
    cross join (values ('public'::name), ('anon'::name)) as g(grantee)
   where c.oid = any (v_tables)
     and (has_table_privilege(g.grantee, c.oid,
                              'select, insert, update, delete, truncate, references, trigger')
          or has_any_column_privilege(g.grantee, c.oid, 'select, insert, update, references'));
  if v_bad is not null then
    raise exception '0037: anon or PUBLIC holds a privilege on a read-only table: %', v_bad;
  end if;

  -- The service role: SELECT, INSERT, UPDATE and DELETE on each.
  select string_agg(format('%s %s', p.priv, c.relname), ', ' order by c.relname, p.priv)
    into v_bad
    from pg_class c
    cross join (values ('select'), ('insert'), ('update'), ('delete')) as p(priv)
   where c.oid = any (v_tables)
     and not has_table_privilege('service_role', c.oid, p.priv);
  if v_bad is not null then
    raise exception '0037: service_role lacks: %', v_bad;
  end if;

  -- The sequences: USAGE for the service role, nothing for anon or authenticated.
  select string_agg(s.seq::text, ', ' order by s.seq::text)
    into v_bad
    from (select pg_get_serial_sequence(format('public.%I', t), 'id')::regclass as seq
            from unnest(array['search_queries', 'consent_log', 'notification_log']) as t) as s
   where not has_sequence_privilege('service_role', s.seq, 'usage')
      or has_sequence_privilege('authenticated', s.seq, 'usage, select, update')
      or has_sequence_privilege('anon', s.seq, 'usage, select, update');
  if v_bad is not null then
    raise exception '0037: wrong privileges on sequence(s): %', v_bad;
  end if;
end $$;
