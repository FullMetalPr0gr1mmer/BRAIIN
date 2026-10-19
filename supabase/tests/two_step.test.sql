-- pgTAP: two-step sign-in (0072, Admin v2 U17). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus the
-- three stale Admin tokens the live checks exist for: one whose profile was demoted to
-- content_creator, one deactivated and one locked, each still carrying an `admin` claim
-- (CLAUDE.md §9 (b)).
--   • The access-token hook: role and tenant stamped only at the assurance level the account
--     requires (a verified factor, or the tenant's require_mfa), every other claim untouched,
--     a role sent in the event never trusted. The case table is tests/lib/twoStep.spec.ts's
--     (the Worker's rule): keep the two visibly equal.
--   • app.mfa_required: GoTrue's (supabase_auth_admin) only.
--   • require_mfa: an Admin sets it (the version moves); every other role, the stale tokens
--     and another tenant change nothing; anon nothing.
--   • public.reset_two_step: a live Admin of the named tenant (the token's) resets a
--     colleague's factors and every session in one transaction with a chained audit row;
--     never yourself, never the owner, never "nothing"; everyone else is refused and nothing
--     is deleted.
--   • public.staff_accounts: two_step and is_active per person, for a live Admin only.
--   • The two guides this slice puts (H11's app.put_help_guide): the catalog holds this
--     slice's text, and every tenant, the ones made after the migration included, holds it.

begin;
select plan(76);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('17000000-0000-0000-0000-000000000001', 'T1'),
  ('17000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email, invited_at, email_confirmed_at, last_sign_in_at) values
  ('17000000-0000-0000-0000-0000000000a0', 'u17-owner@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000a1', 'u17-admin@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000a2', 'u17-demoted@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000a3', 'u17-inactive@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000a4', 'u17-locked@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000c1', 'u17-creator@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000e1', 'u17-seo@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000d1', 'u17-developer@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000f1', 'u17-other-admin@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000b1', 'u17-both@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000b2', 'u17-unverified@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000b3', 'u17-none@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000f2', 'u17-other-member@example.test', null, now(), now()),
  ('17000000-0000-0000-0000-0000000000a9', 'u17-no-profile@example.test', null, now(), now());
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('17000000-0000-0000-0000-0000000000a0', '17000000-0000-0000-0000-000000000001', 'admin', true, null, 'Owner'),
  ('17000000-0000-0000-0000-0000000000a1', '17000000-0000-0000-0000-000000000001', 'admin', true, null, 'Admin'),
  -- Stale: each token below still says admin.
  ('17000000-0000-0000-0000-0000000000a2', '17000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Demoted'),
  ('17000000-0000-0000-0000-0000000000a3', '17000000-0000-0000-0000-000000000001', 'admin', false, null, 'Gone'),
  ('17000000-0000-0000-0000-0000000000a4', '17000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes', 'Locked'),
  ('17000000-0000-0000-0000-0000000000c1', '17000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Creator'),
  ('17000000-0000-0000-0000-0000000000e1', '17000000-0000-0000-0000-000000000001', 'seo', true, null, 'Seo'),
  ('17000000-0000-0000-0000-0000000000d1', '17000000-0000-0000-0000-000000000001', 'developer', true, null, 'Developer'),
  ('17000000-0000-0000-0000-0000000000f1', '17000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Other admin'),
  ('17000000-0000-0000-0000-0000000000b1', '17000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Both'),
  ('17000000-0000-0000-0000-0000000000b2', '17000000-0000-0000-0000-000000000001', 'seo', true, null, 'Unverified'),
  ('17000000-0000-0000-0000-0000000000b3', '17000000-0000-0000-0000-000000000001', 'developer', true, null, 'None'),
  ('17000000-0000-0000-0000-0000000000f2', '17000000-0000-0000-0000-0000000000ff', 'seo', true, null, 'Other member');
update public.profiles set is_owner = true where id = '17000000-0000-0000-0000-0000000000a0';

-- Factors as GoTrue holds them (an authenticator app each; friendly names unique per person).
create function _factor(p_user uuid, p_tag text, p_status text) returns void language sql as $$
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (md5(p_user::text || p_tag)::uuid, p_user, 'u17 ' || p_tag, 'totp'::auth.factor_type,
          p_status::auth.factor_status, now(), now(), 'U17FIXTURESECRET');
$$;
select _factor('17000000-0000-0000-0000-0000000000a0', 'owner', 'verified');
select _factor('17000000-0000-0000-0000-0000000000b1', 'phone app', 'verified');
select _factor('17000000-0000-0000-0000-0000000000b1', 'abandoned', 'unverified');
select _factor('17000000-0000-0000-0000-0000000000b2', 'abandoned', 'unverified');
select _factor('17000000-0000-0000-0000-0000000000f2', 'other', 'verified');
-- A challenge on b1's app: it goes with the factor.
insert into auth.mfa_challenges (id, factor_id, created_at, ip_address)
values (md5('u17-challenge')::uuid, md5('17000000-0000-0000-0000-0000000000b1' || 'phone app')::uuid,
        now(), '127.0.0.1');

create function _give_sessions(p_user uuid, p_tag text) returns void language sql as $$
  insert into auth.sessions (id, user_id, created_at, updated_at)
  values (md5(p_user::text || p_tag)::uuid, p_user, now(), now());
  insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
  values ('00000000-0000-0000-0000-000000000000', 'u17-' || p_tag || '-a', p_user::text, false, now(), now(),
          md5(p_user::text || p_tag)::uuid),
         ('00000000-0000-0000-0000-000000000000', 'u17-' || p_tag || '-b', p_user::text, false, now(), now(), null);
$$;
-- What a person still holds, as "factors f, sessions/tokens".
create function _held(p_user uuid) returns text language sql stable as $$
  select (select count(*) from auth.mfa_factors where user_id = p_user)::text || 'f '
      || (select count(*) from auth.sessions where user_id = p_user)::text || '/'
      || (select count(*) from auth.refresh_tokens where user_id = p_user::text)::text
$$;
select _give_sessions('17000000-0000-0000-0000-0000000000b1', 'b1');
select _give_sessions('17000000-0000-0000-0000-0000000000b2', 'b2');
select _give_sessions('17000000-0000-0000-0000-0000000000b3', 'b3');
select _give_sessions('17000000-0000-0000-0000-0000000000a0', 'a0');

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
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

-- The event GoTrue sends the hook: the user, and claims carrying the assurance level (null
-- leaves it out) and a role the CLIENT claims (admin, in another tenant), which must never
-- survive. Answers "role tenant" of the claims the hook returns, "-" for a missing claim.
create function _hook(p_user uuid, p_aal text) returns text language sql as $$
  with out as (
    select public.custom_access_token_hook(jsonb_build_object(
             'user_id', p_user,
             'claims', jsonb_strip_nulls(jsonb_build_object(
               'sub', p_user, 'aal', p_aal, 'role', 'authenticated', 'session_id', 'u17-session',
               'app_metadata', jsonb_build_object(
                 'provider', 'email', 'role', 'admin',
                 'tenant_id', '17000000-0000-0000-0000-0000000000ee'))))) as e
  )
  select coalesce(e #>> '{claims,app_metadata,role}', '-') || ' '
      || coalesce(e #>> '{claims,app_metadata,tenant_id}', '-')
    from out
$$;

-- The e-mails, 2FA flags and access public.staff_accounts answers the CURRENT caller.
create function _accounts(p_tenant uuid) returns text language sql as $$
  select coalesce(string_agg(format('%s:%s:%s', split_part(email, '@', 1), two_step::text, is_active::text), ','
                             order by email), '')
    from public.staff_accounts(p_tenant)
$$;

-- T1's security row as the CURRENT role sees it.
create function _security() returns text language sql stable as $$
  select coalesce(string_agg(require_mfa::text || '/v' || version::text, ','), '')
    from public.admin_security_settings where tenant_id = '17000000-0000-0000-0000-000000000001'
$$;

grant execute on function _as(text, text, text), _rows(text), _accounts(uuid), _security(),
  _hook(uuid, text) to anon, authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function _hook(uuid, text) to supabase_auth_admin';
  end if;
end $$;

-- T2 requires 2FA from here on; T1 does not (yet).
insert into public.admin_security_settings (tenant_id, require_mfa)
values ('17000000-0000-0000-0000-0000000000ff', true);

-- ── 1. the hook: role only at the required level ─────────────────────────────────
-- (The case table of tests/lib/twoStep.spec.ts.)
select is(_hook('17000000-0000-0000-0000-0000000000a1', 'aal1'),
  'admin 17000000-0000-0000-0000-000000000001',
  'admin, no factor, tenant not requiring, aal1: stamped (another tenant requiring changes nothing here)');
select is(_hook('17000000-0000-0000-0000-0000000000c1', 'aal1'),
  'content_creator 17000000-0000-0000-0000-000000000001',
  'content_creator, no factor, aal1: stamped with the PROFILE''s role, never the event''s');
select is(_hook('17000000-0000-0000-0000-0000000000e1', 'aal1'),
  'seo 17000000-0000-0000-0000-000000000001', 'seo, no factor, aal1: stamped');
select is(_hook('17000000-0000-0000-0000-0000000000d1', 'aal1'),
  'developer 17000000-0000-0000-0000-000000000001', 'developer, no factor, aal1: stamped');
select is(_hook('17000000-0000-0000-0000-0000000000b1', 'aal1'), '- -',
  'a verified factor at aal1: stripped (the client''s role in the event is removed too)');
select is(_hook('17000000-0000-0000-0000-0000000000b1', 'aal2'),
  'content_creator 17000000-0000-0000-0000-000000000001', 'a verified factor at aal2: stamped');
select is(_hook('17000000-0000-0000-0000-0000000000b1', 'aal3'), '- -',
  'a verified factor and an aal GoTrue never writes: stripped');
select is(_hook('17000000-0000-0000-0000-0000000000b2', 'aal1'),
  'seo 17000000-0000-0000-0000-000000000001',
  'an unverified (abandoned) factor only, aal1: stamped (it does not count)');
select is(_hook('17000000-0000-0000-0000-0000000000f1', 'aal1'), '- -',
  'tenant requires 2FA, no factor, aal1: stripped');
select is(_hook('17000000-0000-0000-0000-0000000000f1', 'aal2'),
  'admin 17000000-0000-0000-0000-0000000000ff', 'tenant requires 2FA, aal2: stamped');
select is(_hook('17000000-0000-0000-0000-0000000000f1', null), '- -',
  'tenant requires 2FA and the event has no aal: stripped');
select is(_hook('17000000-0000-0000-0000-0000000000a1', null),
  'admin 17000000-0000-0000-0000-000000000001',
  'nothing required and no aal in the event: stamped, as before 0072');
select is(_hook('17000000-0000-0000-0000-0000000000a3', 'aal2'), '- -',
  'a deactivated profile, even at aal2: stripped (0010, unchanged)');
select is(_hook('17000000-0000-0000-0000-0000000000a9', 'aal2'), '- -',
  'no profile: stripped (0010, unchanged)');
select is(
  (select (public.custom_access_token_hook(jsonb_build_object(
             'user_id', '17000000-0000-0000-0000-0000000000b1',
             'claims', jsonb_build_object('sub', '17000000-0000-0000-0000-0000000000b1', 'aal', 'aal1',
                                          'session_id', 'u17-session', 'role', 'authenticated',
                                          'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', 1)),
                                          'app_metadata', jsonb_build_object('provider', 'email', 'role', 'admin'))))
           -> 'claims')::text),
  jsonb_build_object('sub', '17000000-0000-0000-0000-0000000000b1', 'aal', 'aal1',
                     'session_id', 'u17-session', 'role', 'authenticated',
                     'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', 1)),
                     'app_metadata', jsonb_build_object('provider', 'email'))::text,
  'stripped: every other claim comes back untouched, app_metadata keeps its other keys');

-- The same hook as GoTrue runs it, where this harness may become supabase_auth_admin. Where it
-- may not, the catalog checks below still prove the role holds what the hook needs.
do $$
declare
  v text;
begin
  begin
    execute 'set local role supabase_auth_admin';
    v := _hook('17000000-0000-0000-0000-0000000000b1', 'aal2') || '|'
         || _hook('17000000-0000-0000-0000-0000000000b1', 'aal1');
    execute 'reset role';
    perform set_config('u17.as_auth_admin',
      case when v = 'content_creator 17000000-0000-0000-0000-000000000001|- -' then 'ok'
           else 'wrong: ' || v end, true);
  exception
    when insufficient_privilege or invalid_parameter_value or undefined_object then
      perform set_config('u17.as_auth_admin', 'cannot-set-role: ' || sqlerrm, true);
    when others then
      perform set_config('u17.as_auth_admin', 'error: ' || sqlerrm, true);
  end;
end $$;
select ok(current_setting('u17.as_auth_admin') = 'ok'
          or current_setting('u17.as_auth_admin') like 'cannot-set-role:%',
  'as supabase_auth_admin the hook reads the factor and stamps at aal2 only ('
  || current_setting('u17.as_auth_admin') || ')');
select ok(has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute'),
  'supabase_auth_admin executes the hook');
select ok(has_function_privilege('supabase_auth_admin', 'app.mfa_required(uuid, uuid)', 'execute'),
  'supabase_auth_admin executes the rule the hook calls');
select ok(has_schema_privilege('supabase_auth_admin', 'app', 'usage'),
  'supabase_auth_admin may use schema app (0011)');

-- ── 2. app.mfa_required is GoTrue's alone ────────────────────────────────────────
select _as('17000000-0000-0000-0000-0000000000a1', 'admin', '17000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select app.mfa_required('17000000-0000-0000-0000-0000000000b1', '17000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'an Admin token cannot ask whether a colleague has 2FA');
reset role;
set local role anon;
select throws_ok($$ select app.mfa_required('17000000-0000-0000-0000-0000000000b1', '17000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call the rule');
reset role;
set local role service_role;
select throws_ok($$ select app.mfa_required('17000000-0000-0000-0000-0000000000b1', '17000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'the service role cannot call the rule');
reset role;

-- ── 3. the directory: two_step and is_active, for a live Admin only ───────────────
select _as('17000000-0000-0000-0000-0000000000a1', 'admin', '17000000-0000-0000-0000-000000000001');
set local role authenticated;
select is(_accounts('17000000-0000-0000-0000-000000000001'),
  'u17-admin:false:true,u17-both:true:true,u17-creator:false:true,u17-demoted:false:true,'
  'u17-developer:false:true,u17-inactive:false:false,u17-locked:false:true,u17-none:false:true,'
  'u17-owner:true:true,u17-seo:false:true,u17-unverified:false:true',
  'a live Admin reads each colleague''s 2FA (verified factors only) and access');
select _as('17000000-0000-0000-0000-0000000000c1', 'content_creator', '17000000-0000-0000-0000-000000000001');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '', 'content_creator: no rows');
select _as('17000000-0000-0000-0000-0000000000e1', 'seo', '17000000-0000-0000-0000-000000000001');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '', 'seo: no rows');
select _as('17000000-0000-0000-0000-0000000000d1', 'developer', '17000000-0000-0000-0000-000000000001');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '', 'developer: no rows');
select _as('17000000-0000-0000-0000-0000000000a2', 'admin', '17000000-0000-0000-0000-000000000001');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '', 'a demoted Admin token: no rows');
select _as('17000000-0000-0000-0000-0000000000a3', 'admin', '17000000-0000-0000-0000-000000000001');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '', 'a deactivated Admin token: no rows');
select _as('17000000-0000-0000-0000-0000000000a4', 'admin', '17000000-0000-0000-0000-000000000001');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '', 'a locked Admin token: no rows');
select _as('17000000-0000-0000-0000-0000000000f1', 'admin', '17000000-0000-0000-0000-0000000000ff');
select is(_accounts('17000000-0000-0000-0000-000000000001'), '',
  'another tenant''s Admin naming this tenant: no rows');
