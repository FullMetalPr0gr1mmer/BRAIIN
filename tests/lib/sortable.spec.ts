import { describe, expect, it } from 'vitest';
import {
  locate,
  moveItem,
  sameOrder,
  sortReducer,
  type SortAction,
  type SortContext,
  type SortLists,
  type SortState,
} from '@/lib/admin/client/sortable';

// The Sortable core's state machine (Admin v2 F4b, AV-07 "sortable.spec: keyboard state
// machine, cancel, announcements"). The DOM binder that drives it is exercised in a
// browser by tests/a11y/admin-kit.e2e.ts.

const LABELS: Record<string, string> = { hero: 'Hero', intro: 'Intro', work: 'Work', faq: 'FAQ' };
const one: SortContext = { order: ['list'], label: (id) => LABELS[id] ?? id };
const two: SortContext = {
  order: ['left', 'right'],
  label: (id) => LABELS[id] ?? id,
  listLabel: (key) => (key === 'left' ? 'Left column' : 'Right column'),
};

const start = (lists: SortLists): SortState => ({ lists, lifted: null });

/** Runs actions in order, collecting what each one announces and saves. */
function play(state: SortState, actions: SortAction[], ctx: SortContext) {
  const said: (string | null)[] = [];
  const saved: (SortLists | null)[] = [];
  for (const action of actions) {
    const result = sortReducer(state, action, ctx);
    state = result.state;
    said.push(result.announce);
    saved.push(result.commit);
  }
  return { state, said, saved };
}

describe('order helpers', () => {
  const lists = { left: ['hero', 'intro'], right: ['work'] };

  it('locates an item', () => {
    expect(locate(lists, 'intro')).toEqual({ list: 'left', index: 1 });
    expect(locate(lists, 'nope')).toBeNull();
  });

  it('moves an item, clamping the index, without touching the input', () => {
    expect(moveItem(lists, 'hero', 'right', 0)).toEqual({
      left: ['intro'],
      right: ['hero', 'work'],
    });
    expect(moveItem(lists, 'hero', 'right', 99)).toEqual({
      left: ['intro'],
      right: ['work', 'hero'],
    });
    expect(moveItem(lists, 'hero', 'left', -5)).toEqual(lists);
    expect(lists).toEqual({ left: ['hero', 'intro'], right: ['work'] });
  });

  it('compares orders', () => {
    expect(sameOrder(lists, { left: ['hero', 'intro'], right: ['work'] })).toBe(true);
    expect(sameOrder(lists, { left: ['intro', 'hero'], right: ['work'] })).toBe(false);
    expect(sameOrder({ a: [] }, {})).toBe(true);
  });
});

describe('keyboard: lift, move, drop', () => {
  const lists = { list: ['hero', 'intro', 'work', 'faq'] };

  it('announces the lift with the position and the keys', () => {
    const { state, said } = play(start(lists), [{ type: 'lift', id: 'intro' }], one);
    expect(state.lifted).toEqual({ id: 'intro', origin: lists });
    expect(said[0]).toBe(
      'Intro lifted, position 2 of 4. Use the arrow keys to move it, Space to drop it, or Escape to cancel.',
    );
  });

  it('announces each step, and saves only on the drop', () => {
    const { state, said, saved } = play(
      start(lists),
      [
        { type: 'lift', id: 'intro' },
        { type: 'step', delta: 1 },
        { type: 'step', delta: 1 },
        { type: 'drop' },
      ],
      one,
    );
    expect(said.slice(1)).toEqual([
      'Intro, position 3 of 4.',
      'Intro, position 4 of 4.',
      'Intro dropped, position 4 of 4.',
    ]);
    expect(saved).toEqual([null, null, null, { list: ['hero', 'work', 'faq', 'intro'] }]);
    expect(state).toEqual({ lists: { list: ['hero', 'work', 'faq', 'intro'] }, lifted: null });
  });

  it('says so at either end instead of moving', () => {
    const top = play(
      start(lists),
      [
        { type: 'lift', id: 'hero' },
        { type: 'step', delta: -1 },
      ],
      one,
    );
    expect(top.said[1]).toBe('Hero is already first.');
    expect(top.state.lists).toEqual(lists);
    const bottom = play(
      start(lists),
      [
        { type: 'lift', id: 'faq' },
        { type: 'step', delta: 1 },
      ],
      one,
    );
    expect(bottom.said[1]).toBe('FAQ is already last.');
  });

  it('a drop where it started saves nothing', () => {
    const { saved, said } = play(
      start(lists),
      [
        { type: 'lift', id: 'work' },
        { type: 'step', delta: -1 },
        { type: 'step', delta: 1 },
        { type: 'drop' },
      ],
      one,
    );
    expect(saved[3]).toBeNull();
    expect(said[3]).toBe('Work dropped, position 3 of 4.');
  });

  it('moves nothing unless something is lifted, and lifts one item at a time', () => {
    for (const action of [
      { type: 'step', delta: 1 },
      { type: 'shift', delta: 1 },
      { type: 'drop' },
      { type: 'cancel' },
      { type: 'place', list: 'list', index: 0 },
    ] as SortAction[]) {
      expect(sortReducer(start(lists), action, one)).toEqual({
        state: start(lists),
        announce: null,
        commit: null,
      });
    }
    const lifted = sortReducer(start(lists), { type: 'lift', id: 'hero' }, one).state;
    expect(sortReducer(lifted, { type: 'lift', id: 'faq' }, one).state).toBe(lifted);
    expect(sortReducer(start(lists), { type: 'lift', id: 'nope' }, one).announce).toBeNull();
  });

  it('only item: says so', () => {
    const { said } = play(
      start({ list: ['hero'] }),
      [
        { type: 'lift', id: 'hero' },
        { type: 'step', delta: 1 },
      ],
      one,
    );
    expect(said[1]).toBe('Hero is the only item.');
  });
});

