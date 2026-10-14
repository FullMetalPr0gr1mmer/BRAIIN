import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Chips, { nextSelection } from '@/components/admin/kit/Chips';
import DataTable, {
  pageSelection,
  settleOffset,
  type DataTableProps,
} from '@/components/admin/kit/DataTable';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { errorSummaryTitle } from '@/components/admin/kit/ErrorSummary';
import ListRow from '@/components/admin/kit/ListRow';
import Modal from '@/components/admin/kit/Modal';
import Pager from '@/components/admin/kit/Pager';
import SaveStatus, { saveStatusText } from '@/components/admin/kit/SaveStatus';
import Segmented from '@/components/admin/kit/Segmented';
import {
  MoveButtons,
  SORT_HINT,
  SortHandle,
  SortHint,
  sortLiveId,
} from '@/components/admin/kit/Sortable';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import Tabs from '@/components/admin/kit/Tabs';
import { backdropDismiss } from '@/components/admin/kit/useDialog';
import KitGallery from '@/components/admin/screens/kit/KitGallery';
import { KIT_ROWS, KIT_SECTIONS } from '@/components/admin/screens/kit/samples';
import {
  deleteMessage,
  nameLang,
  nameOf,
  renderCell,
  secondLine,
} from '@/components/admin/screens/resources/ResourceTable';
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

  it('counts and acts on the ticked rows on this page only, never one off screen', () => {
    // 'z' was ticked on another page (or before a filter hid it): the bar must not say
    // "2 selected" for one visible tick, nor hand 'z' to a bulk action (f4b review).
    const given: string[][] = [];
    const out = table({
      selection: {
        selected: new Set(['z', 'a']),
        onChange: () => {},
        actions: (ids) => {
          given.push(ids);
          return createElement('button', { type: 'button' }, `Delete ${ids.length}`);
        },
      },
    });
    expect(out).toContain('<p class="bulkbar__n">1 selected</p>');
    expect(out).toMatch(/<p class="visually-hidden" aria-live="polite">1 selected<\/p>/);
    expect(out).toContain('>Delete 1<');
    expect(given).toEqual([['a']]);

    // Only off-page ticks: no bar at all, and "Select all on this page" is unticked.
    const none = table({
      selection: { selected: new Set(['z']), onChange: () => {}, actions: () => null },
    });
    expect(none).not.toContain('bulkbar');
    expect(none).not.toMatch(/aria-label="Select all on this page" checked=""/);

    expect(pageSelection(new Set(['b', 'z', 'a']), ROWS)).toEqual(['a', 'b']);
    expect(pageSelection(new Set(), ROWS)).toEqual([]);
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

  it('steps back from a page past the end, never calling the list empty', () => {
    // The one row on page 2 was deleted: the page came back empty and 25 rows remain. The
    // table must not say "No services yet" over "1 to 25 of 25" with no pager (f4b review).
    const out = table({ rows: [], total: 25, offset: 25, empty: { title: 'No services yet' } });
    expect(out).not.toContain('No services yet');
    expect(out).not.toContain('1 to 25 of 25');
    expect(out).toContain('Loading…');
    expect(out).toContain('aria-busy="true"');
    // Where it goes: the last page that has rows.
    expect(settleOffset(0, 25, 25)).toBe(0);
    expect(settleOffset(0, 50, 50)).toBe(25);
    expect(settleOffset(0, 26, 75)).toBe(25);
    // Nowhere when the page shows rows, the list is empty, or it is already the last page.
    expect(settleOffset(3, 28, 25)).toBeNull();
    expect(settleOffset(0, 0, 25)).toBeNull();
    expect(settleOffset(0, 30, 25)).toBeNull();
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
    expect(out).toMatch(/aria-pressed="false">All <span class="chip__n">1,200<\/span>/);
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

  it('only a press on the backdrop closes the dialog: one that starts or ends inside does not', () => {
    const close = vi.fn();
    const dialog = { close } as unknown as HTMLDialogElement;
    const field = {} as EventTarget;
    const press = (from: EventTarget, to: EventTarget, click: EventTarget) => {
      const dismiss = backdropDismiss();
      dismiss.onPointerDown({ target: from, currentTarget: dialog });
      dismiss.onPointerUp({ target: to, currentTarget: dialog });
      dismiss.onClick({ target: click, currentTarget: dialog });
    };
    // Selecting a field's text and letting go over the backdrop: the browser sends the
    // click to the <dialog> (the common ancestor). Closing would lose what was typed.
    press(field, dialog, dialog);
    // Pressed on the backdrop, let go inside: the click lands on the <dialog> too.
    press(dialog, field, dialog);
    // A click inside.
    press(field, field, field);
    // A click with no press behind it (the keyboard, assistive technology).
    backdropDismiss().onClick({ target: dialog, currentTarget: dialog });
    expect(close).not.toHaveBeenCalled();

    // Down and up on the backdrop: light dismiss.
    press(dialog, dialog, dialog);
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

  it('the instructions are told, not shown, beside the region that says each step', () => {
    // The live region is SortHint's, rendered beside the list: inside a Modal or Drawer
    // when the list is, so it is heard (f4b review: one on the body is inert there).
    expect(html(SortHint, { id: 'hint' })).toBe(
      `<p id="hint" hidden="">${SORT_HINT}</p>` +
        `<p id="${sortLiveId('hint')}" class="visually-hidden" aria-live="assertive" aria-atomic="true" data-sortable-live=""></p>`,
    );
    expect(sortLiveId('hint')).toBe('hint-live');
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

  it('an Arabic-only title is the link, marked Arabic, and is not said twice', () => {
    const bilingual = { key: 'title', label: 'Title', kind: 'bilingual' as const };
    const cell = (value: unknown) =>
      renderToStaticMarkup(createElement('div', null, secondLine(value, bilingual)));

    // No English: the link says the Arabic (nameOf), in Arabic (WCAG 3.1.2), and the line
    // under it says only that the English is missing (f4b review: it repeated the Arabic).
    expect(nameLang({ en: ' ', ar: 'شعار' }, bilingual)).toBe('ar');
    const arOnly = cell({ en: '', ar: 'شعار' });
    expect(arOnly).toContain('<em>no English</em>');
    expect(arOnly).not.toContain('شعار');
    const link = html(DataTable<Row>, {
      caption: 'Services',
      columns: [{ key: 'title', label: 'Title' }],
      rows: [{ id: 'a', title: 'شعار', views: 0 }],
      rowName: (row) => row.title,
      rowHref: (row) => `/admin/services/${row.id}`,
      rowLang: () => nameLang({ en: '', ar: 'شعار' }, bilingual),
      total: 1,
      offset: 0,
      onPage: () => {},
    });
    expect(link).toContain(
      '<a class="data-link" href="/admin/services/a" dir="auto" lang="ar">شعار</a>',
    );

    // Both sides: English link, the Arabic under it in Arabic and right to left.
    expect(nameLang({ en: 'Logo', ar: 'شعار' }, bilingual)).toBeUndefined();
    expect(cell({ en: 'Logo', ar: 'شعار' })).toBe(
      '<div><div dir="rtl" lang="ar" class="cell-secondary">شعار</div></div>',
    );
    // A missing side is said in English, never marked as Arabic.
    expect(cell({ en: 'Logo', ar: '' })).toBe(
      '<div><div class="cell-secondary"><em>no Arabic</em></div></div>',
    );
    expect(cell(null)).toContain('<em>no English</em>');
    expect(cell(null)).toContain('<em>no Arabic</em>');
    expect(nameLang('/old', { key: 'from', label: 'From' })).toBeUndefined();
  });

  it('names the row in the delete confirmation, isolated from the sentence', () => {
    // The trigger is an icon revealed on hover: the dialog is where a wrong row is caught.
    expect(deleteMessage('Service', 'Logo design')).toBe(
      'Delete the service “\u2068Logo design\u2069”? This cannot be undone.',
    );
    expect(deleteMessage('Service', 'شعار')).toContain('“\u2068شعار\u2069”');
    const source = readFileSync('src/components/admin/screens/resources/ResourceTable.tsx', 'utf8');
    expect(source).toMatch(
      /confirmDialog\(\{\s*message: deleteMessage\(ui\.singular, rowName\(row\)\)/,
    );
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
    expect(out.match(/<dialog/g)).toHaveLength(3);
    // Every sortable list's live region sits beside it, the drawer's inside its dialog.
    expect(out.match(/data-sortable-live=""/g)).toHaveLength(3);
    expect(out).toMatch(/<dialog[^>]*>(?:(?!<\/dialog>)[\s\S])*data-sortable-live=""/);
  });
});
