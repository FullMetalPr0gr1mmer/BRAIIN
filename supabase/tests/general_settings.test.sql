-- pgTAP: General settings v2 and maintenance v2 (0099, Admin v2 U9). Run with `supabase test db`.
--
--   • site_profile v2: the new columns, their CHECKs (each 23514), the icon keys (another
--     tenant's media is 23503; a picture in use cannot be hard-deleted) and the icon shape
--     (square, `storage`, at least 512 px: 23514 naming the column's constraint).
--   • who writes: Admin and Developer of the tenant, through RLS and the RESTRICTIVE live
--     check; Content Creator and SEO filter to no row (UPDATE) or are refused (INSERT);
--     another tenant's Admin reads and writes nothing; anon reads the launch tenant's public
--     identity and writes nothing; four stale tokens (demoted, deactivated, locked, moved to
--     another tenant) write nothing to site_profile or site_settings, the maintenance switch
--     included (U9b: the route writes the row before KV, so this gates the edge too).
--   • site_settings.timezone: the default, the closed list, who writes and reads it, the
--     copy from crm_settings; app.studio_time_zone's tenant fence; public.studio_time_zone(),
--     the Worker's door, which answers every member its own tenant's zone, Sales included
--     (Sales reads no site_settings row, 0097).
--   • media_assets_public_read's icon branch, media_usage v6's icon rows.
--   • the exact policy sets, the helper, the grants (has and has-not).
--   • the four guides 0099 puts, in every tenant (two of them one sentence each: the busiest
--     hours and the uptime days follow the studio's zone, not Riyadh).

begin;
select plan(80);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- Tenants created AFTER the launch tenant, so the anon fence keeps resolving to the launch
-- tenant and never to these.
insert into public.tenants (id, name) values
  ('75000000-0000-0000-0000-00000000000a', 'GenA'),
  ('75000000-0000-0000-0000-00000000000b', 'GenB'),
  ('75000000-0000-0000-0000-00000000000c', 'GenC');

insert into auth.users (id, email) values
  ('75000000-0000-0000-0000-0000000000a1', 'u9-admin@example.test'),
  ('75000000-0000-0000-0000-0000000000c1', 'u9-creator@example.test'),
  ('75000000-0000-0000-0000-0000000000e1', 'u9-seo@example.test'),
  ('75000000-0000-0000-0000-0000000000d1', 'u9-developer@example.test'),
  ('75000000-0000-0000-0000-0000000000b1', 'u9-other-admin@example.test'),
  ('75000000-0000-0000-0000-0000000000d2', 'u9-demoted@example.test'),
  ('75000000-0000-0000-0000-0000000000d3', 'u9-inactive@example.test'),
  ('75000000-0000-0000-0000-0000000000d4', 'u9-locked@example.test'),
  ('75000000-0000-0000-0000-000000000051', 'u9-sales@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('75000000-0000-0000-0000-0000000000a1', '75000000-0000-0000-0000-00000000000a', 'admin', true, null),
  ('75000000-0000-0000-0000-0000000000c1', '75000000-0000-0000-0000-00000000000a', 'content_creator', true, null),
  ('75000000-0000-0000-0000-0000000000e1', '75000000-0000-0000-0000-00000000000a', 'seo', true, null),
  ('75000000-0000-0000-0000-0000000000d1', '75000000-0000-0000-0000-00000000000a', 'developer', true, null),
  ('75000000-0000-0000-0000-0000000000b1', '75000000-0000-0000-0000-00000000000b', 'admin', true, null),
  -- Stale: each token below still says developer of tenant A.
  ('75000000-0000-0000-0000-0000000000d2', '75000000-0000-0000-0000-00000000000a', 'seo', true, null),
  ('75000000-0000-0000-0000-0000000000d3', '75000000-0000-0000-0000-00000000000a', 'developer', false, null),
  ('75000000-0000-0000-0000-0000000000d4', '75000000-0000-0000-0000-00000000000a', 'developer', true,
   now() + interval '10 minutes'),
  ('75000000-0000-0000-0000-000000000051', '75000000-0000-0000-0000-00000000000a', 'sales', true, null);

-- Media: tenant A's square 512 upload, a non-square one, a small square one, an external
-- square one; tenant B's square upload; the launch tenant's icon and an unreferenced upload.
insert into public.media_assets (id, tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes) values
  ('75000000-0000-0000-0000-0000000000f1', '75000000-0000-0000-0000-00000000000a', 'image', 'storage',
   '75000000-0000-0000-0000-00000000000a/75000000-0000-0000-0000-0000000000f1_512x512.webp', 512, 512, 'image/webp', 1000),
  ('75000000-0000-0000-0000-0000000000f2', '75000000-0000-0000-0000-00000000000a', 'image', 'storage',
   '75000000-0000-0000-0000-00000000000a/75000000-0000-0000-0000-0000000000f2_600x400.webp', 600, 400, 'image/webp', 1000),
  ('75000000-0000-0000-0000-0000000000f3', '75000000-0000-0000-0000-00000000000a', 'image', 'storage',
   '75000000-0000-0000-0000-00000000000a/75000000-0000-0000-0000-0000000000f3_256x256.webp', 256, 256, 'image/webp', 1000),
  ('75000000-0000-0000-0000-0000000000fb', '75000000-0000-0000-0000-00000000000b', 'image', 'storage',
   '75000000-0000-0000-0000-00000000000b/75000000-0000-0000-0000-0000000000fb_512x512.webp', 512, 512, 'image/webp', 1000);
insert into public.media_assets (id, tenant_id, kind, provider, storage_path, width, height) values
  ('75000000-0000-0000-0000-0000000000f4', '75000000-0000-0000-0000-00000000000a', 'image', 'external',
   'https://example.com/icon.png', 600, 600);
insert into public.media_assets (id, tenant_id, kind, provider, storage_path, width, height, mime_type, size_bytes)
select v.id::uuid, app.default_tenant_id(), 'image', 'storage',
       app.default_tenant_id()::text || '/' || v.id || '_1024x1024.webp', 1024, 1024, 'image/webp', 1000
  from (values ('75000000-0000-0000-0000-0000000000e7'), ('75000000-0000-0000-0000-0000000000e8')) as v(id);

insert into public.site_profile (tenant_id, brand_name, contact_email, location) values
  ('75000000-0000-0000-0000-00000000000a', '{"en":"Gen A","ar":"أ"}', 'a@example.test', '{"en":"Jeddah","ar":"جدة"}'),
  ('75000000-0000-0000-0000-00000000000b', '{"en":"Gen B","ar":"ب"}', 'b@example.test', '{"en":"Riyadh","ar":"الرياض"}');
update public.site_profile set app_icon_media_id = '75000000-0000-0000-0000-0000000000fb'
 where tenant_id = '75000000-0000-0000-0000-00000000000b';
-- The launch tenant's profile (the one anon reads) with an icon.
insert into public.site_profile (tenant_id, brand_name, contact_email, location)
values (app.default_tenant_id(), '{"en":"Launch","ar":"ل"}', 'launch@example.test', '{"en":"Jeddah","ar":"جدة"}')
on conflict (tenant_id) do nothing;
update public.site_profile set favicon_media_id = '75000000-0000-0000-0000-0000000000e7'
 where tenant_id = app.default_tenant_id();

insert into public.site_settings (tenant_id) values
  ('75000000-0000-0000-0000-00000000000a'),
  ('75000000-0000-0000-0000-00000000000b');
update public.site_settings set timezone = 'Asia/Kuwait'
 where tenant_id = '75000000-0000-0000-0000-00000000000b';

-- The token of a profile: its sub, the role it carries and the tenant it names.
create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true)
$$;
create function _a() returns text language sql as $$ select '75000000-0000-0000-0000-00000000000a' $$;
create function _b() returns text language sql as $$ select '75000000-0000-0000-0000-00000000000b' $$;
-- Rows a statement touched, as the CURRENT role.
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;
create function _visible(p_id text) returns boolean language sql as $$
  select exists (select 1 from public.media_assets where id = p_id::uuid)
$$;
-- A hard delete refused by a foreign key: RESTRICT answers 23001 on the PostgreSQL versions
-- that name it, 23503 on older ones; either is the key refusing (seo_share_images' helper).
create function _delete_refused(p_id text) returns boolean language plpgsql as $$
begin
  delete from public.media_assets where id = p_id::uuid;
  return false;
exception when foreign_key_violation or restrict_violation then
  return true;
end $$;
grant execute on function _as(text, text, text), _a(), _b(), _rows(text), _visible(text)
  to anon, authenticated, service_role;

-- ── Structure, the helper and the grants ────────────────────────────────
select is(
  (select string_agg(format('%s %s%s', attname, format_type(atttypid, atttypmod),
                            case when attnotnull then ' not null' else '' end), ', ' order by attname)
     from pg_attribute
    where attrelid = 'public.site_profile'::regclass and not attisdropped
      and attname in ('tagline', 'phone_e164', 'phone_display', 'map_url', 'favicon_media_id',
                      'app_icon_media_id', 'footer_copyright', 'footer_style',
                      'footer_show_email', 'footer_show_social')),
  'app_icon_media_id uuid, favicon_media_id uuid, footer_copyright jsonb, '
  'footer_show_email boolean not null, footer_show_social boolean not null, '
  'footer_style text not null, map_url text, phone_display text, phone_e164 text, tagline jsonb',
  'site_profile carries the ten v2 columns, the footer settings defaulted and not null');
select is(
  (select format('%s/%s/%s', footer_style, footer_show_email, footer_show_social)
     from public.site_profile where tenant_id = _a()::uuid),
  'light/t/f', 'a profile written without them gets today''s footer (light, email, no social)');
select is(
  (select string_agg(tgname, ' < ' order by tgname) from pg_trigger
    where tgrelid = 'public.site_profile'::regclass and not tgisinternal
      and (tgtype & 2) = 2),
  'site_profile__release_guard < site_profile_guard < site_profile_icons < site_profile_updated_at < site_profile_updater < site_profile_version',
  'the BEFORE triggers fire guard, applications, icons, then the stamps');
select ok(
  app.role_general_settings('admin') and app.role_general_settings('developer')
    and not app.role_general_settings('content_creator') and not app.role_general_settings('seo')
    and not app.role_general_settings('anon') and not app.role_general_settings(null),
  'app.role_general_settings is settings.general: Admin and Developer');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'site_profile'),
  'site_profile_insert INSERT PERMISSIVE {public}, '
  'site_profile_live_insert INSERT RESTRICTIVE {authenticated}, '
  'site_profile_live_update UPDATE RESTRICTIVE {authenticated}, '
  'site_profile_read SELECT PERMISSIVE {public}, '
  'site_profile_update UPDATE PERMISSIVE {public}',
  'site_profile carries 0019''s three policies and the two RESTRICTIVE live writes');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'site_settings'),
  'site_settings_live_insert INSERT RESTRICTIVE {authenticated}, '
  'site_settings_live_update UPDATE RESTRICTIVE {authenticated}, '
  'site_settings_staff_read SELECT PERMISSIVE {public}, '
  'site_settings_write ALL PERMISSIVE {public}',
  'site_settings carries 0001''s two policies and the two RESTRICTIVE live writes');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('site_profile', 'site_settings')
      and permissive = 'RESTRICTIVE'
      and coalesce(qual, with_check) ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_general_settings\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$'
      and coalesce(with_check, qual) = coalesce(qual, with_check)),
  4,
  'each live policy is the tenant predicate first, then settings.general on the live role');
