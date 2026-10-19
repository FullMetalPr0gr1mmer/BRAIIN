import { useCallback, useEffect, useRef, useState } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Icon from '@/components/admin/kit/Icon';
import StatusBadge, { Badge } from '@/components/admin/kit/StatusBadge';
import { adminFetch, describeError } from '@/lib/admin/client';
import SeoDrawer from './SeoDrawer';
import { SEO_TYPE_CHIPS, type SeoEntityType, type SeoListPage, type SeoListRow } from './types';

// The Pages tab of /admin/seo (Admin v2 U10, AV-19): every page, service, project and post
// with its SEO, one type at a time (the chips), 50 a page, a search over the address and the
// English title. The first page comes from the server (no fetch on first paint); the rest
// from GET /api/admin/entity-seo/list (Admin and SEO). Each row says, per field, whether the
// page has its own words (Custom) or uses its default (Default), whether search engines may
// index it, and whether its Arabic is complete; "Edit SEO for <page>" opens the drawer, and a
// save refreshes the list where it stands.

export const SEO_LIST_PATH = '/api/admin/entity-seo/list';
const LIMIT = 50;

export interface PagesTabProps {
  initial: SeoListPage;
  /** Advanced (the canonical address) in the drawer: `seo.entityMeta` at full. */
  canAdvanced: boolean;
}

/** The list's address for a type, an offset and a search. */
export function listUrl(type: SeoEntityType, offset: number, q: string): string {
  const params = new URLSearchParams({ type, offset: String(offset), limit: String(LIMIT) });
  const term = q.trim();
  if (term) params.set('q', term.slice(0, 64));
  return `${SEO_LIST_PATH}?${params.toString()}`;
}

function Kind({ custom }: { custom: boolean }) {
  return custom ? (
    <Badge tone="klein">Custom</Badge>
  ) : (
    <Badge tone="gray" plain>
      Default
    </Badge>
  );
}

/** A Custom/Default cell: the badge, then the English words the head shows, cut short. */
function wordsCell(field: SeoListRow['title']) {
  const words = (field.custom?.en || field.default.en).trim();
  return (
    <>
      <Kind custom={field.custom !== null} />
      {words && (
        <span className="cell-secondary seo-cell" dir="auto">
          {words.length > 60 ? `${words.slice(0, 59)}…` : words}
        </span>
      )}
    </>
  );
}

export default function PagesTab({ initial, canAdvanced }: PagesTabProps) {
  const [page, setPage] = useState<SeoListPage>(initial);
  const [type, setType] = useState<SeoEntityType>(initial.type);
  const [offset, setOffset] = useState(initial.offset);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<SeoListRow | null>(null);
  // The first view is the server's: no read until something changes.
  const first = useRef(true);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setPage(await adminFetch<SeoListPage>(listUrl(type, offset, query)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [type, offset, query]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load();
  }, [load]);

  const columns: DataColumn<SeoListRow>[] = [
    {
      key: 'label',
      label: 'Page',
      render: (row) => (
        <>
          <span className="seo-cell__name" dir="auto">
            {row.label}
          </span>
          <span className="cell-secondary" dir="ltr">
            {row.path ?? row.slug}
          </span>
          {row.status !== 'published' && <StatusBadge status={row.status} />}
        </>
      ),
    },
    { key: 'title', label: 'Title', render: (row) => wordsCell(row.title) },
    { key: 'description', label: 'Description', render: (row) => wordsCell(row.description) },
    {
      key: 'indexed',
      label: 'Index',
      render: (row) => (
        <Badge tone={row.indexed ? 'ok' : 'gray'}>{row.indexed ? 'Indexed' : 'Hidden'}</Badge>
      ),
    },
    {
      key: 'arabic',
      label: 'Arabic',
      render: (row) => (
        <Badge tone={row.arabicComplete ? 'ok' : 'warn'}>
          {row.arabicComplete ? 'Complete' : 'Arabic missing'}
        </Badge>
      ),
    },
  ];

  const typeLabel = SEO_TYPE_CHIPS.find((chip) => chip.value === type)?.label ?? 'Pages';

  return (
    <div>
      <DataTable<SeoListRow>
        caption={`SEO of ${typeLabel.toLowerCase()}`}
        columns={columns}
        rows={page.rows}
        rowName={(row) => row.label}
        total={page.total}
        offset={offset}
        limit={LIMIT}
        onPage={setOffset}
        busy={busy}
        error={error || undefined}
        actionsLabel="Actions"
        rowActions={(row) => (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOpen(row)}
            aria-label={`Edit SEO for ${row.label}`}
          >
            <Icon name="edit" size={15} />
          </button>
        )}
        toolbar={
          <>
            <Chips<SeoEntityType>
              label="Show"
              chips={SEO_TYPE_CHIPS}
              selected={[type]}
              onChange={([next]) => {
                if (!next) return;
                setOffset(0);
                setType(next);
              }}
            />
            <label className="visually-hidden" htmlFor="seo-search">
              Search {typeLabel.toLowerCase()}
            </label>
            <input
              id="seo-search"
              type="search"
              placeholder="Search by address or title…"
              maxLength={64}
              value={query}
              onChange={(event) => {
                setOffset(0);
                setQuery(event.target.value);
              }}
            />
          </>
        }
        empty={{
          title: query
            ? `No ${typeLabel.toLowerCase()} match`
            : `No ${typeLabel.toLowerCase()} yet`,
          text: query ? 'Try another search.' : 'They appear here once they are written.',
        }}
      />

      {open && (
        <SeoDrawer
          open
          onClose={() => setOpen(null)}
          target={{
            entityType: open.entityType,
            entityId: open.entityId,
            label: open.label,
            path: open.path,
          }}
          context={{
            brand: page.brand,
            titleTemplate: page.titleTemplate,
            defaults: { title: open.title.default, description: open.description.default },
            defaultRobots: page.defaultRobots,
          }}
          canAdvanced={canAdvanced}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}
