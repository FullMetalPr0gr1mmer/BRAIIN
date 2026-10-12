-- ─────────────────────────────────────────────────────────────────────────────
-- 0044 — The personal layer (Admin v2 F8, docs/admin-v2/ui.md AV-05). Forward-only,
-- expand only. Depends on 0001 (tenants, profiles), 0002 (audit_log), 0011 (the app
-- schema's grants), 0016 (app.deployment), 0031 (the audit chain's trigger), 0033
-- (app.live_role, app.role_works_leads), 0036 (crm_people) and 0037 (profiles' column grant).
--
-- What every signed-in member owns or sees about themselves, and the two facts the shell
-- shows everyone:
--
--   • public.admin_user_prefs: one row per person, keyed by the person. The bell's read
--     watermark (notifications_seen_at), the kinds of notification they muted, and the
--     dashboard layout and quick actions the dashboard slice (U1) fills. Self only in RLS
--     (the caller's own row, in the token's tenant), behind a RESTRICTIVE live check, so a
--     demoted, deactivated or locked token reads and writes nothing. It names no role:
--     P-6 keeps app.is_staff() to the four CMS roles, and the Sales role (C10a) gets its
--     own preferences too (ui.md §3.2). Staff insert their own row (the key columns, held
--     to themselves by RLS) and update only the preference columns; a BEFORE trigger owns
--     the version (it moves only when a preference does, so marking the bell read never
--     causes a 409), the timestamps, and the watermark, which only moves forward and never
--     past now(). The row's tenant is its person's in the database itself, not only in RLS:
--     the key to the profile is composite, (tenant_id, user_id) to profiles (tenant_id, id),
--     so no writer, the service role included, can file a row under another tenant, and a
--     profile moved to another tenant takes its row along.
--   • app.staff_directory(): the one people directory (README P-7). A live CMS staff member
--     gets every active member of the token's tenant: id, display name, role, and whether
--     the person can take work now (not locked). No e-mail. Executable by no API role; the
--     public functions below read it as its owner.
--       - public.staff_directory(p_tenant): id, display name and role, for the screens that
--         name people (the activity log, history). Empty unless the tenant the Worker names
--         is the token's.
--       - public.crm_people(p_tenant) (0036) is restated over the directory, with the same
--         answer as before: the assignable lead workers, for a live lead worker only. When
--         the Sales role arrives, its row is a branch of app.staff_directory() (P-7: Sales
--         sees only assignable lead workers), not a second directory.
--   • public.update_my_profile(p_tenant, p_display_name): a person renames themselves.
--     profiles is Admin-write only (profiles_admin_write, 0037's column grant), so this is
--     a SECURITY DEFINER that writes exactly one column of exactly the caller's row, after
--     its own live check; it cannot change a role, is_active, a lock or a tenant. It
--     applies the Worker's name rules itself (trim, length, no control or format
--     character) and writes the audit row in the same transaction, so a call that skips
--     the Worker is held to the same rules and audited just the same.
--   • public.admin_environment(p_tenant): which environment the shell's pill names, from
--     app.deployment (0016): production → 'production', staging → 'staging', development →
--     'local'. NULL when the database is unmarked, so the pill never names an environment
--     the marker does not (an unmarked staging project must not read "LOCAL"). For a live
--     member naming their own tenant only.
--
-- Grants are stated for both Supabase privilege regimes (README P-14: from 2026-10-30 new
-- objects are no longer auto-granted): everything is revoked from public, anon,
-- authenticated and service_role first, then granted exactly, and the postconditions
-- check what must and what must not be held. The table has no sequence (its key is the
-- person's uuid). CLAUDE.md §3 (Pillar 1), §5, §8.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 and 0041). 0044 locks
-- public.profiles: the unique key the preferences reference, where 0041 has not added it
-- already (ACCESS EXCLUSIVE while its index builds), and the preferences' foreign key
-- (SHARE ROW EXCLUSIVE, which blocks writers); and public.tenants for the tenant key (SHARE
-- ROW EXCLUSIVE). Every admin request reads profiles, the access-token hook reads it at
-- every sign-in and the sign-in's lockout RPCs write it, so a lock request queued behind a
-- long transaction (an export, a dump, an idle session) would hold those writes up for the
-- whole wait. A statement below that waits more than five seconds for a lock raises
-- instead, the whole migration rolls back, and the push is retried later.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. Preferences ---------------------------------------------------------------------
-- The key a preferences row references: a profile, in its own tenant. 0041 (C3) adds this
-- exact constraint, profiles_tenant_id_id, for the leads' assignee, and applies before 0044
-- in production (docs/admin-v2/migrations.md); on a database without it (this branch's CI
-- until C3 merges) 0044 adds the same one, so whichever file runs first creates it and the
-- other finds it. admin_user_prefs_profile_fk depends on it from here on: a later file that
-- drops and re-adds it must drop that key first.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.profiles'::regclass
                    and conname = 'profiles_tenant_id_id') then
    alter table public.profiles add constraint profiles_tenant_id_id unique (tenant_id, id);
  end if;
end $$;

create table if not exists public.admin_user_prefs (
  -- The person. With tenant_id, the composite key to their profile (below).
  user_id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The dashboard's layout (U1): {top, left, right, hidden}. Zod drops unknown widget ids on
  -- read; a preference never grants access to anything.
  dashboard jsonb not null default '{}'::jsonb,
  -- The dashboard's quick actions (U1).
  quick_actions jsonb not null default '[]'::jsonb,
  -- The bell (F8): {"muted": [kind, …]}. Unknown kinds are dropped on read.
  notifications jsonb not null default '{}'::jsonb,
  -- "Mark all as read": a watermark, not a per-item flag (docs/admin-v2/deviations.md).
  notifications_seen_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Shapes and sizes: a preference is small, and a JSON value of the wrong kind is a bug.
  constraint admin_user_prefs_dashboard_shape check (
    jsonb_typeof(dashboard) = 'object' and octet_length(dashboard::text) <= 16384),
  constraint admin_user_prefs_quick_actions_shape check (
    jsonb_typeof(quick_actions) = 'array' and octet_length(quick_actions::text) <= 16384),
  constraint admin_user_prefs_notifications_shape check (
    jsonb_typeof(notifications) = 'object' and octet_length(notifications::text) <= 4096),
  -- The person, in their own tenant. RLS also holds a staff row to the token's tenant; this
  -- holds every row to its person's, whoever writes it. The row goes with its profile (ON
  -- DELETE), and moves with it (ON UPDATE): a profile moved to another tenant keeps its
  -- preferences there, instead of leaving a row behind in the old tenant that would hold
  -- the person's key and refuse them a row in the new one.
  constraint admin_user_prefs_profile_fk foreign key (tenant_id, user_id)
    references public.profiles (tenant_id, id) on delete cascade on update cascade
);
create index if not exists admin_user_prefs_tenant_idx on public.admin_user_prefs (tenant_id);

