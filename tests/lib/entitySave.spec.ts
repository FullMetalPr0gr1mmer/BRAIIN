import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  autosaveDecision,
  buildSaveRequest,
  createdHref,
  DRAFT_GONE_WORDS,
  entitySaveReducer,
  initialSaveState,
  isDirty,
  loadUrl,
  readDraft,
  RELEASES_OFF_WORDS,
  SCHEDULED_WORDS,
  STAGED_KEY,
  versionFallback,
  type EntitySaveAction,
  type EntitySaveState,
  type SaveTarget,
} from '@/lib/admin/entitySave';
import { saveModeFor } from '@/lib/admin/saveMode';
import type { FieldDef } from '@/lib/admin/uiSchema';

// The editor's save as a state machine (Admin v2 F5a). ResourceForm and SingletonForm both
// run on it through useEntitySave; these are the rules they carried on their own before:
// the version and its 409, the untouched datetime, the singleton's first save at version 0,
// the re-seed from the server's row, `kvSynced`.

const FIELDS: FieldDef[] = [
  { name: 'slug', label: 'Slug', kind: 'slug', required: true },
  { name: 'title', label: 'Title', kind: 'bilingual', required: true },
  { name: 'visible', label: 'Visible', kind: 'checkbox', defaultValue: true },
  { name: 'scheduledFor', label: 'Scheduled for', kind: 'datetime' },
];
const SERVICES: SaveTarget = { kind: 'resource', slug: 'services' };
const SEO: SaveTarget = { kind: 'singleton', endpoint: '/api/admin/seo-defaults' };

const run = (state: EntitySaveState, ...actions: EntitySaveAction[]) =>
  actions.reduce(entitySaveReducer, state);

const ROW = {
  id: 'r1',
  slug: 'logo',
  title: { en: 'Logo', ar: 'الشعار' },
  visible: false,
  scheduled_for: '2026-10-01T09:30:15.250Z',
  version: 4,
};

const loaded = (row: Record<string, unknown> = ROW, target: SaveTarget = SERVICES) =>
  run(initialSaveState(FIELDS, false), {
    type: 'loaded',
    row,
    fields: FIELDS,
    versionFallback: versionFallback(target),
  });

describe('loading', () => {
  it('a new record starts ready from its defaults; an existing one starts loading', () => {
    const fresh = initialSaveState(FIELDS, true, { slug: 'new' });
    expect(fresh.phase).toBe('ready');
    expect(fresh.values).toEqual({ visible: true, slug: 'new' });
    expect(isDirty(fresh)).toBe(false);
    expect(initialSaveState(FIELDS, false).phase).toBe('loading');
  });

  it('a loaded row becomes the form, its version remembered', () => {
    const state = loaded();
    expect(state.phase).toBe('ready');
    expect(state.version).toBe(4);
    expect(state.values['title']).toEqual({ en: 'Logo', ar: 'الشعار' });
    expect(state.status).toBe('idle');
  });

  it('a row without a version: a collection row is 1, a singleton never saved is 0', () => {
    const { version: _v, ...noVersion } = ROW;
    expect(loaded(noVersion).version).toBe(1);
    expect(loaded({}, SEO).version).toBe(0);
  });

  it('a failed load says why', () => {
    const state = run(initialSaveState(FIELDS, false), { type: 'load-failed', message: 'Gone' });
    expect(state.phase).toBe('load-failed');
    expect(state.message).toBe('Gone');
    expect(isDirty(state)).toBe(false);
  });
});

