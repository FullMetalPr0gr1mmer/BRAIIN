import { useMemo, useState } from 'react';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Icon from '@/components/admin/kit/Icon';
import ListRow from '@/components/admin/kit/ListRow';
import Modal from '@/components/admin/kit/Modal';
import SaveStatus, { type SaveState } from '@/components/admin/kit/SaveStatus';
import Segmented from '@/components/admin/kit/Segmented';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import Tabs from '@/components/admin/kit/Tabs';
import { useSortable } from '@/components/admin/kit/useSortable';
import type { SortLists } from '@/lib/admin/client/sortable';
import { PAGE_SIZE } from '@/lib/admin/pager';
import {
  KIT_COLUMNS,
  KIT_ROWS,
  KIT_SECTIONS,
  KIT_TAB_PARAM,
  type KitRow,
  type KitTab,
} from './samples';

// The component kit screen's island (Admin v2 F4b, /admin/kit): the React kit's stateful
// pieces on made-up data, so the signed-in sweep checks them in a browser and
// tests/admin/kit.e2e.ts drives them. Nothing is sent anywhere: every action changes this
// page's state only.

export interface KitGalleryProps {
  /** The tab the URL names (`?tab=`), read on the server so the first paint is right. */
  tab: KitTab;
}

const LABEL: Record<string, string> = Object.fromEntries(
  [...KIT_SECTIONS, ...KIT_COLUMNS.left, ...KIT_COLUMNS.right].map((item) => [item.id, item.label]),
);
const nameOf = (id: string) => LABEL[id] ?? id;

type StatusFilter = 'all' | KitRow['status'];
type Language = 'en' | 'ar' | 'both';
type ShownState = Exclude<SaveState, 'idle'>;

export default function KitGallery({ tab }: KitGalleryProps) {
  return (
    <div className="kit__stack">
      <TableDemo />
      <div className="grid grid--2">
        <SortableDemo />
        <BoardDemo />
      </div>
      <div className="grid grid--2">
        <TabsDemo tab={tab} />
        <DialogsDemo />
      </div>
      <FormDemo />
    </div>
  );
}

function TableDemo() {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [done, setDone] = useState('');
  const matching = useMemo(
    () => KIT_ROWS.filter((row) => filter === 'all' || row.status === filter),
    [filter],
  );
  const rows = matching.slice(offset, offset + PAGE_SIZE);
  const columns: DataColumn<KitRow>[] = [
    { key: 'title', label: 'Title' },
    { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'views', label: 'Views', num: true, render: (row) => row.views.toLocaleString('en-GB') },
  ];

  return (
    <section className="card" aria-labelledby="kit-table-h">
      <h3 id="kit-table-h" className="card-title">
        A data table
      </h3>
      <DataTable<KitRow>
        caption="Sample entries, with selection"
        columns={columns}
        rows={rows}
        rowName={(row) => row.title}
        rowHref={(row) => `#${row.id}`}
        total={matching.length}
        offset={offset}
        onPage={setOffset}
        rowActions={(row) => (
          <button type="button" className="icon-btn" aria-label={`Preview ${row.title}`}>
            <Icon name="eye" size={15} />
          </button>
        )}
        selection={{
          selected,
          onChange: (next) => {
            setSelected(next);
            setDone('');
          },
          actions: (ids) => (
            <button
              type="button"
              data-variant="primary"
              onClick={() => {
                setDone(
                  `${ids.length} sample ${ids.length === 1 ? 'entry' : 'entries'} marked as reviewed.`,
                );
                setSelected(new Set());
              }}
            >
              Mark as reviewed
            </button>
          ),
        }}
        toolbar={
          <Chips<StatusFilter>
            label="Filter the sample by status"
            chips={[
              { value: 'all', label: 'All', count: KIT_ROWS.length },
              { value: 'published', label: 'Published' },
              { value: 'draft', label: 'Draft' },
              { value: 'scheduled', label: 'Scheduled' },
            ]}
            selected={[filter]}
            onChange={([next]) => {
              setFilter(next ?? 'all');
              setOffset(0);
            }}
          />
        }
      />
      <p className="kit__done" role="status">
        {done}
      </p>
    </section>
  );
}

function SortableDemo() {
  const [order, setOrder] = useState<SortLists>(() => ({
    list: KIT_SECTIONS.map((section) => section.id),
  }));
  const { ref, lists, hintId } = useSortable<HTMLUListElement>({
    lists: order,
    onCommit: (next) => setOrder(next),
  });
  return (
    <section className="card" aria-labelledby="kit-sort-h">
      <h3 id="kit-sort-h" className="card-title">
        Reorder a list
      </h3>
      <ul className="list" ref={ref} aria-label="Sample sections">
        {(lists['list'] ?? []).map((id) => (
          <ListRow
            key={id}
            title={nameOf(id)}
            sortId={id}
            lead={<SortHandle label={nameOf(id)} describedBy={hintId} />}
            meta={<MoveButtons label={nameOf(id)} />}
          />
        ))}
      </ul>
      <SortHint id={hintId} />
      <p className="kit__done" data-kit-order="">
        Saved order: {(order['list'] ?? []).map(nameOf).join(', ')}
      </p>
    </section>
  );
}

