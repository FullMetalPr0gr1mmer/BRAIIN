-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0107: scheduled releases, and switching releases on and off (Admin v2 R11; docs/admin-v2/
-- releases.md A3-9, A3-14, §4.7, §8 edge cases 8, 9 and 21, §10). A PLACEHOLDER number: the
-- next free one is assigned at merge (scripts/renumber-migration.mjs).
--
-- Expand only, and inert: releases stay off for every tenant (app.release_tenants is empty
-- until R14), every new path below refuses a tenant whose releases are off (55000), and the
-- runbook's two switches are run by nobody until then. Depends on 0038 (the ledger, the
-- registry, the draft lock), 0051 and 0104 (apply_release as R10 left it), 0062 (staged
-- drafts), 0066 (the guard, app.publish_scheduled skipping a tenant with releases on), 0098
-- (app.publish_scheduled's table list as it stands) and 0103 (the minute cron's purge claim).
--
--   • content_releases.fire_lease_until: when the minute cron's claim on a due scheduled
--     release ends (two minutes), so two runs never fire one release at once; and a partial
--     index over scheduled releases by their time.
--   • public.apply_release (0104's body) restated with two more modes. `schedule`: the same
--     checks as a publish (the person live, the drafts as they saw them, the bases), then the
--     changes as a dry run, as that person; when nothing stands in the way the release is
--     stored `scheduled` with the validated changes, their drafts claimed, and a
--     `release.schedule` audit row naming the scheduler, in one transaction. `fire`: a due
--     scheduled release applied exactly as a publish, as the person who scheduled it (their
--     live profile, their RLS), from the changes it stored, its drafts the ones it claimed; a
--     release no longer scheduled or not yet due is left alone (a second run is a no-op). Both
--     read the switch again under the tenant's release lock. Every other mode is 0104's.
--   • public.claim_scheduled_releases(limit): the minute cron's claim of the due scheduled
--     releases, oldest first, SKIP LOCKED and leased, with what the Worker re-checks: the
--     scheduler's live profile and each change's type, operation and status.
--   • public.fail_scheduled_release(tenant, release, code, draft_ids): a scheduled release
--     that could not go live is `failed` with a code (never a message), its claims released.
--   • public.reschedule_release / public.unschedule_release: a scheduled release moved to
--     another time (and from then on going live as the person who moved it) or cancelled (its
--     claims released), version-checked, by a person live whose role may publish every change
--     it holds (the registry's author and delete roles, the roles RLS lets write them),
--     audited in the same transaction.
--   • app.enable_releases(tenant, operator, fallback_scheduler) and
--     app.disable_releases(tenant, operator, discard_pending): the runbook's switches (R14).
--     Owner only, audited, refused while a release is publishing. See their own comments for
--     the rules, recorded in docs/admin-v2/as-built/R11.md.
--
-- Every function: `search_path ''` and qualified names; the five public ones SECURITY INVOKER
-- with EXECUTE for the service role alone, the two switches SECURITY INVOKER with EXECUTE for
-- no API role. None but apply_release sets a setting or switches role (R4's and R5's catalog
-- rules). No table, no capability, no app.role_* helper, no registry row, no screen, no help
-- guide. Grants are stated for both Supabase grant regimes (Admin v2 P-14). Postconditions at
-- the end.
--
-- CLAUDE.md §3 (Pillar 1, Pillar 4), §8 (Admin v2 lanes, Releases), §9, §10.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy content_releases or content_drafts fails the push instead of queueing behind it.
set local lock_timeout = '5s';

-- ═══ 1. The fire lease ═══════════════════════════════════════════════════════════════════
-- RELEASE_FIRE_LEASE_MINUTES (src/lib/cron/releases.ts; tests/lib/releaseScheduleSql.spec.ts
-- holds the two equal). Null while no run holds the release.
alter table public.content_releases add column if not exists fire_lease_until timestamptz;
comment on column public.content_releases.fire_lease_until is
  'Admin v2 R11: while set and in the future, a minute cron run holds this scheduled release '
  '(public.claim_scheduled_releases); cleared when it goes live, fails or is cancelled.';
create index if not exists content_releases_scheduled_due_idx
  on public.content_releases (scheduled_for) where status = 'scheduled';

-- ═══ 2. apply_release, with schedule and fire (0104 restated) ═════════════════════════════
-- 0104's body, unchanged but for the passages marked R11: the two modes, the switch read again
-- under the lock (every mode: app.disable_releases takes the same lock), a fire's drafts being
-- the ones its release claimed, and a schedule stored after its dry run. The publish and
-- dry-run paths are otherwise 0104's, statement for statement (the shape is pinned by
-- tests/lib/releaseApplySql.spec.ts, the behaviour by release_apply.test.sql, unchanged). The
-- next restatement builds on this one.
create or replace function public.apply_release(
  p_actor uuid,
  p_role text,
  p_mode text,
  p_items jsonb,
  p_note text default null,
  p_kind text default 'publish',
  p_restores_release_id uuid default null,
  p_release_id uuid default null,
  p_scheduled_for timestamptz default null
) returns jsonb
  language plpgsql volatile security invoker
  set search_path = '' set statement_timeout = '20s' set lock_timeout = '5s'
as $$
declare
  -- RELEASE_MAX_ITEMS (packages/schemas/release.ts; tests/schemas/release.spec.ts holds them equal).
  c_max_items constant int := 60;
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_name constant text := '^[A-Za-z][A-Za-z0-9_]{0,62}$';
  v_tenant uuid;
  v_release uuid := pg_catalog.gen_random_uuid();
  v_number int;
  v_reg app.release_entities;
  v_item jsonb;
  v_ord bigint;
  v_it jsonb;
  v_batch jsonb;
  v_plan jsonb := '[]'::jsonb;
  v_first jsonb := '[]'::jsonb;
  v_second jsonb := '[]'::jsonb;
  v_removals jsonb := '[]'::jsonb;
  v_batches jsonb;
  v_children jsonb;
  v_sids jsonb;
  v_media jsonb;
  v_patch jsonb;
  v_row jsonb;
  v_live jsonb;
  v_live_pub jsonb := '{}'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_skip jsonb := '{}'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_failed jsonb := '{}'::jsonb;
  v_child_items jsonb := '[]'::jsonb;
  v_child_before jsonb;
  v_child_after jsonb;
  v_stale jsonb;
  v_draft_bases jsonb;
  v_restored jsonb := '{}'::jsonb;
  v_pub jsonb;
  v_fail jsonb;
  v_result jsonb;
  v_cols text[];
  v_deferred text[];
  v_moved text[];
  v_draft_ids uuid[];
  v_areas text[];
  v_bad text;
  v_list text;
  v_list_cols text;
  v_list_sel text;
  v_sql text;
  v_current text;
  v_n bigint;
  v_live_args jsonb;
  v_base_args jsonb;
  v_saved_claims text;
  v_saved_sub text;
  v_saved_role text;
  -- R11: what the release names. A fire takes its changes, note and kind from the
  -- scheduled release it fires; every other mode from its arguments.
  v_items jsonb := p_items;
  v_note text := p_note;
  v_kind text := p_kind;
  v_restores uuid := p_restores_release_id;
  v_rel public.content_releases;
  v_payload jsonb;
  v_state text;
  v_msg text;
  v_det text;
  v_con text;
  v_col text;
begin
  -- ── 0. Who may call, and the shape of the call ─────────────────────────────────────────
  -- The service role only: EXECUTE says so, and so does this (verification Q1f(2): a
  -- postgres-owned definer in an exposed schema must not reach it either).
  if current_user::text <> 'service_role' then
    raise exception 'apply_release: only the service role applies a release' using errcode = '42501';
  end if;
  -- R11: four modes. `schedule` checks a release as a publish would, runs it as a dry
  -- run, and stores it, its drafts claimed, for its time; `fire` applies a scheduled release
  -- as the person who scheduled it, exactly as a publish, from the changes it stored.
  if p_mode is null or p_mode not in ('publish', 'dry_run', 'schedule', 'fire') then
    raise exception 'apply_release: the mode is publish, dry_run, schedule or fire' using errcode = '22023';
  end if;
  if (p_mode = 'fire') <> (p_release_id is not null) then
    raise exception 'apply_release: a fire names the scheduled release, and only a fire does'
      using errcode = '22023';
  end if;
  if (p_mode = 'schedule') <> (p_scheduled_for is not null) then
    raise exception 'apply_release: a schedule names its time, and only a schedule does'
      using errcode = '22023';
  end if;
  -- RELEASE_SCHEDULE_MIN_MINUTES and RELEASE_SCHEDULE_MAX_DAYS (packages/schemas/release.ts)
  -- are the Worker's tighter bounds; the database refuses anything outside these.
  if p_mode = 'schedule'
     and (p_scheduled_for < pg_catalog.now() + interval '1 minute'
          or p_scheduled_for > pg_catalog.now() + interval '366 days') then
    raise exception 'apply_release: a release is scheduled at least a minute ahead and at most 366 days ahead'
      using errcode = '22023';
  end if;
  if p_mode <> 'fire' and (p_kind is null or p_kind not in ('publish', 'rollback')
     or (p_kind = 'rollback') <> (p_restores_release_id is not null)) then
    raise exception 'apply_release: a publish restores nothing, and a rollback names the version it restores'
      using errcode = '22023';
  end if;
  if p_mode = 'schedule' and p_kind <> 'publish' then
    raise exception 'apply_release: a rollback goes live when it is published; it is never scheduled'
      using errcode = '22023';
  end if;
  if p_mode = 'fire' then
    if p_items is not null or p_note is not null or p_restores_release_id is not null
       or p_kind is distinct from 'publish' then
      raise exception 'apply_release: a fire takes its changes, note and kind from the release'
        using errcode = '22023';
    end if;
    -- The release, read here for its changes (checked below as any publish's are) and read
    -- again, locked, once the tenant's release lock is held. A release that is not scheduled
    -- or not due is not an error: a second run of the cron, or a release unscheduled or moved
    -- since it was claimed, does nothing.
    select r.* into v_rel from public.content_releases r where r.id = p_release_id;
    if not found then
      raise exception 'apply_release: no such release' using errcode = 'P0002';
    end if;
    if v_rel.status <> 'scheduled' or v_rel.scheduled_for > pg_catalog.now() then
      return pg_catalog.jsonb_build_object('mode', 'fire', 'release_id', p_release_id,
                                           'skipped', true, 'status', v_rel.status);
    end if;
    if v_rel.scheduled_by is distinct from p_actor then
      raise exception 'apply_release: a release goes live as the person who scheduled it'
        using errcode = '22023';
    end if;
    if v_rel.kind not in ('publish', 'legacy_schedule') or v_rel.restores_release_id is not null then
      raise exception 'apply_release: only a publish or a legacy schedule is fired'
        using errcode = '22023';
    end if;
    v_items := v_rel.payload;
    v_note := v_rel.note;
    v_kind := v_rel.kind;
    v_restores := null;
  end if;
  if p_actor is null or p_role is null then
    raise exception 'apply_release: the person publishing and their role are required' using errcode = '22023';
  end if;
  if p_note is not null and (pg_catalog.char_length(p_note) > 280 or p_note ~ '[[:cntrl:]]') then
    raise exception 'apply_release: a release note is at most 280 characters, with no control characters'
      using errcode = '22023';
  end if;
  if v_items is null or pg_catalog.jsonb_typeof(v_items) is distinct from 'array' then
    raise exception 'apply_release: the changes are an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_items) not between 1 and c_max_items then
    raise exception 'apply_release: a release holds 1 to 60 changes' using errcode = '22023';
  end if;

  for v_item, v_ord in
    select e.value, e.ord from pg_catalog.jsonb_array_elements(v_items) with ordinality as e(value, ord)
  loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'apply_release: change % is not an object', v_ord using errcode = '22023';
    end if;
    if coalesce(
         not (v_item ?& array['draft_id', 'draft_version', 'entity_type', 'entity_id', 'op', 'patch', 'base'])
         or exists (select 1 from pg_catalog.jsonb_object_keys(v_item) as k(key)
                     where k.key <> all (array['draft_id', 'draft_version', 'entity_type', 'entity_id',
                                               'op', 'patch', 'base', 'children']))
         or pg_catalog.jsonb_typeof(v_item -> 'draft_id') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_item -> 'entity_id') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_item -> 'draft_version') is distinct from 'number'
         or pg_catalog.jsonb_typeof(v_item -> 'entity_type') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_item -> 'op') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_item -> 'patch') is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_item -> 'base') is distinct from 'object',
         true) then
      raise exception 'apply_release: change % must be exactly {draft_id, draft_version, entity_type, entity_id, op, patch, base[, children]}', v_ord
        using errcode = '22023';
    end if;
    if coalesce(
         (v_item ->> 'draft_id') !~* c_uuid
         or (v_item ->> 'entity_id') !~* c_uuid
         or (v_item ->> 'draft_version') !~ '^[1-9][0-9]{0,8}$'
         or (v_item ->> 'op') not in ('create', 'update', 'delete'),
         true) then
      raise exception 'apply_release: change % has a malformed id, version or operation', v_ord
        using errcode = '22023';
    end if;
    -- The ids in their canonical (lower-case) spelling, so every comparison below, the
    -- duplicate check and the capture trigger's match included, sees one spelling.
    v_item := v_item || pg_catalog.jsonb_build_object(
      'draft_id', (v_item ->> 'draft_id')::uuid, 'entity_id', (v_item ->> 'entity_id')::uuid);
    v_plan := v_plan || pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('ord', v_ord));
  end loop;
  if (select count(distinct x.value ->> 'draft_id') from pg_catalog.jsonb_array_elements(v_plan) as x(value))
     <> pg_catalog.jsonb_array_length(v_plan) then
    raise exception 'apply_release: a change is listed twice' using errcode = '22023';
  end if;

  -- ── 1. The person publishing, live ─────────────────────────────────────────────────────
  -- Active, unlocked, holding the role named (a demoted person's old token names the old
  -- one), a CMS role. The tenant is theirs, never the caller's choice.
  select p.tenant_id into v_tenant
    from public.profiles p
   where p.id = p_actor
     and p.is_active
     and (p.locked_until is null or p.locked_until <= pg_catalog.now())
     and p.role::text = p_role
     and p.role::text in ('admin', 'content_creator', 'seo', 'developer');
  if v_tenant is null or (p_mode = 'fire' and v_rel.tenant_id is distinct from v_tenant) then
    raise exception 'apply_release: this person cannot publish now' using errcode = 'BR403',
      detail = pg_catalog.jsonb_build_object('code', 'actor')::text;
  end if;
  if not app.releases_enabled(v_tenant) then
    raise exception 'apply_release: releases are not switched on for this site' using errcode = '55000';
  end if;

  -- ── 2. One release at a time per tenant ────────────────────────────────────────────────
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || v_tenant::text, 0));
  -- R11: the switch, read again under the lock. app.disable_releases takes the same
  -- lock, so a release that waited for it finds the tenant as the switch left it.
  if not app.releases_enabled(v_tenant) then
    raise exception 'apply_release: releases are not switched on for this site' using errcode = '55000';
  end if;
  -- R11: a fire's release, locked: still scheduled and due, or nothing is done. Its
  -- changes are the ones read above: a scheduled release's payload is written once, by its
  -- schedule, and no path changes it.
  if p_mode = 'fire' then
    select r.* into v_rel from public.content_releases r
     where r.tenant_id = v_tenant and r.id = p_release_id
       for update;
    if not found or v_rel.status <> 'scheduled' or v_rel.scheduled_for > pg_catalog.now() then
      return pg_catalog.jsonb_build_object('mode', 'fire', 'release_id', p_release_id,
                                           'skipped', true, 'status', v_rel.status);
    end if;
  end if;

  -- ── 3. Each change against the registry, then against its draft (as the service role) ──
  for v_it in select x.value from pg_catalog.jsonb_array_elements(v_plan) as x(value) loop
    select e.* into v_reg from app.release_entities e where e.entity_type = v_it ->> 'entity_type';
    if not found then
      raise exception 'apply_release: change % names a type no release manages', v_it ->> 'ord'
        using errcode = '22023';
    end if;
    v_patch := v_it -> 'patch';
    select coalesce(array_agg(k.key order by k.key), '{}'::text[]) into v_cols
      from pg_catalog.jsonb_object_keys(v_patch) as k(key);
    select string_agg(c.col, ', ' order by c.col) into v_bad
      from unnest(v_cols) as c(col) where c.col = any (v_reg.exempt_columns);
    if v_bad is not null then
      raise exception 'apply_release: % on % stays immediate and is never part of a release', v_bad, v_reg.table_name
        using errcode = '22023';
    end if;
    select string_agg(case when c.col ~ c_name then c.col else '(not a column name)' end, ', ' order by c.col)
      into v_bad
      from unnest(v_cols) as c(col) where c.col <> all (v_reg.columns);
    if v_bad is not null then
      raise exception 'apply_release: a release may not write % on %', v_bad, v_reg.table_name
        using errcode = '22023';
    end if;
    if v_reg.has_status and (v_patch ->> 'status') = 'scheduled' then
      raise exception 'apply_release: a change is never scheduled on its own; schedule the release (R11)'
        using errcode = '22023';
    end if;
    if v_reg.key_column = 'tenant_id' then
      if (v_it ->> 'entity_id')::uuid is distinct from v_tenant then
        raise exception 'apply_release: a % change is keyed by its tenant', v_reg.entity_type
          using errcode = '22023';
      end if;
      if v_it ->> 'op' = 'delete' then
        raise exception 'apply_release: % is never removed', v_reg.entity_type using errcode = '22023';
      end if;
    end if;

    v_children := nullif(v_it -> 'children', 'null'::jsonb);
    if v_children is not null then
      if v_reg.entity_type <> 'portfolio' or v_it ->> 'op' = 'delete' then
        raise exception 'apply_release: only a case study that stays carries link sets' using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(v_children) <> 'object'
         or exists (select 1 from pg_catalog.jsonb_object_keys(v_children) as k(key)
                     where k.key not in ('service_ids', 'media')) then
        raise exception 'apply_release: link sets are {service_ids?, media?}' using errcode = '22023';
      end if;
      v_sids := nullif(v_children -> 'service_ids', 'null'::jsonb);
      if v_sids is not null then
        if pg_catalog.jsonb_typeof(v_sids) <> 'array' then
          raise exception 'apply_release: service_ids is an array of ids' using errcode = '22023';
        end if;
        if exists (select 1 from pg_catalog.jsonb_array_elements(v_sids) as s(value)
                    where pg_catalog.jsonb_typeof(s.value) <> 'string' or (s.value #>> '{}') !~* c_uuid) then
          raise exception 'apply_release: service_ids is an array of ids' using errcode = '22023';
        end if;
      end if;
      v_media := nullif(v_children -> 'media', 'null'::jsonb);
      if v_media is not null and pg_catalog.jsonb_typeof(v_media) <> 'array' then
        raise exception 'apply_release: media is an array' using errcode = '22023';
      end if;
      if v_sids is null and v_media is null then
        raise exception 'apply_release: link sets name at least one set (service_ids or media)'
          using errcode = '22023';
      end if;
      v_children := pg_catalog.jsonb_build_object('service_ids', v_sids, 'media', v_media);
    end if;

    if v_it ->> 'op' = 'delete' and v_patch <> '{}'::jsonb then
      raise exception 'apply_release: a removal carries no patch' using errcode = '22023';
    end if;
    if v_it ->> 'op' = 'update' and v_patch = '{}'::jsonb and v_children is null then
      raise exception 'apply_release: change % changes nothing', v_it ->> 'ord' using errcode = '22023';
    end if;
    select coalesce(array_agg(c.col order by c.col), '{}'::text[]) into v_deferred
      from unnest(v_cols) as c(col) where c.col = any (v_reg.deferred_columns);
    v_first := v_first || pg_catalog.jsonb_build_array(
      v_it || pg_catalog.jsonb_build_object(
        'table', v_reg.table_name,
        'key', v_reg.key_column,
        'area', v_reg.area,
        'apply_order', v_reg.apply_order,
        'children', v_children,
        'deferred', pg_catalog.to_jsonb(v_deferred),
        'unique_set', exists (select 1 from unnest(v_reg.unique_flags) as f(flag)
                               where v_patch -> f.flag = 'true'::jsonb),
        'has_published_at', v_reg.has_status and exists (
          select 1 from pg_catalog.pg_attribute a
           where a.attrelid = pg_catalog.format('public.%I', v_reg.table_name)::regclass
             and a.attname = 'published_at' and a.attnum > 0 and not a.attisdropped)));
  end loop;
  v_plan := v_first;
  v_first := '[]'::jsonb;

  -- The drafts: locked, in id order, and each still the one the publisher saw: its
  -- version, entity, operation, and, for an update, the base it holds for every column the
  -- change names (the conflict check reads the draft's own base, never the request's).
  -- Another tenant's draft is not found here, as a missing one is not.
  select array_agg((x.value ->> 'draft_id')::uuid order by (x.value ->> 'draft_id')::uuid)
    into v_draft_ids
    from pg_catalog.jsonb_array_elements(v_plan) as x(value);
  perform 1 from public.content_drafts d
    where d.tenant_id = v_tenant and d.id = any (v_draft_ids)
    order by d.id
    for update;
  select coalesce(pg_catalog.jsonb_agg(i.draft_id order by i.draft_id), '[]'::jsonb) into v_stale
    from pg_catalog.jsonb_to_recordset(v_plan)
           as i(draft_id uuid, draft_version int, entity_type text, entity_id uuid, op text,
                patch jsonb, base jsonb)
   where not exists (
     select 1 from public.content_drafts d
      where d.tenant_id = v_tenant and d.id = i.draft_id
        -- R11: unclaimed, or (a fire) claimed by the release it fires.
        and (case when p_mode = 'fire' then d.release_id is not distinct from p_release_id
                  else d.release_id is null end)
        and d.version = i.draft_version and d.entity_type = i.entity_type
        and d.entity_id = i.entity_id and d.op = i.op
        and (i.op <> 'update' or (
              select coalesce(pg_catalog.jsonb_object_agg(k.key, i.base -> k.key)
                                filter (where i.base ? k.key), '{}'::jsonb)
                from pg_catalog.jsonb_object_keys(i.patch) as k(key))
            = (select coalesce(pg_catalog.jsonb_object_agg(k.key, d.base -> k.key)
                                 filter (where d.base ? k.key), '{}'::jsonb)
                 from pg_catalog.jsonb_object_keys(i.patch) as k(key))));
  if pg_catalog.jsonb_array_length(v_stale) > 0 then
    raise exception 'apply_release: a pending change moved since it was read' using errcode = 'BR409',
      detail = pg_catalog.jsonb_build_object('code', 'pending-changed', 'draftIds', v_stale)::text;
  end if;
  select coalesce(pg_catalog.jsonb_object_agg(d.id, d.base), '{}'::jsonb) into v_draft_bases
    from public.content_drafts d
   where d.tenant_id = v_tenant and d.id = any (v_draft_ids);
  -- 0104 (R10): the creates a restore staged (its mark, which only the service role sets and
  -- the draft lock pins): each brings back a row the ledger saw removed.
  select coalesce(pg_catalog.jsonb_object_agg(d.id, true), '{}'::jsonb) into v_restored
    from public.content_drafts d
   where d.tenant_id = v_tenant and d.id = any (v_draft_ids)
     and d.op = 'create' and d.origin_kind = 'restore';
  -- Every column an update changes needs its base, or a conflict could not be seen.
  for v_it in
    select x.value from pg_catalog.jsonb_array_elements(v_plan) as x(value)
     where x.value ->> 'op' = 'update'
     order by (x.value ->> 'ord')::int
  loop
    select string_agg(k.key, ', ' order by k.key) into v_bad
      from pg_catalog.jsonb_object_keys(v_it -> 'patch') as k(key)
     where not ((v_draft_bases -> (v_it ->> 'draft_id')) ? k.key);
    if v_bad is not null then
      raise exception 'apply_release: a pending change carries no base for %', v_bad
        using errcode = 'BR422',
              detail = pg_catalog.jsonb_build_object(
                'code', 'base-missing', 'draftId', v_it ->> 'draft_id',
                'columns', pg_catalog.to_jsonb(pg_catalog.string_to_array(v_bad, ', ')))::text;
    end if;
  end loop;
  if v_restores is not null and not exists (
       select 1 from public.content_releases r
        where r.tenant_id = v_tenant and r.id = v_restores and r.status = 'published') then
    raise exception 'apply_release: a rollback restores a published version of this site' using errcode = '22023';
  end if;

  select pg_catalog.array_agg(distinct x.value ->> 'area' order by x.value ->> 'area') into v_areas
    from pg_catalog.jsonb_array_elements(v_plan) as x(value);
  -- The number it will take: max + 1 under the lock (a dry run uses none).
  select coalesce(max(r.number), 0) + 1 into v_number
    from public.content_releases r where r.tenant_id = v_tenant;

  -- ── 4 to 8, in one block: a dry run ends it with BRDRY, which undoes all of it ─────────
  begin
    -- 4. The release, applying, in the publisher's tenant (named: the column default would
    -- read the service role's claims, verification Q1f(1)).
    -- R11: a fire's release is the scheduled row itself, now applying.
    if p_mode = 'fire' then
      v_release := p_release_id;
      update public.content_releases as r set status = 'applying', fire_lease_until = null
       where r.tenant_id = v_tenant and r.id = v_release;
    else
      insert into public.content_releases (id, tenant_id, kind, status, note, restores_release_id, created_by)
      values (v_release, v_tenant, v_kind, 'applying', v_note, v_restores, p_actor);
    end if;

    -- 6. Conflicts, before any write and still as the service role: each live row an update
    -- or a removal touches, locked in registry order then id order, compared with the
    -- locked draft's own base column by column as the column's own type ('12.50' is 12.5), whatever
    -- the row's version says (a writer may send a version back: app.tg_bump_version keeps
    -- one that differs from the stored one, so an equal version proves nothing). Read past
    -- RLS on purpose: whether the row is there is a fact, and whether this person may change
    -- it is the apply's to decide, under their own policies.
    for v_it in
      select x.value from pg_catalog.jsonb_array_elements(v_plan) as x(value)
       where x.value ->> 'op' <> 'create'
       order by (x.value ->> 'apply_order')::int, x.value ->> 'entity_id'
    loop
      v_current := v_it ->> 'draft_id';
      execute pg_catalog.format(
        'select pg_catalog.to_jsonb(t) from public.%I as t where t.tenant_id = $1 and t.%I = $2 for update',
        v_it ->> 'table', v_it ->> 'key')
        into v_live using v_tenant, (v_it ->> 'entity_id')::uuid;
      if v_live is null then
        v_conflicts := v_conflicts || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('draftId', v_current, 'removed', true));
        v_skip := v_skip || pg_catalog.jsonb_build_object(v_current, true);
        continue;
      end if;
      v_live_pub := v_live_pub || pg_catalog.jsonb_build_object(v_current, v_live -> 'published_at');
      select array_agg(k.key order by k.key) into v_cols
        from pg_catalog.jsonb_object_keys(v_it -> 'patch') as k(key);
      continue when v_cols is null;
      select string_agg(pg_catalog.format('(%L, (s.l).%I is distinct from (s.b).%I)', c.col, c.col, c.col),
                        ', ' order by c.col),
             pg_catalog.jsonb_object_agg(c.col, v_live -> c.col),
             pg_catalog.jsonb_object_agg(c.col, (v_draft_bases -> v_current) -> c.col)
        into v_list, v_live_args, v_base_args
        from unnest(v_cols) as c(col);
      execute pg_catalog.format(
        'select coalesce(pg_catalog.array_agg(v.c order by v.c) filter (where v.d), ''{}''::text[]) '
        'from (select pg_catalog.jsonb_populate_record(null::public.%I, $1) as l, '
        'pg_catalog.jsonb_populate_record(null::public.%I, $2) as b) as s '
        'cross join lateral (values %s) as v(c, d)',
        v_it ->> 'table', v_it ->> 'table', v_list)
        into v_moved using v_live_args, v_base_args;
      if pg_catalog.cardinality(v_moved) > 0 then
        v_conflicts := v_conflicts || pg_catalog.jsonb_build_array(
          case when p_mode = 'dry_run' then
            pg_catalog.jsonb_build_object(
              'draftId', v_current, 'columns', pg_catalog.to_jsonb(v_moved),
              'live', (select pg_catalog.jsonb_object_agg(m.col, v_live -> m.col) from unnest(v_moved) as m(col)),
              'base', (select pg_catalog.jsonb_object_agg(m.col, (v_draft_bases -> v_current) -> m.col) from unnest(v_moved) as m(col)))
          else
            pg_catalog.jsonb_build_object('draftId', v_current, 'columns', pg_catalog.to_jsonb(v_moved))
          end);
        v_skip := v_skip || pg_catalog.jsonb_build_object(v_current, true);
      end if;
    end loop;
    v_current := null;
    if p_mode in ('publish', 'fire') and pg_catalog.jsonb_array_length(v_conflicts) > 0 then
      raise exception 'apply_release: the live site changed under a pending change' using errcode = 'BR409',
        detail = pg_catalog.jsonb_build_object('code', 'conflict', 'items', v_conflicts)::text;
    end if;

    -- The statements, built once. Identifiers are the registry's, through %I; the column
    -- lists are made of %I-quoted names only; values travel in $1 (the row, read by
    -- jsonb_populate_record as the table's own types), $2 (the tenant) and $3 (the key).
    for v_it in
      select x.value from pg_catalog.jsonb_array_elements(v_plan) as x(value)
       order by x.value ->> 'op' = 'delete',
                case when x.value ->> 'op' = 'delete' then -(x.value ->> 'apply_order')::int
                     else (x.value ->> 'apply_order')::int end,
                (x.value ->> 'unique_set')::boolean,
                x.value ->> 'entity_id'
    loop
      continue when v_skip ? (v_it ->> 'draft_id');
      v_patch := v_it -> 'patch';
      v_deferred := array(select pg_catalog.jsonb_array_elements_text(v_it -> 'deferred'));
      v_row := v_patch - v_deferred;
      v_sql := null;
      -- A first publish stamps published_at; a republish, an unpublish or a rollback never
      -- rewrites it (truthful dates, CLAUDE.md §3 Pillar 3). 0104 (R10): a row a restore brings
      -- back is no first publish. It keeps the date it held when it was removed (the image of
      -- the ledger's last removal of it, whatever the status it comes back with); one the
      -- ledger never saw removed with a date is stamped as a first publish.
      v_pub := null;
      if (v_it ->> 'has_published_at')::boolean and v_restored ? (v_it ->> 'draft_id') then
        select nullif(i.before -> 'published_at', 'null'::jsonb) into v_pub
          from public.content_release_items i
         where i.tenant_id = v_tenant and i.entity_type = v_it ->> 'entity_type'
           and i.entity_id = (v_it ->> 'entity_id')::uuid and i.op = 'delete'
         order by i.id desc
         limit 1;
      end if;
      if v_pub is not null then
        v_row := v_row || pg_catalog.jsonb_build_object('published_at', v_pub);
      elsif (v_it ->> 'has_published_at')::boolean and (v_patch ->> 'status') = 'published'
         and (v_it ->> 'op' = 'create'
              or coalesce(v_live_pub -> (v_it ->> 'draft_id'), 'null'::jsonb) = 'null'::jsonb) then
        v_row := v_row || pg_catalog.jsonb_build_object('published_at', pg_catalog.now());
      end if;
      if v_it ->> 'op' = 'create' then
        v_row := v_row || pg_catalog.jsonb_build_object('tenant_id', v_tenant)
                 || case when v_it ->> 'key' = 'id'
                         then pg_catalog.jsonb_build_object('id', v_it ->> 'entity_id')
                         else '{}'::jsonb end;
        select string_agg(pg_catalog.format('%I', k.key), ', ' order by k.key),
               string_agg(pg_catalog.format('r.%I', k.key), ', ' order by k.key)
          into v_list_cols, v_list_sel
          from pg_catalog.jsonb_object_keys(v_row) as k(key);
        v_sql := pg_catalog.format(
          'insert into public.%I (%s) select %s from pg_catalog.jsonb_populate_record(null::public.%I, $1) as r',
          v_it ->> 'table', v_list_cols, v_list_sel, v_it ->> 'table');
      elsif v_it ->> 'op' = 'update' then
        if v_row <> '{}'::jsonb then
          select string_agg(pg_catalog.format('%I = r.%I', k.key, k.key), ', ' order by k.key)
            into v_list_cols
            from pg_catalog.jsonb_object_keys(v_row) as k(key);
          v_sql := pg_catalog.format(
            'update public.%I as t set %s from pg_catalog.jsonb_populate_record(null::public.%I, $1) as r '
            'where t.tenant_id = $2 and t.%I = $3',
            v_it ->> 'table', v_list_cols, v_it ->> 'table', v_it ->> 'key');
        end if;
      else
        v_sql := pg_catalog.format('delete from public.%I as t where t.tenant_id = $2 and t.%I = $3',
                                   v_it ->> 'table', v_it ->> 'key');
      end if;
      v_it := v_it || pg_catalog.jsonb_build_object(
        'sql', v_sql, 'row', v_row,
        'theme_on', coalesce(v_it ->> 'entity_type' = 'custom_theme' and v_patch -> 'is_active' = 'true'::jsonb, false));
      if v_it ->> 'op' = 'delete' then
        v_removals := v_removals || pg_catalog.jsonb_build_array(v_it);
      else
        v_first := v_first || pg_catalog.jsonb_build_array(v_it);
      end if;
      -- The self-references, held back to a second pass once every row exists.
      if pg_catalog.cardinality(v_deferred) > 0 then
        select string_agg(pg_catalog.format('%I = r.%I', d.col, d.col), ', ' order by d.col)
          into v_list_cols
          from unnest(v_deferred) as d(col);
        v_second := v_second || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'draft_id', v_it ->> 'draft_id', 'entity_type', v_it ->> 'entity_type',
          'entity_id', v_it ->> 'entity_id', 'children', null, 'theme_on', false,
          'row', (select pg_catalog.jsonb_object_agg(d.col, v_patch -> d.col) from unnest(v_deferred) as d(col)),
          'sql', pg_catalog.format(
            'update public.%I as t set %s from pg_catalog.jsonb_populate_record(null::public.%I, $1) as r '
            'where t.tenant_id = $2 and t.%I = $3',
            v_it ->> 'table', v_list_cols, v_it ->> 'table', v_it ->> 'key')));
      end if;
    end loop;
    -- A publish runs everything in one exception block (fail fast: one error, nothing kept;
    -- P-15 and verification claim 7). A dry run runs each change in its own, so every
    -- outcome is collected: at most 60 changes, the second pass and this block, inside the
    -- 64 subtransactions a backend caches.
    if p_mode in ('publish', 'fire') then
      v_batches := pg_catalog.jsonb_build_array(v_first || v_second || v_removals);
    else
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(x.value) order by x.ord), '[]'::jsonb)
        into v_batches
        from pg_catalog.jsonb_array_elements(v_first) with ordinality as x(value, ord);
      if pg_catalog.jsonb_array_length(v_second) > 0 then
        v_batches := v_batches || pg_catalog.jsonb_build_array(v_second);
      end if;
      v_batches := v_batches || coalesce(
        (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(x.value) order by x.ord)
           from pg_catalog.jsonb_array_elements(v_removals) with ordinality as x(value, ord)),
        '[]'::jsonb);
    end if;

    -- 5. The release token and the publisher's identity, for the rest of this block. The
    -- token is this transaction's id (app.release_token_valid compares it), so no other
    -- transaction can borrow it. What was there before is kept, and put back below.
    perform pg_catalog.pg_current_xact_id();
    v_saved_claims := coalesce(pg_catalog.current_setting('request.jwt.claims', true), '');
    v_saved_sub := coalesce(pg_catalog.current_setting('request.jwt.claim.sub', true), '');
    v_saved_role := coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '');
    perform pg_catalog.set_config('app.release_apply', pg_catalog.pg_current_xact_id()::text, true);
    perform pg_catalog.set_config('app.release_id', v_release::text, true);
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.jsonb_build_object(
        'sub', p_actor, 'role', 'authenticated',
        'app_metadata', pg_catalog.jsonb_build_object('role', p_role, 'tenant_id', v_tenant))::text,
      true);
    perform pg_catalog.set_config('request.jwt.claim.sub', p_actor::text, true);
    perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    -- 7. The changes, as the publisher.
    for v_batch in
      select b.value from pg_catalog.jsonb_array_elements(v_batches) with ordinality as b(value, ord)
       order by b.ord
    loop
      begin
        for v_it in
          select e.value from pg_catalog.jsonb_array_elements(v_batch) with ordinality as e(value, ord)
           order by e.ord
        loop
          continue when v_failed ? (v_it ->> 'draft_id');
          v_current := v_it ->> 'draft_id';
          -- Names this row's draft to the capture trigger (rows reached indirectly get none).
          perform pg_catalog.set_config('app.release_item',
            (v_it ->> 'entity_type') || ':' || (v_it ->> 'entity_id') || ':' || (v_it ->> 'draft_id'), true);
          -- One active custom theme: activating one switches the others off, here, in the
          -- same transaction (captured as items with no draft).
          if (v_it ->> 'theme_on')::boolean then
            update public.custom_themes as t set is_active = false
             where t.tenant_id = v_tenant and t.id <> (v_it ->> 'entity_id')::uuid and t.is_active;
          end if;
          if v_it ->> 'sql' is not null then
            execute v_it ->> 'sql' using v_it -> 'row', v_tenant, (v_it ->> 'entity_id')::uuid;
            get diagnostics v_n = row_count;
            -- No row: RLS filtered the statement (the publisher may not make this change),
            -- unless a removal found its row already removed by this release, a cascade from
            -- a parent removed before it (navigation children go with their parent, and
            -- removals of one type run by id, not by depth): done, then, and captured.
            if v_n = 0 and not (
                 v_it ->> 'op' = 'delete'
                 and exists (select 1 from public.content_release_items as i
                              where i.tenant_id = v_tenant and i.release_id = v_release
                                and i.entity_type = v_it ->> 'entity_type'
                                and i.entity_id = (v_it ->> 'entity_id')::uuid
                                and i.op = 'delete')) then
              raise exception 'the database refused this change for the person publishing it'
                using errcode = '42501';
            end if;
          end if;
          -- A case study's link sets, replaced as whole sets (save_portfolio's own code),
          -- with their images before and after for the synthetic portfolio_children item.
          if nullif(v_it -> 'children', 'null'::jsonb) is not null then
            -- A change to the link sets alone writes no project row, so nothing above has
            -- shown that the publisher may write this project: lock it as them first (FOR
            -- UPDATE binds the UPDATE policy). Without it, RLS would silently filter the
            -- link-set deletes for a role that may not write case studies, and the change
            -- would be consumed with nothing done.
            if v_it ->> 'sql' is null then
              perform 1 from public.portfolio as t
               where t.tenant_id = v_tenant and t.id = (v_it ->> 'entity_id')::uuid
                 for update;
              if not found then
                raise exception 'the database refused this change for the person publishing it'
                  using errcode = '42501';
              end if;
            end if;
            select pg_catalog.jsonb_build_object(
                     'service_ids', coalesce((select pg_catalog.jsonb_agg(ps.service_id order by ps.sort_order, ps.service_id)
                                                from public.portfolio_services ps
                                               where ps.tenant_id = v_tenant and ps.portfolio_id = (v_it ->> 'entity_id')::uuid), '[]'::jsonb),
                     'media', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pm) - 'tenant_id'::text order by pm.sort_order, pm.id)
                                          from public.portfolio_media pm
                                         where pm.tenant_id = v_tenant and pm.portfolio_id = (v_it ->> 'entity_id')::uuid), '[]'::jsonb))
              into v_child_before;
            perform app.apply_portfolio_children(
              v_tenant, (v_it ->> 'entity_id')::uuid,
              case when nullif(v_it -> 'children' -> 'service_ids', 'null'::jsonb) is null then null::uuid[]
                   else array(select (s.value #>> '{}')::uuid
                                from pg_catalog.jsonb_array_elements(v_it -> 'children' -> 'service_ids')
                                       with ordinality as s(value, ord)
                               order by s.ord) end,
              nullif(v_it -> 'children' -> 'media', 'null'::jsonb));
            select pg_catalog.jsonb_build_object(
                     'service_ids', coalesce((select pg_catalog.jsonb_agg(ps.service_id order by ps.sort_order, ps.service_id)
                                                from public.portfolio_services ps
                                               where ps.tenant_id = v_tenant and ps.portfolio_id = (v_it ->> 'entity_id')::uuid), '[]'::jsonb),
                     'media', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pm) - 'tenant_id'::text order by pm.sort_order, pm.id)
                                          from public.portfolio_media pm
                                         where pm.tenant_id = v_tenant and pm.portfolio_id = (v_it ->> 'entity_id')::uuid), '[]'::jsonb))
              into v_child_after;
            v_child_items := v_child_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'entity_id', v_it ->> 'entity_id', 'draft_id', v_it ->> 'draft_id',
              'before', v_child_before, 'after', v_child_after));
          end if;
          perform pg_catalog.set_config('app.release_item', '', true);
        end loop;
        -- 8. The audit row, as the publisher (audit_insert binds), in this transaction: no
        -- release without it. Ids, operations and counts only, never values (§3).
        if p_mode in ('publish', 'fire') then
          v_current := null;
          insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
          values (v_tenant, p_actor, p_role, 'release.publish', 'release', v_release::text,
                  case when p_mode = 'fire' then pg_catalog.jsonb_build_object('scheduled', true)
                       else '{}'::jsonb end
                  || pg_catalog.jsonb_build_object(
                    'number', v_number, 'kind', v_kind, 'restores', v_restores,
                    'item_count', pg_catalog.jsonb_array_length(v_plan),
                    'items', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                       'type', x.value ->> 'entity_type', 'id', x.value ->> 'entity_id',
                                       'op', x.value ->> 'op') order by (x.value ->> 'ord')::int)
                                from pg_catalog.jsonb_array_elements(v_plan) as x(value))));
        end if;
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                                v_con = constraint_name, v_col = column_name;
        -- Busy, not refused: a lock wait past lock_timeout, a deadlock, a serialization
        -- failure leave as they are, in both modes, for the caller to retry (R6).
        if v_state in ('55P03', '40P01', '40001') then
          raise exception '%', v_msg using errcode = v_state;
        end if;
        v_fail := pg_catalog.jsonb_build_object(
          'draftId', v_current, 'sqlstate', v_state, 'constraint', nullif(v_con, ''),
          'column', nullif(v_col, ''), 'message', v_msg);
        if p_mode in ('publish', 'fire') then
          raise exception 'apply_release: the database refused a change' using errcode = 'BR422',
            detail = pg_catalog.jsonb_build_object('code', 'refused', 'items', pg_catalog.jsonb_build_array(v_fail))::text;
        end if;
        v_errors := v_errors || pg_catalog.jsonb_build_array(v_fail);
        if v_current is not null then
          v_failed := v_failed || pg_catalog.jsonb_build_object(v_current, true);
        end if;
      end;
    end loop;

    if p_mode in ('dry_run', 'schedule') then
      raise exception 'apply_release: dry run, undone' using errcode = 'BRDRY';
    end if;
  exception
    when sqlstate 'BRDRY' then
      -- Everything in the block is undone, the release row, the token and the identity
      -- included (a subtransaction's settings go with it). Nothing persists, and no number
      -- is used.
      null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
      -- The block's own settings are already undone with it; put back what came before,
      -- explicitly, before the error leaves.
      execute 'set local role service_role';
      if v_saved_claims is not null then
        perform pg_catalog.set_config('request.jwt.claims', v_saved_claims, true);
        perform pg_catalog.set_config('request.jwt.claim.sub', v_saved_sub, true);
        perform pg_catalog.set_config('request.jwt.claim.role', v_saved_role, true);
      end if;
      perform pg_catalog.set_config('app.release_apply', '', true);
      perform pg_catalog.set_config('app.release_id', '', true);
      perform pg_catalog.set_config('app.release_item', '', true);
      if v_state in ('BR409', 'BR422', '55P03', '40P01', '40001') then
        raise exception '%', v_msg using errcode = v_state, detail = coalesce(v_det, '');
      end if;
      raise exception 'apply_release: the release could not be applied' using errcode = 'BR422',
        detail = pg_catalog.jsonb_build_object('code', 'refused', 'items', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('draftId', v_current, 'sqlstate', v_state, 'constraint', null,
                                        'column', null, 'message', v_msg)))::text;
  end;

  -- ── 9. Back to the service role; the token and the publisher's claims go ───────────────
  -- So nothing later in the same transaction counts as inside the release, or as them.
  execute 'set local role service_role';
  if v_saved_claims is not null then
    perform pg_catalog.set_config('request.jwt.claims', v_saved_claims, true);
    perform pg_catalog.set_config('request.jwt.claim.sub', v_saved_sub, true);
    perform pg_catalog.set_config('request.jwt.claim.role', v_saved_role, true);
  end if;
  perform pg_catalog.set_config('app.release_apply', '', true);
  perform pg_catalog.set_config('app.release_id', '', true);
  perform pg_catalog.set_config('app.release_item', '', true);

  if p_mode = 'dry_run' then
    return pg_catalog.jsonb_build_object(
      'mode', 'dry_run',
      'ok', pg_catalog.jsonb_array_length(v_conflicts) = 0 and pg_catalog.jsonb_array_length(v_errors) = 0,
      'item_count', pg_catalog.jsonb_array_length(v_plan),
      'conflicts', v_conflicts,
      'errors', v_errors);
  end if;

  -- ── R11: a schedule, stored once its dry run found nothing in its way ───────────
  -- Refused as a publish would be: a conflict with live (BR409), a change the database
  -- refuses as this person (BR422). Otherwise the release, scheduled, holding the validated
  -- changes; its drafts claimed (read-only to every staff token until it goes live or is
  -- unscheduled); its audit row naming the scheduler, in this transaction. The changes keep
  -- the version each draft lands on when claimed (the draft lock moves every update to old +
  -- 1), which the fire then requires.
  if p_mode = 'schedule' then
    if pg_catalog.jsonb_array_length(v_conflicts) > 0 then
      raise exception 'apply_release: the live site changed under a pending change' using errcode = 'BR409',
        detail = pg_catalog.jsonb_build_object('code', 'conflict', 'items', v_conflicts)::text;
    end if;
    if pg_catalog.jsonb_array_length(v_errors) > 0 then
      raise exception 'apply_release: the database refused a change' using errcode = 'BR422',
        detail = pg_catalog.jsonb_build_object('code', 'refused', 'items', v_errors)::text;
    end if;
    select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'draft_id', x.value ->> 'draft_id', 'draft_version', d.version + 1,
               'entity_type', x.value ->> 'entity_type', 'entity_id', x.value ->> 'entity_id',
               'op', x.value ->> 'op', 'patch', x.value -> 'patch', 'base', x.value -> 'base')
             || case when nullif(x.value -> 'children', 'null'::jsonb) is null then '{}'::jsonb
                     else pg_catalog.jsonb_build_object('children', x.value -> 'children') end
             order by (x.value ->> 'ord')::int)
      into v_payload
      from pg_catalog.jsonb_array_elements(v_plan) as x(value)
      join public.content_drafts d on d.tenant_id = v_tenant and d.id = (x.value ->> 'draft_id')::uuid;
    insert into public.content_releases
      (id, tenant_id, kind, status, note, scheduled_for, scheduled_by, payload, item_count, areas, created_by)
    values (v_release, v_tenant, 'publish', 'scheduled', p_note, p_scheduled_for, p_actor, v_payload,
            pg_catalog.jsonb_array_length(v_plan), coalesce(v_areas, '{}'::text[]), p_actor);
    update public.content_drafts as d set release_id = v_release
     where d.tenant_id = v_tenant and d.id = any (v_draft_ids);
    if exists (select 1 from pg_catalog.jsonb_array_elements(v_payload) as x(value)
                where not exists (select 1 from public.content_drafts d
                                   where d.tenant_id = v_tenant and d.id = (x.value ->> 'draft_id')::uuid
                                     and d.release_id = v_release
                                     and d.version = (x.value ->> 'draft_version')::int)) then
      raise exception 'apply_release: a claimed change is not at the version the release holds'
        using errcode = '22023';
    end if;
    insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
    values (v_tenant, p_actor, p_role, 'release.schedule', 'release', v_release::text,
            pg_catalog.jsonb_build_object(
              'scheduled_for', p_scheduled_for, 'item_count', pg_catalog.jsonb_array_length(v_plan),
              'items', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                 'type', x.value ->> 'entity_type', 'id', x.value ->> 'entity_id',
                                 'op', x.value ->> 'op') order by (x.value ->> 'ord')::int)
                          from pg_catalog.jsonb_array_elements(v_plan) as x(value))));
    return pg_catalog.jsonb_build_object(
      'mode', 'schedule', 'release_id', v_release, 'scheduled_for', p_scheduled_for,
      'version', (select r.version from public.content_releases r
                   where r.tenant_id = v_tenant and r.id = v_release),
      'item_count', pg_catalog.jsonb_array_length(v_plan));
  end if;

  -- The link sets' synthetic items, the drafts consumed, the version numbered and live.
  insert into public.content_release_items
    (tenant_id, release_id, entity_type, entity_id, op, before, after, draft_id, actor_id)
  select v_tenant, v_release, 'portfolio_children', (c.value ->> 'entity_id')::uuid, 'update',
         c.value -> 'before', c.value -> 'after', (c.value ->> 'draft_id')::uuid, p_actor
    from pg_catalog.jsonb_array_elements(v_child_items) with ordinality as c(value, ord)
   order by c.ord;
  delete from public.content_drafts d where d.tenant_id = v_tenant and d.id = any (v_draft_ids);
  update public.content_releases r
     set status = 'published', number = v_number, published_at = pg_catalog.now(),
         published_by = p_actor, item_count = pg_catalog.jsonb_array_length(v_plan),
         areas = coalesce(v_areas, '{}'::text[])
   where r.tenant_id = v_tenant and r.id = v_release;

  -- 10. What it changed: the release's items, then the team-member changes, which keep no
  -- images (owner item O-12).
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.id), '[]'::jsonb) into v_result
    from public.content_release_items i
   where i.tenant_id = v_tenant and i.release_id = v_release;
  v_result := v_result || coalesce(
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'entity_type', 'team_member', 'entity_id', x.value ->> 'entity_id',
              'op', x.value ->> 'op', 'draft_id', x.value ->> 'draft_id')
            order by (x.value ->> 'ord')::int)
       from pg_catalog.jsonb_array_elements(v_plan) as x(value)
      where x.value ->> 'entity_type' = 'team_member'),
    '[]'::jsonb);
  return pg_catalog.jsonb_build_object('release_id', v_release, 'number', v_number, 'items', v_result);
