-- ─────────────────────────────────────────────────────────────────────────────
-- 0021 — Sectors, clients, testimonials. UI v2 PR4a.
-- Forward-only (expand). Depends on 0001, 0009, 0011, 0020.
--
--   sectors       the "Industry" facet of Our Work (Automotive, F&B, Education, …)
--   clients       who a project was for. `visible` IS the public-disclosure permission —
--                 fail-closed (default false): a client appears on the site only once
--                 someone has marked it disclosable. The clients marquee reads the
--                 visible ones flagged `show_in_marquee`.
--   testimonials  quotes on home, Our Work and the case studies. A quote is a real
--                 person's words about a real engagement: it cannot be published or
--                 scheduled without recorded consent — a CHECK, so no write path
--                 (admin, PostgREST, seed, service role) can skip it — and the consent
--                 record itself is never readable by anon (column-level grant).
--
-- Same authorization shape as the other content tables (Admin + Content Creator write,
-- §5), with RESTRICTIVE admin-only delete, and archive for the table with a status.
-- `is_placeholder` marks seeded design content; 0025 stops a placeholder going live in
-- production.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Sectors ------------------------------------------------------------------
create table if not exists public.sectors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name jsonb not null check (jsonb_typeof(name) = 'object' and name ? 'en' and name ? 'ar'),
  visible boolean not null default true,
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);

-- ---- Clients ------------------------------------------------------------------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name jsonb not null check (jsonb_typeof(name) = 'object' and name ? 'en' and name ? 'ar'),
  logo_media_id uuid references public.media_assets (id) on delete restrict,
  -- Length checked apart from the pattern: Postgres regex bounds stop at 255 ({4,300} would
  -- compile-fail on the first non-null value, not at CREATE TABLE).
  website_url text check (char_length(website_url) <= 300 and website_url ~ '^https://[^[:space:]]{4,}$'),
  show_in_marquee boolean not null default false,
  visible boolean not null default false,
  is_placeholder boolean not null default false,
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
create index if not exists clients_marquee_idx
  on public.clients (tenant_id, sort_order) where show_in_marquee and visible;
create index if not exists clients_logo_idx on public.clients (logo_media_id);

-- ---- Testimonials -------------------------------------------------------------
create table if not exists public.testimonials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  quote jsonb not null check (jsonb_typeof(quote) = 'object' and quote ? 'en' and quote ? 'ar'),
  author_name jsonb not null
    check (jsonb_typeof(author_name) = 'object' and author_name ? 'en' and author_name ? 'ar'),
  -- "Title, Company" verbatim — there is no company column (plan: testimonials).
  author_role jsonb check (author_role is null or jsonb_typeof(author_role) = 'object'),
  client_id uuid references public.clients (id) on delete set null,
  portfolio_id uuid references public.portfolio (id) on delete set null,
  avatar_media_id uuid references public.media_assets (id) on delete restrict,
  placements text[] not null default '{}' check (placements <@ array['home', 'work']::text[]),
  consent_obtained_at timestamptz,
  consent_reference text check (char_length(consent_reference) <= 200),
  status content_status not null default 'draft',
  published_at timestamptz,
  scheduled_for timestamptz,
  sort_order int not null default 0,
  is_placeholder boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug),
  constraint testimonials_consent_gate
    check (status not in ('published', 'scheduled') or consent_obtained_at is not null)
);
-- One live-or-queued quote per case study (the case-study page shows exactly one).
-- Scheduled counts too: a second quote scheduled behind a published one would otherwise
-- hit this index only when app.publish_scheduled() flips it — aborting the whole cron run,
-- services/blog/portfolio/pages included, every five minutes. Now it is refused (409) at
-- the moment it is scheduled.
create unique index if not exists testimonials_one_per_project
  on public.testimonials (portfolio_id)
  where portfolio_id is not null and status in ('published', 'scheduled');
create index if not exists testimonials_scheduled_idx
  on public.testimonials (tenant_id, scheduled_for) where status = 'scheduled';
create index if not exists testimonials_client_idx on public.testimonials (client_id);
create index if not exists testimonials_avatar_idx on public.testimonials (avatar_media_id);

-- ---- RLS, triggers ------------------------------------------------------------
do $$
declare
  t text;
  entity text;
begin
  for t, entity in values ('sectors', 'sector'), ('clients', 'client'), ('testimonials', 'testimonial') loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function app.tg_set_updated_at()', t || '_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_actor', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function app.tg_set_actor()', t || '_actor', t);
    execute format('drop trigger if exists %I on public.%I', t || '_version', t);
    execute format('create trigger %I before update on public.%I for each row execute function app.tg_bump_version()', t || '_version', t);
    execute format('drop trigger if exists %I on public.%I', t || '_snapshot', t);
    execute format('create trigger %I after insert or update on public.%I for each row execute function app.tg_snapshot_version(%L)', t || '_snapshot', t, entity);
  end loop;
