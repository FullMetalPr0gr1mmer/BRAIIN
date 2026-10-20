import { useEffect, useId, useState, type FormEvent } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import EmptyState from '@/components/admin/kit/EmptyState';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Modal from '@/components/admin/kit/Modal';
import { CTA_IDS, type CtaId } from '@schemas/analytics';
import {
  GOAL_METRICS,
  GOAL_NAME_MAX,
  GOAL_TARGET_MAX,
  type GoalMetric,
} from '@schemas/analyticsGoals';
import { barBucket, formatNumber } from '@/lib/admin/charts';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { showFlash, withFlash, type FlashKey } from '@/lib/admin/flash';
import type { GoalView } from '@/lib/admin/stats/goals';
import { CTA_LABELS, METRIC_LABELS, goalCounts, goalPercent } from '@/lib/admin/stats/labels';

// The goals card for holders of analytics.goals (Admin v2 G1c; the prototype's goals card and
// "New goal" drawer, screens_ops.js opsStatsConversions): the list StatsGoals.astro draws for
// everyone else, plus "Add goal", and Edit and Delete on each goal. Add and Edit open the
// kit's Drawer; Delete asks in the kit's Modal. A save is immediate (P-3: admin
// configuration, nothing public): POST or PATCH /api/admin/analytics/goals (the version the
// goal was read at, 409 when someone saved in between), DELETE for a delete; then the page
// reloads with a confirmation (flash.ts), so the progress shown is the database's again.
//
// The server decides, in both layers (analytics.goals in the Worker, RLS and the live check
// in the database); this island is only rendered for a role whose sidebar would let it use
// the controls.

export interface StatsGoalsProps {
  goals: readonly GoalView[];
}

interface Form {
  name: string;
  metric: GoalMetric;
  cta: CtaId;
  target: string;
}

type FormKey = keyof Form;

const EMPTY: Form = { name: '', metric: 'visits', cta: 'whatsapp', target: '100' };

const LABELS: Readonly<Record<FormKey, string>> = {
  name: 'Goal name',
  metric: 'Counts',
  cta: 'Which click',
  target: 'Target',
};

/** What the form refuses before it asks the server. */
export function checkGoal(form: Form): Partial<Record<FormKey, string>> {
  const errors: Partial<Record<FormKey, string>> = {};
  if (!form.name.trim()) errors.name = 'Name the goal';
  else if (form.name.trim().length > GOAL_NAME_MAX)
    errors.name = `At most ${GOAL_NAME_MAX} characters`;
  const target = Number(form.target);
  if (!Number.isInteger(target) || target < 1 || target > GOAL_TARGET_MAX) {
    errors.target = `A whole number from 1 to ${formatNumber(GOAL_TARGET_MAX)}`;
  }
  return errors;
}

/** The request body: `cta` only on a click goal (null otherwise, as the table stores it). */
export function goalBody(form: Form): {
  name: string;
  metric: GoalMetric;
  cta: CtaId | null;
  target: number;
} {
  return {
    name: form.name.trim(),
    metric: form.metric,
    cta: form.metric === 'cta' ? form.cta : null,
    target: Number(form.target),
  };
}

const here = () => `${location.pathname}${location.search}`;

