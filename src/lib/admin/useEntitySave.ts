import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import type { SaveState } from '@/components/admin/kit/SaveStatus';
import { AdminApiError, adminFetch, describeError } from './client';
import {
  autosaveDecision,
  buildSaveRequest,
  createdHref,
  entitySaveReducer,
  initialSaveState,
  isDirty,
  loadUrl,
  versionFallback,
  type DraftGone,
  type EditorDraft,
  type SaveMode,
  type SaveTarget,
} from './entitySave';
import { errorsFromApi, type FieldErrors } from './fieldErrors';
import { announcePending, onSettled } from './releaseEvents';
import type { FieldDef } from './uiSchema';

// The editor's save hook (Admin v2 F5a, ui.md §2.6, P-5): every editor saves through it,
// so it is the one place that knows HOW an editor saves. The rules live in the pure
// machine (entitySave.ts, unit-tested); this file loads the row, sends the request, and
// wires the page's events.
//
// Live mode (releases off): an explicit Save sends the version the form loaded; a 409 keeps
// the editor's work and offers "Reload their version"; a 422 lands on the fields
// (fieldErrors.ts); Ctrl/⌘+S saves (useSaveShortcut); leaving the page with unsaved changes
// asks first (`beforeunload`). No keystroke autosave (P-5, D8).
//
// Draft mode (Admin v2 R12, releases on): the SERVER says which mode a record is in. A
// release-managed route answers its row with a `draft` key when releases are on, and only
// then (entitySave.ts readDraft), so the hook follows the answer and needs no switch of its
// own: R14 turns releases on in the database and every editor follows. In draft mode a save
// is a pending change, named on every save (`draftId` + `draftVersion`), and the editor also
// saves by itself (P-5): when focus leaves a control it changed (`flush`, which EditorForm
// calls on blur and on a tab switch), on Ctrl/⌘+S, and, for an editor that asks for it,
// after `autosave.idleMs` without typing (E1's page editor: 800 ms, so its preview follows).
// A create is always an explicit Save (there is nothing to stage until the person says so).
// After a saved pending change, `admin:pending` tells the savebar (releaseEvents.ts).

type Row = Record<string, unknown>;

export interface EntitySave {
  isNew: boolean;
  values: Row;
  /**
   * The values as loaded or last saved (Admin v2 U8 review): what is stored, for anything
   * that must describe the record as it is, not as typed ("Open on site").
   */
  saved: Row;
  set(name: string, value: unknown): void;
  version: number;
  /** Loading the row, or saving it. */
  busy: boolean;
  loadError: string | null;
  status: SaveState;
  savedAt: string | null;
  errors: { byId: FieldErrors; summary: readonly FieldError[] };
  conflict: boolean;
  edgeMissed: boolean;
  dirty: boolean;
  /** Why the last save was refused, when it is not about one field (a 403, a bad JSON box). */
  message: string | null;
  save(): Promise<boolean>;
  reloadTheirs(): Promise<void>;
  /**
   * Admin v2 U9: take the row's version after ONE write of this screen's own moved it; kept
   * only when the form was at the version just before (entitySave.ts).
   */
  adoptVersion(version: number): void;
  // Admin v2 R12's members are optional, so a save built by hand (a test's, a screen's own)
  // that names none of them is a live-mode save: EditorForm reads a missing `mode` as live.
  /** Admin v2 R12: how this record saves, as the server's last answer said. */
  mode?: SaveMode;
  /** Admin v2 R12: the pending change the record carries (draft mode), else null. */
  draft?: EditorDraft | null;
  /** Admin v2 R12: the record is staged for removal (read only until "Undo removal"). */
  pendingRemoval?: boolean;
  /** Admin v2 R12: the pending change went live or was thrown away under the form. */
  gone?: DraftGone | null;
  /** Admin v2 R12: releases were switched off under the form; it offers a reload. */
  releasesOff?: boolean;
  /** Admin v2 R12: save now if this is an unsaved pending change (blur, tab switch, ⌘S). */
  flush?(): void;
}

export interface UseEntitySaveOptions {
  fields: readonly FieldDef[];
  /**
   * The mode before the server has answered (`saveModeFor`). From the first answer on the
   * server's `draft` key decides (R12): a release-managed route with releases on says draft.
   */
  mode?: SaveMode;
  /** A new record's starting values, over each field's `defaultValue`. */
  defaults?: Row;
  /** A created record: by default its edit screen opens (resources only). */
  onCreated?: (row: Row) => void;
  /**
   * Admin v2 U9: the row as the server answered it, on every load and save: what a screen
   * shows beside the form (maintenance's state now, whether the edge took the change).
   */
  onRow?: (row: Row) => void;
  /**
   * Admin v2 R12: in draft mode, also save this long after the last keystroke (E1's page
   * editor: 800 ms, P-5). Without it an editor saves on blur, a tab switch and ⌘S.
   */
  autosave?: { idleMs: number } | undefined;
}

