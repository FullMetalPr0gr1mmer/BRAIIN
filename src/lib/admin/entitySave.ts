import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import type { SaveState } from '@/components/admin/kit/SaveStatus';
import type { FieldErrors } from './fieldErrors';
import { formToPayload, rowToForm } from './formPayload';
import { stagedUrl } from './releaseEvents';
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
//
// Draft mode (Admin v2 R12, P-5): with releases on, a release-managed route answers its row
// with a `draft` key, the pending change the row carries (null when there is none yet), and it
// never does with releases off. The machine reads that key and nothing else to know the mode:
//   - every save names the pending change it was made on (`draftId` + `draftVersion`, beside
//     the live `version`), as R3a's staged PATCH asks;
//   - a value typed while a save is in flight is kept when its answer lands (an autosave runs
//     while the person types);
//   - the 409s of a pending change each have their way out: someone else saved it
//     (`draft-conflict`, the "Reload their version" banner), it was published or thrown away
//     under the form (`draft-published`, `draft-discarded`: the values stay, the form is on
//     live again, "Save again" makes a new change), a schedule holds it (`scheduled`);
//   - autosave waits for the person after any of those (`held`), and for the next edit after
//     a refused automatic save (`autoBlocked`);
//   - every save also says it was made in release mode (`staged: true`, even with nothing
//     pending yet), so a form left open across a switch-off is refused (409 `releases-off`)
//     instead of writing live what it holds (src/lib/release/releasesOff.ts): it then holds,
//     and offers Reload (`releasesOff`).
// With releases off no answer carries `draft`, so `draft` stays undefined and every rule above
// is the live mode's, request for request (tests/lib/entitySave.spec.ts).

type Row = Record<string, unknown>;

/** How an editor saves: explicit Save with version/409 (`live`), or pending changes (R12). */
export type SaveMode = 'live' | 'draft';

/**
 * The pending change an editor is on (Admin v2 R12): the item read's `draft` (R3a's DraftMeta,
 * as overlayRow answers it). `releaseId`: a scheduled release has claimed it (read only).
 * `conflict`: the columns live moved in since the change began. `liveMissing`: the live row is
 * gone under it. `invalid`: its stored payload no longer reads.
 */
export interface EditorDraft {
  id: string;
  version: number;
  op: 'create' | 'update' | 'delete';
  fields: readonly string[];
  releaseId: string | null;
  conflict: readonly string[];
  liveMissing: boolean;
  invalid: boolean;
}

/** The draft-specific 409s of a staged save that leave the form on live again (R3a). */
export type DraftGone = 'draft-published' | 'draft-discarded';

/**
 * What an editor saves: one row of a collection, or a per-tenant singleton. A collection
 * row may save somewhere other than where it loads from (Admin v2 U4, additive): `saveUrl`
 * names the PATCH's address (the media drawer's alt text and tags go through
 * /api/admin/media/meta/<id>, the one door every role that reads the library may write
 * through); the load and a create are unchanged.
 */
