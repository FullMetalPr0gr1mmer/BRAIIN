import { formatNumber } from '@/lib/admin/charts';
import { deltaView, type DeltaUnit } from '@/lib/admin/kpi';

// A KPI card inside islands (Admin v2 C4b): the markup of ui/Kpi.astro, so a figure reads the
// same whether a page or an island drew it (tests/astro/kitParity.spec.ts compares the two).
// The label, the figure (a number grouped in en-GB, a string printed as it is: Arabic digits
// are never transformed), an optional unit, and the change against the previous period as the
// words-and-glyph pill: "▲ 12%" shown, "Up 12% vs the previous 7 days" heard. A null change
// draws no pill. The spark stays server-only: an island's KPIs have none.

export interface KpiProps {
  label: string;
  value: string | number;
  unit?: string | undefined;
  delta?: number | null | undefined;
  deltaUnit?: DeltaUnit;
  good?: 'up' | 'down';
  /** Said after the change: "the previous 7 days". */
  period?: string | undefined;
}

export default function Kpi({
  label,
  value,
  unit,
  delta,
  deltaUnit = 'percent',
  good = 'up',
  period,
}: KpiProps) {
  const view = deltaView(delta, good, deltaUnit);
  const shown = typeof value === 'number' ? formatNumber(value) : value;
  const spoken = view
    ? `${view.spoken[0]?.toUpperCase()}${view.spoken.slice(1)}${period ? ` vs ${period}` : ''}`
    : '';
  return (
    <div className="card">
      <p className="stat-label">{label}</p>
      <p className="stat">
        {shown}
        {unit && <span className="stat-unit">{unit}</span>}
      </p>
      {view && (
        <p className="kpi__d" data-tone={view.tone}>
          <span aria-hidden="true">
            {view.glyph} {view.text}
          </span>
          <span className="visually-hidden">{spoken}</span>
        </p>
      )}
    </div>
  );
}
