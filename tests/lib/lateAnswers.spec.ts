import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveOutcome, type MoveCheck } from '@/components/admin/screens/leads/LeadsBoard';
import {
  Latest,
  ListWrites,
  ROW_WAIT_MS,
  Serial,
  TOO_SLOW,
  TooSlow,
  pressStar,
  rowWrite,
  starOutcome,
  starPending,
  withDeadline,
  writeInTurn,
  type StarCheck,
} from '@/lib/crm/lateAnswers';

// The leads screens' late answers (C4 star race): a list read that left before a star press
// answered after the star was saved and drew it off again while the database had it on (R13's
// e2e met it). Each case below replays one order of events through the rule the island uses:
// the rules alone, then the press, the bulk write and the lead page's write as the islands run
// them (their fetches and setters passed in), then the islands' wiring to them. The islands
// render with react-dom/server only (no DOM in the unit project), so the last block reads their
// source; tests/admin/leads.e2e.ts drives the list and a lead's page in a browser.

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('ListWrites (the leads list)', () => {
  it('the R13 order: a read out when the star is pressed is aborted, and read again after', () => {
    const w = new ListWrites();
    const search = w.read()!; // the search leaves
    w.write(); // the star is pressed: the search is aborted
    expect(search.signal.aborted).toBe(true);
    expect(w.landed(search)).toBe(false); // its rows (star off) are never used
    expect(w.written(true)).toBe(true); // saved: read the list once more
    const again = w.read()!;
    expect(again.signal.aborted).toBe(false);
    expect(w.landed(again)).toBe(true);
  });

  it('a single press with no read out needs no read: the screen already shows it', () => {
    const w = new ListWrites();
    w.write();
    expect(w.written(true)).toBe(false);
    expect(w.landed(w.read()!)).toBe(true);
  });

  it('two presses that did not overlap need no read', () => {
    const w = new ListWrites();
    w.write();
    expect(w.written(true)).toBe(false);
    w.write(); // the second leaves after the first answered: their order is known
    expect(w.written(true)).toBe(false);
  });

  it('two overlapping presses: one read once both answered, even in send order (LS2-1)', () => {
    // Answer order is not commit order: the PATCH audits and resolves interests after its
    // update, so "on" can commit last and still answer first. Only a read knows.
    const w = new ListWrites();
    w.write(); // on
    w.write(); // off, while "on" is out
    expect(w.written(true)).toBe(false); // "on" answers first, "off" still out
    expect(w.written(true)).toBe(true);
  });

  it('a press after a burst starts clean', () => {
    const w = new ListWrites();
    w.write();
    w.write();
    expect(w.written(true)).toBe(false);
    expect(w.written(true)).toBe(true);
    w.write(); // the next press, alone
    expect(w.written(true)).toBe(false);
  });

  it('a failed save is read again: the PATCH may have committed before it failed (LS-4)', () => {
    const w = new ListWrites();
    w.write();
    expect(w.written(false)).toBe(true);
  });

  it('a failed save while another press is out: one read, once both have answered', () => {
    const w = new ListWrites();
    w.write();
    w.write();
    expect(w.written(false)).toBe(false); // the other is still out: no read over it yet
    expect(w.written(true)).toBe(true);
    w.write();
    expect(w.written(true)).toBe(false); // and the flag does not linger
  });

  it('a bulk action mid-press: one read after both, in either answer order', () => {
    for (const bulkFirst of [true, false]) {
      const w = new ListWrites();
      const search = w.read()!;
      w.write(); // the star
      w.write(); // the bulk bar's POST is a row write too
      expect(search.signal.aborted).toBe(true);
      // The bulk answers "not shown" (its rows change only through a read); the star "shown".
      const order = bulkFirst ? [false, true] : [true, false];
      expect(order.map((shown) => w.written(shown))).toEqual([false, true]);
    }
  });

  it('a bulk action alone is read again (it is not optimistic)', () => {
    const w = new ListWrites();
    w.write();
    expect(w.written(false)).toBe(true);
  });

  it('a press while a bulk action is out holds the bulk read until both answered', () => {
    const w = new ListWrites();
    w.write(); // bulk
    w.write(); // star
    expect(w.written(false)).toBe(false);
    expect(w.read()).toBeNull(); // the read the bulk asks for is held
    expect(w.written(true)).toBe(true);
  });

  it('a filter change while a star is out: the read is held, then read once', () => {
    const w = new ListWrites();
    w.write();
    expect(w.read()).toBeNull(); // the filter's read waits for the star
    expect(w.written(true)).toBe(true); // ...and is asked for now, with the filters then
    expect(w.read()).not.toBeNull();
  });

  it('a filter change while a read is out: the newer read is the one used', () => {
    const w = new ListWrites();
    const old = w.read()!;
    old.abort(); // the island's effect cleanup
    const fresh = w.read()!;
    expect(w.landed(old)).toBe(false);
    expect(w.landed(fresh)).toBe(true);
    // Both have landed: a press now finds no read out, so it needs no read after it.
    w.write();
    expect(w.written(true)).toBe(false);
  });

  it('a press while the read after the writes is out aborts it, and reads once more', () => {
    const w = new ListWrites();
    w.write();
    expect(w.written(false)).toBe(true);
    const again = w.read()!;
    w.write();
    expect(again.signal.aborted).toBe(true);
    expect(w.landed(again)).toBe(false);
    expect(w.written(true)).toBe(true);
  });

  it('a read that answered before the press is kept and asks for nothing', () => {
    const w = new ListWrites();
    const read = w.read()!;
    expect(w.landed(read)).toBe(true);
    w.write();
    expect(read.signal.aborted).toBe(false);
    expect(w.written(true)).toBe(false);
  });
});

