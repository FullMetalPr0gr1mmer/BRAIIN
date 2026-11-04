import {
  REVEAL_OPENING,
  SECTION_BACKGROUNDS,
  SECTION_REVEALS,
  SECTION_SPACINGS,
  codeAnchored,
  revealRefusal,
  takesAnchor,
  takesBackground,
  takesReveal,
  takesSpacing,
  type SectionBackground,
  type SectionReveal,
  type SectionSpacing,
} from '@schemas/sectionAppearance';
import type { FieldDef } from '@/lib/admin/ui/types';
import { customPage } from './library';
import { inOrder, type SectionRow } from './model';

// The page editor's Appearance card (Admin v2 E9): which of a section's appearance choices its
// kind takes, their words, and the fields the section's save carries for them. Pure and
// client-safe, from the code map (packages/schemas/sectionAppearance.ts), which the Worker, the
// database and the renderer read too. tests/lib/pageEditorAppearance.spec.ts holds it.
//
// The fields are `text` fields the form never draws (EditorForm `hidden`): AppearanceCard draws
// them, as selects and one text box. `text`, not `select`, on purpose: an unset select means
// "leave it alone" to the payload (formPayload.ts), and "its own" must be sendable (null). One
// array per kind, built once and kept (useEntitySave's `fields` keep their identity, or the
// record reloads in a loop: tests/lib/entitySaveFields.spec.ts).

type Field = 'background' | 'spacing' | 'reveal' | 'anchor';

export const BACKGROUND_WORDS: Readonly<Record<SectionBackground, string>> = {
  mist: 'Light grey',
  ink: 'Black',
  klein: 'Primary colour',
};
export const SPACING_WORDS: Readonly<Record<SectionSpacing, string>> = {
  compact: 'Compact',
  roomy: 'Roomy',
};
export const REVEAL_WORDS: Readonly<Record<SectionReveal, string>> = {
  fade: 'Fade in',
  rise: 'Rise and fade in',
};

const FIELD_LABELS: Readonly<Record<Field, string>> = {
  background: 'Background',
  spacing: 'Spacing',
  reveal: 'Reveal',
  anchor: 'Anchor',
};

/** What a kind offers: each choice it takes. The anchor only where no code names its own. */
export interface AppearanceOffer {
  background: boolean;
  spacing: boolean;
  reveal: boolean;
  /** An anchor field (statistics takes one in every look but the Numbers band). */
  anchor: boolean;
}

/** The choices a kind takes. */
export function appearanceOffer(type: string): AppearanceOffer {
  return {
    background: takesBackground(type),
    spacing: takesSpacing(type),
    reveal: takesReveal(type),
    // Statistics names its own anchor in the band look only: the field shows, and says so then.
    anchor: type === 'statistics' || takesAnchor(type, undefined),
  };
}

const cache = new Map<string, readonly FieldDef[]>();

/** The appearance fields a kind's form carries (stable per kind). */
export function appearanceFields(type: string): readonly FieldDef[] {
  const kept = cache.get(type);
  if (kept) return kept;
  const offer = appearanceOffer(type);
  const fields = (['background', 'spacing', 'reveal', 'anchor'] as const)
    .filter((name) => offer[name])
    .map((name): FieldDef => ({ name, label: FIELD_LABELS[name], kind: 'text' }));
  cache.set(type, fields);
  return fields;
}

/** The names of a kind's appearance fields (EditorForm's `hidden`). */
export function appearanceFieldNames(type: string): string[] {
  return appearanceFields(type).map((f) => f.name);
}

/** The options of a choice, "its own" first (the empty value, null when saved). */
export function optionsOf(
  field: 'background' | 'spacing' | 'reveal',
): { value: string; label: string }[] {
  switch (field) {
    case 'background':
      return [
        { value: '', label: 'Its own (white)' },
        ...SECTION_BACKGROUNDS.map((v) => ({ value: v, label: BACKGROUND_WORDS[v] })),
      ];
    case 'spacing':
      return [
        { value: '', label: 'Its own' },
        ...SECTION_SPACINGS.map((v) => ({ value: v, label: SPACING_WORDS[v] })),
      ];
    case 'reveal':
      return [
        { value: '', label: 'None: always shown' },
        ...SECTION_REVEALS.map((v) => ({ value: v, label: REVEAL_WORDS[v] })),
      ];
  }
}

/**
 * Whether a section is in the opening of its page: among the first REVEAL_OPENING sections the
 * page shows, where the renderer ignores a reveal. Hidden sections do not count; a custom page
 * with no shown hero opens with one of its own title (E11), which counts.
 */
export function inOpening(rows: readonly SectionRow[], id: string, page: string): boolean {
  const shown = inOrder(rows).filter((row) => row.visible);
  const floor = customPage(page) && !shown.some((row) => row.type === 'hero') ? 1 : 0;
  const at = shown.findIndex((row) => row.id === id);
  // A hidden section shows nowhere: when shown again, it goes where it is in the order.
  const place = at === -1 ? inOrder(rows).findIndex((row) => row.id === id) : at;
  return place !== -1 && place + floor < REVEAL_OPENING;
}

/** Whether a section in a look names its own anchor (the Numbers band, a form, a list…). */
export const ownsAnchor = codeAnchored;

/** What an editor reads about a choice its kind does not take, or null. */
export function notOffered(type: string): string | null {
  const offer = appearanceOffer(type);
  if (offer.background && offer.spacing) return null;
  if (!offer.background && !offer.spacing) {
    return 'Background and spacing: this kind of section keeps its own, as its design sets them.';
  }
  return 'Background: this kind of section keeps its own, as its design sets it.';
}

/** The words for a reveal in the page's opening, or a kind that never takes one. */
export function revealNote(type: string, opening: boolean): string | null {
  const refused = revealRefusal(type);
  if (refused) return refused;
  if (opening) {
    return 'This section is among the first two the page shows, so it always shows at once. A reveal plays only further down the page.';
  }
  return null;
}

/** The warning when a saved anchor is changed or removed: links to it stop working. */
export function anchorChangeWarning(saved: unknown, now: unknown): string | null {
  const before = typeof saved === 'string' ? saved.trim() : '';
  const after = typeof now === 'string' ? now.trim() : '';
  if (before === '' || before === after) return null;
  return after === ''
    ? `Links to #${before} will stop working once you save. Update the menus, buttons and other pages that point at it.`
    : `Links to #${before} will stop working once you save: update them to #${after}, or keep the old anchor.`;
}
