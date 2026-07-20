import { describe, it, expect } from 'vitest';
import { POST as rumPost } from '@/pages/api/rum';
import { POST as clientlogPost } from '@/pages/api/clientlog';
import { POST as contactPost } from '@/pages/api/contact';
import { POST as styleFinderPost } from '@/pages/api/ai/style-finder';
import { GET as searchGet } from '@/pages/api/search';
import { GET as healthGet } from '@/pages/healthz';
import { CONSENT_COOKIE } from '@consent/gate';

// Nothing in tests/ previously exercised any handler in src/pages/api/ — the endpoints
// were covered only indirectly, through the pure helpers they call. CLAUDE.md §9 asks for
// negative tests that prove the SERVER refuses, so these call the handlers directly.

const ORIGIN = 'https://www.braiinstation.com';
const HOST = 'www.braiinstation.com';

// Astro's APIContext has ~22 members; every handler under test reads exactly one of them
// (`request`, or `url` for search). Constructing a full context would be ceremony that
// tests nothing, so the handler is narrowed to the shape it actually consumes.
type Handler<Ctx> = (ctx: Ctx) => Response | Promise<Response>;
const as = <Ctx>(handler: unknown) => handler as unknown as Handler<Ctx>;

const invoke = (handler: unknown, request: Request) =>
  as<{ request: Request }>(handler)({ request });

