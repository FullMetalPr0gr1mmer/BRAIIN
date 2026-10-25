-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0110 — The integrations contract (Admin v2 U11c): site_integrations' four legacy jsonb
-- columns are dropped. Forward-only: a CONTRACTION, the migration alone (migrations.md rule
-- 6): U11's code PR (#106), which stopped reading and writing them, merged and deployed
-- first, and this file is applied to production before its own PR merges (the deploy guard
-- refuses a checkout holding a migration production lacks). Built with the placeholder 0110;
-- its number is assigned at the merge train. Depends on 0009 (public.site_integrations and
-- its triggers), 0033 (app.live_role, which 0105's live policy reads), 0038 (the release
-- registry this table stays out of) and 0105 (U11: the typed columns, the helper, the five
-- policies, and the grants restated below).
--
-- WHY. 0105 gave every integration a typed, CHECKed column for its public identifier and kept
-- the four free-form jsonb boxes (ga4, search_console, calendly, recaptcha) granted, unread by
-- the new code, for the Worker deployed before U11. That left a residual: until this step an
-- Admin or SEO token could write anything into those boxes through PostgREST and read it back,
-- a secret included. U11's code is live, so nothing reads them any more
-- (tests/lib/integrationsContract.spec.ts proves it for every reader on main: the admin load
-- and route, the public loader, the preview dataset, export-backup, the seeds, every SQL
-- function and view), and this step closes the residual.
--
-- REVOKE OR DROP: DROP. At 0105's push its NOTICE counted 0 production rows holding legacy
-- JSON, so the boxes hold nothing worth keeping, and dropping them is the clean contract: no
-- privilege left to reason about, none a later grant could reopen. The count is taken again
-- here, at this push (1. below): if any row holds JSON by now (written through the API in the
-- window since 0105), the push stops and nothing is dropped, so no value is destroyed unread.
-- The owner then reads those rows in the dashboard and clears them (or, to keep them, turns
-- this file into a revoke: docs/admin-v2/as-built/U11c.md).
--
--   1. The preconditions, under the drop's own lock (so nothing is written between the count
--      and the drop): no row of any tenant holds legacy JSON (anything but '{}'), and the
--      grants 3. restates are still 0105's (a later change to them, U15's anon GA4 read,
--      would otherwise be undone in silence: this file applies before U15's).
--   2. The four columns dropped, RESTRICT: an object that depends on one (a view, a policy, a
--      constraint) fails the push instead of going with it. Their column privileges go with
--      them (PostgreSQL drops a dropped column's ACL).
--   3. The grants restated for both Supabase grant regimes (P-14), exactly 0105's on the
--      columns that remain: staff SELECT on the values, the key, the version and updated_at
--      (never updated_by); INSERT on the key and the values; UPDATE on the values (never
--      DELETE); the service role SELECT, INSERT, UPDATE, DELETE; anon SELECT on tenant_id and
--      search_console_token only; nothing else for anyone.
--   4. Postconditions: what must and must not hold, below.
--
-- Unchanged: the helper app.role_manages_integrations, the five policies (none names a
-- dropped column, and the postconditions read them back), the three CHECKs, the triggers
-- (updated_at, version, updater: generic, none names a column), the help guides (none
-- describes the old boxes). Immediate, never staged (P-3): not in app.release_entities.
--
-- Rollback floor (launch runbook §10): a Worker older than U11's PR selects the dropped
-- columns on the Integrations screen and its route, which then fail (42703) until a newer
-- Worker is deployed. Everything else an older Worker does is untouched.
--
-- Production as of 2026-10-23: PostgreSQL 17.6, one tenant; the ledger holds every migration
-- through 0105, and the merge train pushes the slices that merge before this one first.
-- CLAUDE.md §3 (Pillar 1), §5 (Integrations), §8 (Admin v2 lanes, UI: the U11 bullet), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. Nothing written into the boxes, and no grant changed, since 0105 ═══════════════════
-- The table is locked first, in the mode the drop takes anyway (ACCESS EXCLUSIVE), so no write
-- can land between the count and the drop. The lock_timeout above bounds the wait for it, and
-- it ends with this file's transaction; until then readers of the table queue behind it (the
-- home pages' verification read, which never fails the page, and the Integrations screen).
lock table public.site_integrations in access exclusive mode;

-- A count, never a value. The columns are NOT NULL with '{}' as their default (0009), so any
-- other value (an object with keys, an array, a string, JSON null) is something someone wrote.
do $$
declare
  n int;
begin
  select count(*) into n
    from public.site_integrations
   where ga4 <> '{}'::jsonb or search_console <> '{}'::jsonb
      or calendly <> '{}'::jsonb or recaptcha <> '{}'::jsonb;
  if n > 0 then
    raise exception 'U11c: % site_integrations row(s) hold legacy integration JSON, so nothing is dropped', n
      using hint = 'Read those rows in the dashboard and clear anything secret, set ga4, search_console, '
                   || 'calendly and recaptcha back to ''{}'', then push again (docs/admin-v2/as-built/U11c.md).';
  end if;
end $$;

-- The grants 3. restates are 0105's, so they must still be 0105's here: a migration applied
-- after 0105 but before this file that changed them (U15's GA4 read widens anon's SELECT)
-- would be undone in silence, and the postconditions below would not see it (they check the
-- restatement). Every column privilege of anon and authenticated, compared whole (a table
-- privilege, or PUBLIC's, shows on every column). Under the merge train's order (this file,
-- then U15's) it holds; otherwise the push stops and nothing is dropped.
do $$
declare
  v_got text;
  v_want constant text :=
    'anon select:search_console_token,tenant_id; '
    || 'authenticated insert:calendly,calendly_url,ga4,ga4_measurement_id,recaptcha,search_console,'
    || 'search_console_token,tenant_id; '
    || 'authenticated select:calendly,calendly_url,ga4,ga4_measurement_id,recaptcha,search_console,'
    || 'search_console_token,tenant_id,updated_at,version; '
    || 'authenticated update:calendly,calendly_url,ga4,ga4_measurement_id,recaptcha,search_console,'
    || 'search_console_token';
begin
  select string_agg(x.k, '; ' order by x.k collate "C") into v_got
    from (select r.r || ' ' || p.p || ':'
                 || string_agg(a.attname::text, ',' order by a.attname::text collate "C") as k
            from (values ('anon'), ('authenticated')) as r(r)
           cross join (values ('select'), ('insert'), ('update'), ('references')) as p(p)
            join pg_attribute a
              on a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0
             and not a.attisdropped
           where has_column_privilege(r.r::name, a.attrelid, a.attnum, p.p)
           group by r.r, p.p) as x;
  if v_got is distinct from v_want then
    raise exception 'U11c: the grants on public.site_integrations are no longer 0105''s (%), so restating 0105''s would undo a later change; nothing is dropped', v_got
      using hint = 'Apply this file before the migration that changed them (renumber it), or restate '
                   || 'that change in 3. as well (docs/admin-v2/as-built/U11c.md).';
  end if;
end $$;

-- ═══ 2. The legacy boxes go ═════════════════════════════════════════════════════════════════
alter table public.site_integrations
  drop column ga4,
  drop column search_console,
  drop column calendly,
  drop column recaptcha;

-- ═══ 3. Grants (stated, never inherited: both grant regimes) ═══════════════════════════════
-- Revoking a table privilege also revokes it on every column, so each role starts from nothing.
-- One transaction: no reader meets the table between the revoke and the grants.
revoke all on public.site_integrations from public, anon, authenticated, service_role;
grant select (tenant_id, ga4_measurement_id, search_console_token, calendly_url, version, updated_at)
  on public.site_integrations to authenticated;
grant insert (tenant_id, ga4_measurement_id, search_console_token, calendly_url)
  on public.site_integrations to authenticated;
grant update (ga4_measurement_id, search_console_token, calendly_url)
  on public.site_integrations to authenticated;
grant select, insert, update, delete on public.site_integrations to service_role;
grant select (tenant_id, search_console_token) on public.site_integrations to anon;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, an AND list in one pair; a function's schema printed only when it
-- is not on the search path, so the patterns allow both).
do $$
declare
  v_bad text;
  v_want text[];
  v_got text[];
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  r text;
  pr text;
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  -- ---- 1. The four boxes are gone, and the table holds exactly what remains ---------------
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_got is distinct from array['calendly_url', 'ga4_measurement_id', 'search_console_token',
                                  'tenant_id', 'updated_at', 'updated_by', 'version'] then
    raise exception 'U11c: public.site_integrations has the columns %', v_got;
  end if;

  -- ---- 2. RLS enabled and forced ----------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.site_integrations'::regclass) then
    raise exception 'U11c: public.site_integrations is not ENABLE + FORCE row level security';
  end if;

  -- ---- 3. The exact policy set (0105's), each leading with the tenant predicate ------------
  v_want := array[
    'site_integrations_insert INSERT PERMISSIVE {authenticated}',
    'site_integrations_live ALL RESTRICTIVE {authenticated}',
    'site_integrations_public_read SELECT PERMISSIVE {anon}',
    'site_integrations_read SELECT PERMISSIVE {authenticated}',
    'site_integrations_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                   order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'site_integrations';
  if v_got is distinct from v_want then
    raise exception 'U11c: site_integrations policies are %, expected %', v_got, v_want;
  end if;
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'site_integrations'
     and ((qual is not null and qual !~ v_tenant_first)
          or (with_check is not null and with_check !~ v_tenant_first)
          or coalesce(qual, with_check) is null);
  if v_bad is not null then
    raise exception 'U11c: site_integrations policies that do not lead with the tenant predicate: %', v_bad;
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'site_integrations'
         and policyname = 'site_integrations_live'
         and qual ~ 'role_manages_integrations\(\( SELECT (app\.)?live_role\(\)'
         and with_check ~ 'role_manages_integrations\(\( SELECT (app\.)?live_role\(\)') <> 1 then
    raise exception 'U11c: site_integrations_live no longer checks the live role in USING and WITH CHECK';
  end if;

  -- ---- 4. Table privileges, exactly ---------------------------------------------------------
  -- PUBLIC, anon and authenticated hold no table-level privilege (anon and staff go by column);
  -- the service role exactly SELECT, INSERT, UPDATE, DELETE. Nobody TRUNCATE, REFERENCES,
  -- TRIGGER, nor MAINTAIN on 17+ (CASE, not AND: the word is refused before 17; CI runs 15).
  foreach r in array array['public', 'anon', 'authenticated'] loop
    if has_table_privilege(r::name, 'public.site_integrations',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when v_maintain
                then has_table_privilege(r::name, 'public.site_integrations', 'maintain')
                else false end) then
      raise exception 'U11c: % holds a table privilege on public.site_integrations', r;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.site_integrations', pr) then
      raise exception 'U11c: service_role lacks % on public.site_integrations', pr;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.site_integrations', 'truncate, references, trigger')
     or (case when v_maintain
              then has_table_privilege('service_role', 'public.site_integrations', 'maintain')
              else false end) then
    raise exception 'U11c: service_role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.site_integrations';
  end if;

  -- ---- 5. Column privileges, exactly --------------------------------------------------------
  -- Each column list is compared whole (what must hold and what must not, at once).
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['search_console_token', 'tenant_id'] then
    raise exception 'U11c: anon''s SELECT columns on site_integrations are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.site_integrations', 'insert, update, references')
     or has_any_column_privilege('public', 'public.site_integrations',
                                 'select, insert, update, references') then
    raise exception 'U11c: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['calendly_url', 'ga4_measurement_id', 'search_console_token',
                                  'tenant_id', 'updated_at', 'version'] then
    raise exception 'U11c: authenticated''s SELECT columns on site_integrations are %', v_got;
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert');
  if v_got is distinct from array['calendly_url', 'ga4_measurement_id', 'search_console_token',
                                  'tenant_id'] then
    raise exception 'U11c: authenticated''s INSERT columns on site_integrations are %', v_got;
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from array['calendly_url', 'ga4_measurement_id', 'search_console_token'] then
    raise exception 'U11c: authenticated''s UPDATE columns on site_integrations are %', v_got;
  end if;
  if has_any_column_privilege('authenticated', 'public.site_integrations', 'references') then
    raise exception 'U11c: authenticated holds REFERENCES on a site_integrations column';
  end if;

  -- ---- 6. The three CHECKs are still there and validated ------------------------------------
  select array_agg(c.conname::text order by c.conname::text collate "C") into v_got
    from pg_constraint c
   where c.conrelid = 'public.site_integrations'::regclass and c.contype = 'c' and c.convalidated;
  if v_got is distinct from array['site_integrations_calendly_shape', 'site_integrations_ga4_shape',
                                  'site_integrations_gsc_shape'] then
    raise exception 'U11c: the site_integrations CHECKs are %', v_got;
  end if;

  -- ---- 7. No SQL function or view reads the table ------------------------------------------
  -- The readers are the Worker's (tests/lib/integrationsContract.spec.ts); no function in
  -- public or app names the table (a body is checked only when it runs, so a function that
  -- read a dropped column would fail at its first call, not here), and no view depends on it.
  select string_agg(format('%s.%s', n.nspname, p.proname), ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosrc ~ 'site_integrations';
  if v_bad is not null then
    raise exception 'U11c: functions that name site_integrations: %', v_bad;
  end if;
  select string_agg(distinct v.oid::regclass::text, ', ') into v_bad
    from pg_depend d
    join pg_rewrite w on w.oid = d.objid
    join pg_class v on v.oid = w.ev_class
   where d.classid = 'pg_rewrite'::regclass
     and d.refobjid = 'public.site_integrations'::regclass
     and v.oid <> 'public.site_integrations'::regclass;
  if v_bad is not null then
    raise exception 'U11c: views that read site_integrations: %', v_bad;
  end if;

  -- ---- 8. Immediate, never staged (P-3) ------------------------------------------------------
  if exists (select 1 from app.release_entities e where e.table_name = 'site_integrations') then
    raise exception 'U11c: site_integrations must not be in the release registry (immediate, P-3)';
  end if;
end $$;
