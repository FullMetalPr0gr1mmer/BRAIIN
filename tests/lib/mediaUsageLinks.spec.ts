import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROLES } from '@/lib/auth/types';
import { barBucket } from '@/lib/admin/charts';
import { mediaPermissionsFor, usageScreensFor } from '@/lib/admin/mediaLibrary';
import { reachableHrefs } from '@/lib/admin/nav';
import {
  cleanQuery,
  meterBucket,
  storageText,
  viewFromUrl,
  viewHref,
} from '@/components/admin/screens/media/libraryState';
import {
  IN_USE_PENDING_TEXT,
  IN_USE_TEXT,
  USAGE_KINDS,
  USAGE_SCREENS,
  inUseText,
  usageEntries,
  usageWords,
} from '@/components/admin/screens/media/usage';

// The media library's screen logic (Admin v2 U4): "Used in" in words and links, decided per
// role on the server (a link only where the role's sidebar opens the screen); the view and
// its address; the storage meter; and the island's server HTML (no style attribute: the CSP
// has no 'unsafe-inline').

// The drawer's form reaches the rich-text field module; Tiptap is irrelevant here and heavy.
vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const ID = '11111111-1111-4111-8111-111111111111';
const USAGE = [
  { entityType: 'portfolio', entityId: ID, label: 'desert-campaign' },
  { entityType: 'portfolio_media', entityId: ID, label: 'gallery' },
  { entityType: 'client', entityId: ID, label: 'acme' },
  { entityType: 'testimonial', entityId: ID, label: 'q1' },
  { entityType: 'team_member', entityId: ID, label: 'amal' },
  { entityType: 'page_section', entityId: ID, label: 'hero' },
  { entityType: 'discipline', entityId: ID, label: 'branding' },
  { entityType: 'service', entityId: ID, label: 'logo' },
];