-- One privilege per call: has_table_privilege(r, t, 'select, insert, update') is true when ANY
-- of the listed privileges is held, so it could not fail on a missing INSERT or UPDATE.
select ok(
  has_table_privilege('anon', 'public.site_profile', 'select')
  and not has_table_privilege('anon', 'public.site_profile', 'insert')
  and not has_table_privilege('anon', 'public.site_profile', 'update')
  and not has_table_privilege('anon', 'public.site_settings', 'select')
  and (select bool_and(has_table_privilege(r.role::name, t.name, p.priv))
         from unnest(array['authenticated', 'service_role']) as r(role)
         cross join unnest(array['public.site_profile', 'public.site_settings']) as t(name)
         cross join unnest(array['select', 'insert', 'update']) as p(priv)),
  'grants: anon reads site_profile only; staff and the service role read, insert and update both');
select is(
  (select count(*)::int
     from unnest(array['public.site_profile', 'public.site_settings']) as t(name)
     cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(role)
     cross join unnest(array['delete', 'truncate', 'references', 'trigger']) as p(priv)
    where has_table_privilege(r.role::name, t.name, p.priv)),
  0,
  'no API role deletes, truncates, references or triggers on either table');

-- ── Admin and Developer write the new columns; Content Creator and SEO do not ──
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000a1', 'admin', _a());
select is(_rows($$ update public.site_profile
                      set tagline = '{"en":"From the brain to the real world","ar":"من الفكرة إلى الواقع"}',
                          phone_e164 = '+966500000001', phone_display = '+966 50 000 0001',
                          map_url = 'https://maps.app.goo.gl/abc123',
                          favicon_media_id = '75000000-0000-0000-0000-0000000000f1',
                          footer_copyright = '{"en":"© {year} {brand}.","ar":"© {year} {brand}."}',
                          footer_style = 'dark', footer_show_email = false, footer_show_social = true
                    where tenant_id = _a()::uuid $$),
  1, 'admin updates every new column of its tenant');
