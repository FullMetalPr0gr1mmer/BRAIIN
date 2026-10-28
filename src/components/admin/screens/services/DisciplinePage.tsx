import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Icon from '@/components/admin/kit/Icon';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import { useSortable } from '@/components/admin/kit/useSortable';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { readsThroughRelease, stagedBody, stagedUrl } from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import AddServiceModal from './AddServiceModal';
import DisciplineDrawer from './DisciplineDrawer';
import {
  barWidth,
  bySort,
  clipWords,
  eyeLabel,
  eyeRefusal,
  eyeTarget,
  isShown,
  leadsCount,
  nameOf,
  nextServiceOrder,
  placeLabel,
  rangeOrderChanges,
  renumberable,
  textOf,
  type Row,
} from './model';

// A discipline's page (Admin v2 U5, AV-14; the prototype's route('/services/:cat')): the
// AdminDiscipline island at /admin/disciplines/[id]. The page head (server) holds the
// discipline's number and name, Back, Edit discipline, Open on site and Add service; this
// draws two columns:
//   left   "Services in this discipline": each service's number, poster, name in both
//          languages and tagline, its "N leads" (for the roles that work leads), the eye, a
//          link to it on the site, and the row's link to its editor. Sortable by handle,
//          Space and the arrows, or Move up / Move down; a move renumbers inside the numbers
//          this discipline already holds (model.ts rangeOrderChanges), so no other
//          discipline's order moves, and an archived service keeps its number unless the role
//          may archive.
//   right  "Card on the site" (the poster and the clip's window) and, for the roles that work
//          leads, "Leads by service" (GET /api/admin/leads/interest-counts: counts only).
// The page head's "Edit discipline" and "Add service" are links (`?edit=1`, `?add=1`) this
// island turns into the drawer and the modal. Every button is UX: each route checks again.

interface ListResponse {
  rows: Row[];
  total: number;
}

export interface DisciplinePageProps {
  id: string;
  write: boolean;
  archive: boolean;
  /** leads.manage: the counts and the chart. */
  leads: boolean;
}

const LIST_LIMIT = 100;

