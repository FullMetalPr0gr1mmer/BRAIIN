# R3a: staged writes in the database and the resource kernel (behind the release flag)

- **Lane:** Releases (Wave 3, batch B1; the first Wave 3 PR)
- **Design:** [releases.md](../releases.md) §2.8, §3 (the write path), §4.5, §4.8, §8 edge cases
  2, 13, 16, 17, 19 to 21, slice R3; the README's Track REL, P-2, P-3, P-5, P-13 to P-15;
  [verification.md](../verification.md) claims 7 and 8. The R3 brief splits the slice in two:
  this is R3a (the database and the resource kernel). R3b (singletons, entity SEO, the intake
  switch and the draft endpoints, no migration) is a later PR.
- **Migration:** 0062 (`0062_release_drafts_write.sql`), expand, the Wave 3 reservation; not
  applied to production yet.

## What was built

Releases stay off for every tenant (`app.release_tenants` is empty until R14), so nothing a
person does changes: with the flag off every route takes the legacy path it took before, and
the new policies refuse every staff draft insert and update even through PostgREST directly.

### The database (0062)

- **Grants.** `content_drafts`: staff (`authenticated`) and the service role hold SELECT,
  INSERT, UPDATE and DELETE; anon and PUBLIC nothing; no TRUNCATE, REFERENCES, TRIGGER or
  MAINTAIN for anyone; no column grant. Stated after a `revoke all` (P-14, both regimes).
- **Three RESTRICTIVE policies, to `authenticated`, the tenant predicate first.**
  `content_drafts_live_insert`: a live profile (`(select app.live_role()) is not null`),
  releases on (`public.releases_enabled(tenant_id)`) and a singleton keyed by its tenant
  (`app.draft_key_ok`). `content_drafts_live_update`: the same (the key in WITH CHECK only).
  `content_drafts_live_delete`: the live check alone, so a discard works whatever the flag
  (D2; edge case 21). 0038's permissive policies still say who stages what. The service role
  (apply, schedule) is not bound; the migration role and seeds bypass RLS.
- **`public.releases_enabled(p_tenant)`**: SECURITY DEFINER over `app.releases_enabled`,
  false for any tenant but the caller's, EXECUTE for `authenticated` only (R1's open item).
- **`app.draft_key_ok(type, entity, tenant)`**: invoker, reads the registry under the
  caller's RLS (staff only); an unknown type is false (R1's open item, D13).
- **`public.write_drafts(p_tenant, p_ops)`**, the one draft writer (D3): SECURITY INVOKER,
  `search_path ''`, EXECUTE for `authenticated` only, never sets a GUC. 1 to 200 changes, each
  a `put` (new, or an edit at `expected_version`) or a `discard` at a version; every shape is
  checked before anything is written (22023); the changes run in (entity type, entity,
  draft) order; a duplicate draft or a moved or missing one is `BR409` with
  `{"code":"draft-conflict", …}`, a claimed one `BR409` `scheduled`; a draft that is there as
  named but that RLS refused (a stale token, releases off for an edit, a role that may not
  stage it) is 42501; CHECKs pass through as 23514; any refusal undoes the whole call.
- **Postconditions:** the grant set per role and privilege (MAINTAIN on 17), no column grant,
  RLS forced, the exact seven-policy set, every USING and WITH CHECK led by the tenant
  predicate, each RESTRICTIVE expression read structurally, the draft lock still the only
  trigger, the three functions' kinds, search paths and EXECUTE sets, the flag reader's owner
  bypassing RLS, `app.releases_enabled` still the service role's alone, no `set_config` in the
  writer, and `app.release_tenants` still empty.

### The kernel

- **`src/lib/admin/route.ts`**: `AdminRouteContext.releasesEnabled()`, one
  `rpc('releases_enabled', { p_tenant })` per request, on first call; true only when the
  database says `true`; an error throws (500, logged), never a guess (D4). `mapError` maps the
  new `DraftConflictError` (`src/lib/admin/errors.ts`) to `409 { ok: false, error: code,
  entity, live?, detail? }`, `code` one of `draft-conflict`, `draft-published`,
  `draft-discarded`, `scheduled`, `pending-changed` (`DRAFT_CONFLICT_CODES`).
