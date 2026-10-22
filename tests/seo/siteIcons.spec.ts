import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkImageRequest, ICON_WIDTHS, ICON_FORMAT } from '@/lib/http/imageGuard';
import { IDENTITY_FALLBACK, type Identity } from '@/lib/identity/fallback';
import { buildOrganizationSchema } from '@/lib/seo/jsonld';
import { APPLE_TOUCH_SIZE, FAVICON_SIZES, MANIFEST_ICON_SIZES } from '@/lib/seo/siteIcons';
import { PUBLIC_SUPABASE_URL } from '../stubs/astro-env-client';

// The site's public side of General settings v2 (Admin v2 U9): the icons through a narrow
// `/_image` rule, read in a separate query that fails soft (never the identity's fallback),
// the manifests in both languages, and the Organization JSON-LD's telephone, hasMap and slogan,
// with hidden social accounts out of sameAs (D8).

const TENANT = '11111111-1111-4111-8111-111111111111';
const ICON_ID = '22222222-2222-4222-8222-222222222222';
const key = (id: string, w: number, h: number) => `${TENANT}/${id}_${w}x${h}.webp`;
const href = (w: number, h: number) =>
  `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${key(ICON_ID, w, h)}`;
const ask = (params: Record<string, string>) =>
  checkImageRequest(new URLSearchParams(params), new Map()).ok;

describe('the /_image icon rule: an upload, square, PNG, at a listed size only', () => {
  it('admits each listed size of a square upload as PNG', () => {
    for (const size of ICON_WIDTHS) {
      expect(
        ask({ href: href(512, 512), w: String(size), h: String(size), f: 'png' }),
        String(size),
      ).toBe(true);
    }
    expect(ICON_FORMAT).toBe('png');
  });

  it('refuses everything else', () => {
    // a size that is not an icon size
    expect(ask({ href: href(512, 512), w: '400', h: '400', f: 'png' })).toBe(false);
    // not square
    expect(ask({ href: href(512, 512), w: '32', h: '33', f: 'png' })).toBe(false);
    // a picture that is not square
    expect(ask({ href: href(600, 400), w: '32', h: '21', f: 'png' })).toBe(false);
    expect(ask({ href: href(600, 400), w: '32', h: '32', f: 'png' })).toBe(false);
    // bigger than the picture
    expect(ask({ href: href(256, 256), w: '512', h: '512', f: 'png' })).toBe(false);
    // an icon size in another format is the ordinary rule's (32 is not a listed width)
    expect(ask({ href: href(512, 512), w: '32', h: '32', f: 'webp' })).toBe(false);
    // a bundled asset never takes the icon rule
    const bundled = new Map([['/_astro/logo.png', { width: 512, height: 512 }]]);
    expect(
      checkImageRequest(
        new URLSearchParams({ href: '/_astro/logo.png', w: '32', h: '32', f: 'png' }),
        bundled,
      ).ok,
    ).toBe(false);
    // an extra parameter
    expect(ask({ href: href(512, 512), w: '32', h: '32', f: 'png', q: '80' })).toBe(false);
  });

  it('every size the head and the manifests ask for is listed', () => {
    for (const size of [...FAVICON_SIZES, APPLE_TOUCH_SIZE, ...MANIFEST_ICON_SIZES]) {
      expect(ICON_WIDTHS.has(size), String(size)).toBe(true);
    }
  });
});

// ── The icons' read ────────────────────────────────────────────────────────────────────

const media = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as { message: string } | null,
  calls: [] as unknown[][],
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/source', () => ({
  contentClient: () => ({
    from: (table: string) => ({
      select: () => ({
        in: async (column: string, ids: unknown[]) => {
          media.calls.push([table, column, ids]);
          return { data: media.error ? null : media.rows, error: media.error };
        },
      }),
    }),
  }),
}));

const { readSiteIcons } = await import('@/lib/data/siteProfile');

const upload = (id: string, w: number, h: number, provider = 'storage') => ({
  id,
  kind: 'image',
  provider,
  storage_path: provider === 'storage' ? key(id, w, h) : `stills/x/${id}.jpg`,
  width: w,
  height: h,
  alt: null,
  stream_uid: null,
});

const withIcons = (favicon: string | null, appIcon: string | null): Identity => ({
  ...IDENTITY_FALLBACK,
  faviconMediaId: favicon,
  appIconMediaId: appIcon,
});

beforeEach(() => {
  media.rows = [];
  media.error = null;
  media.calls = [];
});

describe('readSiteIcons: one read, and it fails soft', () => {
  it('no icon set: no read at all', async () => {
    expect(await readSiteIcons(IDENTITY_FALLBACK)).toEqual({ favicon: null, appIcon: null });
    expect(media.calls).toEqual([]);
  });

  it('a square upload of at least 512 px is an icon', async () => {
    const APP = '33333333-3333-4333-8333-333333333333';
    media.rows = [upload(ICON_ID, 512, 512), upload(APP, 1024, 1024)];
    const icons = await readSiteIcons(withIcons(ICON_ID, APP));
    expect(icons.favicon?.id).toBe(ICON_ID);
    expect(icons.appIcon?.width).toBe(1024);
    expect(media.calls).toEqual([['media_assets', 'id', [ICON_ID, APP]]]);
  });

  it('one read for one picture used twice', async () => {
    media.rows = [upload(ICON_ID, 512, 512)];
    await readSiteIcons(withIcons(ICON_ID, ICON_ID));
    expect(media.calls[0]![2]).toEqual([ICON_ID]);
  });

  it('a picture that is not square, too small, or not an upload is no icon', async () => {
    media.rows = [upload(ICON_ID, 600, 512)];
    expect((await readSiteIcons(withIcons(ICON_ID, null))).favicon).toBeNull();
    media.rows = [upload(ICON_ID, 256, 256)];
    expect((await readSiteIcons(withIcons(ICON_ID, null))).favicon).toBeNull();
    media.rows = [upload(ICON_ID, 512, 512, 'static')];
    expect((await readSiteIcons(withIcons(ICON_ID, null))).favicon).toBeNull();
    media.rows = [];
    expect((await readSiteIcons(withIcons(ICON_ID, null))).favicon).toBeNull();
  });

  it('an error is no icons, never a throw (the brand on the page is untouched)', async () => {
    media.error = { message: 'permission denied' };
    expect(await readSiteIcons(withIcons(ICON_ID, ICON_ID))).toEqual({
      favicon: null,
      appIcon: null,
    });
  });
});

