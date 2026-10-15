import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import type { SaveState } from '@/components/admin/kit/SaveStatus';
import type { FieldErrors } from './fieldErrors';
import { formToPayload, rowToForm } from './formPayload';
import type { FieldDef } from './uiSchema';

// The editor's save, as a pure state machine (Admin v2 F5a, ui.md §2.6, P-5): no React,
// no fetch, so every rule is unit-tested in node (tests/lib/entitySave.spec.ts) and the
// hook over it (useEntitySave.ts) only wires requests and events. ResourceForm and
// SingletonForm each carried these rules on their own until F5a; they live here once:
//
//   - the version is the whole point: the form sends back the version it loaded, so a
//     colleague's save in between is a 409 ("Reload their version"), never a silent
//     overwrite. A singleton that was never saved has NO row: GET answers version 0 and
//     the first PATCH sends 0, which the kernel reads as "create" (H7).
//   - a datetime the editor did not touch is left out of the PATCH: the input shows
//     minutes, the stored instant keeps its seconds.
//   - after a save the form is re-seeded from the SERVER's row (the bumped version, the
//     trigger-set fields, the derived ones such as reading_minutes), never from local state.
//   - a table with an edge snapshot (redirects) answers `kvSynced`; false is a committed
//     row the public request path does not see yet (`edgeMissed`).

type Row = Record<string, unknown>;

/** How an editor saves: explicit Save with version/409 (`live`), or drafts (R12). */
export type SaveMode = 'live' | 'draft';

/** What an editor saves: one row of a collection, or a per-tenant singleton. */
export type SaveTarget =
  { kind: 'resource'; slug: string } | { kind: 'singleton'; endpoint: string };

export interface EntitySaveState {
  values: Row;
  /** The values as loaded (or as last saved): what "dirty" and "untouched" compare to. */
  initial: Row;
  version: number;
  phase: 'loading' | 'ready' | 'saving' | 'load-failed';
  status: SaveState;
  /** When the last save landed (ISO), for "Saved at 14:05". */
  savedAt: string | null;
  errors: { byId: FieldErrors; summary: readonly FieldError[] };
  /** The server answered 409: someone else saved since this form loaded. */
  conflict: boolean;
  /** A refusal that is not about one field (403, rate limit, a malformed JSON box). */
  message: string | null;
  /** The row is saved but the public request path's snapshot was not rebuilt. */
  edgeMissed: boolean;
}

export type EntitySaveAction =
  | { type: 'loaded'; row: Row; fields: readonly FieldDef[]; versionFallback: number }
  | { type: 'load-failed'; message: string }
  | { type: 'set'; name: string; value: unknown }
  | { type: 'save-start' }
  | {
      type: 'saved';
      row: Row;
      fields: readonly FieldDef[];
      /** When it landed, ISO (the caller's clock: the reducer reads none). */
      at: string;
    }
  | {
      type: 'save-failed';
      message: string | null;
      errors?: { byId: FieldErrors; summary: readonly FieldError[] } | undefined;
    }
  | {
      /**
       * A create landed (POST). The form is clean from here: what it shows is what was
       * stored, so leaving for the record's edit screen asks nothing. While that page
       * loads (`navigating`) Save stays disabled, so a second press cannot create a twin.
       */
      type: 'created';
      at: string;
      navigating: boolean;
    }
  | { type: 'conflict' }
  | { type: 'reset' };

const NO_ERRORS = { byId: {}, summary: [] } as const;

/** The version a row without one is read as: a collection row is 1, a singleton's 0. */
export function versionFallback(target: SaveTarget): number {
  return target.kind === 'resource' ? 1 : 0;
}

/**
 * The state before anything loads. A new record starts ready, from `defaults` and then
 * each field's `defaultValue` (the create schema's default: a box the server would tick
 * is shown ticked); an existing one starts loading.
 */
