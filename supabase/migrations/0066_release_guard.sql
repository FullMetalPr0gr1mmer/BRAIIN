-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0066 — Releases, part 3: the release guard, complete capture, media_usage v4 and
-- dashboard_attention v4 (Admin v2 R5). Forward-only, EXPAND only but for one privilege
-- revoke nothing uses (TRUNCATE, section 9), and INERT: every new branch asks
-- app.releases_enabled(tenant), and app.release_tenants stays empty until the switch-on
-- slice (R14), so with releases off every write path behaves exactly as before this file.
-- Depends on 0001, 0009, 0010, 0011, 0019, 0022, 0028, 0038, 0051, 0057, 0061 and 0062.
--
-- The design is docs/admin-v2/releases.md (A3-6 the guard, A3-7 the ledger, §2.4, §4.4,
-- §4.6, §8 edge cases 4, 5, 9, 20, 21 and 23, slice R5), as the program README and
-- docs/admin-v2/verification.md (Releases, claims 8, 9 and 19) amend it; the departures are
-- in docs/admin-v2/as-built/R5.md.
--
--   • app.tg_release_guard: a BEFORE INSERT/UPDATE/DELETE row trigger,
--     `<table>__release_guard`, on every registry table (team_members included) and on both
--     case-study link tables. For a tenant with releases on it refuses (42501) any API write
--     outside the release of its own transaction, at any depth: there is no
--     pg_trigger_depth exemption, so a trigger reached by a staff request is refused like
--     the request itself. Allowed: inside this transaction's release; a session with no SET
--     ROLE and no staff claim (migrations, seeds, the runbook, pg_cron, GoTrue); the service
--     role with no staff claim (recorded as a system item); an UPDATE that changes only the
--     registry's immediate columns (exempt_columns) and the stamps. The double underscore
--     sorts it before every other trigger on its table, so its refusal is the one staff see
--     and no other BEFORE trigger's work runs first.
--   • Out-of-band capture: app.tg_release_capture (0051) re-created so that, outside a
--     release, a write to a registry table of a tenant with releases on is recorded as a
--     SYSTEM ITEM (content_release_items with no release and no draft). The items table's
--     release_id becomes nullable, with a shape CHECK, a partial index and a second owner
--     insert policy.
--   • Link-set capture: a case study's link sets (portfolio_services, portfolio_media) are
--     recorded as one `portfolio_children` item per case study per statement, in R4's
--     synthetic shape (app.portfolio_link_sets), cascades from a project or service removal
--     included, inside a release and out of band. A BEFORE ROW trigger keeps the sets as
--     they were the first time a statement touches a case study (app.release_link_pending,
--     a transaction-scoped scratch table); an AFTER STATEMENT trigger writes the item with
--     the sets as they are now. Reversing a transition table instead would give a project
--     removal two items each missing the other table's half: PostgreSQL fires both child
--     tables' statement triggers after BOTH cascades (as-built R5, departure 1). The apply's
--     own link-set step is skipped (R4's synthetic item stands, D4).
--   • public.media_usage v4: a pending change counts as a reference (any string in a
--     draft's payload equal to the asset's id, in any spelling uuid_in reads), with a new
--     `pending boolean` column; search_path '' and every branch tenant-first.
--   • public.dashboard_attention v4: release_scheduled_today (the Riyadh day),
--     release_overdue (more than 5 minutes late), release_failed and purge_failed (within 7
--     days), draft_stale (unclaimed, untouched for 30 days).
--   • app.publish_scheduled(): skips tenants with releases on (their schedule is R11's).
--   • TRUNCATE revoked on every guarded table from every API role: TRUNCATE fires no row
--     trigger, so neither the guard nor the capture would see it.
--
-- No capability, no app.role_* helper, no registry row, no screen, no help guide. Grants are
-- stated for both Supabase grant regimes (Admin v2 P-14). Postconditions at the end.
--
-- Portability note (0038's): the capture and link triggers insert as their owner, the
-- snapshot owner, which bypasses RLS on Supabase (a postcondition holds it). On a host whose
-- owner did not, the owner insert policies below would apply, and a runbook write to a
-- tenant other than the default one would be refused by their tenant predicate.
--
-- CLAUDE.md §3 (Pillar 1, Pillar 4), §8 (Admin v2 lanes, Releases; Media), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: twenty-three live tables gain triggers,
-- the items table loses a NOT NULL and gains a CHECK, media_usage is dropped and created and
-- a view is replaced, and a statement that waits more than five seconds for a lock raises,
-- so the push is retried later rather than holding its place in the lock queue while the
-- site's reads and writes pile up behind it. Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. A case study's link sets, as one image ═════════════════════════════════════════════
-- Exactly the expression apply_release (0051) uses for its synthetic portfolio_children
-- item: the linked service ids in order, and the media rows (minus tenant_id) in order. One
-- definition, so the link capture below and R4's item cannot drift (pgTAP compares them).
create or replace function app.portfolio_link_sets(p_tenant uuid, p_portfolio uuid)
  returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
           'service_ids', coalesce((select pg_catalog.jsonb_agg(ps.service_id order by ps.sort_order, ps.service_id)
                                      from public.portfolio_services ps
                                     where ps.tenant_id = p_tenant and ps.portfolio_id = p_portfolio), '[]'::jsonb),
           'media', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pm) - 'tenant_id'::text order by pm.sort_order, pm.id)
                                from public.portfolio_media pm
                               where pm.tenant_id = p_tenant and pm.portfolio_id = p_portfolio), '[]'::jsonb))
