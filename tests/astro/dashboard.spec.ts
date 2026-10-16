import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import Board from '@/components/admin/ui/dashboard/Board.astro';
import Banners from '@/components/admin/ui/dashboard/Banners.astro';
import Views from '@/components/admin/ui/dashboard/Views.astro';
import Notes from '@/components/admin/ui/dashboard/Notes.astro';
import Quick from '@/components/admin/ui/dashboard/Quick.astro';
import type { WidgetResults } from '@/lib/admin/dashboard/loaders';

// The dashboard's server partials (Admin v2 U1) rendered with Astro's container API on
// fixtures: the board is the three Sortable lists with each widget a named section; the edit
// controls are in the server HTML but hidden (Customize shows them, with JS); a widget whose
// read failed says so in its frame; chart tables equal the data; a note keeps its line breaks
// as text; a link that leaves the admin opens in a new tab with no handle on this one; and
// nothing carries a style attribute (CSP).

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

type Factory = Parameters<AstroContainer['renderToString']>[0];

async function render(component: Factory, props: Record<string, unknown> = {}): Promise<string> {
  const html = await container.renderToString(component, { props });
  expect(html, 'no style attribute (CSP)').not.toMatch(/\sstyle=/);
  return html;
}

const NOW = Date.parse('2026-10-16T09:00:00Z');

const RESULTS: WidgetResults = {
  kpis: {
    ok: true,
    data: [
      {
        label: 'Page views, 7 days',
        value: 1200,
        delta: 12,
        period: 'the previous 7 days',
        spark: [1, 2, 3],
      },
      { label: 'Arabic share', value: '40%', delta: null },
      { label: 'New leads waiting', value: 3, delta: null },
    ],
  },
  quick: {
    ok: true,
    data: [
      {
        id: 'stats',
        label: 'Website stats',
        href: '/admin/analytics',
        icon: 'chart',
        external: false,
        custom: false,
      },
      {
        id: 'c-abcdefgh12',
        label: 'Drive',
        href: 'https://drive.example.com',
        icon: 'link',
        external: true,
        custom: true,
      },
    ],
  },
  activity: { ok: false },
  applications: { ok: true, data: { count: 2 } },
};

describe('the board', () => {
  const layout = {
    top: ['kpis'],
    left: ['quick', 'activity'],
    right: ['applications'],
    hidden: ['notes'],
  };

  it('is three Sortable lists, each widget a direct child named by its heading', async () => {
    const html = await render(Board, { layout, results: RESULTS, now: NOW });
    for (const [list, label] of [
      ['top', 'Top row'],
      ['left', 'Left column'],
      ['right', 'Right column'],
    ]) {
      expect(html).toContain(`data-sortable-list="${list}" data-sortable-list-label="${label}"`);
    }
    for (const id of ['kpis', 'quick', 'activity', 'applications']) {
      expect(html).toMatch(
        new RegExp(`<section[^>]*data-widget="${id}"[^>]*aria-labelledby="wg-${id}-t"`),
      );
      expect(html).toContain(`id="wg-${id}-t"`);
    }
    // A hidden widget is not rendered (and was not read).
    expect(html).not.toContain('data-widget="notes"');
  });

  it('renders the edit controls hidden, each named for its widget', async () => {
    const html = await render(Board, { layout, results: RESULTS, now: NOW });
    const strips = html.match(/<div class="wg__h"[^>]*>/g) ?? [];
    expect(strips).toHaveLength(4);
    for (const strip of strips) expect(strip).toMatch(/\shidden(\s|>|=)/);
    expect(html).toContain('aria-label="Reorder Quick actions"');
    expect(html).toContain('aria-label="Move Quick actions down"');
    expect(html).toContain('aria-label="Move Quick actions to the top row"');
    expect(html).toContain('aria-label="Move Quick actions to the right column"');
    expect(html).toContain('aria-label="Hide Job applications"');
    // The quick widget's own editor button waits for the island too.
    expect(html).toMatch(/<button[^>]*data-quick-edit[^>]*hidden/);
  });

  it('a widget whose read failed says so in its own frame; the others render', async () => {
    const html = await render(Board, { layout, results: RESULTS, now: NOW });
    const activity = html.slice(html.indexOf('data-widget="activity"'));
    expect(activity.slice(0, 1500)).toContain('This widget could not be loaded.');
    expect(html).toContain('new applications waiting');
    expect(html).toContain('New leads waiting');
  });

  it('an empty board says why', async () => {
    const hiddenAll = await render(Board, {
      layout: { top: [], left: [], right: [], hidden: ['quick'] },
      results: {},
    });
    expect(hiddenAll).toContain('Every widget is hidden.');
    const none = await render(Board, {
      layout: { top: [], left: [], right: [], hidden: [] },
      results: {},
    });
    expect(none).toContain('Your role has no dashboard widgets.');
  });
});

describe('the widgets', () => {
  it('quick actions: an outside link opens in a new tab, noopener noreferrer, and says so', async () => {
    const html = await render(Quick, { items: (RESULTS.quick as { data: unknown }).data });
    expect(html).toMatch(
      /href="https:\/\/drive\.example\.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
    );
    expect(html).toContain('(opens in a new tab)');
    expect(html).toMatch(/href="\/admin\/analytics"(?![^>]*target=)/);
  });

  it('views: the chart’s table is the data, and the leads have their own chart', async () => {
    const html = await render(Views, {
      data: {
        labels: ['15 Oct', '16 Oct'],
        en: [10, 12],
        ar: [3, 4],
        total: 29,
        leads: { labels: ['15 Oct', '16 Oct'], counts: [1, 2], total: 3, capped: false },
      },
    });
    expect(html).toContain('id="dash-views"');
    expect(html).toContain('id="dash-leads"');
    expect(html).toContain('Leads, last 30 days');
    const leads = html.slice(html.indexOf('id="dash-leads"'));
    expect(leads).toMatch(/16 Oct<\/t[hd]>\s*<td[^>]*>2</);
  });

  it('notes: the text as written, its line breaks kept, the rule under it', async () => {
    const html = await render(Notes, {
      notes: {
        body: 'Shoot moved.\n<b>not markup</b>',
        version: 2,
        updatedAt: '2026-10-16T08:00:00Z',
        retentionDays: 180,
      },
      now: NOW,
    });
    expect(html).toContain('Shoot moved.<br>');
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(html).toContain('Do not paste client e-mail addresses or phone numbers here.');
    expect(html).toMatch(/Notes clear\s+180 days after the last edit\./);
    expect(html).toContain('data-notes-editor');
  });

  it('banners: maintenance with its way off for the role that may; placeholders live', async () => {
    const html = await render(Banners, {
      maintenance: true,
      canManageMaintenance: true,
      placeholdersLive: 3,
      attentionShown: true,
    });
    expect(html).toContain('Maintenance mode is on.');
    expect(html).toContain('href="/admin/maintenance"');
    expect(html).toContain('3 placeholders are live on the site.');
    expect(html).toContain('href="#wg-attention"');
    const quiet = await render(Banners, {
      maintenance: true,
      canManageMaintenance: false,
      placeholdersLive: 0,
      attentionShown: false,
    });
    expect(quiet).not.toContain('/admin/maintenance');
    expect(quiet).not.toContain('placeholder');
  });
});
