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

Small rules in `src/lib/crm/lateAnswers.ts` (370 lines with their comments, pure, no DOM).
The islands pass their fetches and setters in, so the press, the bulk write, a board move and a
lead page's write run in unit tests exactly as the islands run them. Their state is three
fields (the list and the board each: the read in flight, a count of writes out, a flag), one
promise and a count (a lead's page), two controllers (a lead's timeline), and the failed writes
waiting for the read after them (`Checks`, one per row, emptied by that read): nothing grows
with use.

**Every row write and every list, board or queued read has a deadline (`withDeadline`,
`ROW_WAIT_MS` = 15 s; a bulk action `BULK_WAIT_MS` = 60 s).** `adminFetch` has no timeout of
its own, and the rules below hold the list's and the board's reads and a lead's queue while a
write is out, so one request that never answers would freeze the screen; a read that never
answered would leave "Checking the list again." and the table's busy state up for good. Past
the deadline the request is aborted and counts as a failure ("The server did not answer in
time."), which already reads again. `withDeadline` takes the rule's own signal too (`outer`),
so a read the rule drops is still aborted.

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
  page read. Each failed press waits in `Checks` under its row, with its own words: a press on
  one row never clears another row's check or words (`sayFor`), and the read after the writes
  settles every check waiting (`verdictOf`, shared with the board).
- A press that got no answer at all (too slow, the network: anything but the server's own
  error, `failureOf`) may still be saving, so a read after it that shows the old value proves
  nothing: it says "{name} may not be starred. {why} It may still be saving, so check again in
  a moment." instead of "could not be" (review 4).
- Presses on one row are counted (`RowPresses`, forgotten once none is out): a failed press
  that a newer press on its row left after is neither drawn back nor said, since the newer
  press is what was asked for last and the overlap is read again anyway (review 4).
- The read after a star reads the list only; the KPIs are read on their own counter, which a
  bulk action moves when it answers (a star changes no KPI).
- The bulk bar is a row write like the star. The list owns the bulk POST (`postBulk`, passed
  to the bar as `post`, through `rowWrite`, with `BULK_WAIT_MS`), so the write is counted and
  answered in one place. `bulkDone` asks for no read itself: the rule does, after every write
  has answered. A bulk action the server refused (a 4xx) says why; one with no answer (too
  slow, the network, a 5xx) is never said to have failed: "{why} The change may still be
  saving. The list will be read again, so check the rows before you try again." The selection
  stays, and the read after it shows the rows.

**A lead's page: one thing at a time on the row (`Serial`, `writeInTurn`).**

- Every read and write of the lead's row runs one after another: the status card's writes and
  the read of the row after "Log contact". The row's answers therefore arrive in send order,
  and the newest sent is the last shown. A queued PATCH takes its version from the row last
  drawn (a ref every drawn row goes through, `showLead`), not from the state its closure saw:
  the task before it can answer before React renders.
- The mark-read PATCH sent on opening is not queued, so it never holds the status card. Only
  its `read_at` is taken from its answer (the one field it changes; it does not move the
  version), so its late answer never draws an older row, the star off, over a change made
  since.
- `busy` belongs to the queue: on when the first task is queued, off when the last has settled,
  follow-up reads included. The status card's controls that write (the stage's Move to, the
  owner select, the value box, the star, a tag's remove and the tag form's Add button) are
  `disabled={busy}`, so
  no versioned change can leave with an old version. The tag text box stays typeable; its Add
  waits.
- Any failure reads the lead and its timeline again inside the write's own turn (busy until it
  lands), since the PATCH may have committed: after a 409 the conflict is said and a failed
  read is said too, so a reload is never dropped silently; after any other failure the write's
  own error stays up, hedged: "This change may not have been saved. {why}" (the read after it
  may show it saved).
- The timeline is not on the row and is not queued: its reloads go through `Latest`, so a newer
  reload aborts the one still out and an older timeline never replaces a newer one. "Show
  older" (`Latest.more`) is dropped when a reload leaves after it, or lands before it
  (`Latest.drawn`): its cursor belongs to the list a reload replaces, so appended to the newer
  first page it would skip or repeat events.

