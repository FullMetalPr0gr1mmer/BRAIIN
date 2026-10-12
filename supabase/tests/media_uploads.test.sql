-- pgTAP: media uploads (0045, Admin v2 U3). Runs where Supabase Storage's schema exists
-- (CI's `supabase start`).
--
--   1. the public `media` bucket: WebP only, 10 MB, and no API role writes to it; the
--      RESTRICTIVE belt exists and still shuts anon and staff tokens out when a permissive
--      policy opens every bucket to them;
--   2. the `storage` provider's shape: the key's tenant is the row's, its size is the row's,
--      WebP, ≤ 2,560 px, neither side over 100 times the other (MEDIA_MAX_ASPECT, at the
--      bound admitted), a size and a MIME type (a NULL never slips through the CHECK); the
--      display name refuses exactly what MediaDisplayNameSchema refuses;
--   3. §5 "Media — upload / edit metadata": Admin, Content Creator and Developer write a
--      storage row, and no row names another row's file; SEO reads the library and edits
--      metadata through update_media_meta() only; other_tenant writes and reads nothing;
--      hard delete is Admin's;
--   4. visitors read an uploaded image only while published content shows it, and never
--      its display_name;
--   5. media_storage_stats(): the caller's own tenant only;
--   6. media_orphan_objects(): the service role only, never an object a row names, and only
--      the Worker's own objects: a key it writes, created since 0045 ran (its floor);
--   7. the grants on media_assets, stated: no API role holds TRUNCATE, REFERENCES, TRIGGER
--      or MAINTAIN; staff SELECT, INSERT, UPDATE, DELETE (display_name included); the
--      service role SELECT; anon the 0024 columns; PUBLIC nothing.
begin;
select plan(69);

insert into public.tenants (id, name) values ('45000000-0000-0000-0000-000000000002', 'MediaUploadsT2');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _key(p_tenant uuid, p_object text, p_w int, p_h int) returns text
  language sql immutable as $$
  select p_tenant::text || '/' || p_object || '_' || p_w::text || 'x' || p_h::text || '.webp'
$$;
create function _seen(p_id text) returns int language sql as $$
  select count(id)::int from public.media_assets where id = p_id::uuid $$;
create function _set_path(p_id uuid, p_path text) returns int language plpgsql as $$
declare n int;
begin
  update public.media_assets set storage_path = p_path where id = p_id;
  get diagnostics n = row_count;
  return n;
end $$;
create function _delete(p_id uuid) returns int language plpgsql as $$
declare n int;
begin
  delete from public.media_assets where id = p_id;
  get diagnostics n = row_count;
  return n;
end $$;
-- What the current role sees and can change in a bucket; -1 when it holds no privilege on
-- storage.objects at all (Supabase's grants, not ours, decide that).
create function _objects(p_bucket text) returns int language plpgsql as $f$
begin
  return (select count(*)::int from storage.objects where bucket_id = p_bucket);
exception when insufficient_privilege then
  return -1;
end $f$;
create function _touch(p_bucket text) returns int language plpgsql as $f$
declare n int;
begin
  update storage.objects set metadata = coalesce(metadata, '{}'::jsonb) where bucket_id = p_bucket;
  get diagnostics n = row_count;
  return n;
exception when insufficient_privilege then
  return -1;
end $f$;
-- Whether the CHECK admits an insert, keeping no row: the probe row goes with the
-- subtransaction the exception block rolls back, so later counts are untouched.
create function _admitted(p_sql text) returns boolean language plpgsql as $f$
begin
  execute p_sql;
  raise exception using errcode = 'P0001', message = 'roll the probe row back';
exception
  when check_violation then return false;
  when raise_exception then return true;
end $f$;
create function _can(p_role text, p_privilege text) returns boolean language sql as $f$
  select has_table_privilege(p_role, 'storage.objects', p_privilege) $f$;
-- A role's table privileges on media_assets, every one there is: MAINTAIN only from
-- PostgreSQL 17 (CI runs 15, which does not know the word).
create function _privs(p_role text) returns text language sql as $f$
  select coalesce(string_agg(p.priv, ',' order by p.priv), '')
    from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']
                || case when current_setting('server_version_num')::int >= 170000
                        then array['maintain'] else array[]::text[] end) as p(priv)
   where has_table_privilege(p_role, 'public.media_assets', p.priv) $f$;
-- How many of the named objects one sweep offers.
create function _offered(p_grace int, p_names text[]) returns int language sql as $f$
  select count(*)::int from public.media_orphan_objects(p_grace, 1000)
   where object_name = any (p_names) $f$;

-- The belt (0045 §5), proven rather than assumed. Without it nothing names the bucket, so
-- the inserts in section 1 fail either way; here a permissive policy opens EVERY bucket to
-- anon and authenticated (as a later migration for some other bucket might), and the media
-- bucket must stay shut while the other bucket opens. Adding a policy on storage.objects
-- needs its owner's rights, the same rights 0045 needed for the belt: where this role holds
-- them the belt must exist; where it does not, 0045 warned and these are skipped, saying so.
create function _belt_probe() returns setof text language plpgsql as $f$
declare
  v_open boolean := true;
begin
  begin
    create policy _pgtap_open_all on storage.objects as permissive
      for all to anon, authenticated using (true) with check (true);
  exception when insufficient_privilege then
    v_open := false;
  end;

  if v_open or exists (select 1 from pg_policies where schemaname = 'storage'
                         and tablename = 'objects' and policyname = 'media_bucket_service_only') then
    return next is(
      (select permissive || '|' || cmd || '|'
              || array_to_string(array(select r::text from unnest(roles) as r order by 1), ',')
              || '|' || qual || '|' || with_check
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'media_bucket_service_only'),
      'RESTRICTIVE|ALL|anon,authenticated|(bucket_id <> ''media''::text)|(bucket_id <> ''media''::text)',
      'the belt exists: RESTRICTIVE, every command, anon and authenticated, never the media bucket');
  else
    return next skip('this role may not add a storage.objects policy, and 0045 could not add the belt either (it warned)', 1);
  end if;
  if not v_open then
    return next skip('this role may not add a storage.objects policy, so the belt cannot be opened against here', 8);
    return;
  end if;

  -- A bucket no belt names, and one object in each (the service role writes, as the Worker).
  insert into storage.buckets (id, name, public) values ('pgtap-open', 'pgtap-open', false);
  set local role service_role;
  insert into storage.objects (bucket_id, name) values
    ('media', _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000d1', 1, 1)),
    ('pgtap-open', 'pgtap/open.txt');
  reset role;

  set local role authenticated;
  perform _claims('admin', app.default_tenant_id()::text);
  return next is(_objects('pgtap-open'),
    case when _can('authenticated', 'select') then 1 else -1 end,
    'control: the open policy lets a staff token read the other bucket');
  return next is(_objects('media'),
    case when _can('authenticated', 'select') then 0 else -1 end,
    'the belt hides every media object from a staff token, whatever else is permitted');
  return next is(_touch('media'),
    case when _can('authenticated', 'select') and _can('authenticated', 'update') then 0 else -1 end,
    'the belt leaves a staff token no media object to change (or delete: the same USING)');
  return next throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('media', 'x/belt_1x1.webp') $$,
    '42501', null, 'the belt refuses a staff token''s write into the media bucket, even opened');
  reset role;

  set local role anon;
  perform _claims(null, null);
  return next is(_objects('pgtap-open'),
    case when _can('anon', 'select') then 1 else -1 end,
    'control: the open policy lets anon read the other bucket');
  return next is(_objects('media'),
    case when _can('anon', 'select') then 0 else -1 end,
    'the belt hides every media object from anon (visitors read the public URL, not the table)');
  return next is(_touch('media'),
    case when _can('anon', 'select') and _can('anon', 'update') then 0 else -1 end,
    'the belt leaves anon no media object to change');
  return next throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('media', 'x/belt_1x1.webp') $$,
    '42501', null, 'the belt refuses anon''s write into the media bucket, even opened');
  reset role;

  drop policy _pgtap_open_all on storage.objects;