select _as('75000000-0000-0000-0000-0000000000d1', 'developer', _a());
select is(_rows($$ update public.site_profile
                      set app_icon_media_id = '75000000-0000-0000-0000-0000000000f1', footer_style = 'light'
                    where tenant_id = _a()::uuid $$),
  1, 'developer updates them too (§5 General settings)');
reset role;
select is(
  (select format('%s|%s|%s|%s|%s|%s|%s|%s|%s', tagline ->> 'en', phone_e164, phone_display, map_url,
                 favicon_media_id, app_icon_media_id, footer_style, footer_show_email, footer_show_social)
     from public.site_profile where tenant_id = _a()::uuid),
  'From the brain to the real world|+966500000001|+966 50 000 0001|https://maps.app.goo.gl/abc123|'
  '75000000-0000-0000-0000-0000000000f1|75000000-0000-0000-0000-0000000000f1|light|f|t',
  'both writes stuck, re-read as the migration role');
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000c1', 'content_creator', _a());
select is(_rows($$ update public.site_profile set tagline = null where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set timezone = 'UTC' where tenant_id = _a()::uuid $$),
  0, 'content_creator updates neither row (0 rows)');
select _as('75000000-0000-0000-0000-0000000000e1', 'seo', _a());
select is(_rows($$ update public.site_profile set tagline = null where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set timezone = 'UTC' where tenant_id = _a()::uuid $$),
  0, 'seo updates neither row (0 rows)');

