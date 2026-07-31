-- ─────────────────────────────────────────────────────────────────────────────
-- 0010 — Launch readiness.
--
-- Everything in this migration is a HARD BLOCKER: without it the CMS is complete
-- code that cannot be used. Specifically —
--
--   1. The Custom Access Token Hook. `resolveAuthContext` rejects any session whose
--      JWT carries no `app_metadata.role`/`tenant_id`, and RLS resolves such a user
--      into the anon fence. Until this function is installed AND enabled in the
--      Supabase dashboard, EVERY login is correctly refused. Nothing else can be
--      tested until it exists.
--   2. The Vault audit key. `app.tg_audit_chain()` raises if `audit_hmac_key` is
--      missing, and it is a BEFORE INSERT trigger on a table every admin mutation
--      writes to — so a missing key does not degrade auditing, it 500s the whole CMS.
--   3. A first admin. `users.manage` is Admin-only, so there is no in-product path to
--      the first admin: someone has to be promoted from outside.
--   4. The analytics rollup. Dashboards read `rollup_*` only (Pillar 4); with nothing
--      populating it, the analytics screen is permanently empty and looks broken.
--
-- Forward-only. CLAUDE.md §3, §8, §10.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Custom Access Token Hook -------------------------------------------
-- Stamps role + tenant_id into `app_metadata` on every token mint/refresh. This is
-- THE source RLS reads (`app.current_tenant_id()`, `app.current_role()`), and the
-- reason those helpers look at app_metadata and never user_metadata: user_metadata is
-- writable by the user, so a role read from it would be a self-service promotion.
--
-- `stable`, not `volatile`: GoTrue calls this on every refresh, and it must not write.
create or replace function public.custom_access_token_hook(event jsonb)
  returns jsonb
  language plpgsql
  stable
  set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_tenant uuid;
  v_active boolean;
  claims jsonb;
  app_meta jsonb;
begin
  select p.role::text, p.tenant_id, p.is_active
    into v_role, v_tenant, v_active
    from public.profiles p
   where p.id = (event ->> 'user_id')::uuid;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  app_meta := coalesce(claims -> 'app_metadata', '{}'::jsonb);

  -- A user with no profile, or a deactivated one, gets NO role claim. They can still
  -- authenticate with GoTrue — that is a different question — but the token they
  -- receive grants nothing: RLS sees an anon-equivalent principal and assertCap()
  -- refuses. Deactivation therefore takes effect at the next token refresh even for a
  -- client that never calls our API.
  if v_role is not null and v_active is true then
    app_meta := app_meta || jsonb_build_object('role', v_role, 'tenant_id', v_tenant);
  else
    app_meta := app_meta - 'role' - 'tenant_id';
  end if;

  claims := jsonb_set(claims, '{app_metadata}', app_meta);
  return jsonb_set(event, '{claims}', claims);
end $$;

-- Only GoTrue may execute it. An `authenticated` caller able to run this could not
-- change their own claims (it is stable and reads the profile row), but there is no
-- reason to hand out the shape of the claim pipeline either.
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- `profiles` is FORCE RLS, so the hook's own read needs a policy — the function is
-- not security definer on purpose. Making it definer would let it read every profile
-- with the definer's rights; this policy grants exactly one role exactly SELECT.
grant select on public.profiles to supabase_auth_admin;
create policy profiles_auth_admin_read on public.profiles
  for select to supabase_auth_admin
  using (true);

-- ---- 2. Audit HMAC key in Vault --------------------------------------------
-- Generated here rather than shipped in source: it is per-environment and must never
-- be reconstructible from the repository. `gen_random_bytes` is pgcrypto's CSPRNG.
--
-- Guarded on vault.secrets being reachable so a bare-Postgres CI container running the
-- migration set does not fail; on such a host the audit trigger is unreachable anyway.
--
-- `gen_random_bytes` is schema-qualified: on Supabase, pgcrypto is pre-installed into the
-- `extensions` schema, so the `create extension if not exists pgcrypto` in 0001 was a no-op
-- and never put it in `public`. Whether `extensions` is on the migration role's search_path
-- is not ours to assume — qualify it rather than trust the path.
--
-- Failure is deliberately fatal, not a warning: app.tg_audit_chain() raises when this key
-- is absent, and it is a BEFORE INSERT trigger on a table every admin mutation writes to.
-- A "successful" migration with no key yields a CMS that 500s on every write and an audit
-- chain — a Pillar 1 control — that silently does not exist. The handler exists only to
-- attach the environment context that `supabase db push` otherwise swallows.
do $$
declare
  v_key text;
