import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOOTER_COLUMNS_MAX } from '@schemas/admin';
import { siteProfileSingleton } from '@/lib/admin/singletons/siteProfile';
import { footerUi } from '@/lib/admin/ui/footer';
import { profileUi } from '@/lib/admin/ui/profile';
import {
  canAddColumn,
  columnMove,
  columnMoveSaid,
  footerModel,
  movedIds,
  newColumnBody,
  nextSortOrder,
  sketchColumns,
  titleProblem,
  underLink,
} from '@/components/admin/screens/footer/columns';
import { footerSketch, sketchFacts } from '@/components/admin/screens/footer/sketch';

// The Footer screen's pure pieces (Admin v2 E6, src/components/admin/screens/footer/): the
// columns card's model of the navigation list and the writes it makes, the sketch drawn from
// the Basics form, and the form itself (four columns of the identity row, nothing else of it).

type Row = Record<string, unknown>;

let seq = 0;
const nav = (over: Row): Row => ({
  id: `n${(seq += 1)}`,
  location: 'footer',
  parent_id: null,
  label: { en: 'Link', ar: 'رابط' },
  href: '/x',
  visible: true,
  is_key: false,
  is_heading: false,
  sort_order: 10,
  version: 1,
  ...over,
});
const col = (id: string, sort: number, over: Row = {}) =>
  nav({ id, href: null, is_heading: true, sort_order: sort, label: { en: id, ar: id }, ...over });
const link = (id: string, sort: number, over: Row = {}) =>
  nav({ id, sort_order: sort, label: { en: id, ar: id }, href: `/${id}`, ...over });

describe('footerModel: the navigation list as the columns card draws it', () => {
  it('reads only the footer: header rows never appear', () => {
    const model = footerModel([link('h', 1, { location: 'header' }), link('f', 1)]);
    expect(model.columns).toEqual([]);
    expect(model.loose.map((l) => l.id)).toEqual(['f']);
  });

  it('columns in order with their links in order; the rest are loose, in order', () => {
    const model = footerModel([
      col('B', 20),
      col('A', 10),
      link('a2', 20, { parent_id: 'A' }),
      link('a1', 10, { parent_id: 'A' }),
      link('b1', 10, { parent_id: 'B' }),
      link('z', 30),
      link('y', 5),
    ]);
    expect(model.columns.map((c) => [c.id, c.links.map((l) => l.id)])).toEqual([
      ['A', ['a1', 'a2']],
      ['B', ['b1']],
    ]);
    expect(model.loose.map((l) => l.id)).toEqual(['y', 'z']);
    expect(model.columns[0]!.links.every((l) => l.column === 'A')).toBe(true);
    expect(model.loose.every((l) => l.column === null)).toBe(true);
  });

  it('a sub-link under a link is counted on it, never listed as a loose link', () => {
    const model = footerModel([
      link('p', 10),
      link('c1', 1, { parent_id: 'p' }),
      link('c2', 2, { parent_id: 'p' }),
    ]);
    expect(model.loose.map((l) => [l.id, l.children])).toEqual([['p', 2]]);
  });

  it('keeps both titles, a hidden row, the version and a pending change', () => {
    const model = footerModel([
      col('C', 10, {
        label: { en: '  ', ar: 'خدمات' },
        visible: false,
        version: 7,
        draft: { id: 'd1', version: 3, op: 'update' },
      }),
    ]);
    const c = model.columns[0]!;
    expect(c.label).toBe('خدمات');
    expect(c.title).toEqual({ en: '', ar: 'خدمات' });
    expect(c.visible).toBe(false);
    expect(c.version).toBe(7);
    expect(c.pending).toEqual({ id: 'd1', version: 3 });
    expect(footerModel([col('D', 1, { label: null })]).columns[0]!.label).toBe('Untitled column');
  });
});

