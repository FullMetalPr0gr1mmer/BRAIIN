import { useEffect, useId, useState, type FormEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { MAX_LEAD_VALUE_SAR, type ScoreSignal } from '@schemas/crm';
import type { LeadDetailRow, PersonView, StageView } from '@/lib/crm/leadPage';
import { FORMER_MEMBER, scoreBand, scoreBucket } from '@/lib/crm/leadView';
import MoveTo from './MoveTo';
import { StageBadge, leadName, stageById } from './shared';

// The Status card (Admin v2 C4b, crm.md §11 screen 3): the stage (the same "Move to…" as the
// board, decision D11), who has it, its value in SAR, the score, the star and the tags. Each
// is one PATCH, applied at once (crm.md §11: discrete controls, never a Save bar, never
// autosave of typed text): the value saves on Enter or when the box is left, a tag on Add or
// remove. Every versioned change sends the version the page read; the detail island answers a
// 409 with "Someone else changed this. Refreshed." and reads the lead again.

/** What a sentence says for each score reason (the reveal returns them, decision D7). */
export const SCORE_REASON_WORDS: Readonly<Record<ScoreSignal, string>> = {
  named_service: 'named a service',
  budget_given: 'gave a budget',
  budget_200k_plus: 'have a budget of 200,000 SAR or more',
  company_email: 'wrote from a company e-mail address',
  company_named: 'named their company',
  timeline_given: 'said when they need it',
  returning: 'have written before',
  service_page: 'came from a service page',
};

export function reasonsSentence(reasons: readonly ScoreSignal[]): string {
  if (reasons.length === 0) return 'No strong signals yet.';
  const words = reasons.map((r) => SCORE_REASON_WORDS[r]);
  const last = words.pop();
  return `Because they ${words.length ? `${words.join(', ')} and ${last}` : last}.`;
}

export type LeadWrite = (body: Record<string, unknown>, versioned: boolean) => Promise<boolean>;

interface Props {
  lead: LeadDetailRow;
  stages: readonly StageView[];
  people: readonly PersonView[];
  /** The score's reasons, once the contact details were revealed; else null. */
  reasons: readonly ScoreSignal[] | null;
  canSeePii: boolean;
  busy: boolean;
  write: LeadWrite;
  onMoved: (stage: StageView) => void;
}

export default function LeadStatusCard({
  lead,
  stages,
  people,
  reasons,
  canSeePii,
  busy,
  write,
  onMoved,
}: Props) {
  const ids = { assign: useId(), value: useId(), tag: useId(), star: useId(), head: useId() };
  const stage = stageById(stages, lead.stage_id);
  const assigned = typeof lead.assigned_to === 'string' ? lead.assigned_to : '';
  const former = assigned !== '' && !people.some((person) => person.id === assigned);
  const stored = typeof lead.value_sar === 'number' ? String(lead.value_sar) : '';
  const [value, setValue] = useState(stored);
  const [valueError, setValueError] = useState('');
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState('');
  const tags = Array.isArray(lead.tags) ? (lead.tags as string[]) : [];
  const score = Number(lead.score) || 0;
  // The value counts on an open stage past the first one, or once won (crm.md §11).
  const showValue = stage
    ? stage.kind === 'won' || (stage.kind === 'open' && !stage.isInitial)
    : false;

  useEffect(() => setValue(stored), [stored]);

  async function saveValue() {
    if (value === stored) return;
    const n = value.trim() === '' ? null : Number(value);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > MAX_LEAD_VALUE_SAR)) {
      setValueError('Use a whole number of SAR from 0 to 10,000,000.');
      return;
    }
    setValueError('');
    await write({ valueSar: n }, true);
  }

  async function addTag(event: FormEvent) {
    event.preventDefault();
    const next = tag.trim();
    if (!next) return setTagError('Write a tag first.');
    if (next.length > 32) return setTagError('A tag is at most 32 characters.');
    if (tags.includes(next)) return setTagError('That tag is already there.');
    if (tags.length >= 10) return setTagError('A lead holds at most 10 tags.');
    setTagError('');
    if (await write({ tags: [...tags, next] }, true)) setTag('');
  }

  const name = leadName(lead);
  return (
    <section className="card" aria-labelledby={ids.head}>
      <h2 id={ids.head} className="card-title">
        Status
      </h2>
      <div className="f">
        <span className="f__l">Stage</span>
        <div className="moveto--stage">
          <StageBadge stages={stages} id={lead.stage_id} />
          <MoveTo
            name={name}
            stages={stages}
            current={lead.stage_id}
            disabled={busy}
            onMove={(to) => onMoved(to)}
          />
        </div>
      </div>
      <div className="f">
        <label className="f__l" htmlFor={ids.assign}>
          Assigned to
        </label>
        <select
          id={ids.assign}
          value={assigned}
          disabled={busy}
          onChange={(event) => void write({ assignedTo: event.target.value || null }, true)}
        >
          <option value="">Nobody yet</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
          {former && (
            <option value={assigned} disabled>
              {FORMER_MEMBER}
            </option>
          )}
        </select>
      </div>
      {showValue && (
        <div className="f">
          <label className="f__l" htmlFor={ids.value}>
            Value in SAR
          </label>
          <input
            id={ids.value}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_LEAD_VALUE_SAR}
            step={1000}
            value={value}
            disabled={busy}
            aria-invalid={valueError ? true : undefined}
            aria-describedby={`${ids.value}-hint${valueError ? ` ${ids.value}-error` : ''}`}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void saveValue()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveValue();
              }
            }}
          />
          {valueError && (
            <p id={`${ids.value}-error`} className="field-error f__err">
              {valueError}
            </p>
          )}
          <p id={`${ids.value}-hint`} className="f__hint">
            Counts toward the Won total. Saved when you leave the box or press Enter.
          </p>
        </div>
      )}
      <div className="f">
        <div className="f__l">
          <span>Lead score</span>
          <span className="f__meta">{score} / 100</span>
        </div>
        <span className="bar lead-score" aria-hidden="true">
          <span className="bar-fill" data-width={scoreBucket(score)} data-band={scoreBand(score)} />
        </span>
        <p className="f__hint">
          {reasons
            ? reasonsSentence(reasons)
            : canSeePii
              ? 'Reasons show with the contact details.'
              : 'The reasons are shown to roles that may see contact details.'}
        </p>
      </div>
      <div className="f f--inline">
        <div className="f__l">
          <span id={ids.star}>Starred</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={lead.is_starred === true}
          aria-labelledby={ids.star}
          aria-describedby={`${ids.star}-hint`}
          disabled={busy}
          onClick={() => void write({ isStarred: lead.is_starred !== true }, false)}
        />
        <p id={`${ids.star}-hint`} className="f__hint">
          Starred leads come first in the list.
        </p>
      </div>
      <div className="f">
        <span className="f__l" id={`${ids.tag}-l`}>
          Tags
        </span>
        {tags.length > 0 ? (
          <ul className="lead-tags" aria-labelledby={`${ids.tag}-l`}>
            {tags.map((t) => (
              <li key={t} className="lead-tag" dir="auto">
                {t}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove the tag ${t}`}
                  onClick={() => void write({ tags: tags.filter((x) => x !== t) }, true)}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="f__hint">No tags yet.</p>
        )}
        <form className="lead-tag-add" onSubmit={(event) => void addTag(event)}>
          <label className="visually-hidden" htmlFor={ids.tag}>
            New tag
          </label>
          <input
            id={ids.tag}
            value={tag}
            maxLength={32}
            placeholder="e.g. hot, referral, repeat"
            aria-invalid={tagError ? true : undefined}
            aria-describedby={tagError ? `${ids.tag}-error` : undefined}
            onChange={(event) => setTag(event.target.value)}
          />
          <button type="submit" data-size="sm" disabled={busy}>
            Add tag
          </button>
        </form>
        {tagError && (
          <p id={`${ids.tag}-error`} className="field-error f__err">
            {tagError}
          </p>
        )}
      </div>
    </section>
  );
}