alter table public.admin_user_prefs enable row level security;
alter table public.admin_user_prefs force row level security;

-- The version, the stamps and the watermark belong to the database, and a row belongs to
-- its person for good. INVOKER (a trigger needs no privilege of its own); search_path ''
-- with qualified names.
create or replace function app.tg_admin_user_prefs() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    if new.notifications_seen_at is not null then
      new.notifications_seen_at := least(new.notifications_seen_at, now());
    end if;
    return new;
  end if;

  -- A preferences row belongs to one person for good: refused, not silently kept, so the
  -- composite key can never be left naming a pair that no profile has. (A profile's id is
  -- its auth user's and never changes; staff hold no UPDATE on the key at all.)
  if new.user_id is distinct from old.user_id then
    raise exception using errcode = '23514',
      message = 'admin_user_prefs: a preferences row belongs to one person for good';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();

  -- The row's tenant is its person's: the composite key refuses any other, and carries it
  -- along when the profile moves (ON UPDATE CASCADE). The watermark is a point in one
  -- tenant's feed, so a move starts the person's bell afresh in the new tenant. Otherwise
  -- the watermark only moves forward, and never past now(): a clock ahead of the
  -- database's cannot hide what arrives in between, and it cannot be cleared.
  if new.tenant_id is distinct from old.tenant_id then
    new.notifications_seen_at := null;
  elsif new.notifications_seen_at is null then
    new.notifications_seen_at := old.notifications_seen_at;
  elsif old.notifications_seen_at is not null then
    new.notifications_seen_at := greatest(old.notifications_seen_at,
                                          least(new.notifications_seen_at, now()));
  else
    new.notifications_seen_at := least(new.notifications_seen_at, now());
  end if;

  -- Optimistic locking for the preferences only: the version moves when a preference
  -- does, so marking the bell read between a read and a save is not a conflict.
  if row(new.dashboard, new.quick_actions, new.notifications)
     is distinct from row(old.dashboard, old.quick_actions, old.notifications) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end $$;
revoke all on function app.tg_admin_user_prefs() from public, anon, authenticated, service_role;

drop trigger if exists admin_user_prefs_guard on public.admin_user_prefs;
create trigger admin_user_prefs_guard before insert or update on public.admin_user_prefs
  for each row execute function app.tg_admin_user_prefs();

-- Self only. No DELETE policy (and no DELETE grant): the row goes with its profile.
drop policy if exists admin_user_prefs_self_read on public.admin_user_prefs;
create policy admin_user_prefs_self_read on public.admin_user_prefs for select to authenticated
  using (tenant_id = app.effective_tenant_id() and user_id = (select auth.uid()));

drop policy if exists admin_user_prefs_self_insert on public.admin_user_prefs;
create policy admin_user_prefs_self_insert on public.admin_user_prefs for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and user_id = (select auth.uid()));

