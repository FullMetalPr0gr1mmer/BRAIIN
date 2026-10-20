-- pgTAP: users v2 and the session posture (0055, Admin v2 U12a). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus the
-- three stale Admin tokens the live checks exist for: one whose profile was demoted to
-- content_creator, one deactivated and one locked, each still carrying an `admin` claim
-- (CLAUDE.md §9 (b)).
--   • profiles_live_read: a live Admin reads the tenant's people; a stale Admin token, the
--     other staff roles and another tenant's Admin read their own row at most; anon nothing.
--     The self re-promotion stays closed (H10's write policies, with the read beside them).
--   • The account owner: nobody demotes, deactivates, moves or deletes the owner, a live
--     Admin and the service role included; nor does an operator (an auth.users cascade
--     included) until the marker is cleared; no API role sets or clears the marker; one
--     owner per tenant, always an active Admin; the lockout RPC still locks the owner.
--   • public.transfer_ownership: only the owner, live, of the token's tenant, and only to
--     another active, unlocked Admin of that tenant; one chained audit row.
--   • profiles_revoke_sessions: a role, activity or tenant change deletes every session and
--     refresh token of that person (and only theirs); a name change, a lock and a refused
--     write delete nothing.
--   • public.staff_accounts: e-mails and sign-in times for a live Admin of the named tenant
--     (the token's) only; empty for everyone else; no EXECUTE for anon or the service role.
--   • admin_security_settings: an Admin reads, creates and changes the row, its CHECKs hold,
--     the version moves; every other role, the stale tokens and another tenant see and
--     change nothing; anon nothing; the grants under both regimes.

begin;
select plan(95);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('55000000-0000-0000-0000-000000000001', 'T1'),
  ('55000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email, invited_at, email_confirmed_at, last_sign_in_at) values
  ('55000000-0000-0000-0000-0000000000a0', 'u12-owner@example.test', null, now() - interval '30 days', now() - interval '1 day'),
  ('55000000-0000-0000-0000-0000000000a1', 'u12-admin@example.test', null, now() - interval '20 days', now() - interval '2 hours'),
  ('55000000-0000-0000-0000-0000000000a2', 'u12-demoted@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000a3', 'u12-inactive@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000a4', 'u12-locked@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000c1', 'u12-creator@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000e1', 'u12-seo@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000d1', 'u12-developer@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000f1', 'u12-other-admin@example.test', null, now(), now()),
  ('55000000-0000-0000-0000-0000000000b1', 'u12-target@example.test', now() - interval '1 day', null, null),
  ('55000000-0000-0000-0000-0000000000b2', 'u12-mover@example.test', null, now(), now());
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('55000000-0000-0000-0000-0000000000a0', '55000000-0000-0000-0000-000000000001', 'admin', true, null, 'Omar'),
  ('55000000-0000-0000-0000-0000000000a1', '55000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  -- Stale: each token below still says admin.
  ('55000000-0000-0000-0000-0000000000a2', '55000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Demoted'),
  ('55000000-0000-0000-0000-0000000000a3', '55000000-0000-0000-0000-000000000001', 'admin', false, null, 'Gone'),
  ('55000000-0000-0000-0000-0000000000a4', '55000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes', 'Locked'),
  ('55000000-0000-0000-0000-0000000000c1', '55000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('55000000-0000-0000-0000-0000000000e1', '55000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('55000000-0000-0000-0000-0000000000d1', '55000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('55000000-0000-0000-0000-0000000000f1', '55000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  ('55000000-0000-0000-0000-0000000000b1', '55000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Target'),
  ('55000000-0000-0000-0000-0000000000b2', '55000000-0000-0000-0000-000000000001', 'seo', true, null, 'Mover');

-- The owner, marked as the runbook marks it: one statement, as an operator.
update public.profiles set is_owner = true where id = '55000000-0000-0000-0000-0000000000a0';

-- Sessions and refresh tokens as GoTrue holds them: one session with a refresh token, and
-- one refresh token no session names (an older token), for each person whose access moves
-- below, and for two bystanders.
create function _give_sessions(p_user uuid, p_tag text) returns void language sql as $$
  insert into auth.sessions (id, user_id, created_at, updated_at)
  values (md5(p_user::text || p_tag)::uuid, p_user, now(), now());
  insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
  values ('00000000-0000-0000-0000-000000000000', 'u12-' || p_tag || '-a', p_user::text, false, now(), now(),
          md5(p_user::text || p_tag)::uuid),
         ('00000000-0000-0000-0000-000000000000', 'u12-' || p_tag || '-b', p_user::text, false, now(), now(), null);
$$;
-- How many sessions and refresh tokens a person still holds, as "sessions/tokens".
create function _held(p_user uuid) returns text language sql stable as $$
  select (select count(*) from auth.sessions where user_id = p_user)::text || '/'
      || (select count(*) from auth.refresh_tokens where user_id = p_user::text)::text
$$;
select _give_sessions('55000000-0000-0000-0000-0000000000b1', 'b1');
select _give_sessions('55000000-0000-0000-0000-0000000000b2', 'b2');
select _give_sessions('55000000-0000-0000-0000-0000000000c1', 'c1');
select _give_sessions('55000000-0000-0000-0000-0000000000e1', 'e1');
select _give_sessions('55000000-0000-0000-0000-0000000000a1', 'a1');

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

-- The T1 profiles the CURRENT role sees, by name.
create function _seen() returns text language sql stable as $$
  select coalesce(string_agg(display_name, ',' order by display_name), '')
    from public.profiles where tenant_id = '55000000-0000-0000-0000-000000000001'
$$;

-- The e-mails public.staff_accounts answers the CURRENT caller for a tenant.
create function _accounts(p_tenant uuid) returns text language sql as $$
  select coalesce(string_agg(email, ',' order by email), '') from public.staff_accounts(p_tenant)
$$;

-- T1's security row as the CURRENT role sees it.
create function _security() returns text language sql stable as $$
  select coalesce(string_agg(session_max_days::text || '/' || coalesce(invite_domain, '-') || '/v'
                             || version::text, ','), '')
    from public.admin_security_settings where tenant_id = '55000000-0000-0000-0000-000000000001'
$$;

grant execute on function _as(text, text, text), _rows(text), _seen(), _accounts(uuid), _security()
  to anon, authenticated, service_role;

-- ── 1. the catalog ───────────────────────────────────────────────────────────────
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'profiles'),
  'profiles_admin_write ALL PERMISSIVE {public}, '
  'profiles_auth_admin_read SELECT PERMISSIVE {supabase_auth_admin}, '
  'profiles_live_delete DELETE RESTRICTIVE {authenticated}, '
  'profiles_live_insert INSERT RESTRICTIVE {authenticated}, '
  'profiles_live_read SELECT RESTRICTIVE {authenticated}, '
  'profiles_live_update UPDATE RESTRICTIVE {authenticated}, '
  'profiles_self_select SELECT PERMISSIVE {public}',
  'profiles carries 0001''s and 0010''s policies, H10''s three live writes and the live read');
select ok(
  (select qual ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(\(id = \( SELECT auth\.uid\(\) AS uid\)\) OR (app\.)?role_manages_users\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)\)$'
          and with_check is null
     from pg_policies where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'profiles_live_read'),
  'profiles_live_read is the tenant predicate first, then your own row or a live Admin');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'admin_security_settings'),
  'admin_security_settings_insert INSERT PERMISSIVE {authenticated}, '
  'admin_security_settings_live ALL RESTRICTIVE {authenticated}, '
  'admin_security_settings_read SELECT PERMISSIVE {authenticated}, '
  'admin_security_settings_update UPDATE PERMISSIVE {authenticated}',
  'admin_security_settings: read, insert and update for an Admin, a RESTRICTIVE live check, no delete');
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class
    where oid = 'public.admin_security_settings'::regclass),
  'admin_security_settings is ENABLE + FORCE row level security');