**The board: a move is a row write, as on the list (`ListWrites`, `rowWrite`, `Checks`).** The
stage move is not optimistic: the card moves when the PATCH answers (`rowWrite`'s `shown`, so a
saved move alone needs no read). A move aborts the board read in flight and holds the ones asked
for meanwhile, and the PATCH is bounded, so one that never answers no longer disables every
"Move to" for good. A move whose PATCH fails reads the board again (a 409 says so; any other
failure, since the PATCH can fail after its update committed): "{name} may not have moved.
{why} Checking the board again.", then, once the read lands, "Moved {name} to {stage}." if it
moved after all, "{name} could not be moved. {why}" if not (or, when the PATCH got no answer,
"{name} may not have moved. {why} It may still be saving, so check again in a moment."), or that
the board could not confirm it (`moveOutcome`, through `verdictOf`). Those words are per card,
like the star's.

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

## Review 3 (CR1 to CR8, L1 to L3, Info)

Each finding was checked against the code at `32efa21c`. All were real; all are fixed, with no
change of design: the board now uses the list's rules, and the shared helpers grew instead of
the islands (`Checks`, `sayFor`, `verdictOf`, `rowWrite`'s `shown`, `withDeadline`'s `outer`,
`Latest.more` and `drawn`, `BULK_WAIT_MS`, `bulkUnsure`, `changeUnsure`). Nothing skipped.

| Finding | Verdict | Fix | Guarded by |
| --- | --- | --- | --- |
| CR1: "Show older" was not coordinated with the timeline's reloads | Real: an older page answering after a reload landed was appended to the new first page with a stale cursor | `Latest.more()` for the older page: `next()` aborts it (a reload left after it), `drawn()` aborts it (a reload out before it landed first); its answer and error are dropped when aborted | "an older page is dropped by a reload that leaves after it", "... when a reload out before it lands first", the timeline guard |
| CR2: a slow bulk that committed was reported as failed under the 15 s deadline | Real | `BULK_WAIT_MS` (60 s) for the bulk POST; the bar hands the error to the list (`onError(err)`), which says a refusal (4xx) as before and anything else with `bulkUnsure`: it may still be saving, the list is read again, check the rows; the selection stays (it was only cleared on success) | "a bulk action gets longer than one row", "a bulk action with no answer is never said to have failed", the bulk guard |
| CR3: a queued versioned PATCH took `lead.version` from its closure | Real: the task before it can answer before React renders | Every drawn row goes through `showLead`, which keeps it in a ref; `send` reads `row.current.version` | the lead page guard (one `setLead`, the version from the ref) |
| CR4: the mark-read on opening drove `busy`, disabling the status card up to 15 s | Real | Not queued; only its `read_at` is taken from its answer, so it never draws an older row (the mark-read changes nothing else and never moves the version) | the lead page guard; e2e rewritten: the star is pressed while the mark-read is held and stays once it lands |
| CR5, L2: a board move's PATCH was unbounded; one hung PATCH froze every move | Real | The move is a `rowWrite` (bounded), through `ListWrites` | "a board move (shown when saved) ...", the board guard |
| CR6: a new star press cleared another row's pending check and words; the board's move check the same | Real | `Checks` keyed by row and words per row (`sayFor`) on the list and the board; a press or move drops only its own row's | "a write on one row never clears another row's check", "the words are per row", the star and board guards |
| CR7: the board re-implemented `ListWrites` and the star's check | Real | The board reads and moves through `ListWrites` and `rowWrite` (`shown`: a saved move needs no read); one verdict helper, `verdictOf`, under `starOutcome` and `moveOutcome` | "one verdict for a star and a move", the board guard |
| CR8: a star's re-read bumped the shared counter, so the KPIs were read again | Real | The list reads on `relist`, the KPIs on `recount`; `reread` moves `relist` only; `postBulk` moves `recount` once it answers | the list guard |
| L1: source guards passed when the guard was missing (`indexOf` -1) | Real: mutants M24 (the list's catch unguarded) and M30 (the timeline's catch unguarded) survived | `between` and `inOrder` assert every marker is found, in order; every ordering guard uses them | see the red/green table: both mutants pass review 2's spec on review 2's head and fail this one |
| L3: a hung re-read left "Checking the list again." and `aria-busy` up for good | Real | The list's and the board's reads go through `withDeadline` with the rule's signal as `outer`; a timeout lands as a failed read, which settles the words ("could not confirm it") and says "The server did not answer in time." | "a read the rule drops (outer) aborts the request", "a read that never answers lets go at the deadline with an outer signal too", the list and board guards |
| Info: a lead page's non-409 failure was not hedged | Real: the read after it may show the change applied | `changeUnsure`: "This change may not have been saved. {why}" | "a lead page's failed change is hedged", the lead page guard |

