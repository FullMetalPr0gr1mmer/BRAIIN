import { useCallback, useEffect, useState } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Icon from '@/components/admin/kit/Icon';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import { isArchiveRefusal, MOVE_ARCHIVED, swapTarget } from '../resources/reorder';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { PAGE_SIZE } from '@/lib/admin/pager';
import AddProjectModal from './AddProjectModal';
import {
  filterProjects,
  projectChips,
  projectName,
  serviceNames,
  textIn,
  type Row,
} from './model';
import TagsDrawer from './TagsDrawer';

// The Projects list (Admin v2 U6, AV-15; the prototype's route('/projects')): the AdminProjects
// island at /admin/portfolio. The page head (server) holds "Open Our Work", "Manage tags" and
// "Add project" (links this island turns into the drawer and the modal); this draws the kit's
// DataTable over every project, read in one page with its poster, services, sector and client
// embedded (resources/portfolio.ts listColumns), and filtered here:
//   search    the name and the type, in both languages, folded (model.ts);
//   chips     All, Featured, each sector the projects carry, Hidden (not published);
//   columns   the poster, the name with its type (and the Arabic name under it), the services
//             as pills, the sector, the client, the year, and the badges;
//   order     Move up and Move down on the rows shown, as every resource list moves (hotfix
//             H12, screens/resources/reorder.ts): the two rows' numbers swapped in one request,
//             past archived rows for a role that may not archive, the list read again after,
//             and a refusal under the archive rule said in words.
// Every button is UX: each route checks the capability again.

interface ListResponse {
  rows: Row[];
  total: number;
}

export interface ProjectsListProps {
  /** portfolio.write: add, edit and order; the clients in Manage tags. */
  write: boolean;
  /** content.archiveDelete: a move may write an archived row. */
  archive: boolean;
  /** categories.manage: the sectors in Manage tags. */
  sectors: boolean;
}

const LIST_LIMIT = 100;

