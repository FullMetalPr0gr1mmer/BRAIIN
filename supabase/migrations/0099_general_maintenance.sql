-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0099 — General settings v2 and maintenance v2 (Admin v2 U9, the folded U9a + U9b PR).
-- Forward-only and EXPAND only: ten nullable or defaulted columns, their CHECKs, two composite
-- foreign keys and two indexes on site_profile, one invoker trigger, one closed-list column on
-- site_settings (copied from crm_settings, the only data written), one capability helper, four
-- RESTRICTIVE live-write policies, the two tables' grants stated, one definer reader, one
-- policy and one function restated, one registry row restated and four help guides put. The
-- number is a placeholder: it is assigned at merge (scripts/renumber-migration.mjs). Depends on
-- 0001, 0009, 0011, 0019, 0033 (app.live_role), 0035 (crm_settings), 0038 (the registry),
-- 0045, 0066, 0069 (the help catalog's put) and 0073 (media_assets_tenant_id_id, the policy
-- and media_usage v5 whose texts this file extends).
--
-- The design is docs/admin-v2/ui.md "General (/admin/settings; AV-18)", §6 and §10, and
-- docs/admin-v2/verification.md's maintenance claims, as the Wave 3 U9 brief decides them
-- (D1-D17); the departures are in docs/admin-v2/as-built/U9.md.
--
--   1. media_assets_tenant_id_id: U10's (0073) UNIQUE (tenant_id, id), reused for the icons.
--      Guarded, so this file applies whether or not 0073 ran first.
--   2. site_profile v2 (the public identity, staged once releases switch on): tagline
--      (bilingual, both halves or none), phone (E.164) and its displayed form, a map link
--      (https; the host allow-list is the Worker's Zod, as for socials), the favicon and the
--      app icon (composite keys to the tenant's own media, ON DELETE RESTRICT, MATCH SIMPLE:
--      a null id is not checked and another tenant's id is 23503), and the four footer
--      settings E6 edits and renders (a copyright template whose only braces are {year},
--      {brand} and {place}; light or dark; show the email; show the social icons), each
--      defaulting to today's footer, so no page changes until E6.
--   3. app.tg_site_profile_icons: a set icon must be a square `storage` image of at least
--      512 px. SECURITY INVOKER, so it reads media under the writer's own RLS (staff read
--      their tenant's media) and under apply_release as the publisher; an id it cannot see is
--      left to the foreign key (23503), a visible one of the wrong shape is 23514 naming
--      site_profile_favicon_square or site_profile_app_icon_square in the message, as
--      PostgreSQL names a CHECK, so the Worker maps it to the field.
--   4. site_settings.timezone: the studio's one time zone (immediate, P-3, so it is NOT on
--      the staged site_profile: deviations.md, U9), a closed list equal to crm_settings' and
--      to STUDIO_TIME_ZONES (packages/schemas/timeZones.ts; tests/lib/zone.spec.ts parses
--      both CHECKs). Every existing row takes its tenant's crm_settings.timezone; a tenant
--      with no row keeps the first-save semantics (H7) and the Riyadh default.
--      crm_settings.timezone is marked deprecated (C14 drops it).
--   5. app.role_general_settings(r): the one helper for settings.general (Admin, Developer),
--      held equal to ROLE_CAPS by tests/authz/sqlHelpers.spec.ts. maintenance.manage keeps
--      U14a's app.role_manages_visibility; the two capabilities share the site_settings row,
--      so tests/authz/sqlHelpers.spec.ts holds them to one role set.
--   6. RESTRICTIVE live writes on site_profile and site_settings (H10's pattern, 0050): a
--      token whose profile no longer matches it (demoted, deactivated, locked, moved) writes
--      nothing through PostgREST: an UPDATE filters to no row, an INSERT is 42501. The
--      maintenance route writes the row before KV, so this also gates the edge switch.
--   7. Grants stated under both Supabase regimes: revoke all, then exactly SELECT for anon on
--      site_profile, and SELECT, INSERT, UPDATE for authenticated and service_role on both.
--      No API role keeps DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN: until now the
--      bootstrap ALL left authenticated a DELETE on site_settings, which its FOR ALL policy
--      admitted for an Admin or Developer token (U10 found the same on seo_defaults).
--   8. app.studio_time_zone(p_tenant): the zone for SQL (C8 and C9a read it). DEFINER,
--      tenant-fenced: another tenant's id answers the Riyadh default, which reveals nothing.
--      And public.studio_time_zone(), its door for the Worker (PostgREST exposes only
--      `public`): INVOKER, the caller's own tenant, executable by authenticated only. The
--      admin reads the studio's clock through it for every member, because Sales (0097)
--      reads no site_settings row: site_settings_staff_read is app.is_staff(), the four CMS
--      roles, which 0097 leaves unchanged.
--   9. media_assets_public_read: 0073's text word for word, plus the icons. site_profile is
--      anon-readable and tenant-fenced by its own RLS, and NO policy on site_profile may read
--      media_assets (the recursion rule 0073 states; a postcondition holds it).
--  10. public.media_usage v6: v5 (0073) word for word, plus `site_profile` rows labelled
--      "favicon" and "app icon" (pending false), before v4's pending branch. Same four columns,
--      so the deployed Worker reads it as it reads v5 (as-built U9, rule 5).
--  11. The release registry's site_profile row restated (`do update`) with the ten columns
--      appended, so a release stages them like the rest. timezone is on site_settings and is
--      never in the registry; accepting_applications stays exempt.
--  12. Four guides through H11's catalog (0069): general-settings, new, at place 98 (just
--      before maintenance-mode; 45, 65, 75, 95 and 125 are taken), maintenance-mode rewritten
--      for maintenance v2, and one sentence each in website-stats (the busiest hours) and
--      site-health-and-logs (the uptime days), which said "Riyadh" of what now follows the
--      studio's zone. The literals are docs/admin-v2/guides/<slug>.json verbatim. No other
--      guide is touched.
--
-- Maintenance v2 itself needs no DDL: the switch, the copy, the background, the contact
-- buttons, "Back on", the date, the staff bypass and the IP allowlist are one JSON value
-- (site_settings.maintenance, the source of truth, and its KV snapshot `site:maintenance`),
-- validated by the Worker's Zod and read leniently by every reader; section 6 gates its
-- direct writes.
--
-- Production runs this as postgres (BYPASSRLS) on PostgreSQL 17; CI replays it on 15.
-- Postconditions at the end check both grant regimes (MAINTAIN only on 17).
--
-- CLAUDE.md §3 (Pillar 1, maintenance), §8 (Data model: General settings; Media; Admin v2
-- lanes, UI), §10 (the reconcile).
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: two live tables gain columns, constraints,
-- a trigger and policies, a policy on media_assets is replaced and a function restated, and a
-- statement that waits more than five seconds for a lock raises, so the push is retried later
-- rather than holding its place in the lock queue while the site's reads pile up behind it.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. media_assets (tenant_id, id) ══════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.media_assets'::regclass
                    and conname = 'media_assets_tenant_id_id') then
    alter table public.media_assets
      add constraint media_assets_tenant_id_id unique (tenant_id, id);
  end if;
end $$;

-- ═══ 2. site_profile v2 ════════════════════════════════════════════════════════════════════
alter table public.site_profile
  add column if not exists tagline jsonb,
  add column if not exists phone_e164 text,
  add column if not exists phone_display text,
  add column if not exists map_url text,
  add column if not exists favicon_media_id uuid,
  add column if not exists app_icon_media_id uuid,
  add column if not exists footer_copyright jsonb,
  add column if not exists footer_style text not null default 'light',
  add column if not exists footer_show_email boolean not null default true,
  add column if not exists footer_show_social boolean not null default false;

