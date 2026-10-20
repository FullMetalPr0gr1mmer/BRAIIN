import { useCallback, useEffect, useRef, useState } from 'react';
import { barsGeometry, datumSummary, formatNumber, n } from '@/lib/admin/charts';
import { adminFetch, describeError } from '@/lib/admin/client';
import {
  ACTIVE_MINUTES,
  MINUTES_SHOWN,
  REALTIME_AUTO_STOP_MS,
  REALTIME_POLL_MS,
  minuteLabel,
  peopleWord,
  realtimeOf,
  updatedLine,
  type RealtimeView,
} from '@/lib/admin/stats/realtimeView';

// The website stats' Realtime tab (Admin v2 G1b; the prototype's opsStatsRealtime, without
// its live feed of single page views, which would put raw rows and L5's country and device
// on a screen). Rendered on the server first, so the figures are there with no JS; once
// hydrated it asks GET /api/admin/analytics/realtime again every minute:
//   - only while the tab is visible (a hidden tab asks nothing, and asks at once on its
//     return when a minute has passed);
//   - never while paused: "Pause updates" stops it, "Resume updates" asks at once and starts
//     again (WCAG 2.2.2: content that updates by itself can be paused);
//   - and it stops by itself after 30 minutes, saying so (P-15's request budget).
// An update changes text and the chart's numbers only; nothing is announced (no aria-live:
// a minute's change is not worth interrupting a screen reader for). The live dot pulses
// three times when the figures arrive (stats.css), never under reduced motion.

export interface RealtimeProps {
  initial: RealtimeView;
}

type Stop = 'none' | 'paused' | 'auto';

/** The words beside the button: why updates stopped, if they did. */
export function stateLine(stop: Stop): string {
  if (stop === 'paused') return 'Updates paused.';
  if (stop === 'auto') return 'Updates paused after 30 minutes.';
  return 'Updates every minute.';
}

function MinuteBars({ view }: { view: RealtimeView }) {
  const data = view.perMinute.map((m) => ({ label: minuteLabel(m.minute), value: m.views }));
  const g = barsGeometry(data, { height: 180 });
  const caption = `Page views per minute, the last ${MINUTES_SHOWN} minutes`;
  if (!g) {
    return (
      <figure className="chart-fig" id="rt-minutes">
        <figcaption id="rt-minutes-cap" className="visually-hidden">
          {caption}
        </figcaption>
        <p className="chart-empty">No page views in the last {MINUTES_SHOWN} minutes.</p>
      </figure>
    );
  }
  return (
    <figure className="chart-fig" id="rt-minutes">
      <figcaption id="rt-minutes-cap" className="visually-hidden">
        {caption}
      </figcaption>
      <svg
        className="chart"
        viewBox={`0 0 ${g.width} ${g.height}`}
        role="img"
        aria-labelledby="rt-minutes-cap rt-minutes-sum"
        focusable="false"
      >
        <line className="ch-grid" x1="0" x2={g.width} y1={g.baseline} y2={g.baseline} />
        {g.bars.map((bar, i) => (
          <g key={i}>
            {bar.height > 0 && (
              <rect
                className="ch-bar ch-s1"
                x={n(bar.x)}
                y={n(bar.y)}
                width={n(bar.width)}
                height={n(bar.height)}
                rx={bar.height >= 8 ? 4 : 0}
              />
            )}
            {bar.labelled && (
              <text className="ch-axis" x={n(bar.cx)} y={g.height - 8} textAnchor="middle">
                {bar.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p id="rt-minutes-sum" className="visually-hidden">
        {datumSummary(data)}
      </p>
      <details className="chart-table">
        <summary>View as table</summary>
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Minute, Riyadh time</th>
                <th scope="col" className="num">
                  Page views
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => (
                <tr key={i}>
                  <th scope="row">{d.label}</th>
                  <td className="num">{formatNumber(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export default function Realtime({ initial }: RealtimeProps) {
  const [view, setView] = useState<RealtimeView>(initial);
  const [stop, setStop] = useState<Stop>('none');
  const [failure, setFailure] = useState('');
  const started = useRef(0);
  const asked = useRef(0);

  const refresh = useCallback(async () => {
    asked.current = Date.now();
    try {
      setView(realtimeOf(await adminFetch<unknown>('/api/admin/analytics/realtime')));
      setFailure('');
    } catch (err) {
      setFailure(`The figures could not be updated just now. ${describeError(err)}`);
    }
  }, []);

  useEffect(() => {
    if (stop !== 'none') return;
    const now = Date.now();
    if (started.current === 0) started.current = now;
    if (asked.current === 0) asked.current = now;
    const tick = () => {
      if (Date.now() - started.current >= REALTIME_AUTO_STOP_MS) {
        setStop('auto');
        return;
      }
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - asked.current >= REALTIME_POLL_MS - 1_000) void refresh();
    };
    const timer = setInterval(tick, REALTIME_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [stop, refresh]);

  function toggle() {
    if (stop === 'none') {
      setStop('paused');
      return;
    }
    started.current = Date.now();
    setStop('none');
    void refresh();
  }

  const updated = updatedLine(view);
  return (
    <div className="rt" data-paused={stop === 'none' ? undefined : ''}>
      <div className="rt__bar">
        <p className="rt__state">
          {updated ? `${updated}. ` : ''}
          {stateLine(stop)}
        </p>
        <button type="button" data-size="sm" onClick={toggle}>
          {stop === 'none' ? 'Pause updates' : 'Resume updates'}
        </button>
      </div>
      {failure && (
        <p className="msg" data-kind="error" role="alert">
          {failure}
        </p>
      )}
      <div className="grid grid--1-2">
        <div className="card">
          <h2 className="card-title">Right now</h2>
          <div className="rt__now">
            <span className="rt__n">{formatNumber(view.activeVisits)}</span>
            <span className="rt__who">
              <span className="ops-live" aria-hidden="true" key={view.asOf ?? 'none'} />
              <span>{peopleWord(view.activeVisits)} on the site right now</span>
            </span>
            <p className="rt__sub">
              Who accepted analytics cookies, active in the last {ACTIVE_MINUTES} minutes.
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card__h">
            <div>
              <h2 className="card__t">Page views per minute</h2>
              <p className="card__sub">The last {MINUTES_SHOWN} minutes, Riyadh time</p>
            </div>
          </div>
          <MinuteBars view={view} />
        </div>
      </div>
      <div className="card stats__row">
        <h2 className="card-title">Active pages</h2>
        {view.topPaths.length === 0 ? (
          <p className="stats__under">Nobody is on the site right now.</p>
        ) : (
          <dl className="stat-rows">
            {view.topPaths.map((page) => (
              <div className="stat-row" key={page.path}>
                <dt dir="ltr">{page.path}</dt>
                <dd>{formatNumber(page.visits)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
