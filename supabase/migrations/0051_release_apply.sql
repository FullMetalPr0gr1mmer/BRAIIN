-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0051 — Releases, part 2: applying a release, and capturing what it changes (Admin v2 R4).
-- Forward-only, EXPAND only, and INERT: public.apply_release refuses every tenant whose
-- releases are off (app.release_tenants stays empty until the switch-on slice, R14), and
-- nothing in the Worker calls it until R6. Depends on 0001, 0002, 0009, 0011, 0019, 0022,
-- 0025, 0028, 0031, 0038.
--
-- The design is docs/admin-v2/releases.md (§4.4 the algorithm, §4.5 conflicts, §4.6 audit,
-- slice R4), as the program README and docs/admin-v2/verification.md amend it; the
-- departures are in docs/admin-v2/as-built/R4.md.
--
--   • public.apply_release: SECURITY INVOKER, EXECUTE for the service role only. Applies up
--     to 60 pending changes (P-15) in one transaction, under a per-tenant advisory lock, as
--     the person publishing: it reads their live profile (the tenant comes from it, never
--     from a parameter), checks each draft is still the one they saw, checks the live rows
--     against each draft's base column by column, typed, then sets their claims and SET
--     LOCAL ROLE authenticated, so RLS, every RESTRICTIVE publish/archive/delete gate, the
--     CHECKs and the guard triggers bind as they would for that person. Every identifier in
--     its dynamic SQL comes from app.release_entities and is quoted with %I; every value is
--     bound (USING, jsonb_populate_record). A publish fails fast (one error, nothing kept); a
--     dry run collects every item's outcome and keeps nothing. The release is numbered and
--     its release.publish audit row written, as the publisher, in the same transaction. The
--     claims, the role and the release token are put back before it returns.
--     CLAUDE.md §9 states the one exception this makes to "set_config claim injection
--     restricted to the pgTAP harness".
--   • app.tg_release_capture: an AFTER trigger on every registry table but team_members
--     (owner item O-12, PDPL), writing a before/after image of each row a release changes,
--     cascades between registry tables included, and nothing at all outside a release.
--   • app.apply_portfolio_children: the link-set half of public.save_portfolio, moved out so
--     the apply can call it; save_portfolio is re-created around it, its signature, ACL
--     and behaviour unchanged.
--   • public.record_release_purge: the service role records a release's cache purge (R7).
--   • app.releases_enabled(uuid): the service role may now ask it (the apply does, before it
--     impersonates anyone).
--
-- Grants are stated for both Supabase grant regimes (Admin v2 P-14). No new table, column or
-- sequence. Postconditions at the end.
--
-- CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: nineteen live tables gain a trigger and
-- save_portfolio is re-created, and a statement that waits more than five seconds for a lock
-- raises, so the push is retried later rather than holding its place in the lock queue while
-- the site's reads and writes pile up behind it. Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. The flag, for the service role ═════════════════════════════════════════════════════
-- apply_release runs as the service role and asks the flag before anything else.
revoke all on function app.releases_enabled(uuid) from public, anon, authenticated, service_role;
grant execute on function app.releases_enabled(uuid) to service_role;

-- ═══ 2. Capture: what a release changes ════════════════════════════════════════════════════
-- tg_argv[0] = the entity type, tg_argv[1] = the key column ('id', or 'tenant_id' for a
-- singleton), tg_argv[2] = the table's generated columns, comma-separated (left out of the
-- images; read from the catalog when the trigger is created).
--
-- Outside a release it returns at once: one call to app.release_token_valid(), which reads a
-- setting, on every write to these tables. Inside one it records the row as it was and as it
-- is, the publisher (auth.uid(), their claims are set), and the draft the apply named in
-- app.release_item for this row (type, id and draft), or no draft for a row the item reached
-- indirectly: a cascade, a set-null, a theme the activation switched off. An UPDATE that
-- changes nothing but the version and the stamp writes nothing. Items are only appended:
-- several for one entity in one release are expected (the second pass, a cleared flag), and
-- a restore reads the earliest image (releases.md §6.2).
create or replace function app.tg_release_capture() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_strip text[] := coalesce(pg_catalog.string_to_array(nullif(tg_argv[2], ''), ','), '{}'::text[]);
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_id uuid;
  v_item text;
  v_draft uuid;
