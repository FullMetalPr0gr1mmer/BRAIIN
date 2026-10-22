import { beforeEach, describe, expect, it, vi } from 'vitest';

// The purge seam (Admin v2 R7, src/lib/http/purge.ts): "Not set up" sends and reads nothing;
// the tag set is at most 30 or `tenant:default`; the 24-hour budget is taken in the database
// before anything is sent and nothing is sent blind; one retry after jitter on a 5xx or a
// network error, never on a 4xx; a breaker in the isolate; it never throws; an outcome names a
// reason code, never the token or the response body.

const svc = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  answer: (() => ({ data: true, error: null })) as () => { data: unknown; error: unknown },
  logs: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      svc.calls.push({ fn, args });
      return svc.answer();
    },
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    svc.logs.push(entry);
    return true;
  },
}));

const {
  BREAKER,
  CACHE_PURGE_MAX_TAGS,
  COLLAPSE_TAG,
  MEDIA_PURGE_TAGS,
  purgeAfterSave,
  purgeConfig,
  purgeTagSet,
  purgeTags,
  resetPurgeBreaker,
} = await import('@/lib/http/purge');

const ZONE = '0123456789abcdef0123456789abcdef';
const TOKEN = 'purge-token-for-tests';
const CONFIG = { zoneId: ZONE, token: TOKEN };
const TENANT = '00000000-0000-4000-8000-0000000000b1';

type Answer = Response | Error;
function fetchWith(...answers: Answer[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, seen };
}
const ok = () => new Response(JSON.stringify({ success: true, result: { id: 'x' } }));
const sleeps: number[] = [];
const options = (fetchImpl: typeof fetch, now = () => 1_000_000) => ({
  config: CONFIG,
  fetchImpl,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  random: () => 0.5,
  now,
});

beforeEach(() => {
  svc.calls = [];
  svc.logs = [];
  svc.answer = () => ({ data: true, error: null });
  sleeps.length = 0;
  resetPurgeBreaker();
});

describe('the tag set', () => {
  it('lower-cases, keeps each tag once, in order; empty stays empty', () => {
    expect(purgeTagSet(['Service:Logo', 'services:all', 'service:logo'])).toEqual([
      'service:logo',
      'services:all',
    ]);
    expect(purgeTagSet([])).toEqual([]);
  });

  it('more than 30, or one tag the API cannot take, is tenant:default alone', () => {
    const many = Array.from({ length: CACHE_PURGE_MAX_TAGS + 1 }, (_, n) => `service:s${n}`);
    expect(purgeTagSet(many)).toEqual([COLLAPSE_TAG]);
    expect(purgeTagSet(many.slice(0, 30))).toHaveLength(30);
    expect(purgeTagSet(['service:logo', 'page:a b'])).toEqual([COLLAPSE_TAG]);
    expect(purgeTagSet(['service:شعار'])).toEqual([COLLAPSE_TAG]);
    expect(purgeTagSet(['nocolon'])).toEqual([COLLAPSE_TAG]);
  });
});

describe('not set up (owner item O-3)', () => {
  it('without a zone and token in the environment, nothing is configured', () => {
    expect(purgeConfig()).toBeNull();
  });

  it('is skipped: nothing read, nothing sent, nothing logged', async () => {
    const { impl, seen } = fetchWith();
    const outcome = await purgeTags(TENANT, ['service:logo'], {
      source: 'release',
      config: null,
      fetchImpl: impl,
    });
    expect(outcome).toEqual({
      status: 'skipped',
      tags: ['service:logo'],
      requests: 0,
      reason: 'not-set-up',
    });
    expect(seen).toEqual([]);
    expect(svc.calls).toEqual([]);
    expect(svc.logs).toEqual([]);
  });

  it('the environment default is "not set up" too (the test stub, as a deployment ships)', async () => {
    const outcome = await purgeTags(TENANT, ['media:all'], { source: 'media' });
    expect(outcome.status).toBe('skipped');
    expect(svc.calls).toEqual([]);
  });

  it('no tag is not_needed, and reads nothing', async () => {
    const outcome = await purgeTags(TENANT, [], { source: 'release', config: CONFIG });
    expect(outcome).toEqual({ status: 'not_needed', tags: [], requests: 0 });
    expect(svc.calls).toEqual([]);
  });
});