alter table public.site_profile drop constraint if exists site_profile_tagline_shape;
-- coalesce(…, false): a CHECK passes on NULL, and a missing half makes every test below it
-- NULL rather than false (0045's lesson).
alter table public.site_profile add constraint site_profile_tagline_shape check (
  tagline is null or coalesce((
    jsonb_typeof(tagline) = 'object'
    and jsonb_typeof(tagline -> 'en') = 'string'
    and jsonb_typeof(tagline -> 'ar') = 'string'
    and char_length(tagline ->> 'en') between 1 and 120
    and char_length(tagline ->> 'ar') between 1 and 120), false));

alter table public.site_profile drop constraint if exists site_profile_phone_e164_shape;
alter table public.site_profile add constraint site_profile_phone_e164_shape
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
alter table public.site_profile drop constraint if exists site_profile_phone_display_len;
alter table public.site_profile add constraint site_profile_phone_display_len
  check (phone_display is null or char_length(phone_display) between 1 and 32);
-- The WhatsApp pattern (0019): a displayed form needs the number it displays.
alter table public.site_profile drop constraint if exists site_profile_phone_display_needs_number;
alter table public.site_profile add constraint site_profile_phone_display_needs_number
  check (phone_display is null or phone_e164 is not null);

-- https, a host with no credentials, nothing but printable characters. Which hosts is Zod's
-- (Google Maps and Apple Maps, packages/schemas/siteProfile.ts), as the socials' hosts are.
alter table public.site_profile drop constraint if exists site_profile_map_url_https;
alter table public.site_profile add constraint site_profile_map_url_https check (
  map_url is null or (
    char_length(map_url) <= 500
    and map_url ~ '^https://[^[:space:]/@]+(/[^[:space:]]*)?$'));

-- The footer's copyright line (E6 renders it): null is the built-in "© {year} {brand}.
-- {place}". Both languages, 1-160 characters, and no brace but the three placeholders.
alter table public.site_profile drop constraint if exists site_profile_footer_copyright_shape;
alter table public.site_profile add constraint site_profile_footer_copyright_shape check (
  footer_copyright is null or coalesce((
    jsonb_typeof(footer_copyright) = 'object'
    and jsonb_typeof(footer_copyright -> 'en') = 'string'
    and jsonb_typeof(footer_copyright -> 'ar') = 'string'
    and char_length(footer_copyright ->> 'en') between 1 and 160
    and char_length(footer_copyright ->> 'ar') between 1 and 160
    and regexp_replace(footer_copyright ->> 'en', '\{(year|brand|place)\}', '', 'g') !~ '[{}]'
    and regexp_replace(footer_copyright ->> 'ar', '\{(year|brand|place)\}', '', 'g') !~ '[{}]'), false));
alter table public.site_profile drop constraint if exists site_profile_footer_style_known;
alter table public.site_profile add constraint site_profile_footer_style_known
  check (footer_style in ('light', 'dark'));

-- The icons: a composite key to the tenant's own media (MATCH SIMPLE: a null id passes), so
-- another tenant's picture is refused by the database and a picture in use cannot be
-- hard-deleted even before the Worker's media_usage gate.
alter table public.site_profile drop constraint if exists site_profile_favicon_fk;
alter table public.site_profile add constraint site_profile_favicon_fk
  foreign key (tenant_id, favicon_media_id)
  references public.media_assets (tenant_id, id) on delete restrict;
alter table public.site_profile drop constraint if exists site_profile_app_icon_fk;
alter table public.site_profile add constraint site_profile_app_icon_fk
  foreign key (tenant_id, app_icon_media_id)
  references public.media_assets (tenant_id, id) on delete restrict;
-- For media_usage and the foreign keys' check on a media delete.
create index if not exists site_profile_favicon_idx
  on public.site_profile (favicon_media_id) where favicon_media_id is not null;
create index if not exists site_profile_app_icon_idx
  on public.site_profile (app_icon_media_id) where app_icon_media_id is not null;

comment on column public.site_profile.tagline is
  'The site''s tagline, {en, ar} (both or none), up to 120 characters each (0099). Organization JSON-LD slogan, manifest description.';
comment on column public.site_profile.map_url is
  'A Google Maps or Apple Maps link (https; hosts checked by the Worker), Organization JSON-LD hasMap (0099).';
comment on column public.site_profile.favicon_media_id is
  'The favicon: a square storage image of at least 512 px of the same tenant (0099, app.tg_site_profile_icons). Linked in the head only when set.';
comment on column public.site_profile.app_icon_media_id is
  'The home-screen icon: a square storage image of at least 512 px of the same tenant (0099). apple-touch-icon and the manifest icons, only when set.';
comment on column public.site_profile.footer_copyright is
  'The footer''s copyright template, {en, ar}; only {year}, {brand} and {place} may be braced. Null = the built-in line. Rendered by E6 (0099).';

-- ═══ 3. The icon shape: square, storage, at least 512 px ══════════════════════════════════
-- BEFORE triggers on site_profile fire by name: site_profile__release_guard (0066) <
-- site_profile_guard (0019) < site_profile_icons < site_profile_updated_at <
-- site_profile_updater < site_profile_version (the release capture and the snapshot, 0038
-- and 0051, are AFTER triggers). The release guard's refusal comes first, the
-- applications guard next, then this check, then the stamps: no stamp is computed for a row
-- that is refused.
create or replace function app.tg_site_profile_icons() returns trigger
  language plpgsql security invoker set search_path = ''
as $$
declare
  v_col text;
  v_id uuid;
  v_old uuid;
  v_ok boolean;
begin
  foreach v_col in array array['favicon_media_id', 'app_icon_media_id'] loop
    if v_col = 'favicon_media_id' then
      v_id := new.favicon_media_id;
      v_old := case when tg_op = 'UPDATE' then old.favicon_media_id end;
    else
      v_id := new.app_icon_media_id;
      v_old := case when tg_op = 'UPDATE' then old.app_icon_media_id end;
    end if;
    -- Unset, or unchanged: nothing to check (a stored icon was checked when it was set).
    continue when v_id is null or (tg_op = 'UPDATE' and v_id is not distinct from v_old);
    select m.provider = 'storage' and m.kind = 'image'
           and m.width is not null and m.width = m.height and m.width >= 512
      into v_ok
      from public.media_assets m
     where m.tenant_id = new.tenant_id and m.id = v_id;
    -- Not found under the writer's RLS (another tenant's, or none): the foreign key answers
    -- (23503), after this trigger.
    continue when not found;
    if not coalesce(v_ok, false) then
      raise exception 'new row for relation "site_profile" violates check constraint "%"',
        case v_col when 'favicon_media_id' then 'site_profile_favicon_square'
                   else 'site_profile_app_icon_square' end
        using errcode = '23514',
              detail = 'An icon must be a square uploaded picture at least 512 pixels wide.';
    end if;
  end loop;
  return new;
end $$;
revoke all on function app.tg_site_profile_icons() from public, anon, authenticated, service_role;

drop trigger if exists site_profile_icons on public.site_profile;
create trigger site_profile_icons
  before insert or update of favicon_media_id, app_icon_media_id on public.site_profile
  for each row execute function app.tg_site_profile_icons();

-- ═══ 4. site_settings.timezone ═════════════════════════════════════════════════════════════
alter table public.site_settings
  add column if not exists timezone text not null default 'Asia/Riyadh';
alter table public.site_settings drop constraint if exists site_settings_timezone_closed;
alter table public.site_settings add constraint site_settings_timezone_closed check (timezone in (
  'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat',
  'Africa/Cairo', 'Asia/Amman', 'Europe/London', 'UTC'));
-- One source: every existing row takes its tenant's CRM zone. Only rows that differ are
-- written (a write moves the row's version, which would 409 an open settings form).
update public.site_settings s
   set timezone = c.timezone
  from public.crm_settings c
 where c.tenant_id = s.tenant_id
   and s.timezone is distinct from c.timezone;
comment on column public.site_settings.timezone is
  'The studio''s time zone (Admin v2 U9, 0099): the admin''s clock, the activity log''s days and maintenance''s "Back on" midnight. Immediate, never staged. A closed list equal to STUDIO_TIME_ZONES.';
comment on column public.crm_settings.timezone is
  'Deprecated (Admin v2 U9): site_settings.timezone is the one source. Dropped in C14.';

-- ═══ 5. One helper for settings.general ═══════════════════════════════════════════════════
-- `language sql immutable`, so the planner inlines it (as app.role_works_leads, 0033).
create or replace function app.role_general_settings(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- settings.general
revoke all on function app.role_general_settings(text) from public, anon, authenticated, service_role;
grant execute on function app.role_general_settings(text) to authenticated, service_role;

-- ═══ 6. The live check on every staff write to the two rows ═══════════════════════════════
-- RESTRICTIVE: ANDed with 0019's and 0001's permissive write policies, so it can only narrow.
drop policy if exists site_profile_live_insert on public.site_profile;
create policy site_profile_live_insert on public.site_profile as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())));
drop policy if exists site_profile_live_update on public.site_profile;
create policy site_profile_live_update on public.site_profile as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())));

