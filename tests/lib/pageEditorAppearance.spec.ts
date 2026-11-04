import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import {
  appearanceProblem,
  takesAnchor,
  takesBackground,
  takesReveal,
  takesSpacing,
} from '@schemas/sectionAppearance';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import type { EntitySave } from '@/lib/admin/useEntitySave';

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { default: AppearanceCard } =
  await import('@/components/admin/screens/pageEditor/AppearanceCard');
const {
  anchorChangeWarning,
  appearanceFieldNames,
  appearanceFields,
  appearanceOffer,
  inOpening,
  optionsOf,
} = await import('@/components/admin/screens/pageEditor/appearance');
const { anchorOf } = await import('@/components/admin/screens/pageEditor/library');

// The page editor's Appearance card (Admin v2 E9): what each kind is offered (held to the code
// map the Worker and the database read), the fields the section's save carries for it (stable
// per kind, sent as null for "its own"), the opening rule, the anchor warning, and the card's
// first paint. The browser half is tests/admin/section-appearance.e2e.ts's.

type Row = Record<string, unknown>;

/** A save as the card reads it: values, saved values and errors. */
const saveOf = (values: Row, saved: Row = values, errors: Record<string, string> = {}) =>
  ({
    values,
    saved,
    errors: { byId: errors, summary: [] },
    set: () => undefined,
  }) as unknown as EntitySave;

const card = (
  type: string,
  values: Row = {},
  extra: {
    opening?: boolean;
    codeAnchor?: string | null;
    saved?: Row;
    errors?: Record<string, string>;
  } = {},
) =>
  renderToStaticMarkup(
    createElement(AppearanceCard, {
      save: saveOf(values, extra.saved ?? values, extra.errors ?? {}),
      type,
      variant: values['variant'],
      opening: extra.opening ?? false,
      codeAnchor: extra.codeAnchor ?? null,
    }),
  );

describe('what each kind is offered', () => {
  it('is the code map, for every kind', () => {
    for (const type of SECTION_TYPES) {
      const offer = appearanceOffer(type);
      expect(offer.background, type).toBe(takesBackground(type));
      expect(offer.spacing, type).toBe(takesSpacing(type));
      expect(offer.reveal, type).toBe(takesReveal(type));
      expect(offer.anchor, type).toBe(type === 'statistics' || takesAnchor(type, undefined));
    }
  });

  it('a kind is never offered a choice the Worker refuses', () => {
    for (const type of SECTION_TYPES) {
      const offer = appearanceOffer(type);
      const chosen = {
        background: offer.background ? 'ink' : null,
        spacing: offer.spacing ? 'roomy' : null,
        reveal: offer.reveal ? 'fade' : null,
      };
      expect(appearanceProblem(type, chosen), type).toBeNull();
    }
  });

  it('the editor names the same code anchors as the code map', () => {
    for (const type of SECTION_TYPES) {
      if (type === 'hero') continue;
      const named = anchorOf(type, 'home', undefined) ?? anchorOf(type, 'services', undefined);
      expect(named !== null, type).toBe(!takesAnchor(type, undefined));
    }
    expect(anchorOf('statistics', 'home', 'band')).toBe('numbers');
    expect(anchorOf('leadership', 'about', undefined)).toBe('team');
  });
});

describe('the fields the save carries', () => {
  it('one stable list per kind (the save would reload in a loop otherwise)', () => {
    expect(appearanceFields('textBlock')).toBe(appearanceFields('textBlock'));
    expect(appearanceFieldNames('textBlock')).toEqual([
      'background',
      'spacing',
      'reveal',
      'anchor',
    ]);
    expect(appearanceFieldNames('video')).toEqual(['spacing', 'reveal', 'anchor']);
    expect(appearanceFieldNames('cta')).toEqual(['reveal', 'anchor']);
    expect(appearanceFieldNames('contactInquiry')).toEqual(['reveal']);
    expect(appearanceFieldNames('hero')).toEqual([]);
    expect(appearanceFieldNames('statistics')).toEqual(['reveal', 'anchor']);
  });

  it('loads a stored choice and sends "its own" as null, never leaving it alone', () => {
    const fields = appearanceFields('textBlock');
    const loaded = rowToForm({ background: 'ink', spacing: null, anchor: 'our-story' }, fields);
    expect(loaded).toMatchObject({ background: 'ink', spacing: null, anchor: 'our-story' });
    expect(
      formToPayload({ background: null, spacing: 'roomy', reveal: '', anchor: '' }, fields),
    ).toEqual({ background: null, spacing: 'roomy', reveal: null, anchor: null });
  });

  it('every option is one the write schema takes, "its own" first', () => {
    for (const field of ['background', 'spacing', 'reveal'] as const) {
      const options = optionsOf(field);
      expect(options[0]!.value).toBe('');
      expect(new Set(options.map((o) => o.value)).size).toBe(options.length);
    }
  });
});

