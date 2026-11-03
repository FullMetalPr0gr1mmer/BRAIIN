import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FOOTER_COLUMNS_MAX,
  navShapeIssues,
  NavItemUpdateSchema,
  NavItemWriteSchema,
  type NavShape,
} from '@schemas/admin';
import type { FooterRow } from '@/lib/data/navigation';
import {
  copyrightLine,
  DEFAULT_COPYRIGHT,
  footerAttributes,
  footerSocials,
} from '@/lib/appearance/footer';
import { translateWriteError } from '@/lib/admin/crud';
import { ValidationError } from '@/lib/admin/errors';
import { navigationResource } from '@/lib/admin/resources/navigation';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { footerTree } from '@/lib/nav/tree';

// The footer's link columns and settings (Admin v2 E6): the pure pieces the public footer and
// the navigation API stand on. The SQL half (0122's CHECK and trigger) is pgTAP's
// (supabase/tests/footer_columns.test.sql); this spec holds the Worker's half to the same
// rules, and the numbers both write to one another.

const MIGRATION = readFileSync('supabase/migrations/0122_footer_columns.sql', 'utf8');

const row = (over: Partial<FooterRow> & { id: string }): FooterRow => ({
  parent_id: null,
  label: { en: over.id, ar: over.id },
  href: `/${over.id}`,
  sort_order: 1,
  is_key: false,
  is_heading: false,
  ...over,
});
const heading = (id: string, sort: number) =>
  row({ id, href: null, is_heading: true, sort_order: sort });

describe('footerTree: the footer rows as columns and loose links', () => {
  it('no heading: every row is a loose link, nested as the header nests', () => {
    const tree = footerTree([
      row({ id: 'b', sort_order: 2 }),
      row({ id: 'a', sort_order: 1 }),
      row({ id: 'a1', parent_id: 'a' }),
    ]);
    expect(tree.columns).toEqual([]);
    expect(tree.links.map((l) => [l.id, l.children.map((c) => c.id)])).toEqual([
      ['a', ['a1']],
      ['b', []],
    ]);
  });

  it('a heading heads the links under it, in order; the rest stay loose', () => {
    const tree = footerTree([
      heading('h2', 2),
      heading('h1', 1),
      row({ id: 'x', parent_id: 'h1', sort_order: 2 }),
      row({ id: 'y', parent_id: 'h1', sort_order: 1 }),
      row({ id: 'z', parent_id: 'h2' }),
      row({ id: 'loose' }),
    ]);
    expect(tree.columns.map((c) => [c.id, c.links.map((l) => l.id)])).toEqual([
      ['h1', ['y', 'x']],
      ['h2', ['z']],
    ]);
    expect(tree.links.map((l) => l.id)).toEqual(['loose']);
  });

  it('draws four columns at most; a fifth heading’s links are promoted, never lost', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => heading(`h${n}`, n));
    const tree = footerTree([...rows, row({ id: 'under5', parent_id: 'h5' })]);
    expect(FOOTER_COLUMNS_MAX).toBe(4);
    expect(tree.columns.map((c) => c.id)).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(tree.links.map((l) => l.id)).toEqual(['under5']);
  });

  it('a column link’s sub-link nests under its link, never in the loose row (code review CR1)', () => {
    // Heading H > link L1 > sub-link L1a. The footer draws one level of links (SiteFooter
    // draws no children, in a column or not), so L1a is never drawn; before the fix it was
    // promoted into "Footer navigation" while the Footer card counted it under L1.
    const tree = footerTree([
      heading('H', 1),
      row({ id: 'L1', parent_id: 'H', sort_order: 1 }),
      row({ id: 'L1a', parent_id: 'L1', sort_order: 2 }),
      row({ id: 'L1b', parent_id: 'L1', sort_order: 1 }),
      row({ id: 'L3', sort_order: 3 }),
    ]);
    expect(
      tree.columns.map((c) => [c.id, c.links.map((l) => [l.id, l.children.map((x) => x.id)])]),
    ).toEqual([['H', [['L1', ['L1b', 'L1a']]]]]);
    expect(tree.links.map((l) => l.id)).toEqual(['L3']);
  });

  it('a link under a fifth heading is promoted with its sub-links under it', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => heading(`h${n}`, n));
    const tree = footerTree([
      ...rows,
      row({ id: 'p', parent_id: 'h5' }),
      row({ id: 'p1', parent_id: 'p' }),
    ]);
    expect(tree.links.map((l) => [l.id, l.children.map((c) => c.id)])).toEqual([['p', ['p1']]]);
  });

  it('a hidden column hides its links (review E6-C1): the heading is not read, nor are they drawn', () => {
    // What the public read returns with column H hidden (visible rows only; anon cannot read
    // H): its two links, a sub-link under one of them, and a loose link.
    const tree = footerTree([
      row({ id: 'L1', parent_id: 'H', sort_order: 1 }),
      row({ id: 'L2', parent_id: 'H', sort_order: 2 }),
      row({ id: 'L1a', parent_id: 'L1' }),
      row({ id: 'L3', sort_order: 3 }),
    ]);
    expect(tree.columns).toEqual([]);
    expect(tree.links.map((l) => [l.id, l.children.map((c) => c.id)])).toEqual([['L3', []]]);
  });

  it('a hidden link hides its sub-links in the footer (the header promotes them)', () => {
    const tree = footerTree([
      row({ id: 'sub', parent_id: 'hiddenLink' }),
      row({ id: 'p', sort_order: 1 }),
    ]);
    expect(tree.links.map((l) => l.id)).toEqual(['p']);
  });

  it('drops what the CHECK forbids: a link with no address, a heading under a row', () => {
    const tree = footerTree([
      row({ id: 'nolink', href: null }),
      row({ id: 'p' }),
      row({ id: 'subheading', parent_id: 'p', href: null, is_heading: true }),
    ]);
    expect(tree.columns).toEqual([]);
    expect(tree.links.map((l) => [l.id, l.children.length])).toEqual([['p', 0]]);
  });
});

