import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { encodeMediaMeta, MEDIA_META_HEADER, parseStorageKey } from '@schemas/media';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Media uploads, end to end (Admin v2 U3, owner decision A5), through the real Worker,
 * session, Images binding (wrangler dev's local one) and this job's local Supabase Storage:
 *
 *   upload     a JPEG carrying a GPS note in its EXIF becomes ONE WebP master in the public
 *              `media` bucket, at most 2,560 px on its long edge, under a random key that
 *              holds the tenant and the size; the row is a `storage` row;
 *   delivery   its thumbnail is a same-origin `/_image` URL that the guard admits and the
 *              binding transforms, and it renders in an admin page with no CSP violation;
 *   download   the stored file comes back as an attachment, WebP, without the EXIF note;
 *   replace    a new file gets a new key on the same row (version moves on);
 *   refusals   SEO (media.write "meta only") is refused by the server, and a renamed SVG
 *              by its bytes.
 *
 * The uploaded row is left in place: the per-role sweep (sweep.e2e.ts) opens the newest
 * media row's edit screen, so deleting it mid-run could race that screen. The delete
 * route's file removal is covered by tests/lib/mediaUploadApi.spec.ts. Two upload slots of
 * the admin's daily 50 are spent (four with the CI retry).
 */

test.skip(!staffEnv(), SKIP_REASON);

const GPS_NOTE = 'GPS-E2E-24.7136N-46.6753E';

/** A photo-sized JPEG with a camera note in its EXIF, as a phone would send it. */
async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .jpeg({ quality: 80 })
    .withExif({ IFD0: { ImageDescription: GPS_NOTE, Make: 'E2E Phone' } })
    .toBuffer();
}

async function csrfOf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

/** Headers for a raw-body upload: the token, the origin, and the details in one header. */
async function uploadHeaders(page: Page, meta: unknown, type: string) {
  return {
    'x-csrf-token': await csrfOf(page),
    origin: new URL(page.url()).origin,
    'content-type': type,
    [MEDIA_META_HEADER]: encodeMediaMeta(meta),
  };
}

const META = {
  alt: { en: 'A test frame in blue', ar: 'إطار اختبار باللون الأزرق' },
  tags: ['e2e'],
  displayName: 'IMG_E2E.jpg',
};

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  let asset: Record<string, unknown> = {};

  test('an image uploads as one WebP master in the public bucket', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const res = await page.request.post('/api/admin/media/upload', {
      headers: await uploadHeaders(page, META, 'image/jpeg'),
      data: await photo(3000, 2000),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    asset = body.data;
    expect(asset).toMatchObject({
      kind: 'image',
      provider: 'storage',
      mime_type: 'image/webp',
      width: 2560,
      display_name: 'IMG_E2E.jpg',
      alt: META.alt,
      version: 1,
    });
    expect(Math.abs(Number(asset['height']) - 1707)).toBeLessThanOrEqual(1);
    const key = parseStorageKey(String(asset['storage_path']));
    expect(key, 'the object key is <tenant>/<random>_<w>x<h>.webp').not.toBeNull();
    expect(key).toMatchObject({ width: 2560, height: asset['height'] });
    expect(String(asset['storage_path'])).not.toContain('IMG_E2E');
  });

  test('its thumbnail renders through same-origin /_image with no CSP violation', async ({
    page,
  }) => {
    const thumb = String(asset['thumb_url']);
    expect(thumb).toMatch(/^\/_image\?/);
    const res = await page.request.get(thumb);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/webp');
    // An upload's derivative lives an hour, as its object does (not the adapter's
    // immutable year), so a deleted file leaves the web (runbook §6i).
    expect(res.headers()['cache-control']).toBe('public, max-age=3600');

    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
      });
    });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const rendered = await page.evaluate(async (src) => {
      const img = document.createElement('img');
      img.alt = '';
      img.width = 160;
      img.height = 120;
      const loaded = await new Promise<boolean>((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
      });
      return {
        loaded,
        naturalWidth: img.naturalWidth,
        csp: (window as unknown as { __csp: string[] }).__csp,
      };
    }, thumb);
    expect(rendered.loaded, 'the thumbnail loads').toBe(true);
    expect(rendered.naturalWidth).toBe(320);
    expect(rendered.csp, 'CSP violations').toEqual([]);
  });

  test('a transform the markup never asks for is refused by the guard', async ({ page }) => {
    const url = new URL(String(asset['thumb_url']), 'http://localhost');
    url.searchParams.set('w', '333');
    // Every spelling Astro routes to the endpoint (U3 review: the guard was keyed on one).
    for (const path of ['/_image', '/_image/', '/%5Fimage', '/_imag%65/']) {
      const res = await page.request.get(`${path}${url.search}`);
      expect(res.status(), path).toBe(400);
    }
    // A format a still may take but nothing asks of an upload.
    const png = new URL(String(asset['thumb_url']), 'http://localhost');
    png.searchParams.set('f', 'png');
    expect((await page.request.get(`/_image${png.search}`)).status()).toBe(400);
  });

  test('a well-formed key that names no object is a 404, never a transformation', async ({
    page,
  }) => {
    const url = new URL(String(asset['thumb_url']), 'http://localhost');
    const href = String(url.searchParams.get('href'));
    // Same tenant, same size, a random object id the bucket has never held.
    url.searchParams.set(
      'href',
      href.replace(/\/[0-9a-f-]{36}_(\d+x\d+\.webp)$/, '/00000000-0000-4000-8000-000000000000_$1'),
    );
    expect(url.searchParams.get('href')).not.toBe(href);
    const res = await page.request.get(`/_image${url.search}`);
    expect(res.status()).toBe(404);
    expect(res.headers()['cache-control']).toContain('no-store');
  });

  test('the stored file downloads as an attachment, WebP, without the EXIF note', async ({
    page,
  }) => {
    const res = await page.request.get(`/api/admin/media/${String(asset['id'])}/download`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['content-type']).toBe('image/webp');
    expect(headers['content-disposition']).toMatch(/^attachment; filename="IMG_E2E\.webp"/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toContain('no-store');
    const bytes = await res.body();
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(bytes.includes(Buffer.from(GPS_NOTE))).toBe(false);
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
  });

  test('a replace writes a new key on the same row', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const png = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();
    const res = await page.request.post(`/api/admin/media/${String(asset['id'])}/replace`, {
      headers: await uploadHeaders(page, { version: 1 }, 'image/png'),
      data: png,
    });
    expect(res.status(), await res.text()).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      id: asset['id'],
      provider: 'storage',
      width: 400,
      height: 300,
      version: 2,
      alt: META.alt,
    });
    expect(data['storage_path']).not.toBe(asset['storage_path']);

    const stale = await page.request.post(`/api/admin/media/${String(asset['id'])}/replace`, {
      headers: await uploadHeaders(page, { version: 1 }, 'image/png'),
      data: png,
    });
    expect(stale.status(), 'a replace from a stale version').toBe(409);
  });

  test('a renamed SVG is refused by its bytes', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const res = await page.request.post('/api/admin/media/upload', {
      headers: await uploadHeaders(page, META, 'image/jpeg'),
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    });
    expect(res.status()).toBe(415);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unsupported-type', reason: 'svg' });
  });
});

test.describe('as seo (media.write is meta only)', () => {
  test.use({ storageState: authFile('seo') });

  test('an upload is refused by the server', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const res = await page.request.post('/api/admin/media/upload', {
      headers: await uploadHeaders(page, META, 'image/jpeg'),
      data: await photo(40, 30),
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' });
  });
});
