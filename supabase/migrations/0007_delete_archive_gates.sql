-- ─────────────────────────────────────────────────────────────────────────────
-- 0007 — Harden archive/delete to ADMIN-ONLY via RESTRICTIVE RLS (CLAUDE.md §3 +
-- §5: "archive/delete content = Admin"; "Media — hard delete = Admin"). Services +
-- blog already split DELETE to admin with separate per-command policies; portfolio,
-- pages, page_sections and media_assets used a single FOR ALL write policy that let
-- Content Creator (can_write_content) delete/archive. This brings them to parity.
--
-- Forward-only + minimal: we ADD restrictive policies rather than edit the applied
-- FOR ALL policies. Restrictive policies AND with the permissive write policy, so the
-- effective rule becomes (can_write_content) AND (is_admin) = admin for the gated op —
-- exactly the "gated by RESTRICTIVE RLS" mechanism the standard prescribes.
--
-- Note (RLS semantics): for DELETE the restrictive USING simply FILTERS rows (a
-- non-admin delete affects 0 rows, no error); for the archive UPDATE the restrictive
-- WITH CHECK raises 42501 when a non-admin tries to set status='archived'.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- DELETE → admin only ---------------------------------------------------
create policy portfolio_delete_admin on public.portfolio
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

create policy pages_delete_admin on public.pages
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

create policy page_sections_delete_admin on public.page_sections
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

create policy media_delete_admin on public.media_assets
  as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());

-- ---- ARCHIVE → admin only (non-admin cannot set status='archived') ---------
-- Parity with services/blog. page_sections + media_assets have no status → no gate.
create policy portfolio_archive_admin on public.portfolio
  as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (app.is_admin() or status <> 'archived');

create policy pages_archive_admin on public.pages
  as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (app.is_admin() or status <> 'archived');
