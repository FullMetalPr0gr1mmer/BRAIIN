import { useCallback, useEffect, useRef, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import EditorForm from '@/components/admin/fields/EditorForm';
import { adminFetch, describeError } from '@/lib/admin/client';
import { saveModeFor } from '@/lib/admin/saveMode';
import { toast } from '@/lib/admin/toast';
import { uiFor } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { countBy, projectsCount, textIn, type Row } from './model';

// Manage tags (Admin v2 U6, AV-15; the prototype's taxonomyDrawer, "Tags and filters"): the wide
// drawer the Projects list opens, with what powers the filters on Our Work and All projects.
//   Sectors   each with its English and Arabic name and how many projects carry it; edited
//             and added in place (the sectors resource's own form, categories.manage);
//   Clients   each with how many projects name it and whether it may be named; opened in the
//             clients screen's drawer, where "Visible on the site" IS the disclosure
//             permission (§8: switch it on only when the client has agreed), portfolio.write;
//   Services  not tags of their own: a project is tagged with the services, edited in Services.
// Each section shows only for the role holding its capability; every route checks again.

interface ListResponse {
  rows: (Row & { id: string })[];
}

export interface TagsDrawerProps {
  open: boolean;
  onClose: () => void;
  projects: readonly Row[];
  /** categories.manage: the sectors. */
  sectors: boolean;
  /** portfolio.write: the clients. */
  clients: boolean;
  /** A sector changed: the list reads its names again. */
  onChanged: () => void;
}

type Editing = { id: string | null; key: number } | null;

export default function TagsDrawer({
  open,
  onClose,
  projects,
  sectors: showSectors,
  clients: showClients,
  onChanged,
}: TagsDrawerProps) {
  const [sectors, setSectors] = useState<ListResponse['rows'] | null>(null);
  const [clients, setClients] = useState<ListResponse['rows'] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const opened = useRef(0);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        showSectors
          ? adminFetch<ListResponse>('/api/admin/sectors?limit=100')
          : Promise.resolve({ rows: [] }),
        showClients
          ? adminFetch<ListResponse>('/api/admin/clients?limit=100')
          : Promise.resolve({ rows: [] }),
      ]);
      setSectors(s.rows ?? []);
      setClients(c.rows ?? []);
      setError('');
    } catch (err) {
      setError(describeError(err));
      setSectors((current) => current ?? []);
      setClients((current) => current ?? []);
    }
  }, [showSectors, showClients]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const bySector = countBy(projects, 'sector_id');
  const byClient = countBy(projects, 'client_id');
  const edit = (id: string | null) => {
    opened.current += 1;
    setEditing({ id, key: opened.current });
  };
  const lastSector = (sectors ?? []).reduce(
    (max, row) => Math.max(max, Number(row['sort_order'] ?? 0)),
    0,
  );

  return (
    <Drawer open={open} onClose={onClose} title="Tags and filters" size="wide">
      <div className="prj-tags">
        <p className="admin-sub">These power the filters on Our Work and All projects.</p>
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}

        {showSectors && (
          <section className="prj-tags__group" aria-labelledby="prj-tags-sectors">
            <div className="prj-tags__h">
              <h3 id="prj-tags-sectors">Sectors</h3>
              {!editing && (
                <button
                  type="button"
                  className="btn"
                  data-variant="soft"
                  onClick={() => edit(null)}
                >
                  <Icon name="plus" size={14} />
                  Add sector
                </button>
              )}
            </div>
            {editing ? (
              <SectorForm
                key={editing.key}
                id={editing.id}
                sortOrder={lastSector + 10}
                onDone={(changed) => {
                  setEditing(null);
                  if (changed) {
                    void load();
                    onChanged();
                  }
                }}
              />
            ) : sectors === null ? (
              <p className="admin-sub">Loading…</p>
            ) : sectors.length === 0 ? (
              <p className="admin-sub">No sectors yet.</p>
            ) : (
              <ul className="list">
                {sectors.map((row) => {
                  const en = textIn(row['name'], 'en');
                  const ar = textIn(row['name'], 'ar');
                  return (
                    <li className="li" key={row.id}>
                      <div className="li__main">
                        <span className="prj-tags__name">
                          <span className="li__t" dir="auto">
                            {en || ar || 'Untitled sector'}
                          </span>
                          {ar && en && (
                            <span className="prj-tags__ar" lang="ar" dir="rtl">
                              {ar}
                            </span>
                          )}
                        </span>
                        <span className="li__s">{projectsCount(bySector.get(row.id) ?? 0)}</span>
                      </div>
                      {row['visible'] === false && (
                        <span className="badge" data-tone="gray">
                          Hidden
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn"
                        data-variant="ghost"
                        onClick={() => edit(row.id)}
                        aria-label={`Edit sector ${en || ar}`}
                      >
                        <Icon name="edit" size={14} />
                        Edit
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {showClients && (
          <section className="prj-tags__group" aria-labelledby="prj-tags-clients">
            <div className="prj-tags__h">
              <h3 id="prj-tags-clients">Clients</h3>
              <a className="btn" data-variant="soft" href="/admin/clients/new">
                <Icon name="plus" size={14} />
                Add client
              </a>
            </div>
            <p className="admin-sub">
              Switch a client on only when they have agreed to be named. Until then it shows as
              “Confidential client”.
            </p>
            {clients === null ? (
              <p className="admin-sub">Loading…</p>
            ) : clients.length === 0 ? (
              <p className="admin-sub">No clients yet.</p>
            ) : (
              <ul className="list">
                {clients.map((row) => {
                  const en = textIn(row['name'], 'en');
                  const ar = textIn(row['name'], 'ar');
                  return (
                    <li className="li" key={row.id}>
                      <div className="li__main">
                        <a className="li__t" href={`/admin/clients/${row.id}`} dir="auto">
                          {en || ar || 'Untitled client'}
                        </a>
                        <span className="li__s">{projectsCount(byClient.get(row.id) ?? 0)}</span>
                      </div>
                      {row['visible'] !== true && (
                        <span className="badge" data-tone="warn">
                          Not cleared to name
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        <section className="prj-tags__group" aria-labelledby="prj-tags-services">
          <div className="prj-tags__h">
            <h3 id="prj-tags-services">Services</h3>
          </div>
          <p className="admin-sub">
            Projects are tagged with the services, so the filters follow them.{' '}
            <a href="/admin/services">Edit them in Services</a>.
          </p>
        </section>
      </div>
    </Drawer>
  );
}

/** A sector added or edited in place: the sectors resource's own form. */
function SectorForm({
  id,
  sortOrder,
  onDone,
}: {
  id: string | null;
  sortOrder: number;
  onDone: (changed: boolean) => void;
}) {
  const ui = uiFor('sectors');
  const target = { kind: 'resource', slug: 'sectors' } as const;
  const save = useEntitySave(target, id, {
    fields: ui.fields,
    mode: saveModeFor(target),
    defaults: { sortOrder },
    onCreated: () => {
      toast('Sector added.', 'ok');
      onDone(true);
    },
  });
  const firstSavedAt = useRef(save.savedAt);
  useEffect(() => {
    if (id !== null && save.savedAt && save.savedAt !== firstSavedAt.current) {
      toast('Saved.', 'ok');
      onDone(true);
    }
  }, [save.savedAt]);
  return (
    <div className="prj-tags__form">
      <EditorForm
        save={save}
        fields={ui.fields.filter((f) => f.name !== 'sortOrder')}
        submitLabel={id === null ? 'Add sector' : 'Save changes'}
        idPrefix="ft"
        initialLanguage="both"
      >
        <button type="button" className="btn" data-variant="ghost" onClick={() => onDone(false)}>
          Back to the tags
        </button>
      </EditorForm>
    </div>
  );
}
