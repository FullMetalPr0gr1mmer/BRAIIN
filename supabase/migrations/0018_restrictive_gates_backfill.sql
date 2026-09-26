-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 — Archive/delete gates for the five content tables 0007 missed.
-- Forward-only (expand). Depends on 0001, 0005, 0007, 0009. UI v2 PR1.
--
-- CLAUDE.md §3: "Publish/archive/delete gated by RESTRICTIVE RLS, not hidden buttons";
-- §5: "Archive / delete content — Admin" only. 0007 brought portfolio, pages,
-- page_sections and media to that rule. These five still carry a single FOR ALL
-- `can_write_content()` policy, so a Content Creator can DELETE or archive them straight
-- through PostgREST — only assertCap() in the Worker stops it: one layer, not two.
--
--   team_members    delete + archive   (has status)
--   certifications  delete + archive   (has status)
--   statistics      delete + archive   (has status)
--   categories      delete             (no status column)
--   partner_logos   delete             (no status column)
--
-- Same mechanism as 0007: restrictive policies AND with the permissive write policy.
-- DELETE by a non-admin FILTERS (0 rows, no error); an archive by a non-admin FAILS the
-- WITH CHECK (42501). Behaviour-preserving for the app — every delete/archive route
-- already asserts `content.archiveDelete`, which only Admin holds.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- DELETE → admin only -----------------------------------------------------
drop policy if exists team_members_delete_admin on public.team_members;
create policy team_members_delete_admin on public.team_members
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

drop policy if exists certifications_delete_admin on public.certifications;
create policy certifications_delete_admin on public.certifications
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

drop policy if exists statistics_delete_admin on public.statistics;
create policy statistics_delete_admin on public.statistics
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

drop policy if exists categories_delete_admin on public.categories;
create policy categories_delete_admin on public.categories
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

drop policy if exists partner_logos_delete_admin on public.partner_logos;
create policy partner_logos_delete_admin on public.partner_logos
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- ARCHIVE → admin only (the three with a status column) -------------------
drop policy if exists team_members_archive_admin on public.team_members;
create policy team_members_archive_admin on public.team_members
  as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (app.is_admin() or status <> 'archived');

drop policy if exists certifications_archive_admin on public.certifications;
create policy certifications_archive_admin on public.certifications
  as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (app.is_admin() or status <> 'archived');

drop policy if exists statistics_archive_admin on public.statistics;
create policy statistics_archive_admin on public.statistics
  as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (app.is_admin() or status <> 'archived');

-- ---- Postcondition -----------------------------------------------------------
do $$
declare
  v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and permissive = 'RESTRICTIVE'
     and policyname in (
       'team_members_delete_admin', 'certifications_delete_admin', 'statistics_delete_admin',
       'categories_delete_admin', 'partner_logos_delete_admin',
       'team_members_archive_admin', 'certifications_archive_admin', 'statistics_archive_admin'
     );
  if v_n <> 8 then
    raise exception 'expected 8 RESTRICTIVE archive/delete gates, found %', v_n;
  end if;
end $$;
