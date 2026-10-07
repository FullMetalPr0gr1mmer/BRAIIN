-- 0032 — History is written by the snapshot trigger only (hotfix H6, Admin v2 verification).
--
-- THE DEFECT. `authenticated` holds INSERT on public.content_versions (0011), and two
-- permissive insert policies admit any staff JWT (0001 `content_versions_write`,
-- can_write_content; 0009 `content_versions_insert_staff`, is_staff). So any Admin,
-- Content Creator, SEO or Developer could POST /rest/v1/content_versions with any
-- entity_type, entity_id, version, snapshot AND created_by: invented history, attributed
-- to anyone. Nothing reads history yet, but the release track's "Restore vN" (R10) will
-- stage it as content, and created_by is the "who changed this" record.
--
-- THE FIX, in both server layers:
--   1. GRANT: revoke INSERT (and every other write) from the API roles.
--   2. RLS: the two insert policies applied to PUBLIC, so every staff JWT passed them.
--      They are replaced by ONE policy for the role that owns app.tg_snapshot_version(),
--      the only legitimate writer (0009, SECURITY DEFINER, so it inserts as its owner).
--      content_versions is FORCE RLS, so that owner is policy-checked unless it holds
--      BYPASSRLS (0009's note); the policy keeps 0009's staff check, which reads the
--      request's JWT, so the trigger keeps working for every staff write. No insert
--      policy names anon or authenticated, so RLS refuses a direct insert on its own,
--      even if a later grant restored the privilege.
-- Reading history is unchanged (staff only).
--
-- Stated for both Supabase grant regimes (Admin v2 P-14): nothing else for anon or
-- authenticated, whatever the default privileges were.
--
-- CLAUDE.md §3 (Pillar 1), §8 (one polymorphic content_versions).

revoke insert, update, delete, truncate, references, trigger
  on public.content_versions from public, anon, authenticated;
grant select on public.content_versions to authenticated;

drop policy content_versions_write on public.content_versions;
drop policy content_versions_insert_staff on public.content_versions;
do $$
declare
  v_owner name;
begin
  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'tg_snapshot_version';
  if v_owner is null then
    raise exception '0032: app.tg_snapshot_version() not found';
  end if;
  if v_owner in ('anon', 'authenticated', 'public') then
    raise exception '0032: app.tg_snapshot_version() is owned by an API role (%)', v_owner;
  end if;
  execute format(
    'create policy content_versions_insert_snapshot on public.content_versions for insert to %I '
    'with check (tenant_id = app.effective_tenant_id() and app.is_staff())', v_owner);
end $$;

-- ---- Postconditions ----------------------------------------------------------------
do $$
begin
  if has_table_privilege('authenticated', 'public.content_versions', 'insert') then
    raise exception '0032: authenticated can still INSERT history rows';
  end if;
  if has_table_privilege('authenticated', 'public.content_versions', 'update')
     or has_table_privilege('authenticated', 'public.content_versions', 'delete') then
    raise exception '0032: authenticated can UPDATE or DELETE history rows';
  end if;
  if not has_table_privilege('authenticated', 'public.content_versions', 'select') then
    raise exception '0032: staff lost read access to history';
  end if;
  if has_table_privilege('anon', 'public.content_versions', 'select')
     or has_table_privilege('anon', 'public.content_versions', 'insert') then
    raise exception '0032: anon can reach history';
  end if;
  -- The RLS layer on its own: no write policy reaches an API role.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'content_versions'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and roles && array['public', 'anon', 'authenticated']::name[]
  ) then
    raise exception '0032: a write policy on content_versions still applies to an API role';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'content_versions'
         and cmd = 'INSERT') <> 1 then
    raise exception '0032: expected exactly one insert policy (the snapshot owner''s)';
  end if;
  -- The trigger function the snapshots depend on is still a definer.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'tg_snapshot_version' and p.prosecdef
  ) then
    raise exception '0032: app.tg_snapshot_version() is not SECURITY DEFINER; history would stop';
  end if;
end $$;
