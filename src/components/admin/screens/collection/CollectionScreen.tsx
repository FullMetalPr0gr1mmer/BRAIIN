import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import { announcePending, readsThroughRelease, stagedUrl } from '@/lib/admin/releaseEvents';
import { uiFor } from '@/lib/admin/uiSchema';
import { collectionOf, DELETE_WORDS, type CollectionDef } from './collections';
import { copyPayload } from './copy';
import CollectionDrawer from './CollectionDrawer';
import CollectionList from './CollectionList';
import type { CollectionPermissions } from './fields';
import { ORDER_STEP, duplicateChanges, orderChanges, renumberable } from './reorder';

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
//                An archived row keeps its number unless the role may archive (renumberable).
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
  /**
   * Admin v2 U6: the starting values of the "new" drawer that opens WITH the page (a
   * project's "Add a quote" opens /admin/testimonials/new with the project chosen). Only that
   * first drawer: an Add pressed later starts empty, as before.
   */
  presets?: Readonly<Record<string, unknown>> | undefined;
}

/** The most items one read lists (the list endpoint's cap). */
const LIST_LIMIT = 100;

type DrawerState = { id: string | null; key: number } | null;

export default function CollectionScreen({
  collection,
  open,
  permissions,
  presets,
}: CollectionScreenProps) {
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
  // Admin v2 R12b: the list came through the release (releases on). Read from the answer,
  // never from a row (a row with nothing pending carries no `draft` key), it decides every
  // write this screen sends: its moves, copies and the drawer's create say they were made in
  // release mode, so a switch-off since is refused (409 `releases-off`), never written live.
  const [staged, setStaged] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const opened = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<ListResponse>(`/api/admin/${def.slug}?limit=${LIST_LIMIT}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setStaged(readsThroughRelease(data));
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

  const canSort = permissions.write && ui.reorder === true && (rows?.length ?? 0) > 1;

  async function commitOrder(order: readonly string[]) {
    const before = rows;
    if (!before) return;
    const changes = orderChanges(
      renumberable(before, permissions.remove).map((row) => ({
        id: row.id,
        sort_order: Number(row['sort_order'] ?? 0),
      })),
      order,
    );
    if (changes.length === 0) return;
    // The new order at once (the preview ends with the commit), then the server's.
    const byId = new Map(before.map((row) => [row.id, row]));
    setRows(order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    setError('');
    let failure = '';
    try {
      const moved = await adminFetch<Record<string, unknown>>(
        stagedUrl(`/api/admin/${def.slug}/reorder`, staged),
        { method: 'POST', body: { items: changes } },
      );
      // R12: a staged reorder answers what it staged; the savebar counts the new order.
      if ('staged' in moved) announcePending();
      toast('Order updated.', 'ok');
    } catch (err) {
      setRows(before);
      failure = `The order was not saved. ${describeError(err)}`;
    }
    // The list is read again first (its read clears the message), then the refusal is said
    // (R12b review: said before the read, it lasted one round trip).
    await load();
    if (failure) setError(failure);
  }

  async function duplicate(row: Row) {
    if (!def.copy?.(row) || !rows) return;
    setWorking(true);
    setError('');
    let failure = '';
    try {
      const full = await adminFetch<Record<string, unknown>>(`/api/admin/${def.slug}/${row.id}`);
      const taken = new Set(rows.map((r) => String(r['slug'] ?? '')));
      const payload = copyPayload(def, ui, full, taken);
      if (!payload) return;
      const created = await adminFetch<Record<string, unknown>>(
        stagedUrl(`/api/admin/${def.slug}`, staged),
        { method: 'POST', body: payload },
      );
      const newId = String(created['id']);
      if ('draft' in created) announcePending();
      // Right after the original: the copy and the rows after it renumbered, nothing above.
      const changes = duplicateChanges(
        renumberable(rows, permissions.remove).map((r) => ({
          id: r.id,
          sort_order: Number(r['sort_order'] ?? 0),
        })),
        row.id,
        { id: newId, sort_order: Number(created['sort_order'] ?? 0) },
      );
      if (changes.length > 0) {
        await adminFetch(stagedUrl(`/api/admin/${def.slug}/reorder`, staged), {
          method: 'POST',
          body: { items: changes },
        });
      }
      toast(`Copied as a draft.`, 'ok');
      setFocusId(newId);
    } catch (err) {
      failure = `It was not copied. ${describeError(err)}`;
    } finally {
      setWorking(false);
      // The list is read again first (its read clears the message), then the refusal is said
      // (R12b review: said before the read, it lasted one round trip).
      await load();
    }
    if (failure) setError(failure);
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
          staged={staged}
          defaults={{
            sortOrder: (lastOrder ?? 0) + ORDER_STEP,
            ...(drawer.id === null && drawer.key === 0 ? (presets ?? {}) : {}),
          }}
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
          onDeleted={(outcome) => {
            toast(DELETE_WORDS[outcome], 'ok');
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
