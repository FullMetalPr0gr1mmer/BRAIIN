import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { canWriteResource, seoAccess } from '@/lib/admin/editorAccess';
import { seoPanelFields } from '@/components/admin/screens/seo/SeoPanel';
import {
  SEO_PANEL_FIELD_NAMES,
  fieldOfId,
  firstTab,
  tabOfElement,
  tabsWithErrors,
  validateTabs,
  visibleTabs,
} from '@/lib/admin/editorTabs';
import { RESOURCES } from '@/lib/admin/resources';
import { RESOURCE_UI, type EditorTabDef } from '@/lib/admin/uiSchema';

// Tabbed editors (Admin v2 U8b): the pure rules EditorForm draws its tabs by, every
// ResourceUi's tabs held sound, and what each role is offered on the post editor.

const blog = RESOURCE_UI['blog']!;
const TABS = blog.tabs!;
const FIELDS = blog.fields;

describe('which field and tab an element belongs to', () => {
  it('a field’s own id, its halves and its items; the longest name wins', () => {
    const fields = [{ name: 'title' }, { name: 'titleAr' }, { name: 'body' }];
    expect(fieldOfId('f-title', fields)).toBe('title');
    expect(fieldOfId('f-title-ar', fields)).toBe('title');
    expect(fieldOfId('f-titleAr', fields)).toBe('titleAr');
    expect(fieldOfId('f-body-en', fields)).toBe('body');
    expect(fieldOfId('f-bodyx', fields)).toBeNull();
    expect(fieldOfId('seo-indexed', fields)).toBeNull();
    expect(fieldOfId('f-options-2-label-ar', [{ name: 'options' }])).toBe('options');
  });

  it('the post editor: author on Content, the schedule on Publishing', () => {
    expect(tabOfElement('f-authorId', TABS, FIELDS)).toBe('content');
    expect(tabOfElement('f-title-ar', TABS, FIELDS)).toBe('content');
    expect(tabOfElement('f-body-en', TABS, FIELDS)).toBe('content');
    expect(tabOfElement('f-scheduledFor', TABS, FIELDS)).toBe('publishing');
    expect(tabOfElement('seo-indexed', TABS, FIELDS)).toBeNull();
  });

  it('the tabs holding an error say so; an empty message is none', () => {
    expect([
      ...tabsWithErrors({ 'f-authorId': 'Required', 'f-status': undefined }, TABS, FIELDS),
    ]).toEqual(['content']);
    expect(
      [...tabsWithErrors({ 'f-title-en': 'x', 'f-scheduledFor': 'y' }, TABS, FIELDS)].sort(),
    ).toEqual(['content', 'publishing']);
    expect(tabsWithErrors({}, TABS, FIELDS).size).toBe(0);
  });
});

describe('the tab an editor opens on', () => {
  it('the address’s tab when offered, else the first', () => {
    expect(firstTab(TABS, 'publishing', { seoAccess: 'full' })).toBe('publishing');
    expect(firstTab(TABS, 'nope', { seoAccess: 'full' })).toBe('content');
    expect(firstTab(TABS, null)).toBe('content');
  });

  it('a role that may change only the SEO lands on SEO; one that only views it does not', () => {
    expect(firstTab(TABS, null, { readOnly: true, seoAccess: 'full' })).toBe('seo');
    expect(firstTab(TABS, 'content', { readOnly: true, seoAccess: 'full' })).toBe('content');
    expect(firstTab(TABS, null, { readOnly: true, seoAccess: 'view' })).toBe('content');
  });

  it('the SEO tab is offered to view and full access only, and never asked into', () => {
    const ids = (tabs: readonly EditorTabDef[]) => tabs.map((t) => t.id);
    expect(ids(visibleTabs(TABS, { seoAccess: 'full' }))).toEqual(['content', 'seo', 'publishing']);
    expect(ids(visibleTabs(TABS, { seoAccess: 'view' }))).toEqual(['content', 'seo', 'publishing']);
    expect(ids(visibleTabs(TABS, { seoAccess: 'none' }))).toEqual(['content', 'publishing']);
    expect(firstTab(visibleTabs(TABS), 'seo')).toBe('content');
  });
});

