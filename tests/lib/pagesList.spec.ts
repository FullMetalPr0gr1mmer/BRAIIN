import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { loadPagesList, pageCards, templateCards, templateSub } from '@/lib/admin/pages/list';

// The pages list (Admin v2 E1, src/lib/admin/pages/list.ts): the cards from the four reads,
// and the reads themselves (each scoped to the tenant, the caller's own client).

const page = (id: string, slug: string, extra: Record<string, unknown> = {}) => ({
  id,
  slug,
  title: { en: slug.toUpperCase(), ar: 'ع' },
  status: 'published',
  updated_at: '2026-10-20T10:00:00Z',
  ...extra,
});

describe('the page cards', () => {
  it('in the route map’s order, then any other page; each with its path and section count', () => {
    const cards = pageCards(
      [page('p3', 'portfolio-all'), page('p9', 'zeta'), page('p1', 'home'), page('p2', 'about')],
      [
        { id: 's1', page_id: 'p1' },
        { id: 's2', page_id: 'p1' },
        { id: 's3', page_id: 'p2' },
      ],
      [],
      [],
    );
    expect(cards.map((c) => [c.slug, c.path, c.sections])).toEqual([
      ['home', '/', 2],
      ['about', '/about', 1],
      ['portfolio-all', '/portfolio/all', 0],
      ['zeta', null, 0],
    ]);
    expect(cards[0]).toMatchObject({
      title: { en: 'HOME', ar: 'ع' },
      status: 'published',
      updatedAt: '2026-10-20T10:00:00Z',
      visibility: 'public',
      pending: false,
    });
  });

  it('a title with no English shows the slug; a missing status reads as a draft', () => {
    const [card] = pageCards([page('p1', 'about', { title: null, status: null })], [], [], []);
    expect(card).toMatchObject({ title: { en: 'about', ar: '' }, status: 'draft' });
  });

  it('wears its page visibility; an unknown mode reads as public', () => {
    const cards = pageCards(
      [page('p1', 'home'), page('p2', 'about'), page('p3', 'join')],
      [],
      [
        { page_id: 'p2', template: null, mode: 'password' },
        { page_id: 'p3', template: null, mode: 'nonsense' },
        { page_id: null, template: 'service', mode: 'hidden' },
      ],
      [],
    );
    expect(cards.map((c) => c.visibility)).toEqual(['public', 'password', 'public']);
  });

  it('“Unpublished changes”: the page’s own, its sections’, and a new section’s page', () => {
    const cards = pageCards(
      [page('p1', 'home'), page('p2', 'about'), page('p3', 'contact'), page('p4', 'join')],
      [{ id: 's1', page_id: 'p2' }],
      [],
      [
        { entity_type: 'page', entity_id: 'p1', page_id: null },
        { entity_type: 'page_section', entity_id: 's1', page_id: null },
        { entity_type: 'page_section', entity_id: 'new', page_id: 'p3' },
        { entity_type: 'service', entity_id: 'p4', page_id: null },
      ],
    );
    expect(cards.map((c) => [c.slug, c.pending])).toEqual([
      ['home', true],
      ['about', true],
      ['contact', true],
      ['join', false],
    ]);
  });
});

describe('the template cards', () => {
  it('the service and the project page, their counts, where they are edited, hidden or not', () => {
    expect(
      templateCards([{ page_id: null, template: 'case_study', mode: 'hidden' }], {
        services: 28,
        projects: 1,
      }),
    ).toEqual([
      {
        template: 'service',
        title: 'Service page',
        sub: 'Template for 28 published services',
        href: '/admin/services',
        visibility: 'public',
      },
      {
        template: 'case_study',
        title: 'Project page',
        sub: 'Template for 1 published project',
        href: '/admin/portfolio',
        visibility: 'hidden',
      },
    ]);
    expect(templateSub(null, 'a', 'b', 'Template for every service page')).toBe(
      'Template for every service page',
    );
  });
});

describe('the reads', () => {
  const auth = { tenantId: 't-1', userId: 'u', role: 'content_creator' } as unknown as AuthContext;

  /** A client that records every query and answers each table with `rows`. */
  function fake(rows: Record<string, unknown[]>, fail?: string) {
    const calls: { table: string; ops: string[] }[] = [];
    const sb = {
      from(table: string) {
        const call = { table, ops: [] as string[] };
        calls.push(call);
        const q: Record<string, unknown> = {};
        for (const op of ['select', 'eq', 'in', 'limit']) {
          q[op] = (...args: unknown[]) => {
            call.ops.push(`${op}(${args.map((a) => JSON.stringify(a)).join(',')})`);
            return q;
          };
        }
        q['then'] = (resolve: (v: unknown) => void) =>
          resolve(
            table === fail
              ? { data: null, error: { message: 'refused' } }
              : { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length },
          );
        return q;
      },
    };
    return { sb: sb as unknown as SupabaseClient, calls };
  }

  it('reads each table scoped to the tenant, and maps them', async () => {
    const { sb, calls } = fake({
      pages: [page('p1', 'home')],
      page_sections: [{ id: 's1', page_id: 'p1' }],
      services: [{ id: 'a' }, { id: 'b' }],
    });
    const list = await loadPagesList(sb, auth);
    expect(list.pages).toHaveLength(1);
    expect(list.pages[0]?.sections).toBe(1);
    expect(list.templates[0]?.sub).toBe('Template for 2 published services');
    expect(calls.map((c) => c.table).sort()).toEqual(
      [
        'content_drafts',
        'page_sections',
        'page_visibility',
        'pages',
        'portfolio',
        'services',
      ].sort(),
    );
    for (const call of calls) {
      expect(call.ops, call.table).toContain('eq("tenant_id","t-1")');
    }
    const drafts = calls.find((c) => c.table === 'content_drafts')!;
    expect(drafts.ops).toContain('in("entity_type",["page","page_section"])');
    for (const counted of ['services', 'portfolio']) {
      expect(calls.find((c) => c.table === counted)!.ops).toContain('eq("status","published")');
    }
  });

  it('a failed read fails the list (the page says so), never a list missing its rows', async () => {
    const { sb } = fake({}, 'page_sections');
    await expect(loadPagesList(sb, auth)).rejects.toThrow('read page_sections: refused');
  });
});
