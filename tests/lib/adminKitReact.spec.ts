import { describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Chips, { nextSelection } from '@/components/admin/kit/Chips';
import DataTable, { type DataTableProps } from '@/components/admin/kit/DataTable';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { errorSummaryTitle } from '@/components/admin/kit/ErrorSummary';
import ListRow from '@/components/admin/kit/ListRow';
import Modal from '@/components/admin/kit/Modal';
import Pager from '@/components/admin/kit/Pager';
import SaveStatus, { saveStatusText } from '@/components/admin/kit/SaveStatus';
import Segmented from '@/components/admin/kit/Segmented';
import { MoveButtons, SORT_HINT, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import Tabs from '@/components/admin/kit/Tabs';
import { backdropClose } from '@/components/admin/kit/useDialog';
import KitGallery from '@/components/admin/screens/kit/KitGallery';
import { KIT_ROWS, KIT_SECTIONS } from '@/components/admin/screens/kit/samples';
import { nameOf, renderCell } from '@/components/admin/screens/resources/ResourceTable';
import { pageInfo } from '@/lib/admin/pager';
import { formatDate } from '@/lib/admin/relTime';

// The React kit (Admin v2 F4b, docs/admin-v2/ui.md AV-07), rendered to markup the way an
// island's server render is: the ARIA each piece promises, the words it says, and no style
// attribute (style-src has no 'unsafe-inline'). What moves (keys, focus, drags) is driven in
// a browser by tests/admin/kit.e2e.ts; the Sortable core's state machine by sortable.spec.

function html<P extends object>(component: ComponentType<P>, props: P): string {
  const out = renderToStaticMarkup(createElement(component, props));
  expect(out, 'no style attribute (CSP)').not.toMatch(/\sstyle=/);
  return out;
}

interface Row {
  id: string;
  title: string;
  views: number;
}

const ROWS: Row[] = [
  { id: 'a', title: 'Logo design', views: 1200 },
  { id: 'b', title: 'Packaging', views: 30 },
];

function table(extra: Partial<DataTableProps<Row>> = {}): string {
  return html(DataTable<Row>, {
    caption: 'Services',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'views', label: 'Views', num: true },
    ],
    rows: ROWS,
    rowName: (row) => row.title,
    rowHref: (row) => `/admin/services/${row.id}`,
    total: 60,
    offset: 25,
    onPage: () => {},
    ...extra,
  } as DataTableProps<Row>);
}

describe('DataTable', () => {
  it('names the table, links each row by its name, and aligns numbers', () => {
    const out = table();
    expect(out).toContain('<caption class="visually-hidden">Services</caption>');
    expect(out).toContain(
      '<a class="data-link" href="/admin/services/a" dir="auto">Logo design</a>',
    );
    expect(out).toContain('<th scope="col" class="num">Views</th>');
    expect(out).toContain('<td class="num">1200</td>');
    // No click handler on the row: the link is the row's only way somewhere.
    expect(out).not.toMatch(/<tr[^>]*onclick/i);
  });

  it('says the range in a live region and numbers the pages, the current one marked', () => {
    const out = table();
    expect(out).toContain('<p class="tbl__range" aria-live="polite">26 to 50 of 60</p>');
    expect(out).toMatch(/aria-label="Page 2" aria-current="page"/);
    expect(out).toContain('>Previous<');
  });

  it('labels every checkbox by its row, ticks the chosen, and shows the bulk bar', () => {
    const out = table({
      selection: {
        selected: new Set(['a']),
        onChange: () => {},
        actions: (ids) => createElement('button', { type: 'button' }, `Publish ${ids.length}`),
      },
    });
    expect(out).toContain('aria-label="Select all on this page"');
    expect(out).toMatch(/aria-label="Select Logo design" checked=""/);
    expect(out).toMatch(/<tr data-selected="">/);
    expect(out).toMatch(/<div class="bulkbar" role="region" aria-label="Bulk actions">/);
    expect(out).toContain('<p class="bulkbar__n">1 selected</p>');
    expect(out).toContain('>Publish 1<');
    expect(out).toContain('>Clear selection<');
    // The count is announced by a region that exists before the bar does.
    expect(out).toMatch(/<p class="visually-hidden" aria-live="polite">1 selected<\/p>/);
  });

  it('keeps the live region and drops the bar when nothing is chosen', () => {
    const out = table({
      selection: { selected: new Set(), onChange: () => {}, actions: () => null },
    });
    expect(out).toMatch(/<p class="visually-hidden" aria-live="polite"><\/p>/);
    expect(out).not.toContain('bulkbar');
  });

  it('puts row actions in their own column, named for assistive technology', () => {
    const out = table({
      rowActions: (row) => createElement('button', { type: 'button' }, `Edit ${row.title}`),
    });
    expect(out).toContain('<span class="visually-hidden">Actions</span>');
    expect(out).toContain('<div class="row-acts"><button type="button">Edit Logo design</button>');
  });

  it('says what is empty, says it is loading, and shows an error inline', () => {
    const empty = table({ rows: [], total: 0, offset: 0, empty: { title: 'No services yet' } });
    expect(empty).toContain('No services yet');
    expect(empty).toContain('No results');
    expect(table({ rows: [], total: 0, offset: 0, busy: true })).toContain('Loading…');
    expect(table({ error: 'The server refused.' })).toContain(
      '<p class="msg" data-kind="error" role="alert">The server refused.</p>',
    );
  });
});