begin
  if not app.release_token_valid() then
    return null;
  end if;
  if tg_op <> 'INSERT' then
    v_before := pg_catalog.to_jsonb(old) - v_strip;
  end if;
  if tg_op <> 'DELETE' then
    v_after := pg_catalog.to_jsonb(new) - v_strip;
  end if;
  if tg_op = 'UPDATE'
     and (v_before - array['updated_at', 'version']::text[]) = (v_after - array['updated_at', 'version']::text[]) then
    return null;
  end if;
  v_row := coalesce(v_after, v_before);
  v_id := (v_row ->> tg_argv[1])::uuid;
  v_item := pg_catalog.current_setting('app.release_item', true);
  if v_item is not null
     and pg_catalog.split_part(v_item, ':', 1) = tg_argv[0]
     and pg_catalog.split_part(v_item, ':', 2) = v_id::text
     and pg_catalog.split_part(v_item, ':', 3)
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_draft := pg_catalog.split_part(v_item, ':', 3)::uuid;
  end if;
  insert into public.content_release_items
    (tenant_id, release_id, entity_type, entity_id, op, before, after, draft_id, actor_id)
  values ((v_row ->> 'tenant_id')::uuid, app.current_release_id(), tg_argv[0], v_id,
          case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end,
          v_before, v_after, v_draft, auth.uid());
  return null;
end $$;
revoke all on function app.tg_release_capture() from public, anon, authenticated, service_role;

-- One trigger per registry table, except team_members: release items would keep staff names
-- and bios after a removal, with no erasure path until owner item O-12 decides history
-- redaction (0038 keeps it out of content_versions for the same reason). The apply still
-- applies team-member drafts; it returns them as minimal items instead.
do $$
declare
  e record;
  v_generated text;
begin
  for e in select r.entity_type, r.table_name, r.key_column
             from app.release_entities r
            where r.entity_type <> 'team_member'
            order by r.entity_type
  loop
    select coalesce(string_agg(a.attname::text, ',' order by a.attnum), '') into v_generated
      from pg_attribute a
     where a.attrelid = format('public.%I', e.table_name)::regclass
       and a.attnum > 0 and not a.attisdropped and a.attgenerated = 's';
    execute format('drop trigger if exists %I on public.%I', e.table_name || '_release_capture', e.table_name);
    execute format('create trigger %I after insert or update or delete on public.%I '
                   'for each row execute function app.tg_release_capture(%L, %L, %L)',
                   e.table_name || '_release_capture', e.table_name, e.entity_type, e.key_column,
                   v_generated);
  end loop;
end $$;

-- ═══ 3. A case study's link sets, shared by save_portfolio and the apply ═══════════════════
-- 0022's child section of save_portfolio, unchanged but for its own two lines at the top:
-- the tenant named must be the caller's (as save_portfolio's always is), and a project and a
-- tenant are required. p_service_ids / p_media: the complete ordered set, or null to leave
-- that set untouched. Every id linked must exist in the caller's tenant (a foreign key alone
-- would accept another tenant's row). INVOKER: RLS binds every row it writes, for
-- save_portfolio's caller and for the publisher inside a release alike.
create or replace function app.apply_portfolio_children(
  p_tenant uuid,
  p_portfolio uuid,
  p_service_ids uuid[],
  p_media jsonb
) returns void
  language plpgsql volatile security invoker set search_path = ''
