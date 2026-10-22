import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import {
  auditRowsOf,
  auditsOf,
  callRoute,
  draftRow,
  draftTouchesOf,
  liveWritesOf,
  makeDb,
  OTHER_USER,
} from '../fixtures/stagedRoute';

// The staged branch of the singleton kernel (Admin v2 R3b): the public identity and the global
// SEO defaults, driven through their real routes over the PostgREST stand-in. With releases on,
// a save is the tenant's pending change (keyed by the tenant), never a live write; the
// job-application switch is never staged (422 when a save would change it, ignored when it is
// sent unchanged), `guardWrite` still refuses a Developer opening applications, and the intake
// endpoint writes the switch at once, Admin only, releases on or off.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

type Routes = { GET: APIRoute; PATCH: APIRoute };
const profile = async () => (await import('@/pages/api/admin/site-profile')) as Routes;
const seo = async () => (await import('@/pages/api/admin/seo-defaults')) as Routes;
const intake = async () =>
  ((await import('@/pages/api/admin/site-profile/intake')) as { PATCH: APIRoute }).PATCH;

const BRAND = { en: 'Braiin', ar: 'برين' };
const NEW_BRAND = { en: 'Braiin Studio', ar: 'استوديو برين' };

const profileRow = (over: Row = {}): Row => ({
  tenant_id: T,
  brand_name: BRAND,
  legal_name: null,
  contact_email: 'hello@example.test',
  whatsapp_e164: null,
  whatsapp_display: null,
  location: { en: 'Jeddah', ar: 'جدة' },
  address_locality: null,
  address_country: 'SA',
  founded_year: 2019,
  socials: [],
  accepting_applications: false,
  version: 4,
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

let db: Db;
beforeEach(() => {
  resetIds();
  db = makeDb({ site_profile: [], seo_defaults: [] });
});

const drafts = () => db.tables['content_drafts']!;
const ref = (d: Row) => ({ draftId: d['id'], draftVersion: d['version'] });

// ── Reads ─────────────────────────────────────────────────────────────────────────────────

describe('GET with releases on', () => {
  it('no row and no change: the defaults at version 0, and no pending change', async () => {
    const res = await callRoute(db, (await profile()).GET, 'GET', '/api/admin/site-profile');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ version: 0, draft: null, accepting_applications: false });
  });

  it('a pending edit is laid over live; the switch is what live holds', async () => {
    db.tables['site_profile'] = [profileRow({ accepting_applications: true })];
    db.tables['content_drafts'] = [
      draftRow({
        payload: { brandName: NEW_BRAND },
        base: { brand_name: BRAND },
        base_version: 4,
        fields: ['brand_name'],
      }),
    ];
    const res = await callRoute(db, (await profile()).GET, 'GET', '/api/admin/site-profile');
    expect(res.data['brand_name']).toEqual(NEW_BRAND);
    expect(res.data['accepting_applications']).toBe(true);
    expect(res.data['version']).toBe(4);
    expect(res.data['draft']).toMatchObject({ op: 'update', version: 1, fields: ['brand_name'] });
  });

  it('a pending create is the defaults with the change over them, at version 0', async () => {
    db.tables['content_drafts'] = [
      draftRow({ op: 'create', payload: { brandName: NEW_BRAND }, base_version: null }),
    ];
    const res = await callRoute(db, (await profile()).GET, 'GET', '/api/admin/site-profile');
    expect(res.data).toMatchObject({
      brand_name: NEW_BRAND,
      accepting_applications: false,
      version: 0,
      tenant_id: T,
    });
    expect((res.data['draft'] as Row)['op']).toBe('create');
  });

  it('a draft that no longer reads is shown as live, marked invalid', async () => {
    db.tables['site_profile'] = [profileRow()];
    db.tables['content_drafts'] = [draftRow({ payload: { contactEmail: 'not an address' } })];
    const res = await callRoute(db, (await profile()).GET, 'GET', '/api/admin/site-profile');
    expect(res.data['brand_name']).toEqual(BRAND);
    expect(res.data['draft']).toMatchObject({ invalid: true });
  });
});

// ── The first save ────────────────────────────────────────────────────────────────────────