drop policy if exists site_settings_live_insert on public.site_settings;
create policy site_settings_live_insert on public.site_settings as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())));
drop policy if exists site_settings_live_update on public.site_settings;
create policy site_settings_live_update on public.site_settings as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())));

-- ═══ 7. Grants, stated ═════════════════════════════════════════════════════════════════════
-- Readers and writers today (grep, 2026-10-20): anon reads site_profile (every public page);
-- staff read both and Admin + Developer write both (the General screen, the intake switch,
-- the maintenance route); the service role reads site_profile (the lead write, the index
-- backfill, the application intake) and reads and writes site_settings (the maintenance
-- reconcile). Nobody deletes either row.
revoke all on public.site_profile from public, anon, authenticated, service_role;
grant select on public.site_profile to anon;
grant select, insert, update on public.site_profile to authenticated, service_role;

revoke all on public.site_settings from public, anon, authenticated, service_role;
grant select, insert, update on public.site_settings to authenticated, service_role;

-- ═══ 8. The studio's zone for SQL ═════════════════════════════════════════════════════════
create or replace function app.studio_time_zone(p_tenant uuid) returns text
  language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select s.timezone
       from public.site_settings s
      where s.tenant_id = p_tenant
        and (p_tenant = app.effective_tenant_id()
             or pg_catalog.current_setting('role', true) = 'service_role')),
    'Asia/Riyadh')
$$;
revoke all on function app.studio_time_zone(uuid) from public, anon, authenticated, service_role;
grant execute on function app.studio_time_zone(uuid) to authenticated, service_role;

-- The Worker's door (src/lib/admin/studioTimeZone.ts): every member's own tenant, Sales
-- included, through the caller's token. INVOKER: the tenant is the caller's, and the definer
-- above does the one read. The service role reads site_settings itself and is not granted.
create or replace function public.studio_time_zone() returns text
  language sql stable security invoker set search_path = ''
as $$
  select app.studio_time_zone(app.effective_tenant_id())
$$;
revoke all on function public.studio_time_zone() from public, anon, authenticated, service_role;
grant execute on function public.studio_time_zone() to authenticated;

-- ═══ 9. media_assets_public_read: 0073's branches, plus the icons ═════════════════════════
-- NO policy on public.site_profile (nor, as 0073 says, on entity_seo or seo_defaults) may
-- read public.media_assets: this policy reads them, and the two would recurse (42P17).
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
    -- 0073: a share image. entity_seo is read under the reader's own RLS, so for anon only
    -- a row whose parent is published (0011 entity_seo_published_only) matches.
    or exists (select 1 from public.entity_seo e
                where e.og_media_id = media_assets.id)
    or exists (select 1 from public.seo_defaults sd
                where sd.default_og_media_id = media_assets.id)
    -- 0099: the site's icons, read under site_profile's own RLS (the tenant fence).
    or exists (select 1 from public.site_profile sp
                where sp.tenant_id = media_assets.tenant_id
                  and (sp.favicon_media_id = media_assets.id
                       or sp.app_icon_media_id = media_assets.id))
  )
);

-- ═══ 10. media_usage v6: v5 (0073), plus the icons ════════════════════════════════════════
create or replace function public.media_usage(p_media_id uuid)
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
  -- ---- v5 (0073): the share images. The entity is the page the SEO row describes (its
  -- target), labelled "<kind>: <slug>" from the target's own row; the defaults are the
  -- tenant's, labelled "site default" ----
  union all
  select 'entity_seo', e.entity_id,
         case e.entity_type
           when 'service' then 'service'
           when 'portfolio' then 'project'
           when 'blog_post' then 'post'
           else 'page'
         end
         || coalesce(': ' || case e.entity_type
              when 'service' then (select sv.slug::text from public.services sv
                                    where sv.tenant_id = e.tenant_id and sv.id = e.entity_id)
              when 'portfolio' then (select p.slug::text from public.portfolio p
                                      where p.tenant_id = e.tenant_id and p.id = e.entity_id)
              when 'blog_post' then (select b.slug::text from public.blog_posts b
                                      where b.tenant_id = e.tenant_id and b.id = e.entity_id)
              else (select pg.slug::text from public.pages pg
                     where pg.tenant_id = e.tenant_id and pg.id = e.entity_id)
            end, ''),
         false
    from public.entity_seo e
   where e.tenant_id = app.effective_tenant_id() and e.og_media_id = p_media_id
  union all
  select 'seo_defaults', sd.tenant_id, 'site default', false
    from public.seo_defaults sd
   where sd.tenant_id = app.effective_tenant_id() and sd.default_og_media_id = p_media_id
  -- ---- v6 (0099): the site's icons, labelled by which icon ----
  union all
  select 'site_profile', sp.tenant_id, 'favicon', false
    from public.site_profile sp
   where sp.tenant_id = app.effective_tenant_id() and sp.favicon_media_id = p_media_id
  union all
  select 'site_profile', sp.tenant_id, 'app icon', false
    from public.site_profile sp
   where sp.tenant_id = app.effective_tenant_id() and sp.app_icon_media_id = p_media_id
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

-- ═══ 11. The release registry: the new identity columns are staged like the rest ══════════
-- 0038's row, restated with the ten columns appended. `do update`, so this replaces 0038's;
-- tests/fixtures/releaseRegistry.ts folds the migrations in order and reads this shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('site_profile', 'site_profile', 'tenant_id', 'settings', '{admin,developer}', '{}',
   '{brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,address_locality,address_country,founded_year,socials,tagline,phone_e164,phone_display,map_url,favicon_media_id,app_icon_media_id,footer_copyright,footer_style,footer_show_email,footer_show_social}',
   '{}', '{}', '{accepting_applications}', 110, false, null)
on conflict (entity_type) do update
  set table_name = excluded.table_name,
      key_column = excluded.key_column,
      area = excluded.area,
      author_roles = excluded.author_roles,
      delete_roles = excluded.delete_roles,
      columns = excluded.columns,
      deferred_columns = excluded.deferred_columns,
      unique_flags = excluded.unique_flags,
      exempt_columns = excluded.exempt_columns,
      apply_order = excluded.apply_order,
      has_status = excluded.has_status,
      publish_flag = excluded.publish_flag;

