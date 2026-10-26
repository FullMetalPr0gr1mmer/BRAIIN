import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArabicGapsProvider,
  ArabicMissingBar,
  EditorLanguageProvider,
  EditorLanguageSwitch,
} from '@/components/admin/fields/editorLanguage';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import StatusBadge, { Badge } from '@/components/admin/kit/StatusBadge';
import SeoDrawer from '@/components/admin/screens/seo/SeoDrawer';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { readDraft } from '@/lib/admin/entitySave';
import { announcePending, openPublishDialog } from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { MODE_COPY } from '@/lib/admin/visibilityCopy';
import { orderChanges } from '../collection/reorder';
import AddSectionModal from './AddSectionModal';
import HistoryDrawer, { type HistoryTarget } from './HistoryDrawer';
import { availability, kindOf, sectionName } from './library';
import {
  formSyncAfterWrite,
  inOrder,
  isFirstOfType,
  neighbourAfterRemoval,
  newSectionPayload,
  readsThroughRelease,
  sectionRowOf,
  type SectionRow,
} from './model';
import PagePanel from './PagePanel';
import RenameModal from './RenameModal';
import SectionPanel from './SectionPanel';
import SectionsColumn, { PAGE_DETAILS } from './SectionsColumn';
import type { PageEditorPage, PageEditorSetup } from './types';

// The page editor (Admin v2 E1, docs/admin-v2/ui.md "Page editor (/admin/pages/[id]; AV-25)";
// the prototype's route('/pages/:id')): the AdminPageEditor island. The server page decides
// who may open it and hands over the page, the role's access, the built-in copy and the SEO
// drawer's setup (src/lib/admin/pages/editor.ts); everything else is read here, through the
// resource routes, which lay pending changes over live while releases are on.
//
//   the bar        the page's status, its visibility when it is not public, English /
//                  العربية / Both for every field and "Arabic missing: N" with Next gap (the
//                  language is the screen's: both panels' forms read it), Visibility (the
//                  setting's own screen, maintenance.manage), SEO (the shared SeoPanel in a
//                  drawer: Admin and SEO change it, a Content Creator reads it), History, Open
//                  page in English and Arabic, and once releases are on, Preview and Publish.
//   the sections   "Page details", then every section in the site's order (SectionsColumn):
//                  select one, show or hide it, move it (drag, keys, or Move up / down: only
//                  the rows whose number moved are written, as the collections do), Add.
//   the fields     the selected section (SectionPanel) or the page details (PagePanel).
//   the drawers    SEO and History; the dialogs: Add a section, Rename section.
// The live preview column is E2's (AV-26).
//
// Switching away from a section with unsaved changes asks first while releases are off (each
// save is explicit, P-5); with them on the change is saved as it goes (an 800 ms idle autosave)
// and a switch saves it. A write the column makes to the open section moves its version, so
// the open form follows it (model.ts formSyncAfterWrite) instead of answering its own next
// save with a conflict. Every button is the person's convenience: each route checks again.

type Row = Record<string, unknown>;

/** The most sections one read lists (the list route's own cap). */
const SECTION_LIMIT = 100;

const TONE: Record<string, 'gray' | 'sky' | 'warn'> = {
  hidden: 'gray',
  link: 'sky',
  password: 'warn',
};

const arabicPath = (path: string) => (path === '/' ? '/ar' : `/ar${path}`);

/** A row's version and its pending change's: a write to it moves one or the other. */
function stamp(row: SectionRow): string {
  return `${row.version}:${readDraft(row as unknown as Row)?.version ?? ''}`;
}

/** What a write sends to name a row's pending change (releases on), else nothing. */
function draftRef(row: SectionRow): Row {
  const draft = readDraft(row as unknown as Row);
  return draft ? { draftId: draft.id, draftVersion: draft.version } : {};
}

export interface PageEditorProps extends PageEditorSetup {
  /** The section to open first (the address's `?section=`), when it is on this page. */
  initialSection?: string | null | undefined;
}

export default function PageEditor(props: PageEditorProps) {
  return (
    <EditorLanguageProvider>
      <ArabicGapsProvider>
        <Editor {...props} />
      </ArabicGapsProvider>
    </EditorLanguageProvider>
  );
}