describe('PATCH with releases on: the first save is a pending create keyed by the tenant', () => {
  it('stages a create over the defaults; nothing live is written', async () => {
    const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, acceptingApplications: false, version: 0 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(liveWritesOf(db, 'site_profile')).toEqual([]);
    expect(drafts()).toHaveLength(1);
    const [d] = drafts();
    expect(d).toMatchObject({
      entity_type: 'site_profile',
      entity_id: T,
      op: 'create',
      base: {},
      base_version: null,
      payload: { brandName: NEW_BRAND },
    });
    // The switch is never part of a change, even unchanged.
    expect(d!['payload']).not.toHaveProperty('acceptingApplications');
    expect(res.data).toMatchObject({ brand_name: NEW_BRAND, version: 0 });
    expect((res.data['draft'] as Row)['op']).toBe('create');
    expect(auditsOf(db)).toEqual(['site_profile.draft_save']);
    expect(auditRowsOf(db)[0]).toMatchObject({ entity_id: T });
  });

  it('a version the missing row never had is a conflict', async () => {
    const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, version: 5 },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'conflict']);
    expect(drafts()).toEqual([]);
  });

  it('a second save must name the pending create; naming it edits it, still a create', async () => {
    const { PATCH } = await profile();
    await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, version: 0 },
    });
    const blind = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2020, version: 0 },
    });
    expect([blind.status, blind.body['error']]).toEqual([409, 'draft-conflict']);
    const named = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2020, ...ref(drafts()[0]!) },
    });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({
      op: 'create',
      version: 2,
      payload: { brandName: NEW_BRAND, foundedYear: 2020 },
    });
  });

  it('SEO defaults: the same, keyed by the tenant', async () => {
    const res = await callRoute(db, (await seo()).PATCH, 'PATCH', '/api/admin/seo-defaults', {
      // A closed value (Admin v2 U10, SEO_DEFAULT_ROBOTS).
      body: { robotsDirectives: 'noindex,follow', version: 0 },
      role: 'seo',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({ entity_type: 'seo_defaults', entity_id: T, op: 'create' });
    expect(liveWritesOf(db, 'seo_defaults')).toEqual([]);
    expect(auditsOf(db)).toEqual(['seo_defaults.draft_save']);
  });
});

// ── Edits ─────────────────────────────────────────────────────────────────────────────────

describe('PATCH with releases on: an edit of the row', () => {
  beforeEach(() => {
    db.tables['site_profile'] = [profileRow()];
  });

  it('checks the live version when no change is pending', async () => {
    const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, version: 3 },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'conflict']);
  });

  it('records the base from live once, over the whole allowlist, and never overwrites it', async () => {
    const { PATCH } = await profile();
    const first = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, version: 4 },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({
      op: 'update',
      base: { brand_name: BRAND },
      base_version: 4,
      fields: ['brand_name'],
    });
    // The live read named every column the registry may write (so no base is a false null).
    const select = db.calls.find((c) => c.name === 'site_profile' && c.op === 'select')!.columns!;
    for (const column of ['brand_name', 'contact_email', 'socials', 'accepting_applications']) {
      expect(select.split(',')).toContain(column);
    }
    // Live moves under the change; the next save keeps the first base.
    db.tables['site_profile']![0]!['brand_name'] = { en: 'Moved', ar: 'تغير' };
    const second = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2021, ...ref(drafts()[0]!) },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(drafts()[0]!['base']).toEqual({ brand_name: BRAND, founded_year: 2019 });
    expect((second.data['draft'] as Row)['conflict']).toEqual(['brand_name']);
    expect(liveWritesOf(db, 'site_profile')).toEqual([]);
  });

  it('a save equal to live stages nothing; setting a change back throws it away', async () => {
    const { PATCH } = await profile();
    const same = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: BRAND, version: 4 },
    });
    expect(same.status).toBe(200);
    expect(same.data['draft']).toBeNull();
    expect(drafts()).toEqual([]);
    await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, version: 4 },
    });
    const back = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: BRAND, ...ref(drafts()[0]!) },
    });
    expect(back.status).toBe(200);
    expect(back.data['draft']).toBeNull();
    expect(drafts()).toEqual([]);
    expect(auditsOf(db)).toEqual(['site_profile.draft_save', 'site_profile.draft_discard']);
  });

  it('a claimed change is 409 scheduled; a vanished one is published or discarded, with live', async () => {
    const { PATCH } = await profile();
    db.tables['content_drafts'] = [
      draftRow({ payload: { brandName: NEW_BRAND }, release_id: OTHER_USER }),
    ];
    const claimed = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2020, ...ref(drafts()[0]!) },
    });
    expect([claimed.status, claimed.body['error']]).toEqual([409, 'scheduled']);

    db.tables['content_drafts'] = [];
    const gone = '88888888-8888-4888-8888-000000000001';
    const discarded = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2020, draftId: gone, draftVersion: 2 },
    });
    expect([discarded.status, discarded.body['error']]).toEqual([409, 'draft-discarded']);
    expect((discarded.body['live'] as Row)['brand_name']).toEqual(BRAND);
    db.tables['content_release_items'] = [{ id: 1, tenant_id: T, draft_id: gone }];
    const published = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2020, draftId: gone, draftVersion: 2 },
    });
    expect([published.status, published.body['error']]).toEqual([409, 'draft-published']);
  });

  it('a row that appeared under a pending create: read and saved as an edit of it', async () => {
    db.tables['content_drafts'] = [
      draftRow({ op: 'create', payload: { brandName: NEW_BRAND }, base_version: null }),
    ];
    const { GET, PATCH } = await profile();
    const read = await callRoute(db, GET, 'GET', '/api/admin/site-profile');
    expect(read.data).toMatchObject({ brand_name: NEW_BRAND, version: 4 });
    const saved = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { foundedYear: 2020, ...ref(drafts()[0]!) },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({
      op: 'update',
      base: { brand_name: BRAND, founded_year: 2019 },
      base_version: 4,
    });
  });

  it('the database refusing the change (a stale token, the flag) is a 403, nothing kept', async () => {
    db.fail = (call) => (call.name === 'write_drafts' ? { code: '42501', message: 'rls' } : null);
    const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, version: 4 },
    });
    expect(res.status).toBe(403);
    expect(drafts()).toEqual([]);
    expect(auditsOf(db)).toEqual([]);
  });
});

