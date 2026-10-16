-- pgTAP: a stale Admin token changes no one, and an audit row names who wrote it (0050,
-- hotfix H10). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus the
-- three stale Admin tokens the live check exists for: one whose profile was demoted to
-- content_creator, one deactivated and one locked, each still carrying an `admin` claim
-- (CLAUDE.md §9 (b)).
--   • profiles: no stale token changes any profile's role, activity or name, its own
--     included (the self re-promotion this hotfix closes), and nothing it tried stuck; with
--     INSERT and DELETE granted for a moment, the stale token still inserts and deletes
--     nothing while a live Admin's deletes (the policies, not only the missing grants); a
--     live Admin still changes colleagues (the users screen); another tenant's Admin, the
--     other staff roles and anon change nothing; renaming yourself still works through
--     update_my_profile, which the stale tokens cannot use either; the policy set is exactly
--     0001's, 0010's, 0050's three RESTRICTIVE ones and 0055's live read (whose rows are
--     proven in users_security.test.sql).
--   • audit_log: a staff token's row is stored as the caller, the token's role and now(),
--     whatever it sent (a forged actor, role and date included); a stale token's row names
--     the stale account and the role its token carries; another tenant and anon cannot
--     insert; the service role keeps the actor it names, its time bound; an operator keeps
--     everything it writes; a definer (update_my_profile) names its caller; the chain still
--     links every row in id order, and each hash is over the stored, bound values, so the
--     binding ran before the chain; the two triggers fire in that order.
--   • grants: staff keep only the users screen's three profile columns; on audit_log staff
--     and the service role hold SELECT and INSERT, so the service role cannot TRUNCATE it,
--     and nobody may setval its id sequence.

begin;
select plan(54);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('50000000-0000-0000-0000-000000000001', 'T1'),
  ('50000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('50000000-0000-0000-0000-0000000000a1', 'h10-admin@example.test'),
  ('50000000-0000-0000-0000-0000000000a2', 'h10-demoted@example.test'),
  ('50000000-0000-0000-0000-0000000000a3', 'h10-inactive@example.test'),
  ('50000000-0000-0000-0000-0000000000a4', 'h10-locked@example.test'),
  ('50000000-0000-0000-0000-0000000000c1', 'h10-creator@example.test'),
  ('50000000-0000-0000-0000-0000000000e1', 'h10-seo@example.test'),
  ('50000000-0000-0000-0000-0000000000d1', 'h10-developer@example.test'),
  ('50000000-0000-0000-0000-0000000000f1', 'h10-other-admin@example.test'),
  ('50000000-0000-0000-0000-0000000000b1', 'h10-target@example.test'),
  ('50000000-0000-0000-0000-0000000000b2', 'h10-other-target@example.test'),
  ('50000000-0000-0000-0000-0000000000b3', 'h10-throwaway@example.test'),
  ('50000000-0000-0000-0000-0000000000b4', 'h10-uninvited@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('50000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  -- Stale: each token below still says admin.
  ('50000000-0000-0000-0000-0000000000a2', '50000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Demoted'),
  ('50000000-0000-0000-0000-0000000000a3', '50000000-0000-0000-0000-000000000001', 'admin', false, null, 'Gone'),
  ('50000000-0000-0000-0000-0000000000a4', '50000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes', 'Locked'),
  ('50000000-0000-0000-0000-0000000000c1', '50000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('50000000-0000-0000-0000-0000000000e1', '50000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('50000000-0000-0000-0000-0000000000d1', '50000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('50000000-0000-0000-0000-0000000000f1', '50000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  -- The colleague every write below aims at, and one in the other tenant.
  ('50000000-0000-0000-0000-0000000000b1', '50000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Target'),
  ('50000000-0000-0000-0000-0000000000b2', '50000000-0000-0000-0000-0000000000ff', 'content_creator', true, null, 'Other'),
  -- Deleted by the live Admin in the temporary-grant check below.
  ('50000000-0000-0000-0000-0000000000b3', '50000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Throwaway');

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

-- A profile as one string: role, active flag, name.
create function _who(p_id uuid) returns text language sql stable as $$
  select role::text || '/' || is_active::text || '/' || coalesce(display_name, '')
    from public.profiles where id = p_id
$$;

grant execute on function _as(text, text, text), _rows(text) to anon, authenticated, service_role;

-- ── 1. the helper and the catalog ───────────────────────────────────────────────
select ok(
  app.role_manages_users('admin')
    and not app.role_manages_users('content_creator') and not app.role_manages_users('seo')
    and not app.role_manages_users('developer') and not app.role_manages_users('anon')
    and not app.role_manages_users(null),
  'app.role_manages_users is users.manage: Admin alone');
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
  'profiles carries exactly its three earlier policies, the three RESTRICTIVE live writes and 0055''s live read');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and permissive = 'RESTRICTIVE'
      and coalesce(qual, with_check) ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_manages_users\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$'
      and coalesce(with_check, qual) = coalesce(qual, with_check)),
  3,
  'each live policy is the tenant predicate first, then users.manage on the live role, on every side it has');

-- ── 2. stale Admin tokens change no one ──────────────────────────────────────────
set local role authenticated;

-- Demoted to content_creator; the token still says admin.
select _as('50000000-0000-0000-0000-0000000000a2', 'admin', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set role = 'admin' where id = '50000000-0000-0000-0000-0000000000a2' $$),
  0, 'a demoted Admin''s token cannot promote itself back (the self re-promotion)');
