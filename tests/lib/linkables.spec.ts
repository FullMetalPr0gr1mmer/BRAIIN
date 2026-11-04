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

  /**
   * A PostgREST stand-in: one answer per table, honouring what the reader asks of `pages` (in,
   * `not in`, order and limit, in the table's own order otherwise, as a heap would), and the
   * filters it was asked for.
   */
  function client(byTable: Record<string, { slug: string; title: unknown }[]>) {
    const asked: { table: string; filters: Record<string, string>; limit: number }[] = [];
    return {
      asked,
      from(table: string) {
        const filters: Record<string, string> = {};
        const entry = { table, filters, limit: 0 };
        let rows = [...(byTable[table] ?? [])];
        let ordered = false;
        const builder = {
          select: () => builder,
          eq: (column: string, value: string) => {
            filters[column] = value;
            return builder;
          },
          in: (column: 'slug', values: string[]) => {
            rows = rows.filter((r) => values.includes(r[column]));
            return builder;
          },
          not: (column: 'slug', op: string, list: string | null) => {
            // `not(column, 'is', null)` (E9's anchors): the rows where it is set.
            if (op === 'is' && list === null) {
              rows = rows.filter((r) => (r as Record<string, unknown>)[column] != null);
              return builder;
            }
            const values = String(list)
              .replace(/^\(|\)$/g, '')
              .split(',');
            rows = rows.filter((r) => !values.includes(r[column]));
            return builder;
          },
          order: () => {
            ordered = true;
            return builder;
          },
          limit: (n: number) => {
            entry.limit = n;
            asked.push(entry);
            // Ordered by the slug (pages, services, projects) or the anchor (sections, E9).
            const key = (r: Record<string, unknown>) => String(r['slug'] ?? r['anchor'] ?? '');
            const out = ordered ? [...rows].sort((a, b) => key(a).localeCompare(key(b))) : rows;
            return Promise.resolve({ data: out.slice(0, n), error: null });
          },
        };
        return builder;
      },
    };
  }

  it('asks for published rows of this tenant only, bounded', async () => {
    const sb = client({});
    await loadLinkables(sb as never, auth);
    expect(sb.asked.map((a) => a.table)).toEqual(['pages', 'pages', 'services', 'portfolio']);
    for (const ask of sb.asked) {
      expect(ask.filters).toEqual({ tenant_id: 't-1', status: 'published' });
      expect(ask.limit).toBeLessThanOrEqual(100);
    }
  });

  // E11 code review CR10: the route pages' titles are read apart from the custom pages, so a
  // hundred custom pages stored ahead of them never crowd a route's own title out of the bound.
  it('a route keeps its page’s title however many custom pages there are', async () => {
    const custom = Array.from({ length: 120 }, (_, i) => ({
      slug: `page-${String(i).padStart(3, '0')}`,
      title: { en: `Page ${i}`, ar: `صفحة ${i}` },
    }));
    const sb = client({
      pages: [...custom, { slug: 'about', title: { en: 'Who we are', ar: 'من نحن' } }],
    });
    const links = await loadLinkables(sb as never, auth);
    expect(links.find((link) => link.href === '/about')?.label.en).toBe('Who we are');
    const pages = links.filter((link) => link.group === 'page' && /^\/page-/.test(link.href));
    expect(pages).toHaveLength(100);
    expect(pages[0]).toEqual({
      href: '/page-000',
      label: { en: 'Page 0', ar: 'صفحة 0' },
      group: 'page',
    });
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
          in: () => builder,
          not: () => builder,
          order: () => builder,
          limit: () => Promise.resolve({ data: null, error: { message: 'denied' } }),
        };
        return builder;
      },
    };
    const links = await loadLinkables(sb as never, auth);
    expect(links.map((link) => link.href)).toEqual(CODE_ROUTES.map((route) => route.href));
  });

  // Admin v2 E9: the anchors an editor gave the shown sections of the published pages.
  it('offers the stored section anchors of the published pages, by their page’s path', async () => {
    const ABOUT = '0f0f0f0f-0000-4000-8000-0000000000a1';
    const CUSTOM = '0f0f0f0f-0000-4000-8000-0000000000a2';
    const sb = client({
      pages: [
        { id: ABOUT, slug: 'about', title: { en: 'Who we are', ar: 'من نحن' } },
        { id: CUSTOM, slug: 'how-we-work', title: { en: 'How we work', ar: 'كيف نشتغل' } },
      ],
      page_sections: [
        { page_id: ABOUT, type: 'textBlock', anchor: 'our-story' },
        { page_id: CUSTOM, type: 'cta', anchor: 'next-step' },
        // a code-anchored kind renders no stored anchor: not offered
        { page_id: ABOUT, type: 'leadership', anchor: 'leaders' },
        // a page that is not published (not among the pages read): not offered
        { page_id: '0f0f0f0f-0000-4000-8000-0000000000ff', type: 'textBlock', anchor: 'draft' },
        // a value the rules refuse: not offered
        { page_id: ABOUT, type: 'textBlock', anchor: 'Main Bit' },
      ] as never,
    });
    const links = await loadLinkables(sb as never, auth);
    const anchors = links.filter((link) => link.href.includes('#') && link.group === 'anchor');
    expect(anchors.slice(CODE_ROUTES.filter((r) => r.group === 'anchor').length)).toEqual([
      // in the anchors' order (the read's)
      {
        href: '/how-we-work#next-step',
        label: { en: 'How we work: #next-step', ar: 'كيف نشتغل: #next-step' },
        group: 'anchor',
      },
      {
        href: '/about#our-story',
        label: { en: 'Who we are: #our-story', ar: 'من نحن: #our-story' },
        group: 'anchor',
      },
    ]);
    for (const link of anchors) expect(isSiteHref(link.href), link.href).toBe(true);
    const read = sb.asked.find((a) => a.table === 'page_sections');
    expect(read?.filters).toEqual({ tenant_id: 't-1', visible: true });
    expect(read?.limit).toBeLessThanOrEqual(100);
  });

  it('reads no section when no page is published', async () => {
    const sb = client({ page_sections: [{ page_id: 'x', type: 'cta', anchor: 'a' }] as never });
    await loadLinkables(sb as never, auth);
    expect(sb.asked.some((a) => a.table === 'page_sections')).toBe(false);
  });
});
