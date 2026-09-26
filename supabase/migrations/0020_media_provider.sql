-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 — Media providers, the SEO metadata write path, media usage. UI v2 PR4a.
-- Forward-only (expand). Depends on 0001, 0009, 0011.
--
-- 1. Where an asset's bytes live — `provider`:
--      external   a URL we do not host (legacy rows; the default, so nothing changes)
--      static     a showreel still shipped WITH the site: `storage_path` is a key of the
--                 build-time registry (src/lib/media/static.ts — `stills/…`), processed by
--                 <Picture> like any ESM image. A key, never a path: `..` cannot occur.
--      cf_images  uploaded through the admin (PR5): `provider_ref` is the Images id.
--      stream     a Cloudflare Stream video (KAN-20): `stream_uid`.
--    Each provider's shape is a CHECK, so a row can never claim a provider its columns
--    contradict.
--
-- 2. `update_media_meta()` — §5 gives SEO `media.write: meta only`, and the admin route
--    has allowed it since Phase 3, but `media_write` (0001) never admitted SEO: RLS
--    filtered the UPDATE to zero rows and the editor got a 409 "someone else saved".
--    Rather than hand SEO a column-agnostic UPDATE policy, a SECURITY DEFINER function
--    writes exactly alt / tags / folder, tenant-fenced and version-checked.
--
-- 3. `media_usage()` — where an asset is referenced; the hard-delete route refuses while
--    it is in use (PR4b). v1 knows page_sections; 0024 replaces it once every
--    referencing column exists.
--
-- New constraints are added NOT VALID and then validated: a legacy row that violates one
-- keeps the migration applying (with a warning naming the count) while every new or
-- edited row is held to it from now on.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Provider --------------------------------------------------------------
alter table public.media_assets
  add column if not exists provider text not null default 'external',
  add column if not exists provider_ref text;

alter table public.media_assets drop constraint if exists media_assets_provider_known;
alter table public.media_assets add constraint media_assets_provider_known
  check (provider in ('external', 'static', 'cf_images', 'stream'));

alter table public.media_assets drop constraint if exists media_assets_provider_shape;
alter table public.media_assets add constraint media_assets_provider_shape check (
  case provider
    when 'static' then
      storage_path ~ '^stills/[a-z0-9][a-z0-9/_-]*\.(jpe?g|png|webp|avif)$'
    when 'cf_images' then
      provider_ref is not null
      and storage_path ~ '^https://imagedelivery\.net/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$'
    when 'stream' then
      stream_uid ~ '^[a-f0-9]{32}$'
    else true
  end
) not valid;

alter table public.media_assets drop constraint if exists media_assets_dims;
alter table public.media_assets add constraint media_assets_dims check (
  (width is null) = (height is null)
  and (width is null or (width between 1 and 12000 and height between 1 and 12000))
) not valid;

do $$
declare
  c text;
begin
  foreach c in array array['media_assets_provider_shape', 'media_assets_dims'] loop
    begin
      execute format('alter table public.media_assets validate constraint %I', c);
    exception when check_violation then
      raise warning '0020: % left NOT VALID — legacy media rows violate it (still enforced on every new or edited row)', c;
    end;
  end loop;
end $$;

create unique index if not exists media_assets_provider_ref_key
  on public.media_assets (tenant_id, provider, provider_ref) where provider_ref is not null;
create index if not exists media_assets_kind_idx
  on public.media_assets (tenant_id, kind, created_at desc);

-- ---- 2. The metadata write path (alt / tags / folder only) ---------------------
-- p_patch names only the keys to change: `alt` (a {en, ar} object or null), `tags` (an
-- array of strings) and `folder` (a string or null). Anything else in it is ignored —
-- the function has no way to write storage_path, kind, provider or dimensions.
-- Returns the updated row, or NO row when the id is absent in this tenant or the version
-- has moved on (the route tells those apart with its own pre-read).
create or replace function public.update_media_meta(p_id uuid, p_version int, p_patch jsonb)
  returns table (
    id uuid, kind text, storage_path text, folder text, alt jsonb, tags text[],
    version int, updated_at timestamptz
  )
  language plpgsql security definer set search_path = public, app, pg_temp as $$
begin
  if app.current_role() not in ('admin', 'content_creator', 'seo', 'developer') then
    raise exception 'media metadata is staff-only' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be an object' using errcode = '22023';
  end if;
  if p_patch ? 'alt' and jsonb_typeof(p_patch -> 'alt') not in ('object', 'null') then
    raise exception 'alt must be an {en, ar} object or null' using errcode = '22023';
  end if;
  if p_patch ? 'tags' and jsonb_typeof(p_patch -> 'tags') <> 'array' then
    raise exception 'tags must be an array' using errcode = '22023';
  end if;

  return query
  update public.media_assets m set
    alt = case when p_patch ? 'alt' then nullif(p_patch -> 'alt', 'null'::jsonb) else m.alt end,
    tags = case
      when p_patch ? 'tags'
        then array(select jsonb_array_elements_text(p_patch -> 'tags'))
      else m.tags
    end,
    folder = case when p_patch ? 'folder' then p_patch ->> 'folder' else m.folder end
  where m.tenant_id = app.effective_tenant_id()
    and m.id = p_id
    and m.version = p_version
  returning m.id, m.kind, m.storage_path, m.folder, m.alt, m.tags, m.version, m.updated_at;
end $$;
revoke all on function public.update_media_meta(uuid, int, jsonb) from public, anon, service_role;
grant execute on function public.update_media_meta(uuid, int, jsonb) to authenticated;

-- ---- 3. Where an asset is used (v1: page sections) -----------------------------
-- SECURITY INVOKER: the caller sees only references its own RLS lets it see — a staff
-- caller sees every section of its tenant. 0024 replaces this with every reference.
create or replace function public.media_usage(p_media_id uuid)
  returns table (entity_type text, entity_id uuid, label text)
  language sql stable security invoker set search_path = public, app, pg_temp as $$
  select 'page_section'::text, s.id, s.type
    from public.page_sections s
   where s.tenant_id = app.effective_tenant_id()
     and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                           jsonb_build_object('id', p_media_id::text))
$$;
revoke all on function public.media_usage(uuid) from public, anon, service_role;
grant execute on function public.media_usage(uuid) to authenticated;

-- ---- 4. Postconditions ----------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'update_media_meta' and p.prosecdef
  ) then
    raise exception 'update_media_meta must be SECURITY DEFINER';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'media_usage' and p.prosecdef
  ) then
    raise exception 'media_usage must be SECURITY INVOKER (callers see only their own rows)';
  end if;
  if has_function_privilege('anon', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.media_usage(uuid)', 'execute') then
    raise exception 'anon can execute a 0020 media function';
  end if;
  if exists (select 1 from public.media_assets where provider <> 'external') then
    raise exception '0020 expected every existing media row to default to external';
  end if;
  -- media_assets is FORCE RLS, so the definer's UPDATE is subject to media_write unless
  -- the owner bypasses RLS (Supabase's `postgres` does — the same dependency 0011 checks
  -- for app.default_tenant_id()). Without it the function would update 0 rows for SEO,
  -- which is the very 409 it exists to fix; rls_media_public.test.sql proves it works.
  if not exists (
    select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.update_media_meta(uuid, int, jsonb)'::regprocedure
       and (r.rolsuper or r.rolbypassrls)
  ) then
    raise warning '0020: update_media_meta() is owned by a role without BYPASSRLS — SEO metadata saves will write 0 rows';
  end if;
end $$;
