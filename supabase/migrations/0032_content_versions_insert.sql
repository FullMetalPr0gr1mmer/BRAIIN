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
-- THE FIX. Revoke INSERT from the API roles. The only legitimate writer,
-- app.tg_snapshot_version() (0009), is SECURITY DEFINER and writes as the table's owner,
-- whose privileges this does not touch. The insert POLICIES stay: content_versions is
-- FORCE RLS, so the owner itself is policy-checked unless it holds BYPASSRLS (0009's
-- note), and the policies read the request's JWT, so the trigger keeps working for every
-- staff write. Reading history is unchanged (staff only).
--
-- Stated for both Supabase grant regimes (Admin v2 P-14): nothing else for anon or
-- authenticated, whatever the default privileges were.
--
-- CLAUDE.md §3 (Pillar 1), §8 (one polymorphic content_versions).

revoke insert, update, delete, truncate, references, trigger
  on public.content_versions from public, anon, authenticated;
grant select on public.content_versions to authenticated;

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
  -- The trigger function the snapshots depend on is still a definer.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'tg_snapshot_version' and p.prosecdef
  ) then
    raise exception '0032: app.tg_snapshot_version() is not SECURITY DEFINER; history would stop';
  end if;
end $$;
