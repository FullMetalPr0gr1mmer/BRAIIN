-- ─────────────────────────────────────────────────────────────────────────────
-- 0072 — Two-step sign-in (2FA, TOTP; Admin v2 U17). Forward-only, expand only.
-- Depends on 0010 (the access-token hook and profiles_auth_admin_read), 0011 (USAGE on schema
-- app for supabase_auth_admin), 0031 (the audit chain), 0033 (app.live_role), 0050
-- (app.role_manages_users, the audit actor binding) and 0055 (admin_security_settings,
-- public.staff_accounts, profiles.is_owner, the session revocation this mirrors).
--
-- What it closes. Supabase Auth can hold a second factor per person (an authenticator app,
-- TOTP), and a session that typed its code carries `aal: "aal2"` in its access token. Nothing
-- here asked for it: a password alone opened the admin AND the database (PostgREST honours
-- whatever role the token carries). Now:
--
--   • admin_security_settings.require_mfa ("Require 2FA for everyone", Users › Security,
--     Admin only in both layers exactly as the row's other two settings: 0055's policies and
--     its RESTRICTIVE live check cover every column). Off by default, and off for every
--     tenant after this migration: nothing changes until an Admin who uses 2FA turns it on.
--   • app.mfa_required(p_user, p_tenant): the one rule. A person must be at aal2 when they
--     have a VERIFIED factor (any type: only TOTP is offered, and a phone factor, if ever
--     switched on, must not weaken the rule), or when their tenant requires it.
--     SECURITY DEFINER (it reads auth.mfa_factors, no API role's to read, and a FORCE-RLS
--     table), empty search_path, executable by supabase_auth_admin only.
--   • public.custom_access_token_hook, restated: the same contract as 0010 (invoker,
--     `stable`, reads profiles through profiles_auth_admin_read, strips role and tenant for
--     no profile or a switched-off one), plus ONE rule: role and tenant are stamped only when
--     the token's `aal` meets the required level. A password-only (aal1) token of a person
--     who needs aal2 carries no role, so RLS treats it as the anon fence, which is what a
--     deactivated person's token already is since 0010. This is the database half of 2FA: it
--     stops a stolen password + GoTrue's public password grant + a direct PostgREST call.
--     The Worker's half is resolveAuthContext (src/lib/auth/context.ts), stricter, never
--     looser: it also sends a person whose tenant requires 2FA but who has none to set it up.
--       - NO exception handler. A hook that raises fails every sign-in and refresh (0011's
--         warning); a handler that swallowed would either stamp (fail open) or strip
--         everyone (lock everyone out). The helper is two indexed lookups instead, and the
--         postconditions below prove it can run before anyone signs in.
--       - search_path moves from 0010's `public, pg_temp` to '' with every name qualified
--         (P-14). Still NOT a definer (0010's reasoning stands).
--       - ROLLBACK of the hook alone: re-run 0010's `create or replace function
--         public.custom_access_token_hook` body (docs/launch-runbook.md §10, "2FA"). Every
--         token minted afterwards is stamped as before 0072, whatever its aal.
--   • public.reset_two_step(p_tenant, p_user): an Admin's "Reset 2FA" for a colleague who lost
--     their phone. One definer transaction: the live Admin check, the target's factors, every
--     session and refresh token of the target, and the audit row, so a reset whose audit row
--     cannot be chained does not happen. Never yourself (turn it off on your own account),
--     never the account owner (runbook §3a: whoever runs the database).
--   • public.staff_accounts(p_tenant) gains `two_step` (a verified factor) and `is_active`
--     (the users screen's 2FA column; the health check counts active members without 2FA).
--     The result type changes, so the function is dropped and created again. A Worker
--     built before this migration parses the new rows fine (StaffAccountRowSchema is not
--     strict: unknown keys are dropped), so applying this before the deploy is safe.
--
-- Deploy order (launch runbook §10): push this, then deploy the Worker. Between the two the
-- old Worker runs against the new hook: nobody has a factor yet (enrolment needs the new
-- Worker) and require_mfa is false everywhere, so every token is stamped exactly as before.
-- Never switch Require on before the new Worker is live.
--
-- Production as of 2026-10-18: PostgreSQL 17.6; the ledger holds every migration through
-- 0065. Grants are stated for both Supabase privilege regimes (README P-14). The help guides
-- this slice rewrites are added through H11's app.put_help_guide (see the TODO at the end).
-- CLAUDE.md §2 (session invalidation), §3 (Pillar 1, 2FA), §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0065). The hook and
-- public.profiles are on every sign-in and refresh; the column takes a lock on
-- admin_security_settings, which every admin request reads. A statement below that waits more
-- than five seconds for a lock raises instead, the whole migration rolls back, and the push is
-- retried later. Transaction-local.
set local lock_timeout = '5s';

-- ---- 1. The setting ---------------------------------------------------------------------------
-- A constant default: no table rewrite.
alter table public.admin_security_settings
  add column if not exists require_mfa boolean not null default false;

-- Grants, stated again with the new column (P-14). Staff: read; insert the key and the three
-- settings; update the three settings. The service role: read (the session check embeds the
-- row in its profile read). No grant to supabase_auth_admin and no new policy: the hook reads
-- the setting through app.mfa_required, a definer (a supabase_auth_admin policy could carry
-- no meaningful tenant predicate).
revoke all on public.admin_security_settings from public, anon, authenticated, service_role;
grant select on public.admin_security_settings to authenticated, service_role;
grant insert (tenant_id, session_max_days, invite_domain, require_mfa)
  on public.admin_security_settings to authenticated;
grant update (session_max_days, invite_domain, require_mfa)
  on public.admin_security_settings to authenticated;

-- ---- 2. The rule, once ------------------------------------------------------------------------
-- The same case table runs in supabase/tests/two_step.test.sql (the hook) and
-- tests/lib/twoStep.spec.ts (the Worker's rule): keep the two visibly equal.
create or replace function app.mfa_required(p_user uuid, p_tenant uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f
                  where f.user_id = p_user and f.status = 'verified'::auth.factor_status)
      or coalesce((select s.require_mfa from public.admin_security_settings s
                    where s.tenant_id = p_tenant), false)
$$;
revoke all on function app.mfa_required(uuid, uuid) from public, anon, authenticated, service_role;
do $$
begin
  -- As 0011: the role exists on Supabase; on a bare Postgres the hook is never called.
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function app.mfa_required(uuid, uuid) to supabase_auth_admin';
  end if;
end $$;

-- ---- 3. The access-token hook, restated -------------------------------------------------------
-- 0010's body, plus the assurance level. `aal` is one of GoTrue's required claims ("aal1" after
-- a password, "aal2" after a verified code); anything else, missing included, counts as below
-- aal2, so a malformed event can only withhold the role, never grant it.
create or replace function public.custom_access_token_hook(event jsonb)
  returns jsonb
  language plpgsql
  stable
  set search_path = ''
as $$
declare
  v_role text;
  v_tenant uuid;
  v_active boolean;
  v_stamp boolean;
  claims jsonb;
  app_meta jsonb;
begin
  select p.role::text, p.tenant_id, p.is_active
    into v_role, v_tenant, v_active
    from public.profiles p
   where p.id = (event ->> 'user_id')::uuid;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  app_meta := coalesce(claims -> 'app_metadata', '{}'::jsonb);

  -- A user with no profile, or a deactivated one, gets NO role claim (0010). Since 0072, so
  -- does a token below the assurance level the account requires (app.mfa_required): it can
  -- still authenticate with GoTrue, and it then holds nothing until the code is typed.
  v_stamp := v_role is not null and v_active is true;
  if v_stamp and (claims ->> 'aal') is distinct from 'aal2' then
    v_stamp := not app.mfa_required((event ->> 'user_id')::uuid, v_tenant);
  end if;

  if v_stamp then
    app_meta := app_meta || jsonb_build_object('role', v_role, 'tenant_id', v_tenant);
  else
    app_meta := app_meta - 'role' - 'tenant_id';
  end if;

  claims := jsonb_set(claims, '{app_metadata}', app_meta);
  return jsonb_set(event, '{claims}', claims);
end $$;

-- Only GoTrue may execute it (0010), now stated for the service role too (P-14).
revoke all on function public.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin';
  end if;
end $$;

-- ---- 4. Reset 2FA -----------------------------------------------------------------------------
-- The caller: a live Admin of the token's tenant (42501 otherwise: a demoted, deactivated or
-- locked Admin token reads 42501). The target: a profile of the same tenant (22023
-- `not_found`), not the caller (22023 `self`), not the account owner (42501 `owner_protected`),
-- holding at least one factor (22023 `nothing_to_reset`, so a misclick signs nobody out). The
-- factors go (their challenges cascade), then every session and refresh token, as
-- app.tg_profiles_revoke_sessions does, then the audit row, all in one transaction.
create or replace function public.reset_two_step(p_tenant uuid, p_user uuid) returns integer
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner boolean;
  v_found boolean;
  v_n integer;
begin
  if v_uid is null
     or p_tenant is distinct from app.effective_tenant_id()
     or not app.role_manages_users(app.live_role()) then
    raise exception using errcode = '42501',
      message = 'reset_two_step: the caller is not a live Admin of this tenant';
  end if;
  select true, p.is_owner into v_found, v_owner
    from public.profiles p
   where p.id = p_user and p.tenant_id = p_tenant
   for update;
  if v_found is not true then
    raise exception using errcode = '22023', message = 'not_found';
  end if;
  if p_user = v_uid then
    raise exception using errcode = '22023', message = 'self';
  end if;
  if v_owner is true then
    raise exception using errcode = '42501', message = 'owner_protected';
  end if;
  delete from auth.mfa_factors where user_id = p_user;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception using errcode = '22023', message = 'nothing_to_reset';
  end if;
  delete from auth.sessions where user_id = p_user;
  delete from auth.refresh_tokens where user_id = p_user::text;
  -- Hash-chained by audit_log's own triggers, as every insert is. A definer keeps the actor it
  -- writes (0050), so it names its caller itself, as transfer_ownership does.
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, v_uid, 'admin', 'user.two_step_reset', 'profile', p_user::text,
          jsonb_build_object('factors', v_n));
  return v_n;
end $$;
revoke all on function public.reset_two_step(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.reset_two_step(uuid, uuid) to authenticated;

-- ---- 5. The directory gains the 2FA flag ------------------------------------------------------
-- The result type changes, so drop and create (a `create or replace` cannot change it). Same
-- checks, same order, same cap, same grants as 0055.
drop function if exists public.staff_accounts(uuid);
create function public.staff_accounts(p_tenant uuid)
  returns table (id uuid, email text, invited_at timestamptz, email_confirmed_at timestamptz,
                 last_sign_in_at timestamptz, is_owner boolean, two_step boolean,
                 is_active boolean)
  language sql stable security definer set search_path = '' as $$
  select p.id, u.email::text, u.invited_at, u.email_confirmed_at, u.last_sign_in_at, p.is_owner,
         exists (select 1 from auth.mfa_factors f
                  where f.user_id = p.id and f.status = 'verified'::auth.factor_status),
         p.is_active
    from public.profiles p
    join auth.users u on u.id = p.id
   where p_tenant = app.effective_tenant_id()
     and p.tenant_id = p_tenant
     and app.role_manages_users((select app.live_role()))
   order by p.created_at, p.id
   limit 200
$$;
revoke all on function public.staff_accounts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_accounts(uuid) to authenticated;

-- ---- 6. The guides ----------------------------------------------------------------------------
-- TODO(U17, H11): once H11 (the help-guide catalog) merges, add here, for each guide this slice
-- rewrites, one call:
--   select app.put_help_guide($guide$<docs/admin-v2/guides/your-account.json>$guide$::jsonb);
--   select app.put_help_guide($guide$<docs/admin-v2/guides/roles-and-access.json>$guide$::jsonb);
-- (the JSON files are the guides as they will be seeded; tests/lib/helpCentre.spec.ts holds
-- them to the set's rules today). Until then this migration leaves the help set alone.

-- ---- Postconditions ---------------------------------------------------------------------------
-- The first block is the one the push depends on: if the owner of the definers cannot read
-- auth.mfa_factors, every sign-in would fail at the hook. It refuses here and rolls back.
do $$
declare
  v_me name := current_user;
  v_owner oid;
begin
  -- ---- The definers can run: their owner is the migration role, bypasses RLS (they read
  -- FORCE-RLS tables), reads and deletes factors, deletes sessions and reads accounts.
  foreach v_owner in array array[
      (select proowner from pg_proc where oid = 'app.mfa_required(uuid, uuid)'::regprocedure),
      (select proowner from pg_proc where oid = 'public.reset_two_step(uuid, uuid)'::regprocedure),
      (select proowner from pg_proc where oid = 'public.staff_accounts(uuid)'::regprocedure)] loop
    if v_owner is distinct from (select oid from pg_roles where rolname = v_me) then
      raise exception '0072: the definers must be owned by the migration role %', v_me;
    end if;
  end loop;
  if not exists (select 1 from pg_roles r where r.rolname = v_me and (r.rolsuper or r.rolbypassrls)) then
    raise exception '0072: the definers'' owner (%) does not bypass RLS: app.mfa_required would not see the tenant''s setting', v_me;
  end if;
  if to_regclass('auth.mfa_factors') is null then
    raise exception '0072: auth.mfa_factors is missing: the hook would fail every sign-in';
  end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                   join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'auth' and t.typname = 'factor_status'
                    and e.enumlabel = 'verified') then
    raise exception '0072: auth.factor_status has no ''verified'' label';
  end if;
  if not has_table_privilege(v_me, 'auth.mfa_factors', 'select')
     or not has_table_privilege(v_me, 'auth.mfa_factors', 'delete') then
    raise exception '0072: % cannot SELECT and DELETE auth.mfa_factors, so the hook would fail every sign-in. Refused (run the readback''s pre-push query)', v_me;
  end if;
  if not has_table_privilege(v_me, 'auth.sessions', 'delete')
     or not has_table_privilege(v_me, 'auth.refresh_tokens', 'delete')
     or not has_table_privilege(v_me, 'auth.users', 'select') then
    raise exception '0072: % cannot DELETE sessions and refresh tokens or read auth.users', v_me;
  end if;
  -- The privileges, exercised, as the definers will exercise them.
  perform 1 from auth.mfa_factors where false;
  execute 'delete from auth.mfa_factors where false';
  execute 'delete from auth.sessions where false';
  execute 'delete from auth.refresh_tokens where false';
  -- The rule itself runs, for a person who does not exist: no factor, no setting.
  if app.mfa_required('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000') then
    raise exception '0072: app.mfa_required answers true for nobody';
  end if;
end $$;

do $$
declare
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_hook_role boolean := exists (select 1 from pg_roles where rolname = 'supabase_auth_admin');
  v_have text[];
  v_bad text;
  v_def text;
  p text;
begin
  -- ---- The hook: invoker, stable, empty search_path, the rule in its body, and only GoTrue
  -- executes it.
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.custom_access_token_hook(jsonb)'::regprocedure
                    and not f.prosecdef and f.provolatile::text = 's'
                    and f.proconfig = array['search_path=""']) then
    raise exception '0072: the hook must stay SECURITY INVOKER and STABLE, with search_path = ''''';
  end if;
  v_def := pg_get_functiondef('public.custom_access_token_hook(jsonb)'::regprocedure);
  if v_def !~ 'app\.mfa_required\(' or v_def !~ '''aal''' or v_def !~ '''aal2'''
     or v_def !~ 'public\.profiles' then
    raise exception '0072: the hook body does not read the assurance level through app.mfa_required';
  end if;
  if v_hook_role and (not has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute')
                      or not has_function_privilege('supabase_auth_admin', 'app.mfa_required(uuid, uuid)', 'execute')
                      or not has_schema_privilege('supabase_auth_admin', 'app', 'usage')) then
    raise exception '0072: supabase_auth_admin cannot run the hook and its rule: nobody could sign in';
  end if;

  -- ---- The functions: their kind, their search_path and who may call them.
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.mfa_required(uuid, uuid)'::regprocedure and f.prosecdef
                    and f.provolatile::text = 's' and f.proconfig = array['search_path=""']) then
    raise exception '0072: app.mfa_required must be a STABLE SECURITY DEFINER with search_path = ''''';
  end if;
  foreach p in array array['public.reset_two_step(uuid, uuid)', 'public.staff_accounts(uuid)'] loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure and f.prosecdef
                      and f.proconfig = array['search_path=""']) then
      raise exception '0072: % must be SECURITY DEFINER with search_path = ''''', p;
    end if;
  end loop;
  select string_agg(format('%s %s', r, f), ', ' order by f, r) into v_bad
    from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r
    cross join (values ('public.custom_access_token_hook(jsonb)', array[]::text[]),
                       ('app.mfa_required(uuid, uuid)', array[]::text[]),
                       ('public.reset_two_step(uuid, uuid)', array['authenticated']),
                       ('public.staff_accounts(uuid)', array['authenticated']))
                 as x(f, allowed)
   where has_function_privilege(r, f, 'execute') is distinct from (r = any (x.allowed));
  if v_bad is not null then
    raise exception '0072: wrong EXECUTE (role function): %', v_bad;
  end if;
  -- The directory's columns, in order.
  select array_agg(a order by o) into v_have
    from unnest((select proargnames from pg_proc where oid = 'public.staff_accounts(uuid)'::regprocedure))
         with ordinality as t(a, o);
  if v_have is distinct from array['p_tenant', 'id', 'email', 'invited_at', 'email_confirmed_at',
                                   'last_sign_in_at', 'is_owner', 'two_step', 'is_active'] then
    raise exception '0072: public.staff_accounts columns are %', v_have;
  end if;

  -- ---- admin_security_settings: the column, forced RLS, 0055's four policies, the grants.
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.admin_security_settings'::regclass
                    and a.attname = 'require_mfa' and a.atttypid = 'boolean'::regtype
                    and a.attnotnull and not a.attisdropped
                    and pg_get_expr((select d.adbin from pg_attrdef d
                                      where d.adrelid = a.attrelid and d.adnum = a.attnum),
                                    a.attrelid) = 'false') then
    raise exception '0072: admin_security_settings.require_mfa must be boolean NOT NULL DEFAULT false';
  end if;
  if exists (select 1 from public.admin_security_settings where require_mfa) then
    raise exception '0072: a tenant requires 2FA right after the migration: nobody chose that';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.admin_security_settings'::regclass) then
    raise exception '0072: admin_security_settings is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'admin_security_settings') s;
  if v_have is distinct from array['admin_security_settings_insert INSERT PERMISSIVE {authenticated}',
                                   'admin_security_settings_live ALL RESTRICTIVE {authenticated}',
                                   'admin_security_settings_read SELECT PERMISSIVE {authenticated}',
                                   'admin_security_settings_update UPDATE PERMISSIVE {authenticated}'] then
    raise exception '0072: admin_security_settings policies are %', v_have;
  end if;
  -- Table level: SELECT for staff and the service role, nothing else for anyone.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.admin_security_settings', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0072: wrong table privileges on admin_security_settings (role privilege): %', v_bad;
  end if;
  -- Column level: staff insert the key and the three settings and update the three settings;
  -- nobody holds REFERENCES; PUBLIC, anon and the service role hold no column write.
  select string_agg(format('%s %s.%s', g.who, g.priv, g.col), ', ' order by g.who, g.col, g.priv) into v_bad
    from (select x.who, pr.priv, a.attname::text as col,
                 has_column_privilege(x.who::name, 'public.admin_security_settings', a.attname::text, pr.priv) as held,
                 (x.who = 'authenticated'
                  and ((pr.priv = 'insert'
                        and a.attname in ('tenant_id', 'session_max_days', 'invite_domain', 'require_mfa'))
                       or (pr.priv = 'update'
                           and a.attname in ('session_max_days', 'invite_domain', 'require_mfa')))) as wanted
            from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as x(who)
            cross join unnest(array['insert', 'update', 'references']) as pr(priv)
            cross join pg_attribute a
           where a.attrelid = 'public.admin_security_settings'::regclass and a.attnum > 0
             and not a.attisdropped) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0072: wrong column privileges on admin_security_settings (role privilege.column): %', v_bad;
  end if;
end $$;
