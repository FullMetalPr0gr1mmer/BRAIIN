-- pgTAP: media uploads (0045, Admin v2 U3). Runs where Supabase Storage's schema exists
-- (CI's `supabase start`).
--
--   1. the public `media` bucket: WebP only, 10 MB, and no API role writes to it;
--   2. the `storage` provider's shape: the key's tenant is the row's, its size is the row's,
--      WebP, ≤ 2,560 px, a size and a MIME type (a NULL never slips through the CHECK);
--   3. §5 "Media — upload / edit metadata": Admin, Content Creator and Developer write a
--      storage row; SEO reads the library and edits metadata through update_media_meta()
--      only; other_tenant writes and reads nothing; hard delete is Admin's;
--   4. visitors read an uploaded image only while published content shows it, and never
--      its display_name;
--   5. media_storage_stats(): the caller's own tenant only;
--   6. media_orphan_objects(): the service role only, and never an object a row names.
begin;
select plan(42);

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
-- The orphan probe writes two objects straight into storage.objects. Where this stack's
-- storage schema does not allow that, its two assertions are skipped, saying why.
create function _orphan_probe(p_orphan text, p_named text) returns setof text
  language plpgsql as $f$
begin
  begin
    insert into storage.objects (bucket_id, name, created_at)
    values ('media', p_orphan, now() - interval '2 hours'),
           ('media', p_named, now() - interval '2 hours');
  exception when others then
    return next skip('storage.objects is not writable from SQL here: ' || sqlerrm, 2);
    return;
  end;
  return next is(
    (select count(*)::int from public.media_orphan_objects(60, 1000) where object_name = p_orphan),
    1, 'the sweep finds an object no row names, once it is older than the grace period');
  return next is(
    (select count(*)::int from public.media_orphan_objects(60, 1000) where object_name = p_named),
    0, 'the sweep never offers an object that a media row names');
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
set local role service_role;
select throws_ok($$ select * from public.media_orphan_objects(60, 0) $$,
  '22023', null, 'the sweep refuses an out-of-range batch');
select * from _orphan_probe(
  _key(app.default_tenant_id(), '45000000-0000-4000-8000-0000000000f0', 10, 10),
  _key(app.default_tenant_id(), '45000000-0000-4000-8000-000000000001', 1200, 800));

select * from finish();
rollback;
