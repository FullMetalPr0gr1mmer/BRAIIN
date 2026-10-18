-- pgTAP: share images from the media library (0073, Admin v2 U10).
--
--   • entity_seo.og_media_id and seo_defaults.default_og_media_id are composite foreign keys
--     (tenant_id, <column>) → media_assets (tenant_id, id) ON DELETE RESTRICT: a share image
--     is always an asset of the row's own tenant (another tenant's id is 23503), and a
--     picture in use cannot be hard-deleted (23503) even before the Worker's media_usage gate.
--   • media_assets_public_read gains two branches: anon reads an asset a VISIBLE entity_seo
--     row names (its parent published: 0011's fence, under anon's own RLS) or the tenant's
--     seo_defaults names. A draft's share image and an unreferenced asset stay hidden. Reading
--     either table as anon must not recurse (42P17): no policy on them reads media_assets.
--   • media_usage v5 lists both kinds, pending false.
--   • the release registry stages both columns.
--
-- Roles: admin, content_creator, seo, developer, anon and other_tenant (an admin, and anon,
-- of a second tenant). Writes to entity_seo and seo_defaults rely on the token's role
-- (0009's policies, no live check): a demoted user's unexpired token is the pre-existing
-- stale-token gap (deviations.md), which this file neither widens nor closes, so it has no
-- stale-token rows.

begin;
select plan(37);

-- ── fixtures, as the migration role (RLS bypassed), in the LAUNCH tenant ───────────────────
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('73000000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'image', 'static', 'stills/work/p0.jpg'),
  ('73000000-0000-0000-0000-0000000000a2', app.default_tenant_id(), 'image', 'static', 'stills/work/p1.jpg'),
  ('73000000-0000-0000-0000-0000000000a3', app.default_tenant_id(), 'image', 'static', 'stills/work/p2.jpg'),
  ('73000000-0000-0000-0000-0000000000a4', app.default_tenant_id(), 'image', 'static', 'stills/work/p3.jpg'),
  ('73000000-0000-0000-0000-0000000000a5', app.default_tenant_id(), 'image', 'static', 'stills/work/p4.jpg');
insert into public.services (id, tenant_id, slug, title, status) values
  ('73000000-0000-0000-0000-0000000000c1', app.default_tenant_id(), 'pgtap-seo-pub',
   '{"en":"Live","ar":"مباشر"}', 'published'),
  ('73000000-0000-0000-0000-0000000000c2', app.default_tenant_id(), 'pgtap-seo-draft',
   '{"en":"Draft","ar":"مسودة"}', 'draft');
insert into public.entity_seo (id, tenant_id, entity_type, entity_id, og_media_id) values
  ('73000000-0000-0000-0000-0000000000e1', app.default_tenant_id(), 'service',
   '73000000-0000-0000-0000-0000000000c1', '73000000-0000-0000-0000-0000000000a1'),
  ('73000000-0000-0000-0000-0000000000e2', app.default_tenant_id(), 'service',
   '73000000-0000-0000-0000-0000000000c2', '73000000-0000-0000-0000-0000000000a2');
insert into public.seo_defaults (tenant_id, default_og_media_id)
  values (app.default_tenant_id(), '73000000-0000-0000-0000-0000000000a3')
  on conflict (tenant_id) do update set default_og_media_id = excluded.default_og_media_id;

-- A second tenant with its own published service, SEO row and share image.
insert into public.tenants (id, name) values ('73000000-0000-0000-0000-000000000002', 'SeoT2');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path) values
  ('73000000-0000-0000-0000-0000000000b1', '73000000-0000-0000-0000-000000000002', 'image', 'static', 'stills/work/p0.jpg');
insert into public.services (id, tenant_id, slug, title, status) values
  ('73000000-0000-0000-0000-0000000000d1', '73000000-0000-0000-0000-000000000002', 'pgtap-seo-t2',
   '{"en":"T2","ar":"ت"}', 'published');
insert into public.entity_seo (tenant_id, entity_type, entity_id, og_media_id) values
  ('73000000-0000-0000-0000-000000000002', 'service', '73000000-0000-0000-0000-0000000000d1',
   '73000000-0000-0000-0000-0000000000b1');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
-- anon carrying a tenant claim (and no role): the fence follows the claim.
create function _anon_claim(p_tid text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('app_metadata', json_build_object('tenant_id', p_tid))::text, true)
$$;
create function _tid() returns text language sql as $$ select app.default_tenant_id()::text $$;
create function _visible(p_id text) returns boolean language sql as $$
  select exists (select 1 from public.media_assets where id = p_id::uuid)
$$;
create function _set_og(p_media text) returns int language sql as $$
  with u as (update public.entity_seo set og_media_id = p_media::uuid
              where id = '73000000-0000-0000-0000-0000000000e1' returning 1)
  select count(*)::int from u
$$;
create function _set_default(p_media text) returns int language sql as $$
  with u as (update public.seo_defaults set default_og_media_id = p_media::uuid returning 1)
  select count(*)::int from u
$$;
-- A hard delete refused by a foreign key: RESTRICT answers 23001 (restrict_violation) on
-- the PostgreSQL versions that name it, 23503 on older ones; either is the key refusing.
create function _delete_refused(p_id text) returns boolean language plpgsql as $$
begin
  delete from public.media_assets where id = p_id::uuid;
  return false;
exception when foreign_key_violation or restrict_violation then
  return true;
end $$;
grant execute on function _delete_refused(text) to authenticated;
grant execute on function _claims(text, text), _anon_claim(text), _tid(), _visible(text),
  _set_og(text), _set_default(text) to anon, authenticated;

-- ── 1–6. Structure ────────────────────────────────────────────────────────────────────────
select is((select format_type(atttypid, atttypmod) from pg_attribute
            where attrelid = 'public.entity_seo'::regclass and attname = 'og_media_id'
              and not attisdropped and not attnotnull),
  'uuid', 'entity_seo.og_media_id is a nullable uuid');
select is((select format_type(atttypid, atttypmod) from pg_attribute
            where attrelid = 'public.seo_defaults'::regclass and attname = 'default_og_media_id'
              and not attisdropped and not attnotnull),
  'uuid', 'seo_defaults.default_og_media_id is a nullable uuid');
select is((select pg_get_constraintdef(oid) from pg_constraint
            where conrelid = 'public.media_assets'::regclass and conname = 'media_assets_tenant_id_id'),
  'UNIQUE (tenant_id, id)', 'media_assets carries UNIQUE (tenant_id, id)');
select ok((select confdeltype = 'r'
                  and pg_get_constraintdef(oid) ~ '^FOREIGN KEY \(tenant_id, og_media_id\) REFERENCES (public\.)?media_assets\(tenant_id, id\)'
             from pg_constraint
            where conrelid = 'public.entity_seo'::regclass and conname = 'entity_seo_og_media_fk'),
  'entity_seo_og_media_fk: (tenant_id, og_media_id) to media_assets (tenant_id, id), RESTRICT');
select ok((select confdeltype = 'r'
                  and pg_get_constraintdef(oid) ~ '^FOREIGN KEY \(tenant_id, default_og_media_id\) REFERENCES (public\.)?media_assets\(tenant_id, id\)'
             from pg_constraint
            where conrelid = 'public.seo_defaults'::regclass and conname = 'seo_defaults_default_og_media_fk'),
  'seo_defaults_default_og_media_fk: (tenant_id, default_og_media_id) to media_assets (tenant_id, id), RESTRICT');
select ok(to_regclass('public.entity_seo_og_media_idx') is not null
          and to_regclass('public.seo_defaults_default_og_media_idx') is not null,
  'both share-image columns are indexed');

-- ── 7–13. What anon reads ─────────────────────────────────────────────────────────────────
set local role anon;
select _claims(null, null);
select ok(_visible('73000000-0000-0000-0000-0000000000a1'),
  'anon reads the share image of a PUBLISHED service''s SEO row');
select ok(not _visible('73000000-0000-0000-0000-0000000000a2'),
  'anon does not read the share image of a DRAFT service''s SEO row');
select ok(_visible('73000000-0000-0000-0000-0000000000a3'),
  'anon reads the default share image of the SEO defaults');
select ok(not _visible('73000000-0000-0000-0000-0000000000a4'),
  'anon does not read an asset nothing references');
select lives_ok($$ select (select count(*) from public.entity_seo)
                        + (select count(*) from public.seo_defaults)
                        + (select count(*) from public.media_assets) $$,
  'anon reads entity_seo, seo_defaults and media_assets without recursion (no 42P17)');
select throws_ok($$ select display_name from public.media_assets $$, '42501', null,
  'anon still reads media_assets only through the 0024 column grant');
select _anon_claim('73000000-0000-0000-0000-000000000002');
select ok(not _visible('73000000-0000-0000-0000-0000000000a1')
          and not _visible('73000000-0000-0000-0000-0000000000a3')
          and _visible('73000000-0000-0000-0000-0000000000b1'),
  'other_tenant: anon fenced to the second tenant reads only that tenant''s share image');

-- ── 14–27. Who writes a share image ───────────────────────────────────────────────────────
select _claims(null, null);
select throws_ok($$ select _set_og('73000000-0000-0000-0000-0000000000a5') $$, '42501', null,
  'anon cannot write entity_seo.og_media_id');
select throws_ok($$ select _set_default('73000000-0000-0000-0000-0000000000a5') $$, '42501', null,
  'anon cannot write seo_defaults.default_og_media_id');

set local role authenticated;
select _claims('content_creator', _tid());
select is(_set_og('73000000-0000-0000-0000-0000000000a5'), 0,
  'content_creator cannot set a share image (its view access writes nothing)');
select is(_set_default('73000000-0000-0000-0000-0000000000a5'), 0,
  'content_creator cannot set the default share image');

select _claims('developer', _tid());
select is(_set_og('73000000-0000-0000-0000-0000000000a5'), 0,
  'developer cannot set a share image');
select is(_set_default('73000000-0000-0000-0000-0000000000a5'), 0,
  'developer cannot set the default share image');

select _claims('admin', '73000000-0000-0000-0000-000000000002');
select is(_set_og('73000000-0000-0000-0000-0000000000a5'), 0,
  'other_tenant: an admin of another tenant changes no launch-tenant SEO row');

select _claims('seo', _tid());
select is(_set_og('73000000-0000-0000-0000-0000000000a5'), 1,
  'seo sets a share image from its own tenant''s library');
select is(_set_default('73000000-0000-0000-0000-0000000000a5'), 1,
  'seo sets the default share image from its own tenant''s library');
select throws_ok($$ select _set_og('73000000-0000-0000-0000-0000000000b1') $$, '23503', null,
  'seo cannot point a share image at another tenant''s asset (composite key)');
select throws_ok($$ select _set_default('73000000-0000-0000-0000-0000000000b1') $$, '23503', null,
  'seo cannot point the default share image at another tenant''s asset');
select throws_ok($$ select _set_og('73000000-0000-0000-0000-0000000000ff') $$, '23503', null,
  'a share image must be an asset that exists');

select _claims('admin', _tid());
select is(_set_og('73000000-0000-0000-0000-0000000000a1'), 1,
  'admin sets a share image');
select is(_set_default('73000000-0000-0000-0000-0000000000a3'), 1,
  'admin sets the default share image');

-- ── 28–32. media_usage v5 ─────────────────────────────────────────────────────────────────
select ok(exists (select 1 from public.media_usage('73000000-0000-0000-0000-0000000000a1') u
                   where u.entity_type = 'entity_seo'
                     and u.entity_id = '73000000-0000-0000-0000-0000000000c1'
                     and u.label = 'service: pgtap-seo-pub' and not u.pending),
  'media_usage lists a share image as the page it describes (entity_seo, the target, "service: slug")');
select ok(exists (select 1 from public.media_usage('73000000-0000-0000-0000-0000000000a3') u
                   where u.entity_type = 'seo_defaults' and u.entity_id = app.default_tenant_id()
                     and u.label = 'site default' and not u.pending),
  'media_usage lists the default share image (seo_defaults, the tenant, "site default")');
select _claims('seo', _tid());
select ok(exists (select 1 from public.media_usage('73000000-0000-0000-0000-0000000000a3') u
                   where u.entity_type = 'seo_defaults'),
  'seo (media meta) sees where a share image is used');
select _claims('admin', '73000000-0000-0000-0000-000000000002');
select is((select count(*) from public.media_usage('73000000-0000-0000-0000-0000000000a1'))::int, 0,
  'other_tenant: another tenant''s admin sees no launch-tenant usage');
set local role anon;
select _claims(null, null);
select throws_ok($$ select * from public.media_usage('73000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'anon cannot execute media_usage');

-- ── 33–34. A share image in use cannot be hard-deleted ────────────────────────────────────
set local role authenticated;
select _claims('admin', _tid());
select ok(_delete_refused('73000000-0000-0000-0000-0000000000a1'),
  'admin cannot hard-delete a picture an SEO row uses as its share image');
select ok(_delete_refused('73000000-0000-0000-0000-0000000000a3'),
  'admin cannot hard-delete the default share image');

-- ── 35–37. The registry and the recursion rule ────────────────────────────────────────────
reset role;
select ok((select 'og_media_id' = any (columns) from app.release_entities where entity_type = 'entity_seo'),
  'the release registry stages entity_seo.og_media_id');
select ok((select 'default_og_media_id' = any (columns) from app.release_entities where entity_type = 'seo_defaults'),
  'the release registry stages seo_defaults.default_og_media_id');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename in ('entity_seo', 'seo_defaults')
              and (coalesce(qual, '') ~ 'media_assets' or coalesce(with_check, '') ~ 'media_assets'))::int,
  0, 'no policy on entity_seo or seo_defaults reads media_assets (the recursion rule)');

select * from finish();
rollback;