-- ── Inserts: a first save is an INSERT ─────────────────────────────────
select _as('75000000-0000-0000-0000-0000000000c1', 'content_creator', _a());
select throws_ok(
  $$ insert into public.site_settings (tenant_id) values (_a()::uuid) $$,
  '42501', null, 'content_creator cannot create a settings row, in its own tenant either');
select _as('75000000-0000-0000-0000-0000000000e1', 'seo', _a());
select throws_ok(
  $$ insert into public.site_profile (tenant_id, brand_name, contact_email, location)
     values (_a()::uuid, '{"en":"X","ar":"س"}', 'x@example.test', '{"en":"J","ar":"ج"}') $$,
  '42501', null, 'seo cannot create a profile');
select _as('75000000-0000-0000-0000-0000000000b1', 'admin', _b());
select throws_ok(
  $$ insert into public.site_settings (tenant_id) values ('75000000-0000-0000-0000-00000000000c') $$,
  '42501', null, 'another tenant''s admin cannot create a row for a third tenant');

-- ── Another tenant's admin ─────────────────────────────────────────────
select is((select count(*)::int from public.site_profile where tenant_id = _a()::uuid)
        + (select count(*)::int from public.site_settings where tenant_id = _a()::uuid),
  0, 'other_tenant reads no row of tenant A');
