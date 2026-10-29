import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ListWrites, Serial } from '@/lib/crm/lateAnswers';

// The leads screens' late answers (C4 star race): a list read that left before a star press
// answered after the star was saved and drew it off again while the database had it on (R13's
// e2e met it). Each case below replays one order of events through the rule the island uses;
// the last block checks the islands are wired to it (they render with react-dom/server only).

describe('ListWrites (the leads list)', () => {
  it('the R13 order: a read out when the star is pressed is aborted, and read again after', () => {
    const w = new ListWrites();
    const search = w.read()!; // the search leaves
    const star = w.write(); // the star is pressed: the search is aborted
    expect(search.signal.aborted).toBe(true);
    expect(w.landed(search)).toBe(false); // its rows (star off) are never used
    expect(w.written(star, true)).toBe(true); // saved: read the list once more
    const again = w.read()!;
    expect(again.signal.aborted).toBe(false);
    expect(w.landed(again)).toBe(true);
  });

  it('a single press with no read out needs no read: the screen already shows it', () => {
    const w = new ListWrites();
    const star = w.write();
    expect(w.written(star, true)).toBe(false);
    expect(w.landed(w.read()!)).toBe(true);
  });

  it('two quick presses answering in send order: the last press stands, no read', () => {
    const w = new ListWrites();
    const on = w.write();
    const off = w.write();
    expect(w.written(on, true)).toBe(false);
    expect(w.written(off, true)).toBe(false);
  });

  it('two quick presses answering out of send order: the list is read again (LS-3)', () => {
    const w = new ListWrites();
    const on = w.write();
    const off = w.write();
    expect(w.written(off, true)).toBe(false); // "on" is still out
    expect(w.written(on, true)).toBe(true); // which ran last is unknown: the server says
  });

  it('a press again after the first answered out of order still reads (no state kept)', () => {
    const w = new ListWrites();
    const a = w.write();
    const b = w.write();
    expect(w.written(b, true)).toBe(false);
    expect(w.written(a, true)).toBe(true);
    const c = w.write(); // the next press starts clean
    expect(w.written(c, true)).toBe(false);
  });

  it('a failed save is read again: the PATCH may have committed before it failed (LS-4)', () => {
    const w = new ListWrites();
    const star = w.write();
    expect(w.written(star, false)).toBe(true);
  });

  it('a failed save while another press is out: one read, once both have answered', () => {
    const w = new ListWrites();
    const on = w.write();
    const off = w.write();
    expect(w.written(on, false)).toBe(false); // "off" still out: no read over it yet
    expect(w.written(off, true)).toBe(true);
    expect(w.written(w.write(), true)).toBe(false); // and the flag does not linger
  });

  it('a bulk action mid-press: one read after both, in either answer order', () => {
    for (const bulkFirst of [true, false]) {
      const w = new ListWrites();
      const search = w.read()!;
      const star = w.write();
      const bulk = w.write(); // the bulk bar's POST is a row write too
      expect(search.signal.aborted).toBe(true);
      // The bulk answers "not shown" (its rows change only through a read); the star "shown".
      const answers: [number, boolean][] = bulkFirst
        ? [
            [bulk, false],
            [star, true],
          ]
        : [
            [star, true],
            [bulk, false],
          ];
      const results = answers.map(([token, shown]) => w.written(token, shown));
      expect(results).toEqual([false, true]); // nothing while the other is out, then one read
    }
  });

  it('a bulk action alone is read again (it is not optimistic)', () => {
    const w = new ListWrites();
    expect(w.written(w.write(), false)).toBe(true);
  });

  it('a press while a bulk action is out holds the bulk read until both answered', () => {
    const w = new ListWrites();
    const bulk = w.write();
    const star = w.write();
    expect(w.written(bulk, false)).toBe(false);
    expect(w.read()).toBeNull(); // the read bulkDone asks for is held
    expect(w.written(star, true)).toBe(true);
  });

  it('a filter change while a star is out: the read is held, then read once', () => {
    const w = new ListWrites();
    const star = w.write();
    expect(w.read()).toBeNull(); // the filter's read waits for the star
    expect(w.written(star, true)).toBe(true); // ...and is asked for now, with the filters then
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
    expect(w.written(w.write(), true)).toBe(false);
  });

  it('a press while the read after the writes is out aborts it, and reads once more', () => {
    const w = new ListWrites();
    expect(w.written(w.write(), false)).toBe(true);
    const again = w.read()!;
    const star = w.write();
    expect(again.signal.aborted).toBe(true);
    expect(w.landed(again)).toBe(false);
    expect(w.written(star, true)).toBe(true);
  });

  it('a read that answered before the press is kept and asks for nothing', () => {
    const w = new ListWrites();
    const read = w.read()!;
    expect(w.landed(read)).toBe(true);
    const star = w.write();
    expect(read.signal.aborted).toBe(false);
    expect(w.written(star, true)).toBe(false);
  });
});

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

