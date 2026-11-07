import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entitySaveReducer, initialSaveState, queuedSaveDecision } from '@/lib/admin/entitySave';
import type { FieldDef } from '@/lib/admin/uiSchema';

// Admin v2 R14d review (SEC-1, SEC-2, C3, C4): the save hook's queue, driven for real. A save
// asked for while another is on its way waits for it; R14d made a press made meanwhile the
// person's own save once the first lands. The review found four ways that went wrong:
//
//   SEC-1  a second Ctrl/⌘+S during a create sent a second POST (a duplicate item, releases
//          off included), and with releases off a second press during a save sent a second
//          PATCH (before R14d it was answered by the first);
//   C3     a person's save refused before it was sent (a JSON box that does not parse) left the
//          press remembered, so the next automatic save landed as the person's and closed a
//          close-on-save drawer;
//   SEC-2  the hook's own automatic saves (the page editor's idle timer, a save asked for while
//   C4     one was on its way, the replayed press) went around the forms' checks: a box the
//          browser could not read, a site-wide noindex not yet confirmed.
//
// There is no DOM here, so React's four hooks the save hook uses are played by a small runtime
// (one component, effects after each render, a dispatch re-renders on the next microtask, as
// React batches it), and adminFetch is a queue of requests the test answers by hand.

type Row = Record<string, unknown>;

interface Sent {
  url: string;
  method: string;
  body: Row | undefined;
  resolve: (row: Row) => void;
  reject: (err: unknown) => void;
}

const net = vi.hoisted(() => ({ sent: [] as Sent[] }));

vi.mock('@/lib/admin/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/admin/client')>();
  return {
    ...real,
    adminFetch: (url: string, options: { method?: string; body?: unknown } = {}) =>
      new Promise((resolve, reject) => {
        net.sent.push({
          url,
          method: options.method ?? 'GET',
          body: options.body as Row | undefined,
          resolve,
          reject,
        });
      }),
  };
});

// ── a one-component React ──────────────────────────────────────────────────────────────────

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  effects: [] as { slot: number; effect: () => unknown }[],
  queued: false,
  draw: null as null | (() => void),
}));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const schedule = () => {
    if (rt.queued) return;
    rt.queued = true;
    queueMicrotask(() => {
      rt.queued = false;
      rt.draw?.();
    });
  };
  return {
    ...real,
    useRef: (initial: unknown) => {
      const k = rt.at++;
      rt.slots[k] ??= { current: initial };
      return rt.slots[k];
    },
    useReducer: (
      reducer: (state: unknown, action: unknown) => unknown,
      arg: unknown,
      init?: (arg: unknown) => unknown,
    ) => {
      const k = rt.at++;
      if (!rt.slots[k]) {
        const slot = { state: init ? init(arg) : arg, dispatch: (_: unknown) => undefined };
        slot.dispatch = (action: unknown) => {
          slot.state = reducer(slot.state, action);
          schedule();
          return undefined;
        };
        rt.slots[k] = slot;
      }
      const slot = rt.slots[k] as { state: unknown; dispatch: (action: unknown) => void };
      return [slot.state, slot.dispatch];
    },
    useCallback: (fn: unknown, deps: readonly unknown[]) => {
      const k = rt.at++;
      const slot = rt.slots[k] as { fn: unknown; deps: readonly unknown[] } | undefined;
      if (slot && same(slot.deps, deps)) return slot.fn;
      rt.slots[k] = { fn, deps };
      return fn;
    },
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const k = rt.at++;
      const slot = rt.slots[k] as { deps?: readonly unknown[]; cleanup?: unknown } | undefined;
      if (slot && same(slot.deps, deps)) return;
      rt.effects.push({ slot: k, effect });
      rt.slots[k] = { deps, cleanup: slot?.cleanup };
    },
  };
});