drop policy if exists admin_user_prefs_self_update on public.admin_user_prefs;
create policy admin_user_prefs_self_update on public.admin_user_prefs for update to authenticated
  using (tenant_id = app.effective_tenant_id() and user_id = (select auth.uid()))
  with check (tenant_id = app.effective_tenant_id() and user_id = (select auth.uid()));

-- RESTRICTIVE: the token's own row opens the door; the profile, read live, must hold it
-- open. A stale token (demoted, deactivated, locked, or disagreeing with its profile)
-- reads and writes nothing. Its own tenant predicate (P-14).
drop policy if exists admin_user_prefs_live on public.admin_user_prefs;
create policy admin_user_prefs_live on public.admin_user_prefs as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null)
  with check (tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null);

-- ---- 2. The people directory (P-7) --------------------------------------------------------
-- Reads profiles past profiles_self_select as its owner (BYPASSRLS), so it checks the
-- caller itself: a live CMS staff member (app.is_staff() reads the token's role, and
-- app.live_role() is null unless the profile agrees with it). Locked people stay in the
-- directory (they are still members), marked as not assignable.
create or replace function app.staff_directory()
  returns table (id uuid, display_name text, role text, assignable boolean)
  language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.role::text,
         (p.locked_until is null or p.locked_until <= now()) as assignable
    from public.profiles p
   where app.is_staff()
     and (select app.live_role()) is not null
     and p.tenant_id = app.effective_tenant_id()
     and p.is_active
   order by p.display_name nulls last, p.id
$$;
revoke all on function app.staff_directory() from public, anon, authenticated, service_role;

create or replace function public.staff_directory(p_tenant uuid)
  returns table (id uuid, display_name text, role text)
  language sql stable security definer set search_path = '' as $$
  select d.id, d.display_name, d.role
    from app.staff_directory() d
   where p_tenant = app.effective_tenant_id()
   order by d.display_name nulls last, d.id
$$;

-- 0036's crm_people, now a view of the one directory. Same answer as 0036: the caller's
-- live role works leads, the tenant named is the token's, and only active, unlocked lead
-- workers (the directory adds that its caller is live CMS staff, which a live lead worker
-- is). Same signature, so its grants are kept; they are restated below anyway.
create or replace function public.crm_people(p_tenant uuid)
  returns table (id uuid, display_name text, role text)
  language sql stable security definer set search_path = '' as $$
  select d.id, d.display_name, d.role
    from app.staff_directory() d
   where app.role_works_leads((select app.live_role()))
     and p_tenant = app.effective_tenant_id()
     and d.assignable
     and app.role_works_leads(d.role)
   order by d.display_name nulls last, d.id
$$;

-- ---- 3. Renaming yourself -----------------------------------------------------------------
-- One column of one row: the caller's display name, under the rules the Worker's schema
-- applies (DisplayNameSchema, packages/schemas/adminPrefs.ts), so a call that skips the
-- Worker meets the same ones:
--   • trimmed of exactly what JavaScript's String.prototype.trim() removes (tab, LF, VT,
--     FF, CR, space, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F,
--     U+3000, U+FEFF); empty clears it (the shell then shows the e-mail);
--   • at most 80 characters (counted in code points, so never stricter than the schema's
--     UTF-16 count);
--   • no Unicode control or format character (general categories Cc and Cf, as Unicode 15
--     to 17 list them; NUL cannot reach a text value). A name is shown beside every edit
--     and in every people list, so a bidi override (U+202E), an isolate (U+2066) or a
--     zero-width character (U+200B) must not reorder or hide the text around it.
-- tests/lib/personalLayer.spec.ts holds the trim set and the refused class equal to the
-- schema's `.trim()` and /[\p{Cc}\p{Cf}]/u, code point by code point.
-- The rename is audited HERE, in the same transaction (profile.update, the field's name
-- only, never the name), so every path that reaches this function is audited and a rename
-- whose audit row cannot be written does not happen. 42501 for a caller who is not live in
-- the tenant they name, 22023 for a name it refuses.
create or replace function public.update_my_profile(p_tenant uuid, p_display_name text)
  returns text
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_role text := app.live_role();
  v_name text;
