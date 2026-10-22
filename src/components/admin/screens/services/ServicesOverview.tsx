import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import { useSortable } from '@/components/admin/kit/useSortable';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { toast } from '@/lib/admin/toast';
import DisciplineDrawer from './DisciplineDrawer';
import {
  ORDER_STEP,
  bySort,
  eyeLabel,
  eyeTarget,
  groupServices,
  hideDisciplineQuestion,
  isShown,
  nameOf,
  placeLabel,
  renumberable,
  servicePills,
  servicesCount,
  tensOrderChanges,
  textOf,
  type Row,
} from './model';

// The Services overview (Admin v2 U5, AV-14; the prototype's route('/services')): the
// AdminServices island at /admin/services. The page head (server) holds the title, "Open
// services page" and "Add discipline"; this draws:
//   the list     the disciplines in the site's order: a handle (drag it, or Space and the
//                arrows), the poster as a thumbnail, "01 · Branding" and its Arabic name, how
//                many services and the card line, its first four services as pills and "+N",
//                Move up / Move down (WCAG 2.5.7), the eye, Edit, and the row's link to the
//                discipline's page. A move renumbers the list in tens and sends only the rows
//                it changed; an archived row keeps its number unless the role may archive.
//   the eye      shows or hides a discipline (published or draft); hiding a live one asks
//                first, because its services go with it (services_discipline_published).
//   the drawer   add or edit a discipline (DisciplineDrawer).
//   unfiled      the services filed under no discipline, so none is out of reach.
// Every button is for the role's convenience only: each route checks the capability again.

interface ListResponse {
  rows: Row[];
  total: number;
}

export interface ServicesOverviewProps {
  /** services.write in full: add, edit, order, show and hide. */
  write: boolean;
  /** content.archiveDelete: archive, delete, and write an archived row. */
  archive: boolean;
}

/** The most rows one read lists (the list endpoint's cap). */
const LIST_LIMIT = 100;

type DrawerState = { id: string | null; key: number } | null;