$$;
revoke all on function app.portfolio_link_sets(uuid, uuid) from public, anon, authenticated, service_role;

-- ═══ 2. The guard ═══════════════════════════════════════════════════════════════════════════
-- "An API request" is read from two places PostgREST sets and a SECURITY DEFINER call does
-- not change: the role setting (`SET LOCAL ROLE authenticated`, anon or service_role; 'none'
-- when nobody switched role) and the staff claim (app_metadata.role). Keying on both keeps
-- the allow paths independent of the service-role JWT's claim shape: a staff claim is bound
-- whatever the role, and a switched role other than the service role is bound whatever the
-- claims. Inside apply_release the role is authenticated and the token is valid (step 1).
--
-- Every allow path returns OLD for a DELETE and NEW otherwise: a BEFORE row trigger that
-- returned null would silently skip the row.
create or replace function app.tg_release_guard() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
  v_staff text;
  v_tid uuid;
  v_foreign boolean;
  v_on boolean;
  v_allowed text[];
  v_changed text[];
begin
  -- 1. This transaction's release: the apply's writes, and every cascade they cause.
  if app.release_token_valid() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- 2 and 3. Not an API request (no switched role, no staff claim: migrations, seeds, the
  -- runbook, pg_cron, GoTrue), or the service role with no staff claim (out of band; the
  -- capture records it as a system item).
  v_role := coalesce(nullif(pg_catalog.current_setting('role', true), ''), 'none');
  v_staff := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
               #>> '{app_metadata,role}';
  if v_staff is null and v_role in ('none', 'service_role') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- 4. Releases off for the row's tenant (both images of an UPDATE): today's behaviour.
  -- This runs before RLS's WITH CHECK, so for a role RLS binds (authenticated, anon) a row
  -- naming a tenant other than the caller's is refused here, whatever either tenant's switch
  -- says: reading that tenant's switch would let the refusal's words tell another tenant
  -- whether its releases are on (the guard's message when on, RLS's when off). RLS refuses
  -- such a row anyway; a definer that bypasses RLS and writes across tenants on an API
  -- request is refused too, fail-closed. The bypassing roles (the service role, no switched
  -- role) may read the switch directly, so for them the row's own tenant decides, as before.
  v_tid := app.effective_tenant_id();
  if tg_op = 'INSERT' then
    v_foreign := new.tenant_id is distinct from v_tid;
  elsif tg_op = 'DELETE' then
    v_foreign := old.tenant_id is distinct from v_tid;
  else
    v_foreign := old.tenant_id is distinct from v_tid or new.tenant_id is distinct from v_tid;
  end if;
  if v_foreign and v_role in ('authenticated', 'anon') then
    v_on := true;
  elsif tg_op = 'INSERT' then
    v_on := app.releases_enabled(new.tenant_id);
  elsif tg_op = 'DELETE' then
    v_on := app.releases_enabled(old.tenant_id);
  else
    v_on := app.releases_enabled(old.tenant_id) or app.releases_enabled(new.tenant_id);
  end if;
  if not v_on then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- 5. An UPDATE of the registry's immediate columns only, plus the stamps the standard
  -- triggers own and the generated columns. Read at run time, so a slice that adds an
  -- immediate column changes the registry row, never this function. A no-op save (stamps
  -- only) is still a write outside a release: refused.
  if tg_op = 'UPDATE' then
    select e.exempt_columns into v_allowed
      from app.release_entities e
     where e.table_name = tg_table_name;
    if pg_catalog.cardinality(coalesce(v_allowed, '{}'::text[])) > 0 then
      select coalesce(pg_catalog.array_agg(n.key), '{}'::text[]) into v_changed
        from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) as n
       where n.value is distinct from (pg_catalog.to_jsonb(old) -> n.key);
      if v_changed && v_allowed
         and v_changed <@ (v_allowed || array['updated_at', 'updated_by', 'version']::text[]
                           || coalesce((select pg_catalog.array_agg(a.attname::text)
                                          from pg_catalog.pg_attribute a
                                         where a.attrelid = tg_relid and a.attnum > 0
                                           and not a.attisdropped and a.attgenerated = 's'),
                                       '{}'::text[])) then
        return new;
      end if;
    end if;
  end if;

  raise exception 'Live content changes only through a release.'
    using errcode = '42501',
          hint = 'Save it as a pending change, then publish it.',
          detail = pg_catalog.jsonb_build_object('table', tg_table_name, 'op', pg_catalog.lower(tg_op))::text;
end $$;
revoke all on function app.tg_release_guard() from public, anon, authenticated, service_role;

-- One guard per registry table (all rows, team_members included: its changes go through a
-- release like every other; owner item O-12 decides only whether they keep history) and per
-- case-study link table. The release_entities loop is also what later slices copy: a table
-- that joins the registry adds its guard in the same migration (snapshot_coverage.test.sql).
do $$
declare
  t text;
begin
  for t in
    select e.table_name from app.release_entities e
    union all
    select x from unnest(array['portfolio_services', 'portfolio_media']) as x
    order by 1
  loop
    execute format('drop trigger if exists %I on public.%I', t || '__release_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function app.tg_release_guard()',
                   t || '__release_guard', t);
  end loop;
end $$;