select is(
  _rows($$ update public.profiles set role = 'seo', is_active = false
            where id = '50000000-0000-0000-0000-0000000000b1' $$),
  0, 'nor change a colleague''s role or activity');
select is(
  _rows($$ update public.profiles set display_name = 'Renamed'
            where tenant_id = '50000000-0000-0000-0000-000000000001' $$),
  0, 'nor rename anyone in the tenant');
select throws_ok(
  $$ select public.update_my_profile('50000000-0000-0000-0000-000000000001', 'Still here') $$,
  '42501', null, 'nor rename itself through update_my_profile');

-- Deactivated; the token still says admin.
select _as('50000000-0000-0000-0000-0000000000a3', 'admin', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set is_active = true where id = '50000000-0000-0000-0000-0000000000a3' $$),
  0, 'a deactivated Admin''s token cannot reactivate itself');
select is(
  _rows($$ update public.profiles set role = 'developer' where id = '50000000-0000-0000-0000-0000000000b1' $$),
  0, 'nor change a colleague''s role');
select is(
  _rows($$ update public.profiles set is_active = false where id = '50000000-0000-0000-0000-0000000000a1' $$),
  0, 'nor switch off the Admin who switched it off');

-- Locked; the token still says admin.
select _as('50000000-0000-0000-0000-0000000000a4', 'admin', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set is_active = false where id = '50000000-0000-0000-0000-0000000000b1' $$),
  0, 'a locked Admin''s token cannot switch a colleague off');
select is(
  _rows($$ update public.profiles set role = 'seo' where id = '50000000-0000-0000-0000-0000000000a1' $$),
  0, 'nor demote the live Admin');
select is(
  _rows($$ update public.profiles set display_name = 'Free' where id = '50000000-0000-0000-0000-0000000000a4' $$),
  0, 'nor rename itself');
select throws_ok(
  $$ delete from public.profiles where id = '50000000-0000-0000-0000-0000000000b1' $$,
  '42501', null, 'and no staff token deletes a profile: the GRANT layer refuses first (no DELETE grant)');

-- The second layer on its own: with INSERT and DELETE granted to staff for the moment
-- (withdrawn again below), the stale token still inserts and deletes nothing, while a live
-- Admin's token, through the same grant, does.
reset role;
grant insert, delete on public.profiles to authenticated;
set local role authenticated;
select _as('50000000-0000-0000-0000-0000000000a2', 'admin', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ delete from public.profiles where id = '50000000-0000-0000-0000-0000000000b3' $$),
  0, 'with DELETE granted, a stale Admin token still deletes no profile (profiles_live_delete)');
select throws_ok(
  $$ insert into public.profiles (id, tenant_id, role)
     values ('50000000-0000-0000-0000-0000000000b4', '50000000-0000-0000-0000-000000000001', 'admin') $$,
  '42501', null, 'with INSERT granted, nor inserts one (profiles_live_insert)');
select _as('50000000-0000-0000-0000-0000000000a1', 'admin', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ delete from public.profiles where id = '50000000-0000-0000-0000-0000000000b3' $$),
  1, 'while a live Admin''s token, through the same grant, does: the policies narrow, they do not shut');
reset role;
revoke insert, delete on public.profiles from authenticated;
set local role authenticated;

