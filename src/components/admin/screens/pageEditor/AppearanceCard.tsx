import { ANCHOR_MAX, anchorProblem } from '@schemas/sectionAppearance';
import FieldShell, { describedBy } from '@/components/admin/fields/FieldShell';
import Note from '@/components/admin/kit/Note';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import {
  anchorChangeWarning,
  appearanceOffer,
  notOffered,
  optionsOf,
  ownsAnchor,
  revealNote,
} from './appearance';

// The section's Appearance card (Admin v2 E9), in its form after the words and before Save
// (EditorForm `after`): a background, a spacing and a reveal where the kind takes them, and its
// anchor. Bound to the section's own save (useEntitySave: one Save, one version, staged with
// the section once releases are on); the fields are the save's (appearance.ts), drawn here.
// What the kind does not take is said, not hidden. Ids `f-<name>`, so the form's error summary
// links to them (fieldErrors.ts). No style attribute.

type Choice = 'background' | 'spacing' | 'reveal';

const HINTS: Readonly<Record<Choice, string>> = {
  background:
    'Every colour on it is checked for contrast, and follows your theme’s primary colour.',
  spacing: 'The space above and below the section.',
  reveal:
    'Plays once as the section scrolls into view, only for visitors whose device has not asked for less motion. Everyone else sees it at once.',
};

export interface AppearanceCardProps {
  save: EntitySave;
  type: string;
  /** The look its form holds now (`content.variant`): the Numbers band names its own anchor. */
  variant: unknown;
  /** The section is among the first two the page shows (appearance.ts inOpening). */
  opening: boolean;
  /** The anchor its component names (library.ts anchorOf), or null. */
  codeAnchor: string | null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export default function AppearanceCard({
  save,
  type,
  variant,
  opening,
  codeAnchor,
}: AppearanceCardProps) {
  const offer = appearanceOffer(type);
  const locked = save.pendingRemoval === true;
  const errors = save.errors.byId;
  const missing = notOffered(type);
  const reveal = revealNote(type, opening);
  const anchor = text(save.values['anchor']);
  const owned = ownsAnchor(type, variant);
  const shape = anchor.trim() === '' ? null : anchorProblem(anchor.trim());
  const warning = anchorChangeWarning(save.saved['anchor'], anchor);

  const set = (name: string, value: string) => save.set(name, value === '' ? null : value);

  const choice = (name: Choice) => {
    const id = `f-${name}`;
    const error = errors[id];
    return (
      <FieldShell
        key={name}
        id={id}
        label={name === 'background' ? 'Background' : name === 'spacing' ? 'Spacing' : 'Reveal'}
        hint={HINTS[name]}
        error={error}
      >
        <select
          id={id}
          value={text(save.values[name])}
          disabled={locked}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, { hint: HINTS[name], error })}
          onChange={(e) => set(name, e.target.value)}
        >
          {optionsOf(name).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FieldShell>
    );
  };

  const anchorHint = `Lower-case letters and numbers, words joined by hyphens, up to ${ANCHOR_MAX}. A link can then point at this section: the page’s address, then #anchor. Leave it empty for none.`;
  const anchorError = errors['f-anchor'] ?? shape ?? undefined;

  return (
    <section className="card pe__look" aria-labelledby="pe-look-h">
      <h3 id="pe-look-h" className="card-title">
        Appearance
      </h3>
      {offer.background ? choice('background') : null}
      {offer.spacing ? choice('spacing') : null}
      {missing ? <p className="pe__tiny">{missing}</p> : null}
      {offer.reveal ? choice('reveal') : null}
      {reveal ? (
        <p className="pe__tiny">
          {reveal}
          {offer.reveal && text(save.values['reveal']) !== ''
            ? ' The reveal you chose waits until the section is further down.'
            : ''}
        </p>
      ) : null}
      {codeAnchor !== null && (!offer.anchor || owned) ? (
        <p className="pe__tiny">
          {`Its anchor is #${codeAnchor}, set by the site: other links point at it.`}
        </p>
      ) : null}
      {offer.anchor && (!owned || anchor !== '') ? (
        <FieldShell id="f-anchor" label="Anchor" hint={anchorHint} error={anchorError}>
          <span className="pe__anchor">
            <span aria-hidden="true">#</span>
            <input
              id="f-anchor"
              type="text"
              value={anchor}
              maxLength={ANCHOR_MAX}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              aria-invalid={anchorError ? true : undefined}
              aria-describedby={describedBy('f-anchor', { hint: anchorHint, error: anchorError })}
              onChange={(e) => set('anchor', e.target.value.toLowerCase())}
            />
          </span>
        </FieldShell>
      ) : null}
      {offer.anchor && owned && anchor !== '' ? (
        <Note tone="warn">
          {`This look names its own anchor, so #${anchor} cannot stay: empty the anchor, or choose another look.`}
        </Note>
      ) : null}
      {warning ? <Note tone="warn">{warning}</Note> : null}
    </section>
  );
}
