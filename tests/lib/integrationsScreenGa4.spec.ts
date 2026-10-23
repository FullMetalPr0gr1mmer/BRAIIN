import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import IntegrationsScreen from '@/components/admin/screens/integrations/IntegrationsScreen';
import { integrationsView } from '@/lib/admin/integrations/view';

// The Integrations screen's GA4 tile, as the server renders it (Admin v2 U15): with the switch
// off a saved id is "Saved" and the tile itself says why it does not load yet; with it on the
// tile says "Set up" and nothing waits; with no id it is "Not set up" either way.

const SAVED = integrationsView({ ga4_measurement_id: 'G-ABC123XYZ', version: 2 });
const NONE = integrationsView(null);

const render = (initial: typeof SAVED, ga4Live?: boolean) =>
  renderToStaticMarkup(
    createElement(IntegrationsScreen, {
      initial,
      canSeeForms: true,
      ...(ga4Live === undefined ? {} : { ga4Live }),
    }),
  );

/** The GA4 tile's markup: from its <li> to the next one. */
const ga4Tile = (html: string) => {
  const start = html.indexOf('data-integration="ga4"');
  return html.slice(start, html.indexOf('data-integration="searchConsole"'));
};

describe('the GA4 tile', () => {
  it('off by default: Saved, the id, and why it does not load yet', () => {
    const tile = ga4Tile(render(SAVED));
    expect(tile).toContain('>Saved<');
    expect(tile).toContain('G-ABC123XYZ');
    expect(tile).toContain('Not loading yet. It waits for the privacy notice to name Google');
    expect(ga4Tile(render(SAVED, false))).toBe(tile);
  });

  it('on: Set up, and nothing waiting', () => {
    const tile = ga4Tile(render(SAVED, true));
    expect(tile).toContain('>Set up<');
    expect(tile).not.toContain('Not loading yet');
  });

  it('with no id: Not set up, and no note, whatever the switch', () => {
    for (const live of [false, true]) {
      const tile = ga4Tile(render(NONE, live));
      expect(tile).toContain('>Not set up<');
      expect(tile).not.toContain('Not loading yet');
    }
  });
});
