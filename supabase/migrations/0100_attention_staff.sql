-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0100_attention_staff.sql — The attention list is for CMS staff (Admin v2 hotfix H13).
-- Forward-only; its number is assigned at merge. Depends on 0001 (app.is_staff), 0066
-- (dashboard_attention v4, whose definition this restates) and 0097 (C10a: Sales, the first
-- signed-in token that is not CMS staff, and the non-staff block this joins).
--
-- The gap (found by U7's adversarial check, docs/admin-v2/as-built/U7.md, Open): the view is
-- security_invoker and granted to `authenticated`, so RLS on the tables under it decided its
-- rows, and those tables give every signed-in token their published rows. A Sales token
-- therefore read rows over public content (a `missing_image` row for a published post with no
-- cover, a `placeholder_live` row for a published sample project) that anon, holding nothing
-- on the view, cannot. Every fact in them anon reads from the tables themselves, so nothing
-- private leaked, but it broke C10a's rule (Sales reads no more than anon outside the CRM),
-- and the list is a CMS staff feature: the dashboard reads it for the roles holding
-- blog.write, services.write or seo.entityMeta, and site health (Admin + Developer) through
-- public.content_health, which is INVOKER and runs as the caller.
--
--   1. dashboard_attention v5: 0066's definition, byte for byte, wrapped in one outer
--      SELECT whose WHERE is the staff test, applied once over the whole union rather than in
--      each of its eighteen branches: app.is_staff() (the four CMS roles, P-6), as 0097's
--      block uses it. Same six columns, same order, same types; security_invoker kept, so RLS
--      still scopes a staff member's rows to their tenant.
--      The test has a second arm, "nobody switched role and there is no role claim": 0097's
--      block is a policy TO authenticated and never binds the owner, but a view has no TO
--      clause, so the staff test alone would also empty the owner's psql reads the launch
--      runbook relies on (§6b's "expect none", which would then pass on nothing, and §6c's
--      two checks) and round2-cutover's verify step. That arm is 0066's trusted context
--      (the release guard: no switched role, no staff claim) narrowed to no role claim at
--      all (0097 §5, the sample lock): PostgREST switches role on every request, a SECURITY
--      DEFINER call does not change the role setting, and a session that sets any role
--      claim is judged by it. So every API token reads the list only as CMS staff; a Sales
--      token, a token with no role claim and the migration role with a Sales claim read no
--      row.
--      Not security_barrier: a caller's own filter that ran before the staff test would see
--      only rows the tables' RLS already gives that caller.
--   2. Grants, stated for both Supabase grant regimes (P-14), exactly as 0066 left them:
--      SELECT for authenticated; nothing for PUBLIC, anon or the service role.
--
-- No table, function, capability, screen or guide changes. The Worker reads the view only
-- for the roles above (src/lib/admin/dashboard/loaders.ts ATTENTION_CAPS; site health's
-- siteHealth.view), all CMS staff, so no screen loses a row; Sales never read it from a
-- screen. Postconditions at the end, read from the catalog and by reading the view under a
-- Sales claim. Rollout: push, then merge (nothing deployed relies on the rows it removes).
-- CLAUDE.md §3 (Pillar 1), §5, §8 (C10a), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- The view is replaced under an exclusive lock; a statement that waits more than five
-- seconds for it raises, so the push is retried later rather than queueing the dashboard's
-- reads behind it. Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. dashboard_attention v5: 0066's v4, for CMS staff only ═════════════════════════════
-- Between the two marker lines below, 0066 section 7's view text, unchanged
-- (tests/lib/attentionKinds.spec.ts compares them).
create or replace view public.dashboard_attention with (security_invoker = true) as
select a.kind, a.entity_type, a.id, a.slug, a.title, a.at
  from (
-- ---- 0066's dashboard_attention v4, verbatim ----
  select 'scheduled_today'::text as kind, 'service'::text as entity_type, s.id, s.slug::text,
         s.title, s.scheduled_for as at
    from public.services s
   where s.status = 'scheduled' and s.scheduled_for::date = current_date
  union all
  select 'scheduled_today', 'blog_post', b.id, b.slug::text, b.title, b.scheduled_for
    from public.blog_posts b
   where b.status = 'scheduled' and b.scheduled_for::date = current_date
  union all
  select 'stale', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and b.updated_at < now() - interval '180 days'
  union all
  select 'missing_image', 'blog_post', b.id, b.slug::text, b.title, b.updated_at
    from public.blog_posts b
   where b.status = 'published' and (b.cover_image_url is null or b.cover_image_url = '')
  -- ---- v2 ----
  union all
  select case when p.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.is_placeholder and p.status <> 'archived'
  union all
  select case when t.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where t.is_placeholder and t.status <> 'archived'
  union all
  select case when m.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'team_member', m.id, m.slug::text, m.name, m.updated_at
    from public.team_members m
   where m.is_placeholder and m.status <> 'archived'
  union all
  select case when st.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'statistic', st.id, st.slug::text, st.label, st.updated_at
    from public.statistics st
   where st.is_placeholder and st.status <> 'archived'
  union all
  select case when c.visible then 'placeholder_live' else 'placeholder_pending' end,
         'client', c.id, c.slug::text, c.name, c.updated_at
    from public.clients c
   where c.is_placeholder
  union all
  select case when ps.visible and pg.status = 'published' then 'placeholder_live'
              else 'placeholder_pending' end,
         'page_section', ps.id, pg.slug::text,
         jsonb_build_object('en', ps.type, 'ar', ps.type), ps.updated_at
    from public.page_sections ps
    join public.pages pg on pg.id = ps.page_id
   where ps.is_placeholder
  -- ---- v3 (0028) ----
  union all
  select case when sc.status in ('published', 'scheduled') then 'placeholder_live'
              else 'placeholder_pending' end,
         'service_case', sc.id, sv.slug::text, sc.title, sc.updated_at
    from public.service_cases sc
    join public.services sv on sv.id = sc.service_id
   where sc.is_placeholder and sc.status <> 'archived'
  union all
  select 'missing_alt', 'portfolio', p.id, p.slug::text, p.title, p.updated_at
    from public.portfolio p
   where p.status = 'published'
     and exists (
       select 1 from public.media_assets ma
        where ma.kind = 'image'
          and (ma.id = p.poster_media_id
               or ma.id in (select pm.media_id from public.portfolio_media pm
                             where pm.portfolio_id = p.id))
          and (coalesce(ma.alt ->> 'en', '') = '' or coalesce(ma.alt ->> 'ar', '') = ''))
  union all
  select 'consent_missing', 'testimonial', t.id, t.slug::text, t.author_name, t.updated_at
    from public.testimonials t
   where cardinality(t.placements) > 0 and t.consent_obtained_at is null
     and t.status <> 'archived'
  -- ---- v4 (0066): releases and stale pending changes ----
  union all
  select 'release_scheduled_today', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.scheduled_for
    from public.content_releases r
   where r.status = 'scheduled'
     and (r.scheduled_for at time zone 'Asia/Riyadh')::date
         = (pg_catalog.now() at time zone 'Asia/Riyadh')::date
     and r.scheduled_for >= pg_catalog.now() - interval '5 minutes'
  union all
  select 'release_overdue', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.scheduled_for
    from public.content_releases r
   where r.status = 'scheduled' and r.scheduled_for < pg_catalog.now() - interval '5 minutes'
  union all
  select 'release_failed', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.updated_at
    from public.content_releases r
   where r.status = 'failed' and r.updated_at > pg_catalog.now() - interval '7 days'
  union all
  select 'purge_failed', 'release', r.id, coalesce('v' || r.number::text, ''),
         case when r.note is null then null
              else pg_catalog.jsonb_build_object('en', r.note, 'ar', r.note) end,
         r.published_at
    from public.content_releases r
   where r.status = 'published' and r.purge_status = 'failed'
     and r.published_at > pg_catalog.now() - interval '7 days'
  union all
  select 'draft_stale', d.entity_type, d.entity_id,
         coalesce(case when pg_catalog.jsonb_typeof(d.payload -> 'slug') = 'string'
                       then d.payload ->> 'slug' end, ''),
         d.label, d.updated_at
    from public.content_drafts d
   where d.release_id is null and d.updated_at < pg_catalog.now() - interval '30 days'
-- ---- end of 0066's text ----
       ) a
 where app.is_staff()
    or (pg_catalog.current_setting('role') = 'none'
        and (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
               #>> '{app_metadata,role}') is null);

-- ═══ 2. Grants: stated, never inherited (P-14), exactly as 0066 left them ══════════════════
-- CMS staff read it through `authenticated` (the view then answers only them); anon, PUBLIC
-- and the service role hold nothing (public.content_health is INVOKER and runs as the caller).
revoke all on public.dashboard_attention from public, anon, authenticated, service_role;
grant select on public.dashboard_attention to authenticated;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. The definition is read as pg_get_viewdef prints it.
do $$
declare
  -- MAINTAIN exists from PostgreSQL 17 (production runs 17.6, CI 15); the privilege
  -- functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_col_privs constant text[] := array['select', 'insert', 'update', 'references'];
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_def text;
  v_n bigint;
  r text;
  p text;
begin
  -- 1. Still a view, still security_invoker, still 0066's six columns in their order.
  if not exists (select 1 from pg_class
                  where oid = 'public.dashboard_attention'::regclass and relkind = 'v'
                    and reloptions @> array['security_invoker=true']) then
    raise exception 'attention_staff: dashboard_attention must stay a security_invoker view';
  end if;
  if (select string_agg(format('%s %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', '
                        order by a.attnum)
        from pg_attribute a
       where a.attrelid = 'public.dashboard_attention'::regclass and a.attnum > 0
         and not a.attisdropped)
     is distinct from 'kind text, entity_type text, id uuid, slug text, title jsonb, at timestamp with time zone' then
    raise exception 'attention_staff: dashboard_attention''s columns moved';
  end if;

  -- 2. The staff test, once, as the WHERE of the outer select over the whole union: the
  -- definition names is_staff exactly once, right after the union's closing alias; the
  -- trusted arm reads the role setting and the role claim, and closes that same WHERE.
  v_def := pg_get_viewdef('public.dashboard_attention'::regclass);
  if v_def !~ '\) a\s+WHERE \((app\.)?is_staff\(\) OR '
     or (length(v_def) - length(replace(v_def, 'is_staff(', ''))) <> length('is_staff(')
     or v_def !~ 'current_setting\(''role''::text\) = ''none''::text'
     or v_def !~ '#>> ''\{app_metadata,role\}''::text\[\]\) IS NULL\)\)\);?\s*$' then
    raise exception 'attention_staff: dashboard_attention is not wrapped in the staff test once: %', v_def;
  end if;

  -- 3. Grants, under either regime: authenticated holds SELECT and nothing else; PUBLIC,
  -- anon and the service role hold nothing, table-wide or on a column.
  foreach p in array v_privs loop
    if (p = 'select') <> has_table_privilege('authenticated', 'public.dashboard_attention', p) then
      raise exception 'attention_staff: authenticated % on dashboard_attention is wrong', p;
    end if;
    foreach r in array array['public', 'anon', 'service_role'] loop
      if has_table_privilege(r::name, 'public.dashboard_attention', p) then
        raise exception 'attention_staff: % holds % on dashboard_attention', r, p;
      end if;
    end loop;
  end loop;
  foreach p in array v_col_privs loop
    if p <> 'select' and has_any_column_privilege('authenticated', 'public.dashboard_attention', p) then
      raise exception 'attention_staff: authenticated holds % on a column of dashboard_attention', p;
    end if;
    foreach r in array array['public', 'anon', 'service_role'] loop
      if has_any_column_privilege(r::name, 'public.dashboard_attention', p) then
        raise exception 'attention_staff: % holds % on a column of dashboard_attention', r, p;
      end if;
    end loop;
  end loop;

  -- 4. Read, not only printed: this session (the migration role, no switched role) with a
  -- Sales claim reads no row, whatever the tables hold. The claim is put back as it was.
  perform set_config('request.jwt.claims', '{"app_metadata":{"role":"sales"}}', true);
  select count(*) into v_n from public.dashboard_attention;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  if v_n <> 0 then
    raise exception 'attention_staff: a Sales claim reads % attention rows', v_n;
  end if;
end $$;
