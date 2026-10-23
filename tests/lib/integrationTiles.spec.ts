import { describe, expect, it } from 'vitest';
import { INTEGRATION_TILES, removeQuestion, tileStatus } from '@/lib/admin/integrations/tiles';
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
    const words = JSON.stringify(INTEGRATION_TILES);
    expect(words).not.toMatch(/connected/i);
    expect(words).not.toMatch(/[–—]/);
    expect(words).not.toMatch(/braiin/i);
  });
});
