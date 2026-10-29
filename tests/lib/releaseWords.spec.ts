import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { columnLabel, editHref, fieldLabels, plainWords } from '@/lib/release/words';

// What a pending change is called in the admin (Admin v2 R12): the publish dialog's "Fix"
// opens where the change is edited, and its fields read in the editor's words.

const ID = '33333333-3333-4333-8333-333333333301';

/** The page file that answers an admin address (its path, without the query). */
function pageFileOf(href: string): string | null {
  const path = href.split('?')[0]!.replace(/^\/admin\/?/, '');
  const [segment, rest] = path.split('/');
  if (!segment) return null;
  const candidates = rest
    ? // A nested screen of its own (Admin v2 E5: /admin/appearance/header), else an edit screen.
      [`src/pages/admin/${path}.astro`, `src/pages/admin/${segment}/[id].astro`]
    : [`src/pages/admin/${segment}.astro`, `src/pages/admin/${segment}/index.astro`];
  return candidates.find((file) => existsSync(file)) ?? null;
}

describe('where a pending change is edited', () => {
  it('every release-managed type opens a screen that exists', () => {
    for (const type of RELEASE_ENTITY_TYPES) {
      const href = editHref(type, ID);
      expect(href, type).not.toBeNull();
      expect(pageFileOf(href!), `${type}: ${href}`).not.toBeNull();
    }
  });

  it('a resource opens its own edit screen; the singletons their settings screen', () => {
    expect(editHref('service', ID)).toBe(`/admin/services/${ID}`);
    expect(editHref('page_section', ID)).toBe(`/admin/sections/${ID}`);
    expect(editHref('faq_item', ID)).toBe(`/admin/faq/${ID}`);
    expect(editHref('site_profile', ID)).toBe('/admin/settings');
    expect(editHref('seo_defaults', ID)).toBe('/admin/seo?tab=site');
    expect(editHref('site_appearance', ID)).toBe('/admin/appearance/header');
    expect(editHref('page_visibility', ID)).toBe('/admin/visibility');
  });
});

describe('a change’s fields in words', () => {
  it('every column a release may write reads as words, never as its column name', () => {
    for (const type of RELEASE_ENTITY_TYPES) {
      const entry = RELEASE_REGISTRY[type];
      for (const column of [...entry.columns, ...entry.childKeys]) {
        const label = columnLabel(type, column);
        expect(label, `${type}.${column}`).not.toMatch(/_/);
        expect(label.length, `${type}.${column}`).toBeGreaterThan(0);
      }
    }
  });

  it('a column written by a derived key reads as that key’s field (body and its HTML)', () => {
    expect(fieldLabels('blog_post', ['body', 'body_html', 'reading_minutes'])).toHaveLength(1);
    expect(fieldLabels('service', ['title'])).toEqual(['Service name']);
  });

  it('plain words for a key no field names', () => {
    expect(plainWords('metaTitle')).toBe('Meta title');
    expect(plainWords('og_media_id')).toBe('Og media');
    expect(plainWords('sort_order')).toBe('Sort order');
  });
});
