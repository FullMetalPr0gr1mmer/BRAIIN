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

Small rules in `src/lib/crm/lateAnswers.ts` (275 lines with their comments, pure, no DOM).
The islands pass their fetches and setters in, so the press, the bulk write and a lead page's
write run in unit tests exactly as the islands run them. Their state is three fields (the list:
the read in flight, a count of writes out, a flag), one promise and a count (a lead's page),
and one controller (a lead's timeline): nothing grows with use.

**Every row write and queued read has a deadline (`withDeadline`, `ROW_WAIT_MS` = 15 s).**
`adminFetch` has no timeout of its own, and the rules below hold the list's reads and a lead's
queue while a write is out, so one request that never answers would freeze the screen. Past the
deadline the request is aborted and counts as a failure ("The server did not answer in time."),
which already reads again.

**The list: a row write never overlaps a list read (`ListWrites`, `pressStar`, `rowWrite`).**

- A row write (a star press, any bulk action) aborts the list read in flight, through the
  `AbortController` the read already had, so that read's answer is never used: the island
  checks `writes.landed(controller)` before it touches rows, the total or the errors.
- A list read asked for while a row write is out (a filter, a search, a page, the read after a
  bulk action) is held: the table shows busy, and the read leaves once the writes answered (at
  most the deadline).
- Once every row write has answered, success or failure, the list is read once more if a read
  was aborted or held, if two writes overlapped, if a write failed, or if a bulk action ran.
  That read is the truth; nothing is laid over it. Two writes that overlapped are always read
  after: answer order is not commit order (the PATCH audits and resolves interests after its
  update, and a request can wait on auth before it), so the answers cannot say which the server
  ran last. A single press, or presses that did not overlap, need no read.
- A star is shown at once. A failed save draws it back to the value before the press (most
  failures never reached the database) and says "{name} may not be starred. {why} Checking the
  list again." (or "unstarred"). The read after the writes then settles it: the words go when
  the row shows the press saved after all (the PATCH can fail after its update committed);
  "{name} could not be starred. {why}" when it shows the old value; "{name} may not be
  starred: the list could not confirm it. {why}" when that read failed or the row is not on the
  page read.
- The bulk bar is a row write like the star. The list owns the bulk POST (`postBulk`, passed
  to the bar as `post`, through `rowWrite`), so the write is counted and answered in one place.
  `bulkDone` asks for no read itself: the rule does, after every write has answered.

**A lead's page: one thing at a time on the row (`Serial`, `writeInTurn`).**

- Every read and write of the lead's row runs one after another: the mark-read PATCH on
  opening, the status card's writes, and the read of the row after "Log contact". The row's
  answers therefore arrive in send order, and the newest sent is the last shown.
- `busy` belongs to the queue: on when the first task is queued, off when the last has settled,
  follow-up reads included. The status card's controls that write (the stage's Move to, the
  owner select, the value box, the star, a tag's remove and the tag form's Add button) are
  `disabled={busy}`, so
  no versioned change can leave with an old version. The tag text box stays typeable; its Add
  waits.
- Any failure reads the lead and its timeline again inside the write's own turn (busy until it
  lands), since the PATCH may have committed: after a 409 the conflict is said and a failed
  read is said too, so a reload is never dropped silently; after any other failure the write's
  own error stays up.
- The timeline is not on the row and is not queued: its reloads go through `Latest`, so a newer
  reload aborts the one still out and an older timeline never replaces a newer one.

