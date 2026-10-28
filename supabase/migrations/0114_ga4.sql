-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0114 — GA4's measurement id reaches the public pages (Admin v2 U15). Forward-only: EXPAND
-- (one anon column grant). Built with a placeholder number; renumbered at its merge train.
-- Depends on 0001 (tenants, app.effective_tenant_id), 0009 (public.site_integrations), 0011
-- (the grant regime) and 0105 (U11: the typed ga4_measurement_id column, its CHECK, the
-- policies, anon's read of the launch tenant's row through its column grant).
--
-- WHY. U15 loads Google Analytics 4 on the public site, behind analytics consent and behind a
-- code-owned switch (GA4_NOTICE_READY, astro:env, off until the owner signs off the privacy
-- notice that names Google). The Worker reads the id on a public page as a visitor does:
-- anon, through the content seam (src/lib/data/ga4.ts), one read and only on the routes that
-- load GA4, never while the switch is off. So anon may read that one more column, as it reads
-- U11's Search Console code: a measurement id is public by nature (every page that loads
-- GA4 carries it, in the loader's data attribute and in the gtag.js URL), and the column's
-- CHECK (site_integrations_ga4_shape, 0105) holds it to `G-` and 4 to 15 capitals or digits,
-- so nothing but a measurement id can reach a visitor. The decisions and every departure are
-- in docs/admin-v2/as-built/U15.md.
--
--   1. anon's grants on site_integrations, stated whole (revoked, then exactly granted): SELECT
--      on tenant_id, search_console_token and, new, ga4_measurement_id; nothing else. PUBLIC
--      holds nothing. The row stays fenced to the launch tenant by 0105's
--      site_integrations_public_read (the tenant predicate alone, TO anon), which this file
--      does not touch, and anon still reads no other column (42501).
--   2. Staff and the service role keep exactly what 0105 (and, once it lands, the contract
--      step that drops the legacy jsonb) gave them: this file names neither, so it holds
--      under either state of the legacy columns. The postconditions check only what must stay
--      true whatever that step did: no table privilege for staff, staff still read the id (the
--      Integrations screen), the service role S/I/U/D and nothing more.
--
-- Immediate, never staged (P-3): site_integrations is not in app.release_entities. Releases
-- stay off. No reader's result shape grows: the deployed Worker selects its columns by name
-- (src/lib/admin/integrations/load.ts, src/lib/data/siteVerification.ts), and the preview's
-- anon mirror (src/lib/preview/visibility.ts ANON_COLUMNS) learns the column in this PR.
--
-- Production as of 2026-10-23: PostgreSQL 17.6, one tenant; the ledger holds every migration
-- through 0105. CLAUDE.md §3 (Pillar 1), §7 (Consent), §8 (Admin v2 lanes, UI), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. anon's grants, stated whole ═══════════════════════════════════════════════════════
-- Revoking a table privilege also revokes it on every column, so anon and PUBLIC start from
-- nothing; authenticated and service_role are left exactly as they are.
revoke all on public.site_integrations from public, anon;
grant select (tenant_id, search_console_token, ga4_measurement_id)
  on public.site_integrations to anon;

comment on column public.site_integrations.ga4_measurement_id is
  'GA4 measurement id (G-…): public by nature, so anon reads it (Admin v2 U15). The site loads GA4 only behind analytics consent and the GA4_NOTICE_READY switch.';

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_want text[];
  v_got text[];
  r text;
  pr text;
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  -- ---- 1. RLS still enabled and forced ------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.site_integrations'::regclass) then
    raise exception 'U15: public.site_integrations is not ENABLE + FORCE row level security';
  end if;

  -- ---- 2. The policy set is 0105's, untouched, and anon's read is the tenant alone ---------
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
    raise exception 'U15: site_integrations policies are %, expected %', v_got, v_want;
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'site_integrations'
         and policyname = 'site_integrations_public_read'
         and qual ~ '^\(tenant_id = (app\.)?effective_tenant_id\(\)\)$'
         and with_check is null) <> 1 then
    raise exception 'U15: site_integrations_public_read is not the tenant predicate alone';
  end if;

  -- ---- 3. anon and PUBLIC: exactly three columns to read, nothing else ----------------------
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['ga4_measurement_id', 'search_console_token', 'tenant_id'] then
    raise exception 'U15: anon''s SELECT columns on site_integrations are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.site_integrations', 'insert, update, references')
     or has_any_column_privilege('public', 'public.site_integrations',
                                 'select, insert, update, references') then
    raise exception 'U15: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  -- No table-level privilege for PUBLIC, anon or authenticated (they go by column), MAINTAIN
  -- under a CASE: the word is refused before 17 (CI runs 15).
  foreach r in array array['public', 'anon', 'authenticated'] loop
    if has_table_privilege(r::name, 'public.site_integrations',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when v_maintain
                then has_table_privilege(r::name, 'public.site_integrations', 'maintain')
                else false end) then
      raise exception 'U15: % holds a table privilege on public.site_integrations', r;
    end if;
  end loop;

  -- ---- 4. Staff still read the id (the Integrations screen) and never delete ----------------
  if not has_column_privilege('authenticated', 'public.site_integrations', 'ga4_measurement_id', 'select')
     or not has_column_privilege('authenticated', 'public.site_integrations', 'ga4_measurement_id', 'update')
     or has_any_column_privilege('authenticated', 'public.site_integrations', 'references') then
    raise exception 'U15: authenticated''s grants on site_integrations moved (this file must not touch them)';
  end if;

  -- ---- 5. The service role: SELECT, INSERT, UPDATE, DELETE, nothing more -------------------
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.site_integrations', pr) then
      raise exception 'U15: service_role lacks % on public.site_integrations', pr;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.site_integrations', 'truncate, references, trigger')
     or (case when v_maintain
              then has_table_privilege('service_role', 'public.site_integrations', 'maintain')
              else false end) then
    raise exception 'U15: service_role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.site_integrations';
  end if;

  -- ---- 6. What anon can read is a measurement id or nothing (0105's CHECK, still there) ----
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.site_integrations'::regclass and c.contype = 'c'
                    and c.convalidated and c.conname = 'site_integrations_ga4_shape'
                    and pg_get_constraintdef(c.oid) ~ 'G-\[A-Z0-9\]\{4,15\}\$') then
    raise exception 'U15: site_integrations_ga4_shape is missing or no longer the measurement id''s shape';
  end if;

  -- ---- 7. Immediate, never staged (P-3), and releases still off --------------------------
  if exists (select 1 from app.release_entities e where e.table_name = 'site_integrations') then
    raise exception 'U15: site_integrations must not be in the release registry (immediate, P-3)';
  end if;
  if exists (select 1 from app.release_tenants) then
    raise exception 'U15: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
