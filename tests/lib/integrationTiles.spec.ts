import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_TILES,
  integrationTiles,
  removeQuestion,
  tileStatus,
} from '@/lib/admin/integrations/tiles';
import { integrationsView } from '@/lib/admin/integrations/view';

// The Integrations screen's tiles (Admin v2 U11): honest statuses. "Set up" only where the
// site uses the value now (the Search Console tag on the home pages), "Saved" for a value
// nothing uses yet (GA4 until U15, Calendly), "Not set up" for none, and never the
// prototype's "Connected". The captcha has no value to set until its provider is chosen.

const NONE = integrationsView(null);
const ALL = integrationsView({
  ga4_measurement_id: 'G-ABC123',
  search_console_token: 'abcDEF0123456',
  calendly_url: 'https://calendly.com/studio',
  version: 3,
});
const byKey = (key: string) => INTEGRATION_TILES.find((t) => t.key === key)!;

describe('the tiles', () => {
  it('are the four of the design, in its order', () => {
    expect(INTEGRATION_TILES.map((t) => t.key)).toEqual([
      'ga4',
      'searchConsole',
      'calendly',
      'captcha',
    ]);
  });

  it('say Not set up with nothing saved', () => {
    for (const tile of INTEGRATION_TILES) {
      expect(tileStatus(tile, NONE), tile.key).toEqual({ label: 'Not set up', tone: 'gray' });
    }
  });

  it('say Set up only for what the site uses now, Saved for the rest', () => {
    expect(tileStatus(byKey('searchConsole'), ALL).label).toBe('Set up');
    expect(tileStatus(byKey('ga4'), ALL).label).toBe('Saved');
    expect(tileStatus(byKey('calendly'), ALL).label).toBe('Saved');
    // The captcha has nothing to save (owner item O-19).
    expect(byKey('captcha').field).toBeNull();
    expect(tileStatus(byKey('captcha'), ALL).label).toBe('Not set up');
  });

  it('read an empty string as nothing saved', () => {
    expect(integrationsView({ ga4_measurement_id: '', version: 1 }).ga4MeasurementId).toBeNull();
  });

  it('each editable tile edits one column, and asks before Remove', () => {
    expect(INTEGRATION_TILES.filter((t) => t.field).map((t) => t.field!.column)).toEqual([
      'ga4_measurement_id',
      'search_console_token',
      'calendly_url',
    ]);
    expect(removeQuestion(byKey('calendly'))).toBe(
      'Remove the Calendly setting? You can add it again any time.',
    );
  });

  it('never claim a connection, never use a dash, never spell the brand (P-12)', () => {
    const words = JSON.stringify([INTEGRATION_TILES, integrationTiles(true)]);
    expect(words).not.toMatch(/connected/i);
    expect(words).not.toMatch(/[–—]/);
    expect(words).not.toMatch(/braiin/i);
  });
});

describe('the GA4 tile follows the switch (Admin v2 U15)', () => {
  const ga4 = (live: boolean) => integrationTiles(live).find((t) => t.key === 'ga4')!;

  it('off (every production build until the notice is signed off): the tiles above, unchanged', () => {
    expect(integrationTiles(false)).toBe(INTEGRATION_TILES);
    expect(tileStatus(ga4(false), ALL)).toEqual({ label: 'Saved', tone: 'sky' });
  });

  it('off, a saved id says on the tile and in the drawer why it does not load yet', () => {
    expect(ga4(false).waiting?.text).toBe(
      'Not loading yet. It waits for the privacy notice to name Google, which the site owner approves.',
    );
    expect(
      ga4(false)
        .notes.map((n) => n.text)
        .join(' '),
    ).toContain(
      'first the privacy notice has to say that visit data goes to Google, and the site owner has to approve that wording',
    );
    expect(
      ga4(false)
        .notes.map((n) => n.text)
        .join(' '),
    ).toContain('only for visitors who accept analytics cookies');
  });

  it('on: Set up, no waiting note, behind analytics consent; every other tile as it was', () => {
    expect(tileStatus(ga4(true), ALL)).toEqual({ label: 'Set up', tone: 'ok' });
    expect(tileStatus(ga4(true), NONE).label).toBe('Not set up');
    expect(ga4(true).waiting).toBeUndefined();
    expect(
      ga4(true)
        .notes.map((n) => n.text)
        .join(' '),
    ).toContain('Nothing from Google loads before they do');
    expect(ga4(true).field).toBe(ga4(false).field);
    expect(integrationTiles(true).map((t) => t.key)).toEqual(INTEGRATION_TILES.map((t) => t.key));
    for (const tile of integrationTiles(true)) {
      if (tile.key !== 'ga4') expect(tile, tile.key).toBe(byKey(tile.key));
    }
  });
});
