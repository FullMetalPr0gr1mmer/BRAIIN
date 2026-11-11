import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import { COMPANY_STAGES, type CompanyStage } from '@schemas/crmCompanies';
import type { CompanyPage, CompanyRow } from '@/lib/crm/companies';
import { CONTACT_STAGE_LABELS } from '@/lib/crm/contactView';
import { formatSar } from '@/lib/crm/leadView';
import { ContactStageBadge, Owner, useLazy, usePageButton } from '../shared';
import type { CompanyDrawerProps } from './CompanyDrawer';
import {
  COMPANY_SIZE_LABELS,
  companiesWord,
  companyHref,
  companyName,
  websiteHost,
  type CompanyChoices,
} from './shared';

// The Companies tab (Admin v2 C11, crm.md §11 screen 5): the organisations behind the people,
// with their website, sector, city, how many contacts, stage, won value and owner. The page
// renders the first page on the server; the island searches (a POST body, never an address),
// filters by stage and owner, sorts and pages, and opens the company drawer (loaded with
// import() on first use) to add, change or remove one. A company's address is its id only
// (`?company=<id>` opens its drawer), never its name.

export interface CompaniesListProps {
  initial: CompanyPage | null;
  choices: CompanyChoices;
  me: string;
  /** A company to open at once (the address's `?company=`, an id the page checked is a uuid). */
  open?: string | null | undefined;
}

type Chip = 'all' | CompanyStage;
type Sort = 'name' | 'recent' | 'contacts' | 'value';

const SORTS: readonly { value: Sort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Recently changed' },
  { value: 'contacts', label: 'Most contacts' },
  { value: 'value', label: 'Won value' },
];
export const COMPANIES_PAGE_SIZE = 25;

interface Filters {
  chip: Chip;
  owner: string;
  sort: Sort;
  page: number;
}

/** The list's request body for a view of it (POST /api/admin/crm/companies/query). */
export function companyQueryBody(filters: Filters, q: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sort: filters.sort,
    limit: COMPANIES_PAGE_SIZE,
    offset: (filters.page - 1) * COMPANIES_PAGE_SIZE,
  };
  if (q) body['q'] = q;
  if (filters.chip !== 'all') body['stage'] = filters.chip;
  if (filters.owner) body['owner'] = filters.owner;
  return body;
}

