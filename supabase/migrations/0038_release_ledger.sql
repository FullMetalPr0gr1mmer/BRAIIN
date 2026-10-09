-- ─────────────────────────────────────────────────────────────────────────────
-- 0038 — Releases, part 1: the ledger schema (Admin v2 R1). Forward-only, EXPAND only, and
-- INERT: nothing in the app reads or writes the new objects yet, and releases stay off
-- for every tenant (app.release_tenants starts empty) until the switch-on slice (R14).
-- Depends on 0001, 0005, 0009, 0011, 0016, 0019, 0021, 0022, 0023, 0028, 0032.
--
-- The design is docs/admin-v2/releases.md (§1.1 the registry, §2 storage, slice R1), as
-- the program README amends it (README wins; the departures are in
-- docs/admin-v2/as-built/R1.md):
--
--   • app.release_entities: the registry of release-managed entity types, one row each:
--     table, key, area, who may author and who may stage a removal (today's write policies
--     and RESTRICTIVE gates, as role lists), the writable column allowlist, the
--     self-references set in a second pass, the unique flags, the columns that stay
--     immediate, the apply order. Global configuration: it describes the schema, not a
--     tenant, so it has no tenant_id (the app.deployment precedent, 0016) and its one
--     policy has no tenant predicate. Only migrations change it.
--   • app.release_tenants: the switch-on flag. A row per tenant with releases on. No API
--     role can read or write it (the verification moved the flag off site_settings, which
--     Admin and Developer can write through PostgREST); app.releases_enabled() reads it.
--   • public.content_drafts: one shared pending change per entity (payload untrusted, a
--     base for column-level conflicts, its own version), to be written by the CMS staff
--     who may author that entity type, under RLS. Staff READ drafts from 0038 but write
--     none: authenticated gets no INSERT, UPDATE or DELETE here; R3 grants them with the
--     kernel that writes drafts (the write policies are in place and pgTAP-proven). One
--     BEFORE trigger, the draft lock (app.tg_draft_lock): a claimed draft is read-only to
--     staff (with RLS), and a draft's id, version and author are the database's, so the
--     {draftId, draftVersion} a publish names (R6) cannot be replayed (no ABA).
--   • public.content_releases: the site versions, numbered per tenant when they go live.
--     Staff read them; only the service role writes them.
--   • public.content_release_items: append-only before/after images of every row a
--     release changes. Staff read them; only the release path writes them (R4).
--   • content_versions: gains release_id (set only while a release token is valid), and
--     the snapshot covers every registry table: team_members, certifications, statistics,
--     categories, navigation, redirects, entity_seo and custom_themes join, and the two
--     singletons (site_profile, seo_defaults) snapshot through app.tg_snapshot_singleton.
--     0032 (H6) already took INSERT away from the API roles; that stays as it is.
--   • custom_themes gets the RESTRICTIVE admin-only delete gate the design asks for "when
--     touching the table" (releases.md §12.7): the Worker already refuses a Developer's
--     delete (content.archiveDelete), RLS did not, and the registry's delete roles must
--     be what RLS enforces (registry contract #2).
--
-- Helpers: app.can_author(text) and app.can_stage_delete(text) read the registry's role
-- lists (invoker, EXECUTE for authenticated: the drafts policies call them);
-- app.release_token_valid() and app.current_release_id() read the release token that only
-- apply_release (R4) will set; app.releases_enabled(uuid) reads the flag. No helper is
-- named app.is_cms_staff: program decision P-6 keeps app.is_staff() exactly the four CMS
-- roles, so it already is that.
--
-- Grants are stated for both Supabase grant regimes (Admin v2 P-14): revoke from public,
-- anon, authenticated and service_role, then grant exactly. Postconditions at the end.
--
-- CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes, Releases), §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══ 1. The switch-on flag ════════════════════════════════════════════════════════════════
-- A tenant has releases on while it has a row here. Written only by the runbook functions
-- R11 adds (app.enable_releases / app.disable_releases, as postgres); read only through the
-- definer below. RLS forced, no policy, no grant: a role that does not bypass RLS reads
-- nothing even if a grant appears later.
create table if not exists app.release_tenants (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  enabled_at timestamptz not null default now(),
  -- The operator who switched it on (a profile id; no foreign key, so an operator's
  -- account can be removed without touching the flag).
  enabled_by uuid
);
alter table app.release_tenants enable row level security;
alter table app.release_tenants force row level security;
revoke all on app.release_tenants from public, anon, authenticated, service_role;
comment on table app.release_tenants is
  'Tenants with site-wide releases switched on (Admin v2 R1, 0038). Empty until R14''s '
  'switch-on; written only by the runbook functions; read through app.releases_enabled().';

-- False for a tenant with no row, and for null. The guard (R5) and the apply (R4) ask it.
create or replace function app.releases_enabled(p_tenant uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from app.release_tenants r where r.tenant_id = p_tenant)
$$;
revoke all on function app.releases_enabled(uuid) from public, anon, authenticated, service_role;