describe('editing and saving', () => {
  it('an edit marks the form dirty and clears an old edge warning', () => {
    const saved = run(loaded(), {
      type: 'saved',
      row: { ...ROW, version: 5, kvSynced: false },
      fields: FIELDS,
      at: '2026-10-12T11:05:00Z',
    });
    expect(saved.edgeMissed).toBe(true);
    const edited = run(saved, { type: 'set', name: 'slug', value: 'logos' });
    expect(edited.status).toBe('dirty');
    expect(isDirty(edited)).toBe(true);
    expect(edited.edgeMissed).toBe(false);
  });

  it('a save re-seeds from the SERVER’s row and takes its version', () => {
    const state = run(
      loaded(),
      { type: 'set', name: 'slug', value: 'logos' },
      { type: 'save-start' },
    );
    expect(state.status).toBe('saving');
    expect(state.phase).toBe('saving');
    const done = run(state, {
      type: 'saved',
      row: { ...ROW, slug: 'logos', title: { en: 'Logos', ar: 'الشعارات' }, version: 5 },
      fields: FIELDS,
      at: '2026-10-12T11:05:00Z',
    });
    expect(done.version).toBe(5);
    expect(done.values['title']).toEqual({ en: 'Logos', ar: 'الشعارات' });
    expect(done.initial).toEqual(done.values);
    expect(done.status).toBe('saved');
    expect(done.savedAt).toBe('2026-10-12T11:05:00Z');
    expect(isDirty(done)).toBe(false);
  });

  it('a server row without a version bumps the one sent', () => {
    const { version: _v, ...noVersion } = ROW;
    const done = run(loaded(), { type: 'saved', row: noVersion, fields: FIELDS, at: 'x' });
    expect(done.version).toBe(5);
  });

  it('a 409 keeps the editor’s values and raises the conflict', () => {
    const state = run(
      loaded(),
      { type: 'set', name: 'slug', value: 'mine' },
      { type: 'save-start' },
      { type: 'conflict' },
    );
    expect(state.conflict).toBe(true);
    expect(state.status).toBe('error');
    expect(state.values['slug']).toBe('mine');
    // "Reload their version" loads the row again: the conflict is gone, theirs is shown.
    const theirs = run(state, {
      type: 'loaded',
      row: { ...ROW, slug: 'theirs', version: 6 },
      fields: FIELDS,
      versionFallback: 1,
    });
    expect(theirs.conflict).toBe(false);
    expect(theirs.values['slug']).toBe('theirs');
    expect(theirs.version).toBe(6);
  });

  it('a 422 maps its errors and says "Not saved"', () => {
    const errors = {
      byId: { 'f-title-ar': 'Required' },
      summary: [{ id: 'f-title-ar', message: 'Title (Arabic): Required' }],
    };
    const state = run(
      loaded(),
      { type: 'save-start' },
      { type: 'save-failed', message: null, errors },
    );
    expect(state.status).toBe('error');
    expect(state.errors).toEqual(errors);
    // The next attempt starts clean.
    expect(run(state, { type: 'save-start' }).errors.summary).toEqual([]);
  });

  it('reset puts the loaded values back', () => {
    const state = run(loaded(), { type: 'set', name: 'slug', value: 'x' }, { type: 'reset' });
    expect(state.values).toEqual(state.initial);
    expect(state.status).toBe('idle');
  });
});