/** "?edge=missed" on the address: the create that led here missed the edge snapshot. */
function arrivedEdgeMissed(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('edge') === 'missed'
  );
}

/** The draft 409s a staged save answers (R3a), by the code the kernel sends. */
const GONE: ReadonlySet<string> = new Set<DraftGone>(['draft-published', 'draft-discarded']);

export function useEntitySave(
  target: SaveTarget,
  id: string | null,
  options: UseEntitySaveOptions,
): EntitySave {
  const { fields, defaults, onCreated } = options;
  const idleMs = options.autosave?.idleMs;
  const onRow = useRef(options.onRow);
  onRow.current = options.onRow;
  const isNew = target.kind === 'resource' && id === null;
  const [state, dispatch] = useReducer(entitySaveReducer, undefined, () => {
    const first = initialSaveState(fields, isNew, defaults);
    return { ...first, edgeMissed: arrivedEdgeMissed() };
  });
  // The latest state for save(): a value changed in the same event (a chip committed on
  // blur as Save is pressed) is read from here, not from a stale closure.
  const latest = useRef(state);
  latest.current = state;
  // The target is an object literal at most call sites (a new one each render): read
  // through a ref, and the callbacks follow its address instead.
  const targetRef = useRef(target);
  targetRef.current = target;
  // Set when this form sends the page away itself (a create opening its edit screen): the
  // unsaved-changes guard then lets it go. The state is marked clean too ('created'), but
  // the guard's listener comes off only after the next render, and the page leaves now.
  const leaving = useRef(false);
  // R12: a save on its way (set before the request, cleared after its answer), so a second
  // trigger (a blur as Save is pressed) waits for it instead of sending a twin; and a save
  // asked for meanwhile, run once the first lands.
  const inFlight = useRef(false);
  const again = useRef(false);
  // R12 review: the pending change was settled in the publish dialog while a save was on its
  // way; read the record again once that save has landed.
  const rebaseNext = useRef(false);
  const url = loadUrl(target, id);

  const load = useCallback(async () => {
    try {
      const row = await adminFetch<Row>(url);
      dispatch({
        type: 'loaded',
        row,
        fields,
        versionFallback: versionFallback(targetRef.current),
      });
      onRow.current?.(row);
    } catch (err) {
      dispatch({ type: 'load-failed', message: describeError(err) });
    }
  }, [url, fields]);

  useEffect(() => {
    if (!isNew) void load();
  }, [isNew, load]);

  // "Reload their version" after a 409. If their row cannot be read, the editor keeps what
  // is on screen (and the conflict banner) and is told why: a failed reload never throws
  // the editor's work away the way a failed first load shows no form.
  const reloadTheirs = useCallback(async () => {
    try {
      const row = await adminFetch<Row>(url);
      dispatch({
        type: 'loaded',
        row,
        fields,
        versionFallback: versionFallback(targetRef.current),
      });
      onRow.current?.(row);
    } catch (err) {
      dispatch({
        type: 'save-failed',
        message: `Their version could not be loaded: ${describeError(err)}`,
      });
    }
  }, [url, fields]);

  // R12 review: the pending change was settled in the publish dialog (its version moved): read
  // the record again and keep what was typed since the last save over it. A read that fails
  // changes nothing (the next save then meets the conflict and says so).
  const rebase = useCallback(async () => {
    try {
      const row = await adminFetch<Row>(url);
      dispatch({
        type: 'rebased',
        row,
        fields,
        versionFallback: versionFallback(targetRef.current),
      });
      onRow.current?.(row);
    } catch {
      // Nothing to do: the form keeps what it shows.
    }
  }, [url, fields]);

  const run = useCallback(
    async (auto: boolean): Promise<boolean> => {
      const current = latest.current;
      const target = targetRef.current;
      if (current.phase !== 'ready' || inFlight.current) {
        if (inFlight.current) again.current = true;
        return false;
      }
      let request: ReturnType<typeof buildSaveRequest>;
      try {
        request = buildSaveRequest(target, id, current, fields);
      } catch (err) {
        dispatch({
          type: 'save-failed',
          message: err instanceof Error ? err.message : String(err),
          auto,
        });
        return false;
      }
      inFlight.current = true;
      dispatch({ type: 'save-start' });
      try {
        const row = await adminFetch<Row>(request.url, {
          method: request.method,
          body: request.body,
        });
        if (request.method === 'POST' && target.kind === 'resource') {
          // A create opens the record's edit screen; the form's state goes with the page.
          const at = new Date().toISOString();
          if ('draft' in row) announcePending();
          if (onCreated) {
            dispatch({ type: 'created', at, navigating: false });
            onCreated(row);
          } else {
            dispatch({ type: 'created', at, navigating: true });
            leaving.current = true;
            window.location.href = createdHref(target.slug, row);
          }
          return true;
        }
        dispatch({ type: 'saved', row, fields, at: new Date().toISOString() });
        onRow.current?.(row);
        if ('draft' in row) announcePending();
        return true;
      } catch (err) {
        if (err instanceof AdminApiError && err.info.status === 409) {
          const code = err.info.error;
          if (GONE.has(code)) {
            const live = err.body['live'];
            dispatch({
              type: 'draft-gone',
              code: code as DraftGone,
              live: live && typeof live === 'object' ? (live as Row) : null,
              fields,
              versionFallback: versionFallback(target),
            });
            announcePending();
          } else if (code === 'scheduled') {
            dispatch({ type: 'scheduled' });
          } else if (code === 'releases-off') {
            // Releases were switched off under the form: nothing was written; hold for a reload.
            dispatch({ type: 'releases-off' });
          } else if (code === 'draft-conflict' && typeof err.info.detail === 'string') {
            // The change is staged for removal, or its row is gone: the server's words.
            dispatch({ type: 'save-failed', message: err.info.detail, auto });
          } else {
            dispatch({ type: 'conflict' });
          }
          return false;
        }
        const mapped = errorsFromApi(err, fields, current.values);
        dispatch({
          type: 'save-failed',
          message: mapped ? null : describeError(err),
          errors: mapped ?? undefined,
          auto,
        });
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [id, fields, onCreated],
  );

  const save = useCallback((): Promise<boolean> => run(false), [run]);

  /**
   * Draft mode only: save now when the form holds an unsaved pending change. Never for a new
   * record, a removal, a scheduled change, after a conflict (`held`) or a refused automatic
   * save until the next edit (`autoBlocked`). A save on its way runs again once it lands.
   */
  const flush = useCallback((): void => {
    const decision = autosaveDecision(latest.current, isNew, inFlight.current);
    if (decision === 'later') again.current = true;
    else if (decision === 'save') void run(true);
  }, [run, isNew]);

  // A save asked for while one was on its way: once that one has landed (and rendered). A
  // read asked for by a settle in the publish dialog goes first.
  useEffect(() => {
    if (state.phase !== 'ready' || inFlight.current) return;
    if (rebaseNext.current) {
      rebaseNext.current = false;
      void rebase();
    } else if (again.current) {
      again.current = false;
      flush();
    }
  }, [state.phase, flush, rebase]);

  // R12 review: the publish dialog settled this record's pending change.
  const draftId = state.draft?.id;
  useEffect(() => {
    if (!draftId) return;
    return onSettled((settled) => {
      if (settled !== draftId) return;
      if (inFlight.current || latest.current.phase !== 'ready') rebaseNext.current = true;
      else void rebase();
    });
  }, [draftId, rebase]);

  const dirty = isDirty(state);

  // The page editor's idle save (P-5: 800 ms), in draft mode only.
  useEffect(() => {
    if (!idleMs || state.draft === undefined || isNew || !dirty) return;
    const timer = window.setTimeout(flush, idleMs);
    return () => window.clearTimeout(timer);
  }, [state.values, state.draft, idleMs, isNew, dirty, flush]);

  // Leaving with unsaved changes asks first (D7). The browser writes the question.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      // Older engines show the prompt only when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  return {
    isNew,
    values: state.values,
    saved: state.initial,
    set: useCallback((name: string, value: unknown) => dispatch({ type: 'set', name, value }), []),
    version: state.version,
    busy: state.phase === 'loading' || state.phase === 'saving',
    loadError: state.phase === 'load-failed' ? state.message : null,
    status: state.status,
    savedAt: state.savedAt,
    errors: state.errors,
    conflict: state.conflict,
    edgeMissed: state.edgeMissed,
    dirty,
    message: state.phase === 'load-failed' ? null : state.message,
    save,
    reloadTheirs,
    adoptVersion: useCallback((version: number) => dispatch({ type: 'version', version }), []),
    mode: state.draft !== undefined ? 'draft' : (options.mode ?? 'live'),
    draft: state.draft ?? null,
    pendingRemoval: state.pendingRemoval,
    gone: state.gone,
    releasesOff: state.releasesOff,
    flush,
  };
}

/** Ctrl+S (⌘S on a Mac) saves instead of saving the web page (D7). */
export function useSaveShortcut(save: () => unknown): void {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