-- ═══ 3. System items: what changed outside a release ══════════════════════════════════════
-- A system item has no release and no draft. created_at (the transaction's start) groups
-- one out-of-band transaction's items; no transaction column is added.
alter table public.content_release_items alter column release_id drop not null;
alter table public.content_release_items drop constraint if exists content_release_items_system_shape;
alter table public.content_release_items add constraint content_release_items_system_shape
  check (release_id is not null or draft_id is null);
create index if not exists content_release_items_system_idx
  on public.content_release_items (tenant_id, created_at) where release_id is null;

-- The capture triggers insert as their owner (0038's pattern): a second owner-scoped policy,
-- valid only outside a release, for a tenant with releases on, and only for a system item.
-- Both are PERMISSIVE, so either admits; the owner bypasses RLS on Supabase (postcondition),
-- so they are for portability, not a boundary. No API role gains anything.
do $$
declare
  v_owner name;
begin
  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p
   where p.oid = 'app.tg_snapshot_version()'::regprocedure;
  if v_owner in ('anon', 'authenticated', 'service_role', 'public') then
    raise exception '0066: app.tg_snapshot_version() is owned by an API role (%)', v_owner;
  end if;
  execute 'drop policy if exists content_release_items_insert_system on public.content_release_items';
  execute format(
    'create policy content_release_items_insert_system on public.content_release_items '
    'for insert to %I with check (tenant_id = app.effective_tenant_id() and release_id is null '
    'and draft_id is null and not app.release_token_valid() and app.releases_enabled(tenant_id))',
    v_owner);
end $$;

-- ═══ 4. Capture: what a release changes, and what changes outside one ════════════════════
-- 0051's body, with one branch added where it returned at once without the token: for a
-- tenant with releases on, the write is recorded as a system item (no release, no draft,
-- the actor if the request had one). Releases off, nothing (D6). Both paths skip an UPDATE
-- that changes nothing but the version and the stamp; out of band, an UPDATE of immediate
-- columns only (the intake switch) is skipped too, as the guard lets it through. CREATE OR
-- REPLACE keeps the owner, the ACL and the triggers (same arguments); the revoke is restated.
create or replace function app.tg_release_capture() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_strip text[] := coalesce(pg_catalog.string_to_array(nullif(tg_argv[2], ''), ','), '{}'::text[]);
  v_system boolean := false;
  v_on boolean;
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_id uuid;
  v_item text;
  v_draft uuid;
  v_allowed text[];
  v_changed text[];
begin
  if not app.release_token_valid() then
    if tg_op = 'INSERT' then
      v_on := app.releases_enabled(new.tenant_id);
    elsif tg_op = 'DELETE' then
      v_on := app.releases_enabled(old.tenant_id);
    else
      v_on := app.releases_enabled(old.tenant_id) or app.releases_enabled(new.tenant_id);
    end if;
    if not v_on then
      return null;
    end if;
    v_system := true;
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
  if v_system and tg_op = 'UPDATE' then
    select e.exempt_columns into v_allowed
      from app.release_entities e
     where e.table_name = tg_table_name;
    if pg_catalog.cardinality(coalesce(v_allowed, '{}'::text[])) > 0 then
      select coalesce(pg_catalog.array_agg(n.key), '{}'::text[]) into v_changed
        from pg_catalog.jsonb_each(v_after) as n
       where n.value is distinct from (v_before -> n.key);
      if v_changed <@ (v_allowed || array['updated_at', 'updated_by', 'version']::text[]) then
        return null;
      end if;
    end if;
  end if;
  v_row := coalesce(v_after, v_before);
  v_id := (v_row ->> tg_argv[1])::uuid;
  if not v_system then
    v_item := pg_catalog.current_setting('app.release_item', true);
    if v_item is not null
       and pg_catalog.split_part(v_item, ':', 1) = tg_argv[0]
       and pg_catalog.split_part(v_item, ':', 2) = v_id::text
       and pg_catalog.split_part(v_item, ':', 3)
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_draft := pg_catalog.split_part(v_item, ':', 3)::uuid;
    end if;
  end if;
  insert into public.content_release_items
    (tenant_id, release_id, entity_type, entity_id, op, before, after, draft_id, actor_id)
  values ((v_row ->> 'tenant_id')::uuid,
          case when v_system then null else app.current_release_id() end,
          tg_argv[0], v_id,
          case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end,
          v_before, v_after, v_draft, auth.uid());
  return null;
end $$;
revoke all on function app.tg_release_capture() from public, anon, authenticated, service_role;

-- ═══ 5. Link-set capture ═══════════════════════════════════════════════════════════════════
-- The sets as they were when a statement first touched a case study, kept until that
-- statement's AFTER trigger turns them into an item (then deleted, so the table is empty
-- between statements). Keyed by the top-level transaction, so nothing here outlives or
-- crosses a transaction; a rolled-back statement takes its rows with it. RLS forced with no
-- policy and no grant: only the definers below (owned by the snapshot owner, who bypasses
-- RLS) reach it.
create table if not exists app.release_link_pending (
  xact xid8 not null,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  portfolio_id uuid not null,
  -- app.portfolio_link_sets() before the first change.
  before jsonb not null check (jsonb_typeof(before) = 'object'),
  -- The release and draft in force then (null out of band).
  release_id uuid,
  draft_id uuid,
  created_at timestamptz not null default now(),
  primary key (xact, portfolio_id)
);
alter table app.release_link_pending enable row level security;
alter table app.release_link_pending force row level security;
revoke all on app.release_link_pending from public, anon, authenticated, service_role;
comment on table app.release_link_pending is
  'Admin v2 R5 (0066): a case study''s link sets as they were when the current statement '
  'first touched it, kept by app.tg_release_links_stash and consumed by '
  'app.tg_release_links_capture in the same statement. Empty between statements.';

-- BEFORE each row of portfolio_services / portfolio_media: the first time a statement (with
-- its cascades) touches a case study of a tenant with releases on, or inside a release, keep
-- its sets as they are. A later row of the same statement finds them kept. The apply's own
-- link-set step (app.release_item names this case study and it still exists) is skipped:
-- R4's synthetic item records it (D4). A removal of the project (its row is gone by the time
-- its links cascade) or of a service is a cascade, and is kept.
create or replace function app.tg_release_links_stash() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_token boolean := app.release_token_valid();
  v_item text;
  v_draft uuid;
  v_keys uuid[];
  v_tenants uuid[];
  i int;