describe('the request a save sends', () => {
  const previous = process.env['TZ'];
  beforeAll(() => {
    process.env['TZ'] = 'Asia/Riyadh';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  });

  it('creates with a POST and no version', () => {
    const state = run(initialSaveState(FIELDS, true), { type: 'set', name: 'slug', value: 'new' });
    const req = buildSaveRequest(SERVICES, null, state, FIELDS);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/admin/services');
    expect(req.body).toEqual({ slug: 'new', visible: true });
  });

  it('a PATCH carries the version, and leaves an untouched datetime out', () => {
    const state = run(loaded(), { type: 'set', name: 'slug', value: 'logos' });
    const req = buildSaveRequest(SERVICES, 'r1', state, FIELDS);
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('/api/admin/services/r1');
    expect(req.body['version']).toBe(4);
    expect(req.body).not.toHaveProperty('scheduledFor');
    // Touched, it is sent (at minute precision, which is what the editor chose).
    const touched = run(state, { type: 'set', name: 'scheduledFor', value: '2026-10-02T12:30' });
    expect(buildSaveRequest(SERVICES, 'r1', touched, FIELDS).body['scheduledFor']).toBe(
      '2026-10-02T09:30:00.000Z',
    );
  });

  it('a singleton never saved sends version 0 (the kernel creates the row)', () => {
    const state = run(loaded({ title: { en: '', ar: '' } }, SEO), {
      type: 'set',
      name: 'slug',
      value: 'x',
    });
    const req = buildSaveRequest(SEO, null, state, FIELDS);
    expect(req).toMatchObject({ url: '/api/admin/seo-defaults', method: 'PATCH' });
    expect(req.body['version']).toBe(0);
  });

  it('saveUrl (Admin v2 U4) moves the PATCH only: the load and a create stay where they were', () => {
    const MEDIA: SaveTarget = {
      kind: 'resource',
      slug: 'media',
      saveUrl: (id) => `/api/admin/media/meta/${id}`,
    };
    const state = run(loaded(ROW, MEDIA), { type: 'set', name: 'slug', value: 'x' });
    const patch = buildSaveRequest(MEDIA, 'r1', state, FIELDS);
    expect(patch).toMatchObject({ url: '/api/admin/media/meta/r1', method: 'PATCH' });
    expect(patch.body['version']).toBe(4);
    expect(loadUrl(MEDIA, 'r1')).toBe('/api/admin/media/r1');
    const fresh = run(initialSaveState(FIELDS, true), { type: 'set', name: 'slug', value: 'n' });
    expect(buildSaveRequest(MEDIA, null, fresh, FIELDS)).toMatchObject({
      url: '/api/admin/media',
      method: 'POST',
    });
    // Without it, unchanged (F5a's frozen API).
    expect(buildSaveRequest(SERVICES, 'r1', state, FIELDS).url).toBe('/api/admin/services/r1');
  });

  it('a value that cannot be sent throws with its field’s name', () => {
    const json: FieldDef[] = [{ name: 'meta', label: 'Meta', kind: 'json' }];
    const state = run(initialSaveState(json, true), { type: 'set', name: 'meta', value: '{' });
    expect(() => buildSaveRequest(SERVICES, null, state, json)).toThrow('Meta is not valid JSON.');
  });

  it('where it loads from, and where a created record opens', () => {
    expect(loadUrl(SERVICES, 'r1')).toBe('/api/admin/services/r1');
    expect(loadUrl(SEO, null)).toBe('/api/admin/seo-defaults');
    expect(createdHref('redirects', { id: 'n1', kvSynced: true })).toBe('/admin/redirects/n1');
    expect(createdHref('redirects', { id: 'n1', kvSynced: false })).toBe(
      '/admin/redirects/n1?edge=missed',
    );
  });
});

describe('the save mode', () => {
  it('is live for every editor until releases switch on', () => {
    expect(saveModeFor(SERVICES)).toBe('live');
    expect(saveModeFor(SEO)).toBe('live');
    expect(saveModeFor(PAGE_SEO)).toBe('live');
  });
});

// Admin v2 U10: a page's SEO row, keyed by its target.
const PAGE_SEO: SaveTarget = {
  kind: 'entitySeo',
  entityType: 'service',
  entityId: '11111111-1111-4111-8111-111111111111',
};

describe('the entity-SEO target (U10)', () => {
  const SEO_FIELDS: FieldDef[] = [
    { name: 'metaTitle', label: 'Title', kind: 'bilingual', column: 'meta_title' },
    { name: 'robots', label: 'Index', kind: 'text' },
  ];

  it('loads by its target', () => {
    expect(loadUrl(PAGE_SEO, null)).toBe(
      '/api/admin/entity-seo?entityType=service&entityId=11111111-1111-4111-8111-111111111111',
    );
    expect(loadUrl(PAGE_SEO, 'ignored')).toBe(loadUrl(PAGE_SEO, null));
  });

  it('reads a row without a version as 0 (no SEO row yet), as a singleton', () => {
    expect(versionFallback(PAGE_SEO)).toBe(0);
  });

  it('saves with a PUT of the whole meta, the target and the version it loaded', () => {
    const state = run(initialSaveState(SEO_FIELDS, false), {
      type: 'loaded',
      row: { meta_title: { en: 'T', ar: 'ت' }, robots: null, version: 3 },
      fields: SEO_FIELDS,
      versionFallback: versionFallback(PAGE_SEO),
    });
    const req = buildSaveRequest(PAGE_SEO, null, state, SEO_FIELDS);
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('/api/admin/entity-seo');
    expect(req.body).toMatchObject({
      metaTitle: { en: 'T', ar: 'ت' },
      entityType: 'service',
      entityId: '11111111-1111-4111-8111-111111111111',
      version: 3,
    });
  });

  it('a first save sends version 0', () => {
    const state = run(initialSaveState(SEO_FIELDS, false), {
      type: 'loaded',
      row: { meta_title: {}, robots: null, version: 0, id: null },
      fields: SEO_FIELDS,
      versionFallback: versionFallback(PAGE_SEO),
    });
    expect(buildSaveRequest(PAGE_SEO, null, state, SEO_FIELDS).body['version']).toBe(0);
  });
});