**The board: a failed move reads again.** The stage move is not optimistic: the card moves when
the PATCH answers. A board read that left before the move and is still out when the move
answers is aborted and read again (since C4c). A move whose PATCH fails (not a 409) now reads the
board too, since the PATCH can fail after its update committed (the version then moved, and the
card's next move would meet a false 409): "{name} may not have moved. {why} Checking the board
again.", then, once the read lands, "Moved {name} to {stage}." if it moved after all, "{name}
could not be moved. {why}" if not, or that the board could not confirm it (`moveOutcome`).

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
overlapped a write, and on a lead's page two answers about the row never overlap.

Checked for a concrete case the simpler design gets wrong, two were found and closed inside it:

- **A read that leaves while a write is out.** Aborting only the read in flight would let a
  filter change made during the star's PATCH answer with rows read before the star was saved.
  So a read asked for while a write is out is held, and made after the writes.
- **A lead's page, "Log contact" during a status write.** "Apply only the newest answer by send
  order" alone would show a reload sent after the star's PATCH, which the server may still run
  before it. Running the reads in the same queue as the writes closes it, and makes the
  newest-by-send-order rule hold by construction instead of by stamps.

## Review 2 (LS2-1 to LS2-5, LS-R1 to LS-R7)

Each finding was checked against the code. All were real; all are fixed.

| Finding | Verdict | Fix | Guarded by |
| --- | --- | --- | --- |
| LS2-1, LS-R2: presses answered in send order were trusted as server order | Real: the PATCH audits and resolves interests after its update, so answer order is not commit order | `ListWrites.write()` sets the read-after flag when another write is out: any overlap ends in one read; tokens and the answer-order check are gone (overlap covers them) | "two overlapping presses ... even in send order (LS2-1)", "... still end on a read (LS2-1)", "two presses that did not overlap need no read" |
| LS2-2, LS-R4: a failed star stayed pressed, and its words were untrue | Real | The star is drawn back on failure and the read after it overrides; the words are true either way and settle when that read lands (`starPending`, `starOutcome`, `settleStar`); star or unstar from the press | "a failed save draws the star back ...", "what a failed press says" (3), the islands' star guard |
| LS2-3, LS-R1: one hung write froze the list's reads or a lead's queue | Real: `adminFetch` has no timeout | `withDeadline` (15 s) on the star PATCH, the bulk POST, every queued write, the mark-read and the queued read of the row; a timeout is a failure, which reads again | "withDeadline" (4), "a press that never answers ...", "a bulk action ... bounded too", "a write that never answers frees the queue" |
| LS2-4: overlapping timeline reloads drew whichever answered last | Real | `Latest`: a newer reload aborts the one still out, and an aborted answer or error is dropped | "Latest" (1), "a lead's timeline draws only the newest reload's answer" |
| LS2-5, LS-R5: statements in this note did not match the code | Real | Rewritten: the state described as it is; "every read and write of the lead's row" (the timeline and Log contact's own POST are not queued); the tag text box named as not disabled; the `onDone` departure dropped (`main`'s `onDone` never carried the action; only `21d59fb8` did); the 409 sentence after Log contact dropped (`logContact` never moves the version); "newest sent is last shown" limited to the row; the e2e paragraph corrected | this note |
| LS-R3: a failed board move was not read again | Real | A non-409 failure reads the board and says what the move came to (`moveOutcome`, `settleMove`) | "moveOutcome" (3), "the board reads again after a failed move" |
| LS-R6: the islands' wiring was checked only by source regexes | Real | The press, the bulk write and a lead page's write are functions the islands call with their fetches and setters (`pressStar`, `rowWrite`, `writeInTurn`), replayed in unit tests with deferred answers (the R13 order, a held filter read, overlap, failure, timeout, a 409 in the queue); the source guards are fewer and check order, not formatting; a new e2e holds a lead page's mark-read and presses the star | the "pressStar and rowWrite" and "Serial and writeInTurn" blocks; e2e "a lead: the star waits for the mark-read ..." |
| LS-R7: `useRef(new X())` built an object every render | Real (harmless, but the pattern React warns against) | `useState(() => new X())` for `ListWrites`, `Serial` and `Latest` | "the rules are built once" |

No React DOM test was added for LS-R6: the unit project has no DOM (no jsdom or Testing Library
in the dependencies, and none is added without approval). Moving the islands' write logic into
functions the tests drive covers the behaviour; the e2e covers the browser.

## Departures

- **A failed star is drawn back at once, and the read after it decides.** The brief's first
  rule kept the optimistic value until the re-read landed; review 2 showed that leaves the star
  pressed when that read fails too (often, when the cause is the network). Drawn back, the
  screen shows what most failures leave stored, the words say it may not have saved, and the
  read corrects both when it lands.
- **A press on another row clears a failed press's words.** One line of star words, as on
  `main`; the read after the writes still lands and the screen ends on what is stored.
- **A timed-out write may still commit after the read that follows it.** The deadline aborts
  the browser's request, not the server's work. Fifteen seconds is far past a normal PATCH
  (well under a second), so this is rare; the screen then shows the last read until the next.
- **The read after a race also reads the KPIs.** The list's one reload counter drives both
  reads, as the bulk action already did; one extra summary POST after a race.
- **A lead's page is busy while the mark-read is out on opening** (one PATCH, usually well
  under a second, at most the deadline). The status card's controls are disabled for that time;
  a press waits for them to enable, and nothing is lost.
- **"Log contact" itself is not queued** (its POST belongs to the contact card and is not
  versioned: `logContact` never moves the version); the read of the row after it is queued.

## Tests

`tests/lib/lateAnswers.spec.ts`, 44 tests:

- **ListWrites (14):** the R13 order (a read out when the star is pressed is aborted and read
  again after); a single press needs no read, nor two that did not overlap; two overlapping
  presses are read after even in send order (LS2-1), and the next press starts clean; a failed
  save is read again (LS-4), and with another press out only once both answered; a bulk action
  mid-press, in both answer orders; a bulk action alone; a press while a bulk is out holds the
  bulk's read; a filter change while a star is out (held, then read once) and while a read is
  out (the newer read used); a press while the read after the writes is out; a read that
  answered before the press is kept.
