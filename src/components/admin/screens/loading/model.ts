import {
  INTRO_BACKDROPS,
  INTRO_DEFAULTS,
  INTRO_FADE,
  INTRO_HOLD,
  inBucket,
  inSteps,
  type IntroBackdrop,
} from '@schemas/appearance';
import { pendingOf, type PendingRef } from '../header/menu';

// The Loading screen (Admin v2 E7), pure so it is unit-tested (tests/lib/introOptions.spec.ts):
// which section the on/off switch writes and what it writes, and the look the preview draws
// from the form as it is. No option list, default or bucket check of its own: the schema's
// (packages/schemas/appearance.ts), as the Header screen's sketch (E5 code review, CR8).

type Row = Readonly<Record<string, unknown>>;

/** The home page's hero the switch writes (the section kernel's list row). */
export interface HomeHero {
  id: string;
  version: number;
  pending: PendingRef | null;
}

/**
 * The section that carries the plate: the home page's first VISIBLE hero, in the site's order,
 * as the home route picks it (withHomeIntro gives the plate to the first hero it renders, and
 * the route renders visible sections only). Null when the home page shows no hero: then there
 * is no loading screen to switch.
 */
export function homeHero(rows: readonly Row[]): HomeHero | null {
  const heroes = rows
    .filter((row) => row['type'] === 'hero' && row['visible'] !== false)
    .filter((row) => typeof row['id'] === 'string')
    .sort(
      (a, b) =>
        Number(a['sort_order'] ?? 0) - Number(b['sort_order'] ?? 0) ||
        String(a['id']).localeCompare(String(b['id'])),
    );
  const first = heroes[0];
  if (!first) return null;
  return {
    id: first['id'] as string,
    version: Number(first['version'] ?? 0),
    pending: pendingOf(first),
  };
}

/** A section's stored content, as an object ({} for anything else). */
export function contentOf(row: Row): Record<string, unknown> {
  const content = row['content'];
  return content && typeof content === 'object' && !Array.isArray(content)
    ? { ...(content as Record<string, unknown>) }
    : {};
}

/** Whether the plate shows: the route's default (on) unless the content says `intro: false`. */
export function introShown(content: Readonly<Record<string, unknown>>): boolean {
  return content['intro'] !== false;
}

/**
 * The hero's content with the switch moved. Off stores `intro: false` (an explicit off wins
 * over the route's default); on REMOVES the key, so the route's default applies again and the
 * content keeps no key it does not need. Every other key is kept as it is.
 */
export function switchedContent(
  content: Readonly<Record<string, unknown>>,
  on: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...content };
  if (on) delete next['intro'];
  else next['intro'] = false;
  return next;
}

/** The look the preview draws, from the form's values (each unreadable one at its default). */
export interface PreviewLook {
  backdrop: IntroBackdrop;
  bar: boolean;
  /** The tagline in English (the preview's language), '' for none. */
  tagline: string;
  holdMs: number;
  fadeMs: number;
}

export function previewLook(values: Readonly<Record<string, unknown>>): PreviewLook {
  const d = INTRO_DEFAULTS;
  const tagline = values['tagline'];
  const en =
    tagline && typeof tagline === 'object' && typeof (tagline as Row)['en'] === 'string'
      ? ((tagline as Row)['en'] as string).trim()
      : '';
  return {
    backdrop: inBucket(INTRO_BACKDROPS, values['backdrop'], d.backdrop),
    bar: values['bar'] === true,
    tagline: en,
    holdMs: inSteps(INTRO_HOLD, values['holdMs'], d.holdMs),
    fadeMs: inSteps(INTRO_FADE, values['fadeMs'], d.fadeMs),
  };
}

const BACKDROP_WORDS: Readonly<Record<IntroBackdrop, string>> = {
  video: 'The logo over the home page video',
  black: 'The logo on black',
  light: 'The logo on a light ground',
};

/** The preview in words (its caption, and what a screen reader hears of it). */
export function previewLine(look: PreviewLook): string {
  const parts = [BACKDROP_WORDS[look.backdrop]];
  if (look.bar) parts.push('a progress bar');
  if (look.tagline) parts.push(`the tagline “${look.tagline}”`);
  const what =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return `${what}. It holds ${look.holdMs} ms, then fades in ${look.fadeMs} ms.`;
}
