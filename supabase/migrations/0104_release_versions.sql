-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0104: numbered versions (Admin v2 R10; docs/admin-v2/releases.md A3-7, A3-8, §6.1, §6.2).
-- A PLACEHOLDER number: the next free one is assigned at merge (scripts/renumber-migration.mjs).
--
-- Expand only. Releases stay off for every tenant (app.release_tenants is empty until R14).
--
--   • content_versions.seq: a snapshot's place in its entity's history, 1, 2, 3 …, unique per
--     (tenant, entity_type, entity_id) and in commit order. CLAUDE.md §8 left it to R10: a
--     snapshot records the row's own `version`, which app.tg_bump_version keeps when a writer
--     sends a different value, so two snapshots of one entity could share a number or run
--     backwards. The number is given by a BEFORE INSERT trigger on content_versions itself,
--     app.tg_content_version_seq, so every path that writes history (the snapshot triggers of
--     0009, 0016, 0021, 0028, 0038, 0098; a migration; a test fixture) is numbered alike and
--     none can supply, skip or later change it. It takes a transaction-scoped advisory lock per
--     entity, then reads the entity's highest number: a second writer of the same entity waits
--     for the first to commit and numbers after it (READ COMMITTED, as every PostgREST and
--     pg_cron write runs; a writer of one row already waits on its row lock). A unique index is
--     the backstop: a number taken twice fails the write (23505), never records a duplicate.
--     Existing rows are numbered once, by when their transaction began (`created_at`), then
--     the row's version, then the row's place in the table (`ctid`: insertion order, for a
--     table no API role updates or deletes, 0032), then the id; that is commit order except
--     where two transactions wrote one entity at once, which the per-entity lock now orders.
--     `version` is unchanged.
--   • public.release_as_of(p_tenant, p_number, p_limit, p_page): the state at version N, for a
--     restore (staged as pending changes) and a preview of that version. For every entity the
--     ledger touched after version N (release items and R5's system items), the `before` of its
--     earliest such item (its state at vN; null when it did not exist then), whether it exists
--     now (its latest item is not a removal) and, for a page section, its page. "After version
--     N" is the ledger's own order: items whose id is above the last item of any version up to
--     N. `portfolio_children` items give a case study's link sets at vN; team members are never
--     captured (owner item O-12) and never answered. p_page limits it to one page and its
--     sections (the page editor's page-scoped restore): a section on that page at vN, and one
--     on it now (moved onto it since, its restore sends it back where it was). An entity gone
--     now also carries the published_at it held when it was removed (the apply's rule
--     below, for the preview). SECURITY INVOKER: staff read the ledger under RLS
--     (content_releases_read, content_release_items_read: CMS staff of the tenant), so a
--     Sales token, another tenant or a stale role read nothing (P0002); EXECUTE for
--     authenticated only, anon nothing. One subrequest (P-15).
--   • app.tg_draft_lock (0062) restated with one change: an UPDATE by a caller the lock does
--     not bind (the service role, or no role claim) and that names no user keeps the draft's
--     `updated_by` instead of clearing it. A restore stages its changes as the person
--     (write_drafts, their RLS) and then marks them as a restore of the version
--     (`origin_kind`, `origin_release_id`) with the service role, which no staff token may do;
--     the service key names no user, so the mark used to leave the change with no author
--     ("Discard my changes" and the savebar's names read `updated_by`). A bound caller (every
--     staff token) is stamped exactly as before, and the provenance stays the unbound
--     caller's alone.
--   • public.apply_release (0051) restated with one change: a create a restore staged (its
--     mark) keeps the published_at its row held when it was removed (the ledger's last
--     removal of it), so a rolled-back post is not re-dated to today; every other create and
--     first publish is stamped now(), as before (releases.md §8 edge case 15). Grants as 0051.
--
-- No table, no capability, no app.role_* helper, no registry row, no screen, no help guide:
-- the screens are R13's. Grants are stated for both Supabase grant regimes (Admin v2 P-14).
-- Postconditions at the end.
--
-- CLAUDE.md §3 (Pillar 4, optimistic locking and history), §8 (Data model, versioning; Admin v2
-- lanes, Releases), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: content_versions gains a column, a CHECK, an
-- index and a trigger, and every content write snapshots into it.
set local lock_timeout = '5s';

-- ═══ 1. content_versions.seq ═════════════════════════════════════════════════════════════
alter table public.content_versions add column if not exists seq int;

-- The history already kept, numbered per entity in the order it was written: two snapshots of
-- one entity from one transaction share created_at (now()) and may share a version (a writer
-- sends its version back), so their place in the table, insertion order, decides before the
-- random id. Only rows with no number are written: a second run renumbers nothing (it could
-- otherwise reorder such a pair against the unique index). The trigger below is created
-- afterwards, so this is the one statement that ever writes the column.
drop trigger if exists content_versions_seq on public.content_versions;
update public.content_versions v
   set seq = n.seq
  from (select c.id,
               (pg_catalog.row_number() over (partition by c.tenant_id, c.entity_type, c.entity_id
                                              order by c.created_at, c.version, c.ctid, c.id))::int
                 as seq
          from public.content_versions c) n
 where v.id = n.id
   and v.seq is null;

alter table public.content_versions alter column seq set not null;
alter table public.content_versions drop constraint if exists content_versions_seq_positive;
alter table public.content_versions
  add constraint content_versions_seq_positive check (seq >= 1);
create unique index if not exists content_versions_entity_seq_key
  on public.content_versions (tenant_id, entity_type, entity_id, seq);
comment on column public.content_versions.seq is
  'Admin v2 R10 (0104): the snapshot''s place in its entity''s history (1, 2, 3 …), unique per '
  '(tenant_id, entity_type, entity_id) and in commit order; given by app.tg_content_version_seq. '
  '`version` is the row''s own version when it was snapshotted.';

-- ═══ 2. The number, given on every insert and never changed ═══════════════════════════════
-- SECURITY DEFINER, owned by the snapshot owner (who bypasses RLS, a postcondition): the
-- highest number of the entity is read whatever the inserting role's RLS would show. A trigger
-- function no API role may call.
create or replace function app.tg_content_version_seq() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- No API role holds UPDATE on content_versions (0032); a number is never rewritten either.
    new.seq := old.seq;
    return new;
  end if;
  -- One writer per entity at a time: a second waits here until the first commits, then reads
  -- its number (each statement of this volatile function takes a fresh snapshot).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'content_versions:' || new.tenant_id::text || ':' || new.entity_type || ':'
      || new.entity_id::text, 0));
  select coalesce(max(v.seq), 0) + 1 into new.seq
    from public.content_versions v
   where v.tenant_id = new.tenant_id
     and v.entity_type = new.entity_type
     and v.entity_id = new.entity_id;
  return new;