-- ═══ 12. The help guides ═══════════════════════════════════════════════════════════════════
-- Four puts through H11's catalog, each literal docs/admin-v2/guides/<slug>.json verbatim, each
-- naming the revision main leaves the guide at (a stale one is refused, 55000). No other guide
-- is touched.
--
-- general-settings, new (revision 0), at place 98 (just before maintenance-mode; 45, 65, 75,
-- 95 and 125 are taken by slices in flight or merged).
select app.put_help_guide($guide$
{
  "slug": "general-settings",
  "sort_order": 98,
  "minutes": 3,
  "tags": [
    "site"
  ],
  "screens": [
    "/admin/settings"
  ],
  "caps": [
    "settings.general"
  ],
  "title": "General settings",
  "title_ar": "الإعدادات العامة",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "General settings hold the site's name and tagline, its icons, how people reach the studio, its social accounts and the studio's time zone. Saving puts a change live at once."
      },
      {
        "t": "h",
        "x": "Name, contact and accounts"
      },
      {
        "t": "p",
        "x": "The site name and the email also appear in the privacy notice, the terms and the job application notice. When you change either, tell the owner, so the notices can be dated again."
      },
      {
        "t": "p",
        "x": "An account with Show on the site off leaves the Social section and the details search engines read about the studio. The map link must be a Google Maps or Apple Maps link."
      },
      {
        "t": "h",
        "x": "Icons"
      },
      {
        "t": "p",
        "x": "The favicon and the app icon come from the media library. Each must be a square picture at least 512 pixels wide. Until one is chosen, the site links no icon."
      },
      {
        "t": "h",
        "x": "Region and data"
      },
      {
        "t": "p",
        "x": "The time zone is the studio's clock: the dates and times on every admin screen, the days of the activity log, the busiest hours in website stats, the uptime days in site health, and the midnight when maintenance ends by itself. Page visibility keeps Riyadh days. The time zone saves on its own, with how long data is kept: each can be shortened, and never set past its limit."
      },
      {
        "t": "ol",
        "x": [
          "Only an admin can open or close job applications. The switch saves at once.",
          "A developer sees the switch but cannot change it."
        ]
      },
      {
        "t": "tip",
        "x": "The logos are part of the site build, so the first screen paints fast. To change one, ask a developer."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تضم الإعدادات العامة اسم الموقع وشعاره النصي وأيقوناته، وطرق التواصل مع الاستوديو، وحساباته الاجتماعية، والمنطقة الزمنية للاستوديو. الحفظ ينشر التغيير فورًا."
      },
      {
        "t": "h",
        "x": "الاسم والتواصل والحسابات"
      },
      {
        "t": "p",
        "x": "يظهر اسم الموقع والبريد الإلكتروني أيضًا في إشعار الخصوصية والشروط وإشعار طلبات التوظيف. عند تغيير أيٍّ منهما أبلغ المالك ليُحدَّث تاريخ هذه الإشعارات."
      },
      {
        "t": "p",
        "x": "الحساب الذي أُطفئ فيه خيار Show on the site يختفي من قسم التواصل الاجتماعي ومن البيانات التي تقرؤها محركات البحث عن الاستوديو. ويجب أن يكون رابط الخريطة من خرائط Google أو خرائط Apple."
      },
      {
        "t": "h",
        "x": "الأيقونات"
      },
      {
        "t": "p",
        "x": "تُختار أيقونة الموقع وأيقونة التطبيق من مكتبة الوسائط. ويجب أن تكون كل منهما صورة مربعة لا يقل عرضها عن 512 بكسل. وإلى أن تُختار لا يربط الموقع أي أيقونة."
      },
      {
        "t": "h",
        "x": "المنطقة والبيانات"
      },
      {
        "t": "p",
        "x": "المنطقة الزمنية هي ساعة الاستوديو: التواريخ والأوقات في كل شاشات الإدارة، وأيام سجل النشاط، وأكثر الساعات نشاطًا في إحصاءات الموقع، وأيام وقت التشغيل في صحة الموقع، ومنتصف الليل الذي ينتهي فيه وضع الصيانة تلقائيًا. أما إخفاء الصفحات فيبقى بأيام الرياض. تُحفظ المنطقة الزمنية وحدها مع مدد الاحتفاظ بالبيانات: يمكن تقصير كل منها، ولا يمكن ضبطها أطول من حدها الأقصى."
      },
      {
        "t": "ol",
        "x": [
          "المدير وحده يفتح طلبات التوظيف أو يغلقها، ويُحفظ المفتاح فورًا.",
          "يرى المطوّر المفتاح لكنه لا يستطيع تغييره."
        ]
      },
      {
        "t": "tip",
        "x": "الشعارات جزء من بناء الموقع ليظهر أول ما يراه الزائر بسرعة. لتغيير أحدها اطلب ذلك من مطوّر."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- maintenance-mode rewritten for maintenance v2 (its place, caps and screens unchanged), at
-- revision 1, as the catalog was filled.
select app.put_help_guide($guide$
{
  "slug": "maintenance-mode",
  "sort_order": 100,
  "minutes": 3,
  "tags": [
    "site"
  ],
  "screens": [
    "/admin/maintenance"
  ],
  "caps": [
    "maintenance.manage"
  ],
  "title": "Maintenance mode",
  "title_ar": "وضع الصيانة",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Maintenance mode puts a short page in front of the public site while you fix something. It takes effect within about a minute, and the admin keeps working as usual."
      },
      {
        "t": "ol",
        "x": [
          "Write the headline and the message in English and Arabic, or leave them empty for the built-in words.",
          "Choose the background: the hero image or plain black. Show email and WhatsApp buttons adds the studio's email and WhatsApp number from General settings.",
          "Choose Turn on and confirm. Search engines are told the break is temporary, so rankings are safe for a few days."
        ]
      },
      {
        "t": "h",
        "x": "Coming back by itself"
      },
      {
        "t": "p",
        "x": "Back on ends maintenance by itself at midnight at the start of that day, in the studio's time zone. Pick a day up to 30 days ahead. Show the date to visitors puts it on the page."
      },
      {
        "t": "h",
        "x": "Who still sees the site"
      },
      {
        "t": "p",
        "x": "With Signed in team still sees the site on, anyone signed in to this admin sees the real site. If their sign in cannot be checked, they see the maintenance page like everyone else. Someone who has been away a while should open any admin page first (it renews the sign in), then reload the site. You can also allow IP addresses, for the client or an outside tester."
      },
      {
        "t": "p",
        "x": "Preview full screen opens the page as visitors see it, with the saved settings. While maintenance is on, the top bar says Maintenance on, and the bell says when it was switched on or off."
      },
      {
        "t": "tip",
        "x": "Switch it off as soon as the fix is in, so visitors and search engines are not kept waiting."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "يضع وضع الصيانة صفحة قصيرة أمام الموقع العام أثناء إصلاحك لشيء ما. يسري خلال دقيقة تقريبًا، وتستمر لوحة الإدارة في العمل كالمعتاد."
      },
      {
        "t": "ol",
        "x": [
          "اكتب العنوان والرسالة بالإنجليزية والعربية، أو اتركهما فارغين لاستخدام النص الافتراضي.",
          "اختر الخلفية: صورة الواجهة أو الأسود. خيار Show email and WhatsApp buttons يضيف بريد الاستوديو ورقم واتساب من الإعدادات العامة.",
          "اختر Turn on وأكّد. تُبلَّغ محركات البحث بأن التوقف مؤقت، فلا يتأثر ترتيب الموقع لبضعة أيام."
        ]
      },
      {
        "t": "h",
        "x": "العودة تلقائيًا"
      },
      {
        "t": "p",
        "x": "خيار Back on ينهي وضع الصيانة تلقائيًا عند منتصف الليل في بداية ذلك اليوم، بتوقيت المنطقة الزمنية للاستوديو. اختر يومًا خلال 30 يومًا. وخيار Show the date to visitors يعرض التاريخ على الصفحة."
      },
      {
        "t": "h",
        "x": "من يرى الموقع"
      },
      {
        "t": "p",
        "x": "عند تشغيل Signed in team still sees the site يرى كل من سجّل الدخول إلى لوحة الإدارة الموقعَ الحقيقي. وإذا تعذّر التحقق من دخوله يرى صفحة الصيانة مثل الجميع. ومن غاب مدة يفتح أي صفحة في لوحة الإدارة أولًا (فهذا يجدّد دخوله) ثم يعيد تحميل الموقع. ويمكنك أيضًا السماح بعناوين IP للعميل أو لمختبِر من الخارج."
      },
      {
        "t": "p",
        "x": "يفتح Preview full screen الصفحة كما يراها الزوار بالإعدادات المحفوظة. وأثناء تشغيل الصيانة يعرض الشريط العلوي Maintenance on، ويذكر الجرس متى شُغّل الوضع أو أُطفئ."
      },
      {
        "t": "tip",
        "x": "أطفئ الوضع فور انتهاء الإصلاح حتى لا ينتظر الزوار ومحركات البحث."
      }
    ]
  }
}
$guide$::jsonb, 1);