reset role;
select is(
  (select string_agg(_who(id), ', ' order by id) from public.profiles
    where id in ('50000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a2',
                 '50000000-0000-0000-0000-0000000000a3', '50000000-0000-0000-0000-0000000000a4',
                 '50000000-0000-0000-0000-0000000000b1')),
  'admin/true/Amal, content_creator/true/Demoted, admin/false/Gone, admin/true/Locked, content_creator/true/Target',
  'nothing a stale token tried stuck');
set local role authenticated;

-- ── 3. a live Admin still runs the users screen ───────────────────────────────────
select _as('50000000-0000-0000-0000-0000000000a1', 'admin', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set role = 'seo', is_active = false, display_name = 'Renamed'
            where tenant_id = '50000000-0000-0000-0000-000000000001'
              and id = '50000000-0000-0000-0000-0000000000b1' $$),
  1, 'a live Admin changes a colleague''s role, activity and name');
select is(
  _rows($$ update public.profiles set is_active = true where id = '50000000-0000-0000-0000-0000000000a3' $$),
  1, 'and reactivates a colleague');
select is(
  _rows($$ update public.profiles set display_name = 'Elsewhere' where id = '50000000-0000-0000-0000-0000000000b2' $$),
  0, 'but changes no one in another tenant');
reset role;
select is(_who('50000000-0000-0000-0000-0000000000b1') || ', ' || _who('50000000-0000-0000-0000-0000000000a3'),
  'seo/false/Renamed, admin/true/Gone', 'the live Admin''s changes are stored');
set local role authenticated;

-- ── 4. everyone else ──────────────────────────────────────────────────────────────
select _as('50000000-0000-0000-0000-0000000000f1', 'admin', '50000000-0000-0000-0000-0000000000ff');
select is(
  _rows($$ update public.profiles set role = 'admin', is_active = true
            where id = '50000000-0000-0000-0000-0000000000b1' $$),
  0, 'other_tenant: another tenant''s live Admin changes no T1 profile');
select is(
  _rows($$ update public.profiles set display_name = 'Other 2' where id = '50000000-0000-0000-0000-0000000000b2' $$),
  1, 'other_tenant: while it still runs its own tenant''s users');
select _as('50000000-0000-0000-0000-0000000000c1', 'content_creator', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set role = 'admin' where id = '50000000-0000-0000-0000-0000000000c1' $$),
  0, 'content_creator changes no profile, its own role included');
select _as('50000000-0000-0000-0000-0000000000e1', 'seo', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set is_active = true where id = '50000000-0000-0000-0000-0000000000b1' $$),
  0, 'seo changes no profile');
select _as('50000000-0000-0000-0000-0000000000d1', 'developer', '50000000-0000-0000-0000-000000000001');
select is(
  _rows($$ update public.profiles set role = 'admin' where id = '50000000-0000-0000-0000-0000000000d1' $$),
  0, 'developer changes no profile, its own role included');

-- Renaming yourself does not ride on the users screen's grant: the definer still works for
-- a live member who may not write profiles at all.
select _as('50000000-0000-0000-0000-0000000000c1', 'content_creator', '50000000-0000-0000-0000-000000000001');
select is(public.update_my_profile('50000000-0000-0000-0000-000000000001', 'Cyrus Q'), 'Cyrus Q',
  'content_creator still renames itself through update_my_profile');

reset role;
select _as(null, null, null);
set local role anon;
select throws_ok(
  $$ update public.profiles set role = 'admin' where id = '50000000-0000-0000-0000-0000000000b1' $$,
  '42501', null, 'anon cannot write profiles');
reset role;
select is(_who('50000000-0000-0000-0000-0000000000b1') || ', ' || _who('50000000-0000-0000-0000-0000000000c1')
          || ', ' || _who('50000000-0000-0000-0000-0000000000d1') || ', ' || _who('50000000-0000-0000-0000-0000000000b2'),
  'seo/false/Renamed, content_creator/true/Cyrus Q, developer/true/Dana, content_creator/true/Other 2',
  'only the live Admins'' changes and the self rename are stored');

-- ── 5. an audit row names who wrote it ─────────────────────────────────────────────
set local role authenticated;
select _as('50000000-0000-0000-0000-0000000000c1', 'content_creator', '50000000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail, created_at)
     values ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000a1', 'admin',
             'h10.forged', 'profile', '50000000-0000-0000-0000-0000000000b1', '{"fields": ["role"]}',
             '2020-01-01 00:00:00+00') $$,
  'a staff token may still insert an audit row');
