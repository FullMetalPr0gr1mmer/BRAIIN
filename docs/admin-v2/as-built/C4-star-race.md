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
     a read's answer is used only if no write answered after the read was sent; a write's
     answer only if no write sent after it has answered. So the mark-read PATCH sent on
     opening, or the refetch after "Log contact", can no longer answer last and undo a star or
     a stage move saved meanwhile.
2. **`LeadsList.tsx`** routes its list answers and its star through `RowToggles`.
3. **`LeadDetail.tsx`** routes the mark-read answer, `write()` and `refetch()` through
   `AnswerOrder`.
4. **The board (`LeadsBoard.tsx`)** checked for the same pattern: see "The board" below.
5. **Tests:** `tests/lib/lateAnswers.spec.ts` (the model, each race in both orders, and a
   source guard that the two islands use it), and an e2e step in `tests/admin/leads.e2e.ts` that
   holds the search's answer (read on the server first, delivered after the star is saved) and
   checks the star stays pressed.

## What was built

As planned, in three places:

- **`src/lib/crm/lateAnswers.ts`** (new, pure): `RowToggles` (`read`, `begin`, `settle`,
  `answer`), `AnswerOrder` (`send`, `accept`) and `withField`. One clock per island; nothing
  async inside, so every order of events is a few lines of a unit test.
- **`LeadsList.tsx`**: each list read takes a stamp as it leaves and its answer goes through
  `toggles.answer(rows, stamp)` (null: a newer read already answered, the answer is dropped
  whole, total and all); the star goes through `begin` before its PATCH and `settle` after it.
  A failed star still says "{name} could not be starred." and now puts back the last value the
  server confirmed, which after two quick presses is not always the value before the second.
- **`LeadDetail.tsx`**: the mark-read PATCH on opening, `write()` (every control of the status
  card, the stage move included) and `refetch()` (after "Log contact" and after a 409) take a
  stamp as they leave and set the lead only if `order.accept(stamp, isWrite)`. A refetch a
  write overtook is read once more (at most twice), so what "Log contact" changed still shows
  when a star's row, saved from before the contact, answered in between.

## Self-review

The first `AnswerOrder` dropped every answer sent before any write answered, writes included.
Opening an unread lead and pressing the star at once then lost the star's own answer whenever
the mark-read PATCH answered first: the same bug the other way round. A write's answer is now
dropped only when a write sent after it has answered; the test "keeps a star saved after the
mark-read sent before it answered (either order)" fails on the first rule (1 failed, 17 passed).

## Review fixes

Two findings, both checked against the code and both real; neither refuted, none skipped.

- **LS-1 (low), a lead's page: a write's answer shown over a newer read.** `AnswerOrder`
  compared a write's answer only with other writes, so the mark-read PATCH sent on opening
  could answer after a later refetch (the one after a 409, or after "Log contact") had been
  shown and put the older row back (an old stage and version, the next versioned change a
  needless 409). The model now keeps the send stamp of the newest answer shown, read or write:
  no answer replaces one sent after it, and an older read is dropped once a newer read was
  shown. The reviewer's suggested rule alone (drop the write's answer) was not enough: the
  status card's write and "Log contact" are on separate cards, so a star can be out while a
  refetch sent after it answers first, and the server may have run the star after that read.
  Dropping the star's row would then show the star off while the database has it on, the bug
  this slice fixes. So a write's answer that is not shown is followed by one more read
  (`else void refetch()` in `write()` and in the mark-read effect): the order of the two rows
  is unknown, only a read made after both can tell. Guarded by "drops the mark-read answer
  once a refetch sent after it was shown (LS-1)", "a write whose answer arrives after a later
  read was shown is not shown, then read again", "drops an older read once a newer read was
  shown" and the source guard "a lead's page reads again whenever a write's answer is not
  shown". With the review fix reverted under `src/` (tests kept) all eight new tests fail (8 failed,
  18 passed).