as $$
begin
  if p_tenant is null or p_portfolio is null then
    raise exception 'a case study and its tenant are required' using errcode = '22023';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    raise exception 'a case study''s links are written in the caller''s own tenant only'
      using errcode = '42501';
  end if;

  if p_service_ids is not null then
    if exists (select 1 from unnest(p_service_ids) as s(sid)
                where not exists (select 1 from public.services sv
                                   where sv.id = s.sid and sv.tenant_id = p_tenant)) then
      raise exception 'a linked service does not exist' using errcode = '23503';
    end if;
    delete from public.portfolio_services ps where ps.portfolio_id = p_portfolio;
    insert into public.portfolio_services (tenant_id, portfolio_id, service_id, sort_order)
    select p_tenant, p_portfolio, s.sid, s.ord - 1
      from unnest(p_service_ids) with ordinality as s(sid, ord);
  end if;

  if p_media is not null then
    if jsonb_typeof(p_media) <> 'array' or jsonb_array_length(p_media) > 40 then
      raise exception 'p_media must be an array of at most 40 items' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_media) as e(item)
                where e.item ->> 'media_id' is not null and not exists (
                  select 1 from public.media_assets m
                   where m.id = (e.item ->> 'media_id')::uuid and m.tenant_id = p_tenant)) then
      raise exception 'a linked media asset does not exist' using errcode = '23503';
    end if;
    delete from public.portfolio_media pm where pm.portfolio_id = p_portfolio;
    insert into public.portfolio_media
      (tenant_id, portfolio_id, role, kind, media_id, video_uid, video_path, clip_start_s,
       clip_end_s, duration_label, caption, breakdown_kind, layout, sort_order)
    select p_tenant, p_portfolio, e.item ->> 'role', e.item ->> 'kind',
           (e.item ->> 'media_id')::uuid, e.item ->> 'video_uid', e.item ->> 'video_path',
           (e.item ->> 'clip_start_s')::numeric, (e.item ->> 'clip_end_s')::numeric,
           e.item ->> 'duration_label', nullif(e.item -> 'caption', 'null'::jsonb),
           e.item ->> 'breakdown_kind', e.item ->> 'layout', (e.ord - 1)::int
      from jsonb_array_elements(p_media) with ordinality as e(item, ord);
  end if;