describe('a create (review H1: no "Leave site?" on the way to the new record)', () => {
  it('marks the form clean, and keeps Save off while the edit screen loads', () => {
    const typed = run(
      initialSaveState(FIELDS, true),
      { type: 'set', name: 'slug', value: 'new' },
      { type: 'set', name: 'title', value: { en: 'New', ar: 'جديد' } },
      { type: 'save-start' },
    );
    expect(isDirty(typed)).toBe(true);
    const created = run(typed, { type: 'created', at: 'x', navigating: true });
    expect(isDirty(created)).toBe(false);
    expect(created.phase).toBe('saving');
    expect(created.status).toBe('saved');
    // A screen that stays (onCreated) gets a ready, clean form back.
    const stays = run(typed, { type: 'created', at: 'x', navigating: false });
    expect(stays.phase).toBe('ready');
    expect(isDirty(stays)).toBe(false);
  });
});

describe('a failed "Reload their version" (review L10)', () => {
  it('keeps the editor’s values and the conflict, and says why', () => {
    const state = run(
      loaded(),
      { type: 'set', name: 'slug', value: 'mine' },
      { type: 'save-start' },
      { type: 'conflict' },
      { type: 'save-failed', message: 'Their version could not be loaded: offline' },
    );
    expect(state.phase).toBe('ready');
    expect(state.values['slug']).toBe('mine');
    expect(state.conflict).toBe(true);
    expect(state.message).toMatch(/^Their version could not be loaded/);
  });
});

// Admin v2 R12: draft mode. The server says which mode a record is in: a release-managed
// route with releases on answers its row with a `draft` key (null when nothing is pending,
// R3a's DraftMeta otherwise), and never does with releases off.
const DRAFT = {
  id: '77777777-7777-4777-8777-000000000001',
  version: 3,
  op: 'update',
  fields: ['slug'],
  updatedBy: null,
  updatedAt: '2026-10-23T08:00:00Z',
  releaseId: null,
};
const STAGED = { ...ROW, slug: 'logo-new', draft: DRAFT };

