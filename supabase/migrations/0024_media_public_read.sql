-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 — Visitors may read the media that public content shows. UI v2 PR4a.
-- Forward-only (expand). Depends on 0016, 0020–0023 (every referencing column).
--
-- Until now media_assets was staff-only (0001 media_read), which was fine while nothing
-- public pointed at it. UI v2 does: project posters, case-study media, client logos,
-- testimonial avatars, leadership portraits and section images. The public loaders embed
-- those rows, so anon needs to read them — but ONLY those: an asset uploaded for a draft
-- case study, or referenced by nothing, stays invisible.
--
-- The policy is one EXISTS branch per referencing column. Each subquery runs under
-- anon's OWN RLS on the joined table (portfolio_read, clients_read, …), so a draft,
-- hidden or other-tenant reference fails closed without restating those rules here.
-- Only hosted providers qualify: a legacy `external` URL is never re-published.
--
-- The column grant withholds what is internal (folder, tags, ref_count, provider_ref,
-- size, audit columns). `media_usage()` v2 lists every reference — the hard-delete route
-- refuses while one exists (PR4b).
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists media_assets_public_read on public.media_assets;
create policy media_assets_public_read on public.media_assets for select using (
  tenant_id = app.effective_tenant_id()
  and provider in ('static', 'cf_images', 'stream')
  and (
    exists (select 1 from public.portfolio p
             where p.poster_media_id = media_assets.id and p.status = 'published')
    or exists (select 1 from public.portfolio_media pm
                 join public.portfolio p on p.id = pm.portfolio_id
                where pm.media_id = media_assets.id and p.status = 'published')
    or exists (select 1 from public.clients c
                where c.logo_media_id = media_assets.id and c.visible)
    or exists (select 1 from public.testimonials t
                where t.avatar_media_id = media_assets.id and t.status = 'published')
    or exists (select 1 from public.team_members m
                where m.portrait_media_id = media_assets.id and m.status = 'published')
    or exists (select 1 from public.page_sections s
                 join public.pages pg on pg.id = s.page_id
                where s.visible and pg.status = 'published'
                  and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                                        jsonb_build_object('id', media_assets.id::text)))
  )
);

-- Column-level: exactly what a public <img>/<Picture> needs.
revoke all on public.media_assets from anon;
grant select (id, tenant_id, kind, provider, storage_path, width, height, alt, stream_uid,
              mime_type, updated_at)
  on public.media_assets to anon;

-- ---- media_usage v2: every reference -------------------------------------------------
-- SECURITY INVOKER, as in 0020: staff see every reference in their tenant.
create or replace function public.media_usage(p_media_id uuid)
  returns table (entity_type text, entity_id uuid, label text)
  language sql stable security invoker set search_path = public, app, pg_temp as $$
  select 'portfolio'::text, p.id, p.slug::text
    from public.portfolio p
   where p.tenant_id = app.effective_tenant_id() and p.poster_media_id = p_media_id
  union all
  select 'portfolio_media', pm.portfolio_id, pm.role
    from public.portfolio_media pm
   where pm.tenant_id = app.effective_tenant_id() and pm.media_id = p_media_id
  union all
  select 'client', c.id, c.slug::text
    from public.clients c
   where c.tenant_id = app.effective_tenant_id() and c.logo_media_id = p_media_id
  union all
  select 'testimonial', t.id, t.slug::text
    from public.testimonials t
   where t.tenant_id = app.effective_tenant_id() and t.avatar_media_id = p_media_id
  union all
  select 'team_member', m.id, m.slug::text
    from public.team_members m
   where m.tenant_id = app.effective_tenant_id() and m.portrait_media_id = p_media_id
  union all
  select 'page_section', s.id, s.type
    from public.page_sections s
   where s.tenant_id = app.effective_tenant_id()
     and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                           jsonb_build_object('id', p_media_id::text))
$$;
revoke all on function public.media_usage(uuid) from public, anon, service_role;
grant execute on function public.media_usage(uuid) to authenticated;

-- ---- Postconditions -------------------------------------------------------------------
do $$
declare
  c text;
begin
  foreach c in array array['folder', 'tags', 'ref_count', 'provider_ref', 'size_bytes',
                           'created_by', 'updated_by'] loop
    if has_column_privilege('anon', 'public.media_assets', c, 'select') then
      raise exception '0024: anon can read media_assets.%', c;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.media_assets', 'insert')
     or has_table_privilege('anon', 'public.media_assets', 'update')
     or has_table_privilege('anon', 'public.media_assets', 'delete') then
    raise exception '0024: anon holds a write privilege on media_assets';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'media_usage' and p.prosecdef) then
    raise exception 'media_usage must stay SECURITY INVOKER';
  end if;
end $$;
