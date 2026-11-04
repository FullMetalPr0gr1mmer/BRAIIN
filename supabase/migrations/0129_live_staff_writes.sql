-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0129 — A stale token writes nothing (Admin v2 H16, the general stale-token fix). Forward-only
-- and EXPAND only: policies are added and one function is restated, nothing is dropped. The
-- number is a placeholder: it is assigned at merge (scripts/renumber-migration.mjs). Depends on
-- 0001 (the content tables and their JWT-role policies, app.effective_tenant_id), 0020
-- (public.update_media_meta), 0033 (app.live_role) and every migration that created one of the
-- tables named below.
--
-- THE GAP. RLS reads the role from the access token, and an access token lives up to an hour.
-- A role, activity or tenant change ends every session (0055, profiles_revoke_sessions) and the
-- Worker refuses a token whose claims and profile disagree (U12a), but the token itself stays
-- valid at PostgREST until it expires. On the tables below, every staff write was decided by
-- the token's role alone, so a demoted, deactivated or locked person could keep writing with
-- their old rights by calling the API directly: publish, edit or delete content, rewrite
-- redirects and SEO, change media, clear the system log. The tables built since the leads work
-- (0033) each carry their own RESTRICTIVE live policy; these 28 predate it.
--
-- THE FIX
--   1. Three RESTRICTIVE policies on each table, TO authenticated, one per write command:
--        <table>_live_insert   WITH CHECK
--        <table>_live_update   USING and WITH CHECK
--        <table>_live_delete   USING
--      each `tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null`.
--      app.live_role() (0033, SECURITY DEFINER, empty search_path) is the profile's role, read
--      at query time by the token's `sub`, and null unless that profile is active, unlocked, in
--      the token's tenant and holds exactly the token's role. So where it is not null, the JWT
--      role the existing permissive policies read IS the live role: every capability rule
--      stays where it is, now evaluated on a role the database has just confirmed. A stale
--      token's UPDATE and DELETE match no row; its INSERT is refused (42501).
--        • RESTRICTIVE: ANDed with the permissive policies, so it can only narrow.
--        • The tenant predicate first (CLAUDE.md §3).
--        • `(select …)`: an InitPlan, evaluated once per statement (one primary-key lookup on
--          profiles), never once per row.
--        • All three commands on every table, even where authenticated holds no such grant
--          today (audit_log's UPDATE and DELETE, seo_defaults' DELETE…): a grant added by
--          mistake is then not enough on its own (as 0050 did on profiles).
--        • Reads are untouched: no SELECT policy is added, so what anon and every reader see
--          is unchanged, and no anon policy changes.
--      Not affected: the service role (BYPASSRLS: the Worker's server-side writes, the public
--      forms), SECURITY DEFINER functions and triggers (they run as their owner, which these
--      TO authenticated policies do not name: apply_release, publish_scheduled, the snapshot
--      and capture triggers, update_my_profile), the access-token hook and pg_cron. Invoker
--      RPCs (save_portfolio, apply_portfolio_children, write_drafts) are held by the policies
--      of the tables they write, which is the point.
--   2. public.update_media_meta (0020: SEO's "meta only" media write, a SECURITY DEFINER that
--      checked the token's role alone) restated: a stale token is refused as a non-staff one
--      is (42501). Its search_path is pinned to '' with every name qualified; its body is
--      otherwise 0020's. CREATE OR REPLACE keeps the owner; the grants are stated again.
--   3. Postconditions: the exact policy set added here; the rule that EVERY public table where
--      authenticated holds a write privilege carries a RESTRICTIVE live policy for each
--      command it can run (a later table without one fails supabase/tests/live_staff_writes);
--      the function's settings, body and grants.
--
-- Not changed: a lock (the sign-in lockout) still ends no session (U12a's decision, kept: anyone
-- who knows a staff address can trip it). A locked token writes nothing here (live_role reads
-- locked_until at query time) and the Worker signs it out at its next request. Reads by a stale
-- token on the tables without a live read check stay open until the token expires
-- (docs/admin-v2/as-built/H16.md, residual gaps).
--
-- Rule 5 (the deployed Worker between this push and the deploy): no shape changes. Every write
-- the deployed Worker makes passes resolveAuthContext first, which refuses a session whose
-- profile is inactive, locked, of another tenant or of another role than its token, exactly the
-- tokens live_role() turns away, so no live session's write changes. update_media_meta keeps its
-- signature, result columns and error codes.
--
-- Production as of 2026-11-05: PostgreSQL 17.6, one tenant; main holds every migration through
-- 0127. CLAUDE.md §2 (session invalidation), §3 (Pillar 1), §8, §9 (b).
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later. Each
-- CREATE POLICY takes an ACCESS EXCLUSIVE lock on its table for the rest of the transaction.
set local lock_timeout = '5s';

-- ═══ 1. The live check on every staff write ═══════════════════════════════════════════════
-- The list is the inventory of public tables where authenticated held a write privilege and no
-- RESTRICTIVE live policy (docs/admin-v2/as-built/H16.md). It is spelt out, not derived, so the
-- migration does exactly what it says on every database; section 3 checks nothing was missed.
do $$
declare
  t text;
  tables constant text[] := array[
    'ai_config', 'ai_questions', 'ai_styles', 'audit_log', 'blog_posts', 'categories',
    'certifications', 'clients', 'disciplines', 'entity_seo', 'faq_items', 'media_assets',
    'navigation', 'page_sections', 'pages', 'partner_logos', 'portfolio', 'portfolio_media',
    'portfolio_services', 'redirects', 'sectors', 'seo_defaults', 'service_cases', 'services',
    'statistics', 'system_logs', 'team_members', 'testimonials'];
  live constant text :=
    'tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null';
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', t || '_live_insert', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated with check (%s)',
      t || '_live_insert', t, live);
    execute format('drop policy if exists %I on public.%I', t || '_live_update', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated using (%s) with check (%s)',
      t || '_live_update', t, live, live);
    execute format('drop policy if exists %I on public.%I', t || '_live_delete', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated using (%s)',
      t || '_live_delete', t, live);
  end loop;
