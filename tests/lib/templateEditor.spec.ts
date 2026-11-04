import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TEMPLATE_COPY_KEYS,
  TEMPLATE_KINDS,
  type TemplateCopyKey,
} from '@schemas/templateCopyKeys';
import { ROLES } from '@/lib/auth/types';
import type { AuthContext } from '@/lib/auth/types';
import { portfolioUi } from '@/lib/admin/ui/portfolio';
import { servicesUi } from '@/lib/admin/ui/services';
import { RESOURCES } from '@/lib/admin/resources';
import { templateCopySingleton } from '@/lib/admin/singletons/templateCopy';
import {
  TEMPLATE_EDITOR_PATHS,
  loadTemplateEditor,
  mayEditTemplates,
  pickItem,
  templateAccess,
  templateGroups,
  templateItem,
} from '@/lib/admin/pages/templates';
import { builtInTemplateCopy } from '@/lib/templates/copy';
import { TEMPLATE_PARTS, TEMPLATE_PART_IDS } from '@/lib/templates/parts';
import {
  COPY_WORDS,
  ITEM_FIELDS,
  ITEM_FIELD_NAMES,
  ITEM_TARGET,
  SHARED_TARGET,
  addressWithItem,
  fullEditorHref,
  itemsOf,
  rowStamp,
  savedSince,
  sharedField,
  unpublishedNote,
} from '@/components/admin/screens/templateEditor/model';

// The template editors (Admin v2 E3, /admin/pages/template/service and /project): the server
// half (who opens them, the picker's groups, the item shown first, the reads) and the island's
// pure model (the item's fields are the full editor's, the shared text's one field covers the
// whole catalogue in the page's parts, the small decisions). The pages' words and the SQL are
// tests/lib/templateCopy.spec.ts and tests/lib/templateCopySql.spec.ts.