describe('cancel', () => {
  const lists = { list: ['hero', 'intro', 'work'] };

  it('puts the item back where it was and says where', () => {
    const { state, said, saved } = play(
      start(lists),
      [
        { type: 'lift', id: 'hero' },
        { type: 'step', delta: 1 },
        { type: 'step', delta: 1 },
        { type: 'cancel' },
      ],
      one,
    );
    expect(state).toEqual({ lists, lifted: null });
    expect(said[3]).toBe('Reorder cancelled. Hero is back at position 1 of 3.');
    expect(saved.every((s) => s === null)).toBe(true);
  });
});

describe('several lists (the dashboard columns)', () => {
  const lists = { left: ['hero', 'intro'], right: ['work'] };

  it('shifts across lists at the same height and names the list', () => {
    const { state, said } = play(
      start(lists),
      [{ type: 'lift', id: 'intro' }, { type: 'shift', delta: 1 }, { type: 'drop' }],
      two,
    );
    expect(said[0]).toMatch(/^Intro lifted, position 2 of 2 in Left column\./);
    expect(said[1]).toBe('Intro, position 2 of 2 in Right column.');
    expect(state.lists).toEqual({ left: ['hero'], right: ['work', 'intro'] });
  });

  it('says so past the first or last list', () => {
    const { said } = play(
      start(lists),
      [
        { type: 'lift', id: 'hero' },
        { type: 'shift', delta: -1 },
      ],
      two,
    );
    expect(said[1]).toBe('Hero is already in the first list.');
    const last = play(
      start(lists),
      [
        { type: 'lift', id: 'work' },
        { type: 'shift', delta: 1 },
      ],
      two,
    );
    expect(last.said[1]).toBe('Work is already in the last list.');
  });
});

describe('pointer: place, then drop', () => {
  const lists = { left: ['hero', 'intro'], right: ['work'] };

  it('places silently while dragging and announces the drop', () => {
    const { state, said, saved } = play(
      start(lists),
      [
        { type: 'lift', id: 'hero' },
        { type: 'place', list: 'right', index: 0 },
        { type: 'place', list: 'right', index: 0 },
        { type: 'drop' },
      ],
      two,
    );
    expect(said[1]).toBeNull();
    expect(said[2]).toBeNull();
    expect(said[3]).toBe('Hero dropped, position 1 of 2 in Right column.');
    expect(saved[3]).toEqual({ left: ['intro'], right: ['hero', 'work'] });
    expect(state.lifted).toBeNull();
  });

  it('ignores a list that does not exist', () => {
    const lifted = sortReducer(start(lists), { type: 'lift', id: 'hero' }, two).state;
    expect(sortReducer(lifted, { type: 'place', list: 'nope', index: 0 }, two).state).toBe(lifted);
  });
});

describe('the Move buttons (WCAG 2.5.7: no drag needed)', () => {
  const lists = { left: ['hero', 'intro'], right: ['work'] };

  it('moves one place and saves at once', () => {
    const result = sortReducer(start(lists), { type: 'move', id: 'intro', delta: -1 }, two);
    expect(result.commit).toEqual({ left: ['intro', 'hero'], right: ['work'] });
    expect(result.announce).toBe('Intro moved to position 1 of 2 in Left column.');
    expect(result.state.lifted).toBeNull();
  });

  it('moves to the other list at the same height and saves at once', () => {
    const result = sortReducer(start(lists), { type: 'moveList', id: 'hero', delta: 1 }, two);
    expect(result.commit).toEqual({ left: ['intro'], right: ['hero', 'work'] });
    expect(result.announce).toBe('Hero moved to position 1 of 2 in Right column.');
  });

  it('at an edge, says so and saves nothing', () => {
    const result = sortReducer(start(lists), { type: 'move', id: 'hero', delta: -1 }, two);
    expect(result.commit).toBeNull();
    expect(result.announce).toBe('Hero is already first.');
  });

  it('does nothing while an item is lifted', () => {
    const lifted = sortReducer(start(lists), { type: 'lift', id: 'work' }, two).state;
    expect(sortReducer(lifted, { type: 'move', id: 'hero', delta: 1 }, two).commit).toBeNull();
  });
});
