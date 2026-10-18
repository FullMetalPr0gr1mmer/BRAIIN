# R3b: staged singletons and entity SEO, the intake switch, the draft endpoints

- **Lane:** Releases (Wave 3, batch B2; the second half of R3)
- **Design:** [releases.md](../releases.md) §1.2, §3 (the write path: singletons, entity SEO,
  the draft endpoints), §4.5 (conflicts), §4.8 (discard), §8 edge cases 20 and 21, slice R3;
  the README's Track REL, P-3, P-5, P-15. The R3 brief splits the slice in two: R3a (0062, the
  database and the resource kernel, [R3a.md](R3a.md)) and this PR.
- **Migration:** none. Everything here runs on R3a's 0062 (`public.releases_enabled`,
  `public.write_drafts`, the RESTRICTIVE `content_drafts_live_*` policies, `app.draft_key_ok`).

## What was built

Releases stay off for every tenant (`app.release_tenants` is empty until R14), so nothing a
person does changes, with one exception that is the point: the job-application switch has its
own endpoint now, which works the same with releases on or off.

### The staged singletons (`src/lib/release/stagedSingleton.ts`)

`singletonRoutes` (`src/lib/admin/singleton.ts`) gains one line at the top of GET and PATCH:
`const entry = singletonEntry(config); if (entry && (await ctx.releasesEnabled())) return
stagedSingleton…(…)`. Only `site_profile` and `seo_defaults` are in the registry;
`site_settings`, `site_integrations` and `ai_config` never ask the flag (tested).

- **GET:** live (the editor's columns, the guard's, the immediate ones and the registry's
  allowlist) and the tenant's pending change (`entity_id` = the tenant) laid over it. No row and
  no change: the defaults at version 0, as today, with `draft: null`. A pending create: the
  defaults with the change over them, version 0. A change whose payload no longer reads: live,
  `draft.invalid: true`.
- **PATCH:** the body is the config's schema plus `draftId`/`draftVersion` (both or neither).
  `guardWrite` runs first on the whole save (`toRow` of everything sent), so a Developer opening
  applications is 403 staged or not. Then the immediate columns: a save that would change
  `accepting_applications` is 422 on `acceptingApplications` ("Opening or closing job
  applications happens at once. Use the Job applications switch."); one that sends it unchanged
  (the settings form always does) is let through, and the switch never enters the payload
  (`mergePayload` drops it). The rest follows R3a's PATCH: a pending change must be named (409
  `draft-conflict`), a claimed one is 409 `scheduled`, a vanished one 409 `draft-published` or
  `draft-discarded` with the live row; with none, `version` against live (409 `conflict`). No
  row yet: a pending create over the config's defaults, keyed by the tenant (0062's
  `app.draft_key_ok` refuses any other key). A save equal to live is dropped (an existing change
  is thrown away, audit `<entity>.draft_discard` `{reason: 'no-op'}`); otherwise the base is
  recorded once per column from live and one `write_drafts` call stores the change. Audit
  `site_profile.draft_save` / `seo_defaults.draft_save` `{op, fields}`, coalesced (P-5).

### Staged entity SEO (`src/lib/release/stagedEntitySeo.ts`)

`/api/admin/entity-seo` keeps its legacy bodies; one line at the top of each handler stages
instead when releases are on.