end $f$;

-- ── fixtures (the launch tenant, which anon is fenced to, and another tenant) ──────────────
insert into public.media_assets
  (id, tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes, display_name, alt)
values
  ('45000000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'image', 'storage',
   _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800),
   1200, 800, 'image/webp', 100000, 'holiday photo.jpg', '{"en":"A street","ar":"شارع"}'),
  ('45000000-0000-0000-0000-0000000000a2', app.default_tenant_id(), 'image', 'storage',
   _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000002', 640, 480),
   640, 480, 'image/webp', 50000, 'unused.png', '{"en":"Unused","ar":"غير مستخدم"}'),
  ('45000000-0000-0000-0000-0000000000a3', '45000000-0000-0000-0000-000000000002', 'image', 'storage',
   _key('45000000-0000-0000-0000-000000000002', '45000000-0000-4000-8000-000000000003', 300, 300),
   300, 300, 'image/webp', 7000, 'other.jpg', null);
insert into public.portfolio (id, tenant_id, slug, title, status, poster_media_id) values
  ('45000000-0000-0000-0000-0000000000c1', app.default_tenant_id(), 'pgtap-upload-pub',
   '{"en":"P","ar":"م"}', 'published', '45000000-0000-0000-0000-0000000000a1');

-- ── 1. the bucket ─────────────────────────────────────────────────────────────────────────
select is((select public from storage.buckets where id = 'media'), true,
  'the media bucket is public (visitors read objects by URL, through /_image)');
