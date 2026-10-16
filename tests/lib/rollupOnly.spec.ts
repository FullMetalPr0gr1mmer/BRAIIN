import { describe, expect, it } from 'vitest';
import { scanTree } from './sourceScan';

// CLAUDE.md Pillar 4: "Dashboards read rollup_* only" (Admin v2 U2). No admin page, island,
// loader or admin API names the raw telemetry tables: website stats read the page-view
// rollup and site health the vitals rollup, through the invoker RPCs of migration 0052. The
// raw tables are the ingest's (src/pages/api/analytics.ts, rum.ts) and the rollups' own.
// Names are read as code (tests/lib/sourceScan.ts): a comment that mentions a table is not
// a read; an .astro file is read whole, comments included, which can only be stricter.

const RAW = ['web_vitals', 'analytics_events'];
const ADMIN_CODE = [
  'src/pages/admin',
  'src/pages/api/admin',
  'src/lib/admin',
  'src/components/admin',
];

describe('the admin reads rollups, never raw telemetry', () => {
  const files = ADMIN_CODE.flatMap((dir) => scanTree(dir));

  it('scans the admin code (the check is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.path === 'src/lib/admin/health/vitals.ts')).toBe(true);
    expect(files.some((f) => f.path === 'src/pages/admin/site-health.astro')).toBe(true);
  });

  it.each(RAW)('no admin file names %s', (table) => {
    expect(files.filter((f) => f.names.has(table)).map((f) => f.path)).toEqual([]);
  });

  it('would catch a read (the scanner sees a table named as a string)', async () => {
    const { scanSource } = await import('./sourceScan');
    const scanned = scanSource('x.ts', "await sb.from('web_vitals').select('value');");
    expect(scanned.names.has('web_vitals')).toBe(true);
  });
});
