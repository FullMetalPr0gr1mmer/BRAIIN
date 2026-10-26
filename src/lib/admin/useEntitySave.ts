import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import type { SaveState } from '@/components/admin/kit/SaveStatus';
import { AdminApiError, adminFetch, describeError } from './client';
import {
  buildSaveRequest,
  createdHref,
  entitySaveReducer,
  initialSaveState,
  isDirty,
  loadUrl,
  versionFallback,
  type SaveMode,
  type SaveTarget,
} from './entitySave';
import { errorsFromApi, type FieldErrors } from './fieldErrors';
import type { FieldDef } from './uiSchema';

// The editor's save hook (Admin v2 F5a, ui.md §2.6, P-5): every editor saves through it,
// so it is the one place that knows HOW an editor saves. The rules live in the pure
// machine (entitySave.ts, unit-tested); this file loads the row, sends the request, and
// wires the page's events.
//
// Live mode (until releases switch on): an explicit Save sends the version the form
// loaded; a 409 keeps the editor's work and offers "Reload their version"; a 422 lands
// on the fields (fieldErrors.ts); Ctrl/⌘+S saves (useSaveShortcut); leaving the page with
// unsaved changes asks first (`beforeunload`). No keystroke autosave (P-5, D8).
//
// Draft mode is R12's: it keeps every call site as it is (`mode: saveModeFor(target)`)
// and adds base_version, the 800 ms debounce and the `admin:pending` event here.

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
  /**
   * Admin v2 U5/U6: go to `href` without the unsaved-changes question, after an action that
   * made the form moot (the record was deleted: editorDelete.ts). Optional, so a screen's
   * fake save need not carry it.
   */
  leave?(href: string): void;
}

export interface UseEntitySaveOptions {
  fields: readonly FieldDef[];
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
}

/** "?edge=missed" on the address: the create that led here missed the edge snapshot. */
function arrivedEdgeMissed(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('edge') === 'missed'
  );
}

export function useEntitySave(
  target: SaveTarget,
  id: string | null,
  options: UseEntitySaveOptions,
): EntitySave {
  if ((options.mode ?? 'live') === 'draft') {
    throw new Error('Draft saving arrives with releases (R12)');
  }
  const { fields, defaults, onCreated } = options;
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

  const save = useCallback(async (): Promise<boolean> => {
    const current = latest.current;
    const target = targetRef.current;
    if (current.phase !== 'ready') return false;
    let request: ReturnType<typeof buildSaveRequest>;
    try {
      request = buildSaveRequest(target, id, current, fields);
    } catch (err) {
      dispatch({ type: 'save-failed', message: err instanceof Error ? err.message : String(err) });
      return false;
    }
    dispatch({ type: 'save-start' });
    try {
      const row = await adminFetch<Row>(request.url, {
        method: request.method,
        body: request.body,
      });
      if (request.method === 'POST' && target.kind === 'resource') {
        // A create opens the record's edit screen; the form's state goes with the page.
        const at = new Date().toISOString();
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
      return true;
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        dispatch({ type: 'conflict' });
        return false;
      }
      const mapped = errorsFromApi(err, fields, current.values);
      dispatch({
        type: 'save-failed',
        message: mapped ? null : describeError(err),
        errors: mapped ?? undefined,
      });
      return false;
    }
  }, [id, fields, onCreated]);

  const dirty = isDirty(state);

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
    leave: useCallback((href: string) => {
      leaving.current = true;
      window.location.assign(href);
    }, []),
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
