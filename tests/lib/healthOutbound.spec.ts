import { describe, expect, it, vi } from 'vitest';
import {
  OUTBOUND_DEFAULTS,
  OutboundError,
  RETRY_JITTER_MS,
  outboundJson,
  safeUrl,
} from '@/lib/http/outbound';

// The outbound helper (Admin v2 G2, src/lib/http/outbound.ts): a timeout, a size cap, one
// jittered retry on a network error or a 5xx only, redirects followed once, to https, for a
// GET only, a budget of two requests per call, and errors that carry a status and a reason
// code, never a key, a body or a URL's query.

const KEY = 'ur-secret-key-123';

type Call = { url: string; init: RequestInit };

function fake(...answers: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const noSleep = vi.fn(async () => undefined);

async function failure(p: Promise<unknown>): Promise<OutboundError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OutboundError);
    return err as OutboundError;
  }
  throw new Error('expected a failure');
}

describe('outboundJson', () => {
  it('answers a 2xx with its parsed body, sending only the headers named', async () => {
    const { fetchImpl, calls } = fake(json({ ok: true }));
    const result = await outboundJson(
      'https://api.example.test/x',
      { headers: { accept: 'application/json' } },
      { fetchImpl },
    );
    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers).toEqual({ accept: 'application/json' });
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect('credentials' in calls[0]!.init).toBe(false);
  });

  it('defaults to a 5 s timeout, a 256 KB cap and one retry', () => {
    expect(OUTBOUND_DEFAULTS).toEqual({ timeoutMs: 5000, maxBytes: 262144, retries: 1 });
  });

  it('times out, and does not retry a timeout', async () => {
    const never = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
          );
        }),
    ) as unknown as typeof fetch;
    const err = await failure(
      outboundJson('https://slow.example.test/', {}, { fetchImpl: never, timeoutMs: 20 }),
    );
    expect(err.reason).toBe('timeout');
    expect(never).toHaveBeenCalledTimes(1);
  });

  it('refuses a body past the cap, declared or streamed', async () => {
    const declared = fake(json({ a: 1 }, 200, { 'content-length': '999999' }));
    expect(
      (
        await failure(
          outboundJson(
            'https://a.example.test/',
            {},
            { fetchImpl: declared.fetchImpl, maxBytes: 100 },
          ),
        )
      ).reason,
    ).toBe('too-large');
    const streamed = fake(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(80)));
              controller.enqueue(new TextEncoder().encode('y'.repeat(80)));
              controller.close();
            },
          }),
        ),
    );
    expect(
      (
        await failure(
          outboundJson(
            'https://a.example.test/',
            {},
            { fetchImpl: streamed.fetchImpl, maxBytes: 100 },
          ),
        )
      ).reason,
    ).toBe('too-large');
  });

  it('retries once on a 5xx, after 200 to 600 ms of jitter, then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl, calls } = fake(new Response('boom', { status: 503 }), json({ fine: 1 }));
    const result = await outboundJson(
      'https://a.example.test/',
      {},
      { fetchImpl, sleep, random: () => 0 },
    );
    expect(result.json).toEqual({ fine: 1 });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(RETRY_JITTER_MS.min);
    sleep.mockClear();
    const again = fake(new Error('reset'), json({ fine: 2 }));
    await outboundJson(
      'https://a.example.test/',
      {},
      { fetchImpl: again.fetchImpl, sleep, random: () => 1 },
    );
    expect(sleep).toHaveBeenCalledWith(RETRY_JITTER_MS.max);
    expect(RETRY_JITTER_MS).toEqual({ min: 200, max: 600 });
  });

  it('gives up after one retry: two requests at most', async () => {
    const { fetchImpl, calls } = fake(
      new Response('', { status: 502 }),
      new Response('', { status: 502 }),
      json({}),
    );
    const err = await failure(
      outboundJson('https://a.example.test/', {}, { fetchImpl, sleep: noSleep }),
    );
    expect(err).toMatchObject({ reason: 'http', status: 502 });
    expect(calls).toHaveLength(2);
    const net = fake(new Error('down'), new Error('down'), json({}));
    expect(
      (
        await failure(
          outboundJson('https://a.example.test/', {}, { fetchImpl: net.fetchImpl, sleep: noSleep }),
        )
      ).reason,
    ).toBe('network');
    expect(net.calls).toHaveLength(2);
  });

  it('never retries a 4xx, and names its status', async () => {
    const { fetchImpl, calls } = fake(new Response('nope', { status: 404 }), json({}));
    const err = await failure(
      outboundJson('https://a.example.test/', {}, { fetchImpl, sleep: noSleep }),
    );
    expect(err).toMatchObject({ reason: 'http', status: 404 });
    expect(calls).toHaveLength(1);
  });

  it('follows one https redirect for a GET, carrying only its Accept header', async () => {
    const { fetchImpl, calls } = fake(
      new Response(null, { status: 302, headers: { location: 'https://b.example.test/next' } }),
      json({ moved: true }),
    );
    const result = await outboundJson(
      'https://a.example.test/start',
      { headers: { accept: 'application/json', 'x-extra': 'kept off the hop' } },
      { fetchImpl },
    );
    expect(result.json).toEqual({ moved: true });
    expect(calls.map((c) => c.url)).toEqual([
      'https://a.example.test/start',
      'https://b.example.test/next',
    ]);
    expect(calls[1]!.init.headers).toEqual({ accept: 'application/json' });
  });

  it('refuses a redirect to http, a second hop, one with credentials, and any for a POST', async () => {
    const toHttp = fake(
      new Response(null, { status: 301, headers: { location: 'http://b.example.test/' } }),
    );
    expect(
      (await failure(outboundJson('https://a.example.test/', {}, { fetchImpl: toHttp.fetchImpl })))
        .reason,
    ).toBe('redirect');
    const twice = fake(
      new Response(null, { status: 302, headers: { location: 'https://b.example.test/' } }),
      new Response(null, { status: 302, headers: { location: 'https://c.example.test/' } }),
    );
    expect(
      (await failure(outboundJson('https://a.example.test/', {}, { fetchImpl: twice.fetchImpl })))
        .reason,
    ).toBe('redirect');
    expect(twice.calls).toHaveLength(2);
    const creds = fake(
      new Response(null, { status: 302, headers: { location: 'https://user:pw@b.example.test/' } }),
    );
    expect(
      (await failure(outboundJson('https://a.example.test/', {}, { fetchImpl: creds.fetchImpl })))
        .reason,
    ).toBe('redirect');
    const post = fake(
      new Response(null, { status: 307, headers: { location: 'https://b.example.test/' } }),
    );
    const err = await failure(
      outboundJson(
        'https://a.example.test/',
        { method: 'POST', body: `api_key=${KEY}` },
        { fetchImpl: post.fetchImpl },
      ),
    );
    expect(err.reason).toBe('redirect');
    expect(post.calls).toHaveLength(1);
  });

  it('calls only https URLs with no user or password', async () => {
    const { fetchImpl } = fake(json({}));
    for (const url of [
      'http://a.example.test/',
      'https://u:p@a.example.test/',
      'not a url',
      'ftp://a.example.test/',
    ]) {
      expect((await failure(outboundJson(url, {}, { fetchImpl }))).reason, url).toBe('bad-url');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(safeUrl('https://a.example.test/x')?.toString()).toBe('https://a.example.test/x');
    expect(safeUrl('domain/x.com', 'https://rdap.example.test/v1/')?.toString()).toBe(
      'https://rdap.example.test/v1/domain/x.com',
    );
  });

  it('refuses a body that is not JSON', async () => {
    const { fetchImpl } = fake(new Response('<html>oops</html>', { status: 200 }));
    expect((await failure(outboundJson('https://a.example.test/', {}, { fetchImpl }))).reason).toBe(
      'not-json',
    );
  });

  it('never puts the key, the body or the response in an error', async () => {
    const echo = `{"error":"bad key ${KEY}"`;
    for (const answer of [
      new Response(echo, { status: 401 }),
      new Response(echo, { status: 500 }),
      new Response(echo, { status: 200 }),
    ]) {
      const { fetchImpl } = fake(answer, new Response(echo, { status: 500 }));
      const err = await failure(
        outboundJson(
          `https://a.example.test/?q=${KEY}`,
          { method: 'POST', body: `api_key=${KEY}` },
          { fetchImpl, sleep: noSleep },
        ),
      );
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain('a.example.test');
      expect(JSON.stringify(err)).not.toContain(KEY);
    }
  });
});