- **`src/lib/admin/crud.ts`**: `getRowOrNull`.
- **`src/lib/admin/resource.ts`**: one branch per handler (GET list, POST, GET item, PATCH,
  DELETE, reorder): `const entry = stagedEntry(config); if (entry && (await
  ctx.releasesEnabled())) return staged…(…)`. The legacy bodies below are unchanged (R15
  removes them). Only a config whose table is in the registry asks the flag: media and the
  Style-Finder configs never do.
- **`src/lib/release/drafts.ts`** (server only): `loadDraft`, `loadDraftsOf` (newest first, at
  most 1,000, `truncated` beyond, D14), `draftWasPublished` (a release item names the draft,
  D8), `writeDrafts` (the Zod parity check against the SQL caps, then the RPC and its error
  mapping: BR409 → `DraftConflictError`, 23514 → 422, 42501 → 403), `dropFields`,
  `draftLabel`, `draftFields`, `shouldAudit` (D9), `writtenDraft`.
- **`src/lib/release/staged.ts`** (server only): `stagedList`, `stagedRead`, `stagedCreate`,
  `stagedUpdate`, `stagedDelete`, `stagedReorder`, `stagedSelect` (the live read widened to
  `entry.columns ∪ {key, version}`), `stagedEntry`, `stageTransition` (the legacy save's
  status rule, at stage time). Stage time runs `stageTransition` and `assertWritable` over
  live ⊕ patch (D5), never `assertPublishable` (D6); never `persist`, `afterWrite` or
  `afterDelete`.
- **Shapes** (`packages/schemas/release.ts`): `DraftRefFieldsSchema`, `DraftLabelSchema`,
  `WriteDraftsPutSchema`, `WriteDraftsDiscardSchema`, `WriteDraftsOpsSchema`,
  `WriteDraftsResultSchema`, `DraftConflictDetailSchema`, `DRAFT_CONFLICT_CODES`,
  `WRITE_DRAFTS_MAX_OPS` (200), `DRAFT_LABEL_MAX_BYTES` (4096), `DRAFT_LABEL_TEXT_MAX` (200).