// The page's window: timers the test fires by hand (the idle save), events that go nowhere.
const timers = new Map<number, { fn: () => void; ms: number }>();
let timerId = 0;
/** Fires every timer set so far (the idle save's 800 ms have passed). */
function elapse(): void {
  for (const [id, timer] of [...timers]) {
    timers.delete(id);
    timer.fn();
  }
}
(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => {
    timerId += 1;
    timers.set(timerId, { fn, ms });
    return timerId;
  },
  clearTimeout: (id: number) => timers.delete(id),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  location: { search: '', href: '', pathname: '/admin/faqs' },
};

const { useEntitySave } = await import('@/lib/admin/useEntitySave');
type Hook = ReturnType<typeof useEntitySave>;

const FIELDS: FieldDef[] = [
  { name: 'slug', label: 'Slug', kind: 'text' },
  { name: 'extra', label: 'Extra', kind: 'json' },
];

/** Mounts the hook once and keeps its latest answer. */
function mount(...args: Parameters<typeof useEntitySave>): { now: () => Hook } {
  let latest: Hook | null = null;
  rt.draw = () => {
    rt.at = 0;
    rt.effects = [];
    latest = useEntitySave(...args);
    for (const { slot, effect } of rt.effects) {
      const holder = rt.slots[slot] as { cleanup?: unknown };
      if (typeof holder.cleanup === 'function') (holder.cleanup as () => void)();
      holder.cleanup = effect();
    }
  };
  rt.draw();
  return { now: () => latest! };
}

/** Lets every answered request land and every render and effect run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const writes = () => net.sent.filter((s) => s.method !== 'GET');
const LIVE = { id: 'r1', slug: 'a', extra: {}, version: 3 };
const DRAFT_MODE = { ...LIVE, draft: null };
const pending = (version: number) => ({ id: 'd1', version, op: 'update' });

/** An existing record, loaded from `row`. */
async function existing(row: Row, extra: Partial<Parameters<typeof useEntitySave>[2]> = {}) {
  const hook = mount({ kind: 'resource', slug: 'faqs' }, 'r1', { fields: FIELDS, ...extra });
  await settle();
  const load = net.sent.find((s) => s.method === 'GET');
  expect(load?.url).toBe('/api/admin/faqs/r1');
  load!.resolve(row);
  await settle();
  expect(hook.now().busy).toBe(false);
  return hook;
}

beforeEach(() => {
  net.sent.length = 0;
  rt.slots = [];
  rt.at = 0;
  rt.effects = [];
  rt.queued = false;
  timers.clear();
});
afterEach(() => {
  rt.draw = null;
});

describe('SEC-1: a press while a save is on its way is never a second write of the same thing', () => {
  for (const staged of [false, true]) {
    it(`two presses during one create make exactly one POST (${staged ? 'release mode' : 'releases off'})`, async () => {
      const onCreated = vi.fn();
      const hook = mount({ kind: 'resource', slug: 'faqs', staged }, null, {
        fields: FIELDS,
        onCreated,
      });
      hook.now().set('slug', 'new-question');
      await settle();
      void hook.now().save();
      await settle();
      expect(writes().map((w) => w.method)).toEqual(['POST']);
      // Ctrl/⌘+S again (or held: every key repeat is a press), and a blur.
      expect(await hook.now().save()).toBe(false);
      expect(await hook.now().save()).toBe(false);
      hook.now().flush?.();
      writes()[0]!.resolve({
        id: 'n1',
        slug: 'new-question',
        ...(staged ? { draft: { id: 'd1', version: 1, op: 'create' } } : {}),
      });
      await settle();
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(writes()).toHaveLength(1);
      // And it stays that way: nothing was left queued for a later landing.
      hook.now().set('slug', 'new-question');
      await settle();
      expect(writes()).toHaveLength(1);
    });
  }

  it('releases off: a second press during a save is answered by it, as before R14d', async () => {
    const hook = await existing(LIVE);
    hook.now().set('slug', 'b');
    await settle();
    void hook.now().save();
    await settle();
    expect(await hook.now().save()).toBe(false);
    writes()[0]!.resolve({ ...LIVE, slug: 'b', version: 4 });
    await settle();
    expect(writes().map((w) => w.method)).toEqual(['PATCH']);
    expect(hook.now().status).toBe('saved');
  });
});