export default function ProjectsList({ write, archive, sectors }: ProjectsListProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState('all');
  const [offset, setOffset] = useState(0);
  const [tags, setTags] = useState(false);
  const [adding, setAdding] = useState(0);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const projects = await adminFetch<ListResponse>(`/api/admin/portfolio?limit=${LIST_LIMIT}`);
      setRows(projects.rows ?? []);
      setTotal(projects.total ?? 0);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The services' names, for the pills: read once (a project's own ids come with its row).
  useEffect(() => {
    const controller = new AbortController();
    adminFetch<ListResponse>(`/api/admin/services?limit=${LIST_LIMIT}`, {
      signal: controller.signal,
    })
      .then((services) =>
        setNames(
          new Map(
            (services.rows ?? []).map((s) => [
              s.id,
              textIn(s['title'], 'en') || textIn(s['title'], 'ar'),
            ]),
          ),
        ),
      )
      .catch(() => setNames(new Map()));
    return () => controller.abort();
  }, []);

  // The page head's "Manage tags" and "Add project" (links without JavaScript).
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!plainClick(event)) return;
      if (target?.closest('[data-projects-tags]')) {
        event.preventDefault();
        setTags(true);
      } else if (write && target?.closest('[data-project-add]')) {
        event.preventDefault();
        setAdding((n) => n + 1);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [write]);

  const shown = filterProjects(rows, query, chip);
  const page = shown.slice(offset, offset + PAGE_SIZE);
  const chips = projectChips(rows);

  async function move(index: number, direction: -1 | 1) {
    // The nearest row on this page the person may write: past archived rows unless they may
    // archive (H12), exactly as ResourceTable moves.
    const target = swapTarget(page, index, direction, archive);
    if (target === null) return;
    const a = page[index];
    const b = page[target];
    if (!a || !b) return;
    setError('');
    try {
      await adminFetch('/api/admin/portfolio/reorder', {
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
      // A refused move most often means the list went stale: read it first, then say why.
      await load();
      setError(
        err instanceof AdminApiError && isArchiveRefusal(err.info.error, err.body['capability'])
          ? MOVE_ARCHIVED
          : describeError(err),
      );
    }
  }

  const columns: DataColumn<Row>[] = [
    {
      key: 'poster',
      label: 'Picture',
      render: (row) => {
        const thumb = typeof row['poster_thumb_url'] === 'string' ? row['poster_thumb_url'] : null;
        return (
          <span className="prj__thumb" aria-hidden="true">
            {thumb ? (
              <img src={thumb} alt="" width="64" height="48" />
            ) : (
              <Icon name="image" size={16} />
            )}
          </span>
        );
      },
    },
    {
      key: 'title',
      label: 'Project',
      render: (row) => {
        const type = textIn(row['project_type'], 'en');
        const ar = textIn(row['title'], 'ar');
        const en = textIn(row['title'], 'en');
        return (
          <>
            {type && (
              <div className="cell-secondary" dir="auto">
                {type}
              </div>
            )}
            {ar && en && (
              <div className="cell-secondary" dir="rtl" lang="ar">
                {ar}
              </div>
            )}
          </>
        );
      },
    },
    {
      key: 'services',
      label: 'Services',
      render: (row) => {
        const list = serviceNames(row, names);
        return list.length === 0 ? (
          <span className="admin-sub">None</span>
        ) : (
          <span className="prj__pills">
            {list.map((name, i) => (
              <span key={i} className="badge" data-tone="gray" dir="auto">
                {name}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: 'sector',
      label: 'Sector',
      render: (row) => <span dir="auto">{textIn(row['sector_name'], 'en')}</span>,
    },
    {
      key: 'client',
      label: 'Client',
      render: (row) => <span dir="auto">{textIn(row['client_name'], 'en')}</span>,
    },
    { key: 'year', label: 'Year', num: true, render: (row) => String(row['year'] ?? '') },
    {
      key: 'badges',
      label: 'Status',
      render: (row) => (
        <span className="prj__badges">
          {row['is_featured'] === true && (
            <span className="badge" data-tone="klein">
              Featured
            </span>
          )}
          {row['status'] !== 'published' && <StatusBadge status={String(row['status'] ?? 'draft')} />}
          {row['is_placeholder'] === true && (
            <span className="badge" data-tone="gray">
              Sample
            </span>
          )}
        </span>
      ),
    },
  ];

  const filtered = query !== '' || chip !== 'all';
  const lastOrder = rows.reduce((max, row) => Math.max(max, Number(row['sort_order'] ?? 0)), 0);

  return (
    <div className="prj">
      {total > rows.length && (
        <p className="admin-sub">{`This list shows the first ${rows.length} of ${total}.`}</p>
      )}
      <DataTable<Row>
        caption="Projects"
        columns={columns}
        rows={page}
        rowName={projectName}
        rowHref={(row) => `/admin/portfolio/${row.id}`}
        rowLang={(row) =>
          !textIn(row['title'], 'en') && textIn(row['title'], 'ar') ? 'ar' : undefined
        }
        titleColumn="title"
        total={shown.length}
        offset={offset}
        limit={PAGE_SIZE}
        onPage={setOffset}
        busy={busy}
        error={error || undefined}
        actionsLabel="Actions"
        rowActions={
          write
            ? (row, index) => (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void move(index, -1)}
                    disabled={swapTarget(page, index, -1, archive) === null}
                    aria-label={`Move ${projectName(row)} up`}
                  >
                    <Icon name="chevd" size={15} className="ic--flip" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void move(index, 1)}
                    disabled={swapTarget(page, index, 1, archive) === null}
                    aria-label={`Move ${projectName(row)} down`}
                  >
                    <Icon name="chevd" size={15} />
                  </button>
                </>
              )
            : undefined
        }
        toolbar={
          <>
            <label className="visually-hidden" htmlFor="prj-search">
              Search projects
            </label>
            <input
              id="prj-search"
              type="search"
              placeholder="Search projects…"
              value={query}
              onChange={(event) => {
                setOffset(0);
                setQuery(event.target.value);
              }}
            />
            <Chips<string>
              label="Show"
              chips={chips}
              selected={[chip]}
              onChange={([next]) => {
                setOffset(0);
                setChip(next ?? 'all');
              }}
            />
          </>
        }
        empty={{
          title: filtered ? 'No projects match' : 'No projects yet',
          ...(filtered
            ? { text: 'Try another search or chip.' }
            : write
              ? { text: 'Add the first one with “Add project”.' }
              : {}),
          icon: 'briefcase',
        }}
      />

      <TagsDrawer
        open={tags}
        onClose={() => setTags(false)}
        projects={rows}
        sectors={sectors}
        clients={write}
        onChanged={() => void load()}
      />
      {adding > 0 && (
        <AddProjectModal
          key={adding}
          open
          onClose={() => setAdding(0)}
          sortOrder={lastOrder + 10}
        />
      )}
    </div>
  );
}

/** A plain primary click: no modifier asks for a new tab or window. */
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