begin
  if tg_op = 'INSERT' then
    v_keys := array[new.portfolio_id];
    v_tenants := array[new.tenant_id];
  elsif tg_op = 'DELETE' then
    v_keys := array[old.portfolio_id];
    v_tenants := array[old.tenant_id];
  else
    v_keys := array[old.portfolio_id, new.portfolio_id];
    v_tenants := array[old.tenant_id, new.tenant_id];
  end if;
  for i in 1 .. pg_catalog.cardinality(v_keys) loop
    continue when not (v_token or app.releases_enabled(v_tenants[i]));
    continue when exists (select 1 from app.release_link_pending p
                           where p.xact = pg_catalog.pg_current_xact_id()
                             and p.portfolio_id = v_keys[i]);
    v_draft := null;
    if v_token then
      v_item := pg_catalog.current_setting('app.release_item', true);
      if v_item is not null
         and pg_catalog.split_part(v_item, ':', 1) = 'portfolio'
         and pg_catalog.split_part(v_item, ':', 2) = v_keys[i]::text then
        continue when exists (select 1 from public.portfolio p
                               where p.tenant_id = v_tenants[i] and p.id = v_keys[i]);
        if pg_catalog.split_part(v_item, ':', 3)
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_draft := pg_catalog.split_part(v_item, ':', 3)::uuid;
        end if;
      end if;
    end if;
    insert into app.release_link_pending (xact, tenant_id, portfolio_id, before, release_id, draft_id)
    values (pg_catalog.pg_current_xact_id(), v_tenants[i], v_keys[i],
            app.portfolio_link_sets(v_tenants[i], v_keys[i]),
            case when v_token then app.current_release_id() end, v_draft)
    on conflict (xact, portfolio_id) do nothing;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
revoke all on function app.tg_release_links_stash() from public, anon, authenticated, service_role;