**Red/green, review 3** (`scratchpad/lsmut3/run.sh`, not committed: a `git archive` copy of
the head, each variant applied there, the spec run, the file restored):

| Variant | Result |
| --- | --- |
| this branch | 0 failed, 56 passed |
| CR1: `next()` keeps the older page / `drawn()` does nothing / `olderEvents` off the rule | 1 failed each |
| CR2: the bulk on the row deadline / every bulk failure said as failed / the words say "failed" | 1 failed each |
| CR3: the version from the closure | 1 failed |
| CR4: the mark-read's whole answer drawn / the mark-read queued again | 1 failed each |
| CR5: `rowWrite` without its deadline | 2 failed |
| CR5, CR6, CR7: the board as at `32efa21c` | 2 failed |
| CR6: a press clears every row's words / `Checks.drop` clears all / a move clears every card's words | 1 failed each |
| CR7: `rowWrite` ignores `shown` | 1 failed |
| CR7: `verdictOf` always "refused" | 3 failed |
| CR8: the KPIs on the list's counter / `reread` moves both counters | 1 failed each |
| L1: M24 and M30 on review 2's head, review 2's spec | 0 failed, 44 passed each (they survived) |
| L1: M24 and M30 on this head, this spec | 1 failed each |
| L3: `withDeadline` ignores `outer` / the list's read unbounded | 1 failed each |
| Info: the failure not hedged | 1 failed |

C4c's board guard in `tests/lib/leadsScreens.spec.ts` ("reads again after a move when a filter
or search read was already in flight") pinned the board's old marker (`reading.current`); it now
checks that the board reads and moves through the rule (30 passed; with the board as at
`32efa21c`, 1 failed).

## Review 4 (the independent check's five low items)

Each item was checked against the code at `2fb1a16d`. All were real; all are fixed, with no
change of design.

| Item | Verdict | Fix | Guarded by |
| --- | --- | --- | --- |
| 1: the lead-page e2e waited a fixed 250 ms after the mark-read landed, so it could pass before the late answer was drawn | Real | The fixed code does apply the mark-read answer's `read_at` (only that field), so that is the signal: LeadDetail's `.lead-badges` carries an invisible `data-read-at={lead.read_at ?? ''}`; the route fulfils the held mark-read through `route.fetch()` with its JSON's `read_at` replaced by a sentinel (`2001-01-01T00:00:00.000Z`); after release the test waits for `.lead-badges[data-read-at="<sentinel>"]` to be attached, then reads the star's `aria-checked` once | the e2e (CI); the unit guard "a lead page shows the read mark it drew" keeps the signal in place |
| 2: nothing checked that the list settles on the row's stored star, or the board on the fresh board (mutants G, G2, H, H2 survived) | Real | Guards on the wiring: `settleStars` finds the row in the read that landed and passes `row.is_starred === true` (else undefined); `settleMoves` passes `fresh` to `moveOutcome` and says a move that saved after all | "the list settles each check on its row's stored star, the board on the fresh board" |
| 3: nothing checked that a failed bulk keeps the selection (mutant C2d survived) | Real | Guard: `bulkFailed` never touches the selection, `bulkDone` clears it, the bar never does | "a bulk action that failed keeps the selection; one that answered clears it" |
| 4: after a timeout, a re-read showing the old value said "could not be starred" or "could not be moved", though the write may still land | Real | `failureOf(err)` keeps `unsure` (not an `AdminApiError`: too slow, the network) on the check; `verdictOf(asked, stored, unsure)` answers `unsure` instead of `refused`; `starOutcome` and `moveOutcome` then keep "may not be ..." and add `STILL_SAVING`, as `bulkUnsure` does. A 5xx is the server's own answer (its work is done), so the read after it decides | "with no answer from the server, the old value proves nothing", "failureOf", "after a timeout: the old value keeps "may not be"", "a press that timed out, replayed as the list builds its check", "after a timeout, the old column keeps "may not have moved"", "a failed star or move keeps whether the server answered" |
| 5: two overlapping presses on one row: the older one's failure, arriving after the newer press left, drew the star back over the newer press and said the older press's words | Real | `RowPresses` counts presses per row; `pressStar` takes `{ presses, id }` and skips the draw-back and the check of a failed press that a newer press on its row left after (the draw-back too: it would draw an older value over the newer press until the read) | "presses on one row: an older one failing after a newer left is not drawn back or said", "a failed press is said when the newer press on its row left before it, not after", "a star press counts the presses on its row" |

