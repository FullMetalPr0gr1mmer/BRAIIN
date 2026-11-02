import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SiteFooter from '@/components/SiteFooter.astro';
import type { FooterNavigation, NavNode } from '@/lib/data/navigation';
import type { Identity } from '@/lib/identity/fallback';
import type { VisibilitySnapshot } from '@/lib/http/visibility';
import { IDENTITY } from './fixtures';
import { normalise } from './harness';

// The footer's settings (Admin v2 E6: U9's four site_profile columns and the navigation
// heading rows, 0122). siteChrome.spec.ts holds the footer with nothing saved to the bytes it
// served before E6 (its snapshot is unchanged); this spec holds what a saved setting changes,
// in both languages: the copyright template, the hidden mailbox, the social icons, the dark
// style and the link columns, with the legal links always there.

const state = vi.hoisted(() => ({
  nav: { columns: [], links: [] } as FooterNavigation,
  /** The navigation read has been started. */
  navAsked: false,
  /** The identity resolves only once the navigation read has started (one round trip). */
  identityWaits: false,
}));
vi.mock('@/lib/data/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFooterNavigation: async () => {
    state.navAsked = true;
    return state.nav;
  },
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  state.nav = { columns: [], links: [] };
  state.navAsked = false;
  state.identityWaits = false;
});

const link = (id: string, href: string, en: string, ar: string, sort = 1): NavNode => ({
  id,
  parent_id: null,
  label: { en, ar },
  href,
  sort_order: sort,
  is_key: false,
  children: [],
});

const withFooter = (footer: Partial<Identity['footer']>, extra: Partial<Identity> = {}) => ({
  ...IDENTITY,
  ...extra,
  footer: { ...IDENTITY.footer, ...footer },
});

