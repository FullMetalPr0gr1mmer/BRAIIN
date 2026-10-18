# C4b: the leads screens

- **Lane:** CRM (Wave 3, batch B2)
- **Design:** [crm.md](../crm.md) CRM-4, §11 "UI contract" items 1, 3 and 4, its General and
  PII rules, §13; the Wave 3 brief's C4b half (C4 split into C4a, the readers, and C4b, the
  screens); README P-1, P-5, P-10, P-12, P-15; the Wave 3 corrections (rules 1, 4 and 7).
- **PR:** the `feat/c4b-leads-screens` branch (its number is given at review). Built on C4a's
  branch (#79, merged during the build) with U4's branch merged in first, since U4 merges before
  C4b: its 0064 is the help set 0065 restates and its `admin-screens` group sits beside
  `admin-leads`.
- **Migration:** 0065 (`0065_help_leads_v2.sql`), the help set only: `app.help_article_set()`
  restated from U4's 0064 with `working-with-leads` rewritten, and reseeded. Push, then merge.
  The pre-push gate of corrections rule 1 holds: if a newer restatement reaches `main` first,
  re-base with `hs_rebase.py` (0064 → that file) before the push.
- **Split:** the brief's §13 says to carve out C4c (the board) when C4b passes about 3,500
  lines. It did (about 6,000 lines without the migration's copied guides), so the Pipeline board,
  its tab, its CSS, its help line and its tests are C4c, stacked on this branch
  (`feat/c4c-leads-board`, as-built [C4c](C4c.md)).

## What was built

**The list, `/admin/leads`** (`src/pages/admin/leads/index.astro`, the `AdminLeadsList` island,
`screens/leads/LeadsList.tsx`, `LeadsToolbar.tsx`, `LeadsBulkBar.tsx`):
- the head "Leads", its sub-line "12 inquiries. 3 new, 4 unread." (and "in the last 30 days"
  when ranged; `leadsSubline`), Export CSV (`export.csv` holders: a link to the server's
  audited export with the filters on screen, kept in step by the island) and "Add lead
  manually" (hidden until the island is up, decision D9);
- five KPI cards in the React `Kpi` twin: New, In progress, Won with its value in SAR, "Won of
  all leads" (a change in points) and the web form's average first response ("Not enough data
  yet" under five answered leads; a fall reads as good); changes only when a range is set;
- the search (a form: Enter searches, the term is posted in a body, never put in the address;
  the server's "looks like an e-mail address but not a whole one" said under the box);
- chips with counts for the range only (All, each stage, Unread, Spam; decision D13), selects
  with visible labels (discipline, source, "How they reached us" once "Added by hand" is chosen,
  assigned, range, sort, starred first by default);
- the kit's DataTable at 15 a page with the ☆ (a pressed button named "Star {name}", one
  unversioned PATCH, put back with an inline error on a failure), the name as the link with
  "Unread" as words and a dot (not weight alone), interest and discipline, source and stage
  badges, the assignee (or "Nobody", or "Someone no longer on the team"), and the age with "Over
  response time" in words. **No budget column**;
- the bulk bar: Assign to…, Move to stage…, Mark read, Star, Mark as spam (Not spam in the spam
  view); the versioned actions send each row's version; conflicts and missing leads are said
  inline and kept, "Saved, but the activity log could not record it" when `audited` is false,
  a toast only for success, then the list is read again.

The filters live in the address through `src/lib/crm/leadUrl.ts` (an allow-list; never the
search, in either direction). The island keeps it in step with `history.replaceState`. The
address carries only what the toolbar can show: a source the Source select offers (the web
form, "Added by hand") and a channel only with "Added by hand", so a shared link never narrows
the list with nothing on screen to clear it.

"Lead added" and "Lead erased" are said on the page each action lands on: the drawer and the
erase dialog add a one-shot `?done=<key>` (`src/lib/admin/flash.ts`, a closed list of keys), and
the lead's page or the list shows it once and takes it out of the address. A toast fired before
`location.assign` went with the page, unseen.

**A lead, `/admin/leads/[id]`** (`[id].astro`, the `AdminLeadDetail` island, `LeadDetail.tsx`,
`LeadStatusCard.tsx`, `LeadContactCard.tsx`, `LeadNotes.tsx`, `LeadTimeline.tsx`, `MoveTo.tsx`):
- the tab says "Lead"; the h1 is the name, `dir="auto"` (`AdminLayout`'s new `heading` and
  `headingDir`); the sub-line "company · interest · received {date}"; Back, Previous and Next
  as links carrying the list's filters (`public.lead_neighbours` on the server, decision D8),
  a disabled Previous or Next saying why;
- badges (stage, source, Starred, Spam); the message quoted in its own direction and language;
  the details (company, the interest linked to the service editor for `services.write`,
  language, received, "Agreed to be contacted about this inquiry" or "Added by hand", the
  number);
- Contact & budget (`leads.pii`): four masked rows and "Reveal contact details (this access is
  logged)"; the reveal shows the e-mail and phone left to right, the budget band's words and the
  timeline, with Email, Call and WhatsApp links, and "Log contact"; a 429 is said as the hourly
  limit; the values live in the island's state only;
- the Status card: the stage through "Move to…" (decision D11), the assignee, the value in SAR
  (saved on Enter or leaving the box, shown on an open stage past the first or once won), the
  score bar (`data-width` bucket, `data-band`) with "N / 100" and the reasons only after the
  reveal (decision D7), the star as a switch, the tags as chips with Add tag; every write sends
  the version read, and a 409 says "Someone else changed this. Refreshed." and reads the lead
  again;
- the notes thread (`leads.pii`, read and audited on open; "Notes are unavailable right now" on
  a refusal), Add note ("Write something first"), Delete note for `crm.erase` after a confirm;
- the timeline in sentences (`eventSentence`), who did it and when, "Load older";
- More actions → "Erase this lead…" for `crm.erase`, a non-dismissible modal with the reason,
  loaded with `import()` on first use;
- an unread lead is marked read by one PATCH after the island is up (decision D4).

**The add drawer** (`AddLeadDrawer.tsx`, loaded with `import()` when "Add lead manually" is
first pressed): the fields of crm.md §11 item 4 with the services grouped by published
discipline, the form's own checks first (a name, a message, an e-mail or a phone), the API's
422 issues per field with a summary, the phone-only duplicate's matches with Open links and "Add
as someone new" (`createNew`), the hourly limit said inline, then the new lead's page; an e-mail
that wrote before is named there (`?same=` carries ids, never the address). Not
`useEntitySave` (decision D3).

**Server render** (`src/lib/crm/leadPage.ts`): each page reads its first view on the server, as
the caller, for the caller's tenant: the stages, the people (`crm_people`), the published
disciplines and services, the summary (twice when ranged) and page 1 for the list (8 round trips,
9 ranged, on top of the shell); the lead (safe and pipeline columns, `getRow`: a lead the
caller cannot see is a 404 before any other read), its labels, its neighbours, its first 50
events, the service's id for `services.write`, and a `lead.view` audit row for a lead's page
(9). Never a gated column, a note or a score reason. A role without `leads.manage` gets a 403
and `Refused.astro`, having read nothing (the U2 pattern). The list, board and summary reads are
shared with the API routes (`src/lib/crm/leadReads.ts`), so a first view and a later read
answer the same shape.

**Worker:** `LeadPatchSchema` keeps `internalNotes` as a key and refuses it (422, "Notes are a
thread now. Add a note instead.", path `internalNotes`); the route no longer writes the field;
the `lead internal notes (legacy panel, leads.pii)` authz case and its manifest line are gone,
and `leadsWrite.spec` asserts the 422 for admin and developer with no write and no audit.
`AdminApiError` carries the whole answer (`body`), for the 409's matches. The bell's lead item
opens the lead. `LeadsPanel.tsx` and the `AdminLeads` island are deleted.

**The bundle (O-15):** see below.

**The F0 harness extension:** `EDIT_SAMPLES` in `tests/admin/routes.ts` (the leads detail's
POST list, its capability and the route that adds a row), read by `sweepRoutes` and
`sweep.e2e.ts` (a POST with the CSRF header); `tests/admin/samples.setup.ts` in a new
`admin-samples` Playwright project after `admin-setup` adds "Sample lead"
(`sample.lead@example.invalid`) through `POST /api/admin/leads` as the admin when the list is
empty, loopback only (`staffEnv`); `adminRoutes.spec` learns it. `/admin/leads` is a
server-rendered locked screen; two extra sweep views (`?stage=spam`, `?range=30&assigned=none`).

**Help (0065):** `working-with-leads` rewritten in English and Arabic for these screens, four
minutes; its slug, place (70), tags, title, screens and capability unchanged; every other guide
is 0064's byte for byte (`helpCentre.spec` compares; a second test holds each control the guide
names to the code that draws it). The free `sort_order` values were not needed: no guide was
added.

## The ranged KPI comparison (C4a's open question)

Decided: **the same elapsed span one range earlier.** `rangeToInstants` now runs a range from
midnight N-1 days ago (Riyadh) to now, and `previousPeriod` moves a range back by its length in
whole days, so "the last 7 days" at 15:00 on the 17th is compared with midnight on the 4th to
15:00 on the 10th: as long, ending at the same time of day, never overlapping. The alternative,
whole days only, would leave today's leads out of every KPI. Tested in `leadView.spec`
(`rangeToInstants` and `previousPeriod` agree for 7, 30 and 90 days) and `leadKpis.spec`.

## The bundle and O-15

O-15 was decided by the approved plan's default (B6) on 2026-10-18: each admin screen's
**eager** graph, at most 300 KB gz (`scripts/admin-bundle.mjs`), is the gate; the size-limit
sum becomes a coarse 400 KB tripwire (`.size-limit.json`, renamed to say so; the CI step's name
too). CLAUDE.md §2's F4 amendment says so, and deviations.md has a Bundle row.

Groups (`astro.config.mjs`): `admin-leads` (priority 17, between `admin-ui` 20 and
`admin-fields` 15) claims the leads islands and `screens/leads/`; `admin-leads-lazy` (14) claims
`AddLeadDrawer` and `EraseLeadDialog`; `ADMIN_KIT_SHARED` puts `kit/Kpi.tsx` in `admin-ui`,
because the kit gallery and the list both draw it, and in `admin-leads` it made the `AdminKit`
entry import the leads chunk (measured, then fixed). `scripts/admin-bundle.mjs` gains check 6:
only the leads islands and their lazy part import `admin-leads` statically, `admin-leads`
imports neither `admin-fields` nor `admin-leads-lazy` statically, and nothing imports
`admin-leads-lazy` but through `import()`; `admin-leads` and `admin-leads-lazy` join
`OFF_SCREEN_GROUPS`. `adminBundle.spec` tests each with fixtures, and pins the claims.

| (gzip, KB = 1,000 B) | before (C4a + U4) | C4b |
|---|---|---|
| size-limit admin sum | 295.25 (limit 300) | 310.66 (tripwire 400) |
| leads list, eager | 121.9 (`AdminLeads`) | 134.7 (`AdminLeadsList`) |
| a lead's page, eager | none | 134.7 (`AdminLeadDetail`) |
| `admin-leads` | none | 13.6 |
| `admin-leads-lazy` (drawer, erase) | none | 3.0 |
| `admin-ui` | 58.70 | 57.22 (LeadsPanel left, the Kpi joined) |
| `AdminKit`, eager | 162.4 | 161.0 |
| public routes | 25.51 | 25.51 |

## The deployed Worker during the apply window

0065 only restates the guides; no reader, table or grant changes, so the old Worker reads
nothing different. The new Worker needs nothing 0065 adds.

## Departures from the design, and why

1. **The board is C4c** (the size rule above). Until it merges the Leads area has no tabs.
2. **"Move to…" is named "Move to… {name}"**, not "Move {name} to…": the visible words come first
   in the spoken name (WCAG 2.5.3).
3. **Tags are a chip list with Add tag**, not the field kit's tags field (decision D12's
   fallback): a lead's page then never loads `admin-fields`, which check 6 guards.