end $$;
revoke all on function app.tg_content_version_seq() from public, anon, authenticated, service_role;
comment on function app.tg_content_version_seq() is
  'Admin v2 R10 (0104): numbers each content_versions row within its entity (max + 1 under a '
  'per-entity advisory lock); an UPDATE keeps the number. Callable by no API role.';

create trigger content_versions_seq
  before insert or update on public.content_versions
  for each row execute function app.tg_content_version_seq();

-- ═══ 3. The state at a version ════════════════════════════════════════════════════════════
-- Answers one JSON object:
--   {"release":  {"id", "number", "kind", "note", "published_at", "published_by"},
--    "cutoff":   the last ledger item of any version up to N (0 when there is none),
--    "total":    the entities touched since (within p_page when given),
--    "entities": at most p_limit of them, in the order they were first changed since:
--                [{"entity_type", "entity_id", "before", "exists_now", "page_id",
--                  "removed_published_at"}]}
-- Refusals: 42501 another tenant named; 22023 a number below 1 or a limit outside 1..2000;
-- P0002 no published version N in the tenant (also what a reader of no release sees).
create or replace function public.release_as_of(p_tenant uuid, p_number int,
                                                p_limit int default 200,
                                                p_page uuid default null)
  returns jsonb
  language plpgsql stable security invoker set search_path = ''
as $$
declare
  c_max_limit constant int := 2000;
  v_release jsonb;
  v_cutoff bigint;
  v_out jsonb;