export type SaveTarget =
  | {
      kind: 'resource';
      slug: string;
      saveUrl?: ((id: string) => string) | undefined;
      /**
       * Admin v2 R12b: the screen this NEW record is added from is in release mode (its list
       * answer came through the release, releaseEvents.ts readsThroughRelease, or its editor is
       * in draft mode), so the create says so (STAGED_QUERY): once releases are switched off
       * under the screen, the live POST refuses it (409 `releases-off`) instead of creating the
       * record live. A create only: a saved record's mode is its own answer's (`draft`).
       */
      staged?: boolean | undefined;
    }
  | { kind: 'singleton'; endpoint: string }
  /**
   * A page's SEO row (Admin v2 U10, additive): keyed by its target, not its own id. GET
   * /api/admin/entity-seo?entityType=&entityId= loads it (the defaults at version 0 when it
   * has no row), and a save is a PUT of the whole meta (a full replace) with the target and
   * the version it loaded.
   */
  | { kind: 'entitySeo'; entityType: string; entityId: string };

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
  /**
   * Admin v2 R12: the pending change the form is on. Undefined: the server saves live (no
   * answer carried `draft`: releases off, or a route outside the release); null: releases on
   * and nothing pending yet.
   */
  draft: EditorDraft | null | undefined;
  /** The record is staged for removal (the item read's `pendingRemoval`): read only. */
  pendingRemoval: boolean;
  /** The values the save in flight sent: draft mode keeps what was typed since. */
  sent: Row | null;
  /** Autosave waits for the person (a conflict, a change gone under the form, a schedule). */
  held: boolean;
  /** Autosave waits for the next edit: the last automatic save was refused as it stood. */
  autoBlocked: boolean;
  /** The change was published or thrown away under the form; "Save again" makes a new one. */
  gone: DraftGone | null;
  /** Releases were switched off under the form (409 `releases-off`): it waits for a reload. */
  releasesOff: boolean;
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
      /** R12: an automatic save (autosave then waits for the next edit). */
      auto?: boolean | undefined;
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
  /**
   * Admin v2 R12: the pending change the form was on is gone, published or thrown away; the
   * server answered with the live row (or none). The values stay; the form is on live again.
   */
  | {
      type: 'draft-gone';
      code: DraftGone;
      live: Row | null;
      fields: readonly FieldDef[];
      versionFallback: number;
    }
  /** Admin v2 R12: a scheduled release holds the change: nothing can be saved over it. */
  | { type: 'scheduled' }
  /** Admin v2 R12: releases were switched off under the form; nothing was written. */
  | { type: 'releases-off' }
  /**
   * Admin v2 R12: the record read again after its pending change was settled elsewhere (the
   * publish dialog moved its version): the server's row, with what was typed since the last
   * save kept over it, so the next save names the change at its new version.
   */
  | { type: 'rebased'; row: Row; fields: readonly FieldDef[]; versionFallback: number }
  | { type: 'reset' }
  /**
   * Admin v2 U9: the row moved by ONE write this screen made itself on another column (the
   * General screen's job-applications switch on site_profile, which writes with no version
   * check): the form takes the row's new version and keeps its values, so its next save is
   * not a 409 against itself. Taken only when the form was at the version just before it
   * (the row moved by exactly one): otherwise a colleague's save sits in between, and the
   * form's next save, every field at its own version, must still be the 409 that protects it.
   */
  | { type: 'version'; version: number };

const NO_ERRORS = { byId: {}, summary: [] } as const;

/** The version a row without one is read as: a collection row is 1, a singleton's 0. */
export function versionFallback(target: SaveTarget): number {
  return target.kind === 'resource' ? 1 : 0;
}

const ENTITY_SEO_URL = '/api/admin/entity-seo';

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
    draft: undefined,
    pendingRemoval: false,
    sent: null,
    held: false,
    autoBlocked: false,
    gone: null,
    releasesOff: false,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The pending change a server row carries (Admin v2 R12): undefined when the row has no
 * `draft` key (the server saved it live), null when releases are on and nothing is pending.
 */
export function readDraft(row: Readonly<Row>): EditorDraft | null | undefined {
  if (!('draft' in row)) return undefined;
  const d = row['draft'];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const meta = d as Row;
  const id = str(meta['id']);
  const version = meta['version'];
  const op = meta['op'];
  if (!id || typeof version !== 'number') return null;
  if (op !== 'create' && op !== 'update' && op !== 'delete') return null;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    id,
    version,
    op,
    fields: list(meta['fields']),
    releaseId: str(meta['releaseId']),
    conflict: list(meta['conflict']),
    liveMissing: meta['liveMissing'] === true,
    invalid: meta['invalid'] === true,
  };
}

