import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema, ConsentRecordSchema } from '@schemas/analytics';
import { ClientLogSchema } from '@schemas/clientlog';
import { LeadInputSchema } from '@schemas/lead';
import { StyleFinderInputSchema } from '@schemas/styleFinder';
import { WebVitalSchema } from '@schemas/webvitals';
import { PUBLIC_API_BODY_LIMIT } from '@/lib/auth/bodyLimit';
import { clearVisibilityMemo } from '@/lib/http/visibility';
import { __kv } from '../stubs/cloudflare-workers';

// The public endpoints' body cap (H14, src/lib/auth/bodyLimit.ts PUBLIC_API_BODY_LIMIT): the
// middleware refuses a write to a public /api/* route over 128 KB before any handler reads it,
// because those handlers call request.json() with no cap of their own and zod 3 still parses
// every item of an over-long array (GHSA-mrhx-c7xc-m3w5, EXC-013). Two halves: the cap never
// refuses a body a public schema accepts (each worst case built and measured), and the
// middleware enforces it by the route Astro matched, declared length or streamed.

vi.mock('@/lib/http/maintenanceBypass', () => ({ staffMayBypass: async () => false }));
vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => ({}),
  clearSessionCookies: () => undefined,
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/auth/context', () => ({
  resolveAuthContext: async () => ({ ctx: null, revoke: false }),
}));

const { onRequest } = await import('@/middleware');

type Next = (payload?: unknown) => Promise<Response>;
type Handler = (context: unknown, next: Next) => Promise<Response>;
const run = onRequest as unknown as Handler;

// A character JSON.stringify escapes to six bytes (\u0001): the most a free-text character of
// these schemas can weigh on the wire.
const E = String.fromCharCode(1);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('the cap never refuses a body a public schema accepts', () => {
  // A 254-character address zod's email check takes.
  const email = `${'a'.repeat(64)}@${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(61)}.com`;
  const worst = {
    contact: [
      LeadInputSchema,
      {
        kind: 'contact',
        locale: 'ar',
        name: E.repeat(120),
        company: E.repeat(120),
        email,
        phone: E.repeat(32),
        message: E.repeat(5000),
        serviceOfInterest: 'a'.repeat(120),
        disciplineOfInterest: 'a'.repeat(64),
        timelineText: E.repeat(120),
        consentMarketing: true,
        hp: '',
        // The schema bounds no captcha token; a real one is a few KB at most.
        captchaToken: 'x'.repeat(4096),
      },
    ],
    'style-finder': [
      StyleFinderInputSchema,
      {
        sessionId: 'a'.repeat(64),
        answers: Array.from({ length: 40 }, () => ({
          questionId: E.repeat(64),
          value: E.repeat(280),
        })),
      },
    ],
    clientlog: [
      ClientLogSchema,
      {
        level: 'error',
        message: E.repeat(2000),
        source: E.repeat(120),
        line: Number.MAX_SAFE_INTEGER,
        col: Number.MAX_SAFE_INTEGER,
        path: E.repeat(2048),
      },
    ],
    rum: [
      WebVitalSchema,
      {
        metric: 'LCP',
        value: Number.MAX_VALUE,
        rating: 'needs-improvement',
        path: E.repeat(2048),
        id: E.repeat(64),
      },
    ],
    analytics: [
      AnalyticsEventSchema,
      {
        type: 'service_interest',
        path: `/${'a'.repeat(511)}`,
        locale: 'ar',
        sessionId: 'a'.repeat(64),
        props: { discipline: 'a'.repeat(64) },
      },
    ],
    consent: [
      ConsentRecordSchema,
      {
        categories: { functional: true, analytics: true, marketing: true },
        policyVersion: E.repeat(20),
        action: 'withdraw',
      },
    ],
  } as const;

  it.each(Object.entries(worst))('%s: its largest valid body fits', (_, [schema, body]) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(bytes(body)).toBeLessThanOrEqual(PUBLIC_API_BODY_LIMIT);
  });

  it('is 128 KB because the Style-Finder worst case is over 64', () => {
    expect(bytes(worst['style-finder'][1])).toBeGreaterThan(64 * 1024);
    expect(PUBLIC_API_BODY_LIMIT).toBe(128 * 1024);
  });
});

