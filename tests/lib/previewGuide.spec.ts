import { describe, expect, it } from 'vitest';
import { HelpArticleSeedSchema, type HelpArticleRow } from '@schemas/help';
import { ROLES } from '@/lib/auth/types';
import { CAPABILITIES } from '@/lib/authz/matrix';
import { reachableHrefs } from '@/lib/admin/nav';
import { mayRead, PAGE_GUIDES, pageGuideFor } from '@/lib/admin/help';
import { canPreview, PREVIEW_READ_CAPS } from '@/lib/preview/dataset';
import { PREVIEW_COPY } from '@/lib/preview/report';
import { pageFileFor } from '../admin/routes';
import { helpSet, readMigrations } from '../fixtures/helpSet';

// The preview's help guide (Admin v2 R9, U16), put by its migration through H11's catalog
// (`select app.put_help_guide($guide$ {…} $guide$::jsonb, 0);`) and read here as the
// migrations leave it (tests/fixtures/helpSet.ts). tests/lib/helpCentre.spec.ts holds it to
// every rule a guide keeps; this file holds it to what the preview does and to who may
// preview. The catalog's CHECK allows 12 caps and the guide names exactly 12
// (PREVIEW_READ_CAPS): a cap the preview's door gains must not reach the guide unchecked.

const SLUG = 'previewing-changes';
const HELP = helpSet(readMigrations());
const RAW = HELP.set.find((g) => g.slug === SLUG);
const GUIDE: HelpArticleRow = HelpArticleSeedSchema.parse(RAW);
const PUT = HELP.edits.filter((e) => e.slug === SLUG);

const texts = (lang?: 'en' | 'ar') => [
  ...(lang === 'ar' ? [] : [GUIDE.title]),
  ...(lang === 'en' ? [] : [GUIDE.title_ar]),
  ...(lang ? [lang] : (['en', 'ar'] as const)).flatMap((l) =>
    GUIDE.body[l].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x])),
  ),
];

describe('the preview guide (previewing-changes)', () => {
  it('is put once, as a new guide (revision 0), by a migration after the catalog', () => {
    expect(PUT).toHaveLength(1);
    expect(PUT[0]).toMatchObject({ op: 'put', slug: SLUG, revision: 0 });
    expect(PUT[0]!.file).toMatch(/^\d{4}_help_preview_guide\.sql$/);
    expect(HELP.revisions.get(SLUG)).toBe(1);
  });

  it('takes the place assigned to R9 (95: U7 holds 45, C10a 65, C9a 75)', () => {
    // H11's catalog holds one guide per place (a second put at one place is a 23505).
    expect(GUIDE.sort_order).toBe(95);
    const others = HELP.set.filter((g) => g.slug !== SLUG).map((g) => g.sort_order);
    expect(others).not.toContain(95);
  });

  it("names at most 12 caps, H11's CHECK (help_guide_catalog_caps_ok)", () => {
    // Exactly 12 today: a capability PREVIEW_READ_CAPS gains cannot simply be added to the
    // guide (the put would fail, 23514), so the guide's caps would be narrowed to the areas.
    expect(GUIDE.caps.length).toBeLessThanOrEqual(12);
  });

  it('is for exactly the roles that can preview, by the preview’s own caps', () => {
    expect([...GUIDE.caps].sort()).toEqual([...PREVIEW_READ_CAPS].sort());
    for (const cap of GUIDE.caps) expect(CAPABILITIES).toContain(cap);
    for (const role of ROLES) expect(mayRead(role, GUIDE.caps), role).toBe(canPreview(role));
  });

  it('names admin pages, and each reader reaches one of them from the menu', () => {
    for (const screen of GUIDE.screens) expect(() => pageFileFor(screen)).not.toThrow();
    for (const role of ROLES.filter((r) => mayRead(r, GUIDE.caps))) {
      expect(
        GUIDE.screens.some((s) => reachableHrefs(role).includes(s)),
        role,
      ).toBe(true);
    }
  });

  it('the preview’s own pages offer it, to exactly the roles that may preview', () => {
    const entry = PAGE_GUIDES.find((g) => g.slug === SLUG)!;
    expect([...entry.caps].sort()).toEqual([...GUIDE.caps].sort());
    expect(entry.screens).toEqual(['/admin/preview']);
    for (const role of ROLES) {
      const offered = canPreview(role) ? SLUG : null;
      expect(pageGuideFor('/admin/preview/robots.txt', role), role).toBe(offered);
    }
  });

  it('the Arabic follows the English block for block, in Arabic', () => {
    const kinds = (lang: 'en' | 'ar') =>
      GUIDE.body[lang].map((b) => (b.t === 'ol' ? `ol${b.x.length}` : b.t)).join(',');
    expect(kinds('ar')).toBe(kinds('en'));
    expect(texts('ar').every((t) => /[؀-ۿ]/.test(t))).toBe(true);
  });

  it('keeps the copy rules: no em or en dash, no brand, no markup or control character', () => {
    for (const text of texts()) {
      expect(text).not.toMatch(/[–—]/);
      expect(text.toLowerCase()).not.toMatch(/braii?n|statii?on/);
      expect(text).not.toMatch(/[<>\u0000-\u001f]/);
      expect(text).not.toContain('$guide$');
    }
  });

  it('says what the preview does: the ribbon, red when untrusted, forms, telemetry, passwords', () => {
    const en = texts('en').join(' ');
    expect(PREVIEW_COPY.untrusted).toContain('Reload');
    expect(en).toContain('turns red');
    expect(en).toContain("Forms don't send");
    expect(en).toContain('password prompt');
    expect(en).toContain('/admin/preview/ar/about');
  });
});