/** What a server row says of the release: its pending change, and a staged removal. */
function draftOf(row: Readonly<Row>): Pick<EntitySaveState, 'draft' | 'pendingRemoval'> {
  const draft = readDraft(row);
  return {
    draft,
    pendingRemoval:
      draft !== undefined && (row['pendingRemoval'] === true || draft?.op === 'delete'),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The content lifecycle's status select (as VisibilityField's isLifecycleStatus reads it). */
const isStatusSelect = (field: FieldDef) =>
  field.name === 'status' &&
  field.kind === 'select' &&
  (field.options ?? []).some((option) => option.value === 'published');

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
        ...draftOf(action.row),
        sent: null,
        held: false,
        autoBlocked: false,
        gone: null,
        releasesOff: false,
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
        // R12: an edit is a new attempt, so autosave may try again.
        autoBlocked: false,
      };
    case 'save-start':
      return {
        ...state,
        phase: 'saving',
        status: 'saving',
        message: null,
        errors: NO_ERRORS,
        sent: state.values,
        held: false,
        gone: null,
        releasesOff: false,
      };
    case 'saved': {
      const fromServer = rowToForm(action.row, action.fields);
      const pending = draftOf(action.row);
      // Draft mode: what was typed while this save was on its way stays on screen (and still
      // to save); everything else takes the server's answer. Live mode re-seeds as it did.
      let values = fromServer;
      let typedSince = false;
      if (pending.draft !== undefined && state.sent) {
        const sent = state.sent;
        values = { ...fromServer };
        for (const key of Object.keys(state.values)) {
          if (!same(state.values[key], sent[key])) {
            values[key] = state.values[key];
            typedSince = true;
          }
        }
      }
      return {
        ...state,
        values,
        initial: fromServer,
        version: Number(action.row['version'] ?? state.version + 1),
        phase: 'ready',
        status: typedSince ? 'dirty' : 'saved',
        savedAt: action.at,
        errors: NO_ERRORS,
        conflict: false,
        message: null,
        edgeMissed: action.row['kvSynced'] === false,
        ...pending,
        sent: null,
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
        sent: null,
        autoBlocked: action.auto === true,
      };
    case 'conflict':
      // The editor's values are kept: "Reload their version" is a choice, not a reset.
      return {
        ...state,
        phase: 'ready',
        status: 'error',
        conflict: true,
        message: null,
        sent: null,
        held: true,
      };
    case 'draft-gone': {
      // The values stay (they are the person's work); the form is on live again, so the next
      // save is a new pending change over the live version ("Save again").
      const initial = action.live ? rowToForm(action.live, action.fields) : state.initial;
      return {
        ...state,
        initial,
        version: action.live
          ? Number(action.live['version'] ?? action.versionFallback)
          : state.version,
        phase: 'ready',
        status: 'error',
        errors: NO_ERRORS,
        message: null,
        conflict: false,
        draft: state.draft === undefined ? undefined : null,
        pendingRemoval: false,
        sent: null,
        held: true,
        gone: action.code,
      };
    }
    case 'scheduled':
      return {
        ...state,
        phase: 'ready',
        status: 'error',
        message: SCHEDULED_WORDS,
        sent: null,
        held: true,
      };
    case 'rebased': {
      // Only between saves: the hook waits for a save on its way before it reads again.
      if (state.phase !== 'ready') return state;
      const fromServer = rowToForm(action.row, action.fields);
      const values = { ...fromServer };
      let typedSince = false;
      for (const key of Object.keys(state.values)) {
        if (!same(state.values[key], state.initial[key])) {
          values[key] = state.values[key];
          typedSince = true;
        }
      }
      return {
        ...state,
        values,
        initial: fromServer,
        version: Number(action.row['version'] ?? action.versionFallback),
        status: typedSince ? 'dirty' : 'idle',
        errors: NO_ERRORS,
        conflict: false,
        message: null,
        ...draftOf(action.row),
        sent: null,
        held: false,
        autoBlocked: false,
        gone: null,
        releasesOff: false,
      };
    }
    case 'releases-off':
      // The values stay on screen; nothing was written. Autosave stops until a reload, which
      // reads the record live (no `draft` key) and leaves release mode.
      return {
        ...state,
        phase: 'ready',
        status: 'error',
        errors: NO_ERRORS,
        message: RELEASES_OFF_WORDS,
        conflict: false,
        sent: null,
        held: true,
        releasesOff: true,
      };
    case 'version':
      return Number.isInteger(action.version) && action.version === state.version + 1
        ? { ...state, version: action.version }
        : state;
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

/** What a change a scheduled release holds says (R12). */
export const SCHEDULED_WORDS =
  'This change is scheduled to go live, so it cannot be edited now. Unschedule it to change it.';

/** What a form left open across the switch-off says (R12): nothing was saved; reload. */
export const RELEASES_OFF_WORDS =
  'Publishing was switched off while you were editing, so this was not saved. Reload to edit the live site.';

/**
 * The body key that says a save was made in release mode (R12): the server's STAGED_MARKER
 * (src/lib/release/releasesOff.ts), held equal by tests/lib/entitySave.spec.ts. The staged path
 * ignores it; with releases off the live path refuses the save.
 */
export const STAGED_KEY = 'staged';

/** The words for a pending change gone under the form (R12). */
export const DRAFT_GONE_WORDS: Readonly<Record<DraftGone, string>> = {
  'draft-published':
    'This change was published while you were editing. Your edits are still here: save again to make them a new unpublished change.',
  'draft-discarded':
    'This change was thrown away while you were editing. Your edits are still here: save again to keep them.',
};

/** True while the values differ from what was loaded or last saved. */
export function isDirty(state: EntitySaveState): boolean {
  if (state.phase === 'loading' || state.phase === 'load-failed') return false;
  return JSON.stringify(state.values) !== JSON.stringify(state.initial);
}

/**
 * Whether an automatic save (a blur, a tab switch, the page editor's idle timer) should run
 * now (Admin v2 R12, P-5): `save`, `later` (one is on its way: run again once it lands) or
 * `no`. Never in live mode (releases off: P-5's explicit Save), never for a new record, a
 * staged removal, a scheduled change, after a conflict or a change gone under the form
 * (`held`, until the person acts), or after a refused automatic save until the next edit.
 */
export function autosaveDecision(
  state: EntitySaveState,
  isNew: boolean,
  inFlight: boolean,
): 'save' | 'later' | 'no' {
  if (state.draft === undefined || isNew) return 'no';
  if (state.held || state.autoBlocked || state.pendingRemoval || state.draft?.releaseId) {
    return 'no';
  }
  if (inFlight) return 'later';
  if (state.phase !== 'ready' || !isDirty(state)) return 'no';
  return 'save';
}

/** Where an editor reads its row from. */
export function loadUrl(target: SaveTarget, id: string | null): string {
  if (target.kind === 'singleton') return target.endpoint;
  if (target.kind === 'entitySeo') {
    const query = new URLSearchParams({
      entityType: target.entityType,
      entityId: target.entityId,
    });
    return `${ENTITY_SEO_URL}?${query.toString()}`;
  }
  return `/api/admin/${target.slug}/${id ?? ''}`;
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
): { url: string; method: 'POST' | 'PATCH' | 'PUT'; body: Row } {
  const body = formToPayload(state.values, fields);
  // R12: in release mode the lifecycle status is the "Visible on the site" switch
  // (VisibilityField), which shows a stored `scheduled` as off, and an item is never scheduled
  // on its own (a release is: "Schedule the release instead", R3a). A `scheduled` the form
  // still holds is one with no time, which switching releases on leaves as it is (R11), so it
  // is sent as what the switch shows, `draft`, not as a status every staged save refuses.
  if (state.draft !== undefined && body['status'] === 'scheduled' && fields.some(isStatusSelect)) {
    body['status'] = 'draft';
  }
  // R12: a save on a pending change names it, at the version the form holds (R3a), and every
  // save in draft mode says it was made there (STAGED_KEY), nothing pending yet included, so
  // the live path refuses it once releases are off. Only in draft mode: with releases off the
  // request is exactly what it always was.
  const ref =
    state.draft === undefined
      ? {}
      : {
          [STAGED_KEY]: true,
          ...(state.draft ? { draftId: state.draft.id, draftVersion: state.draft.version } : {}),
        };
  if (target.kind === 'entitySeo') {
    // A full replace: every field the form holds, the target, and the version it loaded.
    return {
      url: ENTITY_SEO_URL,
      method: 'PUT',
      body: {
        ...body,
        entityType: target.entityType,
        entityId: target.entityId,
        version: state.version,
        ...ref,
      },
    };
  }
  if (target.kind === 'resource' && id === null) {
    // R12b: a create from a screen in release mode says so in its address; otherwise the
    // request is exactly what it always was.
    return {
      url: stagedUrl(`/api/admin/${target.slug}`, target.staged === true),
      method: 'POST',
      body,
    };
  }
  // The datetime input shows minutes: an untouched one keeps the stored instant's seconds.
  for (const field of fields) {
    if (field.kind === 'datetime' && state.values[field.name] === state.initial[field.name]) {
      delete body[field.name];
    }
  }
  const url =
    target.kind === 'resource' && target.saveUrl && id !== null
      ? target.saveUrl(id)
      : loadUrl(target, id);
  return { url, method: 'PATCH', body: { ...body, version: state.version, ...ref } };
}

/** Where a created record opens: its edit screen, saying so when the edge missed it. */
export function createdHref(slug: string, row: Row): string {
  const missed = row['kvSynced'] === false ? '?edge=missed' : '';
  return `/admin/${slug}/${String(row['id'])}${missed}`;
}
