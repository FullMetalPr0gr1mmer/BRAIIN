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
--     sections (the page editor's page-scoped restore). SECURITY INVOKER: staff read the ledger
--     under RLS (content_releases_read, content_release_items_read: CMS staff of the tenant),
--     so a Sales token, another tenant or a stale role read nothing (P0002); EXECUTE for
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
--                [{"entity_type", "entity_id", "before", "exists_now", "page_id"}]}
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
           end as page_id
      from firsts f
      join lasts l on l.entity_type = f.entity_type and l.entity_id = f.entity_id
  ), scoped as (
    select t.*, pg_catalog.row_number() over (order by t.first_item) as n
      from touched t
     where p_page is null
        or (t.entity_type = 'page' and t.entity_id = p_page)
        or (t.entity_type = 'page_section' and t.page_id = p_page::text)
  )
  select pg_catalog.jsonb_build_object(
           'release', v_release,
           'cutoff', v_cutoff,
           'total', (select count(*) from scoped)::int,
           'entities', coalesce(
             (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'entity_type', s.entity_type, 'entity_id', s.entity_id,
                       'before', s.before, 'exists_now', s.exists_now, 'page_id', s.page_id)
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

  -- ---- Releases are still off everywhere (0038 to 0066) ------------------------------
  if exists (select 1 from app.release_tenants) then
    raise exception '0104: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
