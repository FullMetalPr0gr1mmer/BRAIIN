import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import type { SaveState } from '@/components/admin/kit/SaveStatus';
import { AdminApiError, adminFetch, describeError } from './client';
import {
  autosaveDecision,
  buildSaveRequest,
  queuedSaveDecision,
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
  /**
   * Admin v2 R14b: a NEW record added from a screen in release mode (its target says `staged`,
   * R12b). No answer has said `draft` yet, but its create is a pending change, so the form is
   * the release form too: no per-item schedule, "Visible on the site" for its status.
   */
  stagedCreate?: boolean;
  /** Admin v2 R12: the pending change went live or was thrown away under the form. */
  gone?: DraftGone | null;
  /** Admin v2 R12: releases were switched off under the form; it offers a reload. */
  releasesOff?: boolean;
  /**
   * Admin v2 R14d: the last save that landed was the person's (Save, Add, ⌘S), not an automatic
   * one. A drawer that closes once an edit lands reads it (closeOnSave.ts), so in release mode
   * the first field left does not close it. Optional, as R12's members are: absent is theirs.
   */
  savedByPerson?: boolean;
  /** Admin v2 R12: save now if this is an unsaved pending change (blur, tab switch, ⌘S). */
  flush?(): void;
  /**
   * Admin v2 R14d review: a check every save the person did not just make asks first (the
   * blur, the tab switch, the idle timer, a save asked for while one was on its way). While it
   * says true the save waits; the person's own Save is the form's to guard. The form that draws
   * the boxes adds it (EditorForm: a box the browser could not read; SiteWideForm: a site-wide
   * noindex not yet confirmed). Returns the function that takes it off. Optional, as R12's are.
   */
  addAutoSaveVeto?(veto: AutoSaveVeto): () => void;
  /**
   * Admin v2 U5/U6: go to `href` without the unsaved-changes question, after an action that
   * made the form moot (the record was deleted: editorDelete.ts). Optional, so a screen's
   * fake save need not carry it.
   */
  leave?(href: string): void;
  /**
   * Admin v2 E1: read the record again and keep what was typed since the last save over it
   * (the `rebased` step a change settled in the publish dialog takes), after a save on its way
   * has landed. The page editor's sections column wrote the same row in draft mode, so the
   * pending change moved under the form. Optional, as R12's members are.
   */
  rebase?(): void;
}

/** True while an automatic save must wait (Admin v2 R14d review: `addAutoSaveVeto`). */
export type AutoSaveVeto = (values: Readonly<Row>) => boolean;

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
  // R14d: the person asked for a save (Save, Add, ⌘S) that has not landed yet. A press while an
  // automatic save is on its way is answered by that save when nothing was typed since, else by
  // a save of the person's own once it lands; either way the landing says it was theirs.
  const wanted = useRef(false);
  // R12 review: the pending change was settled in the publish dialog while a save was on its
  // way; read the record again once that save has landed.
  const rebaseNext = useRef(false);
  // R14d review: the forms' checks every automatic or replayed save asks first.
  const vetoes = useRef(new Set<AutoSaveVeto>());
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
    if (isNew && latest.current.releasesOff) {
      // R12b: a create refused because releases were switched off under the screen that
      // opened it. There is no record to read: the screen is read again, live (its list
      // answer then carries no `draftsInvalid`), and the form starts over, as an editor's
      // Reload takes the live row over what it held.
      leaving.current = true;
      window.location.reload();
      return;
    }
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
  }, [url, fields, isNew]);

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
    // `replay`: the person's press, sent now that the save it waited for has landed (R14d).
    async (auto: boolean, replay = false): Promise<boolean> => {
      const current = latest.current;
      const target = targetRef.current;
      if (current.phase !== 'ready' || inFlight.current) {
        if (inFlight.current) {
          again.current = true;
          if (!auto) wanted.current = true;
        }
        return false;
      }
      // R14d review: a save the person did not just make (an automatic one, or a press replayed
      // over values typed since) waits while a form's check says so, as the person's Save does.
      if ((auto || replay) && [...vetoes.current].some((veto) => veto(current.values))) {
        wanted.current = false;
        return false;
      }
      if (!auto) wanted.current = true;
      let request: ReturnType<typeof buildSaveRequest>;
      try {
        request = buildSaveRequest(target, id, current, fields);
      } catch (err) {
        // R14d review: a refusal answers the person's press (as the request's refusals do).
        wanted.current = false;
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
          // R14d review: a press while it was on its way is answered by it: never a second
          // create (Ctrl/⌘+S pressed again, or held, made a duplicate item).
          again.current = false;
          wanted.current = false;
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
        // R14d: whose save this was. The person's own, or an automatic one that carried
        // everything the person had when they pressed Save (nothing typed since it was sent).
        const typedSince =
          JSON.stringify(latest.current.values) !== JSON.stringify(latest.current.sent);
        const byPerson = !auto || (wanted.current && !typedSince);
        if (byPerson) wanted.current = false;
        dispatch({ type: 'saved', row, fields, at: new Date().toISOString(), byPerson });
        onRow.current?.(row);
        if ('draft' in row) announcePending();
        return true;
      } catch (err) {
        // A refusal answers the person's press too: they see why, and press again.
        wanted.current = false;
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
      // R14d: a press the save that just landed did not answer is the person's save now; never
      // for a new record or with releases off, and only over something new (queuedSaveDecision).
      const next = queuedSaveDecision(latest.current, isNew, wanted.current);
      if (next !== 'person') wanted.current = false;
      if (next === 'person') void run(false, true);
      else if (next === 'auto') flush();
    }
  }, [state.phase, flush, rebase, run, isNew]);

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
    stagedCreate: isNew && target.kind === 'resource' && target.staged === true,
    gone: state.gone,
    releasesOff: state.releasesOff,
    savedByPerson: state.savedByPerson,
    flush,
    addAutoSaveVeto: useCallback((veto: AutoSaveVeto) => {
      vetoes.current.add(veto);
      return () => {
        vetoes.current.delete(veto);
      };
    }, []),
    leave: useCallback((href: string) => {
      leaving.current = true;
      window.location.assign(href);
    }, []),
    rebase: useCallback(() => {
      if (inFlight.current || latest.current.phase !== 'ready') rebaseNext.current = true;
      else void rebase();
    }, [rebase]),
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
