import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Savebar from '@/components/admin/screens/release/Savebar';
import PublishDialog from '@/components/admin/screens/release/PublishDialog';
import { buildRows, savebarCounts } from '@/components/admin/screens/release/model';
import { sampleReleaseApi } from '@/components/admin/screens/release/sampleApi';
import { settleChange } from '@/components/admin/screens/release/api';
import { onSettled } from '@/lib/admin/releaseEvents';
import type { Role } from '@/lib/auth/types';

// The savebar and the publish dialog (Admin v2 R12; releases.md §7), rendered on the server
// with what the island hands them: the markup a person meets (a region, words, buttons, the
// rows by area, who a waiting change needs). The selection, the check and the outcomes are the
// pure model's (tests/lib/releaseUiModel.spec.ts) and the browser's (tests/admin/
// releases-ui.e2e.ts, on the kit's Publishing card).

const summaryFor = async (role: Role) => sampleReleaseApi(role).pending();

describe('the savebar', () => {
  it('a region named for what it holds, its count, its areas and its actions', async () => {
    const counts = savebarCounts(buildRows((await summaryFor('content_creator')).items));
    const html = renderToStaticMarkup(
      createElement(Savebar, { counts, onOpen: () => undefined, onDiscardMine: () => undefined }),
    );
    expect(html).toContain('role="region" aria-label="Unpublished changes"');
    expect(html).toContain('You have 5 unpublished changes');
    expect(html).toContain('1 in Pages · 2 in Services · 2 in Our work');
    expect(html).toContain('+3 waiting for someone who can publish');
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+"[^>]*>Discard/);
    expect(html).toContain('Discard my changes (6)');
    expect(html).toContain('href="/admin/preview/" target="_blank"');
    expect(html).toContain('Publish…');
    // The live region is in the page from the first render, empty.
    expect(html).toMatch(/^<p class="visually-hidden" role="status"><\/p>/);
    // CSP: no style attribute (classes and data attributes only).
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('with nothing of mine to publish it says who the changes wait for and offers Review', async () => {
    const counts = savebarCounts(buildRows((await summaryFor('seo')).items));
    expect(counts.publishable).toBe(1);
    const waitingOnly = { ...counts, publishable: 0, mine: 0, byArea: {} };
    const html = renderToStaticMarkup(
      createElement(Savebar, {
        counts: waitingOnly,
        onOpen: () => undefined,
        onDiscardMine: () => undefined,
      }),
    );
    expect(html).toMatch(/\d+ unpublished changes waiting for someone who can publish them/);
    expect(html).toContain('Review…');
    expect(html).not.toContain('Publish…');
    expect(html).not.toContain('Discard my changes');
  });

  it('draws nothing but its live region when nothing is pending', () => {
    const html = renderToStaticMarkup(
      createElement(Savebar, {
        counts: savebarCounts([]),
        onOpen: () => undefined,
        onDiscardMine: () => undefined,
      }),
    );
    expect(html).toBe('<p class="visually-hidden" role="status"></p>');
  });
});

describe('the publish dialog', () => {
  const dialog = async (role: Role, mode: 'publish' | 'review' | 'discard' = 'publish') =>
    renderToStaticMarkup(
      createElement(PublishDialog, {
        open: true,
        mode,
        role,
        api: sampleReleaseApi(role),
        summary: await summaryFor(role),
        onClose: () => undefined,
        onChanged: () => undefined,
      }),
    );

  it('lists the changes by area with their badges, fields and who made them', async () => {
    const html = await dialog('admin');
    expect(html).toContain('Publish to the website');
    expect(html).toContain('Everything ticked goes live together.');
    for (const area of ['Pages', 'Services', 'Our work', 'Settings', 'SEO']) {
      expect(html).toContain(`>${area}</h3>`);
    }
    expect(html).toContain('New order: Services');
    expect(html).toContain('3 moved');
    expect(html).toContain('>Reordered</span>');
    expect(html).toContain('Service name, Tagline, +2');
    expect(html).toContain('lang="ar" dir="rtl">تصميم الشعار</span>');
    expect(html).toContain('Note (optional), shown in Versions');
    expect(html).toContain('maxLength="280"');
    expect(html).toContain('Preview selection');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('a change the role cannot publish is listed, not tickable, and says who can', async () => {
    const html = await dialog('content_creator');
    // The archive waits for an Admin; the identity for an Admin or a Developer; SEO for SEO.
    expect(html).toContain('Needs an Admin<');
    expect(html).toContain('Needs an Admin or a Developer');
    expect(html).toContain('Needs an Admin or SEO');
    const rows = html.split('<li class="pub__row"').slice(1);
    const waiting = rows.filter((row) => row.includes('data-state="waiting"'));
    expect(waiting.length).toBe(3);
    for (const row of waiting) expect(row).not.toContain('type="checkbox"');
  });

  it('review lists without a tick; discard ticks only what the role may throw away', async () => {
    const review = await dialog('seo', 'review');
    expect(review).toContain('Unpublished changes');
    expect(review).not.toContain('type="checkbox"');
    expect(review).not.toContain('Publish ');
    // Every row waits in review, and each says who can publish it (P-2), as in publish mode.
    const rows = review.split('<li class="pub__row"').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(/class="pub__status">(Needs |Scheduled: |No role can publish)/);
    }
    expect(review).toContain('Needs an Admin<');
    const discard = await dialog('seo', 'discard');
    expect(discard).toContain('Discard changes');
    // SEO may throw away the SEO change only.
    expect(discard.match(/type="checkbox"/g)).toHaveLength(1);
    expect(discard).toContain('Your role can’t throw this away.');
  });

  it('asks When: Now by default; the day and the time appear only for Schedule for', async () => {
    const html = await dialog('admin');
    // A plain fieldset named by its own legend, the choice two native radios.
    expect(html).toContain(
      '<fieldset class="pub__when"><legend class="field-legend">When</legend>',
    );
    expect(html).toMatch(/<input type="radio" name="[^"]+" checked="" value="now"\/>Now/);
    expect(html).toMatch(/<input type="radio" name="[^"]+" value="schedule"\/>Schedule for/);
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('type="time"');
    // Nothing to review or throw away goes live at a time.
    for (const mode of ['review', 'discard'] as const) {
      expect(await dialog('admin', mode)).not.toContain('pub__when');
    }
  });

  it('every id is the dialog’s own, so two dialogs on one page never share one', async () => {
    // With releases on, /admin/kit draws the layout's dialog and the kit card's, both always
    // in the DOM (the Modal keeps its body while closed): one page, two dialogs.
    const props = {
      open: true,
      mode: 'publish' as const,
      role: 'admin' as const,
      api: sampleReleaseApi('admin'),
      summary: await summaryFor('admin'),
      onClose: () => undefined,
      onChanged: () => undefined,
    };
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(PublishDialog, { ...props, key: 'layout' }),
        createElement(PublishDialog, { ...props, key: 'kit' }),
      ),
    );
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // Every label and description points at an element that is there.
    for (const ref of html.matchAll(/\s(?:for|aria-labelledby|aria-describedby)="([^"]+)"/g)) {
      for (const id of ref[1]!.split(' ')) expect(ids, id).toContain(id);
    }
  });

  it('the dialog keeps its words free of dashes (P-12)', async () => {
    const text = (await dialog('admin')).replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('Sales sees nothing of releases (C10a, P-2)', () => {
  it('the kit draws no Publishing card for Sales, and the shell never reads the flag for it', () => {
    const kit = readFileSync('src/pages/admin/kit.astro', 'utf8');
    expect(kit).toContain('(CMS_ROLES as readonly string[]).includes(role) ? role : null');
    // R12b review: the read is releasesFlag.ts's, shared by the shell and the create pages.
    const shell = readFileSync('src/lib/admin/shell.ts', 'utf8');
    expect(shell).toContain('releasesRead ?? readReleasesEnabled(sb, auth)');
    const flag = readFileSync('src/lib/admin/releasesFlag.ts', 'utf8');
    expect(flag).toContain(
      'if (!sb || !auth || !(CMS_ROLES as readonly string[]).includes(auth.role)) return false;',
    );
  });
});

describe('settling a conflict in the dialog (R12 pre-merge review)', () => {
  it('tells an editor open on the change once the settle has landed, and never when refused', async () => {
    vi.stubGlobal('window', new EventTarget());
    try {
      const heard: string[] = [];
      const off = onSettled((draftId) => heard.push(draftId));
      const asked: unknown[] = [];
      await settleChange(
        {
          resolve: async (draftId, request) => {
            // Not before the server has the settle: the editor would read the old version.
            expect(heard).toEqual([]);
            asked.push([draftId, request]);
            return {};
          },
        },
        'd1',
        3,
        'keepMine',
        ['title'],
      );
      expect(asked).toEqual([['d1', { version: 3, keepMine: ['title'] }]]);
      expect(heard).toEqual(['d1']);
      const refused = settleChange(
        {
          resolve: async () => {
            throw new Error('draft-conflict');
          },
        },
        'd2',
        1,
        'useLive',
        ['title'],
      );
      await expect(refused).rejects.toThrow('draft-conflict');
      expect(heard).toEqual(['d1']);
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the dialog settles through it, never with a bare resolve that tells no editor', () => {
    const dialog = readFileSync('src/components/admin/screens/release/PublishDialog.tsx', 'utf8');
    expect(dialog).toContain('await settleChange(api, draftId, version, choice, columns);');
    expect(dialog).not.toMatch(/\bapi\.resolve\(/);
  });
});
