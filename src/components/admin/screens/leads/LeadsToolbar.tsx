import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { MANUAL_LEAD_CHANNELS, type LeadAssignedFilter, type LeadChannel } from '@schemas/crm';
import type { DisciplineView, PersonView } from '@/lib/crm/leadPage';
import type { LeadFilters, LeadSort } from '@/lib/crm/leadUrl';
import { CHANNEL_LABELS, type LeadRange } from '@/lib/crm/leadView';

// The leads list's and board's toolbar (Admin v2 C4b, crm.md §11): the search, and the
// selects with visible labels. The search is posted in a body only, never put in the address
// (verification D10); the selects change the filters, which the island keeps in the address.

export const SEARCH_PLACEHOLDER =
  'Search name, company or message. Full e-mail or phone also works.';

interface SearchProps {
  /** The term in force (empty for none). */
  value: string;
  onSearch: (term: string) => void;
  /** The server's word on a term it cannot read (a part of an e-mail address, say). */
  error: string;
  label?: string;
}

/**
 * The search box: a form, so Enter searches and the term is never half-sent while typed (a
 * part of an address would be refused on every key). Clearing it searches for everything.
 */
export function LeadSearch({ value, onSearch, error, label = 'Search leads' }: SearchProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(draft.trim());
  };
  return (
    <form role="search" className="lead-search" onSubmit={submit}>
      <div className="lead-search__box">
        <label className="visually-hidden" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          type="search"
          maxLength={64}
          autoComplete="off"
          placeholder={SEARCH_PLACEHOLDER}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            // The browser's clear button, or the last character deleted: everything again.
            if (event.target.value === '' && value !== '') onSearch('');
          }}
        />
        {error && (
          <p id={`${id}-error`} className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <button type="submit">Search</button>
    </form>
  );
}

type Shared = Pick<LeadFilters, 'assigned' | 'source' | 'channel' | 'discipline' | 'range'>;

interface FilterProps {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  people: readonly PersonView[];
  disciplines: readonly DisciplineView[];
  /** The list sorts; the board has its own order (newest first in each column). */
  withSort?: boolean;
}

const RANGES: readonly { value: LeadRange; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const SORTS: readonly { value: LeadSort; label: string }[] = [
  { value: 'starred', label: 'Starred first' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'score', label: 'Score' },
];

/** Each control named by its own label (for/id), never one wrapping a <select>. */
function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="f">
      <label className="f__l" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </div>
  );
}

export function LeadFilterSelects({
  filters,
  onChange,
  people,
  disciplines,
  withSort = true,
}: FilterProps) {
  // A change of filter starts the list again from its first page.
  const set = (patch: Partial<Shared> | { sort: LeadSort }) =>
    onChange({ ...filters, ...patch, page: 1 });
  return (
    <div className="lead-filters">
      <Select
        label="Discipline"
        value={filters.discipline ?? ''}
        onChange={(value) => set({ discipline: value || null })}
      >
        <option value="">Every discipline</option>
        {disciplines.map((discipline) => (
          <option key={discipline.slug} value={discipline.slug}>
            {discipline.name}
          </option>
        ))}
      </Select>
      <Select
        label="Source"
        value={filters.source ?? ''}
        onChange={(value) =>
          set({
            source: value === 'web_form' || value === 'manual' ? value : null,
            // How they reached us belongs to a lead added by hand.
            channel: value === 'manual' ? filters.channel : null,
          })
        }
      >
        <option value="">Every source</option>
        <option value="web_form">Web form</option>
        <option value="manual">Added by hand</option>
      </Select>
      {filters.source === 'manual' && (
        <Select
          label="How they reached us"
          value={filters.channel ?? ''}
          onChange={(value) =>
            set({
              channel: (MANUAL_LEAD_CHANNELS as readonly string[]).includes(value)
                ? (value as LeadChannel)
                : null,
            })
          }
        >
          <option value="">Any way</option>
          {MANUAL_LEAD_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {CHANNEL_LABELS[channel]}
            </option>
          ))}
        </Select>
      )}
      <Select
        label="Assigned"
        value={filters.assigned ?? ''}
        onChange={(value) => set({ assigned: (value || null) as LeadAssignedFilter | null })}
      >
        <option value="">Anyone</option>
        <option value="me">Me</option>
        <option value="none">Nobody</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
        {/* A person the address names who is not on the team now still reads as chosen. */}
        {filters.assigned &&
          filters.assigned !== 'me' &&
          filters.assigned !== 'none' &&
          !people.some((person) => person.id === filters.assigned) && (
            <option value={filters.assigned}>Someone no longer on the team</option>
          )}
      </Select>
      <Select
        label="Range"
        value={filters.range}
        onChange={(value) =>
          set({ range: RANGES.find((range) => range.value === value)?.value ?? 'all' })
        }
      >
        {RANGES.map((range) => (
          <option key={range.value} value={range.value}>
            {range.label}
          </option>
        ))}
      </Select>
      {withSort && (
        <Select
          label="Sort"
          value={filters.sort}
          onChange={(value) =>
            set({ sort: SORTS.find((sort) => sort.value === value)?.value ?? 'starred' })
          }
        >
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value}>
              {sort.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/**
 * What a KPI's change is measured against, said after it ("Up 20% vs the 7 days before"):
 * the same elapsed span one range earlier (src/lib/crm/leadView.ts). Null for all time.
 */
export function periodWords(range: LeadRange): string | null {
  return range === 'all' ? null : `the ${range} days before`;
}