end $$;
revoke all on function public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)
  to service_role;

-- ═══ 3. The minute cron's claim of due scheduled releases ═════════════════════════════════
-- An answer row: {tenant_id, release_id, scheduled_for, scheduled_by, kind, scheduler, items}:
-- `scheduler` the scheduler's profile as it is now ({role, tenant_id, live}: active and not
-- locked; null when the profile is gone), `items` each change's {entity_type, op, status} (the
-- status its patch sets, or null), what the Worker re-checks against ROLE_CAPS before it fires
-- (src/lib/cron/releases.ts). Never a patch's values. The lease is RELEASE_FIRE_LEASE_MINUTES.
create or replace function public.claim_scheduled_releases(p_limit int default 1)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_out jsonb;
begin
  if current_user::text <> 'service_role' then
    raise exception 'claim_scheduled_releases: only the service role claims' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5 then
    raise exception 'claim_scheduled_releases: a limit of 1 to 5' using errcode = '22023';
  end if;
  with due as (
    select r.id
      from public.content_releases r
     where r.status = 'scheduled'
       and r.scheduled_for <= pg_catalog.now()
       and (r.fire_lease_until is null or r.fire_lease_until <= pg_catalog.now())
     order by r.scheduled_for, r.id
     limit p_limit
       for update of r skip locked
  ), claimed as (
    update public.content_releases r
       set fire_lease_until = pg_catalog.now() + interval '2 minutes'
      from due
     where r.id = due.id
    returning r.tenant_id, r.id, r.scheduled_for, r.scheduled_by, r.kind, r.payload
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'tenant_id', c.tenant_id, 'release_id', c.id, 'scheduled_for', c.scheduled_for,
           'scheduled_by', c.scheduled_by, 'kind', c.kind,
           'scheduler', (select pg_catalog.jsonb_build_object(
                                  'role', p.role::text, 'tenant_id', p.tenant_id,
                                  'live', p.is_active and (p.locked_until is null
                                                           or p.locked_until <= pg_catalog.now()))
                           from public.profiles p where p.id = c.scheduled_by),
           'items', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                       'entity_type', x.value ->> 'entity_type',
                                       'op', x.value ->> 'op',
                                       'status', x.value -> 'patch' ->> 'status')
                                     order by x.ord), '[]'::jsonb)
                       from pg_catalog.jsonb_array_elements(c.payload) with ordinality as x(value, ord)))
           order by c.scheduled_for, c.id), '[]'::jsonb)
    into v_out
    from claimed c;
  return v_out;
