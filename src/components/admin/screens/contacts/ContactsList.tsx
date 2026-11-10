import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { showFlash } from '@/lib/admin/flash';
import { isoOf } from '@/lib/admin/relTime';
import { toast } from '@/lib/admin/toast';
import {
  CONTACT_STAGES,
  type ContactBulk,
  type ContactStage,
  type LeadAssignedFilter,
} from '@schemas/crm';
import {
  BULK_WAIT_MS,
  Checks,
  ListWrites,
  ROW_WAIT_MS,
  RowPresses,
  bulkUnsure,
  failureOf,
  pressStar,
  rowWrite,
  sayFor,
  starOutcome,
  starPending,
  withDeadline,
  type StarCheck,
} from '@/lib/crm/lateAnswers';
import { formatSar } from '@/lib/crm/leadView';
import type { ContactPage, ContactRow } from '@/lib/crm/contactPage';
import {
  CONTACTS_PAGE_SIZE,
  contactQueryOf,
  withContactFilters,
  type ContactChip,
  type ContactFilters,
  type ContactSort,
} from '@/lib/crm/contactUrl';
import {
  CONTACT_STAGE_LABELS,
  contactName,
  contactsSubline,
  tagsShown,
  type ContactSummary,
} from '@/lib/crm/contactView';
import type { AddContactDrawerProps } from './AddContactDrawer';
import {
  ContactSearch,
  ContactStageBadge,
  Owner,
  useLazy,
  usePageButton,
  type ContactPerson,
} from './shared';

// The People list (Admin v2 C7, crm.md §11 screen 5): the chips with their counts, the search
// and the filters, a table of 20 a page with a bulk bar, and Add contact. The page renders the
// first view on the server (src/lib/crm/contactPage.ts); this island takes over: a filter
// change rewrites the address (history.replaceState; never the search or the tag) and reads the
// list again through POST /api/admin/crm/contacts/query, the counts through POST …/summary.
//
// PII (crm.md §11): a row carries the safe columns only: no e-mail, phone, note or consent
// column. Contact details are revealed one person at a time, on their own page, audited. The
// star and the bulk bar follow the leads list's late-answer rules (src/lib/crm/lateAnswers.ts),
// so a read that left before a change never draws it back.

export interface ContactsListProps {
  initial: { summary: ContactSummary | null; page: ContactPage | null };
  filters: ContactFilters;
  people: ContactPerson[];
  me: string;
  /** The server's clock when it rendered, so the first render's "3 h ago" matches. */
  now: string;
}

/** What the bulk route answers. */
interface BulkOutcome {
  applied: { id: string; version: number | null }[];
  conflicts: { id: string; version: number | null }[];
  missing: string[];
  skipped: string[];
  audited: boolean;
}