const ID = (n: number) => `5eedfa00-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const BI = (en: string, ar = '') => ({ en, ar });

describe('who opens a template editor, and what they may do there', () => {
  it('the holders of pages.write in full (Admin, Content Creator); nobody else', () => {
    expect(ROLES.filter(mayEditTemplates).sort()).toEqual(['admin', 'content_creator']);
  });

  it('the item’s words by its own capability, the shared text by pages.write', () => {
    for (const role of ['admin', 'content_creator'] as const) {
      expect(templateAccess(role, 'service')).toEqual({ item: true, shared: true });
      expect(templateAccess(role, 'project')).toEqual({ item: true, shared: true });
    }
    for (const role of ['seo', 'developer', 'sales'] as const) {
      expect(templateAccess(role, 'service')).toEqual({ item: false, shared: false });
    }
  });

  it('each editor has its address, and the pages list opens it for those roles only', () => {
    expect(TEMPLATE_EDITOR_PATHS).toEqual({
      service: '/admin/pages/template/service',
      project: '/admin/pages/template/project',
    });
    for (const kind of TEMPLATE_KINDS) {
      const page = readFileSync(`src/pages/admin/pages/template/${kind}.astro`, 'utf8');
      expect(page).toContain(`const KIND = '${kind}';`);
      expect(page).toContain('mayEditTemplates(session.role)');
      expect(page).toMatch(/if \(!allowed\) Astro\.response\.status = 403;/);
      // Nothing is read for a refused role.
      expect(page.indexOf('if (allowed && session && sb)')).toBeLessThan(
        page.indexOf('loadTemplateEditor(sb'),
      );
    }
  });
});

describe('the picker', () => {
  const service = (n: number, discipline: string | null, extra: object = {}) => ({
    id: ID(n),
    slug: `s${n}`,
    title: BI(`Service ${n}`, `خدمة ${n}`),
    status: 'published',
    discipline_id: discipline,
    ...extra,
  });

  it('an item: its id, slug, title, status, page and whether the preview renders it', () => {
    expect(templateItem('service', service(1, 'd1'))).toEqual({
      id: ID(1),
      slug: 's1',
      title: BI('Service 1', 'خدمة 1'),
      status: 'published',
      path: '/services/s1',
      previewable: true,
    });
    expect(templateItem('project', { id: ID(2), slug: 'p2', title: null })).toMatchObject({
      path: '/portfolio/p2',
      title: BI('p2'),
      status: 'draft',
    });
    expect(templateItem('service', { id: 'not-a-uuid', slug: 's' })).toBeNull();
    expect(templateItem('service', { id: ID(3), slug: '' })).toBeNull();
  });

  it('services by discipline in the site’s order, a service in none last; empty groups left out', () => {
    const groups = templateGroups(
      'service',
      [service(1, 'd2'), service(2, 'd1'), service(3, null), service(4, 'd2'), service(5, 'gone')],
      [
        { id: 'd1', name: BI('Branding', 'الهوية') },
        { id: 'd2', name: BI('Production') },
        { id: 'd3', name: BI('Marketing') },
      ],
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.slug)])).toEqual([
      ['Branding', ['s2']],
      ['Production', ['s1', 's4']],
      ['No discipline', ['s3', 's5']],
    ]);
  });

  it('projects one flat list in the order read; none is no group', () => {
    const groups = templateGroups('project', [
      { id: ID(2), slug: 'b', title: BI('B'), status: 'draft' },
      { id: ID(1), slug: 'a', title: BI('A'), status: 'published' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeNull();
    expect(itemsOf(groups).map((i) => i.slug)).toEqual(['b', 'a']);
    expect(templateGroups('project', [])).toEqual([]);
  });

  it('the item shown first: the address’s when offered, else the first published, else the first', () => {
    const groups = templateGroups('project', [
      { id: ID(1), slug: 'a', title: BI('A'), status: 'draft' },
      { id: ID(2), slug: 'b', title: BI('B'), status: 'published' },
    ]);
    expect(pickItem(groups, ID(1))).toBe(ID(1));
    expect(pickItem(groups, ID(9))).toBe(ID(2));
    expect(pickItem(groups, null)).toBe(ID(2));
    // None published: the first one.
    expect(pickItem([{ label: null, items: [groups[0]!.items[0]!] }], 'whatever')).toBe(ID(1));
    expect(pickItem([], null)).toBeNull();
  });

  it('reads the tenant’s items and disciplines, archived ones left out, under the person’s client', async () => {
    const calls: string[] = [];
    const sb = {
      from(table: string) {
        calls.push(`from ${table}`);
        const chain = {
          select: (cols: string) => (calls.push(`select ${cols}`), chain),
          eq: (col: string, val: unknown) => (calls.push(`eq ${col}=${String(val)}`), chain),
          neq: (col: string, val: unknown) => (calls.push(`neq ${col}=${String(val)}`), chain),
          order: (col: string) => (calls.push(`order ${col}`), chain),
          limit: (n: number) => (calls.push(`limit ${n}`), chain),
          then: (resolve: (v: unknown) => void) =>
            resolve({
              data:
                table === 'services'
                  ? [service(1, 'd1'), service(2, 'd1', { status: 'draft' })]
                  : [{ id: 'd1', name: BI('Branding') }],
              error: null,
            }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    const auth = { role: 'content_creator', tenantId: 'T1' } as AuthContext;
    const setup = await loadTemplateEditor(sb, auth, 'service', ID(2));
    expect(calls).toContain('from services');
    expect(calls).toContain('eq tenant_id=T1');
    expect(calls).toContain('neq status=archived');
    expect(calls).toContain('from disciplines');
    expect(setup.selected).toBe(ID(2));
    expect(setup.access).toEqual({ item: true, shared: true });
    expect(setup.builtIn).toEqual(builtInTemplateCopy('service'));
    expect(setup.groups.map((g) => g.label)).toEqual(['Branding']);
  });
});

describe('“This service” / “This project”: the full editor’s fields and save', () => {
  it('the same field objects as the full editor, so the save is its save', () => {
    for (const [kind, ui] of [
      ['service', servicesUi],
      ['project', portfolioUi],
    ] as const) {
      expect(ITEM_FIELDS[kind].map((f) => f.name)).toEqual([...ITEM_FIELD_NAMES[kind]]);
      for (const field of ITEM_FIELDS[kind]) {
        expect(ui.fields, `${kind}.${field.name}`).toContain(field);
      }
    }
    expect(ITEM_TARGET).toEqual({
      service: { kind: 'resource', slug: 'services' },
      project: { kind: 'resource', slug: 'portfolio' },
    });
    expect(RESOURCES).toHaveProperty('services');
    expect(RESOURCES).toHaveProperty('portfolio');
    expect(fullEditorHref('service', ID(1))).toBe(`/admin/services/${ID(1)}`);
    expect(fullEditorHref('project', ID(1))).toBe(`/admin/portfolio/${ID(1)}`);
  });
});

describe('“Shared text”: one field over the template’s whole catalogue', () => {
  it('saves to the template_copy singleton, the template’s own column', () => {
    expect(SHARED_TARGET).toEqual({ kind: 'singleton', endpoint: '/api/admin/template-copy' });
    for (const kind of TEMPLATE_KINDS) {
      const field = sharedField(kind, builtInTemplateCopy(kind));
      expect(field).toMatchObject({ name: kind, column: kind, kind: 'object' });
      expect(templateCopySingleton.columns.split(',')).toContain(field.column);
    }
  });

  it('a sub-field per catalogue key, each in exactly one part’s group, in the page’s order', () => {
    for (const kind of TEMPLATE_KINDS) {
      const field = sharedField(kind, builtInTemplateCopy(kind));
      const keys = Object.keys(TEMPLATE_COPY_KEYS[kind]);
      expect(field.itemFields?.map((f) => f.name)).toEqual(keys);
      const grouped = (field.itemGroups ?? []).flatMap((g) => [...g.fields]);
      expect([...grouped].sort()).toEqual([...keys].sort());
      expect(new Set(grouped).size).toBe(grouped.length);
      expect(field.itemGroups?.map((g) => g.id)).toEqual(
        TEMPLATE_PARTS[kind].filter((p) => p.copy.length > 0).map((p) => p.key),
      );
    }
  });

  it('a line: bilingual, its cap, its built-in words as the placeholder; an accent: a word range of its heading', () => {
    for (const kind of TEMPLATE_KINDS) {
      const builtIn = builtInTemplateCopy(kind);
      const field = sharedField(kind, builtIn);
      for (const sub of field.itemFields ?? []) {
        const def = (TEMPLATE_COPY_KEYS[kind] as Record<string, TemplateCopyKey>)[sub.name]!;
        if (def.kind === 'accent') {
          expect(sub).toMatchObject({ kind: 'accent', accent: { of: def.of, mode: 'range' } });
          continue;
        }
        expect(sub).toMatchObject({
          kind: 'bilingual',
          maxLength: def.max,
          placeholder: builtIn[sub.name],
        });
        expect(sub.label, sub.name).toBe(COPY_WORDS[kind][sub.name]?.label);
        expect(sub.label, sub.name).not.toBe(sub.name);
      }
    }
  });

  it('every text key, and only those, has its words; admin copy has no em or en dash', () => {
    for (const kind of TEMPLATE_KINDS) {
      const text = (Object.entries(TEMPLATE_COPY_KEYS[kind]) as [string, TemplateCopyKey][])
        .filter(([, def]) => def.kind === 'text')
        .map(([key]) => key);
      expect(Object.keys(COPY_WORDS[kind]).sort()).toEqual(text.sort());
      for (const [key, words] of Object.entries(COPY_WORDS[kind])) {
        expect(`${words.label} ${words.help}`, key).not.toMatch(/[–—]/);
      }
    }
    for (const kind of TEMPLATE_KINDS) {
      for (const part of TEMPLATE_PARTS[kind]) {
        expect(`${part.name} ${part.own}`, part.key).not.toMatch(/[–—]/);
      }
    }
  });
});

describe('the template parts', () => {
  it('every catalogue key in exactly one part; marker ids unique and tpl- prefixed', () => {
    for (const kind of TEMPLATE_KINDS) {
      const parts = TEMPLATE_PARTS[kind];
      const copy = parts.flatMap((p) => [...p.copy]);
      expect([...copy].sort()).toEqual(Object.keys(TEMPLATE_COPY_KEYS[kind]).sort());
      expect(new Set(copy).size).toBe(copy.length);
      const ids = parts.flatMap((p) => (p.id === null ? [] : [p.id]));
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^tpl-[a-z]+$/);
      expect(Object.values(TEMPLATE_PART_IDS[kind]).sort()).toEqual([...ids].sort());
    }
  });

  it('the pages mark their parts only in a releases preview', () => {
    for (const file of [
      'src/components/service/ServicePage.astro',
      'src/components/case-study/CaseStudyPage.astro',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('Astro.locals.preview !== undefined');
      expect(source, file).toContain('TEMPLATE_PART_IDS');
    }
  });
});

describe('the screen’s small decisions', () => {
  it('the address follows the item shown', () => {
    expect(addressWithItem('https://x.test/admin/pages/template/service', ID(1))).toBe(
      `https://x.test/admin/pages/template/service?item=${ID(1)}`,
    );
    expect(addressWithItem(`https://x.test/a?item=${ID(1)}&b=2`, ID(2))).toBe(
      `https://x.test/a?item=${ID(2)}&b=2`,
    );
  });

  it('a save moves the row’s version or its pending change’s; the first read and a reread do not', () => {
    const row = { version: 3 };
    expect(savedSince(null, row)).toBe(false);
    expect(savedSince(rowStamp(row), { version: 3 })).toBe(false);
    expect(savedSince(rowStamp(row), { version: 4 })).toBe(true);
    const staged = { version: 3, draft: { version: 1 } };
    expect(savedSince(rowStamp(staged), { version: 3, draft: { version: 2 } })).toBe(true);
    expect(savedSince(rowStamp(row), staged)).toBe(true);
  });

  it('an unpublished item says visitors have no page for it yet', () => {
    expect(unpublishedNote('service', 'published')).toBeNull();
    expect(unpublishedNote('project', 'draft')).toMatch(/^This project is not published/);
    expect(unpublishedNote('service', 'scheduled')).toMatch(/^This service is not published/);
  });
});