describe('Pager (buttons)', () => {
  it('renders nothing for one page, and gaps for many', () => {
    expect(html(Pager, { info: pageInfo(10, 0), onPage: () => {} })).toBe('');
    const out = html(Pager, { info: pageInfo(500, 250), onPage: () => {} });
    expect(out).toContain('pager__gap');
    expect(out).toMatch(/aria-label="Page 11" aria-current="page"/);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'content', label: 'Content', panel: 'Body' },
    { id: 'seo', label: 'SEO', panel: 'Meta' },
  ];

  it('is a named tablist with one tab stop on the chosen tab, its panel shown', () => {
    const out = html(Tabs, { tabs, label: 'Editor', active: 'seo' });
    expect(out).toMatch(/<div class="seg" role="tablist" aria-label="Editor">/);
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>SEO/);
    expect(out).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"[^>]*>Content/);
    // Panels stay mounted (a form across tabs keeps what was typed); the others are hidden.
    expect(out.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(out).toMatch(/role="tabpanel"[^>]*hidden="">Body/);
    expect(out).toMatch(/role="tabpanel"[^>]*tabindex="0">Meta/);
  });

  it('ties each tab to its panel', () => {
    const out = html(Tabs, { tabs, label: 'Editor' });
    const controls = [...out.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    for (const id of controls) expect(out).toContain(`id="${id}"`);
    const labelled = [...out.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    for (const id of labelled) expect(out).toContain(`id="${id}"`);
  });

  it('opens the first tab when the URL names none or an unknown one', () => {
    for (const active of [null, 'nope']) {
      expect(html(Tabs, { tabs, label: 'Editor', active })).toMatch(
        /aria-selected="true"[^>]*>Content/,
      );
    }
  });
});

describe('Segmented and Chips', () => {
  it('a segmented choice is native radios under a legend', () => {
    const out = html(Segmented<'en' | 'ar'>, {
      label: 'Edit in',
      value: 'ar',
      onChange: () => {},
      name: 'lang',
      options: [
        { value: 'en', label: 'English' },
        { value: 'ar', label: 'العربية', lang: 'ar' },
      ],
    });
    expect(out).toMatch(/<fieldset class="seg"><legend class="visually-hidden">Edit in<\/legend>/);
    expect(out.match(/type="radio" name="lang"/g)).toHaveLength(2);
    expect(out).toMatch(
      /<label class="seg__o" lang="ar"><input type="radio" name="lang" checked="" value="ar"/,
    );
    expect(out.match(/checked=""/g)).toHaveLength(1);
  });

  it('chips are toggle buttons in a named group, the count part of the name', () => {
    const out = html(Chips<'all' | 'draft'>, {
      label: 'Filter by status',
      selected: ['draft'],
      onChange: () => {},
      chips: [
        { value: 'all', label: 'All', count: 1200 },
        { value: 'draft', label: 'Draft' },
      ],
    });
    expect(out).toMatch(/<div class="chips" role="group" aria-label="Filter by status">/);
    expect(out).toMatch(/aria-pressed="false">All<span class="chip__n">1,200<\/span>/);
    expect(out).toMatch(/aria-pressed="true">Draft</);
  });

  it('a filter keeps one choice; tags toggle', () => {
    expect(nextSelection(['a'], 'b', false)).toEqual(['b']);
    expect(nextSelection(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(nextSelection(['a', 'b'], 'a', true)).toEqual(['b']);
  });
});

describe('StatusBadge, SaveStatus and ErrorSummary', () => {
  it('a status badge says its status', () => {
    expect(html(StatusBadge, { status: 'published' })).toBe(
      '<span class="badge" data-status="published">Published</span>',
    );
  });

  it('save status is a status region from the first render, in words', () => {
    expect(html(SaveStatus, { state: 'idle' })).toBe(
      '<p class="save-status" data-state="idle" role="status"></p>',
    );
    expect(html(SaveStatus, { state: 'saving' })).toMatch(/class="ic spin".*Saving…/);
    expect(saveStatusText('saved', '2026-10-12T11:05:00Z')).toBe('Saved at 14:05');
    expect(saveStatusText('saved', 'not a date')).toBe('Saved');
    expect(saveStatusText('error', null, 'Someone else changed this.')).toBe(
      'Someone else changed this.',
    );
    expect(saveStatusText('dirty')).toBe('Unsaved changes');
  });

  it('the error summary counts the problems and links each to its field', () => {
    expect(html(ErrorSummary, { errors: [] })).toBe('');
    const out = html(ErrorSummary, {
      errors: [{ id: 'f-name', message: 'Give it a name.' }, { message: 'Add a section.' }],
    });
    expect(out).toMatch(
      /class="error-summary" role="alert" tabindex="-1" aria-labelledby="([^"]+)"/,
    );
    expect(out).toContain('>Fix 2 problems to save</h2>');
    expect(out).toContain('<a href="#f-name">Give it a name.</a>');
    expect(out).toContain('<li>Add a section.</li>');
    expect(errorSummaryTitle(1)).toBe('Fix 1 problem to save');
  });
});

describe('Modal and Drawer', () => {
  it('a modal is a closed native dialog named by its title, Close first, footer last', () => {
    const out = html(Modal, {
      open: false,
      onClose: () => {},
      title: 'Rename',
      sub: 'Nothing is saved.',
      footer: createElement('button', { type: 'button' }, 'Save'),
      children: 'Body',
    });
    expect(out).toMatch(
      /^<dialog class="admin-dialog mdl" aria-labelledby="([^"]+)" aria-describedby="([^"]+)">/,
    );
    expect(out).not.toMatch(/<dialog[^>]* open/);
    const [, title, sub] = out.match(/aria-labelledby="([^"]+)" aria-describedby="([^"]+)"/) ?? [];
    expect(out).toContain(`<h2 id="${title}">Rename</h2>`);
    expect(out).toContain(`<p id="${sub}" class="mdl__sub">Nothing is saved.</p>`);
    expect(out).toMatch(/aria-label="Close"/);
    expect(out).toMatch(/<div class="mdl__b">Body<\/div><div class="mdl__f"><button/);
  });

  it('a drawer has F8’s anatomy: the panel fills the dialog', () => {
    const out = html(Drawer, {
      open: false,
      onClose: () => {},
      title: 'Details',
      size: 'wide',
      children: 'Body',
    });
    expect(out).toMatch(
      /^<dialog class="drw" data-size="wide" aria-labelledby="[^"]+"><div class="drw__panel"><div class="drw__h"><h2/,
    );
    expect(out).toContain('<div class="drw__b">Body</div>');
    expect(out).not.toContain('drw__f');
  });

  it('a click on the backdrop closes the dialog; a click inside does not', () => {
    const close = vi.fn();
    const dialog = { close } as unknown as HTMLDialogElement;
    backdropClose({ target: {} as EventTarget, currentTarget: dialog });
    expect(close).not.toHaveBeenCalled();
    backdropClose({ target: dialog, currentTarget: dialog });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('the Sortable controls (WCAG 2.5.7: a pointer drag is never the only way)', () => {
  it('a handle names its item and points at the instructions', () => {
    const out = html(SortHandle, { label: 'Hero', describedBy: 'hint' });
    expect(out).toMatch(
      /class="drag" data-sortable-handle="" aria-label="Reorder Hero" aria-describedby="hint"/,
    );
  });

  it('Move buttons: up and down, and across lists when there are several', () => {
    const one = html(MoveButtons, { label: 'Hero' });
    expect(one).toContain('aria-label="Move Hero up"');
    expect(one).toContain('aria-label="Move Hero down"');
    expect(one).not.toContain('data-sortable-move="next"');
    const many = html(MoveButtons, { label: 'Hero', lists: true });
    expect(many).toContain('aria-label="Move Hero to the previous list"');
    expect(many).toContain('aria-label="Move Hero to the next list"');
  });

  it('the instructions are told, not shown', () => {
    expect(html(SortHint, { id: 'hint' })).toBe(`<p id="hint" hidden="">${SORT_HINT}</p>`);
  });

  it('a sortable row carries its id and the name the announcements use', () => {
    const out = html(ListRow, { title: 'Hero', sortId: 'hero' });
    expect(out).toMatch(/<li class="li" data-sortable-id="hero" data-sortable-label="Hero">/);
    expect(html(ListRow, { title: 'Hero' })).not.toContain('data-sortable');
  });
});

describe('ResourceTable on the kit', () => {
  it('names a row by its first column, never with nothing', () => {
    const bilingual = { key: 'title', label: 'Title', kind: 'bilingual' as const };
    expect(nameOf({ en: 'Logo', ar: 'شعار' }, bilingual, 'Service')).toBe('Logo');
    expect(nameOf({ en: ' ', ar: 'شعار' }, bilingual, 'Service')).toBe('شعار');
    expect(nameOf(null, bilingual, 'Service')).toBe('Untitled service');
    expect(nameOf('/old', { key: 'from', label: 'From' }, 'Redirect')).toBe('/old');
  });

  it('says a status in words and a date in the studio’s calendar', () => {
    const status = renderToStaticMarkup(
      createElement('div', null, renderCell('draft', { key: 's', label: 'S', kind: 'status' })),
    );
    expect(status).toContain('data-status="draft">Draft</span>');
    expect(renderCell('2026-09-03T22:30:00Z', { key: 'd', label: 'D', kind: 'date' })).toBe(
      formatDate('2026-09-03T22:30:00Z'),
    );
    expect(renderCell(undefined, { key: 'x', label: 'X' })).toBe('—');
  });
});

describe('the kit screen’s island', () => {
  it('renders every stateful piece on its sample data, the tab the URL names open', () => {
    const out = html(KitGallery, { tab: 'seo' });
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>.*SEO/s);
    expect(out).toContain('1 to 25 of 60');
    expect(out).toContain(KIT_ROWS[0]!.title);
    for (const section of KIT_SECTIONS)
      expect(out).toContain(`aria-label="Reorder ${section.label}"`);
    expect(out).toContain('data-sortable-list="left"');
    expect(out).toContain('aria-label="Move Visits to the next list"');
    expect(out.match(/<dialog/g)).toHaveLength(2);
  });
});
