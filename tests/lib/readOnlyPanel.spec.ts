import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReadOnlyPanel from '@/components/admin/screens/logs/ReadOnlyPanel';

// The logs and the audit log (ReadOnlyPanel) are tables of plain text: no link or button
// in a row. When a wide row (a long JSON `detail`) makes the table scroll sideways, the
// keyboard can reach the rest only through the scrolling box itself (axe
// scrollable-region-focusable, WCAG 2.1.1, found by the F5a CI sweep on /admin/audit once
// the e2e suite's own saves had written long audit rows). So the box is a focusable, named
// region, and a JSON cell may break anywhere instead of widening the table.

describe('ReadOnlyPanel', () => {
  for (const variant of ['audit', 'logs'] as const) {
    it(`${variant}: the scrolling box is a focusable, named region`, () => {
      const html = renderToStaticMarkup(
        createElement(ReadOnlyPanel, {
          endpoint: `/api/admin/${variant}`,
          variant,
          columns: [{ key: 'detail', label: 'Detail', kind: 'json' }],
        }),
      );
      const name = variant === 'audit' ? 'Audit log' : 'System logs';
      expect(html).toContain(
        `<div class="card table-wrap" tabindex="0" role="region" aria-label="${name}">`,
      );
      expect(html).toContain(`<caption class="visually-hidden">${name}</caption>`);
    });
  }
});
