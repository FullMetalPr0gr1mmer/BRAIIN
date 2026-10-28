import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SeoPanelSetup } from '@/components/admin/screens/seo/types';

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { default: PageEditor } = await import('@/components/admin/screens/pageEditor/PageEditor');
const { default: SectionsColumn } =
  await import('@/components/admin/screens/pageEditor/SectionsColumn');
const { default: AddSectionModal } =
  await import('@/components/admin/screens/pageEditor/AddSectionModal');
const { default: RenameModal } = await import('@/components/admin/screens/pageEditor/RenameModal');
const { availability } = await import('@/components/admin/screens/pageEditor/library');
const { pageEditorAccess } = await import('@/lib/admin/pages/editor');

// The page editor's markup (Admin v2 E1), rendered on the server as its first paint: what each
// role is offered, the sections column's controls, Add a section and Rename. The browser half
// (reads, writes, the Sortable core) is tests/admin/pages.e2e.ts's.

const PAGE = {
  id: '0f0f0f0f-0000-4000-8000-00000000000a',
  slug: 'about',
  title: { en: 'About', ar: 'من نحن' },
  status: 'published',
  path: '/about',
  visibility: 'public' as const,
};
const SEO: SeoPanelSetup = {
  target: { entityType: 'page', entityId: PAGE.id, label: 'About', path: '/about' },
  context: {
    brand: { en: 'Studio', ar: 'ستوديو' },
    titleTemplate: { en: '%s | Studio', ar: '%s | ستوديو' },
    defaults: { title: { en: 'About', ar: 'من نحن' }, description: { en: 'x', ar: 'س' } },
    defaultRobots: 'index,follow',
  },
};

const editor = (role: 'admin' | 'content_creator' | 'seo', patch = {}) =>
  renderToStaticMarkup(
    createElement(PageEditor, {
      page: { ...PAGE, ...patch },
      access: pageEditorAccess(role),
      builtIns: {},
      seo: SEO,
    }),
  );

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('the page editor’s first paint, per role', () => {
  it('Admin: the bar with Visibility, SEO, History and Open page in both languages', () => {
    const html = editor('admin');
    expect(html).toContain('role="group" aria-label="This page"');
    // Back to the list (ui.md's bar starts with Back).
    expect(html).toMatch(/href="\/admin\/pages"><svg[^>]*>.*?<\/svg>All pages<\/a>/);
    expect(html).toContain('href="/admin/visibility"');
    expect(html).toContain('>SEO</button>');
    expect(html).toContain('href="/about" target="_blank" rel="noopener"');
    expect(html).toContain('href="/ar/about"');
    expect(html).toContain('<legend class="visually-hidden">Editing language</legend>');
    // The sections are read once the island runs: the column waits.
    expect(html).toContain('Loading…');
    // Nothing of releases while they are off (the first answer would say so).
    expect(html).not.toContain('Publish…');
    expect(html).not.toContain('/admin/preview/');
  });

  it('Content Creator: no Visibility (maintenance.manage), the SEO drawer read only', () => {
    const html = editor('content_creator');
    expect(html).not.toContain('href="/admin/visibility"');
    expect(html).toContain('>SEO</button>');
    expect(html).toContain('<legend class="visually-hidden">Editing language</legend>');
  });

  it('SEO: no sections and no language bar, its SEO only', () => {
    const html = editor('seo');
    expect(html).not.toContain('Editing language');
    expect(html).not.toContain('aria-labelledby="pe-secs-h"');
    expect(html).toContain('Your role changes this page’s SEO');
    expect(html).toContain('Edit SEO');
    expect(html).not.toContain('History');
  });

  it('a page not open to everyone says so beside its status; a page no route shows has no Open', () => {
    const hidden = editor('admin', { visibility: 'password' });
    expect(hidden).toContain('data-tone="warn">Password</span>');
    const custom = editor('admin', { path: null, slug: 'custom' });
    expect(custom).not.toContain('Open page');
  });

  it('Admin and Content Creator: the live preview column, its frame loaded only after hydration (E2)', () => {
    for (const role of ['admin', 'content_creator'] as const) {
      const html = editor(role);
      expect(html, role).toContain('<section class="pe__preview" aria-labelledby="pe-preview-h">');
      expect(html, role).toContain('<h2 id="pe-preview-h" class="pe__h">Live preview</h2>');
      // Releases are off at first paint (the list answer decides): each save is live.
      expect(html, role).toContain('This is the page as visitors see it.');
      // The narrow screens' switch: the fields or the preview.
      expect(html, role).toContain('<div class="pe__cols" data-view="edit">');
      expect(html, role).toMatch(/<legend class="visually-hidden">Show<\/legend>/);
      expect(text(html), role).toMatch(/Edit\s+Preview/);
      // No frame in the server's HTML: it is mounted once the preview is on screen.
      expect(html, role).not.toContain('<iframe');
      expect(html, role).not.toContain('Loading the preview');
    }
  });

  it('SEO: no preview column; a page no route shows: a note, no switch', () => {
    expect(editor('seo')).not.toContain('Live preview');
    const custom = editor('admin', { path: null, slug: 'custom' });
    expect(custom).toContain('No address of the site shows this page yet');
    expect(custom).toContain('<div class="pe__cols">');
    expect(custom).not.toMatch(/<legend class="visually-hidden">Show<\/legend>/);
  });

  it('no style attribute, no repeated id, no dash in the words (CSP, axe, P-12)', () => {
    for (const role of ['admin', 'content_creator', 'seo'] as const) {
      const html = editor(role);
      expect(html, role).not.toMatch(/\sstyle=/);
      const all = ids(html);
      expect(new Set(all).size, role).toBe(all.length);
      expect(text(html), role).not.toMatch(/[–—]/);
    }
  });
});