// ── The job-application switch ────────────────────────────────────────────────────────────

describe('the job-application switch is never staged', () => {
  beforeEach(() => {
    db.tables['site_profile'] = [profileRow({ accepting_applications: false })];
  });

  it('an Admin changing it in a staged save is 422, pointing to its own switch', async () => {
    const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, acceptingApplications: true, version: 4 },
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      field: 'acceptingApplications',
      detail:
        'Opening or closing job applications happens at once. Use the Job applications switch.',
    });
    expect(drafts()).toEqual([]);
  });

  it('sent unchanged it is ignored, for an Admin and a Developer alike', async () => {
    for (const role of ['admin', 'developer'] as const) {
      db.tables['content_drafts'] = [];
      const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
        body: { brandName: NEW_BRAND, acceptingApplications: false, version: 4 },
        role,
      });
      expect(res.status, `${role}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(drafts()[0]!['payload']).toEqual({ brandName: NEW_BRAND });
    }
  });

  it('a Developer opening applications is refused by guardWrite (403), staged or not', async () => {
    for (const flag of [true, false]) {
      db.flag = flag;
      const res = await callRoute(db, (await profile()).PATCH, 'PATCH', '/api/admin/site-profile', {
        body: { acceptingApplications: true, version: 4 },
        role: 'developer',
      });
      expect(res.status, `releases ${flag ? 'on' : 'off'}`).toBe(403);
    }
    expect(drafts()).toEqual([]);
    expect(liveWritesOf(db, 'site_profile')).toEqual([]);
  });

  it('with no row yet, an unchanged (closed) switch is ignored and an open one refused', async () => {
    db.tables['site_profile'] = [];
    const { PATCH } = await profile();
    const closed = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, acceptingApplications: false, version: 0 },
    });
    expect(closed.status).toBe(200);
    db.tables['content_drafts'] = [];
    const open = await callRoute(db, PATCH, 'PATCH', '/api/admin/site-profile', {
      body: { brandName: NEW_BRAND, acceptingApplications: true, version: 0 },
    });
    expect(open.status).toBe(422);
  });
});

describe('PATCH /api/admin/site-profile/intake: immediate, Admin only, releases on or off', () => {
  for (const flag of [true, false]) {
    describe(`releases ${flag ? 'on' : 'off'}`, () => {
      beforeEach(() => {
        db.flag = flag;
      });

      it('creates the row on first use, with the defaults and the switch open', async () => {
        const res = await callRoute(db, await intake(), 'PATCH', '/api/admin/site-profile/intake', {
          body: { acceptingApplications: true },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.data).toEqual({ acceptingApplications: true, version: 1, changed: true });
        const [row] = db.tables['site_profile']!;
        expect(row).toMatchObject({ tenant_id: T, accepting_applications: true });
        expect(row!['brand_name']).toBeTruthy();
        expect(auditRowsOf(db)).toMatchObject([
          { action: 'site_profile.intake', entity_id: T, detail: { open: true } },
        ]);
        // Never staged, never asks the flag.
        expect(draftTouchesOf(db)).toEqual([]);
        expect(db.calls.filter((c) => c.name === 'releases_enabled')).toEqual([]);
      });

      it('writes only the switch, and audits only a change', async () => {
        db.tables['site_profile'] = [profileRow({ accepting_applications: false })];
        const patch = await intake();
        const same = await callRoute(db, patch, 'PATCH', '/api/admin/site-profile/intake', {
          body: { acceptingApplications: false },
        });
        expect(same.data).toEqual({ acceptingApplications: false, version: 4, changed: false });
        expect(liveWritesOf(db, 'site_profile')).toEqual([]);
        const open = await callRoute(db, patch, 'PATCH', '/api/admin/site-profile/intake', {
          body: { acceptingApplications: true },
        });
        expect(open.data).toEqual({ acceptingApplications: true, version: 5, changed: true });
        expect(liveWritesOf(db, 'site_profile').map((c) => c.values)).toEqual([
          { accepting_applications: true },
        ]);
        await callRoute(db, patch, 'PATCH', '/api/admin/site-profile/intake', {
          body: { acceptingApplications: false },
        });
        expect(auditRowsOf(db).map((r) => r['detail'])).toEqual([{ open: true }, { open: false }]);
      });

      it('a Developer, a Content Creator and SEO are refused (403) and nothing is written', async () => {
        db.tables['site_profile'] = [profileRow()];
        for (const role of ['developer', 'content_creator', 'seo'] as const) {
          const res = await callRoute(
            db,
            await intake(),
            'PATCH',
            '/api/admin/site-profile/intake',
            {
              body: { acceptingApplications: true },
              role,
            },
          );
          expect(res.status, role).toBe(403);
        }
        expect(liveWritesOf(db, 'site_profile')).toEqual([]);
        expect(auditsOf(db)).toEqual([]);
      });
    });
  }

  it('takes one strict boolean', async () => {
    for (const body of [
      {},
      { acceptingApplications: 'yes' },
      { acceptingApplications: true, version: 1 },
    ]) {
      const res = await callRoute(db, await intake(), 'PATCH', '/api/admin/site-profile/intake', {
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('the database layer: the 0019 trigger refusing is a 403; a racing insert a 409', async () => {
    db.tables['site_profile'] = [profileRow()];
    db.fail = (call) =>
      call.name === 'site_profile' && call.op === 'update'
        ? { code: '42501', message: 'only an admin may open applications' }
        : null;
    const refused = await callRoute(db, await intake(), 'PATCH', '/api/admin/site-profile/intake', {
      body: { acceptingApplications: true },
    });
    expect(refused.status).toBe(403);
    db.tables['site_profile'] = [];
    db.fail = (call) =>
      call.name === 'site_profile' && call.op === 'insert'
        ? { code: '23505', message: 'duplicate key' }
        : null;
    const raced = await callRoute(db, await intake(), 'PATCH', '/api/admin/site-profile/intake', {
      body: { acceptingApplications: true },
    });
    expect([raced.status, raced.body['error']]).toEqual([409, 'conflict']);
    expect(auditsOf(db)).toEqual([]);
  });
});

// ── Not release-managed ───────────────────────────────────────────────────────────────────

describe('singletons outside the registry never ask the flag', () => {
  it('general settings, integrations and the Style-Finder config: read and save', async () => {
    db.tables['site_settings'] = [];
    db.tables['site_integrations'] = [];
    db.tables['ai_config'] = [];
    // Releases on: were the flag asked, these would still be live writes, so only the call log
    // can tell — no rpc at all, and nothing touches content_drafts, on the read or the save.
    db.flag = true;
    for (const [load, path, role, table] of [
      [
        () => import('@/pages/api/admin/settings/index'),
        '/api/admin/settings',
        'admin',
        'site_settings',
      ],
      [
        () => import('@/pages/api/admin/integrations'),
        '/api/admin/integrations',
        'admin',
        'site_integrations',
      ],
      [() => import('@/pages/api/admin/ai-config'), '/api/admin/ai-config', 'admin', 'ai_config'],
    ] as const) {
      const { GET, PATCH } = (await load()) as Routes;
      expect((await callRoute(db, GET, 'GET', path, { role })).status, path).toBe(200);
      const saved = await callRoute(db, PATCH, 'PATCH', path, { role, body: { version: 0 } });
      expect(saved.status, `${path} ${JSON.stringify(saved.body)}`).toBe(200);
      expect(db.tables[table], path).toHaveLength(1);
    }
    expect(db.calls.filter((c) => c.kind === 'rpc')).toEqual([]);
    expect(draftTouchesOf(db)).toEqual([]);
  });
});
