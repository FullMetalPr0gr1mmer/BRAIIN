# Admin v2: adversarial verification (2026-10-03)

> Four independent reviewers tried to refute the three designs ([releases.md](releases.md),
> [crm.md](crm.md), [ui.md](ui.md)) against the code, the standard and vendor documentation.
> Every refuted or partly-true claim was folded into the program ([README.md](README.md),
> "Verification findings"), which is why README wins wherever a design and README disagree.
> The live defects they found shipped first, as hotfixes H1 to H4. The TDD coverage table is
> in [deviations.md](deviations.md).

## Releases (site-wide publish)

I tried to refute the release design's six claim groups against the repo (the repository at 479b675), node_modules (astro 7.3.5, @astrojs/cloudflare 14.3.3, wrangler 4.140.0, workerd 1.20260923.1), the PostgreSQL 15 docs (local major_version = 15), and the Supabase, PostgREST and Cloudflare docs. I also read the braiin-admin-handoff README and ADMIN_TDD sections 8.3 and 9. They agree with the design's preview and publish intent. The design is right to reject the handoff bridge, which uses postMessage '*' and raw innerHTML, and its rebuild-on-publish model (TDD Option A).

What holds:
- The core apply mechanism is sound. A SECURITY INVOKER function called as service_role through PostgREST can SET LOCAL ROLE authenticated and later service_role. The membership check is against session_user, and Supabase grants authenticator anon, authenticated and service_role by default.
- set_config(..., true) and SET LOCAL ROLE persist for the rest of the transaction, because the function's SET clause names other variables.
- Every RLS helper (app.current_role, app.current_tenant_id, app.effective_tenant_id, auth.uid) reads request.jwt.claims when it is called. No policy depends on auth.jwt(), auth.role() or current_user, so the impersonation really does bind RLS, the RESTRICTIVE gates and the guard triggers.
- PostgREST v12 hoists the function's statement_timeout, so the 20 s limit is real. Without it, service_role inherits authenticator's 8 s.
- The txid token cannot be forged from PostgREST. No exposed function calls set_config, and the app schema is not exposed.
- AsyncLocalStorage is available with nodejs_compat. Astro 7's own renderForPrerender uses the same technique in workerd: an AsyncLocalStorage scope with the body buffered inside it. That is strong evidence for the preview seam.
- Purge by tag is on every Cloudflare plan: Free allows 5 requests/min, bucket 25, up to 100 tags per request. Nothing caches Tier A responses on workers.dev today.

What fails or is partly true:
1. The new flag site_settings.releases_enabled can be changed by any Admin or Developer directly through PostgREST, because site_settings_write is FOR ALL for those roles and authenticated holds UPDATE on the table. That disarms the guard.
2. Slice R14 makes the CI seed enable releases for the launch tenant. db-tests.yml runs `supabase start`, which loads seed.sql, so rls_admin_cms.test.sql and rls_services.test.sql would fail. Both make staff writes in the launch tenant. This contradicts §9's "existing suites stay green".
3. apply_release injects claims with set_config. That breaks CLAUDE.md §9 ("set_config claim injection restricted to the pgTAP harness") and no amendment covers it. Three more CLAUDE.md conflicts need amending:
   - the release_items insert policy has no tenant predicate (§3);
   - two new tables do not have the §8 standard columns: app.release_entities has no tenant_id, id or timestamps; content_release_items has no updated_* columns;
   - §5 says Developer has "NO publish/schedule", but the design lets Developer publish and schedule identity and theme releases.
4. The write-path inventory misses src/pages/api/admin/pages/visibility/[id].ts. Once the guard is armed it refuses even Admin.
5. The pg_trigger_depth() > 1 exemption is not needed by any current write path, so it only widens the bypass.
6. Child rows deleted by cascade are never captured: portfolio_services when a service is deleted, both child tables when a portfolio is deleted. Rollback loses those link sets.
7. Each item runs in its own exception block, which means one subtransaction per item. Releases with more than 64 items overflow the subtransaction cache, which slows the whole database while the publish runs.
8. The preview dataset's 2,000 rows/table cap is silently cut to 1,000 by Supabase's default max_rows.
9. The overlay client's real query surface is smaller than designed. Loaders use only eq, in and contains filters, order, limit, maybeSingle and FK embeds up to 3 levels deep, across 21 tables. The fragile part is the TypeScript copy of the anon RLS rules, which must reproduce rules that depend on other tables. Running the anon RLS for real inside Postgres in a rolled-back dry run would remove that copy.
10. "Purge is a no-op until a zone exists" is outdated. Cloudflare Workers Cache works on workers.dev with no zone, is purged by ctx.cache.purge with no token, and a zone purge does not touch it. Astro 7's Cloudflare cache provider uses exactly this. It also serves cached pages without running the Worker, which would bypass the §3 maintenance check.

Smaller notes:
- There are 24 anonClient() call sites in loaders, not 25; the 25th is the definition.
- The preview bridge placed under src/scripts/ will not land in an admin-* chunk.
- app.apply_portfolio_children would be a fourth helper that authenticated must be allowed to run.

The design changes below close these gaps.

### Claims checked

#### 1. Q1a: SET ROLE is allowed inside a SECURITY INVOKER plpgsql function and forbidden in a SECURITY DEFINER one, so apply_release can switch roles.

**Verdict: verified.**

**Evidence.** PostgreSQL 15 SET ROLE docs say verbatim: "SET ROLE cannot be used within a SECURITY DEFINER function." An invoker function is allowed. The function's own SET clause (search_path, statement_timeout) does not make it a definer: only prosecdef sets the security-definer context flag. The PostgREST call path is not a security-restricted operation (no definer caller, no RI action, no index expression).

**Consequence.** None. Keep apply_release INVOKER. The definer fallback in §4.4 could not use SET ROLE at all and would need full SQL re-implementation of RLS, so keep it last-resort.

#### 2. Q1b: SET ROLE permission is checked against session_user, and Supabase's authenticator is a member of anon, authenticated and service_role by default.

**Verdict: verified.**

**Evidence.** PG15 docs: "The specified role_name must be a role that the current session user is a member of. (If the session user is a superuser, any role can be selected.)" supabase/postgres init script migrations/db/init-scripts/00000000000000-initial-schema.sql: `grant anon to authenticator; grant authenticated to authenticator; grant service_role to authenticator;` (also supabase_admin). The local pgTAP harness already switches roles: supabase/tests/rls_job_applications.test.sql:158 and storage_applications.test.sql:49 run `set local role service_role`, and many suites run `set local role authenticated`. Note from the same docs: SET ROLE does not apply ALTER ROLE settings, so authenticated's 8 s timeout is not picked up.

**Consequence.** The staging check in the design is still worth doing. Production's Postgres major version is unverified (local is 15, supabase/config.toml:8). On PG16+ the SET option on these grants defaults to TRUE, so behaviour is the same.

#### 3. Q1c: SET LOCAL ROLE and set_config(...,true) inside the function persist for the rest of the transaction.

**Verdict: verified.**

**Evidence.** PG15 CREATE FUNCTION docs: a SET clause restricts SET LOCAL only "for the same variable". apply_release's SET clause names only search_path and statement_timeout. So role, request.jwt.claims, app.release_apply and app.release_id persist after the function returns. Changes made inside the caught BRDRY block (dry run) and inside each per-item exception block are undone when that subtransaction aborts. Variables keep the collected report.

**Consequence.** After apply_release returns, the PostgREST transaction runs as service_role with the publisher's claims. That is harmless, but document it, and assert in pgTAP that a statement after a dry run sees the original role and claims.

#### 4. Q1d: app.current_role(), app.effective_tenant_id() and auth.uid() read request.jwt.claims when called, so impersonation binds RLS, the RESTRICTIVE gates and the guard triggers.

**Verdict: verified.**

**Evidence.** supabase/migrations/0013_search_headline_and_claims_guard.sql:48-62: current_tenant_id and current_role read current_setting('request.jwt.claims') #>> '{app_metadata,…}' and are STABLE SQL, evaluated per statement. 0001:80-83: effective_tenant_id = coalesce(current_tenant_id(), default_tenant_id()). Supabase auth.uid() (supabase/auth migrations/20220224000811_update_auth_functions.up.sql) reads request.jwt.claim.sub, then request.jwt.claims->>'sub'. A grep of the migrations finds no policy using auth.jwt(), auth.role() or current_user, except app.deployment's deploy_guard. 0019:89-107 (site_profile guard) reads the claim directly. 0028:262-293 (testimonial sample lock) uses app.is_staff(). 0025:25-26 (placeholder guard) is SECURITY DEFINER. All of these bind under impersonation. The access-token hook (0010:43-57) builds role and tenant_id from profiles, the same source apply_release uses.

**Consequence.** None for the mechanism. Set both request.jwt.claims (with sub) and request.jwt.claim.sub, as designed.

#### 5. Q1e: `set statement_timeout = '20s'` on apply_release actually bounds the publish when called through PostgREST.

**Verdict: verified.**

**Evidence.** Supabase timeouts doc: service_role has no timeout of its own and "defaults to the authenticator role's 8s timeout if unset". PostgREST v12 transactions doc: a function-level statement_timeout is "hoisted" and applied per transaction (db-hoisted-tx-settings). Without hoisting, a SET clause cannot change the timeout of the statement already running.

**Consequence.** Works for Worker calls. Calls from pgTAP, psql or the runbook are not bounded by it. Do not rely on it outside PostgREST.

#### 6. Q1f: There is no PostgREST-specific problem with the impersonation, given that PostgREST sets role and claims per request.

**Verdict: partly.**

**Evidence.** PostgREST sets role and request.jwt.claims with set_config(...,true) per transaction (PostgREST v12 transactions doc). A POST to a VOLATILE function runs READ WRITE. No blocker found, but four problems remain:
(1) Step 3 inserts content_releases as service_role before the claims are switched, so `tenant_id default app.effective_tenant_id()` resolves to app.default_tenant_id() (0001:73-83), not the publisher's tenant.
(2) Step 0 accepts current_user='postgres', so any future postgres-owned SECURITY DEFINER function in an exposed schema could call apply_release, which bypasses the service_role-only EXECUTE intent.
(3) One BEGIN…EXCEPTION subtransaction per item: past 64 subtransactions (PGPROC_MAX_CACHED_SUBXIDS) the transaction overflows the cache, which causes pg_subtrans contention for every concurrent session while the release runs.
(4) app.apply_portfolio_children runs after SET ROLE authenticated and is also called from save_portfolio as authenticated (0022:307-308). It must be an INVOKER function that authenticated may execute; a definer would not bind RLS.

**Consequence.** Set tenant_id explicitly from the live profile. Allow current_user='postgres' only behind an explicit test/runbook flag, or document it. Use per-item exception blocks only in dry_run; publish and fire should fail fast in one block, or cap a release at about 64 items. Count apply_portfolio_children as a fourth helper that authenticated may execute, and add it to the grants allowlist and pgTAP.

#### 7. Q2a: The design's staged write paths cover every existing write path to the release-managed tables.

**Verdict: partly.**

**Evidence.** Existing write paths:
- Worker, RLS client: crud.ts:121-125/152-159/179-184 via resource.ts (16 tables); reorderRoute resource.ts:457-463; save_portfolio RPC resources.ts:635-653 (portfolio + portfolio_services + portfolio_media); theme deactivation afterWrite resources.ts:1316-1327; singleton.ts:115-134 (site_profile, seo_defaults); entity-seo.ts:93-117; and src/pages/api/admin/pages/visibility/[id].ts:31-39, which runs updateRow on pages.nav_visible.
- Database: public.save_portfolio (0022:170, granted to authenticated, so also callable through PostgREST); app.publish_scheduled (0028:574-596) run by the pg_cron job publish-scheduled (0010:231); FK cascade/set-null actions (0001:140,244-245,315-316,353; 0009:231; 0021:73-74; 0022:37-47,100; 0028:104-105).
- Seeds (seed.sql, seeds/production.sql, seeds/round2-cutover.sql: no set_config or JWT inside) and direct PostgREST/pg_graphql writes by staff.
- No service-role write to these tables in src: grep finds only site_profile reads, in api/apply.ts:98 and api/apply/status.ts:19.
The design does not mention the pages/visibility endpoint. Once the guard is armed, an Admin's nav_visible toggle gets 42501.

**Consequence.** Add pages/visibility/[id].ts to the plan. Either make pages.nav_visible an exempt column (it has no public reader, which the design itself notes in §12.1) or stage it. The static write-path test in R14 will flag it either way.

#### 8. Q2b: The guard's exemptions (no role claim, pg_trigger_depth() > 1, the release token, exempt columns) are sufficient and nothing else is needed.

**Verdict: partly.**

**Evidence.** The exemptions cover the cron (definer, no claims), seeds and runbook SQL (postgres, no claims), user deletion through Supabase Auth (no claims), and cascades inside a release (the token). The only cascade from a table outside the registry is profiles → team_members.profile_user_id set null (0001:140). Profiles are deleted through Supabase Auth with no claims, and staff hold no DELETE on profiles (0011:521). So pg_trigger_depth() > 1 serves no current path and would silently exempt any future trigger that writes a registry table.
The flag itself is the real gap. The release_core slice puts releases_enabled on site_settings, where policy site_settings_write is FOR ALL for admin and developer (0001:132-134) and authenticated holds UPDATE (0011:466-471). The Worker's settings toRow cannot set it (src/pages/api/admin/settings/index.ts:27-31), but a staff JWT through PostgREST can, which disarms the guard tenant-wide (or arms it without enable_releases).
The exempt-column check (accepting_applications) depends on BEFORE-trigger order, which is alphabetical by name (site_profile_updated_at, _updater and _version, 0019:66-73), and on ignoring trigger-maintained columns.

**Consequence.** Move the flag where no API role can write it (a definer-read app.release_tenants table), or add a BEFORE UPDATE guard on site_settings that refuses a change to releases_enabled when a role claim is present (the 0019 pattern), with pgTAP. Drop the pg_trigger_depth() exemption or narrow it to referential actions. Name the guard trigger so it fires before the updated_at/version triggers, or have it ignore those columns.