describe('"Used in": words and links', () => {
  it('says each kind in words, and links it for Admin', () => {
    const entries = usageEntries(usageScreensFor('admin'), USAGE);
    expect(entries.map((e) => [e.words, e.href])).toEqual([
      ['Project: desert-campaign', `/admin/portfolio/${ID}`],
      ['Project (gallery)', `/admin/portfolio/${ID}`],
      ['Client: acme', `/admin/clients/${ID}`],
      ['Testimonial: q1', `/admin/testimonials/${ID}`],
      ['Team: amal', `/admin/team/${ID}`],
      ['Page section (hero)', `/admin/sections/${ID}`],
      ['Discipline: branding', `/admin/disciplines/${ID}`],
      ['Service: logo', `/admin/services/${ID}`],
    ]);
  });

  it('links only what the role’s sidebar opens: SEO projects, disciplines and services, Developer none', () => {
    const linked = (role: (typeof ROLES)[number]) =>
      usageEntries(usageScreensFor(role), USAGE)
        .filter((e) => e.href !== null)
        .map((e) => e.words);
    // Admin v2 U5: a discipline's page is the Services tab's own, which SEO opens (to reach a
    // service's SEO), so its "Used in" entry links there for SEO too.
    expect(linked('seo')).toEqual([
      'Project: desert-campaign',
      'Project (gallery)',
      'Discipline: branding',
      'Service: logo',
    ]);
    expect(linked('developer')).toEqual([]);
    expect(linked('content_creator')).toHaveLength(USAGE.length);
  });

  it('every link a role is given is a screen its sidebar reaches', () => {
    for (const role of ROLES) {
      const reach = reachableHrefs(role);
      for (const screen of usageScreensFor(role))
        expect(reach, `${role} ${screen}`).toContain(screen);
    }
    expect(USAGE_SCREENS).toEqual([...new Set(Object.values(USAGE_KINDS).map((k) => k.screen))]);
  });

  it('a kind it does not know (R5 adds some) is words, no link, no crash', () => {
    const entries = usageEntries(usageScreensFor('admin'), [
      { entityType: 'site_icon', entityId: ID, label: 'favicon' },
      { entityType: 'mystery_table', entityId: ID, label: null },
    ]);
    expect(entries.map((e) => [e.words, e.href])).toEqual([
      ['Site icon: favicon', null],
      ['Mystery table', null],
    ]);
  });

  it('the site’s icons (media_usage v6, U9) open General settings, for the roles that open it', () => {
    const icons = [
      { entityType: 'site_profile', entityId: ID, label: 'favicon' },
      { entityType: 'site_profile', entityId: ID, label: 'app icon' },
    ];
    for (const role of ['admin', 'developer'] as const) {
      expect(usageEntries(usageScreensFor(role), icons).map((e) => [e.words, e.href])).toEqual([
        ['Favicon (General settings)', '/admin/settings'],
        ['App icon (General settings)', '/admin/settings'],
      ]);
    }
    for (const role of ['content_creator', 'seo'] as const) {
      expect(usageEntries(usageScreensFor(role), icons).map((e) => e.href)).toEqual([null, null]);
    }
  });

  it('a share image (media_usage v5, U10) opens the SEO screen, for the roles that open it', () => {
    const shares = [
      { entityType: 'entity_seo', entityId: ID, label: 'service: logo' },
      { entityType: 'seo_defaults', entityId: ID, label: 'site default' },
    ];
    for (const role of ['admin', 'seo'] as const) {
      expect(usageEntries(usageScreensFor(role), shares).map((e) => [e.words, e.href])).toEqual([
        ['Share image (service: logo)', '/admin/seo'],
        ['Default share image', '/admin/seo?tab=site'],
      ]);
    }
    for (const role of ['content_creator', 'developer'] as const) {
      expect(usageEntries(usageScreensFor(role), shares).map((e) => e.href)).toEqual([null, null]);
    }
  });

  it('a pending change (media_usage v4, 0066) says it is one, and is never a link', () => {
    // Before R5 met U4 the drawer ignored `pending`: a draft naming the picture read
    // "Service: logo" and linked to the live service, which does not use it.
    const pending = (entityType: string, label: string | null) => ({
      entityType,
      entityId: ID,
      label,
      pending: true,
    });
    const entries = usageEntries(usageScreensFor('admin'), [
      { entityType: 'service', entityId: ID, label: 'logo', pending: false },
      pending('service', 'logo'),
      pending('page_section', 'Home hero'),
      pending('team_member', 'amal'),
      pending('entity_seo', 'home'),
      pending('blog_post', 'hello'),
      // 0066's label when the draft has no English label and no slug.
      pending('site_profile', 'pending change'),
      pending('service', null),
    ]);
    expect(entries.map((e) => [e.words, e.href])).toEqual([
      ['Service: logo', `/admin/services/${ID}`],
      ['Pending change to service: logo', null],
      ['Pending change to page section: Home hero', null],
      ['Pending change to team member: amal', null],
      ['Pending change to share image: home', null],
      ['Pending change to blog post: hello', null],
      ['Pending change to site icon', null],
      ['Pending change to service', null],
    ]);
    // A live and a pending reference to one entity are two entries with two keys.
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    for (const entry of entries) expect(entry.words).not.toMatch(/[\u2013\u2014]/);
  });

  it('every kind words a pending change with its own noun', () => {
    for (const [type, kind] of Object.entries(USAGE_KINDS)) {
      expect(usageWords({ entityType: type, entityId: ID, label: 'x', pending: true })).toBe(
        `Pending change to ${kind.noun}: x`,
      );
      expect(kind.noun).toBe(kind.noun.toLowerCase());
    }
  });

  it('Delete’s reason says when a pending change holds the picture', () => {
    const live = { entityType: 'service', entityId: ID, label: 'logo' };
    expect(inUseText([])).toBeNull();
    expect(inUseText([live])).toBe(IN_USE_TEXT);
    expect(inUseText([{ ...live, pending: false }])).toBe(IN_USE_TEXT);
    expect(inUseText([{ ...live, pending: true }])).toBe(IN_USE_PENDING_TEXT);
    expect(inUseText([live, { ...live, pending: true }])).toBe(IN_USE_PENDING_TEXT);
    expect(IN_USE_PENDING_TEXT).not.toMatch(/[\u2013\u2014]/);
  });

  it('what the buttons offer each role follows ROLE_CAPS', () => {
    expect(mediaPermissionsFor('admin')).toMatchObject({ write: true, hardDelete: true });
    expect(mediaPermissionsFor('content_creator')).toMatchObject({
      write: true,
      hardDelete: false,
    });
    expect(mediaPermissionsFor('developer')).toMatchObject({ write: true, hardDelete: false });
    expect(mediaPermissionsFor('seo')).toMatchObject({ write: false, hardDelete: false });
  });
});

