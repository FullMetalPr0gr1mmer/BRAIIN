import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION_CLASS,
  MOTION_EVENT,
  MOTION_KEY,
  isMotionPaused,
  onMotionChange,
  parseStoredMotion,
  readStoredMotion,
  serializeMotion,
  setMotionPaused,
  writeStoredMotion,
} from '@/lib/client/motion';

// Round 3 (R3-7): the sitewide motion switch behind the header pause button. The pure
// parts are tested as values; the DOM parts run against a minimal stand-in for
// `document` (an EventTarget with a body classList) — there is no jsdom in this suite,
// and the contract here is the class + the event, not layout.

describe('parseStoredMotion / serializeMotion', () => {
  it('only the literal "paused" pauses', () => {
    expect(parseStoredMotion('paused')).toBe(true);
    expect(parseStoredMotion('playing')).toBe(false);
    expect(parseStoredMotion(null)).toBe(false);
    expect(parseStoredMotion(undefined)).toBe(false);
    expect(parseStoredMotion('')).toBe(false);
    expect(parseStoredMotion('PAUSED')).toBe(false);
    expect(parseStoredMotion('true')).toBe(false);
  });

  it('round-trips through the stored value', () => {
    expect(serializeMotion(true)).toBe('paused');
    expect(serializeMotion(false)).toBe('playing');
    expect(parseStoredMotion(serializeMotion(true))).toBe(true);
    expect(parseStoredMotion(serializeMotion(false))).toBe(false);
  });

  it('keeps the key the removed hero control used (a returning tab reads its own choice)', () => {
    expect(MOTION_KEY).toBe('bs_motion');
  });
});

describe('storage', () => {
  const g = globalThis as { sessionStorage?: unknown };
  afterEach(() => {
    delete g.sessionStorage;
  });

  it('reads and writes the tab store', () => {
    const store = new Map<string, string>();
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readStoredMotion()).toBe(false);
    writeStoredMotion(true);
    expect(store.get(MOTION_KEY)).toBe('paused');
    expect(readStoredMotion()).toBe(true);
    writeStoredMotion(false);
    expect(readStoredMotion()).toBe(false);
  });

  it('a throwing store (private window, blocked site data) is playing and a no-op write', () => {
    g.sessionStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readStoredMotion()).toBe(false);
    expect(() => writeStoredMotion(true)).not.toThrow();
  });

  it('no store at all is playing', () => {
    expect(readStoredMotion()).toBe(false);
    expect(() => writeStoredMotion(true)).not.toThrow();
  });
});

describe('the body class and the motion-updated event', () => {
  const g = globalThis as { document?: unknown };
  let classes: Set<string>;

  beforeEach(() => {
    classes = new Set();
    const doc = new EventTarget() as EventTarget & { body: { classList: unknown } };
    doc.body = {
      classList: {
        contains: (c: string) => classes.has(c),
        toggle: (c: string, force: boolean) => {
          if (force) classes.add(c);
          else classes.delete(c);
          return force;
        },
      },
    };
    g.document = doc;
  });
  afterEach(() => {
    delete g.document;
  });

  it('setMotionPaused toggles the class and notifies subscribers with the new state', () => {
    const seen: boolean[] = [];
    const off = onMotionChange((p) => seen.push(p));
    setMotionPaused(true);
    expect(classes.has(MOTION_CLASS)).toBe(true);
    expect(isMotionPaused()).toBe(true);
    setMotionPaused(false);
    expect(classes.has(MOTION_CLASS)).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
    setMotionPaused(true);
    expect(seen).toEqual([true, false]);
  });

  it('is idempotent: restoring the state the page already has dispatches nothing', () => {
    const spy = vi.fn();
    (g.document as EventTarget).addEventListener(MOTION_EVENT, spy);
    setMotionPaused(false);
    expect(spy).not.toHaveBeenCalled();
    setMotionPaused(true);
    setMotionPaused(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the class is the state the CSS loops pause on', () => {
    expect(MOTION_CLASS).toBe('motion-paused');
  });
});
