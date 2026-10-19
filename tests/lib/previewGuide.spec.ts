import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HelpArticleSeedSchema, type HelpArticleRow } from '@schemas/help';
import { ROLES } from '@/lib/auth/types';
import { CAPABILITIES } from '@/lib/authz/matrix';
import { reachableHrefs } from '@/lib/admin/nav';
import { mayRead, PAGE_GUIDES, PENDING_PAGE_GUIDES } from '@/lib/admin/help';
import { canPreview, PREVIEW_READ_CAPS } from '@/lib/preview/dataset';
import { PREVIEW_COPY } from '@/lib/preview/report';
import { pageFileFor } from '../admin/routes';

// The preview's help guide (Admin v2 R9, U16), written ahead of H11's catalog: the nine keys
// in docs/admin-v2/guides/previewing-changes.json, held here to every rule
// tests/lib/helpCentre.spec.ts holds a seeded guide to, and to what the preview does.
// TODO(H11): when the catalog is on main, a migration carries
//   select app.put_help_guide($guide$ <this file> $guide$::jsonb, 0);
// the PENDING_PAGE_GUIDES entry moves into PAGE_GUIDES, and helpCentre.spec.ts takes over.

const FILE = 'docs/admin-v2/guides/previewing-changes.json';
const RAW = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
const GUIDE: HelpArticleRow = HelpArticleSeedSchema.parse(RAW);

const texts = (lang?: 'en' | 'ar') => [
  ...(lang === 'ar' ? [] : [GUIDE.title]),
  ...(lang === 'en' ? [] : [GUIDE.title_ar]),
  ...(lang ? [lang] : (['en', 'ar'] as const)).flatMap((l) =>
    GUIDE.body[l].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x])),
  ),
];

describe(`the preview guide (${FILE})`, () => {
  it('has exactly the nine keys app.put_help_guide takes, and the seed schema', () => {
    expect(Object.keys(RAW as object).sort()).toEqual(
      [
        'body',
        'caps',
        'minutes',
        'screens',
        'slug',
        'sort_order',
        'tags',
        'title',
        'title_ar',
      ].sort(),
    );
    expect(GUIDE.slug).toBe('previewing-changes');
  });

  it('takes a free place in the list (45, from the free 45, 65, 75, 95, 125)', () => {
    expect(GUIDE.sort_order).toBe(45);
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

  it('its page guide waits for the catalog, with the guide’s caps and one of its screens', () => {
    const entry = PENDING_PAGE_GUIDES.find((g) => g.slug === GUIDE.slug)!;
    expect([...entry.caps]).toEqual([...GUIDE.caps]);
    for (const s of entry.screens) expect(GUIDE.screens).toContain(s);
    expect(PAGE_GUIDES.some((g) => g.slug === GUIDE.slug)).toBe(false);
    const offered = new Set(PAGE_GUIDES.flatMap((g) => g.screens));
    for (const s of entry.screens) expect(offered.has(s), s).toBe(false);
    // Its other screens already have their own page guides (each screen offers one).
    for (const s of GUIDE.screens.filter((x) => !entry.screens.includes(x))) {
      expect(offered.has(s), s).toBe(true);
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
