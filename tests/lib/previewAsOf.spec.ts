import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsOfAnswer } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { contentClient } from '@/lib/data/source';
import { previewHrefFor } from '@/lib/admin/preview/bridge';
import { clearVisibilityMemo, PASS } from '@/lib/http/visibility';
import { createPreviewSource, type VersionPreview } from '@/lib/preview/dataset';
import { assessPreview, PREVIEW_COPY } from '@/lib/preview/report';
import { escapeHtml, ribbonLines } from '@/lib/preview/ribbon';
import { previewTarget } from '@/lib/preview/routes';
import { asOfChanges, asOfTargets } from '@/lib/release/asOf';
import {
  BI,
  fakeStaffClient,
  fixtureTables,
  ID,
  id,
  session,
  TENANT,
} from '../fixtures/previewDataset';
import { __kv } from '../stubs/cloudflare-workers';

// The preview of a published version (Admin v2 R10; releases.md slice R10: "the as-of overlay
// … is reused by the preview dataset (?v=n)"): `?v=` on the route, the dataset laying the
// changes back to that version over live in place of the pending changes (no drafts read), and
// the handler reading the version first (none: a 404 that renders nothing), the ribbon naming
// it, and every link keeping it. The state at a version itself is SQL (0104, pgTAP).

type Row = Record<string, unknown>;
const NOW = new Date('2026-03-01T12:00:00.000Z');

/** The ledger's answer for version `number`, `entities` touched since. */
function answer(number: number, entities: AsOfAnswer['entities'], total?: number): AsOfAnswer {
  return {
    release: {
      id: id(900),
      number,
      kind: 'publish',
      note: null,
      published_at: '2026-02-01T00:00:00+00:00',
      published_by: id(1),
    },
    cutoff: 10,
    total: total ?? entities.length,
    entities,
  };
}

const version = (a: AsOfAnswer): VersionPreview => ({
  number: a.release.number,
  changes: asOfChanges(asOfTargets(a.entities)),
  truncated: a.total > a.entities.length,
});

/** Since version 2: the logo service renamed, the retail sector removed, a category created. */
const SINCE: AsOfAnswer['entities'] = [
  {
    entity_type: 'service',
    entity_id: ID.sPub,
    before: { slug: 'logo', title: BI('Logos then', 'شعارات قديمة'), status: 'published' },
    exists_now: true,
  },
  {
    entity_type: 'sector',
    entity_id: id(801),
    before: { slug: 'health', name: BI('Health', 'الصحة'), visible: true, sort_order: 5 },
    exists_now: false,
  },
  { entity_type: 'category', entity_id: ID.cat1, before: null, exists_now: true },
  {
    entity_type: 'team_member',
    entity_id: ID.tmPub,
    before: { name: BI('Never', 'أبدا') },
    exists_now: true,
  },
];

function source(asOf: VersionPreview, role: AuthContext['role'] = 'admin') {
  const fake = fakeStaffClient({ ...fixtureTables(), content_drafts: [] });
  const preview = createPreviewSource({
    supabase: fake.client,
    session: session(role),
    now: () => NOW,
    asOf,
  });
  const db = preview.client() as unknown as {
    from(t: string): { select(c: string): PromiseLike<{ data: Row[] | null; error: unknown }> };
  };
  const read = async (table: string, columns: string) => {
    const { data, error } = await db.from(table).select(columns);
    if (error) throw new Error(`${table}: ${JSON.stringify(error)}`);
    return data!;
  };
  return { fake, preview, read };
}

describe('?v= on the preview route', () => {
  const at = (path: string) => previewTarget(new URL(`https://www.example.test${path}`));

  it('reads the version and keeps it out of the public query', () => {
    expect(at('/admin/preview/services?v=3&x=1')).toMatchObject({
      ok: true,
      target: { publicPath: '/services?x=1', version: 3 },
    });
    const plain = at('/admin/preview/about');
    expect(plain).toMatchObject({ ok: true, target: { publicPath: '/about' } });
    expect(plain.ok ? plain.target.version : 'refused').toBeUndefined();
  });

  it('refuses a malformed version, two of them, and a version with a selection', () => {
    for (const bad of ['v=0', 'v=-1', 'v=01', 'v=abc', 'v=1e3', 'v=1234567890', 'v=1&v=2', 'v=']) {
      expect(at(`/admin/preview/about?${bad}`), bad).toEqual({ ok: false, reason: 'bad-version' });
    }
    expect(at(`/admin/preview/about?v=2&only=${id(5)}`)).toEqual({
      ok: false,
      reason: 'bad-version',
    });
  });

  it('a link clicked inside a version preview stays on that version', () => {
    expect(
      previewHrefFor('/services/logo', 'https://www.example.test/admin/preview/services?v=4'),
    ).toBe('/admin/preview/services/logo?v=4');
    expect(
      previewHrefFor('/services/logo', `https://www.example.test/admin/preview/services`),
    ).toBe('/admin/preview/services/logo');
  });
});

