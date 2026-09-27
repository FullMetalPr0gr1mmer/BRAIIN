import { expect, test } from '@playwright/test';

/*
 * /media/*.mp4 answers byte ranges (EXC-009; src/worker.ts → src/lib/http/media.ts).
 *
 * The production defect this guards (2026-09-27): Workers Static Assets ignored `Range`, so
 * `Range: bytes=0-99` got 200 and all 12 MB, the browser reported seekable = [0, 0], and
 * clips.ts `seekTarget()` — correctly — refused to seek. Every clip window on the site (the
 * contact hero, About's "who" frame, Our Work's banner, intro frames and card hovers)
 * played the showreel from 0. Nothing failed: the pages looked alive and wrong.
 *
 * The wire assertions run against the built Worker under `wrangler dev`, which routes
 * `/media/*` through the Worker exactly as `assets.run_worker_first` does in production.
 * The browser assertions prove the part that matters to a visitor: the file is seekable,
 * and a real clip window engages.
 */

const MP4 = '/media/showreel.mp4';

test.describe('media byte ranges — wire', () => {
  test('a Range request → 206 with Content-Range, exactly that window', async ({ request }) => {
    const res = await request.get(MP4, { headers: { Range: 'bytes=0-99' } });
    expect(res.status()).toBe(206);
    const h = res.headers();
    expect(h['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(h['accept-ranges']).toBe('bytes');
    expect(h['content-type']).toBe('video/mp4');
    expect(h['content-length']).toBe('100');
    const body = await res.body();
    expect(body.byteLength).toBe(100);
    // An MP4 opens with a box whose type is `ftyp` at bytes 4–7.
    expect(body.subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  test('no Range → 200 with the whole file and Accept-Ranges advertised', async ({ request }) => {
    const probe = await request.head(MP4, { headers: { Range: 'bytes=0-0' } });
    const size = Number(probe.headers()['content-range']?.split('/')[1]);
    expect(size).toBeGreaterThan(0);

    const res = await request.get(MP4);
    expect(res.status()).toBe(200);
    expect(res.headers()['accept-ranges']).toBe('bytes');
    expect(res.headers()['content-range']).toBeUndefined();
    expect(res.headers()['content-type']).toBe('video/mp4');
    expect((await res.body()).byteLength).toBe(size);
  });

  test('HEAD works, with and without a Range', async ({ request }) => {
    const head = await request.head(MP4);
    expect(head.status()).toBe(200);
    expect(head.headers()['accept-ranges']).toBe('bytes');
    expect(Number(head.headers()['content-length'])).toBeGreaterThan(0);

    const ranged = await request.head(MP4, { headers: { Range: 'bytes=10-19' } });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()['content-range']).toMatch(/^bytes 10-19\/\d+$/);
  });

  test('a mid-file window and a suffix range carry the right bytes', async ({ request }) => {
    const size = Number(
      (await request.head(MP4, { headers: { Range: 'bytes=0-0' } }))
        .headers()
        ['content-range']?.split('/')[1],
    );
    const mid = Math.floor(size / 2);
    const res = await request.get(MP4, { headers: { Range: `bytes=${mid}-${mid + 511}` } });
    expect(res.status()).toBe(206);
    expect(res.headers()['content-range']).toBe(`bytes ${mid}-${mid + 511}/${size}`);
    expect((await res.body()).byteLength).toBe(512);

    const tail = await request.get(MP4, { headers: { Range: 'bytes=-16' } });
    expect(tail.status()).toBe(206);
    expect(tail.headers()['content-range']).toBe(`bytes ${size - 16}-${size - 1}/${size}`);
  });

  test('an unsatisfiable range → 416 with bytes */size', async ({ request }) => {
    const res = await request.get(MP4, { headers: { Range: 'bytes=999999999-' } });
    expect(res.status()).toBe(416);
    expect(res.headers()['content-range']).toMatch(/^bytes \*\/\d+$/);
  });

  test('the same security headers as every other response, and a long cache', async ({
    request,
  }) => {
    const h = (await request.get(MP4, { headers: { Range: 'bytes=0-9' } })).headers();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['strict-transport-security']).toContain('max-age=');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['content-security-policy']).toBeTruthy();
    expect(h['content-security-policy']).not.toContain('unsafe-inline');
    expect(h['cache-control']).toMatch(/public, max-age=\d{5,}/);
  });

  test('only /media/*.mp4 is served this way — no traversal, no other file type', async ({
    request,
  }) => {
    expect((await request.get('/media/nope.mp4')).status()).toBe(404);
    expect((await request.get('/media/..%2f..%2fserver%2fwrangler.json')).status()).toBe(404);
    expect((await request.get('/media/%2e%2e/server/wrangler.json')).status()).toBe(404);
    expect((await request.post(MP4)).status()).toBe(405);
    // A non-mp4 file under /media still resolves — through the normal asset path.
    const jpg = await request.get('/media/hero-poster-blur.jpg');
    expect(jpg.status()).toBe(200);
    expect(jpg.headers()['content-range']).toBeUndefined();
  });
});

test.describe('media byte ranges — browser', () => {
  test('the showreel is seekable in a real <video>', async ({ page }) => {
    await page.goto('/healthz');
    const r = await page.evaluate(async (src) => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.src = src;
      document.body.appendChild(v);
      await new Promise<void>((resolve, reject) => {
        v.addEventListener('loadedmetadata', () => resolve(), { once: true });
        v.addEventListener('error', () => reject(new Error(`media error ${v.error?.code}`)));
      });
      const seekableEnd = v.seekable.length > 0 ? v.seekable.end(0) : 0;
      v.currentTime = 6.2;
      await new Promise<void>((resolve) => v.addEventListener('seeked', () => resolve()));
      return { duration: v.duration, seekableEnd, t: v.currentTime };
    }, MP4);
    // Without ranges Chromium reports seekable = [0, 0] and every clip window is dropped.
    expect(r.seekableEnd).toBeGreaterThan(r.duration - 0.5);
    expect(r.t).toBeCloseTo(6.2, 1);
  });

  test('the contact hero plays its 6.2–7.9 s window, not the file from 0', async ({ page }) => {
    await page.goto('/contact', { waitUntil: 'load' });
    const media = page.locator('main > .hero .hero__media');
    await expect(media).toHaveAttribute('data-clip-start', '6.2');
    const video = media.locator('video');
    await expect(video).toHaveCount(1, { timeout: 10_000 });
    // Let it play past a loop boundary, then sample: every position lies inside the window.
    await page.waitForFunction(
      () =>
        (document.querySelector('.hero__media video') as HTMLVideoElement | null)?.readyState === 4,
      undefined,
      { timeout: 15_000 },
    );
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await page.waitForTimeout(400);
      samples.push(await video.evaluate((v) => (v as HTMLVideoElement).currentTime));
    }
    for (const t of samples) {
      expect(t, `currentTime ${t} outside the 6.2–7.9 s window`).toBeGreaterThanOrEqual(6.1);
      expect(t, `currentTime ${t} outside the 6.2–7.9 s window`).toBeLessThanOrEqual(8.3);
    }
  });
});