describe('R14d kept: in release mode a press during an automatic save is the person’s', () => {
  it('nothing typed since: the automatic save answers it, once, and lands as theirs', async () => {
    const hook = await existing(DRAFT_MODE);
    hook.now().set('slug', 'b');
    await settle();
    hook.now().flush?.();
    await settle();
    expect(await hook.now().save()).toBe(false);
    writes()[0]!.resolve({ ...LIVE, slug: 'b', draft: pending(1) });
    await settle();
    expect(writes()).toHaveLength(1);
    expect(hook.now().savedByPerson).toBe(true);
  });

  it('typed since: the person’s own save follows with what they typed, and lands as theirs', async () => {
    const hook = await existing(DRAFT_MODE);
    hook.now().set('slug', 'b');
    await settle();
    hook.now().flush?.();
    await settle();
    expect(await hook.now().save()).toBe(false);
    hook.now().set('slug', 'c');
    await settle();
    writes()[0]!.resolve({ ...LIVE, slug: 'b', draft: pending(1) });
    await settle();
    expect(hook.now().savedByPerson).toBe(false);
    expect(writes()).toHaveLength(2);
    expect(writes()[1]!.body).toMatchObject({ slug: 'c', draftId: 'd1', draftVersion: 1 });
    writes()[1]!.resolve({ ...LIVE, slug: 'c', draft: pending(2) });
    await settle();
    expect(hook.now().savedByPerson).toBe(true);
    expect(writes()).toHaveLength(2);
  });
});

describe('C3: a person’s save refused before it was sent answers their press', () => {
  it('the next automatic save is not the person’s (a close-on-save drawer stays open)', async () => {
    const hook = await existing(DRAFT_MODE);
    hook.now().set('extra', '{not json');
    await settle();
    expect(await hook.now().save()).toBe(false);
    expect(hook.now().message).toBe('Extra is not valid JSON.');
    expect(writes()).toHaveLength(0);
    // The box is put right, a field is left: release mode saves by itself.
    hook.now().set('extra', '{}');
    hook.now().set('slug', 'b');
    await settle();
    hook.now().flush?.();
    await settle();
    expect(writes()).toHaveLength(1);
    writes()[0]!.resolve({ ...LIVE, slug: 'b', draft: pending(1) });
    await settle();
    expect(hook.now().savedByPerson).toBe(false);
  });
});

describe('SEC-2 / C4: every save the hook starts by itself asks the forms’ checks first', () => {
  it('the idle timer waits while a check says so (the page editor’s 800 ms save)', async () => {
    let unreadable = true;
    const hook = await existing(DRAFT_MODE, { autosave: { idleMs: 800 } });
    const off = hook.now().addAutoSaveVeto!(() => unreadable);
    hook.now().set('slug', 'b');
    await settle();
    expect([...timers.values()].some((t) => t.ms === 800)).toBe(true);
    elapse();
    await settle();
    expect(writes()).toHaveLength(0);
    unreadable = false;
    hook.now().set('slug', 'c');
    await settle();
    elapse();
    await settle();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toMatchObject({ slug: 'c' });
    // Taken off, it no longer asks.
    off();
    unreadable = true;
    writes()[0]!.resolve({ ...LIVE, slug: 'c', draft: pending(1) });
    await settle();
    hook.now().set('slug', 'd');
    await settle();
    elapse();
    await settle();
    expect(writes()).toHaveLength(2);
  });

  it('a save asked for while one was on its way checks the values it would send then', async () => {
    // SiteWideForm's check: a site-wide noindex not yet confirmed.
    const hook = await existing(DRAFT_MODE);
    hook.now().addAutoSaveVeto!((values) => values['slug'] === 'noindex');
    hook.now().set('slug', 'b');
    await settle();
    hook.now().flush?.();
    await settle();
    // A second blur while it is on its way (the check passes: nothing hides the site yet).
    hook.now().set('slug', 'c');
    await settle();
    hook.now().flush?.();
    // Then the robots value moves to noindex before the first save lands.
    hook.now().set('slug', 'noindex');
    await settle();
    writes()[0]!.resolve({ ...LIVE, slug: 'b', draft: pending(1) });
    await settle();
    expect(writes()).toHaveLength(1);
    expect(hook.now().dirty).toBe(true);
  });

  it('so does the person’s press replayed once the save it waited for lands', async () => {
    const hook = await existing(DRAFT_MODE);
    hook.now().addAutoSaveVeto!((values) => values['slug'] === 'noindex');
    hook.now().set('slug', 'b');
    await settle();
    hook.now().flush?.();
    await settle();
    expect(await hook.now().save()).toBe(false);
    hook.now().set('slug', 'noindex');
    await settle();
    writes()[0]!.resolve({ ...LIVE, slug: 'b', draft: pending(1) });
    await settle();
    expect(writes()).toHaveLength(1);
    // The press is answered (it waits for the person's own Save, which the form guards): a
    // later automatic save is not theirs.
    hook.now().set('slug', 'e');
    await settle();
    hook.now().flush?.();
    await settle();
    expect(writes()).toHaveLength(2);
    writes()[1]!.resolve({ ...LIVE, slug: 'e', draft: pending(2) });
    await settle();
    expect(hook.now().savedByPerson).toBe(false);
  });

  it('the person’s own Save is the form’s to guard: the hook never vetoes it', async () => {
    const hook = await existing(DRAFT_MODE);
    hook.now().addAutoSaveVeto!(() => true);
    hook.now().set('slug', 'b');
    await settle();
    void hook.now().save();
    await settle();
    expect(writes()).toHaveLength(1);
  });
});

