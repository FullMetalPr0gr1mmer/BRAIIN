-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0073 — SEO: share images from the media library (Admin v2 U10, the folded U10a + U10b PR).
-- Forward-only and EXPAND only: two nullable columns, one unique constraint, two composite
-- foreign keys, two indexes, one policy and one function restated, two registry rows
-- restated. No data changes, no grant changes. The number is a placeholder: it is assigned
-- at merge (scripts/renumber-migration.mjs). Depends on 0009, 0011, 0024, 0028, 0038, 0045 and
-- 0066 (media_usage v4, whose text v5 below extends).
--
-- The design is docs/admin-v2/ui.md "SEO (/admin/seo; AV-19)" and §6, as the Wave 3 U10 brief
-- decides it (D2, D3); the departures are in docs/admin-v2/as-built/U10.md.
--
--   1. media_assets_tenant_id_id: UNIQUE (tenant_id, id) on media_assets, the target of the
--      two composite keys below (0041's profiles precedent; U9a reuses it for the site icons).
--   2. entity_seo.og_media_id and seo_defaults.default_og_media_id: the share image as a
--      media asset. Each is a composite foreign key (tenant_id, <column>) → media_assets
--      (tenant_id, id) ON DELETE RESTRICT, so a share image is always an asset of the row's
--      own tenant (MATCH SIMPLE: a null id is not checked), and a picture in use cannot be
--      hard-deleted even before the Worker's media_usage gate. The legacy URL columns
--      (og_image, default_og_image) stay: read as a fallback, never silently wiped.
--   3. media_assets_public_read: 0045's policy word for word, plus two branches: an asset a
--      VISIBLE entity_seo row names as its share image, and one the tenant's seo_defaults
--      names. Each subquery runs under anon's own RLS on that table, so entity_seo's
--      published-parent fence (0011 entity_seo_published_only) applies: a draft service's
--      share image stays hidden, fail-closed.
--
--      THE RECURSION RULE (why the tenant fence on the new references is a foreign key, not
--      a policy term): this policy now reads entity_seo and seo_defaults, so no policy on
--      either table may ever read media_assets. PostgreSQL would expand the two policies
--      into each other and refuse every read of either table with 42P17 (infinite recursion
--      detected in policy), which would take every public image and every page head down.
--      A postcondition below holds it, and pgTAP reads both tables as anon.
--   4. public.media_usage v5: v4 (0066) word for word, plus `entity_seo` (the target's id,
--      labelled "<kind>: <slug>") and `seo_defaults` (the tenant, "site default") branches,
--      both `pending false`. Same four columns, so the deployed Worker's parsers read it as
--      they read v4 (as-built U10, rule 5). INVOKER, search_path '', every name qualified,
--      every branch tenant-first; EXECUTE authenticated only.
--   5. The release registry rows of entity_seo and seo_defaults restated (`do update`) with
--      the new columns appended, so a release may stage and publish a share image like any
--      other SEO column (R1/R2 contract; tests/fixtures/releaseRegistry.ts reads this shape).
--      apply_release (0051) builds its statements from the registry at call time, and the
--      snapshot, capture and guard triggers are row-generic: nothing else is restated.
--
-- Production runs this as postgres (BYPASSRLS) on PostgreSQL 17; CI replays it on 15. Grants
-- are not touched: anon's table SELECT on entity_seo and seo_defaults (0011) covers the new
-- columns (public data, rendered in the head), staff grants are table-wide, and anon's column
-- grant on media_assets (0024) is unchanged. Postconditions at the end check both grant
-- regimes (MAINTAIN only on 17).
--
-- CLAUDE.md §3 (Pillar 3, the canonical and sitemap rule), §8 (Media; Admin v2 lanes, UI).
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: three live tables gain a constraint, two a
-- column and an index, a policy is replaced and a function restated, and a statement that
-- waits more than five seconds for a lock raises, so the push is retried later rather than
-- holding its place in the lock queue while the site's reads pile up behind it.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. media_assets (tenant_id, id) ══════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.media_assets'::regclass
                    and conname = 'media_assets_tenant_id_id') then
    alter table public.media_assets
      add constraint media_assets_tenant_id_id unique (tenant_id, id);
  end if;
