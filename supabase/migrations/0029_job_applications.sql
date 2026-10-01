-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 — Join: job applications (Admin only), the public write limiter, the CV bucket.
-- Forward-only (expand). Depends on 0001, 0009, 0011, 0019.
--
--   job_applications       one row per application from /join and /ar/join. Admin ONLY
--                          (owner decision J6 / UI v2 decision 4): Content Creator, SEO
--                          and Developer see nothing — not even through export-backup,
--                          which already refuses the table (src/lib/admin/backupTables.ts).
--                          Rows are written by the public apply endpoint with the service
--                          role (the anon tenant fence: the tenant is resolved server-side);
--                          no API role may insert.
--   public_write_attempts  the public write limiter's counters (EXC-004): one row per
--                          (scope, hashed key, window). Service role only.
--   storage bucket         `applications`, PRIVATE, ≤ 10 MB, PDF or .docx (owner decisions
--                          J1/J2). No storage policy names it, so anon and authenticated
--                          can neither read nor write an object in it; only the service
--                          role (the apply endpoint, the admin download, the retention
--                          job) touches it. A RESTRICTIVE policy is added as a belt.
--
-- Contact details are ciphertext (`email_enc`, `phone_enc`, AES-256-GCM under a labelled
-- derivation of LEAD_PII_ENC_KEY — src/lib/applications/keys.ts); the CV is stored as
-- uploaded, under the provider's encryption at rest, and leaves only through the audited
-- admin download. Retention is a column set at insert (12 or 24 months by consent); `spam`
-- caps it at 30 days; the Worker's daily cron deletes the CV object, then the row, and
-- sweeps any CV object no row names (`application_orphan_cvs()`, service role only).
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Applications --------------------------------------------------------------
create table if not exists public.job_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  locale text not null default 'en' check (locale in ('en', 'ar')),
  name text not null check (char_length(name) between 1 and 120),
  email_enc text not null,
  phone_enc text not null,
  city text not null check (char_length(city) between 1 and 80),
  role text not null check (char_length(role) between 1 and 120),
  experience text not null check (experience in ('student', '1-3', '3-6', '6-plus')),
  work_type text not null check (work_type in ('full-time', 'freelance', 'internship', 'any')),
  availability text not null check (availability in ('immediately', 'two-weeks', 'month', 'later')),
  skills text[] not null default '{}' check (
    cardinality(skills) <= 16
    and skills <@ array['branding', 'animation', 'motion-graphics', 'videography', 'photography',
                        'montage', 'event-planning', 'advertising', 'social-media',
                        'web-development', 'seo-geo-aeo', 'music', 'merchandise', 'gaming',
                        'copywriting', 'strategy']::text[]
  ),
  portfolio_url text not null check (portfolio_url ~* '^https://' and char_length(portfolio_url) <= 2048),
  linkedin_url text check (linkedin_url is null or (linkedin_url ~* '^https://' and char_length(linkedin_url) <= 2048)),
  message text not null check (char_length(message) between 1 and 4000),
  -- The CV: `<tenant>/<application id>/<random>.<ext>` in the `applications` bucket. Never
  -- the uploaded file name (it is personal data and the path is not encrypted).
  cv_path text check (
    cv_path is null
    or cv_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|docx)$'
  ),
  cv_content_type text check (
    cv_content_type is null
    or cv_content_type in ('application/pdf',
                           'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  ),
  cv_bytes int check (cv_bytes is null or cv_bytes between 1 and 10485760),
  status text not null default 'new'
    check (status in ('new', 'in_review', 'shortlisted', 'declined', 'hired', 'spam')),
  internal_notes text check (internal_notes is null or char_length(internal_notes) <= 5000),
  -- The consent record (J4): when, under which text, and whether future roles were allowed.
  consent_at timestamptz not null default now(),
  consent_version text not null check (consent_version ~ '^\d{4}-\d{2}-\d{2}$'),
  future_roles_consent boolean not null default false,
  retention_delete_after timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint job_applications_cv_shape check (
    (cv_path is null) = (cv_content_type is null) and (cv_path is null) = (cv_bytes is null)
  )
);
create index if not exists job_applications_tenant_status_idx
  on public.job_applications (tenant_id, status, created_at desc);
create index if not exists job_applications_retention_idx
  on public.job_applications (retention_delete_after);
-- One object, one row: erasing one application can never delete another's CV, and the
-- orphan sweep below looks a path up by this index.
create unique index if not exists job_applications_cv_path_key
  on public.job_applications (cv_path) where cv_path is not null;

alter table public.job_applications enable row level security;
alter table public.job_applications force row level security;

drop trigger if exists job_applications_updated_at on public.job_applications;
create trigger job_applications_updated_at before update on public.job_applications
  for each row execute function app.tg_set_updated_at();
drop trigger if exists job_applications_updater on public.job_applications;
create trigger job_applications_updater before update on public.job_applications
  for each row execute function app.tg_set_updater();

-- Marking an application as spam shortens how long it is kept: 30 days from now, or the
-- original horizon if that is sooner. Nothing an admin can do lengthens it — the column is
-- not in the UPDATE grant below, and un-marking spam does not give the time back.
create or replace function app.tg_job_application_spam_retention() returns trigger
  language plpgsql as $$
begin
  if new.status = 'spam' and old.status is distinct from 'spam' then
    new.retention_delete_after := least(old.retention_delete_after, now() + interval '30 days');
  end if;
  return new;
end $$;
revoke all on function app.tg_job_application_spam_retention() from public, anon, authenticated, service_role;
drop trigger if exists job_applications_spam_retention on public.job_applications;
create trigger job_applications_spam_retention before update of status on public.job_applications
  for each row execute function app.tg_job_application_spam_retention();

-- Two layers inside the database, as for the other Admin-only tables (ai_config, 0009):
-- the permissive policy names the tenant and the role; the RESTRICTIVE one makes "Admin
-- only" hold even if a later permissive policy is added by mistake.
drop policy if exists job_applications_admin_all on public.job_applications;
create policy job_applications_admin_all on public.job_applications for all
  using (tenant_id = app.effective_tenant_id() and app.is_admin())
  with check (tenant_id = app.effective_tenant_id() and app.is_admin());
drop policy if exists job_applications_admin_only on public.job_applications;
create policy job_applications_admin_only on public.job_applications
  as restrictive for all
  using (app.is_admin())
  with check (app.is_admin());

-- Stated, never inherited (0011): no anon access at all; staff read, change the review
-- fields and erase; no API role inserts (the apply endpoint uses the service role).
revoke all on public.job_applications from public, anon, authenticated;
grant select, delete on public.job_applications to authenticated;
grant update (status, internal_notes) on public.job_applications to authenticated;
grant select, insert, update, delete on public.job_applications to service_role;

-- ---- The public write limiter (EXC-004) ----------------------------------------
-- Fixed windows: a counter per (scope, key, window start). Keys are HMACs of the client
-- address or the applicant's e-mail (src/lib/http/publicRateLimit.ts) — the raw value is
-- never stored. Rows older than 48 hours are deleted by the Worker's daily cron.
create table if not exists public.public_write_attempts (
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  scope text not null check (scope ~ '^[a-z][a-z0-9_.:-]{0,40}$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  count int not null default 1 check (count >= 1),
  primary key (tenant_id, scope, key_hash, window_start)
);
create index if not exists public_write_attempts_window_idx
  on public.public_write_attempts (window_start);
alter table public.public_write_attempts enable row level security;
alter table public.public_write_attempts force row level security;
-- No policies: the service role is the only reader and writer.
revoke all on public.public_write_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.public_write_attempts to service_role;

-- One atomic step: count this attempt and return the count for its window. SECURITY
-- INVOKER (it runs with the service role's own rights) and executable by the service role
-- only — it is in `public` because PostgREST exposes no other schema.
create or replace function public.public_write_hit(
  p_tenant uuid, p_scope text, p_key_hash text, p_window_seconds int
) returns int
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_window timestamptz;
  v_count int;
begin
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 604800 then
    raise exception 'public_write_hit: window out of range' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.public_write_attempts as a (tenant_id, scope, key_hash, window_start, count)
  values (p_tenant, p_scope, p_key_hash, v_window, 1)
  on conflict (tenant_id, scope, key_hash, window_start)
    do update set count = a.count + 1
  returning a.count into v_count;
  return v_count;
end $$;
revoke all on function public.public_write_hit(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.public_write_hit(uuid, text, text, int) to service_role;

-- ---- Orphaned CVs -----------------------------------------------------------------------
-- A CV object no application row names: the Worker stopped between the upload and the
-- insert (a CPU-limit kill, a deploy mid-request), both the insert and its compensating
-- delete failed, or a row went another way (a tenant deleted). Retention works from rows,
-- so such a file would otherwise be kept forever. The Worker's daily job asks this
-- function for them — older than a grace period, so an upload whose insert is still in
-- flight is never one — and deletes them through the Storage API (a SQL delete on
-- storage.objects would leave the file). Service role only; SECURITY INVOKER, so it reads
-- what its caller may read and nothing more. PL/pgSQL: `storage` is resolved when the
-- function runs, not when it is created (bare Postgres and the PGlite replay have none).
create or replace function public.application_orphan_cvs(p_older_than_minutes int, p_limit int)
returns table (object_name text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_older_than_minutes is null or p_older_than_minutes < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'application_orphan_cvs: argument out of range' using errcode = '22023';
  end if;
  return query
    select o.name
      from storage.objects o
     where o.bucket_id = 'applications'
       and o.created_at < now() - make_interval(mins => p_older_than_minutes)
       and not exists (select 1 from public.job_applications a where a.cv_path = o.name)
     order by o.created_at
     limit p_limit;
end
$$;
revoke all on function public.application_orphan_cvs(int, int) from public, anon, authenticated;
grant execute on function public.application_orphan_cvs(int, int) to service_role;

-- ---- The CV bucket ------------------------------------------------------------------
-- Guarded: bare Postgres (and the local PGlite replay) has no `storage` schema. On
-- Supabase it always exists, so this branch always runs there, and the postcondition below
-- refuses a migration that left the bucket public.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise warning '0029: storage.buckets absent — skipping the applications bucket (expected ONLY outside Supabase)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('applications', 'applications', false, 10485760,
          array['application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- The belt: a RESTRICTIVE policy that no permissive storage policy added later (for some
  -- other bucket) can widen to this one. Creating a policy on storage.objects needs its
  -- owner's rights; if this project's migration role lacks them, the bucket is still
  -- unreachable to anon/authenticated (no policy names it) — say so, do not fail the push.
  begin
    execute 'drop policy if exists applications_bucket_service_only on storage.objects';
    execute $p$
      create policy applications_bucket_service_only on storage.objects
        as restrictive for all to anon, authenticated
        using (bucket_id <> 'applications')
        with check (bucket_id <> 'applications')
    $p$;
  exception when insufficient_privilege then
    raise warning '0029: not permitted to add the storage.objects belt policy; the private bucket with no policy naming it still denies anon and authenticated';
  end;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['job_applications', 'public_write_attempts'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = ('public.' || t)::regclass) then
      raise exception '0029: % must have RLS enabled and forced', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') then
      raise exception '0029: anon has a privilege on %', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.job_applications', 'insert') then
    raise exception '0029: authenticated may insert job_applications (only the service role writes them)';
  end if;
  if has_column_privilege('authenticated', 'public.job_applications', 'retention_delete_after', 'update')
     or has_column_privilege('authenticated', 'public.job_applications', 'email_enc', 'update') then
    raise exception '0029: authenticated may update a column outside status/internal_notes';
  end if;
  if has_table_privilege('authenticated', 'public.public_write_attempts', 'select') then
    raise exception '0029: authenticated can read the limiter';
  end if;
  if has_function_privilege('anon', 'public.public_write_hit(uuid, text, text, int)', 'execute')
     or has_function_privilege('authenticated', 'public.public_write_hit(uuid, text, text, int)', 'execute') then
    raise exception '0029: an API role other than service_role can execute public_write_hit';
  end if;
  if has_function_privilege('anon', 'public.application_orphan_cvs(int, int)', 'execute')
     or has_function_privilege('authenticated', 'public.application_orphan_cvs(int, int)', 'execute') then
    raise exception '0029: an API role other than service_role can execute application_orphan_cvs';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'job_applications' and policyname = 'job_applications_admin_only'
                  and permissive = 'RESTRICTIVE') then
    raise exception '0029: the RESTRICTIVE admin-only policy is missing';
  end if;
  if to_regclass('storage.buckets') is not null then
    if not exists (select 1 from storage.buckets where id = 'applications' and public = false) then
      raise exception '0029: the applications bucket is missing or public';
    end if;
  end if;
end $$;