-- website-stats (G1's, 0071 left it at revision 2): one sentence. The busiest hours are
-- grouped in the studio's zone now (src/pages/admin/analytics/index.astro passes
-- studioTimeZone to public.busy_hours), not always Riyadh.
select app.put_help_guide($guide$
{
  "slug": "website-stats",
  "sort_order": 110,
  "minutes": 3,
  "tags": ["stats", "goals"],
  "screens": ["/admin/analytics", "/admin/analytics/search"],
  "caps": ["analytics.read"],
  "title": "Website stats",
  "title_ar": "إحصاءات الموقع",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Website stats counts visits, page views and what people do on the site. The numbers are the site's own, with no outside tracker, and only visitors who accept analytics cookies are counted."
      },
      {
        "t": "ol",
        "x": [
          "Pick 7, 30 or 90 days at the top. Overview shows visits, page views, pages per visit, one-page visits, the Arabic share and the top pages; Pages lists every page with its views in each language. If you work with leads, Overview also shows new leads and inquiries per 1,000 page views.",
          "A visit is one browser tab on one day: a tab kept open past midnight UTC counts again the next day. Pages per visit is page views divided by visits; a one-page visit saw one page and did nothing else.",
          "Conversions shows the funnel: visits, then the visits that opened a service page, then the ones that went on to an inquiry form in the same visit. Inquiries received are shown apart, and only to people who work with leads, because they count everyone who wrote, including visitors who declined cookies. Events lists clicks on the contact, language, project and service links, and the interest shown in the services explorer.",
          "Audience shows the busiest hours of the day in the studio's time zone, which the card names, over the days you picked, and English and Arabic views day by day. Devices, countries and sources are not collected.",
          "Realtime counts people who accepted analytics cookies and did something on the site in the last 5 minutes, and the pages they are on. It updates every minute while the tab is open; Pause updates stops it, and it stops by itself after 30 minutes. Minute counts are kept 48 hours.",
          "Admins and the SEO role can add goals on the Conversions tab: a name, what it counts and a target. Progress counts this calendar month, from the first, in UTC days. You can keep up to 20 goals.",
          "A change against the previous period shows only when there is a previous period to compare: the same number of days just before.",
          "Counts are added up every 15 minutes, by days that run midnight to midnight UTC (3 am in Riyadh), so the latest visits can take a while to show.",
          "Where your role has a Search tab, it shows what visitors typed into the site's search, and which searches found nothing. A search that finds nothing is often a page worth writing.",
          "Raw visit records are kept 90 days; the daily totals the screen reads are kept after that."
        ]
      },
      {
        "t": "tip",
        "x": "A low number can simply mean few visitors accepted cookies, not few visitors."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تحتسب إحصاءات الموقع الزيارات ومشاهدات الصفحات وما يفعله الزوار في الموقع. الأرقام خاصة بالموقع نفسه دون أي أداة تتبع خارجية، ولا يُحتسب إلا من يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات."
      },
      {
        "t": "ol",
        "x": [
          "اختر 7 أو 30 أو 90 يومًا في الأعلى. يعرض تبويب Overview الزيارات ومشاهدات الصفحات وعدد الصفحات لكل زيارة وزيارات الصفحة الواحدة وحصة العربية وأكثر الصفحات زيارة، ويسرد تبويب Pages كل صفحة مع مشاهداتها بكل لغة. وإذا كنت تعمل على العملاء المحتملين فسيعرض Overview أيضًا العملاء الجدد والاستفسارات لكل 1,000 مشاهدة.",
          "الزيارة هي علامة تبويب واحدة في المتصفح خلال يوم واحد، فإذا بقيت علامة التبويب مفتوحة بعد منتصف الليل بتوقيت UTC احتُسبت زيارة جديدة في اليوم التالي. عدد الصفحات لكل زيارة هو المشاهدات مقسومة على الزيارات، وزيارة الصفحة الواحدة هي زيارة رأت صفحة واحدة ولم تفعل شيئًا آخر.",
          "يعرض تبويب Conversions مسار التحويل: الزيارات، ثم الزيارات التي فتحت صفحة خدمة، ثم التي وصلت بعدها إلى نموذج استفسار في الزيارة نفسها. وتظهر الاستفسارات الواردة منفصلة، ولمن يعمل على العملاء المحتملين فقط، لأنها تحتسب كل من كتب إلينا بمن فيهم الزوار الذين رفضوا ملفات تعريف الارتباط. ويسرد قسم Events النقرات على روابط التواصل واللغة والمشاريع والخدمات، والاهتمام الذي يظهره الزوار في مستكشف الخدمات.",
          "يعرض تبويب Audience أكثر ساعات اليوم نشاطًا بتوقيت المنطقة الزمنية للاستوديو، كما تذكرها البطاقة، خلال الأيام التي اخترتها، والمشاهدات بالإنجليزية والعربية يومًا بيوم. لا تُجمع بيانات الأجهزة أو الدول أو المصادر.",
          "يحتسب تبويب Realtime الأشخاص الذين قبلوا ملفات تعريف الارتباط الخاصة بالتحليلات وقاموا بأي نشاط في الموقع خلال آخر 5 دقائق، والصفحات التي يتصفحونها. ويتحدّث كل دقيقة ما دام التبويب مفتوحًا، ويوقفه زر Pause updates، ويتوقف من تلقاء نفسه بعد 30 دقيقة. وتُحفظ أرقام الدقائق 48 ساعة.",
          "يستطيع المسؤولون (Admin) ودور SEO إضافة أهداف في تبويب Conversions: اسم، وما يحتسبه الهدف، ورقم مستهدف. ويُحتسب التقدم خلال الشهر الحالي من أوله، بأيام توقيت UTC. ويمكن الاحتفاظ بما يصل إلى 20 هدفًا.",
          "لا يظهر التغيّر مقارنة بالفترة السابقة إلا إذا وُجدت فترة سابقة للمقارنة، أي العدد نفسه من الأيام التي تسبقها مباشرة.",
          "تُجمع الأرقام كل 15 دقيقة، بأيام تمتد من منتصف الليل إلى منتصف الليل بتوقيت UTC (الثالثة فجرًا بتوقيت الرياض)، لذا قد تتأخر أحدث الزيارات في الظهور.",
          "إذا كان لدورك تبويب Search فهو يعرض ما كتبه الزوار في بحث الموقع، وعمليات البحث التي لم تجد شيئًا. والبحث الذي لا يجد شيئًا كثيرًا ما يشير إلى صفحة تستحق الكتابة.",
          "تُحفظ سجلات الزيارات الأولية 90 يومًا، وتبقى المجاميع اليومية التي تقرؤها الشاشة بعد ذلك."
        ]
      },
      {
        "t": "tip",
        "x": "قد يعني الرقم المنخفض ببساطة أن قلة من الزوار قبلوا ملفات تعريف الارتباط، لا أن الزوار قليلون."
      }
    ]
  }
}
$guide$::jsonb, 2);

