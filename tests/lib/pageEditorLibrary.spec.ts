import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { STAT_BAND_VARIANTS } from '@schemas/sections';
import { ICON_NAMES } from '@/lib/admin/icons';
import { RENDERED_SECTION_TYPES } from '@/lib/sections/registry';
import { builtInLook } from '@/lib/sections/copy';
import {
  HERO_PRESETS,
  ensureContactInquiry,
  ensureJoinApply,
  homeHeroCtaHref,
} from '@/lib/sections/types';
import { ensureServiceExplorer } from '@/lib/services/servicesPage';
import { PAGE_PATHS } from '@/lib/visibility/routes';
import { pageEditorAccess } from '@/lib/admin/pages/editor';
import { pageFileFor } from '../admin/routes';
import {
  PAGE_NAMES,
  SECTION_KINDS,
  alwaysShown,
  anchorOf,
  availability,
  collectionLinks,
  collectionScreens,
  kindOf,
  linkRows,
  lookKey,
  routeNote,
  routedPage,
  sectionName,
} from '@/components/admin/screens/pageEditor/library';

// The page editor's section library (Admin v2 E1, src/components/admin/screens/pageEditor/
// library.ts): a code map the island reads, held here to the code it describes, so a word it
// says about a section is what the site does: the section types, F6's looks, the anchors the
// components render, the floors the routes keep, and the screens it links to.

const PAGES = Object.keys(PAGE_PATHS);
const LIBRARY = readFileSync('src/components/admin/screens/pageEditor/library.ts', 'utf8');

describe('the kinds of section', () => {
  it('name every section type, each once, with an icon from the sprite', () => {
    expect(Object.keys(SECTION_KINDS).sort()).toEqual([...SECTION_TYPES].sort());
    expect([...RENDERED_SECTION_TYPES].sort()).toEqual([...SECTION_TYPES].sort());
    const names = Object.values(SECTION_KINDS).map((kind) => kind.name);
    expect(new Set(names).size).toBe(names.length);
    for (const kind of Object.values(SECTION_KINDS)) {
      expect((ICON_NAMES as readonly string[]).includes(kind.icon), kind.name).toBe(true);
      expect(kind.description.length, kind.name).toBeGreaterThan(10);
      for (const page of kind.pages ?? []) expect(PAGES, kind.name).toContain(page);
    }
  });

  it('name every routed page', () => {
    expect(Object.keys(PAGE_NAMES).sort()).toEqual([...PAGES].sort());
  });

  it('carry no em or en dash in any of their words (P-12)', () => {
    expect(LIBRARY).not.toMatch(/[–—]/);
  });

  it('know an old row’s unknown type as none, and name it by its type', () => {
    expect(kindOf('retiredType')).toBeNull();
    expect(sectionName({ type: 'retiredType' })).toBe('retiredType');
    expect(sectionName({ type: 'hero', label: '  Top band  ' })).toBe('Top band');
    expect(sectionName({ type: 'hero', label: '   ' })).toBe('Hero');
    expect(sectionName({ type: 'hero', label: null })).toBe('Hero');
  });
});

describe('the look a section takes is F6’s builtInLook (restated: the copy stays server-side)', () => {
  const variants: unknown[] = [undefined, '', 'klein', 'paper', 'junk', ...STAT_BAND_VARIANTS];
  it('agrees on every type, page, variant and place', () => {
    for (const type of RENDERED_SECTION_TYPES) {
      for (const page of [...PAGES, 'custom-page']) {
        for (const variant of variants) {
          for (const firstOfType of [true, false]) {
            expect(
              lookKey(type, { page, variant, firstOfType }),
              `${type} ${page} ${variant}`,
            ).toBe(builtInLook(type, { page, variant, firstOfType }));
          }
        }
      }
    }
  });

  it('dresses the first hero of exactly the preset pages', () => {
    for (const page of Object.keys(HERO_PRESETS)) {
      expect(lookKey('hero', { page, firstOfType: true })).toBe(page);
      expect(lookKey('hero', { page, firstOfType: false })).toBe('default');
    }
    expect(lookKey('hero', { page: 'home', firstOfType: true })).toBe('default');
  });
});

