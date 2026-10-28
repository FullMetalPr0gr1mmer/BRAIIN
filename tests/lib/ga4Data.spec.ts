import { beforeEach, describe, expect, it, vi } from 'vitest';

// The GA4 measurement id a public page loads Google Analytics with (Admin v2 U15,
// src/lib/data/ga4.ts): anon's one GA4 column of site_integrations (U15's migration), through the content
// seam. It never throws and never fails the page: anything but a well-formed measurement id
// is no id (no GA4), and every failure is reported.

let configured = true;
let answer: { data: unknown; error: unknown } = { data: null, error: null };
let thrown: Error | null = null;
const asked: { table: string; columns: string }[] = [];

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => configured,
  anonClient: () => ({
    from: (table: string) => {
      const entry = { table, columns: '' };
      asked.push(entry);
      const q = {
        select: (columns: string) => {
          entry.columns = columns;
          return q;
        },
        maybeSingle: async () => {
          if (thrown) throw thrown;
          return answer;
        },
      };
      return q;
    },
  }),
}));

const { getGa4MeasurementId, GA4_COLUMN } = await import('@/lib/data/ga4');

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  configured = true;
  answer = { data: null, error: null };
  thrown = null;
  asked.length = 0;
  warn.mockClear();
});

describe('getGa4MeasurementId', () => {
  it('reads the one GA4 column anon may, of site_integrations, and answers the id', async () => {
    answer = { data: { ga4_measurement_id: 'G-ABC123XYZ' }, error: null };
    expect(await getGa4MeasurementId()).toBe('G-ABC123XYZ');
    expect(asked).toEqual([{ table: 'site_integrations', columns: 'ga4_measurement_id' }]);
    expect(GA4_COLUMN).toBe('ga4_measurement_id');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is null, quietly, with no row or no id set', async () => {
    expect(await getGa4MeasurementId()).toBeNull();
    answer = { data: { ga4_measurement_id: null }, error: null };
    expect(await getGa4MeasurementId()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks nothing when the database is not configured', async () => {
    configured = false;
    expect(await getGa4MeasurementId()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is null and reported on a refused read (a database without the U15 migration: 42501)', async () => {
    answer = { data: null, error: { code: '42501', message: 'permission denied' } };
    expect(await getGa4MeasurementId()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_integrations load failed'));
  });

  it('is null and reported when the read throws', async () => {
    thrown = new Error('network');
    expect(await getGa4MeasurementId()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_integrations load failed'));
  });

  it.each([
    ['an old Universal Analytics id', 'UA-12345-1'],
    ['markup', 'G-ABC"><script>'],
    ['lower case', 'g-abc123xyz'],
    ['too short', 'G-ABC'],
    ['too long', `G-${'A'.repeat(16)}`],
    ['not text', 12345678],
  ])('is null and reported for a stored value that is no id (%s)', async (_name, value) => {
    answer = { data: { ga4_measurement_id: value }, error: null };
    expect(await getGa4MeasurementId()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_integrations load failed'));
  });
});