begin
  if to_regclass('vault.secrets') is null then
    raise warning 'vault.secrets absent — skipping audit_hmac_key bootstrap (expected ONLY on bare-Postgres CI)';
    return;
  end if;

  if exists (select 1 from vault.secrets where name = 'audit_hmac_key') then
    return;
  end if;

  v_key := encode(extensions.gen_random_bytes(32), 'hex');

  perform vault.create_secret(
    v_key,
    'audit_hmac_key',
    'HMAC key for the append-only audit_log hash chain (CLAUDE.md §3).'
  );
exception
  when others then
    raise exception E'audit_hmac_key bootstrap failed.\n  error            : % (SQLSTATE %)\n  current_user     : %\n  search_path      : %\n  vault.secrets    : %\n  vault usage priv : %\n  pgcrypto schema  : %\n  create_secret n  : %',
      sqlerrm,
      sqlstate,
      current_user,
      current_setting('search_path'),
      coalesce(to_regclass('vault.secrets')::text, '<missing>'),
      coalesce((select has_schema_privilege(current_user, 'vault', 'usage')::text
                  from pg_namespace where nspname = 'vault'), '<no vault schema>'),
      coalesce((select extnamespace::regnamespace::text
                  from pg_extension where extname = 'pgcrypto'), '<not installed>'),
      (select count(*) from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'vault' and p.proname = 'create_secret');
end $$;

-- ---- 3. First-admin bootstrap ----------------------------------------------
-- Promotes an existing auth user to Admin of the launch tenant, and writes the claim
-- into `raw_app_meta_data` so their CURRENT token is not stale on the next refresh.
--
-- Deliberately takes an email of a user that must ALREADY EXIST: creating an account
-- here would mean this function could mint credentials, and it is callable by
-- service_role. Promotion of an account someone already proved control of is a much
-- smaller primitive than account creation.
create or replace function public.bootstrap_admin(p_email citext)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, auth, pg_temp
as $$
declare
  v_user uuid;
  v_tenant uuid;
begin
  select id into v_user from auth.users where email = p_email;
  if v_user is null then
    raise exception 'no auth user with email %; invite or sign them up first', p_email;
  end if;

  select id into v_tenant from public.tenants order by created_at asc limit 1;
  if v_tenant is null then
    raise exception 'no tenant exists; run the seed first';
  end if;

  insert into public.profiles (id, tenant_id, role, is_active)
  values (v_user, v_tenant, 'admin', true)
  on conflict (id) do update
    set role = 'admin', is_active = true, tenant_id = excluded.tenant_id;

  -- Mirror into the JWT source so the hook and the profile row agree immediately.
  -- They MUST agree: src/lib/auth/context.ts treats divergence as a dead session.
  update auth.users
     set raw_app_meta_data =
           coalesce(raw_app_meta_data, '{}'::jsonb)
           || jsonb_build_object('role', 'admin', 'tenant_id', v_tenant)
   where id = v_user;

  return v_user;
end $$;

revoke execute on function public.bootstrap_admin(citext) from public, anon, authenticated;
grant execute on function public.bootstrap_admin(citext) to service_role;

-- ---- 4. Analytics rollup ----------------------------------------------------
-- Raw telemetry → the pre-aggregated table dashboards read. Recomputes a trailing
-- window rather than appending, so a late-arriving beacon corrects its day instead of
-- double-counting it (the `on conflict … do update` is a SET, not an increment).
create or replace function app.rollup_pageviews(p_days int default 3)
  returns int
  language plpgsql
  security definer
  set search_path = public, app, pg_temp
as $$
declare
  n int;
