import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';

// Three read-only dashboards behind one component: pageview analytics, search
// analytics, and the site-health (field RUM) panel.
//
// Charts are bar rows made of CSS widths rather than a charting library. That is a
// deliberate trade: the admin has its own bundle budget, and a chart library would be
// the single largest thing in it — spent on a panel that shows at most 90 daily
// buckets. If these grow into real dashboards, revisit; until then a percentage width
// is legible, accessible (each row carries its own number as text) and free.

type Mode = 'analytics' | 'search' | 'health';

interface AnalyticsData {
  total: number;
  series: { day: string; views: number }[];
  topPaths: { path: string; views: number }[];
  byLocale: { locale: string; views: number }[];
}

interface SearchData {
  totalSearches: number;
  topQueries: { q: string; locale: string; hits: number; zero: number }[];
  zeroResult: { q: string; locale: string; hits: number; zero: number }[];
}

interface HealthData {
  samples: number;
  errorCount: number;
  metrics: {
    metric: string;
    samples: number;
    p75: number;
    p95: number;
    budget: number | null;
    withinBudget: boolean | null;
  }[];
}

export interface InsightsPanelProps {
  mode: Mode;
}

const ENDPOINT: Record<Mode, string> = {
  analytics: '/api/admin/analytics',
  search: '/api/admin/analytics/search',
  health: '/api/admin/site-health',
};

export default function InsightsPanel({ mode }: InsightsPanelProps) {
  const [days, setDays] = useState(mode === 'health' ? 7 : 28);
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await adminFetch(`${ENDPOINT[mode]}?days=${days}`));
    } catch (err) {
      setError(describeError(err));
    }
  }, [mode, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="range">
          Date range
        </label>
        <select id="range" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={28}>Last 28 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}

      {data !== null && mode === 'analytics' && <Analytics data={data as AnalyticsData} />}
      {data !== null && mode === 'search' && <Search data={data as SearchData} />}
      {data !== null && mode === 'health' && <Health data={data as HealthData} />}
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  // Snapped to the nearest 5% so it always lands on one of the bucket rules in
  // admin.css. See that file for why this is not an inline width.
  const raw = max > 0 ? (value / max) * 100 : 0;
  const percent = Math.round(raw / 5) * 5;
  return (
    <span className="bar" aria-hidden="true">
      <span className="bar-fill" data-width={percent} />
    </span>
  );
}

function Analytics({ data }: { data: AnalyticsData }) {
  const max = Math.max(1, ...data.topPaths.map((row) => row.views));
  return (
    <>
      <div className="grid">
        <div className="card">
          <p className="stat">{data.total.toLocaleString()}</p>
          <p className="stat-label">Page views</p>
        </div>
        {data.byLocale.map((row) => (
          <div className="card" key={row.locale}>
            <p className="stat">{row.views.toLocaleString()}</p>
            <p className="stat-label">{row.locale.toUpperCase()} views</p>
          </div>
        ))}
      </div>

      <div className="card table-wrap">
        <h2 className="card-title">Top pages</h2>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Views</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.topPaths.map((row) => (
              <tr key={row.path}>
                <td>{row.path}</td>
                <td>{row.views.toLocaleString()}</td>
                <td>
                  <Bar value={row.views} max={max} />
                </td>
              </tr>
            ))}
            {data.topPaths.length === 0 && (
              <tr>
                <td colSpan={3}>
                  No rollup data yet. Dashboards read <code>rollup_*</code> only — raw events are
                  aggregated by the scheduled job.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Search({ data }: { data: SearchData }) {
  return (
    <>
      <div className="card">
        <p className="stat">{data.totalSearches.toLocaleString()}</p>
        <p className="stat-label">Searches</p>
      </div>

      <div className="card table-wrap">
        <h2 className="card-title">Queries returning nothing</h2>
        <p className="admin-sub">
          Each of these is either a content gap or an Arabic tokenisation bug — the language column
          tells you which to suspect.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Query</th>
              <th scope="col">Language</th>
              <th scope="col">Times</th>
            </tr>
          </thead>
          <tbody>
            {data.zeroResult.map((row) => (
              <tr key={`${row.locale}-${row.q}`}>
                <td dir={row.locale === 'ar' ? 'rtl' : 'ltr'} lang={row.locale}>
                  {row.q}
                </td>
                <td>{row.locale.toUpperCase()}</td>
                <td>{row.zero}</td>
              </tr>
            ))}
            {data.zeroResult.length === 0 && (
              <tr>
                <td colSpan={3}>No zero-result searches. That is the target state.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card table-wrap">
        <h2 className="card-title">Most searched</h2>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Query</th>
              <th scope="col">Language</th>
              <th scope="col">Times</th>
            </tr>
          </thead>
          <tbody>
            {data.topQueries.map((row) => (
              <tr key={`${row.locale}-${row.q}`}>
                <td dir={row.locale === 'ar' ? 'rtl' : 'ltr'} lang={row.locale}>
                  {row.q}
                </td>
                <td>{row.locale.toUpperCase()}</td>
                <td>{row.hits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Health({ data }: { data: HealthData }) {
  return (
    <>
      <div className="grid">
        <div className="card">
          <p className="stat">{data.samples.toLocaleString()}</p>
          <p className="stat-label">RUM samples</p>
        </div>
        <div className="card">
          <p className="stat">{data.errorCount.toLocaleString()}</p>
          <p className="stat-label">Errors logged</p>
        </div>
      </div>

      <div className="card table-wrap">
        <h2 className="card-title">Core Web Vitals (field, p75)</h2>
        <p className="admin-sub">
          Field data is the source of truth for INP. The CI lab gate is an early warning, not the
          verdict.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">p75</th>
              <th scope="col">p95</th>
              <th scope="col">Budget</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.metrics.map((row) => (
              <tr key={row.metric}>
                <td>{row.metric}</td>
                <td>{row.p75}</td>
                <td>{row.p95}</td>
                <td>{row.budget ?? '—'}</td>
                <td>
                  {row.withinBudget === null ? (
                    '—'
                  ) : (
                    <span
                      className="badge"
                      data-status={row.withinBudget ? 'published' : 'archived'}
                    >
                      {row.withinBudget ? 'within budget' : 'over budget'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {data.metrics.length === 0 && (
              <tr>
                <td colSpan={5}>
                  No field data yet. The RUM beacon is consent-gated, so this stays empty until
                  visitors accept analytics.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