describe('draft mode (Admin v2 R12)', () => {
  it('follows the server: no `draft` key is live mode, request for request', () => {
    const live = run(loaded(), { type: 'set', name: 'slug', value: 'logos' });
    expect(live.draft).toBeUndefined();
    const req = buildSaveRequest(SERVICES, 'r1', live, FIELDS);
    expect(req.body).not.toHaveProperty('draftId');
    expect(req.body).not.toHaveProperty('draftVersion');
    expect(req.body).not.toHaveProperty(STAGED_KEY);
    expect(Object.keys(req.body).sort()).toEqual(['slug', 'title', 'version', 'visible']);
    expect(readDraft(ROW)).toBeUndefined();
    // Every R12 member stays at its live-mode value.
    expect(live).toMatchObject({
      pendingRemoval: false,
      held: false,
      autoBlocked: false,
      gone: null,
    });
  });

  it('a save on a pending change names it at the version the form holds', () => {
    const state = run(loaded(STAGED), { type: 'set', name: 'slug', value: 'logo-newer' });
    expect(state.draft).toMatchObject({ id: DRAFT.id, version: 3, op: 'update' });
    const req = buildSaveRequest(SERVICES, 'r1', state, FIELDS);
    expect(req.body).toMatchObject({
      version: 4,
      draftId: DRAFT.id,
      draftVersion: 3,
      [STAGED_KEY]: true,
    });
    // Entity SEO's full replace names it too.
    const seo = run(loaded(STAGED, PAGE_SEO), { type: 'set', name: 'slug', value: 'x' });
    expect(buildSaveRequest(PAGE_SEO, null, seo, FIELDS).body).toMatchObject({
      draftId: DRAFT.id,
      draftVersion: 3,
      [STAGED_KEY]: true,
    });
  });

  it('releases on with nothing pending (draft: null) sends the live version and the release-mode marker', () => {
    const state = run(loaded({ ...ROW, draft: null }), { type: 'set', name: 'slug', value: 'x' });
    expect(state.draft).toBeNull();
    const body = buildSaveRequest(SERVICES, 'r1', state, FIELDS).body;
    expect(body['version']).toBe(4);
    expect(body).not.toHaveProperty('draftId');
    // The marker: with releases switched off since, the live path refuses this save (review).
    expect(body[STAGED_KEY]).toBe(true);
    // A singleton's save says so too.
    const single = run(loaded({ ...ROW, draft: null }, SEO), {
      type: 'set',
      name: 'slug',
      value: 'x',
    });
    expect(buildSaveRequest(SEO, null, single, FIELDS).body[STAGED_KEY]).toBe(true);
  });

  it('a stored scheduled status with no time is sent as the switch shows it (off: draft)', () => {
    const lifecycle: FieldDef[] = [
      ...FIELDS,
      {
        name: 'status',
        label: 'Status',
        kind: 'select',
        options: ['draft', 'scheduled', 'published', 'archived'].map((value) => ({
          value,
          label: value,
        })),
      },
    ];
    const untimed = { ...ROW, scheduled_for: null, status: 'scheduled' };
    const load = (row: Record<string, unknown>) =>
      run(
        initialSaveState(lifecycle, false),
        { type: 'loaded', row, fields: lifecycle, versionFallback: 1 },
        { type: 'set', name: 'slug', value: 'logos' },
      );
    // Release mode: the switch reads off, so the save says draft, never a refused `scheduled`.
    const staged = buildSaveRequest(SERVICES, 'r1', load({ ...untimed, draft: null }), lifecycle);
    expect(staged.body['status']).toBe('draft');
    // A status the switch set goes as it is.
    const on = run(load({ ...untimed, draft: null }), {
      type: 'set',
      name: 'status',
      value: 'published',
    });
    expect(buildSaveRequest(SERVICES, 'r1', on, lifecycle).body['status']).toBe('published');
    // Live mode (releases off) keeps the select's value, request for request.
    expect(buildSaveRequest(SERVICES, 'r1', load(untimed), lifecycle).body['status']).toBe(
      'scheduled',
    );
  });

  it('read again after a settle elsewhere: the server’s row and change, what was typed kept', () => {
    const typed = run(
      loaded({ ...STAGED, draft: { ...DRAFT, conflict: ['title'] } }),
      { type: 'set', name: 'slug', value: 'typed' },
      { type: 'conflict' },
    );
    const settledRow = {
      ...STAGED,
      title: { en: 'Settled', ar: 'تمت' },
      draft: { ...DRAFT, version: 4, conflict: [] },
    };
    const again = run(typed, {
      type: 'rebased',
      row: settledRow,
      fields: FIELDS,
      versionFallback: 1,
    });
    expect(again.values['slug']).toBe('typed');
    expect(again.values['title']).toEqual({ en: 'Settled', ar: 'تمت' });
    expect(again.initial['slug']).toBe('logo-new');
    expect(again.draft).toMatchObject({ version: 4, conflict: [] });
    expect(again).toMatchObject({ status: 'dirty', conflict: false, held: false });
    expect(buildSaveRequest(SERVICES, 'r1', again, FIELDS).body).toMatchObject({
      slug: 'typed',
      draftVersion: 4,
    });
    // Nothing typed: clean on the new version.
    const clean = run(loaded(STAGED), {
      type: 'rebased',
      row: settledRow,
      fields: FIELDS,
      versionFallback: 1,
    });
    expect(clean).toMatchObject({ status: 'idle' });
    expect(isDirty(clean)).toBe(false);
    // A save on its way is left alone: the hook reads again once it has landed.
    const saving = run(typed, { type: 'save-start' });
    expect(
      run(saving, { type: 'rebased', row: settledRow, fields: FIELDS, versionFallback: 1 }),
    ).toBe(saving);
  });

  it('releases switched off under the form: held with words, until a reload reads it live', () => {
    const refused = run(
      loaded(STAGED),
      { type: 'set', name: 'slug', value: 'typed' },
      { type: 'save-start' },
      { type: 'releases-off' },
    );
    expect(refused).toMatchObject({
      held: true,
      releasesOff: true,
      status: 'error',
      message: RELEASES_OFF_WORDS,
      conflict: false,
    });
    // The person's values stay on screen; autosave stops.
    expect(refused.values['slug']).toBe('typed');
    expect(autosaveDecision(refused, false, false)).toBe('no');
    expect(
      autosaveDecision(run(refused, { type: 'set', name: 'slug', value: 'more' }), false, false),
    ).toBe('no');
    // Reload: the live answer (no `draft` key) puts the form in live mode.
    const reloaded = run(refused, { type: 'loaded', row: ROW, fields: FIELDS, versionFallback: 1 });
    expect(reloaded).toMatchObject({ releasesOff: false, held: false, draft: undefined });
    expect(buildSaveRequest(SERVICES, 'r1', reloaded, FIELDS).body).not.toHaveProperty(STAGED_KEY);
    expect(RELEASES_OFF_WORDS).not.toMatch(/[–—]/);
  });

  it('a pending create (no live version) sends version 0 and the change', () => {
    const create = { ...ROW, version: 0, draft: { ...DRAFT, op: 'create', version: 1 } };
    const state = run(loaded(create), { type: 'set', name: 'slug', value: 'x' });
    expect(buildSaveRequest(SERVICES, 'r1', state, FIELDS).body).toMatchObject({
      version: 0,
      draftVersion: 1,
    });
  });

  it('what was typed while a save was on its way stays; live mode re-seeds as before', () => {
    const typed = run(
      loaded(STAGED),
      { type: 'set', name: 'slug', value: 'sent' },
      { type: 'save-start' },
      { type: 'set', name: 'title', value: { en: 'Typed since', ar: 'كتب' } },
    );
    const answer = { ...STAGED, slug: 'sent', draft: { ...DRAFT, version: 4 } };
    const done = run(typed, { type: 'saved', row: answer, fields: FIELDS, at: 'now' });
    expect(done.values['slug']).toBe('sent');
    expect(done.values['title']).toEqual({ en: 'Typed since', ar: 'كتب' });
    expect(done.initial['title']).toEqual(ROW.title);
    expect([done.status, isDirty(done), done.draft?.version]).toEqual(['dirty', true, 4]);
    // Live mode: the server's row, as F5a built it.
    const liveTyped = run(
      loaded(),
      { type: 'set', name: 'slug', value: 'sent' },
      { type: 'save-start' },
      { type: 'set', name: 'title', value: { en: 'Typed since', ar: 'كتب' } },
    );
    const liveDone = run(liveTyped, {
      type: 'saved',
      row: { ...ROW, slug: 'sent', version: 5 },
      fields: FIELDS,
      at: 'now',
    });
    expect(liveDone.values['title']).toEqual(ROW.title);
    expect(liveDone.status).toBe('saved');
  });

  it('a change published or thrown away under the form: the edits stay, on live again', () => {
    const state = run(
      loaded(STAGED),
      { type: 'set', name: 'slug', value: 'mine' },
      { type: 'save-start' },
      {
        type: 'draft-gone',
        code: 'draft-published',
        live: { ...ROW, slug: 'logo-new', version: 5 },
        fields: FIELDS,
        versionFallback: 1,
      },
    );
    expect(state).toMatchObject({ gone: 'draft-published', held: true, draft: null, version: 5 });
    expect(state.values['slug']).toBe('mine');
    expect(state.initial['slug']).toBe('logo-new');
    // "Save again": a new pending change over the live version, naming no old change.
    const body = buildSaveRequest(SERVICES, 'r1', state, FIELDS).body;
    expect(body).toMatchObject({ slug: 'mine', version: 5 });
    expect(body).not.toHaveProperty('draftId');
    // An explicit save clears the hold and the notice.
    expect(run(state, { type: 'save-start' })).toMatchObject({ held: false, gone: null });
  });

  it('a scheduled change is held with words; a staged removal is read from the row', () => {
    const held = run(loaded(STAGED), { type: 'scheduled' });
    expect(held).toMatchObject({ held: true, message: SCHEDULED_WORDS });
    const removal = loaded({ ...ROW, pendingRemoval: true, draft: { ...DRAFT, op: 'delete' } });
    expect(removal.pendingRemoval).toBe(true);
    // Live mode never reads `pendingRemoval`: no live row carries it.
    expect(loaded({ ...ROW, pendingRemoval: true }).pendingRemoval).toBe(false);
    expect(DRAFT_GONE_WORDS['draft-discarded']).not.toMatch(/[\u2013\u2014]/);
  });

  it('reads the change’s conflict and a row gone under it', () => {
    const conflict = loaded({ ...STAGED, draft: { ...DRAFT, conflict: ['title'] } });
    expect(conflict.draft?.conflict).toEqual(['title']);
    const gone = loaded({ id: 'r1', version: null, draft: { ...DRAFT, liveMissing: true } });
    expect(gone.draft?.liveMissing).toBe(true);
  });
});