begin
  insert into public.rollup_daily_pageviews (tenant_id, day, path, locale, views)
  select e.tenant_id,
         (e.occurred_at at time zone 'UTC')::date,
         e.path,
         coalesce(e.locale, 'en'),
         count(*)
    from public.analytics_events e
   where e.event_type = 'pageview'
     and e.path is not null
     and e.occurred_at >= now() - make_interval(days => greatest(p_days, 1))
   group by 1, 2, 3, 4
  on conflict (tenant_id, day, path, locale)
    do update set views = excluded.views;

  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function app.rollup_pageviews(int) from public, anon, authenticated;

-- ---- 5. Scheduled jobs ------------------------------------------------------
-- Registered here rather than in a runbook step so a fresh environment is correct by
-- construction. Guarded on pg_cron being installed: it is a Supabase extension that an
-- operator enables per project, and a migration that hard-fails on its absence would
-- block every other statement above.
--
-- Note the schedules run on the DIRECT connection (:5432), never the Supavisor pooler —
-- pg_cron holds a session, which transaction-mode pooling cannot give it.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname)
      from cron.job
     where jobname in ('publish-scheduled', 'rollup-pageviews', 'telemetry-retention',
                       'telemetry-partitions');

    -- Scheduled content goes live within 5 minutes of its time.
    perform cron.schedule('publish-scheduled', '*/5 * * * *',
      $job$ select app.publish_scheduled() $job$);

    -- Dashboards are at most 15 minutes stale.
    perform cron.schedule('rollup-pageviews', '*/15 * * * *',
      $job$ select app.rollup_pageviews(3) $job$);

    -- Retention (0008) — RAW_TELEMETRY_RETENTION, leads, system_logs.
    perform cron.schedule('telemetry-retention', '0 3 * * *',
      $job$ select app.run_retention() $job$);

    -- Roll the monthly partitions forward before they are needed.
    perform cron.schedule('telemetry-partitions', '0 2 25 * *',
      $job$ select app.ensure_telemetry_partitions(2) $job$);
  else
    raise notice 'pg_cron not installed — schedule publish-scheduled / rollup-pageviews / run_retention manually';
  end if;
end $$;

-- ---- 6. Lead notification trigger (§10) ------------------------------------
-- Fires AFTER INSERT so the row is committed before the Worker is asked to fetch it,
-- and carries ONLY `lead_id` + `tenant_id` — no PII crosses the public `*.workers.dev`
-- hop. The Worker authenticates the call, then re-reads the row server-side.
--
-- Guarded on pg_net: without it the trigger is not created and leads simply arrive
-- unannounced, which is a missing feature rather than a broken insert path. A contact
-- form that 500s because a notification could not be queued is the worse failure.
create or replace function app.tg_notify_lead() returns trigger
  language plpgsql
  security definer
  set search_path = public, app, extensions, net, pg_temp
as $$
declare
  v_url text;
  v_secret text;
begin
  select coalesce(identity ->> 'notify_lead_url', '') into v_url
    from public.site_settings where tenant_id = new.tenant_id;
  if v_url = '' then return null; end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'notify_lead_secret';
  if v_secret is null then return null; end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('lead_id', new.id, 'tenant_id', new.tenant_id)
  );
  return null;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    create trigger leads_notify after insert on public.leads
      for each row execute function app.tg_notify_lead();
  else
    raise notice 'pg_net not installed — lead notifications disabled (leads still save)';
  end if;
end $$;

-- ---- 7. Consent ledger write path -------------------------------------------
-- The banner posts to a Worker endpoint; that endpoint calls this. security definer
-- because consent_log has no INSERT policy — the ledger is written by exactly one path
-- and read by Admin/Developer, never appended to by a session.
create or replace function public.record_consent(
  p_subject_hash text,
  p_categories jsonb,
  p_policy_version text,
  p_action text default 'grant'
) returns void
  language plpgsql
  security definer
  set search_path = public, app, pg_temp
as $$
begin
  insert into public.consent_log (tenant_id, subject_hash, categories, policy_version, action)
  values (app.default_tenant_id(), p_subject_hash, p_categories, p_policy_version,
          case when p_action = 'withdraw' then 'withdraw' else 'grant' end);
end $$;

revoke execute on function public.record_consent(text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.record_consent(text, jsonb, text, text) to service_role;