reset role;
set local role anon;
select throws_ok($$ select * from public.staff_accounts('17000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call the directory');
reset role;
set local role service_role;
select throws_ok($$ select * from public.staff_accounts('17000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'the service role cannot call the directory');
reset role;

-- ── 4. Require 2FA: an Admin's setting, live ──────────────────────────────────────
select _as('17000000-0000-0000-0000-0000000000a1', 'admin', '17000000-0000-0000-0000-000000000001');
set local role authenticated;
-- (_security() is STABLE: it sees its statement's snapshot, so each read is its own statement.)
select is(_rows($$ insert into public.admin_security_settings (tenant_id, require_mfa)
                   values ('17000000-0000-0000-0000-000000000001', true) $$), 1,
  'an Admin creates the row with Require 2FA on');
select is(_security(), 'true/v1', 'and reads it back');
select is(_rows($$ update public.admin_security_settings set require_mfa = false
                    where tenant_id = '17000000-0000-0000-0000-000000000001' $$), 1,
  'an Admin turns it off again');
select is(_security(), 'false/v2', 'and the version moves');
select _as('17000000-0000-0000-0000-0000000000c1', 'content_creator', '17000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.admin_security_settings set require_mfa = true $$)::text || ' ' || _security(),
  '0 ', 'content_creator sees and changes nothing');
select _as('17000000-0000-0000-0000-0000000000e1', 'seo', '17000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.admin_security_settings set require_mfa = true $$)::text || ' ' || _security(),
  '0 ', 'seo sees and changes nothing');
select _as('17000000-0000-0000-0000-0000000000d1', 'developer', '17000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.admin_security_settings set require_mfa = true $$)::text || ' ' || _security(),
  '0 ', 'developer sees and changes nothing');
select _as('17000000-0000-0000-0000-0000000000f1', 'admin', '17000000-0000-0000-0000-0000000000ff');
select is(_rows($$ update public.admin_security_settings set require_mfa = true
                    where tenant_id = '17000000-0000-0000-0000-000000000001' $$)::text || ' ' || _security(),
  '0 ', 'another tenant''s Admin sees and changes nothing of T1''s');
select _as('17000000-0000-0000-0000-0000000000a2', 'admin', '17000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.admin_security_settings set require_mfa = true $$)::text,
  '0', 'a demoted Admin token changes nothing (admin_security_settings_live)');
select _as('17000000-0000-0000-0000-0000000000a3', 'admin', '17000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.admin_security_settings set require_mfa = true $$)::text,
  '0', 'a deactivated Admin token changes nothing');
select _as('17000000-0000-0000-0000-0000000000a4', 'admin', '17000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.admin_security_settings set require_mfa = true $$)::text,
  '0', 'a locked Admin token changes nothing');
reset role;
set local role anon;
select throws_ok($$ update public.admin_security_settings set require_mfa = true $$,
  '42501', null, 'anon: no grant');
reset role;
select is((select require_mfa::text from public.admin_security_settings
            where tenant_id = '17000000-0000-0000-0000-000000000001'),
  'false', 'after every refused try, T1 still does not require 2FA');

-- ── 5. Reset 2FA ─────────────────────────────────────────────────────────────────
select _as('17000000-0000-0000-0000-0000000000c1', 'content_creator', '17000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'content_creator cannot reset');
select _as('17000000-0000-0000-0000-0000000000e1', 'seo', '17000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'seo cannot reset');
select _as('17000000-0000-0000-0000-0000000000d1', 'developer', '17000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'developer cannot reset');
select _as('17000000-0000-0000-0000-0000000000a2', 'admin', '17000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'a demoted Admin token cannot reset');
select _as('17000000-0000-0000-0000-0000000000a3', 'admin', '17000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'a deactivated Admin token cannot reset');
select _as('17000000-0000-0000-0000-0000000000a4', 'admin', '17000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'a locked Admin token cannot reset');
select _as('17000000-0000-0000-0000-0000000000f1', 'admin', '17000000-0000-0000-0000-0000000000ff');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'another tenant''s Admin naming this tenant cannot reset');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-0000000000ff', '17000000-0000-0000-0000-0000000000b1') $$,
  '22023', 'not_found', 'another tenant''s Admin cannot reach this tenant''s member through their own');
select _as('17000000-0000-0000-0000-0000000000a1', 'admin', '17000000-0000-0000-0000-000000000001');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000f2') $$,
  '22023', 'not_found', 'an Admin cannot reset a member of another tenant');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000a1') $$,
  '22023', 'self', 'not your own: you turn it off on your account');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000a0') $$,
  '42501', 'owner_protected', 'never the account owner''s (the runbook''s path)');
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b3') $$,
  '22023', 'nothing_to_reset', 'nothing to reset: refused, so nobody is signed out for nothing');
reset role;
set local role anon;
select throws_ok($$ select public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1') $$,
  '42501', null, 'anon cannot call it');
reset role;
select is(_held('17000000-0000-0000-0000-0000000000b1') || ', ' || _held('17000000-0000-0000-0000-0000000000b3')
          || ', ' || _held('17000000-0000-0000-0000-0000000000a0') || ', ' || _held('17000000-0000-0000-0000-0000000000f2'),
  '2f 1/2, 0f 1/2, 1f 1/2, 1f 0/0',
  'every refused call deleted nothing: factors and sessions intact');
select is((select count(*)::int from public.audit_log where action = 'user.two_step_reset'), 0,
  'and wrote no audit row');

select _as('17000000-0000-0000-0000-0000000000a1', 'admin', '17000000-0000-0000-0000-000000000001');
set local role authenticated;
select is(public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b1'),
  2, 'a live Admin resets a colleague with a verified and an abandoned factor: 2 removed');
reset role;
select is(_held('17000000-0000-0000-0000-0000000000b1'), '0f 0/0',
  'their factors, sessions and refresh tokens are gone');
select is((select count(*)::int from auth.mfa_challenges where id = md5('u17-challenge')::uuid), 0,
  'and the challenge on their app went with it');
select is(_held('17000000-0000-0000-0000-0000000000b2') || ', ' || _held('17000000-0000-0000-0000-0000000000a0'),
  '1f 1/2, 1f 1/2', 'nobody else lost a factor or a session');
select is(
  (select format('%s %s %s %s %s %s', a.tenant_id, a.actor_id, a.actor_role, a.entity_type, a.entity_id,
                 a.detail ->> 'factors')
     from public.audit_log a where a.action = 'user.two_step_reset'),
  '17000000-0000-0000-0000-000000000001 17000000-0000-0000-0000-0000000000a1 admin profile '
  '17000000-0000-0000-0000-0000000000b1 2',
  'one audit row: the tenant, who reset whom, and how many factors');
select ok((select count(*) = 1 and bool_and(a.hash <> '') from public.audit_log a
            where a.action = 'user.two_step_reset'),
  'the audit row is chained (the chain trigger set its hash)');
select _as('17000000-0000-0000-0000-0000000000a1', 'admin', '17000000-0000-0000-0000-000000000001');
set local role authenticated;
select is(public.reset_two_step('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000b2'),
  1, 'an abandoned setup alone can be reset too');
reset role;
select is(_held('17000000-0000-0000-0000-0000000000b2'), '0f 0/0', 'and its sessions end with it');

-- ── 6. the catalog ───────────────────────────────────────────────────────────────
select ok((select not prosecdef and provolatile::text = 's' and proconfig = array['search_path=""']
             from pg_proc where oid = 'public.custom_access_token_hook(jsonb)'::regprocedure),
  'the hook stays SECURITY INVOKER and STABLE, with an empty search_path');
select is(
  (select coalesce(string_agg(r, ',' order by r), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) r
    where has_function_privilege(r, 'public.custom_access_token_hook(jsonb)', 'execute')
       or has_function_privilege(r, 'app.mfa_required(uuid, uuid)', 'execute')),
  '', 'no API role executes the hook or its rule');
select ok((select prosecdef and proconfig = array['search_path=""']
             from pg_proc where oid = 'app.mfa_required(uuid, uuid)'::regprocedure),
  'the rule is a definer with an empty search_path');
select is(
  (select string_agg(format('%s %s', r, f), ', ' order by f, r)
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) r
     cross join unnest(array['public.reset_two_step(uuid, uuid)', 'public.staff_accounts(uuid)']) f
    where has_function_privilege(r, f, 'execute')),
  'authenticated public.reset_two_step(uuid, uuid), authenticated public.staff_accounts(uuid)',
  'staff tokens alone execute the reset and the directory (each checks its caller itself)');
select is(
  (select format('%s %s %s', format_type(a.atttypid, a.atttypmod), a.attnotnull::text,
                 pg_get_expr(d.adbin, d.adrelid))
     from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.admin_security_settings'::regclass and a.attname = 'require_mfa'),
  'boolean true false', 'require_mfa is boolean NOT NULL DEFAULT false');

-- ── 7. the guides (§6, put through H11's catalog) ───────────────────────────────
-- As the migration role (the catalog has no API-role privilege). Only this slice's two guides
-- are checked; the set's size is not (H11 rule 3).
select ok((select c.revision >= 2 and '/admin/2fa' = any (c.screens)
                  and c.body::text like '%Two factor authentication%'
             from app.help_guide_catalog c where c.slug = 'your-account'),
  'the catalog holds your-account with its 2FA section and /admin/2fa (revision moved by the put)');
select ok((select c.revision >= 2 and c.body::text like '%Require 2FA for everyone%'
                  and c.body::text like '%Reset 2FA%'
             from app.help_guide_catalog c where c.slug = 'roles-and-access'),
  'the catalog holds roles-and-access with Require 2FA and Reset 2FA (revision moved by the put)');
select is(
  (select count(*)::int
     from public.tenants t
     cross join app.help_guide_catalog c
    where c.slug in ('your-account', 'roles-and-access')
      and t.id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-0000000000ff')
      and not exists (select 1 from public.help_articles h
                       where h.tenant_id = t.id and h.slug = c.slug
                         and row(h.title, h.title_ar, h.minutes, h.tags, h.screens, h.caps,
                                 h.body, h.sort_order)
                             is not distinct from row(c.title, c.title_ar, c.minutes, c.tags,
                                                      c.screens, c.caps, c.body, c.sort_order))),
  0, 'a tenant made after the migration holds both guides, field for field the catalog''s');

select * from finish();
rollback;
