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

The plan held, with the changes listed under Departures.

## What was built

### Releases off: what changes and what does not

Releases stay off for every tenant (`app.release_tenants` is empty) and in every required check.
With them off:

- **Three editors gain a History button** (General's identity form, SEO › Site wide, and the
  SeoPanel's form once the page has a search-settings row). Each only reads (`GET
  /api/admin/history`), loads its drawer on first use (`admin-history`, as R13's), lists the saves
  that went live and offers no Restore (the server's `restorable` is false). Nothing else on
  those screens moved.
- **Every write path is main's.** No kernel, staged, singleton or entity-SEO write changed; the
  identity's live save refreshes the maintenance buttons through the shared helper with exactly
  main's reads, writes and answers (`generalKit.spec.ts` unchanged and green).
- **The dashboard is main's.** The placement rule (below) can put the publish card on a stored
  layout's board, and the page and its JSON twin strip the release widgets while releases are off,
  as on main; its loader reads nothing, so the render's subrequests are unchanged (42).
- **The required e2e job runs what it ran.** Without `E2E_RELEASES` Playwright's projects are
  main's (held by `tests/ci/releasesRehearsal.spec.ts`), the drill is in no project, and the
  setup that switches releases on is matched by none. The skips added to the specs written for
  releases off are false.

### 1. History for the site identity, the SEO defaults and a page's search settings

- **The two singletons are named by the site, never by an id.** Their snapshots are keyed by the
  tenant (`app.tg_snapshot_singleton`, 0038), which no editor holds and no client should choose.
  `HistoryQuerySchema` and `HistoryRestoreRequestSchema` take `entityId` as optional, and a
  refinement requires it for every type but `SINGLETON_ENTITY_TYPES` (`site_profile`,
  `seo_defaults`), which must not send one (422 either way, before any read).
  `historyEntityId` (`src/lib/release/history.ts`) answers the session's tenant for a registry
  entry keyed by `tenant_id`; the history read and the one-snapshot restore both use it.
- **The area gate is unchanged**: `readsEntity` (the identity: `settings.general`, Admin and
  Developer; the defaults: `seo.globalDefaults`, Admin and SEO; entity SEO: `seo.entityMeta` at
  full or view), then RLS on `content_versions` (CMS staff, tenant first).
- **The client** (`src/lib/admin/historyTarget.ts`): `HistoryTarget.entityId` may be null (the
  site's own); `singletonHistory`, `entitySeoHistory`, `historyQuery` and `historyRestoreBody`
  build the drawer's request and its restore body (a singleton's carry no id). Type-only imports
  from the schemas, so no zod reaches the editors' chunks.
- **EditorForm's `historyOf`** names a record its values cannot (the button's "History of …",
  the drawer's title) and the page Preview opens (null: none). General passes
  `{ label: 'Site identity', path: '/' }`, Site wide `{ label: 'Site wide SEO', path: '/' }`, the
  SeoPanel `Search settings for <page>` with the page's own path, and its row id from the load
  and every save (`onRow`), so a page with no row yet shows no History and one saved for the
  first time shows it at once. On a service's SEO tab the service's own History (R13, after the
  panel) and the panel's stand apart by name; `tests/admin/backups.e2e.ts` now finds the
  service's by `/^History of (?!Search settings for )/`.
- **Releases on**, Restore stages the snapshot through R10's path for the identity and the
  defaults (an update of the tenant's row) and entity SEO, as for any row.

### 2. The maintenance page's buttons after a release (R7's hand-off from U9)

- `snapshotNeeds` (`src/lib/release/afterEffects.ts`) owes `maintenance` when a release's
  `site_profile` item moves `brand_name`, `contact_email` or `whatsapp_e164` (compared as JSON:
  key order and a missing value read as null do not count), carrying the after-image; and when the
  items are not known (an apply that committed after the Worker stopped waiting), with no image.
- `rebuildSnapshots` refreshes them as the system through `refreshMaintenanceContact`
  (`src/lib/maintenance/refresh.ts`): the edge's value first (maintenance off at the edge:
  nothing read or written), the settings row with the service client for the release's tenant
  (off there: nothing written, the site never switched on), the buttons from the image (or the
  identity read as the system), the put. A miss logs a warning (`release:snapshot`) and counts
  in the release's `kvSynced`; the 10-minute reconcile heals it.
- The identity's live save (`siteProfile.ts` `afterWrite`) now calls the same helper with the row
  it saved: the same reads, writes and answers as before.
- **Budgets.** A fire that went live, at its worst, is 32 subrequests (was 26: the edge's value,
  the settings, the identity when unknown, the put, and a line if it fails); the minute's worst
  stays 37. The all-types publish is re-measured with maintenance on and the identity's e-mail
  moving: 29 (was 26), cap 30, 34 with a cache zone's purge (under 50). The cron's orphan path
  (`runReleasePurges`) does not refresh the buttons (its own budget, 31): the reconcile does.

### 3. The publish card in layouts saved before releases were on (R13 review C6)

**The rule** (`resolveLayout`, `src/lib/admin/dashboard/layout.ts`): a release widget
(`RELEASE_WIDGETS`, today the publish card) that the stored layout, or else the role's preset,
names nowhere (no column, not hidden) takes its place from the role's default layout (its column,
at its index there, or last in a shorter column). A layout that names it keeps it where it is,
hidden included. Every other widget keeps U1's rule (unnamed means hidden). Why: while releases
are off the dashboard strips the release widgets from the board, Add widget and every save
(R13), so every layout and preset saved before the switch-on never names the card, and it would
otherwise arrive hidden for everyone who ever arranged their dashboard. Sales never has it.

### 4. The release-mode rehearsal (plan B5)

- **Playwright** (`playwright.config.ts`): with `E2E_RELEASES=on`, `releases-on`
  (`tests/admin/releases.setup.ts`) runs after `admin-samples` (the sample rows are made live
  first, as production's content exists before its switch) and before `chromium` and `admin`;
  `releases-mode` (`tests/admin/releases-mode.e2e.ts`) runs after both, alone, and `visibility`
  (then general, GA4, maintenance) after it. The admin project never runs the drill.
- **The switch** is `app.enable_releases(tenant, e2e admin, e2e admin)` sent with `psql` as the
  owner to the job's `SUPABASE_DB_POOL_URL`, refused unless that URL is loopback and the
  harness's own guard holds (`tests/admin/releasesSwitch.ts`: the two statements, uuids checked).
  Already on (a local re-run): nothing. Replayed in PGlite with the read-back before and after:
  baseline 1, the flag, one `releases.enable` audit row.
- **The drill**, as the Admin, on an FAQ question of the run's own (a random marker; the FAQ is
  on `/contact`): every unclaimed pending change other specs left is removed first (the service
  role), since Publish ticks all; the question created through the FAQ route (`?staged=1`) is a
  pending change and not on `/contact`; the savebar's Publish… and the dialog's "Publish 1
  change" put it live ("Published vP"); its history and the identity's (no id) are restorable;
  a new wording PATCHed (`staged: true`) and scheduled through the publish route 150 seconds
  ahead shows on Backups & versions as Scheduled, then once due `GET /__scheduled?cron=*+*+*+*+*`
  (the Worker's `scheduled`, `wrangler dev --test-scheduled`) fires it, polled until it is a
  published version and the live one, and `/contact` shows the new wording; Restore vP, its
  confirm and toast, then "Publish vP again" and its confirm publish a rollback naming vP
  ("Restored vP"), and `/contact` shows the first wording again; the dashboard's publish card
  names the live version. The question is removed by the service role at the end.
- **The specs written for releases off** skip in the rehearsal (`RELEASES_OFF_ONLY`, in
  `tests/admin/staff.ts`): whole files blog, collections, faq, fields, general, pages, projects,
  reorder, seo, services and visibility (their saves go live at once and they check the public
  site, or the screen's live-mode controls); and the describes "releases off" of releases-ui and
  backups, backups' history drawer ("no Restore while releases are off") and dashboard's
  "arranging the dashboard" (its column positions are the board without the card). Everything
  else runs in release mode: the public suites, the per-role sweep (every screen with the
  savebar), the refusals, the kit's release components, leads, users, media, uploads,
  applications, integrations, the 2FA and sign-in suites, GA4 and maintenance.
- **The workflow** (`.github/workflows/releases-rehearsal.yml`, "Releases rehearsal"):
  `workflow_dispatch` only; the e2e job of perf-seo-a11y.yml step for step (held by
  `releasesRehearsal.spec.ts`: same env plus `E2E_RELEASES`, same steps but the psql client
  before the preview and `--test-scheduled` on it, no design capture), timeout 60. Never started
  by a push or a PR (`workflows.spec.ts` already holds that only ci.yml is), not called by ci.yml,
  so neither the deploy nor branch protection waits for it.

### 5. The switch-on and its way back (launch runbook §6p)

Before the day: production on the newest migrations and a Worker containing R14-prep; a green
rehearsal on `main`; staging first (the same SQL, the editors' flows, O-16's CPU); the operator
and the fallback scheduler named (O-5) with the query that lists the active Admins; the freeze
announced (about 15 minutes, every editor tab closed, the public site untouched). The switch: the
read-back before (`scripts/releases-switch-readback.sql`, one read-only row, its expected
"before" and "after" lines), the exact `app.enable_releases` call and what each refusal means,
the read-back after, the checks in the admin, the drill on a draft FAQ question no visitor sees
(publish v2, Restore v1 and Publish v1 again as v3, optionally a scheduled one), the end of the
freeze. The way back: `app.disable_releases`, refused while anything is pending or scheduled,
and with `p_discard_pending => true` R11's discard rule (the legacy schedule restored, every other
scheduled release cancelled, every pending change thrown away, versions and history kept, a new
baseline at the next switch-on). And the Worker's rollback line while releases are on (a build
containing R13, `42b61c6f`), also in §10. `tests/lib/releasesRunbook.spec.ts` holds the calls to
0112's signatures, the read-back's tables to the switch's own list and to the registry's other
status tables, and its columns to its expected lines.

## Departures from the plan, each with its reason

1. **The drill's edit and schedule go through the routes the editor and the dialog call**, not
   their controls: the dialog's Day and Time are minutes on the studio's clock, so a time 150
   seconds ahead cannot be typed exactly, and the controls are already driven on the kit
   (`releases-ui.e2e.ts`). The publish and the rollback are driven through the real savebar,
   dialog and versions page.
2. **By hand only**, no weekly schedule: before R14 converts the specs written for releases off,
   a scheduled run would only mail the same skips; and no PR label (only ci.yml may start on a
   push or a PR). GitHub offers a `workflow_dispatch` workflow once its file is on the default
   branch, so the first rehearsal runs after this PR merges (it changes nothing while unset).
3. **The specs written for releases off skip; they are not converted.** Converting them is R14's
   "e2e in release mode" (README R14 row); the drill covers the release path end to end, and the
   list is named above so R14 can work through it.
4. **An orphan release (the cron path) does not refresh the maintenance buttons**: its minute
   spends its budget on the purge retries, and the 10-minute reconcile refreshes them from the
   identity anyway.
5. **The placement rule is for the release widgets only**, not U1's rule for every unnamed
   widget: that would put every widget added later onto every arranged dashboard, and change
   dashboards now, with releases off.
6. **A Content Creator's read-only search settings have no History** (no form there; the
   drawer's history is the editors'). Page visibility has none either (outside the owner's
   decision).
7. **The read-back does not count the SEO defaults row**: a missing one is created by its first
   release, unlike the identity's, which the job-applications switch updates in place.
8. **The read-back is `scripts/releases-switch-readback.sql`**, not the plan's
   `scripts/sql/releases-readback.sql`: `scripts/` holds no `sql/` folder, and the name says which
   switch it reads back.

## Tests

Each new rule was run red and green: one rule at a time was reverted in its source (a scripted
mutant: the exact lines of the rule replaced, the file restored byte for byte after), its specs
were run, and the run had to fail; with every source as built the same specs pass (the
baseline: 10 files green). All 29 were red. Unit specs only: the e2e and the workflow are traced
below, not run here.

| # | Rule reverted | Spec that fails (red) |
|---|---|---|
| 1 | The schema's id rule (a singleton names none, an item names one) | `historySingletons.spec.ts` "a history request names no id…"; `releaseVersions.spec.ts` "…refused before any read (422)" |
| 2 | `historyEntityId`: the session's tenant for a tenant-keyed entry | `releaseVersions.spec.ts` "the identity and the SEO defaults name no id…", "restoring a version of the identity reads the session tenant's snapshot" |
| 3 | The drawer's query leaves a singleton's id out | `historySingletons.spec.ts` "the drawer's request and restore body…" |
| 4 | The restore body leaves a singleton's id out | the same |
| 5 | General passes the identity's History | `historySingletons.spec.ts` "General: the identity has it…" |
| 6 | Site wide passes the defaults' History | `historySingletons.spec.ts` "SEO › Site wide: the defaults have it…" |
| 7 | SeoPanel reads the row's id from the load and every save (`onRow`) | `historySingletons.spec.ts` "a page's search settings: History once the row exists…" |
| 8 | No entity-SEO History before a row exists | `historySingletons.spec.ts` "a page with no search settings saved yet has no History" |
| 9 | `snapshotNeeds` owes the buttons for an identity contact change | `releaseAfterEffects.spec.ts` "owed only when…", "a publish that changed the identity refreshes the buttons…"; `releasePublish.spec.ts` the all-types count |
| 10 | Unknown items owe the buttons too | `releaseAfterEffects.spec.ts` "a redirect, a visibility row, a page renamed or removed…" |
| 11 | Only the brand, e-mail or WhatsApp number owe them (not the tagline, not key order) | `releaseAfterEffects.spec.ts` "owed only when…" |
| 12 | `rebuildSnapshots` refreshes them | `releaseAfterEffects.spec.ts` "maintenance on…", "items not known…", "a publish that changed the identity…"; `releasePublish.spec.ts` the all-types count and its rollback |
| 13 | `refreshMaintenanceContact` reads the edge first, nothing more while it says off | `releaseAfterEffects.spec.ts` "maintenance off at the edge…"; `generalKit.spec.ts` "the edge off: no row read…" |
| 14 | …and the settings row must say on too | `releaseAfterEffects.spec.ts` "the edge on but the settings row off…"; `generalKit.spec.ts` "a colleague turned it off…" |
| 15 | …with the caller's row when it has one (no identity re-read) | `releaseAfterEffects.spec.ts` "maintenance on…", "a publish that changed the identity…"; `generalKit.spec.ts` "the row's settings with the new buttons…" |
| 16 | The fire's budget, 32 | `releaseFire.spec.ts` "the job declares the worst of the minute's paths, within 50" |
| 17 | The publish card takes its default place in a layout that never named it | `dashboardLayout.spec.ts` "a layout that never named it…", "a short column…", "keeps every widget… off the board" and more; `dashboardWidgets.spec.ts` "a hidden widget reads nothing…" |
| 18 | Only the release widgets are placed (U1's rule for every other) | `dashboardLayout.spec.ts` "the person's own layout wins", "else the role's preset", "a layout that hid it keeps it hidden…" and more |
| 19 | A layout that hid the card keeps it hidden | `dashboardLayout.spec.ts` "a layout that hid it keeps it hidden…" |
| 20 | The admin project never runs the drill | `releasesRehearsal.spec.ts` "unset: every project is main's, field for field…", "the drill is never one of the admin project's specs" |
| 21 | Unset, chromium waits for nothing | `releasesRehearsal.spec.ts` "unset (the required e2e job)…", "unset: every project is main's…" |
| 22 | On, visibility (and so general, GA4, maintenance) waits for the drill | `releasesRehearsal.spec.ts` "on: the switch after the samples…" |
| 23 | The switch goes to a loopback database only | `releasesRehearsal.spec.ts` "goes to a loopback database only" |
| 24 | The switch takes two checked uuids | `releasesRehearsal.spec.ts` "is 0112's owner-only function…" |
| 25 | The workflow runs by hand only | `releasesRehearsal.spec.ts` "runs only by hand…" |
| 26 | The preview runs with `--test-scheduled` | `releasesRehearsal.spec.ts` "is the e2e job step for step…" |
| 27 | The read-back answers one column per expected line | `releasesRunbook.spec.ts` "answers one column per expected line…" |
| 28 | The read-back counts the eight tables the switch converts | `releasesRunbook.spec.ts` "counts the eight tables the switch converts…" |
| 29 | §6p's switch names the fallback scheduler | `releasesRunbook.spec.ts` "runs 0112's switches as the owner…" |

The test "unset: every project is main's, field for field" was added at the finish: the earlier
"unset" test checked the project names and three dependencies only. It now holds every project's
directory, match, ignore list, dependencies, teardown and device to main `42b61c6f`'s, with one
addition (the admin project ignores the drill's file, which would otherwise be one of its specs
and only skip). The workflows are byte for byte main's: `git diff origin/main -- .github/` is the
new file alone.

**The read-back and the switch, in PGlite** (every migration through 0116 and `seed.sql`, a
`publish-scheduled` job and one active Admin standing in): before, every "Expected before" line
holds (`legacy_to_convert` and `left_scheduled` 0 there); `app.enable_releases(tenant, admin,
admin)` answers baseline 1, nothing converted; after, every "Expected after" line holds
(`releases_on` true, `release_tenants` 1, `published_versions`, `baselines` and `live_version` 1,
`enable_audits` 1).

**E2E (CI only, not run here).** `tests/admin/releases-mode.e2e.ts` and the setup were traced
against the routes and the markup they use: the FAQ kernel's staged create (`?staged=1`, the
Worker's id) and staged PATCH (`staged: true`), `GET /api/admin/releases/pending` (`draftId`,
`draftVersion`, `entityId`, `scheduled`), `POST /api/admin/releases` with `scheduleAt` (2 minutes
at least; the answer's `release.id`), `GET /api/admin/releases` (`live`, published `versions` only,
a scheduled one in `upcoming` until it fires), the history answer (`enabled`, `restorable`,
`versions[0].live`, `release.number`); the savebar (`region` "Unpublished changes", mounted
`client:idle`, hence the 15-second wait), the dialog ("Publish to the website", "Publish 1
change"), the toasts in `#admin-toasts`, Backups & versions (the lists "Scheduled and failed
releases" and "Published versions", "Restore vN" with its hidden number, the native confirm's
"Restore vN?" and "Publish vN again?", the restore's open changes read again from the server
after a reload, the flash "Published. The website now shows the restored version.", "Restored
vN"), `/contact`'s `.faq-item__t` (50 questions at most) and the publish card's first `dd`. The
switch runs as `postgres`, the owner of 0112's functions on the local stack, which the function
admits (no role claim, no `SET ROLE`). It has not run yet: GitHub offers a `workflow_dispatch`
workflow only once its file is on the default branch, so the first rehearsal is after the merge,
and any spec it shows to need releases off joins `RELEASES_OFF_ONLY` there.

## Sizes

`npm run build` with the CI dummy environment, then `npm run size`:

- Public route client JS: 26.07 KB of 100.
- The admin bundle sum (the tripwire): **394.76 KB** of 400 (main `42b61c6f`: 394.40, +0.36). Under
  the tripwire, so the owner's raise to 450 KB (decision 2026-10-28) is left to the slice that
  first crosses 400 (E2), and `.size-limit.json` is unchanged.
- Each screen's eager graph (gate 300 KB): the largest are AdminGeneral, AdminSeo, AdminCollection,
  AdminCrmSettings, AdminIntegrations, AdminMaintenance, AdminMediaLibrary and
  AdminNotificationSettings at 208.4 KB (main 208.1); AdminServiceEditor, AdminProjectEditor,
  AdminServices, AdminProjects and AdminDiscipline 204.9 (204.7); AdminPageEditor 199.6 (199.4);
  AdminSingletonForm and AdminResourceForm 189.1 (188.9); AdminDashboard 147.6 (147.5);
  AdminVersions 149.4 (149.2); AdminChrome 144.4 (144.3). Every entry moved by 0.1 to 0.3 KB
  (the shared history target and EditorForm's `historyOf`); the drawer stays in its lazy
  `admin-history` chunk. `admin-rich` (lazy) 122.7 KB; the chunk plan holds.