export default function DisciplinePage({ id, write, archive, leads }: DisciplinePageProps) {
  const [disciplines, setDisciplines] = useState<Row[] | null>(null);
  const [services, setServices] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Readonly<Record<string, number>> | null>(null);
  const [countsError, setCountsError] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  // Admin v2 R12b: the lists came through the release (releases on). Read from the answers,
  // never from a row, it decides every write this screen sends: a move, an eye, an add made in
  // release mode says so, so a switch-off since is refused (409 `releases-off`), never live.
  const [staged, setStaged] = useState(false);
  const [drawer, setDrawer] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState(0);
  const [addOrder, setAddOrder] = useState(0);
  const shown = useRef<Row[] | null>(null);
  shown.current = services;

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        adminFetch<ListResponse>(`/api/admin/disciplines?limit=${LIST_LIMIT}`),
        adminFetch<ListResponse>(
          `/api/admin/services?limit=${LIST_LIMIT}&discipline_id=${encodeURIComponent(id)}`,
        ),
      ]);
      setDisciplines([...(d.rows ?? [])].sort(bySort));
      setServices([...(s.rows ?? [])].sort(bySort));
      setStaged(readsThroughRelease(d) || readsThroughRelease(s));
      setError('');
    } catch (err) {
      setError(describeError(err));
      setServices((current) => current ?? []);
      setDisciplines((current) => current ?? []);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The counts, for the roles that work leads only (the route refuses everyone else).
  useEffect(() => {
    if (!leads) return;
    const controller = new AbortController();
    adminFetch<{ counts: Record<string, number> }>('/api/admin/leads/interest-counts', {
      signal: controller.signal,
    })
      .then((data) => setCounts(data.counts ?? {}))
      .catch((err) => {
        if (!controller.signal.aborted) setCountsError(describeError(err));
      });
    return () => controller.abort();
  }, [leads]);

  // The head's links: "Edit discipline" (?edit=1) and "Add service" (?add=1), also on arrival.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('edit') === '1') setDrawer((n) => n + 1);
    if (write && params.get('add') === '1') void openAdd();
    if (params.has('edit') || params.has('add')) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!plainClick(event)) return;
      if (target?.closest('[data-discipline-edit]')) {
        event.preventDefault();
        setDrawer((n) => n + 1);
      } else if (write && target?.closest('[data-service-add]')) {
        event.preventDefault();
        void openAdd();
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [write]);

  async function openAdd() {
    // Where the new service goes is numbered against EVERY service (nextServiceOrder: in an
    // empty discipline, after all of them), but this page reads its own discipline's only;
    // so every service is read when asked, before the modal takes its starting values, and
    // this discipline's own are taken from that same read. A failed read falls back to the
    // rows on the page (a ref: the head's click handler is set up once, at mount).
    let own: readonly Row[] = shown.current ?? [];
    let all = own;
    try {
      const list = await adminFetch<ListResponse>(`/api/admin/services?limit=${LIST_LIMIT}`);
      all = list.rows ?? [];
      own = all.filter((row) => row['discipline_id'] === id);
    } catch {
      // the fallback above
    }
    setAddOrder(nextServiceOrder(own, all));
    setAddKey((n) => n + 1);
    setAdding(true);
  }

  const index = disciplines?.findIndex((row) => row.id === id) ?? -1;
  const discipline = index >= 0 ? disciplines![index]! : null;
  const rows = services ?? [];
  const canSort = write && rows.length > 1;

  async function commitOrder(order: readonly string[]) {
    const before = services;
    if (!before) return;
    const changes = rangeOrderChanges(
      renumberable(before, archive).map((row) => ({
        id: row.id,
        sort_order: Number(row['sort_order'] ?? 0),
      })),
      order,
    );
    if (changes.length === 0) return;
    const byId = new Map(before.map((row) => [row.id, row]));
    setServices(order.flatMap((rowId) => (byId.has(rowId) ? [byId.get(rowId)!] : [])));
    setError('');
    let failure = '';
    try {
      await adminFetch(stagedUrl('/api/admin/services/reorder', staged), {
        method: 'POST',
        body: { items: changes },
      });
      toast('Order updated.', 'ok');
    } catch (err) {
      setServices(before);
      failure = `The order was not saved. ${describeError(err)}`;
    }
    // The list is read again first (its read clears the message), then the refusal is said
    // (R12b review: said before the read, it lasted one round trip).
    await load();
    if (failure) setError(failure);
  }

  async function toggle(row: Row) {
    const next = eyeTarget(row['status']);
    if (!next) return;
    const name = nameOf(row);
    setWorking(true);
    setError('');
    let failure = '';
    try {
      await adminFetch(`/api/admin/services/${row.id}`, {
        method: 'PATCH',
        body: stagedBody({ status: next, version: Number(row['version'] ?? 1) }, staged),
      });
      toast(next === 'draft' ? `${name} is hidden.` : `${name} is on the site.`, 'ok');
    } catch (err) {
      failure = eyeRefusal(
        'service',
        err instanceof AdminApiError ? err.info : null,
        describeError(err),
      );
    } finally {
      setWorking(false);
      // The list is read again first (its read clears the message), then the refusal is said
      // (R12b review: said before the read, it lasted one round trip).
      await load();
    }
    if (failure) setError(failure);
  }

  const thumb =
    discipline && typeof discipline['poster_thumb_url'] === 'string'
      ? discipline['poster_thumb_url']
      : null;
  const clip = discipline ? clipWords(discipline['preview']) : null;
  const max = Math.max(0, ...rows.map((row) => counts?.[String(row['slug'])] ?? 0));

  return (
    <div className="grid grid--2-1">
      <section className="card svc-d__main" aria-labelledby="svc-d-list">
        <h2 className="card-title" id="svc-d-list">
          Services in this discipline
        </h2>
        <p className="admin-sub">
          {write
            ? 'Drag to reorder. The numbers on the site follow this order.'
            : 'In the order the site shows them.'}
        </p>
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
        {services === null && !error && <p className="admin-sub">Loading…</p>}
        {services !== null && rows.length === 0 && !error && (
          <EmptyState icon="layers" title="No services yet" text="Add the first one.">
            {write && (
              <button type="button" className="btn" onClick={openAdd}>
                <Icon name="plus" size={16} />
                Add service
              </button>
            )}
          </EmptyState>
        )}
        {rows.length > 0 && (
          <ServiceList
            rows={rows}
            sortable={canSort}
            write={write}
            archive={archive}
            working={working}
            counts={leads ? counts : null}
            onCommit={(order) => void commitOrder(order)}
            onToggle={(row) => void toggle(row)}
          />
        )}
      </section>

      <div className="svc-d__side">
        <section className="card" aria-labelledby="svc-d-card">
          <h2 className="card-title" id="svc-d-card">
            Card on the site
          </h2>
          {discipline ? (
            <figure className="svc-d__card">
              <span className="svc-d__poster">
                {thumb ? (
                  <img src={thumb} alt="" width="240" height="320" />
                ) : (
                  <Icon name="image" size={24} />
                )}
              </span>
              <figcaption>
                <b dir="auto">{`${placeLabel(index)} · ${nameOf(discipline, 'name')}`}</b>
                <span className="admin-sub" dir="auto">
                  {textOf(discipline['short']) || 'No card line yet.'}
                </span>
                <span className="admin-sub">{clip ?? 'No card video.'}</span>
              </figcaption>
            </figure>
          ) : (
            disciplines !== null && <p className="admin-sub">This discipline was not found.</p>
          )}
        </section>

        {leads && (
          <section className="card" aria-labelledby="svc-d-leads">
            <h2 className="card-title" id="svc-d-leads">
              Leads by service
            </h2>
            <p className="admin-sub">All time, spam left out.</p>
            {countsError && (
              <p className="msg" data-kind="error" role="alert">
                {countsError}
              </p>
            )}
            {counts === null && !countsError && <p className="admin-sub">Loading…</p>}
            {counts !== null && rows.length > 0 && (
              <ul className="barlist" aria-label="Leads by service">
                {rows.map((row) => {
                  const n = counts[String(row['slug'])] ?? 0;
                  return (
                    <li className="prog" key={row.id}>
                      <span dir="auto">{nameOf(row)}</span>
                      <span className="prog__v">{String(n)}</span>
                      <span className="bar" aria-hidden="true">
                        <span className="bar-fill ch-s1" data-width={barWidth(n, max)} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>

      {drawer > 0 && discipline && (
        <DisciplineDrawer
          key={drawer}
          id={id}
          status={typeof discipline['status'] === 'string' ? discipline['status'] : null}
          name={nameOf(discipline, 'name')}
          write={write}
          archive={archive}
          defaults={{}}
          onClose={() => setDrawer(0)}
          onSaved={() => {
            toast('Saved.', 'ok');
            void load();
          }}
          onDeleted={() => {
            window.location.href = '/admin/services';
          }}
        />
      )}
      {adding && discipline && (
        <AddServiceModal
          key={addKey}
          open={adding}
          onClose={() => setAdding(false)}
          disciplineId={id}
          disciplineName={nameOf(discipline, 'name')}
          sortOrder={addOrder}
          staged={staged}
        />
      )}
    </div>
  );
}

interface ServiceListProps {
  rows: readonly Row[];
  sortable: boolean;
  write: boolean;
  archive: boolean;
  working: boolean;
  counts: Readonly<Record<string, number>> | null;
  onCommit: (order: readonly string[]) => void;
  onToggle: (row: Row) => void;
}

/** The discipline's services, sortable (mounted once rows exist, so the core binds to it). */
function ServiceList({
  rows,
  sortable,
  write,
  archive,
  working,
  counts,
  onCommit,
  onToggle,
}: ServiceListProps) {
  const ids = rows.map((row) => row.id);
  const { ref, lists, hintId } = useSortable<HTMLUListElement>({
    lists: { list: ids },
    onCommit: (next) => onCommit(next['list'] ?? []),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shown = lists['list'] ?? ids;
  const place = new Map(ids.map((rowId, i) => [rowId, placeLabel(i)]));

  return (
    <>
      <ul
        className="list"
        ref={ref}
        aria-label="Services in this discipline"
        aria-busy={working || undefined}
      >
        {shown.map((rowId) => {
          const row = byId.get(rowId);
          if (!row) return null;
          const name = nameOf(row);
          const ar = textOf(row['title'], 'ar');
          const status = String(row['status'] ?? 'draft');
          const slug = String(row['slug'] ?? '');
          const thumb =
            typeof row['poster_thumb_url'] === 'string' ? row['poster_thumb_url'] : null;
          const eye = write && (archive || status !== 'archived') ? eyeTarget(status) : null;
          return (
            <li
              key={rowId}
              className="li svc__row"
              data-hidden={isShown(row) ? undefined : ''}
              data-sortable-id={sortable ? rowId : undefined}
              data-sortable-label={sortable ? name : undefined}
            >
              {sortable && <SortHandle label={name} describedBy={hintId} />}
              <span className="svc__n" aria-hidden="true">
                {place.get(rowId)}
              </span>
              <span className="svc__thumb" aria-hidden="true">
                {thumb ? (
                  <img src={thumb} alt="" width="64" height="48" />
                ) : (
                  <Icon name="image" size={18} />
                )}
              </span>
              <div className="li__main">
                <span className="svc__name">
                  <a className="li__t" href={`/admin/services/${rowId}`} dir="auto">
                    {name}
                  </a>
                  {ar && (
                    <span className="svc__ar" lang="ar" dir="rtl">
                      {ar}
                    </span>
                  )}
                </span>
                <span className="li__s" dir="auto">
                  {textOf(row['blurb'])}
                </span>
              </div>
              {counts && (
                <span className="badge" data-tone="gray">
                  {leadsCount(counts[slug] ?? 0)}
                </span>
              )}
              {!isShown(row) && <StatusBadge status={status} />}
              {sortable && <MoveButtons label={name} />}
              <div className="li__acts">
                {eye && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={eyeLabel(row, name)}
                    disabled={working}
                    onClick={() => onToggle(row)}
                  >
                    <Icon name={isShown(row) ? 'eye' : 'eyeoff'} size={15} />
                  </button>
                )}
                {isShown(row) && slug && (
                  <a
                    className="icon-btn"
                    href={`/services/${slug}`}
                    target="_blank"
                    rel="noopener"
                    aria-label={`Open ${name} on the site`}
                  >
                    <Icon name="ext" size={15} />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <SortHint id={hintId} />
    </>
  );
}

/** A plain primary click: no modifier asks for a new tab or window. */
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