end $$;
revoke all on function public.claim_scheduled_releases(int)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_scheduled_releases(int) to service_role;

-- ═══ 4. A scheduled release that could not go live ════════════════════════════════════════
-- RELEASE_FAILURE_CODES (packages/schemas/release.ts; tests/lib/releaseScheduleSql.spec.ts
-- holds the two lists equal): `scheduler` (the person who scheduled it can no longer publish:
-- inactive, locked, another role, gone), `forbidden` (their role no longer publishes one of its
-- changes), `changed` (a change is not as the release holds it), `conflict` (the live site
-- moved under a change), `refused` (the database refused a change as that person),
-- `releases-off` (switched off since), `error` (anything else). The failure is the code and,
-- for a change at fault, the drafts' ids: never a message or a value. Under the tenant's
-- release lock; only a release still scheduled AND due is failed: one that went live, failed or
-- was cancelled meanwhile, or that a person moved to a later time since the cron claimed it
-- (reschedule_release takes the same lock), is left as it is, as a fire leaves it. Its drafts
-- are released: pending changes again.
create or replace function public.fail_scheduled_release(p_tenant uuid, p_release uuid,
                                                         p_code text, p_draft_ids uuid[] default null)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_status text;
  v_at timestamptz;
  v_released int;
begin
  if current_user::text <> 'service_role' then
    raise exception 'fail_scheduled_release: only the service role fails a release' using errcode = '42501';
  end if;
  if p_tenant is null or p_release is null or p_code is null
     or p_code not in ('scheduler', 'forbidden', 'changed', 'conflict', 'refused', 'releases-off', 'error')
     or (p_draft_ids is not null and (pg_catalog.cardinality(p_draft_ids) not between 1 and 60
                                      or array_position(p_draft_ids, null) is not null)) then
    raise exception 'fail_scheduled_release: a tenant, a release, a known code and at most 60 drafts'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || p_tenant::text, 0));
  select r.status, r.scheduled_for into v_status, v_at
    from public.content_releases r
   where r.tenant_id = p_tenant and r.id = p_release
     for update;
  if not found then
    raise exception 'fail_scheduled_release: no such release on this site' using errcode = 'P0002';
  end if;
  if v_status <> 'scheduled' or v_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('failed', false, 'status', v_status);
  end if;
  update public.content_drafts as d set release_id = null
   where d.tenant_id = p_tenant and d.release_id = p_release;
  get diagnostics v_released = row_count;
  update public.content_releases as r
     set status = 'failed', fire_lease_until = null,
         failure = pg_catalog.jsonb_build_object('code', p_code)
                   || case when p_draft_ids is null then '{}'::jsonb
                           else pg_catalog.jsonb_build_object('draft_ids', pg_catalog.to_jsonb(p_draft_ids)) end
   where r.tenant_id = p_tenant and r.id = p_release;
  return pg_catalog.jsonb_build_object('failed', true, 'status', 'failed', 'released', v_released);
