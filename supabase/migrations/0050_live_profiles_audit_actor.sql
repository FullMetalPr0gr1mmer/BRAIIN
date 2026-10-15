-- ─────────────────────────────────────────────────────────────────────────────
-- 0050 — A stale Admin token changes no one, and an audit row names who wrote it (hotfix
-- H10). Forward-only, expand only. Depends on 0001 (profiles, profiles_admin_write,
-- app.current_role), 0002 (audit_log, audit_insert, audit_log_chain), 0013 (app.current_role's
-- grants), 0031 (the chain trigger, serialized), 0033 (app.live_role), 0037 (profiles' column
-- grant) and 0044 (public.update_my_profile).
--
-- Two live defects, found while planning the users screen (U12) and the activity log (U13):
--
--   1. A STALE ADMIN TOKEN CAN RE-PROMOTE ITSELF. RLS reads the role from the JWT, and an
--      access token lives up to an hour. profiles_admin_write (0001, FOR ALL) admits any
--      token whose claim says admin, and 0037 grants `authenticated` UPDATE on
--      profiles.role, is_active and display_name (the users screen's write). So an Admin
--      who has just been demoted, deactivated or locked can, until the token expires,
--      PATCH /rest/v1/profiles directly: set their own role back to admin, their own
--      is_active back to true, or change anyone else in the tenant. The access-token hook
--      (0010) stamps the role from the profile at the next refresh, so a self re-promotion
--      outlives the token. No audit row is written on that path.
--   2. AN AUDIT ROW CAN NAME SOMEONE ELSE. audit_insert (0002) lets any staff token insert
--      into audit_log with whatever actor_id, actor_role and created_at it sends, and the
--      chain trigger hashes those values like any others: a forged row naming a colleague,
--      backdated, is chained and verifies.
--
-- THE FIX
--   • app.role_manages_users(r): one helper for users.manage (CLAUDE.md §8, held equal to
--     ROLE_CAPS by tests/authz/sqlHelpers.spec.ts). U12a reuses it.
--   • Three RESTRICTIVE policies on profiles, TO authenticated, one per write command
--     (profiles_live_update, profiles_live_insert, profiles_live_delete): the tenant
--     predicate first, then app.role_manages_users((select app.live_role())). The live
--     role is the profile's role read at query time, and null unless the profile is
--     active, unlocked, in the token's tenant and agrees with the token's role (0033), so
--     a demoted, deactivated or locked Admin's token updates no profile, its own included.
--     The JWT layer (profiles_admin_write) is unchanged and still opens the door; the live
--     one must hold it open. INSERT and DELETE have no staff grant (0037); their policies
--     are the second layer, so a grant added by mistake is not enough on its own. SELECT is
--     untouched here: reading colleagues' rows behind a live check is U12a's, with the
--     Worker's claim comparison and the session revocation.
--     Not affected: renaming yourself (public.update_my_profile, 0044, a SECURITY DEFINER
--     that runs as its owner, so these TO authenticated policies do not apply to it; it
--     makes its own live check), the sign-in's lockout RPCs (definers), the access-token
--     hook (supabase_auth_admin, SELECT only), the invite (service role), and the users
--     screen for a live Admin (its PATCH writes through the Admin's session, so the live
--     check applies to it as well; liveRecheck refuses a stale Admin before it gets there).
--     The policies' live_role() call reads profiles from inside a definer, under SELECT
--     policies only, so no policy here can recurse.
--   • app.tg_audit_actor() and the trigger audit_log_actor (BEFORE INSERT FOR EACH ROW).
--     For an insert made by a staff token directly (current_user is `authenticated`, or
--     `anon`, which holds no INSERT anyway) it sets actor_id := auth.uid() and actor_role :=
--     the token's role (app.current_role()); for those and the service role it sets
--     created_at := now(). The service role (the Worker's server-side writes: a password
--     reset's row names the account it is about), a SECURITY DEFINER function (running as
--     its owner: update_my_profile names its caller itself) and an operator keep the actor
--     they write.
--       - Bound, not refused. A correct caller already sends these values (writeAudit uses
--         the session's user and role), so binding never fails one; a refusal would turn
--         an audit write into a failed operation on the fail-closed paths whenever the
--         Worker's view of the role and the token's differ (the minutes after a role
--         change), and a forger would leave no trace. Bound, the attempt itself is chained
--         under the account that made it.
--       - The token's role, not the profile's: it is what RLS let through, and the only
--         role the database can attest for this statement.
--       - Keyed on current_user, not on the presence of JWT claims: a definer still sees
--         the caller's claims, and the service role's requests carry claims too.
--       - SECURITY INVOKER, so current_user is the writer; an empty search_path with every
--         name qualified.
--       - Before the chain: Postgres fires the BEFORE triggers of one event in name order,
--         and audit_log_actor sorts before audit_log_chain, so the chain hashes the bound
--         values. The chain trigger, its lock, its id under the lock and its READ COMMITTED
--         rule (0031) are untouched.
--   • audit_log's grants, stated (section 4): SELECT and INSERT for staff and the service
--     role, nothing else for any API role. 0002 revoked UPDATE and DELETE but left the rest
--     of Supabase's default ALL, TRUNCATE included, which no policy or row trigger sees.
--   • MAINTAIN on profiles withdrawn from the API roles (PostgreSQL 17), which 0037 missed.
--
-- Production as of 2026-10-15: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046
-- and 0048. Grants are stated for both Supabase privilege regimes (README P-14). CLAUDE.md §3
-- (Pillar 1), §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0048). The policies take an
-- ACCESS EXCLUSIVE lock on public.profiles, which every admin request and every sign-in
-- reads, and the trigger a SHARE ROW EXCLUSIVE lock on public.audit_log, which every audited
-- action writes. A statement below that waits more than five seconds for a lock raises
-- instead, the whole migration rolls back, and the push is retried later.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. One helper for users.manage ------------------------------------------------------
-- `language sql immutable`, so the planner inlines it (as app.role_works_leads, 0033).
create or replace function app.role_manages_users(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- users.manage
revoke all on function app.role_manages_users(text) from public, anon, authenticated, service_role;
grant execute on function app.role_manages_users(text) to authenticated, service_role;

-- ---- 2. The live check on every staff write to profiles -----------------------------------
-- RESTRICTIVE: ANDed with profiles_admin_write, so it can only narrow.
drop policy if exists profiles_live_update on public.profiles;
create policy profiles_live_update on public.profiles as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_manages_users((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_manages_users((select app.live_role())));

drop policy if exists profiles_live_insert on public.profiles;
create policy profiles_live_insert on public.profiles as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_manages_users((select app.live_role())));

drop policy if exists profiles_live_delete on public.profiles;
create policy profiles_live_delete on public.profiles as restrictive for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_manages_users((select app.live_role())));

-- 0037 withdrew Supabase's default writes on profiles from the API roles but not MAINTAIN,
-- which PostgreSQL 17 (production) adds to the default ALL: VACUUM, ANALYZE, REINDEX,
-- CLUSTER and LOCK TABLE, the last enough to hold every sign-in up. Nothing in the app uses
-- it. The word does not parse before 17 (CI), so the statement is built only there.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.profiles from public, anon, authenticated';
  end if;
end $$;

-- ---- 3. An audit row names who wrote it ----------------------------------------------------
create or replace function app.tg_audit_actor() returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  -- A staff token writing directly (PostgREST, or an invoker function it called). Not a
  -- definer, whose current_user is its owner, and not the service role.
  if current_user in ('authenticated', 'anon') then
    new.actor_id := auth.uid();
    new.actor_role := app.current_role();
  end if;
  -- The time is the database's for every API role. Nothing the Worker writes sets it.
  if current_user in ('authenticated', 'anon', 'service_role') then
    new.created_at := pg_catalog.now();
  end if;
  return new;
end $$;
-- A trigger function: fired by its trigger, called by no session.
revoke all on function app.tg_audit_actor() from public, anon, authenticated, service_role;

drop trigger if exists audit_log_actor on public.audit_log;
create trigger audit_log_actor before insert on public.audit_log
  for each row execute function app.tg_audit_actor();

-- ---- 4. audit_log's grants, stated -------------------------------------------------------
-- 0002 hard-revoked UPDATE and DELETE "so even the service role cannot tamper", and 0011
-- granted staff SELECT and INSERT, but neither withdrew the rest of Supabase's default ALL:
-- TRUNCATE (which no policy and no row trigger sees, and which empties the chain in one
-- statement), REFERENCES, TRIGGER and, on PostgreSQL 17, MAINTAIN. Nothing in the app uses
-- them. Stated now: staff SELECT and INSERT (writeAudit, the activity log, the backup), the
-- service role SELECT and INSERT (the password-reset rows), anon and PUBLIC nothing. The id's
-- sequence: USAGE for the two roles that insert (the column default draws from it as the
-- writer), never UPDATE, which is setval.
revoke all on public.audit_log from public, anon, authenticated, service_role;
grant select, insert on public.audit_log to authenticated, service_role;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated, service_role;
grant usage on sequence public.audit_log_id_seq to authenticated, service_role;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair; a function's schema printed only when
-- app is not on the search path, so the patterns allow both).
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_live constant text :=
    '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_manages_users\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$';
  v_update constant text[] := array['display_name', 'is_active', 'role'];
  v_have text[];
  v_want text[];
  v_cols text[];
  v_bad text;
  v_src text;
  p text;