function post(
  path: string,
  routePattern: string,
  opts: { declared?: string; size?: number; streamed?: boolean; method?: string },
) {
  const url = new URL(`https://www.example.test${path}`);
  const payload = 'x'.repeat(opts.size ?? 2);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.declared !== undefined) headers['content-length'] = opts.declared;
  const body = opts.streamed
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      })
    : payload;
  return {
    request: new Request(url, {
      method: opts.method ?? 'POST',
      headers,
      body,
      duplex: 'half',
    } as RequestInit),
    url,
    routePattern,
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

function handler() {
  const calls: unknown[] = [];
  const next: Next = async (payload) => {
    calls.push(payload);
    return new Response(null, { status: 204 });
  };
  return { next, calls };
}

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
});

const PUBLIC_ROUTES = [
  '/api/contact',
  '/api/consent',
  '/api/rum',
  '/api/analytics',
  '/api/clientlog',
  '/api/ai/style-finder',
];
const OVER = String(PUBLIC_API_BODY_LIMIT + 1);

describe('the middleware enforces it', () => {
  it.each(PUBLIC_ROUTES)(
    '%s: a declared length over the cap is a 413, never read',
    async (route) => {
      const { next, calls } = handler();
      const res = await run(post(route, route, { declared: OVER }), next);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ ok: false, error: 'too-large' });
      expect(res.headers.get('strict-transport-security')).not.toBeNull();
      expect(
        res.headers.get('content-security-policy') ??
          res.headers.get('content-security-policy-report-only'),
      ).not.toBeNull();
      expect(calls).toHaveLength(0);
    },
  );

  it('a declared length at the cap reaches the handler', async () => {
    const { next, calls } = handler();
    const res = await run(
      post('/api/contact', '/api/contact', { declared: String(PUBLIC_API_BODY_LIMIT) }),
      next,
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
  });

  it('a streamed body (no length) is counted, and refused once past the cap', async () => {
    const over = handler();
    const refused = await run(
      post('/api/rum', '/api/rum', { streamed: true, size: PUBLIC_API_BODY_LIMIT + 1 }),
      over.next,
    );
    expect(refused.status).toBe(413);
    expect(over.calls).toHaveLength(0);

    const under = handler();
    const passed = await run(
      post('/api/rum', '/api/rum', { streamed: true, size: 1024 }),
      under.next,
    );
    expect(passed.status).toBe(204);
    expect(under.calls).toHaveLength(1);
  });

  it.each(['/api/apply', '/api/hooks/notify-lead', '/api/page-access'])(
    '%s keeps its own limit: the middleware leaves its body to it',
    async (route) => {
      const { next, calls } = handler();
      const res = await run(post(route, route, { declared: String(5 * 1024 * 1024) }), next);
      expect(res.status).toBe(204);
      expect(calls).toHaveLength(1);
    },
  );

  it('by the route Astro matched: a path spelled as an exempt one but routed elsewhere is capped', async () => {
    const { next, calls } = handler();
    const res = await run(post('/api/apply', '/api/contact', { declared: OVER }), next);
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('a read is not bounded here (no body), and the admin API is the private branch’s', async () => {
    const read = handler();
    const res = await run(
      {
        ...post('/api/search?q=logo', '/api/search', {}),
        request: new Request('https://www.example.test/api/search?q=logo'),
      },
      read.next,
    );
    expect(res.status).toBe(204);
    // Signed out, an admin write is a 401 before any body is read, never this 413.
    const admin = handler();
    const refused = await run(
      post('/api/admin/leads', '/api/admin/leads', { declared: OVER }),
      admin.next,
    );
    expect(refused.status).not.toBe(413);
    expect(admin.calls).toHaveLength(0);
  });
});