begin
  if p_tenant is null or p_tenant is distinct from app.effective_tenant_id() then
    raise exception 'release_as_of: the tenant is not the caller''s' using errcode = '42501';
  end if;
  if p_number is null or p_number < 1 or p_limit is null or p_limit < 1 or p_limit > c_max_limit then
    raise exception 'release_as_of: a version number from 1, and a limit of 1 to %', c_max_limit
      using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object('id', r.id, 'number', r.number, 'kind', r.kind,
                                       'note', r.note, 'published_at', r.published_at,
                                       'published_by', r.published_by)
    into v_release
    from public.content_releases r
   where r.tenant_id = p_tenant and r.number = p_number and r.status = 'published';
  if v_release is null then
    raise exception 'release_as_of: no such version' using errcode = 'P0002';
  end if;

  select coalesce(max(i.id), 0) into v_cutoff
    from public.content_release_items i
    join public.content_releases r on r.tenant_id = i.tenant_id and r.id = i.release_id
   where i.tenant_id = p_tenant and r.status = 'published' and r.number <= p_number;

  with since as (
    select i.id, i.entity_type, i.entity_id, i.op, i.before, i.after
      from public.content_release_items i
      left join public.content_releases r on r.tenant_id = i.tenant_id and r.id = i.release_id
     where i.tenant_id = p_tenant
       and i.id > v_cutoff
       and i.entity_type <> 'team_member'
       and (i.release_id is null or r.status = 'published')
  ), firsts as (
    select distinct on (s.entity_type, s.entity_id) s.entity_type, s.entity_id, s.before, s.id
      from since s
     order by s.entity_type, s.entity_id, s.id
  ), lasts as (
    select distinct on (s.entity_type, s.entity_id) s.entity_type, s.entity_id, s.op, s.before,
           s.after
      from since s
     order by s.entity_type, s.entity_id, s.id desc
  ), touched as (
    select f.entity_type, f.entity_id, f.before, f.id as first_item,
           (l.op <> 'delete') as exists_now,
           case when f.entity_type = 'page_section'
                then coalesce(f.before ->> 'page_id', l.after ->> 'page_id', l.before ->> 'page_id')
           end as page_id,
           -- The page a section is on now (it exists): one moved onto a page since belongs to
           -- that page's restore too, which sends it back where it was at vN.
           case when f.entity_type = 'page_section' and l.op <> 'delete'
                then l.after ->> 'page_id'
           end as page_now,
           -- Gone now: the first-publish date it held when it was removed, which the apply
           -- gives it back if a restore brings it back (section 5).
           case when l.op = 'delete' then l.before -> 'published_at' end as removed_published_at
      from firsts f
      join lasts l on l.entity_type = f.entity_type and l.entity_id = f.entity_id
  ), scoped as (
    select t.*, pg_catalog.row_number() over (order by t.first_item) as n
      from touched t
     where p_page is null
        or (t.entity_type = 'page' and t.entity_id = p_page)
        or (t.entity_type = 'page_section'
            and (t.page_id = p_page::text or t.page_now = p_page::text))
  )
  select pg_catalog.jsonb_build_object(
           'release', v_release,
           'cutoff', v_cutoff,
           'total', (select count(*) from scoped)::int,
           'entities', coalesce(
             (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'entity_type', s.entity_type, 'entity_id', s.entity_id,
                       'before', s.before, 'exists_now', s.exists_now, 'page_id', s.page_id,
                       'removed_published_at', s.removed_published_at)
                     order by s.n)
                from scoped s
               where s.n <= p_limit), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function public.release_as_of(uuid, int, int, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.release_as_of(uuid, int, int, uuid) to authenticated;
comment on function public.release_as_of(uuid, int, int, uuid) is
  'Admin v2 R10 (0104): the state at version N of the caller''s tenant, from the ledger: per '
  'entity touched since, its earliest before-image and whether it exists now. Invoker: the '
  'ledger''s staff-only RLS decides who reads it.';

-- ═══ 4. The restore's mark keeps the change's author ══════════════════════════════════════
-- 0062's body, unchanged but for step 3's `updated_by` (above): bound callers are stamped with
-- auth.uid() as before; an unbound UPDATE keeps the stored author when it names no user.
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
  -- 0104: an unbound UPDATE that names no user (the restore's mark, by the service role) keeps
  -- the author; every other write names its caller, as 0038 and 0062 did.
  if tg_op = 'UPDATE' and not v_bound then
    new.updated_by := coalesce(auth.uid(), old.updated_by);
  else
    new.updated_by := auth.uid();
  end if;
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

-- ═══ 5. A restored row keeps its first-publish date (apply_release restated) ══════════════
-- 0051's body, unchanged but for the published_at stamp of a create and the read of which
-- creates a restore staged (both marked 0104). A first publish stamps now(); a row a restore
-- brings back (a create carrying the restore's mark) keeps the published_at of the ledger's
-- last image of it, taken when it was removed, so a rolled-back post is not re-dated to today
-- (releases.md §8 edge case 15). Read as the service role, before the role switch: the ledger
-- is the system's record, and the date is the row's own. The next restatement of
-- apply_release builds on this one, not on 0051's.
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
  if p_mode in ('schedule', 'fire') then
    raise exception 'apply_release: scheduled releases arrive with R11' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('publish', 'dry_run') then
    raise exception 'apply_release: the mode is publish or dry_run' using errcode = '22023';
  end if;
  if p_release_id is not null or p_scheduled_for is not null then
    raise exception 'apply_release: a release id and a schedule arrive with R11' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('publish', 'rollback')
     or (p_kind = 'rollback') <> (p_restores_release_id is not null) then
    raise exception 'apply_release: a publish restores nothing, and a rollback names the version it restores'
      using errcode = '22023';
  end if;
  if p_actor is null or p_role is null then
    raise exception 'apply_release: the person publishing and their role are required' using errcode = '22023';
  end if;
  if p_note is not null and (pg_catalog.char_length(p_note) > 280 or p_note ~ '[[:cntrl:]]') then
    raise exception 'apply_release: a release note is at most 280 characters, with no control characters'
      using errcode = '22023';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'apply_release: the changes are an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_items) not between 1 and c_max_items then
    raise exception 'apply_release: a release holds 1 to 60 changes' using errcode = '22023';
  end if;

  for v_item, v_ord in
    select e.value, e.ord from pg_catalog.jsonb_array_elements(p_items) with ordinality as e(value, ord)
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
  if v_tenant is null then
    raise exception 'apply_release: this person cannot publish now' using errcode = 'BR403',
      detail = pg_catalog.jsonb_build_object('code', 'actor')::text;
  end if;
  if not app.releases_enabled(v_tenant) then
    raise exception 'apply_release: releases are not switched on for this site' using errcode = '55000';
  end if;

  -- ── 2. One release at a time per tenant ────────────────────────────────────────────────
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || v_tenant::text, 0));

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
      where d.tenant_id = v_tenant and d.id = i.draft_id and d.release_id is null
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
  if p_restores_release_id is not null and not exists (
       select 1 from public.content_releases r
        where r.tenant_id = v_tenant and r.id = p_restores_release_id and r.status = 'published') then
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
    insert into public.content_releases (id, tenant_id, kind, status, note, restores_release_id, created_by)
    values (v_release, v_tenant, p_kind, 'applying', p_note, p_restores_release_id, p_actor);

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
    if p_mode = 'publish' and pg_catalog.jsonb_array_length(v_conflicts) > 0 then
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
    if p_mode = 'publish' then
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
        if p_mode = 'publish' then
          v_current := null;
          insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
          values (v_tenant, p_actor, p_role, 'release.publish', 'release', v_release::text,
                  pg_catalog.jsonb_build_object(
                    'number', v_number, 'kind', p_kind, 'restores', p_restores_release_id,
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
        if p_mode = 'publish' then
          raise exception 'apply_release: the database refused a change' using errcode = 'BR422',
            detail = pg_catalog.jsonb_build_object('code', 'refused', 'items', pg_catalog.jsonb_build_array(v_fail))::text;
        end if;
        v_errors := v_errors || pg_catalog.jsonb_build_array(v_fail);
        if v_current is not null then
          v_failed := v_failed || pg_catalog.jsonb_build_object(v_current, true);
        end if;
      end;
    end loop;

    if p_mode = 'dry_run' then
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

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks.
do $$
declare
  -- The privileges 0032 stated on content_versions. MAINTAIN (PostgreSQL 17) is not among
  -- them: this migration adds a column, it grants and revokes nothing on the table, and the
  -- production read-back records what the API roles hold of it.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger'];
  v_bad text;
  v_owner oid;
begin
  -- ---- seq: present, NOT NULL, positive, unique per entity, nothing left unnumbered ------
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.content_versions'::regclass and attname = 'seq'
                    and atttypid = 'int4'::regtype and attnotnull and not attisdropped) then
    raise exception '0104: content_versions.seq must be an int NOT NULL';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.content_versions'::regclass
                    and conname = 'content_versions_seq_positive' and contype = 'c') then
    raise exception '0104: content_versions_seq_positive is missing';
  end if;
  if not exists (select 1 from pg_index x
                   join pg_class i on i.oid = x.indexrelid
                  where x.indrelid = 'public.content_versions'::regclass
                    and i.relname = 'content_versions_entity_seq_key' and x.indisunique
                    and pg_get_indexdef(x.indexrelid)
                        ~ '\(tenant_id, entity_type, entity_id, seq\)$') then
    raise exception '0104: content_versions_entity_seq_key must be UNIQUE (tenant_id, entity_type, entity_id, seq)';
  end if;
  -- Every entity's numbers run 1..n with no gap (the backfill, and nothing since).
  if exists (select 1 from public.content_versions
              group by tenant_id, entity_type, entity_id
             having max(seq) <> count(*) or min(seq) <> 1) then
    raise exception '0104: an entity''s history is not numbered 1..n';
  end if;

  -- ---- The trigger: one, BEFORE INSERT OR UPDATE, row level, on content_versions --------
  -- tgtype 23 = ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16).
  if (select string_agg(format('%s %s.%s %s', tg.tgname, n.nspname, f.proname, tg.tgtype), ', '
                        order by tg.tgname)
        from pg_trigger tg
        join pg_proc f on f.oid = tg.tgfoid
        join pg_namespace n on n.oid = f.pronamespace
       where tg.tgrelid = 'public.content_versions'::regclass and not tg.tgisinternal)
     is distinct from 'content_versions_seq app.tg_content_version_seq 23' then
    raise exception '0104: content_versions must carry exactly one trigger, the numbering';
  end if;
  -- The numbering is a definer with an empty search path, owned by the snapshot functions'
  -- owner (0032's insert policy names it), who bypasses RLS; no API role may call it.
  select proowner into v_owner from pg_proc where oid = 'app.tg_snapshot_version()'::regprocedure;
  if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                  where f.oid = 'app.tg_content_version_seq()'::regprocedure
                    and f.prosecdef and f.proconfig = array['search_path=""']
                    and f.proowner = v_owner and (r.rolsuper or r.rolbypassrls)) then
    raise exception '0104: app.tg_content_version_seq must be a SECURITY DEFINER with search_path '''', owned by the snapshot owner, who bypasses RLS';
  end if;
  if has_function_privilege('public', 'app.tg_content_version_seq()', 'execute')
     or has_function_privilege('anon', 'app.tg_content_version_seq()', 'execute')
     or has_function_privilege('authenticated', 'app.tg_content_version_seq()', 'execute')
     or has_function_privilege('service_role', 'app.tg_content_version_seq()', 'execute') then
    raise exception '0104: app.tg_content_version_seq must be callable by no API role';
  end if;

  -- ---- content_versions keeps 0032's privileges: staff read, nobody writes --------------
  -- authenticated: select only; anon and PUBLIC: nothing (no truncate, references or trigger
  -- either). The service role's (Supabase's default) is not this migration's.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (
      select x.who, pr.priv,
             has_table_privilege(x.who::name, 'public.content_versions', pr.priv) as held,
             pr.priv = any (x.allowed) as wanted
        from (values
          ('public', array[]::text[]),
          ('anon', array[]::text[]),
          ('authenticated', array['select'])
        ) as x(who, allowed)
        cross join unnest(v_privs) as pr(priv)
    ) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0104: wrong privileges on content_versions: %', v_bad;
  end if;
  -- The new column is reached through the table's grants only.
  if exists (select 1 from pg_attribute
              where attrelid = 'public.content_versions'::regclass and attname = 'seq'
                and attacl is not null) then
    raise exception '0104: content_versions.seq carries a column-level grant';
  end if;
  -- Still staff-only history (0001, 0038).
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_versions'
                    and policyname = 'content_versions_read' and cmd = 'SELECT'
                    and qual ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?is_staff\(\)\)$') then
    raise exception '0104: content_versions_read must stay the tenant, then CMS staff';
  end if;

  -- ---- release_as_of: an invoker, empty search path, authenticated alone ----------------
  if not exists (select 1 from pg_proc
                  where oid = 'public.release_as_of(uuid, int, int, uuid)'::regprocedure
                    and not prosecdef and proconfig = array['search_path=""']
                    and provolatile = 's') then
    raise exception '0104: public.release_as_of must be a STABLE SECURITY INVOKER with search_path ''''';
  end if;
  if not has_function_privilege('authenticated', 'public.release_as_of(uuid, int, int, uuid)', 'execute')
     or has_function_privilege('anon', 'public.release_as_of(uuid, int, int, uuid)', 'execute')
     or has_function_privilege('public', 'public.release_as_of(uuid, int, int, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.release_as_of(uuid, int, int, uuid)', 'execute') then
    raise exception '0104: public.release_as_of must be executable by authenticated only';
  end if;
  -- It sets nothing and switches nothing (R4's catalog: only apply_release sets claims or the
  -- release token; R5's: only apply_release switches role).
  if exists (select 1 from pg_proc
              where oid in ('public.release_as_of(uuid, int, int, uuid)'::regprocedure,
                            'app.tg_content_version_seq()'::regprocedure)
                and (prosrc ~* 'set_config' or prosrc ~* 'set\s+(local\s+|session\s+)?role')) then
    raise exception '0104: the new functions must not call set_config or switch role';
  end if;
  -- The ledger it reads stays the CMS staff's (0038): it is an invoker, so these decide.
  if (select count(*) from pg_policies
       where schemaname = 'public'
         and (tablename, policyname) in (('content_releases', 'content_releases_read'),
                                         ('content_release_items', 'content_release_items_read'))
         and cmd = 'SELECT' and qual ~ '(app\.)?is_staff\(\)') <> 2 then
    raise exception '0104: the ledger''s read policies must stay CMS staff only';
  end if;

  -- ---- The draft lock: still the one trigger on content_drafts, an invoker nobody calls,
  -- pinning the provenance (0062's checks), and keeping the author on an unbound update ----
  if (select string_agg(format('%s %s.%s %s', tg.tgname, n.nspname, f.proname, tg.tgtype), ', ')
        from pg_trigger tg
        join pg_proc f on f.oid = tg.tgfoid
        join pg_namespace n on n.oid = f.pronamespace
       where tg.tgrelid = 'public.content_drafts'::regclass and not tg.tgisinternal)
     is distinct from 'content_drafts_lock app.tg_draft_lock 31' then
    raise exception '0104: content_drafts must carry exactly one trigger, the draft lock';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.tg_draft_lock()'::regprocedure and not prosecdef
                    and proconfig = array['search_path=""']
                    and prosrc ~ 'new\.origin_kind := null'
                    and prosrc ~ 'new\.origin_release_id := old\.origin_release_id'
                    and prosrc ~ 'new\.updated_by := coalesce\(auth\.uid\(\), old\.updated_by\)')
     or has_function_privilege('anon', 'app.tg_draft_lock()', 'execute')
     or has_function_privilege('authenticated', 'app.tg_draft_lock()', 'execute')
     or has_function_privilege('service_role', 'app.tg_draft_lock()', 'execute')
     or has_function_privilege('public', 'app.tg_draft_lock()', 'execute') then
    raise exception '0104: app.tg_draft_lock must pin the provenance, keep the author on an unbound update and be callable by no API role';
  end if;

  -- ---- apply_release: as 0051 left it (an invoker, its settings, the service role alone),
  -- now keeping a restored row's first-publish date ------------------------------------
  if not exists (select 1 from pg_proc
                  where oid = 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)'::regprocedure
                    and not prosecdef
                    and proconfig @> array['search_path=""', 'statement_timeout=20s', 'lock_timeout=5s']
                    and prosrc ~ 'd\.origin_kind = ''restore'''
                    and prosrc ~ 'v_restored \? \(v_it ->> ''draft_id''\)'
                    and prosrc ~ 'pg_catalog\.jsonb_build_object\(''published_at'', pg_catalog\.now\(\)\)')
     or not has_function_privilege('service_role', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute')
     or has_function_privilege('public', 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)', 'execute') then
    raise exception '0104: public.apply_release must stay an invoker with 0051''s settings, executable by the service role alone, keeping a restored row''s first-publish date';
  end if;

  -- ---- Releases are still off everywhere (0038 to 0066) ------------------------------
  if exists (select 1 from app.release_tenants) then
    raise exception '0104: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
