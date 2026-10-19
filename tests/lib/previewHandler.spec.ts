import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/types';
import { contentClient } from '@/lib/data/source';
import { handlePreview, type PreviewDeps } from '@/lib/http/preview';
import { clearVisibilityMemo, VISIBILITY_KV_KEY } from '@/lib/http/visibility';
import { PREVIEW_COPY } from '@/lib/preview/report';
import { escapeHtml, VISIBILITY_COPY } from '@/lib/preview/ribbon';
import { withPageAccess } from '@/lib/visibility/scope';
import {
  draft,
  fakeStaffClient,
  fixtureTables,
  ID,
  session,
  TENANT,
} from '../fixtures/previewDataset';
import { __kv } from '../stubs/cloudflare-workers';

// The `/admin/preview/**` branch (Admin v2 R9): src/middleware.ts after its session gate,
// then src/lib/http/preview.ts. Driven through the real middleware with the session mocked
// and the person's client a fake staff client (tests/fixtures/previewDataset.ts), and the
// handler alone for what the middleware cannot reach (a page-access scope, a bad method).

const state = vi.hoisted(() => ({
  ctx: null as AuthContext | null,
  client: null as unknown,
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
type Handler = (context: unknown, next: Next) => Promise<Response>;
const run = onRequest as unknown as Handler;

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const TIER_A = 'public, s-maxage=31536000, stale-while-revalidate=86400';

function context(path: string, routePattern = '/admin/preview/[...path]', method = 'GET') {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url, { method }),
    url,
    routePattern,
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

/** A `next` that renders like a public page: it reads services through the content seam. */
function publicPage(read = true) {
  const calls: unknown[] = [];
  const next: Next = async (payload) => {
    calls.push(payload);
    let titles: string[] = [];
    if (read && payload !== undefined) {
      const { data } = await contentClient()
        .from('services')
        .select('id,title')
        .eq('status', 'published');
      titles = ((data ?? []) as { title: { en: string } }[]).map((r) => r.title.en);
    }
    return new Response(
      `<!doctype html><html><head><title>t</title></head><body class="pg"><main>${titles.join('|')}</main></body></html>`,
      {
        status: 200,
        headers: { ...HTML, 'cache-control': TIER_A, 'cache-tag': 'route:services,tenant:default' },
      },
    );
  };
  return { next, calls };
}

function signIn(role: AuthContext['role'] | 'sales' = 'admin', extra: Partial<AuthContext> = {}) {
  const fake = fakeStaffClient({ ...fixtureTables(), content_drafts: [] });
  state.client = fake.client;
  state.ctx = session(role as AuthContext['role'], extra);
  return fake;
}

beforeEach(() => {
  state.ctx = null;
  state.client = null;
  state.logs.length = 0;
  __kv.clear();
  clearVisibilityMemo();
});

const csp = (res: Response) => res.headers.get('content-security-policy') ?? '';

describe('the preview through the middleware', () => {
  it('renders the public route by rewrite, inside the scope, with the ribbon, private and noindex', async () => {
    signIn('admin');
    const { next, calls } = publicPage();
    const res = await run(context('/admin/preview/services?x=1'), next);
    expect(calls).toEqual(['/services?x=1']);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-pv-ribbon');
    expect(html).toContain(escapeHtml(PREVIEW_COPY.ok.none));
    expect(html.indexOf('data-pv-ribbon')).toBeGreaterThan(html.indexOf('<body class="pg">'));
    expect(html).toContain('<link rel="stylesheet" href="/styles/preview.css" /></head>');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0, must-revalidate');
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(csp(res)).toContain("form-action 'none'");
    expect(csp(res)).toMatch(/frame-src 'self' /);
    expect(csp(res)).toContain('nonce-');
  });

  it('reads through the overlay: a pending change shows, the live site is untouched', async () => {
    const fake = fakeStaffClient({
      ...fixtureTables(),
      content_drafts: [
        draft('service', 'update', ID.sPub, { title: { en: 'Pending title', ar: 'عنوان' } }),
      ],
    });
    state.client = fake.client;
    state.ctx = session('content_creator');
    const res = await run(context('/admin/preview/services'), publicPage().next);
    const html = await res.text();
    expect(html).toContain('Pending title');
    expect(html).toContain(escapeHtml(PREVIEW_COPY.ok.one));
    expect(fake.selects['services']?.length).toBeGreaterThan(0);
  });

  it('the Arabic twin renders the Arabic route and links back to English', async () => {
    signIn('seo');
    const { next, calls } = publicPage();
    const html = await (await run(context('/admin/preview/ar/about'), next)).text();
    expect(calls).toEqual(['/ar/about']);
    expect(html).toContain('href="/admin/preview/about"');
  });

  it('the twin link keeps the `only` selection (the bridge does not rewrite it)', async () => {
    signIn('seo');
    const only = '0d000000-0000-4000-8000-000000000001';
    const { next } = publicPage();
    const html = await (await run(context(`/admin/preview/ar/about?only=${only}`), next)).text();
    expect(html).toContain(`href="/admin/preview/about?only=${only}"`);
  });

  it('with no session it is the sign-in redirect, and nothing renders', async () => {
    const { next, calls } = publicPage();
    const res = await run(context('/admin/preview/about'), next);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/admin\/login\?next=/);
    expect(calls).toEqual([]);
  });

  it('refuses an inactive session and a role that reads no area (Sales), reading nothing', async () => {
    for (const who of [() => signIn('admin', { isActive: false }), () => signIn('sales')]) {
      const fake = who();
      const { next, calls } = publicPage();
      const res = await run(context('/admin/preview/about'), next);
      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
      expect(fake.calls).toEqual([]);
    }
  });

  it('a path that is not a Tier A page falls through to the preview 404 route (no rewrite)', async () => {
    signIn('developer');
    for (const path of [
      '/admin/preview/sitemap.xml',
      '/admin/preview/api/contact',
      '/admin/preview/services/a/b',
      '/admin/preview/creative-knowledge/rss.xml',
      '/admin/preview/services/x%2Fy',
      '/admin/preview/services/x%5Cy',
    ]) {
      const { next, calls } = publicPage();
      await run(context(path), next);
      expect(calls, path).toEqual([undefined]);
    }
  });

  it('a malformed `only` selection is a 400, before anything is read', async () => {
    const fake = signIn('admin');
    const { next, calls } = publicPage();
    const res = await run(context('/admin/preview/about?only=nope'), next);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('an untrusted render (no read through the overlay) says so and is logged once, names only', async () => {
    signIn('admin');
    const res = await run(context('/admin/preview/privacy'), publicPage(false).next);
    const html = await res.text();
    expect(html).toContain('data-state="untrusted"');
    expect(html).toContain(escapeHtml(PREVIEW_COPY.reasons['no-reads']));
    expect(state.logs).toHaveLength(1);
    expect(JSON.stringify(state.logs[0])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('a redirect the public page answers stays inside the preview, the selection kept', async () => {
    signIn('admin');
    const only = '0d000000-0000-4000-8000-000000000001';
    const next: Next = async () =>
      new Response(null, { status: 301, headers: { location: '/services/logo' } });
    const res = await run(context(`/admin/preview/services/branding?only=${only}`), next);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`/admin/preview/services/logo?only=${only}`);
  });

  it('a hidden page renders for staff with a line saying visitors cannot open it', async () => {
    signIn('admin');
    __kv.set(
      VISIBILITY_KV_KEY,
      JSON.stringify({
        v: 1,
        builtAt: null,
        pages: { about: { mode: 'hidden' } },
        templates: {},
        tenant: TENANT,
      }),
    );
    const { next, calls } = publicPage();
    const html = await (await run(context('/admin/preview/about'), next)).text();
    expect(calls).toEqual(['/about']);
    expect(html).toContain(escapeHtml(VISIBILITY_COPY.hide));
  });

  it('a page behind a password shows visitors their prompt, and renders nothing behind it', async () => {
    const fake = signIn('admin');
    __kv.set(
      VISIBILITY_KV_KEY,
      JSON.stringify({
        v: 1,
        builtAt: null,
        pages: { about: { mode: 'password', id: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', pv: 1 } },
        templates: {},
        tenant: TENANT,
      }),
    );
    const { next, calls } = publicPage();
    const res = await run(context('/admin/preview/about'), next);
    const html = await res.text();
    expect(calls).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(html).toContain('action="/api/page-access"');
    expect(html).toContain(escapeHtml(VISIBILITY_COPY.password));
    expect(csp(res)).toContain("form-action 'none'");
  });

  it('a public page keeps its own headers: no same-origin framing, forms allowed, no ribbon', async () => {
    const { next } = publicPage(false);
    const res = await run(context('/about', '/about'), next);
    expect(csp(res)).not.toMatch(/frame-src 'self'/);
    expect(csp(res)).toContain("form-action 'self'");
    expect(res.headers.get('cache-tag')).toBe('route:services,tenant:default');
    expect(await res.text()).not.toContain('pv-ribbon');
  });

  it('every other admin page may frame the preview; none is a preview render', async () => {
    signIn('admin');
    const res = await run(
      context('/admin/pages', '/admin/pages'),
      async () => new Response('<html><body>pages</body></html>', { headers: HTML }),
    );
    expect(csp(res)).toMatch(/frame-src 'self' /);
    expect(csp(res)).toContain("form-action 'self'");
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('the handler alone', () => {
  const deps = (over: Partial<PreviewDeps> = {}): PreviewDeps => ({
    render: async () => new Response('<html><body></body></html>', { headers: HTML }),
    fallthrough: async () => new Response('404', { status: 404 }),
    snapshot: async () => ({ v: 1, builtAt: null, pages: {}, templates: {} }),
    log: async () => true,
    ...over,
  });
  const ctx = (method = 'GET') => {
    const fake = fakeStaffClient({ ...fixtureTables(), content_drafts: [] });
    const url = new URL('https://www.example.test/admin/preview/about');
    return {
      request: new Request(url, { method }),
      url,
      nonce: 'n',
      locals: { session: session('admin'), supabase: fake.client },
    };
  };

  it('answers GET and HEAD only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const { response, rendered } = await handlePreview(ctx(method), deps());
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(rendered).toBe(false);
    }
  });

  it('refuses inside a page-access scope (U14b reads live sections there)', async () => {
    const render = vi.fn(deps().render);
    const { response } = await withPageAccess({ pageId: ID.sPub, tenantId: TENANT }, () =>
      handlePreview(ctx(), deps({ render })),
    );
    expect(response.status).toBe(403);
    expect(render).not.toHaveBeenCalled();
  });

  it('a HEAD renders with no body to splice', async () => {
    const { response, rendered } = await handlePreview(
      ctx('HEAD'),
      deps({ render: async () => new Response(null, { headers: HTML }) }),
    );
    expect(rendered).toBe(true);
    expect(response.body).toBeNull();
  });
});
