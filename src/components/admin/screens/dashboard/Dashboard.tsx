import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DashboardLayout, DashboardPref, QuickItem, WidgetId } from '@schemas/dashboard';
import Icon from '@/components/admin/kit/Icon';
import Modal from '@/components/admin/kit/Modal';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import AddWidgetDrawer from './AddWidgetDrawer';
import { readBoard, startCustomize, type BoardLists, type Customize } from './customize';
import QuickActionsDrawer from './QuickActionsDrawer';
import RoleDefaultsModal from './RoleDefaultsModal';
import type { DashboardIslandProps } from './types';

// The dashboard's one island (Admin v2 U1): the head's Customize, and what it opens over the
// server-rendered board. It never fetches widget data; it saves the person's preferences
// (PUT /api/admin/me/preferences, under their version) and the presets (Admin).
//   Customize   the board's controls show (customize.ts binds the Sortable core); each move
//               or hide is saved as it happens; the bar has Add widget (a drawer; it saves,
//               then reloads, as the design says), Reset (a confirm), the presets (Admin) and
//               Done.
//   Quick       "Customize quick actions" on that widget opens its editor (a drawer).
//   Notes       "Edit notes" opens the field kit's singleton editor in place, loaded only
//               then (import()), so the board itself carries no form code.

// The field kit is the admin-fields chunk group (F5a): reached lazily, never from here.
const NotesEditor = lazy(() => import('@/components/admin/screens/singleton/SingletonForm'));

type Status = { kind: 'ok' | 'error'; text: string } | null;