describe('autosave (Admin v2 R12, P-5)', () => {
  const edited = (row: Record<string, unknown> = STAGED) =>
    run(loaded(row), { type: 'set', name: 'slug', value: 'typed' });

  it('saves an unsaved pending change; never in live mode, never a new record', () => {
    expect(autosaveDecision(edited(), false, false)).toBe('save');
    expect(autosaveDecision(edited(ROW), false, false)).toBe('no');
    expect(autosaveDecision(edited(), true, false)).toBe('no');
    // Nothing typed: nothing to save.
    expect(autosaveDecision(loaded(STAGED), false, false)).toBe('no');
  });

  it('waits for a save on its way, and runs again once it lands', () => {
    expect(autosaveDecision(edited(), false, true)).toBe('later');
  });

  it('waits for the person after a conflict, a gone change or a schedule; for an edit after a refusal', () => {
    expect(autosaveDecision(run(edited(), { type: 'conflict' }), false, false)).toBe('no');
    expect(autosaveDecision(run(edited(), { type: 'scheduled' }), false, false)).toBe('no');
    const scheduled = edited({ ...STAGED, draft: { ...DRAFT, releaseId: DRAFT.id } });
    expect(autosaveDecision(scheduled, false, false)).toBe('no');
    const refused = run(
      edited(),
      { type: 'save-start' },
      { type: 'save-failed', message: 'x', auto: true },
    );
    expect(autosaveDecision(refused, false, false)).toBe('no');
    // The next edit is a new attempt.
    const retyped = run(refused, { type: 'set', name: 'slug', value: 'fixed' });
    expect(autosaveDecision(retyped, false, false)).toBe('save');
    // An explicit save that failed does not block the automatic ones.
    const explicit = run(edited(), { type: 'save-start' }, { type: 'save-failed', message: 'x' });
    expect(autosaveDecision(explicit, false, false)).toBe('save');
    // A staged removal is read only.
    const removal = edited({ ...ROW, pendingRemoval: true, draft: { ...DRAFT, op: 'delete' } });
    expect(autosaveDecision(removal, false, false)).toBe('no');
  });
});

