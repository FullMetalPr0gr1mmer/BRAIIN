import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { AuthorizationError } from '@/lib/authz/errors';
import { RateLimitError } from '@/lib/admin/errors';

// The content export as Backups & versions' "Download content" link (Admin v2 R13; GET
// /api/admin/export-backup, `export.backup`, under the export lockdown, CLAUDE.md §3, §7). A
// link a person follows: another site's page cannot make them download (403 before a slot or a
// row is spent), and a refusal they can act on (the hourly limit, an attempt row that could not
// be written) sends them back to the page with a notice (303) instead of a JSON body. A script's
// request is answered as before (429, 403).

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

const order: string[] = [];
let limited = false;
let ledgerDown = false;
let attemptFails = false;
let demoted = false;

vi.mock('@/lib/admin/liveRecheck', () => ({
  liveRecheck: async () => {
    order.push('live');
    if (demoted) throw new AuthorizationError('live-recheck', 'role changed');
  },
}));
vi.mock('@/lib/admin/rateLimit', () => ({
  claimPrivilegedOp: async (_auth: unknown, op: string) => {
    order.push(`limit:${op}`);
    if (limited) throw new RateLimitError(`${op}:user`);
    if (ledgerDown) throw new RateLimitError(`${op}:unavailable`);
  },
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: { action: string }) => {
    order.push(entry.action);
    return !(attemptFails && entry.action === 'export.backup.attempt');
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { GET } = await import('@/pages/api/admin/export-backup');

function db() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) b[m] = () => b;
      b['then'] = (ok: (v: unknown) => unknown) => {
        order.push(`read:${table}`);
        return Promise.resolve({ data: [], error: null }).then(ok);
      };
      return b;
    },
  };
}

function call({
  role = 'developer',
  navigate = false,
  headers = {} as Record<string, string>,
}: { role?: string; navigate?: boolean; headers?: Record<string, string> } = {}) {
  const url = new URL('https://admin.example.test/api/admin/export-backup');
  return (GET as APIRoute)({
    request: new Request(url, {
      headers: { ...(navigate ? { 'sec-fetch-mode': 'navigate' } : {}), ...headers },
    }),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role, isActive: true, email: 'x@example.test' },
      supabase: db(),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

beforeEach(() => {
  order.length = 0;
  limited = false;
  ledgerDown = false;
  attemptFails = false;
  demoted = false;
});

describe('GET /api/admin/export-backup, followed as a link', () => {
  it('our own page: the file, after the live recheck, the slot and the attempt row', async () => {
    const res = await call({ navigate: true, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="/);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(order.slice(0, 3)).toEqual(['live', 'limit:export-backup', 'export.backup.attempt']);
    expect(order[order.length - 1]).toBe('export.backup.outcome');
  });

  it('another site cannot make a person download: 403 before a slot or a row is spent', async () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      { origin: 'https://evil.example' },
      { referer: 'https://evil.example/trap' },
    ]) {
      order.length = 0;
      const res = await call({ headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(order, JSON.stringify(headers)).toEqual([]);
    }
  });

  it('the fourth download in an hour: 429 for a script, back to the page for a person', async () => {
    limited = true;
    expect((await call()).status).toBe(429);
    const person = await call({ navigate: true });
    expect(person.status).toBe(303);
    expect(person.headers.get('location')).toBe('/admin/backups?export=limit');
    expect(person.headers.get('cache-control')).toContain('no-store');
    expect(order.filter((o) => o.startsWith('read') || o.startsWith('export'))).toEqual([]);
  });

  it('a limiter that cannot be read is not the hourly limit: the page says it could not run', async () => {
    ledgerDown = true;
    const person = await call({ navigate: true });
    expect(person.status).toBe(303);
    expect(person.headers.get('location')).toBe('/admin/backups?export=unavailable');
  });

  it('an attempt row that cannot be written stops it: 403 for a script, the notice for a person', async () => {
    attemptFails = true;
    expect((await call()).status).toBe(403);
    const person = await call({ navigate: true });
    expect(person.status).toBe(303);
    expect(person.headers.get('location')).toBe('/admin/backups?export=unavailable');
    expect(order.some((o) => o.startsWith('read'))).toBe(false);
  });

  it('a demoted Developer is refused by the live recheck, a navigation included', async () => {
    demoted = true;
    expect((await call({ navigate: true })).status).toBe(403);
    expect(order).toEqual(['live']);
  });

  it('Content Creator and SEO hold no export.backup: refused before anything', async () => {
    for (const role of ['content_creator', 'seo', 'sales']) {
      order.length = 0;
      expect((await call({ role, navigate: true })).status, role).toBe(403);
      expect(order, role).toEqual([]);
    }
  });
});