end $$;
revoke all on function public.fail_scheduled_release(uuid, uuid, text, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.fail_scheduled_release(uuid, uuid, text, uuid[]) to service_role;

-- ═══ 5. Moving or cancelling a scheduled release ══════════════════════════════════════════
-- The Worker's route (src/lib/release/schedule.ts) checks the capabilities first (every change
-- the release holds is the caller's to publish, P-2) and re-reads the person; these check them
-- again in the database, the second layer: the person live (active, unlocked, the role named, a
-- CMS role, the tenant from the profile), their role among each change's author roles in the
-- registry (the roles RLS lets write it) and, for a removal, an archive, or an edit that sets
-- no status of its own to a row archived live (it keeps the row archived: hotfix H12, an
-- Admin's to publish under the archive gates, as the Worker's `keepsArchived` judges a
-- publish), its delete roles; the release scheduled and at the version the person saw (BR409
-- otherwise); under the tenant's release lock, so neither races a fire. Audited in the same
-- transaction, naming the person (ids and the time only). A moved release goes live as the
-- person who moved it: they may publish all of it.
create or replace function public.reschedule_release(p_actor uuid, p_role text, p_release uuid,
                                                     p_version int, p_scheduled_for timestamptz)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_tenant uuid;
  v_rel public.content_releases;
  v_version int;
  v_kept record;
  v_live text;
begin
  if current_user::text <> 'service_role' then
    raise exception 'reschedule_release: only the service role moves a release' using errcode = '42501';
  end if;
  if p_actor is null or p_role is null or p_release is null or p_version is null or p_scheduled_for is null then
    raise exception 'reschedule_release: the person, their role, the release, its version and a time'
      using errcode = '22023';
  end if;
  if p_scheduled_for < pg_catalog.now() + interval '1 minute'
     or p_scheduled_for > pg_catalog.now() + interval '366 days' then
    raise exception 'reschedule_release: a release is scheduled at least a minute ahead and at most 366 days ahead'
      using errcode = '22023';
  end if;
  select p.tenant_id into v_tenant
    from public.profiles p
   where p.id = p_actor and p.is_active
     and (p.locked_until is null or p.locked_until <= pg_catalog.now())
     and p.role::text = p_role
     and p.role::text in ('admin', 'content_creator', 'seo', 'developer');
  if v_tenant is null then
    raise exception 'reschedule_release: this person cannot schedule now' using errcode = 'BR403',
      detail = pg_catalog.jsonb_build_object('code', 'actor')::text;
  end if;
  if not app.releases_enabled(v_tenant) then
    raise exception 'reschedule_release: releases are not switched on for this site' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || v_tenant::text, 0));
  select r.* into v_rel from public.content_releases r
   where r.tenant_id = v_tenant and r.id = p_release
     for update;
  if not found then
    raise exception 'reschedule_release: no such release on this site' using errcode = 'P0002';
  end if;
  if v_rel.status <> 'scheduled' then
    raise exception 'reschedule_release: the release is not scheduled' using errcode = 'BR409',
      detail = pg_catalog.jsonb_build_object('code', 'not-scheduled', 'status', v_rel.status)::text;
  end if;
  if v_rel.version <> p_version then
    raise exception 'reschedule_release: the release changed since it was read' using errcode = 'BR409',
      detail = pg_catalog.jsonb_build_object('code', 'conflict', 'version', v_rel.version)::text;
  end if;
  if exists (
       select 1
         from pg_catalog.jsonb_array_elements(v_rel.payload) as x(value)
         left join app.release_entities e on e.entity_type = x.value ->> 'entity_type'
        where e.entity_type is null
           or p_role <> all (e.author_roles)
           or ((x.value ->> 'op' = 'delete'
                or (e.has_status and x.value -> 'patch' ->> 'status' = 'archived'))
               and p_role <> all (e.delete_roles))) then
    raise exception 'reschedule_release: this role cannot publish every change of the release'
      using errcode = 'BR403', detail = pg_catalog.jsonb_build_object('code', 'forbidden')::text;
  end if;
  -- An edit that sets no status of its own to a row archived live keeps it archived: the
  -- archive gates leave that to the delete roles (hotfix H12), as a publish of it.
  for v_kept in
    select e.table_name, e.key_column, x.value ->> 'entity_id' as entity_id
      from pg_catalog.jsonb_array_elements(v_rel.payload) as x(value)
      join app.release_entities e on e.entity_type = x.value ->> 'entity_type'
     where e.has_status and x.value ->> 'op' = 'update'
       and pg_catalog.jsonb_typeof(x.value -> 'patch' -> 'status') is distinct from 'string'
       and p_role <> all (e.delete_roles)
  loop
    execute pg_catalog.format(
      'select t.status::text from public.%I as t where t.tenant_id = $1 and t.%I = $2',
      v_kept.table_name, v_kept.key_column)
      into v_live using v_tenant, v_kept.entity_id::uuid;
    if v_live = 'archived' then
      raise exception 'reschedule_release: this role cannot publish every change of the release'
        using errcode = 'BR403', detail = pg_catalog.jsonb_build_object('code', 'forbidden')::text;
    end if;
  end loop;
  update public.content_releases as r
     set scheduled_for = p_scheduled_for, scheduled_by = p_actor, fire_lease_until = null
   where r.tenant_id = v_tenant and r.id = p_release
  returning r.version into v_version;
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (v_tenant, p_actor, p_role, 'release.reschedule', 'release', p_release::text,
          pg_catalog.jsonb_build_object('scheduled_for', p_scheduled_for, 'was', v_rel.scheduled_for,
                                        'item_count', v_rel.item_count));
  return pg_catalog.jsonb_build_object('release_id', p_release, 'scheduled_for', p_scheduled_for,
                                       'version', v_version);
