import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROLES } from '@/lib/auth/types';
import { barBucket } from '@/lib/admin/charts';
import { mediaPermissionsFor, usageScreensFor } from '@/lib/admin/mediaLibrary';
import { reachableHrefs } from '@/lib/admin/nav';
import {
  meterBucket,
  storageText,
  viewFromUrl,
  viewHref,
} from '@/components/admin/screens/media/libraryState';
import { USAGE_KINDS, USAGE_SCREENS, usageEntries } from '@/components/admin/screens/media/usage';

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

  it('links only what the role’s sidebar opens: SEO projects and services, Developer none', () => {
    const linked = (role: (typeof ROLES)[number]) =>
      usageEntries(usageScreensFor(role), USAGE)
        .filter((e) => e.href !== null)
        .map((e) => e.words);
    expect(linked('seo')).toEqual([
      'Project: desert-campaign',
      'Project (gallery)',
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

  it('a kind it does not know (R5, U10a and U9a add some) is words, no link, no crash', () => {
    const entries = usageEntries(usageScreensFor('admin'), [
      { entityType: 'entity_seo', entityId: ID, label: 'home' },
      { entityType: 'site_profile', entityId: ID, label: null },
    ]);
    expect(entries.map((e) => [e.words, e.href])).toEqual([
      ['Entity seo: home', null],
      ['Site profile', null],
    ]);
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
