import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import { uiFor } from '@/lib/admin/uiSchema';
import { collectionOf, type CollectionDef } from './collections';
import { copyPayload } from './copy';
import CollectionDrawer from './CollectionDrawer';
import CollectionList from './CollectionList';
import type { CollectionPermissions } from './fields';
import { ORDER_STEP, orderChanges, placeAfter } from './reorder';

// One collection's screen (Admin v2 U7, the prototype's route('/collections/:kind')): the
// AdminCollection island at /admin/<slug>. The page head (server) holds the title, the line
// and Add; this draws the list and the drawer.
//
//   the list     one row per item, in the site's order: a handle (drag it, or Space and
//                the arrows), the icon, the item's words, its badges (the status when it
//                is not Published, Sample, Needs consent…), Move up / Move down (WCAG 2.5.7)
//                and, on hover or focus, Duplicate and Edit. The title is a real link to
//                /admin/<slug>/<id>, which opens the drawer in place.
//   the order    a move renumbers the list in tens and sends only the rows it changed
//                (reorder.ts; one subrequest each, P-15), then reads the list again (each
//                moved row's version moved). A refusal puts the list back and says why.
//   the drawer   add or edit one item (CollectionDrawer). The address follows it
//                (/admin/<slug>/new, /admin/<slug>/<id>), so a reload or a link reopens it.
//   Duplicate    a draft copy right after the original (its slug suffixed, consent and the
//                sample flag never copied); a collection may refuse it for some rows.
//
// Every button is for the role's convenience only: each route checks the capability again.

type Row = Record<string, unknown> & { id: string };

interface ListResponse {
  rows: Row[];
  total: number;
}

export interface CollectionScreenProps {
  collection: string;
  /** 'new', an item's id, or null: the drawer that opens with the page. */
  open: string | null;
  permissions: CollectionPermissions;
}

/** The most items one read lists (the list endpoint's cap). */
const LIST_LIMIT = 100;

type DrawerState = { id: string | null; key: number } | null;

