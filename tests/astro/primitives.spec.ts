import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import Avatar from '@/components/admin/ui/Avatar.astro';
import Badge from '@/components/admin/ui/Badge.astro';
import BarList from '@/components/admin/ui/BarList.astro';
import Card from '@/components/admin/ui/Card.astro';
import EmptyState from '@/components/admin/ui/EmptyState.astro';
import Kpi from '@/components/admin/ui/Kpi.astro';
import LinkChips from '@/components/admin/ui/LinkChips.astro';
import LinkTabs from '@/components/admin/ui/LinkTabs.astro';
import ListRow from '@/components/admin/ui/ListRow.astro';
import Note from '@/components/admin/ui/Note.astro';
import PageHead from '@/components/admin/ui/PageHead.astro';
import Pager from '@/components/admin/ui/Pager.astro';
import ServerTable from '@/components/admin/ui/ServerTable.astro';
import StatRows from '@/components/admin/ui/StatRows.astro';
import Timeline from '@/components/admin/ui/Timeline.astro';
import BarsV from '@/components/admin/ui/charts/BarsV.astro';
import Donut from '@/components/admin/ui/charts/Donut.astro';
import Line from '@/components/admin/ui/charts/Line.astro';
import Ring from '@/components/admin/ui/charts/Ring.astro';
import Spark from '@/components/admin/ui/charts/Spark.astro';
import { avatarTone } from '@/lib/admin/avatar';
import { formatNumber } from '@/lib/admin/charts';
import { clockFor } from '@/lib/admin/relTime';

const { formatDate } = clockFor('Asia/Riyadh');

// The admin's server primitives (Admin v2 F4b, docs/admin-v2/ui.md AV-07), rendered with
// Astro's container API: zero JS, so their markup is their whole behaviour. Every render
// here is also held to the strict CSP's rule: no style attribute (style-src has no
// 'unsafe-inline'; a width or a colour is a data-* bucket, an SVG attribute or a class).

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

type Factory = Parameters<AstroContainer['renderToString']>[0];

async function render(
  component: Factory,
  props: Record<string, unknown> = {},
  slots: Record<string, string> = {},
): Promise<string> {
  const html = await container.renderToString(component, { props, slots });
  expect(html, 'no style attribute (CSP)').not.toMatch(/\sstyle=/);
  return html;
}