select is(_rows($$ update public.site_profile set footer_style = 'dark' $$)
        + _rows($$ update public.site_settings set timezone = 'UTC' $$),
  2, 'other_tenant''s unfiltered update touches only its own two rows');
reset role;
select is(
  (select format('%s/%s', p.footer_style, s.timezone)
     from public.site_profile p join public.site_settings s using (tenant_id)
    where tenant_id = _a()::uuid),
  'light/Asia/Riyadh', 'tenant A''s rows are unchanged by it');
update public.site_settings set timezone = 'Asia/Kuwait' where tenant_id = _b()::uuid;
update public.site_profile set footer_style = 'light' where tenant_id = _b()::uuid;
select ok(
  not exists (select 1 from public.site_profile where tenant_id = _a()::uuid and footer_style = 'dark'),
  'and none of it landed in tenant A');

-- ── Stale tokens write nothing, the maintenance switch included ─────────
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000d2', 'developer', _a());
select is(_rows($$ update public.site_profile set footer_style = 'dark' where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set maintenance = '{"active":true,"allowlist":[]}' where tenant_id = _a()::uuid $$),
  0, 'a developer token whose profile is now seo writes neither row');
-- The stale inserts name the token's OWN tenant (A): a third tenant's row is refused by the
-- permissive policy's tenant predicate already, so only an insert into A reaches the live
-- check. RLS's WITH CHECK runs before the unique key, so the live policy answers 42501; were
-- it gone, the insert would pass RLS and stop at the key (23505), and these would fail.
select throws_ok(
  $$ insert into public.site_settings (tenant_id) values (_a()::uuid) $$,
  '42501', null, 'nor creates one (the live check, not the tenant predicate)');
select _as('75000000-0000-0000-0000-0000000000d3', 'developer', _a());
select is(_rows($$ update public.site_profile set footer_style = 'dark' where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set maintenance = '{"active":true,"allowlist":[]}' where tenant_id = _a()::uuid $$),
  0, 'a deactivated developer writes neither row');
select throws_ok(
  $$ insert into public.site_profile (tenant_id, brand_name, contact_email, location)
     values (_a()::uuid, '{"en":"X","ar":"س"}', 'x@example.test', '{"en":"J","ar":"ج"}') $$,
  '42501', null, 'nor creates a profile in its own tenant');
select _as('75000000-0000-0000-0000-0000000000d4', 'developer', _a());
select is(_rows($$ update public.site_profile set footer_style = 'dark' where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set retention = '{"raw_telemetry_days":1}' where tenant_id = _a()::uuid $$),
  0, 'a locked developer writes neither row (no purge by a shortened retention)');
select throws_ok(
  $$ insert into public.site_settings (tenant_id) values (_a()::uuid) $$,
  '42501', null, 'nor creates one in its own tenant');
-- Moved: tenant B's admin, carrying a token that names tenant A.
select _as('75000000-0000-0000-0000-0000000000b1', 'admin', _a());
select is(_rows($$ update public.site_profile set footer_style = 'dark' where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set maintenance = '{"active":true,"allowlist":[]}' where tenant_id = _a()::uuid $$),
  0, 'a token naming another tenant than its profile''s writes neither row');
reset role;
select is(
  (select format('%s/%s/%s', p.footer_style, s.maintenance ->> 'active', s.retention ->> 'raw_telemetry_days')
     from public.site_profile p join public.site_settings s using (tenant_id)
    where tenant_id = _a()::uuid),
  'light/false/90', 'nothing a stale token tried stuck');

-- ── The maintenance switch: Admin and Developer (U9b) ───────────────────
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000d1', 'developer', _a());
select is(_rows($$ update public.site_settings
                      set maintenance = '{"v":2,"active":true,"allowlist":[],"staffBypass":true}'
                    where tenant_id = _a()::uuid $$),
  1, 'a live developer switches maintenance on (maintenance.manage)');
