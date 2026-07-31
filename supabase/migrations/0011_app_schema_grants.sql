-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 — Privileges: the layer 0001 opened but never granted, and the allowlist
--        that has to exist before it can be opened safely.
--
-- 0001 created schema `app` and put every RLS helper in it. No migration since has
-- granted USAGE on that schema to anybody. An RLS USING/WITH CHECK expression is
-- evaluated with the *querying* role's privileges, and 75 of the 76 policies in this
-- database call at least one `app.*` helper — every one of them written without a
-- `TO` clause, so every one applies to PUBLIC and is evaluated for `anon` on every
-- anonymous request. `anon` could not resolve the name `app.effective_tenant_id()`,
-- so the public site failed closed with 42501 `permission denied for schema app` on
-- tenants / services / portfolio / blog_posts / statistics / partner_logos — i.e. all
-- of it. SECURITY DEFINER on `app.default_tenant_id()` is not a workaround: definer
-- governs what the function BODY may touch, never the right to CALL it.
--
-- The obvious one-liner — `grant usage on schema app to anon` — is the WRONG fix and
-- would be a Pillar 1 breach, not a bug fix. Postgres grants EXECUTE on every new
-- function to PUBLIC by default, and schema `app` also holds app.purge_leads(),
-- app.run_retention(), app.purge_telemetry(), app.publish_scheduled() and
-- app.rollup_pageviews(). Nothing inside the DATABASE has ever stood in front of those
-- for anon except the missing USAGE — an accident of a forgotten grant, not an
-- authorization control. (There is a second, non-database barrier: PostgREST is
-- configured to expose `public` and `graphql_public` only — supabase/config.toml — so
-- `app` has never been routable as an RPC. That is a toggle in a dashboard, not a
-- privilege, and it is not what this migration is willing to rely on.)
--
-- Hence the order below, which is load-bearing and must not be rearranged:
--
--   1. REVOKE schema `app` from PUBLIC and every app role   (default-deny first)
--   2. ALTER DEFAULT PRIVILEGES so migration 0012+ cannot silently re-open it
--   3. GRANT USAGE on `app` — only now that there is nothing behind the door
--   4. GRANT EXECUTE back on an allowlist of read-only helpers, by full signature
--   5. Schema `public`: the same shape — revoke anon to zero, close the four policies
--      that would leak unpublished content the moment a grant exists, grant SELECT back
--      on an allowlist, then state the `authenticated` CMS surface explicitly
--   6. Assert the postconditions, so this migration cannot "succeed" while wrong
--
-- Forward-only and idempotent: every statement is a GRANT/REVOKE, a
-- drop-if-exists + create policy, a CREATE OR REPLACE, or a catalog-driven DO block.
-- (One deliberate exception: postcondition 6c is *designed* to raise on a re-run once a
-- later migration adds a PUBLIC-executable `app.*` routine. That is the point of it.)
-- CLAUDE.md §3 (Pillar 1), §5, §7, §9.
--
-- ⚠ TESTS OUTSTANDING (§4.5 / §9 — this migration is NOT "done" until they land):
--   • supabase/tests/grants_app_schema.test.sql does not exist yet. It is the pgTAP
--     mirror of the §6 postconditions: anon holds USAGE on `app` and EXECUTE on exactly
--     the step-4 allowlist and nothing else; anon holds SELECT and ONLY SELECT in
--     schema public; every privileged app.* routine is unreachable from anon and
--     authenticated.
--   • The four restrictive policies added in step 5b need per-role rows over
--     {admin, content_creator, seo, developer, anon, other_tenant} like every other
--     gate. In particular rls_admin_cms.test.sql's entity_seo fixture points at a
--     service id that never existed, so "anon reads entity_seo" currently passes for
--     the wrong reason — it must seed a published AND a draft entity and assert anon
--     sees exactly the published one.
-- The migration is applied ahead of its tests deliberately, because the site is down
-- without it. That is a §11 exception, not the standard: owner = Kareem, and it closes
-- when the two items above merge.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (flagged per §11 — each is a policy
-- decision, not a privilege one):
--   • `redirects`, `custom_themes` and `site_settings` have staff-only SELECT policies
--     (`app.is_staff()`), so anon reads them as zero rows no matter what is granted.
--     If the v1 redirects module or the theme is meant to render for anonymous
--     visitors, that needs a POLICY (or a service-role read path), not a GRANT.
--   • `public.leads` is table-granted to all `authenticated`, and `public.leads_safe` is
--     granted to all `authenticated` (0002:52) though CLAUDE.md §3/§7 say it explicitly
--     should not be, and name a column GRANT as part of the gate of record for
--     budget/timeline/internal_notes/ip_inet. Neither is fixable with a GRANT: table and
--     column privileges are held by the POSTGRES role, and all four app roles share the
--     single role `authenticated`, so no GRANT can tell Admin from SEO. RLS
--     (`leads_admin_dev_all`) is what distinguishes them, and it returns zero rows to
--     Content Creator and SEO. Step 5d narrows `authenticated` on `leads` to
--     SELECT+UPDATE, which is the most a privilege can contribute here.
--   • `portfolio_services` has a tenant-only SELECT policy, so a grant would expose the
--     service linkage of unpublished case studies. It is simply not granted to anon
--     (nothing reads it anonymously); if a public "related services" feature ever needs
--     it, it needs a parent-status join in the policy first.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══ 1. Close schema `app` before opening it ═════════════════════════════════
-- ROUTINES, not FUNCTIONS: `all routines` covers procedures too, so a future
-- `create procedure app.…` cannot slip past this line on a re-run.
--
-- All four grantees are named on purpose. `revoke … from public` removes only the
-- implicit PUBLIC grant and does nothing to a privilege held by name; there are no
-- by-name grants in schema `app` today, and naming the roles is what keeps that true if
-- one is ever added out-of-band. It also makes the step-4 allowlist authoritative for
-- exactly the four roles postcondition 6c audits.
revoke all privileges on all routines in schema app
  from public, anon, authenticated, service_role;