4. **The refusal reads "Your role does not allow that."** (`Refused.astro`), not crm.md's lock
   copy: one refusal across the admin (U2).
5. **The list's empty state** has two texts: "No leads match / Try another filter or clear the
   search." when anything is filtered, "No leads yet" otherwise.
6. **A lead's page audits its view** (`lead.view`, `via: 'page'`) as `GET /api/admin/leads/[id]`
   does, after the row is read (an unseen lead writes nothing).
7. **The search is a form** (Enter, or Search), not search-as-you-type: a part of an address
   typed on the way to a whole one would be refused on every key (the blind index needs it
   whole).
8. **WhatsApp's link** is the phone's Latin digits (`wa.me/<digits>`), as the prototype builds
   it; a number stored in Arabic-Indic digits gets no usable link (digits are never transformed,
   P-12). Rare for a lead (the form and the drawer take Latin digits from a phone keypad).
9. **The add drawer's sub-line** is the body's first paragraph: the kit's Drawer has no `sub`.
10. **The detail page's sub-line** omits empty parts and has no time (the Details card has the
    date and time).
11. **"Move to…" gives focus back to its button** after a move: the lead's page disables it
    while the move is saved, which dropped focus to the body (WCAG 2.4.3). It never takes focus
    from where the person went meanwhile.