-- ═══ 2. The registry ══════════════════════════════════════════════════════════════════════
create table if not exists app.release_entities (
  entity_type text primary key check (entity_type ~ '^[a-z][a-z_]{1,39}$'),
  table_name text not null unique check (table_name ~ '^[a-z][a-z_]{1,62}$'),
  -- 'id' for rows; 'tenant_id' for the per-tenant singletons (the draft's entity_id is
  -- then the tenant's id).
  key_column text not null check (key_column in ('id', 'tenant_id')),
  area text not null check (area in ('pages', 'services', 'our_work', 'collections', 'blog',
                                     'navigation', 'settings', 'appearance', 'seo')),
  -- The roles today's write policy admits (who may stage a change), and the roles the
  -- RESTRICTIVE delete gate admits (who may stage a removal). Explicit lists, never
  -- app.is_staff(): a role added later (Sales) gets nothing here by accident.
  -- tests/authz/releaseRegistry.spec.ts holds both equal to ROLE_CAPS.
  author_roles text[] not null
    check (cardinality(author_roles) >= 1
           and author_roles <@ array['admin', 'content_creator', 'seo', 'developer']),
  delete_roles text[] not null default '{}' check (delete_roles <@ author_roles),
  -- The writable allowlist: what a release may write (derived columns included, e.g.
  -- body_html, reading_minutes, preview_*). Never the key, tenant_id, version, the actor
  -- and timestamp columns, the generated search_* columns, published_at (stamped by the
  -- apply on a first publish) or scheduled_for (scheduling belongs to releases).
  columns text[] not null check (cardinality(columns) >= 1),
  -- Self-references, set in a second pass after every row exists.
  deferred_columns text[] not null default '{}' check (deferred_columns <@ columns),
  -- Flags that are unique per scope (a partial unique index): cleared before they are set.
  unique_flags text[] not null default '{}' check (unique_flags <@ columns),
  -- Columns that stay immediate (never staged, never in a patch).
  exempt_columns text[] not null default '{}' check (not (exempt_columns && columns)),
  -- Creates and updates apply in ascending order; deletes in descending order.
  apply_order int not null check (apply_order between 1 and 1000),
  -- Whether the row has a content_status lifecycle (redirects' `status` is an HTTP code).
  has_status boolean not null,
  -- The boolean column whose flip to true is a go-live (visible), if any.
  publish_flag text check (publish_flag is null or publish_flag = any (columns)),
  created_at timestamptz not null default now()
);
alter table app.release_entities enable row level security;
alter table app.release_entities force row level security;
comment on table app.release_entities is
  'The release registry (Admin v2 R1, 0038): every entity type a release may change, with '
  'its writable columns and the roles that may stage it. Global configuration (no tenant), '
  'changed only by migrations; src/lib/release/registry.ts (R2) mirrors it.';

-- docs/admin-v2/releases.md §1.1. FAQ (U7), page visibility (U14), the appearance and
-- forms tables (E5, E8) and template copy (E3) join with the slices that create them
-- (registry contract #4). One row per line group, parsed by tests/schemas/release.spec.ts
-- and tests/authz/releaseRegistry.spec.ts: keep the shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('category', 'categories', 'id', 'blog', '{admin,content_creator}', '{admin}',
   '{slug,name}',
   '{}', '{}', '{}', 10, false, null),
  ('sector', 'sectors', 'id', 'our_work', '{admin,content_creator}', '{admin}',
   '{slug,name,visible,sort_order}',
   '{}', '{}', '{}', 10, false, 'visible'),
  ('client', 'clients', 'id', 'our_work', '{admin,content_creator}', '{admin}',
   '{slug,name,logo_media_id,website_url,show_in_marquee,visible,is_placeholder,sort_order}',
   '{}', '{}', '{}', 10, false, 'visible'),
  ('team_member', 'team_members', 'id', 'collections', '{admin,content_creator}', '{admin}',
   '{profile_user_id,slug,name,bio,avatar_url,status,sort_order,role,linkedin_url,is_leadership,portrait_media_id,is_placeholder}',
   '{}', '{}', '{}', 10, true, null),
  ('statistic', 'statistics', 'id', 'collections', '{admin,content_creator}', '{admin}',
   '{slug,label,value,status,sort_order,value_numeric,value_suffix,placements,placement_labels,is_placeholder}',
   '{}', '{}', '{}', 10, true, null),
  ('certification', 'certifications', 'id', 'collections', '{admin,content_creator}', '{admin}',
   '{slug,name,issuer,year,logo_url,status,sort_order}',
   '{}', '{}', '{}', 10, true, null),
  ('discipline', 'disciplines', 'id', 'services', '{admin,content_creator}', '{admin}',
   '{slug,name,short,blurb,poster_media_id,preview_video_path,preview_start_s,preview_end_s,status,sort_order}',
   '{}', '{}', '{}', 20, true, null),
  ('service', 'services', 'id', 'services', '{admin,content_creator}', '{admin}',
   '{slug,title,blurb,body,body_html,hero_video_uid,category,status,is_teaser,sort_order,short_title,discipline_id,intro,value_points,deliverables,poster_media_id,preview_video_path,preview_start_s,preview_end_s}',
   '{}', '{}', '{}', 30, true, null),
  ('portfolio', 'portfolio', 'id', 'our_work', '{admin,content_creator}', '{admin}',
   '{slug,title,summary,body,body_html,status,sort_order,project_type,teaser,lead,goal,result,scope,keywords,results,sector_id,client_id,year,is_featured,poster_media_id,preview_video_uid,preview_video_path,preview_start_s,preview_end_s,next_portfolio_id,is_placeholder}',
   '{next_portfolio_id}', '{}', '{}', 40, true, null),
  ('service_case', 'service_cases', 'id', 'services', '{admin,content_creator}', '{admin}',
   '{service_id,portfolio_id,title,context,problems,results,status,is_placeholder}',
   '{}', '{}', '{}', 50, true, null),
  ('testimonial', 'testimonials', 'id', 'our_work', '{admin,content_creator}', '{admin}',
   '{slug,quote,author_name,author_role,client_id,portfolio_id,avatar_media_id,placements,consent_obtained_at,consent_reference,status,sort_order,is_placeholder}',
   '{}', '{}', '{}', 60, true, null),
  ('blog_post', 'blog_posts', 'id', 'blog', '{admin,content_creator}', '{admin}',
   '{slug,title,excerpt,body,body_html,author_id,category_id,cover_image_url,status,reading_minutes}',
   '{}', '{}', '{}', 70, true, null),
  ('page', 'pages', 'id', 'pages', '{admin,content_creator}', '{admin}',
   '{slug,title,status,nav_visible}',
   '{}', '{}', '{}', 80, true, null),
  ('page_section', 'page_sections', 'id', 'pages', '{admin,content_creator}', '{admin}',
   '{page_id,type,content,style,visible,sort_order,is_placeholder}',
   '{}', '{}', '{}', 90, false, 'visible'),
  ('nav_item', 'navigation', 'id', 'navigation', '{admin,content_creator}', '{admin}',
   '{location,parent_id,label,href,visible,is_key,sort_order}',
   '{parent_id}', '{is_key}', '{}', 100, false, 'visible'),
  ('site_profile', 'site_profile', 'tenant_id', 'settings', '{admin,developer}', '{}',
   '{brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,address_locality,address_country,founded_year,socials}',
   '{}', '{}', '{accepting_applications}', 110, false, null),
  ('custom_theme', 'custom_themes', 'id', 'appearance', '{admin,developer}', '{admin}',
   '{name,tokens,is_active}',
   '{}', '{}', '{}', 110, false, null),
  ('entity_seo', 'entity_seo', 'id', 'seo', '{admin,seo}', '{}',
   '{entity_type,entity_id,meta_title,meta_description,og_image,canonical_override,robots,schema_type}',
   '{}', '{}', '{}', 120, false, null),
  ('seo_defaults', 'seo_defaults', 'tenant_id', 'seo', '{admin,seo}', '{}',
   '{title_template,default_title,default_description,default_og_image,organization,robots_directives}',
   '{}', '{}', '{}', 120, false, null),
  ('redirect', 'redirects', 'id', 'seo', '{admin,seo}', '{admin,seo}',
   '{source_path,target_path,status}',
   '{}', '{}', '{}', 130, false, null)
on conflict (entity_type) do nothing;

-- CMS staff read it (the drafts policies evaluate it through app.can_author, as the
-- caller). No tenant predicate: there is no tenant column (see the header). No write
-- policy and no write grant for any API role.
drop policy if exists release_entities_read on app.release_entities;
create policy release_entities_read on app.release_entities for select to authenticated
  using (app.is_staff());
revoke all on app.release_entities from public, anon, authenticated, service_role;
grant select on app.release_entities to authenticated, service_role;

-- ═══ 3. Helpers ═══════════════════════════════════════════════════════════════════════════
-- May the caller's role stage a change to this entity type? Invoker, so it reads the
-- registry under the caller's own RLS (staff only); an unknown type is false.
create or replace function app.can_author(p_entity_type text) returns boolean
  language sql stable
as $$
  select exists (
    select 1 from app.release_entities e
     where e.entity_type = p_entity_type
       and app.current_role() = any (e.author_roles))
$$;

-- May the caller's role stage a removal of this entity type?
create or replace function app.can_stage_delete(p_entity_type text) returns boolean
  language sql stable
as $$
  select exists (
    select 1 from app.release_entities e
     where e.entity_type = p_entity_type
       and app.current_role() = any (e.delete_roles))
$$;

revoke all on function app.can_author(text) from public, anon, authenticated, service_role;
revoke all on function app.can_stage_delete(text) from public, anon, authenticated, service_role;
grant execute on function app.can_author(text) to authenticated;
grant execute on function app.can_stage_delete(text) to authenticated;

-- The release token. apply_release (R4) will set `app.release_apply` to
-- pg_current_xact_id()::text, transaction-local, next to `app.release_id`. The token is
-- valid only in the transaction that set it: a value left in the session, or set in
-- another transaction, never matches. The GUC is read first, so a write with no token
-- never asks for a transaction id; `_if_assigned` never assigns one either (a write has
-- one already, and apply_release assigns it when it sets the token). No function in an
-- exposed schema sets either GUC, and PostgREST sets only request.* ones.
create or replace function app.release_token_valid() returns boolean
  language sql stable set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('app.release_apply', true), '')
      = pg_catalog.pg_current_xact_id_if_assigned()::text,
    false)
$$;

-- The release a write belongs to: its id while the token is valid, else null. Inside a
-- release the id must be there and be a uuid, or the write fails (22023) rather than
-- recording a history row with no release.
create or replace function app.current_release_id() returns uuid
  language plpgsql stable set search_path = ''
as $$
declare
  v text;
begin
  if not app.release_token_valid() then
    return null;
  end if;
  v := pg_catalog.current_setting('app.release_id', true);
  if v is null
     or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'a release is applying without its id' using errcode = '22023';
  end if;
  return v::uuid;
end $$;

revoke all on function app.release_token_valid() from public, anon, authenticated, service_role;
revoke all on function app.current_release_id() from public, anon, authenticated, service_role;

-- ═══ 4. content_releases: the site versions ═══════════════════════════════════════════════
create table if not exists public.content_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  -- Assigned when the release goes live (max + 1 under the per-tenant lock, R4).
  number int check (number >= 1),
  kind text not null default 'publish'
    check (kind in ('baseline', 'publish', 'rollback', 'legacy_schedule')),
  status text not null
    check (status in ('applying', 'scheduled', 'published', 'failed', 'cancelled')),
  note text check (note is null or (char_length(note) <= 280 and note !~ '[[:cntrl:]]')),
  scheduled_for timestamptz,
  scheduled_by uuid,
  published_at timestamptz,
  published_by uuid,
  restores_release_id uuid,
  -- A scheduled release: the frozen, validated item list.
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'array'),
  item_count int not null default 0 check (item_count >= 0),
  areas text[] not null default '{}'
    check (areas <@ array['pages', 'services', 'our_work', 'collections', 'blog',
                          'navigation', 'settings', 'appearance', 'seo']),
  tags text[] not null default '{}',
  purge_status text not null default 'pending'
    check (purge_status in ('pending', 'done', 'skipped', 'failed', 'not_needed')),
  purge_attempts int not null default 0 check (purge_attempts >= 0),
  purge_next_at timestamptz,
  purged_at timestamptz,
  side_effects jsonb not null default '{}'::jsonb check (jsonb_typeof(side_effects) = 'object'),
  failure jsonb check (failure is null or jsonb_typeof(failure) = 'object'),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint content_releases_tenant_number unique (tenant_id, number),
  -- The target of the tenant-fenced foreign keys below and on the other ledger tables.
  constraint content_releases_tenant_id_id unique (tenant_id, id),
  constraint content_releases_restores_fk foreign key (tenant_id, restores_release_id)
    references public.content_releases (tenant_id, id),
  constraint content_releases_numbered check ((status = 'published') = (number is not null)),
  constraint content_releases_schedule_shape check (
    status <> 'scheduled'
    or (scheduled_for is not null and scheduled_by is not null and payload is not null))
);
create index if not exists content_releases_tenant_status_idx
  on public.content_releases (tenant_id, status);