- **GET** by target: live, then its pending change by the SEO row's id, or, with no row, the
  pending create whose payload names the target (`payload->>entityType`, `payload->>entityId`,
  0038's `content_drafts_one_seo_create`). Overlay as for a resource.
- **PUT:** `assertBilingual` as today; the payload is the save itself (a full replace, never
  merged with the previous change) and always carries `entityType` and `entityId`, so the
  publish (R4) can check the target on an edit too. No row: a pending create under a
  Worker-allocated id (a client `id` is ignored); a second create for one target is refused by
  the database (BR409 → 409 `draft-conflict`). A row: the change writes all six meta columns,
  with a base for each, and `fields` names only those that differ from live (the pending list).
  Audit `entity_seo.draft_save` `{op, fields, target}` under the target's id, as the legacy
  `entity_seo.update` row is, so the activity log titles the service or post.

### The intake switch (`PATCH /api/admin/site-profile/intake`)

Immediate whatever the flag (decision D7), so U9a's General screen can wire its switch to it.
Kernel `applications.manage` (Admin only) plus `assertCap('settings.general')` in the handler,
`guardWrite` (the Worker layer) and the 0019 trigger (the database layer; 42501 → 403). Body
`{acceptingApplications: boolean}`, strict. It reads `version, accepting_applications`; an
unchanged switch writes nothing and audits nothing; otherwise it updates that one column, or,
with no row yet, inserts the defaults with the switch (a racing insert is 409). Audit
`site_profile.intake` `{open}`. It never reads the flag and never touches `content_drafts`. The
legacy `PATCH /api/admin/site-profile` still writes the switch while releases are off.

### The draft endpoints (`src/lib/release/draftEndpoints.ts`, thin routes)

Each route admits any role holding a capability that stages something (`STAGE_ANY_CAP`, the
union of every type's author capabilities) or, for the summary, reads something
(`PENDING_ANY_CAP`, every type's read capabilities at full, view or meta): all four CMS roles.
Then each draft is checked against its own type, and every write goes through
`public.write_drafts`, so RLS, the live check and the draft lock decide again.

- **`GET /api/admin/releases/pending`:** the drafts of the types the caller may read, newest
  first, at most 1,000 (`truncated` beyond). Stored metadata only (`status:payload->>status`,
  never the payload). Per item `draftId, draftVersion, entityType, entityId, op, area, label,
  fields, updatedBy, updatedByName, updatedAt, scheduled, mine, publishableByMe, requiredCaps,
  waitingFor` (`PendingItemSchema`), counted `byArea` (`total`, `publishableByMe`, `waiting`,
  `mine`). Names come from `public.staff_directory(p_tenant)`; if it fails the list still
  answers, unnamed.
- **`DELETE /api/admin/drafts/[id]?version=n`:** the type's author capabilities (equal to
  `app.can_author`, 0038's delete policy), else 403 naming the draft; a claimed draft is 409
  `scheduled`, a moved version 409 `draft-conflict`, no version 422, an unknown or malformed id
  404. Works with releases off (D2, edge case 21). Audit `<type>.draft_discard` `{op, fields}`.
- **`POST /api/admin/drafts/discard`:** `{scope: 'mine'}`: my unclaimed drafts of the types I
  may stage, oldest first, at most 200 per request (`more: true` when others remain).
  `{items: [{draftId, draftVersion}]}` (1 to 200, distinct): all or nothing, a type I may not
  stage is 403 naming those drafts, then any gone, moved or claimed one is 409
  `pending-changed` listing them; one writer call. Audit one `drafts.discard_bulk` `{count,
  scope, types, draftIds}`.
- **`POST /api/admin/drafts/[id]/resolve`:** `{version, keepMine, useLive}` (column names in the
  `content_drafts` pattern, disjoint, at least one; `ResolveRequestSchema`). What publishing the
  change needs (`requiredCaps`: an archive needs `content.archiveDelete`, as the update
  policy's archive term), else 403 naming the draft and the missing capability. Every named
  column must be in the change's patch (422). "Keep mine": `base[col] = live[col]`. "Use the
  live version": the payload key that writes the column is dropped whole, with its base entries
  (entity SEO, a full replace, takes the live value instead). A change left writing nothing is
  thrown away. One writer call; audit `<type>.draft_resolve` `{keepMine, useLive}` (column
  names). The row gone under the change: 409 `draft-conflict` "This item was removed on the
  live site. Discard the change."

### Shapes and words

- `packages/schemas/release.ts`: `DiscardRequestSchema`, `ResolveRequestSchema`,
  `IntakeRequestSchema`, `PendingItemSchema`.
- `src/lib/admin/auditLabels.ts`: `drafts.discard_bulk` ("Threw away several unpublished
  changes", edits), `site_profile.intake` ("Opened job applications" / "Closed job
  applications", settings), and for every release-managed type `draft_resolve` ("Settled a
  conflict on") plus the `draft_save` / `draft_discard` words the kernel's map did not already
  give (the singletons, entity SEO, page visibility). Entity SEO's pending-change rows are
  titled by their target, as its save is.

## Registry entries and their routes

Every registry entry now stages through a kernel factory (R3a), the singleton kernel or the
entity-SEO route, except `page_visibility` (U14a, 0057): `PATCH
/api/admin/page-visibility` and the alias `PATCH /api/admin/pages/visibility/[id]` stay
immediate, as R3a's as-built says, until R5's guard and R14's static write-path test close
it. The draft endpoints handle a `page_visibility` draft like any other (its author
capability is `maintenance.manage`).

## Departures from the design, each with its reason

1. **The singleton PATCH and the entity-SEO PUT parse their body in the handler** (the kernel's
   input is `z.unknown()`), as R3a did for the resource PATCH: the schemas strip unknown keys,
   so a kernel parse would have dropped `draftId`/`draftVersion`. The same schema gives the
   same 422 body. All five singletons share the factory, so the three outside the registry
   parse in the handler too, with no flag read; for site profile, SEO defaults and entity SEO a
   bad body now costs one flag read before its 422.
2. **A first save with no row accepts version 0 or 1**, not only 0 (the brief): the legacy
   first save's rule (`singletonFirstSave.spec.ts`), so a form behaves the same staged or not.
3. **A pending create that a row has since appeared under is read and saved as an edit of
   that row.** With releases on and no identity row, a staged first save is a create; if an
   Admin then opens applications, the intake endpoint inserts the row. GET then overlays the
   change on that row and the next save rewrites it as an update with a base from live. Until
   it is re-saved its op is still `create`: R6's dry run must report (or convert) it, since the
   apply would meet an existing row. A tenant that already has its identity row never meets
   this.
4. **Entity SEO's pending change is a full replace**: never merged with the previous change, it
   writes all six meta columns and records a base for each (R4 needs a base for every column it
   writes); `fields` (display) lists only the ones that differ from live. A pending create whose
   target gained a live row by another path is not looked up once the row exists (R6's dry run
   reports it).
5. **Per-item checks use the registry's author capabilities**, not each config's `writeCap`
   alone (the brief): for a discard every capability in `authorCaps` at full, which is
   `app.can_author`'s rule; for a resolve what publishing the change needs (`requiredCaps`),
   because the update policy refuses a non-Admin's archive. With today's `ROLE_CAPS` the
   discard sets are identical to the brief's.
6. **The draft endpoints' 403 and 409 name drafts** (`draftIds`) through a response the handler
   returns, not through the kernel's `mapError`, so `route.ts` is untouched. A bulk discard
   whose write meets a moved draft between the read and the write is 409 `pending-changed`
   listing every draft of the call (the writer does not say which).
7. **"Discard mine" does at most 200 drafts per request** (`more: true` beyond): one
   `write_drafts` call is one subrequest and holds at most 200 changes.
8. **Resolve refuses what it cannot settle with a 422**: a pending create or removal (nothing
   to conflict with), a payload that no longer parses, and releases switched off ("Publishing is
   switched off: this change can only be thrown away."), rather than the bare 403 the database
   would answer. That last costs one flag read.
9. **The intake endpoint writes nothing when the switch is already as asked**, including
   closing it on a tenant with no row (the default is closed), and audits only a change.
10. **`draft_resolve` is not a kernel verb.** `KERNEL_VERBS` is held to the verbs
    `resource.ts` and `staged.ts` write; the draft endpoints write theirs, so the words live
    in a separate map over every registry type.

## Proof

- `tests/lib/stagedSingleton.spec.ts`: GET and PATCH for both singletons over the PostgREST
  stand-in (first save keyed by the tenant, a second save naming the change, the base from the
  whole allowlist and never overwritten, no-op drops, claimed / published / discarded, the row
  appearing under a pending create, an RLS refusal), the switch (changed 422, unchanged ignored,
  a Developer 403 with releases on and off), the intake endpoint (creates the row, writes only
  the switch, audits only a change, Developer / Content Creator / SEO 403, strict body, the 0019
  trigger's 403, a racing insert's 409; releases on and off, never asking the flag), and the
  other singletons never asking the flag.
- `tests/lib/stagedEntitySeo.spec.ts`: GET by target (live, an edit, a pending create among
  another target's), PUT (a create under a Worker id storing the target, a second create 409,
  the database refusing a racing one, a full replace with every base, a stale version, no-op,
  setting back, Arabic required, Content Creator 403, a vanished change, releases off writing
  live).
- `tests/lib/draftEndpoints.spec.ts`: the summary per role (only readable types,
  `publishableByMe`, `waitingFor`, counts, names, no payload read, the directory down, the
  1,000 cap), discard one (versions, claimed, 403 naming the draft, 404, releases off, entity
  SEO audited by target, RLS refusal), discard mine (only mine, unclaimed and stageable; 200 a
  request) and selected (all or nothing, 403 naming, 409 listing, a race), resolve (keep mine,
  use live by key, a key dropped whole, emptied change thrown away, unknown column, versions,
  row gone, create, releases off, SEO and Content Creator 403 per item, entity SEO).
- `tests/lib/releaseOffWrites.spec.ts`: its stub answers the flag as off; **the snapshot did not
  change**; a new block proves each singleton and entity-SEO route asks the flag once, for the
  caller's tenant, then makes the legacy calls only (no `content_drafts`), treats any answer but
  `true` as off, answers 500 and writes nothing when the flag read fails, and that the GETs
  answer the stored row or the defaults as before.
- `tests/authz/cases/releases.ts`: flag-on twins (site profile write, opening applications,
  SEO defaults write, entity SEO read and write), the intake switch (Admin only, flag on and
  off), the summary (four roles), discard mine (four roles), and per-item rows for a service,
  identity and entity-SEO draft over discard, selected discard and resolve.
- `tests/schemas/release.spec.ts`, `tests/lib/auditLabels.spec.ts`: the new shapes and words.
- The PostgREST stand-in moved from `stagedKernel.spec.ts` to `tests/fixtures/stagedDb.ts`
  (with `tests/fixtures/stagedRoute.ts` to drive a route); it now reads jsonb paths and
  aliases, answers `staff_directory`, refuses an unkeyed singleton draft and a second entity-SEO
  create per target, and can fail a call on demand. `singletonFirstSave.spec.ts` and the
  refusing client in `endpoints.spec.ts` gained an `rpc` that answers the flag as off.
- No capability, no `app.role_*` helper, no registry row, no screen, no help guide, no client
  file: `ROLE_CAPS`, §5, architecture §3.4 and §9.3 are unchanged, and the admin bundle is too.

## Deploying

No migration. The Worker now reads `public.releases_enabled` on the site-profile and
SEO-defaults routes and on `/api/admin/entity-seo` (one more subrequest each), so 0062 must be
in production first; it is. The new routes need nothing else.

## Open

- **R6:** the dry run and the apply meet a singleton `create` draft whose row now exists
  (departure 3) and an entity-SEO create whose target gained a row (departure 4).
- **R12:** the client sends `draftId` + `draftVersion` and calls the draft endpoints; U9a wires
  the General screen's switch to `PATCH /api/admin/site-profile/intake`.
- **O-16:** measure the pending summary with many drafts on staging before R14.