const SORTS: readonly { value: ContactSort; label: string }[] = [
  { value: 'recent', label: 'Last activity' },
  { value: 'name', label: 'Name' },
  { value: 'starred', label: 'Starred first' },
  { value: 'oldest', label: 'Oldest' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function BulkBar({
  ids,
  versions,
  people,
  post,
}: {
  ids: readonly string[];
  versions: ReadonlyMap<string, number>;
  people: readonly ContactPerson[];
  post: (body: ContactBulk) => Promise<void>;
}) {
  const id = useId();
  const [tag, setTag] = useState('');
  const [owner, setOwner] = useState('');
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState(false);
  const versioned = ids.map((contact) => ({ id: contact, version: versions.get(contact) ?? 1 }));
  const run = (body: ContactBulk) => {
    setBusy(true);
    void post(body).finally(() => setBusy(false));
  };
  const word = tag.trim();
  return (
    <>
      <span className="lead-bulk__g">
        <label className="visually-hidden" htmlFor={`${id}-tag`}>
          Tag for the selected contacts
        </label>
        <input
          id={`${id}-tag`}
          maxLength={32}
          placeholder="Tag"
          value={tag}
          dir="auto"
          onChange={(e) => setTag(e.target.value)}
        />
        <button
          type="button"
          data-size="sm"
          disabled={busy || !word}
          onClick={() => run({ action: 'tagAdd', value: word, items: versioned })}
        >
          Add tag
        </button>
        <button
          type="button"
          data-size="sm"
          disabled={busy || !word}
          onClick={() => run({ action: 'tagRemove', value: word, items: versioned })}
        >
          Remove tag
        </button>
      </span>
      <span className="lead-bulk__g">
        <label className="visually-hidden" htmlFor={`${id}-owner`}>
          New owner for the selected contacts
        </label>
        <select id={`${id}-owner`} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Change owner…</option>
          <option value="none">No owner</option>
          {people
            .filter((person) => person.canOwn)
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
        </select>
        <button
          type="button"
          data-size="sm"
          disabled={busy || owner === ''}
          onClick={() =>
            run({ action: 'owner', value: owner === 'none' ? null : owner, items: versioned })
          }
        >
          Change
        </button>
      </span>
      <span className="lead-bulk__g">
        <label className="visually-hidden" htmlFor={`${id}-stage`}>
          New stage for the selected contacts
        </label>
        <select id={`${id}-stage`} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Change stage…</option>
          {CONTACT_STAGES.map((s) => (
            <option key={s} value={s}>
              {CONTACT_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-size="sm"
          disabled={busy || stage === ''}
          onClick={() =>
            run({
              action: 'stage',
              value: stage as ContactStage,
              items: versioned,
            })
          }
        >
          Move
        </button>
      </span>
      <button
        type="button"
        data-size="sm"
        disabled={busy}
        onClick={() => run({ action: 'star', value: true, items: ids.map((c) => ({ id: c })) })}
      >
        Star
      </button>
    </>
  );
}

export default function ContactsList({
  initial,
  filters: start,
  people,
  me,
  now: renderedAt,
}: ContactsListProps) {
  const { formatDateTime, relTime } = useClock();
  const tagId = useId();
  const sortId = useId();
  const ownerId = useId();
  const [filters, setFilters] = useState<ContactFilters>(start);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [rows, setRows] = useState<ContactRow[]>(() => initial.page?.rows ?? []);
  const [total, setTotal] = useState(initial.page?.total ?? 0);
  const [summary, setSummary] = useState<ContactSummary | null>(initial.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    initial.page ? '' : 'The contacts could not be loaded just now. Try again in a moment.',
  );
  const [searchError, setSearchError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<{ tone: 'warn' | 'err'; text: string }[]>([]);
  const [starWords, setStarWords] = useState<Record<string, string>>({});
  const [relist, setRelist] = useState(0);
  const [recount, setRecount] = useState(0);
  const [now, setNow] = useState(() => Date.parse(renderedAt));
  const [writes] = useState(() => new ListWrites());
  const [stars] = useState(() => new Checks<StarCheck>());
  const [presses] = useState(() => new RowPresses());

  const addContact = useLazy<AddContactDrawerProps>(
    () => import('./AddContactDrawer'),
    (open, close) => ({ open, onClose: close, people, me }),
  );
  usePageButton('[data-contact-add]', true, addContact.open);

  // A confirmation the last page sent here (a contact erased): shown once, then taken out of
  // the address. First, before the address is rewritten from the filters.
  useEffect(() => showFlash(), []);

  // The address follows the filters (never the search or the tag).
  useEffect(() => {
    const href = withContactFilters('/admin/contacts', filters);
    if (`${location.pathname}${location.search}` !== href) history.replaceState(null, '', href);
  }, [filters]);

  const listed = useRef(initial.page !== null);
  useEffect(() => {
    if (listed.current) {
      listed.current = false;
      return;
    }
    setBusy(true);
    const controller = writes.read();
    if (!controller) return;
    const body = contactQueryOf(filters, { q, tag });
    withDeadline(
      (signal) =>
        adminFetch<ContactPage>('/api/admin/crm/contacts/query', { method: 'POST', body, signal }),
      ROW_WAIT_MS,
      controller.signal,
    )
      .then((page) => {
        if (!writes.landed(controller)) return;
        setRows(page.rows);
        setTotal(page.total);
        setError('');
        setSearchError('');
        setNow(Date.now());
        settleStars(page.rows);
      })
      .catch((err: unknown) => {
        if (!writes.landed(controller)) return;
        settleStars(null);
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
  }, [filters, q, tag, relist]);

  // The counts: the chips and the page head's sub-line, read again after a bulk change.
  const counted = useRef(true);
  useEffect(() => {
    if (counted.current) {
      counted.current = false;
      return;
    }
    const controller = new AbortController();
    adminFetch<ContactSummary>('/api/admin/crm/contacts/summary', {
      method: 'POST',
      body: {},
      signal: controller.signal,
    })
      .then(setSummary)
      .catch(() => undefined);
    return () => controller.abort();
  }, [recount]);

  useEffect(() => {
    const line = document.querySelector('.admin-header .admin-sub');
    if (line && summary) line.textContent = contactsSubline(summary);
  }, [summary]);

  const versions = useMemo(
    () => new Map(rows.map((row) => [row.id, Number(row.version) || 1])),
    [rows],
  );
  const reread = () => setRelist((n) => n + 1);

  function settleStars(fresh: ContactRow[] | null) {
    for (const check of stars.take()) {
      const row = fresh?.find((r) => r.id === check.id);
      const said = starOutcome(check, row ? row.is_starred === true : undefined);
      setStarWords((words) => sayFor(words, check.id, said));
    }
  }

  async function toggleStar(row: ContactRow) {
    const next = row.is_starred !== true;
    stars.drop(row.id);
    setStarWords((words) => sayFor(words, row.id, ''));
    await pressStar(
      writes,
      next,
      {
        show: (on) =>
          setRows((list) => list.map((r) => (r.id === row.id ? { ...r, is_starred: on } : r))),
        send: (signal) =>
          adminFetch(`/api/admin/crm/contacts/${row.id}`, {
            method: 'PATCH',
            body: { isStarred: next },
            signal,
          }),
        failed: (err) => {
          const check = { id: row.id, name: contactName(row), next, ...failureOf(err) };
          stars.add(check);
          setStarWords((words) => sayFor(words, row.id, starPending(check)));
        },
        reread,
      },
      ROW_WAIT_MS,
      { presses, id: row.id },
    );
  }

  /** One bulk action: a row write (not optimistic), then the list and the counts read again. */
  async function postBulk(body: ContactBulk) {
    try {
      const outcome = await rowWrite(
        writes,
        (signal) =>
          adminFetch<BulkOutcome>('/api/admin/crm/contacts/bulk', {
            method: 'POST',
            body,
            signal,
          }),
        reread,
        BULK_WAIT_MS,
      );
      const said: { tone: 'warn' | 'err'; text: string }[] = [];
      if (outcome.conflicts.length > 0)
        said.push({
          tone: 'warn',
          text: `${plural(outcome.conflicts.length, 'contact was', 'contacts were')} changed by someone else. Refreshed.`,
        });
      if (outcome.missing.length > 0)
        said.push({
          tone: 'warn',
          text: `${plural(outcome.missing.length, 'contact is', 'contacts are')} no longer there to change.`,
        });
      if (outcome.skipped.length > 0)
        said.push({
          tone: 'warn',
          text: `${plural(outcome.skipped.length, 'contact already has', 'contacts already have')} 10 tags, so nothing was added.`,
        });
      if (!outcome.audited)
        said.push({
          tone: 'err',
          text: 'Saved, but the activity log could not record it. Tell an admin.',
        });
      setNotes(said);
      const changed = outcome.applied.length;
      if (changed > 0 && said.length === 0)
        toast(`Done. ${plural(changed, 'contact', 'contacts')} changed.`, 'ok');
      setSelected(new Set());
    } catch (err) {
      const refused = err instanceof AdminApiError && err.info.status < 500;
      const detail = describeError(err);
      setNotes([
        refused ? { tone: 'err', text: detail } : { tone: 'warn', text: bulkUnsure(detail) },
      ]);
    } finally {
      setRecount((n) => n + 1);
    }
  }

  const chips: { value: ContactChip; label: string; count: number | undefined }[] = [
    { value: 'all', label: 'All', count: summary?.total },
    ...CONTACT_STAGES.map((stage) => ({
      value: stage,
      label: CONTACT_STAGE_LABELS[stage],
      count: summary?.[stage],
    })),
    { value: 'starred', label: 'Starred', count: summary?.starred },
    { value: 'expiring', label: 'Expiring soon', count: summary?.expiring },
  ];

  const columns: DataColumn<ContactRow>[] = [
    {
      key: 'star',
      label: 'Starred',
      render: (row) => (
        <button
          type="button"
          className="lead-star btn--icon"
          data-variant="ghost"
          aria-pressed={row.is_starred === true}
          aria-label={`Star ${contactName(row)}`}
          onClick={() => void toggleStar(row)}
        >
          <Icon name="star" size={16} />
        </button>
      ),
    },
    {
      key: 'person',
      label: 'Person',
      render: (row) => (
        <>
          {typeof row.title === 'string' && row.title && (
            <span className="lead-sub" dir="auto">
              {row.title}
            </span>
          )}
          {typeof row.to_check === 'number' && row.to_check > 0 && (
            <span className="lead-sla">Phone match to check</span>
          )}
        </>
      ),
    },
    {
      key: 'company',
      label: 'Company',
      render: (row) =>
        typeof row.company_name === 'string' && row.company_name ? (
          <span dir="auto">{row.company_name}</span>
        ) : (
          <span className="lead-sub">Not given</span>
        ),
    },
    { key: 'stage', label: 'Stage', render: (row) => <ContactStageBadge stage={row.stage} /> },
    {
      key: 'tags',
      label: 'Tags',
      render: (row) => {
        const { tags, more } = tagsShown(row.tags);
        return tags.length === 0 ? (
          <span className="lead-sub">None</span>
        ) : (
          <span className="ct-tags">
            {tags.map((t) => (
              <span key={t} className="lead-tag" dir="auto">
                {t}
              </span>
            ))}
            {more > 0 && (
              <span className="lead-sub">
                +{more}
                <span className="visually-hidden"> more</span>
              </span>
            )}
          </span>
        );
      },
    },
    { key: 'owner', label: 'Owner', render: (row) => <Owner id={row.owner_id} people={people} /> },
    {
      key: 'activity',
      label: 'Last activity',
      render: (row) => {
        const at = typeof row.last_activity_at === 'string' ? row.last_activity_at : '';
        return at ? (
          <time dateTime={isoOf(at)} title={formatDateTime(at)}>
            {relTime(at, now)}
          </time>
        ) : (
          <span className="lead-sub">None yet</span>
        );
      },
    },
    {
      key: 'value',
      label: 'Value',
      num: true,
      render: (row) => (typeof row.value === 'number' && row.value > 0 ? formatSar(row.value) : ''),
    },
  ];

  const set = (patch: Partial<ContactFilters>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const filtered = q !== '' || tag !== '' || filters.chip !== 'all' || filters.owner !== null;
  const ownerKnown =
    filters.owner === null ||
    filters.owner === 'me' ||
    filters.owner === 'none' ||
    people.some((p) => p.id === filters.owner);

  function applyTag(event: FormEvent) {
    event.preventDefault();
    setTag(tagDraft.trim());
    set({});
  }

  return (
    <>
      <div className="toolbar">
        <ContactSearch
          value={q}
          error={searchError}
          onSearch={(term) => {
            setQ(term);
            setSearchError('');
            set({});
          }}
        />
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
          <label className="f__l" htmlFor={ownerId}>
            Owner
          </label>
          <select
            id={ownerId}
            value={filters.owner ?? ''}
            onChange={(e) => set({ owner: (e.target.value || null) as LeadAssignedFilter | null })}
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">No owner</option>
            {people
              .filter((p) => p.canOwn)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            {!ownerKnown && filters.owner && (
              <option value={filters.owner}>Someone no longer on the team</option>
            )}
          </select>
        </div>
        <div className="f">
          <label className="f__l" htmlFor={sortId}>
            Sort
          </label>
          <select
            id={sortId}
            value={filters.sort}
            onChange={(e) =>
              set({ sort: SORTS.find((s) => s.value === e.target.value)?.value ?? 'recent' })
            }
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <form className="f ct-tagfilter" onSubmit={applyTag}>
          <label className="f__l" htmlFor={tagId}>
            Tag
          </label>
          <span className="ct-tagfilter__row">
            <input
              id={tagId}
              maxLength={32}
              dir="auto"
              autoComplete="off"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
            />
            <button type="submit" data-size="sm">
              Filter
            </button>
          </span>
        </form>
      </div>
      {notes.map((note) => (
        <Note key={note.text} tone={note.tone} role="status" className="lead-note">
          <p>{note.text}</p>
        </Note>
      ))}
      {Object.entries(starWords).map(([id, said]) => (
        <p key={id} className="msg" data-kind="error" role="alert">
          {said}
        </p>
      ))}
      <DataTable<ContactRow>
        caption="Contacts"
        columns={columns}
        rows={rows}
        rowName={contactName}
        rowHref={(row) => `/admin/contacts/${row.id}`}
        titleColumn="person"
        total={total}
        offset={(filters.page - 1) * CONTACTS_PAGE_SIZE}
        limit={CONTACTS_PAGE_SIZE}
        onPage={(offset) =>
          setFilters((f) => ({ ...f, page: Math.floor(offset / CONTACTS_PAGE_SIZE) + 1 }))
        }
        busy={busy}
        error={error || undefined}
        empty={
          filtered
            ? { title: 'Nobody matches', text: 'Try another filter or clear the search.' }
            : {
                title: 'No contacts yet',
                text: 'People arrive here with their first inquiry, or when you add them.',
              }
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (ids) => (
            <BulkBar ids={ids} versions={versions} people={people} post={postBulk} />
          ),
        }}
      />
      {addContact.element}
    </>
  );
}
