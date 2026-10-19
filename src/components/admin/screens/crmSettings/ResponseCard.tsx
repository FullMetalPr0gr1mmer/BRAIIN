import { useEffect, useId, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { isRole } from '@/lib/auth/types';
import {
  MAX_ASSIGNMENT_POOL,
  MAX_SLA_HOURS,
  MIN_SLA_HOURS,
  type AssignmentRule,
} from '@schemas/crm';
import { RULE_COPY } from './copy';
import type { CrmSettingsRow, Person } from './types';

// The response time and assignment card (Admin v2 C9a, crm.md §11 screen 11): the hours a
// new lead may wait before the list flags it "Over response time", and who a new lead goes
// to: nobody (Manual, owner item O-9), the next person in a rotation, or always one person.
// Only active members who work leads are offered; someone switched off since is dropped from
// the rotation on the next save (arrival skips them meanwhile).

export function personName(person: Person): string {
  const role = person.role && isRole(person.role) ? ROLE_LABELS[person.role] : null;
  const name = person.display_name?.trim() || 'A team member';
  return role ? `${name} (${role})` : name;
}

/** The assignment as it will be saved: only people still offered, in rotation order. */
export function assignmentPayload(
  rule: AssignmentRule,
  pool: readonly string[],
  fixedTo: string | null,
  people: readonly Person[],
) {
  const offered = new Set(people.map((p) => p.id));
  return {
    rule,
    pool: pool.filter((id) => offered.has(id)),
    fixedTo: fixedTo && offered.has(fixedTo) ? fixedTo : null,
  };
}

const isRule = (value: string): value is AssignmentRule =>
  RULE_COPY.some((r) => r.rule === value);

interface Props {
  /** The settings as the screen loaded them: the fields start from these. */
  settings: CrmSettingsRow;
  /** The row's version now: another card's save moves it without touching these fields. */
  version: number;
  people: readonly Person[];
  onSaved: (settings: CrmSettingsRow) => void;
}

export default function ResponseCard({ settings, version, people, onSaved }: Props) {
  const id = useId();
  const [hours, setHours] = useState(settings.slaHours);
  const [rule, setRule] = useState<AssignmentRule>(
    isRule(settings.assignment.rule) ? settings.assignment.rule : 'manual',
  );
  const [pool, setPool] = useState<string[]>(settings.assignment.pool);
  const [fixedTo, setFixedTo] = useState<string | null>(settings.assignment.fixedTo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHours(settings.slaHours);
    setRule(isRule(settings.assignment.rule) ? settings.assignment.rule : 'manual');
    setPool(settings.assignment.pool);
    setFixedTo(settings.assignment.fixedTo);
  }, [settings]);

  const assignment = assignmentPayload(rule, pool, fixedTo, people);

  function problem(): string | null {
    if (!Number.isInteger(hours) || hours < MIN_SLA_HOURS || hours > MAX_SLA_HOURS) {
      return `Response time is a whole number of hours from ${MIN_SLA_HOURS} to ${MAX_SLA_HOURS}.`;
    }
    if (rule === 'round_robin' && assignment.pool.length === 0) {
      return 'Choose at least one person for the rotation.';
    }
    if (rule === 'fixed' && !assignment.fixedTo) return 'Choose who gets every new lead.';
    return null;
  }

  async function save() {
    const why = problem();
    if (why) {
      setError(why);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await adminFetch<{ settings: CrmSettingsRow }>('/api/admin/crm/settings', {
        method: 'PUT',
        body: { version, slaHours: hours, assignment },
      });
      toast('Response time and assignment saved.', 'ok');
      onSaved(answer.settings);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const togglePool = (person: string, on: boolean) =>
    setPool((list) =>
      on ? (list.includes(person) ? list : [...list, person]) : list.filter((p) => p !== person),
    );

  return (
    <section className="card crm-card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Response time and assignment
      </h2>
      <label className="f">
        <span className="f__l">Answer new leads within</span>
        <span className="crm-hours">
          <input
            type="number"
            className="in--num"
            inputMode="numeric"
            min={MIN_SLA_HOURS}
            max={MAX_SLA_HOURS}
            step={1}
            value={Number.isFinite(hours) ? hours : ''}
            aria-describedby={`${id}-hours`}
            onChange={(e) => setHours(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          />
          <span>hours</span>
        </span>
        <span className="f__hint" id={`${id}-hours`}>
          A new web lead nobody has answered by then shows &ldquo;Over response time&rdquo; on the
          leads list. Up to {MAX_SLA_HOURS} hours (a week).
        </span>
      </label>

      <fieldset className="f f--group">
        <legend className="f__l">New leads go to</legend>
        <div className="crm-rules">
          {RULE_COPY.map((option) => (
            <label className="crm-rule" key={option.rule}>
              <input
                type="radio"
                name={`${id}-rule`}
                value={option.rule}
                checked={rule === option.rule}
                aria-describedby={`${id}-rule-${option.rule}`}
                onChange={() => setRule(option.rule)}
              />
              <span className="crm-rule__t">{option.label}</span>
              <span className="f__hint" id={`${id}-rule-${option.rule}`}>
                {option.hint}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {rule === 'round_robin' && (
        <fieldset className="f f--group">
          <legend className="f__l">In the rotation</legend>
          {people.length === 0 ? (
            <p className="f__hint">Nobody works leads yet.</p>
          ) : (
            <ul className="crm-people">
              {people.slice(0, MAX_ASSIGNMENT_POOL).map((person) => (
                <li key={person.id}>
                  <label className="field-inline">
                    <input
                      type="checkbox"
                      checked={pool.includes(person.id)}
                      onChange={(e) => togglePool(person.id, e.target.checked)}
                    />
                    <span>{personName(person)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="f__hint">
            Leads go round in the order people were added. Someone switched off is skipped.
          </p>
        </fieldset>
      )}

      {rule === 'fixed' && (
        <label className="f">
          <span className="f__l">Who gets every new lead</span>
          <select
            value={assignment.fixedTo ?? ''}
            onChange={(e) => setFixedTo(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Choose a person</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {personName(person)}
              </option>
            ))}
          </select>
        </label>
      )}

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
          Save response time and assignment
        </button>
      </div>
    </section>
  );
}