end $$;

-- Reads: anon sees what is public (visible sectors/clients, published testimonials);
-- staff see their whole tenant. Writes: content authors. Delete: Admin only.
drop policy if exists sectors_read on public.sectors;
create policy sectors_read on public.sectors for select
  using (tenant_id = app.effective_tenant_id() and (visible or app.is_staff()));
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select
  using (tenant_id = app.effective_tenant_id() and (visible or app.is_staff()));
drop policy if exists testimonials_read on public.testimonials;
create policy testimonials_read on public.testimonials for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));

do $$
declare
  t text;
begin
  foreach t in array array['sectors', 'clients', 'testimonials'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format(
      'create policy %I on public.%I for all
         using (tenant_id = app.effective_tenant_id() and app.can_write_content())
         with check (tenant_id = app.effective_tenant_id() and app.can_write_content())',
      t || '_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_admin', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete
         using (tenant_id = app.effective_tenant_id() and app.is_admin())',
      t || '_delete_admin', t);
  end loop;
end $$;

drop policy if exists testimonials_archive_admin on public.testimonials;
create policy testimonials_archive_admin on public.testimonials
  as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (app.is_admin() or status <> 'archived');

-- ---- Grants (stated, never inherited — 0011 §5) -------------------------------
revoke all on public.sectors, public.clients, public.testimonials from anon, authenticated;
grant select on public.sectors, public.clients to anon;
-- Column list: never consent_obtained_at / consent_reference / scheduled_for / is_placeholder.
grant select (id, tenant_id, slug, quote, author_name, author_role, client_id, portfolio_id,
              avatar_media_id, placements, status, sort_order, published_at, updated_at)
  on public.testimonials to anon;
grant select, insert, update, delete on public.sectors, public.clients, public.testimonials
  to authenticated;

-- ---- Legacy partner logos → hidden clients --------------------------------------
-- The marquee moves to `clients` (PR7). Existing partner names are carried over HIDDEN:
-- their Arabic name and disclosure permission are unknown, so an editor confirms both
-- before anything appears. Idempotent by a slug derived from the old row's id.
insert into public.clients (tenant_id, slug, name, show_in_marquee, visible, is_placeholder, sort_order)
select p.tenant_id,
       'legacy-' || substr(md5(p.id::text), 1, 8),
       jsonb_build_object('en', p.name, 'ar', p.name),
       true, false, false, p.sort_order
  from public.partner_logos p
on conflict (tenant_id, slug) do nothing;

-- ---- Scheduled publishing: testimonials join the cron ---------------------------
-- Each table is its own sub-transaction: one table whose rows cannot be published (a
-- constraint an editor managed to trip) is logged and skipped, and never stops the others
-- from going live on time.
create or replace function app.publish_scheduled() returns int
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  n int := 0;
  c int;
  t text;
begin
  foreach t in array array['services', 'blog_posts', 'portfolio', 'pages', 'testimonials'] loop
    begin
      -- testimonials: consent is already guaranteed — the CHECK refuses a scheduled row
      -- without it.
      execute format(
        'update public.%I set status = ''published'', published_at = coalesce(published_at, now())
          where status = ''scheduled'' and scheduled_for is not null and scheduled_for <= now()', t);
      get diagnostics c = row_count;
      n := n + c;
    exception when others then
      raise warning 'publish_scheduled: % skipped (%: %)', t, sqlstate, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke all on function app.publish_scheduled() from public, anon, authenticated, service_role;

-- ---- Postconditions ----------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['sectors', 'clients', 'testimonials'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = format('public.%I', t)::regclass) then
      raise exception '%: RLS must be enabled AND forced', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                    and policyname = t || '_delete_admin' and permissive = 'RESTRICTIVE') then
      raise exception '%: the admin-only delete gate is missing or not RESTRICTIVE', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'insert')
       or has_table_privilege('anon', format('public.%I', t), 'update')
       or has_table_privilege('anon', format('public.%I', t), 'delete') then
      raise exception '%: anon holds a write privilege', t;
    end if;
  end loop;
  if has_column_privilege('anon', 'public.testimonials', 'consent_reference', 'select')
     or has_column_privilege('anon', 'public.testimonials', 'consent_obtained_at', 'select') then
    raise exception 'anon can read testimonial consent records';
  end if;
  if not has_column_privilege('anon', 'public.testimonials', 'quote', 'select') then
    raise exception 'anon cannot read published testimonial quotes';
  end if;
end $$;
