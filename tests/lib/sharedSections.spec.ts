import { describe, it, expect } from 'vitest';
import { splitAccent, accentRange } from '@/lib/text/accent';
import { galleryLayout } from '@/lib/portfolio/gallery';
import { clipWindow, clipsAllowed, hoverStartsClip, seekTarget } from '@/lib/client/clips';
import { countValue, easeOutCubic, COUNT_DURATION_MS } from '@/lib/client/countUp';
import { carouselRunning, focusEntryStops, step, type CarouselFlags } from '@/lib/client/carousel';
import { toggleFacet } from '@/lib/portfolio/catalog';

// The pure halves of the UI v2 shared components (PR6). The DOM halves are exercised by the
// page e2e suites that compose them (PR7+).

const accented = (text: string, from: number, to?: number) =>
  splitAccent(text, { from, ...(to === undefined ? {} : { to }) })
    .map((r) => (r.accent ? `[${r.text}]` : r.text))
    .join('');

describe('splitAccent — a word range, anywhere in the heading', () => {
  it('accents mid-line, keeping the edge spaces outside', () => {
    expect(accented('Ideas that leave the brain and land in the world.', 2, 5)).toBe(
      'Ideas that [leave the brain] and land in the world.',
    );
  });

  it('runs to the end when `to` is omitted', () => {
    expect(accented('Your idea could be next', 4)).toBe('Your idea could be [next]');
    expect(accented('In their words', 2)).toBe('In their [words]');
  });

  it('works for Arabic (word order is logical, not visual)', () => {
    expect(accented('أفكار تطلع من الدماغ وتوصل للعالم.', 1, 4)).toBe(
      'أفكار [تطلع من الدماغ] وتوصل للعالم.',
    );
  });

  it('keeps a trailing footnote asterisk outside the accent', () => {
    expect(accented('Creative work that performs*', 3)).toBe('Creative work that [performs]*');
  });

  it('no range, or a range past the end, accents nothing', () => {
    expect(splitAccent('Plain heading', undefined)).toEqual([
      { text: 'Plain heading', accent: false },
    ]);
    expect(accented('Two words', 5)).toBe('Two words');
  });

  it('picks the locale’s range', () => {
    expect(accentRange({ en: { from: 1 }, ar: { from: 2 } }, 'ar')).toEqual({ from: 2 });
    expect(accentRange(undefined, 'en')).toBeUndefined();
  });
});

