import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SAVEBAR_HEIGHT_PROPERTY,
  reserveSavebarSpace,
} from '@/components/admin/screens/release/savebarSpace';
import { BULKBAR_HEIGHT_PROPERTY } from '@/components/admin/kit/DataTable';
import { reserveBoxHeight } from '@/lib/admin/client/boxHeight';

// The room a page keeps under the fixed savebar (Admin v2 R14a; releases.md §7, WCAG 2.2
// 2.4.11). The first release-mode rehearsal found a screen's last Save under the bar at 1280 px:
// the CSS reserved a guessed 64 px while the bar was about 109 px on two rows, 22 px above the
// window's bottom. Now the bar's height is measured (this helper, run by Savebar while the fixed
// bar shows) and admin.css reserves it plus the inset, under the shown bar's gate only, so
// nothing changes with releases off. The browser half is tests/admin/releases-mode.e2e.ts
// ("the savebar keeps the page's last control and the bulk bar clear").

/** A ResizeObserver stand-in that remembers what it watches and lets the test resize. */
function fakeObserver() {
  const made: { callback: () => void; observed: unknown[]; disconnected: boolean }[] = [];
  class Observer {
    entry: (typeof made)[number];
    constructor(callback: () => void) {
      this.entry = { callback, observed: [], disconnected: false };
      made.push(this.entry);
    }
    observe(target: unknown) {
      this.entry.observed.push(target);
    }
    disconnect() {
      this.entry.disconnected = true;
    }
  }
  return { Observer, made };
}

function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
    },
  };
}

describe('reserveSavebarSpace', () => {
  it('writes the bar’s height at once, in whole pixels rounded up, and watches the bar', () => {
    const bar = { height: 108.2, getBoundingClientRect: () => ({ height: bar.height }) };
    const root = fakeRoot();
    const { Observer, made } = fakeObserver();
    reserveSavebarSpace(bar, root.style, Observer);
    expect(SAVEBAR_HEIGHT_PROPERTY).toBe('--ad-savebar-h');
    expect(root.props.get('--ad-savebar-h')).toBe('109px');
    expect(made).toHaveLength(1);
    expect(made[0]!.observed).toEqual([bar]);
  });

  it('follows the bar when it wraps or unwraps', () => {
    const bar = { height: 109, getBoundingClientRect: () => ({ height: bar.height }) };
    const root = fakeRoot();
    const { Observer, made } = fakeObserver();
    reserveSavebarSpace(bar, root.style, Observer);
    bar.height = 60;
    made[0]!.callback();
    expect(root.props.get('--ad-savebar-h')).toBe('60px');
    bar.height = 177.5;
    made[0]!.callback();
    expect(root.props.get('--ad-savebar-h')).toBe('178px');
  });

  it('a hidden or gone bar reserves nothing: stop disconnects and removes the property', () => {
    const bar = { getBoundingClientRect: () => ({ height: 109 }) };
    const root = fakeRoot();
    root.props.set('--ad-top-h', '64px');
    const { Observer, made } = fakeObserver();
    const stop = reserveSavebarSpace(bar, root.style, Observer);
    stop();
    expect(made[0]!.disconnected).toBe(true);
    expect(root.props.has('--ad-savebar-h')).toBe(false);
    // Only its own property: the topbar's measure stays.
    expect(root.props.get('--ad-top-h')).toBe('64px');
  });
});

describe('Savebar runs it for the fixed bar only, while it shows', () => {
  const source = readFileSync('src/components/admin/screens/release/Savebar.tsx', 'utf8');

  it('in a layout effect keyed on shown and inline, on the root’s style, with the real observer', () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*const bar = barRef\.current;\s*if \(!shown \|\| inline \|\| !bar \|\| typeof ResizeObserver === 'undefined'\) return;\s*return reserveSavebarSpace\(bar, document\.documentElement\.style, ResizeObserver\);\s*\}, \[shown, inline\]\);/,
    );
  });

  it('measures the bar itself (the region), not a wrapper', () => {
    expect(source).toMatch(/<div\s+ref=\{barRef\}\s+className="savebar"\s+role="region"/);
  });
});

describe('the bulk bar keeps its own measure (R14a review, CR-1)', () => {
  // Stuck above the shown savebar, the bulk bar covers a band of its own; admin.css adds its
  // measured height to the scroll padding while one shows (tests/lib/adminStyles.spec.ts), so a
  // row focused by the keyboard is not left behind it. The browser half is the drill's Tab walk
  // (tests/admin/releases-mode.e2e.ts, "room").
  it('writes the named property, rounded up, follows a resize and removes only its own', () => {
    const bar = { height: 59.4, getBoundingClientRect: () => ({ height: bar.height }) };
    const root = fakeRoot();
    root.props.set('--ad-savebar-h', '109px');
    const { Observer, made } = fakeObserver();
    const stop = reserveBoxHeight(bar, root.style, Observer, BULKBAR_HEIGHT_PROPERTY);
    expect(BULKBAR_HEIGHT_PROPERTY).toBe('--ad-bulkbar-h');
    expect(root.props.get('--ad-bulkbar-h')).toBe('60px');
    bar.height = 118;
    made[0]!.callback();
    expect(root.props.get('--ad-bulkbar-h')).toBe('118px');
    stop();
    expect(made[0]!.disconnected).toBe(true);
    expect(root.props.has('--ad-bulkbar-h')).toBe(false);
    expect(root.props.get('--ad-savebar-h')).toBe('109px');
  });

  const source = readFileSync('src/components/admin/kit/DataTable.tsx', 'utf8');

  it('BulkBar measures itself in a layout effect, on the root’s style, with the real observer', () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*const bar = barRef\.current;\s*if \(!bar \|\| typeof ResizeObserver === 'undefined'\) return;\s*return reserveBoxHeight\(\s*bar,\s*document\.documentElement\.style,\s*ResizeObserver,\s*BULKBAR_HEIGHT_PROPERTY,?\s*\);\s*\}, \[\]\);/,
    );
    expect(source).toMatch(/<div ref=\{barRef\} className="bulkbar" role="region"/);
  });
});