async function render(
  locale: 'en' | 'ar',
  identity: Identity = IDENTITY,
  visibility?: VisibilitySnapshot,
) {
  const container = await AstroContainer.create();
  const path = locale === 'ar' ? '/ar/about' : '/about';
  const identityPromise = state.identityWaits
    ? (async () => {
        for (let i = 0; i < 20 && !state.navAsked; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (!state.navAsked) throw new Error('the footer read its menu only after the identity');
        return identity;
      })()
    : Promise.resolve(identity);
  const html = await container.renderToString(SiteFooter, {
    props: { locale },
    request: new Request(`https://www.example.test${path}`),
    locals: { identity: identityPromise, ...(visibility ? { visibility } : {}) } as App.Locals,
  });
  return normalise(html);
}

const footerTag = (html: string) => /<footer\b[^>]*>/.exec(html)?.[0] ?? '';
const copyOf = (html: string) =>
  /<p class="site-footer__copy">([^<]*)<\/p>/.exec(html)?.[1] ?? '(none)';
const LEGAL = ['/privacy', '/terms', '/cookie-policy'];

describe('the footer settings', () => {
  test('nothing saved: the built-in line, the mailbox, no icons, no columns, light', async () => {
    const html = await render('en');
    expect(copyOf(html)).toBe(`© 2026 ${IDENTITY.brandName.en}. ${IDENTITY.location.en}`);
    expect(html).toContain('class="site-footer__mail"');
    expect(html).not.toContain('site-footer__social');
    expect(html).not.toContain('site-footer__cols');
    expect(footerTag(html)).toBe('<footer class="site-footer">');
  });

  test('the copyright template fills {year}, {brand} and {place} per language', async () => {
    const identity = withFooter({
      copyright: { en: '{brand} © {year}, made in {place}', ar: '© {year} {brand} في {place}' },
    });
    expect(copyOf(await render('en', identity))).toBe(
      `${IDENTITY.brandName.en} © 2026, made in ${IDENTITY.location.en}`,
    );
    expect(copyOf(await render('ar', identity))).toBe(
      `© ٢٠٢٦ ${IDENTITY.brandName.ar} في ${IDENTITY.location.ar}`,
    );
  });

  test('the template is text: markup in it is escaped, never drawn', async () => {
    const identity = withFooter({
      copyright: { en: '<b>{brand}</b> & co', ar: '<i>{brand}</i>' },
    });
    const html = await render('en', identity);
    expect(html).toContain(`&lt;b&gt;${IDENTITY.brandName.en}&lt;/b&gt; &amp; co`);
    expect(html).not.toContain('<b>');
  });

  test('"Show the email address" off drops the mailbox, in both languages', async () => {
    const identity = withFooter({ showEmail: false });
    for (const locale of ['en', 'ar'] as const) {
      const html = await render(locale, identity);
      expect(html).not.toContain('site-footer__mail');
      expect(html).not.toContain('mailto:');
    }
  });

  test('"Show social icons" draws the visible accounts as named icon links', async () => {
    const identity = withFooter(
      { showSocial: true },
      {
        socials: [
          {
            network: 'instagram',
            handle: '@studio',
            url: 'https://www.instagram.com/studio',
            visible: true,
          },
          { network: 'x', handle: '@studio', url: 'https://x.com/studio', visible: true },
          {
            network: 'behance',
            handle: '@hidden',
            url: 'https://www.behance.net/hidden',
            visible: false,
          },
        ],
      },
    );
    const html = await render('ar', identity);
    expect(html).toContain(
      '<ul class="site-footer__social" aria-label="حسابات التواصل الاجتماعي">',
    );
    expect(html).toContain('href="https://www.instagram.com/studio"');
    expect(html).toMatch(
      /aria-label="Instagram"[^>]*>\s*<svg viewBox="0 0 24 24" aria-hidden="true">/,
    );
    // A network with no mark is named in words.
    expect(html).toMatch(/aria-label="X">X<\/a>/);
    expect(html).not.toContain('behance.net/hidden');
    // The mailbox stays, beside the icons.
    expect(html).toMatch(/<div class="site-footer__end">\s*<a class="site-footer__mail"/);
  });

  test('"Show social icons" with no account shown draws nothing extra', async () => {
    const html = await render('en', withFooter({ showSocial: true }, { socials: [] }));
    expect(html).not.toContain('site-footer__social');
    expect(html).not.toContain('site-footer__end');
  });

  test('the dark style is one attribute on the footer', async () => {
    const html = await render('en', withFooter({ style: 'dark' }));
    expect(footerTag(html)).toBe('<footer class="site-footer" data-style="dark">');
  });

  test('the columns: a titled nav per column, its links localized, the loose links below', async () => {
    state.nav = {
      columns: [
        {
          id: 'c1',
          label: { en: 'Studio', ar: 'الاستوديو' },
          sort_order: 1,
          links: [link('l1', '/about', 'About', 'من نحن'), link('l2', '/join', 'Join', 'انضم', 2)],
        },
        {
          id: 'c2',
          label: { en: 'Work', ar: 'الأعمال' },
          sort_order: 2,
          links: [link('l3', '/portfolio', 'Our Work', 'أعمالنا')],
        },
      ],
      links: [link('l4', '/contact', 'Contact', 'تواصل معنا')],
    };
    const html = await render('ar');
    expect(html).toContain('<div class="site-footer__cols">');
    expect(html).toMatch(
      /<nav class="site-footer__col" aria-labelledby="footer-col-1">\s*<h2 class="site-footer__heading" id="footer-col-1">\s*الاستوديو\s*<\/h2>/,
    );
    expect(html).toContain('aria-labelledby="footer-col-2"');
    expect(html).toContain('href="/ar/about"');
    expect(html).toContain('href="/ar/join"');
    // The loose link stays in the row under the columns; the fallback menu is not drawn.
    expect(html).toMatch(/<nav aria-label="روابط التذييل">[\s\S]*href="\/ar\/contact"/);
    expect(html).not.toContain('/ar/creative-knowledge');
    for (const href of LEGAL) expect(html).toContain(`href="/ar${href}"`);
  });

  test('columns only: no empty footer navigation, the legal links stay', async () => {
    state.nav = {
      columns: [
        {
          id: 'c1',
          label: { en: 'Studio', ar: 'الاستوديو' },
          sort_order: 1,
          links: [link('l1', '/about', 'About', 'من نحن')],
        },
      ],
      links: [],
    };
    const html = await render('en');
    expect(html).not.toContain('aria-label="Footer navigation"');
    for (const href of LEGAL) expect(html).toContain(`href="${href}"`);
  });

  test('a column whose links are all on pages that are not public is not drawn', async () => {
    state.nav = {
      columns: [
        {
          id: 'c1',
          label: { en: 'Studio', ar: 'الاستوديو' },
          sort_order: 1,
          links: [link('l1', '/about', 'About', 'من نحن')],
        },
      ],
      links: [link('l4', '/contact', 'Contact', 'تواصل معنا')],
    };
    const hidden: VisibilitySnapshot = {
      v: 1,
      builtAt: null,
      pages: { about: { mode: 'hidden', target: null } },
      templates: {},
    };
    const html = await render('en', IDENTITY, hidden);
    expect(html).not.toContain('site-footer__cols');
    expect(html).toContain('href="/contact"');
  });

  test('a column with no link is not authored content: the built-in menu shows', async () => {
    state.nav = {
      columns: [{ id: 'c1', label: { en: 'Empty', ar: 'فارغ' }, sort_order: 1, links: [] }],
      links: [],
    };
    const html = await render('en');
    expect(html).not.toContain('Empty');
    expect(html).toContain('href="/creative-knowledge"');
  });

  test('the identity and the menu are read together (one round trip)', async () => {
    state.identityWaits = true;
    await expect(render('en')).resolves.toContain('site-footer');
  });
});