alter table public.content_releases enable row level security;
alter table public.content_releases force row level security;

-- BEFORE triggers fire in name order: actor, updated_at, version. None reads another's
-- output.
drop trigger if exists content_releases_actor on public.content_releases;
create trigger content_releases_actor before insert or update on public.content_releases
  for each row execute function app.tg_set_actor();
drop trigger if exists content_releases_updated_at on public.content_releases;
create trigger content_releases_updated_at before update on public.content_releases
  for each row execute function app.tg_set_updated_at();
drop trigger if exists content_releases_version on public.content_releases;
create trigger content_releases_version before update on public.content_releases
  for each row execute function app.tg_bump_version();

-- CMS staff read their tenant's versions. Nobody writes them through the API: no write
-- policy, and authenticated holds no write privilege (section 8). The service role
-- (apply_release, the purge and schedule paths) bypasses RLS.
drop policy if exists content_releases_read on public.content_releases;
create policy content_releases_read on public.content_releases for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

-- ═══ 5. content_drafts: one pending change per entity ═════════════════════════════════════
create table if not exists public.content_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  entity_type text not null references app.release_entities (entity_type),
  -- The live row's key; the tenant's id for a singleton; pre-allocated for a create.
  entity_id uuid not null,
  op text not null check (op in ('create', 'update', 'delete')),
  -- The merged camelCase input. UNTRUSTED: every consumer re-parses it with the entity's
  -- Zod schema and toRow (releases.md A3-13).
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 524288),
  -- The changed columns, for display only: at most 200, each a column name (a letter, then
  -- letters, digits or underscores, at most 63 characters: Postgres's own identifier
  -- limit). A CHECK cannot read the elements one by one (no subquery), so it reads the
  -- array's text form, which is exact for names: a name is never quoted there, and
  -- anything else (empty, spaces, commas, quotes, braces, another dimension or lower
  -- bound) is. A null element prints as a bare NULL, hence the array_position test
  -- (after the pattern, which has already refused a second dimension it cannot search).
  fields text[] not null default '{}'
    check (cardinality(fields) <= 200
           and fields::text ~ '^\{([A-Za-z][A-Za-z0-9_]{0,62}(,[A-Za-z][A-Za-z0-9_]{0,62})*)?\}$'
           and array_position(fields, null::text) is null),
  -- The live values of each patched column when it was first patched (three-way check).
  base jsonb not null default '{}'::jsonb
    check (jsonb_typeof(base) = 'object' and pg_column_size(base) <= 524288),
  -- The live version when the draft began (null for a create).
  base_version int,
  -- {en, ar} for lists, display only.
  label jsonb check (label is null or (jsonb_typeof(label) = 'object' and pg_column_size(label) <= 4096)),
  origin_kind text check (origin_kind in ('restore')),
  origin_release_id uuid,
  -- Claimed by a scheduled release (written only by the service-role schedule path).
  release_id uuid,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint content_drafts_one_per_entity unique (tenant_id, entity_type, entity_id),
  -- Tenant-fenced: a draft can only name a release of its own tenant.
  constraint content_drafts_release_fk foreign key (tenant_id, release_id)
    references public.content_releases (tenant_id, id),
  constraint content_drafts_origin_fk foreign key (tenant_id, origin_release_id)
    references public.content_releases (tenant_id, id),
  constraint content_drafts_delete_shape check (op <> 'delete' or payload = '{}'::jsonb),
  constraint content_drafts_create_shape check (op <> 'create' or base_version is null)
);
-- One pending entity_seo create per target (its draft is keyed by the new row's id).
create unique index if not exists content_drafts_one_seo_create
  on public.content_drafts (tenant_id, (payload ->> 'entityType'), (payload ->> 'entityId'))
  where entity_type = 'entity_seo' and op = 'create';
create index if not exists content_drafts_updated_by_idx
  on public.content_drafts (tenant_id, updated_by);
create index if not exists content_drafts_release_idx
  on public.content_drafts (tenant_id, release_id) where release_id is not null;
alter table public.content_drafts enable row level security;
alter table public.content_drafts force row level security;

-- The draft lock: the whole BEFORE phase of content_drafts in one function (one function
-- per phase, as app.tg_lead_pipeline is for leads), so no trigger order decides anything.
-- The shared app.tg_set_actor / app.tg_bump_version are not used here: the first keeps a
-- created_by the caller sends, the second keeps a version the caller sends when it differs
-- from the stored one, and either would let a writer forge what the publish check (R6)
-- reads.
--
--   1. The claim lock. A claim (release_id) is set and cleared only by the service-role
--      schedule path, and a claimed draft is read-only until its release fires or is
--      unscheduled: a bound caller cannot set, change or clear a claim, nor edit or discard
--      a claimed draft. Bound: anon and authenticated (RLS already refuses them, below), and
--      any other role that carries a staff claim, e.g. a SECURITY DEFINER function a staff
--      request reaches. Not bound: the service role (apply_release claims, consumes and
--      releases drafts as service_role, R4/R11, even while the publisher's claims are set),
--      and a caller with no role claim (the runbook functions, seeds, the migration role).
--   2. The draft's version, the lock publishing checks (a publish names {draftId,
--      draftVersion}, R6). An update always lands on old + 1, whatever the writer sent,
--      and never changes the id; an insert with a role claim starts at 1 under a fresh id.
--      So a pair a publisher saw never names other content later: not after an edit that
--      sent the old version back, and not after a discard and a re-create under that id.
--   3. The actor and the stamps. With a role claim, created_by/created_at are the
--      database's on insert; on every update they stay what they were. updated_by is
--      auth.uid() and updated_at now() on every write.
-- Invoker on purpose: it reads current_user and the request's claims, nothing private.
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
  return new;