-- AFTER each statement on portfolio_services / portfolio_media: every case study this
-- transaction kept sets for becomes one `portfolio_children` item (op update, R4's shape),
-- its sets then and now, unless they are equal. Whichever link table's statement trigger
-- fires first writes the item, with every change made so far (a project removal cascades
-- into both tables before either trigger fires); a later change keeps a new "before".
create or replace function app.tg_release_links_capture() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_after jsonb;
begin
  for r in
    select p.tenant_id, p.portfolio_id, p.before, p.release_id, p.draft_id
      from app.release_link_pending p
     where p.xact = pg_catalog.pg_current_xact_id_if_assigned()
     order by p.portfolio_id
  loop
    v_after := app.portfolio_link_sets(r.tenant_id, r.portfolio_id);
    if v_after is distinct from r.before then
      insert into public.content_release_items
        (tenant_id, release_id, entity_type, entity_id, op, before, after, draft_id, actor_id)
      values (r.tenant_id, r.release_id, 'portfolio_children', r.portfolio_id, 'update',
              r.before, v_after, r.draft_id, auth.uid());
    end if;
  end loop;
  delete from app.release_link_pending p
   where p.xact = pg_catalog.pg_current_xact_id_if_assigned();
  return null;
end $$;
revoke all on function app.tg_release_links_capture() from public, anon, authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['portfolio_services', 'portfolio_media'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_links_stash', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function app.tg_release_links_stash()',
                   t || '_links_stash', t);
    execute format('drop trigger if exists %I on public.%I', t || '_links_capture', t);
    execute format('create trigger %I after insert or update or delete on public.%I '
                   'for each statement execute function app.tg_release_links_capture()',
                   t || '_links_capture', t);
  end loop;
end $$;

-- ═══ 6. media_usage v4: pending changes are references ═══════════════════════════════════
-- v3's eight branches (0028), unchanged but for the new `pending` column (false) and every
-- name qualified, plus one: a pending change (a draft that is not a removal, claimed or not)
-- whose payload holds the asset's id as a string anywhere, in any spelling uuid_in reads
-- (upper case, braces, hyphens anywhere or none), because the apply reads it as a uuid. The
-- base is never read (it holds live values). INVOKER: the caller's RLS decides every branch
-- (drafts: CMS staff of the tenant). A hard delete waits while a pending change names it.
-- Dropped and created because the result gains a column; the callers parse rows with
-- non-strict Zod objects, which ignore it (as-built R5, rule 5).
drop function if exists public.media_usage(uuid);
create function public.media_usage(p_media_id uuid)
  returns table (entity_type text, entity_id uuid, label text, pending boolean)
  language sql stable security invoker set search_path = ''
as $$
  select 'portfolio'::text, p.id, p.slug::text, false
    from public.portfolio p
   where p.tenant_id = app.effective_tenant_id() and p.poster_media_id = p_media_id
  union all
  select 'portfolio_media', pm.portfolio_id, pm.role, false
    from public.portfolio_media pm
   where pm.tenant_id = app.effective_tenant_id() and pm.media_id = p_media_id
  union all
  select 'client', c.id, c.slug::text, false
    from public.clients c
   where c.tenant_id = app.effective_tenant_id() and c.logo_media_id = p_media_id
  union all
  select 'testimonial', t.id, t.slug::text, false
    from public.testimonials t
   where t.tenant_id = app.effective_tenant_id() and t.avatar_media_id = p_media_id
  union all
  select 'team_member', m.id, m.slug::text, false
    from public.team_members m
   where m.tenant_id = app.effective_tenant_id() and m.portrait_media_id = p_media_id
  union all
  select 'page_section', s.id, s.type, false
    from public.page_sections s
   where s.tenant_id = app.effective_tenant_id()
     and pg_catalog.jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                                      pg_catalog.jsonb_build_object('id', p_media_id::text))
  union all
  select 'discipline', d.id, d.slug::text, false
    from public.disciplines d
   where d.tenant_id = app.effective_tenant_id() and d.poster_media_id = p_media_id
  union all
  select 'service', sv.id, sv.slug::text, false
    from public.services sv
   where sv.tenant_id = app.effective_tenant_id() and sv.poster_media_id = p_media_id
  -- ---- v4 (0066): pending changes ----
  union all
  select dr.entity_type, dr.entity_id,
         pg_catalog.left(coalesce(nullif(dr.label ->> 'en', ''), dr.payload ->> 'slug', 'pending change'), 120),
         true
    from public.content_drafts dr
   where dr.tenant_id = app.effective_tenant_id()
     and dr.op <> 'delete'
     and exists (select 1
                   from pg_catalog.jsonb_path_query(dr.payload, 'lax $.**') as v(value)
                  where pg_catalog.jsonb_typeof(v.value) = 'string'
                    and pg_catalog.lower(pg_catalog.regexp_replace(v.value #>> '{}', '[{}-]', '', 'g'))
                        = pg_catalog.replace(p_media_id::text, '-', ''))
$$;
revoke all on function public.media_usage(uuid) from public, anon, authenticated, service_role;
grant execute on function public.media_usage(uuid) to authenticated;

-- ═══ 7. dashboard_attention v4: releases and stale pending changes ════════════════════════
-- 0028's definition, unchanged, then five kinds. The view is security_invoker, so RLS
-- decides every row (content_releases and content_drafts: CMS staff of the tenant); no row
-- exists until R3, R7 or R11 writes one. A release more than five minutes late is overdue
-- and not also "today". The Riyadh day, the 5 minutes, the 7 days and the 30 days are pinned
-- by tests/lib/attentionKinds.spec.ts and tests/schemas/release.spec.ts. The existing
-- scheduled_today kind keeps its UTC day (U1 reads around it).
create or replace view public.dashboard_attention with (security_invoker = true) as
  select 'scheduled_today'::text as kind, 'service'::text as entity_type, s.id, s.slug::text,
         s.title, s.scheduled_for as at
    from public.services s
   where s.status = 'scheduled' and s.scheduled_for::date = current_date
  union all
  select 'scheduled_today', 'blog_post', b.id, b.slug::text, b.title, b.scheduled_for
    from public.blog_posts b
   where b.status = 'scheduled' and b.scheduled_for::date = current_date
  union all
  select 'stale', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and b.updated_at < now() - interval '180 days'
  union all
  select 'missing_image', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and (b.cover_image_url is null or b.cover_image_url = '')
  -- ---- v2 ----
  union all
  select case when p.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.is_placeholder and p.status <> 'archived'
  union all
  select case when t.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where t.is_placeholder and t.status <> 'archived'
  union all
  select case when m.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'team_member', m.id, m.slug::text, m.name, m.updated_at
    from public.team_members m
   where m.is_placeholder and m.status <> 'archived'
  union all
  select case when st.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'statistic', st.id, st.slug::text, st.label, st.updated_at
    from public.statistics st
   where st.is_placeholder and st.status <> 'archived'
  union all
  select case when c.visible then 'placeholder_live' else 'placeholder_pending' end,
         'client', c.id, c.slug::text, c.name, c.updated_at
    from public.clients c
   where c.is_placeholder
  union all
  select case when ps.visible and pg.status = 'published' then 'placeholder_live'
              else 'placeholder_pending' end,
         'page_section', ps.id, pg.slug::text,
         jsonb_build_object('en', ps.type, 'ar', ps.type), ps.updated_at
    from public.page_sections ps
    join public.pages pg on pg.id = ps.page_id
   where ps.is_placeholder
  -- ---- v3 (0028) ----
  union all
  select case when sc.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'service_case', sc.id, sv.slug::text, sc.title, sc.updated_at
    from public.service_cases sc
    join public.services sv on sv.id = sc.service_id
   where sc.is_placeholder and sc.status <> 'archived'
  union all
  select 'missing_alt', 'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.status = 'published'
     and exists (
       select 1 from public.media_assets ma
        where ma.kind = 'image'
          and (ma.id = p.poster_media_id
               or ma.id in (select pm.media_id from public.portfolio_media pm
                             where pm.portfolio_id = p.id))
          and (coalesce(ma.alt ->> 'en', '') = '' or coalesce(ma.alt ->> 'ar', '') = ''))
  union all
  select 'consent_missing', 'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where cardinality(t.placements) > 0 and t.consent_obtained_at is null
     and t.status <> 'archived'
  -- ---- v4 (0066): releases and stale pending changes ----
  union all
  select 'release_scheduled_today', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.scheduled_for
    from public.content_releases r
   where r.status = 'scheduled'
     and (r.scheduled_for at time zone 'Asia/Riyadh')::date
         = (pg_catalog.now() at time zone 'Asia/Riyadh')::date
     and r.scheduled_for >= pg_catalog.now() - interval '5 minutes'
  union all
  select 'release_overdue', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.scheduled_for
    from public.content_releases r
   where r.status = 'scheduled' and r.scheduled_for < pg_catalog.now() - interval '5 minutes'
  union all
  select 'release_failed', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.updated_at
    from public.content_releases r
   where r.status = 'failed' and r.updated_at > pg_catalog.now() - interval '7 days'
  union all
  select 'purge_failed', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.published_at
    from public.content_releases r
   where r.status = 'published' and r.purge_status = 'failed'
     and r.published_at > pg_catalog.now() - interval '7 days'
  union all
  select 'draft_stale', d.entity_type, d.entity_id,
         coalesce(case when pg_catalog.jsonb_typeof(d.payload -> 'slug') = 'string'
                       then d.payload ->> 'slug' end, ''),
         d.label, d.updated_at
    from public.content_drafts d
   where d.release_id is null and d.updated_at < pg_catalog.now() - interval '30 days';

-- Stated, never inherited (P-14): staff read it; anon, PUBLIC and the service role nothing
-- (public.content_health is INVOKER and runs as the staff member).
revoke all on public.dashboard_attention from public, anon, authenticated, service_role;
grant select on public.dashboard_attention to authenticated;

-- ═══ 8. Scheduled publishing skips tenants with releases on ═══════════════════════════════
-- 0028's body, but for the WHERE's last term and a pinned search_path with every name
-- qualified. In a tenant with releases on, a legacy `scheduled` row never goes live outside a
-- release (R11's enable_releases converts them first); every other tenant is unchanged.
create or replace function app.publish_scheduled() returns int
  language plpgsql security definer set search_path = ''
as $$
declare
  n int := 0;
  c int;
  t text;
begin
  foreach t in array array['disciplines', 'services', 'blog_posts', 'portfolio', 'pages',
                           'testimonials', 'service_cases'] loop
    begin
      -- testimonials: consent is already guaranteed: the CHECK refuses a scheduled row
      -- without it, unless it is a flagged sample (0028), which 0025 governs.
      execute pg_catalog.format(
        'update public.%I set status = ''published'', published_at = coalesce(published_at, pg_catalog.now())
          where status = ''scheduled'' and scheduled_for is not null and scheduled_for <= pg_catalog.now()
            and not app.releases_enabled(tenant_id)', t);
      get diagnostics c = row_count;
      n := n + c;
    exception when others then
      raise warning 'publish_scheduled: % skipped (%: %)', t, sqlstate, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke all on function app.publish_scheduled() from public, anon, authenticated, service_role;

-- ═══ 9. TRUNCATE closed on every guarded table ═══════════════════════════════════════════
-- TRUNCATE fires no row trigger, so neither the guard nor the capture would see it. No
-- code truncates these tables (tests/lib/noTruncate.spec.ts holds that for src/, scripts/
-- and supabase/functions/); seed.sql and restores run as the migration role. The same
-- table list as the guard loop above.
do $$
declare
  t text;
begin
  for t in
    select e.table_name from app.release_entities e
    union all
    select x from unnest(array['portfolio_services', 'portfolio_media']) as x
    order by 1
  loop
    execute format('revoke truncate on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair of parentheses; a function's schema
-- printed only when it is not on the search path, so the patterns allow both).
do $$
declare
  v_guarded text[];
  v_owner oid;
  v_bad text;
  v_have text;
  v_want text[];
  v_got text[];
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  p text;
  r text;
begin
  select array_agg(t order by t) into v_guarded
    from (select e.table_name as t from app.release_entities e
          union all select 'portfolio_services' union all select 'portfolio_media') x;
  select proowner into v_owner from pg_proc where oid = 'app.tg_snapshot_version()'::regprocedure;

  -- ---- 1. The new and re-created definers: SECURITY DEFINER, search_path '', owned by the
  -- snapshot owner (who bypasses RLS), executable by no API role -------------------------
  foreach p in array array['app.tg_release_guard()', 'app.tg_release_capture()',
                           'app.tg_release_links_stash()', 'app.tg_release_links_capture()',
                           'app.portfolio_link_sets(uuid, uuid)', 'app.publish_scheduled()'] loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure and f.prosecdef and f.proowner = v_owner
                      and f.proconfig = array['search_path=""']) then
      raise exception '0066: % must be SECURITY DEFINER, search_path '''', owned by the snapshot owner', p;
    end if;
    foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r::name, p, 'execute') then
        raise exception '0066: % can execute %', r, p;
      end if;
    end loop;
  end loop;
  if not exists (select 1 from pg_roles where oid = v_owner and (rolsuper or rolbypassrls)) then
    raise exception '0066: the snapshot owner does not bypass RLS';
  end if;

  -- ---- 2. No depth exemption anywhere in the guard (verification claim 8), and the token
  -- is its first check -------------------------------------------------------------------
  if (select prosrc from pg_proc where oid = 'app.tg_release_guard()'::regprocedure) ~* 'pg_trigger_depth' then
    raise exception '0066: the guard must not read pg_trigger_depth';
  end if;

  -- ---- 3. Exactly one guard per registry table and per link table, named for its table,
  -- BEFORE ROW INSERT+UPDATE+DELETE (tgtype 31), enabled, and the FIRST BEFORE ROW trigger
  -- on its table by name; none anywhere else -------------------------------------------
  select string_agg(t, ', ' order by t) into v_bad
    from unnest(v_guarded) as t
   where (select count(*) from pg_trigger tg
           where tg.tgrelid = format('public.%I', t)::regclass and not tg.tgisinternal
             and tg.tgfoid = 'app.tg_release_guard()'::regprocedure
             and tg.tgname = t || '__release_guard'
             and tg.tgtype = 31 and tg.tgenabled = 'O' and tg.tgnargs = 0) <> 1
      or (select tg.tgname from pg_trigger tg
           where tg.tgrelid = format('public.%I', t)::regclass and not tg.tgisinternal
             and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 2
           order by tg.tgname collate "C" limit 1) is distinct from t || '__release_guard';
  if v_bad is not null then
    raise exception '0066: tables without exactly one guard firing first: %', v_bad;
  end if;
  select string_agg(format('%s.%s', tg.tgrelid::regclass, tg.tgname), ', ') into v_bad
    from pg_trigger tg
   where tg.tgfoid = 'app.tg_release_guard()'::regprocedure
     and tg.tgrelid not in (select format('public.%I', t)::regclass from unnest(v_guarded) as t);
  if v_bad is not null then
    raise exception '0066: guard triggers where none belongs: %', v_bad;
  end if;

  -- ---- 4. Each link table: its stash (BEFORE ROW I/U/D, tgtype 31) and its capture (AFTER
  -- STATEMENT I/U/D, tgtype 28); no other table has either. team_members still captures
  -- nothing (O-12) ------------------------------------------------------------------------
  select string_agg(t, ', ') into v_bad
    from unnest(array['portfolio_services', 'portfolio_media']) as t
   where (select count(*) from pg_trigger tg
           where tg.tgrelid = format('public.%I', t)::regclass and not tg.tgisinternal
             and ((tg.tgname = t || '_links_stash' and tg.tgtype = 31
                   and tg.tgfoid = 'app.tg_release_links_stash()'::regprocedure)
                  or (tg.tgname = t || '_links_capture' and tg.tgtype = 28
                      and tg.tgfoid = 'app.tg_release_links_capture()'::regprocedure))
             and tg.tgenabled = 'O') <> 2;
  if v_bad is not null then
    raise exception '0066: link tables without their stash and capture triggers: %', v_bad;
  end if;
  if exists (select 1 from pg_trigger tg
              where tg.tgfoid in ('app.tg_release_links_stash()'::regprocedure,
                                  'app.tg_release_links_capture()'::regprocedure)
                and tg.tgrelid not in ('public.portfolio_services'::regclass,
                                       'public.portfolio_media'::regclass)) then
    raise exception '0066: link capture triggers where none belongs';
  end if;
  if exists (select 1 from pg_trigger tg
              where tg.tgrelid = 'public.team_members'::regclass
                and tg.tgfoid in ('app.tg_release_capture()'::regprocedure,
                                  'app.tg_release_links_capture()'::regprocedure)) then
    raise exception '0066: team_members must capture nothing until owner item O-12';
  end if;

  -- ---- 4b. The link scratch table: RLS forced, no policy, nothing for any API role -------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'app.release_link_pending'::regclass) then
    raise exception '0066: app.release_link_pending is not ENABLE + FORCE row level security';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'app' and tablename = 'release_link_pending') then
    raise exception '0066: app.release_link_pending must have no policy';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'app.release_link_pending',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'app.release_link_pending', 'select, insert, update, references')
       -- CASE, not AND: PostgreSQL does not promise AND short-circuits, and the privilege
       -- functions refuse the word MAINTAIN before PostgreSQL 17 (CI runs 15).
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'app.release_link_pending', 'maintain')
                else false end) then
      raise exception '0066: % holds a privilege on app.release_link_pending', r;
    end if;
  end loop;

  -- ---- 5. The items table: release_id nullable, the system shape, the exact policy set
  -- with the tenant predicate first, still no UPDATE/DELETE for any API role, and the
  -- identity sequence still no API role's -----------------------------------------------
  if (select attnotnull from pg_attribute
       where attrelid = 'public.content_release_items'::regclass and attname = 'release_id') then
    raise exception '0066: content_release_items.release_id must be nullable (system items)';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.content_release_items'::regclass
                    and conname = 'content_release_items_system_shape' and contype = 'c'
                    and pg_get_constraintdef(oid) ~ 'release_id IS NOT NULL\) OR \(draft_id IS NULL') then
    raise exception '0066: content_release_items_system_shape is missing or changed';
  end if;
  v_want := array[
    format('content_release_items_insert_capture INSERT PERMISSIVE %s', array[pg_get_userbyid(v_owner)]::name[]),
    format('content_release_items_insert_system INSERT PERMISSIVE %s', array[pg_get_userbyid(v_owner)]::name[]),
    'content_release_items_read SELECT PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles) order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'content_release_items';
  if v_got is distinct from v_want then
    raise exception '0066: content_release_items policies are %, expected %', v_got, v_want;
  end if;
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'content_release_items'
     and (coalesce(qual, with_check) is null or qual !~ v_tenant_first or with_check !~ v_tenant_first);
  if v_bad is not null then
    raise exception '0066: items policies that do not lead with the tenant predicate: %', v_bad;
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_release_items'
                    and policyname = 'content_release_items_insert_system'
                    and with_check ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(release_id IS NULL\) AND \(draft_id IS NULL\) AND \(NOT (app\.)?release_token_valid\(\)\) AND (app\.)?releases_enabled\(tenant_id\)\)$') then
    raise exception '0066: the system insert policy must hold the tenant, no release, no draft, no token and releases on';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.content_release_items', 'update, delete, truncate') then
      raise exception '0066: % may rewrite or delete release items', r;
    end if;
    if has_sequence_privilege(r::name, pg_get_serial_sequence('public.content_release_items', 'id'),
                              'usage, select, update') then
      raise exception '0066: % holds a privilege on the release items'' sequence', r;
    end if;
  end loop;

  -- ---- 6. media_usage v4: INVOKER, search_path '', four columns, authenticated only -----
  if not exists (select 1 from pg_proc
                  where oid = 'public.media_usage(uuid)'::regprocedure and not prosecdef
                    and proconfig = array['search_path=""']
                    and pg_get_function_result(oid)
                        = 'TABLE(entity_type text, entity_id uuid, label text, pending boolean)') then
    raise exception '0066: public.media_usage must be INVOKER, search_path '''', four columns';
  end if;
  if not has_function_privilege('authenticated', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('anon', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('public', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.media_usage(uuid)', 'execute') then
    raise exception '0066: public.media_usage must be executable by authenticated only';
  end if;

  -- ---- 7. dashboard_attention: security_invoker, SELECT for authenticated only ---------
  if not exists (select 1 from pg_class
                  where oid = 'public.dashboard_attention'::regclass
                    and reloptions @> array['security_invoker=true']) then
    raise exception '0066: dashboard_attention must stay security_invoker';
  end if;
  if not has_table_privilege('authenticated', 'public.dashboard_attention', 'select')
     or has_table_privilege('authenticated', 'public.dashboard_attention', 'insert, update, delete, truncate, references, trigger') then
    raise exception '0066: authenticated must hold SELECT on dashboard_attention and nothing more';
  end if;
  foreach r in array array['public', 'anon', 'service_role'] loop
    if has_table_privilege(r::name, 'public.dashboard_attention',
                           'select, insert, update, delete, truncate, references, trigger') then
      raise exception '0066: % holds a privilege on dashboard_attention', r;
    end if;
  end loop;

  -- ---- 8. publish_scheduled: still callable by no API role, and asks the flag -----------
  if (select prosrc from pg_proc where oid = 'app.publish_scheduled()'::regprocedure)
       !~ 'not app\.releases_enabled\(tenant_id\)' then
    raise exception '0066: app.publish_scheduled must skip tenants with releases on';
  end if;

  -- ---- 9. No API role may TRUNCATE a guarded table --------------------------------------
  select string_agg(format('%s %s', r2, t), ', ') into v_bad
    from unnest(v_guarded) as t
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as r2
   where has_table_privilege(r2::name, format('public.%I', t), 'truncate');
  if v_bad is not null then
    raise exception '0066: API roles that may TRUNCATE a guarded table: %', v_bad;
  end if;

  -- ---- 10. R4's catalog (verification claims 10 and 18), which the guard trusts: among
  -- the functions in public and graphql_public that are not an extension's, those calling
  -- set_config are exactly apply_release and crm_delete_lead_note; only apply_release sets
  -- claims; in any schema only apply_release and app.release_token_valid name the token;
  -- none of this file's functions calls set_config --------------------------------------
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('public', 'graphql_public')
     and f.prosrc ~* 'set_config'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'public.apply_release, public.crm_delete_lead_note' then
    raise exception '0066: exposed functions calling set_config are %, expected apply_release and crm_delete_lead_note', v_have;
  end if;
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('public', 'graphql_public')
     and f.prosrc ~* 'set_config' and f.prosrc ~* 'request\.jwt\.claim'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'public.apply_release' then
    raise exception '0066: exposed functions setting claims are %, expected apply_release only', v_have;
  end if;
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
     and f.prosrc ~* 'app\.release_apply'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'app.release_token_valid, public.apply_release' then
    raise exception '0066: functions naming the release token are %, expected app.release_token_valid and apply_release', v_have;
  end if;
  -- The guard also trusts the role setting (no switched role = not an API request): in the
  -- schemas this project owns (public, graphql_public, app), the only function that switches
  -- role (SET LOCAL or SESSION ROLE, SET ROLE to a name, set_config('role', ...) or a SET role
  -- clause; an UPDATE's `set role = ...` is a column) is apply_release, which switches to
  -- authenticated and back. Supabase's own schemas are not ours to judge: Realtime's
  -- realtime.apply_rls sets the role for every Postgres Changes check, and is no extension's
  -- member, so a scan of every schema would fail this push on a hosted project.
  select string_agg(n.nspname || '.' || f.proname, ', ' order by n.nspname, f.proname) into v_have
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('public', 'graphql_public', 'app')
     and (f.prosrc ~* 'set\s+(local|session)\s+role\M'
          or f.prosrc ~* 'set\s+role\s+(?!=)'
          or f.prosrc ~* 'set_config\s*\(\s*''role'''
          or coalesce(array_to_string(f.proconfig, ','), '') ~* '(^|,)role=')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e');
  if v_have is distinct from 'public.apply_release' then
    raise exception '0066: functions switching role are %, expected apply_release only', v_have;
  end if;
  foreach p in array array['app.tg_release_guard()', 'app.tg_release_capture()',
                           'app.tg_release_links_stash()', 'app.tg_release_links_capture()',
                           'app.portfolio_link_sets(uuid, uuid)', 'app.publish_scheduled()',
                           'public.media_usage(uuid)'] loop
    if (select prosrc from pg_proc where oid = p::regprocedure) ~* 'set_config' then
      raise exception '0066: % must not call set_config', p;
    end if;
  end loop;

  -- ---- 11. Releases are still off everywhere (0038, 0051, 0062) -------------------------
  if exists (select 1 from app.release_tenants) then
    raise exception '0066: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