select _as('75000000-0000-0000-0000-0000000000a1', 'admin', _a());
select is(_rows($$ update public.site_settings
                      set maintenance = '{"v":2,"active":false,"allowlist":[],"staffBypass":true}'
                    where tenant_id = _a()::uuid $$),
  1, 'a live admin switches it off');

-- ── The CHECKs ──────────────────────────────────────────────────────────
select throws_ok($$ update public.site_profile set phone_e164 = '+012' where tenant_id = _a()::uuid $$,
  '23514', null, 'a phone number that is not E.164 is refused');
select throws_ok($$ update public.site_profile set phone_e164 = null, phone_display = '050' where tenant_id = _a()::uuid $$,
  '23514', null, 'a displayed phone without its number is refused');
select throws_ok($$ update public.site_profile set map_url = 'http://maps.app.goo.gl/x' where tenant_id = _a()::uuid $$,
  '23514', null, 'an http map link is refused');
select throws_ok($$ update public.site_profile set map_url = 'javascript:alert(1)' where tenant_id = _a()::uuid $$,
  '23514', null, 'a javascript: map link is refused');
select throws_ok($$ update public.site_profile set tagline = '{"en":"Only English"}' where tenant_id = _a()::uuid $$,
  '23514', null, 'a tagline in one language only is refused');
select throws_ok($$ update public.site_profile set footer_copyright = '{"en":"© {evil}","ar":"©"}' where tenant_id = _a()::uuid $$,
  '23514', null, 'a copyright with an unknown placeholder is refused');
select throws_ok($$ update public.site_profile set footer_copyright = '{"en":"© {year}}","ar":"©"}' where tenant_id = _a()::uuid $$,
  '23514', null, 'a copyright with a stray brace is refused');
select throws_ok($$ update public.site_profile set footer_copyright = '{"en":"© {year}"}' where tenant_id = _a()::uuid $$,
  '23514', null, 'a copyright in one language only is refused');
select throws_ok($$ update public.site_profile set footer_style = 'blue' where tenant_id = _a()::uuid $$,
  '23514', null, 'a footer style other than light or dark is refused');

-- ── The icons ───────────────────────────────────────────────────────────
select throws_ok($$ update public.site_profile set favicon_media_id = '75000000-0000-0000-0000-0000000000fb' where tenant_id = _a()::uuid $$,
  '23503', null, 'another tenant''s picture is refused by the key');
select throws_ok($$ update public.site_profile set favicon_media_id = '75000000-0000-0000-0000-0000000000f2' where tenant_id = _a()::uuid $$,
  '23514', 'new row for relation "site_profile" violates check constraint "site_profile_favicon_square"',
  'a picture that is not square is refused, naming the favicon');
select throws_ok($$ update public.site_profile set app_icon_media_id = '75000000-0000-0000-0000-0000000000f3' where tenant_id = _a()::uuid $$,
  '23514', 'new row for relation "site_profile" violates check constraint "site_profile_app_icon_square"',
  'a square picture under 512 px is refused, naming the app icon');
select throws_ok($$ update public.site_profile set app_icon_media_id = '75000000-0000-0000-0000-0000000000f4' where tenant_id = _a()::uuid $$,
  '23514', null, 'an external picture is refused, square or not');
select lives_ok($$ update public.site_profile set favicon_media_id = null, app_icon_media_id = null where tenant_id = _a()::uuid $$,
  'clearing both icons is allowed');
reset role;
update public.site_profile set favicon_media_id = '75000000-0000-0000-0000-0000000000f1' where tenant_id = _a()::uuid;
select ok(_delete_refused('75000000-0000-0000-0000-0000000000f1'),
  'a picture in use as an icon cannot be hard-deleted (RESTRICT)');

-- ── media_usage v6 lists the icon ───────────────────────────────────────
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000a1', 'admin', _a());
select is(
  (select string_agg(format('%s %s %s %s', entity_type, entity_id, label, pending), ', ')
     from public.media_usage('75000000-0000-0000-0000-0000000000f1')),
  'site_profile 75000000-0000-0000-0000-00000000000a favicon f',
  'media_usage names the profile, as "favicon", not pending');