describe('the dataset at a version', () => {
  it('lays the changes back to the version over live, and reads no pending change', async () => {
    const { fake, preview, read } = source(version(answer(2, SINCE)));
    const services = await read('services', 'id,title');
    expect(services).toContainEqual({ id: ID.sPub, title: BI('Logos then', 'شعارات قديمة') });
    // Removed since: back, as the version had it.
    expect(await read('sectors', 'id,slug')).toContainEqual({ id: id(801), slug: 'health' });
    // Created since: gone.
    expect((await read('categories', 'id')).map((r) => r['id'])).not.toContain(ID.cat1);
    // Team members are never in a version (O-12): the live row stands.
    expect(await read('team_members', 'id')).toContainEqual({ id: ID.tmPub });
    expect(fake.calls.some((c) => c.startsWith('content_drafts'))).toBe(false);
    const report = preview.report();
    expect(report.overlaid).toBe(3);
    expect(report.pending).toBe(3);
    expect(assessPreview(report).state).toBe('ok');
  });

  it('counts, never shows, the changes in an area the role does not read (Developer)', async () => {
    const pageThen: AsOfAnswer['entities'][number] = {
      entity_type: 'page',
      entity_id: ID.pgDraft,
      before: { slug: 'draft-page', title: BI('Then', 'سابقا'), status: 'published' },
      exists_now: true,
    };
    const { preview, read } = source(version(answer(2, [...SINCE, pageThen])), 'developer');
    const titles = (await read('services', 'title')).map((r) => (r['title'] as { en: string }).en);
    expect(titles).not.toContain('Logos then');
    expect((await read('pages', 'id')).map((r) => r['id'])).toContain(ID.pgDraft);
    // service, sector and category: none of them Developer's to read.
    expect(preview.report().draftsNotShown).toBe(3);
    expect(preview.report().pending).toBe(1);
  });

  it('more changes since than were read: the render is not trusted', async () => {
    const { preview, read } = source(version(answer(2, SINCE, 900)));
    await read('services', 'id');
    expect(preview.report().truncated).toContain('content_release_items');
    expect(assessPreview(preview.report())).toMatchObject({
      state: 'untrusted',
      reasons: ['truncated'],
    });
  });

  it('a change of the version that no longer reads is reported, not shown', async () => {
    const { preview, read } = source(
      version(
        answer(2, [
          {
            entity_type: 'service',
            entity_id: ID.sPub,
            before: { slug: 'NOT A SLUG', title: BI('X', 'س') },
            exists_now: true,
          },
        ]),
      ),
    );
    expect(await read('services', 'id,slug')).toContainEqual({ id: ID.sPub, slug: 'logo' });
    expect(preview.report().invalid).toMatchObject([{ entityId: ID.sPub, reason: 'invalid' }]);
  });
});

describe('the ribbon of a version', () => {
  const ok = { state: 'ok' as const, pending: 3, invalid: [], notPreviewed: [], samples: 0 };

  it('names the version, never a count of pending changes', () => {
    const { lead } = ribbonLines({ verdict: ok, gate: PASS, version: 7 });
    expect(lead).toBe(PREVIEW_COPY.version.lead.replace('{v}', '7'));
    expect(lead).not.toContain('unpublished');
  });

  it('says what it shows as it is now, and what it cannot show as it was', () => {
    const { notes } = ribbonLines({
      verdict: {
        ...ok,
        invalid: [{ draftId: 'x', entityType: 'service', entityId: id(1), reason: 'invalid' }],
        notPreviewed: ['redirect', 'custom_theme', 'rpc:search_content'],
      },
      gate: PASS,
      version: 7,
    });
    expect(notes).toEqual([
      PREVIEW_COPY.version.invalid.one,
      PREVIEW_COPY.notPreviewed.search,
      PREVIEW_COPY.version.notPreviewed,
    ]);
  });

  it('a version it could not read whole names the version, never "your changes"', () => {
    const { lead, notes } = ribbonLines({
      verdict: { state: 'untrusted', reasons: ['truncated', 'failed-table'] },
      gate: PASS,
      version: 7,
    });
    expect(lead).toBe(PREVIEW_COPY.version.untrusted.replace('{v}', '7'));
    expect(lead).toContain('version 7');
    expect(lead).not.toMatch(/your changes|Reload/);
    expect(notes).toEqual([
      PREVIEW_COPY.version.reasons.truncated,
      PREVIEW_COPY.reasons['failed-table'],
    ]);
    // A preview of pending changes keeps R9's words.
    expect(
      ribbonLines({ verdict: { state: 'untrusted', reasons: ['truncated'] }, gate: PASS }).lead,
    ).toBe(PREVIEW_COPY.untrusted);
  });

  it('keeps the copy rules: no em or en dash, the brand never spelled', () => {
    const text = JSON.stringify(PREVIEW_COPY.version);
    expect(text).not.toMatch(/[–—]/);
    expect(text.toLowerCase()).not.toContain('braiin');
  });
});

