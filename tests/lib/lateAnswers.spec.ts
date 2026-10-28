import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnswerOrder, RowToggles, withField } from '@/lib/crm/lateAnswers';

// The leads screens' late answers (C4 star race): a list read that left before a star press
// answered after the star was saved and drew it off again while the database had it on (R13's
// e2e met it). Each case below replays one order of events through the model the islands use.

const A = 'lead-a';
const B = 'lead-b';
type Row = { id: string; is_starred: boolean; name: string };
const rows = (starA = false, starB = false): Row[] => [
  { id: A, is_starred: starA, name: 'Nora' },
  { id: B, is_starred: starB, name: 'Omar' },
];
const starOf = (list: Row[] | null, id: string) => list?.find((r) => r.id === id)?.is_starred;

describe('RowToggles (the leads list)', () => {
  it('keeps a star saved while a read that left before it was out (the R13 order)', () => {
    const t = new RowToggles();
    const read = t.read(); // the search leaves
    const token = t.begin(A, 'is_starred', true, false); // the star is pressed
    expect(t.settle(token, true)).toEqual({ id: A, field: 'is_starred', value: true }); // saved
    // The search answers with what it read before the star: off.
    expect(starOf(t.answer(rows(false), read), A)).toBe(true);
  });

  it('keeps a star whose write is still out when a read answers', () => {
    const t = new RowToggles();
    const read = t.read();
    t.begin(A, 'is_starred', true, false);
    expect(starOf(t.answer(rows(false), read), A)).toBe(true);
  });

  it('keeps it over a read that left while the write was out, then lets a later read decide', () => {
    const t = new RowToggles();
    const token = t.begin(A, 'is_starred', true, false);
    const during = t.read(); // left before the write answered: it may or may not hold it
    t.settle(token, true);
    expect(starOf(t.answer(rows(false), during), A)).toBe(true);
    // A read that left after the write answered holds the server's value, whatever it is
    // (a colleague may have changed it since): the toggle no longer overrides it.
    const after = t.read();
    expect(starOf(t.answer(rows(false), after), A)).toBe(false);
    expect(starOf(t.answer(rows(true), t.read()), A)).toBe(true);
  });

  it('drops an answer older than one already used', () => {
    const t = new RowToggles();
    const old = t.read();
    const fresh = t.read();
    expect(t.answer(rows(true), fresh)).not.toBeNull();
    expect(t.answer(rows(false), old)).toBeNull();
  });

  it('touches only the toggled row and field', () => {
    const t = new RowToggles();
    const read = t.read();
    t.begin(A, 'is_starred', true, false);
    const shown = t.answer(rows(false, true), read);
    expect(shown).toEqual([
      { id: A, is_starred: true, name: 'Nora' },
      { id: B, is_starred: true, name: 'Omar' },
    ]);
  });

  it('a failed write puts back what the server holds, and a late answer does not re-show it', () => {
    const t = new RowToggles();
    const read = t.read();
    const token = t.begin(A, 'is_starred', true, false);
    expect(t.settle(token, false)).toEqual({ id: A, field: 'is_starred', value: false });
    expect(starOf(t.answer(rows(false), read), A)).toBe(false);
  });

  it('two presses: the answer of each waits for the other, the last saved value wins', () => {
    const t = new RowToggles();
    const read = t.read();
    const on = t.begin(A, 'is_starred', true, false);
    const off = t.begin(A, 'is_starred', false, true);
    expect(t.settle(on, true)).toBeNull(); // another press is out: its answer decides
    expect(starOf(t.answer(rows(true), read), A)).toBe(false); // shows the last press
    expect(t.settle(off, true)).toEqual({ id: A, field: 'is_starred', value: false });
  });

  it('two presses, the second failing: back to what the first saved', () => {
    const t = new RowToggles();
    const on = t.begin(A, 'is_starred', true, false);
    const off = t.begin(A, 'is_starred', false, true);
    expect(t.settle(on, true)).toBeNull();
    expect(t.settle(off, false)).toEqual({ id: A, field: 'is_starred', value: true });
  });

  it('two presses, both failing: back to the value before the first', () => {
    const t = new RowToggles();
    const on = t.begin(A, 'is_starred', true, false);
    const off = t.begin(A, 'is_starred', false, true);
    expect(t.settle(off, false)).toBeNull();
    expect(t.settle(on, false)).toEqual({ id: A, field: 'is_starred', value: false });
  });

  it('an unknown token changes nothing', () => {
    const t = new RowToggles();
    expect(t.settle(42, true)).toBeNull();
  });

  it('withField sets one row only', () => {
    expect(withField(rows(), B, 'is_starred', true)).toEqual(rows(false, true));
  });
});

describe('AnswerOrder (a lead page)', () => {
  it('drops the mark-read answer that arrives after a star was saved', () => {
    const o = new AnswerOrder();
    const markRead = o.send(); // on opening
    const star = o.send();
    expect(o.accept(star, true)).toBe(true);
    expect(o.accept(markRead, true)).toBe(false);
  });

  it('keeps a star saved after the mark-read sent before it answered (either order)', () => {
    const o = new AnswerOrder();
    const markRead = o.send();
    const star = o.send();
    expect(o.accept(markRead, true)).toBe(true);
    expect(o.accept(star, true)).toBe(true);
  });

  it('drops a read sent before a write that answered first, then a read sent after is kept', () => {
    const o = new AnswerOrder();
    const refetch = o.send(); // after Log contact
    const star = o.send();
    expect(o.accept(star, true)).toBe(true);
    expect(o.accept(refetch, false)).toBe(false);
    expect(o.accept(o.send(), false)).toBe(true); // the island's one more read
  });

  it('drops a refetch sent while a write was out when the write answers first', () => {
    const o = new AnswerOrder();
    const write = o.send();
    const refetch = o.send();
    expect(o.accept(write, true)).toBe(true);
    expect(o.accept(refetch, false)).toBe(false);
  });

  it('keeps answers that arrive in order, and a read sent after a write', () => {
    const o = new AnswerOrder();
    const refetch = o.send();
    expect(o.accept(refetch, false)).toBe(true);
    const write = o.send();
    expect(o.accept(write, true)).toBe(true);
    const after = o.send();
    expect(o.accept(after, false)).toBe(true);
  });
});

describe('the islands use the model', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  it('the list lays its toggles over every list answer and settles its star through them', () => {
    const src = read('src/components/admin/screens/leads/LeadsList.tsx');
    expect(src).toContain('toggles.current.read()');
    expect(src).toContain('toggles.current.answer(asRows(page), stamp)');
    expect(src).toContain("toggles.current.begin(row.id, 'is_starred'");
    expect(src).toContain('toggles.current.settle(token, ok)');
    // No bare replacement of the rows by an answer.
    expect(src).not.toMatch(/setRows\(asRows\(/);
  });

  it("a lead's page sends every read and write of the row through one order", () => {
    const src = read('src/components/admin/screens/leads/LeadDetail.tsx');
    expect(src).not.toMatch(/\.then\(setLead\)/);
    expect(src).not.toMatch(/setLead\(await /);
    const sets = src.match(/setLead\(/g) ?? [];
    const guarded = src.match(/order\.current\.accept\([^)]*\)\) setLead\(/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(sets.length);
  });
});
