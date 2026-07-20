-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 — Retention machinery (KAN-22): monthly partition roll-forward + purge jobs.
--
-- Horizons come from the SINGLE source of truth, `public.site_settings.retention`
-- (created in 0001) — there is deliberately NO second hardcoded number in code or SQL
-- (CLAUDE.md Pillar 4: "RAW_TELEMETRY_RETENTION ... never two hardcoded numbers").
-- This migration extends that jsonb with the two horizons CLAUDE.md states but 0001
-- did not persist (web_vitals 90d, system_logs 30d), so every horizon is settings-driven
-- and adjustable without a deploy once legal signs off (may go SHORTER, never longer).
--
-- Multi-tenant-safe: partitions are physically shared, so the telemetry purge uses the
-- MAX horizon across tenants — no tenant can lose data early because another is shorter.
-- Row-scoped purges (leads, system_logs) resolve each tenant's own horizon.
--
-- `audit_log` is NEVER auto-dropped (append-only, hash-chained).
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Extend the single retention source with the remaining horizons ---------
alter table public.site_settings
  alter column retention set default jsonb_build_object(
    'raw_telemetry_days', 90,   -- RAW_TELEMETRY_RETENTION (pageviews/CTA/search/service-interest)
    'web_vitals_days', 90,
    'system_logs_days', 30,
    'leads_months', 24,
    'spam_days', 30
  );

-- Backfill existing rows with any missing keys (never overwrite a chosen value).
update public.site_settings
set retention = jsonb_build_object(
      'raw_telemetry_days', 90, 'web_vitals_days', 90,
      'system_logs_days', 30, 'leads_months', 24, 'spam_days', 30
    ) || retention;

-- ---- Horizon accessors (single source; documented fallback if unset) --------
create or replace function app.retention_max_int(p_key text, p_default int)
  returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(max((retention ->> p_key)::int), p_default) from public.site_settings
$$;

-- ---- Partition roll-forward -------------------------------------------------
-- Creates this month + the next N months for each partitioned telemetry table, so an
-- insert never lands in the catch-all default partition (which can't be dropped).
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
        made := made + 1;
      end if;
    end loop;
  end loop;
  return made;
end $$;

-- ---- Telemetry purge: DROP whole partitions (cheap, no row churn) ----------
create or replace function app.purge_telemetry()
  returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  part record;
  cutoff date;
  part_month date;
  dropped int := 0;
  keep int;
begin
  for part in
    select c.relname as relname, p.relname as parent
    from pg_class c
    join pg_inherits inh on inh.inhrelid = c.oid
    join pg_class p on p.oid = inh.inhparent
    where p.relname in ('analytics_events', 'web_vitals')
      and c.relname ~ '_[0-9]{4}_[0-9]{2}$'      -- never the catch-all *_default
  loop
    keep := case part.parent
              when 'web_vitals' then app.retention_max_int('web_vitals_days', 90)
              else app.retention_max_int('raw_telemetry_days', 90)
            end;
    cutoff := (now() - make_interval(days => keep))::date;
    -- month encoded in the partition name; drop only if the whole month precedes cutoff
    part_month := to_date(right(part.relname, 7), 'YYYY_MM');
    if (part_month + interval '1 month')::date <= cutoff then
      execute format('drop table if exists public.%I', part.relname);
      dropped := dropped + 1;
    end if;
  end loop;
  return dropped;
end $$;

-- ---- Row-scoped purges (per-tenant horizons) --------------------------------
-- Leads: honour an explicit `retention_delete_after` when set, else created_at + horizon.
create or replace function app.purge_leads()
  returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  removed int := 0;
  n int;
  s record;
begin
  for s in select tenant_id, retention from public.site_settings loop
    delete from public.leads l
    where l.tenant_id = s.tenant_id
      and (
        (l.retention_delete_after is not null and l.retention_delete_after < now())
        or (l.retention_delete_after is null
            and l.created_at < now() - make_interval(months => coalesce((s.retention ->> 'leads_months')::int, 24)))
      );
    get diagnostics n = row_count;
    removed := removed + n;
  end loop;
  return removed;
end $$;

create or replace function app.purge_system_logs()
  returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  removed int := 0;
  n int;
  s record;
begin
  for s in select tenant_id, retention from public.site_settings loop
    delete from public.system_logs sl
    where sl.tenant_id = s.tenant_id
      and sl.created_at < now() - make_interval(days => coalesce((s.retention ->> 'system_logs_days')::int, 30));
    get diagnostics n = row_count;
    removed := removed + n;
  end loop;
  return removed;
end $$;

-- ---- Orchestrator (one entry point for the scheduler) -----------------------
create or replace function app.run_retention()
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  made int; dropped int; leads_removed int; logs_removed int;
begin
  made := app.ensure_telemetry_partitions();
  dropped := app.purge_telemetry();
  leads_removed := app.purge_leads();
  logs_removed := app.purge_system_logs();
  insert into public.system_logs (tenant_id, level, source, message, detail)
  select id, 'info', 'retention', 'retention run',
         jsonb_build_object('partitions_created', made, 'partitions_dropped', dropped,
                            'leads_purged', leads_removed, 'system_logs_purged', logs_removed)
  from public.tenants order by created_at asc limit 1;
  return jsonb_build_object('partitions_created', made, 'partitions_dropped', dropped,
                            'leads_purged', leads_removed, 'system_logs_purged', logs_removed);
end $$;

-- Never callable by public roles — scheduler/service only.
revoke execute on function app.run_retention() from public, anon, authenticated;
revoke execute on function app.purge_telemetry() from public, anon, authenticated;
revoke execute on function app.purge_leads() from public, anon, authenticated;
revoke execute on function app.purge_system_logs() from public, anon, authenticated;
revoke execute on function app.ensure_telemetry_partitions(int) from public, anon, authenticated;

-- ---- Schedule (pg_cron). Guarded: the extension only exists once enabled at
-- ---- provisioning (KAN-19, via the :5432 direct connection). Idempotent.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('braiin-retention') where exists (
      select 1 from cron.job where jobname = 'braiin-retention'
    );
    perform cron.schedule('braiin-retention', '17 3 * * *', 'select app.run_retention();');
  end if;
end $$;