describe('set up', () => {
  it('takes the tags from the day’s budget, then sends one request by tag', async () => {
    const { impl, seen } = fetchWith(ok());
    const outcome = await purgeTags(TENANT, ['service:logo', 'services:all'], {
      source: 'release',
      ...options(impl),
    });
    expect(outcome).toEqual({
      status: 'done',
      tags: ['service:logo', 'services:all'],
      requests: 1,
    });
    expect(svc.calls).toEqual([
      {
        fn: 'cache_purge_take',
        args: { p_tenant: TENANT, p_tags: 2, p_source: 'release' },
      },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`);
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      tags: ['service:logo', 'services:all'],
    });
  });

  it('a 5xx is retried once after 200 to 600 ms of jitter', async () => {
    const { impl, seen } = fetchWith(new Response('', { status: 503 }), ok());
    const outcome = await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) });
    expect(outcome).toMatchObject({ status: 'done', requests: 2 });
    expect(seen).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(200);
    expect(sleeps[0]).toBeLessThanOrEqual(600);
  });

  it('a 429 is failed (rate-limited) at once: a 4xx is never retried; the minute cron is', async () => {
    const { impl, seen } = fetchWith(new Response('slow down', { status: 429 }));
    const outcome = await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) });
    expect(outcome).toEqual({
      status: 'failed',
      tags: ['media:all'],
      requests: 1,
      reason: 'rate-limited',
    });
    expect(seen).toHaveLength(1);
  });

  it('a refusal in the body is failed (refused), without its words', async () => {
    const { impl } = fetchWith(
      new Response(JSON.stringify({ success: false, errors: [{ message: 'secret detail' }] })),
    );
    const outcome = await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(JSON.stringify(outcome)).not.toContain('secret detail');
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it('a network error twice is failed (network) after two requests', async () => {
    const { impl } = fetchWith(new TypeError('boom'), new TypeError('boom'));
    const outcome = await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'network', requests: 2 });
  });

  it('over the day’s budget nothing is sent (budget); an unreadable budget sends nothing either', async () => {
    const { impl, seen } = fetchWith();
    svc.answer = () => ({ data: false, error: null });
    expect(
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) }),
    ).toMatchObject({ status: 'failed', reason: 'budget', requests: 0 });
    svc.answer = () => ({ data: null, error: { code: '42501', message: 'no' } });
    expect(
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) }),
    ).toMatchObject({ status: 'failed', reason: 'budget-unread', requests: 0 });
    svc.answer = () => {
      throw new Error('unreachable');
    };
    expect(
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) }),
    ).toMatchObject({ status: 'failed', reason: 'budget-unread' });
    expect(seen).toEqual([]);
  });

  it('the breaker: three failures in a row stop requests for a minute, then one is tried again', async () => {
    let now = 1_000_000;
    const clock = () => now;
    for (let n = 0; n < BREAKER.failures; n += 1) {
      const { impl } = fetchWith(new Response('', { status: 400 }));
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl, clock) });
    }
    svc.calls = [];
    const shut = fetchWith();
    expect(
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(shut.impl, clock) }),
    ).toEqual({ status: 'failed', tags: ['media:all'], requests: 0, reason: 'breaker' });
    expect(shut.seen).toEqual([]);
    expect(svc.calls).toEqual([]);

    now += BREAKER.openMs + 1;
    const open = fetchWith(ok());
    expect(
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(open.impl, clock) }),
    ).toMatchObject({ status: 'done' });
    // A success closes it: the next failure alone does not open it again.
    const once = fetchWith(new Response('', { status: 400 }));
    await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(once.impl, clock) });
    const after = fetchWith(ok());
    expect(
      await purgeTags(TENANT, ['media:all'], { source: 'media', ...options(after.impl, clock) }),
    ).toMatchObject({ status: 'done' });
  });

  it('never throws, whatever the transport does', async () => {
    const impl = (() => {
      throw new Error('synchronous');
    }) as unknown as typeof fetch;
    await expect(
      purgeTags(TENANT, ['media:all'], { source: 'media', ...options(impl) }),
    ).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('after an immediate save (media, page visibility)', () => {
  it('not set up: nothing read, sent or logged, so the save behaves as before', async () => {
    const outcome = await purgeAfterSave(TENANT, MEDIA_PURGE_TAGS, 'media');
    expect(outcome.status).toBe('skipped');
    expect(svc.calls).toEqual([]);
    expect(svc.logs).toEqual([]);
  });

  it('a failure is one warning naming the reason, never the token; a success logs nothing', async () => {
    const failing = fetchWith(new Response('', { status: 429 }));
    await purgeAfterSave(TENANT, ['page:about', 'nav:all'], 'visibility', {
      ...options(failing.impl),
    });
    expect(svc.logs).toEqual([
      expect.objectContaining({ level: 'warn', source: 'purge:visibility' }),
    ]);
    expect(JSON.stringify(svc.logs)).toContain('rate-limited');
    expect(JSON.stringify(svc.logs)).not.toContain(TOKEN);
    svc.logs = [];
    const fine = fetchWith(ok());
    await purgeAfterSave(TENANT, MEDIA_PURGE_TAGS, 'media', { ...options(fine.impl) });
    expect(svc.logs).toEqual([]);
    expect(svc.calls.at(-1)).toEqual({
      fn: 'cache_purge_take',
      args: { p_tenant: TENANT, p_tags: 1, p_source: 'media' },
    });
  });
});