end $$;

-- ═══ 2. update_media_meta: live, and its search_path pinned ═════════════════════════════
create or replace function public.update_media_meta(p_id uuid, p_version int, p_patch jsonb)
  returns table (
    id uuid, kind text, storage_path text, folder text, alt jsonb, tags text[],
    version int, updated_at timestamptz
  )
  language plpgsql security definer set search_path = ''
as $$
begin
  -- The token's role must be a staff role AND the profile's, live (H16): a demoted,
  -- deactivated or locked person's token is refused like a non-staff one.
  if app.current_role() not in ('admin', 'content_creator', 'seo', 'developer')
     or app.live_role() is null then
    raise exception 'media metadata is staff-only' using errcode = '42501';
  end if;
  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be an object' using errcode = '22023';
  end if;
  if p_patch ? 'alt' and pg_catalog.jsonb_typeof(p_patch -> 'alt') not in ('object', 'null') then
    raise exception 'alt must be an {en, ar} object or null' using errcode = '22023';
  end if;
  if p_patch ? 'tags' and pg_catalog.jsonb_typeof(p_patch -> 'tags') <> 'array' then
    raise exception 'tags must be an array' using errcode = '22023';
  end if;

  return query
  update public.media_assets m set
    alt = case when p_patch ? 'alt' then nullif(p_patch -> 'alt', 'null'::jsonb) else m.alt end,
    tags = case
      when p_patch ? 'tags'
        then array(select pg_catalog.jsonb_array_elements_text(p_patch -> 'tags'))
      else m.tags
    end,
    folder = case when p_patch ? 'folder' then p_patch ->> 'folder' else m.folder end
  where m.tenant_id = app.effective_tenant_id()
    and m.id = p_id
    and m.version = p_version
  returning m.id, m.kind, m.storage_path, m.folder, m.alt, m.tags, m.version, m.updated_at;