describe('withDeadline (a row write or queued read never holds the screen for good)', () => {
  it('answers as the request answers, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(async () => 'saved', 1_000)).resolves.toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('past the deadline: the signal aborts and it fails as too slow (LS-R1, LS2-3)', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const late = withDeadline((signal) => {
      seen = signal;
      return new Promise<never>(() => undefined); // a request that never answers
    }, 1_000);
    const caught = late.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(999);
    expect(seen!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen!.aborted).toBe(true);
    const err = await caught;
    expect(err).toBeInstanceOf(TooSlow);
    expect((err as Error).message).toBe(TOO_SLOW);
  });

  it('a failure before the deadline is the request’s own', async () => {
    await expect(withDeadline(() => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline',
    );
  });

  it('waits long enough for a slow Worker, not for ever', () => {
    expect(ROW_WAIT_MS).toBeGreaterThanOrEqual(10_000);
    expect(ROW_WAIT_MS).toBeLessThanOrEqual(30_000);
  });
});

/** The list as one island: what the screen shows and what the reads asked for. */
function listScreen(starred: boolean) {
  const screen = { starred, rereads: 0, failures: [] as unknown[] };
  const steps = (send: (signal: AbortSignal) => Promise<unknown>) => ({
    show: (on: boolean) => {
      screen.starred = on;
    },
    send,
    failed: (err: unknown) => {
      screen.failures.push(err);
    },
    reread: () => {
      screen.rereads += 1;
    },
  });
  return { screen, steps };
}

