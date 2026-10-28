import { useId, useState } from 'react';
import type { LeadBulk } from '@schemas/crm';
import { adminFetch, describeError } from '@/lib/admin/client';
import type { PersonView, StageView } from '@/lib/crm/leadPage';

// The list's bulk bar (Admin v2 C4b, crm.md §11): Assign to…, Move to stage…, Mark read, Star,
// and Mark as spam (Not spam in the spam view) over the ticked rows of the page on screen.
// No delete: a lead leaves through spam or an Admin's erase, one at a time. One POST to
// /api/admin/leads/bulk per action; the versioned ones (assign, stage, spam) carry the version
// each row was read at, so a lead a colleague changed meanwhile comes back as a conflict,
// never as an overwrite (risk R7: the screen refreshes and says so, it never retries).

/** What the bulk route answers. */
export interface BulkOutcome {
  applied: { id: string; version: number }[];
  conflicts: { id: string; version: number }[];
  missing: string[];
  skipped: string[];
  audited: boolean;
}

interface Props {
  ids: readonly string[];
  /** Each ticked row's version, as read. */
  versions: ReadonlyMap<string, number>;
  people: readonly PersonView[];
  stages: readonly StageView[];
  spamView: boolean;
  /** The bulk answer, with the action it applied (the list forgets its own star toggles). */
  onDone: (outcome: BulkOutcome, action: LeadBulk['action']) => void;
  onError: (message: string) => void;
}

export default function LeadsBulkBar({
  ids,
  versions,
  people,
  stages,
  spamView,
  onDone,
  onError,
}: Props) {
  const assignId = useId();
  const stageId = useId();
  const [assignee, setAssignee] = useState('');
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(body: LeadBulk) {
    setBusy(true);
    try {
      const outcome = await adminFetch<BulkOutcome>('/api/admin/leads/bulk', {
        method: 'POST',
        body,
      });
      onDone(outcome, body.action);
    } catch (err) {
      onError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const versioned = ids.map((id) => ({ id, version: versions.get(id) ?? 1 }));
  const plain = ids.map((id) => ({ id }));

  return (
    <>
      <span className="lead-bulk__g">
        <label className="visually-hidden" htmlFor={assignId}>
          Assign the selected leads to
        </label>
        <select id={assignId} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Assign to…</option>
          <option value="none">Nobody</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-size="sm"
          disabled={busy || assignee === ''}
          onClick={() =>
            void run({
              action: 'assign',
              value: assignee === 'none' ? null : assignee,
              items: versioned,
            })
          }
        >
          Assign
        </button>
      </span>
      <span className="lead-bulk__g">
        <label className="visually-hidden" htmlFor={stageId}>
          Move the selected leads to the stage
        </label>
        <select id={stageId} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Move to stage…</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-size="sm"
          disabled={busy || stage === ''}
          onClick={() => void run({ action: 'stage', value: stage, items: versioned })}
        >
          Move
        </button>
      </span>
      <button
        type="button"
        data-size="sm"
        disabled={busy}
        onClick={() => void run({ action: 'read', value: true, items: plain })}
      >
        Mark read
      </button>
      <button
        type="button"
        data-size="sm"
        disabled={busy}
        onClick={() => void run({ action: 'star', value: true, items: plain })}
      >
        Star
      </button>
      <button
        type="button"
        data-size="sm"
        disabled={busy}
        onClick={() => void run({ action: 'spam', value: !spamView, items: versioned })}
      >
        {spamView ? 'Not spam' : 'Mark as spam'}
      </button>
    </>
  );
}
