# C2b: one lead in the CRM

- **Lane:** CRM
- **Design:** [crm.md](../crm.md) CRM-2, the rest of the read side (reveal, notes, timeline)
- **PR:** #48, folded into #45 (merged as `aa7cf76` on 2026-10-08)
- **Migrations:** none (the tables and grants are 0033 to 0035's)

## Departures from the design, and why

- **One reveal path,** `src/lib/crm/reveal.ts`, for the legacy `GET ?pii=1` and the new
  `POST /api/admin/leads/[id]/reveal`: the live recheck, then the limiter (60 an hour per
  person, 300 per tenant, O-9, fail-closed), then the RLS read, then an audit row written
  before anything gated is read, then the gated columns as the service role. The new route
  returns the contact details only, and the `lead.view_pii` row names exactly the fields
  returned.
- **The notes thread's one door,** `GET` and `POST /api/admin/leads/[id]/notes`
  (`leads.pii`): reading writes its audit row first (no row, no notes); a note's author is the
  session's user, never a client field; adding a note writes its timeline event through
  0034's trigger. A demoted, deactivated or locked profile gets a 403 with nothing read or
  written, and a lead RLS hides is a 404 before the audit row.
- **The timeline,** `GET /api/admin/leads/[id]/events`, is read as the caller (RLS and the live
  check), newest first, and pages on the `(at, id)` keyset it orders by (`before` and
  `beforeId`), so events one statement writes at the same instant are never dropped at a page
  boundary.
- **Not built here:** the design's single-lead detail GET (notes for `leads.pii` holders, the
  first events page, `read_at`): the legacy `GET /api/admin/leads/[id]` keeps its shape, and
  there is no `read_at` column yet. The legacy PATCH still accepts `internalNotes`; the
  design's 422 for D4 waits until the leads UI moves to the thread (C4).
- **The daily cron** drops `privileged_ops` rows older than 48 hours (the limits look back one
  hour; the audit log is the record); `docs/retention.md` has the row.
- **LeadsPanel** no longer re-reveals after its own saves, and a save that stood is never
  reported as an error.
- **Tests.** `leadDetailApi.spec` (order, 429, fail-closed audits, author, paging through a
  tie), the legacy reveal spec pinning the limiter in its order, `privilegedOps.spec`
  (60/300/60, the 61st reveal refused), endpoint matrix rows, and a guard that only the notes
  route touches `lead_notes`.