describe('pressStar and rowWrite (the list, as the island runs them)', () => {
  it('the R13 order: the search out is aborted, the star stays, and the list is read', async () => {
    const w = new ListWrites();
    const { screen, steps } = listScreen(false);
    const search = w.read()!;
    const patch = deferred<unknown>();
    const press = pressStar(
      w,
      true,
      steps(() => patch.promise),
    );
    expect(screen.starred).toBe(true); // shown at once
    expect(search.signal.aborted).toBe(true); // its rows (star off) will be dropped
    expect(w.landed(search)).toBe(false);
    expect(w.read()).toBeNull(); // a filter changed meanwhile waits
    patch.resolve({});
    expect(await press).toBe(true);
    expect(screen).toMatchObject({ starred: true, rereads: 1, failures: [] });
  });

  it('two overlapping presses answering in send order still end on a read (LS2-1)', async () => {
    const w = new ListWrites();
    const { screen, steps } = listScreen(false);
    const on = deferred<unknown>();
    const off = deferred<unknown>();
    const first = pressStar(
      w,
      true,
      steps(() => on.promise),
    );
    const second = pressStar(
      w,
      false,
      steps(() => off.promise),
    );
    on.resolve({}); // the server may have run "off" first: the answers cannot say
    await first;
    expect(screen.rereads).toBe(0); // nothing read over a write still out
    off.resolve({});
    await second;
    expect(screen.rereads).toBe(1);
  });

  it('a failed save draws the star back, says so, and the list is read (LS2-2)', async () => {
    const w = new ListWrites();
    const { screen, steps } = listScreen(false);
    const ok = await pressStar(
      w,
      true,
      steps(() => Promise.reject(new Error('offline'))),
    );
    expect(ok).toBe(false);
    expect(screen.starred).toBe(false); // the value before the press, until the read says
    expect(screen.failures).toHaveLength(1);
    expect(screen.rereads).toBe(1);
  });

  it('a press that never answers lets the held reads go at the deadline (LS-R1)', async () => {
    vi.useFakeTimers();
    const w = new ListWrites();
    const { screen, steps } = listScreen(false);
    const press = pressStar(
      w,
      true,
      steps(() => new Promise<never>(() => undefined)),
      1_000,
    );
    expect(w.read()).toBeNull(); // a search held behind it
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await press).toBe(false);
    expect(screen.failures[0]).toBeInstanceOf(TooSlow);
    expect(screen.starred).toBe(false);
    expect(screen.rereads).toBe(1); // the held search and the check, as one read
    expect(w.read()).not.toBeNull();
  });

  it('a bulk action reads after it, saved or not, and is bounded too', async () => {
    vi.useFakeTimers();
    const w = new ListWrites();
    let rereads = 0;
    const reread = () => {
      rereads += 1;
    };
    await expect(rowWrite(w, async () => 'done', reread)).resolves.toBe('done');
    expect(rereads).toBe(1);
    await expect(rowWrite(w, () => Promise.reject(new Error('offline')), reread)).rejects.toThrow(
      'offline',
    );
    expect(rereads).toBe(2);
    const stuck = rowWrite(w, () => new Promise<never>(() => undefined), reread, 1_000);
    const caught = stuck.catch((err: unknown) => err);
    expect(w.read()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toBeInstanceOf(TooSlow);
    expect(rereads).toBe(3);
  });

  it('a press while a bulk action is out: one read, after both', async () => {
    const w = new ListWrites();
    const { screen, steps } = listScreen(false);
    const bulk = deferred<string>();
    const posted = rowWrite(w, () => bulk.promise, steps(async () => ({})).reread);
    await pressStar(
      w,
      true,
      steps(async () => ({})),
    );
    expect(screen.rereads).toBe(0);
    bulk.resolve('done');
    await posted;
    expect(screen.rereads).toBe(1);
  });
});

describe('what a failed press says (LS2-2, LS-R4: true either way)', () => {
  const check = (next: boolean): StarCheck => ({
    id: 'a',
    name: 'Sara',
    next,
    detail: 'Something went wrong.',
  });

  it('before the read: it may not have saved, and the list is being checked', () => {
    expect(starPending(check(true))).toBe(
      'Sara may not be starred. Something went wrong. Checking the list again.',
    );
    expect(starPending(check(false))).toContain('may not be unstarred');
  });

  it('after the read: nothing when it saved after all, the truth otherwise', () => {
    expect(starOutcome(check(true), true)).toBe(''); // the save committed before it failed
    expect(starOutcome(check(true), false)).toBe(
      'Sara could not be starred. Something went wrong.',
    );
    expect(starOutcome(check(false), true)).toBe(
      'Sara could not be unstarred. Something went wrong.',
    );
    expect(starOutcome(check(true), undefined)).toBe(
      'Sara may not be starred: the list could not confirm it. Something went wrong.',
    );
  });

  it('no em or en dash in the words (P-12)', () => {
    const words = [
      starPending(check(true)),
      starOutcome(check(true), false),
      starOutcome(check(true), undefined),
      TOO_SLOW,
    ].join(' ');
    expect(words).not.toMatch(/[–—]/);
  });
});