describe('the identity read stays one query with no media embed (a media slip never blanks the brand)', () => {
  it('SITE_PROFILE_COLUMNS names no embed', async () => {
    const { SITE_PROFILE_COLUMNS } = await import('@/lib/data/siteProfile');
    expect(SITE_PROFILE_COLUMNS).not.toContain('(');
    expect(SITE_PROFILE_COLUMNS).toContain('favicon_media_id');
  });
});

// ── The manifests ──────────────────────────────────────────────────────────────────────

describe('the web app manifests (/manifest.webmanifest, /ar/manifest.webmanifest)', () => {
  const locals = (identity: Identity, icons = { favicon: null, appIcon: null }) =>
    ({ identity: Promise.resolve(identity), siteIcons: Promise.resolve(icons) }) as never;

  it('in English and in Arabic: name, tagline, direction, scope, browser display', async () => {
    const { webManifest } = await import('@/lib/seo/manifest');
    const identity = {
      ...IDENTITY_FALLBACK,
      tagline: { en: 'From the brain to the real world', ar: 'من الفكرة إلى الواقع' },
    };
    expect(await webManifest(locals(identity), 'en')).toMatchObject({
      name: 'Braiin Statiion',
      short_name: 'Braiin Statiion',
      description: 'From the brain to the real world',
      lang: 'en',
      dir: 'ltr',
      start_url: '/',
      scope: '/',
      display: 'browser',
      icons: [],
    });
    expect(await webManifest(locals(identity), 'ar')).toMatchObject({
      name: 'بريّن ستيشن',
      description: 'من الفكرة إلى الواقع',
      lang: 'ar',
      dir: 'rtl',
      start_url: '/ar/',
      scope: '/ar/',
    });
    expect(await webManifest(locals(IDENTITY_FALLBACK), 'en')).not.toHaveProperty('description');
  });

  it('answers 200 with no icon, as JSON a browser reads, cached and tagged like llms.txt', async () => {
    const { manifestResponse } = await import('@/lib/seo/manifest');
    const res = await manifestResponse({ locals: locals(IDENTITY_FALLBACK) } as never, 'en');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('cache-tag')).toBe('route:manifest,locale:en,site:identity,media:all');
    expect(JSON.parse(await res.text()).icons).toEqual([]);
  });

  it('the two routes answer their language', () => {
    expect(readFileSync('src/pages/manifest.webmanifest.ts', 'utf8')).toContain(
      "manifestResponse(context, 'en')",
    );
    expect(readFileSync('src/pages/ar/manifest.webmanifest.ts', 'utf8')).toContain(
      "manifestResponse(context, 'ar')",
    );
  });
});

// ── The Organization node ──────────────────────────────────────────────────────────────

describe('Organization JSON-LD (Admin v2 U9)', () => {
  const SITE = 'https://www.example.test';

  it('a site that set none of the new fields emits the node it always did', () => {
    const node = buildOrganizationSchema(SITE, IDENTITY_FALLBACK, 'en');
    expect(node).not.toHaveProperty('slogan');
    expect(node).not.toHaveProperty('telephone');
    expect(node).not.toHaveProperty('hasMap');
    expect(node['sameAs']).toHaveLength(IDENTITY_FALLBACK.socials.length);
  });

  it('slogan in the page’s language, telephone in E.164, hasMap', () => {
    const identity: Identity = {
      ...IDENTITY_FALLBACK,
      tagline: { en: 'Brain to world', ar: 'من الفكرة' },
      phoneE164: '+966500000001',
      mapUrl: 'https://maps.app.goo.gl/abc',
    };
    expect(buildOrganizationSchema(SITE, identity, 'en')).toMatchObject({
      slogan: 'Brain to world',
      telephone: '+966500000001',
      hasMap: 'https://maps.app.goo.gl/abc',
    });
    expect(buildOrganizationSchema(SITE, identity, 'ar')['slogan']).toBe('من الفكرة');
  });

  it('a hidden account leaves sameAs (D8); all hidden, no sameAs at all', () => {
    const [first, second] = IDENTITY_FALLBACK.socials;
    const identity: Identity = {
      ...IDENTITY_FALLBACK,
      socials: [first!, { ...second!, visible: false }],
    };
    expect(buildOrganizationSchema(SITE, identity, 'en')['sameAs']).toEqual([first!.url]);
    const none: Identity = {
      ...IDENTITY_FALLBACK,
      socials: IDENTITY_FALLBACK.socials.map((s) => ({ ...s, visible: false })),
    };
    expect(buildOrganizationSchema(SITE, none, 'en')).not.toHaveProperty('sameAs');
  });
});