- **withDeadline (4):** answers as the request does and leaves no timer; past the deadline the
  signal aborts and it fails as too slow, even when the request ignores its signal; an earlier
  failure is the request's own; the deadline is between 10 and 30 seconds.
- **pressStar and rowWrite (6):** the R13 order as the island runs it; two overlapping presses
  answered in send order end on a read; a failed save draws the star back, says so and reads; a
  press that never answers lets the held reads go at the deadline; a bulk action reads after it
  (saved, failed, timed out); a press while a bulk action is out reads once, after both.
- **The star's words (3):** pending, then settled four ways; no em or en dash (P-12).
- **moveOutcome (3):** moved after all, not moved, not confirmed.
- **Serial and writeInTurn (6):** the mark-read and a star (the star leaves only after the
  mark-read answered, answers shown in send order); a 409 (busy until its reload lands, the
  next change leaves with the new version, the reload's failure said); any other failure reads
  again quietly; a write that never answers frees the queue at the deadline; a failed task does
  not stop the queue; busy goes off once.
- **Latest (1):** a newer reload aborts the older.
- **The islands (7, source guards):** the rules are built once; the list reads through the rule
  (held before the fetch, an aborted answer dropped before rows or errors, a failed press
  settled on both paths); the star and the bulk action go through `pressStar` and `rowWrite`
  with their signal, the bar has no `adminFetch` and `bulkDone` asks for no read; a lead's page
  queues and bounds the row's read, write and mark-read and never sets `busy` itself; it reads
  again after a 409 (said) and any failure (quiet); its timeline draws only the newest reload;
  the board reads again after a failed move.

**Red/green** (a local script, not committed: each variant applied, the spec run, the variant
undone):

| Variant | Result |
| --- | --- |
| this branch | 0 failed, 44 passed |
| no read after an overlap (LS2-1) | 3 failed |
| no deadline (the timer aborts nothing) | 4 failed |
| a failed star not drawn back | 2 failed |
| `Latest` does not abort the older reload | 1 failed |
| a press that saved after all still said to have failed | 1 failed |
| `writeInTurn` does not read after a failure | 2 failed |
| the list and a lead's page as at `01e06e26` (review 1's head) | 6 failed (every island guard but the board's) |
| the board's failure branch as on `main` | 1 failed |

Review 1's variants (M1 to M10, at `01e06e26`) were run on the model before these changes;
their cases are all still in the spec.

**e2e** (`tests/admin/leads.e2e.ts`, CI only), traced against the markup:

- "the list: a star pressed while a search is out stays pressed (C4 star race)". The lead is put
  on screen by a first search (the `Search leads` searchbox, Enter); the table (`Leads`, its
  `aria-busy`) settles and the row's `Star {name}` button reads `aria-pressed="false"`. A second
  search (the lead's whole e-mail, the same row) is fetched from the server at once by
  `page.route` + `route.fetch()`, and its answer held. The star is pressed: `aria-pressed="true"`,
  its PATCH answers 200, and the list is read again (a second query with the same term, not the
  held one) and answers 200; the table stops being busy and the star is still pressed. The held
  answer is then released (its `route.fulfill` meets an aborted request and is caught), the star
  stays pressed, and the database says starred. On `main` it is red because no read follows the
  star: the wait for that read times out before the held answer is released.
- "a lead: the star waits for the mark-read sent on opening, and stays (C4 star race)". A lead
  added by hand is read at once, so the test marks it unread through the API (`read: false`,
  200, `read_at` null). The page's mark-read PATCH (`{ read: true }`) is fetched from the server
  at once and its answer held; the `Starred` switch is disabled and reads `aria-checked="false"`.
  Released, the switch enables; pressed, its PATCH (`isStarred: true`) answers 200 and the
  switch reads `aria-checked="true"`; the database says starred and read. On `main` it is red:
  the switch is pressable while the mark-read is out (`toBeDisabled` fails), which is the order
  in which the mark-read's late answer turned the star off again.

## Sizes

`npm run size` with the CI environment: public route JS 26.07 kB (limit 100); admin bundle sum
395.51 kB (limit 400; `main` 394.4, review 1's head 394.81: the deadline, the star's words and
the board's re-read cost 0.7 kB); the leads screens' eager graphs 160.1 kB each (limit 300;
review 1's head 159.4); admin chunk plan holds. The sum is 4.5 kB under its tripwire; E2 raises
it to 450 kB (owner decision of 2026-10-28). `lateAnswers.ts` is 275 lines, about half of them
comments; the islands' diff against `main` is about 250 changed lines across four files.

## Owner questions

None.

## PII

Nothing new reaches a row or the model: the rules hold counts, a flag, controllers and one
promise, never a row or a field. A failed press keeps the lead's id, the name the list already
shows and the error's words until the next read. The list still reads the safe row shape only
(`LEAD_LIST_FIELDS`); no contact detail, budget or note is read or held.