export default function ServicesOverview({ write, archive }: ServicesOverviewProps) {
  const [disciplines, setDisciplines] = useState<Row[] | null>(null);
  const [services, setServices] = useState<Row[]>([]);
  const [totals, setTotals] = useState({ disciplines: 0, services: 0 });
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const opened = useRef(0);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        adminFetch<ListResponse>(`/api/admin/disciplines?limit=${LIST_LIMIT}`),
        adminFetch<ListResponse>(`/api/admin/services?limit=${LIST_LIMIT}`),
      ]);
      setDisciplines([...(d.rows ?? [])].sort(bySort));
      setServices(s.rows ?? []);
      setTotals({ disciplines: d.total ?? 0, services: s.total ?? 0 });
    } catch (err) {
      setError(describeError(err));
      setDisciplines((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openDrawer(id: string | null) {
    opened.current += 1;
    setDrawer({ id, key: opened.current });
  }

  // The page head's "Add discipline" (a link to the no-JS form) opens the drawer instead.
  useEffect(() => {
    if (!write) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-discipline-add]') || !plainClick(event)) return;
      event.preventDefault();
      openDrawer(null);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [write]);

  const grouped = groupServices(disciplines ?? [], services);
  const rows = disciplines ?? [];
  const canSort = write && rows.length > 1;

  async function commitOrder(order: readonly string[]) {
    const before = disciplines;
    if (!before) return;
    const changes = tensOrderChanges(
      renumberable(before, archive).map((row) => ({
        id: row.id,
        sort_order: Number(row['sort_order'] ?? 0),
      })),
      order,
    );
    if (changes.length === 0) return;
    const byId = new Map(before.map((row) => [row.id, row]));
    setDisciplines(order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    setError('');
    try {
      await adminFetch('/api/admin/disciplines/reorder', {
        method: 'POST',
        body: { items: changes },
      });
      toast('Order updated.', 'ok');
    } catch (err) {
      setDisciplines(before);
      setError(`The order was not saved. ${describeError(err)}`);
    }
    await load();
  }

  async function toggle(row: Row) {
    const next = eyeTarget(row['status']);
    if (!next) return;
    const name = nameOf(row, 'name');
    if (next === 'draft') {
      const count = grouped.byDiscipline.get(row.id)?.filter(isShown).length ?? 0;
      const confirmed = await confirmDialog({
        message: hideDisciplineQuestion(name, count),
        confirmLabel: 'Hide',
        danger: false,
      });
      if (!confirmed) return;
    }
    setWorking(true);
    setError('');
    try {
      await adminFetch(`/api/admin/disciplines/${row.id}`, {
        method: 'PATCH',
        body: { status: next, version: Number(row['version'] ?? 1) },
      });
      toast(next === 'draft' ? `${name} is hidden.` : `${name} is on the site.`, 'ok');
    } catch (err) {
      setError(
        err instanceof AdminApiError && err.info.status === 409
          ? 'Someone else changed this discipline. The list has been reloaded: try again.'
          : `It was not changed. ${describeError(err)}`,
      );
    } finally {
      setWorking(false);
      await load();
    }
  }

  const lastOrder = rows.reduce((max, row) => Math.max(max, Number(row['sort_order'] ?? 0)), 0);
  const listed = drawer?.id ? (rows.find((row) => row.id === drawer.id) ?? null) : null;

  return (
    <div className="svc">
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {disciplines === null && !error && <p className="admin-sub">Loading…</p>}
      {disciplines !== null && (
        <p className="admin-sub svc__count" aria-live="polite">
          {`${totals.disciplines === 1 ? '1 discipline' : `${totals.disciplines} disciplines`}, ${servicesCount(totals.services).toLowerCase()}.`}
          {write ? ' Drag to change the order on the site.' : ''}
        </p>
      )}
      {disciplines !== null && rows.length === 0 && !error && (
        <EmptyState icon="layers" title="No disciplines yet" text="Add the first one.">
          {write && (
            <button type="button" className="btn" onClick={() => openDrawer(null)}>
              <Icon name="plus" size={16} />
              Add discipline
            </button>
          )}
        </EmptyState>
      )}
      {rows.length > 0 && (
        <DisciplineList
          rows={rows}
          grouped={grouped}
          sortable={canSort}
          write={write}
          archive={archive}
          working={working}
          onCommit={(order) => void commitOrder(order)}
          onToggle={(row) => void toggle(row)}
          onEdit={(id) => openDrawer(id)}
        />
      )}
      {grouped.unfiled.length > 0 && (
        <section className="card svc__unfiled" aria-labelledby="svc-unfiled">
          <h2 className="card-title" id="svc-unfiled">
            Not filed under a discipline
          </h2>
          <p className="admin-sub">
            These services are on no discipline, so the site does not list them. Open one and choose
            its discipline.
          </p>
          <ul className="list">
            {grouped.unfiled.map((service) => (
              <li className="li" key={service.id}>
                <div className="li__main">
                  <a className="li__t" href={`/admin/services/${service.id}`} dir="auto">
                    {nameOf(service)}
                  </a>
                  <span className="li__s" dir="auto">
                    {textOf(service['blurb'])}
                  </span>
                </div>
                {service['status'] !== 'published' && (
                  <StatusBadge status={String(service['status'] ?? 'draft')} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Note>
        Disciplines are the big cards on the home page and the Services page. Each one holds its
        services: open a discipline to manage them.
      </Note>

      {drawer && (
        <DisciplineDrawer
          key={drawer.key}
          id={drawer.id}
          status={typeof listed?.['status'] === 'string' ? listed['status'] : null}
          name={listed ? nameOf(listed, 'name') : 'New discipline'}
          write={write}
          archive={archive}
          defaults={{ sortOrder: lastOrder + ORDER_STEP, status: 'draft' }}
          onClose={() => setDrawer(null)}
          onSaved={(_, created) => {
            toast(created ? 'Discipline created.' : 'Saved.', 'ok');
            void load();
          }}
          onDeleted={() => {
            toast('Discipline deleted.', 'ok');
            void load();
          }}
        />
      )}
    </div>
  );
}

interface DisciplineListProps {
  rows: readonly Row[];
  grouped: ReturnType<typeof groupServices>;
  sortable: boolean;
  write: boolean;
  archive: boolean;
  working: boolean;
  onCommit: (order: readonly string[]) => void;
  onToggle: (row: Row) => void;
  onEdit: (id: string) => void;
}

/** The disciplines as a sortable list (mounted once rows exist, so the core binds to it). */
function DisciplineList({
  rows,
  grouped,
  sortable,
  write,
  archive,
  working,
  onCommit,
  onToggle,
  onEdit,
}: DisciplineListProps) {
  const ids = rows.map((row) => row.id);
  const { ref, lists, hintId } = useSortable<HTMLUListElement>({
    lists: { list: ids },
    onCommit: (next) => onCommit(next['list'] ?? []),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shown = lists['list'] ?? ids;
  // The number follows the stored order, not a move in progress: it is the site's number.
  const place = new Map(ids.map((id, index) => [id, placeLabel(index)]));

  return (
    <>
      <ul className="list" ref={ref} aria-label="Disciplines" aria-busy={working || undefined}>
        {shown.map((id) => {
          const row = byId.get(id);
          if (!row) return null;
          const name = nameOf(row, 'name');
          const ar = textOf(row['name'], 'ar');
          const label = `${place.get(id)} · ${name}`;
          const own = grouped.byDiscipline.get(id) ?? [];
          const pills = servicePills(own);
          const status = String(row['status'] ?? 'draft');
          const thumb =
            typeof row['poster_thumb_url'] === 'string' ? row['poster_thumb_url'] : null;
          const eye = write && (archive || status !== 'archived') ? eyeTarget(status) : null;
          return (
            <li
              key={id}
              className="li svc__row"
              data-hidden={isShown(row) ? undefined : ''}
              data-sortable-id={sortable ? id : undefined}
              data-sortable-label={sortable ? name : undefined}
            >
              {sortable && <SortHandle label={name} describedBy={hintId} />}
              <span className="svc__thumb" aria-hidden="true">
                {thumb ? (
                  <img src={thumb} alt="" width="64" height="48" />
                ) : (
                  <Icon name="layers" size={18} />
                )}
              </span>
              <div className="li__main">
                <span className="svc__name">
                  <a className="li__t" href={`/admin/disciplines/${id}`} dir="auto">
                    {label}
                  </a>
                  {ar && (
                    <span className="svc__ar" lang="ar" dir="rtl">
                      {ar}
                    </span>
                  )}
                </span>
                <span className="li__s" dir="auto">
                  {[servicesCount(own.length), textOf(row['short'])].filter(Boolean).join(' · ')}
                </span>
              </div>
              {pills.names.length > 0 && (
                <span className="svc__pills">
                  {pills.names.map((pill, index) => (
                    <span key={index} className="badge" data-tone="gray" dir="auto">
                      {pill}
                    </span>
                  ))}
                  {pills.more > 0 && (
                    <span className="badge" data-tone="gray">
                      {`+${pills.more}`}
                      <span className="visually-hidden"> more services</span>
                    </span>
                  )}
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
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${write ? 'Edit' : 'Open'} discipline ${name}`}
                  onClick={() => onEdit(id)}
                >
                  <Icon name="edit" size={15} />
                </button>
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