select _as('75000000-0000-0000-0000-0000000000b1', 'admin', _b());
select is((select count(*)::int from public.media_usage('75000000-0000-0000-0000-0000000000f1')), 0,
  'another tenant''s admin sees no use of it');

-- ── What anon reads ─────────────────────────────────────────────────────
set local role anon;
select _as(null, null, null);
select ok(_visible('75000000-0000-0000-0000-0000000000e7'),
  'anon reads the launch tenant''s favicon through media_assets_public_read');
select ok(not _visible('75000000-0000-0000-0000-0000000000e8'),
  'anon does not read an upload nothing references');
select ok(not _visible('75000000-0000-0000-0000-0000000000fb'),
  'anon does not read another tenant''s icon (the fence)');
select is(
  (select format('%s/%s/%s', count(*), max(tagline::text) is null, bool_and(favicon_media_id is not null))
     from public.site_profile),
  '1/t/t', 'anon reads only the launch tenant''s profile, its new columns included');
select throws_ok($$ update public.site_profile set footer_style = 'dark' $$, '42501', null,
  'anon cannot write site_profile');
select throws_ok($$ select timezone from public.site_settings $$, '42501', null,
  'anon cannot read site_settings at all');

-- ── The time zone ─────────────────────────────────────────────────────────
reset role;
insert into public.site_settings (tenant_id) values ('75000000-0000-0000-0000-00000000000c');
select is((select timezone from public.site_settings where tenant_id = '75000000-0000-0000-0000-00000000000c'),
  'Asia/Riyadh', 'a new settings row is in Riyadh time');
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000a1', 'admin', _a());
select throws_ok($$ update public.site_settings set timezone = 'Europe/Paris' where tenant_id = _a()::uuid $$,
  '23514', null, 'a zone outside the closed list is refused');
select is(_rows($$ update public.site_settings set timezone = 'Asia/Dubai' where tenant_id = _a()::uuid $$),
  1, 'admin sets the studio''s zone');
select _as('75000000-0000-0000-0000-0000000000d1', 'developer', _a());
select is(_rows($$ update public.site_settings set timezone = 'Asia/Dubai' where tenant_id = _a()::uuid $$),
  1, 'developer sets it too');
select _as('75000000-0000-0000-0000-0000000000c1', 'content_creator', _a());
select is((select timezone from public.site_settings where tenant_id = _a()::uuid),
  'Asia/Dubai', 'content_creator reads it (staff read, unchanged)');
select _as('75000000-0000-0000-0000-0000000000e1', 'seo', _a());
select is((select timezone from public.site_settings where tenant_id = _a()::uuid),
  'Asia/Dubai', 'seo reads it');
select _as('75000000-0000-0000-0000-0000000000b1', 'admin', _b());
select is((select count(*)::int from public.site_settings where tenant_id = _a()::uuid), 0,
  'other_tenant does not read it');
reset role;
select is(
  (select count(*)::int from public.site_settings s join public.crm_settings c using (tenant_id)
    where s.timezone is distinct from c.timezone
      and s.tenant_id not in (select id from public.tenants where name like 'Gen%')),
  0, 'every row the migration found took its tenant''s crm_settings zone');

-- ── app.studio_time_zone ────────────────────────────────────────────────
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000c1', 'content_creator', _a());
select is(app.studio_time_zone(_a()::uuid), 'Asia/Dubai', 'the own tenant''s zone, for any staff role');
select is(app.studio_time_zone(_b()::uuid), 'Asia/Riyadh',
  'another tenant''s id answers the default, never that tenant''s zone (Kuwait)');
set local role anon;
select throws_ok($$ select app.studio_time_zone('75000000-0000-0000-0000-00000000000a') $$,
  '42501', null, 'anon cannot call it');
set local role service_role;
select _as(null, null, null);
select is(app.studio_time_zone(_b()::uuid), 'Asia/Kuwait', 'the service role reads any tenant''s zone');