select is((select file_size_limit from storage.buckets where id = 'media'), 10485760::bigint,
  'the bucket refuses objects over 10 MB');
select is((select allowed_mime_types from storage.buckets where id = 'media'), array['image/webp']::text[],
  'the bucket holds WebP only: the re-encoded master, never an original');

set local role authenticated;
select _claims('admin', app.default_tenant_id()::text);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('media', 'x/y_1x1.webp') $$,
  '42501', null, 'an authenticated admin cannot write into the media bucket (the Worker does, as the service role)');
reset role;
set local role anon;
select _claims(null, null);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('media', 'x/y_1x1.webp') $$,
  '42501', null, 'anon cannot write into the media bucket');
reset role;

-- The belt, with every bucket opened to both API roles (nine assertions, or nine skips).
select * from _belt_probe();

-- ── 2. the storage provider's shape ───────────────────────────────────────────────────────
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 10, 10, 'image/webp', 100) $$,
         _key('45000000-0000-0000-0000-000000000002', '45000000-0000-4000-8000-0000000000e1', 10, 10)),
  '23514', null, 'a key under another tenant''s prefix is refused');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 641, 480, 'image/webp', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e2', 640, 480)),
  '23514', null, 'a size in the key that is not the row''s width and height is refused');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 10, 10, 'image/webp', 100) $$,
         replace(_key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e3', 10, 10), '.webp', '.jpg')),
  '23514', null, 'a key that is not a .webp is refused');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'video', 'storage', %L, 10, 10, 'image/webp', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e4', 10, 10)),
  '23514', null, 'a storage row is an image');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 10, 10, 'image/webp', null) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e5', 10, 10)),
  '23514', null, 'a storage row without its size is refused (a NULL does not slip through the CHECK)');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 10, 10, 'image/png', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e6', 10, 10)),
  '23514', null, 'a storage row is WebP');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 3000, 2000, 'image/webp', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e7', 3000, 2000)),
  '23514', null, 'a master longer than 2,560 px is refused');
-- MEDIA_MAX_ASPECT (packages/schemas/media.ts): thinner than 100 to 1, a listed width rounds
-- the height to 0 and `/_image` admits no URL for it; both ways, as the upload refuses.
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 2000, 19, 'image/webp', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e8', 2000, 19)),
  '23514', null, 'a master more than 100 times as wide as it is high is refused');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 19, 2000, 'image/webp', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000e9', 19, 2000)),
  '23514', null, 'a master more than 100 times as high as it is wide is refused');
