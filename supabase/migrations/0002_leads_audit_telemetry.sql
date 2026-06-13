-- ─────────────────────────────────────────────────────────────────────────────
-- 0002 — Leads (PII) + tamper-evident audit chain + logs + partitioned telemetry
-- Depends on 0001 (app schema, helpers, enums, tenants). CLAUDE.md Pillars 1 & 4.
-- ─────────────────────────────────────────────────────────────────────────────

-- Allow the audit trigger body to reference vault.decrypted_secrets at create time.
set check_function_bodies = off;

-- ---- Leads (PII gated to Admin + Developer) --------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  kind text not null default 'contact',
  locale text not null default 'en',
  name text not null,
  -- Envelope-encrypted PII (ciphertext only; decrypt is a role-checked app path).
  email_enc bytea not null,
  phone_enc bytea,
  budget_enc bytea,
  -- Sensitive (Admin/Developer only): omitted from leads_safe.
  timeline_band text,
  internal_notes text,
  ip_inet inet,
  message text not null,
  service_of_interest citext,
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'spam')),
  consent_marketing boolean not null default false,
  retention_delete_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_tenant_status_idx on public.leads (tenant_id, status, created_at desc);
alter table public.leads enable row level security;
alter table public.leads force row level security;
create trigger leads_updated_at before update on public.leads
  for each row execute function app.tg_set_updated_at();
-- Public submissions arrive via the submit-contact-form Edge Function (service_role,
-- which bypasses RLS and resolves tenant server-side — the anon tenant fence). Staff
-- access is Admin + Developer ONLY; Content Creator and SEO get NO lead access.
create policy leads_admin_dev_all on public.leads for all
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));

-- Defense-in-depth: a security_invoker view (RLS of leads applies) that OMITS
-- internal_notes, ip_inet, and all encrypted PII. Not granted to anon.
create view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  status, consent_marketing, created_at, updated_at
from public.leads;
revoke all on public.leads_safe from anon;
grant select on public.leads_safe to authenticated;

-- ---- Audit log: append-only + HMAC hash-chain (DB-computed) -----------------
create table public.audit_log (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  actor_id uuid,
  actor_role text,
  action text not null,
  entity_type text,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text not null default '',      -- overwritten by the BEFORE INSERT trigger
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log (tenant_id, id desc);

-- The DB computes the hash on EVERY insert path (incl. service_role); callers can
-- neither supply, skip, nor forge it. Key lives in Supabase Vault, readable only by
-- this definer. Chain head is anchored hourly to object-locked R2 by a Worker.
create or replace function app.tg_audit_chain() returns trigger
  language plpgsql security definer set search_path = public, app, vault, pg_temp as $$
declare
  v_prev text;
  v_key text;
  v_payload text;
begin
  select hash into v_prev from public.audit_log
    where tenant_id = new.tenant_id order by id desc limit 1;
  new.prev_hash := v_prev;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'audit_hmac_key';
  if v_key is null then
    raise exception 'audit_hmac_key missing from Vault (run vault.create_secret(...))';
  end if;

  v_payload := coalesce(v_prev, '') || '|' || new.tenant_id::text || '|' || coalesce(new.actor_id::text, '')
    || '|' || coalesce(new.actor_role, '') || '|' || new.action || '|' || coalesce(new.entity_type, '')
    || '|' || coalesce(new.entity_id, '') || '|' || new.detail::text || '|' || new.created_at::text;

  new.hash := encode(hmac(v_payload, v_key, 'sha256'), 'hex');
  return new;
end $$;

create trigger audit_log_chain before insert on public.audit_log
  for each row execute function app.tg_audit_chain();

alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;
-- View = Admin + Developer. Insert allowed for staff (chained). NO update/delete
-- policy ⇒ denied; also hard-revoke so even PostgREST service-role cannot tamper.
create policy audit_read on public.audit_log for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));
create policy audit_insert on public.audit_log for insert
  with check (tenant_id = app.effective_tenant_id() and app.is_staff());
