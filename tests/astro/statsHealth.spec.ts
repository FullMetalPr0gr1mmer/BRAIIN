import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import StatsOverview from '@/components/admin/screens/stats/StatsOverview.astro';
import StatsPages from '@/components/admin/screens/stats/StatsPages.astro';
import StatsSearch from '@/components/admin/screens/stats/StatsSearch.astro';
import HealthSummary from '@/components/admin/screens/health/HealthSummary.astro';
import HealthChecklist from '@/components/admin/screens/health/HealthChecklist.astro';
import SpeedTable from '@/components/admin/screens/health/SpeedTable.astro';
import ErrorsTable from '@/components/admin/screens/health/ErrorsTable.astro';
import Refused from '@/components/admin/ui/Refused.astro';
import { formatNumber } from '@/lib/admin/charts';
import { runChecklist } from '@/lib/admin/health/checklist';
import { healthScore } from '@/lib/admin/health/score';
import type { PageviewSummary, PageviewTotals } from '@/lib/admin/stats/pageviews';
import { dayLabel, rangeOfDays } from '@/lib/admin/stats/range';

// Website stats and site health (Admin v2 U2), their server partials rendered with Astro's
// container API on fixtures: the chart tables are the data, a KPI draws no change without a
// previous period, the empty states say what is empty, the state of a checklist row is a
// word, a log's detail is text, and nothing carries a style attribute (CSP).

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

/** The <figure id="…"> of a chart, so its table is read alone. */
function figure(html: string, id: string): string {
  const start = html.indexOf(`<figure class="chart-fig" id="${id}">`);
  expect(start, `figure ${id}`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf('</figure>', start));
}

