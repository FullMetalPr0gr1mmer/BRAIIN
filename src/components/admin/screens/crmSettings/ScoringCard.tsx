import { useEffect, useId, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import type { ScoreSignal } from '@schemas/crm';
import { ALL_SIGNALS, LIMITS, SIGNAL_COPY } from './copy';
import type { CrmSettingsRow } from './types';

// The lead scoring card (Admin v2 C9a, crm.md §6.3): the closed signals, 0 to 50 points each,
// the score capped at 100. Saving new points re-scores every lead at once (0091), so the list
// and the board never mix scores from two sets of points.

export function scoringOf(settings: CrmSettingsRow): Record<ScoreSignal, number> {
  return Object.fromEntries(
    // A signal the row has no points for scores nothing (app.lead_score), so it shows 0.
    ALL_SIGNALS.map((s) => [s, settings.scoring[s] ?? 0]),
  ) as Record<ScoreSignal, number>;
}

/** The most a lead can score with these points, the cap applied. */
export function maxScore(points: Readonly<Record<string, number>>): number {
  return Math.min(
    LIMITS.maxScore,
    SIGNAL_COPY.reduce((sum, { signal }) => sum + (points[signal] ?? 0), 0),
  );
}

interface Props {
  /** The settings as the screen loaded them: the fields start from these. */
  settings: CrmSettingsRow;
  /** The row's version now: another card's save moves it without touching these fields. */
  version: number;
  onSaved: (settings: CrmSettingsRow) => void;
}

export default function ScoringCard({ settings, version, onSaved }: Props) {
  const id = useId();
  const [points, setPoints] = useState(() => scoringOf(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPoints(scoringOf(settings)), [settings]);

  const valid = SIGNAL_COPY.every(({ signal }) => {
    const v = points[signal];
    return Number.isInteger(v) && v >= 0 && v <= LIMITS.maxPoints;
  });

  async function save() {
    if (!valid) {
      setError(`Points are whole numbers from 0 to ${LIMITS.maxPoints}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await adminFetch<{ settings: CrmSettingsRow }>('/api/admin/crm/settings', {
        method: 'PUT',
        body: { version, scoring: points },
      });
      toast('Lead scoring saved. Every lead has its new score.', 'ok');
      onSaved(answer.settings);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card crm-card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Lead scoring
      </h2>
      <p className="admin-sub">
        Adds up per lead and shows on the leads list and each lead. Saving re-scores every lead.
      </p>
      <div className="crm-points">
        {SIGNAL_COPY.map(({ signal, label, hint }) => (
          <label className="f crm-points__row" key={signal}>
            <span className="f__l">{label}</span>
            <span className="f__hint" id={`${id}-${signal}`}>
              {hint}
            </span>
            <input
              type="number"
              className="in--num"
              inputMode="numeric"
              min={0}
              max={LIMITS.maxPoints}
              step={1}
              value={Number.isFinite(points[signal]) ? points[signal] : ''}
              aria-describedby={`${id}-${signal}`}
              onChange={(e) =>
                setPoints((p) => ({
                  ...p,
                  [signal]: e.target.value === '' ? Number.NaN : Number(e.target.value),
                }))
              }
            />
          </label>
        ))}
      </div>
      <p className="f__hint">
        Highest possible score: {Number.isFinite(maxScore(points)) ? maxScore(points) : 0} of{' '}
        {LIMITS.maxScore}. Scores of 75 and above show green.
      </p>
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
          Save scoring
        </button>
      </div>
    </section>
  );
}