describe('moveOutcome (the board, a failed move, LS-R3)', () => {
  const stage = (id: string) => ({
    id,
    key: id,
    label: id === 'won' ? 'Won' : 'New',
    tone: 'ok' as const,
    kind: 'open' as const,
    isInitial: false,
  });
  const check: MoveCheck = { id: 'c', name: 'Sara', to: stage('won'), detail: 'Offline.' };
  const board = (where: string) =>
    ['new', 'won'].map((id) => ({ stage: { id }, cards: id === where ? [{ id: 'c' }] : [] }));

  it('the read shows the card moved: the move is said, no error', () => {
    expect(moveOutcome(check, board('won'))).toEqual({ said: 'Moved Sara to Won.' });
  });

  it('the read shows it where it was: it could not be moved', () => {
    expect(moveOutcome(check, board('new'))).toEqual({
      error: 'Sara could not be moved. Offline.',
    });
  });

  it('the read failed, or the card is not on the board: it could not be confirmed', () => {
    expect(moveOutcome(check, null)).toEqual({
      error: 'Sara may not have moved: the board could not confirm it. Offline.',
    });
    expect(moveOutcome(check, board('none'))).toHaveProperty('error');
  });
});

describe("Serial and writeInTurn (a lead's page)", () => {
  it('the mark-read on opening and a star: the star leaves only once the mark-read answered', async () => {
    const busy: boolean[] = [];
    const q = new Serial((on) => busy.push(on));
    const sent: string[] = [];
    const shown: string[] = [];
    const markRead = deferred<string>();
    const star = deferred<string>();
    const a = q.run(async () => {
      sent.push('mark-read');
      shown.push(await markRead.promise);
    });
    const b = writeInTurn(q, {
      send: () => {
        sent.push('star');
        return star.promise;
      },
      saved: (answer) => shown.push(answer),
      refused: () => true,
      reread: async () => undefined,
    });
    await tick();
    expect(sent).toEqual(['mark-read']);
    star.resolve('starred'); // even an answer ready first is not shown first
    await tick();
    expect(shown).toEqual([]);
    markRead.resolve('read');
    await Promise.all([a, b]);
    expect(sent).toEqual(['mark-read', 'star']);
    expect(shown).toEqual(['read', 'starred']); // the newest sent is the last shown
    expect(busy).toEqual([true, false]);
  });

  it('a 409: busy until its reload lands, and the next change leaves with the new version', async () => {
    const busy: boolean[] = [];
    const q = new Serial((on) => busy.push(on));
    let version = 1; // on screen
    const patch = deferred<number>();
    const reload = deferred<number>();
    const sentWith: number[] = [];
    const quiet: boolean[] = [];
    const conflict = new Error('409');
    const move = writeInTurn(q, {
      send: () => {
        sentWith.push(version);
        return patch.promise;
      },
      saved: (v) => {
        version = v;
      },
      refused: (err) => err !== conflict, // a 409 has its read's failure said
      reread: async (q) => {
        quiet.push(q);
        version = await reload.promise;
      },
    });
    const next = writeInTurn(q, {
      send: async () => {
        sentWith.push(version);
        return version;
      },
      saved: () => undefined,
      refused: () => true,
      reread: async () => undefined,
    });
    patch.reject(conflict);
    await tick();
    expect(busy).toEqual([true]); // the reload is out: still busy
    expect(sentWith).toEqual([1]); // nothing else has left
    expect(quiet).toEqual([false]);
    reload.resolve(2);
    expect(await move).toBe(false);
    expect(await next).toBe(true);
    expect(sentWith).toEqual([1, 2]);
    expect(busy).toEqual([true, false]);
  });

  it('any other failure reads again too, quietly, inside the same turn', async () => {
    const q = new Serial(() => undefined);
    const steps: string[] = [];
    const ok = await writeInTurn(q, {
      send: () => Promise.reject(new Error('offline')),
      saved: () => steps.push('saved'),
      refused: () => {
        steps.push('refused');
        return true;
      },
      reread: async (quiet) => {
        steps.push(`reread ${quiet ? 'quiet' : 'said'}`);
      },
    });
    expect(ok).toBe(false);
    expect(steps).toEqual(['refused', 'reread quiet']);
  });

  it('a write that never answers frees the queue at the deadline (LS-R1, LS2-3)', async () => {
    vi.useFakeTimers();
    const busy: boolean[] = [];
    const q = new Serial((on) => busy.push(on));
    const said: unknown[] = [];
    const stuck = writeInTurn(
      q,
      {
        send: () => new Promise<never>(() => undefined),
        saved: () => undefined,
        refused: (err) => {
          said.push(err);
          return true;
        },
        reread: async () => undefined,
      },
      1_000,
    );
    const after = q.run(async () => 'read');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stuck).toBe(false);
    expect(said[0]).toBeInstanceOf(TooSlow);
    await expect(after).resolves.toBe('read');
    await vi.advanceTimersByTimeAsync(0);
    expect(busy).toEqual([true, false]);
  });

  it('a failed task does not stop the queue, and its answer is its own', async () => {
    const q = new Serial(() => undefined);
    const failed = q.run(() => Promise.reject(new Error('offline')));
    const after = q.run(async () => 'read');
    await expect(failed).rejects.toThrow('offline');
    await expect(after).resolves.toBe('read');
  });

  it('busy goes off once, after the last task, and on again for the next', async () => {
    const busy: boolean[] = [];
    const q = new Serial((on) => busy.push(on));
    await Promise.all([q.run(async () => 1), q.run(async () => 2)]);
    await tick();
    expect(busy).toEqual([true, false]);
    await q.run(async () => 3);
    await tick();
    expect(busy).toEqual([true, false, true, false]);
  });
});

