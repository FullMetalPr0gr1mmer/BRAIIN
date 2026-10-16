import { describe, expect, it } from 'vitest';
import {
  AdminOrHttpsHref,
  QUICK_ICONS,
  QUICK_LIBRARY_ID,
  QuickActionsSchema,
  QuickCustomItemSchema,
  isAdminOrHttpsHref,
  readQuickActions,
} from '@schemas/dashboard';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { ICON_NAMES } from '@/lib/admin/icons';
import {
  ALL_QUICK_ACTIONS,
  QUICK_DEFAULTS,
  QUICK_LIBRARY,
  libraryFor,
  mayUse,
  quickActionsFor,
} from '@/lib/admin/quickActions';
import { pageFileFor } from '../admin/routes';

// Quick actions (Admin v2 U1; ui.md §8 `quickActions.spec`): a person's own link leads to an
// admin screen or an https address and nowhere else; the library is filtered per role from
// ROLE_CAPS; every library href is a page that exists; the palette's list (F3) is unchanged.

const custom = (href: string) => ({ id: 'c-abcdefgh12', label: 'Mine', href, icon: 'link' });

describe('a person’s own link: /admin… or https://… only', () => {
  it.each([
    '/admin',
    '/admin/',
    '/admin/leads',
    '/admin/leads?stage=new&sort=newest',
    '/admin/analytics?tab=pages',
    'https://drive.google.com/drive/u/0',
    'HTTPS://calendar.example.com/',
    'https://1.2.3.4/x',
  ])('accepts %s', (href) => {
    expect(isAdminOrHttpsHref(href)).toBe(true);
    expect(AdminOrHttpsHref.safeParse(href).success).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:x',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'http://plain.example.com',
    'https://user:pw@x.example',
    'https://user@x.example',
    'https://localhost',
    'https://intranet',
    '/admin/../x',
    '/admin/./x',
    '/administrator',
    '/about',
    'admin/leads',
    '/admin/le ads',
    '/admin/\u202Eleads',
    `https://x.example/${'a'.repeat(300)}`,
    '',
  ])('refuses %j', (href) => {
    expect(isAdminOrHttpsHref(href)).toBe(false);
    expect(QuickCustomItemSchema.safeParse(custom(href)).success).toBe(false);
  });

  it('a label is 1 to 40 characters with no control or format character; the icon is from the list', () => {
    expect(QuickCustomItemSchema.safeParse({ ...custom('/admin'), label: '' }).success).toBe(false);
    expect(
      QuickCustomItemSchema.safeParse({ ...custom('/admin'), label: 'x'.repeat(41) }).success,
    ).toBe(false);
    expect(
      QuickCustomItemSchema.safeParse({ ...custom('/admin'), label: 'a\u202Eb' }).success,
    ).toBe(false);
    expect(
      QuickCustomItemSchema.safeParse({ ...custom('/admin'), label: 'Google Drive' }).success,
    ).toBe(true);
    expect(QuickCustomItemSchema.safeParse({ ...custom('/admin'), icon: 'bomb' }).success).toBe(
      false,
    );
    expect(QuickCustomItemSchema.safeParse({ ...custom('/admin'), id: 'stats' }).success).toBe(
      false,
    );
  });
});

describe('the list: at most 12, at most 8 of the person’s own, each once', () => {
  const own = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...custom('/admin'), id: `c-${'a'.repeat(7)}${i}x` }));

  it('8 own links pass, 9 do not', () => {
    expect(QuickActionsSchema.safeParse(own(8)).success).toBe(true);
    expect(QuickActionsSchema.safeParse(own(9)).success).toBe(false);
  });

  it('12 in all pass, 13 do not', () => {
    const library = QUICK_LIBRARY.slice(0, 4).map((a) => ({ id: a.id }));
    expect(QuickActionsSchema.safeParse([...library, ...own(8)]).success).toBe(true);
    expect(QuickActionsSchema.safeParse([...library, { id: 'stats' }, ...own(8)]).success).toBe(
      false,
    );
  });

  it('an id twice is refused; read back leniently, the second goes', () => {
    expect(QuickActionsSchema.safeParse([{ id: 'stats' }, { id: 'stats' }]).success).toBe(false);
    expect(
      readQuickActions([
        { id: 'stats' },
        { id: 'stats' },
        { id: 'Bad!' },
        'x',
        custom('javascript:x'),
      ]),
    ).toEqual([{ id: 'stats' }]);
  });
});

describe('the library', () => {
  it('ids are unique and of the shape presets store', () => {
    const ids = QUICK_LIBRARY.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(QUICK_LIBRARY_ID);
  });

  it('every library href is a page that exists (the homepage editor falls back to the pages list)', () => {
    for (const action of QUICK_LIBRARY) {
      const href = action.href === 'home' ? '/admin/pages' : action.href;
      if (href === 'site') continue;
      expect(() => pageFileFor(href.split('?')[0]!), href).not.toThrow();
    }
  });

  it('is filtered per role from ROLE_CAPS', () => {
    for (const role of ROLES) {
      for (const action of QUICK_LIBRARY) {
        const holds = action.cap === null || ROLE_CAPS[role][action.cap] === 'full';
        expect(mayUse(role, action), `${role} ${action.id}`).toBe(holds);
        expect(libraryFor(role).includes(action), `${role} ${action.id}`).toBe(holds);
      }
    }
    expect(libraryFor('seo').map((a) => a.id)).not.toContain('open-leads');
    expect(libraryFor('content_creator').map((a) => a.id)).not.toContain('applications');
  });

  it('every role’s default list is library actions the role may use', () => {
    for (const role of ROLES) {
      const allowed = new Set(libraryFor(role).map((a) => a.id));
      for (const id of QUICK_DEFAULTS[role]) expect(allowed.has(id), `${role} ${id}`).toBe(true);
    }
  });

  it('the icons a person may pick are symbols of the sprite', () => {
    for (const icon of QUICK_ICONS) expect(ICON_NAMES as readonly string[]).toContain(icon);
  });

  it('the palette keeps F3’s list: the same eight actions, words and order', () => {
    expect(ALL_QUICK_ACTIONS.map((a) => [a.label, a.href, a.icon, a.cap])).toEqual([
      ['New service', '/admin/services/new', 'plus', 'services.write'],
      ['New project', '/admin/portfolio/new', 'plus', 'portfolio.write'],
      ['New post', '/admin/blog/new', 'plus', 'blog.write'],
      ['New page', '/admin/pages/new', 'plus', 'pages.write'],
      ['New testimonial', '/admin/testimonials/new', 'plus', 'portfolio.write'],
      ['Upload media', '/admin/media/new', 'upload', 'media.write'],
      ['New redirect', '/admin/redirects/new', 'plus', 'redirects.manage'],
      ['Invite a user', '/admin/users', 'users', 'users.manage'],
    ]);
    expect(quickActionsFor('seo').map((a) => a.label)).toEqual(['New redirect']);
  });
});