#### 9. Q2c: The guard covers portfolio_services and portfolio_media, and capture records every row a release changes, cascades included.

**Verdict: partly.**

**Evidence.** Slice R5 does attach the guard "plus portfolio_media/portfolio_services". But §9's snapshot_coverage test asserts triggers only on registry tables. Child tables have no capture trigger; portfolio_services has no id column, with primary key (portfolio_id, service_id) (0001:313-318). Synthetic portfolio_children items are emitted only when a patch changes a child set. Cascades are missed: portfolio_services.service_id ON DELETE CASCADE (0001:316), and both child tables cascade from portfolio (0001:315, 0022:100). So deleting a service or a case study in release N loses the link sets, and 'Restore vN' brings the parent back without them.

**Consequence.** Emit a portfolio_children item for every delete of portfolio or services (before-image of the affected link rows), or add capture triggers on both child tables keyed by parent. Extend snapshot_coverage to assert the guard (and capture) on both child tables.

#### 10. Q2d: The txid-bound release token cannot be forged from PostgREST.

**Verdict: verified.**

**Evidence.** The only set_config in migrations is a DO block in 0013:146,154. No function in an exposed schema sets any GUC. The exposed schemas are public and graphql_public (supabase/config.toml:12-13); app is not exposed. PostgREST sets only request.* GUCs, plus role and timezone. Binding the token to txid_current() stops a leaked or session-level value being reused in another transaction. Inside per-item subtransactions, txid_current() returns the top-level XID.

**Consequence.** Add a pgTAP catalog assertion that only apply_release (and the token helper) mention 'app.release_apply' in pg_proc.prosrc, and that no function in an exposed schema calls set_config. Prefer pg_current_xact_id() over the deprecated txid_current().

#### 11. Q3a: AsyncLocalStorage is available in workerd with the repo's compatibility flags.

**Verdict: verified.**

**Evidence.** wrangler.jsonc:4-5: compatibility_date 2026-06-01, flags ["nodejs_compat"]. Cloudflare's AsyncLocalStorage doc: nodejs_compat is required for dates before 2026-08-04, and this repo sets it. The doc's caveats: enterWith() and disable() are omitted, and thenables are "not fully" supported.

**Consequence.** Use als.run() only. contentClient() must be resolved synchronously when the query is built, never inside a thenable's then(). supabase-js builders are thenables.

#### 12. Q3b: Context survives Astro 7 / @astrojs/cloudflare v14 SSR, and buffering the response inside the scope is enough.

**Verdict: verified.**

**Evidence.** Astro 7.3.5 uses the same pattern itself. node_modules/astro/dist/core/app/prerender.js:8-17 runs `scope.run(store, async () => { const rendered = await app.render(...); await rendered.arrayBuffer(); ... })` with an AsyncLocalStorage render scope (core/render-scope/scope.js), and records content entries and images from inside component rendering. @astrojs/cloudflare 14.3.3 installs that scope in workerd (dist/utils/prerender-scope.js:3-15). index.js:150-156 adds nodejs_als to the prerender worker so that scope works. Rendering starts eagerly within the async chain whichever path renderPage takes (page.js:41-58 async-iterable or render.js:42-79 ReadableStream). There are no server islands (`server:defer` has zero matches in src), so no island request renders outside the scope. Identity is memoised per request on locals (src/lib/identity/index.ts:21-24), not per isolate.

**Consequence.** Keep buffering inside withContentSource. Add a fail-closed check (the overlay records the tables it served; a preview render that also reached anonClient(), or served zero overlay reads, renders an error ribbon). The safer fallback is to pass Astro.locals.contentSource explicitly from components and pages into loaders: every .astro component already has Astro.locals, and the lib composers already take locals (loadHead).

#### 13. Q4a: The overlay client must emulate the PostgREST subset eq/neq/in/is/contains/order/limit/range/maybeSingle/single plus aliased nested embeds (inventory of src/lib/data/*.ts).

**Verdict: partly.**

**Evidence.** Actual surface:
- 24 anonClient() calls in 15 loader files; the design's 25 counts the definition. 2 of them are search RPCs, which are not previewed.
- 18 base tables plus 3 reached only through embeds (categories, portfolio_services, portfolio_media).
- About 16 foreign-key embeds, up to 3 levels deep (service_cases→project→poster/sector/client; portfolio→portfolio_services→service; portfolio→portfolio_media→asset).
- Filters used: eq, in (media ids), contains (placements). Also order (asc/desc, nullsFirst:false on blog), limit (testimonials) and maybeSingle. neq, is, range, single, or, ilike and count are never used.
The RLS copy matters even for top-level rows:
- sectors has no status filter (taxonomy.ts:28-31);
- site_profile and seo_defaults rely only on the tenant fence (siteProfile.ts:20-23, seo.ts:70-73);
- page_sections relies on the 0011 RESTRICTIVE fence (pageSections.ts:87-91).
It must also reproduce rules that depend on other tables: services_discipline_published, evaluated inside the service_cases_published_parent subquery (0028:180-185,224-229), and the 9-branch media rule, including the `$.**.mediaId` JSON path (0028:~400-431). Rough size: client 300-450 LOC, RLS copy 250-400 LOC, plus dataset and overlay.

**Consequence.** Cut the emulator to the operations actually used, and make unknown ones throw everywhere, not only in tests. The dataset must page with range(): Supabase's default max_rows is 1000, so the 2,000 rows/table cap silently returns 1,000.

#### 14. Q4b: No simpler alternative to the TypeScript RLS copy plus PostgREST emulator exists.

**Verdict: refuted.**

**Evidence.** Loaders are called from about 20 section and layout components (e.g. Statistics.astro, TeamGrid.astro, SiteHeader/SiteFooter → getNavigation), so a domain-level data source passed in from above would be a large refactor and duplicate each loader's query; the design's seam is reasonable there. The RLS copy, however, is replaceable. A dry-run 'preview snapshot' RPC can apply the Worker-validated patches (Zod plus toRow, which derives the sanitised body_html) inside a subtransaction, then run SET LOCAL ROLE anon with empty claims, select the anon-granted columns of the ~21 tables, and abort with BRDRY. Real RLS then decides visibility, including the rules that depend on other tables. The TypeScript side only joins and filters, and a render costs 1 RPC instead of ~21 staff reads.

**Consequence.** Consider adopting it (with a small lock_timeout and without setting the release token, so neither the guard nor capture is involved), or keep visibility.ts but make the zero-draft parity e2e mandatory on every Tier A route.

#### 15. Q5a: Purge by tag is available on the Cloudflare Free plan (5 requests/min, bucket 25).

**Verdict: verified.**

**Evidence.** developers.cloudflare.com/cache/how-to/purge-cache: URL, hostname, tag, prefix and purge-everything are on all plans. Free: 5 requests/min, bucket size 25, max 100 operations per request; limits are shared across zones in the same plan tier. docs/architecture.md:158 ("purge-by-tag is Enterprise-only, 30 tags/call, 30k calls/24h") and CLAUDE.md:49 are stale.

**Consequence.** Correct the docs. The design's 30-tag cap is conservative but fine; 100 tags is allowed if the fallback to tenant:default turns out too coarse.

#### 16. Q5b: Nothing caches Tier A responses on *.workers.dev today.

**Verdict: verified.**

**Evidence.** src/lib/http/cacheTags.ts:12,36-42 only sets headers. No caches.default/caches.open/cache.put in src (grep). src/worker.ts:18-25 has no cache logic. wrangler.jsonc has no `cache` key, although wrangler 4.140's schema supports `cache: {enabled, cross_version_cache}`. astro.config.mjs configures no `cache.provider`.

**Consequence.** Pages are fresh at every Cloudflare layer today. Browsers mostly refetch: Tier A sends public, s-maxage, stale-while-revalidate and no max-age. sitemap.xml and llms.txt send max-age=3600.

#### 17. Q5c: 'Purge is a no-op until a zone exists; pages are always fresh meanwhile.'

**Verdict: partly.**

**Evidence.** It is true today, but the condition is wrong. Cloudflare Workers Cache (developers.cloudflare.com/workers/cache/) is enabled with `"cache": {"enabled": true}`, works on workers.dev, is purged with ctx.cache.purge / `cache.purge` from cloudflare:workers with no API token, and "Zone-level purges via the dashboard, API, or Terraform do not affect Workers Caching content". Free-tier purge limits always apply. worker-configuration.d.ts:444-449,488-503 already types ctx.cache.purge. Astro 7's provider node_modules/@astrojs/cloudflare/dist/cache/provider.js sets Cloudflare-CDN-Cache-Control and Cache-Tag and calls cache.purge({tags}). Workers Cache also serves hits "without executing your Worker code", which bypasses the middleware maintenance check (CLAUDE.md:86, middleware.ts:137-149). The design's planned layer, the in-Worker Cache API, keeps that check; Cache API entries are purgeable by Cache-Tag.

**Consequence.** Tie purge.ts to the cache layer actually used, not to 'a zone exists': the zone API for the in-Worker Cache API; cache.purge for Workers Cache, plus purgeEverything when maintenance turns on. Add a CI check that enabling `cache` in wrangler.jsonc or Astro's cache provider fails unless purge.ts uses the matching backend.

#### 18. Q6a: The design conforms to CLAUDE.md.

**Verdict: refuted.**

**Evidence.** Four conflicts:
(1) CLAUDE.md:234 says "`set_config` claim injection restricted to the pgTAP harness". apply_release does it in production, and the claudeMdAmendments §9 text does not change that sentence.
(2) CLAUDE.md:71 requires a tenant predicate in every policy. The content_release_items insert policy `with check (app.release_token_valid())` has none, and neither does the app.release_entities select policy (app.deployment, 0016:48-59, is a precedent, not an amendment).
(3) CLAUDE.md:205 requires id, tenant_id NOT NULL, timestamps and created_by/updated_by on every table. app.release_entities and content_release_items deviate, and no amendment line covers it.
(4) CLAUDE.md:121 says Developer has "NO publish/schedule". The design lets Developer publish and schedule identity and theme releases; the §5 amendment appends text but leaves that sentence.

**Consequence.** Add the amendments:
- a §9 exception for apply_release, which builds claims from the live profile;
- add `tenant_id = app.effective_tenant_id() and …` to the release_items policy, and state the global-config exception for the registry;
- §8 exceptions for the registry and ledger table shapes;
- reword the §5 canonical role model to 'no content publish/schedule', and make Developer scheduling explicit in owner item 2.

#### 19. Q6b: Existing pgTAP suites stay green (the guard is inert for disabled tenants).

**Verdict: refuted.**

**Evidence.** Slice R14 says "CI seed enables releases for the launch tenant so every e2e runs in release mode". .github/workflows/db-tests.yml runs `supabase start`, which applies seed.sql (rls_admin_cms.test.sql:210 notes the dependence on seed data), then `supabase test db`. Suites doing staff writes in the launch tenant would get 42501 from the guard:
- rls_admin_cms.test.sql:89 (_tid() = app.default_tenant_id()), 99-107 and 172-178: content_creator UPDATE and admin DELETE on navigation;
- rls_services.test.sql:53 and 75-102: staff insert, update and delete on services and disciplines.

**Consequence.** Turn releases on only in the e2e workflow, as a post-seed step calling app.enable_releases, and keep seed.sql's default false. Alternatively, those suites switch the flag off as postgres at their start, or move to dedicated tenants. app.releases_enabled() must treat a missing site_settings row as false.

#### 20. Q6c: Other gates (matrix snapshot, grants test, size-limit, cache-tag tests) are unaffected.

**Verdict: partly.**

**Evidence.** Unaffected:
- tests/authz/matrix.spec.ts:65-78 maps only known labels, so the new 5-column release table is skipped.
- grants_app_schema.test.sql:81-102 checks anon only, and 0011:603-618 revokes anon by default, so new tables and helpers do not break it.
- The e2e cache-tag tests use toContain (about-page.e2e.ts:255-257).
Will break or need work:
- tests/lib/cacheTags.spec.ts:27 asserts the exact tag string.
- The bridge at src/scripts/previewBridge.ts does not match the admin-ui chunk rule (astro.config.mjs:63: /src/(components|lib)/admin/). It lands in an unnamed chunk that the public glob in .size-limit.json counts.

**Consequence.** Put the bridge under src/lib/admin, or extend manualChunks plus both .size-limit lists, and assert it is excluded from the public glob. Update the exact cacheTags assertions as part of the SECTION_READS change.

### New risks