end $$;
revoke all on function public.reschedule_release(uuid, text, uuid, int, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.reschedule_release(uuid, text, uuid, int, timestamptz) to service_role;

create or replace function public.unschedule_release(p_actor uuid, p_role text, p_release uuid,
                                                     p_version int)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_tenant uuid;
  v_rel public.content_releases;
  v_released int;
  v_kept record;
  v_live text;
begin
  if current_user::text <> 'service_role' then
    raise exception 'unschedule_release: only the service role cancels a release' using errcode = '42501';
  end if;
  if p_actor is null or p_role is null or p_release is null or p_version is null then
    raise exception 'unschedule_release: the person, their role, the release and its version'
      using errcode = '22023';
  end if;
  select p.tenant_id into v_tenant
    from public.profiles p
   where p.id = p_actor and p.is_active
     and (p.locked_until is null or p.locked_until <= pg_catalog.now())
     and p.role::text = p_role
     and p.role::text in ('admin', 'content_creator', 'seo', 'developer');
  if v_tenant is null then
    raise exception 'unschedule_release: this person cannot schedule now' using errcode = 'BR403',
      detail = pg_catalog.jsonb_build_object('code', 'actor')::text;
  end if;
  if not app.releases_enabled(v_tenant) then
    raise exception 'unschedule_release: releases are not switched on for this site' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || v_tenant::text, 0));
  select r.* into v_rel from public.content_releases r
   where r.tenant_id = v_tenant and r.id = p_release
     for update;
  if not found then
    raise exception 'unschedule_release: no such release on this site' using errcode = 'P0002';
  end if;
  if v_rel.status <> 'scheduled' then
    raise exception 'unschedule_release: the release is not scheduled' using errcode = 'BR409',
      detail = pg_catalog.jsonb_build_object('code', 'not-scheduled', 'status', v_rel.status)::text;
  end if;
  if v_rel.version <> p_version then
    raise exception 'unschedule_release: the release changed since it was read' using errcode = 'BR409',
      detail = pg_catalog.jsonb_build_object('code', 'conflict', 'version', v_rel.version)::text;
  end if;
  if exists (
       select 1
         from pg_catalog.jsonb_array_elements(v_rel.payload) as x(value)
         left join app.release_entities e on e.entity_type = x.value ->> 'entity_type'
        where e.entity_type is null
           or p_role <> all (e.author_roles)
           or ((x.value ->> 'op' = 'delete'
                or (e.has_status and x.value -> 'patch' ->> 'status' = 'archived'))
               and p_role <> all (e.delete_roles))) then
    raise exception 'unschedule_release: this role cannot publish every change of the release'
      using errcode = 'BR403', detail = pg_catalog.jsonb_build_object('code', 'forbidden')::text;
  end if;
  -- An edit that sets no status of its own to a row archived live keeps it archived: the
  -- archive gates leave that to the delete roles (hotfix H12), as a publish of it.
  for v_kept in
    select e.table_name, e.key_column, x.value ->> 'entity_id' as entity_id
      from pg_catalog.jsonb_array_elements(v_rel.payload) as x(value)
      join app.release_entities e on e.entity_type = x.value ->> 'entity_type'
     where e.has_status and x.value ->> 'op' = 'update'
       and pg_catalog.jsonb_typeof(x.value -> 'patch' -> 'status') is distinct from 'string'
       and p_role <> all (e.delete_roles)
  loop
    execute pg_catalog.format(
      'select t.status::text from public.%I as t where t.tenant_id = $1 and t.%I = $2',
      v_kept.table_name, v_kept.key_column)
      into v_live using v_tenant, v_kept.entity_id::uuid;
    if v_live = 'archived' then
      raise exception 'unschedule_release: this role cannot publish every change of the release'
        using errcode = 'BR403', detail = pg_catalog.jsonb_build_object('code', 'forbidden')::text;
    end if;
  end loop;
  update public.content_drafts as d set release_id = null
   where d.tenant_id = v_tenant and d.release_id = p_release;
  get diagnostics v_released = row_count;
  update public.content_releases as r
     set status = 'cancelled', fire_lease_until = null
   where r.tenant_id = v_tenant and r.id = p_release;
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (v_tenant, p_actor, p_role, 'release.unschedule', 'release', p_release::text,
          pg_catalog.jsonb_build_object('scheduled_for', v_rel.scheduled_for,
                                        'item_count', v_rel.item_count, 'released', v_released));
  return pg_catalog.jsonb_build_object('release_id', p_release, 'status', 'cancelled',
                                       'released', v_released);