end $$;
revoke all on function public.update_media_meta(uuid, int, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_media_meta(uuid, int, jsonb) to authenticated;

-- ═══ 3. Postconditions ═══════════════════════════════════════════════════════════════════
-- Expressions are read as pg_get_expr prints them, with or without the schema qualifier.
do $$
declare
  v_expr constant text :=
    '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\)\)$';
  v_bad text;
  v_count int;
begin
  -- 3a. Each policy this migration made: RESTRICTIVE, TO authenticated alone, the expression
  --     exactly, on the sides its command has and on no other.
  select count(*)::int,
         string_agg(c.relname || '.' || p.polname, ', ') filter (where not (
           not p.polpermissive
           and p.polroles = array['authenticated'::regrole::oid]
           and case p.polcmd
                 when 'a' then p.polqual is null
                               and pg_get_expr(p.polwithcheck, p.polrelid) ~ v_expr
                 when 'w' then pg_get_expr(p.polqual, p.polrelid) ~ v_expr
                               and pg_get_expr(p.polwithcheck, p.polrelid) ~ v_expr
                 when 'd' then p.polwithcheck is null
                               and pg_get_expr(p.polqual, p.polrelid) ~ v_expr
                 else false
               end
           and p.polname = c.relname || case p.polcmd
                                          when 'a' then '_live_insert'
                                          when 'w' then '_live_update'
                                          when 'd' then '_live_delete' end))
    into v_count, v_bad
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any (array[
       'ai_config', 'ai_questions', 'ai_styles', 'audit_log', 'blog_posts', 'categories',
       'certifications', 'clients', 'disciplines', 'entity_seo', 'faq_items', 'media_assets',
       'navigation', 'page_sections', 'pages', 'partner_logos', 'portfolio', 'portfolio_media',
       'portfolio_services', 'redirects', 'sectors', 'seo_defaults', 'service_cases', 'services',
       'statistics', 'system_logs', 'team_members', 'testimonials'])
     and p.polname ~ '_live_(insert|update|delete)$';
  if v_count <> 84 or v_bad is not null then
    raise exception 'H16: expected 84 live write policies of the one shape, found % (wrong: %)',
      v_count, coalesce(v_bad, 'none');
  end if;

  -- 3b. The rule: every public table (partitions are reached through their parent) where
  --     authenticated holds a write privilege, table-wide or on a column, carries a
  --     RESTRICTIVE policy for authenticated, on that command or ALL, that consults the live
  --     profile (app.live_role or app.is_live_admin, 0029).
  with t as (
    select c.oid, c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  ), need as (
    select t.oid, t.relname, cmd.c
      from t
      cross join lateral (values
        ('a', has_table_privilege('authenticated', t.oid, 'INSERT')
              or has_any_column_privilege('authenticated', t.oid, 'INSERT')),
        ('w', has_table_privilege('authenticated', t.oid, 'UPDATE')
              or has_any_column_privilege('authenticated', t.oid, 'UPDATE')),
        ('d', has_table_privilege('authenticated', t.oid, 'DELETE'))) as cmd(c, held)
     where cmd.held
  )
  select string_agg(need.relname || ':' || need.c, ', ' order by need.relname, need.c)
    into v_bad
    from need
   where not exists (
     select 1 from pg_policy p
      where p.polrelid = need.oid
        and not p.polpermissive
        and p.polcmd in (need.c::"char", '*')
        and (p.polroles = array[0::oid] or 'authenticated'::regrole::oid = any (p.polroles))
        and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
              || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
            ~ '(live_role|is_live_admin)\(\)');
  if v_bad is not null then
    raise exception 'H16: a staff write with no RESTRICTIVE live policy: %', v_bad;
  end if;

  -- 3c. update_media_meta: a definer with an empty search_path that asks for the live role,
  --     executable by authenticated alone.
  if not exists (
    select 1 from pg_proc
     where oid = 'public.update_media_meta(uuid, int, jsonb)'::regprocedure
       and prosecdef
       and proconfig = array['search_path=""']
       and prosrc ~ 'app\.live_role\(\) is null'
  ) then
    raise exception 'H16: update_media_meta must be a definer with an empty search_path that checks app.live_role()';
  end if;
  if not has_function_privilege('authenticated', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or exists (
       select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = 'public.update_media_meta(uuid, int, jsonb)'::regprocedure
          and a.grantee = 0) then
    raise exception 'H16: update_media_meta must be executable by authenticated alone';
  end if;

  -- 3d. app.live_role() is what every policy above stands on: still a definer with an empty
  --     search_path, executable by authenticated, and not by anon or PUBLIC.
  if not exists (
    select 1 from pg_proc
     where oid = 'app.live_role()'::regprocedure
       and prosecdef
       and proconfig = array['search_path=""']
  ) or not has_function_privilege('authenticated', 'app.live_role()', 'execute')
    or has_function_privilege('anon', 'app.live_role()', 'execute') then
    raise exception 'H16: app.live_role() is not the definer the live policies need';
  end if;
end $$;
