import { useEffect, useMemo, useRef, useState } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Icon from '@/components/admin/kit/Icon';
import Kpi from '@/components/admin/kit/Kpi';
import Note from '@/components/admin/kit/Note';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { showFlash } from '@/lib/admin/flash';
import { isoOf } from '@/lib/admin/relTime';
import { useClock } from '@/components/admin/kit/clock';
import { toast } from '@/lib/admin/toast';
import { deltaOf, MIN_RESPONSE_SAMPLE, type LeadKpis } from '@/lib/crm/leadKpis';
import type { LeadsFrame } from '@/lib/crm/leadPage';
import type { LeadPage, LeadRow, LeadSummaryAnswer } from '@/lib/crm/leadReads';
import {
  LEADS_PAGE_SIZE,
  exportHrefOf,
  firstPage,
  listQueryOf,
  summaryQueryOf,
  withLeadFilters,
  type LeadChip,
  type LeadFilters,
} from '@/lib/crm/leadUrl';
import { formatSar, leadsSubline, slaLabel } from '@/lib/crm/leadView';
import LeadsBulkBar, { type BulkOutcome } from './LeadsBulkBar';
import { LeadFilterSelects, LeadSearch, periodWords } from './LeadsToolbar';
import {
  Assignee,
  SourceBadge,
  StageBadge,
  disciplineOfService,
  interestText,
  leadName,
  text,
  useAddLead,
  type LeadsPermissions,
} from './shared';

// The leads list (Admin v2 C4b, crm.md §11 screen 1): the KPIs for the range, the chips, the
// search and the filters, a table of 15 a page with a bulk bar, and Add lead manually. The page
// renders the first view on the server (src/lib/crm/leadPage.ts); this island takes over: a
// filter change rewrites the address (history.replaceState, never the search) and reads the
// list again through POST /api/admin/leads/query, the KPIs through POST …/summary.
//
// PII (crm.md §11): a row carries the safe columns only. No budget column, no e-mail or
// phone, no message in the table; contact details are revealed one lead at a time, on its own
// page, audited. The export is a link to the server's audited CSV, for export.csv holders.

export interface LeadsListProps {
  frame: LeadsFrame;
  initial: { summary: LeadSummaryAnswer | null; page: LeadPage | null };
  filters: LeadFilters;
  permissions: LeadsPermissions;
  /** The server's clock when it rendered, so the first render's "3 h ago" matches. */
  now: string;
}

type Row = LeadRow & { id: string };

const asRows = (page: LeadPage | null): Row[] =>
  (page?.rows ?? []).filter((row): row is Row => typeof row.id === 'string');

/** The chip's value: 'all', 'unread', 'spam' or a stage id. */
function chipValue(chip: LeadChip): string {
  return chip.kind === 'stage' ? chip.id : chip.kind;
}

function chipOf(value: string): LeadChip {
  if (value === 'all' || value === 'unread' || value === 'spam') return { kind: value };
  return { kind: 'stage', id: value };
}

