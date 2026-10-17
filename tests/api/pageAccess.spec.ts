import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VISIBILITY_KV_KEY, clearVisibilityMemo } from '@/lib/http/visibility';
import { PAGE_ACCESS_FIELDS } from '@schemas/visibility';
import { pageAccessCookieName, verifyAccessCookie } from '@/lib/visibility/access';
import { __kv } from '../stubs/cloudflare-workers';

// POST /api/page-access — the password box's form (Admin v2 U14b).
//
// What this file is about: the order of the refusals, that the limiter FAILS CLOSED, and
// that nothing of the password leaves the Worker — not in the answer, not in the URL, not
// in a log line. The bcrypt check itself is the database's (pgTAP page_password.test.sql).

const TENANT = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ROOT_KEY = 'test-dummy-lead-pii-enc-key';

/** What `page_password_check` answers: a version, null, or an error. */
let check: number | null | 'error' = 4;
/** What `public_write_hit` answers for each call, in order. */
let hits: (number | 'error')[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
const logs: unknown[] = [];

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'public_write_hit') {
        const next = hits.shift() ?? 1;
        return next === 'error'
          ? { data: null, error: { message: 'down' } }
          : { data: next, error: null };
      }
      if (check === 'error') return { data: null, error: { message: 'down' } };
      return { data: check, error: null };
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
  },
}));

const { POST, PAGE_ACCESS_LIMITS } = await import('@/pages/api/page-access');

function snapshot(mode: 'password' | 'public' = 'password') {
  __kv.set(
    VISIBILITY_KV_KEY,
    JSON.stringify({
      v: 1,
      builtAt: null,
      tenant: TENANT,
      pages:
        mode === 'password'
          ? { about: { mode: 'password', id: PAGE_ID, pv: 4 } }
          : { join: { mode: 'link' } },
      templates: {},
    }),
  );
  clearVisibilityMemo();
}

function send(
  body: Record<string, string>,
  opts: { origin?: string | null; headers?: Record<string, string> } = {},
) {
  const form = new URLSearchParams(body);
  const headers: Record<string, string> = {
    host: 'www.braiinstation.com',
    'content-type': 'application/x-www-form-urlencoded',
    ...opts.headers,
  };
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'https://www.braiinstation.com';
  return (POST as unknown as (c: { request: Request }) => Promise<Response>)({
    request: new Request('https://www.braiinstation.com/api/page-access', {
      method: 'POST',
      headers,
      body: form.toString(),
    }),
  });
}

const good = {
  [PAGE_ACCESS_FIELDS.page]: 'about',
  [PAGE_ACCESS_FIELDS.next]: '/about',
  [PAGE_ACCESS_FIELDS.password]: 'letmein22',
};

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
  check = 4;
  hits = [];
  rpcCalls.length = 0;
  logs.length = 0;
  snapshot();
});