end $$;
revoke all on function public.unschedule_release(uuid, text, uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function public.unschedule_release(uuid, text, uuid, int) to service_role;

-- ═══ 6. Switching releases on ═════════════════════════════════════════════════════════════
-- The runbook's switch (R14; docs/launch-runbook.md, "Releases: the two switches"), run as the
-- owner on a direct session. The rules (docs/admin-v2/as-built/R11.md):
--   1. Owner only: EXECUTE is no API role's, and a switched role or a role claim (a definer an
--      API request reached) is refused (42501). The operator and the fallback scheduler are
--      active, unlocked Admins of the site (22023 otherwise).
--   2. Not while a release is publishing: the tenant's release lock, taken without waiting
--      (55P03). Not twice (55000), and not over pending changes or scheduled releases left from
--      an earlier time (55000: there can be none; it says so rather than mixing them in).
--   3. The legacy schedule, its eight tables locked against writes first (SHARE ROW EXCLUSIVE:
--      a write in flight lands first, a later one waits and then meets releases on; a write
--      still running past the lock timeout refuses the switch, 55P03): each row
--      app.publish_scheduled() would have published by itself
--      (its tables, held equal by tests/lib/releaseScheduleSql.spec.ts, and its rows: status
--      scheduled WITH a time) becomes a pending change {status: published}, claimed by a
--      `legacy_schedule` release at that time (a time passed: the next minute fires it), its
--      live status moved from scheduled to draft. Releases group the rows by time and
--      scheduler, at most 60 changes each. The scheduler is the row's last editor when that
--      person may still publish it (live, of this site, among its author roles), else the
--      fallback. What the legacy path never publishes by itself is left as it is and counted
--      (`left_scheduled`): a row of those tables scheduled with no time, and a scheduled row of
--      the registry's other status tables (team members, statistics, certifications).
--   4. The baseline: version N (1 the first time), "Releases switched on", nothing purged.
--   5. The flag, then the audit row (`releases.enable`, the operator), all in one transaction.
create or replace function app.enable_releases(p_tenant uuid, p_operator uuid, p_fallback_scheduler uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  -- app.publish_scheduled()'s tables (0098).
  c_tables constant text[] := array['disciplines', 'services', 'blog_posts', 'portfolio', 'pages',
                                    'testimonials', 'service_cases', 'faq_items'];
  c_max_items constant int := 60;
  v_claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_reg app.release_entities;
  v_t text;
  v_found jsonb;
  v_versions jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_group record;
  v_release uuid;
  v_items jsonb;
  v_baseline uuid := pg_catalog.gen_random_uuid();
  v_number int;
  v_legacy int := 0;
  v_fallback int := 0;
  v_left int := 0;
  v_n int;
begin
  -- 1. Who.
  if current_user::text in ('anon', 'authenticated', 'service_role')
     or pg_catalog.current_setting('role') <> 'none'
     or (v_claims ->> 'role') is not null
     or (v_claims #>> '{app_metadata,role}') is not null then
    raise exception 'app.enable_releases: the owner runs it from the runbook, on a direct session'
      using errcode = '42501';
  end if;
  if p_tenant is null or not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'app.enable_releases: no such site' using errcode = '22023';
  end if;
  if p_operator is null or not exists (
       select 1 from public.profiles p
        where p.id = p_operator and p.tenant_id = p_tenant and p.role::text = 'admin' and p.is_active
          and (p.locked_until is null or p.locked_until <= pg_catalog.now())) then
    raise exception 'app.enable_releases: the operator is an active Admin of this site' using errcode = '22023';
  end if;
  if p_fallback_scheduler is null or not exists (
       select 1 from public.profiles p
        where p.id = p_fallback_scheduler and p.tenant_id = p_tenant and p.role::text = 'admin' and p.is_active
          and (p.locked_until is null or p.locked_until <= pg_catalog.now())) then
    raise exception 'app.enable_releases: the fallback scheduler is an active Admin of this site'
      using errcode = '22023';
  end if;

  -- 2. When.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('release:' || p_tenant::text, 0)) then
    raise exception 'app.enable_releases: a release is publishing; try again in a moment' using errcode = '55P03';
  end if;
  if app.releases_enabled(p_tenant) then
    raise exception 'app.enable_releases: releases are already on for this site' using errcode = '55000';
  end if;
  if exists (select 1 from public.content_drafts d where d.tenant_id = p_tenant)
     or exists (select 1 from public.content_releases r
                 where r.tenant_id = p_tenant and r.status in ('applying', 'scheduled')) then
    raise exception 'app.enable_releases: pending changes or scheduled releases remain from an earlier time; clear them first'
      using errcode = '55000';
  end if;

  -- 3. The legacy schedule. First every write to its tables in flight lands and every later
  -- one waits for this transaction (a SHARE ROW EXCLUSIVE lock on each, as disable holds
  -- content_drafts; reads are not blocked): while releases are off R5's guard admits a staff
  -- write, so without it a row scheduled between the read and the move below would be moved to
  -- draft with no pending change, or stay scheduled under releases on, where nothing publishes
  -- it. A write after the switch meets releases on. Then, row by row: the rows locked, read,
  -- then moved to draft. Exactly app.publish_scheduled()'s rows: scheduled, with a time. A row
  -- scheduled with no time is never published by it, so it is counted and left as it is.
  foreach v_t in array c_tables loop
    execute pg_catalog.format('lock table public.%I in share row exclusive mode', v_t);
  end loop;
  foreach v_t in array c_tables loop
    select e.* into v_reg from app.release_entities e where e.table_name = v_t;
    if not found or not v_reg.has_status then
      raise exception 'app.enable_releases: % is not a status table of the release registry', v_t
        using errcode = '22023';
    end if;
    execute pg_catalog.format(
      'select 1 from public.%I as t where t.tenant_id = $1 and t.status = ''scheduled'' for update', v_t)
      using p_tenant;
    execute pg_catalog.format(
      'select count(*)::int from public.%I as t '
      'where t.tenant_id = $1 and t.status = ''scheduled'' and t.scheduled_for is null', v_t)
      into v_n using p_tenant;
    v_left := v_left + v_n;
    execute pg_catalog.format(
      'select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('
      '''entity_id'', t.id, ''at'', t.scheduled_for, '
      '''updated_by'', t.updated_by, ''row'', pg_catalog.to_jsonb(t)) order by t.id), ''[]''::jsonb) '
      'from public.%I as t where t.tenant_id = $1 and t.status = ''scheduled'' and t.scheduled_for is not null', v_t)
      into v_found using p_tenant;
    continue when pg_catalog.jsonb_array_length(v_found) = 0;
    execute pg_catalog.format(
      'with u as (update public.%I as t set status = ''draft'' '
      'where t.tenant_id = $1 and t.status = ''scheduled'' and t.scheduled_for is not null '
      'returning t.id, t.version) '
      'select coalesce(pg_catalog.jsonb_object_agg(u.id, u.version), ''{}''::jsonb) from u', v_t)
      into v_versions using p_tenant;
    select v_rows || coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'entity_type', v_reg.entity_type, 'entity_id', f.value ->> 'entity_id',
             'area', v_reg.area, 'apply_order', v_reg.apply_order,
             'at', f.value ->> 'at',
             'version', (v_versions ->> (f.value ->> 'entity_id'))::int,
             'scheduler', case when exists (
                                 select 1 from public.profiles p
                                  where p.id = (f.value ->> 'updated_by')::uuid
                                    and p.tenant_id = p_tenant and p.is_active
                                    and (p.locked_until is null or p.locked_until <= pg_catalog.now())
                                    and p.role::text = any (v_reg.author_roles))
                               then (f.value ->> 'updated_by')::uuid
                               else p_fallback_scheduler end,
             'fallback', not exists (
                                 select 1 from public.profiles p
                                  where p.id = (f.value ->> 'updated_by')::uuid
                                    and p.tenant_id = p_tenant and p.is_active
                                    and (p.locked_until is null or p.locked_until <= pg_catalog.now())
                                    and p.role::text = any (v_reg.author_roles)),
             'label', nullif(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                        'en', left(coalesce(f.value -> 'row' -> 'title' ->> 'en',
                                            f.value -> 'row' -> 'name' ->> 'en',
                                            f.value -> 'row' -> 'question' ->> 'en',
                                            f.value -> 'row' -> 'author_name' ->> 'en',
                                            f.value -> 'row' ->> 'slug'), 200),
                        'ar', left(coalesce(f.value -> 'row' -> 'title' ->> 'ar',
                                            f.value -> 'row' -> 'name' ->> 'ar',
                                            f.value -> 'row' -> 'question' ->> 'ar',
                                            f.value -> 'row' -> 'author_name' ->> 'ar'), 200))),
                      '{}'::jsonb))), '[]'::jsonb)
      into v_rows
      from pg_catalog.jsonb_array_elements(v_found) as f(value);
  end loop;

  -- The other status tables of the registry: scheduled rows there are counted, left as they are.
  for v_reg in select e.* from app.release_entities e
                where e.has_status and e.table_name <> all (c_tables) order by e.table_name loop
    execute pg_catalog.format(
      'select count(*)::int from public.%I as t where t.tenant_id = $1 and t.status = ''scheduled''',
      v_reg.table_name)
      into v_n using p_tenant;
    v_left := v_left + v_n;
  end loop;

  -- One legacy_schedule release per time and scheduler, at most 60 changes each.
  for v_group in
    select g.at, g.scheduler,
           pg_catalog.jsonb_agg(g.r order by g.apply_order, g.entity_id) as rows,
           pg_catalog.array_agg(distinct g.area order by g.area) as areas
      from (select x.value as r, (x.value ->> 'at')::timestamptz as at,
                   (x.value ->> 'scheduler')::uuid as scheduler, x.value ->> 'area' as area,
                   (x.value ->> 'apply_order')::int as apply_order, x.value ->> 'entity_id' as entity_id,
                   (pg_catalog.row_number() over (
                      partition by x.value ->> 'at', x.value ->> 'scheduler'
                      order by (x.value ->> 'apply_order')::int, x.value ->> 'entity_id') - 1) / c_max_items as chunk
              from pg_catalog.jsonb_array_elements(v_rows) as x(value)) g
     group by g.at, g.scheduler, g.chunk
     order by g.at, g.scheduler, g.chunk
  loop
    v_release := pg_catalog.gen_random_uuid();
    select pg_catalog.jsonb_agg(r.value || pg_catalog.jsonb_build_object('draft_id', pg_catalog.gen_random_uuid())
                                order by r.ord)
      into v_items
      from pg_catalog.jsonb_array_elements(v_group.rows) with ordinality as r(value, ord);
    insert into public.content_releases
      (id, tenant_id, kind, status, scheduled_for, scheduled_by, payload, item_count, areas, created_by)
    values (v_release, p_tenant, 'legacy_schedule', 'scheduled', v_group.at, v_group.scheduler,
            (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'draft_id', i.value ->> 'draft_id', 'draft_version', 1,
                      'entity_type', i.value ->> 'entity_type', 'entity_id', i.value ->> 'entity_id',
                      'op', 'update', 'patch', '{"status":"published"}'::jsonb,
                      'base', '{"status":"draft"}'::jsonb) order by i.ord)
               from pg_catalog.jsonb_array_elements(v_items) with ordinality as i(value, ord)),
            pg_catalog.jsonb_array_length(v_items), v_group.areas, p_operator);
    insert into public.content_drafts
      (id, tenant_id, entity_type, entity_id, op, payload, fields, base, base_version, label,
       release_id, version, created_by)
    select (i.value ->> 'draft_id')::uuid, p_tenant, i.value ->> 'entity_type', (i.value ->> 'entity_id')::uuid,
           'update', '{"status":"published"}'::jsonb, array['status'], '{"status":"draft"}'::jsonb,
           (i.value ->> 'version')::int, i.value -> 'label', v_release, 1, v_group.scheduler
      from pg_catalog.jsonb_array_elements(v_items) as i(value);
    v_legacy := v_legacy + 1;
    v_fallback := v_fallback + (select count(*)::int from pg_catalog.jsonb_array_elements(v_items) as i(value)
                                 where (i.value ->> 'fallback')::boolean);
  end loop;

  -- 4. The baseline: the site as releases found it.
  select coalesce(max(r.number), 0) + 1 into v_number
    from public.content_releases r where r.tenant_id = p_tenant;
  insert into public.content_releases
    (id, tenant_id, number, kind, status, note, published_at, published_by, purge_status, created_by)
  values (v_baseline, p_tenant, v_number, 'baseline', 'published', 'Releases switched on',
          pg_catalog.now(), p_operator, 'not_needed', p_operator);

  -- 5. The flag, and the audit row naming the operator.
  insert into app.release_tenants (tenant_id, enabled_at, enabled_by)
  values (p_tenant, pg_catalog.now(), p_operator);
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, p_operator, 'admin', 'releases.enable', 'release', v_baseline::text,
          pg_catalog.jsonb_build_object('number', v_number,
                                        'converted', pg_catalog.jsonb_array_length(v_rows),
                                        'legacy_releases', v_legacy, 'fallback_scheduled', v_fallback,
                                        'left_scheduled', v_left));
  return pg_catalog.jsonb_build_object(
    'tenant_id', p_tenant, 'baseline', pg_catalog.jsonb_build_object('id', v_baseline, 'number', v_number),
    'converted', pg_catalog.jsonb_array_length(v_rows), 'legacy_releases', v_legacy,
    'fallback_scheduled', v_fallback, 'left_scheduled', v_left);