export default function StatsGoals({ goals }: StatsGoalsProps) {
  const prefix = useId();
  const id = (key: FormKey) => `${prefix}-${key}`;
  const [editing, setEditing] = useState<GoalView | 'new' | null>(null);
  const [removing, setRemoving] = useState<GoalView | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<FormKey, string>>>({});
  const [summary, setSummary] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => showFlash(), []);

  function show(found: Partial<Record<FormKey, string>>) {
    setErrors(found);
    setSummary(
      (Object.entries(found) as [FormKey, string][]).map(([key, message]) => ({
        id: id(key),
        message: `${LABELS[key]}: ${message}`,
      })),
    );
  }

  function open(goal: GoalView | 'new') {
    setFailure('');
    show({});
    setForm(
      goal === 'new'
        ? EMPTY
        : {
            name: goal.name,
            metric: goal.metric,
            cta: (CTA_IDS as readonly string[]).includes(goal.cta ?? '')
              ? (goal.cta as CtaId)
              : 'whatsapp',
            target: String(goal.target),
          },
    );
    setEditing(goal);
  }

  function done(key: FlashKey) {
    location.assign(withFlash(here(), key));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (editing === null || busy) return;
    setFailure('');
    const local = checkGoal(form);
    if (Object.keys(local).length > 0) return show(local);
    show({});
    setBusy(true);
    try {
      if (editing === 'new') {
        await adminFetch('/api/admin/analytics/goals', { method: 'POST', body: goalBody(form) });
        done('goal-added');
      } else {
        await adminFetch(`/api/admin/analytics/goals/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          body: { ...goalBody(form), version: editing.version },
        });
        done('goal-saved');
      }
    } catch (err) {
      setBusy(false);
      if (err instanceof AdminApiError && err.info.status === 422) {
        const found: Partial<Record<FormKey, string>> = {};
        for (const issue of err.info.issues ?? []) {
          const key = issue.path.split('.')[0] as FormKey;
          if (key in LABELS) found[key] ??= issue.message;
        }
        const field = err.info.field as FormKey | undefined;
        if (field && field in LABELS) found[field] ??= err.info.detail ?? 'Check this field';
        if (Object.keys(found).length > 0) return show(found);
      }
      setFailure(describeError(err));
    }
  }

  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    setFailure('');
    try {
      await adminFetch(`/api/admin/analytics/goals/${encodeURIComponent(removing.id)}`, {
        method: 'DELETE',
      });
      done('goal-deleted');
    } catch (err) {
      setBusy(false);
      setFailure(describeError(err));
    }
  }

  const described = (key: FormKey) => (errors[key] ? `${id(key)}-error` : undefined);
  const fieldError = (key: FormKey) =>
    errors[key] ? (
      <p id={`${id(key)}-error`} className="field-error f__err">
        {errors[key]}
      </p>
    ) : null;
  const set = (key: FormKey) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <>
      {goals.length === 0 ? (
        <EmptyState
          icon="chart"
          title="No goals yet."
          text="Add a goal to track a number that matters. Progress counts this calendar month."
        />
      ) : (
        <>
          <ul className="goals__list">
            {goals.map((goal) => {
              const pct = goalPercent(goal);
              return (
                <li className="goal" key={goal.id}>
                  <div className="goal__h">
                    <div>
                      <span className="goal__name" dir="auto">
                        {goal.name}
                      </span>
                      <span className="goal__counts">{goalCounts(goal.metric, goal.cta)}</span>
                    </div>
                    <div className="goal__acts">
                      <button type="button" data-size="sm" onClick={() => open(goal)}>
                        Edit<span className="visually-hidden"> {goal.name}</span>
                      </button>
                      <button
                        type="button"
                        data-size="sm"
                        data-variant="danger"
                        onClick={() => {
                          setFailure('');
                          setRemoving(goal);
                        }}
                      >
                        Delete<span className="visually-hidden"> {goal.name}</span>
                      </button>
                    </div>
                  </div>
                  <div className="prog">
                    <span>
                      {goal.done === null
                        ? `Target ${formatNumber(goal.target)}. Progress shows to people who work with leads.`
                        : `${formatNumber(goal.done)} of ${formatNumber(goal.target)}`}
                    </span>
                    <span className="prog__v">{pct === null ? '' : `${pct}%`}</span>
                    <span className="bar" aria-hidden="true">
                      <span className="bar-fill ch-s1" data-width={barBucket(pct ?? 0, 100)} />
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="stats__under">Progress counts from the first of this month, in UTC days.</p>
        </>
      )}
      {failure && !editing && (
        <p className="msg" data-kind="error" role="alert">
          {failure}
        </p>
      )}
      <p className="goals__add">
        <button type="button" data-variant="primary" onClick={() => open('new')}>
          Add goal
        </button>
      </p>

      <Drawer
        open={editing !== null}
        onClose={() => {
          if (!busy) setEditing(null);
        }}
        title={editing === 'new' ? 'New goal' : 'Edit goal'}
        dismissible={false}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" form={`${prefix}-form`} data-variant="primary" disabled={busy}>
              {editing === 'new' ? 'Add goal' : 'Save goal'}
            </button>
          </>
        }
      >
        <form id={`${prefix}-form`} onSubmit={(e) => void save(e)} noValidate>
          <ErrorSummary errors={summary} />
          {failure && (
            <p className="msg" data-kind="error" role="alert">
              {failure}
            </p>
          )}
          <div className="f">
            <label className="f__l" htmlFor={id('name')}>
              {LABELS.name}
            </label>
            <input
              id={id('name')}
              value={form.name}
              maxLength={GOAL_NAME_MAX}
              autoComplete="off"
              dir="auto"
              placeholder="e.g. WhatsApp clicks this month"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={described('name')}
              onChange={(event) => set('name')(event.target.value)}
            />
            {fieldError('name')}
          </div>
          <div className="f">
            <label className="f__l" htmlFor={id('metric')}>
              {LABELS.metric}
            </label>
            <select
              id={id('metric')}
              value={form.metric}
              onChange={(event) => set('metric')(event.target.value)}
            >
              {GOAL_METRICS.map((metric) => (
                <option key={metric} value={metric}>
                  {METRIC_LABELS[metric]}
                </option>
              ))}
            </select>
            {form.metric === 'inquiries' && (
              <p className="f__hint">Progress shows to people who work with leads.</p>
            )}
          </div>
          {form.metric === 'cta' && (
            <div className="f">
              <label className="f__l" htmlFor={id('cta')}>
                {LABELS.cta}
              </label>
              <select
                id={id('cta')}
                value={form.cta}
                aria-invalid={errors.cta ? true : undefined}
                aria-describedby={described('cta')}
                onChange={(event) => set('cta')(event.target.value)}
              >
                {CTA_IDS.map((cta) => (
                  <option key={cta} value={cta}>
                    {CTA_LABELS[cta]}
                  </option>
                ))}
              </select>
              {fieldError('cta')}
            </div>
          )}
          <div className="f">
            <label className="f__l" htmlFor={id('target')}>
              {LABELS.target}
            </label>
            <input
              id={id('target')}
              type="number"
              inputMode="numeric"
              min={1}
              max={GOAL_TARGET_MAX}
              step={1}
              value={form.target}
              aria-invalid={errors.target ? true : undefined}
              aria-describedby={described('target') ?? `${id('target')}-hint`}
              onChange={(event) => set('target')(event.target.value)}
            />
            {fieldError('target')}
            <p id={`${id('target')}-hint`} className="f__hint">
              This calendar month, counted from the first.
            </p>
          </div>
        </form>
      </Drawer>

      <Modal
        open={removing !== null}
        onClose={() => {
          if (!busy) setRemoving(null);
        }}
        title="Delete this goal?"
        sub={removing ? `“${removing.name}” stops being tracked. Nothing else changes.` : ''}
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="danger"
              aria-disabled={busy ? 'true' : undefined}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : 'Delete goal'}
            </button>
          </>
        }
      >
        {failure && (
          <p className="msg" data-kind="error" role="alert">
            {failure}
          </p>
        )}
      </Modal>
    </>
  );
}