describe('POST /api/page-access', () => {
  it('the right password sets the cookie for that page and sends the visitor back', async () => {
    const res = await send(good);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/about');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith(`${pageAccessCookieName(PAGE_ID)}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
    expect(await verifyAccessCookie(ROOT_KEY, value, { pageId: PAGE_ID, pv: 4 })).toBe(true);
  });

  it('the Arabic twin gets the Arabic path back', async () => {
    const res = await send({ ...good, [PAGE_ACCESS_FIELDS.next]: '/ar/about' });
    expect(res.headers.get('location')).toBe('/ar/about');
  });

  it('a wrong password: back to the page, no cookie, and nothing typed is echoed', async () => {
    check = null;
    const res = await send(good);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/about?pa=wrong');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).not.toContain('letmein22');
  });

  it('the password reaches the database and nothing else: no log, no URL, no answer body', async () => {
    check = null;
    const res = await send(good);
    expect(await res.text()).toBe('');
    expect(JSON.stringify(logs)).not.toContain('letmein22');
    const limiter = rpcCalls.filter((c) => c.fn === 'public_write_hit');
    expect(JSON.stringify(limiter)).not.toContain('letmein22');
    const checked = rpcCalls.find((c) => c.fn === 'page_password_check');
    expect(checked?.args).toEqual({
      p_tenant: TENANT,
      p_page_id: PAGE_ID,
      p_password: 'letmein22',
    });
  });

  it('refuses a cross-origin post before anything else', async () => {
    const res = await send(good, { origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a body larger than the form can be, before reading it', async () => {
    const res = await send(good, { headers: { 'content-length': '9000' } });
    expect(res.status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a streamed body with no Content-Length once it passes the cap', async () => {
    const bytes = new TextEncoder().encode(
      `${new URLSearchParams(good).toString()}&x=${'a'.repeat(64 * 1024)}`,
    );
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close();
        const chunk = bytes.slice(pulled, pulled + 1024);
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('https://www.braiinstation.com/api/page-access', {
      method: 'POST',
      headers: {
        host: 'www.braiinstation.com',
        origin: 'https://www.braiinstation.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const res = await (POST as unknown as (c: { request: Request }) => Promise<Response>)({
      request,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a Content-Length that is not a number, before reading the body', async () => {
    const res = await send(good, { headers: { 'content-length': 'abc' } });
    expect(res.status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a page that is not behind a password, and one the route map does not know', async () => {
    snapshot('public');
    expect((await send(good)).status).toBe(400);
    snapshot();
    expect((await send({ ...good, [PAGE_ACCESS_FIELDS.page]: 'careers' })).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a `next` that is not this page’s own path: no open redirect', async () => {
    for (const next of [
      'https://evil.test/',
      '//evil.test/',
      '/contact',
      '/about?x=1',
      '/ar/contact',
      '',
    ]) {
      const res = await send({ ...good, [PAGE_ACCESS_FIELDS.next]: next });
      expect(res.status, next).toBe(400);
    }
    expect(rpcCalls).toEqual([]);
  });

  it('refuses an empty or oversized password without asking the database', async () => {
    expect((await send({ ...good, [PAGE_ACCESS_FIELDS.password]: '' })).status).toBe(400);
    expect((await send({ ...good, [PAGE_ACCESS_FIELDS.password]: 'x'.repeat(201) })).status).toBe(
      400,
    );
    expect(rpcCalls).toEqual([]);
  });

  it('counts every try against both rules, by address and by page', async () => {
    await send(good, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
    const limiter = rpcCalls.filter((c) => c.fn === 'public_write_hit');
    expect(limiter.map((c) => c.args['p_scope'])).toEqual(['page-access:ip', 'page-access:page']);
    expect(limiter[0]?.args['p_window_seconds']).toBe(PAGE_ACCESS_LIMITS.perIp.windowSeconds);
    expect(limiter[1]?.args['p_window_seconds']).toBe(PAGE_ACCESS_LIMITS.perPage.windowSeconds);
    // The address itself never leaves the Worker: the counter is keyed by an HMAC of it.
    expect(JSON.stringify(limiter)).not.toContain('203.0.113.7');
    for (const call of limiter) expect(call.args['p_key_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('over either limit: 429, no bcrypt call, and one line with counts only', async () => {
    hits = [PAGE_ACCESS_LIMITS.perIp.max + 1, 1];
    const res = await send(good);
    expect(res.status).toBe(429);
    expect(rpcCalls.some((c) => c.fn === 'page_password_check')).toBe(false);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('letmein22');
    hits = [1, PAGE_ACCESS_LIMITS.perPage.max + 1];
    expect((await send(good)).status).toBe(429);
  });

  it('an unreachable limiter FAILS CLOSED: no unlimited guessing at a password', async () => {
    hits = ['error'];
    const res = await send(good);
    expect(res.status).toBe(429);
    expect(rpcCalls.some((c) => c.fn === 'page_password_check')).toBe(false);
  });

  it('a database that cannot answer refuses rather than opening the page', async () => {
    check = 'error';
    const res = await send(good);
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses when the snapshot names no tenant (nothing to bind the unlock to)', async () => {
    __kv.set(
      VISIBILITY_KV_KEY,
      JSON.stringify({
        v: 1,
        builtAt: null,
        pages: { about: { mode: 'password', id: PAGE_ID, pv: 4 } },
        templates: {},
      }),
    );
    clearVisibilityMemo();
    expect((await send(good)).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});