/** The text of every body cell of the first table in `html`, row by row. */
function tableCells(html: string): string[][] {
  const body = html.split('<tbody>')[1]?.split('</tbody>')[0] ?? '';
  return [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map(([, row]) =>
    [...(row ?? '').matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map(([, cell]) =>
      (cell ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );
}

const NOW = Date.parse('2026-10-15T12:00:00Z');
const range = rangeOfDays(7, NOW);

function totals(en: number[], ar: number[]): PageviewTotals {
  const byDay = en.map((n, i) => ({
    day: `2026-10-${String(9 + i).padStart(2, '0')}`,
    en: n,
    ar: ar[i] ?? 0,
  }));
  const sumEn = en.reduce((a, b) => a + b, 0);
  const sumAr = ar.reduce((a, b) => a + b, 0);
  return {
    total: sumEn + sumAr,
    byDay,
    byLocale: [
      { locale: 'en', views: sumEn },
      { locale: 'ar', views: sumAr },
    ],
    topPaths: [
      { path: '/services/logo', views: 40 },
      { path: '/ar/services/logo', views: 12 },
    ],
  };
}

const EN = [10, 12, 9, 14, 20, 18, 11];
const AR = [4, 5, 3, 6, 8, 7, 5];

function summary(previous: PageviewTotals | null): PageviewSummary {
  return { range, current: totals(EN, AR), previous, firstDay: '2026-09-01' };
}

describe('StatsOverview', () => {
  it('draws the English and Arabic line from the days, its table cell for cell', async () => {
    const html = await render(StatsOverview, { summary: summary(null), leads: null });
    const line = figure(html, 'stats-line');
    expect(tableCells(line)).toEqual(
      summary(null).current.byDay.map((d) => [
        dayLabel(d.day),
        formatNumber(d.en),
        formatNumber(d.ar),
      ]),
    );
    const donut = figure(html, 'stats-donut');
    expect(tableCells(donut).map((row) => row.slice(0, 2))).toEqual([
      ['English', formatNumber(94)],
      ['Arabic', formatNumber(38)],
    ]);
    expect(html).toContain('/services/logo');
  });

  it('shows the KPIs with no change when there is no previous period', async () => {
    const html = await render(StatsOverview, { summary: summary(null), leads: null });
    expect(html).toContain('Page views');
    expect(html).toContain('<p class="stat">132</p>');
    expect(html).toContain('Arabic share');
    expect(html).toMatch(/<p class="stat">28\.8%<\/p>/); // 38 of 132
    expect(html).not.toContain('kpi__d');
    // No lead figures for a role without leads.manage.
    expect(html).not.toContain('New leads');
    expect(html).not.toContain('Inquiries per 1,000 page views');
  });

  it('shows the change against the previous period when the rollups hold it', async () => {
    const html = await render(StatsOverview, {
      summary: summary(totals([5, 5, 5, 5, 5, 5, 6], [2, 2, 2, 2, 2, 2, 2])),
      leads: { current: 6, previous: 3 },
    });
    // 132 against 50: up 164%.
    expect(html).toContain('Up 164% vs the previous 7 days');
    expect(html).toContain('New leads');
    expect(html).toContain('Up 100% vs the previous 7 days');
    expect(html).toContain('Inquiries per 1,000 page views');
    expect(html).toMatch(/<p class="stat">45\.5<\/p>/); // 6 / 132 x 1000
  });

  it('says there were no visits instead of drawing empty charts', async () => {
    const empty: PageviewSummary = {
      range,
      current: totals([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]),
      previous: null,
      firstDay: null,
    };
    const html = await render(StatsOverview, { summary: empty, leads: null });
    expect(html).toContain('No visits counted yet.');
    expect(html).toContain('Visits arrive from visitors who accept analytics cookies.');
    expect(html).not.toContain('chart-fig');
    expect(html).toContain('No views yet');
  });
});

describe('StatsPages', () => {
  it('lists the page of paths with its range under it and the UTC note', async () => {
    const html = await render(StatsPages, {
      pages: {
        rows: [
          { path: '/a', views: 1200, views_en: 1000, views_ar: 200 },
          { path: '/ar/b', views: 9, views_en: 0, views_ar: 9 },
        ],
        total: 52,
        offset: 25,
      },
      url: new URL('https://admin.test/admin/analytics?tab=pages&page=2'),
      days: 30,
    });
    expect(tableCells(html)).toEqual([
      ['/a', '1,200', '1,000', '200'],
      ['/ar/b', '9', '0', '9'],
    ]);
    expect(html).toContain('<p class="tbl__range">26 to 50 of 52</p>');
    expect(html).toContain('midnight to midnight UTC (3 am in Riyadh)');
    // The pager keeps the tab.
    expect(html).toContain('href="/admin/analytics?tab=pages&amp;page=3"');
    // The scroll box can be reached by the keyboard.
    expect(html).toMatch(/<div class="table-wrap" tabindex="0" role="region" aria-label="[^"]+">/);
  });

  it('says when the period has no visits', async () => {
    const html = await render(StatsPages, {
      pages: { rows: [], total: 0, offset: 0 },
      url: new URL('https://admin.test/admin/analytics?tab=pages'),
      days: 7,
    });
    expect(html).toContain('No visits counted in this period.');
  });
});

describe('StatsSearch', () => {
  it('prints the searches as text, with the counts', async () => {
    const html = await render(StatsSearch, {
      search: {
        days: 30,
        total: 6,
        zeroTotal: 3,
        top: [{ q: '<b>logo</b>', locale: 'en', hits: 3, zero: 0 }],
        zero: [{ q: 'شعار', locale: 'ar', hits: 2, zero: 2 }],
      },
    });
    expect(html).toContain('&lt;b&gt;logo&lt;/b&gt;');
    expect(html).not.toContain('<b>logo</b>');
    expect(html).toContain('شعار');
    expect(html).toContain('Arabic');
    expect(html).toContain('<p class="stat">3</p>');
  });
});

describe('HealthSummary', () => {
  it('names the score in words and prints the formula beside it', async () => {
    const score = healthScore({ vitals: ['good', 'good', 'poor'], checks: [{ state: 'ok' }] });
    const html = await render(HealthSummary, {
      score,
      label: 'Needs attention',
      tiles: [
        { label: 'Largest paint (LCP)', value: '1.8 s', rating: 'good', note: '28 days' },
        { label: 'Errors, 7 days', value: 'Not checked' },
      ],
    });
    expect(html).toContain(`aria-label="Site health score: ${score.total} out of 100"`);
    expect(html).toContain(score.formula);
    expect(html).toContain('<dt>Largest paint (LCP)</dt>');
    expect(html).toContain('data-tone="ok">Good</span>');
    expect(html).toContain('Not checked');
  });

  it('with nothing to score, says so instead of drawing a ring', async () => {
    const html = await render(HealthSummary, {
      score: healthScore({ vitals: [], checks: [] }),
      label: 'Not scored yet',
      tiles: [],
    });
    expect(html).not.toContain('class="ring"');
    expect(html).toContain('No score');
  });
});

describe('HealthChecklist', () => {
  const checks = runChecklist({
    role: 'admin',
    vitals: null,
    content: {
      placeholdersLive: 2,
      missingAlt: 0,
      consentMissing: 0,
      published: 3,
      ownDescription: 1,
      missingArabic: 0,
      defaultDescriptionEn: true,
      defaultDescriptionAr: true,
    },
    errors7d: 0,
    lastBackup: null,
    now: NOW,
  });

  it('says each state in words and links a failing row to its fix', async () => {
    const html = await render(HealthChecklist, { checks });
    expect(html).toContain('Needs fixing: </span>');
    expect(html).toContain('Passing: </span>');
    expect(html).toContain('For information: </span>');
    expect(html).toContain('Not judged: </span>');
    expect(html).toMatch(
      /<a class="btn" data-size="sm" href="\/admin">\s*Fix<span class="visually-hidden">: 2 design placeholders are live on the site<\/span>/,
    );
    for (const group of ['Content', 'SEO', 'Speed', 'Errors', 'Security', 'Backups']) {
      expect(html).toContain(`<span>${group}</span>`);
    }
  });

  it('narrows to the groups asked for', async () => {
    const html = await render(HealthChecklist, { checks, groups: ['SEO'] });
    expect(html).toContain('<span>SEO</span>');
    expect(html).not.toContain('<span>Content</span>');
  });
});

describe('SpeedTable', () => {
  it('a page per row, a rating in words where it has the visits, "few visits" where not', async () => {
    const html = await render(SpeedTable, {
      rows: [
        {
          path: '/services/logo',
          samples: 120,
          vitals: {
            LCP: {
              path: '/services/logo',
              metric: 'LCP',
              samples: 120,
              p75: 3000,
              approx: true,
              open: false,
            },
            CLS: {
              path: '/services/logo',
              metric: 'CLS',
              samples: 120,
              p75: 0.02,
              approx: true,
              open: false,
            },
          },
        },
        {
          path: '/about',
          samples: 4,
          vitals: {
            INP: {
              path: '/about',
              metric: 'INP',
              samples: 4,
              p75: 900,
              approx: false,
              open: false,
            },
          },
        },
      ],
      url: new URL('https://admin.test/admin/site-health?tab=speed'),
      days: 28,
    });
    expect(tableCells(html)).toEqual([
      ['/services/logo', '3.0 s Needs work', 'not measured', '0.02 Good', '120'],
      ['/about', 'not measured', '900 ms few visits', 'not measured', '4'],
    ]);
  });

  it('says when nothing is measured yet', async () => {
    const html = await render(SpeedTable, {
      rows: [],
      url: new URL('https://admin.test/admin/site-health?tab=speed'),
      days: 28,
    });
    expect(html).toContain('No speed measured yet.');
  });
});

describe('ErrorsTable', () => {
  it('prints a message and its detail as text, the level as a word', async () => {
    const html = await render(ErrorsTable, {
      logs: {
        rows: [
          {
            id: 1,
            level: 'error',
            source: 'admin:help',
            message: '<script>alert(1)</script> failed',
            detail: '{\n  "error": "boom"\n}',
            created_at: '2026-10-15T11:00:00Z',
          },
        ],
        total: 1,
        offset: 0,
      },
      url: new URL('https://admin.test/admin/site-health?tab=errors'),
      now: NOW,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; failed');
    expect(html).toContain('data-tone="err">Error</span>');
    expect(html).toMatch(/<details class="log__d">\s*<summary>Detail<\/summary>\s*<pre dir="ltr">/);
    expect(html).toContain('1 h ago');
  });

  it('says when nothing is logged', async () => {
    const html = await render(ErrorsTable, {
      logs: { rows: [], total: 0, offset: 0 },
      url: new URL('https://admin.test/admin/site-health?tab=errors'),
    });
    expect(html).toContain('Nothing logged.');
  });
});

describe('Refused', () => {
  it('is the islands’ refusal: the same words in the same message box', async () => {
    const html = await render(Refused);
    expect(html).toBe(
      '<p class="msg" data-kind="error" role="alert">Your role does not allow that.</p>',
    );
  });
});