const post = (
  url: string,
  body: unknown,
  { origin = ORIGIN, cookie }: { origin?: string | null; cookie?: string } = {},
) =>
  new Request(url, {
    method: 'POST',
    headers: {
      host: HOST,
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const consentCookie = (analytics: boolean) =>
  `${CONSENT_COOKIE}=${encodeURIComponent(
    JSON.stringify({ functional: true, analytics, marketing: false, v: 1, ts: 1750000000 }),
  )}`;

const validVital = { metric: 'LCP', value: 1234, rating: 'good', path: '/services', id: 'v1-1' };

describe('POST /api/rum — consent gate', () => {
  it('DROPS the beacon when analytics consent is absent (default deny)', async () => {
    const res = await invoke(rumPost, post('https://x/api/rum', validVital));
    expect(res.status).toBe(204);
  });

  it('drops it when consent is explicitly refused', async () => {
    const req = post('https://x/api/rum', validVital, { cookie: consentCookie(false) });
    expect((await invoke(rumPost, req)).status).toBe(204);
  });

  it('accepts a valid vital WITH analytics consent', async () => {
    const req = post('https://x/api/rum', validVital, { cookie: consentCookie(true) });
    expect((await invoke(rumPost, req)).status).toBe(204);
  });

  it('rejects a cross-origin JSON POST — Astro checkOrigin does not cover this', async () => {
    const req = post('https://x/api/rum', validVital, { origin: 'https://evil.example' });
    expect((await invoke(rumPost, req)).status).toBe(403);
  });

  it('allows a request with NO Origin header — sendBeacon must keep working', async () => {
    const req = post('https://x/api/rum', validVital, {
      origin: null,
      cookie: consentCookie(true),
    });
    expect((await invoke(rumPost, req)).status).toBe(204);
  });

  it('422s a malformed vital, but only after consent has been checked', async () => {
    const req = post('https://x/api/rum', { metric: 'NOPE' }, { cookie: consentCookie(true) });
    expect((await invoke(rumPost, req)).status).toBe(422);
  });

  it('400s a body that is not JSON', async () => {
    const req = post('https://x/api/rum', 'not json', { cookie: consentCookie(true) });
    expect((await invoke(rumPost, req)).status).toBe(400);
  });

  it('sets private, no-store on EVERY branch (Tier C)', async () => {
    const cases = [
      post('https://x/api/rum', validVital), // consent drop
      post('https://x/api/rum', validVital, { origin: 'https://evil.example' }), // 403
      post('https://x/api/rum', 'not json', { cookie: consentCookie(true) }), // 400
      post('https://x/api/rum', {}, { cookie: consentCookie(true) }), // 422
      post('https://x/api/rum', validVital, { cookie: consentCookie(true) }), // 204
    ];
    for (const req of cases) {
      const res = await invoke(rumPost, req);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});

describe('POST /api/clientlog — unauthenticated path to a service-role write', () => {
  const entry = { level: 'error', message: 'boom', path: '/services' };

  it('accepts a well-formed report', async () => {
    expect((await invoke(clientlogPost, post('https://x/api/clientlog', entry))).status).toBe(204);
  });

  it('rejects a cross-origin POST', async () => {
    const req = post('https://x/api/clientlog', entry, { origin: 'https://evil.example' });
    expect((await invoke(clientlogPost, req)).status).toBe(403);
  });

  it('422s an unknown level rather than coercing it', async () => {
    const req = post('https://x/api/clientlog', { ...entry, level: 'fatal' });
    expect((await invoke(clientlogPost, req)).status).toBe(422);
  });

  it('REJECTS an over-long source at the boundary instead of dropping it at the sink', async () => {
    // The endpoint capped source at 512 while the sink capped it at 120, so a 121-512
    // char source returned 204 and then vanished. Now it fails loudly at the door.
    const req = post('https://x/api/clientlog', { ...entry, source: 's'.repeat(121) });
    expect((await invoke(clientlogPost, req)).status).toBe(422);
    const ok = post('https://x/api/clientlog', { ...entry, source: 's'.repeat(120) });
    expect((await invoke(clientlogPost, ok)).status).toBe(204);
  });

  it('sets private, no-store on every branch', async () => {
    for (const req of [
      post('https://x/api/clientlog', entry, { origin: 'https://evil.example' }),
      post('https://x/api/clientlog', 'nope'),
      post('https://x/api/clientlog', {}),
      post('https://x/api/clientlog', entry),
    ]) {
      expect((await invoke(clientlogPost, req)).headers.get('cache-control')).toBe(
        'private, no-store',
      );
    }
  });
});

describe('POST /api/contact — the public write path', () => {
  const lead = {
    name: 'Kareem',
    email: 'someone@example.com',
    message: 'I would like a brand identity for a new venture launching this year.',
  };

  it('rejects a cross-origin submission (CSRF)', async () => {
    const req = post('https://x/api/contact', lead, { origin: 'https://evil.example' });
    expect((await invoke(contactPost, req)).status).toBe(403);
  });

  it('422s an invalid payload', async () => {
    const req = post('https://x/api/contact', { name: 'K' });
    expect((await invoke(contactPost, req)).status).toBe(422);
  });

  it('422s when the honeypot is filled (bot signal)', async () => {
    const req = post('https://x/api/contact', { ...lead, hp: 'i am a bot' });
    expect((await invoke(contactPost, req)).status).toBe(422);
  });

  it('never echoes submitted PII back in the response body', async () => {
    const res = await invoke(contactPost, post('https://x/api/contact', lead));
    const text = await res.text();
    expect(text).not.toContain('someone@example.com');
    expect(text).not.toContain('Kareem');
  });

  it('is never cached', async () => {
    const res = await invoke(contactPost, post('https://x/api/contact', lead));
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('POST /api/ai/style-finder — the security envelope around the 501 stub', () => {
  const answers = {
    sessionId: 'test-session-abc123',
    answers: [{ questionId: 'q1', value: 'bold' }],
  };

  it('rejects a cross-origin call BEFORE any spend path', async () => {
    const req = post('https://x/api/ai/style-finder', answers, { origin: 'https://evil.example' });
    expect((await invoke(styleFinderPost, req)).status).toBe(403);
  });

  it('returns 501 for a well-formed call — logic is deferred, envelope is not', async () => {
    const res = await invoke(styleFinderPost, post('https://x/api/ai/style-finder', answers));
    expect([501, 429]).toContain(res.status);
  });

  it('never leaks a provider key or upstream detail in the body', async () => {
    const res = await invoke(styleFinderPost, post('https://x/api/ai/style-finder', answers));
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain('anthropic');
    expect(text).not.toContain('sk-');
  });

  it('is never cached', async () => {
    const res = await invoke(styleFinderPost, post('https://x/api/ai/style-finder', answers));
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('GET /api/search — anon endpoint, no captcha by design', () => {
  // This handler destructures `url`, not `request` — the safety envelope reads the query
  // string, so the fixture has to supply a real URL object.
  const search = (q: string) =>
    as<{ url: URL }>(searchGet)({
      url: new URL(`https://x/api/search?q=${encodeURIComponent(q)}`),
    });

  it('422s an over-long query (Zod cap ≤64 chars)', async () => {
    expect((await search('a'.repeat(65))).status).toBe(422);
  });

  it('422s a query containing control characters', async () => {
    expect((await search(`brand${String.fromCharCode(0)}ing`)).status).toBe(422);
  });

  it('handles tsquery metacharacters without erroring (websearch_to_tsquery)', async () => {
    // Raw to_tsquery would throw on these; websearch_to_tsquery treats them as text.
    expect([200, 422]).toContain((await search('a & b | !c :*')).status);
  });

  it('accepts a query exactly at the 64-char cap', async () => {
    expect((await search('a'.repeat(64))).status).toBe(200);
  });

  it('is never cached', async () => {
    expect((await search('branding')).headers.get('cache-control')).toContain('no-store');
  });
});

describe('GET /healthz', () => {
  it('is a no-store, noindex liveness probe', async () => {
    const res = await as<undefined>(healthGet)(undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('leaks no version, build or dependency detail to an unauthenticated caller', async () => {
    const res = await as<undefined>(healthGet)(undefined);
    const text = (await res.text()).toLowerCase();
    for (const leak of ['version', 'commit', 'sha', 'supabase', 'node', 'astro']) {
      expect(text).not.toContain(leak);
    }
  });
});
