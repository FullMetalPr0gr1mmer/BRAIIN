-- ─────────────────────────────────────────────────────────────────────────────
-- 0045 — Media uploads: the public `media` bucket and the `storage` provider.
-- Admin v2 U3 (owner decision A5; owner item O-1). Forward-only (expand). Depends on 0001,
-- 0009, 0011, 0020, 0024, 0028.
--
-- Editors upload images through the Worker (POST /api/admin/media/upload): it sniffs the
-- bytes, re-encodes them through the Images binding to ONE WebP no longer than 2,560 px on
-- its long edge (EXIF and GPS dropped), and stores only that output, with the service role,
-- in a public bucket. Visitors and the admin reach the object only through same-origin
-- `/_image` (img-src gains no origin). This migration is the database half:
--
--   1. media_assets: a fifth provider, `storage`, shape-checked — the object key is
--      `<tenant>/<random id>_<w>x<h>.webp`, its tenant segment is the row's tenant, its
--      size in the name equals the row's width/height (the `/_image` guard bounds a
--      transform by the name, with no database read), WebP, at most 2,560 px, neither side
--      more than 100 times the other (MEDIA_MAX_ASPECT: thinner, a listed width rounds its
--      height to 0 and no `/_image` URL for it is admitted), a size the bucket can hold —
--      one row per object (a unique index on the key), plus
--      `display_name` (the uploaded file's own name; staff only).
--   2. media_assets_public_read: 0028's policy, unchanged, with `storage` added to the
--      hosted providers visitors may read (only while published content shows the asset).
--   3. public.media_storage_stats(p_tenant): "storage used" for the library's meter.
--      SECURITY INVOKER: RLS decides the rows, and a tenant other than the token's gets 0.
--   4. public.media_orphan_objects(): objects in the bucket no row names (a replaced file, a
--      Worker stopped between the upload and the insert). Service role only; the Worker's
--      daily job deletes them through the Storage API.
--   5. The grants on media_assets, stated: anon the 0024 column SELECT only; authenticated
--      SELECT, INSERT, UPDATE, DELETE; the service role SELECT; PUBLIC nothing. No API role
--      keeps Supabase's starter TRUNCATE, REFERENCES, TRIGGER or (PostgreSQL 17) MAINTAIN.
--   6. The bucket: PUBLIC, 10 MB, `image/webp` only. No storage policy admits anon or
--      authenticated, and a RESTRICTIVE belt refuses them outright: only the service role
--      writes, as for 0029's `applications`. A public bucket means an uploaded image is
--      reachable by its unguessable URL before anything publishes it (runbook §6i).
--
-- Grants are stated, never inherited (P-14): each new function is revoked from public,
-- anon, authenticated and service_role, then granted to exactly the role that calls it, and
-- media_assets' grants are stated in full (5); the postconditions check what each role must
-- and must not hold, under both Supabase grant regimes and on PostgreSQL 15 (CI) and 17
-- (production). No table, sequence or capability is added: §5 "Media — upload / edit
-- metadata" already decides who uploads (media_write: Admin, Content Creator, Developer; SEO
-- meta only, via update_media_meta()).
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: a statement below that waits more than
-- five seconds for a lock (media_assets gains a column, three constraints, an index, a
-- policy and its stated grants; storage.objects a policy) raises, and the push is retried
-- later, rather than holding its place in the lock queue while the site's reads and writes
-- pile up behind it.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. The provider, its shape, the display name ---------------------------------------
alter table public.media_assets
  add column if not exists display_name text;

-- The characters refused are named, not a locale's [[:cntrl:]] (which, in a UTF-8 database,
-- follows LC_CTYPE and may also take C1 controls or U+2028/U+2029), so the database refuses
-- exactly what MediaDisplayNameSchema refuses (packages/schemas/media.ts): C0 and C1
-- controls, DEL, the line and paragraph separators, and both slashes.
alter table public.media_assets drop constraint if exists media_assets_display_name;
alter table public.media_assets add constraint media_assets_display_name check (
  display_name is null
  or (char_length(display_name) between 1 and 200
      and display_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029/\\]')
);

alter table public.media_assets drop constraint if exists media_assets_provider_known;
alter table public.media_assets add constraint media_assets_provider_known
  check (provider in ('external', 'static', 'cf_images', 'stream', 'storage'));