select ok(
  _admitted(format(
    $$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
       values (app.default_tenant_id(), 'image', 'storage', %L, 2000, 20, 'image/webp', 100) $$,
    _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000ea', 2000, 20))),
  'a master exactly 100 times as wide as it is high is admitted (the bound is the schema''s)');
select throws_ok(
  $$ insert into public.media_assets (tenant_id, kind, provider, storage_path)
     values (app.default_tenant_id(), 'image', 'r2', 'x.webp') $$,
  '23514', null, 'an unknown provider is still refused');
select throws_ok(
  $$ insert into public.media_assets (tenant_id, kind, provider, storage_path, display_name)
     values (app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', E'two\nlines') $$,
  '23514', null, 'a display name with a control character is refused');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, display_name)
            values (app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', %L) $$,
         repeat('x', 201)),
  '23514', null, 'a display name over 200 characters is refused');
-- The CHECK names its characters, so it refuses what MediaDisplayNameSchema refuses and
-- nothing else, whatever the database's locale calls a control character.
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, display_name)
            values (app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', %L) $$,
         'scan' || chr(133) || '1.jpg'),
  '23514', null, 'a display name with a C1 control character is refused (as the schema refuses it)');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, display_name)
            values (app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', %L) $$,
         'scan' || chr(8232) || '1.jpg'),
  '23514', null, 'a display name with a line separator is refused (as the schema refuses it)');
select lives_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, display_name)
            values (app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', %L) $$,
         'صورة' || chr(160) || 'الفريق.jpg'),
  'an Arabic display name with a no-break space is admitted (as the schema admits it)');
select lives_ok(
  $$ insert into public.media_assets (tenant_id, kind, provider, storage_path, display_name)
     values (app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg', 'reel frame.jpg') $$,
  'the other providers are unchanged (a static still with a display name)');

-- ── 3. who writes: §5 "Media — upload / edit metadata" ───────────────────────────────────
set local role authenticated;
select _claims('admin', app.default_tenant_id()::text);
select lives_ok(
  format($$ insert into public.media_assets (id, tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values ('45000000-0000-0000-0000-0000000000b1', app.default_tenant_id(), 'image', 'storage', %L, 20, 10, 'image/webp', 2000) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000b1', 20, 10)),
  'admin records an uploaded image');
select _claims('content_creator', app.default_tenant_id()::text);
select lives_ok(
  format($$ insert into public.media_assets (id, tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values ('45000000-0000-0000-0000-0000000000b2', app.default_tenant_id(), 'image', 'storage', %L, 20, 10, 'image/webp', 2500) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000b2', 20, 10)),
  'content_creator records an uploaded image');
-- One row per uploaded file, at the database too: a staff token on the API cannot make a
-- second row name a live poster's file (deleting that row would remove the poster's file).
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 1200, 800, 'image/webp', 100) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800)),
  '23505', null, 'a staff token cannot add a second row naming a file another row names');
select throws_ok(
  format($$ update public.media_assets set storage_path = %L, width = 1200, height = 800
             where id = '45000000-0000-0000-0000-0000000000b2' $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800)),
  '23505', null, 'nor repoint a row at another row''s file');
select _claims('developer', app.default_tenant_id()::text);
select lives_ok(
  format($$ insert into public.media_assets (id, tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values ('45000000-0000-0000-0000-0000000000b3', app.default_tenant_id(), 'image', 'storage', %L, 20, 10, 'image/webp', 3000) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000b3', 20, 10)),
  'developer records an uploaded image');
select _claims('seo', app.default_tenant_id()::text);
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 20, 10, 'image/webp', 2000) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000b4', 20, 10)),
  '42501', null, 'seo cannot record an uploaded image (media.write is meta only)');
select _claims('admin', '45000000-0000-0000-0000-000000000002');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 20, 10, 'image/webp', 2000) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000b5', 20, 10)),
  '42501', null, 'other_tenant (an admin elsewhere) cannot record an image in this tenant');
select is(
  (select count(*)::int from public.media_assets
    where provider = 'storage' and tenant_id = app.default_tenant_id()),
  0, 'other_tenant reads none of this tenant''s uploaded images');

