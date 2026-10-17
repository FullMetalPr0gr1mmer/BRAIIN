# C4a: the leads readers v2

- **Lane:** CRM
- **Design:** [crm.md](../crm.md) CRM-4, §9 (the API surface and the KPI definitions), §11 items 1
  to 4 (what the screens need from the read side); the Wave 3 brief splits C4 into C4a (SQL and
  API, no screen change) and C4b (the screens, the `internalNotes` 422, the help guide).
- **PR:** not opened yet (branch `feat/c4a-leads-readers`)
- **Migrations:** 0063 (`0063_crm_leads_readers_v2.sql`), expand only: functions restated or
  added, no table, column, policy or grant change on `leads`. The plan's number was 0062; Wave 3
  moved up one when U14b took 0061 (`w3_corrections.md` §0).

## What was built

- **`app.lead_filter` v2**, dropped and recreated (its `RETURNS TABLE` grows). Every 0036 key
  keeps its meaning. New keys: `assigned` (`'me'`, read in SQL as `auth.uid()` so a client never
  names itself; `'none'`; or a person's uuid, filtered as sent), `starred`, `unread`
  (`read_at is null`), `source` and `channel` (0035's CHECK lists, held equal to
  `packages/schemas/crm.ts` by `tests/lib/crmLeadsReadersSql.spec.ts`) and `discipline` (a slug,
  at most 64). `sort` gains `'starred'`. The board now refuses a stage, a spam flag, a sort and a
  page (22023).
- **`app.leads_matching(p_tenant, p_filter, p_board)`**, SECURITY INVOKER: the one predicate set
  and the one order. It returns `(lead_id, pos)`; `leads_list` pages it, `leads_board` groups it
  and `lead_neighbours` steps through it (decision D14). `'newest'` is 0036's order exactly
  (`created_at desc, id`), so U1's "latest leads" widget does not move.
- **`app.lead_over_sla(...)`**: the one SLA rule, for the list's `over_sla` and the summary's
  `sla_breached`: a web-form lead, not spam, in the initial stage, never answered, older than
  `crm_settings.sla_hours` (read as the caller; 24 when it cannot be read).
- **`public.leads_list`** restated (same signature): rows add `assigned_to`, `value_sar`,
  `is_starred`, `read_at`, `last_contact_at`, `last_contact_channel` and `over_sla`. No tags,
  score reason, index or ciphertext.
- **`public.leads_board`** dropped and recreated: `value_sum numeric` appended last (each stage's
  matching non-spam `value_sar`); cards add `stage_id`, `assigned_to`, `value_sar`, `is_starred`,
  `read_at`.
- **`public.lead_summary`** restated: 0036's keys unchanged, plus `in_progress`, `won_value`,
  `unread`, `starred`, `per_stage` (every stage the caller reads, zeros included),
  `sla_breached`, `web_response_hours` and `web_response_n`. Still a date range only (22023 on
  every list filter, the new ones included).
- **`public.lead_neighbours(p_tenant, p_id, p_filter)`**, new, SECURITY INVOKER:
  `{prev, next}` in the list's order and filter; `prev` is the newer one. A lead the caller cannot
  see, or one the filter leaves out, has neither. No search, contact lookup or page (22023).
  Nothing calls it yet: C4b's detail page reads it on the server (decision D8).
- **Grants (P-14):** every function revoked from PUBLIC, anon, authenticated and service_role,
  then EXECUTE to `authenticated` only. The postconditions check that, invoker-ness, one overload
  each of the dropped functions, the board's result type, `app.leads_with_contact` unchanged, the
  leads columns unchanged, the staff SELECT and UPDATE column sets equal to 0041's, nothing for
  anon or PUBLIC on `leads`/`leads_safe`, and `leads_live` still RESTRICTIVE.
- **Worker:**
  - `packages/schemas/crm.ts`: `LeadQuerySchema` and `LeadBoardQuerySchema` take the new keys,
    `LEAD_SORTS` adds `'starred'`, `LeadNeighboursQuerySchema` (the list's minus `q`, `limit`,
    `offset`), `LeadExportQuerySchema` adds the new filters in a link's string form (never `q`).
  - `src/lib/crm/leadQuery.ts`: `LEAD_LIST_FIELDS` and `LEAD_CARD_FIELDS` grow; `toRpcFilter`
    needs no change (the new keys are one word each and pass as they are).
  - `board.ts` answers `value_sum` per column; `summary.ts` answers the new figures, the
    conversion, and for a whole range the previous period of equal length
    (`src/lib/crm/leadKpis.ts`: `readLeadKpis`, `readPerStage`, `previousPeriod`, `deltaOf`).
  - `GET /api/admin/leads/[id]` (no `?pii=1`) selects `LEAD_WRITE_COLUMNS`: the pipeline columns
    too. The legacy `?pii=1` branch passes `LEGACY_REVEAL_FIELDS`, so its shape is unchanged.
  - `score_signals` joins `GATED_LEAD_COLUMNS` and `PLAIN_GATED_FIELDS`; `POST /reveal` returns
    `score_reasons` (known signals only, in the scoring's order) and its audit row names
    `score_signals` (decision D7). The export's `NOT_EXPORTED` leaves the column out;
    `stripSensitive` drops it too.
  - The export takes `assigned` (`me` is the session's user, `none` is `is null`), `source`,
    `channel`, `starred`, `unread` and `discipline`, as PostgREST filters on every keyset page,
    and names them in its attempt audit row.
  - The sidebar's Leads badge (`src/lib/admin/counters/leads.ts`) counts initial-stage leads that
    are not spam, the dashboard's "New leads waiting" rule (`lead_summary.new`), in one HEAD
    request with the stage embedded through the composite key.
  - `src/lib/crm/leadView.ts` (pure, for the Worker and C4b's islands): `interestOf` (moved from
    `LeadsPanel.tsx`), `sourceLabel`, `sourceTone`, `stageTone`, `scoreBand`, `scoreBucket`,
    `slaLabel`, `eventSentence` with `actorName`, `rangeToInstants` (the Riyadh calendar,
    half-open, with the previous period) and `formatSar` (en-GB, Latin digits).
  - The authz cases `lead query (CRM list)` and `lead pipeline board` send the new keys.

## The deployed Worker during the apply window (rule 5)

0063 is pushed to production before this PR merges, so until the deploy the **old** Worker reads
the new shapes. Every reader it calls was checked by name:

| RPC | Deployed callers and what they read | Why the new shape is safe |
|---|---|---|
| `public.leads_list` (restated, same signature) | `src/pages/api/admin/leads/query.ts` reads `total` and `rows` untyped (`Number(page.total)`, `Array.isArray(page.rows)`) and reduces each row with `pick(row, LEAD_LIST_FIELDS)`; `src/lib/crm/manualLead.ts` reads `rows[].id`, `lead_number`, `name` by name; `src/lib/admin/dashboard/loaders.ts` reads `page['rows']` and six named fields | The new row keys are dropped by `pick` and never read by the other two. The filters the old Worker sends (`stage`, `spam`, `q` or `contact_kind`/`contact_hmac`, `from`, `to`, `sort` in newest/oldest/score, `limit`, `offset`; the dashboard's `{limit: 6, sort: 'newest'}`; the manual add's contact pair, `spam` and `limit`) are all 0036 keys with their 0036 meaning, and `'newest'` is the same order. |
| `public.leads_board` (**dropped and recreated** in the migration's one transaction) | `src/pages/api/admin/leads/board.ts` calls it by name with named arguments (`p_tenant`, `p_filter`), reads `column['stage_id']`, `column['total']`, `column['leads']` by name and reduces cards with `pick(card, LEAD_CARD_FIELDS)` | Same name and signature, so the call resolves to the new function once PostgREST's schema cache reloads (Supabase reloads on DDL). `value_sum` is appended last and never read; the new card keys are dropped by `pick`. The old board schema sends only `q`/contact, `from`, `to` and `per_stage`, none of which the new refusal (stage, spam, sort, limit, offset) touches. The drop and the create commit together: another session sees the old function or the new one, never neither. Re-check `POST /api/admin/leads/board` right after the push (brief risk R3). |
| `public.lead_summary` (restated) | `summary.ts` reads its six counts and `avg_first_response_hours` by name; `loaders.ts` reads `['new']`; `src/lib/admin/stats/leads.ts` reads `['total']` | 0036's keys keep their values (pgTAP compares them on 0036's own fixture, `crm_queries.test.sql`); the new keys are never read. They send `from`/`to` only. |
| `app.lead_filter` (dropped and recreated) | Not called by the Worker; called only from the readers' plpgsql bodies | Recreated with them in the same file. |
| `public.lead_neighbours`, `app.leads_matching`, `app.lead_over_sla` (new) | None | Nothing calls them until C4b. |

So every route the old Worker serves answers byte for byte what it answered before 0063.

## Departures from the design, and why

1. **One matching function for three readers.** The brief asked for the list and the neighbours
   to share one ordering ("factor it into a SQL helper"). `app.leads_matching` does that and the
   board uses it too, so the three readers cannot disagree about which leads a filter matches.
   The board's column order is still 0036's (newest first).
2. **The SLA rule leaves spam out**, and lives in `app.lead_over_sla` for the list and the
   summary alike. The brief's list of conditions did not name spam; crm.md's SLA breach is a KPI,
   where spam is excluded everywhere, and a spam lead "over response time" in the spam view would
   be wrong.
3. **The summary returns `previous`, not ready-made deltas.** With a whole range the route reads
   the previous period and answers its figures (no `per_stage`) and `conversion`; the arithmetic
   is `deltaOf` in `src/lib/crm/leadKpis.ts`, for C4b's Kpi pill. Without a whole range,
   `previous` is null and only one read runs.
4. **The board's SQL accepts `starred` and `unread`** (one filter for all readers), but the
   Worker's `LeadBoardQuerySchema` does not take them: the designed board has no such filter.
5. **The export's discipline filter reads twice** (the discipline's id, then its services), not
   once through an embedded relationship: two plain reads, once per export, with nothing for
   PostgREST to resolve. A service slug that is not `SlugSchema`-shaped is dropped before it is
   put in the `or` filter. On a second keyset page the export sends two `or` parameters, which
   PostgREST ANDs; with the caps (80 and 300 rows, pages of 1,000) a second page comes only
   when the server's row limit is below a page.
6. **`interestOf` moved with a `none` argument.** Its default is "Not given" (P-12, no dash);
   the legacy panel passes its old "—", so the panel is unchanged until C4b deletes it.
7. **`crm_queries.test.sql` changed in two assertions**: the 0036 summary assertions compare the
   answer minus the keys 0063 added, so they still prove 0036's keys keep their values.
8. **The migrations ledger is not edited here.** R3a pastes Wave 3's Reserved table (rule 9);
   when it lands, C4a's row should also name `app.leads_matching` and `app.lead_over_sla`.
9. **Left for C4b, as the brief splits it:** the `LeadPatchSchema` refusal of `internalNotes`
   (422) and the removal of the `lead internal notes (legacy panel, leads.pii)` case, the bell's
   per-lead link, the screens, the bundle group and the help guide.

## Notes for later slices

- **The badge's embed (risk R10).** `lead_stages!inner(is_initial)` goes through the composite
  key `(tenant_id, stage_id)`, the only relation between the two tables (no table links both).
  It cannot be run here; C4b's e2e round trip (badge +1) is the check. If PostgREST refused it,
  the badge would be left out (a failed counter read is dropped), not wrong.
- **Sales (C10a, risk R9).** The discipline filter reads `services` and `disciplines` as the
  caller. Staff read every status; Sales is not staff, so for Sales a lead of an archived
  service would not match its discipline.
- **Search and Previous/Next (D8).** The neighbours follow the URL's filters; a list searched
  by `q` steps through the unsearched filter.

## Tests

- pgTAP `supabase/tests/crm_leads_readers_v2.test.sql`, `plan(101)`: anon (42501 on every
  reader and on `app.leads_matching`), content_creator and seo (nothing), demoted, deactivated
  and locked developers (nothing from any reader), another tenant's admin (nothing of T1's, its
  own lead only), a live developer and admin; every new filter, `'me'` for a caller with no
  leads, a person's uuid that is not the caller, the combinations, the sorts, 0036's keys
  (spam, stage, the manual-add contact lookup, `q`, the page and its total); the refusals; the
  row and card key sets (no gated key); `over_sla` against a one-hour `sla_hours`; the board's
  counts and values with spam left out; the summary's old and new figures and a range; the
  neighbours at both ends, in the middle, under a filter, under the starred sort, in the spam
  view, outside the filter and across tenants, and lead by lead against the list under four
  sorts and two filters; the grants and invoker-ness of all seven functions. Replayed locally on
  the PGlite harness: 101 of 101, and `crm_queries.test.sql` 72 of 72 (mutating the SLA rule or
  the assignee predicate fails seven assertions).
- Vitest: `crmLeadsReadersSql.spec.ts` (the migration's shape), `leadView.spec.ts`,
  `leadKpis.spec.ts`, and `leadsQuery`, `leadDetailApi`, `leadsAdmin`, `leadExport`,
  `leadGrants` (the files that name `score_signals`), `adminShell` (the badge's filters and
  embed) and `leadDiscipline` updated.
- The read-back for production is in the program's scratchpad (`readback_0063.sql`); on the
  harness it matches but for the server version and the ledger rows of 0061 and 0062, which the
  harness does not have.
