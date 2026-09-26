-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — Public identity singleton (`site_profile`) + the nav "key" link.
-- Forward-only (expand). Depends on 0001, 0009, 0011. UI v2 PR1.
--
-- WHY A NEW TABLE, not `site_settings.identity`:
--   The brand name, contact email, WhatsApp number, city and social handles render on
--   EVERY public page (header, footer, contact channels, Organization JSON-LD). Public
--   loaders read with the anon key under RLS (CLAUDE.md §8), but `site_settings` is
--   staff-read-only and also holds technical keys (notify_lead_url, maintenance,
--   retention) that must never be public. RLS is row-level, not column-level, so the
--   split has to be a table — the same rule the Phase-3 amendment applied to
--   site_integrations / seo_defaults / entity_seo. `site_settings.identity` keeps its
--   technical keys; everything a visitor sees moves here.
--
--   The owner renamed the public brand to "Braiin Statiion" (UI v2 decision 1) while the
--   domain stays braiinstation.com. With the brand in data, the next rename is an edit,
--   not a deploy.
--
-- CAPABILITY: §5 "General settings (identity, footer, localization)" — Admin + Developer
-- write; everyone (incl. anon) reads.
--
-- ONE COLUMN IS NARROWER: `accepting_applications` opens or closes the public job
-- application form. Job applications are Admin-only HR data (UI v2 decision 4), so a
-- Developer — who may edit the rest of this row — must not be able to open intake. RLS is
-- row-level, so this is a BEFORE trigger: it raises 42501 when a JWT whose role is not
-- `admin` changes the flag. Requests with no role claim are exempt — migrations, seeds,
-- psql and service_role carry none, and a signed-in session with no role is already
-- refused by the write policy. (It inspects the claim directly: app.current_role()
-- defaults to 'anon' and cannot tell "no JWT" from "anon JWT".)
--
-- `navigation.is_key`: the design keeps exactly one header link visible at ≤900px
-- ("Contact us"). One per location, enforced by a partial unique index.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.site_profile (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  brand_name jsonb not null
    check (jsonb_typeof(brand_name) = 'object' and brand_name ? 'en' and brand_name ? 'ar'),
  -- The registered legal entity, for the privacy notice / terms. Null until the owner
  -- supplies it; legal copy falls back to the brand name.
  legal_name jsonb check (legal_name is null or jsonb_typeof(legal_name) = 'object'),
  contact_email citext not null
    check (char_length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- E.164. Null = the WhatsApp contact card is not rendered at all (a placeholder number
  -- on the one page whose job is being reachable is worse than one fewer card).
  whatsapp_e164 text check (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_display text check (char_length(whatsapp_display) <= 32),
  location jsonb not null
    check (jsonb_typeof(location) = 'object' and location ? 'en' and location ? 'ar'),
  address_locality jsonb check (address_locality is null or jsonb_typeof(address_locality) = 'object'),
  address_country text not null default 'SA' check (address_country ~ '^[A-Z]{2}$'),
  founded_year smallint check (founded_year between 1900 and 2100),
  socials jsonb not null default '[]'::jsonb
    check (jsonb_typeof(socials) = 'array' and jsonb_array_length(socials) <= 8),
  accepting_applications boolean not null default false,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint site_profile_whatsapp_display_needs_number
    check (whatsapp_display is null or whatsapp_e164 is not null)
);
alter table public.site_profile enable row level security;
alter table public.site_profile force row level security;

drop trigger if exists site_profile_updated_at on public.site_profile;
create trigger site_profile_updated_at before update on public.site_profile
  for each row execute function app.tg_set_updated_at();
drop trigger if exists site_profile_version on public.site_profile;
create trigger site_profile_version before update on public.site_profile
  for each row execute function app.tg_bump_version();
drop trigger if exists site_profile_updater on public.site_profile;
create trigger site_profile_updater before insert or update on public.site_profile
  for each row execute function app.tg_set_updater();

-- Public read (it IS the public identity), tenant-scoped like everything else.
drop policy if exists site_profile_read on public.site_profile;
create policy site_profile_read on public.site_profile for select
  using (tenant_id = app.effective_tenant_id());
-- General settings: Admin + Developer. Singleton: insert (first save) + update, never delete.
drop policy if exists site_profile_insert on public.site_profile;
create policy site_profile_insert on public.site_profile for insert
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));
drop policy if exists site_profile_update on public.site_profile;
create policy site_profile_update on public.site_profile for update
  using (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'))
  with check (tenant_id = app.effective_tenant_id() and app.current_role() in ('admin', 'developer'));

-- ---- accepting_applications: Admin only ---------------------------------------
create or replace function app.tg_site_profile_guard() returns trigger
  language plpgsql as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb
                   #>> '{app_metadata,role}';
  v_before boolean := case when tg_op = 'UPDATE' then old.accepting_applications else false end;
begin
  if v_role is not null and v_role <> 'admin'
     and new.accepting_applications is distinct from v_before then
    raise exception 'only an admin may open or close job applications'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function app.tg_site_profile_guard() from public, anon, authenticated, service_role;

drop trigger if exists site_profile_guard on public.site_profile;
create trigger site_profile_guard before insert or update on public.site_profile
  for each row execute function app.tg_site_profile_guard();

-- ---- Grants (stated, never inherited — 0011 §5) -------------------------------
revoke all on public.site_profile from anon, authenticated;
grant select on public.site_profile to anon;
grant select, insert, update on public.site_profile to authenticated;

-- ---- navigation.is_key --------------------------------------------------------
alter table public.navigation add column if not exists is_key boolean not null default false;
create unique index if not exists navigation_one_key_per_location
  on public.navigation (tenant_id, location) where is_key;

-- ---- Postconditions -----------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.site_profile'::regclass) then
    raise exception 'site_profile must have RLS enabled AND forced';
  end if;
  if not has_table_privilege('anon', 'public.site_profile', 'select') then
    raise exception 'anon cannot read site_profile — every public page would lose its identity';
  end if;
  if has_table_privilege('anon', 'public.site_profile', 'insert')
     or has_table_privilege('anon', 'public.site_profile', 'update')
     or has_table_privilege('anon', 'public.site_profile', 'delete') then
    raise exception 'anon holds a write privilege on site_profile';
  end if;
  if has_table_privilege('authenticated', 'public.site_profile', 'delete') then
    raise exception 'authenticated can delete the site_profile singleton';
  end if;
  if has_function_privilege('anon', 'app.tg_site_profile_guard()', 'execute')
     or has_function_privilege('authenticated', 'app.tg_site_profile_guard()', 'execute') then
    raise exception 'app.tg_site_profile_guard() is executable by an API role';
  end if;

  -- The whole anon surface, re-asserted with this migration's additions (0011 §6d is the
  -- original; it only runs when 0011 does). Anything else anon can touch is a leak.
  select string_agg(format('%s: %s', c.relname, p.priv), ', ' order by c.relname, p.priv)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('select'), ('insert'), ('update'), ('delete'),
                       ('truncate'), ('references'), ('trigger')) p(priv)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege('anon', c.oid, p.priv)
     and not (
       p.priv = 'select'
       and c.relname in ('categories', 'services', 'blog_posts', 'portfolio', 'pages',
                         'team_members', 'certifications', 'statistics', 'partner_logos',
                         'navigation', 'entity_seo', 'seo_defaults',
                         'ai_questions', 'ai_styles',
                         -- 0016 / 0019
                         'page_sections', 'site_profile')
     );
  if v_bad is not null then
    raise exception 'anon holds privileges outside the SELECT allowlist: %', v_bad;
  end if;
end $$;
