import { describe, expect, it } from 'vitest';
import { SafeHrefSchema } from '@schemas/media';
import { CODE_ROUTES, isHttpsHref, isSiteHref, loadLinkables } from '@/lib/admin/linkables';
import { LEGAL } from '@/lib/legal/content';
import { PAGE_PATHS } from '@/lib/visibility/routes';
import type { AuthContext } from '@/lib/auth/types';

// The link field offers these targets and refuses what the server would refuse. Two
// things are held here: the client rule equals SafeHrefSchema (D3 — the field writes to a
// column that schema guards), and the code routes are the routes this site actually has.

describe('isSiteHref is SafeHrefSchema', () => {
  const inputs = [
    '/',
    '/about',
    '/portfolio/all',
    '/services/logo-design',
    '/contact#inquiry',
    '#apply',
    '#a',
    '',
    ' /about ',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'https://example.com',
    'http://example.com',
    'mailto:hi@example.com',
    '/a/../b',
    '/About',
    '/about?x=1',
    '/about#Inquiry',
    '#1bad',
    '/عربي',
    `/${'a'.repeat(250)}`,
    '/a_b-c/d',
  ];

  for (const href of inputs) {
    it(`agrees on ${JSON.stringify(href)}`, () => {
      expect(isSiteHref(href)).toBe(SafeHrefSchema.safeParse(href).success);
    });
  }

  it('says no to anything that is not a string', () => {
    for (const value of [null, undefined, 7, {}, ['/about']]) expect(isSiteHref(value)).toBe(false);
  });
});

describe('isHttpsHref', () => {
  it('takes https only', () => {
    expect(isHttpsHref('https://example.com/a')).toBe(true);
    expect(isHttpsHref(' https://example.com ')).toBe(true);
    expect(isHttpsHref('http://example.com')).toBe(false);
    expect(isHttpsHref('/about')).toBe(false);
    expect(isHttpsHref('javascript:alert(1)')).toBe(false);
    expect(isHttpsHref('not a url')).toBe(false);
  });

  it('refuses credentials in the URL', () => {
    expect(isHttpsHref('https://user@example.com')).toBe(false);
    expect(isHttpsHref('https://user:pass@example.com')).toBe(false);
  });

  it('says no to anything that is not a string', () => {
    for (const value of [null, undefined, 7, {}]) expect(isHttpsHref(value)).toBe(false);
  });
});

describe('CODE_ROUTES', () => {
  it('offers every link the field could store', () => {
    for (const route of CODE_ROUTES) {
      expect(isSiteHref(route.href), route.href).toBe(true);
      expect(route.label.en.length, route.href).toBeGreaterThan(0);
      expect(route.label.ar.length, route.href).toBeGreaterThan(0);
    }
  });

  it('names every CMS page path, once', () => {
    const hrefs = CODE_ROUTES.map((route) => route.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const path of Object.values(PAGE_PATHS)) expect(hrefs).toContain(path);
    expect(hrefs).toContain('/creative-knowledge');
  });

  it('names the three legal notices, labelled as the notices are titled', () => {
    const legal = CODE_ROUTES.filter((route) => route.group === 'legal');
    expect(legal.map((route) => route.href).sort()).toEqual([
      '/cookie-policy',
      '/privacy',
      '/terms',
    ]);
    // The labels are literals (the notices are 16 KB of copy that must not reach the admin
    // bundle), so they are held to the notices' own titles here.
    const titles: Record<string, 'privacy' | 'terms' | 'cookie'> = {
      '/privacy': 'privacy',
      '/terms': 'terms',
      '/cookie-policy': 'cookie',
    };
    for (const route of legal) {
      const key = titles[route.href]!;
      expect(route.label.en).toBe(LEGAL.en[key].title);
      expect(route.label.ar).toBe(LEGAL.ar[key].title);
    }
  });

  it('the anchors point at pages that exist', () => {
    for (const route of CODE_ROUTES.filter((r) => r.group === 'anchor')) {
      const [path] = route.href.split('#');
      expect(Object.values(PAGE_PATHS) as string[]).toContain(path);
    }
  });
});