describe('queuedSaveDecision (entitySave.ts)', () => {
  const fields: FieldDef[] = [{ name: 'slug', label: 'Slug', kind: 'text' }];
  const loaded = (row: Row) =>
    entitySaveReducer(initialSaveState(fields, false), {
      type: 'loaded',
      row,
      fields,
      versionFallback: 1,
    });

  it('never for a new record, never with releases off', () => {
    const created = entitySaveReducer(
      entitySaveReducer(initialSaveState(fields, true), { type: 'set', name: 'slug', value: 'x' }),
      { type: 'created', at: 'now', navigating: false },
    );
    expect(queuedSaveDecision(created, true, true)).toBe('none');
    const live = entitySaveReducer(loaded({ id: 'r1', slug: 'a', version: 1 }), {
      type: 'set',
      name: 'slug',
      value: 'b',
    });
    expect(queuedSaveDecision(live, false, true)).toBe('none');
  });

  it('release mode: the person’s save over something new, else the automatic rules', () => {
    const clean = loaded({ id: 'r1', slug: 'a', version: 1, draft: null });
    const typed = entitySaveReducer(clean, { type: 'set', name: 'slug', value: 'b' });
    expect(queuedSaveDecision(typed, false, true)).toBe('person');
    expect(queuedSaveDecision(clean, false, true)).toBe('auto');
    expect(queuedSaveDecision(typed, false, false)).toBe('auto');
  });
});

describe('the forms add their checks', () => {
  it('EditorForm: a box the browser could not read', () => {
    const src = readFileSync('src/components/admin/fields/EditorForm.tsx', 'utf8');
    expect(src).toContain('const addVeto = save.addAutoSaveVeto;');
    expect(src).toContain(
      'useEffect(() => addVeto?.(() => unreadableIn(formRef.current).length > 0), [addVeto]);',
    );
  });

  it('SiteWideForm: a site-wide noindex not yet confirmed', () => {
    const src = readFileSync('src/components/admin/screens/seo/SiteWideForm.tsx', 'utf8');
    expect(src).toMatch(
      /addVeto\?\.\(\(values\) => needsConfirmation\(committed\.current\[ROBOTS\], values\[ROBOTS\]\)\)/,
    );
    // EditorForm is handed the guarded save, which carries the hook's addAutoSaveVeto.
    expect(src).toContain('...save,');
    expect(src).toContain('save={guarded}');
  });
});