revoke update, delete on public.audit_log from authenticated, anon, service_role;

-- ---- System logs (clearable; separate from the audit log) -------------------
create table public.system_logs (
  id bigserial primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  source text,
  message text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index system_logs_tenant_idx on public.system_logs (tenant_id, created_at desc);
alter table public.system_logs enable row level security;
alter table public.system_logs force row level security;
create policy system_logs_read on public.system_logs for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));
create policy system_logs_insert on public.system_logs for insert
  with check (tenant_id = app.effective_tenant_id() and app.is_staff());
create policy system_logs_clear on public.system_logs for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- Login attempts (lockout). Managed by the handle-login Edge Function ----
create table public.login_attempts (
  id bigserial primary key,
  tenant_id uuid,
  email citext not null,
  ip inet,
  success boolean not null default false,
  created_at timestamptz not null default now()
);
create index login_attempts_email_idx on public.login_attempts (email, created_at desc);
alter table public.login_attempts enable row level security;
alter table public.login_attempts force row level security;
-- No policies: only the service_role (Edge Function) touches this table.

-- ---- Telemetry: monthly range partitions; retention by dropping partitions --
-- ONE canonical analytics source (first-party). Every write is consent-gated at the
-- ingest boundary by the Edge Function. Dashboards read rollup_* only.
create table public.analytics_events (
  id bigint generated always as identity,
  tenant_id uuid not null default app.effective_tenant_id(),
  occurred_at timestamptz not null default now(),
  event_type text not null,
  path text,
  locale text,
  session_id text,
  props jsonb not null default '{}'::jsonb,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table public.analytics_events_2026_06 partition of public.analytics_events
  for values from ('2026-06-01') to ('2026-07-01');
create table public.analytics_events_2026_07 partition of public.analytics_events
  for values from ('2026-07-01') to ('2026-08-01');
create table public.analytics_events_default partition of public.analytics_events default;

alter table public.analytics_events enable row level security;
alter table public.analytics_events force row level security;
-- Raw reads limited to Admin/Developer/SEO; inserts via service_role (bypass).
create policy analytics_events_read on public.analytics_events for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer', 'seo'));

create table public.web_vitals (
  id bigint generated always as identity,
  tenant_id uuid not null default app.effective_tenant_id(),
  occurred_at timestamptz not null default now(),
  metric text not null,
  value double precision not null,
  rating text,
  path text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table public.web_vitals_2026_06 partition of public.web_vitals
  for values from ('2026-06-01') to ('2026-07-01');
create table public.web_vitals_default partition of public.web_vitals default;

alter table public.web_vitals enable row level security;
alter table public.web_vitals force row level security;
create policy web_vitals_read on public.web_vitals for select
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));

-- Pre-aggregated dashboard source (dashboards read here, never raw).
create table public.rollup_daily_pageviews (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,
  path text not null,
  locale text not null default 'en',
  views bigint not null default 0,
  primary key (tenant_id, day, path, locale)
);
alter table public.rollup_daily_pageviews enable row level security;
alter table public.rollup_daily_pageviews force row level security;
create policy rollup_read on public.rollup_daily_pageviews for select
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

-- Retention (RAW_TELEMETRY_RETENTION = 90 days; CLAUDE.md Pillar 4). Implemented by
-- DROPPING whole partitions, not row deletes. Operator schedules via pg_cron on the
-- direct :5432 connection, e.g.:
--   select cron.schedule('telemetry-roll-forward', '0 2 28 * *',
--     $$ /* create next month partitions for analytics_events + web_vitals */ $$);
--   select cron.schedule('telemetry-retention', '0 3 * * *',
--     $$ /* drop analytics_events_/web_vitals_ partitions older than 90 days */ $$);
-- The partition-management function lands with the analytics ingest (Phase 3); raw
-- retention 90d, web_vitals 90d, system_logs 30d, audit_log never auto-dropped.