end $$;
revoke all on function app.enable_releases(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ═══ 7. Switching releases off ════════════════════════════════════════════════════════════
-- The way back before the contract slice (releases.md §10, edge case 21), as the owner:
--   1. Owner only, the operator an active Admin of the site, as enable's (42501, 22023).
--   2. Not while a release is publishing (the release lock without waiting, 55P03), not when
--      off already (55000). Every draft write in flight lands first and every later one waits
--      (a SHARE ROW EXCLUSIVE lock on content_drafts for the rest of the transaction), so the
--      count below is the whole of it.
--   3. Pending changes or scheduled releases refuse it (55000, with the counts) unless the
--      discard is named (p_discard_pending => true). The draft writes need releases on (0062),
--      so none could land after the switch is off.
--   4. With the discard: the flag goes first (what follows is not captured: the tenant is off);
--      a legacy_schedule release's rows go back to their own schedule (status scheduled at the
--      release's time, where the row is still the draft enable made it), so
--      app.publish_scheduled() publishes them as before; every scheduled release is cancelled;
--      every pending change is thrown away. Without anything pending, only the flag goes.
--   5. The audit row (`releases.disable`, the operator, the counts). History, versions and the
--      ledger stay; switching on again writes a new baseline.
create or replace function app.disable_releases(p_tenant uuid, p_operator uuid,
                                                p_discard_pending boolean default false)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_rel public.content_releases;
  v_reg app.release_entities;
  v_item jsonb;
  v_pending int;
  v_scheduled int;
  v_cancelled int := 0;
  v_restored int := 0;
  v_unrestored int := 0;
  v_discarded int := 0;
  v_n int;
begin
  if current_user::text in ('anon', 'authenticated', 'service_role')
     or pg_catalog.current_setting('role') <> 'none'
     or (v_claims ->> 'role') is not null
     or (v_claims #>> '{app_metadata,role}') is not null then
    raise exception 'app.disable_releases: the owner runs it from the runbook, on a direct session'
      using errcode = '42501';
  end if;
  if p_tenant is null or p_discard_pending is null
     or not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'app.disable_releases: a site, and whether to discard what is pending' using errcode = '22023';
  end if;
  if p_operator is null or not exists (
       select 1 from public.profiles p
        where p.id = p_operator and p.tenant_id = p_tenant and p.role::text = 'admin' and p.is_active
          and (p.locked_until is null or p.locked_until <= pg_catalog.now())) then
    raise exception 'app.disable_releases: the operator is an active Admin of this site' using errcode = '22023';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('release:' || p_tenant::text, 0)) then
    raise exception 'app.disable_releases: a release is publishing; try again in a moment' using errcode = '55P03';
  end if;
  if not app.releases_enabled(p_tenant) then
    raise exception 'app.disable_releases: releases are already off for this site' using errcode = '55000';
  end if;
  lock table public.content_drafts in share row exclusive mode;
  select count(*)::int into v_pending
    from public.content_drafts d where d.tenant_id = p_tenant and d.release_id is null;
  select count(*)::int into v_scheduled
    from public.content_releases r where r.tenant_id = p_tenant and r.status = 'scheduled';
  if (v_pending > 0 or v_scheduled > 0) and not p_discard_pending then
    raise exception 'app.disable_releases: % pending change(s) and % scheduled release(s) are waiting; publish or discard them first, or name the discard (p_discard_pending => true)',
      v_pending, v_scheduled using errcode = '55000';
  end if;

  delete from app.release_tenants where tenant_id = p_tenant;

  for v_rel in
    select r.* from public.content_releases r
     where r.tenant_id = p_tenant and r.status = 'scheduled'
     order by r.scheduled_for, r.id
       for update
  loop
    if v_rel.kind = 'legacy_schedule' then
      for v_item in select x.value from pg_catalog.jsonb_array_elements(v_rel.payload) as x(value) loop
        select e.* into v_reg from app.release_entities e where e.entity_type = v_item ->> 'entity_type';
        begin
          execute pg_catalog.format(
            'update public.%I as t set status = ''scheduled'', scheduled_for = $3 '
            'where t.tenant_id = $1 and t.id = $2 and t.status = ''draft''', v_reg.table_name)
            using p_tenant, (v_item ->> 'entity_id')::uuid, v_rel.scheduled_for;
          get diagnostics v_n = row_count;
          v_restored := v_restored + v_n;
          v_unrestored := v_unrestored + (1 - v_n);
        exception when others then
          v_unrestored := v_unrestored + 1;
        end;
      end loop;
    end if;
    update public.content_drafts as d set release_id = null
     where d.tenant_id = p_tenant and d.release_id = v_rel.id;
    update public.content_releases as r set status = 'cancelled', fire_lease_until = null
     where r.tenant_id = p_tenant and r.id = v_rel.id;
    v_cancelled := v_cancelled + 1;
  end loop;
  delete from public.content_drafts d where d.tenant_id = p_tenant;
  get diagnostics v_discarded = row_count;

  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, p_operator, 'admin', 'releases.disable', 'release', null,
          pg_catalog.jsonb_build_object('discarded', v_discarded, 'cancelled', v_cancelled,
                                        'restored_schedules', v_restored, 'not_restored', v_unrestored));
  return pg_catalog.jsonb_build_object(
    'tenant_id', p_tenant, 'discarded', v_discarded, 'cancelled', v_cancelled,
    'restored_schedules', v_restored, 'not_restored', v_unrestored);