begin
  if v_uid is null
     or v_role is null
     or p_tenant is distinct from app.effective_tenant_id() then
    raise exception using errcode = '42501',
      message = 'update_my_profile: the caller is not a live member of this tenant';
  end if;
  v_name := nullif(btrim(coalesce(p_display_name, ''),
    E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'),
    '');
  if v_name is not null and (
       char_length(v_name) > 80
       or v_name ~ '[\u0001-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]') then
    raise exception using errcode = '22023',
      message = 'update_my_profile: a display name is at most 80 characters, with no control or format characters';
  end if;
  update public.profiles p
     set display_name = v_name
   where p.id = v_uid and p.tenant_id = p_tenant;
  if not found then
    raise exception using errcode = '42501', message = 'update_my_profile: no profile to update';
  end if;
  -- Hash-chained by audit_log's own trigger (0031), as every insert is.
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, v_uid, v_role, 'profile.update', 'profile', v_uid::text,
          jsonb_build_object('fields', jsonb_build_array('display_name')));
  return v_name;
end $$;

-- ---- 4. The environment pill --------------------------------------------------------------
-- app.deployment is readable by no API role (0016); this answers one word from it.
create or replace function public.admin_environment(p_tenant uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case d.env
           when 'production' then 'production'
           when 'staging' then 'staging'
           when 'development' then 'local'
         end
    from app.deployment d
   where (select app.live_role()) is not null
     and p_tenant = app.effective_tenant_id()
$$;

-- ---- 5. Grants, stated (Admin v2 P-14: both Supabase grant regimes) -----------------------
revoke all on public.admin_user_prefs from public, anon, authenticated, service_role;
grant select on public.admin_user_prefs to authenticated;
grant insert (tenant_id, user_id, dashboard, quick_actions, notifications, notifications_seen_at)
  on public.admin_user_prefs to authenticated;
grant update (dashboard, quick_actions, notifications, notifications_seen_at)
  on public.admin_user_prefs to authenticated;
-- The backend of record (support, a person's erasure). Nothing in F8 uses it.
grant select, insert, update, delete on public.admin_user_prefs to service_role;

revoke all on function public.staff_directory(uuid) from public, anon, authenticated, service_role;
revoke all on function public.crm_people(uuid) from public, anon, authenticated, service_role;
revoke all on function public.update_my_profile(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_environment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_directory(uuid) to authenticated;
grant execute on function public.crm_people(uuid) to authenticated;
grant execute on function public.update_my_profile(uuid, text) to authenticated;
grant execute on function public.admin_environment(uuid) to authenticated;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them, the same
-- on PostgreSQL 15 and 17 (each operator in parentheses, each AND list in one pair; a
-- function's schema printed only when app is not on the search path, so the patterns allow
-- both).
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_insert constant text[] := array['dashboard', 'notifications', 'notifications_seen_at',
    'quick_actions', 'tenant_id', 'user_id'];
  v_update constant text[] := array['dashboard', 'notifications', 'notifications_seen_at',
    'quick_actions'];
  -- The tenant predicate first, then the caller's own row (the three permissive policies);
  -- the tenant predicate first, then the live check (the restrictive one).
  v_self constant text :=
    '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(user_id = \( SELECT auth\.uid\(\) AS uid\)\)\)$';
  v_live constant text :=
    '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\)\)$';
  v_cols text[];
  v_have text[];
  v_want text[];
  v_bad text;
  p text;
begin
  -- RLS on, and forced.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.admin_user_prefs'::regclass) then
    raise exception '0044: admin_user_prefs is not ENABLE + FORCE row level security';
  end if;

  -- ---- Table privileges, as each API role holds them (directly or through a role it is a
  -- member of): exactly these, and nothing else of v_privs. PUBLIC and anon nothing;
  -- authenticated SELECT (its INSERT and UPDATE are column grants, below); service_role
  -- SELECT, INSERT, UPDATE and DELETE, never TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.admin_user_prefs', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select', 'insert', 'update', 'delete']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0044: wrong table privileges on admin_user_prefs (role privilege): %', v_bad;
  end if;

  -- ---- The table's own ACL, grantee by grantee: the owner's, plus exactly the grants
  -- above. A grant to any other role (a later custom role, supabase_auth_admin) fails here.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s',
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_class c
            cross join lateral aclexplode(c.relacl) a
           where c.oid = 'public.admin_user_prefs'::regclass
             and a.grantee <> c.relowner) s;
  v_want := array['authenticated select', 'service_role delete', 'service_role insert',
                  'service_role select', 'service_role update'];
  select array_agg(w order by w) into v_want from unnest(v_want) as w;
  if v_have is distinct from v_want then
    raise exception '0044: admin_user_prefs is granted %, expected %', v_have, v_want;
  end if;

  -- ---- Column grants: exactly authenticated's INSERT on the key and the preference
  -- columns and UPDATE on the preference columns, and no other column grant to anyone.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s', att.attname,
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_attribute att
            cross join lateral aclexplode(att.attacl) a
           where att.attrelid = 'public.admin_user_prefs'::regclass
             and att.attnum > 0 and not att.attisdropped) s;
  select array_agg(e order by e) into v_want
    from (select format('%s authenticated insert', c) as e from unnest(v_insert) c
          union all
          select format('%s authenticated update', c) from unnest(v_update) c) s;
  if v_have is distinct from v_want then
    raise exception '0044: admin_user_prefs column grants are %, expected %', v_have, v_want;
  end if;

  -- ---- Column privileges as held: PUBLIC and anon none on any column; authenticated
  -- INSERT exactly v_insert and UPDATE exactly v_update; no one REFERENCES any column.
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.admin_user_prefs', 'select, insert, update, references') then
      raise exception '0044: % holds a column privilege on admin_user_prefs', p;
    end if;
  end loop;
  foreach p in array array['authenticated', 'service_role'] loop
    if has_any_column_privilege(p::name, 'public.admin_user_prefs', 'references') then
      raise exception '0044: % holds REFERENCES on a column of admin_user_prefs', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.admin_user_prefs'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.admin_user_prefs', a.attname::text, 'insert');
  if not (v_cols @> v_insert and v_cols <@ v_insert) then
    raise exception '0044: authenticated inserts columns % (expected exactly %)', v_cols, v_insert;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.admin_user_prefs'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.admin_user_prefs', a.attname::text, 'update');
  if not (v_cols @> v_update and v_cols <@ v_update) then
    raise exception '0044: authenticated updates columns % (expected exactly %)', v_cols, v_update;
  end if;

  -- ---- Policies: exactly these, for any role. Name, command, kind and roles compared as a
  -- set, so a policy added (a permissive one over the whole tenant, say), dropped, renamed,
  -- turned permissive or widened to another role fails here. No policy lets anyone delete.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'admin_user_prefs') s;
  v_want := array['admin_user_prefs_live ALL RESTRICTIVE {authenticated}',
                  'admin_user_prefs_self_insert INSERT PERMISSIVE {authenticated}',
                  'admin_user_prefs_self_read SELECT PERMISSIVE {authenticated}',
                  'admin_user_prefs_self_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(w order by w) into v_want from unnest(v_want) as w;
  if v_have is distinct from v_want then
    raise exception '0044: admin_user_prefs policies are %, expected %', v_have, v_want;
  end if;

  -- ---- Each side of each policy, read separately: the three permissive ones are the
  -- tenant and the caller's own row in USING and in WITH CHECK alike (an UPDATE whose
  -- WITH CHECK dropped auth.uid() fails), and the restrictive one is the tenant and the
  -- live check on both sides. A side a command does not have must be absent.
  select string_agg(format('%s %s', x.policy, x.side), ', ' order by x.policy, x.side) into v_bad
    from (values ('admin_user_prefs_self_read', 'using', v_self),
                 ('admin_user_prefs_self_read', 'with check', null),
                 ('admin_user_prefs_self_insert', 'using', null),
                 ('admin_user_prefs_self_insert', 'with check', v_self),
                 ('admin_user_prefs_self_update', 'using', v_self),
                 ('admin_user_prefs_self_update', 'with check', v_self),
                 ('admin_user_prefs_live', 'using', v_live),
                 ('admin_user_prefs_live', 'with check', v_live)) as x(policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = 'admin_user_prefs'
     and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0044: admin_user_prefs policy expressions are not as stated: %', v_bad;
  end if;

  -- ---- Keys: a row's tenant is its person's. Exactly two foreign keys, the tenant and the
  -- composite key to the profile (cascading on delete and on update), and the latter rests
  -- on profiles_tenant_id_id, unique on exactly (tenant_id, id) (0041's, or the same one
  -- added above).
  if (select count(*) from pg_constraint
       where conrelid = 'public.admin_user_prefs'::regclass and contype = 'f') <> 2
     or not exists (
       select 1 from pg_constraint
        where conrelid = 'public.admin_user_prefs'::regclass and contype = 'f'
          and conname = 'admin_user_prefs_profile_fk'
          and pg_get_constraintdef(oid) ~ '^FOREIGN KEY \(tenant_id, user_id\) REFERENCES (public\.)?profiles\(tenant_id, id\) ON UPDATE CASCADE ON DELETE CASCADE$')
     or not exists (
       select 1 from pg_constraint
        where conrelid = 'public.admin_user_prefs'::regclass and contype = 'f'
          and pg_get_constraintdef(oid) ~ '^FOREIGN KEY \(tenant_id\) REFERENCES (public\.)?tenants\(id\) ON DELETE CASCADE$') then
    raise exception '0044: admin_user_prefs must have exactly its tenant key and the composite key to its profile';
  end if;
  if not exists (
       select 1 from pg_constraint k
         join pg_constraint f on f.conname = 'admin_user_prefs_profile_fk'
                             and f.conrelid = 'public.admin_user_prefs'::regclass
        where k.conrelid = 'public.profiles'::regclass and k.conname = 'profiles_tenant_id_id'
          and k.contype = 'u' and pg_get_constraintdef(k.oid) = 'UNIQUE (tenant_id, id)'
          and f.conindid = k.conindid) then
    raise exception '0044: admin_user_prefs_profile_fk must rest on profiles_tenant_id_id, UNIQUE (tenant_id, id)';
  end if;

  -- The functions: definers with an empty search path, callable by staff tokens and by
  -- nobody else; the directory and the trigger by no API role at all.
  foreach p in array array['public.staff_directory(uuid)', 'public.crm_people(uuid)',
                           'public.update_my_profile(uuid, text)',
                           'public.admin_environment(uuid)'] loop
    if has_function_privilege('anon', p, 'execute')
       or has_function_privilege('service_role', p, 'execute')
       or not has_function_privilege('authenticated', p, 'execute') then
      raise exception '0044: % must be executable by authenticated only', p;
    end if;
    if exists (select 1 from information_schema.routine_privileges r
                where r.grantee = 'PUBLIC' and r.specific_schema = 'public'
                  and r.routine_name = split_part(split_part(p, '(', 1), '.', 2)) then
      raise exception '0044: PUBLIC may execute %', p;
    end if;
  end loop;
  foreach p in array array['app.staff_directory()', 'app.tg_admin_user_prefs()'] loop
    if has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0044: % is executable by an API role', p;
    end if;
  end loop;
  foreach p in array array['app.staff_directory()', 'public.staff_directory(uuid)',
                           'public.crm_people(uuid)', 'public.update_my_profile(uuid, text)',
                           'public.admin_environment(uuid)'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0044: % must be SECURITY DEFINER with an empty search_path', p;
    end if;
  end loop;

  -- No e-mail leaves the directory: its result is exactly id, display_name, role (and the
  -- internal assignable flag on app.staff_directory()).
  if pg_get_function_result('public.staff_directory(uuid)'::regprocedure)
     <> 'TABLE(id uuid, display_name text, role text)' then
    raise exception '0044: public.staff_directory returns %',
      pg_get_function_result('public.staff_directory(uuid)'::regprocedure);
  end if;

  -- 0016's marker is still unreadable by every API role: the pill reads it through the
  -- definer above, never directly.
  if has_table_privilege('authenticated', 'app.deployment', 'select')
     or has_table_privilege('anon', 'app.deployment', 'select')
     or has_table_privilege('service_role', 'app.deployment', 'select') then
    raise exception '0044: app.deployment is readable by an API role';
  end if;

  -- The trigger is the only BEFORE trigger on the table.
  if (select coalesce(array_agg(distinct t.trigger_name::text order by t.trigger_name::text), '{}')
        from information_schema.triggers t
       where t.event_object_schema = 'public' and t.event_object_table = 'admin_user_prefs'
         and t.action_timing = 'BEFORE') <> array['admin_user_prefs_guard'] then
    raise exception '0044: admin_user_prefs must have exactly one BEFORE trigger, admin_user_prefs_guard';
  end if;
end $$;