export default function Dashboard(props: DashboardIslandProps) {
  const [editing, setEditing] = useState(false);
  const [hidden, setHidden] = useState<WidgetId[]>(props.layout.hidden);
  const [source, setSource] = useState(props.source);
  const [status, setStatus] = useState<Status>(null);
  const [conflict, setConflict] = useState(false);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [targets, setTargets] = useState<{
    bar: HTMLElement | null;
    notes: HTMLElement | null;
    board: HTMLElement | null;
  }>({ bar: null, notes: null, board: null });

  const version = useRef(props.version);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const customize = useRef<Customize | null>(null);
  const live = useRef<HTMLParagraphElement | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  // The server markup this island works on, and the two buttons it shows there.
  useEffect(() => {
    const board = document.querySelector<HTMLElement>('[data-dash]');
    setTargets({
      board,
      bar: document.querySelector<HTMLElement>('[data-dash-bar]'),
      notes: document.querySelector<HTMLElement>('[data-notes-editor]'),
    });
    if (!props.editable) return;
    const quick = document.querySelector<HTMLButtonElement>('[data-quick-edit]');
    const notes = document.querySelector<HTMLButtonElement>('[data-notes-edit]');
    const openQuick = () => setQuickOpen(true);
    const openNotes = () => setNotesOpen(true);
    if (quick) {
      quick.hidden = false;
      quick.addEventListener('click', openQuick);
    }
    if (notes) {
      notes.hidden = false;
      notes.addEventListener('click', openNotes);
    }
    return () => {
      quick?.removeEventListener('click', openQuick);
      notes?.removeEventListener('click', openNotes);
    };
  }, [props.editable]);

  // The notes' text gives way to the editor while it is open.
  useEffect(() => {
    const view = document.querySelector<HTMLElement>('[data-notes-view]');
    const button = document.querySelector<HTMLButtonElement>('[data-notes-edit]');
    if (view) view.hidden = notesOpen;
    if (button) button.hidden = notesOpen || !props.editable;
  }, [notesOpen, props.editable]);

  /** Saves preferences after the saves before it, under the version the last one left. */
  const save = useCallback(
    (body: { dashboard?: DashboardPref; quickActions?: QuickItem[] }): Promise<boolean> => {
      const run = queue.current.then(async () => {
        try {
          const saved = await adminFetch<{ version: number }>('/api/admin/me/preferences', {
            method: 'PUT',
            body: { version: version.current, ...body },
          });
          version.current = saved.version;
          return true;
        } catch (err) {
          if (err instanceof AdminApiError && err.info.status === 409) setConflict(true);
          else setStatus({ kind: 'error', text: describeError(err) });
          return false;
        }
      });
      queue.current = run;
      return run;
    },
    [],
  );

  const layoutOf = useCallback(
    (lists: BoardLists, hide: readonly WidgetId[]): DashboardLayout => ({
      top: lists.top,
      left: lists.left,
      right: lists.right,
      hidden: [...hide],
      ...(props.storedQuickSet ? { quickSet: true } : {}),
    }),
    [props.storedQuickSet],
  );

  // Customize on and off: the binder over the board.
  useEffect(() => {
    const board = targets.board;
    if (!editing || !board) return;
    customize.current = startCustomize(board, {
      live: live.current,
      onChange: (lists, hiddenNow) => {
        const nextHidden = hiddenNow ? [...hiddenRef.current, hiddenNow] : hiddenRef.current;
        if (hiddenNow) setHidden(nextHidden);
        setSource('mine');
        void save({ dashboard: layoutOf(lists, nextHidden) }).then((ok) => {
          if (ok) setStatus({ kind: 'ok', text: 'Saved.' });
        });
      },
    });
    return () => {
      customize.current?.stop();
      customize.current = null;
    };
  }, [editing, targets.board, save, layoutOf]);

  async function addWidget(id: WidgetId, column: 'left' | 'right') {
    const board = targets.board;
    if (!board) return;
    const lists = readBoard(board);
    lists[column] = [...lists[column], id];
    const ok = await save({
      dashboard: layoutOf(
        lists,
        hidden.filter((h) => h !== id),
      ),
    });
    if (ok) window.location.reload();
  }

  async function reset() {
    // Back to the role's layout (its preset, else the code's): the person's columns go, their
    // own quick actions stay (D8).
    const ok = await save({ dashboard: props.storedQuickSet ? { quickSet: true } : {} });
    if (ok) window.location.reload();
  }

  const catalogLabel = (id: WidgetId) => props.catalog.find((w) => w.id === id)?.label ?? id;

  if (!props.editable) return null;

  const bar = editing && targets.bar && (
    <div className="dash__bar" role="region" aria-label="Customize the dashboard">
      <Icon name="move" size={18} />
      <span className="dash__bar-t">
        Drag widgets to reorder them or move them between columns. Use the eye to hide one.
      </span>
      <button type="button" data-size="sm" onClick={() => setAdding(true)}>
        <Icon name="plus" size={14} />
        Add widget
      </button>
      <button type="button" data-size="sm" data-variant="ghost" onClick={() => setResetting(true)}>
        Reset
      </button>
      {props.presets && (
        <button
          type="button"
          data-size="sm"
          data-variant="ghost"
          onClick={() => setPresetsOpen(true)}
        >
          Save as the default for a role
        </button>
      )}
      <button type="button" data-size="sm" data-variant="primary" onClick={() => setEditing(false)}>
        <Icon name="check" size={14} />
        Done
      </button>
      {status && (
        <p
          className="msg dash__bar-msg"
          data-kind={status.kind === 'error' ? 'error' : 'ok'}
          role={status.kind === 'error' ? 'alert' : undefined}
        >
          {status.text}
        </p>
      )}
      <p ref={live} className="visually-hidden" aria-live="assertive" aria-atomic="true" />
    </div>
  );

  return (
    <>
      <button
        type="button"
        aria-pressed={editing ? 'true' : 'false'}
        onClick={() => {
          setStatus(null);
          setEditing((on) => !on);
        }}
      >
        <Icon name="grid" size={14} />
        {editing ? 'Done customizing' : 'Customize'}
      </button>
      {bar && targets.bar && createPortal(bar, targets.bar)}
      {conflict &&
        targets.bar &&
        createPortal(
          <div className="msg editor__conflict" data-kind="error" role="alert">
            <span>Your dashboard was changed in another tab.</span>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>,
          targets.bar,
        )}

      <AddWidgetDrawer
        open={adding}
        onClose={() => setAdding(false)}
        widgets={hidden.map((id) => ({
          id,
          label: catalogLabel(id),
          description: props.catalog.find((w) => w.id === id)?.description ?? '',
        }))}
        onAdd={(id, column) => void addWidget(id, column)}
      />

      <Modal
        open={resetting}
        onClose={() => setResetting(false)}
        title="Reset the dashboard?"
        sub={
          source === 'mine'
            ? 'Back to the layout for your role. Only your dashboard changes.'
            : 'Your dashboard already shows the layout for your role.'
        }
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setResetting(false)}>
              Cancel
            </button>
            <button type="button" data-variant="primary" onClick={() => void reset()}>
              Reset
            </button>
          </>
        }
      >
        <p>Your quick actions stay as they are.</p>
      </Modal>

      {props.presets && (
        <RoleDefaultsModal
          open={presetsOpen}
          onClose={() => setPresetsOpen(false)}
          roles={props.presets}
          board={targets.board}
          hidden={hidden}
          quick={props.quick.items}
        />
      )}

      {props.quickShown && (
        <QuickActionsDrawer
          open={quickOpen}
          onClose={() => setQuickOpen(false)}
          items={props.quick.items}
          library={props.quick.library}
          onSave={async (items) => {
            const lists = targets.board ? readBoard(targets.board) : props.layout;
            const ok = await save({
              quickActions: items,
              dashboard:
                source === 'mine'
                  ? { ...layoutOf(lists, hidden), quickSet: true }
                  : { quickSet: true },
            });
            if (ok) window.location.reload();
            return ok;
          }}
          onReset={async () => {
            const lists = targets.board ? readBoard(targets.board) : props.layout;
            const base = layoutOf(lists, hidden);
            const ok = await save({
              quickActions: [],
              dashboard:
                source === 'mine'
                  ? { top: base.top, left: base.left, right: base.right, hidden: base.hidden }
                  : {},
            });
            if (ok) window.location.reload();
            return ok;
          }}
        />
      )}

      {notesOpen &&
        targets.notes &&
        createPortal(
          <div className="notes__editor">
            <Suspense fallback={<p className="admin-sub">Loading…</p>}>
              <NotesEditor config="team-notes" />
            </Suspense>
            <button type="button" data-variant="ghost" onClick={() => window.location.reload()}>
              Close the editor
            </button>
          </div>,
          targets.notes,
        )}
    </>
  );
}