end $$;
revoke all on function app.disable_releases(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks.
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_apply constant text := 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)';
  v_service_fns constant text[] := array[
    'public.claim_scheduled_releases(integer)',
    'public.fail_scheduled_release(uuid, uuid, text, uuid[])',
    'public.reschedule_release(uuid, text, uuid, integer, timestamp with time zone)',
    'public.unschedule_release(uuid, text, uuid, integer)'];
  v_owner_fns constant text[] := array[
    'app.enable_releases(uuid, uuid, uuid)',
    'app.disable_releases(uuid, uuid, boolean)'];
  v_bad text;
  v_src text;
  p text;
begin
  -- ---- The lease: a nullable timestamptz with no column grant; the due index.
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.content_releases'::regclass and a.attname = 'fire_lease_until'
                    and a.atttypid = 'timestamptz'::regtype and not a.attnotnull and not a.attisdropped
                    and cardinality(coalesce(a.attacl, '{}'::aclitem[])) = 0) then
    raise exception '0107: content_releases.fire_lease_until must be a nullable timestamptz with no column grant';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'content_releases'
                    and indexname = 'content_releases_scheduled_due_idx'
                    and indexdef ~ 'WHERE \(status = ''scheduled''::text\)') then
    raise exception '0107: content_releases_scheduled_due_idx is missing or not partial on scheduled releases';
  end if;

  -- ---- content_releases' privileges, as 0038 stated them and unchanged: authenticated
  -- SELECT, the service role SELECT, INSERT and UPDATE, PUBLIC and anon nothing; no DELETE,
  -- TRUNCATE, REFERENCES, TRIGGER or MAINTAIN for any API role.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.content_releases', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select', 'insert', 'update']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0107: wrong table privileges on content_releases (role privilege): %', v_bad;
  end if;

  -- ---- Every function: SECURITY INVOKER with an empty search_path and lock waits bounded;
  -- apply_release keeps 0051's settings.
  foreach p in array array[v_apply] || v_service_fns || v_owner_fns loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure and not f.prosecdef
                      and 'search_path=""' = any (coalesce(f.proconfig, '{}'::text[]))
                      and 'lock_timeout=5s' = any (coalesce(f.proconfig, '{}'::text[]))) then
      raise exception '0107: % must be SECURITY INVOKER with an empty search_path and lock_timeout 5s', p;
    end if;
  end loop;
  if not exists (select 1 from pg_proc f
                  where f.oid = v_apply::regprocedure
                    and 'statement_timeout=20s' = any (coalesce(f.proconfig, '{}'::text[]))) then
    raise exception '0107: apply_release lost its statement_timeout setting (PostgREST hoists it, R4)';
  end if;

  -- ---- Who may execute them: apply_release and the four cron and route functions the
  -- service role only; the two switches no API role (the owner runs them).
  select string_agg(format('%s %s', g.who, g.fn), ', ' order by g.fn, g.who) into v_bad
    from (select x.who, f.fn,
                 has_function_privilege(x.who::name, f.fn, 'execute') as held,
                 x.who = 'service_role' and f.fn <> all (v_owner_fns) as wanted
            from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as x(who)
            cross join unnest(array[v_apply] || v_service_fns || v_owner_fns) as f(fn)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0107: wrong EXECUTE privileges (role function): %', v_bad;
  end if;

  -- ---- The apply handles the four modes, re-reads the switch under the lock, fires only the
  -- drafts its release claimed, and keeps 0104's restore date rule.
  select prosrc into v_src from pg_proc where oid = v_apply::regprocedure;
  if v_src !~ 'p_mode not in \(''publish'', ''dry_run'', ''schedule'', ''fire''\)'
     or v_src ~ 'arrive with R11'
     or v_src !~ 'd\.release_id is not distinct from p_release_id'
     or v_src !~ 'v_restored \? \(v_it ->> ''draft_id''\)'
     or (select count(*) from regexp_matches(v_src, 'if not app\.releases_enabled\(v_tenant\) then', 'g')) <> 2 then
    raise exception '0107: apply_release does not read as R11 restated it';
  end if;

  -- ---- R4's and R5's catalog rules still hold: of the functions this file adds, none sets a
  -- setting, switches role or names the release token; among exposed functions only
  -- apply_release and crm_delete_lead_note call set_config.
  if exists (select 1 from pg_proc f
              where f.oid in (select x::regprocedure from unnest(v_service_fns || v_owner_fns) as x)
                and (f.prosrc ~* 'set_config' or f.prosrc ~* 'app\.release_apply'
                     or f.prosrc ~* 'set\s+(local|session)\s+role\M'
                     or f.prosrc ~* 'set\s+role\s+(?!=)'
                     or coalesce(array_to_string(f.proconfig, ','), '') ~* '(^|,)role=')) then
    raise exception '0107: a function of this file sets a setting, a role or names the release token';
  end if;
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('public', 'graphql_public') and f.prosrc ~* 'set_config'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_bad is distinct from 'public.apply_release, public.crm_delete_lead_note' then
    raise exception '0107: exposed functions calling set_config are %, expected apply_release and crm_delete_lead_note', v_bad;
  end if;

  -- ---- The switches' table list is app.publish_scheduled()'s (0098), table for table.
  select prosrc into v_src from pg_proc where oid = 'app.publish_scheduled()'::regprocedure;
  if v_src !~ 'array\[''disciplines'', ''services'', ''blog_posts'', ''portfolio'', ''pages'',\s+''testimonials'', ''service_cases'', ''faq_items''\]'
     or v_src !~ 'not app\.releases_enabled\(tenant_id\)' then
    raise exception '0107: app.publish_scheduled() is not the one app.enable_releases converts for (0098, skipping tenants with releases on)';
  end if;
  -- ...and its rows: scheduled WITH a time (a timeless one is never published by it, so the
  -- switch leaves it); a failure leaves a release a person moved since it was claimed.
  select prosrc into v_src from pg_proc where oid = 'app.enable_releases(uuid, uuid, uuid)'::regprocedure;
  if v_src !~ 'scheduled_for is not null' or v_src ~ 'coalesce\(t\.scheduled_for' then
    raise exception '0107: app.enable_releases must convert only the rows app.publish_scheduled() publishes (scheduled with a time)';
  end if;
  -- ...with every write to those tables held off while it reads and moves them.
  if v_src !~ 'lock table public\.%I in share row exclusive mode' then
    raise exception '0107: app.enable_releases must hold writes to the legacy tables off while it converts them';
  end if;
  select prosrc into v_src from pg_proc where oid = 'public.fail_scheduled_release(uuid, uuid, text, uuid[])'::regprocedure;
  if v_src !~ 'v_status <> ''scheduled'' or v_at > pg_catalog\.now\(\)' then
    raise exception '0107: fail_scheduled_release must leave a release that is no longer due';
  end if;

  -- ---- Nothing was switched on and nothing scheduled.
  if exists (select 1 from app.release_tenants) then
    raise exception '0107: app.release_tenants is not empty: releases must stay off until R14';
  end if;
  if exists (select 1 from public.content_releases r where r.fire_lease_until is not null) then
    raise exception '0107: a release holds a fire lease after the migration';
  end if;
end $$;
