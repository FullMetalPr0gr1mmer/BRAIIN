-- ─────────────────────────────────────────────────────────────────────────────
-- 0062 — Releases, staged writes: the draft writes staff were not given in 0038 (Admin v2
-- R3a). Forward-only, EXPAND only (grants, policies and functions are added; nothing is
-- taken away), and INERT: releases stay off for every tenant (app.release_tenants is empty
-- until R14), and while they are off the new policies refuse every staff draft insert and
-- update, so nothing reaches content_drafts through the API before switch-on.
-- Depends on 0033 (app.live_role), 0038 (the ledger, the registry, the draft lock) and
-- 0051 (app.releases_enabled's grant).
--
-- The design is docs/admin-v2/releases.md §3 and slice R3, as the R3 brief splits it (R3a:
-- the database and the resource kernel; R3b: singletons, entity SEO, the intake switch and
-- the draft endpoints, no migration). The departures are in docs/admin-v2/as-built/R3a.md.
--
--   • public.content_drafts: staff (authenticated) now hold INSERT, UPDATE and DELETE, as
--     0038 promised R3 would grant them with the kernel that writes drafts. 0038's
--     permissive policies already say WHO may stage WHAT (app.can_author, removals,
--     archives, never a claimed draft); three RESTRICTIVE policies here say WHEN:
--       - the writer's profile is live (`app.live_role()`: active, unlocked, this tenant,
--         the token's role), so a demoted, deactivated or locked token writes no draft
--         through the API directly (decision D1);
--       - releases are on for the tenant, for an insert or an update (D2: a draft planted
--         through PostgREST while releases are off would surface at switch-on). A discard
--         needs only the live check: throwing a change away never changes the site, and a
--         tenant switched off later keeps its drafts (releases.md §8, edge case 21);
--       - a singleton's draft is keyed by its tenant (`app.draft_key_ok`, D13; R1's open
--         item): a `site_profile` or `seo_defaults` draft names `entity_id = tenant_id`.
--   • public.releases_enabled(p_tenant): the flag reader staff may call (R1's open item).
--     SECURITY DEFINER over app.releases_enabled (the flag table is FORCE RLS with no
--     policy), and false for any tenant but the caller's own: the public.staff_directory
--     shape (0044), so the Worker names its tenant and the authz harness sees it.
--   • public.write_drafts(p_tenant, p_ops): the one draft writer (D3). SECURITY INVOKER, so
--     RLS, the policies above and the draft lock bind exactly as for a direct write; every
--     change of one request lands in one transaction and one subrequest (a 200-row reorder
--     would otherwise need 200 PostgREST calls against the Workers Free plan's 50), in a
--     fixed order, so two concurrent reorders cannot deadlock.
--   • app.draft_key_ok(type, entity, tenant): invoker, reads the registry under the
--     caller's own RLS (CMS staff only); an unknown type is false.
--   • app.tg_draft_lock (0038) restated: a staff caller can no longer set or change a
--     draft's provenance (`origin_kind`, `origin_release_id`), which only a restore writes.
--
-- No capability, no app.role_* helper (the live check is generic, not a capability), no
-- registry row, no help guide. Grants are stated for both Supabase grant regimes (Admin v2
-- P-14). Postconditions at the end.
--
-- CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy content_drafts fails the push instead of queueing behind live traffic (0038's
-- pattern). Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ═══ 1. Grants: the draft writes 0038 withheld ════════════════════════════════════════════
-- Stated, never inherited: every API role loses everything first (MAINTAIN included on
-- PostgreSQL 17, which `all` covers), then exactly this. No column grant, no sequence (the
-- id is gen_random_uuid(), and the draft lock replaces it on a staff insert anyway).
revoke all on public.content_drafts from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.content_drafts to authenticated;
grant select, insert, update, delete on public.content_drafts to service_role;

-- ═══ 2. The flag reader staff may call ═══════════════════════════════════════════════════
-- True only while the caller's own tenant has releases on. Another tenant's id, or none,
-- answers false (never an error, so a policy that calls it never raises on it).
create or replace function public.releases_enabled(p_tenant uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select coalesce(p_tenant = app.effective_tenant_id(), false)
         and app.releases_enabled(p_tenant)
$$;
revoke all on function public.releases_enabled(uuid) from public, anon, authenticated, service_role;
grant execute on function public.releases_enabled(uuid) to authenticated;
comment on function public.releases_enabled(uuid) is
  'Admin v2 R3a (0062): are site-wide releases on for the caller''s own tenant? False for '
  'any other tenant. The route kernel asks it once per request on a release-managed route.';

-- ═══ 3. A singleton's draft is keyed by its tenant ═══════════════════════════════════════
create or replace function app.draft_key_ok(p_entity_type text, p_entity_id uuid, p_tenant uuid)
  returns boolean
  language sql stable set search_path = ''
as $$
  select coalesce(
    (select e.key_column <> 'tenant_id' or p_entity_id = p_tenant
       from app.release_entities e
      where e.entity_type = p_entity_type),
    false)
$$;
revoke all on function app.draft_key_ok(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.draft_key_ok(text, uuid, uuid) to authenticated;

-- ═══ 4. When staff may write a draft (RESTRICTIVE, ANDed with 0038's permissive ones) ════
-- To authenticated only: the service role (apply_release consumes drafts, the schedule path
-- claims them) is not bound, and the migration role and seeds (no claims) bypass RLS. The
-- tenant predicate leads each one (P-14), the live check is an InitPlan (one lookup per
-- statement).
drop policy if exists content_drafts_live_insert on public.content_drafts;
create policy content_drafts_live_insert on public.content_drafts
  as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id()
              and (select app.live_role()) is not null
              and public.releases_enabled(tenant_id)
              and app.draft_key_ok(entity_type, entity_id, tenant_id));
drop policy if exists content_drafts_live_update on public.content_drafts;
create policy content_drafts_live_update on public.content_drafts
  as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id()
         and (select app.live_role()) is not null
         and public.releases_enabled(tenant_id))
  with check (tenant_id = app.effective_tenant_id()
              and (select app.live_role()) is not null
              and public.releases_enabled(tenant_id)
              and app.draft_key_ok(entity_type, entity_id, tenant_id));
drop policy if exists content_drafts_live_delete on public.content_drafts;
create policy content_drafts_live_delete on public.content_drafts
  as restrictive for delete to authenticated
  using (tenant_id = app.effective_tenant_id()
         and (select app.live_role()) is not null);

-- ═══ 4b. The draft lock pins a draft's provenance too ════════════════════════════════════
-- 0038's lock makes a draft's id, version, author and stamps the database's for a bound
-- caller (a staff claim, or anon/authenticated). With staff now holding INSERT and UPDATE, it
-- also pins where a draft came from: `origin_kind` ('restore') and `origin_release_id` are
-- written only by the paths that restore a version (the service role, or no role claim: the
-- runbook), never by a staff token, so the history a rollback shows (R6, R10, R11) cannot be
-- forged. A bound insert gets nulls, a bound update keeps the stored values. Otherwise 0038's
-- body, unchanged.
create or replace function app.tg_draft_lock() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  v_role text := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
                   #>> '{app_metadata,role}';
  v_bound constant boolean := current_user::text in ('anon', 'authenticated')
                              or (v_role is not null and current_user::text <> 'service_role');
begin
  -- 1. The claim lock.
  if v_bound then
    if tg_op = 'INSERT' then
      if new.release_id is not null then
        raise exception 'a pending change is claimed and released only by a scheduled release'
          using errcode = '42501',
                hint = 'Schedule or unschedule the release instead.';
      end if;
    elsif old.release_id is not null then
      raise exception 'a pending change claimed by a scheduled release cannot be changed or discarded'
        using errcode = '42501',
              hint = 'Unschedule the release first.';
    elsif tg_op = 'UPDATE' and new.release_id is not null then
      raise exception 'a pending change is claimed and released only by a scheduled release'
        using errcode = '42501',
              hint = 'Schedule or unschedule the release instead.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- 2 and 3. The version, the id, the actor and the stamps.
  if tg_op = 'INSERT' then
    if v_role is not null then
      new.id := pg_catalog.gen_random_uuid();
      new.version := 1;
      new.created_by := auth.uid();
      new.created_at := pg_catalog.now();
    else
      new.created_by := coalesce(new.created_by, auth.uid());
    end if;
  else
    new.id := old.id;
    new.version := old.version + 1;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := pg_catalog.now();

  -- 4. The provenance (0062): a bound caller never sets or changes it.
  if v_bound then
    if tg_op = 'INSERT' then
      new.origin_kind := null;
      new.origin_release_id := null;
    else
      new.origin_kind := old.origin_kind;
      new.origin_release_id := old.origin_release_id;
    end if;
  end if;
  return new;
end $$;
revoke all on function app.tg_draft_lock() from public, anon, authenticated, service_role;

-- ═══ 5. The one draft writer ═════════════════════════════════════════════════════════════
-- p_ops is a JSON array of 1 to 200 changes, all for p_tenant (the caller's own, else 42501):
--
--   {"action":"put", "entity_type", "entity_id", "op", "payload", "fields", "base",
--    "base_version", "label"}                       a new draft (the lock assigns its id,
--                                                   version 1 and author)
--   the same plus "draft_id" and "expected_version" an edit of that draft at that version
--   {"action":"discard", "draft_id", "expected_version", "entity_type"?, "entity_id"?}
--
-- A key outside these, a value of the wrong JSON type, or one of draft_id/expected_version
-- without the other is 22023 (the Worker built the call wrong). They run in (entity_type,
-- entity_id, draft_id) order, so two calls touching the same drafts take their locks in
-- the same order. Answers, per change in that order,
-- {action, draft_id, entity_type, entity_id, version} (version null for a discard).
--
-- Refusals (the Worker maps them, src/lib/release/drafts.ts):
--   BR409  detail {"code":"draft-conflict", "draft_id"?, "entity_type", "entity_id"}: a
--          second draft for one entity (or one pending SEO create for one target), or the
--          named draft moved on (another version) or is gone;
--          detail {"code":"scheduled", ...}: the named draft is claimed by a scheduled release.
--   42501  the tenant is not the caller's, or RLS refused the write (a stale token,
--          releases off, a role that may not stage this change).
--   23514  a CHECK of content_drafts (payload or base over 512 KB, a changed-column list,
--          a label over 4 KB, a removal with a payload, a create with a base version).
-- Any refusal undoes the whole call: nothing of it is kept.
create or replace function public.write_drafts(p_tenant uuid, p_ops jsonb) returns jsonb
  language plpgsql volatile security invoker set search_path = ''
as $$
declare
  c_max_ops constant int := 200;
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_version constant text := '^[1-9][0-9]{0,8}$';
  v_out jsonb := '[]'::jsonb;
  v_op jsonb;
  v_action text;
  v_bad text;
  v_type text;
  v_entity uuid;
  v_draft uuid;
  v_expected int;
  v_payload jsonb;
  v_base jsonb;
  v_fields text[];
  v_label jsonb;
  v_base_version int;
  v_id uuid;
  v_version int;
  v_constraint text;
  v_found record;
begin
  if p_tenant is null or p_tenant is distinct from app.effective_tenant_id() then
    raise exception 'write_drafts: the tenant is not the caller''s' using errcode = '42501';
  end if;
  if p_ops is null or pg_catalog.jsonb_typeof(p_ops) <> 'array'
     or pg_catalog.jsonb_array_length(p_ops) < 1
     or pg_catalog.jsonb_array_length(p_ops) > c_max_ops then
    raise exception 'write_drafts: one call carries 1 to % changes', c_max_ops
      using errcode = '22023';
  end if;

  -- The shapes, all of them before anything is written.
  for v_op in select x.value from pg_catalog.jsonb_array_elements(p_ops) as x(value) loop
    if pg_catalog.jsonb_typeof(v_op) <> 'object' then
      raise exception 'write_drafts: a change is a JSON object' using errcode = '22023';
    end if;
    v_action := v_op ->> 'action';
    if v_action = 'put' then
      select pg_catalog.string_agg(k.key, ', ') into v_bad
        from pg_catalog.jsonb_object_keys(v_op) as k(key)
       where k.key <> all (array['action', 'entity_type', 'entity_id', 'op', 'payload', 'fields',
                                 'base', 'base_version', 'label', 'draft_id', 'expected_version']);
      if v_bad is not null
         or pg_catalog.jsonb_typeof(v_op -> 'entity_type') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_op -> 'op') is distinct from 'string'
         or coalesce(v_op ->> 'entity_id', '') !~ c_uuid
         or coalesce(pg_catalog.jsonb_typeof(v_op -> 'payload'), 'null') not in ('null', 'object')
         or coalesce(pg_catalog.jsonb_typeof(v_op -> 'base'), 'null') not in ('null', 'object')
         or coalesce(pg_catalog.jsonb_typeof(v_op -> 'label'), 'null') not in ('null', 'object')
         or coalesce(pg_catalog.jsonb_typeof(v_op -> 'fields'), 'null') not in ('null', 'array')
         or (pg_catalog.jsonb_typeof(v_op -> 'fields') = 'array'
             and exists (select 1 from pg_catalog.jsonb_array_elements(v_op -> 'fields') as f(value)
                          where pg_catalog.jsonb_typeof(f.value) <> 'string'))
         or (coalesce(pg_catalog.jsonb_typeof(v_op -> 'base_version'), 'null') <> 'null'
             and (pg_catalog.jsonb_typeof(v_op -> 'base_version') <> 'number'
                  or (v_op ->> 'base_version') !~ c_version))
         or (coalesce(pg_catalog.jsonb_typeof(v_op -> 'draft_id'), 'null') = 'null')
            <> (coalesce(pg_catalog.jsonb_typeof(v_op -> 'expected_version'), 'null') = 'null')
         or (coalesce(pg_catalog.jsonb_typeof(v_op -> 'draft_id'), 'null') <> 'null'
             and ((v_op ->> 'draft_id') !~ c_uuid
                  or pg_catalog.jsonb_typeof(v_op -> 'expected_version') <> 'number'
                  or (v_op ->> 'expected_version') !~ c_version)) then
        raise exception 'write_drafts: a put change has the wrong shape' using errcode = '22023';
      end if;
    elsif v_action = 'discard' then
      select pg_catalog.string_agg(k.key, ', ') into v_bad
        from pg_catalog.jsonb_object_keys(v_op) as k(key)
       where k.key <> all (array['action', 'draft_id', 'expected_version', 'entity_type', 'entity_id']);
      if v_bad is not null
         or coalesce(v_op ->> 'draft_id', '') !~ c_uuid
         or coalesce(v_op ->> 'expected_version', '') !~ c_version
         or pg_catalog.jsonb_typeof(v_op -> 'expected_version') is distinct from 'number'
         or coalesce(pg_catalog.jsonb_typeof(v_op -> 'entity_type'), 'null') not in ('null', 'string')
         or (coalesce(pg_catalog.jsonb_typeof(v_op -> 'entity_id'), 'null') <> 'null'
             and (v_op ->> 'entity_id') !~ c_uuid) then
        raise exception 'write_drafts: a discard names its draft and the version read'
          using errcode = '22023';
      end if;
    else
      raise exception 'write_drafts: a change is a put or a discard' using errcode = '22023';
    end if;
  end loop;

  -- The writes, in a fixed order.
  for v_op in
    select x.value
      from pg_catalog.jsonb_array_elements(p_ops) with ordinality as x(value, ord)
     order by x.value ->> 'entity_type' nulls first,
              pg_catalog.lower(x.value ->> 'entity_id') nulls first,
              pg_catalog.lower(x.value ->> 'draft_id') nulls first,
              x.ord
  loop
    v_action := v_op ->> 'action';
    v_type := v_op ->> 'entity_type';
    v_entity := (v_op ->> 'entity_id')::uuid;
    v_draft := (v_op ->> 'draft_id')::uuid;
    v_expected := (v_op ->> 'expected_version')::int;
    v_id := null;
    v_version := null;

    if v_action = 'put' then
      v_payload := case when pg_catalog.jsonb_typeof(v_op -> 'payload') = 'object'
                        then v_op -> 'payload' else '{}'::jsonb end;
      v_base := case when pg_catalog.jsonb_typeof(v_op -> 'base') = 'object'
                     then v_op -> 'base' else '{}'::jsonb end;
      v_label := case when pg_catalog.jsonb_typeof(v_op -> 'label') = 'object'
                      then v_op -> 'label' end;
      v_fields := case when pg_catalog.jsonb_typeof(v_op -> 'fields') = 'array'
                       then array(select pg_catalog.jsonb_array_elements_text(v_op -> 'fields'))
                       else '{}'::text[] end;
      v_base_version := (v_op ->> 'base_version')::int;
      begin
        if v_draft is null then
          insert into public.content_drafts
            (tenant_id, entity_type, entity_id, op, payload, fields, base, base_version, label)
          values (p_tenant, v_type, v_entity, v_op ->> 'op', v_payload, v_fields, v_base,
                  v_base_version, v_label)
          returning id, version into v_id, v_version;
        else
          update public.content_drafts d
             set op = v_op ->> 'op', payload = v_payload, fields = v_fields, base = v_base,
                 base_version = v_base_version, label = v_label
           where d.tenant_id = p_tenant and d.id = v_draft and d.version = v_expected
             and d.entity_type = v_type and d.entity_id = v_entity
          returning d.id, d.version into v_id, v_version;
        end if;
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint in ('content_drafts_one_per_entity', 'content_drafts_one_seo_create') then
          raise exception 'write_drafts: this item already has a pending change'
            using errcode = 'BR409',
                  detail = pg_catalog.jsonb_build_object(
                    'code', 'draft-conflict', 'draft_id', v_draft,
                    'entity_type', v_type, 'entity_id', v_entity)::text;
        end if;
        raise;
      end;
    else
      delete from public.content_drafts d
       where d.tenant_id = p_tenant and d.id = v_draft and d.version = v_expected
         and (v_type is null or d.entity_type = v_type)
         and (v_entity is null or d.entity_id = v_entity)
      returning d.id, d.entity_type, d.entity_id into v_id, v_type, v_entity;
    end if;

    -- An edit or a discard that touched no row: say why.
    if v_id is null then
      select d.release_id, d.version, d.entity_type, d.entity_id into v_found
        from public.content_drafts d
       where d.tenant_id = p_tenant and d.id = v_draft;
      if found and v_found.release_id is not null then
        raise exception 'write_drafts: the pending change is claimed by a scheduled release'
          using errcode = 'BR409',
                detail = pg_catalog.jsonb_build_object(
                  'code', 'scheduled', 'draft_id', v_draft,
                  'entity_type', v_found.entity_type, 'entity_id', v_found.entity_id)::text;
      end if;
      if found and v_found.version = v_expected
         and (v_type is null or v_found.entity_type = v_type)
         and (v_entity is null or v_found.entity_id = v_entity) then
        -- The draft is there as named: RLS refused it (a profile that is not live, releases
        -- off for an edit, or a role that may not stage this change).
        raise exception 'write_drafts: permission denied for this pending change'
          using errcode = '42501';
      end if;
      raise exception 'write_drafts: the pending change moved on or is gone'
        using errcode = 'BR409',
              detail = pg_catalog.jsonb_build_object(
                'code', 'draft-conflict', 'draft_id', v_draft,
                'entity_type', coalesce(v_type, v_found.entity_type),
                'entity_id', coalesce(v_entity, v_found.entity_id))::text;
    end if;

    v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'action', v_action, 'draft_id', v_id, 'entity_type', v_type, 'entity_id', v_entity,
      'version', v_version));
  end loop;
  return v_out;