select _claims('seo', app.default_tenant_id()::text);
select is(
  (select count(*)::int from public.media_assets
    where provider = 'storage' and tenant_id = app.default_tenant_id()),
  5, 'seo reads the library (its uploaded images included)');
select is(
  _set_path('45000000-0000-0000-0000-0000000000a2',
            _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800)),
  0, 'seo cannot repoint an uploaded image at another file (a direct UPDATE is filtered)');
select is(
  (select count(*)::int from public.update_media_meta('45000000-0000-0000-0000-0000000000a2', 1,
     '{"alt":{"en":"A frame","ar":"لقطة"},"storage_path":"stills/evil.jpg","provider":"static"}'::jsonb)),
  1, 'seo edits an uploaded image''s alt text through update_media_meta()');
select is(
  (select alt ->> 'en' || '|' || provider || '|'
          || (storage_path = _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000002', 640, 480))::text
     from public.media_assets where id = '45000000-0000-0000-0000-0000000000a2'),
  'A frame|storage|true',
  'only the alt text changed: the file and its provider in the patch were ignored');

select _claims('content_creator', app.default_tenant_id()::text);
select is(_delete('45000000-0000-0000-0000-0000000000b2'), 0,
  'content_creator cannot hard-delete an uploaded image (media.hardDelete is Admin''s)');
select _claims('admin', app.default_tenant_id()::text);
select is(_delete('45000000-0000-0000-0000-0000000000b2'), 1, 'admin hard-deletes an uploaded image');

-- ── 4. visitors ───────────────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select _claims(null, null);
select is(_seen('45000000-0000-0000-0000-0000000000a1'), 1,
  'anon reads an uploaded image a published project shows');
select is(_seen('45000000-0000-0000-0000-0000000000a2'), 0,
  'anon cannot read an uploaded image nothing published shows');
select throws_ok($$ select display_name from public.media_assets $$,
  '42501', null, 'anon cannot read an upload''s display name (the file''s own name)');
select throws_ok(
  format($$ insert into public.media_assets (tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
            values (app.default_tenant_id(), 'image', 'storage', %L, 20, 10, 'image/webp', 2000) $$,
         _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000b6', 20, 10)),
  '42501', null, 'anon cannot record an image');
select throws_ok($$ select * from public.media_storage_stats(app.default_tenant_id()) $$,
  '42501', null, 'anon cannot execute media_storage_stats()');
select throws_ok($$ select * from public.media_orphan_objects(60, 10) $$,
  '42501', null, 'anon cannot execute media_orphan_objects()');

-- ── 5. storage used ───────────────────────────────────────────────────────────────────────
reset role;
set local role authenticated;
select _claims('admin', app.default_tenant_id()::text);
select is(
  (select assets::text || '/' || bytes::text from public.media_storage_stats(app.default_tenant_id())),
  '4/155000', 'admin: four uploaded images, 155,000 bytes, in this tenant');
select is(
  (select assets::text || '/' || bytes::text
     from public.media_storage_stats('45000000-0000-0000-0000-000000000002')),
  '0/0', 'a tenant other than the token''s counts nothing');
select _claims('seo', app.default_tenant_id()::text);
select is(
  (select assets::text || '/' || bytes::text from public.media_storage_stats(app.default_tenant_id())),
  '4/155000', 'seo reads the meter too (it reads the library)');
select _claims('admin', '45000000-0000-0000-0000-000000000002');
select is(
  (select assets::text || '/' || bytes::text from public.media_storage_stats(app.default_tenant_id())),
  '0/0', 'other_tenant naming this tenant counts nothing');
select throws_ok($$ select * from public.media_orphan_objects(60, 10) $$,
  '42501', null, 'a staff token cannot execute media_orphan_objects()');

-- ── 6. the orphan sweep (the Worker's daily job, as the service role) ──────────────────────
reset role;
select ok(
  has_function_privilege('service_role', 'app.media_sweep_floor()', 'execute')
  and not has_function_privilege('authenticated', 'app.media_sweep_floor()', 'execute')
  and not has_function_privilege('anon', 'app.media_sweep_floor()', 'execute')
  and app.media_sweep_floor() < now(),
  'the sweep''s floor is a moment before this run (0045''s), and only the service role reads it');
set local role service_role;
select throws_ok($$ select * from public.media_orphan_objects(60, 0) $$,
  '22023', null, 'the sweep refuses an out-of-range batch');
-- Objects written straight into storage.objects, as the Storage API writes them (the
-- service role), dated at the floor: this run cannot wait out the hour's grace, so the
-- sweep is asked with a grace of 0 (an object dated at the floor is older than now), and
-- once with a grace longer than the time since 0045 ran. Not wrapped: if this stack
-- refused the write, the run should say so, not turn the sweep's assertions into skips.
insert into storage.objects (bucket_id, name, created_at) values
  -- the Worker's key, and no row names it: an orphan
  ('media', _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000f0', 10, 10),
   app.media_sweep_floor()),
  -- the file row a1 names
  ('media', _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800),
   app.media_sweep_floor()),
  -- the Worker's key, but in the bucket before 0045 ran (an adopted bucket's earlier file)
  ('media', _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000f1', 10, 10),
   app.media_sweep_floor() - interval '1 second'),
  -- names the Worker never writes: a file put in by hand, and a key without its size
  ('media', 'hand/team photo.webp', app.media_sweep_floor()),
  ('media', app.default_tenant_id()::text || '/45000000-0000-4000-8000-0000000000f2.webp',
   app.media_sweep_floor());
select is(
  _offered(0, array[_key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000f0', 10, 10)]),
  1, 'the sweep finds an object the Worker wrote that no row names, once it is older than the grace period');
select is(
  _offered(1000000, array[_key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000f0', 10, 10)]),
  0, 'an object younger than the grace period is not offered (its row may still be on its way)');
select is(
  _offered(0, array[_key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800)]),
  0, 'the sweep never offers an object that a media row names');
select is(
  _offered(0, array[_key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000f1', 10, 10)]),
  0, 'nor one that was in the bucket before 0045 ran (an adopted bucket''s earlier files stay)');
select is(
  _offered(0, array['hand/team photo.webp',
                    app.default_tenant_id()::text || '/45000000-0000-4000-8000-0000000000f2.webp']),
  0, 'nor one whose name is not a key the Worker writes (a file put in by hand stays)');

-- ── 7. the grants on media_assets, stated (0045 §5) ────────────────────────────────────────
reset role;
select is(_privs('authenticated'), 'delete,insert,select,update',
  'staff tokens hold SELECT, INSERT, UPDATE and DELETE on media_assets, and no TRUNCATE (RLS does not govern it), REFERENCES, TRIGGER or MAINTAIN');
select is(_privs('service_role'), 'select',
  'the service role holds SELECT on media_assets and nothing else (the sweep and the removal''s lookup read it; nothing writes as it)');
select is(_privs('anon') || '|' || _privs('public'), '|',
  'anon and PUBLIC hold no table privilege on media_assets');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.media_assets'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', 'public.media_assets', a.attname::text, 'select')),
  'alt,height,id,kind,mime_type,provider,storage_path,stream_uid,tenant_id,updated_at,width',
  'anon reads exactly the 0024 columns, never display_name');
select ok(
  not has_any_column_privilege('anon', 'public.media_assets', 'insert, update, references')
  and not has_any_column_privilege('public', 'public.media_assets', 'select, insert, update, references')
  and not has_any_column_privilege('authenticated', 'public.media_assets', 'references')
  and not has_any_column_privilege('service_role', 'public.media_assets', 'insert, update, references'),
  'no column grant widens a table grant: no column write for anon, PUBLIC or the service role, and no REFERENCES');
select ok(
  has_column_privilege('authenticated', 'public.media_assets', 'display_name', 'select')
  and has_column_privilege('authenticated', 'public.media_assets', 'display_name', 'insert')
  and has_column_privilege('authenticated', 'public.media_assets', 'display_name', 'update'),
  'staff tokens read and write display_name (the upload and replace routes write it as the caller)');

select * from finish();
rollback;