export default function CompaniesList({ initial, choices, me, open }: CompaniesListProps) {
  const ids = useId();
  const [filters, setFilters] = useState<Filters>({
    chip: 'all',
    owner: '',
    sort: 'name',
    page: 1,
  });
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<CompanyRow[]>(initial?.rows ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial ? '' : 'The companies could not be loaded just now.');
  const [editing, setEditing] = useState<string | null>(open ?? null);
  const first = useRef(true);
  const latest = useRef(0);

  async function load(next: Filters = filters, term: string = q) {
    const ticket = ++latest.current;
    setBusy(true);
    try {
      const answer = await adminFetch<{ rows: CompanyRow[]; total: number }>(
        '/api/admin/crm/companies/query',
        { method: 'POST', body: companyQueryBody(next, term) },
      );
      if (ticket !== latest.current) return;
      setRows(answer.rows);
      setTotal(answer.total);
      setError('');
    } catch (err) {
      if (ticket !== latest.current) return;
      setError(describeError(err));
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (initial) return;
    }
    void load();
  }, [filters, q]);

  const drawer = useLazy<CompanyDrawerProps>(
    () => import('./CompanyDrawer'),
    (shown, close) => ({
      open: shown,
      onClose: () => {
        close();
        setEditing(null);
      },
      companyId: editing,
      choices,
      me,
      onSaved: (company, created) => {
        if (company) toast(created ? 'Company added.' : 'Company saved.', 'ok');
        void load();
      },
      onDeleted: () => {
        toast('Company removed.', 'ok');
        void load();
      },
    }),
  );
  const openDrawer = (id: string | null) => {
    setEditing(id);
    drawer.open();
  };
  usePageButton('[data-company-add]', true, () => openDrawer(null));
  // A company named by the address opens at once.
  useEffect(() => {
    if (open) drawer.open();
  }, []);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const filtered = q !== '' || filters.chip !== 'all' || filters.owner !== '';

  function search(event: FormEvent) {
    event.preventDefault();
    setQ(draft.trim());
    set({});
  }

  const chips = [
    { value: 'all' as Chip, label: 'All' },
    ...COMPANY_STAGES.map((stage) => ({
      value: stage as Chip,
      label: CONTACT_STAGE_LABELS[stage],
    })),
  ];

  const columns: DataColumn<CompanyRow>[] = [
    {
      key: 'name',
      label: 'Company',
      render: (row) => (
        <>
          {row.size && (
            <span className="lead-sub">
              {COMPANY_SIZE_LABELS[row.size as keyof typeof COMPANY_SIZE_LABELS] ?? row.size}
            </span>
          )}
          {row.auto && <span className="lead-sub">Made from an inquiry</span>}
        </>
      ),
    },
    {
      key: 'website',
      label: 'Website',
      render: (row) =>
        row.website ? (
          <span dir="ltr">{websiteHost(row.website)}</span>
        ) : (
          <span className="lead-sub">Not given</span>
        ),
    },
    {
      key: 'sector',
      label: 'Sector',
      render: (row) =>
        row.sector_name ? (
          <span dir="auto">{row.sector_name}</span>
        ) : (
          <span className="lead-sub">Not given</span>
        ),
    },
    {
      key: 'city',
      label: 'City',
      render: (row) =>
        row.city ? <span dir="auto">{row.city}</span> : <span className="lead-sub">Not given</span>,
    },
    { key: 'contacts', label: 'Contacts', num: true, render: (row) => String(row.contacts) },
    { key: 'stage', label: 'Stage', render: (row) => <ContactStageBadge stage={row.stage} /> },
    {
      key: 'value',
      label: 'Won value',
      num: true,
      render: (row) => (row.won_value > 0 ? formatSar(row.won_value) : ''),
    },
    {
      key: 'owner',
      label: 'Owner',
      render: (row) => <Owner id={row.owner_id} people={choices.people} />,
    },
  ];

  return (
    <>
      <p className="lead-sub" role="status">
        {companiesWord(total)}
        {filtered ? ' match' : ''}
      </p>
      <div className="toolbar">
        <form role="search" className="lead-search" onSubmit={search}>
          <div className="lead-search__box">
            <label className="visually-hidden" htmlFor={`${ids}-q`}>
              Search companies
            </label>
            <input
              id={`${ids}-q`}
              type="search"
              maxLength={64}
              autoComplete="off"
              dir="auto"
              placeholder="Search by company name"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (event.target.value === '' && q !== '') {
                  setQ('');
                  set({});
                }
              }}
            />
          </div>
          <button type="submit">Search</button>
        </form>
      </div>
      <div className="lead-chips">
        <Chips
          label="Filter by stage"
          chips={chips}
          selected={[filters.chip]}
          onChange={([value]) => set({ chip: value ?? 'all' })}
        />
      </div>
      <div className="lead-filters">
        <div className="f">
          <label className="f__l" htmlFor={`${ids}-owner`}>
            Owner
          </label>
          <select
            id={`${ids}-owner`}
            value={filters.owner}
            onChange={(event) => set({ owner: event.target.value })}
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">No owner</option>
            {choices.people
              .filter((p) => p.canOwn)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <div className="f">
          <label className="f__l" htmlFor={`${ids}-sort`}>
            Sort
          </label>
          <select
            id={`${ids}-sort`}
            value={filters.sort}
            onChange={(event) =>
              set({ sort: SORTS.find((s) => s.value === event.target.value)?.value ?? 'name' })
            }
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DataTable<CompanyRow>
        caption="Companies"
        columns={columns}
        rows={rows}
        rowName={companyName}
        rowHref={(row) => companyHref(row.id)}
        titleColumn="name"
        total={total}
        offset={(filters.page - 1) * COMPANIES_PAGE_SIZE}
        limit={COMPANIES_PAGE_SIZE}
        onPage={(offset) =>
          setFilters((f) => ({ ...f, page: Math.floor(offset / COMPANIES_PAGE_SIZE) + 1 }))
        }
        rowActions={(row) => (
          <button type="button" data-size="sm" onClick={() => openDrawer(row.id)}>
            Edit <span className="visually-hidden">{companyName(row)}</span>
          </button>
        )}
        actionsLabel="Actions"
        busy={busy}
        error={error || undefined}
        empty={
          filtered
            ? { title: 'No company matches', text: 'Try another filter or clear the search.' }
            : {
                title: 'No companies yet',
                text: 'They arrive with inquiries that name one, or you can add one.',
              }
        }
      />
      {drawer.element}
    </>
  );
}
