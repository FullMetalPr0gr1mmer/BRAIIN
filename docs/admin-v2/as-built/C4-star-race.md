# C4 star race: a late answer no longer undoes a star

- **Lane:** CRM (a fix after C4b and C4c; found in R13's e2e investigation)
- **Design:** [crm.md](../crm.md) §11 "UI contract" items 1 and 3 (the list's star, a lead's
  page). No design change: the screens already promise that a pressed star stays pressed.
- **PR:** the `fix/leads-star-race` branch, from `main` at `42b61c6f`.
- **Migration:** none.

## The problem

On the leads list a list read (a search, a filter, a page) that leaves before a star press can
answer after the star's write is saved. Its rows were read before the star, so the island's
`setRows(answer)` drew the star off again while the database had it on, until the next reload.
R13's e2e met it (the search answer replaced the rows after the star was saved) and now waits
for the search before pressing the star; the product itself was not fixed.

## Plan

1. **A small pure model, `src/lib/crm/lateAnswers.ts`**, so the rule is unit-tested without a
   DOM (the repo renders islands with `react-dom/server` only):
   - `RowToggles` for the list: every read takes a stamp from one clock as it leaves; every
     toggle (the star today; any later row toggle by field name) records the value shown and
     the value the server is known to hold. When a list answer arrives, every toggle whose
     writes had not all answered before that read left is laid over the answer's row; a toggle
     whose writes all answered before the read left is dropped (the answer already holds it).
     An answer from a read older than one already used is dropped whole. A failed write puts
     back what the server is known to hold, and only once no other write of that field is out.
   - `AnswerOrder` for a lead's page, which is not optimistic (it shows each write's answer):
     an answer (a read or a write's row) is used only if no write answered after it was sent.
     So the mark-read PATCH sent on opening, or the refetch after "Log contact", can no longer
     answer last and undo a star or a stage move saved meanwhile.
2. **`LeadsList.tsx`** routes its list answers and its star through `RowToggles`.
3. **`LeadDetail.tsx`** routes the mark-read answer, `write()` and `refetch()` through
   `AnswerOrder`.
4. **The board (`LeadsBoard.tsx`)** checked for the same pattern: see "The board" below.
5. **Tests:** `tests/lib/lateAnswers.spec.ts` (the model, each race in both orders, and a
   source guard that the two islands use it), and an e2e step in `tests/admin/leads.e2e.ts` that
   holds the search's answer (read on the server first, delivered after the star is saved) and
   checks the star stays pressed.

## PII

Nothing new reaches a row: the model only copies a field the island already set on its own
row (`is_starred`) over the same safe row shape (`LEAD_LIST_FIELDS`). No contact detail,
budget or note is read or held.