describe('loadLinkables', () => {
  const auth = { tenantId: 't-1', role: 'admin' } as unknown as AuthContext;

  /** A PostgREST stand-in: one answer per table, and the filters it was asked for. */
  function client(byTable: Record<string, { slug: string; title: unknown }[]>) {
    const asked: { table: string; filters: Record<string, string>; limit: number }[] = [];
    return {
      asked,
      from(table: string) {
        const filters: Record<string, string> = {};
        const entry = { table, filters, limit: 0 };
        const builder = {
          select: () => builder,
          eq: (column: string, value: string) => {
            filters[column] = value;
            return builder;
          },
          order: () => builder,
          limit: (n: number) => {
            entry.limit = n;
            asked.push(entry);
            return Promise.resolve({ data: byTable[table] ?? [], error: null });
          },
        };
        return builder;
      },
    };
  }

  it('asks for published rows of this tenant only, bounded', async () => {
    const sb = client({});
    await loadLinkables(sb as never, auth);
    expect(sb.asked.map((a) => a.table)).toEqual(['pages', 'services', 'portfolio']);
    for (const ask of sb.asked) {
      expect(ask.filters).toEqual({ tenant_id: 't-1', status: 'published' });
      expect(ask.limit).toBeLessThanOrEqual(100);
    }
  });

  it('adds published services and projects under their public paths', async () => {
    const sb = client({
      services: [{ slug: 'logo-design', title: { en: 'Logo Design', ar: 'تصميم الشعار' } }],
      portfolio: [{ slug: 'hilton-rebrand', title: { en: 'Hilton rebrand', ar: '' } }],
    });
    const links = await loadLinkables(sb as never, auth);
    expect(links).toContainEqual({
      href: '/services/logo-design',
      label: { en: 'Logo Design', ar: 'تصميم الشعار' },
      group: 'service',
    });
    // One language written: the other shows it rather than an empty option.
    expect(links).toContainEqual({
      href: '/portfolio/hilton-rebrand',
      label: { en: 'Hilton rebrand', ar: 'Hilton rebrand' },
      group: 'project',
    });
    for (const link of links) expect(isSiteHref(link.href), link.href).toBe(true);
  });

  it('a published page lends the route its own title', async () => {
    const sb = client({ pages: [{ slug: 'about', title: { en: 'Who we are', ar: 'من نحن' } }] });
    const links = await loadLinkables(sb as never, auth);
    expect(links.find((link) => link.href === '/about')?.label).toEqual({
      en: 'Who we are',
      ar: 'من نحن',
    });
    // A page with no published row keeps its code label.
    expect(links.find((link) => link.href === '/contact')?.label.en).toBe('Contact');
  });

  it('never offers the same href twice, and skips a row with no slug', async () => {
    const sb = client({
      services: [
        { slug: '', title: { en: 'Nameless', ar: '' } },
        { slug: 'logo', title: { en: 'Logo', ar: 'شعار' } },
        { slug: 'logo', title: { en: 'Logo again', ar: '' } },
      ],
      portfolio: [{ slug: 'all', title: { en: 'Reserved', ar: '' } }],
    });
    const links = await loadLinkables(sb as never, auth);
    const hrefs = links.map((link) => link.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.filter((href) => href === '/services/logo')).toHaveLength(1);
    // `/portfolio/all` is the All projects page, already a code route: the row adds nothing.
    expect(links.find((link) => link.href === '/portfolio/all')?.group).toBe('page');
  });

  it('a table the caller cannot read simply contributes nothing', async () => {
    const sb = {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          limit: () => Promise.resolve({ data: null, error: { message: 'denied' } }),
        };
        return builder;
      },
    };
    const links = await loadLinkables(sb as never, auth);
    expect(links.map((link) => link.href)).toEqual(CODE_ROUTES.map((route) => route.href));
  });
});