describe('the copyright template', () => {
  const parts = { year: '2026', brand: 'Studio', place: 'Jeddah' };

  it('none saved is the footer as built', () => {
    expect(DEFAULT_COPYRIGHT).toBe('© {year} {brand}. {place}');
    expect(copyrightLine(null, 'en', parts)).toBe('© 2026 Studio. Jeddah');
    expect(copyrightLine(undefined, 'ar', { ...parts, year: '٢٠٢٦' })).toBe(
      '© ٢٠٢٦ Studio. Jeddah',
    );
  });

  it('fills each placeholder, every time it appears, in the reader’s language', () => {
    const t = { en: '{brand} {year} {brand}', ar: '{place} - {year}' };
    expect(copyrightLine(t, 'en', parts)).toBe('Studio 2026 Studio');
    expect(copyrightLine(t, 'ar', parts)).toBe('Jeddah - 2026');
  });

  it('fills in one pass: a brand that reads "{year}" is never filled again', () => {
    expect(
      copyrightLine({ en: '{brand}', ar: '{brand}' }, 'en', { ...parts, brand: '{year}' }),
    ).toBe('{year}');
  });
});

describe('the settings as the footer draws them', () => {
  it('the defaults add nothing: light, the mailbox, no icons', () => {
    expect(footerAttributes(IDENTITY_FALLBACK)).toEqual({});
    expect(footerSocials(IDENTITY_FALLBACK)).toEqual([]);
    expect(IDENTITY_FALLBACK.footer).toEqual({
      copyright: null,
      style: 'light',
      showEmail: true,
      showSocial: false,
    });
  });

  it('dark is one data attribute; icons are the shown accounts, in order', () => {
    const identity = {
      ...IDENTITY_FALLBACK,
      footer: { ...IDENTITY_FALLBACK.footer, style: 'dark' as const, showSocial: true },
      socials: [
        {
          network: 'linkedin' as const,
          handle: '@a',
          url: 'https://www.linkedin.com/a',
          visible: true,
        },
        {
          network: 'tiktok' as const,
          handle: '@b',
          url: 'https://www.tiktok.com/b',
          visible: false,
        },
        { network: 'x' as const, handle: '@c', url: 'https://x.com/c', visible: true },
      ],
    };
    expect(footerAttributes(identity)).toEqual({ 'data-style': 'dark' });
    expect(footerSocials(identity).map((s) => [s.label, s.href, s.icon !== null])).toEqual([
      ['LinkedIn', 'https://www.linkedin.com/a', true],
      ['X', 'https://x.com/c', false],
    ]);
  });
});