describe('every ResourceUi with tabs is sound', () => {
  for (const [slug, ui] of Object.entries(RESOURCE_UI)) {
    if (!ui.tabs) continue;
    it(`${slug}: every field in exactly one field tab; a panel tab with its entity`, () => {
      expect(validateTabs(ui)).toEqual([]);
      if (ui.seoEntity) {
        expect(
          ENTITY_SEO.LookupSchema.safeParse({
            entityType: ui.seoEntity,
            entityId: '11111111-1111-4111-8111-111111111111',
          }).success,
        ).toBe(true);
      }
    });
  }

  it('no record field repeats an id of the SEO panel mounted beside it', () => {
    const blank = { en: '', ar: '' };
    expect(seoPanelFields({ title: blank, description: blank }).map((f) => f.name)).toEqual([
      ...SEO_PANEL_FIELD_NAMES,
    ]);
    expect(
      validateTabs({
        slug: 'x',
        seoEntity: 'service',
        fields: [{ name: 'metaTitle', label: 'M', kind: 'bilingual' }],
        tabs: [
          { id: 'content', label: 'C', fields: ['metaTitle'] },
          { id: 'seo', label: 'S', panel: 'seo' },
        ],
      }),
    ).toEqual([`x: "metaTitle" repeats an SEO panel field's id`]);
  });

  it('catches what it exists to catch (not vacuous)', () => {
    const fields = [
      { name: 'a', label: 'A', kind: 'text' as const },
      { name: 'b', label: 'B', kind: 'text' as const },
    ];
    expect(
      validateTabs({
        slug: 'x',
        fields,
        tabs: [
          { id: 'One', label: '1', fields: ['a', 'zz'] },
          { id: 'two', label: '2', fields: ['a'] },
          { id: 'two', label: '2b', panel: 'seo' },
          { id: 'empty', label: 'E' },
        ],
      }),
    ).toEqual([
      'x: tab id "One" is not lowercase words',
      'x: tab "One" names no field "zz"',
      'x: "a" is in "One" and "two"',
      'x: tab "two" twice',
      'x: tab "two" mounts SEO without seoEntity',
      'x: tab "empty" holds nothing',
      'x: "b" is in no tab',
    ]);
  });

  it('the post editor: Content | SEO | Publishing, its SEO for blog posts, its public address', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Content', 'SEO', 'Publishing']);
    expect(blog.seoEntity).toBe('blog_post');
    expect(blog.title).toBe('Creative Knowledge');
    expect(blog.publicHref?.({ status: 'published', slug: 'colour' })).toBe(
      '/creative-knowledge/colour',
    );
    expect(blog.publicHref?.({ status: 'draft', slug: 'colour' })).toBeNull();
    expect(blog.publicHref?.({ status: 'published', slug: '' })).toBeNull();
  });
});

describe('what each role is offered on posts (from ROLE_CAPS)', () => {
  it('writes posts with blog.write, reads them read-only otherwise', () => {
    for (const role of ROLES) {
      expect(canWriteResource('blog', role), role).toBe(can(role, 'blog.write') === 'full');
    }
    expect(canWriteResource('blog', 'seo')).toBe(false);
    expect(canWriteResource('nope', 'admin')).toBe(false);
    expect(RESOURCES['blog']?.readCaps).toContain('seo.entityMeta');
  });

  it('SEO access follows seo.entityMeta: Admin and SEO full, Content Creator view, Developer and Sales none', () => {
    expect(ROLES.map((role) => [role, seoAccess(role)])).toEqual([
      ['admin', 'full'],
      ['content_creator', 'view'],
      ['seo', 'full'],
      ['developer', 'none'],
      ['sales', 'none'],
    ]);
  });

  it('the post pages read the role’s access and the address’s tab on the server', () => {
    const edit = readFileSync('src/pages/admin/blog/[id].astro', 'utf8');
    expect(edit).toContain("canWriteResource('blog', role)");
    expect(edit).toContain("loadSeoPanelSetup(sb, session, 'blog_post', id)");
    expect(edit).toContain("Astro.url.searchParams.get('tab')");
    expect(readFileSync('src/pages/admin/blog/index.astro', 'utf8')).toContain(
      'canCreate={canCreate}',
    );
  });
});