- Any Admin or Developer can change the switch-on flag site_settings.releases_enabled through PostgREST (0001:132-134, 0011:466-471). That disarms the guard, or arms it without app.enable_releases, leaving no baseline and legacy scheduled rows that never publish.
- Each release item runs in its own exception block, so a release of more than 64 items overflows the subtransaction cache and causes pg_subtrans contention for every concurrent session while it runs. Frequent validate dry runs repeat it.
- If the Worker is on the Workers Free plan (unverified; the runbook says 'nothing here needs a paid plan'), each request gets 50 subrequests and 10 ms CPU. Per-item validation reads through the overlay and Zod/Tiptap re-parsing of up to 500 items can exceed that.
- Supabase's default max_rows of 1000 silently truncates the preview dataset (planned cap 2,000 rows/table) and any unpaged overlay read.
- Workers Cache pitfall. If someone enables it (wrangler `cache.enabled`, or Astro 7's Cloudflare cache provider), Tier A pages are cached for a year (s-maxage=31536000). The zone purge would not touch them, and cached hits skip the Worker, including the maintenance check.
- Child-table cascades are not captured (portfolio_services and portfolio_media when a service or portfolio is deleted), so restores and rollbacks lose case-study link sets.
- After switch-on, seed deltas and runbook SQL change live rows outside any release (exempt: no role claim). The version ledger and 'Restore vN' cannot see or revert those changes; only the BR409 conflict check notices them.
- pg_trigger_depth() > 1 is an unused exemption that would silently let any future trigger-driven write to a registry table bypass the guard.
- apply_release accepts current_user='postgres', so any postgres-owned SECURITY DEFINER function in an exposed schema could reach it.
- Step-3 inserts into content_releases run under service-role claims, so the tenant_id default resolves to app.default_tenant_id() (wrong once there is more than one tenant).
- Thenables: supabase-js builders are thenables, which workerd's AsyncLocalStorage supports only partly. If contentClient() is ever resolved inside a then() callback rather than when the query is built, preview silently falls back to live anon data.
- The tag check runs one way only. Blog post pages stamp only blog:<slug> (src/pages/creative-knowledge/[slug].astro), so team-member and category edits never purge post pages once a cache exists.
- The cron path is serviced by the minute cron on the Free cron allowance (5 per account). The design's release list, purge retries and fire path all share one 10 ms CPU invocation on Free.

## CRM core and the Sales role

Verdict on the CRM core and Sales role design (read-only review of the repository at 479b675, plus the braiin-admin-handoff mockup). Seven of the ten defects are real exactly as described: D1, D2, D4, D5, D6, D8 and D9. D3 and D7 are real but understated. D10 is a latent API-shape issue, not a live leak.

Confirmed:
- Putting ALTER TYPE ADD VALUE alone in 0037 is correct. Both Supabase CLIs apply each migration file as one implicit pgconn batch transaction, and PG 15 allows ADD VALUE in a transaction but not using the value before commit.
- Composite foreign keys with ON DELETE SET NULL (column list) work on PG 15 (supabase/config.toml:9). No table has unique (tenant_id, id) today; the design adds it for leads, profiles, lead_stages and crm_contacts but forgets crm_companies.
- app.live_role() reads the same JWT paths as the access-token hook, app.current_role() and is_live_admin. The (select app.live_role()) InitPlan pattern is correct.
- app.is_staff() must stay the four CMS roles. Every role check in the migrations is a positive list, so Sales gets no write anywhere.
- The ingest RPC does not disturb the public write limiter or the notify-lead trigger.

Refuted or materially incomplete:
1. Grants. 'Revoke everything from anon, then grant authenticated' is unsafe under both Supabase privilege regimes. Under the old auto-grant regime, which the existing tables evidently use, authenticated keeps INSERT/UPDATE/DELETE on every new CRM table, and almost certainly holds INSERT/DELETE on leads today. Under the new no-auto-grant regime, which Supabase enforces on existing projects on 2026-10-30, new tables get nothing for service_role. That breaks the service-role ingest, erase and cron paths. New app.* functions used in generated columns or CHECKs also need explicit EXECUTE for both roles.
2. 'One lead at a time, audited, no bulk PII' is false at the PostgREST layer for plaintext data: internal_notes, timeline_band and lead_notes are readable in bulk with a worker's own token.
3. A 'BEFORE UPDATE OF is_spam' trigger will not fire for legacy status='spam' writes that the sync trigger maps. So the D2 fix fails during the expand window, and trigger order (alphabetical by name) is undesigned.
4. The ingest fallback can create duplicate leads after an ambiguous failure. It also breaks once CRM-14 removes the sync trigger (stage_id becomes NOT NULL with nothing to fill it).
5. Sales becomes the first non-staff authenticated principal, so it reads columns hidden from anon on public rows: testimonial consent, media internals, discipline/service-case metadata. The design's pgTAP expectation 'Sales reads zero rows of media_assets' is wrong.
6. The RESTRICTIVE policy template omits the tenant predicate that CLAUDE.md §3 requires in every policy.
7. PDPL: the contacts horizon (last activity + 24 months) can exceed the documented lead horizon, so CRM-5 must be gated on legal sign-off (O4), as CRM-13 already is.
8. The mockup gives Sales 'stats'. The design denies it without recording the deviation.

Critical files:
- supabase/migrations/0011_app_schema_grants.sql
- supabase/migrations/0029_job_applications.sql
- supabase/migrations/0002_leads_audit_telemetry.sql
- src/lib/admin/route.ts
- src/pages/api/admin/leads/[id].ts
- src/lib/data/leads.ts
- tests/authz/matrix.spec.ts

Sources:
- https://www.postgresql.org/docs/15/sql-altertype.html
- https://www.postgresql.org/docs/15/sql-createtable.html
- https://www.postgresql.org/docs/release/15.0/
- https://www.postgresql.org/docs/15/sql-createtrigger.html
- https://pkg.go.dev/github.com/jackc/pgconn#PgConn.ExecBatch
- supabase/cli develop: apps/cli-go/pkg/migration/{file.go,apply.go} and apps/cli/src/command-internal/migration-apply.ts
- https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically

### Claims checked

#### 1. D1: the lead.view_pii audit is queued in defineAdminRoute, and a failed writeAudit does not block the decrypted response.

**Verdict: verified.**

**Evidence.** route.ts:44 says audits are queued and written after the handler; :173 audit() pushes into pending; :179 'for (const entry of pending) await writeAudit(sb, auth, entry);' ignores the boolean. audit.ts:45-77 returns false and never throws. leads/[id].ts:27-29 claims fail-closed, but :74-88 decrypts, :93-98 only queues the audit, and :101 returns plaintext. The correct pattern is in applications/[id].ts:69-77 (direct writeAudit, throws on false).

**Consequence.** The CRM-2 fix is right. Because this is a live PDPL gap, ship the fail-closed ?pii=1 change as a standalone hotfix rather than waiting for CRM-1/2.

#### 2. D2: app.purge_leads ignores spam_days, so spam leads are kept 24 months.

**Verdict: verified.**

**Evidence.** 0008:106-124 purge_leads only checks retention_delete_after or created_at + leads_months, with no status or spam predicate. spam_days is documented in docs/retention.md:27, packages/schemas/admin.ts:752 and the 0001:122 / 0008:20-33 defaults. Nothing in src sets leads.retention_delete_after (grep). src/lib/cron/daily.ts runs only the Join retention.

**Consequence.** The fix is right, but see the trigger claim below: as specified ('BEFORE UPDATE OF is_spam'), the trigger does not fire for legacy status='spam' writes.

#### 3. D3: authenticated has table-wide UPDATE on leads, so any lead worker can rewrite email_enc, retention_delete_after or consent_marketing.

**Verdict: partly.**

**Evidence.** True as stated: 0011:501 grants select, update on leads to authenticated, and 0002:40-42 leads_admin_dev_all is FOR ALL with no TO clause. It is understated, though. 0011 revoked Supabase's default grants only from anon (0011:285; default-privileges change for anon only at :616), and its own comment says that if the defaults applied, its authenticated grants are a no-op (0011:435-440). The §6b postcondition (0011:681) checks only that authenticated HAS select/update, never that it lacks insert/delete. The old Supabase default gives anon, authenticated and service_role SELECT/INSERT/UPDATE/DELETE on public tables (Supabase changelog 45329). That default is evidently live here: no migration grants service_role on profiles or leads, yet context.ts:79-84 reads profiles and leads.ts:34 inserts leads as service_role, and users/[id].ts:64-68 updates profiles through the RLS client although 0011:521 granted only SELECT. So admin/developer tokens can very likely INSERT and DELETE leads through PostgREST today. rls_leads.test.sql:61-67 cannot tell, because RLS denies content_creator either way.

**Consequence.** CRM-1 must run 'revoke all on public.leads from public, anon, authenticated', grant select plus the UPDATE column list, and grant service_role explicitly (the 0029:167-170 pattern). Otherwise the design's own §4.5 postcondition (no INSERT/DELETE for authenticated) aborts the migration, or RLS is the only layer. Verify on staging with has_table_privilege('authenticated','public.leads','insert'/'delete').

#### 4. D4: LeadsPanel can overwrite internal_notes with '' when someone saves before revealing.

**Verdict: verified.**

**Evidence.** LeadsPanel.tsx:105-117: open(id,false) fetches without ?pii=1, and GET returns stripSensitive over SAFE columns (leads/[id].ts:65-68; leadFields.ts:32-33 has no internal_notes), so setNotes(''). The textarea and Save button render whenever canSeePii is true, regardless of piiShown (:267-279). Save sends PATCH {internalNotes: ''} (:273), which leads/[id].ts:113-123 writes.

**Consequence.** The design's fix is right. Gating the textarea on piiShown is a one-line interim hotfix.

#### 5. D5: a demoted or deactivated Developer's token keeps reading leads, including plaintext internal_notes, through PostgREST for up to an hour.

**Verdict: verified.**

**Evidence.** 0002:40-42 checks only the JWT role. The table-level SELECT (0011:501) includes internal_notes. The live check exists only for job_applications (0029:128-163). users/[id].ts:64-79 changes the profile and app_metadata but does not revoke the target's sessions. config.toml sets no jwt_expiry, so the default 3600 s applies.

**Consequence.** The fix is right. Note in the risk register that the same stale-token gap remains on every non-CRM Admin/Developer table (site_settings write, audit_log, system_logs).

#### 6. D6: tests/authz/matrix.spec.ts parses only CLAUDE.md §5; architecture §3.4 and §9.3 drift.

**Verdict: verified.**

**Evidence.** matrix.spec.ts:57-80 reads only CLAUDE.md. architecture.md:237-285 uses the ●/◐/○ notation, different labels, and a stale CAPS block (content.read, leads.sensitive). §9.3 is merged into the '9.1–9.5' prose (architecture.md:409-410). No other test reads a .md file (grep).

**Consequence.** None.

#### 7. D7: CLAUDE.md's statement that the leads_safe grant is not to all authenticated is false.

**Verdict: partly.**

**Evidence.** Correct: 0002:52, 0011:526, 0015:44 and 0028:398 all grant leads_safe to authenticated, and the 0011:66-74 header admits it. Understated: the same false claim is in CLAUDE.md §7:188 ('granted only to lead-viewing roles'), architecture.md:291 (§3.6) and .claude/rules/database-and-authz.md. The 'column GRANT' half of CLAUDE.md §3:74 is false too, since leads has only table-level SELECT.

**Consequence.** Amend all four places. The design's §7 amendment still cites 'column grants' as defence in depth, which stays false for SELECT unless CRM-1 adds column SELECT grants.

#### 8. D8: role lists are hard-coded in UsersPanel, notify-lead and adminSecurity.spec.

**Verdict: verified.**

**Evidence.** UsersPanel.tsx:23; notify-lead.ts:40 and :89 (plus a {role:'admin'|'developer'} cast); adminSecurity.spec.ts:95-96. The list is incomplete. Also hard-coded: matrix.spec.ts:46 (ROLE_ORDER), :59-64, :71 (cells.length !== 5), :97-99 (four roles only); packages/schemas/admin.ts:797 (RoleSchema); 0020:90 (update_media_meta, deliberate default-deny); 0001:34-36 (is_staff, intentional).

**Consequence.** Add the extra spots to CRM-10.

#### 9. D9: lead search covers names only, and adding .or() would break the single-column search-safety rule.

**Verdict: verified.**

**Evidence.** leads/index.ts:26 searches the 'name' column only. The single-ilike rule is in globalSearch.ts:42-45.

**Consequence.** None.

#### 10. D10: lead search terms travel in GET query strings and land in URLs, history and logs.

**Verdict: partly.**

**Evidence.** GET /api/admin/leads accepts q (ListQuerySchema, packages/schemas/admin.ts:50-55, max 120, no cleanQuery). But LeadsPanel never sends q (:88-99), and /admin/search excludes leads (globalSearch.ts:35-38). Nothing leaks today.

**Consequence.** Keep the POST-body design. It is preventive, not a fix.

#### 11. Putting ALTER TYPE public.app_role ADD VALUE 'sales' alone in 0037 and using it from 0038 is correct for the Supabase CLI runner on the configured PG version.

**Verdict: verified.**

**Evidence.** PG 15 ALTER TYPE notes: inside a transaction block, the new value cannot be used until the transaction commits. In supabase/cli (develop), apply.go ApplyMigrations loops per file (RESET ALL, then ExecBatch). file.go ExecBatch sends all statements plus the schema_migrations insert in one pgconn.Batch, and pgconn documents batch execution as 'implicitly transactional'. Only CONCURRENTLY index operations, VACUUM, ALTER SYSTEM and CLUSTER run standalone. The TS CLI (apps/cli/.../migration-apply.ts) behaves the same, with an opt-out header '-- pg-delta: transaction=false'. CI runs CLI 2.118.0 via 'supabase start' (db-tests.yml); production uses 'supabase db push' (deploy-guard.sh). config.toml:9 sets major_version = 15.

**Consequence.** Keep the split. The helper redefinitions compare text, so only enum casts (the enum_range postcondition, profile writes) truly need 0038. Never add CONCURRENTLY or the transaction=false header to 0037.

#### 12. No other app_role consumer breaks: the access-token hook, RoleSchema and the CI parsers.

**Verdict: partly.**

**Evidence.** The hook projects p.role::text (0010:43, :57), app.current_role() returns text (0001:26-31, 0013:56-61), and resolveAuthContext returns DENY_ANON for an unknown role (context.ts:71-73). These need no change. These must change in the same deploy: ROLES (types.ts:5); RoleSchema (admin.ts:797, used for invite and users/[id].ts:27; 'sales' gets 422 otherwise); ROLE_CAPS (matrix.ts:60, a loud tsc error); UsersPanel.tsx:23 (silent: a Sales user's select falls back to the first option and a save can change their role); notify-lead.ts:40; matrix.spec (loud); adminSecurity.spec (loud). endpoints.spec.ts:131 PRINCIPALS=[...ROLES,'anon'] picks Sales up automatically. Docs with four-role lists: architecture.md:178, CONTRIBUTING.md:62, .claude/rules/database-and-authz.md:26, CLAUDE.md §1 and §9.

**Consequence.** Add the UsersPanel silent-failure test and the doc and rules files to CRM-10.

#### 13. Composite foreign keys (tenant_id, x_id) → t(tenant_id, id) ON DELETE SET NULL (x_id) are supported on the configured PG, and the referenced tables need unique (tenant_id, id), which is absent today.

**Verdict: verified.**

**Evidence.** PG 15 release notes: 'Allow foreign key ON DELETE SET actions to affect only specified columns'. CREATE TABLE docs: a column subset is allowed only for ON DELETE, and the referenced columns must be a non-deferrable unique/PK constraint or a non-partial unique index. No migration has unique (tenant_id, id) (grep); leads has PK(id) only (0002:11) and profiles PK(id) only (0001:91). The column list is mandatory because tenant_id is NOT NULL. The design adds unique (tenant_id, id) for leads, profiles, lead_stages and crm_contacts but not for crm_companies, the CRM-11 target of crm_contacts.company_id. The production PG major is not recorded in the repo.

**Consequence.** Add unique (tenant_id, id) to crm_companies, and to sectors/clients if those links become composite. Add a server_version_num >= 150000 guard. Prefer NO ACTION over RESTRICT for the stage FK: RESTRICT is checked immediately and can fail a tenant cascade delete.

#### 14. app.live_role() reads the right JWT paths and runs once per statement as an InitPlan.

**Verdict: verified.**

**Evidence.** It reads 'sub' like is_live_admin (0029:131-141) and '{app_metadata,role}', the same path as app.current_role() (0001:28, 0013:58) and as what the hook writes (0010:57). The tenant comes through app.effective_tenant_id() (current_tenant_id reads '{app_metadata,tenant_id}', 0013:51). The is_active and locked_until checks and the role-equality check mirror context.ts:111-115. Wrapped in (select ...), it is an uncorrelated InitPlan, the same pattern as 0029:162. Definer functions are not inlined; the immutable app.role_* helpers have no SET clause and do inline. The 'no BYPASSRLS needed' claim holds, because profiles_self_select (0001:109-110) shows the caller's own row.

**Consequence.** None. Optionally wrap app.current_role() in (select ...) in the permissive policies too.

#### 15. The column-scoped UPDATE grant on leads plus the RLS policies plus the RESTRICTIVE live policy have correct semantics.

**Verdict: partly.**

**Evidence.** Correct parts: column privileges are checked only against the SET list, so BEFORE triggers can still write version, retention and updated_by (precedent: the 0029:107-115 trigger writes outside the 0029:169 column grant). leads_read plus a restrictive FOR ALL policy satisfies UPDATE's need for SELECT visibility. Problems: (a) 'revoke update' alone leaves the default INSERT/DELETE in place (see D3). (b) The RESTRICTIVE template omits 'tenant_id = app.effective_tenant_id()', which CLAUDE.md:71 requires in every policy (precedents that also omit it: 0029:160-163, 0011:315). (c) read_by in the grant can be spoofed by the client. (d) internal_notes and status stay UPDATE-granted until CRM-14, although CRM-2 stops all app writes, so Sales (CRM-10) inherits a direct PostgREST write path to the legacy notes column.

**Consequence.** Use revoke all plus explicit grants; add the tenant predicate; set read_by in a trigger; revoke internal_notes/status UPDATE at CRM-10 at the latest.

#### 16. Sales gets no bulk PII, and the leads.pii capability is 'one lead at a time, audited'.

**Verdict: refuted.**

**Evidence.** authenticated has table-level SELECT on leads (0011:501). A worker's own JWT (readable from their cookie in devtools) plus the public anon key reads, for every lead in the tenant, through PostgREST: internal_notes (plaintext, kept until CRM-14), timeline_band (plaintext, still accepted at packages/schemas/lead.ts:87 and stored by leads.ts:43), and message, name and company. Per design §4.6, lead_notes is SELECT-granted with RLS role_lead_pii. None of these reads is audited or rate-limited. Only the AES-GCM fields are protected, by the key held in the Worker. Developer has the same gap today; the design extends it to Sales.

**Consequence.** Scope SELECT on leads by column, excluding internal_notes, timeline_band, ip_inet, score_signals and the *_hmac columns, and read gated columns through the service role after the fail-closed audit. Encrypt or null timeline_band in CRM-1 whatever O1 decides. Serve lead_notes through an audited path, or document the residual risk in §3 and correct the matrix label.

#### 17. The grant strategy is sufficient: 'revoke everything from anon, then grant authenticated exactly what it needs', with a no-TO INSERT policy letting the definer triggers write lead_events under FORCE RLS.

**Verdict: refuted.**

**Evidence.** Under the old default (Supabase changelog 45329; 0011:274-284), new tables keep INSERT/UPDATE/DELETE for authenticated, so the no-TO lead_events INSERT policy would let live workers forge timeline rows through PostgREST. Under the new default (new projects since 2026-05-30, enforced on existing projects on 2026-10-30, and covering sequences; existing tables keep their grants), new tables get no grants for service_role. crm_ingest_lead (INVOKER as service_role), crm_link_lead, crm_erase_* and the cron backfills would then fail with 42501, and Supabase states service_role needs explicit grants. The repo's own pattern revokes from public, anon and authenticated and grants explicitly, service_role included (0029:167-170, 0021:164-171, 0028:600-608). The no-TO policy is also unnecessary if the trigger owner has BYPASSRLS (0011 §6e already relies on this) and insufficient if it doesn't, because under a service-role JWT current_role() is 'anon'.

**Consequence.** For leads and every CRM table: revoke all from public, anon, authenticated; grant the exact authenticated set; grant service_role explicitly; add postconditions that hold under both regimes, checking both what must be granted and what must not. Drop the no-TO policy and assert the trigger owner's rolbypassrls instead.

#### 18. Default-deny is structural: a new 'sales' value gets nothing until a CRM helper names it.

**Verdict: partly.**

**Evidence.** Every role predicate is a positive list: is_staff (0001:34-36), is_admin, can_write_content, is_live_admin (0029:143), the inline lists at 0001:133/412/431/470, 0002:41/105/124/169/189, 0009:295/320/345/463/479/494 and 0019:82-86, plus 0020:90 and the 0007/0018 is_admin gates. Sales gets no write and no row from any staff table. However, Sales is the first non-staff authenticated principal. The anon-visible policies have no role predicate (0021:135-137, 0024:21-41, 0028:167-183), while authenticated holds table-level SELECT (0021:170, 0011:461, 0028:608) and anon only column grants (0021:166-169, 0024:46-48, 0028:600-606). So Sales reads testimonial consent_reference/consent_obtained_at, media folder/tags/provider_ref, and discipline/service-case audit columns. The design's 'Sales reads zero rows of media_assets' is wrong. 0028:265 skips the sample lock for any non-staff JWT. interestLabel.ts:16-18 depends on staff RLS, so Sales gets degraded interest labels.

**Consequence.** Make the Sales pgTAP test catalog-driven (Sales sees no more rows or columns than anon) instead of a hand list. Add a RESTRICTIVE non-staff block on testimonials, or document the exposure. Replace 'not is_staff()' trusted-context checks with a no-role-claim test (as 0019:88-96 does). Resolve interest labels without relying on staff RLS.

#### 19. app.is_staff() must stay the four CMS roles.

**Verdict: verified.**

**Evidence.** is_staff gates: site_settings read (0001:129-130), media_read (0001:409-410), redirects (0001:428-429), custom_themes (0001:467-468), content_versions read (0001:387-388) and insert (0009:520-521), rollups (0002:202-203), audit_insert and system_logs insert (0002:107, 0002:126), site_integrations (0009:342-343), every 'published or is_staff' draft gate, and the restrictive escapes (0011:315-362, 0028:183, 0028:227).

**Consequence.** Keep it. is_member() should be used only in audit_insert, enforced by a review rule plus a test.

#### 20. crm_ingest_lead with a fallback to today's insert works with the current contact path without breaking the notify trigger or the limiter, so 'a lead is never lost'.

**Verdict: partly.**

**Evidence.** The limiter runs before createLead (contact.ts:55-66) through public_write_hit (0029:195-215) and is independent of the insert path. leads_notify is AFTER INSERT FOR EACH ROW (0010:289) and fires inside an RPC as well; the pg_net queue row is transactional. tg_set_actor keeps a caller-supplied created_by (0009:34). Gaps: (a) if the RPC commits but the response is lost, the fallback inserts a duplicate lead and sends a second notification; (b) falling back on 23514/22023 would mask bugs; (c) CRM-14 drops tg_lead_legacy_sync, the only thing that fills the fallback's NOT NULL stage_id, and its scope doesn't mention the fallback; (d) both paths evaluate new app.* functions in generated columns and CHECKs (lead_search_text, tags_ok) as service_role, but 0011:150-169 leaves new app.* routines with no EXECUTE unless granted (0011:252-257 granted ar_tsvector for exactly this reason), so without grants both paths fail and the form returns 500; (e) the sync trigger reads lead_stages as the invoker, which has no grant under the new regime; (f) the fallback writes no 'created' event.

**Consequence.** Generate the lead id in the Worker and pass it to both paths; treat 23505 on the fallback as success. Fall back only for PGRST202, 42883 or transport errors. Add a stage default that survives CRM-14, or remove the fallback in CRM-14. Grant EXECUTE on the new functions to authenticated and service_role and test it. Make the sync trigger SECURITY DEFINER or grant service_role on lead_stages. Write 'created' in an AFTER INSERT trigger.

#### 21. During the expand window, legacy status writes keep working through the sync trigger, and spam retention is applied by the BEFORE UPDATE OF is_spam trigger.

**Verdict: refuted.**

**Evidence.** PG 15 CREATE TRIGGER docs: a column-specific trigger fires only when the column is listed in the UPDATE's SET list; changes made by BEFORE UPDATE triggers are not considered. Triggers of the same kind fire in alphabetical order by name. A legacy PATCH {status:'spam'} (leads/[id].ts:112; LeadsPanel.tsx:193) has is_spam set by tg_lead_legacy_sync, so the spam trigger never fires. The design specifies no trigger order for sync, version, stamps, spam and events.

**Consequence.** Use a plain BEFORE UPDATE trigger that compares OLD and NEW. Name the triggers so the sync runs first. Add a pgTAP test that a legacy status='spam' write caps retention.

#### 22. The design complies with CLAUDE.md and with PDPL as written in docs/retention.md.

**Verdict: partly.**

**Evidence.** Violations or open gaps: the §3 tenant predicate is missing from the restrictive policies; the §3 'audit-log every view' is not true at the DB layer (see the bulk-PII claim); §9 per-role pgTAP: the existing 19 suites get no Sales principal; §8 requires an id and actor columns on every table, but crm_merge_dismissals has no id and the append-only tables have no updated_*. retention.md:44 says a longer horizon needs a documented justification, but contacts kept for last activity + leads_months can outlive the 24-month lead horizon, and only CRM-13 is marked blocked on O4, not CRM-5. last_activity_at is bumped by system events such as cron contact_linked. The orphan-contact purge rule (version = 1) is defeated by trigger-driven edits. privileged_ops has no purge (grep) yet pii-reveal will grow it. The design's 'audit rows hold ids and field names only' is false: login.ts:80-85 stores the IP and users/index.ts:71-77 stores an e-mail. The mockup gives Sales 'stats' (ADMIN_TDD.md §7; SPEC.md:33), the design denies it without recording the deviation, and dashboard.ts:27 is analytics.read only.

**Consequence.** Gate CRM-5 on O4, or cap contact expiry at the last linked lead. Bump last_activity_at only for actions taken by the person or by staff. Use an explicit staff-edited flag for the orphan rule. Add privileged_ops to retention.md with a purge. Record the 'stats' deviation as an owner item. Switch the dashboard route to anyCap.

### New risks

- Supabase stops auto-granting on new public tables and sequences for existing projects on 2026-10-30. Slices applied after that date will have no grants for anon, authenticated or service_role unless the grants are explicit. If the local CLI stack still uses the old regime, pgTAP passes while production returns 42501, the same failure pattern as the 0011 outage.
- Live, before any CRM work: under the old default, admin and developer tokens can probably INSERT and DELETE leads through PostgREST today (leads_admin_dev_all is FOR ALL, and authenticated's default INSERT/DELETE was never revoked). Check on production with has_table_privilege.
- pg_trgm lives in the 'extensions' schema on Supabase. RPCs with search_path='' must schema-qualify similarity(), the % operator and gin_trgm_ops. Precedent: the 0012 hmac bug lost audit rows silently for 12 migrations.
- BEFORE triggers fire in alphabetical order by name. The order of sync, version, stamps, spam and events is undesigned and can corrupt version bumps and timeline events.
- The contact upsert can leave an orphan contact when two transactions race on a new e-mail. Use pg_advisory_xact_lock on the blind index, or clean up in the same transaction.
- crm_people() shows Sales the name and role of every staff member. Restrict it to assignable lead workers.
- Role changes do not revoke GoTrue sessions (users/[id].ts:71-79). Outside the CRM tables, a stale token keeps its old rights for up to an hour; for example, a Developer moved to Sales can still write site_settings through PostgREST.
- Bulk 'Mark as spam' (up to 100 per request) lets Sales trigger irreversible deletion 30 days later, because un-marking never restores the time. That is an erase-like power outside crm.erase.
- Immutable app.role_* helpers must never be used in indexes, generated columns or CHECKs, because redefining them in 0038 would not recompute stored values.
- The production PG major version is not recorded in the repo, and ON DELETE SET NULL with a column list needs PG 15 or later.
- The deferred lead_stages shape trigger and a RESTRICT stage FK can block a tenant cascade delete.
- Public CRM RPCs get PUBLIC EXECUTE by default (and anon/authenticated under the old Supabase default) unless revoked and tested, as 0029:214-215 does.

### Design changes required

- Grants on leads and every new CRM table: 'revoke all on <t> from public, anon, authenticated', grant authenticated exactly what it needs, and grant select/insert/update/delete to service_role explicitly (0029:167-170). Add postconditions that check both what must be granted and what must not, so the migration behaves the same under both Supabase privilege regimes. Do the same for public CRM functions.
- Grant EXECUTE to both authenticated and service_role on every new app.* function used in generated columns, CHECKs, defaults or policies (lead_search_text, crm_name_key, tags_ok, lead_score, role_*), and add them to the pgTAP grants test.
- lead_events: drop the no-TO INSERT policy, revoke INSERT from authenticated, assert in a postcondition that the definer trigger owner has rolbypassrls, and add a pgTAP test that a worker's direct INSERT fails with 42501.
- Spam trigger: make it a plain BEFORE UPDATE that compares OLD and NEW, name the triggers so the sync fires first, and test legacy status='spam' writes. Consider restoring the original horizon on un-spam, never beyond created_at + leads_months.
- Add 'tenant_id = app.effective_tenant_id() and' to every RESTRICTIVE live policy (CLAUDE.md §3 requires the tenant predicate in every policy).
- PII at the DB layer: scope SELECT on leads by column, excluding internal_notes, timeline_band, ip_inet, score_signals and the *_hmac columns, and read gated columns through the service role after the fail-closed audit. Encrypt or null timeline_band in CRM-1. Put lead_notes reads behind an audited path, or document the residual risk and fix the matrix label.
- Foreign keys: add unique (tenant_id, id) to crm_companies (and to sectors/clients if those links are composite), use NO ACTION instead of RESTRICT for the stage FK, and add a PG >= 15 guard.
- Ingest: generate the lead id in the Worker and make the fallback idempotent (23505 = success). Fall back only for PGRST202, 42883 or transport errors. Keep a stage default that survives CRM-14, or remove the fallback in CRM-14. Write the 'created' event in an AFTER INSERT trigger. Make the sync trigger SECURITY DEFINER or grant service_role on lead_stages.
- Sales exposure: replace the hand-picked table list with a catalog-driven pgTAP test that Sales sees no more rows or columns than anon, and fix the media_assets expectation. Add a RESTRICTIVE non-staff block on testimonials. Replace 'not is_staff()' trusted-context checks (0028:265) with a no-role-claim test. Resolve interest labels through the service role or a definer RPC.
- Ship the D1 (fail-closed ?pii=1 audit) and D4 (textarea gated on piiShown) fixes now as hotfixes.
- Column grant: set read_by in a trigger, add a CHECK on last_contact_at, and revoke UPDATE on internal_notes and status at CRM-10 at the latest.
- CRM-10 completeness: move dashboard.ts:27 to anyCap ['analytics.read','leads.manage']; update CLAUDE.md §7, architecture §2.1 and §3.6, .claude/rules/database-and-authz.md and CONTRIBUTING.md.
- PDPL: gate CRM-5 on O4, or cap contact expiry at the last linked lead. Bump last_activity_at only for actions by the person or by staff. Use an explicit staff-edited flag for the orphan purge. Add privileged_ops to retention.md with a purge. Stop claiming audit rows hold ids only.
- Record the mockup deviation (the handoff gives Sales 'stats') and add an owner item for it.

## UI, media and the bundle

Verdict on the UI port design. Its main mechanisms hold up. Many of its specific promises are wrong or incomplete.

What holds:
- Uploaded Supabase Storage images do work. Astro's <Picture> on the cloudflare-binding service sends them through the same-origin /_image endpoint, so img-src needs no new host. Two conditions: image.remotePatterns must be set when the build runs, and width and height must be passed explicitly.
- Today's admin bundle measures 223,076 B gz. size-limit really does add up every matched file.
- About, Our Work, All projects and case studies (and their Arabic twins) do lack media:all. Section-composed pages do need SECTION_READS.
- The popover sidebar, @starting-style and container queries are fine for an internal admin and raise no CSP issue.
- The contrast and font claims check out.

What is refuted or incomplete:
1. Uploads would not show up yet. The anon media read policy (0028:408), the provider CHECK (0020:37), the public media Zod enum (content.ts:59) and the ImageRef type all exclude 'storage', so uploaded images stay hidden from visitors.
2. The free-plan failure mode is missed. Cloudflare's free tier allows 5,000 unique transforms a month, after which new ones return error 9422. /_image accepts any width or quality value, so anyone can burn the quota, and the adapter has no fallback. The project runs on the Workers Free plan.
3. Uploads keep their EXIF/GPS data in a public bucket.
4. LCP posters could miss the 2.5 s budget. Large originals are transformed on first request, and a cold transform of the small logo already takes about 3.5 s in production.
5. The bundle budget is not enforced. size-limit runs in no CI workflow. About 1.4 KB of admin-only code is counted against the public budget instead.
6. The bundle projection is optimistic. Splitting into ~17 chunks costs about 10–13 KB of gzip overhead on its own, and the release backend's own admin UI (≤18 KB) is not in the ledger. Even without the CRM screens the total lands around 290–300 KB.
7. The planned chunking may not work. Rolldown's manualChunks pulls in each module's dependencies by default, which is why Tiptap, ProseMirror, zod and React already sit in admin-ui.
8. "All test hooks are kept" is untrue. These pins break: adminSecurity.spec.ts:164 and :181–190, cacheTags.spec.ts:13–29, adminFields.spec.ts:45, 64, 120 and 194, and resourceSync.spec.ts:29. The new no-script rule also fails today on login.astro:65.
9. app.css cannot be ported verbatim for pixel fidelity. Its element resets would restyle every existing island. It has about 63 colour literals outside the token block. The mockup's look also depends on roughly 464 inline styles plus runtime <style> blocks, and CSP forbids both.
10. The publish rules conflict with CLAUDE.md §5 and the release backend design. Only Admin and Content Creator get Publish, so a Content Creator would publish theme, identity and SEO changes it cannot author.
11. The UI design contradicts the release backend design on what is staged (media metadata, redirects, page visibility), on the theme cache tag name (site:chrome vs theme:active), and on whether site_chrome must be split per capability. Both designs also build their own harness, preview route, savebar and history screens.
12. page_sections.label would not be admin-only, because anon has SELECT on the whole table (0016:93).

### Claims checked

#### 1. A5: Supabase Storage public-bucket images rendered with Astro <Picture> on the 'cloudflare-binding' service are transformed on Workers through the same-origin /_image endpoint, so CSP img-src needs no new host.

**Verdict: verified.**

**Evidence.** 1. Astro's base image service, getURL() (node_modules/astro/dist/assets/services/service.js:173-181), emits `/_image?href=<remote>` only when isRemoteAllowed(src, imageConfig) is true. Otherwise it returns the raw remote URL, which img-src `'self' https://imagedelivery.net https://*.cloudflarestream.com` blocks (src/lib/http/securityHeaders.ts:133).
2. For cloudflare-binding, the adapter wires `@astrojs/cloudflare/image-transform-endpoint` (node_modules/@astrojs/cloudflare/dist/utils/image-config.js). That is confirmed in the build: dist/server/chunks/_astro_assets_DRWi1Zko.mjs:612-625 has endpoint /_image, domains [] and remotePatterns [].
3. transform() (dist/utils/image-binding-transform.js) re-checks isRemoteAllowed, fetches with fetchWithRedirects (which re-validates every redirect hop: astro/dist/assets/utils/redirectValidation.js), then runs env.IMAGES.input().transform().output().
4. The IMAGES binding already exists (wrangler.jsonc:62-64). Production already transforms images at runtime: tests/e2e/hero-intro.e2e.ts:359-361 and docs/hero-intro.md §3 record ~3.5 s cold and ~0.7 s warm.

**Consequence.** Keep the approach. Add the concrete configuration (next claim).

The imageConfig is serialized into the server bundle at build time. Each environment must therefore build with its own Supabase URL; one artifact cannot be promoted across Supabase projects.

Least-change fallbacks, needed only if transforms must stop:
- runtime 'passthrough' for remote sources. The adapter's passthrough endpoint is still same-origin and checks the content type, but it loses resizing, a Pillar 2 hit that needs a §2 adapter-lock amendment.
- the already-anticipated cf_images provider: imagedelivery.net is already in img-src (see the resolve.ts:11-12 comment), but Cloudflare Images storage is a paid plan.

#### 2. The only configuration needed is `image.remotePatterns` pinned to the bucket path from the build env.

**Verdict: partly.**

**Evidence.** - astro.config.mjs:117-120 has only `domains: []` and reads no env. Astro evaluates the config before .env is loaded, so the config needs vite loadEnv() or process.env.
- Remote images without width/height throw MissingImageDimension (service.js verifyOptions, about lines 22-50). inferSize would fetch the original at render time.
- ImageRef.src is typed ImageMetadata only (src/lib/media/resolve.ts:19), and imageRef() returns null for any non-static provider (resolve.ts:28).
- CI builds against local Supabase (http://127.0.0.1:54321), so a second pattern with protocol http, that hostname and port 54321 is needed.
- matchPathname needs a trailing `/**` to match nested keys (@astrojs/internal-helpers/dist/remote.js).

**Consequence.** AV-11 must specify:
- loadEnv-derived remotePatterns ({protocol, hostname, port, pathname: '/storage/v1/object/public/media/**'}), with the build failing if unset in production;
- stored dimensions required and always passed;
- ImageRef.src widened to `ImageMetadata | string`;
- no inferSize.

#### 3. Images-binding cost and limits are an owner cost item only (AV-11 risk: 'Supabase egress and image-transform costs').

**Verdict: partly.**

**Evidence.** Cloudflare docs:
- images/pricing: Free = 5,000 unique transformations per month. Binding calls are billed as unique transformations (source plus parameters, per calendar month). Once exceeded, 'New transformations will return a 9422 error'.
- images/get-started/limits: binding .input() max 20 MB; dimension cap 12,000 px; AVIF output capped at 1,200 px (larger requests fall back to WebP/JPEG).
- images/transform-images/bindings: binding responses are not cached automatically.

In this repo:
- The adapter endpoint has no error fallback (image-transform-endpoint.js), so a failed transform becomes a 500 and a broken image.
- /_image accepts arbitrary w, h, q and f values, so anyone can mint new unique transformations.
- The project is on the Workers Free plan (docs/security-exceptions.md:496, :513): 100k requests per day and 10 ms CPU (workers/platform/limits). Every /_image hit is a Worker request.
- The Cache API docs promise functional cache operations only for custom domains, and the site has no zone yet (owner item 4).
- Supabase Free: 1 GB storage and 5 GB egress (supabase billing docs). Each uncached transform refetches the original, up to 10 MB.

**Consequence.** Name the 9422 failure mode, which can break LCP posters. Add three changes:
- normalize uploads through env.IMAGES (smaller master, stripped metadata);
- a parameter guard on /_image;
- a transformation budget (and AVIF widths ≤1200 px).

#### 4. Adding provider 'storage' with a shape CHECK, display_name and imageRef() support is enough for uploads to render on public pages.

**Verdict: refuted.**

**Evidence.** - The anon read policy is limited to `provider in ('static','cf_images','stream')`: supabase/migrations/0024_media_public_read.sql:24, and the latest version at 0028_disciplines_service_pages.sql:408.
- The CHECK media_assets_provider_known also excludes 'storage' (0020_media_provider.sql:37).
- PublicMediaRowSchema's provider enum excludes it too (packages/schemas/content.ts:59), so parseRows drops such rows.
- The design's migration list (AV-11: '00NN_media_storage.sql: storage bucket media and policies; media_assets provider storage + shape CHECK; display_name') mentions none of these.
- docs/launch-runbook.md:298 documents the old provider set.

**Consequence.** Storage images would fail closed and never appear publicly. AV-11 must:
- replace media_assets_public_read with a version that includes 'storage';
- extend the provider CHECK;
- update the Zod enum and MediaWriteSchema, and the runbook;
- keep display_name out of the anon column grant (0024:47).

#### 5. Today's admin bundle is about 223 KB gz: admin-ui 165.2 (admin code, Tiptap/ProseMirror, zod) plus admin-vendor 55.7 (react, react-dom) plus facades.

**Verdict: verified.**

**Evidence.** Measured in memory: gzip level 9, the same as @size-limit/file, on dist/client/_astro. That build is from 2026-10-01 23:37; later commits touched only tests, docs and deps.
- Admin entry: 13 files, 223,076 B. admin-ui.Cgqh94bN.js is 165,423; admin-vendor.CZGi1lC0.js is 55,776.
- Public entry: 30 files, 25,290 B.
- In admin-ui, 'ProseMirror' appears 51 times, 'tiptap' 31, 'ZodError' 2 and 'react.transitional.element' 2. ProseMirror and Tiptap appear 0 times in admin-vendor. So react (jsx-runtime), Tiptap and zod sit in admin-ui even though manualChunks routes @tiptap|prosemirror|react to admin-vendor (astro.config.mjs:75-79).

**Consequence.** The baseline is right, but the chunk contents do not match the configured intent (see the Rolldown claim). The unauthenticated login page also downloads all of admin-ui (442 + 165,423 + 388 B) just for a fetch helper.

#### 6. The 300 KB gz admin budget is computed as a sum of all admin-* chunks.

**Verdict: partly.**

**Evidence.** Confirmed:
- @size-limit/file sums the gzip size (level 9) of every matched file (node_modules/@size-limit/file/index.js step60: `check.size = await sum(files, gzipSize)`). The admin entry matches admin-*.js plus 11 facade and script globs (.size-limit.json).
- '300 KB' is parsed by bytes-iec as 300,000 B, so headroom is 76,924 B. The release-backend and CRM designs quote '~82 KB', which is a KiB figure.

Caveats:
- No CI workflow runs size-limit. There is no size step in .github/workflows/ci.yml or perf-seo-a11y.yml; only package.json:21 defines it.
- docs/fonts.md:29 says 'CI-enforced via size-limit … once active'.
- The admin-only React renderer client.Bz_aiHmk.js (1,021 B) and rolldown-runtime (388 B) are counted in the public entry.

**Consequence.** The budget is unenforced today, so 'Each PR reports its size-limit delta' needs a CI step first. Fix the units (KB = 1,000 B). Move client.*.js and rolldown-runtime.*.js to the admin entry.

#### 7. The projected end state is about 271–281 KB gz before the CRM screens (+63/−15 ledger).

**Verdict: partly.**

**Evidence.** - The ledger ignores gzip's per-file overhead. Splitting admin-ui in memory: 10 parts adds 7.1 KB (4.3%), 15 parts 11.8 KB (7.1%), 20 parts 15.3 KB (9.3%). The design's ~17 admin chunks would add roughly 10–13 KB.
- The release backend's own admin UI is estimated at '≤ +18 KB gz' (design-release.json, slices R12/R13: Savebar, PublishDialog, ConflictPanel, VersionsPanel, HistoryDrawer). It is not in this ledger.
- Several adds look low; for example, 'page editor +10' covers a 3-column editor with sortable sections, modals, drawers and the bridge.
- A realistic total is about 290–300 KB before CRM. The CRM screens then exceed a 300 KB sum.

**Consequence.** The owner decision is needed even earlier than the design suggests. A sum metric grows with every lazy split, which penalizes exactly the lever that cuts per-page payload. Redefine the budget (see design changes).

#### 8. manualChunks can quarantine Tiptap into a lazy admin-rich chunk and screens into admin-screen-<name>, so per-page payload falls.

**Verdict: partly.**

**Evidence.** - Vite is 8.1.5 and Rolldown 1.1.5. Rolldown turns manualChunks into a single codeSplitting group (node_modules/rolldown/dist/shared/rolldown-build-CtPvmZgJ.mjs:3058).
- That group's includeDependenciesRecursively defaults to true: 'Whether to include captured modules' dependencies… @default true' (define-config-BhJ90aEv.d.mts:1162-1175).
- This is the observed reason Tiptap, ProseMirror, zod and react are in admin-ui.
- Vite marks build.rollupOptions deprecated in favour of rolldownOptions (vite dist/node/index.d.ts:856).

**Consequence.** Build the split with build.rolldownOptions.output.codeSplitting.groups: explicit test regexes, priority, includeDependenciesRecursively:false and strictExecutionOrder:true. Add a post-build test of chunk contents. Otherwise per-page savings are not guaranteed.

#### 9. Zero-JS mobile sidebar (`<nav popover=auto>` + popovertarget, UA hiding overridden at ≥900px), @starting-style dialogs and container queries are adequately supported for an internal admin, with no CSP issue.

**Verdict: verified.**

**Evidence.** Browser support (MDN):
- Popover API: Baseline 2025, newly available since January 2025.
- @starting-style: Baseline 2024 (August 2024).
- @container: widely available since February 2023.
- overlay: limited availability, so top-layer exit animations are cut short outside Chromium (cosmetic only).

CSS behaviour:
- Author rules beat the UA `[popover]:not(:popover-open){display:none}` rule whatever the specificity. They must also reset the UA's position:fixed, inset:0, margin:auto, border, padding and Canvas colours.
- A popover opened below 900px stays in the top layer if the window is widened.
- Drawers and modals live in the top layer, outside `.content`, so .grid--* modifiers inside them have no container to query.

CSP:
- These are declarative attributes and external CSS, so script-src and style-src are unaffected.
- CSSOM writes (setProperty) are not restricted by style-src, but they add [style] to the live DOM. csp.e2e.ts:103-111 checks `[style]` on the live DOM of /admin/login, which matches the design's move to a server-HTML check.
- The mockup itself hides the sidebar below 900px with no replacement (app.css:413).

**Consequence.** Adequate for an internal admin. Four follow-ups:
- put the narrow-screen drawer CSS under `@supports selector(:popover-open)` so browsers without popover show the nav in normal flow;
- add a 3-line matchMedia → hidePopover handler to AdminLayout's existing script;
- give drawer and modal bodies container-type;
- document a floor of Chrome/Edge 117+, Firefox 129+ and Safari 17.5+.

#### 10. media:all (or media-usage tags) is missing on About, Our Work, All projects and case studies.

**Verdict: verified.**

**Evidence.** Missing:
- about.astro:71-75 has [page:about, team:all, statistics:all].
- portfolio/index.astro:14-25 and portfolio/all.astro:16-20 lack it.
- portfolio/[slug].astro:16-26 lacks it.
- The ar/* twins mirror all of these.

Present: home.ts:15, servicesPage.ts:33 and services/page.ts:48.

These pages do render media_assets rows:
- AboutWho and WorkIntro through getSectionImage(s) (src/lib/data/sectionMedia.ts; AboutWho.astro:6, WorkIntro.astro:6);
- leadership portraits (src/lib/data/team.ts:72);
- portfolio posters and media (src/lib/data/portfolio.ts:120, :158).

No purge exists in src yet (TODO(KAN-20) at sitemap.xml.ts:83 and llms.txt.ts:78), so the gap is latent until the release backend's purge seam lands.

**Consequence.** Add media:all to all eight routes now; it is cheap and does nothing until purges exist. Alternatively, purge by media_usage, mapping each use to its entity tags.

#### 11. Page tags must be derived from rendered sections (SECTION_READS).

**Verdict: partly.**

**Evidence.** Needed:
- Any section type is accepted on any page: SectionWriteBase checks only `type: SectionTypeSchema` (packages/schemas/admin.ts:347-355).
- Table-backed sections load their own data when the route injects none: Certifications.astro:19, ClientsMarquee.astro:38, TestimonialsSection.astro:32, ProjectGrid.astro:50, Statistics.astro:46 and LeadershipSlider.astro:55. So About can render tables it carries no tag for.

But not sufficient:
- CaseStudyPage.astro is a fixed template that uses no SectionRenderer, so SECTION_READS cannot cover case studies.
- tierATags() silently slices to 30 tags and drops the trailing locale tag first (src/lib/http/cacheTags.ts:26-32).

**Consequence.** Adopt SECTION_READS for section-composed pages, keep a static list on the case-study routes, and make the 30-tag cap preserve the ALWAYS, route and locale tags or fail in a test. If the Add-section 'allowed types' map ships, also enforce it server-side in sectionResource.assertWritable.

#### 12. All existing JS and test hooks are kept, so every current screen takes the new look on day one and adminFields.spec keeps passing.

**Verdict: refuted.**

**Evidence.** Pins that the design changes:
- adminSecurity.spec.ts:164 expects Developer's nav to contain /admin/logs, which the design retires.
- :181-190 accept arbitrary `--x` / `--ok-name` keys and url() values, which enum-keyed ThemeTokensSchema rejects.
- cacheTags.spec.ts:13-29 pins the ALWAYS list exactly, which site:chrome breaks.
- adminFields.spec.ts:45 ('Page *'), :120 ('Rating line *'), :64 (the exact `<button type="button" class="btn" disabled="">Add</button>`) and :194 (`>Remove file` adjacency) break with a required-marker span or icons inside buttons.
- resourceSync.spec.ts:29 pins `>Sync to edge<`, which breaks if an icon is added.
- AV-01's 'no <script> in src/pages/admin/**' test fails today on src/pages/admin/login.astro:65.

Hooks used by current islands but missing from the design's keep-list:
- confirm.ts:33-42 (admin-dialog, dialog-message, dialog-actions) and toast.ts:23;
- .field > span, .field-inline, .form-actions, .pii;
- .media-thumb/-grid/-pick/-current and dialog.media-dialog;
- .item-list/-row/-label and .repeater-item;
- .editor-toolbar [aria-pressed] and .editor-surface .tiptap;
- .crumbs, .search-hits, .stat/.stat-label, .table-wrap, .row-3, .field-error.

**Consequence.** List these test edits explicitly in each slice, and let AV-01 grandfather login.astro until AV-06 (or move its script into an enhancer). Extend AV-02's keep-list to every class an existing island uses.

#### 13. The client's app.css could be ported nearly verbatim (minus inline-style dependencies and failing-contrast values) for pixel fidelity.

**Verdict: partly.**

**Evidence.** In favour:
- app.css is 413 lines, contains no backslashes (safe for scripts/minify-css.mjs) and is mostly logical properties.

Against:
- It has ~29 hex and 34 rgba literals outside :root, which fails the design's own no-colour-literal test.
- It has no reduced-motion, forced-colors, @container or :has() rules.
- Its element resets (`*{margin:0;padding:0}`, `button{background:none;border:0}`, `a{color:inherit;text-decoration:none}`, `body{overflow:hidden;font-size:14px}`, `svg{display:block}`) would restyle current islands. The repo styles controls by element and type selectors (admin.css:523-539, 720-763), and `input[type=text]` (0,1,1) out-ranks app's `.in` (0,1,0).
- Much of the look lives in ~464 inline style attributes (core 26, shell 10, cms 73, ops 143, setup 36, health 26, crm_a 72, crm_b 78) plus ~35 KB of runtime <style> blocks in screens_*.js. CSP forbids both.
- Visual state uses `.on` classes in 13 selectors.
- Physical-property leftovers: .tog::after left:3px, .drw box-shadow -20px, .fgroup--item inset 3px.

Class collisions:
- .card, .grid, .badge, .btn (plus the repo's global button rule), .bar (also in screens_health), .toast/.toasts;
- .toolbar (compatible), .tabs vs .seg/.langtabs;
- .sel (the mockup uses it for both selects and selected rows), .on;
- .media vs .media-*, .av vs .avatar, .mdl/.ov vs dialog.admin-dialog, .tbl vs table.data, .kpi vs .stat, .note vs .msg[data-kind];
- .f/.in/.ta vs .field and element selectors;
- screens_ops reuses .content, .grid and .stack.

**Consequence.** Do a verbatim-first port: start AV-02 from app.css text, rename colliding selectors, turn literals into tokens, scope or drop the resets, retarget the .in/.ta/.sel rules or add classes in FormField, and replace .on with ARIA-state selectors. Pixel fidelity also needs a small class layer to replace the inline styles.

#### 14. Publish is shown only to content.publish holders (Admin, Content Creator); SEO and Developer see 'Waiting for an Admin or Content Creator to publish' for theme, identity, entity SEO, SEO defaults, navigation and media metadata (§2.10, §7).

**Verdict: refuted.**

**Evidence.** - CLAUDE.md §5 gives Content Creator ❌ for Theme editor (line 129), General settings (126) and Global SEO defaults (139), and only 'view' for per-entity SEO (138). Under this rule a Content Creator would make those changes live, while their holders (Developer, SEO) could not.
- The release backend design (A3-4, §1.1) says items are publishable by holders of their area's caps and the model 'never widens who can change the live site': site_profile → settings.general; custom_theme → theme.edit; entity_seo → seo.entityMeta; seo_defaults → seo.globalDefaults; redirects → redirects.manage.

**Consequence.** Make the savebar and publish modal eligible per item. Publish only the pending items the user holds the area caps for, show the rest as waiting, and never let Content Creator publish theme, identity or SEO items.

#### 15. The UI design's save semantics and tags are consistent with the release backend (REL) contract it consumes.

**Verdict: refuted.**

**Evidence.** Contradictions with design-release.json:
- Media alt/tags: staged in the UI (§7, open question 1) vs immediate plus a media:all purge in REL (A3-10, §1.2).
- Redirects: immediate with 'Sync to edge' in the UI vs 'staged on purpose' with slug renames in REL §1.1.
- Page visibility: immediate in the UI vs a registry entry in REL §12 finding 1.
- Theme tag: `site:chrome` in the UI vs `theme:active` in REL. REL's tag-closure test requires every emitted tag to be stamped by a route.
- site_chrome: one singleton in the UI vs 'one table per capability' in REL's registry contract #6.

Duplicate ownership:
- harness: REL R0 vs UI AV-01;
- preview route, bridge and CSP: R9 vs AV-26;
- savebar, publish, history and versions: R12/R13 vs AV-24/AV-25/backups, with /admin/settings/versions vs /admin/backups;
- both edit public/styles/admin.css, nav.ts and ResourceForm/ResourceTable.

**Consequence.** Reconcile one contract and one owner per component before AV-13, AV-24, AV-26, AV-27 and AV-28. Otherwise there are conflicting behaviours, merge conflicts and a double-counted bundle.

#### 16. page_sections.label is an admin-only column.

**Verdict: refuted.**

**Evidence.** 0016_page_sections_public.sql:93 grants `select on public.page_sections to anon` for the whole table, and no later migration narrows it. A new column is therefore anon-readable through PostgREST behind the 0011 published-page fence.

**Consequence.** Either accept that labels are public (low sensitivity) or switch anon to a column grant in the same migration.

#### 17. admin.css declares only Almarai 400/700 Arabic under a wider range than the files; --ad-font-ar should equal --bs-font-ar (Almarai first).

**Verdict: verified.**

**Evidence.** - admin.css:50-69 declares only 400 and 700 Arabic, with ranges U+0750-077F, U+FB50-FDFF and others.
- global.css's Arabic subset covers only U+0020, U+00A0, U+0600-06FF, U+200C-200E and U+2010-2011, across 14 @font-face rules.
- global.css:57 is `--bs-font-ar: 'Almarai','Almarai Fallback','Archivo',…`, while admin.css:162 currently puts Archivo first.

**Consequence.** The planned font-face parity test is sound.

#### 18. The v2 token contrast values (dim2 #626A7F, side label #919295, badge texts, control #828B9E, focus, tones, series) meet AA as stated.

**Verdict: verified.**

**Evidence.** Recomputed with the WCAG formula:
- dim2: 5.00 on bg, 5.40 card, 5.22 surface-2, 4.57 preview.
- side label 6.24; side text 10.13; control border 3.42 / 3.17 / 3.31.
- ok 5.06, warn 4.81, err 5.76 (6.57 on card), sky 4.76.
- white on primary 10.61, on hover 6.03; focus 6.03 / 5.59; focus-dark 7.57.
- tones 5.42–10.61; chart series 5.02–9.83 on bg.
- The mockup values fail as claimed: #8A93A6 2.86–3.09, line2 1.36, toggle track 1.53.

However, scripts/contrast-audit.mjs:245 hand-copies the admin tokens ('keep in sync'), so drift between the audit and admin.css goes undetected.

**Consequence.** Keep the values. Have the audit read admin.css tokens (or a shared token JSON) instead of a hand-maintained copy.

### New risks

- Free-plan image quota (5,000 unique transformations a month). /_image accepts arbitrary w, h, q and f values, so anyone can exhaust it. New transformations then fail with 9422, and the adapter endpoint has no fallback, so images break across the site, LCP posters included.
- Uploaded LCP posters on About, Our Work and case studies could miss the 2.5 s LCP budget. Originals up to 10 MB / 40 MP are transformed on first request, and a cold transform of the small logo already measures about 3.5 s in production (docs/hero-intro.md §3).
- Privacy (PDPL): EXIF/GPS metadata stays in originals in the public bucket. Every published page's /_image href exposes the original's URL.
- Supabase Free egress (5 GB) and storage (1 GB): each uncached transform refetches the full original. The 1 GB is shared with the private applications CV bucket. The Cache API's persistence is documented only for custom domains, and the site runs on workers.dev until the zone exists.
- Workers Free limit of 100k requests a day: every /_image hit and every /styles/theme.css hit is a Worker invocation.
- Requests for AVIF wider than 1,200 px fall back to WebP/JPEG (Cloudflare limits), yet still count as separate unique transformations, which wastes quota.
- size-limit is not run in CI, so both JS budgets can regress silently. CLAUDE.md §6 claims this gate exists.
- Rolldown pulls captured modules' dependencies into the same chunk, so the planned admin-rich and admin-screen-* chunks may not contain what their names say. Chunk names would then be an unreliable proxy in the budget globs.
- A sum-of-chunks budget gets worse with every lazy split (+4–9% gzip overhead), which pushes the team away from code splitting.
- Both the UI design and the release backend design build the harness, the preview route/bridge/CSP change, the savebar/publish dialog and the history/versions screens, with different file paths and routes. Both also rewrite admin.css. Expect merge conflicts and a double-counted bundle.
- Turning on the new opt-in Workers Cache, for example to cache /_image, would also cache Tier A HTML for a year at once (s-maxage=31536000). It must not be enabled before the purge seam exists.
- FAQ cutover: production needs a delta seed. If the FAQ rows are flagged __placeholder, gen-seeds demotes them to drafts, and /contact loses its FAQ and the FAQPage JSON-LD in production.
- When SECTION_READS adds tags, tierATags() silently truncates at 30 tags and drops the trailing locale tag.
- If the popover sidebar is opened below 900px and the window is then widened, it stays in the top layer until it is light-dismissed.
- Today the login page downloads all of admin-ui (about 166 KB gz, including Tiptap, ProseMirror, zod and React) just for a fetch helper.

### Design changes required

- AV-11 configuration:
- astro.config.mjs derives image.remotePatterns from PUBLIC_SUPABASE_URL via vite loadEnv(): {protocol, hostname, port, pathname:'/storage/v1/object/public/media/**'}, plus an http://127.0.0.1:54321 pattern for CI.
- The build fails when the variable is missing in production.
- Stored width and height are always passed; inferSize is never used.
- ImageRef.src is widened to `ImageMetadata | string`.
- AV-11 migration and schema:
- Replace media_assets_public_read (0028:408) so it includes 'storage'.
- Extend media_assets_provider_known (0020:37).
- Add 'storage' to PublicMediaRowSchema (content.ts:59), MediaWriteSchema and imageRef().
- Keep display_name out of the anon column grant.
- Update launch-runbook.md:298.
- Normalize at upload through env.IMAGES: cap the long edge at about 2560 px, re-encode to WebP or AVIF, and strip metadata before storing the object. This bounds cold-transform latency and egress and removes EXIF/GPS. It also matches the client TDD §8.6 ('image variants generated on upload').
- Guard /_image with a custom image.endpoint entrypoint that wraps the adapter's transform:
- w must be in a code allow-list (the union of every component's widths);
- f must be avif, webp, jpg or png;
- q must be absent or allow-listed.
Document the 5,000/month budget, the 9422 behaviour, and the emergency passthrough fallback (which needs a §2 amendment).
- Bundle budget:
- Add a size step to CI (ci.yml, after Build).
- Redefine the admin budget as the eager JS graph of each admin route: the closure of static imports from the layout script, renderer and island facades, ≤300 KB gz.
- Give lazy chunks their own caps (for example admin-rich) and add a total-sum tripwire.
- Amend CLAUDE.md §2/§6.
- State that KB means 1,000 B.
- Move client.*.js and rolldown-runtime.*.js into the admin entry.
- Add the split overhead (~10–13 KB) and the release backend's UI (≤18 KB) to the ledger.
- Chunking: replace manualChunks with build.rolldownOptions.output.codeSplitting.groups, using explicit test regexes, priority, includeDependenciesRecursively:false and strictExecutionOrder:true. Add a post-build test that admin-ui contains no ProseMirror once admin-rich exists, and that no public chunk imports an admin-* chunk.
- Shell CSS:
- Narrow-screen drawer rules go under @supports selector(:popover-open) and :popover-open.
- At ≥900px, reset the UA popover styles (position, inset, margin, border, padding, background).
- Add a matchMedia → hidePopover handler to AdminLayout's existing script.
- Give drawer and modal bodies container-type: inline-size.
- Document the browser floor: Chrome/Edge 117+, Firefox 129+, Safari 17.5+.
- Cache tags:
- Add media:all now to about, portfolio, portfolio/all and portfolio/[slug] and their AR twins.
- Adopt SECTION_READS for section-composed pages and keep static lists for the case-study template.
- Make tierATags keep the ALWAYS, route and locale tags and fail (in a test) above 30.
- Enforce per-page allowed section types server-side if the Add-section map ships.
- Publish rules: replace 'Publish only for content.publish holders' with per-item eligibility from the release backend registry. SEO publishes SEO items; Admin and Developer publish identity and theme; Content Creator never publishes theme, identity or SEO.
Align the staging lists with the release backend:
- media metadata immediate (A3-10);
- redirects staged;
- a single decision on page visibility;
- one tag name (site:chrome vs theme:active);
- split site_chrome per capability (REL contract #6), or record why not.
- Ownership with the release backend:
- one harness (REL R0 = AV-01);
- one preview route, bridge and CSP edit (R9 or AV-26);
- one savebar, publish, history and versions implementation (R12/R13 or AV-24/AV-25), on one route;
- admin.css edits sequenced after AV-02.
- Test plan:
- List the pin edits explicitly: adminSecurity.spec.ts:164 and :181-190; cacheTags.spec.ts:13-29; adminFields.spec.ts:45, 64, 120 and 194; resourceSync.spec.ts:29.
- AV-01's no-<script> rule grandfathers src/pages/admin/login.astro until AV-06.
- Wire admin routes into tests/a11y/axe.e2e.ts, which has none today.
- AV-02:
- Start from the app.css text (verbatim-first).
- Turn its literal colours into tokens and add reduced-motion and forced-colors rules.
- Scope the element resets to the new shell or drop them.
- Retarget the .in/.ta/.sel rules to the repo's element/type selectors, or add classes in FormField.
- Replace .on with ARIA-state selectors.
- Replace the ~464 inline styles with a small class layer.
- Keep every hook current islands use (confirm.ts, toast.ts, MediaField, RepeaterField, RichText, the PII grid, crumbs, search hits).
- scripts/contrast-audit.mjs: read the admin tokens from admin.css (or a shared token JSON) instead of the hand-copied block at line 245.
- Theme delivery: also evaluate a nonce'd inline <style> of custom properties emitted by BaseLayout. It complies with §3's nonce-based style-src and avoids a render-blocking /styles/theme.css round trip on themed Tier A pages.
- Mark page_sections.label as public, or move anon to a column grant in the same migration.
- FAQ cutover: ship faq_items to production as non-placeholder published rows through a delta seed (runbook §6d) before removing CONTACT_FAQ. Assert in e2e that /contact still has the FAQ and the FAQPage JSON-LD.
- Workers Cache (cache.enabled): evaluate it only together with the release backend's purge seam, because it would cache Tier A HTML as well as /_image.

## Coverage against the client's ADMIN_TDD.md

Coverage walk of ADMIN_TDD §2-§19 against the release design (R0-R16), the UI design (AV-01-AV-34), the CRM design (CRM-1-CRM-14), P-1-P-9 and the merger additions, checked against the repo, the prototype sources (which win on conflicts) and vendor docs.

**Result:** 127 rows.
- 59 covered.
- 20 deviated with a real CLAUDE.md, PDPL or security basis, or under a binding owner decision.
- 13 deferred consistently with A1.
- 25 deviated for convenience (challenged with in-standard designs).
- 10 missing.

**No slice exists for:**
- the help centre with DB articles (A1 defers Get connected, not help);
- 7-day invitations: Supabase invite links follow the global Email OTP expiry (default 1 h; more than a day is discouraged and Management-API only);
- protecting the owner account from demotion (users/[id].ts only blocks self-demotion);
- image re-encoding (EXIF stays public in the bucket);
- company find-or-create at ingest;
- captcha (KAN-20);
- a guard that Eastern Arabic digits survive in content;
- owner-set quick-action presets per role (TDD-only);
- a page-scoped history restore.

**Biggest convenience deviations challenged:**
- Sales without Website stats (§5 gives analytics.read to every role).
- GA4 injection deferred: CLAUDE.md §2 locks 'GA4 behind consent' and gate.ts already names it.
- 2FA.
- Page visibility: password, redirect target, dates, template-wide hide.
- Maintenance copy and auto-off.
- Section settings, Shared text, generic section types.
- Theme v2 and motion; header buckets; loading styles.
- Free stage colours: the CSP blocks style attributes, not nonce'd or stylesheet classes.
- Contacts in ⌘K; activity export.
- Stats enrichment, health extras, scheduled content backups, import/files.

**Slice text contradicts binding decisions:**
- AV-13 and AV-19 are immediate where P-3 stages page visibility and redirects. Staged visibility also needs a KV re-sync after apply and rollback.
- UI §7 stages media alt/tags; P-3 makes them immediate.
- AV-24 shows Publish only to content.publish holders; P-2 publishes per area.
- AV-28 uses one site_chrome table; P-9 splits it by capability.
- R9 and AV-26 define two bridge modules; P-4 says one.

Style-Finder is unclassified, and Forms config has no P-2 area or §5 row.

**CLAUDE.md wording to amend first:**
- P-2 against §5's literal 'Developer ... NO publish/schedule'.
- Staged redirects against §1/§8 'every save rebuilds KV'.
- The staff bypass against the §3 maintenance bullet; it must fail closed.

**Two risks:**
- R10's change-capture restore misses out-of-band writes: the guard exempts runbook and cron, and content_versions keeps no delete snapshots.
- The free plan's 10 ms CPU is not budgeted for preview SSR or for validating a 500-item publish.

**Already shipped:** Retry-After (maintenance.ts:100).

**§18 acceptance:**
- Pass as written: 4 of 14 (homepage publish, hidden page, maintenance plus staff bypass, Sales 403). The hidden-page and maintenance checks need new tests.
- Pass partly, with replacements: 6. These are per-role sessions instead of View as, https instead of file://, preview after the autosave reload, the bridge kept off public pages, bell-only notifications, and restore of a deleted project through versions.
- Cannot pass under A1: 4 (su.mjs, the e-mail campaign, the WhatsApp 24-hour rule, the automation wait).

**Critical files:**
- handoff: ADMIN_TDD.md
- CLAUDE.md
- docs/admin-v2/releases.md
- docs/admin-v2/ui.md
- docs/admin-v2/crm.md
- src/middleware.ts
- src/pages/api/admin/users/[id].ts

Several claude.ai connectors (Figma, Gmail and others) need authorising in the claude.ai connector settings; this review did not need them.

The 127-row table and the acceptance mapping are in [deviations.md](deviations.md).

### Challenges to the designs

- Sales without Website stats (CRM-10: 'Sales must NOT get analytics.read'). This is convenience. CLAUDE.md §5 grants analytics.read to all four current roles, and the prototype's Sales has 'stats'. Lead-derived cards are already gated on leads.manage, which Sales holds. Give Sales analytics.read but not siteHealth.view (§5 keeps that Admin + Developer). The change is one ROLE_CAPS cell plus the §5 / architecture §3.4 rows and matrix.spec, all inside CRM-10.
- GA4 injection and the /stats/ga tab are deferred (UI 'later' list; AV-20 stores the id only). A1 does not list them. CLAUDE.md §2 locks 'GA4 secondary, behind consent', and packages/consent/gate.ts:8 already names 'GA4 injection'. Proposal: (1) a same-origin loader injects gtag only after hasConsent('analytics'); (2) the CSP gains googletagmanager / google-analytics sources only while an id is set, with one Report-Only cycle at the single enforcement point (securityHeaders.ts:135 is connect-src 'self' today); (3) GA numbers are read server-side through the Data API, with a service-account secret in astro:env. Ad pixels need the marketing category and belong with the A1-later ad audiences, so ask the owner.
- Help centre deferred (UI §0). A1 defers Get connected, not help. Proposal: a help_articles table (tenant, Admin write, staff read, typed p/h/ol/tip blocks validated by Zod, no HTML); a drawer in AdminChrome; per-screen guides through AdminLayout's reserved 'guide' prop, filtered by caps. Rewrite the guides for built features: 9 of the prototype's 15 describe later-phase screens, and the 'roles' guide contradicts §5. Editing can wait for TDD phase 7; reading should not.
- 2FA hidden 'until MFA exists' (AV-05/AV-21). Supabase Auth TOTP MFA is available and raises Pillar 1. Proposal: enrol and verify in the Account drawer; enforce aal2 in resolveAuthContext when a tenant require_2fa flag is on; 'Reset 2FA' through auth.admin.mfa.deleteFactor (Admin, liveRecheck, audited); show the 2FA column from the factor list. The prototype shows 'Require 2FA for everyone' and per-user 2FA badges.
- Page visibility: password, redirect target, hide-from/until dates and template-wide hide (UI deviation 9; prototype screens_cms.js:413-446). 'Password pages cannot be edge-cached' is solved the way maintenance is. (1) The Worker answers gated paths pre-cache as private, no-store, noindex. (2) It verifies the password in Postgres (pgcrypto bcrypt through a service-role RPC), so the free plan's 10 ms CPU is not spent hashing. (3) It sets an HMAC-signed per-page cookie and limits attempts with public_write_hit. Dates and a /services/* or /portfolio/* prefix rule live in the same KV snapshot; the minute cron purges nav and sitemap tags at each boundary. Any published page can be the 302 target.
- Maintenance copy, background, contact buttons, 'Back on' auto-off and the visible date (UI deviation 28; prototype screens_ops.js:736-761). The stated concern is keeping the DB off the critical path. Write these values into the same site:maintenance KV value when they are saved, so there is no DB read at request time. Middleware evaluates now >= until; the minute cron flips the row and audits; Retry-After is derived from until. Use the hero poster still rather than the MP4 so the 503 stays light, or exempt /media/* during maintenance.
- Per-section background, spacing, reveal and anchor (UI deviation 8). Closed variants work through classes and data attributes, so the CSP is not a blocker. Give each background variant contrast-audit pairs and a visual baseline. Turning reveal off only removes motion. Anchors can be editable with a slug pattern, per-page uniqueness and a linkables refresh. Keep 'show on mobile' out (Pillar 3 mobile parity) or limit it to decorative sections.
- Template 'Shared text' read-only (UI deviation 11). Code ownership is today's implementation, not a rule. Move SERVICE_PAGE_COPY and the case-study labels into a staged template_copy singleton (AR required by Zod; tags service:all / portfolio:all), with the code values as defaults (the AV-23 pattern).
- Section library and New page (UI deviations 7/10; AV-33 'later'). Keep Custom HTML out (Pillar 1). Gallery (media refs + bilingual alt), Video (a showreel window, EXC-009, zero bytes before intersection) and Text block are ordinary typed section types. New page needs the [slug] route plus SEO, sitemap and hreflang. Owner item 9 is still open, and A1 does not defer it.
- Theme v2 and motion (AV-32 'later'; UI deviation 24). (1) Radius, button style, heading weight and case are a token refactor with visual regression, and cost nothing against the budget. (2) A curated self-hosted catalogue of the prototype's font tiles works without Google links: pre-subset woff2 plus metric-override faces per weight and script, within 180 KB per route. (3) Reveal-off, marquee-speed presets and a site-wide 'reduce motion' switch only reduce motion, and would partly answer EXC-007 (WCAG 2.2.2).
- Header tint, blur, solid-after-hero and sticky (UI deviation 25, beyond the merger's options). Offer bucketed values through data attributes, for example tint 0/40/70/100 and blur 0/8/16. Require a minimum tint when 'stays transparent' is chosen, for contrast. Sticky off is harmless. 'Language switch always shown' is a product choice: CLAUDE.md requires hreflang, not a visible toggle. Keep it, but record it as owner-approved.
- Loading screen 'progress bar' and 'text' styles, tagline and light background (UI deviation 27). A scaleX bar is compositor-only, and a light background is a class. The tagline can ship behind the lhci re-gate (home LCP is the intro logo, CLAUDE.md §6) instead of being refused.
- Pipeline stage colours limited to six tones (CRM deviation 6: 'free colours need inline style'). The CSP forbids style attributes, not nonce'd style elements or same-origin stylesheets. Serve validated hex values as generated classes, either a nonce'd style block in AdminLayout or /styles/crm-stages.css?v=. Gate badge text for AA, as the theme gate does, and keep the named tones as presets.
- Contacts never in ⌘K (CRM deviation 4). Leads must stay out: they hold envelope-encrypted fields and every view is audited. Contact names and companies, however, are plaintext under RLS. Add a palette provider for crm.contacts holders that calls the existing POST lookup: at most 8 results, name and company only, q in the body so it never reaches URLs or logs. Campaign search comes back with the later phase.
- Activity log export and person/date filters (UI deviation 33). An export is allowed under the §7 lockdown pattern: audit.view + export.csv holders (Admin + Developer), liveRecheck, 3/hr per user and tenant, two audit rows, no-store, field names only. It needs a §5 row. Person and date-range filters are plain server-side filters.
- Stats tabs (UI deviation 22) and the dashboard Realtime / Team notes widgets (UI deviation 20): split the deferral. (1) PDPL-gated: referrer/UTM/device/country capture (consent + notice change, O4) and a persistent visitor id (needs legal); cities never. (2) Feasible now on already-consented data: sessions from session_id; events (cta_click and service_interest are already in AnalyticsEventSchema); a views -> inquiry funnel; busiest hours in Riyadh time; goals; realtime from a 1-minute rollup (Pillar 4: dashboards read rollup_* only). (3) Team notes: a staff singleton with version, audit, a 2,000-character cap, a 'no client contact details' hint and a retention rule.
- Site health extras (UI deviation 23). §10 forbids an in-Worker uptime checker, not uptime data, so read the external monitor's API with a read-only key stored as a Worker secret. Check SSL and domain expiry through RDAP in the daily cron. Failing checks can be bell items now; external channels are A1. The weekly link crawl will not fit the free plan's 10 ms cron CPU without chunking, which is an owner/infra decision.
- Backups (UI deviation 34). Keeping leads out of admin backups and restores is standard (§7, §10). A daily content snapshot is within the standard: export-backup JSON to R2, keep 30, list and download under the export lockdown. So are 'Back up now' and restore-as-drafts through the release path, which match the prototype's card.
- Small caps. Media 10 MB: the TDD asks for 25 MB, the sniffer reads headers only and Supabase's free plan allows larger files, so stream the upload and allow 25 MB. Service value cards and problems: the prototype caps them at 4 and 5, the repo at 6. Tighten the admin schema after checking existing rows.
- Import CSV and contact Files (CRM deviations 15/16, owner item O12). A1 defers inbox, campaigns, automations, templates, reports, export & audiences and Get connected; import and files are not on that list. Files can reuse the private-bucket + audited-download pattern of job applications. Import can ship with per-row lawful-basis attestation, without marketing consent. The owner should confirm the deferral explicitly.
- Phone matching: CRM-5 never auto-links on phone. That is a reasonable data-quality choice, not a standard rule; the TDD and prototype match on e-mail, then E.164 phone. Either offer link-and-flag ('Linked by phone, please check') or get the owner's confirmation.
- Binding decisions that need CLAUDE.md amendments first. (1) P-2 contradicts the literal §5 canonical text ('Developer ... NO publish/schedule') until R14's amendment lands. Relabel the row 'Publish / schedule content' in §5, architecture §3.4 and matrix.ts LABEL_TO_CAP, so the derived release matrix does not conflict with it. (2) P-3's staged redirects contradict §1/§8 ('every redirect save rebuilds KV site:redirects'). (3) The merger's staff bypass changes the §3 maintenance bullet ('/admin exempt'), and the bypass must fail closed when the session cannot be verified.

### Details the designs missed

- Invitation links expire in 7 days (§7, §16 /auth/invite/:token). AV-21 reuses inviteUserByEmail, and Supabase invite links follow the global Email OTP Expiration: default 3,600 s; more than 86,400 s is 'strongly discouraged and can only be set via the Management API', and the same setting also lengthens password-reset links. Options: (a) an admin_invites table (hashed token, role, expires_at = +7 days, accepted/revoked; Admin-only RLS) plus /admin/invite/[token], which creates the account at acceptance; this needs a transactional sender for the invite e-mail (an auth e-mail, not A1 CRM outbound), so it is an owner decision; or (b) accept links of 24 h or less, with Resend.
- Owner protection (§7: 'an owner cannot be downgraded by an admin'). src/pages/api/admin/users/[id].ts only refuses self-demotion and self-deactivation, so any Admin can demote or deactivate the principal Admin. Add a runbook-set account-owner marker, enforced by a DB trigger and a Worker check; it is not a new role. Ownership moves only by the owner's own action.
- Quick actions pre-set per role by the owner (§15). AV-09 has per-role default layouts but no owner editor. The prototype itself has only a global QUICK_DEFAULT (screens_cms.js:162), so this is TDD-only. Add admin_role_defaults (Admin write; layout plus quick list per role), used when a user has no prefs and by 'Reset to default'.
- Help-centre articles as database content (§13). No slice exists. Besides the help_articles table and drawer, the per-route ROUTE_GUIDE map needs AdminLayout's reserved guide prop, and the guides must be filtered by caps so nobody is sent to a screen they cannot open.
- Activity kept 12 months (§6.4) vs 90 days in the prototype (screens_ops.js:1094) vs permanent under CLAUDE.md §3/§7 (append-only, no DELETE, exempt from retention). AV-22's 'kept permanently and tamper-evident' copy is correct. Record it in the deviations register so the client sees why neither number applies.
- Versions store a full snapshot (§6.4). R1/R4/R10 capture before/after row images only while a release token is valid, and R5's guard exempts writes with no role claim (runbook SQL, staging reseeds, cron). content_versions also has no delete snapshots (0009_admin_cms.sql:66-73: AFTER INSERT OR UPDATE). So an out-of-band edit between two releases makes 'Restore vN' compute the wrong values. Fix options: capture no-token writes as system ledger items; or have revert.ts compare each before-image with the content_versions state at vN's published_at and refuse on drift; or store a full content JSON snapshot per release in R2.
- Retry-After on the 503 (§8.2) is already shipped: src/lib/http/maintenance.ts:100 sends 'retry-after: 3600', tested in tests/lib/maintenance.spec.ts:71. When the prototype's 'Back on' date is built, derive Retry-After from it.
- Eastern Arabic digits in content are never transformed (§17). None of the designs mention it. No content path normalises today (no .normalize or NFKC in src or packages), and the CRM normaliser converts digits only for the phone blind index while storing the value as given. Risk points: typed number inputs (statistics, values), the AccentSchema word tokeniser, placeholder-figure guards, and the footer {year} token, which is code-formatted with ar-SA-u-nu-arab. Add a round-trip test (Zod -> toRow -> sanitiser -> render) for U+0660-0669 and U+06F0-06F9 in AR fields.
- 'Discard restores the draft from live' (§8.3) is covered: deleting the content_drafts rows makes editors show live again, and the site-wide variant is Discard -> Choose... (select all) with a confirm that names the other authors. AV-24's copy ('Everything since the last publish will be reverted') must match R12's one/mine/selected scopes.
- Image re-encoding (§17 security basics). AV-11 byte-sniffs and stores the original in the public bucket, so EXIF/GPS stays reachable at the original URL. Re-encode at upload through the configured IMAGES binding with metadata stripped (CPU off the Worker, which matters on the free plan) and store only the output.
- Company find-or-create on submit (§11.1). CRM-11 companies are created manually. Add a match inside crm_ingest_lead by non-freemail domain blind index or normalised company name.
- Forms config (merger slice). Server-side 'required' must follow the config (TDD §6.1: 'required is validated server side too'). A save must purge the tags of the home/contact/services/join pages. Any consent-copy edit needs a stored version (PDPL; recruitment consent is already versioned, §7). P-2 does not say which capability publishes forms config, and §5 has no row for it.
- Page visibility, prototype details (screens_cms.js:413-446): a redirect to any other page (not only home or 404); 'Hide from' / 'Show again on' dates; the template note 'hiding it hides every service/project page'; a password gate with a bilingual message. AV-13 covers 404 or home only.
- Page visibility staged (P-3). AV-13 rides hidden paths on the site:maintenance KV snapshot, so every release and every rollback that touches visibility must re-sync that snapshot after commit. R7's post-apply effects cover only redirects (syncRedirectsToEdge).
- Maintenance page details (screens_ops.js:736-761): bilingual headline/message, background (video/black), e-mail/WhatsApp buttons, 'Back on' with auto-off at midnight, 'show the date'. allowTeam is a toggle in the prototype, so the merger's staff bypass should be switchable.
- Users Security card (screens_ops.js:1013-1016): 'Require 2FA for everyone'; 'Session length' (offer only 7 days or less, to match SESSION_MAX_AGE_SECONDS); 'Allowed email domain' for invites; and the invite drawer's 'Message (optional)'. Supabase templates can render it from the invite's data.
- Activity log: filter by person and date range, plus export (§15). AV-22 has kind chips and a bounded q only.
- Page-scoped history restore (§8.3: 'restores one page's keys'). R10 offers per-entity and site-level restore, but a page is a page row plus its page_sections rows. The History drawer needs a 'restore this page as of vN' that stages both.
- Free-plan CPU. The owner chose the Workers free route (docs/security-exceptions.md EXC-008, J1), which allows 10 ms CPU per request and per cron trigger (Cloudflare limits). R6 re-parses up to 500 items in the Worker, and R8 emulates PostgREST in memory over up to 2,000 rows per table. Neither design budgets CPU. Measure both on staging, or raise Workers Paid as an owner item.
- Slice-text conflicts with binding decisions: AV-13 'immediate' and AV-19 'redirects immediate' vs P-3 staged; UI §7 'media alt/tags/replace = draft' vs P-3 immediate; AV-24 'Publish only for content.publish holders; SEO/Developer wait' vs P-2 per-area publishing (R12 has it right); AV-28 site_chrome (one table, admin + developer write) vs P-9 (site_appearance under theme.edit, footer on site_profile under settings.general); R9 and AV-26 define different bridge and envelope files (previewMessage.ts vs previewBridge.ts) vs P-4's single bridge.
- Unclassified or inconsistent items: Style-Finder (ai_questions/ai_styles) is in neither P-3 list (release design: immediate until the quiz ships; UI §7: draft); the publish note is limited to 140 characters in AV-24 and 280 in R6; the 'Backups & versions' nav caps (export.backup, content.publish) exclude SEO, while R13 says every CMS role sees it; crm_settings.timezone is editable in CRM-9 while General shows the timezone read-only.
- TDD vs prototype disagreements where the prototype wins and the designs already follow it: contact stages are fixed (CRM-9 read-only); assignment rules are manual/round-robin/fixed with no 'by-service'; loading duration is at most 1.5 s; identity and footer edits wait for Publish (the TDD lists 'settings' as immediate). Maintenance is staged in the prototype; the program keeps it immediate on Pillar 1 grounds.
- Friendly lead ids: the prototype shows L1047-style ids in URLs and in the form's 201 body, while the designs use uuids. A per-tenant lead_number keeps the look without putting names in URLs.
- Sales in the prototype sees Website stats (and Site health). See the challenge on analytics.read; Site health stays Admin + Developer under §5.
