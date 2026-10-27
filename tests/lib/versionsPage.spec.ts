import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { visibleNav } from '@/lib/admin/nav';
import { clockFor } from '@/lib/admin/relTime';
import { RESOURCES } from '@/lib/admin/resources';
import { HISTORY_TYPE_OF_SLUG, historyTargetOf } from '@/lib/admin/historyTarget';
import { DEFAULT_LAYOUTS, RELEASE_WIDGETS, widgetsFor } from '@/lib/admin/dashboard/widgets';
import { withoutWidgets } from '@/lib/admin/dashboard/layout';
import { PENDING_ANY_CAP } from '@/lib/release/draftEndpoints';
import { PREVIEW_READ_CAPS } from '@/lib/preview/dataset';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { RELEASE_READ_CAPS } from '@/lib/release/readCaps';
import { loadVersionsPage, mayOpenVersions } from '@/lib/release/versionsPage';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import { ClockProvider } from '@/components/admin/kit/clock';
import Versions from '@/components/admin/screens/versions/Versions';
import {
  COPY,
  changesLine,
  failedLine,
  kindLine,
  purgeLine,
  refusedNames,
} from '@/components/admin/screens/versions/model';
import {
  SAMPLE_VERSIONS_API,
  sampleStatus,
  sampleVersions,
} from '@/components/admin/screens/versions/sample';
import { cacheWords, pendingWords } from '@/components/admin/screens/release/PublishCard';
import { HISTORY_COPY, historyRowTitle } from '@/components/admin/screens/history/model';
import { T } from '../fixtures/stagedDb';
import { ADMIN, draftRow, makeDb } from '../fixtures/stagedRoute';
import { client } from '../fixtures/stagedDb';

// Backups & versions (Admin v2 R13): who opens it (B7.3: the release read capabilities, never
// Sales), what the page reads (nothing but the flag while releases are off), the words of its
// list and of the history drawer and the publish card (P-12), the list's markup as the island
// draws it, and the client-safe copies of server lists (the read capabilities, the history
// targets) held equal to the registry they copy.

const NOW = Date.UTC(2026, 9, 27, 9, 0);
const DASH = /[–—]/;

describe('who opens Backups & versions (plan B7.3)', () => {
  it('the menu’s capabilities are the registry’s read capabilities, written out for the browser', () => {
    expect([...RELEASE_READ_CAPS].sort()).toEqual([...PENDING_ANY_CAP].sort());
    expect([...RELEASE_READ_CAPS].sort()).toEqual([...PREVIEW_READ_CAPS].sort());
  });

  it('every CMS role, never Sales, in the page’s gate and in the menu alike', () => {
    const expected: Record<Role, boolean> = {
      admin: true,
      content_creator: true,
      seo: true,
      developer: true,
      sales: false,
    };
    for (const role of ROLES) {
      expect(mayOpenVersions(role), role).toBe(expected[role]);
      const links = visibleNav(role).flatMap((g) => g.links.map((l) => l.href));
      expect(links.includes('/admin/backups'), role).toBe(expected[role]);
    }
  });

  it('Download content is offered to the export.backup holders only (Admin, Developer)', () => {
    const page = readFileSync('src/pages/admin/backups.astro', 'utf8');
    expect(page).toContain("can(session.role, 'export.backup') === 'full'");
    expect(page).toContain('href="/api/admin/export-backup"');
    expect(ROLES.filter((r) => ROLE_CAPS[r]['export.backup'] === 'full')).toEqual([
      'admin',
      'developer',
    ]);
  });
});