-- ── public.studio_time_zone(): the Worker's door, for every member ──────
set local role authenticated;
select _as('75000000-0000-0000-0000-000000000051', 'sales', _a());
select is((select count(*)::int from public.site_settings), 0,
  'sales reads no site_settings row (site_settings_staff_read is app.is_staff(), unchanged by 0097)');
select is(public.studio_time_zone(), 'Asia/Dubai',
  'public.studio_time_zone() answers sales its tenant''s zone all the same');
select is(_rows($$ update public.site_profile set tagline = null where tenant_id = _a()::uuid $$)
        + _rows($$ update public.site_settings set timezone = 'UTC' where tenant_id = _a()::uuid $$),
  0, 'sales updates neither row (0 rows)');
select _as('75000000-0000-0000-0000-0000000000e1', 'seo', _a());
select is(public.studio_time_zone(), 'Asia/Dubai', 'and every CMS role its tenant''s zone (seo)');
select _as('75000000-0000-0000-0000-0000000000b1', 'admin', _b());
select is(public.studio_time_zone(), 'Asia/Kuwait',
  'other_tenant gets its own tenant''s zone, never tenant A''s');
set local role anon;
select _as(null, null, null);
select throws_ok($$ select public.studio_time_zone() $$, '42501', null, 'anon cannot call it');
reset role;
select ok(
  has_function_privilege('authenticated', 'public.studio_time_zone()', 'execute')
  and not has_function_privilege('anon', 'public.studio_time_zone()', 'execute')
  and not has_function_privilege('service_role', 'public.studio_time_zone()', 'execute')
  and not has_function_privilege('public', 'public.studio_time_zone()', 'execute'),
  'public.studio_time_zone() is executable by authenticated only');

-- ── The guides ──────────────────────────────────────────────────────────
reset role;
select is(
  (select count(*)::int from public.tenants t
    where not exists (select 1 from public.help_articles h
                       where h.tenant_id = t.id and h.slug = 'general-settings'
                         and h.caps = array['settings.general'] and h.screens = array['/admin/settings'])),
  0, 'every tenant holds general-settings, for settings.general, on /admin/settings');
select is(
  (select count(*)::int from public.tenants t
    where not exists (select 1 from public.help_articles h
                       where h.tenant_id = t.id and h.slug = 'maintenance-mode'
                         and h.caps = array['maintenance.manage']
                         and h.body::text ~ 'Back on ends maintenance by itself')),
  0, 'every tenant holds the rewritten maintenance-mode');
select is(
  (select count(*)::int from public.tenants t
    where not exists (select 1 from public.help_articles h
                       where h.tenant_id = t.id and h.slug = 'website-stats'
                         and h.body::text ~ 'busiest hours of the day in the studio''s time zone')
       or not exists (select 1 from public.help_articles h
                       where h.tenant_id = t.id and h.slug = 'site-health-and-logs'
                         and h.body::text ~ 'Days follow the studio''s time zone')
       or exists (select 1 from public.help_articles h
                   where h.tenant_id = t.id and h.slug in ('website-stats', 'site-health-and-logs')
                     and h.body::text ~ '(hours of the day in Riyadh|midnight to midnight in Riyadh)')),
  0, 'every tenant''s website-stats and site-health-and-logs name the studio''s zone, not Riyadh');
select is((select sort_order from app.help_guide_catalog where slug = 'general-settings'), 98,
  'general-settings sits just before maintenance-mode');
set local role authenticated;
select _as('75000000-0000-0000-0000-0000000000a1', 'admin', _a());
select is((select count(*)::int from public.help_articles where slug in ('general-settings', 'maintenance-mode')),
  2, 'staff read both guides of their own tenant');
select _as('75000000-0000-0000-0000-0000000000b1', 'admin', _b());
select is((select count(*)::int from public.help_articles
            where tenant_id = _a()::uuid and slug in ('general-settings', 'maintenance-mode')),
  0, 'other_tenant reads none of tenant A''s');
set local role anon;
select _as(null, null, null);
select throws_ok($$ select 1 from public.help_articles where slug = 'general-settings' $$,
  '42501', null, 'anon reads no guide');

select * from finish();
rollback;