describe('the sections column', () => {
  const ROWS = [
    {
      id: 'a',
      type: 'hero',
      label: null,
      visible: true,
      sortOrder: 10,
      version: 1,
      placeholder: false,
    },
    {
      id: 'b',
      type: 'statistics',
      label: 'Our numbers',
      visible: false,
      sortOrder: 20,
      version: 2,
      placeholder: true,
    },
  ];
  const column = (selected = 'b') =>
    renderToStaticMarkup(
      createElement(SectionsColumn, {
        rows: ROWS,
        selected,
        working: false,
        error: '',
        onSelect: () => undefined,
        onToggle: () => undefined,
        onCommit: () => undefined,
        onAdd: () => undefined,
      }),
    );

  it('a named column: Page details, then each section with its handle, eye and moves', () => {
    const html = column();
    expect(html).toContain('<aside class="pe__secs" aria-labelledby="pe-secs-h">');
    expect(html).toContain('>Page details<');
    expect(html).toContain('aria-label="Reorder Hero"');
    expect(html).toContain('aria-label="Move Our numbers up"');
    expect(html).toContain('aria-label="Move Our numbers down"');
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Show Hero on the site"/);
    expect(html).toMatch(
      /role="switch" aria-checked="false" aria-label="Show Our numbers on the site"/,
    );
    expect(html).toContain('>Add section</button>');
  });

  it('the open one is current; a hidden one says so in words; a sample says it is one', () => {
    const html = column();
    expect(html).toMatch(/data-hidden="" aria-current="true" data-sortable-id="b"/);
    expect(html).toContain('Numbers · Hidden · Sample');
    expect(column('page')).toMatch(/<li class="li pe__row" aria-current="true">/);
  });

  it('one section: nothing to move, so no handle and no Move buttons', () => {
    const html = renderToStaticMarkup(
      createElement(SectionsColumn, {
        rows: [ROWS[0]!],
        selected: 'a',
        working: false,
        error: '',
        onSelect: () => undefined,
        onToggle: () => undefined,
        onCommit: () => undefined,
        onAdd: () => undefined,
      }),
    );
    expect(html).not.toContain('Reorder Hero');
    expect(html).not.toContain('Move Hero up');
  });
});

describe('Add a section and Rename', () => {
  it('every kind, the ones the page may not take marked and saying why', () => {
    const html = renderToStaticMarkup(
      createElement(AddSectionModal, {
        open: true,
        onClose: () => undefined,
        options: availability('about', ['aboutWho', 'leadership']),
        working: false,
        onPick: () => undefined,
      }),
    );
    expect(html).toContain('Add a section');
    expect(html).toContain('This page has one already.');
    expect(html).toContain('This page already has its main heading, in Who we are.');
    expect(html).toContain('Made for the Contact page.');
    expect(html.match(/aria-disabled="true"/g)?.length).toBeGreaterThan(5);
    expect(html).toContain('Who the studio is, with a few short columns.');
    const all = ids(html);
    expect(new Set(all).size).toBe(all.length);
  });

  it('a name of up to 60 characters, empty for the kind’s own', () => {
    const html = renderToStaticMarkup(
      createElement(RenameModal, {
        open: true,
        onClose: () => undefined,
        label: 'Our numbers',
        kindName: 'Numbers',
        working: false,
        error: 'no line breaks or control characters',
        onSave: () => undefined,
      }),
    );
    expect(html).toContain('maxLength="60"');
    expect(html).toContain('value="Our numbers"');
    expect(html).toContain('11/60');
    expect(html).toContain('Leave it empty to use the section’s own name, Numbers.');
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toContain('role="alert">no line breaks or control characters</p>');
  });
});
