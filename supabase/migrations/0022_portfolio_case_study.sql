-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 — Portfolio as a case study: catalogue fields, media, services order, one
-- atomic save. UI v2 PR4a. Forward-only (expand). Depends on 0001, 0007, 0011, 0020, 0021.
--
-- The UI v2 Our Work pages (landing, All projects, case study) need, per project:
--   catalogue   project type, teaser, sector, client, year, featured, a poster and an
--               optional preview clip (the card's hover loop)
--   case study  lead, goal, result, scope list, keywords, result cards, a media set
--               (hero banner, final film, breakdown, gallery) and an explicit "next"
--
-- Children (services, media) are saved with their parent in ONE transaction through
-- `save_portfolio()` — SECURITY INVOKER, so RLS applies to every row it writes — with
-- the optimistic version check. Saving the parent and then replacing children in a
-- second request would leave a half-saved case study whenever the second one failed.
--
-- History: the portfolio snapshot trigger (0009) records the parent row only; children
-- are not versioned in v1 (restoring a version restores the parent's fields).
--
-- `portfolio_services` becomes public for PUBLISHED parents only (the RESTRICTIVE policy
-- below — created BEFORE the anon grant, as 0011 §5 demands); `portfolio_media` the same.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Portfolio columns -------------------------------------------------------
alter table public.portfolio
  add column if not exists project_type jsonb
    check (project_type is null or jsonb_typeof(project_type) = 'object'),
  add column if not exists teaser jsonb check (teaser is null or jsonb_typeof(teaser) = 'object'),
  add column if not exists lead jsonb check (lead is null or jsonb_typeof(lead) = 'object'),
  add column if not exists goal jsonb check (goal is null or jsonb_typeof(goal) = 'object'),
  add column if not exists result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  add column if not exists scope jsonb not null default '[]'::jsonb
    check (jsonb_typeof(scope) = 'array' and jsonb_array_length(scope) <= 10),
  add column if not exists keywords jsonb not null default '[]'::jsonb
    check (jsonb_typeof(keywords) = 'array' and jsonb_array_length(keywords) <= 6),
  add column if not exists results jsonb not null default '[]'::jsonb
    check (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 4),
  add column if not exists sector_id uuid references public.sectors (id) on delete set null,
  add column if not exists client_id uuid references public.clients (id) on delete set null,
  add column if not exists year smallint check (year between 2000 and 2100),
  add column if not exists is_featured boolean not null default false,
  add column if not exists poster_media_id uuid references public.media_assets (id) on delete restrict,
  add column if not exists preview_video_uid text check (preview_video_uid ~ '^[a-f0-9]{32}$'),
  add column if not exists preview_video_path text
    check (preview_video_path ~ '^/media/[a-z0-9][a-z0-9/_-]*\.mp4$'),
  add column if not exists preview_start_s numeric(6, 2),
  add column if not exists preview_end_s numeric(6, 2),
  add column if not exists next_portfolio_id uuid references public.portfolio (id) on delete set null,
  add column if not exists is_placeholder boolean not null default false;

-- The clip rules (VideoClipSchema, packages/schemas/media.ts — EXC-009): at most one
-- source; the window is both-or-neither, end after start, at most 30s.
alter table public.portfolio drop constraint if exists portfolio_preview_one_source;
alter table public.portfolio add constraint portfolio_preview_one_source
  check (preview_video_uid is null or preview_video_path is null);
alter table public.portfolio drop constraint if exists portfolio_preview_window;
alter table public.portfolio add constraint portfolio_preview_window check (
  (preview_start_s is null) = (preview_end_s is null)
  and (preview_start_s is null
       or (preview_start_s >= 0 and preview_end_s > preview_start_s
           and preview_end_s - preview_start_s <= 30))
);
alter table public.portfolio drop constraint if exists portfolio_next_not_self;
alter table public.portfolio add constraint portfolio_next_not_self
  check (next_portfolio_id is null or next_portfolio_id <> id);
-- `/portfolio/all` is the catalogue route: a project may never be called "all".
alter table public.portfolio drop constraint if exists portfolio_slug_not_reserved;
alter table public.portfolio add constraint portfolio_slug_not_reserved
  check (lower(slug::text) <> 'all') not valid;
do $$
begin
  alter table public.portfolio validate constraint portfolio_slug_not_reserved;
exception when check_violation then
  raise warning '0022: portfolio_slug_not_reserved left NOT VALID — a legacy row is slugged "all"; rename it';
end $$;

create index if not exists portfolio_status_order_idx on public.portfolio (tenant_id, status, sort_order);
create index if not exists portfolio_featured_idx
  on public.portfolio (tenant_id, sort_order) where status = 'published' and is_featured;
create index if not exists portfolio_sector_idx on public.portfolio (sector_id);
create index if not exists portfolio_client_idx on public.portfolio (client_id);
create index if not exists portfolio_poster_idx on public.portfolio (poster_media_id);
create index if not exists portfolio_next_idx on public.portfolio (next_portfolio_id);

-- ---- 2. Services, in order, public for published parents -------------------------
alter table public.portfolio_services add column if not exists sort_order int not null default 0;
create index if not exists portfolio_services_service_idx on public.portfolio_services (service_id);
create index if not exists portfolio_services_order_idx
  on public.portfolio_services (portfolio_id, sort_order);

drop policy if exists portfolio_services_published_only on public.portfolio_services;
create policy portfolio_services_published_only on public.portfolio_services
  as restrictive for select
  using (app.is_staff() or exists (
    select 1 from public.portfolio p where p.id = portfolio_id and p.status = 'published'));

-- ---- 3. Case-study media --------------------------------------------------------
create table if not exists public.portfolio_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  portfolio_id uuid not null references public.portfolio (id) on delete cascade,
  role text not null check (role in ('hero', 'final', 'breakdown', 'gallery')),
  kind text not null check (kind in ('image', 'video')),
  -- The image, or the video's poster.
  media_id uuid references public.media_assets (id) on delete restrict,
  video_uid text check (video_uid ~ '^[a-f0-9]{32}$'),
  video_path text check (video_path ~ '^/media/[a-z0-9][a-z0-9/_-]*\.mp4$'),
  clip_start_s numeric(6, 2),
  clip_end_s numeric(6, 2),
  duration_label text check (duration_label ~ '^[0-9]{1,2}:[0-5][0-9]$'),
  caption jsonb check (caption is null or jsonb_typeof(caption) = 'object'),
  breakdown_kind text check (breakdown_kind in ('sketch', 'bts', 'process')),
  layout text check (layout in ('half', 'wide', 'third')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint portfolio_media_breakdown_kind check ((role = 'breakdown') = (breakdown_kind is not null)),
  constraint portfolio_media_image_shape check (
    kind <> 'image' or (media_id is not null and video_uid is null and video_path is null
                        and clip_start_s is null and clip_end_s is null)),
  constraint portfolio_media_video_source check (
    kind <> 'video' or ((video_uid is null) <> (video_path is null))),
  constraint portfolio_media_window check (
    (clip_start_s is null) = (clip_end_s is null)
    and (clip_start_s is null
         or (clip_start_s >= 0 and clip_end_s > clip_start_s and clip_end_s - clip_start_s <= 30)))
);
create unique index if not exists portfolio_media_one_hero
  on public.portfolio_media (portfolio_id) where role = 'hero';
create unique index if not exists portfolio_media_one_final
  on public.portfolio_media (portfolio_id) where role = 'final';
create index if not exists portfolio_media_order_idx
  on public.portfolio_media (portfolio_id, role, sort_order);
create index if not exists portfolio_media_asset_idx on public.portfolio_media (media_id);

alter table public.portfolio_media enable row level security;
alter table public.portfolio_media force row level security;
drop trigger if exists portfolio_media_updated_at on public.portfolio_media;
create trigger portfolio_media_updated_at before update on public.portfolio_media
  for each row execute function app.tg_set_updated_at();
drop trigger if exists portfolio_media_actor on public.portfolio_media;
create trigger portfolio_media_actor before insert or update on public.portfolio_media
  for each row execute function app.tg_set_actor();

drop policy if exists portfolio_media_read on public.portfolio_media;
create policy portfolio_media_read on public.portfolio_media for select
  using (tenant_id = app.effective_tenant_id() and (app.is_staff() or exists (
    select 1 from public.portfolio p where p.id = portfolio_id and p.status = 'published')));
drop policy if exists portfolio_media_write on public.portfolio_media;
create policy portfolio_media_write on public.portfolio_media for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content()
              and exists (select 1 from public.portfolio p
                           where p.id = portfolio_id and p.tenant_id = app.effective_tenant_id()));
-- No RESTRICTIVE delete: media rows are part of the case study, replaced as a set by
-- save_portfolio() (Content Creator authors case studies, §5).

-- ---- 4. Grants (stated — 0011 §5) ------------------------------------------------
revoke all on public.portfolio_media from anon, authenticated;
grant select on public.portfolio_services, public.portfolio_media to anon;
grant select, insert, update, delete on public.portfolio_media to authenticated;

-- ---- 5. save_portfolio(): parent + children, one transaction ---------------------
-- p_id null creates. p_values: the portfolio columns to set (keys outside the allow-list
-- below are ignored). p_service_ids / p_media: the complete ordered child sets, or null
-- to leave that set untouched. Version conflicts raise 40001 (the route answers 409);
-- a missing row raises P0002 (404). Every id it links must be visible to the caller in
-- its own tenant — a foreign key alone would accept another tenant's row.
create or replace function public.save_portfolio(
  p_id uuid,
  p_version int,
  p_values jsonb,
  p_service_ids uuid[] default null,
  p_media jsonb default null
) returns table (id uuid, version int)
  language plpgsql security invoker set search_path = public, app, pg_temp as $$
declare
  v_row public.portfolio;
  v_new public.portfolio;
  v_patch jsonb;
  v_tenant uuid := app.effective_tenant_id();
begin
  if not app.can_write_content() then
    raise exception 'writing case studies needs portfolio.write' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'p_values must be an object' using errcode = '22023';
  end if;
  -- The writable columns. Identity, tenancy, versioning, audit and generated columns can
  -- never be set through this function.
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_patch
    from jsonb_each(p_values)
   where key = any (array[
     'slug', 'title', 'summary', 'body', 'body_html', 'status', 'sort_order', 'published_at',
     'scheduled_for', 'project_type', 'teaser', 'lead', 'goal', 'result', 'scope',
     'keywords', 'results', 'sector_id', 'client_id', 'year', 'is_featured',
     'poster_media_id', 'preview_video_uid', 'preview_video_path', 'preview_start_s',
     'preview_end_s', 'next_portfolio_id', 'is_placeholder']);

  -- Linked rows must exist in the caller's tenant, as the caller can see them.
  if (v_patch ? 'sector_id' and v_patch ->> 'sector_id' is not null and not exists (
        select 1 from public.sectors s where s.id = (v_patch ->> 'sector_id')::uuid and s.tenant_id = v_tenant))
     or (v_patch ? 'client_id' and v_patch ->> 'client_id' is not null and not exists (
        select 1 from public.clients c where c.id = (v_patch ->> 'client_id')::uuid and c.tenant_id = v_tenant))
     or (v_patch ? 'poster_media_id' and v_patch ->> 'poster_media_id' is not null and not exists (
        select 1 from public.media_assets m where m.id = (v_patch ->> 'poster_media_id')::uuid and m.tenant_id = v_tenant))
     or (v_patch ? 'next_portfolio_id' and v_patch ->> 'next_portfolio_id' is not null and not exists (
        select 1 from public.portfolio q where q.id = (v_patch ->> 'next_portfolio_id')::uuid and q.tenant_id = v_tenant))
  then
    raise exception 'a linked record does not exist' using errcode = '23503';
  end if;

  if p_id is null then
    -- One INSERT, so a create is one version and one content_versions snapshot. Columns
    -- the patch omits take the table defaults (jsonb_populate_record would give NULL).
    v_new := jsonb_populate_record(null::public.portfolio,
      jsonb_build_object('status', 'draft', 'sort_order', 0, 'scope', '[]'::jsonb,
                         'keywords', '[]'::jsonb, 'results', '[]'::jsonb,
                         'is_featured', false, 'is_placeholder', false) || v_patch);
    insert into public.portfolio (
      slug, title, summary, body, body_html, status, sort_order, published_at, scheduled_for,
      project_type, teaser, lead, goal, result, scope, keywords, results, sector_id, client_id,
      year, is_featured, poster_media_id, preview_video_uid, preview_video_path,
      preview_start_s, preview_end_s, next_portfolio_id, is_placeholder
    ) values (
      v_new.slug, v_new.title, v_new.summary, v_new.body, v_new.body_html, v_new.status,
      v_new.sort_order, v_new.published_at, v_new.scheduled_for, v_new.project_type,
      v_new.teaser, v_new.lead, v_new.goal, v_new.result, v_new.scope, v_new.keywords,
      v_new.results, v_new.sector_id, v_new.client_id, v_new.year, v_new.is_featured,
      v_new.poster_media_id, v_new.preview_video_uid, v_new.preview_video_path,
      v_new.preview_start_s, v_new.preview_end_s, v_new.next_portfolio_id, v_new.is_placeholder
    ) returning * into v_new;
  else
    select * into v_row from public.portfolio p
     where p.tenant_id = v_tenant and p.id = p_id
       for update;
    if not found then
      raise exception 'portfolio % not found', p_id using errcode = 'P0002';
    end if;
    -- A missing version is a stale one: an update without the lock token would be the
    -- last-write-wins save optimistic locking exists to prevent.
    if p_version is null or v_row.version <> p_version then
      raise exception 'portfolio % was modified by someone else', p_id using errcode = '40001';
    end if;

    -- The stored row with the patch laid over it: keys absent from the patch keep their
    -- stored values (jsonb_populate_record reads unmatched columns from its base).
    v_new := jsonb_populate_record(v_row, v_patch);

    update public.portfolio p set
      slug = v_new.slug, title = v_new.title, summary = v_new.summary, body = v_new.body,
      body_html = v_new.body_html, status = v_new.status, sort_order = v_new.sort_order,
      published_at = v_new.published_at, scheduled_for = v_new.scheduled_for,
      project_type = v_new.project_type, teaser = v_new.teaser, lead = v_new.lead,
      goal = v_new.goal, result = v_new.result, scope = v_new.scope,
      keywords = v_new.keywords, results = v_new.results, sector_id = v_new.sector_id,
      client_id = v_new.client_id, year = v_new.year, is_featured = v_new.is_featured,
      poster_media_id = v_new.poster_media_id, preview_video_uid = v_new.preview_video_uid,
      preview_video_path = v_new.preview_video_path, preview_start_s = v_new.preview_start_s,
      preview_end_s = v_new.preview_end_s, next_portfolio_id = v_new.next_portfolio_id,
      is_placeholder = v_new.is_placeholder
     where p.tenant_id = v_tenant and p.id = v_row.id
    returning * into v_new;
    if not found then
      -- RLS filtered the UPDATE: an authorization outcome, not a missing row.
      raise exception 'the database refused the portfolio write' using errcode = '42501';
    end if;
  end if;

  if p_service_ids is not null then
    if exists (select 1 from unnest(p_service_ids) as s(sid)
                where not exists (select 1 from public.services sv
                                   where sv.id = s.sid and sv.tenant_id = v_tenant)) then
      raise exception 'a linked service does not exist' using errcode = '23503';
    end if;
    delete from public.portfolio_services ps where ps.portfolio_id = v_new.id;
    insert into public.portfolio_services (tenant_id, portfolio_id, service_id, sort_order)
    select v_tenant, v_new.id, s.sid, s.ord - 1
      from unnest(p_service_ids) with ordinality as s(sid, ord);
  end if;

  if p_media is not null then
    if jsonb_typeof(p_media) <> 'array' or jsonb_array_length(p_media) > 40 then
      raise exception 'p_media must be an array of at most 40 items' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_media) as e(item)
                where e.item ->> 'media_id' is not null and not exists (
                  select 1 from public.media_assets m
                   where m.id = (e.item ->> 'media_id')::uuid and m.tenant_id = v_tenant)) then
      raise exception 'a linked media asset does not exist' using errcode = '23503';
    end if;
    delete from public.portfolio_media pm where pm.portfolio_id = v_new.id;
    insert into public.portfolio_media
      (tenant_id, portfolio_id, role, kind, media_id, video_uid, video_path, clip_start_s,
       clip_end_s, duration_label, caption, breakdown_kind, layout, sort_order)
    select v_tenant, v_new.id, e.item ->> 'role', e.item ->> 'kind',
           (e.item ->> 'media_id')::uuid, e.item ->> 'video_uid', e.item ->> 'video_path',
           (e.item ->> 'clip_start_s')::numeric, (e.item ->> 'clip_end_s')::numeric,
           e.item ->> 'duration_label', nullif(e.item -> 'caption', 'null'::jsonb),
           e.item ->> 'breakdown_kind', e.item ->> 'layout', (e.ord - 1)::int
      from jsonb_array_elements(p_media) with ordinality as e(item, ord);
  end if;

  return query select v_new.id, v_new.version;
end $$;
revoke all on function public.save_portfolio(uuid, int, jsonb, uuid[], jsonb) from public, anon, service_role;
grant execute on function public.save_portfolio(uuid, int, jsonb, uuid[], jsonb) to authenticated;

-- ---- 6. Postconditions ----------------------------------------------------------
do $$
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.portfolio_media'::regclass) then
    raise exception 'portfolio_media: RLS must be enabled AND forced';
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'portfolio_services'
       and policyname = 'portfolio_services_published_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'portfolio_services_published_only must exist and be RESTRICTIVE before anon reads it';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'save_portfolio' and p.prosecdef
  ) then
    raise exception 'save_portfolio must be SECURITY INVOKER (RLS applies to every row it writes)';
  end if;
  if has_function_privilege('anon', 'public.save_portfolio(uuid, int, jsonb, uuid[], jsonb)', 'execute') then
    raise exception 'anon can execute save_portfolio';
  end if;
  if has_table_privilege('anon', 'public.portfolio_media', 'insert')
     or has_table_privilege('anon', 'public.portfolio_services', 'insert') then
    raise exception 'anon holds a write privilege on portfolio children';
  end if;
end $$;