-- site-health-and-logs (G2's, revision 1 as the catalog was filled): one sentence. The uptime
-- strip's days are the studio's (src/lib/health/probes.ts reads the zone with the probes).
select app.put_help_guide($guide$
{
  "slug": "site-health-and-logs",
  "sort_order": 120,
  "minutes": 4,
  "tags": [
    "site"
  ],
  "screens": [
    "/admin/site-health",
    "/admin/audit"
  ],
  "caps": [
    "siteHealth.view",
    "logs.view",
    "audit.view"
  ],
  "title": "Site health, errors and the activity log",
  "title_ar": "صحة الموقع والأخطاء وسجل النشاط",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Site health shows how fast the site feels to real visitors (Core Web Vitals), measured in their own browsers when they accept analytics cookies, beside a checklist of things worth fixing."
      },
      {
        "t": "ol",
        "x": [
          "Once the uptime monitor is set up, the score weighs speed 40%, the checklist 40% and uptime 20%; until then it is half speed and half checklist. Speed comes from real visits over the last 28 days: each of LCP, INP and CLS counts in full when it is within budget, half when it needs work and not at all when it is poor. Uptime over the last 30 days counts in full at 100% and not at all at 99% or less.",
          "The checklist groups what it checks: content, SEO, speed, errors, security and backups. A row that needs fixing links to the screen where you fix it, and a row your role cannot check says so.",
          "The Uptime card shows what the uptime monitor sees: it checks the site from outside our hosting, and its readings arrive here every 10 minutes. Each of the last 90 days is a bar: green when the site was up all day, amber when it was down for a few minutes, red when it was down for more than 14 minutes, grey when there is no reading. Days follow the studio's time zone, and View as table lists the days with downtime. Check now asks for a fresh reading at once, up to 6 times an hour. Until a developer adds the monitor's read-only key, the card says Not set up and the score leaves uptime out.",
          "The Security tab lists how the site is protected, with its domain and its certificate. The domain's renewal date is read from its public registration record about once a day, and the row needs fixing when 30 days or fewer are left. The certificate's date comes from the uptime monitor when it reports one, and the row needs fixing when 14 days or fewer are left; otherwise the row says Cloudflare issues and renews the certificates.",
          "The bell tells Admins and Developers when the site is down, when it was down for a while, when the domain or the certificate is about to expire, when no registration is found for the domain, and when the uptime monitor has not answered for an hour.",
          "Speed lists each page's figures from visitors' browsers, added up every hour and kept 400 days. Lab scores run in CI on every change, so none are shown here.",
          "Errors lists problems the site ran into. Every night, entries older than 30 days are deleted by themselves; an Admin can clear them sooner with Clear logs, choosing entries older than 7 days, older than 30 days, or all of them, and the clearing itself is recorded in the activity log.",
          "The activity log records saves, publishes, reveals of contact details, sign-ins and exports, each against the account that made it, with the time. The database itself writes who made an entry and when, so nobody can record something in someone else's name. Each entry names the person, former members included, and says what they did in plain words, with the names of the fields a save changed, never what they hold. Nobody can edit or delete an entry, not even an Admin, and the log is kept for good.",
          "Narrow the log to a kind of activity, a person or a range of days. Publishing finds publishes recorded since these filters arrived; earlier ones are listed as updates. Export downloads the entries that match as a spreadsheet file (CSV), up to three times an hour, and each download is recorded in the log too; the file names each item by its type and id, not its title. If the line above the list says the latest entries do not link up, tell whoever runs the site."
        ]
      },
      {
        "t": "tip",
        "x": "To find out when something changed, and who changed it, look in the activity log."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تُظهر صحة الموقع مدى سرعة الموقع كما يشعر بها الزوار الحقيقيون (Core Web Vitals)، وتُقاس في متصفحاتهم عندما يقبلون ملفات تعريف الارتباط الخاصة بالتحليلات، إلى جانب قائمة تحقق بما يستحق الإصلاح."
      },
      {
        "t": "ol",
        "x": [
          "بعد إعداد مراقب وقت التشغيل، تُوزَّع الدرجة على 40% للسرعة و40% لقائمة التحقق و20% لوقت التشغيل، وحتى ذلك الحين يكون نصفها للسرعة ونصفها لقائمة التحقق. تأتي السرعة من زيارات حقيقية خلال آخر 28 يومًا: يُحتسب كل من LCP وINP وCLS كاملًا إذا كان ضمن الحد المستهدف، ونصفه إذا احتاج إلى تحسين، ولا يُحتسب إذا كان ضعيفًا. ويُحتسب وقت التشغيل خلال آخر 30 يومًا كاملًا عند 100%، ولا يُحتسب عند 99% أو أقل.",
          "تجمع قائمة التحقق ما تفحصه في مجموعات: المحتوى وSEO والسرعة والأخطاء والأمان والنسخ الاحتياطية. والبند الذي يحتاج إلى إصلاح يرتبط بالشاشة التي تصلحه منها، والبند الذي لا يستطيع دورك فحصه يذكر ذلك.",
          "تعرض بطاقة Uptime ما يراه مراقب وقت التشغيل: فهو يفحص الموقع من خارج الاستضافة، وتصل قراءاته إلى هنا كل 10 دقائق. لكل يوم من آخر 90 يومًا شريط: أخضر إذا عمل الموقع طوال اليوم، وكهرماني إذا توقف بضع دقائق، وأحمر إذا توقف أكثر من 14 دقيقة، ورمادي إذا لم تتوفر قراءة. تتبع الأيام المنطقة الزمنية للاستوديو، ويسرد زر View as table الأيام التي توقف فيها الموقع. ويطلب زر Check now قراءة جديدة فورًا، حتى 6 مرات في الساعة. وإلى أن يضيف المطوّر مفتاح القراءة فقط الخاص بالمراقب، تذكر البطاقة Not set up ولا تدخل وقت التشغيل في الدرجة.",
          "يعرض تبويب Security كيف يُحمى الموقع، ومعه النطاق والشهادة. يُقرأ تاريخ تجديد النطاق من سجل تسجيله العام مرة في اليوم تقريبًا، ويحتاج البند إلى إصلاح عندما يبقى 30 يومًا أو أقل. ويأتي تاريخ الشهادة من مراقب وقت التشغيل إذا أبلغ عنه، ويحتاج البند إلى إصلاح عندما يبقى 14 يومًا أو أقل، وإلا فيذكر البند أن Cloudflare تُصدر الشهادات وتجددها.",
          "يُنبّه الجرس المسؤول (Admin) والمطوّر (Developer) عندما يتوقف الموقع، وبعد أن يتوقف مدة، وعندما يقترب انتهاء النطاق أو الشهادة، وعندما لا يُعثر على تسجيل للنطاق، وعندما لا يجيب مراقب وقت التشغيل لمدة ساعة.",
          "يعرض تبويب Speed أرقام كل صفحة من متصفحات الزوار، تُجمع كل ساعة وتُحفظ 400 يوم. أما درجات المختبر فتُشغَّل في CI مع كل تغيير، لذا لا تظهر هنا.",
          "يعرض تبويب Errors المشكلات التي واجهها الموقع. تُحذف كل ليلة الإدخالات الأقدم من 30 يومًا تلقائيًا، ويستطيع المسؤول (Admin) مسحها قبل ذلك بزر Clear logs، فيختار الإدخالات الأقدم من 7 أيام أو الأقدم من 30 يومًا أو كلها، ويُسجَّل المسح نفسه في سجل النشاط.",
          "يسجّل سجل النشاط الحفظ والنشر وكشف بيانات التواصل وتسجيل الدخول والتصدير، كلًّا على الحساب الذي قام به مع وقته. وتكتب قاعدة البيانات بنفسها صاحب كل إدخال ووقته، فلا يستطيع أحد أن يسجّل شيئًا باسم غيره. ويذكر كل إدخال اسم الشخص، ومنهم من غادر الفريق، وما فعله بكلمات واضحة، مع أسماء الحقول التي غيّرها الحفظ دون محتواها. ولا يستطيع أحد تعديل أي إدخال أو حذفه، ولا حتى المسؤول (Admin)، ويُحتفظ بالسجل دائمًا.",
          "ضيّق السجل حسب نوع النشاط أو الشخص أو مدة من الأيام. يجد مرشّح Publishing ما نُشر منذ إضافة هذه المرشّحات، ويظهر ما نُشر قبلها كتحديثات. ويُنزّل زر Export الإدخالات المطابقة في ملف جدول بيانات (CSV) حتى ثلاث مرات في الساعة، ويُسجَّل كل تنزيل في السجل أيضًا، ويذكر الملف كل عنصر بنوعه ومعرّفه لا بعنوانه. وإذا ذكر السطر أعلى القائمة أن أحدث الإدخالات لا تتصل كما ينبغي، فأبلغ المسؤول عن الموقع."
        ]
      },
      {
        "t": "tip",
        "x": "لمعرفة متى تغيّر شيء ومن قام بتغييره، ارجع إلى سجل النشاط."
      }
    ]
  }
}
$guide$::jsonb, 1);

-- ═══ 13. Postconditions ═══════════════════════════════════════════════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_bad text;
  v_qual text;
  v_got text;
  r text;
  t text;
  p text;
  v_crm text[];
  v_site text[];