/** The text of every cell of a chart's "View as table", row by row. */
function tableCells(html: string): string[][] {
  const body = html.split('<tbody>')[1]?.split('</tbody>')[0] ?? '';
  return [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map(([, row]) =>
    [...(row ?? '').matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map(([, cell]) =>
      (cell ?? '').trim(),
    ),
  );
}

const NOW = Date.parse('2026-10-12T12:00:00Z');
const HOUR = 3_600_000;

describe('Badge', () => {
  it('says a status in words and lets admin.css map its tone', async () => {
    const html = await render(Badge, { status: 'draft' });
    expect(html).toMatch(/<span class="badge" data-status="draft">Draft<\/span>/);
  });

  it('takes a tone and a text, or no dot', async () => {
    expect(await render(Badge, { tone: 'ok' }, { default: 'Live' })).toMatch(
      /class="badge" data-tone="ok">Live</,
    );
    expect(await render(Badge, { plain: true }, { default: '12' })).toContain('data-plain');
  });
});

describe('Card', () => {
  it('draws a title alone as the header band, at the level asked', async () => {
    expect(await render(Card, { title: 'Visits' })).toMatch(/<h2 class="card-title">Visits<\/h2>/);
    expect(await render(Card, { title: 'Visits', level: 3 })).toMatch(
      /<h3 class="card-title">Visits<\/h3>/,
    );
  });

  it('draws a title with a sub-line or actions as the prototype header', async () => {
    const html = await render(
      Card,
      { title: 'Visits', sub: 'Last 7 days', flush: true },
      { actions: '<a href="/x">All</a>' },
    );
    expect(html).toContain('card card--flush');
    expect(html).toMatch(/<div class="card__h">.*<h2 class="card__t">Visits<\/h2>/s);
    expect(html).toContain('<p class="card__sub">Last 7 days</p>');
    expect(html).toMatch(/<div class="card__acts">\s*<a href="\/x">All<\/a>/);
  });
});

describe('Avatar', () => {
  it('is decoration beside a name, two letters on a tone hashed from the id', async () => {
    const html = await render(Avatar, { name: 'Content Team', toneKey: 'user-1' });
    expect(html).toContain(`data-tone="${avatarTone('user-1')}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/>CT<\/span>/);
  });

  it('is an image with a name when it stands alone', async () => {
    const html = await render(Avatar, { initials: 'AB', label: 'Sample person', size: 'lg' });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Sample person"');
    expect(html).toContain('data-size="lg"');
    expect(html).not.toContain('aria-hidden');
  });
});

describe('Kpi', () => {
  it('groups the figure and says the change in words, the glyph hidden', async () => {
    const html = await render(Kpi, {
      label: 'Visits',
      value: 3284,
      delta: 12.4,
      period: 'the previous 7 days',
      spark: [1, 2, 3],
    });
    expect(html).toContain('<p class="stat">3,284</p>');
    expect(html).toMatch(/class="kpi__d" data-tone="ok"/);
    expect(html).toMatch(/<span aria-hidden="true">\s*▲ 12%\s*<\/span>/);
    expect(html).toContain('<span class="visually-hidden">Up 12% vs the previous 7 days</span>');
    expect(html).toMatch(/<svg class="kpi__spark"[^>]*aria-hidden="true"/);
  });

  it('reads a fall as good where fewer is better, and draws no pill without history', async () => {
    expect(await render(Kpi, { label: 'Errors', value: 3, delta: -40, good: 'down' })).toMatch(
      /data-tone="ok"/,
    );
    const none = await render(Kpi, { label: 'Storage', value: '214', unit: 'MB' });
    expect(none).not.toContain('kpi__d');
    expect(none).toContain('<span class="stat-unit">MB</span>');
  });

  it('prints a string figure as it is (Arabic digits are never transformed)', async () => {
    expect(await render(Kpi, { label: 'Visits', value: '٣٢٨٤' })).toContain('٣٢٨٤');
  });
});

describe('Note and EmptyState', () => {
  it('a note carries its tone, its icon and, when it reports something, a role', async () => {
    const html = await render(Note, { tone: 'err', role: 'alert' }, { default: '<p>No.</p>' });
    expect(html).toMatch(/class="note" data-tone="err" role="alert"/);
    expect(html).toContain('#i-warn');
    expect(html).toContain('<div class="note__b"><p>No.</p></div>');
  });

  it('an empty state says what is empty, how to fill it, and holds the action', async () => {
    const html = await render(
      EmptyState,
      { title: 'No inquiries yet', text: 'They land here.', icon: 'inbox' },
      { default: '<a class="btn" href="/x">Add one</a>' },
    );
    expect(html).toContain('<p class="empty__t">No inquiries yet</p>');
    expect(html).toContain('<p class="empty__x">They land here.</p>');
    expect(html).toContain('#i-inbox');
    expect(html).toMatch(/<div class="empty__a">\s*<a class="btn"/);
  });
});

describe('Timeline and StatRows', () => {
  it('lists what happened with a <time>: relative words, the full Riyadh time in its title', async () => {
    const at = NOW - 2 * HOUR;
    const html = await render(Timeline, {
      label: 'Recent changes',
      now: NOW,
      items: [
        { title: 'Published Logo', text: 'Content team', at, href: '/admin/services/1' },
        { title: 'No time', at: 'not a date' },
      ],
    });
    expect(html).toMatch(/<ol class="tl" aria-label="Recent changes">/);
    expect(html).toContain(`datetime="${new Date(at).toISOString()}"`);
    expect(html).toContain('title="12 Oct 2026, 13:00"');
    expect(html).toContain('2 h ago');
    expect(html).toMatch(/<a class="data-link" href="\/admin\/services\/1">\s*Published Logo/);
    expect(html.match(/<time/g)).toHaveLength(1);
  });

  it('pairs each figure with its label in a description list', async () => {
    const html = await render(StatRows, {
      rows: [
        { label: 'Sessions', value: 12345 },
        { label: 'Layout shift', value: '0.02' },
      ],
    });
    expect(html).toMatch(/<dl class="stat-rows">/);
    expect(html).toMatch(/<dt>Sessions<\/dt>\s*<dd>12,345<\/dd>/);
    expect(html).toMatch(/<dd>0.02<\/dd>/);
  });
});

describe('ListRow', () => {
  it('links its title over the row, and keeps people’s words in their own direction', async () => {
    const html = await render(ListRow, {
      title: 'Hero',
      sub: 'Banner',
      href: '/x',
      icon: 'layers',
    });
    expect(html).toMatch(/<li class="li">/);
    expect(html).toMatch(/<a class="li__t" href="\/x" dir="auto">\s*Hero\s*<\/a>/);
    expect(html).toMatch(/<span class="li__s" dir="auto">\s*Banner/);
  });

  it('labels a hidden row in words, marks the current one, and holds actions', async () => {
    const html = await render(
      ListRow,
      { title: 'Clients', hidden: true, current: true },
      { actions: '<button type="button">Edit</button>' },
    );
    expect(html).toMatch(/data-hidden aria-current="true"|data-hidden="" aria-current="true"/);
    expect(html).toMatch(/data-tone="gray">\s*Hidden\s*</);
    expect(html).toMatch(/<div class="li__acts">\s*<button/);
    expect(html).toMatch(/<span class="li__t" dir="auto">/);
  });
});

describe('LinkTabs, LinkChips and Pager', () => {
  it('marks only the current tab', async () => {
    const html = await render(LinkTabs, {
      label: 'Services sections',
      current: '/b',
      tabs: [
        { label: 'A', href: '/a' },
        { label: 'B', href: '/b' },
      ],
    });
    expect(html).toMatch(/<nav class="tabs" aria-label="Services sections">/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/b" aria-current="page"/);
  });

  it('makes each chip a link, the count part of its name', async () => {
    const html = await render(LinkChips, {
      label: 'Filter by status',
      current: '/x?s=draft',
      chips: [
        { label: 'All', href: '/x', count: 1200 },
        { label: 'Draft', href: '/x?s=draft' },
      ],
    });
    expect(html).toMatch(/<nav aria-label="Filter by status">/);
    // A space before the count, so the chip's name is "All 1,200", not "All1,200".
    expect(html).toMatch(/>\s*All\s+<span class="chip__n">1,200<\/span>/);
    expect(html).toMatch(/href="\/x\?s=draft" aria-current="page"/);
  });

  it('pages by links that keep the other parameters; the first page has one address', async () => {
    const url = new URL('https://admin.test/admin/log?q=logo&page=3');
    const html = await render(Pager, { total: 500, url });
    expect(html).toMatch(/<nav class="pager" aria-label="Pages">/);
    expect(html).toContain('href="/admin/log?q=logo&amp;page=2" rel="prev"');
    expect(html).toContain('href="/admin/log?q=logo&amp;page=4" rel="next"');
    expect(html).toContain('href="/admin/log?q=logo" aria-label="Page 1"');
    expect(html).toMatch(/aria-label="Page 3" aria-current="page"/);
    expect(html).toContain('pager__gap');
  });

  it('draws no pager for a list that fits on one page', async () => {
    const html = await render(Pager, { total: 25, url: new URL('https://admin.test/admin/log') });
    expect(html).not.toContain('pager');
  });
});

describe('ServerTable', () => {
  const columns = [
    { key: 'title', label: 'Title', title: true },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'views', label: 'Views', kind: 'number' },
    { key: 'updated', label: 'Updated', kind: 'date' },
    { key: 'seen', label: 'Seen', kind: 'ago' },
  ];
  const updated = '2026-09-03T09:30:00Z';

  it('types its cells: a stretched title link, a badge, a tabular number, dates', async () => {
    const html = await render(ServerTable, {
      caption: 'Entries',
      columns,
      rows: [
        { id: '1', title: 'Logo', status: 'published', views: 4321, updated, seen: NOW - HOUR },
      ],
      rowHref: (row: Record<string, unknown>) => `/admin/x/${String(row['id'])}`,
      now: NOW,
    });
    expect(html).toContain('<caption class="visually-hidden">Entries</caption>');
    expect(html).toMatch(/<a class="data-link" href="\/admin\/x\/1" dir="auto">\s*Logo/);
    expect(html).toContain('data-status="published">Published</span>');
    expect(html).toMatch(/<td class="num">\s*4,321\s*<\/td>/);
    expect(html).toContain(formatDate(updated, { now: NOW }));
    expect(html).toMatch(/<time datetime="[^"]+" title="[^"]+">\s*1 h ago\s*<\/time>/);
    expect(html).not.toContain('tbl__foot');
  });

  it('says what is empty instead of an empty table', async () => {
    const html = await render(ServerTable, {
      caption: 'Entries',
      columns,
      rows: [],
      empty: { title: 'No entries yet', text: 'Add one.' },
    });
    expect(html).toMatch(/<td colspan="5">/);
    expect(html).toContain('No entries yet');
  });

  it('draws a person and a tagged sentence (U13), every part as text', async () => {
    const html = await render(ServerTable, {
      caption: 'Activity',
      columns: [
        { key: 'who', label: 'Who', kind: 'person' },
        { key: 'what', label: 'What', kind: 'tagged' },
      ],
      rows: [
        {
          who: { id: 'p-1', name: '<b>Amal</b>', sub: 'Admin' },
          what: {
            badge: { label: 'Lead', tone: 'ok' },
            parts: [
              { text: 'Revealed the contact details of', strong: true },
              { text: 'a lead' },
              { text: '<img src=x>', muted: true },
            ],
          },
        },
        {
          who: {
            id: 'p-2',
            name: 'Bashir',
            sub: 'SEO, former member',
            href: '/admin/audit?actor=p-2',
          },
          what: { badge: { label: 'Edit', tone: 'not-a-tone' }, parts: [] },
        },
      ],
    });
    // The avatar's tone is the person's, and the name sits beside it with its sub-line.
    expect(html).toContain(`data-tone="${avatarTone('p-1')}"`);
    expect(html).toContain('&lt;b&gt;Amal&lt;/b&gt;');
    expect(html).not.toContain('<b>Amal</b>');
    expect(html).toContain('<span class="cell-secondary">Admin</span>');
    // A name with a filter link is a link.
    expect(html).toMatch(/<a href="\/admin\/audit\?actor=p-2" dir="auto">\s*Bashir\s*<\/a>/);
    // The badge, then the sentence: strong, plain, muted; markup in a part stays text.
    expect(html).toMatch(/<span class="badge" data-tone="ok" data-plain[^>]*>\s*Lead\s*<\/span>/);
    expect(html).toMatch(/<b dir="auto">Revealed the contact details of<\/b>/);
    expect(html).toMatch(/<span dir="auto">a lead<\/span>/);
    expect(html).toContain('<span class="cell-secondary" dir="auto">&lt;img src=x&gt;</span>');
    expect(html).not.toContain('<img src=x>');
    // A value of the wrong shape (an unknown tone) is an empty cell, never a guess.
    expect(html).not.toContain('not-a-tone');
    expect(html.match(/class="cell-tagged"/g)).toHaveLength(1);
  });

  it('shows the range and the pager under a paged list', async () => {
    const html = await render(ServerTable, {
      caption: 'Entries',
      columns,
      rows: [{ id: '1', title: 'Logo' }],
      total: 60,
      url: new URL('https://admin.test/admin/x?page=2'),
    });
    expect(html).toContain('<p class="tbl__range">26 to 50 of 60</p>');
    expect(html).toMatch(/aria-label="Page 2" aria-current="page"/);
  });
});

describe('BarList', () => {
  it('writes every number and draws each bar as a 5% bucket of the largest', async () => {
    const html = await render(BarList, {
      label: 'Top pages',
      items: [
        { label: '/a', value: 200 },
        { label: '/b', value: 100, display: '100 visits' },
        { label: '/c', value: 1 },
      ],
    });
    expect(html).toMatch(/<ul class="barlist" aria-label="Top pages">/);
    expect([...html.matchAll(/data-width="(\d+)"/g)].map((m) => m[1])).toEqual(['100', '50', '5']);
    expect(html).toContain('<span class="prog__v">100 visits</span>');
    expect(html).toContain('<span class="prog__v">200</span>');
    expect(html).toMatch(/class="bar" aria-hidden="true"/);
  });
});

describe('charts: an SVG image named by its caption and summary, tabled from the same data', () => {
  const visits = [120, 1320, 101, 134];
  const leads = [4, 6, 3, 8];
  const labels = ['1 Oct', '2 Oct', '3 Oct', '4 Oct'];

  it('Line: the drawing, its name, its legend and its table', async () => {
    const html = await render(Line, {
      id: 'c1',
      caption: 'Visits per day',
      series: [
        { name: 'Visits', data: visits },
        { name: 'Inquiries', data: leads },
      ],
      labels,
    });
    expect(html).toMatch(/<figure class="chart-fig" id="c1">/);
    expect(html).toMatch(/<svg class="chart"[^>]*role="img"[^>]*aria-labelledby="c1-cap c1-sum"/);
    expect(html).toContain('<figcaption id="c1-cap">');
    expect(html).toContain('Visits: highest 1,320 (2 Oct), latest 134 (4 Oct).');
    expect(html.match(/class="ch-line ch-s\d"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<ul class="legend">/);
    expect(html).toContain('View as table');
    // The table IS the data: every label, every value, nothing invented.
    expect(tableCells(html)).toEqual(
      labels.map((label, i) => [label, formatNumber(visits[i]!), formatNumber(leads[i]!)]),
    );
  });

  it('Line: one point is a dot; no data is said in words, with no image', async () => {
    const one = await render(Line, {
      id: 'c2',
      caption: 'One day',
      series: [{ name: 'Visits', data: [5] }],
      labels: ['1 Oct'],
    });
    expect(one).toContain('class="ch-dot ch-s1"');
    expect(one).not.toContain('class="legend"');
    const none = await render(Line, { id: 'c3', caption: 'Nothing', series: [], labels: [] });
    expect(none).toContain('<p class="chart-empty">No data for this period yet.</p>');
    expect(none).not.toContain('<svg');
  });

  it('BarsV: a bar per non-zero value, every value in the table', async () => {
    const data = [
      { label: 'Branding', value: 42 },
      { label: 'Web', value: 0 },
      { label: 'Events', value: 8 },
    ];
    const html = await render(BarsV, { id: 'b1', caption: 'By service', data });
    expect(html.match(/<rect/g)).toHaveLength(2);
    expect(html).toContain('Highest: Branding, 42. Total 50.');
    expect(tableCells(html)).toEqual(data.map((d) => [d.label, formatNumber(d.value)]));
  });

  it('Donut: shares that add up to 100 in the legend and the table', async () => {
    const data = [
      { label: 'Search', value: 1 },
      { label: 'Direct', value: 1 },
      { label: 'Social', value: 1 },
      { label: 'Email', value: 0 },
    ];
    const html = await render(Donut, { id: 'd1', caption: 'Sources', data, center: '3' });
    expect(html.match(/class="ch-seg ch-s\d"/g)).toHaveLength(3);
    const shares = [...html.matchAll(/<b>(\d+)%<\/b>/g)].map((m) => Number(m[1]));
    expect(shares).toHaveLength(4);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
    expect(tableCells(html).map((row) => row[2])).toEqual(shares.map((s) => `${s}%`));
    expect(html).toContain('<text class="ch-center"');
    const empty = await render(Donut, { id: 'd2', caption: 'Sources', data: [] });
    expect(empty).toContain('chart-empty');
  });

  it('Ring: one value, named in words; its tone follows the score', async () => {
    const html = await render(Ring, { value: 87, label: 'Site health score' });
    expect(html).toMatch(/class="ring" data-tone="warn" role="img"/);
    expect(html).toContain('aria-label="Site health score: 87 out of 100"');
    expect(await render(Ring, { value: 95, label: 'Score' })).toContain('data-tone="ok"');
    expect(await render(Ring, { value: 20, label: 'Score' })).toContain('data-tone="err"');
    expect(await render(Ring, { value: 0, label: 'Score' })).not.toContain('ring__arc');
  });

  it('Spark: decoration only, nothing for no data', async () => {
    expect(await render(Spark, { data: [1, 4, 2] })).toMatch(/aria-hidden="true"/);
    expect((await render(Spark, { data: [] })).trim()).toBe('');
  });
});

describe('PageHead: the h1 and the title (C4b)', () => {
  it('prints the title as the h1 by default, with no direction of its own', async () => {
    const html = await render(PageHead, { title: 'Leads', subtitle: '12 inquiries.' });
    expect(html).toMatch(/<h1>Leads<\/h1>/);
    expect(html).toContain('12 inquiries.');
  });

  it('a heading replaces the h1 only, read in its own direction (a person’s name)', async () => {
    const html = await render(PageHead, { title: 'Lead', heading: 'سارة', headingDir: 'auto' });
    expect(html).toMatch(/<h1 dir="auto">سارة<\/h1>/);
    expect(html).not.toMatch(/<h1[^>]*>Lead<\/h1>/);
  });
});