describe('Add section: what each page may take, and why not', () => {
  const at = (page: string, present: string[], type: string) =>
    availability(page, present).find((a) => a.type === type)!;

  it('lists every type, in SECTION_TYPES’ order, each with a reason when it is refused', () => {
    const options = availability('home', []);
    expect(options.map((o) => o.type)).toEqual([...SECTION_TYPES]);
    for (const option of options) {
      if (option.ok) expect(option.reason, option.type).toBeNull();
      else expect(option.reason?.length, option.type).toBeGreaterThan(10);
    }
  });

  it('refuses a kind made for another page, naming that page', () => {
    expect(at('about', [], 'faq')).toEqual({
      type: 'faq',
      ok: false,
      reason: 'Made for the Contact page.',
    });
    expect(at('home', [], 'servicesOverview').ok).toBe(true);
    expect(at('about', [], 'servicesOverview').reason).toBe(
      'Made for the Home and Services pages.',
    );
    expect(at('contact', [], 'faq').ok).toBe(true);
  });

  it('refuses a second of a kind a page holds once, hidden ones included', () => {
    expect(at('home', ['testimonials'], 'testimonials').reason).toBe('This page has one already.');
    expect(at('home', [], 'testimonials').ok).toBe(true);
    // A kind a page may hold twice: the call to action.
    expect(at('home', ['cta'], 'cta').ok).toBe(true);
  });

  it('refuses a second main heading, form or project list, naming the one there', () => {
    expect(at('about', ['aboutWho'], 'hero').reason).toBe(
      'This page already has its main heading, in Who we are.',
    );
    expect(at('home', ['contact'], 'cta').ok).toBe(true);
    expect(at('services', ['hello'], 'hello').reason).toBe(
      'This page already has a form, in Say hello. A page holds one.',
    );
    expect(at('portfolio', ['projectGrid'], 'projectGrid').reason).toBe(
      'This page already lists the projects, in Featured projects.',
    );
  });

  it('offers the blocks (Admin v2 E10) on every routed page, as many as a page needs', () => {
    const blocks = ['textBlock', 'gallery', 'video'] as const;
    for (const page of PAGES) {
      for (const type of blocks) {
        // Every other kind already on the page, the block itself twice over: still offered.
        const full = [...SECTION_TYPES, type, type];
        expect(at(page, full, type), `${page} ${type}`).toEqual({ type, ok: true, reason: null });
      }
    }
    for (const type of blocks) {
      const kind = SECTION_KINDS[type];
      expect(kind.pages, type).toBeUndefined();
      expect(kind.once, type).toBeUndefined();
      expect(kind.group, type).toBeUndefined();
      // No fixed anchor (several a page would share one) and one look, the empty one.
      expect(anchorOf(type, 'home', undefined), type).toBeNull();
      expect(lookKey(type, { page: 'about', firstOfType: true }), type).toBe('default');
      expect(routeNote(type, 'about', true)?.length, type).toBeGreaterThan(20);
    }
    expect(collectionLinks('gallery').map((l) => l.href)).toEqual(['/admin/media']);
    expect(collectionLinks('video').map((l) => l.href)).toEqual(['/admin/media']);
    expect(collectionLinks('textBlock')).toEqual([]);
  });

  it('refuses everything on a page no route shows (custom pages are E11)', () => {
    expect(routedPage('custom-page')).toBeNull();
    expect(availability('custom-page', []).every((o) => !o.ok)).toBe(true);
  });

  it('the seeded compositions are each something their page may hold', () => {
    const seeded: Record<string, string[]> = {
      home: [
        'hero',
        'clientsMarquee',
        'selectedWork',
        'statistics',
        'testimonials',
        'servicesOverview',
        'aboutIntro',
        'slogan',
        'contact',
        'social',
      ],
      about: ['aboutWho', 'leadership', 'statistics', 'social'],
      contact: ['hero', 'contactInquiry', 'contactChannels', 'faq'],
      portfolio: ['workHero', 'proof', 'workIntro', 'projectGrid', 'clientsMarquee', 'cta'],
      'portfolio-all': ['pageHead', 'projectCatalog', 'cta'],
      services: ['hero', 'statistics', 'servicesOverview', 'serviceExplorer', 'hello'],
      join: ['hero', 'joinWhy', 'joinSteps', 'joinApply'],
    };
    for (const [page, types] of Object.entries(seeded)) {
      types.forEach((type, i) => {
        // Each, added to the page as the ones before it stand, would have been offered.
        expect(at(page, types.slice(0, i), type).ok, `${page} ${type}`).toBe(true);
      });
    }
  });
});

describe('the anchors the editor shows are the ones the components render', () => {
  const FILES: Record<string, string> = {
    aboutIntro: 'AboutIntro',
    aboutWho: 'AboutWho',
    clientsMarquee: 'ClientsMarquee',
    contact: 'HomeContact',
    contactInquiry: 'ContactInquiry',
    hello: 'Hello',
    joinApply: 'JoinApply',
    faq: 'FaqAccordion',
    projectGrid: 'ProjectGrid',
    projectCatalog: 'ProjectCatalog',
    selectedWork: 'SelectedWork',
    testimonials: 'TestimonialsSection',
  };

  it('each fixed anchor is an id its component renders', () => {
    for (const [type, file] of Object.entries(FILES)) {
      const anchor = anchorOf(type, 'home', undefined);
      expect(anchor, type).not.toBeNull();
      const source = readFileSync(`src/components/sections/${file}.astro`, 'utf8');
      expect(source, `${type} #${anchor}`).toMatch(new RegExp(`\\bid=["{']?${anchor}["}']?`));
    }
  });

  it('the discipline cards, by page; the numbers band only in its band look', () => {
    expect(anchorOf('servicesOverview', 'home', undefined)).toBe('services');
    expect(anchorOf('servicesOverview', 'services', undefined)).toBe('categories');
    const cards = readFileSync('src/lib/services/cards.ts', 'utf8');
    expect(cards).toContain("return mode === 'page' ? 'categories' : 'services';");
    expect(anchorOf('statistics', 'home', 'band')).toBe('numbers');
    expect(anchorOf('statistics', 'about', 'reach')).toBeNull();
    expect(readFileSync('src/components/sections/Statistics.astro', 'utf8')).toContain(
      "id={variant === 'band' ? 'numbers' : undefined}",
    );
    expect(anchorOf('slogan', 'home', undefined)).toBeNull();
  });
});

