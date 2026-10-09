# C2a: reading the pipeline

- **Lane:** CRM
- **Design:** [crm.md](../crm.md) CRM-2, the read side's list, board, KPIs and people directory
- **PR:** #47, folded into #45 (merged as `aa7cf76` on 2026-10-08)
- **Migrations:** 0036 (`0036_crm_leads_queries.sql`; the design's file was 0031, a number
  taken since), expand

## Departures from the design, and why

- **CRM-2 is two slices.** C2a is the pipeline read side (0036); C2b is one lead (reveal,
  notes, timeline), with no migration.
- **The readers.** `public.leads_list`, `leads_board` and `lead_summary` are SECURITY INVOKER,
  so RLS, the live check and the column grants decide what they return; one allow-listed,
  bounded filter (`app.lead_filter`, 22023 otherwise); safe columns only. All three take
  `p_tenant`, like `crm_people`, and find nothing unless it is the token's tenant, so the
  endpoint matrix's "scopes its reads" check covers these POST reads too (a review fix).
  `leads_list` answers `{total, rows}`, the total counted apart from the page, so a page past
  the end is empty with the right total.
- **Search.** `leads.search_text` is a generated column (the normalised name, company and the
  start of the message) with a trigram index, folded with `app.normalize_ar_q` (the step that
  also maps ة to ه, CLAUDE.md §8) on both sides; `%` and `_` in a query are characters, not
  wildcards. A whole e-mail or phone becomes a blind-index lookup in the Worker
  (`src/lib/crm/leadQuery.ts`) through the definer `app.leads_with_contact`, so the address
  never reaches the database, its logs or a URL; the routes are POSTs. `app.lead_filter`
  refuses a query holding an `@` or a phone-shaped run of 7 or more digits (22023), a second
  layer behind the Worker, which answers 422 for a term that looks like an address or number
  but cannot be read as one.
- **`public.crm_people(p_tenant)`**: the active lead workers, names and roles only, SECURITY
  DEFINER because a lead worker's own token reads no other profile.
- **Routes.** POST `/api/admin/leads/{query,board,summary}` and GET
  `/api/admin/crm/{stages,people}`, all `leads.manage`; responses are cut to the safe fields
  again in the Worker.
- **Not built:** the design's `lead_neighbours` RPC and its `/[id]/neighbours` route. The
  dashboard and sidebar lead counts still count `status = 'new'`, where the design moves them
  to the initial stage and not spam.
- **Tests.** pgTAP `crm_queries.test.sql` (every reader and both definers over the four staff
  roles, anon, another tenant and stale tokens; the ة/ه fold both ways; a page past the end;
  the refused address and number; the date range and sort), `leadsQuery.spec` (blind-index
  search, safe fields, 422s) and endpoint matrix rows.