select lives_ok(
  $$ insert into public.audit_log (tenant_id, action, detail)
     values ('50000000-0000-0000-0000-000000000001', 'h10.unnamed', '{}') $$,
  'and one that names no actor');

-- Stale: the demoted account, its token still admin.
select _as('50000000-0000-0000-0000-0000000000a2', 'admin', '50000000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.audit_log (tenant_id, actor_id, actor_role, action, detail)
     values ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000d1', 'developer',
             'h10.stale', '{}') $$,
  'a stale token''s insert is let through (the Worker refuses stale sessions; the row is still bound)');

select _as('50000000-0000-0000-0000-0000000000f1', 'admin', '50000000-0000-0000-0000-0000000000ff');
select throws_ok(
  $$ insert into public.audit_log (tenant_id, actor_id, actor_role, action, detail)
     values ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000f1', 'admin',
             'h10.cross_tenant', '{}') $$,
  '42501', null, 'other_tenant cannot write into T1''s log');

reset role;
select _as(null, null, null);
set local role anon;
select throws_ok(
  $$ insert into public.audit_log (tenant_id, actor_id, actor_role, action, detail)
     values ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000a1', 'admin',
             'h10.anon', '{}') $$,
  '42501', null, 'anon cannot write the log');

-- The service role: the Worker's server-side rows (a password reset names the account).
reset role;
set local role service_role;
select lives_ok(
  $$ insert into public.audit_log (tenant_id, actor_id, actor_role, action, detail, created_at)
     values ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000a1', 'admin',
             'h10.service', '{}', '2020-01-01 00:00:00+00') $$,
  'the service role inserts a row naming the account it is about');

-- An operator (the migration role, as a runbook statement runs).
reset role;
insert into public.audit_log (tenant_id, actor_id, actor_role, action, detail, created_at)
values ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000d1', 'developer',
        'h10.operator', '{}', '2020-01-01 00:00:00+00');

select is(
  (select actor_id::text || '/' || actor_role from public.audit_log where action = 'h10.forged'),
  '50000000-0000-0000-0000-0000000000c1/content_creator',
  'a staff token''s forged actor and role are replaced by the caller and its token''s role');
select ok(
  (select created_at = now() from public.audit_log where action = 'h10.forged'),
  'and its backdated time by now()');
select is(
  (select entity_type || '/' || entity_id || '/' || detail::text from public.audit_log where action = 'h10.forged'),
  'profile/50000000-0000-0000-0000-0000000000b1/{"fields": ["role"]}',
  'what the row says happened is kept as written');
select is(
  (select actor_id::text || '/' || actor_role from public.audit_log where action = 'h10.unnamed'),
  '50000000-0000-0000-0000-0000000000c1/content_creator',
  'a row that names no actor is filled in with the caller');
select is(
  (select actor_id::text || '/' || actor_role from public.audit_log where action = 'h10.stale'),
  '50000000-0000-0000-0000-0000000000a2/admin',
  'a stale token''s row names the stale account and the role its token carries, not the one it named');
select is(
  (select count(*)::int from public.audit_log where action in ('h10.cross_tenant', 'h10.anon')),
  0, 'the refused inserts wrote nothing');
select is(
  (select actor_id::text || '/' || actor_role from public.audit_log where action = 'h10.service'),
  '50000000-0000-0000-0000-0000000000a1/admin',
  'the service role keeps the actor and role it names');
select ok(
  (select created_at = now() from public.audit_log where action = 'h10.service'),
  'with the database''s time, not the one it sent');
select is(
  (select actor_id::text || '/' || actor_role || '/'
          || (created_at = '2020-01-01 00:00:00+00'::timestamptz)::text
     from public.audit_log where action = 'h10.operator'),
  '50000000-0000-0000-0000-0000000000d1/developer/true',
  'an operator''s row is kept exactly as written');
-- update_my_profile (section 4) audits from inside a definer, which keeps what it writes.
select is(
  (select string_agg(actor_id::text || '/' || actor_role, ', ' order by id) from public.audit_log
    where action = 'profile.update' and tenant_id = '50000000-0000-0000-0000-000000000001'),
  '50000000-0000-0000-0000-0000000000c1/content_creator',
  'a definer''s row (update_my_profile) still names its caller');

