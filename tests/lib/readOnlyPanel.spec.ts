import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReadOnlyPanel from '@/components/admin/screens/logs/ReadOnlyPanel';

// The system logs (ReadOnlyPanel) are a table of plain text: no link or button in a row.
// When a wide row (a long JSON `detail`) makes the table scroll sideways, the keyboard can
// reach the rest only through the scrolling box itself (axe scrollable-region-focusable,
// WCAG 2.1.1, found by the F5a CI sweep on /admin/audit once the e2e suite's own saves had
// written long audit rows). So the box is a focusable, named region, and a JSON cell may
// break anywhere instead of widening the table. The activity log left this panel in U13;
// its server table asks ServerTable for the same region (`region`, tests/astro).

describe('ReadOnlyPanel', () => {
  it('the scrolling box is a focusable, named region', () => {
    const html = renderToStaticMarkup(
      createElement(ReadOnlyPanel, {
        endpoint: '/api/admin/logs',
        variant: 'logs',
        columns: [{ key: 'detail', label: 'Detail', kind: 'json' }],
      }),
    );
    expect(html).toContain(
      '<div class="card table-wrap" tabindex="0" role="region" aria-label="System logs">',
    );
    expect(html).toContain('<caption class="visually-hidden">System logs</caption>');
  });

  it('the activity log asks ServerTable for the same region', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync('src/pages/admin/audit.astro', 'utf8');
    expect(page).toMatch(/caption="Activity, newest first"\s+region/);
  });
});