-- The specific ones, re-asserted by signature. Redundant after the blanket revoke and
-- kept anyway: this list is the greppable, reviewable statement of what must never be
-- reachable, and a signature that stops resolving here is a signature that changed.
revoke all on function app.run_retention()                  from public, anon, authenticated, service_role;
revoke all on function app.purge_leads()                    from public, anon, authenticated, service_role;
revoke all on function app.purge_telemetry()                from public, anon, authenticated, service_role;
revoke all on function app.purge_system_logs()              from public, anon, authenticated, service_role;
revoke all on function app.ensure_telemetry_partitions(int) from public, anon, authenticated, service_role;
revoke all on function app.publish_scheduled()              from public, anon, authenticated, service_role;
revoke all on function app.rollup_pageviews(int)            from public, anon, authenticated, service_role;

-- THE ACTUAL LIVE GAP. Every other privileged routine in `app` was revoked by the
-- migration that created it; `app.retention_max_int` never was (0008:164-168 lists the
-- other five and not it), so it still carries the default PUBLIC EXECUTE. It is
-- SECURITY DEFINER and reads `site_settings.retention` past that table's staff-only
-- policy with `max()` over every tenant row — no tenant predicate at all. What it
-- discloses is an integer retention horizon, not lead data, so this is a small leak
-- rather than a large one; it is still a read straight through the staff fence, and it
-- is the one routine whose exposure step 3 would have CREATED rather than inherited.
revoke all on function app.retention_max_int(text, int) from public, anon, authenticated, service_role;

-- Trigger functions. Postgres checks EXECUTE at CREATE TRIGGER time, not at fire time,
-- so revoking these cannot break a single write path — and three of them are SECURITY
-- DEFINER over material that must never be reachable from a session: tg_audit_chain
-- reads the Vault HMAC key that makes the audit chain tamper-evident, tg_notify_lead
-- reads NOTIFY_LEAD_SECRET and then makes an outbound HTTP call (a Vault-exfiltration
-- plus SSRF primitive in one function), tg_snapshot_version writes content history past
-- the writer's own RLS. Today they are unreachable only because Postgres refuses a
-- direct call to a `returns trigger` function (SQLSTATE 0A000) — that is a return-type
-- accident, not an authorization decision, and it evaporates the day a signature changes.
revoke all on function app.tg_audit_chain()      from public, anon, authenticated, service_role;
revoke all on function app.tg_notify_lead()      from public, anon, authenticated, service_role;
revoke all on function app.tg_snapshot_version() from public, anon, authenticated, service_role;
revoke all on function app.tg_set_updated_at()   from public, anon, authenticated, service_role;
revoke all on function app.tg_set_actor()        from public, anon, authenticated, service_role;
revoke all on function app.tg_set_updater()      from public, anon, authenticated, service_role;
revoke all on function app.tg_bump_version()     from public, anon, authenticated, service_role;

-- `supabase_auth_admin` gets the same treatment, guarded on the role existing: it is a
-- Supabase-platform role and a bare-Postgres host will not have it. EVERY reference to
-- that role in this file is guarded the same way, so the tolerance postcondition 6e
-- claims is real rather than merely asserted.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'revoke all privileges on all routines in schema app from supabase_auth_admin';
  end if;
end $$;

-- ═══ 2. Make the default deny survive the next migration ═════════════════════
-- Default privileges are keyed to (creating role, schema) — they bind objects created
-- BY that role, and they do not touch objects that already exist (step 1 did that).
-- The role to name is therefore whoever will own future functions in `app`: this repo's
-- migrations are applied by the Supabase CLI, which connects as `postgres`, and every
-- app.* function in 0001–0010 is owned by it. `supabase_admin` is included because a
-- dashboard-run statement executes as that role, and current_user because a CI or
-- local harness may push migrations as something else again.
--
-- Membership is checked rather than assumed: ALTER DEFAULT PRIVILEGES FOR ROLE x
-- requires membership in x, and a hard failure here would block a migration whose real
-- work is already done. A role we cannot bind gets a NOTICE, not an exception.
do $$
declare
  r text;
begin
  for r in select distinct x
             from unnest(array[current_user::text, 'postgres', 'supabase_admin']) x loop
    if not exists (select 1 from pg_roles where rolname = r) then
      continue;
    end if;
    if not pg_has_role(current_user, r, 'member') then
      raise notice 'default privileges NOT set for role % in schema app (current_user % is not a member) — a function created by % would arrive PUBLIC-executable', r, current_user, r;
      continue;
    end if;
    execute format('alter default privileges for role %I in schema app revoke execute on routines from public', r);
  end loop;
end $$;

-- ═══ 3. Open the door ════════════════════════════════════════════════════════
-- USAGE is the right to resolve names in the schema; it grants no EXECUTE by itself,
-- which is exactly why step 4 has to be explicit.
--
--   anon          — evaluates the policy expressions on every public read
--   authenticated — the same, plus column DEFAULTs and STORED generated columns on
--                   write. The entire CMS runs as this role: the admin client is the
--                   ANON KEY carrying the user's JWT (src/lib/auth/session.ts), not the
--                   service key, so RLS is the primary layer exactly as §3 requires —
--                   and every admin request evaluates these helpers.
--   service_role  — BYPASSRLS skips policy evaluation but grants no schema USAGE; it
--                   still evaluates `default app.effective_tenant_id()` on any insert
--                   that omits tenant_id.
grant usage on schema app to anon, authenticated, service_role;