## Notes for later slices

- **C4c** restores the board and its tab and restates the help set again (from 0065).
- **C10a (Sales):** the discipline filter and the service list read `services`/`disciplines` as
  the caller (published only for a non-staff role); `canEditServices` is false for Sales.
- **O-16:** `/admin/leads?range=30` (9 round trips, two summaries) and `/admin/leads/<id>` (9)
  join the staging CPU list; the fallback is to drop the list's server-rendered first page.
- **C14a** removes `GET /api/admin/leads`, `?pii=1` and the legacy status; nothing in the new
  screens calls them (the sweep's leads sample uses the POST list).
- **`?same=` on a lead's page** names earlier leads by the ids in the address (the drawer's answer, never the address itself), read under RLS for their numbers. A crafted link can name any lead the viewer can already see as having "written before"; it reveals nothing new, and a later slice can carry a short-lived token instead if that matters.

## Tests

- Vitest: `leadUrl.spec` (the allow-list, the round trip, never `q`, every body valid for its
  API schema), `leadsScreens.spec` (24: no style, no PII or contact link before the reveal,
  "Unread" and "Over response time" in words, the star's name, the KPIs, the chips, the
  labels, the masked rows, the reasons behind the reveal, the links after it, no storage, the
  drawer's body and checks, "Move to…" focus), `leadPage.spec` (tenant-scoped reads, safe columns, a 404 before
  any audit, the neighbours' filter), `leadView.spec` and `leadKpis.spec` (the comparison,
  `leadsSubline`), `leadsWrite.spec` (the 422), `leadGrants.spec` (the PATCH no longer writes
  `internal_notes`; 0030's grant still names it), `kitParity.spec` (React `Kpi` = `Kpi.astro`),
  `primitives.spec` (`PageHead`'s `heading`), `adminBundle.spec`, `adminStyles.spec`,
  `adminRoutes.spec`, `helpCentre.spec`, `notifications.spec`, `leadDiscipline.spec`.
- pgTAP `supabase/tests/help_leads_v2.test.sql`, `plan(10)`: the set, the guide's place and
  text in both languages, the seed (new tenant, an old text replaced with its version moved
  once, a second seed a no-op), who reads it. Replayed on the PGlite harness: 10 of 10, and
  `help_centre.test.sql` 64 of 64.
- The read-back (`readback_0065.sql` in the program's scratchpad): on the harness it matches but
  for the server version and the guide's version (the harness seeds its tenant after every
  migration, so 1, where production's single tenant reads 2).
- E2E (CI only): `tests/admin/leads.e2e.ts` as admin (the round trip from a real
  `POST /api/contact`, the list, a stale-version conflict, the narrow widths, Previous/Next, the
  reveal and its audit row, a note, a logged call, a stage move and its conflict, the erase, the
  drawer and a phone duplicate) and as Content Creator and SEO (a 403 on both pages and the
  APIs); `help.e2e` follows the new text; the per-role sweep opens the list, its two extra views
  and a lead's page. The admin tests run serially (the round trip reads the shared New-leads
  count the others move), every page they open waits for hydration, and axe also runs with the
  move menu open on a lead's page (`leadsE2e.spec` holds the first two). The sweep's and the
  capture's lead sample is the OLDEST lead, found through one helper (`editRowRequest`), so
  neither opens a lead a parallel test is erasing nor skips the screen on a GET.
