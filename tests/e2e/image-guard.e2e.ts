import { expect, test } from '@playwright/test';

/*
 * The `/_image` guard (H3) on every spelling of the route (U3 review). Astro matches routes
 * on the decoded path and ignores a trailing slash, so `/_image/`, `/%5Fimage` and
 * `/_imag%65/` all reach the image endpoint. The guard was keyed on the spelling `/_image`,
 * and on those paths the adapter transformed any width, height, quality and fit, each one a
 * new unique transformation against the Images free plan's 5,000 a month. Now the
 * middleware checks the route Astro matched, and the endpoint checks the request itself.
 *
 * A transform the page emits is taken from the home page (the header logo is a <Picture>),
 * then given a width no component asks for.
 */

const ALIASES = ['/_image', '/_image/', '/%5Fimage', '/%5fimage', '/_imag%65/'];

test('every spelling of /_image refuses a transform the markup never emits', async ({
  request,
}) => {
  const html = await (await request.get('/')).text();
  const found = /(?:src|srcset)="(\/_image\?[^"\s,]+)/.exec(html)?.[1];
  expect(found, 'the home page emits a /_image URL').toBeTruthy();
  const emitted = new URL(found!.replaceAll('&amp;', '&'), 'http://localhost');

  const admitted = await request.get(`/_image${emitted.search}`);
  expect(admitted.status(), 'the URL the page emits is served').toBe(200);

  const tampered = new URL(emitted.href);
  tampered.searchParams.set('w', '333');
  for (const path of ALIASES) {
    const res = await request.get(`${path}${tampered.search}`);
    expect(res.status(), path).toBe(400);
    expect(res.headers()['cache-control'], path).toContain('no-store');
  }

  const withQuality = new URL(emitted.href);
  withQuality.searchParams.set('q', '1');
  for (const path of ALIASES) {
    expect((await request.get(`${path}${withQuality.search}`)).status(), path).toBe(400);
  }
});