end $$;
revoke all on function app.tg_draft_lock() from public, anon, authenticated, service_role;

-- The only trigger on the table (a postcondition holds it so).
drop trigger if exists content_drafts_lock on public.content_drafts;
create trigger content_drafts_lock before insert or update or delete on public.content_drafts
  for each row execute function app.tg_draft_lock();

-- Read: CMS staff, their tenant (each role's screens filter further; nothing here is more
-- private than the live tables, which every CMS role already reads: registry contract #1).
-- Write: the roles that may author the entity type; staging a removal needs the delete
-- roles, staging an archive needs Admin (content.archiveDelete); never a claimed draft.
drop policy if exists content_drafts_read on public.content_drafts;
create policy content_drafts_read on public.content_drafts for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
drop policy if exists content_drafts_insert on public.content_drafts;
create policy content_drafts_insert on public.content_drafts for insert to authenticated
  with check (tenant_id = app.effective_tenant_id()
              and app.can_author(entity_type)
              and (op <> 'delete' or app.can_stage_delete(entity_type))
              and ((payload ->> 'status') is distinct from 'archived' or app.is_admin())
              and release_id is null);
drop policy if exists content_drafts_update on public.content_drafts;
create policy content_drafts_update on public.content_drafts for update to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.can_author(entity_type)
         and release_id is null)
  with check (tenant_id = app.effective_tenant_id()
              and app.can_author(entity_type)
              and (op <> 'delete' or app.can_stage_delete(entity_type))
              and ((payload ->> 'status') is distinct from 'archived' or app.is_admin())
              and release_id is null);