export function initialSaveState(
  fields: readonly FieldDef[],
  isNew: boolean,
  defaults: Row = {},
): EntitySaveState {
  const values: Row = isNew
    ? {
        ...Object.fromEntries(
          fields.filter((f) => f.defaultValue !== undefined).map((f) => [f.name, f.defaultValue]),
        ),
        ...defaults,
      }
    : {};
  return {
    values,
    initial: values,
    version: 0,
    phase: isNew ? 'ready' : 'loading',
    status: 'idle',
    savedAt: null,
    errors: NO_ERRORS,
    conflict: false,
    message: null,
    edgeMissed: false,
  };
}

export function entitySaveReducer(
  state: EntitySaveState,
  action: EntitySaveAction,
): EntitySaveState {
  switch (action.type) {
    case 'loaded': {
      const values = rowToForm(action.row, action.fields);
      return {
        ...state,
        values,
        initial: values,
        version: Number(action.row['version'] ?? action.versionFallback),
        phase: 'ready',
        status: 'idle',
        errors: NO_ERRORS,
        conflict: false,
        message: null,
      };
    }
    case 'load-failed':
      return { ...state, phase: 'load-failed', message: action.message };
    case 'set':
      return {
        ...state,
        values: { ...state.values, [action.name]: action.value },
        status: 'dirty',
        // An edit after a save is a new change: the old "not on the edge" no longer
        // describes what is on screen (as ResourceForm did).
        edgeMissed: false,
      };
    case 'save-start':
      return { ...state, phase: 'saving', status: 'saving', message: null, errors: NO_ERRORS };
    case 'saved': {
      const values = rowToForm(action.row, action.fields);
      return {
        ...state,
        values,
        initial: values,
        version: Number(action.row['version'] ?? state.version + 1),
        phase: 'ready',
        status: 'saved',
        savedAt: action.at,
        errors: NO_ERRORS,
        conflict: false,
        message: null,
        edgeMissed: action.row['kvSynced'] === false,
      };
    }
    case 'created':
      return {
        ...state,
        initial: state.values,
        phase: action.navigating ? 'saving' : 'ready',
        status: 'saved',
        savedAt: action.at,
        errors: NO_ERRORS,
        message: null,
      };
    case 'save-failed':
      return {
        ...state,
        phase: 'ready',
        status: 'error',
        message: action.message,
        errors: action.errors ?? NO_ERRORS,
      };
    case 'conflict':
      // The editor's values are kept: "Reload their version" is a choice, not a reset.
      return { ...state, phase: 'ready', status: 'error', conflict: true, message: null };
    case 'reset':
      return {
        ...state,
        values: state.initial,
        phase: 'ready',
        status: 'idle',
        errors: NO_ERRORS,
        conflict: false,
        message: null,
      };
  }
}

/** True while the values differ from what was loaded or last saved. */
export function isDirty(state: EntitySaveState): boolean {
  if (state.phase === 'loading' || state.phase === 'load-failed') return false;
  return JSON.stringify(state.values) !== JSON.stringify(state.initial);
}

/** Where an editor reads its row from. */
export function loadUrl(target: SaveTarget, id: string | null): string {
  return target.kind === 'singleton' ? target.endpoint : `/api/admin/${target.slug}/${id ?? ''}`;
}

/**
 * The request a save sends. Throws (with the field's name) when a value cannot be sent at
 * all, such as a JSON box that does not parse: the caller shows that instead of posting.
 */
export function buildSaveRequest(
  target: SaveTarget,
  id: string | null,
  state: EntitySaveState,
  fields: readonly FieldDef[],
): { url: string; method: 'POST' | 'PATCH'; body: Row } {
  const body = formToPayload(state.values, fields);
  if (target.kind === 'resource' && id === null) {
    return { url: `/api/admin/${target.slug}`, method: 'POST', body };
  }
  // The datetime input shows minutes: an untouched one keeps the stored instant's seconds.
  for (const field of fields) {
    if (field.kind === 'datetime' && state.values[field.name] === state.initial[field.name]) {
      delete body[field.name];
    }
  }
  return { url: loadUrl(target, id), method: 'PATCH', body: { ...body, version: state.version } };
}

/** Where a created record opens: its edit screen, saying so when the edge missed it. */
export function createdHref(slug: string, row: Row): string {
  const missed = row['kvSynced'] === false ? '?edge=missed' : '';
  return `/admin/${slug}/${String(row['id'])}${missed}`;
}
