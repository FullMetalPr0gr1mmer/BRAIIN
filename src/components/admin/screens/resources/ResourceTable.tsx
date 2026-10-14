import { useCallback, useEffect, useState } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Icon from '@/components/admin/kit/Icon';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { PAGE_SIZE } from '@/lib/admin/pager';
import { formatDate } from '@/lib/admin/relTime';
import { toast } from '@/lib/admin/toast';
import { uiFor, type ColumnDef, type SyncActionDef } from '@/lib/admin/uiSchema';

// The list view for every CRUD resource. Reads its shape from RESOURCE_UI, so adding an
// entity is a config entry rather than a component.
//
// Since Admin v2 F4b it is drawn by the kit's DataTable (ui.md AV-07), its props, state and
// requests unchanged: the first column's text is a real link to the edit screen, stretched
// over the row; Move up, Move down and Delete are the row's actions (shown on hover and
// whenever focus is in the row); the status filter is chips; the range and the numbered
// pages sit under the table. Dates are the studio's (Asia/Riyadh, relTime.ts): one clock
// for every screen, whoever's browser shows it. (The rows are fetched after mount, so the
// server's HTML holds no dates to disagree with.)
//
// Note what the delete button does NOT do: it never checks the caller's role to decide
// whether to render. The server answers `content.archiveDelete` (Admin-only), and a
// non-admin who clicks gets a 403 rendered as a message. Hiding it would be nicer UX;
// hiding it *instead of* the server check is the bug CLAUDE.md calls out by name, and
// mixing the two invites someone to later "simplify" by keeping only the visible half.

interface Row extends Record<string, unknown> {
  id: string;
  version: number;
}

interface ListResponse {
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResourceTableProps {
  resource: string;
  /** Extra query string appended to the list call (e.g. `page_id=…` for sections). */
  filter?: string;
}

/** The status filter's chips: every lifecycle state, and "All" (no filter). */
const STATUS_CHIPS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
] as const;

type StatusChip = (typeof STATUS_CHIPS)[number]['value'];