describe("Serial (a lead's page)", () => {
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
    const b = q.run(async () => {
      sent.push('star');
      shown.push(await star.promise);
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
    const move = q.run(async () => {
      sentWith.push(version);
      try {
        version = await patch.promise;
        return true;
      } catch {
        version = await reload.promise; // the reload, inside the write's turn
        return false;
      }
    });
    const next = q.run(async () => {
      sentWith.push(version);
      return true;
    });
    patch.reject(new Error('409'));
    await tick();
    expect(busy).toEqual([true]); // the reload is out: still busy
    expect(sentWith).toEqual([1]); // nothing else has left
    reload.resolve(2);
    expect(await move).toBe(false);
    expect(await next).toBe(true);
    expect(sentWith).toEqual([1, 2]);
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

describe('the islands use the rules', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const list = () => read('src/components/admin/screens/leads/LeadsList.tsx');
  const detail = () => read('src/components/admin/screens/leads/LeadDetail.tsx');

  it('the list takes its read from the rule, held while a write is out', () => {
    const src = list();
    expect(src).toMatch(
      /const controller = writes\.current\.read\(\);\s*if \(!controller\) return;/,
    );
    const effect = src.slice(src.indexOf('const listed = useRef'), src.indexOf('const summarised'));
    expect(effect).not.toContain('new AbortController()'); // the read's controller is the rule's
  });

  it('the list uses an answer only when its read was not aborted, rows and errors alike', () => {
    const src = list();
    expect(src).toMatch(
      /\.then\(\(page\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(!writes\.current\.landed\(controller\)\) return;\s*setRows\(asRows\(page\)\);/,
    );
    expect(src).toMatch(
      /\.catch\(\(err: unknown\) => \{\s*if \(!writes\.current\.landed\(controller\)\) return;/,
    );
  });

  it('a star is a write: sent through the rule, kept on failure, the read decides', () => {
    const src = list();
    const star = src.slice(
      src.indexOf('async function toggleStar'),
      src.indexOf('async function postBulk'),
    );
    expect(star).toMatch(/const token = writes\.current\.write\(\);[\s\S]*method: 'PATCH'/);
    expect(star).toContain('written(token, ok);');
    expect(star).not.toContain('!next'); // no local roll back: a failed PATCH may have committed
  });

  it('a bulk action is a write: the list posts it through the rule and reads after it', () => {
    const src = list();
    expect(src).toMatch(
      /async function postBulk[\s\S]*const token = writes\.current\.write\(\);\s*try \{\s*return await adminFetch<BulkOutcome>\('\/api\/admin\/leads\/bulk'[\s\S]*finally \{\s*written\(token, false\);/,
    );
    expect(src).toContain('post={postBulk}');
    const done = src.slice(src.indexOf('function bulkDone'), src.indexOf('const counts ='));
    expect(done).not.toContain('setReload'); // the rule asks for the read, after every write
    const bar = read('src/components/admin/screens/leads/LeadsBulkBar.tsx');
    expect(bar).toContain('onDone(await post(body))');
    expect(bar).not.toContain('adminFetch');
  });

  it("a lead's page queues every read and write of the row", () => {
    const src = detail();
    expect(src).toContain('const queue = useRef(new Serial(setBusy));');
    // busy belongs to the queue alone: no write clears it before a follow-up read lands.
    expect(src).not.toMatch(/setBusy\((true|false)\)/);
    // The row's own route is fetched in three places: the read, the write, the mark-read.
    const calls = src.match(/adminFetch<LeadDetailRow>\(`\/api\/admin\/leads\/\$\{lead\.id\}`/g);
    expect(calls).toHaveLength(3);
    expect(src).toMatch(/const refetch = \(\) => queue\.current\.run\(\(\) => readLead\(\)\);/);
    expect(src).toMatch(
      /return queue\.current\.run\(async \(\) => \{\s*try \{\s*const answer = await adminFetch<LeadDetailRow>/,
    );
    expect(src).toMatch(
      /void queue\.current\.run\(\(\) =>\s*adminFetch<LeadDetailRow>\(`\/api\/admin\/leads\/\$\{lead\.id\}`, \{\s*method: 'PATCH',\s*body: \{ read: true \}/,
    );
  });

  it("a lead's page reads again inside the write's turn after a 409 and after any failure", () => {
    const src = detail();
    expect(src).toMatch(
      /status === 409\) \{\s*setMessage\(\{ tone: 'warn', text: CONFLICT \}\);\s*await readLead\(\);/,
    );
    expect(src).toMatch(
      /\} else \{\s*setMessage\(\{ tone: 'err', text: describeError\(err\) \}\);\s*await readLead\(true\);/,
    );
    // A failed reload says so (never dropped silently), unless a write's error is already up.
    expect(src).toMatch(/catch \(err\) \{\s*if \(!quiet\) setMessage\(\{ tone: 'err'/);
  });
});