select is(
  (select string_agg(tgname::text, ', ' order by tgname collate "C") from pg_trigger
    where tgrelid = 'public.profiles'::regclass and not tgisinternal),
  'profiles_display_name_rule, profiles_owner_guard, profiles_revoke_sessions, profiles_updated_at',
  'profiles carries the owner guard and the session revocation beside its two triggers');
select ok(
  (select f.prosecdef and f.proconfig = array['search_path=""']
     from pg_proc f where f.oid = 'app.tg_profiles_revoke_sessions()'::regprocedure)
  and (select not f.prosecdef from pg_proc f where f.oid = 'app.tg_profiles_owner_guard()'::regprocedure)
  and (select r.rolsuper or r.rolbypassrls from pg_proc f join pg_roles r on r.oid = f.proowner
        where f.oid = 'app.tg_profiles_revoke_sessions()'::regprocedure),
  'the revocation is a definer whose owner bypasses RLS; the guard runs as the writer');

-- ── 2. reading people is live ─────────────────────────────────────────────────────
set local role authenticated;
select _as('55000000-0000-0000-0000-0000000000a1', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Amal,Cyrus,Dana,Demoted,Eli,Gone,Locked,Mover,Omar,Target',
  'a live Admin reads every profile of the tenant (the users screen)');