drop policy if exists content_drafts_delete on public.content_drafts;
create policy content_drafts_delete on public.content_drafts for delete to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.can_author(entity_type)
         and release_id is null);

-- ═══ 6. content_release_items: what each release changed (append-only) ════════════════════
create table if not exists public.content_release_items (
  id bigint generated always as identity primary key,
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  release_id uuid not null,
  -- A registry type, or 'portfolio_children' (the synthetic item for a project's link sets).
  entity_type text not null check (entity_type ~ '^[a-z][a-z_]{1,39}$'),
  entity_id uuid not null,
  op text not null check (op in ('create', 'update', 'delete')),
  -- Full row images, minus the generated search_* columns.
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb check (after is null or jsonb_typeof(after) = 'object'),
  -- The draft it came from; null for cascades and side writes.
  draft_id uuid,
  -- An append-only ledger like audit_log: actor_id + created_at stand in for the
  -- created_by/updated_by pair (CLAUDE.md §8, Admin v2 lanes, Releases).
  actor_id uuid,
  created_at timestamptz not null default now(),
  constraint content_release_items_release_fk foreign key (tenant_id, release_id)
    references public.content_releases (tenant_id, id),
  constraint content_release_items_shape check (
    case op
      when 'create' then before is null and after is not null
      when 'delete' then before is not null and after is null
      else before is not null and after is not null
    end)
);
create index if not exists content_release_items_release_idx
  on public.content_release_items (tenant_id, release_id);
create index if not exists content_release_items_entity_idx
  on public.content_release_items (tenant_id, entity_type, entity_id, id desc);
alter table public.content_release_items enable row level security;
alter table public.content_release_items force row level security;

drop policy if exists content_release_items_read on public.content_release_items;
create policy content_release_items_read on public.content_release_items for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

-- The capture trigger (R4) is SECURITY DEFINER and inserts as its owner, the role that owns
-- the snapshot trigger. FORCE RLS subjects that owner to policies unless it bypasses RLS, so
-- it gets one insert policy, valid only inside a release (the 0032 pattern for
-- content_versions). No insert policy names an API role.
do $$
declare
  v_owner name;
begin
  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'tg_snapshot_version';
  if v_owner is null then
    raise exception '0038: app.tg_snapshot_version() not found';
  end if;
  if v_owner in ('anon', 'authenticated', 'service_role', 'public') then
    raise exception '0038: app.tg_snapshot_version() is owned by an API role (%)', v_owner;
  end if;
  execute 'drop policy if exists content_release_items_insert_capture on public.content_release_items';
  execute format(
    'create policy content_release_items_insert_capture on public.content_release_items '
    'for insert to %I with check (tenant_id = app.effective_tenant_id() and app.release_token_valid())',
    v_owner);
end $$;

-- ═══ 7. content_versions: release_id and full coverage ════════════════════════════════════
alter table public.content_versions add column if not exists release_id uuid;
alter table public.content_versions drop constraint if exists content_versions_release_fk;
alter table public.content_versions add constraint content_versions_release_fk
  foreign key (tenant_id, release_id) references public.content_releases (tenant_id, id);
create index if not exists content_versions_release_idx
  on public.content_versions (tenant_id, release_id) where release_id is not null;

-- 0009's body, plus release_id; search_path pinned to '' with every name qualified.
-- CREATE OR REPLACE keeps the owner (whom 0032's insert policy names) and the ACL.
create or replace function app.tg_snapshot_version() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.content_versions
    (tenant_id, entity_type, entity_id, version, snapshot, created_by, release_id)
  values (new.tenant_id, tg_argv[0], new.id, new.version, pg_catalog.to_jsonb(new), auth.uid(),
          app.current_release_id());
  return null;
end $$;
revoke all on function app.tg_snapshot_version() from public, anon, authenticated, service_role;

-- The same for a per-tenant singleton: the entity is the tenant.
create or replace function app.tg_snapshot_singleton() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.content_versions
    (tenant_id, entity_type, entity_id, version, snapshot, created_by, release_id)
  values (new.tenant_id, tg_argv[0], new.tenant_id, new.version, pg_catalog.to_jsonb(new),
          auth.uid(), app.current_release_id());
  return null;
end $$;
revoke all on function app.tg_snapshot_singleton() from public, anon, authenticated, service_role;

-- The registry tables that had no history (0009, 0016, 0021 and 0028 cover the rest).
do $$
declare
  t text;
  entity text;
begin
  for t, entity in values
    ('team_members', 'team_member'), ('certifications', 'certification'),
    ('statistics', 'statistic'), ('categories', 'category'), ('navigation', 'nav_item'),
    ('redirects', 'redirect'), ('entity_seo', 'entity_seo'), ('custom_themes', 'custom_theme')
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_snapshot', t);
    execute format('create trigger %I after insert or update on public.%I for each row execute function app.tg_snapshot_version(%L)', t || '_snapshot', t, entity);
  end loop;
  for t, entity in values ('site_profile', 'site_profile'), ('seo_defaults', 'seo_defaults') loop
    execute format('drop trigger if exists %I on public.%I', t || '_snapshot', t);
    execute format('create trigger %I after insert or update on public.%I for each row execute function app.tg_snapshot_singleton(%L)', t || '_snapshot', t, entity);
  end loop;
end $$;

-- ═══ 8. custom_themes: removal is Admin's (registry contract #2) ═══════════════════════════
drop policy if exists custom_themes_delete_admin on public.custom_themes;
create policy custom_themes_delete_admin on public.custom_themes
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ═══ 9. Grants, stated (Admin v2 P-14: both Supabase grant regimes) ═══════════════════════
-- Staff READ drafts and write none yet. The write policies above are in place (pgTAP proves
-- them with the grant restored inside its rolled-back transaction), but authenticated holds
-- no INSERT, UPDATE or DELETE until R3 grants them with the kernel that writes drafts: no
-- draft can be planted through PostgREST while nothing shows or checks them, to surface at
-- switch-on.
revoke all on public.content_drafts from public, anon, authenticated, service_role;
grant select on public.content_drafts to authenticated;
grant select, insert, update, delete on public.content_drafts to service_role;

revoke all on public.content_releases from public, anon, authenticated, service_role;
grant select on public.content_releases to authenticated;
grant select, insert, update on public.content_releases to service_role;

-- Append-only: no UPDATE or DELETE for any API role (R16's redaction will be a definer).
revoke all on public.content_release_items from public, anon, authenticated, service_role;
grant select on public.content_release_items to authenticated;
grant select, insert on public.content_release_items to service_role;

-- The items' identity sequence, the one sequence 0038 creates: no API role holds anything
-- on it (Supabase's default privileges would give them all of it; UPDATE on a sequence is
-- setval). An identity column draws its next value without any privilege on its sequence,
-- so the service role's inserts and the capture trigger's (R4) need no USAGE (0037 B5
-- grants USAGE because those tables have bigserial defaults, which do need it).
do $$
declare
  v_seq text := pg_get_serial_sequence('public.content_release_items', 'id');
begin
  if v_seq is null then
    raise exception '0038: public.content_release_items.id owns no sequence';
  end if;
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role', v_seq);
end $$;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_tables constant text[] := array['app.release_entities', 'app.release_tenants',
    'public.content_drafts', 'public.content_releases', 'public.content_release_items'];
  v_expected constant text[] := array['blog_post', 'category', 'certification', 'client',
    'custom_theme', 'discipline', 'entity_seo', 'nav_item', 'page', 'page_section',
    'portfolio', 'redirect', 'sector', 'seo_defaults', 'service', 'service_case',
    'site_profile', 'statistic', 'team_member', 'testimonial'];
  v_bad text;
  v_owner oid;
  p text;
  t text;
begin
  -- ---- RLS forced on every new table; nothing for anon or PUBLIC ----------------------
  foreach t in array v_tables loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = t::regclass) then
      raise exception '0038: % is not ENABLE + FORCE row level security', t;
    end if;
    foreach p in array array['public', 'anon'] loop
      if has_table_privilege(p::name, t, 'select, insert, update, delete, truncate, references, trigger')
         or has_any_column_privilege(p::name, t, 'select, insert, update, references') then
        raise exception '0038: % holds a privilege on %', p, t;
      end if;
    end loop;
  end loop;

  -- ---- authenticated and service_role: exactly the stated privileges -------------------
  select string_agg(format('%s %s %s', g.who, g.priv, g.tbl), ', ' order by g.tbl, g.who, g.priv)
    into v_bad
    from (
      select x.who, x.tbl, pr.priv,
             has_table_privilege(x.who::name, x.tbl, pr.priv) as held,
             pr.priv = any (x.allowed) as wanted
        from (values
          ('authenticated', 'public.content_drafts', array['select']),
          ('authenticated', 'public.content_releases', array['select']),
          ('authenticated', 'public.content_release_items', array['select']),
          ('authenticated', 'app.release_entities', array['select']),
          ('authenticated', 'app.release_tenants', array[]::text[]),
          ('service_role', 'public.content_drafts', array['select', 'insert', 'update', 'delete']),
          ('service_role', 'public.content_releases', array['select', 'insert', 'update']),
          ('service_role', 'public.content_release_items', array['select', 'insert']),
          ('service_role', 'app.release_entities', array['select']),
          ('service_role', 'app.release_tenants', array[]::text[])
        ) as x(who, tbl, allowed)
        cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                           ('references'), ('trigger')) as pr(priv)
    ) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0038: wrong table privileges: %', v_bad;
  end if;

  -- ---- Every policy on the new public tables names the tenant; no write policy reaches
  -- an API role on the two ledgers ----------------------------------------------------
  select string_agg(format('%s.%s', tablename, policyname), ', ') into v_bad
    from pg_policies
   where schemaname = 'public'
     and tablename in ('content_drafts', 'content_releases', 'content_release_items')
     and coalesce(qual, '') not like '%effective_tenant_id()%'
     and coalesce(with_check, '') not like '%effective_tenant_id()%';
  if v_bad is not null then
    raise exception '0038: policies without the tenant predicate: %', v_bad;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'content_releases' and cmd <> 'SELECT') then
    raise exception '0038: content_releases has a write policy';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'content_release_items'
                and cmd <> 'SELECT'
                and (cmd <> 'INSERT'
                     or roles && array['public', 'anon', 'authenticated', 'service_role']::name[]
                     or with_check not like '%release_token_valid()%')) then
    raise exception '0038: content_release_items has a write policy other than the capture insert inside a release';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'content_drafts'
         and roles = array['authenticated']::name[]) <> 4 then
    raise exception '0038: content_drafts must carry exactly its four policies, to authenticated';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_drafts'
                    and policyname = 'content_drafts_update'
                    and qual like '%release_id IS NULL%' and with_check like '%release_id IS NULL%') then
    raise exception '0038: a claimed draft must stay out of reach of staff updates';
  end if;

  -- ---- Functions: who may call what --------------------------------------------------
  foreach p in array array['app.can_author(text)', 'app.can_stage_delete(text)'] loop
    if not has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('public', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0038: % must be executable by authenticated only', p;
    end if;
  end loop;
  foreach p in array array['app.release_token_valid()', 'app.current_release_id()',
                           'app.releases_enabled(uuid)', 'app.tg_snapshot_version()',
                           'app.tg_snapshot_singleton()', 'app.tg_draft_lock()'] loop
    if has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute')
       or has_function_privilege('public', p, 'execute') then
      raise exception '0038: % is executable by an API role', p;
    end if;
  end loop;

  -- The definers: SECURITY DEFINER with a pinned search_path. The flag reader's owner must
  -- bypass RLS (app.release_tenants is FORCE RLS with no policy), or every tenant would
  -- read as off forever; the singleton snapshot has the owner 0032's insert policy names.
  foreach p in array array['app.tg_snapshot_version()', 'app.tg_snapshot_singleton()',
                           'app.releases_enabled(uuid)'] loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure and f.prosecdef
                      and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')) then
      raise exception '0038: % must be SECURITY DEFINER with a pinned search_path', p;
    end if;
  end loop;
  if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                  where f.oid = 'app.releases_enabled(uuid)'::regprocedure
                    and (r.rolsuper or r.rolbypassrls)) then
    raise exception '0038: app.releases_enabled() is owned by a role that does not bypass RLS';
  end if;
  select proowner into v_owner from pg_proc where oid = 'app.tg_snapshot_version()'::regprocedure;
  if (select proowner from pg_proc where oid = 'app.tg_snapshot_singleton()'::regprocedure) <> v_owner then
    raise exception '0038: the two snapshot triggers must have the same owner';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_versions'
                    and policyname = 'content_versions_insert_snapshot'
                    and roles = array[pg_get_userbyid(v_owner)]::name[]) then
    raise exception '0038: content_versions_insert_snapshot (0032) must name the snapshot owner';
  end if;

  -- ---- The registry: the design's twenty entity types, each a real table with the
  -- columns it names, RLS forced, and history ----------------------------------------
  if not (select array_agg(entity_type) @> v_expected and array_agg(entity_type) <@ v_expected
                 and count(*) = cardinality(v_expected)
            from app.release_entities) then
    raise exception '0038: the registry must hold exactly %', v_expected;
  end if;
  select string_agg(format('%s.%s', e.table_name, c.col), ', ' order by e.table_name, c.col)
    into v_bad
    from app.release_entities e
    cross join lateral unnest(e.columns || e.exempt_columns
                              || array[e.key_column, 'tenant_id', 'version']) as c(col)
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = format('public.%I', e.table_name)::regclass
        and a.attname = c.col and a.attnum > 0 and not a.attisdropped);
  if v_bad is not null then
    raise exception '0038: registry columns that do not exist: %', v_bad;
  end if;
  select string_agg(e.entity_type, ', ' order by e.entity_type) into v_bad
    from app.release_entities e
    join pg_class c on c.oid = format('public.%I', e.table_name)::regclass
   where not (c.relrowsecurity and c.relforcerowsecurity)
      or not exists (
        select 1 from pg_trigger tg
          join pg_proc f on f.oid = tg.tgfoid
         where tg.tgrelid = c.oid and not tg.tgisinternal
           and tg.tgname = e.table_name || '_snapshot'
           and f.proname = case e.key_column when 'id' then 'tg_snapshot_version'
                                             else 'tg_snapshot_singleton' end
           -- AFTER (bit 2 clear) ROW (bit 0) INSERT (bit 2^2) and UPDATE (bit 2^4)
           and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 0
           and tg.tgtype & 4 = 4 and tg.tgtype & 16 = 16
           -- One argument, the entity type (tgargs holds each one NUL-terminated).
           and tg.tgnargs = 1
           and tg.tgargs = convert_to(e.entity_type, 'UTF8') || '\x00'::bytea);
  if v_bad is not null then
    raise exception '0038: registry tables without forced RLS or their snapshot trigger: %', v_bad;
  end if;

  -- ---- Releases are off everywhere, history is still staff-read, the theme gate ------
  if exists (select 1 from app.release_tenants) then
    raise exception '0038: releases must start switched off (app.release_tenants is not empty)';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'content_versions'
                    and policyname = 'content_versions_read' and qual like '%is_staff()%') then
    raise exception '0038: content_versions_read must stay CMS staff only (app.is_staff())';
  end if;
  if has_table_privilege('authenticated', 'public.content_versions', 'insert')
     or has_table_privilege('authenticated', 'public.content_versions', 'update')
     or has_table_privilege('authenticated', 'public.content_versions', 'delete') then
    raise exception '0038: authenticated may write history rows (0032 reverted?)';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.content_versions'::regclass
                    and conname = 'content_versions_release_fk' and contype = 'f') then
    raise exception '0038: content_versions.release_id is not tenant-fenced to content_releases';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'custom_themes'
                    and policyname = 'custom_themes_delete_admin' and permissive = 'RESTRICTIVE'
                    and cmd = 'DELETE'
                    and qual like '%effective_tenant_id()%' and qual like '%is_admin()%') then
    raise exception '0038: custom_themes_delete_admin is missing, permissive, or incomplete';
  end if;
  -- The draft lock is the only trigger on content_drafts, BEFORE, FOR EACH ROW, on INSERT,
  -- UPDATE and DELETE (tgtype 1 + 2 + 4 + 8 + 16): a later generic actor or version trigger
  -- would run in name order around it and could undo what it sets.
  if (select string_agg(format('%s %s.%s %s', t.tgname, n.nspname, f.proname, t.tgtype), ', ')
        from pg_trigger t
        join pg_proc f on f.oid = t.tgfoid
        join pg_namespace n on n.oid = f.pronamespace
       where t.tgrelid = 'public.content_drafts'::regclass and not t.tgisinternal)
     is distinct from 'content_drafts_lock app.tg_draft_lock 31' then
    raise exception '0038: content_drafts must carry exactly one trigger, the draft lock';
  end if;
end $$;