describe('the opening of a page', () => {
  const row = (id: string, type: string, sortOrder: number, visible = true) => ({
    id,
    type,
    label: null,
    visible,
    sortOrder,
    version: 1,
    placeholder: false,
  });

  it('is the first two sections the page shows, hidden ones not counted', () => {
    const rows = [
      row('a', 'hero', 0),
      row('b', 'cta', 1, false),
      row('c', 'cta', 2),
      row('d', 'cta', 3),
    ];
    expect(['a', 'b', 'c', 'd'].map((id) => inOpening(rows, id, 'about'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('counts the banner a custom page with no shown hero opens with', () => {
    // The custom page renders [its title's banner, a, b]: a is second, b third.
    const rows = [row('a', 'textBlock', 0), row('b', 'textBlock', 1)];
    expect(inOpening(rows, 'a', 'how-we-work')).toBe(true);
    expect(inOpening(rows, 'b', 'how-we-work')).toBe(false);
    // A route page has no such banner: b is second there.
    expect(inOpening(rows, 'b', 'about')).toBe(true);
    // With its own hero shown, the custom page opens with it: [h, a, b].
    expect(inOpening([row('h', 'hero', 0), ...rows], 'a', 'how-we-work')).toBe(true);
    expect(inOpening([row('h', 'hero', 0), ...rows], 'b', 'how-we-work')).toBe(false);
  });
});

describe('changing an anchor', () => {
  it('warns that links to the old one stop working', () => {
    expect(anchorChangeWarning(null, 'our-story')).toBeNull();
    expect(anchorChangeWarning('our-story', 'our-story')).toBeNull();
    expect(anchorChangeWarning('our-story', 'story')).toMatch(
      /#our-story will stop working.*#story/,
    );
    expect(anchorChangeWarning('our-story', '')).toMatch(/#our-story will stop working/);
  });
});

describe('the card’s first paint', () => {
  it('a text block: every choice, its options, the anchor box; no style attribute', () => {
    const html = card('textBlock', { background: 'ink', anchor: 'our-story' });
    expect(html).toContain('aria-labelledby="pe-look-h"');
    for (const id of ['f-background', 'f-spacing', 'f-reveal', 'f-anchor']) {
      expect(html, id).toContain(`id="${id}"`);
      expect(html, id).toContain(`for="${id}"`);
    }
    expect(html).toContain('<option value="ink" selected="">Black</option>');
    expect(html).toContain('<option value="klein">Primary colour</option>');
    expect(html).toContain('value="our-story"');
    expect(html).toContain('maxLength="40"');
    expect(html).not.toContain('style=');
  });

  it('a call to action says what it keeps, and offers a reveal and an anchor', () => {
    const html = card('cta');
    expect(html).not.toContain('id="f-background"');
    expect(html).not.toContain('id="f-spacing"');
    expect(html).toContain('Background and spacing: this kind of section keeps its own');
    expect(html).toContain('id="f-reveal"');
    expect(html).toContain('id="f-anchor"');
  });

  it('a section in the page’s opening is told its reveal waits', () => {
    expect(card('cta', { reveal: 'fade' }, { opening: true })).toContain(
      'among the first two the page shows',
    );
    expect(card('cta', { reveal: 'fade' }, { opening: false })).not.toContain(
      'among the first two',
    );
  });

  it('the reveal’s hint says it follows the scroll, never that it plays once (E9-C1)', () => {
    // global.css: a view() timeline, fill both, so scrolling back up past a section undoes it
    // and scrolling down plays it again (as-built E9, Departures).
    const html = card('cta');
    expect(html).toContain('id="f-reveal"');
    expect(html).toContain('It follows the scroll');
    expect(html).toContain('plays again on the way down');
    expect(html).not.toMatch(/plays once/i);
  });

  it('the Slogan is told it moves on its own, not that it opens a page (E9-C2)', () => {
    const html = card('slogan');
    expect(html).not.toContain('id="f-reveal"');
    expect(html).toContain('This section moves on its own as you scroll');
    expect(html).not.toContain('opens a page');
  });

  it('the hero takes no reveal, and its anchor is not offered', () => {
    const html = card('hero');
    expect(html).toContain('it takes no reveal');
    expect(html).not.toContain('id="f-reveal"');
    expect(html).not.toContain('id="f-anchor"');
  });

  it('a code-anchored section shows its own anchor, read only', () => {
    const html = card('contactInquiry', {}, { codeAnchor: 'inquiry' });
    expect(html).toContain('Its anchor is #inquiry, set by the site');
    expect(html).not.toContain('id="f-anchor"');
  });

  it('the Numbers band names its own anchor: a stored one must go, and says so', () => {
    const html = card(
      'statistics',
      { variant: 'band', anchor: 'figures' },
      { codeAnchor: 'numbers' },
    );
    expect(html).toContain('Its anchor is #numbers');
    expect(html).toContain('#figures cannot stay');
    expect(html).toContain('id="f-anchor"');
    expect(card('statistics', { variant: 'band' }, { codeAnchor: 'numbers' })).not.toContain(
      'id="f-anchor"',
    );
  });

  it('changing a saved anchor warns, and an error from the save is shown on its box', () => {
    const html = card(
      'textBlock',
      { anchor: 'story' },
      { saved: { anchor: 'our-story' }, errors: { 'f-anchor': 'Another section has it.' } },
    );
    expect(html).toContain('Links to #our-story will stop working');
    expect(html).toContain('Another section has it.');
    expect(html).toContain('aria-invalid="true"');
  });

  it('an anchor the rules refuse is said before saving', () => {
    expect(card('textBlock', { anchor: 'main' })).toContain('used by the site itself');
  });
});