-- 0020's shape, plus the `storage` branch. The branch is wrapped in coalesce(…, false): a
-- CHECK passes on NULL, so a storage row missing its size or MIME type would otherwise slip
-- through on an unknown rather than fail on a false.
alter table public.media_assets drop constraint if exists media_assets_provider_shape;
alter table public.media_assets add constraint media_assets_provider_shape check (
  case provider
    when 'static' then
      storage_path ~ '^stills/[a-z0-9][a-z0-9/_-]*\.(jpe?g|png|webp|avif)$'
    when 'cf_images' then
      provider_ref is not null
      and storage_path ~ '^https://imagedelivery\.net/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$'
    when 'stream' then
      stream_uid is not null and stream_uid ~ '^[a-f0-9]{32}$'
    when 'storage' then coalesce((
      kind = 'image'
      and storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[1-9][0-9]{0,3}x[1-9][0-9]{0,3}\.webp$'
      and split_part(storage_path, '/', 1) = tenant_id::text
      and split_part(storage_path, '_', 2) = width::text || 'x' || height::text || '.webp'
      and greatest(width, height) <= 2560
      and greatest(width, height) <= least(width, height) * 100
      and mime_type = 'image/webp'
      and size_bytes between 1 and 10485760
      and provider_ref is null
      and stream_uid is null
    ), false)
    else true
  end
) not valid;

-- Validated where every row complies; otherwise left NOT VALID with a warning, as 0020 did
-- (a legacy row keeps the push applying, and every new or edited row is held to it).
do $$
begin
  alter table public.media_assets validate constraint media_assets_provider_shape;
exception when check_violation then
  raise warning '0045: media_assets_provider_shape left NOT VALID — legacy media rows violate it (still enforced on every new or edited row)';
end $$;

-- One row per uploaded file. The Worker writes a fresh random key on every upload and
-- replace, but a staff token holds INSERT and UPDATE on media_assets (0011), so without this
-- a direct API write could name another row's object; deleting that duplicate would then
-- remove a file a live page still shows. No `storage` row exists before this migration.
create unique index if not exists media_assets_storage_object_key
  on public.media_assets (storage_path) where provider = 'storage';

-- ---- 2. Visitors read an uploaded image that published content shows -------------------
-- 0028's policy, word for word, with `storage` among the hosted providers. Each branch
-- runs under anon's own RLS on the joined table, so a draft or hidden reference fails
-- closed; the anon column grant (0024) is unchanged, so `display_name` stays staff-only.
drop policy if exists media_assets_public_read on public.media_assets;
create policy media_assets_public_read on public.media_assets for select using (
  tenant_id = app.effective_tenant_id()
  and provider in ('static', 'cf_images', 'stream', 'storage')
  and (
    exists (select 1 from public.portfolio p
             where p.poster_media_id = media_assets.id and p.status = 'published')
    or exists (select 1 from public.portfolio_media pm
                 join public.portfolio p on p.id = pm.portfolio_id
                where pm.media_id = media_assets.id and p.status = 'published')
    or exists (select 1 from public.clients c
                where c.logo_media_id = media_assets.id and c.visible)
    or exists (select 1 from public.testimonials t
                where t.avatar_media_id = media_assets.id and t.status = 'published')
    or exists (select 1 from public.team_members m
                where m.portrait_media_id = media_assets.id and m.status = 'published')
    or exists (select 1 from public.page_sections s
                 join public.pages pg on pg.id = s.page_id
                where s.visible and pg.status = 'published'
                  and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                                        jsonb_build_object('id', media_assets.id::text)))
    or exists (select 1 from public.disciplines d
                where d.poster_media_id = media_assets.id and d.status = 'published')
    or exists (select 1 from public.services sv
                where sv.poster_media_id = media_assets.id and sv.status = 'published')
  )
);

-- ---- 3. Storage used, for the library's meter -------------------------------------------
-- SECURITY INVOKER: the caller's RLS decides what is counted (media_read: staff of the
-- token's tenant), and the tenant the Worker names must be the token's, or the answer is
-- zero. Counts uploaded objects only: a still shipped with the site occupies no bucket.
create or replace function public.media_storage_stats(p_tenant uuid)
  returns table (assets bigint, bytes bigint)
  language sql stable security invoker set search_path = '' as $$
  select count(*)::bigint, coalesce(sum(m.size_bytes), 0)::bigint
    from public.media_assets m
   where m.provider = 'storage'
     and m.tenant_id = p_tenant
     and m.tenant_id = app.effective_tenant_id()
