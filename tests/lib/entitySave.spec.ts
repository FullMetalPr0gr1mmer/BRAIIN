import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSaveRequest,
  createdHref,
  entitySaveReducer,
  initialSaveState,
  isDirty,
  loadUrl,
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
  });
});