describe('the hook in live mode (F5a, unchanged by R12)', () => {
  it('renders a new record as before; asking for draft mode no longer throws', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { useEntitySave } = await import('@/lib/admin/useEntitySave');
    function Live() {
      const save = useEntitySave(SERVICES, null, { fields: FIELDS, mode: 'live' });
      return createElement('p', null, `${save.isNew ? 'new' : 'old'} ${save.mode}`);
    }
    expect(renderToStaticMarkup(createElement(Live))).toBe('<p>new live</p>');
    function Draft() {
      const save = useEntitySave(SERVICES, 'r1', { fields: FIELDS, mode: 'draft' });
      return createElement('p', null, `${save.draft === null ? 'none' : 'some'}`);
    }
    expect(renderToStaticMarkup(createElement(Draft))).toBe('<p>none</p>');
  });

  // R12 pre-merge review: the publish dialog's settle (`admin:draft-settled`, checked in
  // releaseUi.spec) reaches an open editor only through this subscription. Effects do not run
  // in a server render, so its wiring is read from the source: listening for its own change
  // only, reading the record again ('rebased', checked above), after a save on its way.
  it('listens for a settle of its own pending change and reads the record again', async () => {
    const { readFileSync } = await import('node:fs');
    const hook = readFileSync('src/lib/admin/useEntitySave.ts', 'utf8');
    expect(hook).toMatch(
      /return onSettled\(\(settled\) => \{\s*if \(settled !== draftId\) return;\s*if \(inFlight\.current \|\| latest\.current\.phase !== 'ready'\) rebaseNext\.current = true;\s*else void rebase\(\);/,
    );
    expect(hook).toMatch(/const rebase = useCallback\(async \(\) => \{[\s\S]*?type: 'rebased',/);
    expect(hook).toMatch(
      /if \(rebaseNext\.current\) \{\s*rebaseNext\.current = false;\s*void rebase\(\);/,
    );
  });
});

// Admin v2 R12b: a create from a screen in release mode (a collection's drawer, a list's
// modal, a case study added in a service's draft-mode editor) says so in its address, so the
// live POST refuses it once releases are switched off under the screen.
describe('a create made in release mode (R12b)', () => {
  const fresh = () =>
    run(initialSaveState(FIELDS, true), {
      type: 'set',
      name: 'title',
      value: { en: 'New', ar: 'جديد' },
    });

  it('carries the marker in its address, and nothing else changes', () => {
    const plain = buildSaveRequest(SERVICES, null, fresh(), FIELDS);
    const staged = buildSaveRequest({ ...SERVICES, staged: true }, null, fresh(), FIELDS);
    expect(plain.url).toBe('/api/admin/services');
    expect(staged.url).toBe('/api/admin/services?staged=1');
    expect(staged.method).toBe('POST');
    expect(staged.body).toEqual(plain.body);
    expect(staged.body).not.toHaveProperty(STAGED_KEY);
  });

  it('a screen read live (or no word either way) sends main’s create', () => {
    for (const target of [
      SERVICES,
      { ...SERVICES, staged: false },
      { ...SERVICES, staged: undefined },
    ]) {
      expect(buildSaveRequest(target, null, fresh(), FIELDS).url).toBe('/api/admin/services');
    }
  });

  it('the flag is for a create only: a saved record follows its own answer', () => {
    const live = buildSaveRequest({ ...SERVICES, staged: true }, 'r1', loaded(), FIELDS);
    expect(live.url).toBe('/api/admin/services/r1');
    expect(live.body).not.toHaveProperty(STAGED_KEY);
  });

  it('a refused create holds, and its Reload reads the screen again (there is no record)', async () => {
    const held = entitySaveReducer(fresh(), { type: 'releases-off' });
    expect(held).toMatchObject({ releasesOff: true, held: true, message: RELEASES_OFF_WORDS });
    const { readFileSync } = await import('node:fs');
    const hook = readFileSync('src/lib/admin/useEntitySave.ts', 'utf8');
    expect(hook).toMatch(
      /const reloadTheirs = useCallback\(async \(\) => \{\s*if \(isNew && latest\.current\.releasesOff\) \{[\s\S]*?leaving\.current = true;\s*window\.location\.reload\(\);\s*return;/,
    );
  });
});
