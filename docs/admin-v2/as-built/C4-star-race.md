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

A lead's page has the same shape without the optimism: the mark-read PATCH sent on opening,
the reload after "Log contact" or after a 409, and the status card's writes could answer in any
order, and the last to arrive was shown, an older row (the star off, an old version) included.

## The design

Two small rules in `src/lib/crm/lateAnswers.ts` (97 lines, pure, no DOM), one per screen. Their
state is four numbers and one controller (the list) and one promise and a count (a lead's
page): nothing grows with use.

**The list: a row write never overlaps a list read (`ListWrites`).**

- A row write (a star press, any bulk action) aborts the list read in flight, through the
  `AbortController` the read already had, so that read's answer is never used: the island
  checks `writes.current.landed(controller)` before it touches rows, the total or the errors.
- A list read asked for while a row write is out (a filter, a search, a page, the read after a
  bulk action) is held: the table shows busy, and the read leaves once the writes answered.
- Once every row write has answered, success or failure, the list is read once more if a read
  was aborted or held, if an answer came back out of send order, if a write failed, or if a
  bulk action ran. That read is the truth again; nothing is laid over it.
- Until then the screen keeps what it shows: the pressed star stays pressed, a failed one too
  (with "{name} could not be starred."), because the PATCH can fail after its update committed
  (`resolveLeadInterests` runs after the update in `src/pages/api/admin/leads/[id].ts`), so a
  failure proves nothing about what the database holds.
- The bulk bar is a row write like the star. The list owns the bulk POST now (`postBulk`,
  passed to the bar as `post`), so the write is counted and answered in one `try/finally`.
  `bulkDone` no longer asks for a read itself: the rule does, after every write has answered.

**A lead's page: one thing at a time (`Serial`).**

- Every read and write of the row (the mark-read PATCH on opening, the status card's writes,
  the reload after "Log contact") runs one after another. Answers therefore arrive in send
  order, and the newest sent is always the last shown.
- `busy` belongs to the queue: on when the first task is queued, off when the last has settled,
  follow-up reads included. The status card's controls are all `disabled={busy}`, so no
  versioned change can leave with an old version.
- A 409 reads the lead inside the write's own turn (busy until it lands); if that read fails,
  its error is said, so a reload is never dropped silently. Any other failure reads the lead
  again too (the PATCH may have committed), keeping the write's own error on screen.

## Why this design, not the clock and overlay engine

The first version of this fix (head `21d59fb8`) kept a clock and an overlay per toggle: list
answers were patched with the toggles they might predate, a lead's answers were accepted or
dropped by stamps. It was 191 lines with several ordering holes, found by the review and the
independent check:

- **LS-3:** two quick presses whose answers came back out of send order showed the value of
  the last write to *answer*, not the last *sent*, with no re-read; the same after a press on a
  toggle the bulk Star had detached.
- **LS-4:** a failed save was treated as proof nothing was written.
- Review 2 and 5: a bulk Star and a single press still out could lose their order.
- Review 3 and 4: the lead page's re-read could waste reads, or drop the reload after a 409
  silently when its retry budget ran out, leaving an old version on screen.
- Review 6: a dropped answer dropped its error resets too.
- Review 7 and 8: settled toggles piled up in a map until a later read; linear scans.
- Info: a dropped write answer on a lead's page left the old version on screen while `busy`
  was already false, so a quick versioned change got a needless 409.

The review proposed the simpler design (review 10): abort the read in flight on a write and
read once more afterwards. It was taken as proposed. Every hole above disappears because the
rule never decides which of two answers is newer: on the list it never uses an answer that
overlapped a write, and on a lead's page two answers never overlap.

Checked for a concrete case the simpler design gets wrong, two were found and closed inside it:

- **A read that leaves while a write is out.** Aborting only the read already in flight would
  let a filter change made during the star's PATCH answer with rows read before the star was
  saved. So a read asked for while a write is out is held, and made after the writes.
- **A lead's page, "Log contact" during a status write.** "Apply only the newest answer by send
  order" alone would show a reload sent after the star's PATCH, which the server may still run
  before it. Running the reads in the same queue as the writes closes it, and makes the
  newest-by-send-order rule hold by construction instead of by stamps.

## Departures

- **Answers in send order are trusted.** Two presses answered in send order are taken to have
  run in that order, and no read follows; out of order, the list is read again. Answer order is
  not proof of server order, but it is the best signal the screen has short of reading after
  every double click; the cost of the rare miss is the same as before this fix (the screen
  shows the last press until the next read).
- **A failed star stays shown until the read after it lands.** The brief's rule (keep the
  optimistic value until the re-read lands); if that read fails too, the table shows that
  read's error above it, and the star's own error stays.
- **The bulk bar's `onDone` no longer carries the action.** The type finding (review 9: type
  `action` as `LeadBulk['action']`) is moot: with every bulk action treated as a write, the list
  does not need to know which one ran, so the parameter was removed rather than retyped.
