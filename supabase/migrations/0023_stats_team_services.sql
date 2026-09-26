-- ─────────────────────────────────────────────────────────────────────────────
-- 0023 — Statistics, leadership, service short titles. UI v2 PR4a.
-- Forward-only (expand). Depends on 0001, 0005, 0018, 0020.
--
--   statistics     The same counter appears on several pages under a different label
--                  ("Projects" on home, "Projects delivered across the region" on About).
--                  `placements` says where a stat shows; `placement_labels` holds the
--                  per-page label ({about: {en, ar}}), falling back to `label`.
--                  `value_numeric` + `value_suffix` let the band count up; `value` stays
--                  the display string, and a CHECK keeps the two in agreement so the
--                  server-rendered number and the animated one can never differ.
--   team_members   The About leadership slider: a role line, an optional LinkedIn link,
--                  a portrait from the media library and the `is_leadership` filter.
--   services       `short_title` — the chip/skill label where it differs from the title
--                  (SEO / GEO / AEO: "تحسين الظهور" on chips, the full title elsewhere).
--
-- `is_placeholder` on statistics and team_members: 0025 stops a placeholder going live
-- in production. New constraints are NOT VALID, then validated (a legacy row that fails
-- one keeps the migration applying, with a warning).
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Statistics -------------------------------------------------------------------
alter table public.statistics
  add column if not exists value_numeric numeric(12, 2) check (value_numeric >= 0),
  add column if not exists value_suffix text check (char_length(value_suffix) <= 4),
  add column if not exists placements text[] not null default '{}'
    check (placements <@ array['home', 'about', 'work']::text[]),
  add column if not exists placement_labels jsonb not null default '{}'::jsonb
    check (jsonb_typeof(placement_labels) = 'object'),
  add column if not exists is_placeholder boolean not null default false;

-- Labels exist only for known placements, each a {en, ar} object. (Spelled out per key:
-- a CHECK cannot hold a subquery, and a helper function would need its own grants.)
alter table public.statistics drop constraint if exists statistics_placement_labels_shape;
alter table public.statistics add constraint statistics_placement_labels_shape check (
  placement_labels - 'home' - 'about' - 'work' = '{}'::jsonb
  and (not placement_labels ? 'home'
       or (jsonb_typeof(placement_labels -> 'home') = 'object'
           and placement_labels -> 'home' ?& array['en', 'ar']))
  and (not placement_labels ? 'about'
       or (jsonb_typeof(placement_labels -> 'about') = 'object'
           and placement_labels -> 'about' ?& array['en', 'ar']))
  and (not placement_labels ? 'work'
       or (jsonb_typeof(placement_labels -> 'work') = 'object'
           and placement_labels -> 'work' ?& array['en', 'ar']))
) not valid;

-- `value` is what the server renders; when a number is set, it must say the same thing.
alter table public.statistics drop constraint if exists statistics_value_consistent;
alter table public.statistics add constraint statistics_value_consistent check (
  value_numeric is null or value = trim_scale(value_numeric)::text || coalesce(value_suffix, '')
) not valid;

create index if not exists statistics_placements_idx on public.statistics using gin (placements);

-- ---- Team members -------------------------------------------------------------------
alter table public.team_members
  add column if not exists role jsonb check (role is null or jsonb_typeof(role) = 'object'),
  add column if not exists linkedin_url text
    check (linkedin_url ~ '^https://([a-z]{2,3}\.)?linkedin\.com/(in|company)/[A-Za-z0-9_-]+/?$'),
  add column if not exists is_leadership boolean not null default false,
  add column if not exists portrait_media_id uuid references public.media_assets (id) on delete restrict,
  add column if not exists is_placeholder boolean not null default false;

create index if not exists team_members_leadership_idx
  on public.team_members (tenant_id, sort_order) where is_leadership and status = 'published';
create index if not exists team_members_portrait_idx on public.team_members (portrait_media_id);

-- ---- Services -----------------------------------------------------------------------
alter table public.services
  add column if not exists short_title jsonb
    check (short_title is null or (jsonb_typeof(short_title) = 'object'
                                   and short_title ? 'en' and short_title ? 'ar'));

-- ---- Validate what can be validated -------------------------------------------------
do $$
declare
  c text;
begin
  foreach c in array array['statistics_placement_labels_shape', 'statistics_value_consistent'] loop
    begin
      execute format('alter table public.statistics validate constraint %I', c);
    exception when check_violation then
      raise warning '0023: % left NOT VALID — legacy statistics rows violate it (still enforced on every new or edited row)', c;
    end;
  end loop;
end $$;

-- ---- Postconditions -------------------------------------------------------------------
-- The anon grants on statistics / team_members / services are table-level (0011), so the
-- new columns are readable by anon exactly as the rows are — published only, per RLS.
do $$
begin
  if not has_column_privilege('anon', 'public.statistics', 'placement_labels', 'select')
     or not has_column_privilege('anon', 'public.team_members', 'portrait_media_id', 'select')
     or not has_column_privilege('anon', 'public.services', 'short_title', 'select') then
    raise exception '0023: anon cannot read a new public column (a table grant was narrowed?)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'team_members' and policyname = 'team_members_delete_admin'
                  and permissive = 'RESTRICTIVE') then
    raise exception '0023 expects the 0018 admin-only delete gate on team_members';
  end if;
end $$;