describe('a column heading through the navigation API (two layers with 0122)', () => {
  const base = { location: 'footer' as const, label: { en: 'Studio', ar: 'الاستوديو' } };

  it('a new heading has no link, is in the footer, at the top and never the key', () => {
    expect(NavItemWriteSchema.parse({ ...base, isHeading: true }).isHeading).toBe(true);
    const bad = (extra: Record<string, unknown>) =>
      NavItemWriteSchema.safeParse({ ...base, isHeading: true, ...extra }).error?.issues.map((i) =>
        i.path.join('.'),
      );
    expect(bad({ href: '/about' })).toEqual(['href']);
    expect(bad({ location: 'header' })).toEqual(['location']);
    expect(bad({ parentId: '00000000-0000-4000-8000-000000000001' })).toEqual(['parentId']);
    expect(bad({ isKey: true })).toEqual(['isKey']);
  });

  it('a new link still needs its address; isHeading defaults to false', () => {
    expect(NavItemWriteSchema.safeParse(base).success).toBe(false);
    expect(NavItemWriteSchema.parse({ ...base, href: '/about' }).isHeading).toBe(false);
  });

  it('an update names only what it changes (the stored row is the CHECK’s)', () => {
    const patch = NavItemUpdateSchema.parse({ isHeading: true, href: null, version: 3 });
    expect(patch).toEqual({ isHeading: true, href: null, version: 3 });
    expect(NavItemUpdateSchema.parse({ label: base.label, version: 3 }).isHeading).toBeUndefined();
  });

  it('toRow keeps a heading’s empty link and still refuses a bad scheme', () => {
    expect(navigationResource.toRow({ isHeading: true, href: null })).toEqual({
      is_heading: true,
      href: null,
    });
    expect(() => navigationResource.toRow({ href: 'javascript:alert(1)' })).toThrow(
      /unsupported link scheme/,
    );
  });

  it('the database’s two refusals are 422s on the field, named as 0122 names them', () => {
    const fields = navigationResource.constraintFields ?? {};
    for (const name of ['navigation_heading_shape', 'navigation_footer_columns_max']) {
      expect(MIGRATION).toContain(name);
      expect(fields[name]?.field).toBe('isHeading');
    }
    expect(fields['navigation_footer_columns_max']?.message).toContain(String(FOOTER_COLUMNS_MAX));
    // One number: the trigger refuses at four others, the schema and the reader say four.
    // SQL cannot import FOOTER_COLUMNS_MAX, so the migration names it beside its literal
    // (code review CR8); tests/lib/footerLimit.spec.ts holds every reader to the constant.
    expect(MIGRATION).toMatch(/if v_others >= 4 then/);
    expect(MIGRATION).toContain('The four below is FOOTER_COLUMNS_MAX');
    expect(FOOTER_COLUMNS_MAX).toBe(4);
  });

  it('a parent of another tenant is a 422 on parentId (review E6-SEC-1: the composite key)', () => {
    // The key is (tenant_id, parent_id) -> (tenant_id, id): a key check bypasses RLS, so a
    // single-column key would let a writer name another tenant's row as a parent.
    expect(MIGRATION).toMatch(
      /add constraint navigation_parent_fk foreign key \(tenant_id, parent_id\)\s+references public\.navigation \(tenant_id, id\) on delete cascade;/,
    );
    const error = translateWriteError(
      {
        code: '23503',
        message:
          'insert or update on table "navigation" violates foreign key constraint "navigation_parent_fk"',
      },
      'navigation',
      'write',
      navigationResource.constraintFields,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('parentId');
  });
});

describe('a menu row’s shape over the stored row (code review CR3, CR4)', () => {
  const link: NavShape = { isHeading: false, href: '/about', location: 'footer', parentId: null };
  const head: NavShape = { isHeading: true, href: null, location: 'footer', parentId: null };
  const fields = (row: NavShape, changed?: (keyof NavShape)[]) =>
    navShapeIssues(row, changed ? new Set(changed) : undefined).map((i) => i.field);

  it('a link whose address is emptied is said on its address, never on the heading flag', () => {
    expect(fields({ ...link, href: null }, ['href'])).toEqual(['href']);
    expect(fields({ ...link, href: '' }, ['href'])).toEqual(['href']);
    // A heading turned back into a link without an address: the address is what is missing.
    expect(fields({ ...head, isHeading: false }, ['isHeading'])).toEqual(['href']);
  });

  it('a heading’s clash is said on the field the write sent, else on the flag it turned on', () => {
    expect(fields({ ...head, href: '/x' }, ['href'])).toEqual(['href']);
    expect(fields({ ...link, isHeading: true }, ['isHeading'])).toEqual(['isHeading']);
    expect(fields({ ...head, location: 'header' }, ['location'])).toEqual(['location']);
    expect(
      fields({ ...link, href: null, isHeading: true, location: 'header' }, ['isHeading', 'href']),
    ).toEqual(['isHeading']);
    expect(fields({ ...head, parentId: 'p' }, ['parentId'])).toEqual(['parentId']);
    expect(
      fields({ ...link, href: null, isHeading: true, parentId: 'p' }, ['isHeading', 'href']),
    ).toEqual(['isHeading']);
    expect(fields({ ...head, isKey: true }, ['isKey'])).toEqual(['isKey']);
    expect(
      fields({ ...link, href: null, isKey: true, isHeading: true }, ['isHeading', 'href']),
    ).toEqual(['isHeading']);
  });

  it('judges only what the write can have broken: the stored row is inside the CHECK', () => {
    // A write that names none of a clause's columns cannot break it (a label, an order, an
    // eye); nor does the read of a stored row trust a column the write did not send.
    expect(fields({ isHeading: false }, [])).toEqual([]);
    expect(fields({ isHeading: false }, ['parentId'])).toEqual([]);
    expect(fields({ ...head, href: '/x' }, ['parentId'])).toEqual([]);
    expect(fields({ ...link, href: null })).toEqual(['href']);
  });

  it('a create is judged whole, with the same words the create schema says', () => {
    const issues = navShapeIssues({
      isHeading: true,
      href: '/x',
      location: 'header',
      parentId: 'p',
      isKey: true,
    });
    expect(issues.map((i) => i.field)).toEqual(['href', 'location', 'parentId', 'isKey']);
    const parsed = NavItemWriteSchema.safeParse({
      location: 'header',
      label: { en: 'a', ar: 'ب' },
      href: '/x',
      parentId: '00000000-0000-4000-8000-000000000001',
      isKey: true,
      isHeading: true,
    });
    expect(parsed.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual(
      issues.map((i) => [i.field, i.message]),
    );
  });
});
