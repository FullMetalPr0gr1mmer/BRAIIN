-- 0005 — About-page entities: certifications + statistics (stat counters).
-- CLAUDE.md §8 lists both as v1 schema entities; they land with the About page (KAN-30).
-- Forward-only. Same tenant + RLS pattern as every other content table: ENABLE + FORCE,
-- tenant-scoped read (published OR staff), write gated to content authors.

-- ---- Certifications --------------------------------------------------------
create table public.certifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  name jsonb not null,                  -- {en, ar}
  issuer jsonb,                         -- {en, ar}
  year int,
  logo_url text,
  status content_status not null default 'draft',
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
alter table public.certifications enable row level security;
alter table public.certifications force row level security;
create trigger certifications_updated_at before update on public.certifications
  for each row execute function app.tg_set_updated_at();
create policy certifications_read on public.certifications for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy certifications_write on public.certifications for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());

-- ---- Statistics (stat counters) --------------------------------------------
create table public.statistics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  slug citext not null,
  label jsonb not null,                 -- {en, ar}
  value text not null,                  -- display string, e.g. '150+' (keeps '+', '%', 'x')
  status content_status not null default 'draft',
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (tenant_id, slug)
);
alter table public.statistics enable row level security;
alter table public.statistics force row level security;
create trigger statistics_updated_at before update on public.statistics
  for each row execute function app.tg_set_updated_at();
create policy statistics_read on public.statistics for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
create policy statistics_write on public.statistics for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
