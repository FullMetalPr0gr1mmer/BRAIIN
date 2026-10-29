import { describe, expect, it } from 'vitest';
import { DISCIPLINE_COLUMNS } from '@/lib/data/disciplines';
import { CARD_COLUMNS, CASE_STUDY_COLUMNS } from '@/lib/data/portfolio';
import { SERVICE_CASE_COLUMNS } from '@/lib/data/serviceCases';
import { SERVICE_COLUMNS, SERVICE_DETAIL_COLUMNS } from '@/lib/data/services';
import { SITE_PROFILE_COLUMNS } from '@/lib/data/siteProfile';
import { MAX_SELECT_DEPTH, parseSelect, PreviewUnsupportedError } from '@/lib/preview/select';
import { loaderQueries } from './loaderQueries';

// The preview's select parser (Admin v2 R8, src/lib/preview/select.ts): every list the
// public loaders send parses, and every form they never send is refused, not approximated.

describe('parseSelect', () => {
  it('parses every exported loader select', () => {
    for (const list of [
      DISCIPLINE_COLUMNS,
      CARD_COLUMNS,
      CASE_STUDY_COLUMNS,
      SERVICE_CASE_COLUMNS,
      SERVICE_COLUMNS,
      SERVICE_DETAIL_COLUMNS,
      SITE_PROFILE_COLUMNS,
    ]) {
      expect(parseSelect(list).length).toBeGreaterThan(0);
    }
  });

  it('parses every select any loader sends (read from the loaders, the private ones too)', () => {
    const selects = loaderQueries().filter((q) => q.table !== null);
    // blog, certifications, disciplines, faq (U7), navigation, pageSections (2), portfolio (3),
    // sectionMedia, seo (4: U10's getSeoRules reads entity_seo and pages), serviceCases,
    // services (2), siteProfile (2: the identity, and U9's icons from media_assets),
    // siteVerification (U11), ga4 (U15), appearance (E5), statistics, taxonomy (3), team: 29
    // `.from()` calls; search's two are rpcs.
    expect(selects).toHaveLength(29);
    for (const q of selects) {
      expect(q.select, `${q.file}:${q.line}`).not.toBeNull();
      expect(() => parseSelect(q.select!), `${q.file}:${q.line}`).not.toThrow();
    }
  });

  it('reads columns and aliased embeds, three tables deep', () => {
    expect(parseSelect(SERVICE_CASE_COLUMNS)).toContainEqual({
      kind: 'embed',
      alias: 'project',
      target: 'portfolio_id',
      items: expect.arrayContaining([
        { kind: 'column', name: 'slug' },
        {
          kind: 'embed',
          alias: 'poster',
          target: 'poster_media_id',
          items: expect.arrayContaining([{ kind: 'column', name: 'storage_path' }]),
        },
      ]),
    });
    expect(parseSelect('id,author:team_members(slug),media:portfolio_media(sort_order)')).toEqual([
      { kind: 'column', name: 'id' },
      {
        kind: 'embed',
        alias: 'author',
        target: 'team_members',
        items: [{ kind: 'column', name: 'slug' }],
      },
      {
        kind: 'embed',
        alias: 'media',
        target: 'portfolio_media',
        items: [{ kind: 'column', name: 'sort_order' }],
      },
    ]);
    // An embed without an alias is returned under its target.
    expect(parseSelect('id,categories(slug)')[1]).toMatchObject({
      alias: 'categories',
      target: 'categories',
    });
  });

  it('ignores whitespace and newlines', () => {
    expect(parseSelect(' id ,\n  slug,\tposter : poster_media_id ( id , kind )\n')).toEqual(
      parseSelect('id,slug,poster:poster_media_id(id,kind)'),
    );
  });

  it('returns the same frozen tree for the same string', () => {
    const tree = parseSelect('id,slug');
    expect(parseSelect('id,slug')).toBe(tree);
    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(tree[0])).toBe(true);
  });

  it.each([
    ['*', /\*/],
    ['id,*', /\*/],
    ['id::text', /cast/],
    ['client:clients!inner(slug)', /hint or inner join/],
    ['client:clients!client_id(slug)', /hint/],
    ['...client:client_id(slug)', /spread/],
    ['content->title', /JSON path/],
    ['content->>title', /JSON path/],
    ['label:name', /column alias/],
    ['"Slug"', /quoted/],
    ['count()', /aggregate/],
    ['id.count()', /aggregate/],
    ['amount.sum()', /aggregate/],
    ['id,,slug', /empty item/],
    ['', /empty list/],
    ['a:b(c', /unbalanced/],
    ['a:b(c))', /unbalanced/],
    ['Slug', /column name/],
    ['a:b(c:d(e:f(g)))', new RegExp(`deeper than ${MAX_SELECT_DEPTH}`)],
  ])('refuses %j', (list, message) => {
    let thrown: unknown;
    try {
      parseSelect(list);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PreviewUnsupportedError);
    expect((thrown as Error).message).toMatch(message);
  });

  it('allows exactly three tables in a path', () => {
    expect(() => parseSelect('a:b(c:d(e))')).not.toThrow();
  });
});