describe('galleryLayout — the design’s rhythm, computed on the server', () => {
  it('cycles wide · half half · third third third · half half · wide', () => {
    expect(galleryLayout(9).map((c) => c.span)).toEqual([
      'wide',
      'half',
      'half',
      'third',
      'third',
      'third',
      'half',
      'half',
      'wide',
    ]);
    expect(galleryLayout(10)[9]?.span).toBe('wide');
  });

  it('on phones, a still left alone on its row fills the row', () => {
    // Phones pair stills two-up; a wide one always starts a row.
    // 6 stills: wide · (1,2) · (3,4) · 5 alone at the end → fills
    expect(galleryLayout(6).map((c) => c.mobileFill)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    // 9 stills (the-rider): wide · (1,2) (3,4) (5,6) · 7 alone before the closing wide → fills
    expect(galleryLayout(9).map((c) => c.mobileFill)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    // 7 stills: wide · (1,2) (3,4) (5,6) — nobody alone
    expect(galleryLayout(7).some((c) => c.mobileFill)).toBe(false);
    expect(galleryLayout(0)).toEqual([]);
  });
});

describe('clips — a window of one showreel, never on touch', () => {
  const frame = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement;

  it('reads a valid window and rejects a bad one', () => {
    expect(clipWindow(frame({ clipStart: '1', clipEnd: '3.7' }))).toEqual({ start: 1, end: 3.7 });
    expect(clipWindow(frame({}))).toBeNull();
    expect(clipWindow(frame({ clipStart: '4', clipEnd: '2' }))).toBeNull();
    expect(clipWindow(frame({ clipStart: 'x', clipEnd: '2' }))).toBeNull();
  });

  it('loops by seeking back to the start, only when the file is seekable that far', () => {
    const w = { start: 4.1, end: 5.4 };
    expect(seekTarget(5.5, w, 30)).toBe(4.1); // past the end
    expect(seekTarget(0, w, 30)).toBe(4.1); // before the start (first play)
    expect(seekTarget(4.8, w, 30)).toBeNull(); // inside the window
    expect(seekTarget(5.5, w, 5)).toBeNull(); // no range support: play the file whole
  });

  it('is off under reduced motion, Save-Data and on touch-only devices', () => {
    const ok = { reducedMotion: false, saveData: false, canHover: true };
    expect(clipsAllowed(ok)).toBe(true);
    expect(clipsAllowed({ ...ok, reducedMotion: true })).toBe(false);
    expect(clipsAllowed({ ...ok, saveData: true })).toBe(false);
    expect(clipsAllowed({ ...ok, canHover: false })).toBe(false);
  });

  it('a hover preview starts for a mouse or pen, never for a finger on a hybrid', () => {
    expect(hoverStartsClip('mouse')).toBe(true);
    expect(hoverStartsClip('pen')).toBe(true);
    expect(hoverStartsClip('touch')).toBe(false);
  });
});

describe('count-up — an enhancement over the final value', () => {
  it('eases out and lands exactly on the value', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    expect(countValue(250, COUNT_DURATION_MS)).toBe(250);
    expect(countValue(250, COUNT_DURATION_MS * 2)).toBe(250);
    expect(countValue(250, 0)).toBe(0);
  });
});

describe('carousel — the APG run/pause decision', () => {
  const on: CarouselFlags = {
    started: true,
    onScreen: true,
    pageVisible: true,
    reducedMotion: false,
    userPaused: false,
    hovered: false,
  };

  it('runs only when started, on screen and visible', () => {
    expect(carouselRunning(on)).toBe(true);
    expect(carouselRunning({ ...on, started: false })).toBe(false);
    expect(carouselRunning({ ...on, onScreen: false })).toBe(false);
    expect(carouselRunning({ ...on, pageVisible: false })).toBe(false);
  });

  it('never auto-advances under reduced motion', () => {
    expect(carouselRunning({ ...on, reducedMotion: true })).toBe(false);
  });

  it('pauses on hover and stops on the Pause button', () => {
    expect(carouselRunning({ ...on, hovered: true })).toBe(false);
    expect(carouselRunning({ ...on, userPaused: true })).toBe(false);
  });

  it('keyboard focus arriving from outside stops it; a click or focus moving inside does not', () => {
    const entry = { entering: true, keyboard: true, reducedMotion: false };
    expect(focusEntryStops(entry)).toBe(true);
    expect(focusEntryStops({ ...entry, keyboard: false })).toBe(false); // mouse click
    expect(focusEntryStops({ ...entry, entering: false })).toBe(false); // between controls
    expect(focusEntryStops({ ...entry, reducedMotion: true })).toBe(false);
  });

  it('a stop holds until Play — focus leaving does not restart it, Play does even with focus inside', () => {
    // Keyboard entry sets userPaused; nothing but the toggle clears it (no focus flag).
    const stopped: CarouselFlags = { ...on, userPaused: true };
    expect(carouselRunning(stopped)).toBe(false);
    expect(carouselRunning({ ...stopped, userPaused: !stopped.userPaused })).toBe(true);
  });

  it('steps wrap both ways', () => {
    expect(step(2, 1, 3)).toBe(0);
    expect(step(0, -1, 3)).toBe(2);
  });
});

describe('facet tags link to the toggled selection', () => {
  it('sets a value, or clears it when it is the active one', () => {
    expect(toggleFacet({}, 'service', 'branding')).toEqual({ service: 'branding' });
    expect(toggleFacet({ service: 'branding', year: '2026' }, 'service', 'branding')).toEqual({
      year: '2026',
    });
    expect(toggleFacet({ service: 'branding' }, 'service', 'music')).toEqual({ service: 'music' });
  });
});