export default function ResourceTable({ resource, filter = '' }: ResourceTableProps) {
  const ui = uiFor(resource);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  // Bumped after every delete so the edge status line re-reads (a delete rebuilds the
  // snapshot server-side; the line must not keep showing the old count).
  const [syncEpoch, setSyncEpoch] = useState(0);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status) params.set('status', status);
      if (query) params.set('q', query);
      const suffix = filter ? `&${filter}` : '';
      const data = await adminFetch<ListResponse>(
        `/api/admin/${ui.slug}?${params.toString()}${suffix}`,
      );
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [ui.slug, offset, status, query, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(row: Row) {
    // A real <dialog>, not window.confirm: the browser can suppress repeated native
    // confirms wholesale, at which point destructive actions silently resolve one way
    // or the other. confirmDialog puts initial focus on Cancel.
    const confirmed = await confirmDialog({
      message: deleteMessage(ui.singular, rowName(row)),
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setError('');
    try {
      const result = await adminFetch<{ kvSynced?: boolean }>(`/api/admin/${ui.slug}/${row.id}`, {
        method: 'DELETE',
      });
      toast(`${ui.singular} deleted.`, 'ok');
      if (result.kvSynced === false) setError(EDGE_NOT_SYNCED);
      setSyncEpoch((n) => n + 1);
      await load();
    } catch (err) {
      // Errors stay inline, never in a toast — they must not auto-dismiss.
      setError(describeError(err));
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    const a = rows[index];
    const b = rows[target];
    if (!a || !b) return;
    setError('');
    try {
      // Swaps the two rows' sort_order. One round-trip, and the server applies both in
      // the same tenant-scoped loop, so a half-applied reorder is not reachable.
      await adminFetch(`/api/admin/${ui.slug}/reorder`, {
        method: 'POST',
        body: {
          items: [
            { id: a.id, sortOrder: Number(b['sort_order'] ?? target) },
            { id: b.id, sortOrder: Number(a['sort_order'] ?? index) },
          ],
        },
      });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const [first, ...rest] = ui.columns;
  const rowName = (row: Row) => (first ? nameOf(row[first.key], first, ui.singular) : row.id);
  const columns: DataColumn<Row>[] = [
    ...(first
      ? [
          {
            key: first.key,
            label: first.label,
            // The link says the row's name; a bilingual title's Arabic follows it.
            render: (row: Row) => secondLine(row[first.key], first),
          },
        ]
      : []),
    ...rest.map((column) => ({
      key: column.key,
      label: column.label,
      render: (row: Row) => renderCell(row[column.key], column),
    })),
  ];

  return (
    <div>
      {ui.syncAction && <SyncStatus action={ui.syncAction} epoch={syncEpoch} />}

      <DataTable<Row>
        caption={ui.title}
        columns={columns}
        rows={rows}
        rowName={rowName}
        rowHref={(row) => `/admin/${ui.slug}/${row.id}`}
        rowLang={(row) => (first ? nameLang(row[first.key], first) : undefined)}
        total={total}
        offset={offset}
        limit={PAGE_SIZE}
        onPage={setOffset}
        busy={busy}
        error={error || undefined}
        actionsLabel="Actions"
        rowActions={(row, index) => (
          <>
            {ui.reorder && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${rowName(row)} up`}
                >
                  <Icon name="chevd" size={15} className="ic--flip" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void move(index, 1)}
                  disabled={index === rows.length - 1}
                  aria-label={`Move ${rowName(row)} down`}
                >
                  <Icon name="chevd" size={15} />
                </button>
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              data-variant="danger"
              onClick={() => void remove(row)}
              aria-label={`Delete ${rowName(row)}`}
            >
              <Icon name="trash" size={15} />
            </button>
          </>
        )}
        toolbar={
          <>
            <a className="btn" data-variant="primary" href={`/admin/${ui.slug}/new`}>
              <Icon name="plus" size={16} />
              New {ui.singular.toLowerCase()}
            </a>
            <label className="visually-hidden" htmlFor={`${ui.slug}-search`}>
              Search {ui.title}
            </label>
            <input
              id={`${ui.slug}-search`}
              type="search"
              placeholder="Search…"
              value={query}
              onChange={(event) => {
                setOffset(0);
                setQuery(event.target.value);
              }}
            />
            {ui.hasStatus && (
              <Chips<StatusChip>
                label="Filter by status"
                chips={STATUS_CHIPS}
                selected={[(status || 'all') as StatusChip]}
                onChange={([next]) => {
                  setOffset(0);
                  setStatus(!next || next === 'all' ? '' : next);
                }}
              />
            )}
          </>
        }
        empty={{
          title:
            query || status
              ? `No ${ui.title.toLowerCase()} match`
              : `No ${ui.title.toLowerCase()} yet`,
          text:
            query || status
              ? 'Try another search or filter.'
              : `Add the first one with “New ${ui.singular.toLowerCase()}”.`,
        }}
      />
    </div>
  );
}

/**
 * The delete confirmation names the row: its trigger is an icon tied to the row only by
 * hover and its accessible name, so the dialog is where a press on the wrong row is
 * caught. The name is a bidi isolate (FSI…PDI), so an Arabic name cannot reorder the
 * English sentence around it.
 */
export function deleteMessage(singular: string, name: string): string {
  return `Delete the ${singular.toLowerCase()} “\u2068${name}\u2069”? This cannot be undone.`;
}

/**
 * The maintenance panel's wording (MaintenancePanel.tsx), reused: the row is committed,
 * the edge snapshot is not, and the operator must act — never a silent 200.
 */
export const EDGE_NOT_SYNCED =
  'Saved to the database, but the edge did not pick it up. The site is still serving the previous rules — retry with “Sync to edge” before relying on this.';

interface SyncStatusProps {
  action: SyncActionDef;
  /** Any change bumps it and the counts are re-read. */
  epoch: number;
}

/**
 * "Sync to edge" and the status line beside it. The table is the source of truth, the
 * snapshot is what the public request path reads (Round 3, design-port R3-1); this is
 * the one place the two are compared, so an operator can see "12 in the database, none
 * at the edge" after a deploy and fix it with one click (runbook §6f).
 */
function SyncStatus({ action, epoch }: SyncStatusProps) {
  const [counts, setCounts] = useState<{ db: number; edge: number | null } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCounts(await adminFetch<{ db: number; edge: number | null }>(action.endpoint));
    } catch (err) {
      setError(describeError(err));
    }
  }, [action.endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh, epoch]);

  async function sync() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await adminFetch<{ kvSynced: boolean; count: number; truncated: boolean }>(
        action.endpoint,
        { method: 'POST' },
      );
      await refresh();
      if (!result.kvSynced) setError(EDGE_NOT_SYNCED);
      else
        setNotice(
          `${result.count} rule${result.count === 1 ? '' : 's'} live at the edge.` +
            (result.truncated ? ' The table holds more rules than one snapshot carries.' : ''),
        );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toolbar" data-sync>
      <button type="button" onClick={() => void sync()} disabled={busy}>
        {action.label}
      </button>
      <span className="admin-sub" aria-live="polite">
        {counts === null
          ? 'Edge status unknown.'
          : counts.edge === null
            ? `${counts.db} in the database · nothing at the edge yet — sync to make the rules live.`
            : counts.db === counts.edge
              ? `${counts.db} in the database · ${counts.edge} at the edge.`
              : `${counts.db} in the database · ${counts.edge} at the edge — out of step, sync.`}
      </span>
      {notice && (
        <span className="msg" data-kind="ok" role="status">
          {notice}
        </span>
      )}
      {error && (
        <span className="msg" data-kind="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** A bilingual value's two sides, '' where one is missing or not text. */
function sides(value: unknown): { en: string; ar: string } {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    en: typeof record['en'] === 'string' ? record['en'] : '',
    ar: typeof record['ar'] === 'string' ? record['ar'] : '',
  };
}

/**
 * The row's name, for its link and the labels of its actions ("Delete Logo design"): the
 * first column's text (a bilingual one's English, else its Arabic), never empty.
 */
export function nameOf(value: unknown, column: ColumnDef, singular: string): string {
  if (column.kind === 'bilingual') {
    const { en, ar } = sides(value);
    return en.trim() || ar.trim() || `Untitled ${singular.toLowerCase()}`;
  }
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || `Untitled ${singular.toLowerCase()}`;
}

/**
 * The language of the row's name when it is not English: a bilingual title with only its
 * Arabic, which nameOf then uses for the link. Undefined otherwise.
 */
export function nameLang(value: unknown, column: ColumnDef): 'ar' | undefined {
  if (column.kind !== 'bilingual') return undefined;
  const { en, ar } = sides(value);
  return !en.trim() && ar.trim() ? 'ar' : undefined;
}

/**
 * Under the link: a bilingual title's Arabic, or the cue that a side is missing. With no
 * English the link already says the Arabic (nameOf, read as Arabic through nameLang), so
 * only "no English" follows: the same words twice would be read twice.
 */
export function secondLine(value: unknown, column: ColumnDef) {
  if (column.kind !== 'bilingual') return null;
  const { en, ar } = sides(value);
  const hasEn = en.trim() !== '';
  const hasAr = ar.trim() !== '';
  return (
    <>
      {!hasEn && (
        <div className="cell-secondary">
          <em>no English</em>
        </div>
      )}
      {(hasEn || !hasAr) && <ArabicLine ar={ar} />}
    </>
  );
}

/**
 * A bilingual value's Arabic line, or "no Arabic". dir="rtl" and lang="ar" on the Arabic
 * only: a mixed table where the Arabic renders LTR shows correct characters with the
 * punctuation in the wrong place, which reviewers reliably miss, and the English cue is
 * not Arabic.
 */
function ArabicLine({ ar }: { ar: string }) {
  return ar.trim() ? (
    <div dir="rtl" lang="ar" className="cell-secondary">
      {ar}
    </div>
  ) : (
    <div className="cell-secondary">
      <em>no Arabic</em>
    </div>
  );
}

export function renderCell(value: unknown, column: ColumnDef) {
  if (value === null || value === undefined) return '—';
  switch (column.kind) {
    case 'status':
      return <StatusBadge status={String(value)} />;
    case 'date':
      // An unreadable date is an empty cell, as in ServerTable: no dash (P-12).
      return formatDate(String(value));
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'bilingual': {
      const { en, ar } = sides(value);
      return (
        <>
          <div dir="auto">{en || <em>no English</em>}</div>
          <ArabicLine ar={ar} />
        </>
      );
    }
    default:
      return <span dir="auto">{String(value)}</span>;
  }
}