describe("Latest (a lead's timeline, LS2-4)", () => {
  it('a newer reload aborts the one still out, so an older timeline is never drawn', () => {
    const latest = new Latest();
    const first = latest.next(); // after the first write
    const second = latest.next(); // after the second, or a logged contact
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });
});

describe('the islands use the rules', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const list = () => read('src/components/admin/screens/leads/LeadsList.tsx');
  const detail = () => read('src/components/admin/screens/leads/LeadDetail.tsx');
  const board = () => read('src/components/admin/screens/leads/LeadsBoard.tsx');
  const between = (src: string, from: string, to: string) =>
    src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

  it('the rules are built once, never as a ref argument on every render (LS-R7)', () => {
    expect(list()).toContain('const [writes] = useState(() => new ListWrites());');
    expect(detail()).toContain('const [queue] = useState(() => new Serial(setBusy));');
    expect(detail()).toContain('const [timeline] = useState(() => new Latest());');
    for (const src of [list(), detail()]) expect(src).not.toMatch(/useRef\(new /);
  });

  it('the list reads through the rule: held while a write is out, aborted answers dropped', () => {
    const effect = between(list(), 'const listed = useRef', 'const summarised');
    expect(effect).not.toContain('new AbortController()'); // the read's controller is the rule's
    const held = effect.indexOf('if (!controller) return;');
    expect(effect.indexOf('const controller = writes.read();')).toBeLessThan(held);
    expect(held).toBeLessThan(effect.indexOf('adminFetch<LeadPage>'));
    expect(effect.indexOf('if (!writes.landed(controller)) return;')).toBeLessThan(
      effect.indexOf('setRows('),
    );
    const caught = effect.slice(effect.indexOf('.catch('));
    expect(caught.indexOf('if (!writes.landed(controller)) return;')).toBeLessThan(
      caught.indexOf('setError('),
    );
    // A failed press is settled by the read after it, landed or failed.
    expect(effect.match(/settleStar\(/g)).toHaveLength(2);
  });

  it('a star and a bulk action are row writes, bounded, through the rule', () => {
    const src = list();
    const star = between(src, 'async function toggleStar', 'function postBulk');
    expect(star).toContain('await pressStar(writes, next, {');
    expect(star).toMatch(/body: \{ isStarred: next \},\s*signal,/);
    expect(star).toContain('setStarError(starPending(check));');
    expect(star).not.toContain('could not be starred'); // the words are the rule's
    const bulk = between(src, 'function postBulk', 'function bulkDone');
    expect(bulk).toContain('return rowWrite(');
    expect(bulk).toMatch(/method: 'POST', body, signal \}/);
    expect(src).toContain('post={postBulk}');
    const done = between(src, 'function bulkDone', 'const counts =');
    expect(done).not.toContain('setReload'); // the rule asks for the read, after every write
    const bar = read('src/components/admin/screens/leads/LeadsBulkBar.tsx');
    expect(bar).toContain('onDone(await post(body))');
    expect(bar).not.toContain('adminFetch');
  });

  it("a lead's page queues and bounds every read and write of the row", () => {
    const src = detail();
    // busy belongs to the queue alone: no write clears it before a follow-up read lands.
    expect(src).not.toMatch(/setBusy\((true|false)\)/);
    // The row's own route is fetched in three places (read, write, mark-read), each bounded.
    const calls = src.match(/adminFetch<LeadDetailRow>\(`\/api\/admin\/leads\/\$\{lead\.id\}`/g);
    expect(calls).toHaveLength(3);
    expect(src.match(/withDeadline\(\(signal\) =>\s*adminFetch<LeadDetailRow>/g)).toHaveLength(2);
    expect(src).toContain('const refetch = () => queue.run(() => readLead());');
    const write = between(src, 'function write(', '// A confirmation');
    expect(write).toContain('return writeInTurn(queue, {');
    expect(write).toMatch(
      /body: versioned \? \{ \.\.\.body, version: lead\.version \} : body,\s*signal,/,
    );
    const marked = between(src, 'if (marked.current', 'function openErase');
    expect(marked).toMatch(/void queue\.run\(\(\) =>\s*withDeadline\(/);
    expect(marked).toContain('body: { read: true }');
  });

  it("a lead's page reads again after a 409 (said) and after any failure (quiet)", () => {
    const write = between(detail(), 'function write(', '// A confirmation');
    expect(write).toContain('return !conflict;');
    expect(write).toMatch(
      /reread: async \(quiet\) => \{\s*await readLead\(quiet\);\s*void reloadEvents\(\);/,
    );
    // A failed reload says so (never dropped silently), unless a write's error is already up.
    expect(detail()).toMatch(/catch \(err\) \{\s*if \(!quiet\) setMessage\(\{ tone: 'err'/);
  });

  it("a lead's timeline draws only the newest reload's answer (LS2-4)", () => {
    const reload = between(detail(), 'async function reloadEvents', 'async function olderEvents');
    expect(reload).toContain('const controller = timeline.next();');
    expect(reload).toContain('{ signal: controller.signal }');
    const guard = reload.indexOf('if (controller.signal.aborted) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(reload.indexOf('setEvents('));
    const caught = reload.slice(reload.indexOf('catch (err)'));
    expect(caught.indexOf('if (controller.signal.aborted) return;')).toBeLessThan(
      caught.indexOf('setEventsError('),
    );
  });

  it('the board reads again after a failed move, and says what it came to (LS-R3)', () => {
    const src = board();
    const failed = between(src, '} else {\n        // The PATCH can fail', 'finally {');
    expect(failed).toContain('moveCheck.current = { id: card.id, name, to, detail };');
    expect(failed).toContain('setReload((n) => n + 1);');
    const effect = between(src, 'const loaded = useRef', '// After a move');
    expect(effect).toContain('settleMove(fresh);');
    expect(effect).toContain('settleMove(null);');
  });
});
