import { describe, expect, test } from 'vitest';
import { LAYOUT_CASES, renderLayout } from './layout';

// The public layout (src/layouts/BaseLayout.astro), rendered whole and to the byte: the head,
// the header, the page's slot, the footer and the consent-gated block (the banner, the RUM
// collector, the page view, the error reporter). The snapshot was written by BaseLayout as it
// stood BEFORE Admin v2 U15 taught it the GA4 loader, so it is the proof that a site with no
// GA4 id, or with the switch off (which the middleware turns into no read at all), serves the
// page it always did. Its twin, baseLayoutGa4.spec.ts, proves what an id adds.

describe('the public layout, to the byte, with no GA4 id', () => {
  test.each(Object.keys(LAYOUT_CASES))('%s', async (name) => {
    const html = await renderLayout({ ...LAYOUT_CASES[name as keyof typeof LAYOUT_CASES] });
    expect(html).toMatchSnapshot();
  });
});
