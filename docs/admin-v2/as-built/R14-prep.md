# R14-prep: everything the release switch-on needs, except the switch

- **Lane:** Releases
- **Design:** README's R14 row (deps R13 + U5 to U10, U14), plan B5 ("rehearsed first in CI,
  where the whole e2e suite runs in release mode; then a publish and a rollback drill");
  [releases.md](../releases.md) §4.7 (the legacy conversion), §8 edge case 21, §10 (switch-on,
  rollback before contract), slice R14; the open items of R7 (the maintenance contact
  snapshot after a release that changes the identity), R10, R11 (the two switches and the
  discard rule), R12, R12b and R13 (history on the singletons and entity SEO; the publish card
  in layouts saved before R14); owner decisions of 2026-10-28 (history for the identity, the
  SEO defaults and entity SEO before R14; no "Publish now" on a scheduled release; R14's
  production switch-on gets a final owner go after a green rehearsal)
- **PR:** at review (branch `feat/r14-prep`, from main `42b61c6f`)
- **Migration:** none (see Plan: every piece is Worker, test, workflow or runbook)

## Plan (written before the build)

Releases stay OFF in production and in the required CI checks. Nothing here runs against
production. With releases off every screen, route and write path is what main serves, except
the History buttons item 1 adds (which only read).

1. **History for the identity, the SEO defaults and entity SEO** (owner decision 2026-10-28).
   - The two singletons key their snapshots by the tenant (`app.tg_snapshot_singleton`, 0038),
     which no editor holds and which the client should never choose. `GET /api/admin/history`
     and `POST /api/admin/history/restore` take no `entityId` for a singleton type
     (`site_profile`, `seo_defaults`: the registry's tenant-keyed entries, held equal by a
     test) and read the session's tenant instead; any other type still needs one (422 either
     way it is wrong). Read under the person's RLS as before, behind the same area gate
     (`readsEntity`: `settings.general` for the identity, `seo.globalDefaults` for the
     defaults, `seo.entityMeta` at full or view for entity SEO).
   - `HistoryTarget.entityId` may be null ("this site's own"); the drawer leaves it out of its
     query and its restore body.
   - EditorForm takes `historyOf` (the record's words and its page for Preview) for a record
     its own values cannot name.
   - General (the identity editor), SEO › Site wide (the defaults) and the shared SeoPanel (a
     page's search settings: the row's own id, from the load and every save; none until a
     row exists) pass `history`. SeoPanel's button is named "History of Search settings for
     <page>", so on a service's SEO tab it stands apart from the service's own History.
   - Releases off: the drawer lists the saves that went live and offers no Restore (R13's
     rule, the server's `restorable`), as on every row editor.
2. **The maintenance contact snapshot after a release** (R7's owed item, U9's hand-off): a
   release whose items change the identity's contact columns (`brand_name`, `contact_email`,
   `whatsapp_e164`), or whose items are not known, refreshes the maintenance page's buttons at
   the edge while maintenance is on, as the identity's live save does (`afterWrite`). One
   helper shared by both (`refreshMaintenanceContact`): the edge's value first (nothing more
   while the edge says off), the settings row as the system, the contact from the release's
   after-image (read only when unknown), the put; best effort, logged. The fire's subrequest
   budget gains it; the all-types publish count is re-measured with it.
3. **The publish card in layouts saved before R14** (R13 open item, review C6). Rule: a
   release widget (`RELEASE_WIDGETS`) that a stored layout or role preset names NOWHERE (no
   column, not hidden) takes its place from the role's default layout; one it names, hidden
   included, stays where the person put it. Every other widget keeps U1's rule (unnamed means
   hidden), so no dashboard changes while releases are off (the page and the JSON twin strip
   the release widgets then, as on main).
4. **The CI rehearsal** (plan B5): the whole e2e suite with releases ON for the e2e tenant.
   - Playwright: `E2E_RELEASES=on` adds a `releases-on` setup project after `admin-samples`
     (the sample rows exist live first) that calls `app.enable_releases(tenant, e2e admin,
     e2e admin)` as the owner on the loopback database (psql with the local stack's
     `SUPABASE_DB_POOL_URL`, refused for any non-loopback URL), and every other project
     depends on it. Unset, the config is exactly main's.
   - `tests/admin/releases-mode.e2e.ts` (skipped unless releases are on): as the Admin, an edit
     saved as a pending change (the savebar), Publish (a version), the public page shows it; a
     scheduled release (the dialog's Schedule, the time passed, the minute cron fired through
     wrangler's `/__scheduled`), the public page shows it; Restore of the earlier version on
     Backups & versions, "Publish vN again", the public page shows the old words, the version
     a rollback; the history drawer offers Restore.
   - The specs that assert releases-off behaviour (a save that goes live at once, "isn't
     switched on yet") skip in release mode with a named reason, listed here; everything else
     runs as it is.
   - `.github/workflows/releases-rehearsal.yml`: `workflow_dispatch` (and a weekly schedule),
     never on a push or a PR, never a need of the deploy, not a required check: the e2e job's
     steps (held equal by `tests/ci/workflows.spec.ts`) with `E2E_RELEASES=on` and
     `wrangler dev --test-scheduled`.
5. **The switch-on and rollback runbook** (launch runbook §6p): the announced freeze (~15
   minutes), the read-back before, `app.enable_releases` with the operator and the fallback
   scheduler (O-5), the read-back after, the publish and rollback drill in production, and
   `app.disable_releases` as the way back with its discard rule; the read-back SQL as a file
   (`scripts/sql/releases-readback.sql`) a spec keeps in step with 0112's functions.

**Not in this slice (R14 proper):** running the switch; the CLAUDE.md and architecture
amendments, the derived §5 release matrix, the publishing guide, the static write-path test,
removing the per-item schedule UI, flipping the required e2e job to release mode.

## What was built

(filled in as the build goes)
