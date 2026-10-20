import { useEffect, useId, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import type { StageKind, StageTone } from '@schemas/crm';
import { KIND_NAMES, KINDS, leadsCount, LIMITS, removeBlocked, TONE_NAMES, TONES } from './copy';
import type { StageDraft, StageRow } from './types';

// The pipeline stages card (Admin v2 C9a, crm.md §11 screen 11): a list of the stages in
// board order, each with its label, its tone chosen by name from the closed palette, what it
// counts as (Open, Won, Lost), how many leads it holds, Move up / Move down and Remove. The
// first stage is where every new lead starts: it stays first, stays open and cannot be
// removed. A stage that holds leads keeps its kind and cannot be removed ("Move its N leads
// first"). One explicit Save sends the whole pipeline with the stages as they were loaded, so
// a save on top of someone else's is a 409, never a silent overwrite (P-5).

let next = 0;
const localKey = () => `new-${++next}`;

export function draftsOf(stages: readonly StageRow[]): StageDraft[] {
  return stages.map((s) => ({
    id: s.id,
    local: s.id,
    label: s.label,
    tone: s.tone,
    kind: s.kind,
    is_initial: s.is_initial,
    leads: s.leads,
  }));
}

/** What the save sends: the pipeline in board order, ids for the stages that exist. */
export function stagesPayload(loaded: readonly StageRow[], drafts: readonly StageDraft[]) {
  return {
    known: loaded.map((s) => ({ id: s.id, version: s.version })),
    stages: drafts.map((d) => ({
      ...(d.id ? { id: d.id } : {}),
      label: d.label.trim(),
      tone: d.tone,
      kind: d.kind,
    })),
  };
}

/** What would stop this pipeline saving, in words, or null. The server checks it again. */
export function pipelineProblem(drafts: readonly StageDraft[]): string | null {
  if (drafts.length < LIMITS.minStages || drafts.length > LIMITS.maxStages) {
    return `A pipeline has ${LIMITS.minStages} to ${LIMITS.maxStages} stages.`;
  }
  if (drafts.some((d) => d.label.trim().length === 0)) return 'Every stage needs a label.';
  if (!drafts.some((d) => d.kind === 'won')) return 'Keep at least one Won stage.';
  if (!drafts.some((d) => d.kind === 'lost')) return 'Keep at least one Lost stage.';
  return null;
}

interface Props {
  loaded: readonly StageRow[];
  onSaved: () => Promise<void>;
}

export default function StagesCard({ loaded, onSaved }: Props) {
  const id = useId();
  const [drafts, setDrafts] = useState<StageDraft[]>(() => draftsOf(loaded));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDrafts(draftsOf(loaded)), [loaded]);

  const update = (local: string, patch: Partial<StageDraft>) =>
    setDrafts((list) => list.map((d) => (d.local === local ? { ...d, ...patch } : d)));
  const move = (index: number, by: -1 | 1) =>
    setDrafts((list) => {
      const to = index + by;
      // The first stage stays first.
      if (to < 1 || to >= list.length || index < 1) return list;
      const copy = [...list];
      [copy[index], copy[to]] = [copy[to]!, copy[index]!];
      return copy;
    });
  const remove = (local: string) => setDrafts((list) => list.filter((d) => d.local !== local));
  const add = () =>
    setDrafts((list) => [
      ...list,
      {
        local: localKey(),
        label: 'New stage',
        tone: 'gray',
        kind: 'open',
        is_initial: false,
        leads: 0,
      },
    ]);

  const problem = pipelineProblem(drafts);

  async function save() {
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch('/api/admin/crm/stages', {
        method: 'PUT',
        body: stagesPayload(loaded, drafts),
      });
      toast('Pipeline stages saved.', 'ok');
      await onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card crm-card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Pipeline stages
      </h2>
      <p className="admin-sub">
        The columns of the Leads pipeline, in this order. A stage that holds leads keeps what it
        counts as and cannot be removed until its leads move.
      </p>
      <ol className="crm-stages">
        {drafts.map((d, i) => {
          const blocked = removeBlocked(d);
          const kindLocked = d.is_initial || d.leads > 0;
          return (
            <li className="crm-stage" key={d.local}>
              <div className="crm-stage__head">
                <span className="crm-stage__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="badge" data-tone={d.tone}>
                  {d.label.trim() || 'Untitled'}
                </span>
                <span className="crm-stage__count">{leadsCount(d.leads)}</span>
              </div>
              <label className="f">
                <span className="f__l">
                  Label<span className="visually-hidden"> of stage {i + 1}</span>
                </span>
                <input
                  type="text"
                  value={d.label}
                  maxLength={LIMITS.maxLabel}
                  required
                  onChange={(e) => update(d.local, { label: e.target.value })}
                />
              </label>
              <fieldset className="f f--group">
                <legend className="f__l">Colour</legend>
                <div className="crm-tones__list">
                  {TONES.map((tone: StageTone) => (
                    <label className="crm-tone" key={tone}>
                      <input
                        type="radio"
                        name={`${id}-tone-${d.local}`}
                        value={tone}
                        checked={d.tone === tone}
                        onChange={() => update(d.local, { tone })}
                      />
                      <span className="badge" data-tone={tone}>
                        {TONE_NAMES[tone]}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="f f--group" disabled={kindLocked}>
                <legend className="f__l">Counts as</legend>
                <div className="crm-kinds__list">
                  {KINDS.map((kind: StageKind) => (
                    <label className="field-inline" key={kind}>
                      <input
                        type="radio"
                        name={`${id}-kind-${d.local}`}
                        value={kind}
                        checked={d.kind === kind}
                        onChange={() => update(d.local, { kind })}
                      />
                      <span>{KIND_NAMES[kind]}</span>
                    </label>
                  ))}
                </div>
                {kindLocked && (
                  <p className="f__hint">
                    {d.is_initial
                      ? 'Every new lead starts here, so it stays open.'
                      : 'It holds leads, so it keeps what it counts as.'}
                  </p>
                )}
              </fieldset>
              {!d.is_initial && (
                <div className="crm-stage__acts">
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    disabled={i <= 1}
                    aria-label={`Move up: ${d.label.trim() || 'this stage'}`}
                    onClick={() => move(i, -1)}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    disabled={i === drafts.length - 1}
                    aria-label={`Move down: ${d.label.trim() || 'this stage'}`}
                    onClick={() => move(i, 1)}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    disabled={blocked !== null || drafts.length <= LIMITS.minStages}
                    aria-label={`Remove: ${d.label.trim() || 'this stage'}`}
                    onClick={() => remove(d.local)}
                  >
                    <Icon name="trash" size={14} />
                    Remove
                  </button>
                  {blocked && <span className="f__hint">{blocked}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="crm-card__foot">
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          disabled={drafts.length >= LIMITS.maxStages}
          onClick={add}
        >
          <Icon name="plus" size={16} />
          Add stage
        </button>
        <span className="f__hint">
          {drafts.length} of {LIMITS.maxStages} stages
        </span>
      </div>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={busy}
          onClick={() => void save()}
        >
          Save stages
        </button>
      </div>
    </section>
  );
}