-- ── 6. the chain ───────────────────────────────────────────────────────────────────
select ok(
  (select count(*) = 6
          and bool_and(a.hash ~ '^[0-9a-f]{64}$')
          and bool_and(a.prev_hash is not distinct from (
                select b.hash from public.audit_log b
                 where b.tenant_id = a.tenant_id and b.id < a.id
                 order by b.id desc limit 1))
     from public.audit_log a
    where a.tenant_id = '50000000-0000-0000-0000-000000000001'),
  'every T1 row, bound or kept, is chained to the one before it in id order');
-- Recomputed from the STORED values with the chain's key and payload (0002, 0031): equal only
-- if the chain hashed the row after the binding, i.e. audit_log_actor fired first.
select ok(
  (select bool_and(a.hash = encode(extensions.hmac(
            coalesce(a.prev_hash, '') || '|' || a.tenant_id::text || '|' || coalesce(a.actor_id::text, '')
              || '|' || coalesce(a.actor_role, '') || '|' || a.action || '|' || coalesce(a.entity_type, '')
              || '|' || coalesce(a.entity_id, '') || '|' || a.detail::text || '|' || a.created_at::text,
            k.decrypted_secret, 'sha256'), 'hex'))
     from public.audit_log a
     cross join (select decrypted_secret from vault.decrypted_secrets where name = 'audit_hmac_key') k
    where a.tenant_id = '50000000-0000-0000-0000-000000000001'
      and a.action in ('h10.forged', 'h10.unnamed', 'h10.stale', 'h10.service')),
  'each bound row''s hash is over the values stored, so the chain hashed them after the binding');
select is(
  (select string_agg(t.tgname::text, ',' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.audit_log'::regclass and not t.tgisinternal
      and t.tgtype = 7 and t.tgenabled::text = 'O'),
  'audit_log_actor,audit_log_chain',
  'audit_log has two BEFORE INSERT row triggers, the binding sorting (and firing) first');
select ok(
  (select not p.prosecdef
          and not has_function_privilege('authenticated', p.oid, 'execute')
          and not has_function_privilege('service_role', p.oid, 'execute')
          and not has_function_privilege('anon', p.oid, 'execute')
     from pg_proc p where p.oid = 'app.tg_audit_actor()'::regprocedure),
  'the binding runs as the writer (SECURITY INVOKER) and no API role calls it');

-- ── 7. grants are as 0037 left them ────────────────────────────────────────────────
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'insert')
    and not has_table_privilege('authenticated', 'public.profiles', 'update')
    and not has_table_privilege('authenticated', 'public.profiles', 'delete')
    and has_column_privilege('authenticated', 'public.profiles', 'role', 'update')
    and has_column_privilege('authenticated', 'public.profiles', 'is_active', 'update')
    and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update')
    and not has_column_privilege('authenticated', 'public.profiles', 'tenant_id', 'update')
    and not has_column_privilege('authenticated', 'public.profiles', 'locked_until', 'update'),
  'staff still hold only the users screen''s UPDATE on role, is_active and display_name');
select ok(
  not has_table_privilege('authenticated', 'public.audit_log', 'update')
    and not has_table_privilege('authenticated', 'public.audit_log', 'delete')
    and not has_table_privilege('authenticated', 'public.audit_log', 'truncate')
    and not has_table_privilege('service_role', 'public.audit_log', 'update')
    and not has_table_privilege('service_role', 'public.audit_log', 'delete')
    and not has_table_privilege('service_role', 'public.audit_log', 'truncate')
    and not has_table_privilege('anon', 'public.audit_log', 'insert')
    and has_table_privilege('authenticated', 'public.audit_log', 'select')
    and has_table_privilege('authenticated', 'public.audit_log', 'insert')
    and has_table_privilege('service_role', 'public.audit_log', 'insert'),
  'staff and the service role read and insert audit rows, and no API role may UPDATE, DELETE or TRUNCATE one');
reset role;
set local role service_role;
select throws_ok($$ truncate public.audit_log $$, '42501', null,
  'the service role cannot empty the log (TRUNCATE sees no policy and no row trigger)');
reset role;
select ok(
  not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.audit_log', 'id'), 'update')
    and not has_sequence_privilege('service_role', pg_get_serial_sequence('public.audit_log', 'id'), 'update')
    and has_sequence_privilege('authenticated', pg_get_serial_sequence('public.audit_log', 'id'), 'usage'),
  'the id sequence: staff draw from it, nobody may setval it');

select _as(null, null, null);
select * from finish();
rollback;