begin
  -- ---- The helper: Admin alone, for every role the enum knows and for none; staff and
  -- the service role may call it, anon and PUBLIC may not; inlinable (immutable, invoker).
  if not (app.role_manages_users('admin')
          and not app.role_manages_users('content_creator')
          and not app.role_manages_users('seo')
          and not app.role_manages_users('developer')
          and not app.role_manages_users('anon')
          and not app.role_manages_users(null)) then
    raise exception '0050: app.role_manages_users does not answer users.manage (Admin only)';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.role_manages_users(text)'::regprocedure
                    and provolatile = 'i' and not prosecdef) then
    raise exception '0050: app.role_manages_users must be IMMUTABLE and SECURITY INVOKER';
  end if;
  if not has_function_privilege('authenticated', 'app.role_manages_users(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_manages_users(text)', 'execute')
     or has_function_privilege('anon', 'app.role_manages_users(text)', 'execute')
     or has_function_privilege('public', 'app.role_manages_users(text)', 'execute') then
    raise exception '0050: app.role_manages_users must be executable by authenticated and service_role only';
  end if;
  -- The live role it is given: a definer staff tokens may call (0033).
  if not exists (select 1 from pg_proc where oid = 'app.live_role()'::regprocedure and prosecdef)
     or not has_function_privilege('authenticated', 'app.live_role()', 'execute')
     or has_function_privilege('anon', 'app.live_role()', 'execute') then
    raise exception '0050: app.live_role() must be a SECURITY DEFINER that authenticated alone executes';
  end if;

  -- ---- profiles: RLS on and forced, and exactly these policies (name, command, kind and
  -- roles compared as a set, so one added, dropped, renamed, made permissive or widened to
  -- another role fails here).
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.profiles'::regclass) then
    raise exception '0050: profiles is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'profiles') s;
  v_want := array['profiles_admin_write ALL PERMISSIVE {public}',
                  'profiles_auth_admin_read SELECT PERMISSIVE {supabase_auth_admin}',
                  'profiles_live_delete DELETE RESTRICTIVE {authenticated}',
                  'profiles_live_insert INSERT RESTRICTIVE {authenticated}',
                  'profiles_live_update UPDATE RESTRICTIVE {authenticated}',
                  'profiles_self_select SELECT PERMISSIVE {public}'];
  select array_agg(w order by w) into v_want from unnest(v_want) as w;
  if v_have is distinct from v_want then
    raise exception '0050: profiles policies are %, expected %', v_have, v_want;
  end if;

  -- ---- Each side of each live policy, read separately: the tenant predicate first, then
  -- the live check, on every side the command has; a side it does not have is absent.
  select string_agg(format('%s %s', x.policy, x.side), ', ' order by x.policy, x.side) into v_bad
    from (values ('profiles_live_update', 'using', v_live),
                 ('profiles_live_update', 'with check', v_live),
                 ('profiles_live_insert', 'using', null),
                 ('profiles_live_insert', 'with check', v_live),
                 ('profiles_live_delete', 'using', v_live),
                 ('profiles_live_delete', 'with check', null)) as x(policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = 'profiles' and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0050: profiles live policy expressions are not as stated: %', v_bad;
  end if;

  -- ---- profiles' grants, as 0037 left them (and MAINTAIN withdrawn above): PUBLIC and anon
  -- nothing; authenticated SELECT at table level and UPDATE on exactly role, is_active and
  -- display_name, no other privilege.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.profiles', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0050: wrong table privileges on profiles (role privilege): %', v_bad;
  end if;
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.profiles', 'select, insert, update, references') then
      raise exception '0050: % holds a column privilege on profiles', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.profiles', a.attname::text, 'update');
  if v_cols is distinct from v_update then
    raise exception '0050: authenticated updates profiles columns % (expected exactly %)', v_cols, v_update;
  end if;
  if has_any_column_privilege('authenticated', 'public.profiles', 'insert, references') then
    raise exception '0050: authenticated holds a column INSERT or REFERENCES on profiles';
  end if;

  -- ---- Renaming yourself does not ride on the grant or the policies: a definer with an
  -- empty search_path that staff tokens alone call (0044).
  if not exists (select 1 from pg_proc
                  where oid = 'public.update_my_profile(uuid, text)'::regprocedure and prosecdef
                    and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                 where c in ('search_path=""', 'search_path=')))
     or not has_function_privilege('authenticated', 'public.update_my_profile(uuid, text)', 'execute') then
    raise exception '0050: public.update_my_profile must stay a SECURITY DEFINER that staff tokens call';
  end if;

  -- ---- audit_log: exactly two triggers, both BEFORE INSERT FOR EACH ROW (tgtype 7: ROW 1 +
  -- BEFORE 2 + INSERT 4), enabled, no WHEN clause or argument: the actor binding, then the
  -- chain. BEFORE triggers on one event fire in name order (byte order, as strcmp), so
  -- audit_log_actor must sort first.
  select coalesce(array_agg(format('%s %s', t.tgname, t.tgfoid::regprocedure) order by t.tgname collate "C"), '{}')
    into v_have
    from pg_trigger t
   where t.tgrelid = 'public.audit_log'::regclass and not t.tgisinternal
     and t.tgenabled::text = 'O' and t.tgtype = 7 and t.tgqual is null and t.tgnargs = 0;
  if v_have is distinct from array['audit_log_actor app.tg_audit_actor()',
                                   'audit_log_chain app.tg_audit_chain()']
     or (select count(*) from pg_trigger t
          where t.tgrelid = 'public.audit_log'::regclass and not t.tgisinternal) <> 2 then
    raise exception '0050: audit_log triggers are %, expected audit_log_actor then audit_log_chain, both BEFORE INSERT FOR EACH ROW', v_have;
  end if;
  if not ('audit_log_actor' collate "C" < 'audit_log_chain' collate "C") then
    raise exception '0050: audit_log_actor does not sort before audit_log_chain';
  end if;

  -- ---- The binding function: an invoker (current_user must be the writer) with an empty
  -- search_path, executable by no API role; its body binds the three columns, keyed on the
  -- writing role.
  if not exists (select 1 from pg_proc
                  where oid = 'app.tg_audit_actor()'::regprocedure and not prosecdef
                    and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                 where c in ('search_path=""', 'search_path='))) then
    raise exception '0050: app.tg_audit_actor() must be SECURITY INVOKER with an empty search_path';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.tg_audit_actor()', 'execute') then
      raise exception '0050: % may execute app.tg_audit_actor()', p;
    end if;
  end loop;
  select prosrc into v_src from pg_proc where oid = 'app.tg_audit_actor()'::regprocedure;
  if not (v_src ~ 'new\.actor_id := auth\.uid\(\)'
          and v_src ~ 'new\.actor_role := app\.current_role\(\)'
          and v_src ~ 'new\.created_at := pg_catalog\.now\(\)'
          and v_src ~ 'current_user in \(''authenticated'', ''anon''\)') then
    raise exception '0050: app.tg_audit_actor() does not bind actor_id, actor_role and created_at for staff tokens';
  end if;

  -- ---- The chain is as 0031 left it: the trigger serializes (isolation check, lock, id,
  -- then the predecessor read, in that order in its source).
  select p2.prosrc into v_src
    from pg_proc p2 join pg_namespace n on n.oid = p2.pronamespace
   where n.nspname = 'app' and p2.proname = 'tg_audit_chain';
  if v_src is null
     or not (0 < position('transaction_isolation' in v_src)
             and position('transaction_isolation' in v_src) < position('pg_advisory_xact_lock' in v_src)
             and position('pg_advisory_xact_lock' in v_src) < position('nextval(pg_get_serial_sequence' in v_src)
             and position('nextval(pg_get_serial_sequence' in v_src) < position('select hash into v_prev' in v_src)) then
    raise exception '0050: app.tg_audit_chain() no longer serializes the chain (0031)';
  end if;

  -- ---- audit_log's policies are unchanged: staff insert, Admin and Developer read (the JWT
  -- layer; U13 adds the live read).
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'audit_log') s;
  if v_have is distinct from array['audit_insert INSERT PERMISSIVE {public}',
                                   'audit_read SELECT PERMISSIVE {public}'] then
    raise exception '0050: audit_log policies are %, expected audit_insert and audit_read', v_have;
  end if;

  -- ---- audit_log's table privileges, as each API role holds them: exactly SELECT and
  -- INSERT for authenticated and service_role, nothing for anon and PUBLIC; so no API role
  -- may UPDATE, DELETE or TRUNCATE a row, the service role included. No column grant.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.audit_log', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select', 'insert']),
                         ('service_role', array['select', 'insert']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0050: wrong table privileges on audit_log (role privilege): %', v_bad;
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0
                and not a.attisdropped and cardinality(coalesce(a.attacl, '{}'::aclitem[])) > 0) then
    raise exception '0050: audit_log carries a column grant';
  end if;
  -- Its sequence: USAGE for the two writers, no SELECT or UPDATE (setval) for anyone.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_sequence_privilege(x.who::name,
                   pg_get_serial_sequence('public.audit_log', 'id'), pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['usage']),
                         ('service_role', array['usage']))
                   as x(who, allowed)
            cross join unnest(array['usage', 'select', 'update']) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0050: wrong privileges on audit_log''s id sequence: %', v_bad;
  end if;
end $$;