-- supabase_auth_admin is not a nicety. `public.custom_access_token_hook` (0010) is
-- deliberately NOT security definer, and its read of FORCE-RLS `public.profiles` ORs in
-- `profiles_admin_write` and `profiles_self_select`, both of which call
-- app.effective_tenant_id()/app.is_admin(). Policies are applied in name order, so those
-- are resolved before the `using (true)` branch that would fold the qual away. Omit this
-- and every token mint and refresh fails — an outage that presents as an unrelated auth
-- bug, not as a permissions one.
--
-- The list is exactly the transitive closure of those two policies and nothing more:
-- is_staff() and can_write_content() are NOT in it, because `profiles` does not call
-- them and GoTrue has no business evaluating a content capability.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    raise notice 'supabase_auth_admin absent — skipping the token-hook grants (expected ONLY on bare-Postgres CI; on Supabase this would mean nobody can log in)';
    return;
  end if;
  execute 'grant usage on schema app to supabase_auth_admin';
  execute 'grant execute on function app.current_tenant_id()   to supabase_auth_admin';
  execute 'grant execute on function app.default_tenant_id()   to supabase_auth_admin';
  execute 'grant execute on function app.effective_tenant_id() to supabase_auth_admin';
  execute 'grant execute on function app.current_role()        to supabase_auth_admin';
  execute 'grant execute on function app.is_admin()            to supabase_auth_admin';
end $$;

-- ═══ 4. Hand back EXECUTE — allowlist only, by full signature ════════════════
-- Never `grant execute on all functions in schema app`: that is the blanket grant that
-- would re-expose purge_leads() and is the exact mistake step 1 exists to prevent.
--
-- The list is the TRANSITIVE closure, not the set of names that appear in policy text.
-- app.effective_tenant_id/is_staff/is_admin/can_write_content are plain `language sql`
-- (SECURITY INVOKER), so the planner inlines them and re-resolves their bodies as the
-- caller — granting only the leaf helpers named in policies leaves anon 42501-ing from
-- *inside* effective_tenant_id. That inlining is also why the error says "schema app"
-- rather than "function app.x": the failure is a namespace lookup at plan time.
--
-- Every function here is read-only and carries no privilege of its own:
--   current_tenant_id / current_role  — read the caller's OWN JWT claim
--   default_tenant_id                 — SECURITY DEFINER, returns the launch tenant uuid.
--                                       This IS the anon tenant fence (§3): anon must be
--                                       able to resolve exactly one tenant and no other.
--                                       The uuid is not a secret; the fence is the point.
--   effective_tenant_id               — coalesce of the two; the tenant predicate in
--                                       every policy and the DEFAULT on ~24 tables
--   is_staff / is_admin / can_write_content — pure predicates over current_role(), which
--                                       is itself granted, so they hand a caller nothing
--                                       it could not already compute about its own token
--   normalize_ar / normalize_ar_q     — IMMUTABLE pure text transforms, already reachable
--                                       by design through public.search_content /
--                                       public.search_suggest (granted to anon at 0006:156)
--
-- can_write_content() and current_role() are on the anon list because a dozen policies
-- are permissive `FOR ALL`, and a FOR ALL policy's USING clause is OR'd into the SELECT
-- qualifier — `categories_write`, `pages_write`, `navigation_write`, `entity_seo_write`
-- and friends are all evaluated on an anonymous SELECT. is_admin() is on it for the same
-- mechanism rather than a current call site: no FOR ALL policy on an anon-readable table
-- calls it TODAY, and the first one that does would 42501 the entire public site. (The
-- RESTRICTIVE gates in 0007/0009 are all `for delete` / `for update`, so they are NOT
-- part of that argument — a command-scoped restrictive policy never touches a SELECT.)
grant execute on function app.current_tenant_id()      to anon, authenticated, service_role;
grant execute on function app.default_tenant_id()      to anon, authenticated, service_role;
grant execute on function app.effective_tenant_id()    to anon, authenticated, service_role;
grant execute on function app.current_role()           to anon, authenticated, service_role;
grant execute on function app.is_staff()               to anon, authenticated, service_role;
grant execute on function app.is_admin()               to anon, authenticated, service_role;
grant execute on function app.can_write_content()      to anon, authenticated, service_role;
grant execute on function app.normalize_ar(text)       to anon, authenticated, service_role;
grant execute on function app.normalize_ar_q(text)     to anon, authenticated, service_role;

-- Write-side only. The STORED generated columns services.search_ar / blog_posts.search_ar
-- / portfolio.search_ar re-evaluate this on every INSERT and UPDATE, in the writer's
-- session, with the WRITER's privileges — so the CMS cannot save a service or a blog post
-- without it, even after the read path is fixed. anon never writes content (public writes
-- go through submit-contact-form as service_role), so anon does not get it.
grant execute on function app.ar_tsvector(text) to authenticated, service_role;