- **Activity log** (`src/lib/admin/auditLabels.ts`): `KERNEL_VERBS` gains `draft_save` ("Saved
  unpublished changes to", "Saved an unpublished removal of", "Saved an unpublished new order
  for") and `draft_discard` ("Threw away unpublished changes to"), kind `edits`, titled like
  the kernel's. Details carry the op, column names and counts, never values.

### What each staged handler does

- **POST**: the create schema (the kernel's parse), `stageTransition`, `mergePayload`,
  `derivePatch('create')` (no `published_at`; a schedule is 422 "Schedule the release
  instead"), `assertWritable`, then a `put` op `create` under `crypto.randomUUID()` (a client's
  `id` never reaches it), base `{}`. Answers the overlaid row (`version: 0`) and its draft meta.
  Audit `<entity>.draft_save` `{op: 'create', fields, status}`.
- **PATCH**: with a draft pending, the save must name it (`draftId` + `draftVersion`), else 409
  `draft-conflict`; a claimed draft is 409 `scheduled`; a pending removal is 409
  `draft-conflict` ("Undo the removal first"); an update draft over a removed row is 409
  ("Discard the change"). With no draft and a ref sent: 409 `draft-published` (a release item
  names it) or `draft-discarded`, each with the live row. With neither: `version` against live
  (409 `conflict`, as today), 404 when there is no row. Then merge, derive, drop what equals
  live and the base (an emptied change is discarded, audit `draft_discard` `{reason:
  'no-op'}`), `assertWritable`, record the base, one `put`. Audit `draft_save` `{op, fields}`,
  coalesced.
- **DELETE**: the gate is unchanged (`deleteCap` and the write cap). A pending create is
  discarded; a live row gets a `put` op `delete` (payload and base `{}`), replacing a pending
  edit (D11; the audit row names the fields it threw away); `?draftVersion=` is checked when
  sent; a pending removal answers as it stands.
- **Reorder**: one `write_drafts` call for every moved row (≤ 200, one subrequest); positions
  equal to live and base are dropped (a sort-only draft moved back is discarded); pending
  removals keep their place; one audit row `{op: 'reorder', count}`.
- **GET item / GET list**: `overlayRow` / `overlayList` over the live read and the entity
  type's drafts; the list answers `{rows, total, limit, offset, draftsInvalid,
  draftsTruncated}`. Relation pickers read the same GET, so they overlay too.

## Registry entries a kernel factory does not serve

Every kernel-served registry entry stages automatically (`tests/lib/stagedSelect.spec.ts` holds
that every kernel config on a registry table stages through its own entry). These do not, and
stay live writes until their slice:

- `site_profile`, `seo_defaults` (`singletonRoutes`) and `entity_seo`
  (`src/pages/api/admin/entity-seo.ts`): R3b.
- `page_visibility` (U14a, 0057): `src/pages/api/admin/page-visibility/index.ts` and the alias
  `PATCH /api/admin/pages/visibility/[id]` stay immediate (the brief's scope; U14a's as-built
  calls the row "immediate until R14"). R5's guard and R14's static write-path test close it.

## Departures from the design, each with its reason

1. **PATCH parses its body in the handler.** The kernel's input for PATCH is `z.unknown()`;
   the handler parses `config.updateSchema` itself when releases are off (the same schema, the
   same 422 body), or `DraftRefFieldsSchema` plus the update schema when they are on. The
   flag is known only inside the handler, and the update schemas strip unknown keys, so a
   kernel-level parse would have dropped `draftId` and `draftVersion` before the staged branch
   saw them. A bad body now costs one flag read before its 422.
2. **A draft-named save needs no live version.** With `draftId` + `draftVersion` sent and
   `version` missing or 0 (a pending create has no live version), the draft's version stands
   in for the schema's required one; it is never compared with anything.
3. **The stored payload loses keys whose columns all left the patch, and the patch is
   re-derived** (`dropFields`). Otherwise a key equal to live would stay in the payload, its
   column would reappear in the patch at publish with no base, and R4 would refuse it as
   `base-missing`. The base is likewise trimmed to the columns the change still writes.
4. **Reorder reads the whole allowlist only when a moved row has a draft.** The brief reads
   `id,sort_order,version`; a draft's base must then be read over the allowlist (`recordBase`
   reads `live[column] ?? null`), so the select widens exactly when it can matter.
5. **A reorder that names a claimed draft is 409 `scheduled` as a whole** (all or nothing, one
   writer call), rather than skipping that row.
6. **GET item answers a removed-under-its-change row and an unreadable draft.** An update
   draft whose live row is gone answers `{id, version: null, draft: {liveMissing: true}}`
   rather than 404, so the editor can discard it; a draft whose payload no longer parses
   answers live with `draft.invalid: true`.
7. **DELETE answers `{deleted, pendingRemoval: true, draft}`** for a staged removal and
   `{deleted, draft: null}` for a discarded create (R12 decides what the form does with them).
8. **`write_drafts` tells a refused draft from a moved one.** After an edit or discard that
   touched no row it looks the draft up: claimed is `scheduled`, there at the named version is
   42501 (RLS refused it), otherwise `draft-conflict`. A discard may also name its entity
   (optional `entity_type`/`entity_id`), used for the lock order and matched when given.
9. **Activity words by op.** `draft_save` reads "Saved an unpublished removal of" and "Saved
   an unpublished new order for" for those ops; the brief had one sentence for all.
10. **`tests/lib/releaseOffWrites.spec.ts` is untouched.** Its routes (site profile, SEO
    defaults, entity SEO) never read the flag in R3a; R3b gives its stub an `rpc`. Its snapshot
    does not change.
11. **Four specs' fake clients gained an `rpc`** that answers the flag as off
    (`adminKernel`, `contentResources`, `serviceResources`, `redirectResource`): the
    kernel now asks the flag on every release-managed route. Their assertions are unchanged.
12. **The status rule also judges the merged pending change** (PATCH and reorder), not only
    the request: a Content Creator's title edit to an item an Admin staged for archiving would
    re-save that archive, so it is 403 `content.archiveDelete` in the Worker, as RLS (0038's
    archive term) would refuse it anyway. Found in the self-review; the legacy save checks only
    the request because there is nothing pending to inherit.
13. **`grants_app_schema.test.sql` gains rows, not an allowlist entry.** Its exhaustive
    allowlist is anon's; `app.draft_key_ok` is not anon's, so it gets its own rows (section
    13, with the two public functions).

## Proof

- **pgTAP**: `supabase/tests/release_drafts.test.sql` `plan(81)`, new: the catalog, the grant
  and policy sets, releases off per role (insert and edit refused, directly and through the
  writer; discard allowed for the author roles), releases on per area and role (content,
  identity and themes, SEO meta, SEO defaults and redirects; removals; archives), a `sales`
  claim, anon, another tenant, three stale Admin tokens (demoted, deactivated, locked: no
  insert, edit or discard), the singleton key (insert and re-key refused), and the writer's
  outcomes (new, edit, discard, BR409 codes, all or nothing, another tenant, malformed calls,
  RLS and CHECK pass-through, the fixed order, the lock binding).
  `rls_releases.test.sql` stays `plan(111)`: section 0 now proves R3's grant exists and that
  nothing is written while releases are off; the fixtures gain live profiles for every staff
  claim; the flag goes on at the end of section 0 instead of in section 9.
  `grants_app_schema.test.sql` `plan(61)` → `plan(63)`. The three files and
  `release_apply.test.sql` pass on the PGlite replay; CI is the authority.
- **Vitest**: `tests/lib/stagedKernel.spec.ts` (the real route factories over an in-memory
  PostgREST with `write_drafts` emulated: releases off call for call with `content_drafts`
  untouched and `persist`/`afterWrite`/`afterDelete` still running; releases on for every
  handler; the flag error; media and Style-Finder never asking), `tests/lib/stagedSelect.spec.ts`,
  `tests/schemas/release.spec.ts` (the new shapes, equal to 0062 and 0038's label cap),
  `tests/lib/auditLabels.spec.ts`, and `tests/authz/cases/releases.ts`: flag-on twins of
  services create, publish, archive, delete and reorder, testimonials publish, clients clear
  for disclosure and categories delete, each with its flag-off allow set.
- **No capability, no `app.role_*` helper, no registry row, no screen, no help guide**:
  `ROLE_CAPS`, §5, architecture §3.4 and §9.3 are unchanged; the admin bundle is unchanged (no
  client file changed).

## Deploying

Expand, so the push comes first (rule 5): the Worker reads `public.releases_enabled` on every
release-managed admin route, read or write, so a Worker running this code against a database
without 0062 would answer 500 there. The deploy guard (#41) refuses that order. Each such
request costs one more subrequest (the flag read): a staged PATCH costs flag + live + draft +
write + audit, about today's plus one (P-15).

## Open

- **R3b**: the staged singletons and entity SEO, `PATCH /api/admin/site-profile/intake`, the
  draft endpoints (pending, discard one / mine / selected, resolve), their audit words and
  authz rows; `releaseOffWrites.spec.ts`'s stub gains `rpc` then.
- **R6**: `OverlayDb` for `assertWritable`/`assertPublishable`, so a link to a pending create or
  a redirect over a pending slug is not refused at stage time (D5).
- **R12**: the client sends `draftId` + `draftVersion` (`saveModeFor` still answers `live`); until
  then, a second save of a drafted item from today's forms is a 409. Harmless while releases
  are off.
- **O-16**: measure a staged list GET with many drafts and a 200-row staged reorder on staging
  before R14.