function Editor({ page: initialPage, access, builtIns, seo, initialSection }: PageEditorProps) {
  const [page, setPage] = useState<PageEditorPage>(initialPage);
  const [rows, setRows] = useState<SectionRow[] | null>(access.sections ? null : []);
  const [total, setTotal] = useState(0);
  const [release, setRelease] = useState(false);
  // '' until the first read says which section opens (no form loads before it).
  const [selected, setSelected] = useState<string>(access.sections ? '' : PAGE_DETAILS);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [drawer, setDrawer] = useState<'seo' | 'history' | null>(null);
  const [adding, setAdding] = useState(false);
  // The section being renamed; the dialog stays mounted (closing it returns focus), and a
  // new key on each opening starts its box from that section's name.
  const [renaming, setRenaming] = useState<SectionRow | null>(null);
  const [renameKey, setRenameKey] = useState(0);
  const [renameError, setRenameError] = useState('');
  const form = useRef<EntitySave | null>(null);

  const load = useCallback(async (): Promise<SectionRow[] | null> => {
    if (!access.sections) return null;
    try {
      const answer = await adminFetch<Row>(
        `/api/admin/sections?page_id=${encodeURIComponent(initialPage.id)}&limit=${SECTION_LIMIT}`,
      );
      const listed = (Array.isArray(answer['rows']) ? (answer['rows'] as Row[]) : [])
        .map(sectionRowOf)
        .filter((row): row is SectionRow => row !== null);
      const ordered = inOrder(listed);
      setRows(ordered);
      setTotal(typeof answer['total'] === 'number' ? answer['total'] : ordered.length);
      setRelease(readsThroughRelease(answer));
      setError('');
      return ordered;
    } catch (err) {
      setError(`The sections could not be read. ${describeError(err)}`);
      setRows((current) => current ?? []);
      return null;
    }
  }, [access.sections, initialPage.id]);

  // The first read opens the section the address names, when it is on this page, else the
  // first one (the page details for a page with none).
  useEffect(() => {
    void load().then((listed) => {
      setSelected((current) => {
        if (current !== '') return current;
        const named = listed?.find((row) => row.id === initialSection);
        return named?.id ?? listed?.[0]?.id ?? PAGE_DETAILS;
      });
    });
  }, [load, initialSection]);

  // The address follows the open section, so a reload or a link reopens it.
  useEffect(() => {
    if (selected === '') return;
    const url = new URL(window.location.href);
    if (selected === PAGE_DETAILS) url.searchParams.delete('section');
    else url.searchParams.set('section', selected);
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, '', url.href);
    }
  }, [selected]);

  const section = rows?.find((row) => row.id === selected) ?? null;

  /** Open another section (or the page details); unsaved work is never dropped silently. */
  async function select(next: string) {
    if (next === selected) return;
    const open = form.current;
    if (open) {
      if (open.mode === 'draft') open.flush?.();
      else if (
        open.dirty &&
        !(await confirmDialog({
          message: 'Leave without saving? Your changes here will be lost.',
          confirmLabel: 'Leave without saving',
          cancelLabel: 'Stay',
        }))
      ) {
        return;
      }
    }
    setSelected(next);
  }

  /** After a write the column made to the open section: the form follows it. */
  function follow(id: string, answer: Row | null, version: number | null) {
    const open = form.current;
    if (!open || id !== selectedRef.current) return;
    const action = formSyncAfterWrite({
      mode: open.mode === 'draft' ? 'draft' : 'live',
      dirty: open.dirty || open.busy,
      fullRow: answer !== null,
    });
    if (action === 'adopt-row' && answer) open.adoptRow?.(answer);
    else if (action === 'adopt-version' && version !== null) open.adoptVersion(version);
    else if (action === 'reload') void open.reloadTheirs();
  }

  /** A section's row as a write answered it. */
  function take(answer: Row) {
    const row = sectionRowOf(answer);
    if (!row) return;
    setRows((current) => current && current.map((r) => (r.id === row.id ? { ...r, ...row } : r)));
  }

  async function toggle(row: SectionRow) {
    setWorking(true);
    setError('');
    try {
      const answer = await adminFetch<Row>(`/api/admin/sections/${row.id}`, {
        method: 'PATCH',
        body: { visible: !row.visible, version: row.version, ...draftRef(row) },
      });
      take(answer);
      follow(row.id, answer, typeof answer['version'] === 'number' ? answer['version'] : null);
      const name = sectionName(row);
      if ('draft' in answer) {
        announcePending();
        toast(`${name}: saved as an unpublished change.`, 'ok');
      } else {
        toast(
          row.visible ? `${name} is hidden on the site.` : `${name} is shown on the site.`,
          'ok',
        );
      }
    } catch (err) {
      setError(`Not changed. ${describeError(err)}`);
      await load();
    } finally {
      setWorking(false);
    }
  }

  async function commitOrder(order: readonly string[]) {
    const before = rows;
    if (!before) return;
    const changes = orderChanges(
      before.map((row) => ({ id: row.id, sort_order: row.sortOrder })),
      order,
    );
    if (changes.length === 0) return;
    const byId = new Map(before.map((row) => [row.id, row]));
    setRows(order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    setWorking(true);
    setError('');
    try {
      const moved = await adminFetch<Row>(`/api/admin/sections/reorder`, {
        method: 'POST',
        body: { items: changes },
      });
      if ('staged' in moved) announcePending();
      toast('Section order updated.', 'ok');
    } catch (err) {
      setRows(before);
      setError(`The order was not saved. ${describeError(err)}`);
    }
    const listed = await load();
    const open = listed?.find((row) => row.id === selectedRef.current);
    const was = before.find((row) => row.id === selectedRef.current);
    if (open && was && stamp(open) !== stamp(was)) follow(open.id, null, open.version);
    setWorking(false);
  }

  async function add(type: string) {
    if (!rows) return;
    setWorking(true);
    setError('');
    try {
      const created = await adminFetch<Row>('/api/admin/sections', {
        method: 'POST',
        body: newSectionPayload(initialPage.id, type, rows),
      });
      if ('draft' in created) announcePending();
      setAdding(false);
      await load();
      if (typeof created['id'] === 'string') setSelected(created['id']);
      toast(
        `${kindOf(type)?.name ?? 'The section'} added at the end, hidden. Fill it in, move it, then show it.`,
        'ok',
      );
    } catch (err) {
      setAdding(false);
      setError(`Not added. ${describeError(err)}`);
    } finally {
      setWorking(false);
    }
  }

  async function rename(label: string | null) {
    if (!renaming) return;
    const row = rows?.find((r) => r.id === renaming.id) ?? renaming;
    setWorking(true);
    setRenameError('');
    try {
      const answer = await adminFetch<Row>(`/api/admin/sections/${row.id}`, {
        method: 'PATCH',
        body: { label, version: row.version, ...draftRef(row) },
      });
      take(answer);
      follow(row.id, answer, typeof answer['version'] === 'number' ? answer['version'] : null);
      if ('draft' in answer) announcePending();
      setRenaming(null);
      toast(label ? `Renamed ${label}.` : 'The section shows its own name again.', 'ok');
    } catch (err) {
      setRenameError(describeError(err));
    } finally {
      setWorking(false);
    }
  }

  async function remove(row: SectionRow) {
    const name = sectionName(row);
    const ok = await confirmDialog({
      message: release
        ? `Remove the section “${name}” from the page? The removal is saved as an unpublished change, and nothing leaves the site until it is published.`
        : `Delete the section “${name}”? Its words go with it. To keep them, hide it instead.`,
      confirmLabel: release ? 'Remove' : 'Delete',
    });
    if (!ok || !rows) return;
    setWorking(true);
    setError('');
    const next = neighbourAfterRemoval(rows, row.id);
    try {
      const answer = await adminFetch<Row>(`/api/admin/sections/${row.id}`, { method: 'DELETE' });
      if ('staged' in answer || 'draft' in answer) {
        announcePending();
        toast(`The removal of ${name} is saved as an unpublished change.`, 'ok');
      } else {
        toast(`${name} is deleted.`, 'ok');
        setSelected(next ?? PAGE_DETAILS);
      }
      await load();
    } catch (err) {
      setError(`Not deleted. ${describeError(err)}`);
    } finally {
      setWorking(false);
    }
  }

  function openRename(row: SectionRow) {
    setRenameKey((key) => key + 1);
    setRenameError('');
    setRenaming(row);
  }

  const historyTarget: HistoryTarget | null = section
    ? { entityType: 'page_section', entityId: section.id, name: sectionName(section) }
    : selected === PAGE_DETAILS
      ? { entityType: 'page', entityId: page.id, name: 'Page details' }
      : null;

  const options = rows
    ? availability(
        page.slug,
        rows.map((row) => row.type),
      )
    : [];

  return (
    <div className="pe">
      <div className="pe__bar" role="group" aria-label="This page">
        <div className="pe__badges">
          <StatusBadge status={page.status} />
          {page.visibility !== 'public' && (
            <Badge tone={TONE[page.visibility]}>{MODE_COPY[page.visibility].badge}</Badge>
          )}
        </div>
        {access.sections && (
          <div className="pe__lang">
            <EditorLanguageSwitch />
            <ArabicMissingBar />
          </div>
        )}
        <div className="pe__acts">
          {access.visibility && (
            <a className="btn" data-size="sm" href="/admin/visibility">
              <Icon name="eye" size={15} />
              Visibility
            </a>
          )}
          {seo && access.seo !== 'none' && (
            <button type="button" className="btn" data-size="sm" onClick={() => setDrawer('seo')}>
              <Icon name="seo" size={15} />
              SEO
            </button>
          )}
          {access.sections && historyTarget && (
            <button
              type="button"
              className="btn"
              data-size="sm"
              onClick={() => setDrawer('history')}
            >
              <Icon name="history" size={15} />
              History
            </button>
          )}
          {page.path && (
            <>
              <a className="btn" data-size="sm" href={page.path} target="_blank" rel="noopener">
                <Icon name="ext" size={15} />
                Open page
              </a>
              <a
                className="btn"
                data-size="sm"
                href={arabicPath(page.path)}
                target="_blank"
                rel="noopener"
                aria-label="Open page in Arabic"
              >
                <Icon name="ext" size={15} />
                <span lang="ar">العربية</span>
              </a>
            </>
          )}
          {release && page.path && (
            <a
              className="btn"
              data-size="sm"
              href={`/admin/preview${page.path}`}
              target="_blank"
              rel="noopener"
            >
              <Icon name="eye" size={15} />
              Preview
            </a>
          )}
          {release && access.publish && (
            <button
              type="button"
              className="btn"
              data-size="sm"
              data-variant="primary"
              onClick={() => openPublishDialog({ entityId: page.id })}
            >
              <Icon name="upload" size={15} />
              Publish…
            </button>
          )}
        </div>
      </div>

      {access.sections ? (
        <div className="pe__cols">
          {rows === null ? (
            <p className="admin-sub">Loading…</p>
          ) : (
            <SectionsColumn
              rows={rows}
              selected={selected}
              working={working}
              error={error}
              onSelect={(id) => void select(id)}
              onToggle={(row) => void toggle(row)}
              onCommit={(order) => void commitOrder(order)}
              onAdd={() => setAdding(true)}
            />
          )}
          <div className="pe__fields">
            {total > (rows?.length ?? 0) && (
              <Note tone="warn">
                {`This page has ${total} sections; the column lists the first ${rows?.length ?? 0}.`}
              </Note>
            )}
            {section ? (
              <SectionPanel
                key={section.id}
                section={section}
                page={page.slug}
                firstOfType={rows ? isFirstOfType(rows, section.id) : true}
                builtIns={builtIns}
                remove={access.remove}
                working={working}
                formRef={form}
                onRow={take}
                onRename={() => openRename(section)}
                onDelete={() => void remove(section)}
              />
            ) : selected === PAGE_DETAILS ? (
              <PagePanel
                page={page}
                formRef={form}
                onRow={(row) =>
                  setPage((current) => ({
                    ...current,
                    status: typeof row['status'] === 'string' ? row['status'] : current.status,
                  }))
                }
              />
            ) : (
              <p className="admin-sub">Loading…</p>
            )}
          </div>
        </div>
      ) : (
        <div className="card pe__seo-only">
          <p>
            Your role changes this page’s SEO: its title, description and share image for search
            engines and shared links. Its sections are edited by an Admin or a Content Creator.
          </p>
          {seo && (
            <button type="button" className="btn" onClick={() => setDrawer('seo')}>
              <Icon name="seo" size={16} />
              Edit SEO
            </button>
          )}
        </div>
      )}

      {seo && access.seo !== 'none' && (
        <SeoDrawer
          open={drawer === 'seo'}
          onClose={() => setDrawer(null)}
          target={seo.target}
          context={seo.context}
          readOnly={access.seo !== 'full'}
          canAdvanced={access.seo === 'full'}
        />
      )}
      {access.sections && historyTarget && drawer === 'history' && (
        <HistoryDrawer
          open
          onClose={() => setDrawer(null)}
          target={historyTarget}
          pageId={page.id}
          path={page.path}
          onRestored={() => {
            void load();
            void form.current?.reloadTheirs();
          }}
        />
      )}
      {access.sections && rows && (
        <AddSectionModal
          open={adding}
          onClose={() => setAdding(false)}
          options={options}
          working={working}
          onPick={(type) => void add(type)}
        />
      )}
      {access.sections && (
        <RenameModal
          key={renameKey}
          open={renaming !== null}
          onClose={() => setRenaming(null)}
          label={renaming?.label ?? null}
          kindName={renaming ? (kindOf(renaming.type)?.name ?? renaming.type) : ''}
          working={working}
          error={renameError}
          onSave={(label) => void rename(label)}
        />
      )}
    </div>
  );
}