/** "3 h 40 min", "45 min", "2 d 4 h": a first-response time in words. */
export function hoursText(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.round((minutes - d * 24 * 60) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** A change in percent, or null (no previous figure, or nothing then: no invented trend). */
const percentOf = (current: number | null, previous: number | null) => {
  const delta = deltaOf(current, previous);
  return delta === null ? null : delta * 100;
};

/** The five KPI cards (crm.md §9's definitions), with changes only when a range is set. */
export function LeadKpiCards({
  summary,
  period,
}: {
  summary: LeadSummaryAnswer;
  period: string | null;
}) {
  const before: LeadKpis | null = period ? summary.previous : null;
  const conversion = summary.conversion;
  const response =
    summary.web_response_n >= MIN_RESPONSE_SAMPLE && summary.web_response_hours !== null
      ? summary.web_response_hours
      : null;
  const beforeResponse =
    before && before.web_response_n >= MIN_RESPONSE_SAMPLE ? before.web_response_hours : null;
  const pointsOf = (now: number | null, then: number | null | undefined) =>
    now === null || then === null || then === undefined ? null : (now - then) * 100;
  return (
    <div className="lead-kpis">
      <Kpi
        label="New"
        value={summary.new}
        delta={before ? percentOf(summary.new, before.new) : null}
        period={period ?? undefined}
      />
      <Kpi
        label="In progress"
        value={summary.in_progress}
        delta={before ? percentOf(summary.in_progress, before.in_progress) : null}
        period={period ?? undefined}
      />
      <Kpi
        label="Won"
        value={summary.won}
        unit={formatSar(summary.won_value)}
        delta={before ? percentOf(summary.won, before.won) : null}
        period={period ?? undefined}
      />
      <Kpi
        label="Won of all leads"
        value={conversion === null ? 'No leads yet' : `${Math.round(conversion * 100)}%`}
        deltaUnit="points"
        delta={before ? pointsOf(conversion, before.conversion) : null}
        period={period ?? undefined}
      />
      <Kpi
        label="Average first response"
        value={response === null ? 'Not enough data yet' : hoursText(response)}
        good="down"
        delta={before && response !== null ? percentOf(response, beforeResponse) : null}
        period={period ?? undefined}
      />
    </div>
  );
}

export default function LeadsList({
  frame,
  initial,
  filters: start,
  permissions,
  now: renderedAt,
}: LeadsListProps) {
  const { formatDateTime, relTime, zone } = useClock();
  const { stages, people, disciplines } = frame;
  const [filters, setFilters] = useState<LeadFilters>(start);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>(() => asRows(initial.page));
  const [total, setTotal] = useState(initial.page?.total ?? 0);
  const [summary, setSummary] = useState<LeadSummaryAnswer | null>(initial.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    initial.page ? '' : 'The leads could not be loaded just now. Try again in a moment.',
  );
  const [searchError, setSearchError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<{ tone: 'warn' | 'err'; text: string }[]>([]);
  const [starError, setStarError] = useState('');
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.parse(renderedAt));
  const addLead = useAddLead(permissions.canSeePii, disciplines);

  // A confirmation the last page sent here (a lead erased): shown once, then taken out of
  // the address. First, before the address is rewritten from the filters.
  useEffect(() => showFlash(), []);

  // The address follows the filters (never the search), and so does the page head's Export
  // link (the server's audited CSV, for the filters on screen; crm.md §11: no client CSV).
  useEffect(() => {
    const href = withLeadFilters('/admin/leads', filters);
    if (`${location.pathname}${location.search}` !== href) history.replaceState(null, '', href);
    document
      .querySelector('[data-lead-export]')
      ?.setAttribute('href', exportHrefOf(filters, new Date(), zone));
  }, [filters]);

  // The list: read again whenever a filter, the search or a change asks; the server's first
  // view stands until then.
  const listed = useRef(initial.page !== null);
  useEffect(() => {
    if (listed.current) {
      listed.current = false;
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const body = { ...listQueryOf(filters, new Date(), zone), ...(q ? { q } : {}) };
    adminFetch<LeadPage>('/api/admin/leads/query', {
      method: 'POST',
      body,
      signal: controller.signal,
    })
      .then((page) => {
        setRows(asRows(page));
        setTotal(page.total);
        setError('');
        setSearchError('');
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // A term that looks like an address or a number but is not a whole one: said under
        // the box, the list left as it was.
        if (err instanceof AdminApiError && err.info.status === 422 && q) {
          setSearchError(err.info.detail ?? describeError(err));
          return;
        }
        setError(describeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [filters, q, reload]);

  // The KPIs and the chips' counts follow the range only (decision D13).
  const summarised = useRef(initial.summary !== null);
  useEffect(() => {
    if (summarised.current) {
      summarised.current = false;
      return;
    }
    const controller = new AbortController();
    adminFetch<LeadSummaryAnswer>('/api/admin/leads/summary', {
      method: 'POST',
      body: summaryQueryOf(filters, new Date(), zone),
      signal: controller.signal,
    })
      .then(setSummary)
      .catch(() => {
        if (!controller.signal.aborted) setSummary(null);
      });
    return () => controller.abort();
  }, [filters.range, reload]);

  // The page head's sub-line counts the range the KPIs count (decision D13).
  useEffect(() => {
    const line = document.querySelector('.admin-header .admin-sub');
    if (line && summary) line.textContent = leadsSubline(summary, filters.range);
  }, [summary]);

  const versions = useMemo(
    () => new Map(rows.map((row) => [row.id, Number(row.version) || 1])),
    [rows],
  );
  const spamView = filters.chip.kind === 'spam';

  async function toggleStar(row: Row) {
    const next = row.is_starred !== true;
    setStarError('');
    setRows((list) => list.map((r) => (r.id === row.id ? { ...r, is_starred: next } : r)));
    try {
      await adminFetch(`/api/admin/leads/${row.id}`, {
        method: 'PATCH',
        body: { isStarred: next },
      });
    } catch (err) {
      setRows((list) => list.map((r) => (r.id === row.id ? { ...r, is_starred: !next } : r)));
      setStarError(`${leadName(row)} could not be starred. ${describeError(err)}`);
    }
  }

  function bulkDone(outcome: BulkOutcome) {
    const next: { tone: 'warn' | 'err'; text: string }[] = [];
    const changed = outcome.applied.length;
    if (outcome.conflicts.length > 0) {
      const n = outcome.conflicts.length;
      next.push({
        tone: 'warn',
        text: `${n} ${n === 1 ? 'lead was' : 'leads were'} changed by someone else. Refreshed.`,
      });
    }
    if (outcome.missing.length > 0) {
      const n = outcome.missing.length;
      next.push({
        tone: 'warn',
        text: `${n} ${n === 1 ? 'lead is' : 'leads are'} no longer there to change.`,
      });
    }
    if (!outcome.audited) {
      next.push({
        tone: 'err',
        text: 'Saved, but the activity log could not record it. Tell an admin.',
      });
    }
    setNotes(next);
    if (changed > 0 && outcome.conflicts.length === 0)
      toast(`Done. ${changed} ${changed === 1 ? 'lead' : 'leads'} changed.`, 'ok');
    setSelected(new Set());
    setReload((n) => n + 1);
  }

  const counts = summary?.per_stage ?? {};
  const chips = [
    { value: 'all', label: 'All', count: summary?.total },
    ...stages.map((stage) => ({ value: stage.id, label: stage.label, count: counts[stage.id] })),
    { value: 'unread', label: 'Unread', count: summary?.unread },
    { value: 'spam', label: 'Spam', count: summary?.spam },
  ];

  const columns: DataColumn<Row>[] = [
    {
      key: 'star',
      label: 'Starred',
      render: (row) => (
        <button
          type="button"
          className="lead-star btn--icon"
          data-variant="ghost"
          aria-pressed={row.is_starred === true}
          aria-label={`Star ${leadName(row)}`}
          onClick={() => void toggleStar(row)}
        >
          <Icon name="star" size={16} />
        </button>
      ),
    },
    {
      key: 'lead',
      label: 'Lead',
      render: (row) => (
        <>
          {row.read_at === null && (
            <>
              <span className="lead-dot" aria-hidden="true" />
              <span className="visually-hidden"> Unread</span>
            </>
          )}
          {text(row.company) && (
            <span className="lead-sub" dir="auto">
              {text(row.company)}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'interest',
      label: 'Interest',
      render: (row) => {
        const discipline = disciplineOfService(row.service_of_interest, disciplines);
        return (
          <>
            {interestText(row)}
            {discipline && <span className="lead-sub">{discipline}</span>}
          </>
        );
      },
    },
    {
      key: 'source',
      label: 'Source',
      render: (row) => <SourceBadge source={row.source} channel={row.channel} />,
    },
    {
      key: 'stage',
      label: 'Stage',
      render: (row) => <StageBadge stages={stages} id={row.stage_id} />,
    },
    {
      key: 'assigned',
      label: 'Assigned',
      render: (row) => <Assignee id={row.assigned_to} people={people} />,
    },
    {
      key: 'received',
      label: 'Received',
      render: (row) => {
        const at = text(row.created_at);
        const late = slaLabel(row.over_sla);
        return (
          <>
            <time dateTime={isoOf(at)} title={formatDateTime(at)}>
              {relTime(at, now)}
            </time>
            {late && <span className="lead-sla">{late}</span>}
          </>
        );
      },
    },
  ];

  const filtered =
    q !== '' ||
    filters.chip.kind !== 'all' ||
    filters.range !== 'all' ||
    Boolean(filters.assigned || filters.source || filters.channel || filters.discipline);

  return (
    <>
      {summary && <LeadKpiCards summary={summary} period={periodWords(filters.range)} />}
      {!summary && (
        <p className="msg" data-kind="error" role="alert">
          The figures could not be read just now.
        </p>
      )}
      <div className="toolbar">
        <LeadSearch
          value={q}
          error={searchError}
          onSearch={(term) => {
            setQ(term);
            setSearchError('');
            setFilters((f) => ({ ...f, page: 1 }));
          }}
        />
      </div>
      <div className="lead-chips">
        <Chips
          label="Filter by stage"
          chips={chips}
          selected={[chipValue(filters.chip)]}
          onChange={([value]) =>
            setFilters((f) => ({ ...f, chip: chipOf(value ?? 'all'), page: 1 }))
          }
        />
      </div>
      <LeadFilterSelects
        filters={filters}
        onChange={setFilters}
        people={people}
        disciplines={disciplines}
      />
      {notes.map((note) => (
        <Note key={note.text} tone={note.tone} role="status" className="lead-note">
          <p>{note.text}</p>
        </Note>
      ))}
      {starError && (
        <p className="msg" data-kind="error" role="alert">
          {starError}
        </p>
      )}
      <DataTable<Row>
        caption="Leads"
        columns={columns}
        rows={rows}
        rowName={leadName}
        rowHref={(row) => withLeadFilters(`/admin/leads/${row.id}`, firstPage(filters))}
        titleColumn="lead"
        total={total}
        offset={(filters.page - 1) * LEADS_PAGE_SIZE}
        limit={LEADS_PAGE_SIZE}
        onPage={(offset) =>
          setFilters((f) => ({ ...f, page: Math.floor(offset / LEADS_PAGE_SIZE) + 1 }))
        }
        busy={busy}
        error={error || undefined}
        empty={
          filtered
            ? { title: 'No leads match', text: 'Try another filter or clear the search.' }
            : { title: 'No leads yet', text: 'Inquiries from the site’s forms arrive here.' }
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (ids) => (
            <LeadsBulkBar
              ids={ids}
              versions={versions}
              people={people}
              stages={stages}
              spamView={spamView}
              onDone={bulkDone}
              onError={(message) => setNotes([{ tone: 'err', text: message }])}
            />
          ),
        }}
      />
      {addLead}
    </>
  );
}