describe('the columns card’s writes', () => {
  const four = footerModel([col('A', 10), col('B', 20), col('C', 30), col('D', 40)]);

  it('adds a column while there are fewer than four (the database refuses a fifth)', () => {
    expect(FOOTER_COLUMNS_MAX).toBe(4);
    expect(canAddColumn(footerModel([col('A', 10)]))).toBe(true);
    expect(canAddColumn(four)).toBe(false);
  });

  it('a new column is a shown footer heading with no link, after everything there', () => {
    const model = footerModel([col('A', 10), link('x', 70)]);
    const body = newColumnBody({ en: ' Studio ', ar: ' الاستوديو ' }, model);
    expect(body).toEqual({
      location: 'footer',
      label: { en: 'Studio', ar: 'الاستوديو' },
      isHeading: true,
      visible: true,
      sortOrder: 80,
    });
    expect(body).not.toHaveProperty('href');
    expect(nextSortOrder([])).toBe(10);
  });

  it('a title needs both languages, each under 200 characters', () => {
    expect(titleProblem({ en: ' ', ar: '' })).toBe('Write the column title in English and Arabic.');
    expect(titleProblem({ en: 'Studio', ar: '' })).toBe('Write the Arabic title too.');
    expect(titleProblem({ en: '', ar: 'الاستوديو' })).toBe('Write the English title too.');
    expect(titleProblem({ en: 'a'.repeat(201), ar: 'ب' })).toMatch(/under 200/);
    expect(titleProblem({ en: 'Studio', ar: 'الاستوديو' })).toBeNull();
  });

  it('moving a link into a column sets its parent and puts it last there', () => {
    const model = footerModel([
      col('A', 10),
      link('a1', 10, { parent_id: 'A' }),
      link('a2', 30, { parent_id: 'A' }),
      link('x', 50),
    ]);
    const x = model.loose[0]!;
    expect(columnMove(model, x, 'A')).toEqual({ parentId: 'A', sortOrder: 40 });
    const a1 = model.columns[0]!.links[0]!;
    expect(columnMove(model, a1, null)).toEqual({ parentId: null, sortOrder: 60 });
    // Already there, or a column that is not one: no write.
    expect(columnMove(model, a1, 'A')).toBeNull();
    expect(columnMove(model, x, 'nope')).toBeNull();
  });

  it('a link moved with its sub-links says they go with it and stay hidden (code review CR2)', () => {
    // The footer draws one level of links (src/lib/nav/tree.ts footerTree, CR1): a link's
    // sub-links sit under it (parent_id is the link), so the one PATCH that moves the link
    // carries them, and the card says where they went and that the site does not show them.
    const model = footerModel([
      col('A', 10),
      link('p', 10),
      link('p1', 1, { parent_id: 'p' }),
      link('p2', 2, { parent_id: 'p' }),
      link('q', 20),
      link('q1', 1, { parent_id: 'q' }),
      link('r', 30),
    ]);
    const [p, q, r] = model.loose;
    expect(columnMove(model, p!, 'A')).toEqual({ parentId: 'A', sortOrder: 10 });
    expect(columnMoveSaid(p!, 'A')).toBe(
      'p is in the column A. The 2 links under it move with it and stay hidden: the footer shows one level of links.',
    );
    expect(columnMoveSaid(q!, null)).toBe(
      'q is in no column. The link under it moves with it and stays hidden: the footer shows one level of links.',
    );
    expect(columnMoveSaid(r!, 'A')).toBe('r is in the column A.');
    // The card's sub-line says the same of a link with sub-links, wherever it sits.
    expect(underLink(p!)).toBe('2 links under it, not shown in the footer');
    expect(underLink(q!)).toBe('1 link under it, not shown in the footer');
    expect(underLink(r!)).toBe('');
    const screen = readFileSync('src/components/admin/screens/footer/FooterScreen.tsx', 'utf8');
    expect(screen).toContain('columnMoveSaid(link, name)');
    expect(screen).toContain('underLink(link)');
    expect(screen.replace(/\s+/g, ' ')).toContain(
      'The footer shows one level of links: a link under another link moves with it and is not shown.',
    );
  });

  it('Move up and Move down swap neighbours and stop at the ends', () => {
    expect(movedIds(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(movedIds(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(movedIds(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(movedIds(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(movedIds(['a'], 'z', 1)).toEqual(['a']);
  });
});

describe('the sketch draws the columns the site draws (code review CR6)', () => {
  it('a shown column with a shown link; never an empty, hidden or all-hidden one', () => {
    const model = footerModel([
      col('Full', 10),
      link('f1', 10, { parent_id: 'Full' }),
      col('Empty', 20),
      col('Hidden', 30, { visible: false }),
      link('h1', 10, { parent_id: 'Hidden' }),
      col('Quiet', 40),
      link('q1', 10, { parent_id: 'Quiet', visible: false }),
    ]);
    expect(model.columns.map((c) => c.id)).toEqual(['Full', 'Empty', 'Hidden', 'Quiet']);
    expect(sketchColumns(model)).toEqual(['Full']);
    const screen = readFileSync('src/components/admin/screens/footer/FooterScreen.tsx', 'utf8');
    expect(screen).toContain('onTitles(sketchColumns(next));');
  });
});

describe('the sketch, from the Basics form as it is', () => {
  const facts = sketchFacts({
    brand_name: { en: 'Studio', ar: 'استوديو' },
    location: { en: 'Jeddah', ar: 'جدة' },
    contact_email: 'hello@studio.example',
    socials: [
      { network: 'x', url: 'https://x.com/s', visible: true },
      { network: 'instagram', url: 'https://instagram.com/s', visible: false },
      { network: 'linkedin', url: 'https://linkedin.com/s' },
    ],
  });
  const year = String(new Date().getFullYear());

  it('reads the identity: the name, the place, the mailbox and the accounts shown', () => {
    expect(facts).toEqual({
      brand: 'Studio',
      place: 'Jeddah',
      email: 'hello@studio.example',
      socials: 2,
    });
    expect(sketchFacts(null)).toEqual({
      brand: 'Site name',
      place: 'Location',
      email: '',
      socials: 0,
    });
  });

  it('nothing chosen is the footer as built: light, the built-in line, the mailbox, no icons', () => {
    expect(footerSketch({}, facts, [])).toEqual({
      style: 'light',
      copyright: `© ${year} Studio. Jeddah`,
      email: 'hello@studio.example',
      columns: [],
      socials: 0,
    });
  });

  it('follows every choice before it is saved', () => {
    const sketch = footerSketch(
      {
        footerCopyright: { en: '{brand} {year}, made in {place}', ar: '' },
        footerStyle: 'dark',
        footerShowEmail: false,
        footerShowSocial: true,
      },
      facts,
      ['A', 'B', 'C', 'D', 'E'],
    );
    expect(sketch).toEqual({
      style: 'dark',
      copyright: `Studio ${year}, made in Jeddah`,
      email: '',
      columns: ['A', 'B', 'C', 'D'],
      socials: 2,
    });
    // Any style but dark draws light: the attribute is a closed value.
    expect(footerSketch({ footerStyle: 'neon' }, facts, []).style).toBe('light');
  });
});

describe('the Basics form: four columns of the identity row, and nothing else of it', () => {
  const names = footerUi.fields.map((f) => f.name);

  it('names exactly the footer settings, each one a footer column of the identity row', () => {
    expect(names).toEqual([
      'footerCopyright',
      'footerStyle',
      'footerShowEmail',
      'footerShowSocial',
    ]);
    // What the identity's PATCH writes for this form: the four footer columns, nothing else.
    const values = {
      footerCopyright: { en: '© {year} {brand}', ar: '© {year} {brand}' },
      footerStyle: 'dark',
      footerShowEmail: false,
      footerShowSocial: true,
    };
    expect(siteProfileSingleton.toRow(values)).toEqual({
      footer_copyright: values.footerCopyright,
      footer_style: 'dark',
      footer_show_email: false,
      footer_show_social: true,
    });
    expect(footerUi.endpoint).toBe('/api/admin/site-profile');
  });

  it('shares no field with General, so neither form overwrites the other', () => {
    const general = new Set(profileUi.fields.map((f) => f.name));
    expect(names.filter((n) => general.has(n))).toEqual([]);
  });

  it('every group field is a form field; the preview slot is the screen’s own', () => {
    const grouped = footerUi.groups!.flatMap((g) => g.fields);
    expect(grouped.sort()).toEqual([...names].sort());
    const screen = readFileSync('src/components/admin/screens/footer/FooterScreen.tsx', 'utf8');
    expect(screen).toContain('slots={{ preview: <Sketch');
    // useEntitySave's fields keep their identity across renders (E8): the module constant.
    expect(screen).toContain('fields: footerUi.fields,');
  });

  it('the sketch carries no style attribute: classes and one closed data-* value (CSP)', () => {
    const screen = readFileSync('src/components/admin/screens/footer/FooterScreen.tsx', 'utf8');
    expect(screen).not.toMatch(/[\s<]style=\{/);
    expect(screen).toContain('data-style={sketch.style}');
    const css = readFileSync('public/styles/admin/footer.css', 'utf8');
    expect(css).toContain(".ftr-pv__stage[data-style='dark']");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});

describe('one copy of the menu readers (code review CR9)', () => {
  it('the columns card takes a row’s pending change and its two labels from the header’s card', () => {
    const columns = readFileSync('src/components/admin/screens/footer/columns.ts', 'utf8');
    const menu = readFileSync('src/components/admin/screens/header/menu.ts', 'utf8');
    expect(columns).toContain(
      "import { bilingual, pendingOf, type PendingRef } from '../header/menu';",
    );
    expect(columns).not.toMatch(/readDraft|const pendingOf|const text\b/);
    expect(menu).toContain('export const pendingOf');
    expect(menu).toContain('export const bilingual');
  });

  it('reads a label through the shared reader: both trimmed, a missing one empty, a string as English', () => {
    const model = footerModel([
      col('X', 10, { label: { en: ' Work ', ar: 7 } }),
      link('y', 10, { label: 'Plain' }),
    ]);
    expect(model.columns[0]!.title).toEqual({ en: 'Work', ar: '' });
    expect(model.loose[0]!.label).toBe('Plain');
  });
});