end $$;

-- ═══ 2. The share-image columns ═══════════════════════════════════════════════════════════
alter table public.entity_seo add column if not exists og_media_id uuid;
alter table public.entity_seo drop constraint if exists entity_seo_og_media_fk;
alter table public.entity_seo
  add constraint entity_seo_og_media_fk foreign key (tenant_id, og_media_id)
  references public.media_assets (tenant_id, id) on delete restrict;
-- For media_usage and the foreign key's check on a media delete.
create index if not exists entity_seo_og_media_idx
  on public.entity_seo (og_media_id) where og_media_id is not null;

alter table public.seo_defaults add column if not exists default_og_media_id uuid;
alter table public.seo_defaults drop constraint if exists seo_defaults_default_og_media_fk;
alter table public.seo_defaults
  add constraint seo_defaults_default_og_media_fk foreign key (tenant_id, default_og_media_id)
  references public.media_assets (tenant_id, id) on delete restrict;
create index if not exists seo_defaults_default_og_media_idx
  on public.seo_defaults (default_og_media_id) where default_og_media_id is not null;

comment on column public.entity_seo.og_media_id is
  'The page''s share image (og:image), a media asset of the same tenant (0073). Outranks the '
  'legacy og_image URL, which is read only as a fallback.';
comment on column public.seo_defaults.default_og_media_id is
  'The default share image for a page with no image of its own, a media asset of the same '
  'tenant (0073). Outranks the legacy default_og_image URL.';

-- ═══ 3. media_assets_public_read: 0045's branches, plus the two share images ══════════════
-- NO policy on public.entity_seo or public.seo_defaults may read public.media_assets: this
-- policy reads them, and the two would recurse (42P17). A postcondition holds it.
drop policy if exists media_assets_public_read on public.media_assets;
create policy media_assets_public_read on public.media_assets for select using (
  tenant_id = app.effective_tenant_id()
  and provider in ('static', 'cf_images', 'stream', 'storage')
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
    or exists (select 1 from public.disciplines d
                where d.poster_media_id = media_assets.id and d.status = 'published')
    or exists (select 1 from public.services sv
                where sv.poster_media_id = media_assets.id and sv.status = 'published')
    -- 0073: a share image. entity_seo is read under the reader's own RLS, so for anon only
    -- a row whose parent is published (0011 entity_seo_published_only) matches.
    or exists (select 1 from public.entity_seo e
                where e.og_media_id = media_assets.id)
    or exists (select 1 from public.seo_defaults sd
                where sd.default_og_media_id = media_assets.id)
  )
);

-- ═══ 4. media_usage v5: v4 (0066), plus the two share images ═════════════════════════════
create or replace function public.media_usage(p_media_id uuid)
  returns table (entity_type text, entity_id uuid, label text, pending boolean)
  language sql stable security invoker set search_path = ''
