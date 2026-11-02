import { describe, expect, it, vi } from 'vitest';
import type { FooterRow } from '@/lib/data/navigation';
import { footerTree } from '@/lib/nav/tree';
import { canAddColumn, footerModel } from '@/components/admin/screens/footer/columns';
import { footerSketch, sketchFacts } from '@/components/admin/screens/footer/sketch';

// One number for the footer's columns (Admin v2 E6 code review, CR8): the public footer's
// reader, the Footer screen's sketch and its card all read FOOTER_COLUMNS_MAX
// (packages/schemas/footerRules.ts), never a literal of their own. Here the constant is two:
// a reader that kept its own four draws three. 0122's trigger keeps its literal, held equal to
// the constant by tests/lib/footerColumns.spec.ts.

vi.mock('@schemas/footerRules', () => ({ FOOTER_COLUMNS_MAX: 2 }));

const heading = (n: number): FooterRow => ({
  id: `h${n}`,
  parent_id: null,
  label: { en: `H${n}`, ar: `ع${n}` },
  href: null,
  sort_order: n,
  is_key: false,
  is_heading: true,
});

describe('every reader follows FOOTER_COLUMNS_MAX', () => {
  it('the public footer draws that many columns', () => {
    expect(footerTree([1, 2, 3].map(heading)).columns.map((c) => c.id)).toEqual(['h1', 'h2']);
  });

  it('the sketch draws that many titles', () => {
    expect(footerSketch({}, sketchFacts(null), ['A', 'B', 'C']).columns).toEqual(['A', 'B']);
  });

  it('the card stops adding at that many', () => {
    const rows = [1, 2].map((n) => ({
      id: `h${n}`,
      location: 'footer',
      parent_id: null,
      label: { en: `H${n}`, ar: `ع${n}` },
      href: null,
      is_heading: true,
      sort_order: n,
      version: 1,
    }));
    expect(canAddColumn(footerModel(rows.slice(0, 1)))).toBe(true);
    expect(canAddColumn(footerModel(rows))).toBe(false);
  });
});