end $$;
revoke all on function app.apply_portfolio_children(uuid, uuid, uuid[], jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app.apply_portfolio_children(uuid, uuid, uuid[], jsonb) to authenticated;

-- 0022's save_portfolio, line for line, but for its child section, which is now the call
-- to app.apply_portfolio_children above. Same signature, settings and ACL.
create or replace function public.save_portfolio(
  p_id uuid,
  p_version int,
  p_values jsonb,
  p_service_ids uuid[] default null,
  p_media jsonb default null
) returns table (id uuid, version int)
  language plpgsql security invoker set search_path = public, app, pg_temp as $$
declare
  v_row public.portfolio;
  v_new public.portfolio;
  v_patch jsonb;
  v_tenant uuid := app.effective_tenant_id();
begin
  if not app.can_write_content() then
    raise exception 'writing case studies needs portfolio.write' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'p_values must be an object' using errcode = '22023';
  end if;
  -- The writable columns. Identity, tenancy, versioning, audit and generated columns can
  -- never be set through this function.
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_patch
    from jsonb_each(p_values)
   where key = any (array[
     'slug', 'title', 'summary', 'body', 'body_html', 'status', 'sort_order', 'published_at',
     'scheduled_for', 'project_type', 'teaser', 'lead', 'goal', 'result', 'scope',
     'keywords', 'results', 'sector_id', 'client_id', 'year', 'is_featured',
     'poster_media_id', 'preview_video_uid', 'preview_video_path', 'preview_start_s',
     'preview_end_s', 'next_portfolio_id', 'is_placeholder']);

  -- Linked rows must exist in the caller's tenant, as the caller can see them.
  if (v_patch ? 'sector_id' and v_patch ->> 'sector_id' is not null and not exists (
        select 1 from public.sectors s where s.id = (v_patch ->> 'sector_id')::uuid and s.tenant_id = v_tenant))
     or (v_patch ? 'client_id' and v_patch ->> 'client_id' is not null and not exists (
        select 1 from public.clients c where c.id = (v_patch ->> 'client_id')::uuid and c.tenant_id = v_tenant))
     or (v_patch ? 'poster_media_id' and v_patch ->> 'poster_media_id' is not null and not exists (
        select 1 from public.media_assets m where m.id = (v_patch ->> 'poster_media_id')::uuid and m.tenant_id = v_tenant))
     or (v_patch ? 'next_portfolio_id' and v_patch ->> 'next_portfolio_id' is not null and not exists (
        select 1 from public.portfolio q where q.id = (v_patch ->> 'next_portfolio_id')::uuid and q.tenant_id = v_tenant))
  then
    raise exception 'a linked record does not exist' using errcode = '23503';
  end if;

  if p_id is null then
    -- One INSERT, so a create is one version and one content_versions snapshot. Columns
    -- the patch omits take the table defaults (jsonb_populate_record would give NULL).
    v_new := jsonb_populate_record(null::public.portfolio,
      jsonb_build_object('status', 'draft', 'sort_order', 0, 'scope', '[]'::jsonb,
                         'keywords', '[]'::jsonb, 'results', '[]'::jsonb,
                         'is_featured', false, 'is_placeholder', false) || v_patch);
    insert into public.portfolio (
      slug, title, summary, body, body_html, status, sort_order, published_at, scheduled_for,
      project_type, teaser, lead, goal, result, scope, keywords, results, sector_id, client_id,
      year, is_featured, poster_media_id, preview_video_uid, preview_video_path,
      preview_start_s, preview_end_s, next_portfolio_id, is_placeholder
    ) values (
      v_new.slug, v_new.title, v_new.summary, v_new.body, v_new.body_html, v_new.status,
      v_new.sort_order, v_new.published_at, v_new.scheduled_for, v_new.project_type,
      v_new.teaser, v_new.lead, v_new.goal, v_new.result, v_new.scope, v_new.keywords,
      v_new.results, v_new.sector_id, v_new.client_id, v_new.year, v_new.is_featured,
      v_new.poster_media_id, v_new.preview_video_uid, v_new.preview_video_path,
      v_new.preview_start_s, v_new.preview_end_s, v_new.next_portfolio_id, v_new.is_placeholder
    ) returning * into v_new;
  else
    select * into v_row from public.portfolio p
     where p.tenant_id = v_tenant and p.id = p_id
       for update;
    if not found then
      raise exception 'portfolio % not found', p_id using errcode = 'P0002';
    end if;
    -- A missing version is a stale one: an update without the lock token would be the
    -- last-write-wins save optimistic locking exists to prevent.
    if p_version is null or v_row.version <> p_version then
      raise exception 'portfolio % was modified by someone else', p_id using errcode = '40001';
    end if;

    -- The stored row with the patch laid over it: keys absent from the patch keep their
    -- stored values (jsonb_populate_record reads unmatched columns from its base).
    v_new := jsonb_populate_record(v_row, v_patch);

    update public.portfolio p set
      slug = v_new.slug, title = v_new.title, summary = v_new.summary, body = v_new.body,
      body_html = v_new.body_html, status = v_new.status, sort_order = v_new.sort_order,
      published_at = v_new.published_at, scheduled_for = v_new.scheduled_for,
      project_type = v_new.project_type, teaser = v_new.teaser, lead = v_new.lead,
      goal = v_new.goal, result = v_new.result, scope = v_new.scope,
      keywords = v_new.keywords, results = v_new.results, sector_id = v_new.sector_id,
      client_id = v_new.client_id, year = v_new.year, is_featured = v_new.is_featured,
      poster_media_id = v_new.poster_media_id, preview_video_uid = v_new.preview_video_uid,
      preview_video_path = v_new.preview_video_path, preview_start_s = v_new.preview_start_s,
      preview_end_s = v_new.preview_end_s, next_portfolio_id = v_new.next_portfolio_id,
      is_placeholder = v_new.is_placeholder
     where p.tenant_id = v_tenant and p.id = v_row.id
    returning * into v_new;
    if not found then
      -- RLS filtered the UPDATE: an authorization outcome, not a missing row.
      raise exception 'the database refused the portfolio write' using errcode = '42501';
    end if;
  end if;

  -- The child sets (0051: the same statements, moved to the shared helper).
  perform app.apply_portfolio_children(v_tenant, v_new.id, p_service_ids, p_media);

  return query select v_new.id, v_new.version;
end $$;
revoke all on function public.save_portfolio(uuid, int, jsonb, uuid[], jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_portfolio(uuid, int, jsonb, uuid[], jsonb) to authenticated;

-- ═══ 4. public.apply_release ═══════════════════════════════════════════════════════════════
-- Errors (the Worker, R6, maps them): BR403 the person cannot publish now (403); BR409 a
-- pending change moved since it was read, or the live site moved under it (409, detail
-- JSON); BR422 the database refused a change, or a draft carries no base for a column it
-- changes (422, detail JSON per item and field); 55000 releases are off for the tenant
-- (409); 22023 a malformed call (400); 42501 a caller other than the service role.
--
-- p_items: an array of 1 to 60 changes, each exactly
--   {draft_id, draft_version, entity_type, entity_id, op, patch, base[, children]}
-- (packages/schemas/release.ts ApplyItemSchema), where patch is the change as column values
-- (the Worker's toRow), base the live values of those columns when the draft began, and
-- children a case study's link sets ({service_ids?, media?}).
--
-- Order: creates and updates by apply order ascending (within one order, a change that sets
-- a unique flag to true after the others, so a cleared flag lands first), then the
-- self-references held back from them (second pass), then removals by apply order
-- descending (children before parents).
--
-- Time: lock_timeout (5 s) binds every lock this function waits for, the advisory lock
-- included (55P03). The statement_timeout in its SET clause does NOT bound the call: the
-- timer is armed when a top-level statement starts, and a function's SET clause does not
-- re-arm it. It stays only because PostgREST v12 hoists a function's statement_timeout to
-- the transaction it opens (verification Q1e), which R6 must confirm on staging; the cap
-- that holds is the caller's (a statement_timeout PostgREST applies for the service role,
-- or the Worker's own request timeout and cancel), an R6 item.
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
      v_children := pg_catalog.jsonb_build_object('service_ids', v_sids, 'media', v_media);
    end if;

    if v_it ->> 'op' = 'delete' and v_patch <> '{}'::jsonb then
      raise exception 'apply_release: a removal carries no patch' using errcode = '22023';
    end if;
    if v_it ->> 'op' = 'update' and v_patch = '{}'::jsonb and v_children is null then
      raise exception 'apply_release: change % changes nothing', v_it ->> 'ord' using errcode = '22023';
    end if;
    if v_it ->> 'op' = 'update' then
      select string_agg(c.col, ', ' order by c.col) into v_bad
        from unnest(v_cols) as c(col) where not ((v_it -> 'base') ? c.col);
      if v_bad is not null then
        raise exception 'apply_release: a pending change carries no base for %', v_bad
          using errcode = 'BR422',
                detail = pg_catalog.jsonb_build_object(
                  'code', 'base-missing', 'draftId', v_it ->> 'draft_id',
                  'columns', pg_catalog.to_jsonb(pg_catalog.string_to_array(v_bad, ', ')))::text;
      end if;
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

  -- The drafts: locked, in id order, and each still the one the publisher saw. Another
  -- tenant's draft is not found here, as a missing one is not.
  select array_agg((x.value ->> 'draft_id')::uuid order by (x.value ->> 'draft_id')::uuid)
    into v_draft_ids
    from pg_catalog.jsonb_array_elements(v_plan) as x(value);
  perform 1 from public.content_drafts d
    where d.tenant_id = v_tenant and d.id = any (v_draft_ids)
    order by d.id
    for update;
  select coalesce(pg_catalog.jsonb_agg(i.draft_id order by i.draft_id), '[]'::jsonb) into v_stale
    from pg_catalog.jsonb_to_recordset(v_plan)
           as i(draft_id uuid, draft_version int, entity_type text, entity_id uuid, op text)
   where not exists (
     select 1 from public.content_drafts d
      where d.tenant_id = v_tenant and d.id = i.draft_id and d.release_id is null
        and d.version = i.draft_version and d.entity_type = i.entity_type
        and d.entity_id = i.entity_id and d.op = i.op);
  if pg_catalog.jsonb_array_length(v_stale) > 0 then
    raise exception 'apply_release: a pending change moved since it was read' using errcode = 'BR409',
      detail = pg_catalog.jsonb_build_object('code', 'pending-changed', 'draftIds', v_stale)::text;
  end if;
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
    -- draft's base column by column as the column's own type ('12.50' is 12.5), whatever
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
             pg_catalog.jsonb_object_agg(c.col, (v_it -> 'base') -> c.col)
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
              'base', (select pg_catalog.jsonb_object_agg(m.col, (v_it -> 'base') -> m.col) from unnest(v_moved) as m(col)))
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
      -- rewrites it (truthful dates, CLAUDE.md §3 Pillar 3).
      if (v_it ->> 'has_published_at')::boolean and (v_patch ->> 'status') = 'published'
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
            if v_n = 0 then
              -- RLS filtered the statement: the publisher may not make this change.
              raise exception 'the database refused this change for the person publishing it'
                using errcode = '42501';
            end if;
          end if;
          -- A case study's link sets, replaced as whole sets (save_portfolio's own code),
          -- with their images before and after for the synthetic portfolio_children item.
          if nullif(v_it -> 'children', 'null'::jsonb) is not null then
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
      if v_state in ('BR409', 'BR422') then
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

-- ═══ 5. public.record_release_purge: how a release's cache purge went (R7) ═════════════════
-- The service role only. Attempts count every outcome but not_needed; purged_at is stamped
-- when it is done; tags (at most 100, `<kind>:<value>` in lower case) replace the stored
-- set when given; side effects are merged in. P0002 when the release is not that tenant's,
-- or not live.
create or replace function public.record_release_purge(
  p_tenant uuid,
  p_release uuid,
  p_status text,
  p_tags text[],
  p_next_at timestamptz default null,
  p_side_effects jsonb default null
) returns void
  language plpgsql volatile security invoker set search_path = ''
as $$
begin
  if current_user::text <> 'service_role' then
    raise exception 'record_release_purge: only the service role records a purge' using errcode = '42501';
  end if;
  if p_tenant is null or p_release is null then
    raise exception 'record_release_purge: a tenant and a release are required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('pending', 'done', 'skipped', 'failed', 'not_needed') then
    raise exception 'record_release_purge: the purge status is pending, done, skipped, failed or not_needed'
      using errcode = '22023';
  end if;
  if p_tags is not null
     and (pg_catalog.cardinality(p_tags) > 100
          or pg_catalog.array_ndims(p_tags) > 1
          or exists (select 1 from unnest(p_tags) as t(tag)
                      where t.tag is null or t.tag !~ '^[a-z_]+:[a-z0-9_:-]+$')) then
    raise exception 'record_release_purge: at most 100 tags, each <kind>:<value> in lower case'
      using errcode = '22023';
  end if;
  if p_side_effects is not null and pg_catalog.jsonb_typeof(p_side_effects) <> 'object' then
    raise exception 'record_release_purge: side effects are an object' using errcode = '22023';
  end if;
  update public.content_releases r
     set purge_status = p_status,
         purge_attempts = r.purge_attempts + case when p_status = 'not_needed' then 0 else 1 end,
         purge_next_at = p_next_at,
         purged_at = case when p_status = 'done' then pg_catalog.now() else r.purged_at end,
         tags = case when p_tags is null then r.tags
                     else array(select distinct t.tag from unnest(p_tags) as t(tag) order by t.tag) end,
         side_effects = r.side_effects || coalesce(p_side_effects, '{}'::jsonb)
   where r.tenant_id = p_tenant and r.id = p_release and r.status = 'published';
  if not found then
    raise exception 'record_release_purge: no such published release' using errcode = 'P0002';
  end if;
end $$;
revoke all on function public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)
  to service_role;