**Red/green, review 4** (`scratchpad/lsmut5`, not committed: a `git archive` copy of
`20e22e8f`, each variant applied there with exact replacements, `lateAnswers.spec.ts` and
`leadsScreens.spec.ts` run, the files restored; `results.txt`):

| Variant | Result |
| --- | --- |
| this branch | 0 failed, 98 passed |
| 1: `data-read-at` taken off the badges | 1 failed |
| 2: G (`row ? true : undefined`) / G2 (`starOutcome(check, undefined)`) | 1 failed each |
| 2: H (the said-after-all line dropped) / H2 (`moveOutcome(check, null)`) | 1 failed each |
| 3: C2d (`bulkFailed` clears the selection) | 1 failed |
| 4: `failureOf` never unsure / always unsure | 2 / 1 failed |
| 4: `verdictOf` ignores `unsure` | 4 failed |
| 4: `starOutcome`'s / `moveOutcome`'s unsure words dropped | 2 / 1 failed |
| 4: the list's / the board's check built without `unsure` | 1 / 2 failed |
| 4: the board's verdict ignores `unsure` | 3 failed |
| 5: `pressStar` ignores newer presses / `passed` always false / a press never counted | 2 failed each |
| 5: a row never forgotten | 1 failed |
| 5: the list passes no presses | 1 failed |
| 5: only the check skipped, the draw-back kept | 1 failed |

G, G2, H, H2 and C2d are the independent check's mutants, applied verbatim; on `2fb1a16d` with
its spec they survived (0 failed of 86). The e2e runs only in CI. Traced against `main`: its
mark-read draws the whole answer (`.then(setLead)`), so with the attribute added the sentinel
appears together with the star off and the single look reads `aria-checked="false"` (red);
without the attribute (`main` as it is) the wait for the sentinel times out (red). On this
branch only `read_at` is taken from that answer, over the row last drawn (the star's PATCH
answer), so the sentinel appears with the star on (green), in the same render.

## Departures

- **A failed star is drawn back at once, and the read after it decides.** The brief's first
  rule kept the optimistic value until the re-read landed; review 2 showed that leaves the star
  pressed when that read fails too (often, when the cause is the network). Drawn back, the
  screen shows what most failures leave stored, the words say it may not have saved, and the
  read corrects both when it lands.
- **The star's and the board's failure words are one line per row** (review 3, CR6), not one
  line for the screen as on `main`: a press on another row keeps them, and the read after the
  writes settles them all.
- **A timed-out write may still commit after the read that follows it.** The deadline aborts
  the browser's request, not the server's work. Fifteen seconds is far past a normal PATCH
  (well under a second), so this is rare; the screen then shows the last read until the next.
  A bulk action gets sixty, and its words say it may still be saving.
- **A held list read waits at most a bulk action's deadline** (60 s) while a bulk is out; the
  table shows busy meanwhile. A bulk action normally answers in well under a second.
- **"Log contact" itself is not queued** (its POST belongs to the contact card and is not
  versioned: `logContact` never moves the version); the read of the row after it is queued.