describe('what the page reads', () => {
  it('releases off: the flag, and nothing else', async () => {
    const db = makeDb({ content_releases: [{ id: 'x', tenant_id: T, status: 'published' }] });
    db.flag = false;
    const page = await loadVersionsPage({
      sb: client(db) as never,
      auth: { userId: ADMIN, tenantId: T, role: 'admin', isActive: true, email: 'a@x.test' },
    });
    expect(page).toEqual({
      enabled: false,
      live: null,
      versions: [],
      upcoming: [],
      more: false,
      restores: {},
    });
    expect(db.calls.map((c) => c.name)).toEqual(['releases_enabled']);
  });

  it('on: the versions, and each restore waiting by the version it restores, untouched or not', async () => {
    const R1 = '0f0f0f0f-0000-4000-8000-000000000001';
    const R2 = '0f0f0f0f-0000-4000-8000-000000000002';
    const release = (id: string, number: number) => ({
      id,
      tenant_id: T,
      number,
      kind: 'publish',
      status: 'published',
      item_count: 1,
      areas: ['pages'],
      purge_status: 'done',
      version: 1,
      created_at: '2026-10-20T08:00:00Z',
    });
    const restore = (n: number, origin: string, version: number, over = {}) =>
      draftRow({
        id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`,
        origin_kind: 'restore',
        origin_release_id: origin,
        version,
        ...over,
      });
    const db = makeDb({
      content_releases: [release(R1, 1), release(R2, 2)],
      content_drafts: [
        restore(1, R1, 2),
        restore(2, R1, 2),
        restore(3, R2, 3),
        draftRow({ id: '77777777-7777-4777-8777-000000000009', origin_kind: null }),
      ],
    });
    const page = await loadVersionsPage({
      sb: client(db) as never,
      auth: { userId: ADMIN, tenantId: T, role: 'admin', isActive: true, email: 'a@x.test' },
    });
    expect(page.enabled).toBe(true);
    expect(page.live).toBe(2);
    expect(page.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(page.restores[R1]).toEqual({
      items: [
        { draftId: '77777777-7777-4777-8777-000000000001', draftVersion: 2 },
        { draftId: '77777777-7777-4777-8777-000000000002', draftVersion: 2 },
      ],
      untouched: true,
    });
    // Edited after the restore (version 3): no longer the version's rollback.
    expect(page.restores[R2]?.untouched).toBe(false);
    // Every read named the caller's tenant: the stand-in serves only T.
    expect(db.calls.filter((c) => c.kind === 'from').length).toBeGreaterThan(0);
  });
});

describe('the words (P-12: plain, no dashes)', () => {
  const clock = clockFor('Asia/Riyadh');

  it('a version’s lines', () => {
    expect(changesLine({ itemCount: 1, areas: ['pages'] })).toBe('1 change in Pages');
    expect(changesLine({ itemCount: 4, areas: ['pages', 'services', 'seo'] })).toBe(
      '4 changes in Pages, Services and SEO',
    );
    expect(changesLine({ itemCount: 0, areas: [] })).toBe('0 changes');
    expect(kindLine({ kind: 'rollback', restores: 3 })).toBe('Restored v3');
    expect(kindLine({ kind: 'publish', restores: null })).toBeNull();
    expect(failedLine({ scheduledFor: '2026-10-26T11:00:00Z', failure: 'conflict' }, clock)).toBe(
      'Couldn’t publish on 26 Oct 2026, 14:00: The live site changed under one of its changes. Its changes are waiting to be published again.',
    );
    expect(purgeLine('failed')).toEqual({
      text: 'Couldn’t refresh the website cache.',
      retry: true,
    });
    expect(purgeLine('done')).toBeNull();
  });

  it('a refusal names each item once, by its label or its type', () => {
    expect(
      refusedNames({
        items: [
          { entityType: 'service', label: { en: 'Logo Design' } },
          { entityType: 'service', label: { en: 'Logo Design' } },
          { entityType: 'page_section', label: null },
        ],
      }),
    ).toEqual(['Logo Design', 'page section']);
  });

  it('no line has a dash', () => {
    const lines = [
      ...Object.values(COPY).map((v) => (typeof v === 'function' ? v(3, 2) : v)),
      ...Object.values(HISTORY_COPY).map((v) =>
        typeof v === 'function' ? (v as (a: never) => string)(3 as never) : v,
      ),
    ];
    for (const line of lines) expect(String(line)).not.toMatch(DASH);
  });

  it('the history rows and the card’s lines', () => {
    expect(historyRowTitle({ seq: 4, live: true, release: { id: 'r', number: 12 } })).toBe(
      'Version 4 · in release v12',
    );
    expect(historyRowTitle({ seq: 2, live: false, release: null })).toBe('Version 2');
    const status = sampleStatus(NOW);
    expect(cacheWords(status)).toEqual({ text: 'Couldn’t refresh', retry: true });
    expect(cacheWords({ ...status, cacheConnected: false }).text).toBe('Not connected yet');
    expect(pendingWords(status.pending)).toBe('2 yours to publish · 1 waiting');
    expect(pendingWords({ publishable: 0, waiting: 0, scheduled: 4 })).toBe('None');
  });
});

describe('the versions list as the island draws it', () => {
  const html = renderToStaticMarkup(
    createElement(
      ClockProvider,
      { tz: 'Asia/Riyadh' },
      createElement(Versions, {
        api: SAMPLE_VERSIONS_API,
        ...sampleVersions(NOW),
        more: false,
        inline: true,
      }),
    ),
  );

  it('what is scheduled or failed on top, then the versions, the live one marked', () => {
    expect(html.indexOf('Scheduled')).toBeLessThan(html.indexOf('Live now'));
    expect(html).toContain('Couldn’t publish on');
    expect(html).toContain('aria-label="Published versions"');
    expect(html).toContain('Spring copy on the home page');
    expect(html).toContain('Couldn’t refresh the website cache.');
  });

  it('actions named for their version; the live one is never restored or previewed', () => {
    expect(html).toContain('Restore<span class="visually-hidden"> v1</span>');
    expect(html).not.toContain('> v3</span>');
    expect(html).toContain('href="/admin/preview/?v=1"');
    expect(html).not.toContain('href="/admin/preview/?v=3"');
    // v2 was restored: it offers its rollback, not a second restore.
    expect(html).toContain('Publish v2 again');
    expect(html).not.toContain('Restore<span class="visually-hidden"> v2</span>');
    expect(html).toContain('Change time');
    expect(html).toContain('Unschedule');
  });

  it('CSP: no style attribute, and no id twice', () => {
    expect(html).not.toMatch(/\sstyle=/);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the history drawer’s records (the editors, historyTargetOf)', () => {
  it('every release-managed kernel resource, under its own slug, and nothing else', () => {
    const expected: Record<string, string> = {};
    for (const type of RELEASE_ENTITY_TYPES) {
      const resource = RELEASE_REGISTRY[type].resource;
      if (!resource) continue;
      const slug = Object.entries(RESOURCES).find(([, config]) => config === resource)?.[0];
      if (slug) expected[slug] = type;
    }
    expect(HISTORY_TYPE_OF_SLUG).toEqual(expected);
  });

  it('a saved record only; a singleton, media or a new record has none', () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000001';
    expect(historyTargetOf({ kind: 'resource', slug: 'services' }, id)).toEqual({
      entityType: 'service',
      entityId: id,
    });
    expect(historyTargetOf({ kind: 'resource', slug: 'services' }, null)).toBeNull();
    expect(historyTargetOf({ kind: 'resource', slug: 'media' }, id)).toBeNull();
    expect(
      historyTargetOf({ kind: 'singleton', endpoint: '/api/admin/site-profile' }, id),
    ).toBeNull();
  });

  it('EditorForm loads the drawer through import() only', () => {
    const form = readFileSync('src/components/admin/fields/EditorForm.tsx', 'utf8');
    expect(form).toContain(
      "lazy(() => import('@/components/admin/screens/history/HistoryDrawer'))",
    );
    expect(form).not.toMatch(/^import .*screens\/history/m);
  });
});

describe('the dashboard’s publish card while releases are off', () => {
  it('is a CMS role’s widget, on the default board, and leaves it whole while off', () => {
    for (const role of ROLES) {
      expect(widgetsFor(role).includes('publish'), role).toBe(role !== 'sales');
    }
    const off = withoutWidgets(DEFAULT_LAYOUTS.admin, RELEASE_WIDGETS);
    expect([...off.top, ...off.left, ...off.right, ...off.hidden]).not.toContain('publish');
    expect(off.right).toEqual(DEFAULT_LAYOUTS.admin.right.filter((id) => id !== 'publish'));
  });

  it('the page reads the flag once and drops the widget from the board, Add widget and presets', () => {
    const page = readFileSync('src/pages/admin/index.astro', 'utf8');
    expect(page).toContain('withoutWidgets(loaded.layout, RELEASE_WIDGETS)');
    expect(page).toContain('catalog: offered(session.role)');
    expect(page).toContain('widgets: offered(role)');
    expect(page.match(/releases_enabled/g)).toHaveLength(1);
  });
});

describe('its guide, backups-and-versions (one app.put_help_guide, revision 0, place 125)', () => {
  it('is put once, for the release read capabilities, naming the screen, offered on it', async () => {
    const { helpSet, readMigrations } = await import('../fixtures/helpSet');
    const { pageGuideFor } = await import('@/lib/admin/help/pageGuides');
    const set = helpSet(readMigrations());
    const puts = set.edits.filter((e) => e.slug === 'backups-and-versions');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ op: 'put', revision: 0 });
    const guide = set.set.find((g) => g.slug === 'backups-and-versions')!;
    expect(guide.sort_order).toBe(125);
    expect([...(guide['caps'] as string[])].sort()).toEqual([...RELEASE_READ_CAPS].sort());
    expect(guide['screens']).toEqual(['/admin/backups']);
    for (const role of ROLES) {
      expect(pageGuideFor('/admin/backups', role), role).toBe(
        role === 'sales' ? null : 'backups-and-versions',
      );
    }
    // True with releases on or off: it never says a version exists before the switch.
    const text = JSON.stringify(guide['body']);
    expect(text).toContain('Once publishing in releases is switched on');
    expect(text).not.toMatch(DASH);
  });
});