- **LS-2 (low), the list: a single star press laid over the bulk Star's read.** The bulk bar's
  Star is another write of `is_starred` the model did not know about: a single unstar still out
  was laid over the read `bulkDone` asks for, and `settle` showed it again, while the server
  could have run the bulk Star last. The bulk bar now passes its action to `onDone`, and on a
  bulk Star the list calls the new `RowToggles.forget(ids, 'is_starred')` before reading again:
  a toggle whose writes have all answered is dropped, one with a write still out is detached
  (it overrides no answer, and its `settle` returns `'reread'`, on which the list reads again,
  since only a read made after both writes can say which ran last). A press after the bulk
  answered reattaches the toggle (it is the newest write from this screen). Disabling the bulk
  Star while a single write is out was the other option; it would not cover a single press
  made while the bulk Star is out, which the detach rule handles the same way. Guarded by "a
  bulk Star that lands while a single unstar is out: the read after it decides (LS-2)", "forget
  drops a settled toggle, leaves other rows and fields, and a later press counts", "a detached
  press that is pressed again is laid over answers again" and the source guard "the list
  forgets its star toggles on a bulk Star and reads again when asked".

## The board

`LeadsBoard.tsx` was checked and left as it is. Its one write, the stage move, is not
optimistic: the card moves when the PATCH answers. A board read that left before the move and
is still out when the move answers is aborted and read again (`reading` ref and `setReload`,
since C4c), so its answer can never redraw the card in its old column; a read that answered
before the move answered is the state before the move, and the move is applied over it. No
toggle on a card writes anything (the card's star and unread dot are display only).

## Departures

- **One write per field at a time is not enforced.** Two quick presses of one star send two
  PATCHes; the model shows the last press, waits for both answers and then shows the last value
  the server confirmed (in answer order). If the network delivered the two writes to the
  server out of order, the database could hold the first press while the screen shows the
  second, until the next read. Queuing presses would close that, at the cost of a slower
  star; the risk is the same as before this fix, so it is left and recorded here.
- **A lead's page drops, not merges, a stale answer.** When the mark-read answer is dropped,
  the screen keeps the later write's row, whose `read_at` may still be empty if the server ran
  the star first. Nothing on the page shows `read_at` after opening, and the page never marks a
  lead read twice (`marked` ref), so nothing visible changes.
- The existing list e2e keeps its wait for the search answer (it means to press the star on the
  searched rows); its comment now points at the new e2e test, which holds the race on purpose.

## Tests

- `tests/lib/lateAnswers.spec.ts` (26 tests since the review fixes, see above): the R13 order (read leaves, star saved, read
  answers with the star off: the star stays on), a star still out when a read answers, a read
  that left during the write and one after it (the later read decides, so a colleague's change
  shows), an older answer dropped, only the toggled row and field touched, a failed write put
  back and not re-shown by a late answer, two presses (each order, one or both failing), an
  unknown token; `AnswerOrder`: the mark-read answer after a saved star is dropped, a star
  sent after the mark-read is kept in either order, a refetch overtaken by a write is dropped
  and the read after it kept, answers in order are kept; and a source guard that both islands go through the model (no `setRows(asRows(`, no
  bare `setLead(await`, no `.then(setLead)`).
- **Fails without the fix:** with the two islands reverted (`git diff origin/main --
  src/components/admin/screens/leads > p; git apply -R p`), the two source-guard tests fail
  (2 failed, 16 passed); with the whole change reverted the spec cannot import the model.
- **e2e** (`tests/admin/leads.e2e.ts`, CI only): "the list: a star pressed while a search is
  out stays pressed (C4 star race)". The lead is put on screen by a first search; a second
  search (its whole e-mail, the same row) is fetched from the server at once through
  `page.route` + `route.fetch()`, and its answer is held; the star is pressed and its PATCH
  answers 200; the held answer is then released, the table stops being busy, and the star must
  still be pressed and the database must say starred. Without the fix the held rows turn it off.

## Sizes

`npm run size`: public route JS 26.07 kB (limit 100); admin bundle sum 394.9 kB (limit 400,
main was 394.4); the leads screens' eager graphs 159.5 kB each (limit 300); admin chunk plan
holds.

## Owner questions

None.

## PII

Nothing new reaches a row: the model only copies a field the island already set on its own
row (`is_starred`) over the same safe row shape (`LEAD_LIST_FIELDS`). No contact detail,
budget or note is read or held.