$$;
revoke all on function public.media_storage_stats(uuid) from public, anon, authenticated, service_role;
grant execute on function public.media_storage_stats(uuid) to authenticated;

-- ---- 4. Objects no row names --------------------------------------------------------------
-- A replaced file's old object (kept until this sweep, so a page rendered just before the
-- replace still finds it), or an upload whose row was never written (the Worker stopped
-- between the two, and its compensating delete failed too). Older than a grace period, so
-- an upload still in flight is never one. The Worker's daily job deletes them through the
-- Storage API (a SQL delete on storage.objects would leave the file).
--
-- SECURITY INVOKER, so it reads only what its caller may: the service role, which bypasses
-- RLS. It refuses any caller that does not, because under RLS `not exists` would see no
-- rows and call EVERY object an orphan. PL/pgSQL: `storage` is resolved when it runs, not
-- when it is created (bare Postgres has no storage schema).
create or replace function public.media_orphan_objects(p_older_than_minutes int, p_limit int)
returns table (object_name text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_older_than_minutes is null or p_older_than_minutes < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'media_orphan_objects: argument out of range' using errcode = '22023';
  end if;
  if not coalesce((select r.rolbypassrls or r.rolsuper
                     from pg_catalog.pg_roles r where r.rolname = current_user), false) then
    raise exception 'media_orphan_objects: the caller must bypass RLS' using errcode = '42501';
  end if;
  return query
    select o.name
      from storage.objects o
     where o.bucket_id = 'media'
       and o.created_at < now() - make_interval(mins => p_older_than_minutes)
       and not exists (select 1 from public.media_assets m where m.storage_path = o.name)
     order by o.created_at
     limit p_limit;
end
$$;
revoke all on function public.media_orphan_objects(int, int) from public, anon, authenticated, service_role;
grant execute on function public.media_orphan_objects(int, int) to service_role;

-- ---- 5. Who holds what on media_assets, stated ------------------------------------------
-- Stated, never inherited (P-14), so the table's grants are the same with Supabase's
-- starter grants (ALL to anon, authenticated and service_role: 0011 granted staff four
-- commands and never revoked the rest, so they still held TRUNCATE, REFERENCES, TRIGGER
-- and, on PostgreSQL 17, MAINTAIN) and without them:
--   • PUBLIC: nothing.
--   • anon: the 0024 column SELECT and nothing else. Only what anon must not hold is
--     revoked, never SELECT: revoking a table privilege takes it off every column as well,
--     and the 0024 grant with it.
--   • authenticated: SELECT, INSERT, UPDATE and DELETE; RLS decides the rows (0001, 0007),
--     and the upload and replace routes write `display_name` through the caller's token.
--     Not TRUNCATE, which RLS does not govern, nor REFERENCES, TRIGGER or MAINTAIN, which
--     no staff path uses (the API cannot run them either; this is the grant layer saying
--     so).
--   • service_role: SELECT. The orphan sweep (as the caller of media_orphan_objects) and
--     the delete and replace routes' "does a row still name this file?" read the table as
--     the service role; nothing writes it so (every write is the caller's, under RLS).
revoke all on public.media_assets from public;
revoke insert, update, delete, truncate, references, trigger on public.media_assets from anon;
revoke all on public.media_assets from authenticated;
grant select, insert, update, delete on public.media_assets to authenticated;
revoke all on public.media_assets from service_role;
grant select on public.media_assets to service_role;
-- MAINTAIN exists from PostgreSQL 17 (production runs 17.6; CI runs 15, which does not know
-- the word, hence EXECUTE behind the version test). REVOKE ALL above already took it from
-- the other three.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.media_assets from anon';
  end if;
end $$;

-- ---- 6. The bucket ------------------------------------------------------------------------
-- Guarded like 0029's: bare Postgres has no `storage` schema. On Supabase it always exists,
-- so this branch always runs there, and the postcondition below refuses a push that left
-- the bucket missing, private, or wider than WebP and 10 MB.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise warning '0045: storage.buckets absent — skipping the media bucket (expected ONLY outside Supabase)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media', 'media', true, 10485760, array['image/webp'])
  on conflict (id) do update
    set public = true,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- The belt: no permissive storage policy added later (for some other bucket) can let
  -- anon or a staff token write, list or delete here. Visitors read through the public URL,
  -- which Supabase Storage serves without RLS. Creating a policy on storage.objects needs
  -- its owner's rights; if this project's migration role lacks them, the bucket is still
  -- closed to both roles (no policy names it): say so, do not fail the push.
  begin
    execute 'drop policy if exists media_bucket_service_only on storage.objects';
    execute $p$
      create policy media_bucket_service_only on storage.objects
        as restrictive for all to anon, authenticated
        using (bucket_id <> 'media')
        with check (bucket_id <> 'media')
    $p$;
  exception when insufficient_privilege then
    raise warning '0045: not permitted to add the storage.objects belt policy; no policy names the media bucket, so anon and authenticated still cannot write to it';
  end;
end $$;

-- ---- 7. Postconditions --------------------------------------------------------------------
do $$
declare
  -- Every table privilege there is. MAINTAIN exists from PostgreSQL 17 (production); on 15
  -- (CI) has_table_privilege() does not know the word, so it is listed only where it does.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  -- The 0024 column grant: what a public <img>/<Picture> needs (PUBLIC_MEDIA_COLUMNS).
  v_anon_cols constant text[] := array['id', 'tenant_id', 'kind', 'provider', 'storage_path',
    'width', 'height', 'alt', 'stream_uid', 'mime_type', 'updated_at'];
  -- The tenant predicate, alone or as the FIRST conjunct of a top-level AND (as 0038).
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  v_have text[];
  v_want text[];
  v_bad text;
begin
  -- ---- media_assets, table-wide: each API role holds exactly its stated privileges -----
  select string_agg(format('%s %s %s', x.who,
                           case when has_table_privilege(x.who::name, 'public.media_assets', p.priv)
                                then 'holds' else 'lacks' end,
                           p.priv), ', ' order by x.who, p.priv)
    into v_bad
    from (values ('public', array[]::text[]),
                 ('anon', array[]::text[]),
                 ('authenticated', array['select', 'insert', 'update', 'delete']),
                 ('service_role', array['select'])) as x(who, allowed)
    cross join unnest(v_privs) as p(priv)
   where has_table_privilege(x.who::name, 'public.media_assets', p.priv)
         is distinct from (p.priv = any (x.allowed));
  if v_bad is not null then
    raise exception '0045: wrong table privileges on media_assets: %', v_bad;
  end if;

  -- ---- ...and per column: no column grant widens what the table grant says (a column
  -- grant is visible to has_any_column_privilege, not to has_table_privilege) -------------
  select string_agg(format('%s %s %s', x.who, case when x.held then 'lacks' else 'holds' end,
                           x.priv), ', ' order by x.who, x.priv)
    into v_bad
    from (values ('public', 'select', false), ('public', 'insert', false),
                 ('public', 'update', false), ('public', 'references', false),
                 ('anon', 'select', true), ('anon', 'insert', false),
                 ('anon', 'update', false), ('anon', 'references', false),
                 ('authenticated', 'select', true), ('authenticated', 'insert', true),
                 ('authenticated', 'update', true), ('authenticated', 'references', false),
                 ('service_role', 'select', true), ('service_role', 'insert', false),
                 ('service_role', 'update', false), ('service_role', 'references', false))
         as x(who, priv, held)
   where has_any_column_privilege(x.who::name, 'public.media_assets', x.priv) is distinct from x.held;
  if v_bad is not null then
    raise exception '0045: wrong column privileges on media_assets: %', v_bad;
  end if;
  -- Visitors read exactly the 0024 columns: never display_name (the uploaded file's name).
  select coalesce(array_agg(a.attname::text), '{}')
    into v_have
    from pg_attribute a
   where a.attrelid = 'public.media_assets'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', 'public.media_assets', a.attname::text, 'select');
  if not (v_have @> v_anon_cols and v_have <@ v_anon_cols) then
    raise exception '0045: anon reads media_assets columns % (expected exactly %)', v_have, v_anon_cols;
  end if;
  -- Staff read and write display_name: the upload and replace routes write it as the caller.
  if not (has_column_privilege('authenticated', 'public.media_assets', 'display_name', 'select')
          and has_column_privilege('authenticated', 'public.media_assets', 'display_name', 'insert')
          and has_column_privilege('authenticated', 'public.media_assets', 'display_name', 'update')) then
    raise exception '0045: authenticated cannot read and write media_assets.display_name';
  end if;

  -- ---- media_assets' policies: exactly these, for any role (name, command, kind, roles),
  -- each leading with the tenant predicate in USING and in WITH CHECK -------------------
  v_want := array[
    'media_assets_public_read SELECT PERMISSIVE {public}',
    'media_delete_admin DELETE RESTRICTIVE {public}',
    'media_read SELECT PERMISSIVE {public}',
    'media_write ALL PERMISSIVE {public}'];
  select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                            order by policyname), '{}')
    into v_have
    from pg_policies
   where schemaname = 'public' and tablename = 'media_assets';
  if v_have is distinct from v_want then
    raise exception '0045: media_assets'' policies are %, expected %', v_have, v_want;
  end if;
  select string_agg(policyname, ', ' order by policyname)
    into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'media_assets'
     and (qual is null or qual !~ v_tenant_first
          or (with_check is not null and with_check !~ v_tenant_first));
  if v_bad is not null then
    raise exception '0045: media_assets policies that do not lead with the tenant predicate: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.media_assets'::regclass
       and conname = 'media_assets_provider_known'
       and pg_get_constraintdef(oid) like '%''storage''%'
  ) then
    raise exception '0045: media_assets_provider_known does not admit storage';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.media_assets'::regclass
       and conname = 'media_assets_provider_shape'
       and pg_get_constraintdef(oid) like '%''storage''%'
  ) then
    raise exception '0045: media_assets_provider_shape has no storage branch';
  end if;
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.media_assets_storage_object_key')
       and i.indrelid = 'public.media_assets'::regclass
       and i.indisunique and i.indisvalid
       and pg_get_expr(i.indpred, i.indrelid) like '%''storage''%'
  ) then
    raise exception '0045: media_assets_storage_object_key is missing, not unique, or not limited to storage rows';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'media_assets'
       and policyname = 'media_assets_public_read' and permissive = 'PERMISSIVE'
       and qual like '%''storage''%' and qual like '%effective_tenant_id%'
  ) then
    raise exception '0045: media_assets_public_read is missing, or does not admit storage';
  end if;

  -- ---- The functions: invoker, a fixed search_path, and exactly one caller role each ----
  if exists (
    select 1 from pg_proc
     where oid in ('public.media_storage_stats(uuid)'::regprocedure,
                   'public.media_orphan_objects(int, int)'::regprocedure)
       and (prosecdef
            or not exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) as s(setting)
                            where s.setting like 'search_path=%'))
  ) then
    raise exception '0045: a media function is SECURITY DEFINER or has no fixed search_path';
  end if;
  select string_agg(format('%s %s %s', x.who,
                           case when x.held then 'cannot execute' else 'may execute' end, x.fn),
                    ', ' order by x.fn, x.who)
    into v_bad
    from (select r.who, f.fn, r.who = f.caller as held
            from (values ('public.media_storage_stats(uuid)', 'authenticated'),
                         ('public.media_orphan_objects(int, int)', 'service_role')) as f(fn, caller)
            cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) as r(who)
         ) as x
   where has_function_privilege(x.who::name, x.fn, 'execute') is distinct from x.held;
  if v_bad is not null then
    raise exception '0045: wrong callers: %', v_bad;
  end if;
  -- The sweep's safety rests on the service role bypassing RLS (the function also checks).
  if exists (select 1 from pg_roles where rolname = 'service_role' and not rolbypassrls) then
    raise exception '0045: service_role does not bypass RLS; media_orphan_objects would call every object an orphan';
  end if;

  if to_regclass('storage.buckets') is not null then
    if not exists (
      select 1 from storage.buckets
       where id = 'media' and public = true and file_size_limit = 10485760
         and allowed_mime_types = array['image/webp']::text[]
    ) then
      raise exception '0045: the media bucket is missing, private, or not limited to WebP and 10 MB';
    end if;
    if not has_table_privilege('service_role', 'storage.objects', 'select') then
      raise warning '0045: the service role cannot read storage.objects; the daily orphan sweep will fail (and log it)';
    end if;

  end if;
end $$;
