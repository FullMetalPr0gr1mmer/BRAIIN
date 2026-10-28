import { describe, expect, test } from 'vitest';
import { CONSENT_VERSION } from '@consent/gate';
import { LAYOUT_CASES, renderLayout } from './layout';

// The public layout once the middleware's read found a GA4 id (Admin v2 U15). Its twin,
// baseLayout.spec.ts, holds the layout with no id to the byte as it stood before U15; this one
// proves what an id adds: exactly one same-origin loader tag, with the id and the consent
// version in data attributes, at the end of the consent-gated block, in either language, and
// nothing else anywhere. A read that found nothing (null) is no id, and a preview never
// carries the loader whatever `locals` holds.

const ID = 'G-TEST1234';
const TAG = `<script src="/scripts/ga4.js" data-ga4-id="${ID}" data-consent-version="${CONSENT_VERSION}" defer></script>`;

const cases = Object.keys(LAYOUT_CASES) as (keyof typeof LAYOUT_CASES)[];

describe('the GA4 loader in the public layout', () => {
  test.each(cases)('%s: one tag with an id, the page unchanged without one', async (name) => {
    const props = { ...LAYOUT_CASES[name] };
    const without = await renderLayout(props);
    const none = await renderLayout(props, { ga4: Promise.resolve(null) });
    const withId = await renderLayout(props, { ga4: Promise.resolve(ID) });
    expect(none).toBe(without);
    expect(withId.split(TAG)).toHaveLength(2);
    expect(withId.replace(TAG, '')).toBe(without);
    // At the end of the consent-gated block: after the banner, before the body closes.
    expect(withId.indexOf(TAG)).toBeGreaterThan(withId.indexOf('id="consent-banner"'));
    expect(withId.indexOf(TAG)).toBeLessThan(withId.indexOf('</body>'));
    // A classic script of our own: no inline body, no JSON, no Google host in the markup.
    expect(withId).not.toMatch(/googletagmanager|google-analytics/);
  });

  test('a value that is not a measurement id renders no tag (the read refuses it first)', async () => {
    const props = { ...LAYOUT_CASES['home, English'] };
    const without = await renderLayout(props);
    for (const value of ['UA-12345-1', '"><script>alert(1)</script>', 'g-test1234', '']) {
      expect(await renderLayout(props, { ga4: Promise.resolve(value) }), value).toBe(without);
    }
  });

  test('a preview never carries the loader, whatever the request holds', async () => {
    const html = await renderLayout(
      { ...LAYOUT_CASES['home, English'] },
      { ga4: Promise.resolve(ID), preview: { locale: 'en', path: '/admin/preview' } as never },
    );
    expect(html).not.toContain('/scripts/ga4.js');
    expect(html).not.toContain('consent-banner');
  });
});