-- ═══ Postconditions ════════════════════════════════════════════════════════════════════════
-- Each block says what it checks.
do $$
declare
  v_apply constant text := 'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)';
  v_purge constant text := 'public.record_release_purge(uuid, uuid, text, text[], timestamptz, jsonb)';
  v_children constant text := 'app.apply_portfolio_children(uuid, uuid, uuid[], jsonb)';
  v_save constant text := 'public.save_portfolio(uuid, int, jsonb, uuid[], jsonb)';
  v_owner oid;
  v_bad text;
  v_have text;
  p text;
  r text;
begin
  -- ---- The two RPCs: INVOKER, settings pinned, EXECUTE for the service role only ----------
  if to_regprocedure(v_apply) is null or to_regprocedure(v_purge) is null then
    raise exception '0051: apply_release or record_release_purge is missing (or its signature changed)';
  end if;
  if exists (select 1 from pg_proc where oid in (v_apply::regprocedure, v_purge::regprocedure) and prosecdef) then
    raise exception '0051: apply_release and record_release_purge must be SECURITY INVOKER (SET ROLE needs it)';
  end if;
  -- (Its statement_timeout is not checked: inside a call it bounds nothing; see its header.)
  if not (select coalesce(proconfig, '{}') @> array['search_path=""', 'lock_timeout=5s']
            from pg_proc where oid = v_apply::regprocedure) then
    raise exception '0051: apply_release must pin an empty search_path and lock_timeout 5s';
  end if;
  if not (select coalesce(proconfig, '{}') @> array['search_path=""'] from pg_proc where oid = v_purge::regprocedure) then
    raise exception '0051: record_release_purge must pin an empty search_path';
  end if;
  foreach p in array array[v_apply, v_purge] loop
    if not has_function_privilege('service_role', p, 'execute') then
      raise exception '0051: the service role cannot execute %', p;
    end if;
    foreach r in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(r::name, p, 'execute') then
        raise exception '0051: % can execute %', r, p;
      end if;
    end loop;
  end loop;

  -- ---- The link-set helper: INVOKER, EXECUTE for authenticated only ----------------------
  if (select prosecdef from pg_proc where oid = v_children::regprocedure) then
    raise exception '0051: app.apply_portfolio_children must be SECURITY INVOKER (RLS binds its writes)';
  end if;
  if not has_function_privilege('authenticated', v_children, 'execute')
     or has_function_privilege('anon', v_children, 'execute')
     or has_function_privilege('public', v_children, 'execute')
     or has_function_privilege('service_role', v_children, 'execute') then
    raise exception '0051: app.apply_portfolio_children must be executable by authenticated only';
  end if;

  -- ---- save_portfolio: the same signature, INVOKER, authenticated only (0022) -----------
  if to_regprocedure(v_save) is null
     or (select prosecdef from pg_proc where oid = v_save::regprocedure)
     or not has_function_privilege('authenticated', v_save, 'execute')
     or has_function_privilege('anon', v_save, 'execute')
     or has_function_privilege('public', v_save, 'execute')
     or has_function_privilege('service_role', v_save, 'execute') then
    raise exception '0051: save_portfolio must keep its signature, stay INVOKER and be executable by authenticated only';
  end if;

  -- ---- The flag reader: the service role, and no other API role -------------------------
  if not has_function_privilege('service_role', 'app.releases_enabled(uuid)', 'execute')
     or has_function_privilege('anon', 'app.releases_enabled(uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.releases_enabled(uuid)', 'execute')
     or has_function_privilege('public', 'app.releases_enabled(uuid)', 'execute') then
    raise exception '0051: app.releases_enabled(uuid) must be executable by the service role only';
  end if;

  -- ---- The capture trigger: a definer under the snapshot owner, who bypasses RLS ---------
  select proowner into v_owner from pg_proc where oid = 'app.tg_snapshot_version()'::regprocedure;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.tg_release_capture()'::regprocedure
                    and f.prosecdef and f.proowner = v_owner
                    and coalesce(f.proconfig, '{}') @> array['search_path=""']) then
    raise exception '0051: app.tg_release_capture must be SECURITY DEFINER, search_path pinned, owned by the snapshot owner';
  end if;
  if not exists (select 1 from pg_roles where oid = v_owner and (rolsuper or rolbypassrls)) then
    raise exception '0051: the capture trigger''s owner does not bypass RLS';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r::name, 'app.tg_release_capture()', 'execute') then
      raise exception '0051: % can execute app.tg_release_capture()', r;
    end if;
  end loop;

  -- ---- One capture trigger on every registry table but team_members, and nowhere else:
  -- AFTER, FOR EACH ROW, on INSERT, UPDATE and DELETE (tgtype 1 + 4 + 8 + 16), named for its
  -- table, with the entity type and the key as its first two arguments -------------------
  select string_agg(e.entity_type, ', ' order by e.entity_type) into v_bad
    from app.release_entities e
   where e.entity_type <> 'team_member'
     and (select count(*) from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgfoid = 'app.tg_release_capture()'::regprocedure
             and tg.tgname = e.table_name || '_release_capture'
             and tg.tgtype = 29 and tg.tgnargs = 3
             and position(convert_to(e.entity_type, 'UTF8') || '\x00'::bytea
                          || convert_to(e.key_column, 'UTF8') || '\x00'::bytea in tg.tgargs) = 1) <> 1;
  if v_bad is not null then
    raise exception '0051: registry tables without exactly one capture trigger: %', v_bad;
  end if;
  select string_agg(format('%s.%s', tg.tgrelid::regclass, tg.tgname), ', ') into v_bad
    from pg_trigger tg
   where tg.tgfoid = 'app.tg_release_capture()'::regprocedure
     and (tg.tgrelid = 'public.team_members'::regclass
          or tg.tgrelid not in (select format('public.%I', e.table_name)::regclass from app.release_entities e));
  if v_bad is not null then
    raise exception '0051: capture triggers where none belongs (team_members waits on O-12): %', v_bad;
  end if;

  -- ---- The apply reads and locks live rows as the service role: it must hold SELECT and
  -- UPDATE (FOR UPDATE needs it) on every registry table -----------------------------------
  select string_agg(e.table_name, ', ' order by e.table_name) into v_bad
    from app.release_entities e
   where not (has_table_privilege('service_role', format('public.%I', e.table_name), 'select')
              and has_table_privilege('service_role', format('public.%I', e.table_name), 'update'));
  if v_bad is not null then
    raise exception '0051: the service role cannot read and lock: %', v_bad;
  end if;

  -- ---- The release token cannot be set from an exposed schema (verification claims 10 and
  -- 18): among the functions in public and graphql_public that are not an extension's, the
  -- ones calling set_config are exactly apply_release and crm_delete_lead_note (0041,
  -- app.acting_for); only apply_release sets claims; and the release token's setting is
  -- named by apply_release and app.release_token_valid only, in any schema -----------------
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('public', 'graphql_public')
     and f.prosrc ~* 'set_config'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'public.apply_release, public.crm_delete_lead_note' then
    raise exception '0051: exposed functions calling set_config are %, expected apply_release and crm_delete_lead_note', v_have;
  end if;
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('public', 'graphql_public')
     and f.prosrc ~* 'set_config' and f.prosrc ~* 'request\.jwt\.claim'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'public.apply_release' then
    raise exception '0051: exposed functions setting claims are %, expected apply_release only', v_have;
  end if;
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
     and f.prosrc ~* 'app\.release_apply'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'app.release_token_valid, public.apply_release' then
    raise exception '0051: functions naming the release token are %, expected app.release_token_valid and apply_release', v_have;
  end if;

  -- ---- Releases are still off everywhere -------------------------------------------------
  if exists (select 1 from app.release_tenants) then
    raise exception '0051: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