-- ═══ 5. Schema `public` ══════════════════════════════════════════════════════
-- RLS is only consulted AFTER the table GRANT passes, so a missing table privilege is a
-- second, independent way to produce the same 401 — and the observed error does NOT
-- exonerate the table ACLs: schema resolution happens while the planner inlines the
-- policy expression, which is strictly before the executor's permission check. The
-- `permission denied for schema app` message would have masked a missing SELECT.
--
-- That argument cuts both ways, which is why this step states BOTH role surfaces
-- explicitly instead of granting to anon and leaving `authenticated` to defaults it has
-- just finished arguing cannot be verified from the outside.

-- ---- 5a. anon → zero, then an allowlist ------------------------------------
-- Supabase's stock bootstrap runs `alter default privileges in schema public grant ALL
-- on tables to postgres, anon, authenticated, service_role`, so every table created by
-- 0001–0010 most likely carries INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER for
-- `anon`. Additively granting SELECT would leave all of that in place: RLS would be the
-- ONLY thing between an anonymous visitor and a write — one layer, not the two §3
-- requires — and TRUNCATE is not subject to RLS at all.
--
-- One blanket revoke rather than an enumeration, because this must be exhaustive and an
-- enumeration is a list that drifts: it covers all 36 tables, both views (leads_safe,
-- dashboard_attention) and every telemetry partition in one statement whose completeness
-- is a property of the catalog rather than of this file.
revoke all privileges on all tables in schema public from anon;

-- Sequences too. anon inserts nowhere after the line above, so nextval/currval are dead
-- weight — and UPDATE on a sequence is setval, i.e. the ability to force a primary-key
-- collision on the audit chain. Behaviour-preserving, so there is no reason to keep it.
revoke all privileges on all sequences in schema public from anon;

-- ---- 5b. Close what a SELECT grant would open ------------------------------
-- Four tables have SELECT policies with NO status and NO visibility predicate. That was
-- invisible while the missing USAGE failed every anonymous read closed; granting SELECT
-- without fixing it would CREATE four disclosures rather than restore a site. The
-- accident was doing the enforcing, so removing the accident means writing the rule down.
--
-- Every policy below is `as restrictive`, so it ANDs with the existing permissive one and
-- can only narrow. Every one has an `app.is_staff()` escape, so every admin path — the
-- editors, export-backup, the version snapshots — is unaffected: all four app roles are
-- staff. That escape is is_staff() and not is_admin() on purpose: a restrictive SELECT
-- policy is also applied to UPDATE and DELETE statements that reference columns, so a
-- narrower escape would have silently broken Content Creator's edits.
--
-- drop-then-create so a re-run is a no-op rather than a duplicate-object error.

-- navigation: `navigation_read` (0009:253) is tenant-only. The `visible = true` filter
-- lives in the query at src/lib/data/navigation.ts:38 — application layer, one layer —
-- and PostgREST lets a caller send `?visible=eq.false` instead. §5 gives Admin+Developer
-- a "hidden pages / page visibility" capability; without this the hrefs it exists to
-- hide are anonymously enumerable.
drop policy if exists navigation_visible_only on public.navigation;
create policy navigation_visible_only on public.navigation
  as restrictive for select
  using (visible or app.is_staff());

-- partner_logos: same shape (0001:447 is tenant-only; src/lib/data/partnerLogos.ts:19
-- does the filtering). A hidden partner logo is typically an unannounced client.
drop policy if exists partner_logos_visible_only on public.partner_logos;
create policy partner_logos_visible_only on public.partner_logos
  as restrictive for select
  using (visible or app.is_staff());

-- page_sections: `page_sections_read` (0001:367) is a bare tenant match — no status, no
-- `visible`, and no join to `pages.status`. `pages` itself IS correctly gated to
-- published-or-staff (0001:344), so without this the parent is hidden and the body is
-- not: the `content` jsonb of every draft, scheduled and archived page, plus every
-- hidden section. The only restrictive policy the table already had (0007:27) is FOR
-- DELETE. The table is deliberately NOT in the anon grant list below — nothing reads it
-- anonymously yet (src/lib/sections/types.ts notes the section renderer is still Phase
-- 3) — so today this is a second layer behind a closed door. It is here so that the day
-- the renderer lands, turning it on is a one-line grant and not a re-litigation.
drop policy if exists page_sections_published_only on public.page_sections;
create policy page_sections_published_only on public.page_sections
  as restrictive for select
  using (
    app.is_staff()
    or (
      visible
      and exists (
        select 1 from public.pages p
         where p.id = page_sections.page_id
           and p.status = 'published'
      )
    )
  );

-- entity_seo: `entity_seo_read` (0009:292) is tenant-only. This grant is load-bearing —
-- src/lib/data/seo.ts:53 reads it with the anon client, and it is what makes the SEO
-- role's work reach a visitor — so the fix has to be a policy, not a removal. 0009's
-- comment ("meta tags are public by construction, they ship in the HTML head") is true
-- only for PUBLISHED entities; for a draft it is the title and description of unreleased
-- work, and the entire unreleased pipeline would be enumerable in one request.
--
-- Fail-closed on an orphan: a row whose parent no longer exists matches none of the four
-- branches and stays hidden. Fail-open would have been the smaller case to defend and
-- the wrong default to write down.
drop policy if exists entity_seo_published_only on public.entity_seo;
create policy entity_seo_published_only on public.entity_seo
  as restrictive for select
  using (
    app.is_staff()
    or (entity_type = 'service' and exists (
          select 1 from public.services s
           where s.id = entity_seo.entity_id and s.status = 'published'))
    or (entity_type = 'blog_post' and exists (
          select 1 from public.blog_posts b
           where b.id = entity_seo.entity_id and b.status = 'published'))
    or (entity_type = 'portfolio' and exists (
          select 1 from public.portfolio p
           where p.id = entity_seo.entity_id and p.status = 'published'))
    or (entity_type = 'page' and exists (
          select 1 from public.pages pg
           where pg.id = entity_seo.entity_id and pg.status = 'published'))
  );

-- ---- 5c. The anon read surface, in full ------------------------------------
-- SELECT and nothing else, on exactly the relations an anonymous visitor must reach.
-- Traced from every `anonClient()` call site in src/ rather than from the policy set:
-- the loaders in src/lib/data/*.ts, the two PostgREST embeds in blog.ts
-- (`author:team_members(...)`, `category:categories(...)`, each of which needs its own
-- SELECT), the three tables the search RPCs read as SECURITY INVOKER, and the four
-- parents the entity_seo policy above joins to.
--
-- `pages` has no anonymous reader today. It is granted because the entity_seo restrictive
-- policy must be able to evaluate `exists (… from public.pages …)` as anon, and because
-- `pages_read` is already gated to published-or-staff, so the grant discloses nothing a
-- published page does not.
--
-- ai_questions / ai_styles are here because their SELECT policies (0009) have the same
-- `status = 'published' or app.is_staff()` shape as services: they are public quiz
-- content. `ai_config` — the results/logic configuration, Admin-only in §5 — is a
-- separate table for exactly this reason and is not granted.
--
-- NOT granted, each for a reason:
--   tenants            — no anonymous reader. `app.default_tenant_id()` is SECURITY
--                        DEFINER, so the anon fence resolves the launch tenant with the
--                        OWNER's rights and needs no privilege here; the only other
--                        reader, src/lib/data/tenant.ts, uses serviceClient(). A grant
--                        would publish `name` and `primary_domain` for no consumer.
--   page_sections      — see 5b: no anonymous reader, unpublished page bodies.
--   portfolio_services — tenant-only policy; would expose the service linkage of
--                        unpublished case studies. Only reader is the admin CRUD.
--
-- CONSEQUENCE FOR FUTURE MIGRATIONS: a new public-readable table OR VIEW in schema
-- `public` will NOT be readable by anon until it is granted by name —
--     grant select on public.<relation> to anon;
-- next to its `create policy`. That failure mode is a loud 401 on a relation nobody has
-- opened yet, which is the direction this class of mistake should fail in.
grant select on
  public.categories,
  public.services,
  public.blog_posts,
  public.portfolio,
  public.pages,
  public.team_members,
  public.certifications,
  public.statistics,
  public.partner_logos,
  public.navigation,
  public.entity_seo,
  public.seo_defaults,
  public.ai_questions,
  public.ai_styles
to anon;

-- ---- 5d. The `authenticated` surface, stated rather than inherited ---------
-- `authenticated` is the role EVERY staff member connects as — Admin, Content Creator,
-- SEO and Developer all share it — so a table privilege here cannot distinguish them and
-- is not the authorization boundary. RLS is, with assertCap() as the second layer. What
-- a privilege CAN decide is whether a command is reachable at all, so the rule applied
-- below is: grant exactly the commands for which the relation carries a policy admitting
-- some staff role, and withhold the rest.
--
-- Stated explicitly rather than left to Supabase's default privileges, for the same
-- reason as the anon grants: the 42501 being fixed is raised during planner inlining,
-- BEFORE the executor's table permission check, so the outage told us nothing about
-- whether those defaults ever applied. If they did, every line here is a no-op. If they
-- did not, these lines are the difference between "the public site is back" and "the
-- public site is back, every admin save still 401s, and nobody was told".

-- Content the CMS creates, edits and deletes.
grant select, insert, update, delete on
  public.services,
  public.blog_posts,
  public.portfolio,
  public.portfolio_services,
  public.pages,
  public.page_sections,
  public.categories,
  public.team_members,
  public.certifications,
  public.statistics,
  public.partner_logos,
  public.navigation,
  public.media_assets,
  public.redirects,
  public.custom_themes,
  public.entity_seo,
  public.ai_questions,
  public.ai_styles
to authenticated;

-- Singletons keyed by tenant_id: upserted, never deleted. Withholding DELETE means no
-- session token can drop a tenant's settings row through PostgREST, whatever its role.
grant select, insert, update on
  public.site_settings,
  public.site_integrations,
  public.seo_defaults,
  public.ai_config
to authenticated;

-- Append-only and near-append-only ledgers.
--   audit_log        — staff insert + Admin/Developer read. UPDATE and DELETE were hard-
--                      revoked at 0002:108 and stay revoked; the chain is the point.
--   content_versions — written by the SECURITY DEFINER snapshot trigger, read by staff.
--   system_logs      — staff insert, Admin/Developer read, Admin clear (§5).
grant select, insert on public.audit_log to authenticated;
grant select, insert on public.content_versions to authenticated;
grant select, insert, delete on public.system_logs to authenticated;

-- A bigserial primary key needs its sequence; an identity column (analytics_events,
-- web_vitals) does not. USAGE is nextval/currval only — it is UPDATE that would permit
-- setval, i.e. forcing a primary-key collision on the audit chain, and that is withheld.
do $$
begin
  if to_regclass('public.audit_log_id_seq') is not null then
    execute 'grant usage on sequence public.audit_log_id_seq to authenticated';
  end if;
  if to_regclass('public.system_logs_id_seq') is not null then
    execute 'grant usage on sequence public.system_logs_id_seq to authenticated';
  end if;
end $$;

-- Leads: SELECT + UPDATE only (§5 "Leads — view list / manage status / notes"). INSERT
-- belongs to submit-contact-form as service_role, which resolves the tenant server-side;
-- DELETE belongs to app.purge_leads(), the SECURITY DEFINER retention job. Withholding
-- both means no admin session can forge or destroy a lead by talking to PostgREST — a
-- real second layer, and the most a privilege can contribute given all four app roles
-- share this one Postgres role.
grant select, update on public.leads to authenticated;

-- Read-only surfaces: dashboards, logs and ledgers whose only writer is service_role or
-- a definer function. RLS narrows each to the roles §5 names.
grant select on
  public.rollup_daily_pageviews,
  public.analytics_events,
  public.web_vitals,
  public.search_queries,
  public.consent_log,
  public.notification_log,
  public.tenants
to authenticated;

-- Profiles: SELECT only. `profiles_self_select` is a legitimate read, but every WRITE to
-- this table in the codebase goes through the service-role user-management endpoints,
-- which pair it with assertCap() + liveRecheck() + an audit entry
-- (src/pages/api/admin/users/*). Withholding DML means a stolen admin session cannot
-- self-promote or deactivate a colleague by addressing PostgREST directly; it has to go
-- through the audited path. Nothing in src/ writes profiles as `authenticated`.
grant select on public.profiles to authenticated;

-- The two views, re-asserted (0002:52 and 0009:660 granted them; 5a's blanket revoke
-- touched only anon). leads_safe's over-broad grant is flagged in the header — RLS, not
-- this GRANT, is what keeps Content Creator and SEO out of it.
grant select on public.leads_safe, public.dashboard_attention to authenticated;

-- Tables with NO policy at all: the service-role export and lockout paths are their only
-- reader and writer, so RLS already answers zero rows to `authenticated`. Revoking makes
-- that two layers instead of one, and is provably behaviour-preserving.
revoke all on public.login_attempts, public.privileged_ops from authenticated;

-- ---- 5e. Telemetry partitions ----------------------------------------------
-- A partition carries its own ACL and its own RLS settings, and PostgREST publishes
-- `analytics_events_2026_07` as its own endpoint — so a partition is a way to address
-- the rows AROUND the parent's policies. Privileges on a partition are not consulted
-- when the data is reached through the partitioned parent (Postgres checks the relation
-- named in the query, which is why partitioned tables need no per-partition grants), so
-- revoking them breaks neither the service-role ingest nor the admin dashboards.
--
-- Catalog-driven so it covers whatever the roll-forward job has already created.
do $$
declare
  p record;
begin
  for p in
    select cn.nspname as schema_name, c.relname as table_name
      from pg_inherits i
      join pg_class c  on c.oid = i.inhrelid
      join pg_namespace cn on cn.oid = c.relnamespace
      join pg_class par on par.oid = i.inhparent
      join pg_namespace pn on pn.oid = par.relnamespace
     where pn.nspname = 'public'
       and par.relname in ('analytics_events', 'web_vitals')
  loop
    execute format('revoke all on %I.%I from anon, authenticated', p.schema_name, p.table_name);
  end loop;
end $$;

-- …and for the ones that do not exist yet. `app.ensure_telemetry_partitions()` creates a
-- new telemetry partition every month, as `postgres`, forever — so without this the hole
-- above reappears on a schedule. Fixed at the source rather than with an ALTER DEFAULT
-- PRIVILEGES, because ADP is per-SCHEMA: revoking future-table privileges from
-- `authenticated` across all of `public` would silently break the next CMS table anyone
-- adds. The body is 0008's, unchanged, plus one revoke. CREATE OR REPLACE preserves a
-- function's ACL, and the revoke below re-asserts step 1 regardless.
create or replace function app.ensure_telemetry_partitions(p_months_ahead int default 2)
  returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  parent text;
  i int;
  m_start date;
  m_end date;
  part_name text;
  made int := 0;
begin
  foreach parent in array array['analytics_events', 'web_vitals'] loop
    for i in 0..p_months_ahead loop
      m_start := (date_trunc('month', now()) + make_interval(months => i))::date;
      m_end := (m_start + interval '1 month')::date;
      part_name := parent || '_' || to_char(m_start, 'YYYY_MM');
      if not exists (select 1 from pg_class where relname = part_name) then
        execute format(
          'create table public.%I partition of public.%I for values from (%L) to (%L)',
          part_name, parent, m_start, m_end
        );
        -- 0011: born closed. A partition is separately addressable and does not inherit
        -- the parent's policies; access through the parent is unaffected by this.
        execute format('revoke all on public.%I from anon, authenticated', part_name);
        made := made + 1;
      end if;
    end loop;
  end loop;
  return made;
end $$;

revoke all on function app.ensure_telemetry_partitions(int)
  from public, anon, authenticated, service_role;

-- Belt to that braces: any OTHER path that creates a table in `public` — a dashboard
-- statement, a future migration — still produces one anon cannot read until it is granted
-- by name. Scoped to anon only, for the ADP-is-per-schema reason given above.
do $$
declare
  r text;
begin
  for r in select distinct x
             from unnest(array[current_user::text, 'postgres', 'supabase_admin']) x loop
    if not exists (select 1 from pg_roles where rolname = r) then
      continue;
    end if;
    if not pg_has_role(current_user, r, 'member') then
      raise notice 'default privileges NOT set for role % in schema public — future tables it creates may arrive anon-readable', r;
      continue;
    end if;
    execute format('alter default privileges for role %I in schema public revoke all on tables from anon', r);
  end loop;
end $$;

-- ═══ 6. Postconditions ═══════════════════════════════════════════════════════
-- A privileges migration that "succeeds" while leaving the public site 401-ing, or the
-- admin 401-ing, or a purge routine reachable, is worse than one that fails: the first
-- two are invisible and the third is a Pillar 1 breach. So assert all of it, here, on
-- the live catalog.
--
-- §9 requires a pgTAP mirror of this block at supabase/tests/grants_app_schema.test.sql.
-- That file does NOT exist yet — it is the outstanding piece of this change's Definition
-- of Done — which is why every check below raises instead of warning: until it lands,
-- this is the only enforcement there is.

-- ---- 6a. The public read path is actually open ------------------------------
do $$
begin
  if not has_schema_privilege('anon', 'app', 'usage') then
    raise exception 'anon still lacks USAGE on schema app — every public read will 42501';
  end if;
  if not has_function_privilege('anon', 'app.effective_tenant_id()', 'execute') then
    raise exception 'anon still lacks EXECUTE on app.effective_tenant_id() — the tenant predicate in every policy';
  end if;
  if not has_function_privilege('anon', 'app.default_tenant_id()', 'execute') then
    raise exception 'anon still lacks EXECUTE on app.default_tenant_id() — the anon tenant fence itself';
  end if;
  if not has_schema_privilege('anon', 'public', 'usage') then
    raise exception 'anon lacks USAGE on schema public — PostgREST cannot reach any relation';
  end if;
  if not has_table_privilege('anon', 'public.services', 'select') then
    raise exception 'anon lacks SELECT on public.services — the table GRANT layer is still closed';
  end if;
  if not has_function_privilege('anon', 'public.search_content(text, text)', 'execute') then
    raise exception 'anon lacks EXECUTE on public.search_content(text, text) — site search is broken';
  end if;
end $$;

-- ---- 6b. The CMS write path is actually open --------------------------------
-- Everything the admin does runs as `authenticated` through the anon key plus the user's
-- JWT, so this half is exactly as load-bearing as 6a and fails exactly as silently.
do $$
declare
  v_missing text;
begin
  if not has_schema_privilege('authenticated', 'app', 'usage') then
    raise exception 'authenticated lacks USAGE on schema app — every admin request evaluates a policy that needs it';
  end if;
  if not has_function_privilege('authenticated', 'app.ar_tsvector(text)', 'execute') then
    raise exception 'authenticated lacks EXECUTE on app.ar_tsvector(text) — the STORED search_ar columns re-evaluate it in the writer''s session, so no service or post could be saved';
  end if;

  select string_agg(format('%s on public.%s', p.priv, c.relname), E'\n  '
                    order by c.relname, p.priv)
    into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(
      case
        when c.relname in ('site_settings', 'site_integrations', 'seo_defaults', 'ai_config')
          then array['select', 'insert', 'update']
        when c.relname in ('audit_log', 'content_versions')
          then array['select', 'insert']
        when c.relname = 'system_logs'
          then array['select', 'insert', 'delete']
        when c.relname = 'leads'
          then array['select', 'update']
        when c.relname in ('rollup_daily_pageviews', 'search_queries', 'web_vitals', 'profiles')
          then array['select']
        else array['select', 'insert', 'update', 'delete']
      end
    ) as p(priv)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relname in (
       'services', 'blog_posts', 'portfolio', 'portfolio_services', 'pages',
       'page_sections', 'categories', 'team_members', 'certifications', 'statistics',
       'partner_logos', 'navigation', 'media_assets', 'redirects', 'custom_themes',
       'entity_seo', 'ai_questions', 'ai_styles', 'site_settings', 'site_integrations',
       'seo_defaults', 'ai_config', 'audit_log', 'content_versions', 'system_logs',
       'leads', 'rollup_daily_pageviews', 'search_queries', 'web_vitals', 'profiles'
     )
     and not has_table_privilege('authenticated', c.oid, p.priv);

  if v_missing is not null then
    raise exception E'the CMS write path is NOT open — `authenticated` is missing:\n  %', v_missing;
  end if;
end $$;

-- ---- 6c. Schema `app` is default-deny ---------------------------------------
-- Catalog-driven rather than a fixed list of the dangerous ones, so a function added by
-- a LATER migration that arrives PUBLIC-executable fails this migration's own re-run.
do $$
declare
  v_offenders text;
begin
  with allowed(grantee, sig) as (
    values
      ('anon',                'app.current_tenant_id()'),
      ('anon',                'app.default_tenant_id()'),
      ('anon',                'app.effective_tenant_id()'),
      ('anon',                'app.current_role()'),
      ('anon',                'app.is_staff()'),
      ('anon',                'app.is_admin()'),
      ('anon',                'app.can_write_content()'),
      ('anon',                'app.normalize_ar(text)'),
      ('anon',                'app.normalize_ar_q(text)'),
      ('authenticated',       'app.current_tenant_id()'),
      ('authenticated',       'app.default_tenant_id()'),
      ('authenticated',       'app.effective_tenant_id()'),
      ('authenticated',       'app.current_role()'),
      ('authenticated',       'app.is_staff()'),
      ('authenticated',       'app.is_admin()'),
      ('authenticated',       'app.can_write_content()'),
      ('authenticated',       'app.normalize_ar(text)'),
      ('authenticated',       'app.normalize_ar_q(text)'),
      ('authenticated',       'app.ar_tsvector(text)'),
      ('service_role',        'app.current_tenant_id()'),
      ('service_role',        'app.default_tenant_id()'),
      ('service_role',        'app.effective_tenant_id()'),
      ('service_role',        'app.current_role()'),
      ('service_role',        'app.is_staff()'),
      ('service_role',        'app.is_admin()'),
      ('service_role',        'app.can_write_content()'),
      ('service_role',        'app.normalize_ar(text)'),
      ('service_role',        'app.normalize_ar_q(text)'),
      ('service_role',        'app.ar_tsvector(text)'),
      ('supabase_auth_admin', 'app.current_tenant_id()'),
      ('supabase_auth_admin', 'app.default_tenant_id()'),
      ('supabase_auth_admin', 'app.effective_tenant_id()'),
      ('supabase_auth_admin', 'app.current_role()'),
      ('supabase_auth_admin', 'app.is_admin()')
  ),
  -- Superusers are skipped: has_function_privilege() is true for them by definition, so
  -- including one would fail this check for a reason no GRANT could fix. A role absent
  -- from the host (supabase_auth_admin on bare Postgres) simply produces no rows.
  graded as (
    select g.rolname as grantee, p.oid, p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (
        select rolname from pg_roles
         where rolname in ('anon', 'authenticated', 'service_role', 'supabase_auth_admin')
           and not rolsuper
      ) g
     where n.nspname = 'app'
       and has_function_privilege(g.rolname, p.oid, 'execute')
  )
  select string_agg(format('%s -> %s', gr.grantee, gr.sig), E'\n  ' order by gr.grantee, gr.sig)
    into v_offenders
    from graded gr
   where not exists (
     select 1 from allowed a
      where a.grantee = gr.grantee
        and to_regprocedure(a.sig) = gr.oid
   );

  if v_offenders is not null then
    raise exception E'schema app is not default-deny — EXECUTE is reachable outside the allowlist. Revoke each of these, or add it to the 0011 §6c allowlist and the pgTAP mirror with a reason:\n  %', v_offenders;
  end if;
end $$;

-- ---- 6d. Schema `public` is default-deny for anon ---------------------------
-- The table-level mirror of 6c, and the check an additive-grant version of this migration
-- could not have had: SELECT on the allowlist and NOTHING else, anywhere, for any relkind.
-- Catches both a leftover Supabase default (INSERT/UPDATE/DELETE/TRUNCATE on a content
-- table) and a future migration that hands anon something without saying so here.
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s: %s', c.relname, p.priv), E'\n  ' order by c.relname, p.priv)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('select'), ('insert'), ('update'), ('delete'),
                       ('truncate'), ('references'), ('trigger')) p(priv)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege('anon', c.oid, p.priv)
     and not (
       p.priv = 'select'
       and c.relname in ('categories', 'services', 'blog_posts', 'portfolio', 'pages',
                         'team_members', 'certifications', 'statistics', 'partner_logos',
                         'navigation', 'entity_seo', 'seo_defaults',
                         'ai_questions', 'ai_styles')
     );

  if v_bad is not null then
    raise exception E'anon holds privileges in schema public outside the SELECT allowlist:\n  %', v_bad;
  end if;
end $$;

-- ---- 6e. The recursion that lets the anon fence terminate -------------------
-- `app.default_tenant_id()` is SECURITY DEFINER and reads `public.tenants`, which is
-- FORCE RLS — and `tenants_select` calls app.effective_tenant_id(), which calls
-- app.default_tenant_id(). That loop terminates only because the function's OWNER
-- bypasses RLS (Supabase's `postgres` carries BYPASSRLS, and BYPASSRLS is a role
-- attribute that FORCE does not override). Reassign ownership to a role without it and
-- every anonymous read becomes "infinite recursion detected in policy for relation
-- tenants" instead of working. A warning rather than an exception: it is a property of
-- the environment, not of this migration, and a bare-Postgres CI host may differ.
do $$
declare
  v_owner text;
  v_ok boolean;
begin
  select r.rolname, (r.rolsuper or r.rolbypassrls)
    into v_owner, v_ok
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where n.nspname = 'app' and p.proname = 'default_tenant_id';

  if v_owner is not null and v_ok is not true then
    raise warning 'app.default_tenant_id() is owned by % which has neither SUPERUSER nor BYPASSRLS — the tenants policy will recurse instead of resolving the anon fence', v_owner;
  end if;
end $$;

-- ---- 6f. service_role can still write ---------------------------------------
-- Advisory. service_role's BYPASSRLS skips policies but NOT table privileges, and it is
-- the ingest path for leads, telemetry, consent and system logs. If Supabase's stock
-- default privileges never applied, that path is broken in the same silent way the read
-- path was — but restoring it is a wider decision than a privileges patch, so this
-- reports rather than acts. Guarded on the role existing, and joined through pg_class
-- rather than to_regclass() so a table that does not exist is simply absent from the
-- scan: has_table_privilege() raises on an unknown relation, and SQL gives no
-- evaluation-order guarantee that would make a `where` guard reliable.
do $$
declare
  v_missing text;
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role' and not rolsuper) then
    return;
  end if;

  select string_agg(format('service_role lacks %s on public.%s', p.priv, c.relname), E'\n  '
                    order by c.relname, p.priv)
    into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('select'), ('insert')) p(priv)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relname in ('leads', 'system_logs', 'analytics_events', 'web_vitals',
                       'search_queries', 'consent_log', 'notification_log',
                       'privileged_ops', 'login_attempts', 'tenants', 'profiles')
     and not has_table_privilege('service_role', c.oid, p.priv);

  if v_missing is not null then
    raise warning E'the service-role ingest path may be broken — Supabase default privileges may not have applied when 0001-0010 were pushed:\n  %', v_missing;
  end if;
end $$;
