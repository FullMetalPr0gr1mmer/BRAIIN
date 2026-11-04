import {
  INTRO_BACKDROPS,
  INTRO_COLUMNS,
  INTRO_DEFAULTS,
  INTRO_FADE,
  INTRO_HOLD,
  IntroTaglineSchema,
  inBucket,
  inSteps,
  type IntroSettings,
} from '@schemas/appearance';

// The loading screen's look as the public site reads it (Admin v2 E7, the `intro_` columns of
// `public.site_appearance`). Pure: no request state, no database. src/lib/data/appearance.ts
// reads the row; the home routes hand the result to the hero as route data (withHomeData), and
// Hero.astro renders what `introAttributes` returns on the plate.
//
// A row is read option by option, as the header's is: a value outside its bucket (a row written
// around the Worker, or a column a later slice widened) costs that option its built-in value,
// never the page.

type Row = Readonly<Record<string, unknown>>;

/** A stored row (or none) → the intro's look, every unreadable option at its default. */
export function introFromRow(row: Row | null | undefined): IntroSettings {
  if (!row) return { ...INTRO_DEFAULTS };
  const c = INTRO_COLUMNS;
  const d = INTRO_DEFAULTS;
  const tagline = IntroTaglineSchema.safeParse(row[c.tagline]);
  return {
    backdrop: inBucket(INTRO_BACKDROPS, row[c.backdrop], d.backdrop),
    bar: typeof row[c.bar] === 'boolean' ? (row[c.bar] as boolean) : d.bar,
    tagline: tagline.success ? tagline.data : null,
    holdMs: inSteps(INTRO_HOLD, row[c.holdMs], d.holdMs),
    fadeMs: inSteps(INTRO_FADE, row[c.fadeMs], d.fadeMs),
  };
}

/** What the plate's markup says about each timing or backdrop option off its default. */
export type IntroAttributes = Partial<Record<'data-backdrop' | 'data-hold' | 'data-fade', string>>;

/**
 * One `data-*` attribute per option that differs from its default, and none for an option at
 * its default, so the intro as built renders the same bytes as before E7. global.css maps each
 * value to a fixed rule: the backdrop's colour, and `--bs-intro-hold` / `--bs-intro-fade`, from
 * which the whole choreography is derived (docs/hero-intro.md §1). The tagline and the bar are
 * elements of their own, rendered only when set.
 */
export function introAttributes(s: IntroSettings): IntroAttributes {
  const d = INTRO_DEFAULTS;
  const out: IntroAttributes = {};
  if (s.backdrop !== d.backdrop) out['data-backdrop'] = s.backdrop;
  if (s.holdMs !== d.holdMs) out['data-hold'] = String(s.holdMs);
  if (s.fadeMs !== d.fadeMs) out['data-fade'] = String(s.fadeMs);
  return out;
}