- **The mark-read is not queued** (review 3, CR4): it changes `read_at` only, and only
  `read_at` is taken from its answer, so it needs no turn and holds no control.

## Tests

`tests/lib/lateAnswers.spec.ts`, 68 tests (44 after review 2, 56 after review 3; review 3's
twelve and review 4's twelve are named in their sections above and below):

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
- **Review 4 (12):** presses on one row (2); `verdictOf`'s unsure and `failureOf` (2); the
  star's and the move's words after a timeout, and a timed-out press replayed (3); the islands
  (5): settle wiring, `failureOf` on the checks, the row's presses, the bulk selection, the
  badges' `data-read-at`.
- **Serial and writeInTurn (6):** a read of the row and a star (the star leaves only after the
  read answered, answers shown in send order); a 409 (busy until its reload lands, the
  next change leaves with the new version, the reload's failure said); any other failure reads
  again quietly; a write that never answers frees the queue at the deadline; a failed task does
  not stop the queue; busy goes off once.
- **Latest (1):** a newer reload aborts the older.
- **The islands (8, source guards, rewritten in review 3):** every guard now fails when its
  marker is missing (`between` and `inOrder` assert each marker is found, in order; review 2's
  `indexOf(a) < indexOf(b)` passed when `a` was gone, so two removed guards survived). The rules
  are built once (the list, the board, a lead's page); the list reads through the rule, bounded,
  on its own counter; a star press keeps the other rows' checks; a bulk action has its longer
  deadline and hedged words; a lead's page queues the row's read and write, takes the version
  from the row last drawn, and leaves the mark-read out of the queue taking only `read_at`; it
  reads again after any failure, hedged; its timeline guards reloads and older pages; the board
  moves through the rule with a check per card.

**Red/green, review 2** (a local script, not committed: each variant applied, the spec run, the
variant undone):

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
- "a lead: a star pressed while the mark-read is out stays (C4 star race)" (rewritten in
  review 3 for CR4). A lead added by hand is read at once, so the test marks it unread through
  the API (`read: false`, 200, `read_at` null). The page's mark-read PATCH (`{ read: true }`) is
  fetched from the server at once and its answer held. The `Starred` switch
  (`role="switch"`, labelled by its "Starred" span, in LeadStatusCard) is enabled and reads
  `aria-checked="false"`; pressed, its PATCH (`isStarred: true`, not intercepted: the route
  continues every request but the mark-read) answers 200, and the switch reads
  `aria-checked="true"` and is enabled again. The held mark-read's JSON carries a sentinel
  `read_at` (`2001-01-01T00:00:00.000Z`, set through `route.fetch()` and `route.fulfill({
  response, json })`, review 4). Released, the test waits for the badges'
  `data-read-at` to show the sentinel (the answer has been drawn), then reads the switch's
  `aria-checked` once: `true`; the database says starred and read. On `main` it is red there
  (the late answer drew the star off with the sentinel; without the attribute the wait times
  out); at review 2's head (`32efa21c`) it is red at `toBeEnabled` (the queue held the switch).

## Sizes

`npm run size` with the CI environment, after review 4: public route JS 26.07 kB (limit 100);
admin bundle sum 396.23 kB (limit 400; `main` 394.4, review 1's head 394.81, review 2's head
395.51, review 3's head 395.97: review 4's row presses and timeout words cost 0.26 kB); the
leads screens' eager graphs 160.8 kB each (limit 300; review 3's head 160.5); admin chunk plan
holds. The sum is 3.77 kB under its tripwire, so the owner's 450 kB raise was not needed here
(E2 applies it). `lateAnswers.ts` is 437 lines, about half of them comments; the islands' diff
against `main` is about 420 changed lines across four files (336 added, 86 removed).

## Owner questions

None.

## PII

Nothing new reaches a row or the model: the rules hold counts, a flag, controllers and one
promise, never a row or a field. A failed press or move keeps the lead's id, the name the
screen already shows and the error's words until the next read. A lead's page keeps the row it
already shows in a ref as well (`showLead`), the same safe and pipeline columns, never a
revealed contact detail. The list still reads the safe row shape only
(`LEAD_LIST_FIELDS`); no contact detail, budget or note is read or held.