// ---- through the middleware ------------------------------------------------------------------

const state = vi.hoisted(() => ({
  ctx: null as AuthContext | null,
  client: null as unknown,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  logs: [] as unknown[],
}));
vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => state.client,
  clearSessionCookies: () => undefined,
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/auth/context', () => ({
  resolveAuthContext: async () => ({ ctx: state.ctx, revoke: false }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    state.logs.push(entry);
    return true;
  },
}));

const { onRequest } = await import('@/middleware');
type Next = (payload?: unknown) => Promise<Response>;
const run = onRequest as unknown as (context: unknown, next: Next) => Promise<Response>;

function context(path: string) {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url),
    url,
    routePattern: '/admin/preview/[...path]',
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

/** A public page that lists the services' English titles, read through the content seam. */
function servicesPage() {
  const calls: unknown[] = [];
  const next: Next = async (payload) => {
    calls.push(payload);
    const { data } = await contentClient().from('services').select('id,title');
    const titles = ((data ?? []) as { title: { en: string } }[]).map((r) => r.title.en);
    return new Response(
      `<!doctype html><html><head><title>t</title></head><body><main>${titles.join('|')}</main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  };
  return { next, calls };
}

/** Signs in with a staff client whose `release_as_of` answers `at` (null: no such version). */
function signIn(at: AsOfAnswer | null, role: AuthContext['role'] = 'content_creator') {
  const fake = fakeStaffClient({ ...fixtureTables(), content_drafts: [] });
  state.client = Object.assign(fake.client, {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      if (fn !== 'release_as_of') return { data: null, error: { code: 'XX000', message: fn } };
      return at
        ? { data: at, error: null }
        : { data: null, error: { code: 'P0002', message: 'no such version' } };
    },
  });
  state.ctx = session(role);
  return fake;
}

beforeEach(() => {
  state.ctx = null;
  state.client = null;
  state.rpcs.length = 0;
  state.logs.length = 0;
  __kv.clear();
  clearVisibilityMemo();
});

describe('a version through the preview route', () => {
  it('reads the version with the person’s own client, then shows the site as it was', async () => {
    const fake = signIn(answer(2, SINCE));
    const { next, calls } = servicesPage();
    const res = await run(context('/admin/preview/services?v=2'), next);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['/services']);
    expect(state.rpcs).toEqual([
      {
        fn: 'release_as_of',
        args: { p_tenant: TENANT, p_number: 2, p_limit: 500, p_page: null },
      },
    ]);
    const html = await res.text();
    expect(html).toContain('Logos then');
    expect(html).toContain(escapeHtml(PREVIEW_COPY.version.lead.replace('{v}', '2')));
    // The twin keeps the version.
    expect(html).toContain('href="/admin/preview/ar/services?v=2"');
    expect(fake.calls.some((c) => c.startsWith('content_drafts'))).toBe(false);
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0, must-revalidate');
  });

  it('no such version (releases off, a number never published): a 404 that renders nothing', async () => {
    signIn(null);
    const { next, calls } = servicesPage();
    const res = await run(context('/admin/preview/services?v=9'), next);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("That version doesn't exist.");
    expect(calls).toEqual([]);
  });

  it('a ledger that cannot be read is a plain 503, logged with the route only', async () => {
    signIn(answer(2, SINCE));
    (state.client as { rpc: unknown }).rpc = async () => ({
      data: null,
      error: { code: '08006', message: 'connection lost' },
    });
    const { next, calls } = servicesPage();
    const res = await run(context('/admin/preview/services?v=2'), next);
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
    expect(state.logs).toEqual([
      expect.objectContaining({
        level: 'error',
        source: 'preview',
        detail: { route: '/services' },
      }),
    ]);
  });

  it('a malformed version is a 400, before anything is read', async () => {
    signIn(answer(2, SINCE));
    const { next, calls } = servicesPage();
    const res = await run(context('/admin/preview/services?v=two'), next);
    expect(res.status).toBe(400);
    expect(state.rpcs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('Sales cannot preview a version either', async () => {
    signIn(answer(2, SINCE));
    state.ctx = session('sales' as AuthContext['role']);
    const res = await run(context('/admin/preview/services?v=2'), servicesPage().next);
    expect(res.status).toBe(403);
    expect(state.rpcs).toEqual([]);
  });
});