end $$;
revoke all on function public.write_drafts(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.write_drafts(uuid, jsonb) to authenticated;
comment on function public.write_drafts(uuid, jsonb) is
  'Admin v2 R3a (0062): the one writer of staff drafts. Invoker: RLS, the live/flag/key '
  'policies and the draft lock bind as for a direct write; one transaction per call.';

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair of parentheses; a function's schema
-- printed only when it is not on the search path, so the patterns allow both).
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  v_live constant text := '\(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\)';
  v_flag constant text := '(public\.)?releases_enabled\(tenant_id\)';
  v_key constant text := '(app\.)?draft_key_ok\(entity_type, entity_id, tenant_id\)';
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_want text[];
  v_have text[];
  v_bad text;
  p text;
begin
  -- ---- content_drafts: exactly these table privileges, for every API role --------------
  -- authenticated and service_role: select, insert, update, delete; anon and PUBLIC:
  -- nothing; no truncate, references, trigger (or maintain) for anyone.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (
      select x.who, pr.priv,
             has_table_privilege(x.who::name, 'public.content_drafts', pr.priv) as held,
             pr.priv = any (x.allowed) as wanted
        from (values
          ('public', array[]::text[]),
          ('anon', array[]::text[]),
          ('authenticated', array['select', 'insert', 'update', 'delete']),
          ('service_role', array['select', 'insert', 'update', 'delete'])
        ) as x(who, allowed)
        cross join unnest(v_privs) as pr(priv)
    ) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0062: wrong privileges on content_drafts: %', v_bad;
  end if;
  -- No column-level grant: the table privileges above are the whole surface.
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.content_drafts'::regclass
                and a.attnum > 0 and not a.attisdropped and a.attacl is not null) then
    raise exception '0062: content_drafts carries a column-level grant';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.content_drafts'::regclass) then
    raise exception '0062: content_drafts is not ENABLE + FORCE row level security';
  end if;

  -- ---- The policy set on content_drafts: 0038's four and these three, exactly ---------
  v_want := array[
    'content_drafts_delete DELETE PERMISSIVE {authenticated}',
    'content_drafts_insert INSERT PERMISSIVE {authenticated}',
    'content_drafts_live_delete DELETE RESTRICTIVE {authenticated}',
    'content_drafts_live_insert INSERT RESTRICTIVE {authenticated}',
    'content_drafts_live_update UPDATE RESTRICTIVE {authenticated}',
    'content_drafts_read SELECT PERMISSIVE {authenticated}',
    'content_drafts_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles) order by policyname)
    into v_have
    from pg_policies
   where schemaname = 'public' and tablename = 'content_drafts';
  if v_have is distinct from v_want then
    raise exception '0062: content_drafts policies are %, expected %', v_have, v_want;
  end if;

  -- ---- Every USING and WITH CHECK on the table leads with the tenant predicate --------
  select string_agg(policyname, ', ' order by policyname) into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'content_drafts'
     and (coalesce(qual, with_check) is null
          or qual !~ v_tenant_first
          or with_check !~ v_tenant_first);
  if v_bad is not null then
    raise exception '0062: content_drafts policies that do not lead with the tenant: %', v_bad;
  end if;

  -- ---- The three RESTRICTIVE policies say exactly this --------------------------------
  -- insert: tenant, live, releases on, singleton key.
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_drafts'
                    and policyname = 'content_drafts_live_insert' and qual is null
                    and with_check ~ ('^\(' || v_tenant || ' AND ' || v_live || ' AND '
                                      || v_flag || ' AND ' || v_key || '\)$')) then
    raise exception '0062: content_drafts_live_insert is not tenant, live, releases on, key';
  end if;
  -- update: tenant, live, releases on (USING); and the key too (WITH CHECK).
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_drafts'
                    and policyname = 'content_drafts_live_update'
                    and qual ~ ('^\(' || v_tenant || ' AND ' || v_live || ' AND ' || v_flag || '\)$')
                    and with_check ~ ('^\(' || v_tenant || ' AND ' || v_live || ' AND '
                                      || v_flag || ' AND ' || v_key || '\)$')) then
    raise exception '0062: content_drafts_live_update is not tenant, live, releases on (and key)';
  end if;
  -- delete: tenant and live only (a discard never changes the site).
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_drafts'
                    and policyname = 'content_drafts_live_delete' and with_check is null
                    and qual ~ ('^\(' || v_tenant || ' AND ' || v_live || '\)$')) then
    raise exception '0062: content_drafts_live_delete is not tenant and live';
  end if;

  -- ---- The draft lock is still the only trigger on content_drafts (0038) --------------
  if (select string_agg(format('%s %s.%s %s', tg.tgname, n.nspname, f.proname, tg.tgtype), ', ')
        from pg_trigger tg
        join pg_proc f on f.oid = tg.tgfoid
        join pg_namespace n on n.oid = f.pronamespace
       where tg.tgrelid = 'public.content_drafts'::regclass and not tg.tgisinternal)
     is distinct from 'content_drafts_lock app.tg_draft_lock 31' then
    raise exception '0062: content_drafts must carry exactly one trigger, the draft lock';
  end if;

  -- ---- The lock pins the provenance, and stays a trigger nobody calls ----------------
  if not exists (select 1 from pg_proc
                  where oid = 'app.tg_draft_lock()'::regprocedure and not prosecdef
                    and proconfig = array['search_path=""']
                    and prosrc ~ 'new\.origin_kind := null'
                    and prosrc ~ 'new\.origin_release_id := old\.origin_release_id')
     or has_function_privilege('anon', 'app.tg_draft_lock()', 'execute')
     or has_function_privilege('authenticated', 'app.tg_draft_lock()', 'execute')
     or has_function_privilege('service_role', 'app.tg_draft_lock()', 'execute')
     or has_function_privilege('public', 'app.tg_draft_lock()', 'execute') then
    raise exception '0062: app.tg_draft_lock must pin the provenance and be callable by no API role';
  end if;

  -- ---- Functions: who may call what, and how they run --------------------------------
  foreach p in array array['public.releases_enabled(uuid)', 'public.write_drafts(uuid, jsonb)',
                           'app.draft_key_ok(text, uuid, uuid)', 'app.live_role()'] loop
    if not has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('public', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0062: % must be executable by authenticated only', p;
    end if;
  end loop;
  if not exists (select 1 from pg_proc
                  where oid = 'public.releases_enabled(uuid)'::regprocedure
                    and prosecdef and proconfig = array['search_path=""']
                    and provolatile = 's') then
    raise exception '0062: public.releases_enabled must be a STABLE SECURITY DEFINER with search_path ''''';
  end if;
  foreach p in array array['public.write_drafts(uuid, jsonb)', 'app.draft_key_ok(text, uuid, uuid)'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and not prosecdef
                      and proconfig = array['search_path=""']) then
      raise exception '0062: % must be SECURITY INVOKER with search_path ''''', p;
    end if;
  end loop;
  -- The flag reader reads app.release_tenants (FORCE RLS, no policy) through
  -- app.releases_enabled: its owner bypasses RLS, or every tenant would read as off.
  if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                  where f.oid = 'public.releases_enabled(uuid)'::regprocedure
                    and (r.rolsuper or r.rolbypassrls)) then
    raise exception '0062: public.releases_enabled is owned by a role that does not bypass RLS';
  end if;
  -- The flag table itself stays unreachable, and its definer reader the service role's.
  if has_function_privilege('authenticated', 'app.releases_enabled(uuid)', 'execute')
     or not has_function_privilege('service_role', 'app.releases_enabled(uuid)', 'execute') then
    raise exception '0062: app.releases_enabled(uuid) must stay the service role''s alone (0051)';
  end if;
  -- The draft writer never sets a GUC (R4's catalog rows pin which exposed functions may).
  if exists (select 1 from pg_proc
              where oid = 'public.write_drafts(uuid, jsonb)'::regprocedure
                and prosrc ~* 'set_config') then
    raise exception '0062: public.write_drafts must not call set_config';
  end if;

  -- ---- Releases are still off everywhere (0038, 0051) --------------------------------
  if exists (select 1 from app.release_tenants) then
    raise exception '0062: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