- **The read after a race also reads the KPIs.** The list's one reload counter drives both
  reads, as the bulk action already did; one extra summary POST after a race.
- **A lead's page is busy while the mark-read is out on opening** (one PATCH, usually well
  under a second). The status card's controls are disabled for that time; a press waits for
  them to enable, and nothing is lost.
- **"Log contact" itself is not queued** (its POST belongs to the contact card); the reload
  after it is. A versioned change in the moment between the contact's save and that reload
  leaving can still meet a 409, said and refreshed, as on `main`.

## The board

`LeadsBoard.tsx` was checked and left as it is. Its one write, the stage move, is not
optimistic: the card moves when the PATCH answers. A board read that left before the move and
is still out when the move answers is aborted and read again (`reading` ref and `setReload`,
since C4c), the same pattern the list now uses; no toggle on a card writes anything.

## Tests

`tests/lib/lateAnswers.spec.ts`, 24 tests:

- **The list (14):** the R13 order (a read out when the star is pressed is aborted and read
  again after); a single press needs no read; two quick presses in send order (no read) and out
  of send order (one read, LS-3), and a press after that starts clean; a failed save is read
  again (LS-4), and with another press out only once both answered; a bulk action mid-press,
  in both answer orders; a bulk action alone; a press while a bulk is out holds the bulk's read;
  a filter change while a star is out (held, then read once) and while a read is out (the
  newer read used); a press while the read after the writes is out; a read that answered
  before the press is kept.
- **A lead's page (4):** the mark-read and a star (the star leaves only after the mark-read
  answered, answers shown in send order); a 409 (busy until its reload lands, the next change
  leaves with the new version); a failed task does not stop the queue; busy goes off once.
- **The islands (6, source guards):** the list's read comes from the rule and is held while a
  write is out; an answer is used only when its read was not aborted (rows and errors); the star
  is a write (no local roll back); the bulk action is a write posted through the rule and
  `bulkDone` asks for no read itself, the bar has no `adminFetch`; a lead's page queues its read,
  write and mark-read and never sets `busy` itself; a 409 and any failure read again inside the
  write's turn, and a failed reload is said.

**Red/green** (a local script, not committed: each variant applied to the model or the
islands, the spec run, the variant undone):

| Variant | Result |
| --- | --- |
| this branch | 0 failed, 24 passed |
| M1 answer order not checked | 2 failed (LS-3, the press after it) |
| M2 a failure trusted | 4 failed (LS-4, failure while another is out, bulk alone, press during the read after) |
| M3 a read never held | 2 failed (filter change while a star is out, press while a bulk is out) |
| M4 a write aborts nothing | 3 failed (R13 order, bulk mid-press, press during the read after) |
| M5 the queue does not chain | 2 failed (mark-read and star, the 409) |
| M6 busy off after each task | 3 failed (mark-read and star, the 409, busy once) |
| M7 read while a write is out | 3 failed (failure while another is out, bulk mid-press, press while a bulk is out) |
| M8 always read after writes | 6 failed (single press, in order, the press after, failure while out, filter change while a read is out, read before the press) |
| M9 an aborted answer used | 3 failed (R13 order, filter change while a read is out, press during the read after) |
| M10 a failed task breaks the queue | 1 failed (a failed task does not stop the queue) |
| islands at `21d59fb8` (the old fix) | 6 failed (every source guard) |
| islands at `main` | 6 failed (every source guard) |
| the whole of `21d59fb8` | 24 failed (the old model has neither rule) |

Every test fails under at least one variant.

**e2e** (`tests/admin/leads.e2e.ts`, CI only): "the list: a star pressed while a search is out
stays pressed (C4 star race)", traced against the markup. The lead is put on screen by a first
search (the `Search leads` searchbox, Enter); the table (`Leads`, its `aria-busy`) settles and
the row's `Star {name}` button reads `aria-pressed="false"`. A second search (the lead's whole
e-mail, the same row) is fetched from the server at once by `page.route` + `route.fetch()`, and
its answer held. The star is pressed: `aria-pressed="true"`, its PATCH answers 200, and the
list is read again (a second query with the same term, not the held one) and answers 200; the
table stops being busy and the star is still pressed. The held answer is then released (its
`route.fulfill` meets an aborted request and is caught), the star stays pressed, and the
database says starred. Without the fix no read follows the star (the wait for it fails), and the
held rows turn the star off.

## Sizes

`npm run size` with the CI environment: public route JS 26.07 kB (limit 100); admin bundle sum
394.81 kB (limit 400; `main` 394.4, the old fix 395.07); the leads screens' eager graphs
159.4 kB each (limit 300; the old fix 159.6); admin chunk plan holds. `lateAnswers.ts` is 97
lines (the old one 191); the islands' diff against `main` is 122 changed lines across three files.

## Owner questions

None.

## PII

Nothing new reaches a row or the model: `ListWrites` and `Serial` hold counts, one
`AbortController` and one promise, never a row or a field. The list still reads the safe row
shape only (`LEAD_LIST_FIELDS`); no contact detail, budget or note is read or held.
