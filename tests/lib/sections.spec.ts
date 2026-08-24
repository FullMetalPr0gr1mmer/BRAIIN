import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_SECTIONS, withHomeIntro, type SectionData } from '@/lib/sections/types';

// `withHomeIntro` is what decides that the brand intro plate exists at all. The plate is
// a full-viewport, opaque, pointer-capturing overlay, so "who turns it on" is a real
// safety question, not a styling one — see the intro block in public/styles/global.css.

describe('withHomeIntro', () => {
  it('turns the intro on for the first hero', () => {
    const out = withHomeIntro([{ type: 'hero' }]);
    expect(out[0]!.props).toEqual({ intro: true });
  });

  it('never touches a hero that is not the first one', () => {
    const out = withHomeIntro([{ type: 'hero' }, { type: 'hero' }]);
    expect(out[0]!.props).toEqual({ intro: true });
    expect(out[1]!.props).toBeUndefined();
  });

  it('leaves every other section type alone', () => {
    const input: SectionData[] = [{ type: 'aboutIntro' }, { type: 'hero' }, { type: 'contact' }];
    const out = withHomeIntro(input);
    expect(out[0]!.props).toBeUndefined();
    expect(out[1]!.props).toEqual({ intro: true });
    expect(out[2]!.props).toBeUndefined();
  });

  // The off switch. Route-level default, CMS override — an author who turns the intro
  // off in the CMS must win, or the field is decorative.
  it('lets an explicit CMS value win in both directions', () => {
    expect(withHomeIntro([{ type: 'hero', props: { intro: false } }])[0]!.props).toEqual({
      intro: false,
    });
    expect(withHomeIntro([{ type: 'hero', props: { intro: true } }])[0]!.props).toEqual({
      intro: true,
    });
  });

  it('preserves the rest of a section content payload', () => {
    const out = withHomeIntro([
      { type: 'hero', visible: true, props: { headline: { en: 'A', ar: 'ب' } } },
    ]);
    expect(out[0]!.visible).toBe(true);
    expect(out[0]!.props).toEqual({ intro: true, headline: { en: 'A', ar: 'ب' } });
  });

  it('does not mutate its input — the defaults array is a module singleton', () => {
    const before = JSON.stringify(DEFAULT_HOME_SECTIONS);
    withHomeIntro(DEFAULT_HOME_SECTIONS);
    expect(JSON.stringify(DEFAULT_HOME_SECTIONS)).toBe(before);
    // Specifically: the shared default must not acquire the plate for other callers.
    expect(DEFAULT_HOME_SECTIONS[0]!.props).toBeUndefined();
  });

  it('is a no-op on a composition with no hero at all', () => {
    const out = withHomeIntro([{ type: 'contact' }]);
    expect(out).toEqual([{ type: 'contact' }]);
  });

  it('the home default composition still opens with a hero', () => {
    // If this ever stops being true the intro silently disappears from the home page.
    expect(DEFAULT_HOME_SECTIONS[0]!.type).toBe('hero');
  });
});