begin
  -- ---- 1. The unique key is exactly (tenant_id, id) ---------------------------------------
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.media_assets'::regclass
                    and c.conname = 'media_assets_tenant_id_id' and c.contype = 'u'
                    and pg_get_constraintdef(c.oid) = 'UNIQUE (tenant_id, id)') then
    raise exception '0099: media_assets_tenant_id_id must be UNIQUE (tenant_id, id)';
  end if;

  -- ---- 2. The icon keys: RESTRICT, to that unique key ------------------------------------
  foreach t in array array['favicon', 'app_icon'] loop
    if not exists (select 1 from pg_constraint c
                    where c.conrelid = 'public.site_profile'::regclass
                      and c.conname = format('site_profile_%s_fk', t) and c.contype = 'f'
                      and c.confdeltype = 'r'
                      and c.conindid = (select conindid from pg_constraint
                                         where conname = 'media_assets_tenant_id_id'
                                           and conrelid = 'public.media_assets'::regclass)
                      and pg_get_constraintdef(c.oid)
                          ~ format('^FOREIGN KEY \(tenant_id, %s_media_id\) REFERENCES (public\.)?media_assets\(tenant_id, id\) ON DELETE RESTRICT$', t)) then
      raise exception '0099: site_profile_%_fk must be (tenant_id, %_media_id) -> media_assets (tenant_id, id) ON DELETE RESTRICT', t, t;
    end if;
  end loop;
  if to_regclass('public.site_profile_favicon_idx') is null
     or to_regclass('public.site_profile_app_icon_idx') is null then
    raise exception '0099: the icon indexes are missing';
  end if;

  -- ---- 3. The CHECKs, by name ------------------------------------------------------------
  select string_agg(n, ', ') into v_bad
    from unnest(array['site_profile_tagline_shape', 'site_profile_phone_e164_shape',
                      'site_profile_phone_display_len', 'site_profile_phone_display_needs_number',
                      'site_profile_map_url_https', 'site_profile_footer_copyright_shape',
                      'site_profile_footer_style_known']) as n
   where not exists (select 1 from pg_constraint c
                      where c.conrelid = 'public.site_profile'::regclass
                        and c.conname = n and c.contype = 'c' and c.convalidated);
  if v_bad is not null then
    raise exception '0099: site_profile lacks the validated CHECKs %', v_bad;
  end if;
  if (select pg_get_expr(adbin, adrelid) from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'public.site_profile'::regclass and a.attname = 'footer_style')
     is distinct from '''light''::text'
     or (select attnotnull from pg_attribute
          where attrelid = 'public.site_profile'::regclass and attname = 'footer_show_social') is not true then
    raise exception '0099: the footer settings must default to today''s footer, not null';
  end if;

  -- ---- 4. The triggers on site_profile, by function --------------------------------------
  select string_agg(format('%s:%s', tg.tgname, tg.tgfoid::regproc), ', ' order by tg.tgname)
    into v_got
    from pg_trigger tg
   where tg.tgrelid = 'public.site_profile'::regclass and not tg.tgisinternal;
  if v_got is distinct from
     'site_profile__release_guard:app.tg_release_guard, '
     'site_profile_guard:app.tg_site_profile_guard, '
     'site_profile_icons:app.tg_site_profile_icons, '
     'site_profile_release_capture:app.tg_release_capture, '
     'site_profile_snapshot:app.tg_snapshot_singleton, '
     'site_profile_updated_at:app.tg_set_updated_at, '
     'site_profile_updater:app.tg_set_updater, '
     'site_profile_version:app.tg_bump_version' then
    raise exception '0099: site_profile''s triggers are not the expected set: %', v_got;
  end if;
  if exists (select 1 from pg_proc
              where oid = 'app.tg_site_profile_icons()'::regprocedure
                and (prosecdef or proconfig is distinct from array['search_path=""'])) then
    raise exception '0099: app.tg_site_profile_icons must be INVOKER with search_path ''''';
  end if;

  -- ---- 5. The time zone: the closed list equals crm_settings', every row copied ------------
  select array_agg(m[1] order by ord) into v_site
    from regexp_matches((select pg_get_constraintdef(oid) from pg_constraint
                          where conrelid = 'public.site_settings'::regclass
                            and conname = 'site_settings_timezone_closed'),
                        '''([^'']+)''', 'g') with ordinality as x(m, ord);
  select array_agg(m[1] order by ord) into v_crm
    from regexp_matches((select pg_get_constraintdef(c.oid) from pg_constraint c
                          where c.conrelid = 'public.crm_settings'::regclass and c.contype = 'c'
                            and pg_get_constraintdef(c.oid) ~ 'timezone'),
                        '''([^'']+)''', 'g') with ordinality as x(m, ord);
  if v_site is null or v_site is distinct from v_crm or cardinality(v_site) <> 10 then
    raise exception '0099: site_settings_timezone_closed (%) must equal crm_settings'' list (%)', v_site, v_crm;
  end if;
  if exists (select 1 from public.site_settings s join public.crm_settings c using (tenant_id)
              where s.timezone is distinct from c.timezone) then
    raise exception '0099: a site_settings row''s timezone differs from its tenant''s crm_settings.timezone';
  end if;

  -- ---- 6. The helper, and the reader ------------------------------------------------------
  if not exists (select 1 from pg_proc
                  where oid = 'app.role_general_settings(text)'::regprocedure
                    and provolatile = 'i' and not prosecdef
                    and prosrc ~ 'r in \(''admin'', ''developer''\)')
     or has_function_privilege('anon', 'app.role_general_settings(text)', 'execute')
     or has_function_privilege('public', 'app.role_general_settings(text)', 'execute')
     or not has_function_privilege('authenticated', 'app.role_general_settings(text)', 'execute') then
    raise exception '0099: app.role_general_settings must be an immutable Admin + Developer check, executable by staff and the service role only';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.studio_time_zone(uuid)'::regprocedure
                    and prosecdef and proconfig = array['search_path=""'])
     or has_function_privilege('anon', 'app.studio_time_zone(uuid)', 'execute')
     or has_function_privilege('public', 'app.studio_time_zone(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'app.studio_time_zone(uuid)', 'execute')
     or not has_function_privilege('service_role', 'app.studio_time_zone(uuid)', 'execute') then
    raise exception '0099: app.studio_time_zone must be DEFINER with search_path '''', executable by staff and the service role only';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'public.studio_time_zone()'::regprocedure
                    and not prosecdef and proconfig = array['search_path=""']
                    and prorettype = 'text'::regtype)
     or has_function_privilege('anon', 'public.studio_time_zone()', 'execute')
     or has_function_privilege('public', 'public.studio_time_zone()', 'execute')
     or has_function_privilege('service_role', 'public.studio_time_zone()', 'execute')
     or not has_function_privilege('authenticated', 'public.studio_time_zone()', 'execute') then
    raise exception '0099: public.studio_time_zone() must be INVOKER with search_path '''', executable by authenticated only';
  end if;

  -- ---- 7. The exact policy sets, tenant first in each ---------------------------------------
  select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'site_profile';
  if v_got is distinct from
     'site_profile_insert INSERT PERMISSIVE {public}, '
     'site_profile_live_insert INSERT RESTRICTIVE {authenticated}, '
     'site_profile_live_update UPDATE RESTRICTIVE {authenticated}, '
     'site_profile_read SELECT PERMISSIVE {public}, '
     'site_profile_update UPDATE PERMISSIVE {public}' then
    raise exception '0099: site_profile''s policies are not the expected set: %', v_got;
  end if;
  select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'site_settings';
  if v_got is distinct from
     'site_settings_live_insert INSERT RESTRICTIVE {authenticated}, '
     'site_settings_live_update UPDATE RESTRICTIVE {authenticated}, '
     'site_settings_staff_read SELECT PERMISSIVE {public}, '
     'site_settings_write ALL PERMISSIVE {public}' then
    raise exception '0099: site_settings''s policies are not the expected set: %', v_got;
  end if;
  select string_agg(format('%s.%s', tablename, policyname), ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename in ('site_profile', 'site_settings')
     and not (coalesce(qual, '^') ~ '^\(?\(?tenant_id = (app\.)?effective_tenant_id\(\)\)'
              or qual is null)
     or schemaname = 'public' and tablename in ('site_profile', 'site_settings')
     and not (coalesce(with_check, '^') ~ '^\(?\(?tenant_id = (app\.)?effective_tenant_id\(\)\)'
              or with_check is null);
  if v_bad is not null then
    raise exception '0099: policies without the tenant predicate first: %', v_bad;
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename in ('site_profile', 'site_settings')
         and permissive = 'RESTRICTIVE'
         and coalesce(qual, with_check) ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_general_settings\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$'
         and coalesce(with_check, qual) = coalesce(qual, with_check)) <> 4 then
    raise exception '0099: each live policy must be the tenant predicate, then settings.general on the live role, on every side it has';
  end if;

  -- ---- 8. RLS on and forced ---------------------------------------------------------------
  select string_agg(relname, ', ') into v_bad
    from pg_class
   where oid in ('public.site_profile'::regclass, 'public.site_settings'::regclass,
                 'public.media_assets'::regclass)
     and not (relrowsecurity and relforcerowsecurity);
  if v_bad is not null then
    raise exception '0099: RLS is not enabled and forced on %', v_bad;
  end if;

  -- ---- 9. Grants: has and has-not, table-wide and per column -------------------------------
  foreach t in array array['public.site_profile', 'public.site_settings'] loop
    foreach r in array array['authenticated', 'service_role'] loop
      if not has_table_privilege(r::name, t, 'select')
         or not has_table_privilege(r::name, t, 'insert')
         or not has_table_privilege(r::name, t, 'update') then
        raise exception '0099: % must SELECT, INSERT and UPDATE %', r, t;
      end if;
    end loop;
    foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
      foreach p in array array['delete', 'truncate', 'references', 'trigger'] loop
        if has_table_privilege(r::name, t, p) then
          raise exception '0099: % holds % on %', r, p, t;
        end if;
      end loop;
      if v_maintain and has_table_privilege(r::name, t, 'maintain') then
        raise exception '0099: % holds MAINTAIN on %', r, t;
      end if;
    end loop;
    foreach r in array array['public', 'anon'] loop
      if has_table_privilege(r::name, t, 'insert') or has_table_privilege(r::name, t, 'update') then
        raise exception '0099: % may write %', r, t;
      end if;
    end loop;
    -- No column grant widens any of it: every column, every API role.
    select string_agg(format('%s %s.%s', rr, t, a.attname), ', ') into v_bad
      from pg_attribute a
      cross join unnest(array['public', 'anon']) as rr
     where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege(rr::name, t::regclass, a.attnum, 'insert, update, references');
    if v_bad is not null then
      raise exception '0099: column write or REFERENCES grants: %', v_bad;
    end if;
    select string_agg(format('%s %s.%s', rr, t, a.attname), ', ') into v_bad
      from pg_attribute a
      cross join unnest(array['authenticated', 'service_role']) as rr
     where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege(rr::name, t::regclass, a.attnum, 'references');
    if v_bad is not null then
      raise exception '0099: column REFERENCES grants: %', v_bad;
    end if;
  end loop;
  if not has_table_privilege('anon', 'public.site_profile', 'select')
     or has_table_privilege('anon', 'public.site_settings', 'select')
     or has_table_privilege('public', 'public.site_settings', 'select')
     or exists (select 1 from pg_attribute a
                 where a.attrelid = 'public.site_settings'::regclass and a.attnum > 0
                   and not a.attisdropped
                   and has_column_privilege('anon', 'public.site_settings'::regclass, a.attnum, 'select')) then
    raise exception '0099: anon must read site_profile and nothing of site_settings';
  end if;

  -- ---- 10. media_assets_public_read: PERMISSIVE SELECT, tenant first, every branch -------
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'media_assets'
     and policyname = 'media_assets_public_read'
     and permissive = 'PERMISSIVE' and cmd = 'SELECT';
  if v_qual is null
     or v_qual !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\)'
     or position('storage' in v_qual) = 0
     or position('portfolio_media' in v_qual) = 0
     or position('page_sections' in v_qual) = 0
     or position('disciplines' in v_qual) = 0
     or position('services' in v_qual) = 0
     or position('og_media_id' in v_qual) = 0
     or position('default_og_media_id' in v_qual) = 0
     or position('favicon_media_id' in v_qual) = 0
     or position('app_icon_media_id' in v_qual) = 0 then
    raise exception '0099: media_assets_public_read must be PERMISSIVE SELECT, tenant first, naming storage, every 0045 and 0073 branch and the icons';
  end if;
  -- The recursion rule: no policy on a table this policy reads may read media_assets.
  select string_agg(tablename || '.' || policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename in ('site_profile', 'entity_seo', 'seo_defaults')
     and (coalesce(qual, '') ~ 'media_assets' or coalesce(with_check, '') ~ 'media_assets');
  if v_bad is not null then
    raise exception '0099: policies that read media_assets (42P17 with media_assets_public_read): %', v_bad;
  end if;

  -- ---- 11. media_usage v6: INVOKER, search_path '', four columns, authenticated only -----
  if not exists (select 1 from pg_proc
                  where oid = 'public.media_usage(uuid)'::regprocedure and not prosecdef
                    and proconfig = array['search_path=""']
                    and pg_get_function_result(oid)
                        = 'TABLE(entity_type text, entity_id uuid, label text, pending boolean)'
                    and prosrc ~ '''entity_seo''' and prosrc ~ '''seo_defaults'''
                    and prosrc ~ '''site_profile''' and prosrc ~ 'favicon_media_id'
                    and prosrc ~ 'app_icon_media_id' and prosrc ~ 'content_drafts') then
    raise exception '0099: public.media_usage must be INVOKER, search_path '''', four columns, with the icon, share-image and pending branches';
  end if;
  if not has_function_privilege('authenticated', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('anon', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('public', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.media_usage(uuid)', 'execute') then
    raise exception '0099: public.media_usage must be executable by authenticated only';
  end if;

  -- ---- 12. The registry row, exactly ------------------------------------------------------
  if not exists (select 1 from app.release_entities
                  where entity_type = 'site_profile' and table_name = 'site_profile'
                    and key_column = 'tenant_id' and area = 'settings'
                    and author_roles = '{admin,developer}' and delete_roles = '{}'
                    and columns = '{brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,address_locality,address_country,founded_year,socials,tagline,phone_e164,phone_display,map_url,favicon_media_id,app_icon_media_id,footer_copyright,footer_style,footer_show_email,footer_show_social}'
                    and deferred_columns = '{}' and unique_flags = '{}'
                    and exempt_columns = '{accepting_applications}'
                    and apply_order = 110 and not has_status and publish_flag is null) then
    raise exception '0099: the site_profile registry row is not as stated';
  end if;
  if exists (select 1 from app.release_entities where 'timezone' = any (columns)) then
    raise exception '0099: timezone is immediate and must never be staged';
  end if;

  -- ---- 13. The guides: in the catalog and in every tenant ---------------------------------
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'general-settings' and revision = 1 and sort_order = 98
                    and title = 'General settings' and caps = array['settings.general']
                    and screens = array['/admin/settings'])
     or not exists (select 1 from app.help_guide_catalog
                     where slug = 'maintenance-mode' and revision = 2 and sort_order = 100
                       and caps = array['maintenance.manage']
                       and screens = array['/admin/maintenance']
                       and body::text ~ 'Back on ends maintenance by itself')
     or not exists (select 1 from app.help_guide_catalog
                     where slug = 'website-stats' and revision = 3
                       and body::text ~ 'busiest hours of the day in the studio''s time zone'
                       and body::text !~ 'busiest hours of the day in Riyadh')
     or not exists (select 1 from app.help_guide_catalog
                     where slug = 'site-health-and-logs' and revision = 2
                       and body::text ~ 'Days follow the studio''s time zone'
                       and body::text !~ 'midnight to midnight in Riyadh') then
    raise exception '0099: the catalog must hold general-settings at revision 1, maintenance-mode at 2, website-stats at 3 and site-health-and-logs at 2, with their new words';
  end if;
  select string_agg(tn.id::text, ', ') into v_bad
    from public.tenants tn
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = tn.id and h.slug = 'general-settings')
      or not exists (select 1 from public.help_articles h
                      where h.tenant_id = tn.id and h.slug = 'maintenance-mode'
                        and h.body::text ~ 'Back on ends maintenance by itself')
      or not exists (select 1 from public.help_articles h
                      where h.tenant_id = tn.id and h.slug = 'website-stats'
                        and h.body::text ~ 'busiest hours of the day in the studio''s time zone')
      or not exists (select 1 from public.help_articles h
                      where h.tenant_id = tn.id and h.slug = 'site-health-and-logs'
                        and h.body::text ~ 'Days follow the studio''s time zone');
  if v_bad is not null then
    raise exception '0099: tenants without the four guides as U9 leaves them: %', v_bad;
  end if;
end $$;