function BoardDemo() {
  const [order, setOrder] = useState<SortLists>(() => ({
    left: KIT_COLUMNS.left.map((item) => item.id),
    right: KIT_COLUMNS.right.map((item) => item.id),
  }));
  const { ref, lists, hintId } = useSortable<HTMLDivElement>({
    lists: order,
    onCommit: (next) => setOrder(next),
  });
  const column = (key: 'left' | 'right', label: string) => (
    <div className="kit__col">
      <h4 className="kit__colh">{label}</h4>
      <ul
        className="list"
        data-sortable-list={key}
        data-sortable-list-label={label}
        aria-label={label}
      >
        {(lists[key] ?? []).map((id) => (
          <ListRow
            key={id}
            title={nameOf(id)}
            sortId={id}
            lead={<SortHandle label={nameOf(id)} describedBy={hintId} />}
            meta={<MoveButtons label={nameOf(id)} lists />}
          />
        ))}
      </ul>
    </div>
  );
  return (
    <section className="card" aria-labelledby="kit-board-h">
      <h3 id="kit-board-h" className="card-title">
        Move between lists
      </h3>
      <div className="kit__board" ref={ref}>
        {column('left', 'Left column')}
        {column('right', 'Right column')}
      </div>
      <SortHint id={hintId} />
    </section>
  );
}

function TabsDemo({ tab }: { tab: KitTab }) {
  const [language, setLanguage] = useState<Language>('en');
  return (
    <section className="card" aria-labelledby="kit-tabs-h">
      <h3 id="kit-tabs-h" className="card-title">
        Tabs and a segmented choice
      </h3>
      <Tabs
        label="Sample editor"
        active={tab}
        param={KIT_TAB_PARAM}
        tabs={[
          {
            id: 'content',
            label: 'Content',
            icon: 'pages',
            panel: (
              <div className="kit__stack">
                <Segmented<Language>
                  label="Edit in"
                  value={language}
                  onChange={setLanguage}
                  options={[
                    { value: 'en', label: 'English' },
                    { value: 'ar', label: 'العربية', lang: 'ar' },
                    { value: 'both', label: 'Both' },
                  ]}
                />
                <p className="kit__done">
                  Editing:{' '}
                  {language === 'en' ? 'English' : language === 'ar' ? 'Arabic' : 'both languages'}
                </p>
              </div>
            ),
          },
          {
            id: 'seo',
            label: 'SEO',
            icon: 'search',
            panel: <p>The page title and description search engines show.</p>,
          },
          {
            id: 'media',
            label: 'Media',
            icon: 'image',
            panel: <p>The share image and the clip.</p>,
          },
        ]}
      />
    </section>
  );
}

function DialogsDemo() {
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  return (
    <section className="card" aria-labelledby="kit-dialogs-h">
      <h3 id="kit-dialogs-h" className="card-title">
        A modal and a drawer
      </h3>
      <p className="kit__line">
        <button type="button" onClick={() => setModal(true)}>
          Rename the sample
        </button>
        <button type="button" onClick={() => setDrawer(true)}>
          Open the sample drawer
        </button>
      </p>
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Rename the sample"
        sub="Nothing is saved: this is the kit."
        dismissible={false}
        footer={
          <>
            <button type="button" onClick={() => setModal(false)}>
              Cancel
            </button>
            <button type="button" data-variant="primary" onClick={() => setModal(false)}>
              Rename
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="kit-rename">New name</label>
          <input id="kit-rename" type="text" defaultValue="Sample entry 1" />
        </div>
      </Modal>
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Sample details"
        footer={
          <button type="button" onClick={() => setDrawer(false)}>
            Done
          </button>
        }
      >
        <p>A drawer opens from the inline end and keeps the page behind it.</p>
      </Drawer>
    </section>
  );
}

function FormDemo() {
  const [state, setState] = useState<ShownState>('dirty');
  const [errors, setErrors] = useState<FieldError[]>([]);
  return (
    <section className="card" aria-labelledby="kit-form-h">
      <h3 id="kit-form-h" className="card-title">
        Saving and errors
      </h3>
      <div className="kit__stack">
        <Segmented<ShownState>
          label="Save state"
          value={state}
          onChange={setState}
          options={[
            { value: 'dirty', label: 'Unsaved' },
            { value: 'saving', label: 'Saving' },
            { value: 'saved', label: 'Saved' },
            { value: 'error', label: 'Not saved' },
          ]}
        />
        <SaveStatus state={state} savedAt="2026-10-12T11:05:00Z" />
        <ErrorSummary errors={errors} />
        <div className="field">
          <label htmlFor="kit-name">Name</label>
          <input
            id="kit-name"
            type="text"
            aria-invalid={errors.length > 0 || undefined}
            aria-describedby={errors.length > 0 ? 'kit-name-err' : undefined}
          />
          {errors.length > 0 && (
            <p id="kit-name-err" className="field-error">
              Give it a name.
            </p>
          )}
        </div>
        <p className="kit__line">
          <button
            type="button"
            onClick={() =>
              setErrors([
                { id: 'kit-name', message: 'Give it a name.' },
                { message: 'Add at least one section.' },
              ])
            }
          >
            Check the sample form
          </button>
          <button type="button" data-variant="ghost" onClick={() => setErrors([])}>
            Clear the errors
          </button>
        </p>
      </div>
    </section>
  );
}