describe('the notes on what the route decides are what the routes do', () => {
  it('the two forms the routes keep on their pages, whatever the eye says', () => {
    expect(alwaysShown('contactInquiry', 'contact')).toMatch(/always on this page/);
    expect(alwaysShown('joinApply', 'join')).toMatch(/always on this page/);
    expect(alwaysShown('contactInquiry', 'home')).toBeNull();
    expect(alwaysShown('hero', 'contact')).toBeNull();
    // Hidden, the routes show them; removed, they put them back.
    expect(
      ensureContactInquiry([{ type: 'hero' }, { type: 'contactInquiry', visible: false }]),
    ).toEqual([{ type: 'hero' }, { type: 'contactInquiry', visible: true }]);
    expect(ensureContactInquiry([{ type: 'hero' }]).map((s) => s.type)).toEqual([
      'hero',
      'contactInquiry',
    ]);
    expect(ensureJoinApply([{ type: 'joinApply', visible: false }])).toEqual([
      { type: 'joinApply', visible: true },
    ]);
    expect(ensureJoinApply([{ type: 'hero' }]).map((s) => s.type)).toEqual(['hero', 'joinApply']);
  });

  it('the explorer follows the cards on the Services page', () => {
    expect(routeNote('serviceExplorer', 'services', true)).toMatch(/explorer is shown too/);
    const out = ensureServiceExplorer([
      { type: 'servicesOverview' },
      { type: 'serviceExplorer', visible: false },
    ]);
    expect(out[1]).toEqual({ type: 'serviceExplorer', visible: true });
  });

  it('a hero: the preset pages’ banners, the home button’s rule, a second hero', () => {
    for (const page of Object.keys(HERO_PRESETS)) {
      expect(routeNote('hero', page, true), page).toMatch(/banner, with its own built-in words/);
    }
    expect(routeNote('hero', 'contact', false)).toMatch(/home page’s built-in words/);
    expect(routeNote('hero', 'home', true)).toMatch(/Selected work while a project is featured/);
    expect(homeHeroCtaHref([{ type: 'selectedWork' }], 1)).toBe('#selected-work');
    expect(homeHeroCtaHref([{ type: 'selectedWork', visible: false }], 1)).toBe('/portfolio');
    expect(homeHeroCtaHref([{ type: 'selectedWork' }], 0)).toBe('/portfolio');
    expect(routeNote('hero', 'about', true)).toBeNull();
  });
});

describe('the screens a section links to', () => {
  it('are admin screens that exist', () => {
    const hrefs = new Set(
      SECTION_TYPES.flatMap((type) => collectionLinks(type).map((l) => l.href)),
    );
    expect(hrefs.size).toBeGreaterThan(5);
    for (const href of hrefs) {
      expect(href.startsWith('/admin/'), href).toBe(true);
      expect(() => pageFileFor(href), href).not.toThrow();
    }
  });

  it('name where each table-backed section gets what it shows', () => {
    expect(collectionLinks('testimonials').map((l) => l.title)).toEqual(['Testimonials']);
    expect(collectionLinks('faq').map((l) => l.href)).toEqual(['/admin/faq']);
    expect(collectionLinks('proof').map((l) => l.title)).toEqual(['Numbers', 'Testimonials']);
    expect(collectionLinks('slogan')).toEqual([]);
  });

  it('are links only for a role that opens the screen; the others are named, unlinked', () => {
    const rows = (type: string, role: 'admin' | 'content_creator') =>
      linkRows(type, pageEditorAccess(role).opens).map((l) => [l.href, l.open]);
    // An Admin opens every screen a row names.
    for (const type of SECTION_TYPES) {
      expect(
        linkRows(type, pageEditorAccess('admin').opens).every((l) => l.open),
        type,
      ).toBe(true);
    }
    // A Content Creator: General settings, Forms and Job applications answer it 403.
    expect(rows('joinApply', 'content_creator')).toEqual([
      ['/admin/settings', false],
      ['/admin/applications', false],
    ]);
    expect(rows('contact', 'content_creator')).toEqual([['/admin/forms', false]]);
    expect(rows('social', 'content_creator')).toEqual([['/admin/settings', false]]);
    expect(rows('proof', 'content_creator')).toEqual([
      ['/admin/statistics', true],
      ['/admin/testimonials', true],
    ]);
    expect(collectionScreens()).toEqual(
      [...new Set(SECTION_TYPES.flatMap((t) => collectionLinks(t).map((l) => l.href)))].sort(),
    );
  });
});