select _as('55000000-0000-0000-0000-0000000000a2', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Demoted', 'a demoted Admin''s token reads its own row only');
select is(
  _rows($$ update public.profiles set role = 'admin' where id = auth.uid() $$),
  0, 'and still cannot promote itself back (the self re-promotion, H10)');
select _as('55000000-0000-0000-0000-0000000000a3', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Gone', 'a deactivated Admin''s token reads its own row only');
select is(
  _rows($$ update public.profiles set is_active = true where id = auth.uid() $$),
  0, 'and cannot switch itself back on');
select _as('55000000-0000-0000-0000-0000000000a4', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Locked', 'a locked Admin''s token reads its own row only');
select _as('55000000-0000-0000-0000-0000000000c1', 'content_creator', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Cyrus', 'content_creator reads its own row only');
select _as('55000000-0000-0000-0000-0000000000e1', 'seo', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Eli', 'seo reads its own row only');
select _as('55000000-0000-0000-0000-0000000000d1', 'developer', '55000000-0000-0000-0000-000000000001');
select is(_seen(), 'Dana', 'developer reads its own row only');
select _as('55000000-0000-0000-0000-0000000000f1', 'admin', '55000000-0000-0000-0000-0000000000ff');
select is(_seen(), '', 'another tenant''s Admin reads none of T1''s people');
reset role;
set local role anon;
select _as(null, null, null);
select throws_ok($$ select count(*) from public.profiles $$, '42501', null,
  'anon reads no profile (no grant)');
reset role;


-- ── 3. colleagues' e-mails: a live Admin of the named tenant only ─────────────────
set local role authenticated;
select _as('55000000-0000-0000-0000-0000000000a1', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'),
  'u12-admin@example.test,u12-creator@example.test,u12-demoted@example.test,u12-developer@example.test,'
  'u12-inactive@example.test,u12-locked@example.test,u12-mover@example.test,u12-owner@example.test,'
  'u12-seo@example.test,u12-target@example.test',
  'a live Admin reads every colleague''s e-mail in its tenant');
select is(
  (select string_agg(email || ':' || is_owner::text || ':' || (invited_at is not null)::text || ':'
                     || (email_confirmed_at is not null)::text || ':' || (last_sign_in_at is not null)::text,
                     ',' order by email)
     from public.staff_accounts('55000000-0000-0000-0000-000000000001')
    where is_owner or email_confirmed_at is null),
  'u12-owner@example.test:true:false:true:true,u12-target@example.test:false:true:false:false',
  'with the owner marked, and an invited account told apart by its times');
select is(_accounts('55000000-0000-0000-0000-0000000000ff'), '',
  'naming another tenant answers nothing');
select _as('55000000-0000-0000-0000-0000000000a2', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'a demoted Admin''s token reads none');
select _as('55000000-0000-0000-0000-0000000000a3', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'a deactivated Admin''s token reads none');
select _as('55000000-0000-0000-0000-0000000000a4', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'a locked Admin''s token reads none');
select _as('55000000-0000-0000-0000-0000000000c1', 'content_creator', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'content_creator reads none');
select _as('55000000-0000-0000-0000-0000000000e1', 'seo', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'seo reads none');
select _as('55000000-0000-0000-0000-0000000000d1', 'developer', '55000000-0000-0000-0000-000000000001');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'developer reads none');
select _as('55000000-0000-0000-0000-0000000000f1', 'admin', '55000000-0000-0000-0000-0000000000ff');
select is(_accounts('55000000-0000-0000-0000-000000000001'), '', 'another tenant''s Admin reads none of T1''s');
select is(_accounts('55000000-0000-0000-0000-0000000000ff'), 'u12-other-admin@example.test',
  'and reads its own tenant''s');
reset role;
set local role anon;
select throws_ok($$ select * from public.staff_accounts('55000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call staff_accounts');
reset role;
set local role service_role;
select throws_ok($$ select * from public.staff_accounts('55000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'nor can the service role (the Worker calls it as the Admin)');
reset role;

-- ── 4. the account owner ──────────────────────────────────────────────────────────
set local role authenticated;
select _as('55000000-0000-0000-0000-0000000000a1', 'admin', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ update public.profiles set role = 'seo' where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'a live Admin cannot demote the owner');
select throws_ok(
  $$ update public.profiles set is_active = false where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'nor switch the owner off');
select throws_ok(
  $$ update public.profiles set is_owner = true where id = '55000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'nor claim ownership (no grant on is_owner)');
select is(
  _rows($$ update public.profiles set display_name = 'Omar K' where id = '55000000-0000-0000-0000-0000000000a0' $$),
  1, 'but still renames the owner (protected, not frozen)');
reset role;
set local role service_role;
select throws_ok(
  $$ update public.profiles set role = 'developer' where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'the service role cannot demote the owner either');
select throws_ok(
  $$ update public.profiles set tenant_id = '55000000-0000-0000-0000-0000000000ff'
      where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'nor move the owner to another tenant');
select throws_ok(
  $$ delete from public.profiles where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'nor delete the owner''s profile');
select throws_ok(
  $$ update public.profiles set is_owner = false where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'nor clear the marker');
select throws_ok(
  $$ update public.profiles set is_owner = true where id = '55000000-0000-0000-0000-0000000000f1' $$,
  '42501', 'owner_protected', 'nor set it, even where the tenant has no owner');
select throws_ok(
  $$ insert into public.profiles (id, tenant_id, role, is_owner)
     values ('55000000-0000-0000-0000-0000000000b2', '55000000-0000-0000-0000-0000000000ff', 'admin', true) $$,
  '42501', 'owner_protected', 'nor create a profile that is an owner');
-- The sign-in's lockout (a definer over profiles) still locks the owner.
select is(
  public.register_failed_login('u12-owner@example.test', null, '15 minutes', 1, '15 minutes'),
  true, 'the lockout still counts the owner''s failed sign-in');
reset role;
select ok(
  (select locked_until > now() from public.profiles where id = '55000000-0000-0000-0000-0000000000a0'),
  'and locks the owner (the lockout columns stay writable)');
update public.profiles set locked_until = null, failed_login_count = 0
 where id = '55000000-0000-0000-0000-0000000000a0';
-- An operator: the owner's rules hold until the marker is cleared.
select throws_ok(
  $$ delete from auth.users where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'an operator cannot delete the owner''s account (its profile cascade is refused)');
select throws_ok(
  $$ update public.profiles set role = 'seo' where id = '55000000-0000-0000-0000-0000000000a0' $$,
  '42501', 'owner_protected', 'nor demote the owner without clearing the marker');
select throws_ok(
  $$ update public.profiles set is_owner = true where id = '55000000-0000-0000-0000-0000000000c1' $$,
  '42501', 'owner_protected', 'the owner is always an Admin');
select throws_ok(
  $$ update public.profiles set is_owner = true where id = '55000000-0000-0000-0000-0000000000a3' $$,
  '42501', 'owner_protected', 'and an active one');
select throws_ok(
  $$ update public.profiles set is_owner = true where id = '55000000-0000-0000-0000-0000000000a1' $$,
  '23505', null, 'one owner per tenant (profiles_one_owner)');

-- ── 5. handing ownership on ───────────────────────────────────────────────────────
set local role authenticated;
select _as('55000000-0000-0000-0000-0000000000a1', 'admin', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'an Admin who is not the owner cannot take ownership');
select _as('55000000-0000-0000-0000-0000000000a2', 'admin', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'nor can a stale Admin token');
select _as('55000000-0000-0000-0000-0000000000c1', 'content_creator', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'nor another role');
select _as('55000000-0000-0000-0000-0000000000a0', 'admin', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-0000000000ff', '55000000-0000-0000-0000-0000000000f1') $$,
  '42501', null, 'the owner cannot name another tenant');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a3') $$,
  '22023', null, 'nor hand it to a switched-off Admin');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a4') $$,
  '22023', null, 'nor to a locked Admin');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000c1') $$,
  '22023', null, 'nor to someone who is not an Admin');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000f1') $$,
  '22023', null, 'nor to another tenant''s Admin');
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a0') $$,
  '22023', null, 'nor to themselves');
select lives_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a1') $$,
  'the owner hands ownership to another active Admin');
reset role;
select is(
  (select string_agg(display_name, ',') from public.profiles
    where tenant_id = '55000000-0000-0000-0000-000000000001' and is_owner),
  'Amal', 'the new owner is the only owner');
select is(
  (select string_agg(actor_id::text || '/' || actor_role || '/' || entity_type || '/' || entity_id || '/'
                     || (detail ->> 'to') || '/' || (hash <> '')::text, ',')
     from public.audit_log
    where tenant_id = '55000000-0000-0000-0000-000000000001' and action = 'user.ownership_transfer'),
  '55000000-0000-0000-0000-0000000000a0/admin/profile/55000000-0000-0000-0000-0000000000a1/'
  '55000000-0000-0000-0000-0000000000a1/true',
  'one audit row, chained, naming the old owner as actor and the new one as the entity');
set local role anon;
select throws_ok(
  $$ select public.transfer_ownership('55000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'anon cannot call transfer_ownership');
reset role;

-- ── 6. a role, activity or tenant change ends every session ───────────────────────
set local role authenticated;
select _as('55000000-0000-0000-0000-0000000000a2', 'admin', '55000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set role = 'developer' where id = '55000000-0000-0000-0000-0000000000c1' $$),
  0, 'a stale Admin token''s role change is refused');
select _as('55000000-0000-0000-0000-0000000000a1', 'admin', '55000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set display_name = 'Cyrus Q' where id = '55000000-0000-0000-0000-0000000000c1' $$),
  1, 'a live Admin renames a colleague');
select is(
  _rows($$ update public.profiles set role = 'seo' where id = '55000000-0000-0000-0000-0000000000b1' $$),
  1, 'and changes another''s role');
reset role;
select is(_held('55000000-0000-0000-0000-0000000000b1'), '0/0',
  'the role change deleted every session and refresh token of that person');
select is(_held('55000000-0000-0000-0000-0000000000c1'), '1/2',
  'a rename and a refused write deleted none of the colleague''s');
set local role service_role;
select is(
  _rows($$ update public.profiles set locked_until = now() + interval '1 minute'
           where id = '55000000-0000-0000-0000-0000000000a1' $$),
  1, 'the service role locks an account (the lockout)');
select is(
  _rows($$ update public.profiles set is_active = false where id = '55000000-0000-0000-0000-0000000000e1' $$),
  1, 'and switches one off');
reset role;
select is(_held('55000000-0000-0000-0000-0000000000a1') || ' ' || _held('55000000-0000-0000-0000-0000000000e1'),
  '1/2 0/0', 'a lock deletes no session; switching off deletes every one');
update public.profiles set locked_until = null where id = '55000000-0000-0000-0000-0000000000a1';
update public.profiles set tenant_id = '55000000-0000-0000-0000-0000000000ff'
 where id = '55000000-0000-0000-0000-0000000000b2';
select is(_held('55000000-0000-0000-0000-0000000000b2'), '0/0',
  'an operator''s move to another tenant deletes every session too');

-- ── 7. the Security card's settings ───────────────────────────────────────────────
set local role authenticated;
select _as('55000000-0000-0000-0000-0000000000c1', 'content_creator', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.admin_security_settings (tenant_id, session_max_days)
     values ('55000000-0000-0000-0000-000000000001', 1) $$,
  '42501', null, 'content_creator cannot create the settings');
select _as('55000000-0000-0000-0000-0000000000f1', 'admin', '55000000-0000-0000-0000-0000000000ff');
select throws_ok(
  $$ insert into public.admin_security_settings (tenant_id, session_max_days)
     values ('55000000-0000-0000-0000-000000000001', 1) $$,
  '42501', null, 'nor can another tenant''s Admin create T1''s');
select _as('55000000-0000-0000-0000-0000000000a2', 'admin', '55000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.admin_security_settings (tenant_id, session_max_days)
     values ('55000000-0000-0000-0000-000000000001', 1) $$,
  '42501', null, 'nor can a stale Admin token (the RESTRICTIVE live check)');
select _as('55000000-0000-0000-0000-0000000000a1', 'admin', '55000000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.admin_security_settings (tenant_id, session_max_days, invite_domain)
     values ('55000000-0000-0000-0000-000000000001', 1, 'example.com') $$,
  'a live Admin creates them');
select is(_security(), '1/example.com/v1', 'and reads them back');
select is(
  _rows($$ update public.admin_security_settings set session_max_days = 7
           where tenant_id = '55000000-0000-0000-0000-000000000001' $$),
  1, 'and changes them');
select is(_security(), '7/example.com/v2', 'the version moves with each change');
select throws_ok(
  $$ update public.admin_security_settings set session_max_days = 3
      where tenant_id = '55000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'a session length other than 1 or 7 days is refused');
select throws_ok(
  $$ update public.admin_security_settings set invite_domain = 'Example.com'
      where tenant_id = '55000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'a domain with capitals is refused (the Worker lower-cases it)');
select throws_ok(
  $$ update public.admin_security_settings set invite_domain = 'localhost'
      where tenant_id = '55000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'a name with no dot is refused');
select throws_ok(
  $$ update public.admin_security_settings set invite_domain = 'team@example.com'
      where tenant_id = '55000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'an address is refused (a domain only)');
select throws_ok(
  $$ update public.admin_security_settings set version = 9
      where tenant_id = '55000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'staff cannot write the version (no column grant)');
select throws_ok(
  $$ delete from public.admin_security_settings where tenant_id = '55000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'nor delete the row (no grant)');
select _as('55000000-0000-0000-0000-0000000000a2', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_security() || '/' || _rows($$ update public.admin_security_settings set session_max_days = 1 $$)::text,
  '/0', 'a demoted Admin''s token reads and changes nothing');
select _as('55000000-0000-0000-0000-0000000000a3', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_security() || '/' || _rows($$ update public.admin_security_settings set session_max_days = 1 $$)::text,
  '/0', 'nor a deactivated one''s');
select _as('55000000-0000-0000-0000-0000000000a4', 'admin', '55000000-0000-0000-0000-000000000001');
select is(_security() || '/' || _rows($$ update public.admin_security_settings set session_max_days = 1 $$)::text,
  '/0', 'nor a locked one''s');
select _as('55000000-0000-0000-0000-0000000000c1', 'content_creator', '55000000-0000-0000-0000-000000000001');
select is(_security() || '/' || _rows($$ update public.admin_security_settings set session_max_days = 1 $$)::text,
  '/0', 'content_creator reads and changes nothing');
select _as('55000000-0000-0000-0000-0000000000e1', 'seo', '55000000-0000-0000-0000-000000000001');
select is(_security(), '', 'seo reads nothing');
select _as('55000000-0000-0000-0000-0000000000d1', 'developer', '55000000-0000-0000-0000-000000000001');
select is(_security() || '/' || _rows($$ update public.admin_security_settings set session_max_days = 1 $$)::text,
  '/0', 'developer reads and changes nothing');
select _as('55000000-0000-0000-0000-0000000000f1', 'admin', '55000000-0000-0000-0000-0000000000ff');
select is(_security() || '/' || _rows($$ update public.admin_security_settings set session_max_days = 1 $$)::text,
  '/0', 'another tenant''s Admin reads and changes nothing of T1''s');
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.admin_security_settings $$, '42501', null,
  'anon reads nothing (no grant)');
reset role;
set local role service_role;
select is(_security(), '7/example.com/v2', 'the service role reads the row (the session check)');
reset role;
select is(
  (select (updated_by = '55000000-0000-0000-0000-0000000000a1' and created_by = '55000000-0000-0000-0000-0000000000a1')::text
     from public.admin_security_settings where tenant_id = '55000000-0000-0000-0000-000000000001'),
  'true', 'the row names who created and last changed it');

-- ── 8. grants (P-14: what must and must not be held, both regimes) ─────────────────
select is(
  (select coalesce(string_agg(format('%s %s', r, p), ', ' order by r, p), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r
     cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p
    where has_table_privilege(r, 'public.admin_security_settings', p)),
  'authenticated select, service_role select',
  'admin_security_settings at table level: SELECT for staff and the service role, nothing else');
select is(
  (select coalesce(string_agg(format('%s %s.%s', r, p, a.attname), ', ' order by r, p, a.attname), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r
     cross join unnest(array['insert', 'update', 'references']) as p
     cross join pg_attribute a
    where a.attrelid = 'public.admin_security_settings'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege(r, 'public.admin_security_settings', a.attname::text, p)),
  'authenticated insert.invite_domain, authenticated insert.require_mfa, '
  'authenticated insert.session_max_days, authenticated insert.tenant_id, '
  'authenticated update.invite_domain, authenticated update.require_mfa, '
  'authenticated update.session_max_days',
  'at column level staff insert the key and the three settings (U17, 0072: require_mfa) and update the three settings, nothing more');
select is(
  (select coalesce(string_agg(a.attname::text, ', ' order by a.attname), '')
     from pg_attribute a
    where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.profiles', a.attname::text, 'update')),
  'display_name, is_active, role',
  'staff still update only role, is_active and display_name on profiles: never is_owner');

select * from finish();
rollback;