export default function CollectionScreen({ collection, open, permissions }: CollectionScreenProps) {
  const def: CollectionDef = collectionOf(collection);
  const ui = uiFor(def.slug);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<DrawerState>(
    open ? { id: open === 'new' ? null : open, key: 0 } : null,
  );
  const [focusId, setFocusId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const opened = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<ListResponse>(`/api/admin/${def.slug}?limit=${LIST_LIMIT}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setError('');
    } catch (err) {
      setError(describeError(err));
      setRows((current) => current ?? []);
    }
  }, [def.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // The address follows the drawer.
  useEffect(() => {
    const path =
      drawer === null
        ? `/admin/${def.slug}`
        : `/admin/${def.slug}/${drawer.id === null ? 'new' : drawer.id}`;
    if (window.location.pathname !== path) {
      window.history.replaceState(window.history.state, '', path);
    }
  }, [drawer, def.slug]);

  // The page head's Add (a link to /admin/<slug>/new without JavaScript) opens the drawer.
  useEffect(() => {
    if (!permissions.write) return;
    const onClick = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-collection-add]') || plainClick(event) === false) return;
      event.preventDefault();
      openDrawer(null);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [permissions.write]);

  // Focus the row a create or a duplicate made, once the list shows it.
  useEffect(() => {
    if (!focusId || !rows) return;
    const link = listRef.current?.querySelector<HTMLAnchorElement>(
      `a.li__t[href="/admin/${def.slug}/${focusId}"]`,
    );
    if (link) {
      link.focus();
      setFocusId(null);
    }
  }, [rows, focusId, def.slug]);

  function openDrawer(id: string | null) {
    opened.current += 1;
    setDrawer({ id, key: opened.current });
  }

  const ids = (rows ?? []).map((row) => row.id);
  const canSort = permissions.write && ui.reorder === true && (rows?.length ?? 0) > 1;

  async function commitOrder(order: readonly string[]) {
    const before = rows;
    if (!before) return;
    const changes = orderChanges(
      before.map((row) => ({ id: row.id, sort_order: Number(row['sort_order'] ?? 0) })),
      order,
    );
    if (changes.length === 0) return;
    // The new order at once (the preview ends with the commit), then the server's.
    const byId = new Map(before.map((row) => [row.id, row]));
    setRows(order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    setError('');
    try {
      await adminFetch(`/api/admin/${def.slug}/reorder`, {
        method: 'POST',
        body: { items: changes },
      });
      toast('Order updated.', 'ok');
    } catch (err) {
      setRows(before);
      setError(`The order was not saved. ${describeError(err)}`);
    }
    await load();
  }

  async function duplicate(row: Row) {
    if (!def.copy?.(row) || !rows) return;
    setWorking(true);
    setError('');
    try {
      const full = await adminFetch<Record<string, unknown>>(`/api/admin/${def.slug}/${row.id}`);
      const taken = new Set(rows.map((r) => String(r['slug'] ?? '')));
      const payload = copyPayload(def, ui, full, taken);
      if (!payload) return;
      const created = await adminFetch<Record<string, unknown>>(`/api/admin/${def.slug}`, {
        method: 'POST',
        body: payload,
      });
      const newId = String(created['id']);
      // Right after the original: the list renumbered from it on.
      const order = placeAfter([...ids, newId], row.id, newId);
      const changes = orderChanges(
        [
          ...rows.map((r) => ({ id: r.id, sort_order: Number(r['sort_order'] ?? 0) })),
          { id: newId, sort_order: Number(created['sort_order'] ?? 0) },
        ],
        order,
      );
      if (changes.length > 0) {
        await adminFetch(`/api/admin/${def.slug}/reorder`, {
          method: 'POST',
          body: { items: changes },
        });
      }
      toast(`Copied as a draft.`, 'ok');
      setFocusId(newId);
    } catch (err) {
      setError(`It was not copied. ${describeError(err)}`);
    } finally {
      setWorking(false);
      await load();
    }
  }

  // The title link opens the drawer in place; a modified click keeps the browser's own.
  function onListClick(event: MouseEvent<HTMLUListElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a.li__t');
    const id = link ? new URL(link.href).pathname.split('/').pop() : undefined;
    if (!link || !id || !plainClick(event.nativeEvent)) return;
    event.preventDefault();
    openDrawer(id);
  }

  const lastOrder = rows?.reduce((max, row) => Math.max(max, Number(row['sort_order'] ?? 0)), 0);
  const listed = drawer?.id ? (rows?.find((row) => row.id === drawer.id) ?? null) : null;

  return (
    <div className="coll">
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="admin-sub">Loading…</p>}
      {rows !== null && rows.length === 0 && !error && (
        <EmptyState icon={def.icon} title="Nothing yet" text="Add the first one.">
          {permissions.write && (
            <button type="button" className="btn" onClick={() => openDrawer(null)}>
              <Icon name="plus" size={16} />
              Add
            </button>
          )}
        </EmptyState>
      )}
      {rows !== null && rows.length > 0 && (
        <>
          {total > rows.length && (
            <Note>
              This list shows the first {rows.length} of {total}.
            </Note>
          )}
          <CollectionList
            def={def}
            rows={rows}
            permissions={permissions}
            sortable={canSort}
            current={drawer?.id ?? null}
            working={working}
            listRef={listRef}
            onCommit={(order) => void commitOrder(order)}
            onOpen={openDrawer}
            onDuplicate={(row) => void duplicate(row)}
            onLinkClick={onListClick}
          />
        </>
      )}

      {drawer && (
        <CollectionDrawer
          key={drawer.key}
          def={def}
          id={drawer.id}
          listed={listed}
          permissions={permissions}
          defaults={{ sortOrder: (lastOrder ?? 0) + ORDER_STEP }}
          onClose={() => setDrawer(null)}
          onCreated={(row) => {
            toast('Saved.', 'ok');
            setFocusId(String(row['id']));
            void load();
          }}
          onSaved={() => {
            toast('Saved.', 'ok');
            void load();
          }}
          onDeleted={() => {
            toast('Deleted.', 'ok');
            void load();
          }}
        />
      )}
    </div>
  );
}

/** A plain primary click: no modifier asks for a new tab or window. */
function plainClick(event: globalThis.MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