as $$
  select 'portfolio'::text, p.id, p.slug::text, false
    from public.portfolio p
   where p.tenant_id = app.effective_tenant_id() and p.poster_media_id = p_media_id
  union all
  select 'portfolio_media', pm.portfolio_id, pm.role, false
    from public.portfolio_media pm
   where pm.tenant_id = app.effective_tenant_id() and pm.media_id = p_media_id
  union all
  select 'client', c.id, c.slug::text, false
    from public.clients c
   where c.tenant_id = app.effective_tenant_id() and c.logo_media_id = p_media_id
  union all
  select 'testimonial', t.id, t.slug::text, false
    from public.testimonials t
   where t.tenant_id = app.effective_tenant_id() and t.avatar_media_id = p_media_id
  union all
  select 'team_member', m.id, m.slug::text, false
    from public.team_members m
   where m.tenant_id = app.effective_tenant_id() and m.portrait_media_id = p_media_id
  union all
  select 'page_section', s.id, s.type, false
    from public.page_sections s
   where s.tenant_id = app.effective_tenant_id()
     and pg_catalog.jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                                      pg_catalog.jsonb_build_object('id', p_media_id::text))
  union all
  select 'discipline', d.id, d.slug::text, false
    from public.disciplines d
   where d.tenant_id = app.effective_tenant_id() and d.poster_media_id = p_media_id
  union all
  select 'service', sv.id, sv.slug::text, false
    from public.services sv
   where sv.tenant_id = app.effective_tenant_id() and sv.poster_media_id = p_media_id
  -- ---- v5 (0073): the share images. The entity is the page the SEO row describes (its
  -- target), labelled "<kind>: <slug>" from the target's own row; the defaults are the
  -- tenant's, labelled "site default" ----
  union all
  select 'entity_seo', e.entity_id,
         case e.entity_type
           when 'service' then 'service'
           when 'portfolio' then 'project'
           when 'blog_post' then 'post'
           else 'page'
         end
         || coalesce(': ' || case e.entity_type
              when 'service' then (select sv.slug::text from public.services sv
                                    where sv.tenant_id = e.tenant_id and sv.id = e.entity_id)
              when 'portfolio' then (select p.slug::text from public.portfolio p
                                      where p.tenant_id = e.tenant_id and p.id = e.entity_id)
              when 'blog_post' then (select b.slug::text from public.blog_posts b
                                      where b.tenant_id = e.tenant_id and b.id = e.entity_id)
              else (select pg.slug::text from public.pages pg
                     where pg.tenant_id = e.tenant_id and pg.id = e.entity_id)
            end, ''),
         false
    from public.entity_seo e
   where e.tenant_id = app.effective_tenant_id() and e.og_media_id = p_media_id
  union all
  select 'seo_defaults', sd.tenant_id, 'site default', false
    from public.seo_defaults sd
   where sd.tenant_id = app.effective_tenant_id() and sd.default_og_media_id = p_media_id
  -- ---- v4 (0066): pending changes ----
  union all
  select dr.entity_type, dr.entity_id,
         pg_catalog.left(coalesce(nullif(dr.label ->> 'en', ''), dr.payload ->> 'slug', 'pending change'), 120),
         true
    from public.content_drafts dr
   where dr.tenant_id = app.effective_tenant_id()
     and dr.op <> 'delete'
     and exists (select 1
                   from pg_catalog.jsonb_path_query(dr.payload, 'lax $.**') as v(value)
                  where pg_catalog.jsonb_typeof(v.value) = 'string'
                    and pg_catalog.lower(pg_catalog.regexp_replace(v.value #>> '{}', '[{}-]', '', 'g'))
                        = pg_catalog.replace(p_media_id::text, '-', ''))
$$;
revoke all on function public.media_usage(uuid) from public, anon, authenticated, service_role;
grant execute on function public.media_usage(uuid) to authenticated;

-- ═══ 5. The release registry: the share-image columns are staged like the rest ════════════
-- 0038's two rows, restated with the new column appended. `do update`, so these replace
-- 0038's; tests/fixtures/releaseRegistry.ts folds the migrations in order and reads this shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('entity_seo', 'entity_seo', 'id', 'seo', '{admin,seo}', '{}',
   '{entity_type,entity_id,meta_title,meta_description,og_image,canonical_override,robots,schema_type,og_media_id}',
   '{}', '{}', '{}', 120, false, null),
  ('seo_defaults', 'seo_defaults', 'tenant_id', 'seo', '{admin,seo}', '{}',
   '{title_template,default_title,default_description,default_og_image,organization,robots_directives,default_og_media_id}',
   '{}', '{}', '{}', 120, false, null)
on conflict (entity_type) do update
  set table_name = excluded.table_name,
      key_column = excluded.key_column,
      area = excluded.area,
      author_roles = excluded.author_roles,
      delete_roles = excluded.delete_roles,
      columns = excluded.columns,
      deferred_columns = excluded.deferred_columns,
      unique_flags = excluded.unique_flags,
      exempt_columns = excluded.exempt_columns,
      apply_order = excluded.apply_order,
      has_status = excluded.has_status,
      publish_flag = excluded.publish_flag;

-- ═══ 6. The help guide ═══════════════════════════════════════════════════════════════════
-- TODO(H11): once the help-guide catalog (H11, app.put_help_guide) is on main, the
-- seo-and-redirects guide for the SEO screen is put here, at the start of a line and outside
-- any DO block, from docs/admin-v2/guides/seo-and-redirects.json (its revision on main, 1 if
-- no other slice has put it):
--   select app.put_help_guide($guide$ {the JSON file} $guide$::jsonb, 1);
-- Until then the guide in the database is the one the latest restatement left (0067), which
-- still describes the old form; tests/lib/helpCentre.spec.ts holds the file's claims.

-- ═══ 7. Postconditions ═══════════════════════════════════════════════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_privs text;
  r text;
  t text;
  v_qual text;
  v_bad text;
begin
  -- ---- 1. The unique key is exactly (tenant_id, id) ---------------------------------------
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.media_assets'::regclass
                    and c.conname = 'media_assets_tenant_id_id' and c.contype = 'u'
                    and pg_get_constraintdef(c.oid) = 'UNIQUE (tenant_id, id)') then
    raise exception '0073: media_assets_tenant_id_id must be UNIQUE (tenant_id, id)';
  end if;

  -- ---- 2. The two composite keys: RESTRICT, to that unique key ----------------------------
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.entity_seo'::regclass
                    and c.conname = 'entity_seo_og_media_fk' and c.contype = 'f'
                    and c.confdeltype = 'r'
                    and c.conindid = (select conindid from pg_constraint
                                       where conname = 'media_assets_tenant_id_id'
                                         and conrelid = 'public.media_assets'::regclass)
                    and pg_get_constraintdef(c.oid)
                        ~ '^FOREIGN KEY \(tenant_id, og_media_id\) REFERENCES (public\.)?media_assets\(tenant_id, id\) ON DELETE RESTRICT$') then
    raise exception '0073: entity_seo_og_media_fk must be (tenant_id, og_media_id) -> media_assets (tenant_id, id) ON DELETE RESTRICT';
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.seo_defaults'::regclass
                    and c.conname = 'seo_defaults_default_og_media_fk' and c.contype = 'f'
                    and c.confdeltype = 'r'
                    and c.conindid = (select conindid from pg_constraint
                                       where conname = 'media_assets_tenant_id_id'
                                         and conrelid = 'public.media_assets'::regclass)
                    and pg_get_constraintdef(c.oid)
                        ~ '^FOREIGN KEY \(tenant_id, default_og_media_id\) REFERENCES (public\.)?media_assets\(tenant_id, id\) ON DELETE RESTRICT$') then
    raise exception '0073: seo_defaults_default_og_media_fk must be (tenant_id, default_og_media_id) -> media_assets (tenant_id, id) ON DELETE RESTRICT';
  end if;
  if to_regclass('public.entity_seo_og_media_idx') is null
     or to_regclass('public.seo_defaults_default_og_media_idx') is null then
    raise exception '0073: the share-image indexes are missing';
  end if;

  -- ---- 3. media_assets_public_read: PERMISSIVE SELECT, tenant first, every branch --------
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'media_assets'
     and policyname = 'media_assets_public_read'
     and permissive = 'PERMISSIVE' and cmd = 'SELECT';
  if v_qual is null
     or v_qual !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\)'
     or position('storage' in v_qual) = 0
     or position('portfolio_media' in v_qual) = 0
     or position('page_sections' in v_qual) = 0
     or position('disciplines' in v_qual) = 0
     or position('services' in v_qual) = 0
     or position('entity_seo' in v_qual) = 0
     or position('og_media_id' in v_qual) = 0
     or position('seo_defaults' in v_qual) = 0
     or position('default_og_media_id' in v_qual) = 0 then
    raise exception '0073: media_assets_public_read must be PERMISSIVE SELECT, tenant first, naming storage, every 0045 branch, entity_seo and seo_defaults';
  end if;

  -- ---- 4. The recursion rule: no policy on entity_seo or seo_defaults reads media_assets --
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename in ('entity_seo', 'seo_defaults')
     and (coalesce(qual, '') ~ 'media_assets' or coalesce(with_check, '') ~ 'media_assets');
  if v_bad is not null then
    raise exception '0073: policies on entity_seo or seo_defaults read media_assets (42P17 with media_assets_public_read): %', v_bad;
  end if;

  -- ---- 5. media_usage v5: INVOKER, search_path '', four columns, authenticated only -----
  if not exists (select 1 from pg_proc
                  where oid = 'public.media_usage(uuid)'::regprocedure and not prosecdef
                    and proconfig = array['search_path=""']
                    and pg_get_function_result(oid)
                        = 'TABLE(entity_type text, entity_id uuid, label text, pending boolean)'
                    and prosrc ~ '''entity_seo''' and prosrc ~ '''seo_defaults'''
                    and prosrc ~ 'content_drafts') then
    raise exception '0073: public.media_usage must be INVOKER, search_path '''', four columns, with the share-image and pending branches';
  end if;
  if not has_function_privilege('authenticated', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('anon', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('public', 'public.media_usage(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.media_usage(uuid)', 'execute') then
    raise exception '0073: public.media_usage must be executable by authenticated only';
  end if;

  -- ---- 6. Grants unchanged where they matter: PUBLIC and anon never write the three
  -- tables, and no API role truncates them (R5, 0066). Staff's other table privileges are
  -- the regime's and 0011's, which this file does not touch ------------------------------
  v_privs := 'insert, update, delete, truncate';
  foreach t in array array['public.entity_seo', 'public.seo_defaults', 'public.media_assets'] loop
    foreach r in array array['public', 'anon'] loop
      if has_table_privilege(r::name, t, v_privs) then
        raise exception '0073: % may write %', r, t;
      end if;
    end loop;
    foreach r in array array['authenticated', 'service_role'] loop
      if has_table_privilege(r::name, t, 'truncate') then
        raise exception '0073: % may truncate %', r, t;
      end if;
    end loop;
    -- MAINTAIN (PostgreSQL 17) for the roles that must never write: staff and the service
    -- role keep whatever their regime gave them, which this file does not touch.
    if v_maintain then
      foreach r in array array['public', 'anon'] loop
        if (case when v_maintain then has_table_privilege(r::name, t, 'maintain') else false end) then
          raise exception '0073: % holds MAINTAIN on %', r, t;
        end if;
      end loop;
    end if;
  end loop;
  -- anon reads the new columns (they ship in the head) and writes neither.
  if not has_column_privilege('anon', 'public.entity_seo', 'og_media_id', 'select')
     or not has_column_privilege('anon', 'public.seo_defaults', 'default_og_media_id', 'select')
     or has_column_privilege('anon', 'public.entity_seo', 'og_media_id', 'insert, update, references')
     or has_column_privilege('anon', 'public.seo_defaults', 'default_og_media_id', 'insert, update, references') then
    raise exception '0073: anon must read, and only read, the share-image columns';
  end if;
  -- anon's media_assets read stays the 0024 column grant: never display_name.
  if has_column_privilege('anon', 'public.media_assets', 'display_name', 'select') then
    raise exception '0073: anon may read media_assets.display_name';
  end if;

  -- ---- 7. RLS still on and forced -------------------------------------------------------
  select string_agg(relname, ', ') into v_bad
    from pg_class
   where oid in ('public.entity_seo'::regclass, 'public.seo_defaults'::regclass,
                 'public.media_assets'::regclass)
     and not (relrowsecurity and relforcerowsecurity);
  if v_bad is not null then
    raise exception '0073: RLS is not enabled and forced on %', v_bad;
  end if;

  -- ---- 8. The registry stages the new columns ------------------------------------------
  if not exists (select 1 from app.release_entities
                  where entity_type = 'entity_seo' and 'og_media_id' = any (columns)
                    and 'og_image' = any (columns))
     or not exists (select 1 from app.release_entities
                     where entity_type = 'seo_defaults' and 'default_og_media_id' = any (columns)
                       and 'default_og_image' = any (columns)) then
    raise exception '0073: the release registry must stage og_media_id and default_og_media_id';
  end if;
end $$;