describe('the view and its address', () => {
  it('reads every value the URL may carry, held to what the library takes', () => {
    const view = viewFromUrl(new URLSearchParams('q=dunes&tab=videos&alt=missing&page=3'), ID);
    expect(view).toEqual({ tab: 'videos', q: 'dunes', needsAlt: true, offset: 96, openId: ID });
    expect(viewFromUrl(new URLSearchParams('page=0&tab=x&alt=yes'))).toMatchObject({
      tab: 'images',
      needsAlt: false,
      offset: 0,
      openId: null,
    });
    expect(viewFromUrl(new URLSearchParams(`q=${'a'.repeat(80)}`)).q).toHaveLength(64);
    expect(viewFromUrl(new URLSearchParams('q=a%07b')).q).toBe('ab');
    expect(viewFromUrl(new URLSearchParams(), 'not-a-uuid').openId).toBeNull();
  });

  it('a search cut at 64 never splits a character in two (self-review)', () => {
    // 63 letters and an emoji (two UTF-16 units): cut at 64 units, a lone high surrogate was
    // left, which no text column or URL can carry. The cut drops it instead, and stays within
    // the route's 64 (MediaLibraryQuerySchema counts units).
    const emoji = String.fromCodePoint(0x1f600);
    const q = cleanQuery(`${'a'.repeat(63)}${emoji}`);
    expect(q).toBe('a'.repeat(63));
    expect(cleanQuery(`${'a'.repeat(62)}${emoji}`)).toBe(`${'a'.repeat(62)}${emoji}`);
  });

  it('writes the address back without ?upload=1, the drawer in the path', () => {
    const view = viewFromUrl(new URLSearchParams('upload=1&q=dunes&page=2'));
    expect(viewHref(view)).toBe('/admin/media?q=dunes&page=2');
    expect(viewHref({ ...view, openId: ID, q: '', offset: 0 })).toBe(`/admin/media/${ID}`);
    expect(viewHref(viewFromUrl(new URLSearchParams()))).toBe('/admin/media');
  });
});

describe('the storage meter', () => {
  it('says the bucket against the quota in binary units, as the plan counts', () => {
    expect(storageText(214 * 1024 ** 2, 1024 ** 3)).toBe('Storage used: 214 MB of 1 GB');
    expect(storageText(0, 1024 ** 3)).toBe('Storage used: 0 KB of 1 GB');
  });

  it('its bar bucket is charts.ts’s rule (restated to keep charts out of the browser)', () => {
    for (const [v, m] of [
      [0, 100],
      [1, 1000],
      [214, 1024],
      [99, 100],
      [5, 0],
      [200, 100],
      [Number.NaN, 10],
    ]) {
      expect(meterBucket(v!, m!), `${v}/${m}`).toBe(barBucket(v!, m!));
    }
  });
});

describe('the island’s server HTML', () => {
  it(
    'renders without a style attribute, the drawer open on a deep link',
    { timeout: 60_000 },
    async () => {
      const { default: MediaLibrary } =
        await import('@/components/admin/screens/media/MediaLibrary');
      const row = {
        id: ID,
        kind: 'image',
        provider: 'static',
        storage_path: 'stills/work/p0.jpg',
        alt: { en: 'A frame', ar: '' },
        width: 1600,
        height: 1200,
        created_at: '2026-10-01T09:00:00Z',
        thumb_url: '/_astro/p0.jpg',
        preview_url: '/_astro/p0.jpg',
        version: 1,
      };
      const html = renderToStaticMarkup(
        createElement(MediaLibrary, {
          permissions: mediaPermissionsFor('admin'),
          view: viewFromUrl(new URLSearchParams(), ID),
          initial: { total: 1, rows: [row] },
          stats: {
            assets: 1,
            bytes: 1000,
            quotaBytes: 1024 ** 3,
            uploadsReady: true,
            canUpload: true,
          },
          openRow: row,
        }),
      );
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).toContain('Search media');
      expect(html).toContain('Choose images');
      expect(html).toContain('A frame, 1,600 by 1,200, No Arabic alt');
      expect(html).toContain('<dialog');
      expect(html).toContain('Used in');
      // Not set up: no dropzone, the words instead.
      const off = renderToStaticMarkup(
        createElement(MediaLibrary, {
          permissions: mediaPermissionsFor('content_creator'),
          view: viewFromUrl(new URLSearchParams()),
          initial: { total: 0, rows: [] },
          stats: {
            assets: 0,
            bytes: 0,
            quotaBytes: 1024 ** 3,
            uploadsReady: false,
            canUpload: false,
          },
        }),
      );
      expect(off).toContain('Uploads are not set up yet.');
      expect(off).not.toContain('Choose images');
      expect(off).toContain('No pictures yet.');
    },
  );
});
