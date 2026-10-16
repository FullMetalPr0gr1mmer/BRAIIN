import { describe, expect, it } from 'vitest';
import {
  DashboardLayoutSchema,
  DashboardPrefSchema,
  RoleDefaultsPutSchema,
  hasColumns,
  readDashboardLayout,
} from '@schemas/dashboard';
import { AdminPrefsPutSchema } from '@schemas/adminPrefs';
import { ROLES } from '@/lib/auth/types';
import {
  forbiddenActions,
  forbiddenWidgets,
  resolveLayout,
  resolveQuick,
  shownWidgets,
} from '@/lib/admin/dashboard/layout';
import { presetValues } from '@/lib/admin/dashboard/roleDefaults';
import { DEFAULT_LAYOUTS, widgetsFor } from '@/lib/admin/dashboard/widgets';
import { QUICK_DEFAULTS } from '@/lib/admin/quickActions';

// A person's layout (Admin v2 U1, README U1 D2, D8; ui.md §4 "Per-user layout", §10): the
// schema refuses duplicates and unknown ids on write, the reader drops them on read, and
// resolution goes person, then the role's preset, then the code's default, dropping what the
// role may not see. A preference never grants access.

const layout = (top: string[], left: string[], right: string[], hidden: string[] = []) => ({
  top,
  left,
  right,
  hidden,
});

describe('the schemas refuse on write', () => {
  it('a widget twice, across columns or within one', () => {
    expect(DashboardLayoutSchema.safeParse(layout(['kpis'], ['quick'], ['quick'])).success).toBe(
      false,
    );
    expect(DashboardLayoutSchema.safeParse(layout([], ['quick', 'quick'], [])).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse(layout(['kpis'], [], [], ['kpis'])).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse(layout(['kpis'], ['quick'], ['notes'])).success).toBe(
      true,
    );
  });

  it('an id this build does not know, and an unknown key', () => {
    expect(DashboardLayoutSchema.safeParse(layout(['realtime'], [], [])).success).toBe(false);
    expect(
      DashboardLayoutSchema.safeParse({ ...layout(['kpis'], [], []), extra: true }).success,
    ).toBe(false);
  });

  it('a preference: every column or none, the quick-actions flag either way', () => {
    expect(DashboardPrefSchema.safeParse({}).success).toBe(true);
    expect(DashboardPrefSchema.safeParse({ quickSet: true }).success).toBe(true);
    expect(DashboardPrefSchema.safeParse({ top: ['kpis'] }).success).toBe(false);
    expect(
      DashboardPrefSchema.safeParse({ ...layout(['kpis'], [], []), quickSet: true }).success,
    ).toBe(true);
  });

  it('a preferences save names at least one preference; `notifications` alone still works', () => {
    expect(
      AdminPrefsPutSchema.safeParse({ version: 0, notifications: { muted: [] } }).success,
    ).toBe(true);
    expect(AdminPrefsPutSchema.safeParse({ version: 0, dashboard: {} }).success).toBe(true);
    expect(AdminPrefsPutSchema.safeParse({ version: 0, quickActions: [] }).success).toBe(true);
    expect(AdminPrefsPutSchema.safeParse({ version: 0 }).success).toBe(false);
  });

  it('a preset save names a layout, quick actions or both; quick actions are library ids only', () => {
    expect(RoleDefaultsPutSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(
      RoleDefaultsPutSchema.safeParse({ version: 0, quickActions: [{ id: 'stats' }] }).success,
    ).toBe(true);
    expect(
      RoleDefaultsPutSchema.safeParse({
        version: 0,
        quickActions: [
          { id: 'c-abcdefgh12', label: 'Drive', href: 'https://drive.example.com', icon: 'link' },
        ],
      }).success,
    ).toBe(false);
    expect(
      RoleDefaultsPutSchema.safeParse({
        version: 0,
        quickActions: [{ id: 'x', href: 'https://a.b' }],
      }).success,
    ).toBe(false);
  });
});

describe('the reader drops on read (ui.md §10)', () => {
  it('unknown ids and repeats go, the rest keep their order', () => {
    expect(
      readDashboardLayout({
        top: ['kpis', 'realtime'],
        left: ['quick', 'kpis', 'views'],
        right: 'not a list',
        hidden: ['notes', 7, null],
        quickSet: 'yes',
      }),
    ).toEqual({ top: ['kpis'], left: ['quick', 'views'], right: [], hidden: ['notes'] });
  });

  it('anything malformed is the empty layout', () => {
    for (const raw of [null, undefined, 'x', 3, [], ['kpis']]) {
      expect(readDashboardLayout(raw)).toEqual({ top: [], left: [], right: [], hidden: [] });
      expect(hasColumns(raw)).toBe(false);
    }
    expect(hasColumns({ quickSet: true })).toBe(false);
    expect(hasColumns({ top: [] })).toBe(true);
  });
});

describe('resolution: the person, then the preset, then the default', () => {
  const mine = layout([], ['notes'], ['quick']);
  const preset = layout(['kpis'], ['views'], []);

  it('the person’s own layout wins', () => {
    expect(resolveLayout(mine, preset, 'seo').source).toBe('mine');
    expect(resolveLayout(mine, preset, 'seo').layout.left).toEqual(['notes']);
  });

  it('else the role’s preset', () => {
    expect(resolveLayout({}, preset, 'seo')).toMatchObject({
      source: 'preset',
      layout: { top: ['kpis'], left: ['views'] },
    });
    expect(resolveLayout({ quickSet: true }, preset, 'seo').source).toBe('preset');
  });

  it('else the code’s default for the role', () => {
    for (const role of ROLES) {
      const { layout: got, source } = resolveLayout(null, null, role);
      expect(source).toBe('default');
      expect(got.top).toEqual(DEFAULT_LAYOUTS[role].top);
      expect(got.left).toEqual(DEFAULT_LAYOUTS[role].left);
    }
  });

  it('drops what the role may not see, wherever it came from: a preference never grants access', () => {
    const greedy = layout(['kpis'], ['leads', 'applications'], ['disciplines', 'health', 'notes']);
    for (const role of ['content_creator', 'seo'] as const) {
      const { layout: got } = resolveLayout(greedy, null, role);
      expect(shownWidgets(got)).toEqual(['kpis', 'notes']);
      for (const id of [...got.top, ...got.left, ...got.right, ...got.hidden]) {
        expect(widgetsFor(role)).toContain(id);
      }
    }
  });

  it('keeps every widget the role may have that the layout does not mention, off the board', () => {
    const { layout: got } = resolveLayout(layout(['kpis'], [], []), null, 'developer');
    expect(got.hidden.sort()).toEqual(
      widgetsFor('developer')
        .filter((id) => id !== 'kpis')
        .sort(),
    );
  });

  it('names the forbidden ids a save carries, and the library ids a role may not use', () => {
    expect(forbiddenWidgets(layout(['kpis'], ['leads'], [], ['applications']), 'seo')).toEqual([
      'leads',
      'applications',
    ]);
    expect(forbiddenWidgets(layout(['kpis'], ['leads'], []), 'developer')).toEqual([]);
    expect(
      forbiddenActions([{ id: 'open-leads' }, { id: 'stats' }, { id: 'gone' }], 'seo'),
    ).toEqual(['open-leads', 'gone']);
    expect(
      forbiddenActions(
        [{ id: 'c-abcdefgh12', label: 'Drive', href: 'https://drive.example.com', icon: 'link' }],
        'seo',
      ),
    ).toEqual([]);
  });
});

describe('quick actions: the person’s once chosen (D8), else the preset’s, else the default', () => {
  it('never chose: the role’s default', () => {
    for (const role of ROLES) {
      const got = resolveQuick({}, [], {}, [], role);
      expect(got.source).toBe('default');
      expect(got.items.map((i) => i.id)).toEqual([...QUICK_DEFAULTS[role]]);
    }
  });

  it('removed every action: an empty list honoured', () => {
    expect(
      resolveQuick({ quickSet: true }, [], { quickSet: true }, [{ id: 'stats' }], 'seo'),
    ).toEqual({
      items: [],
      source: 'mine',
    });
  });

  it('a preset’s list when the person never chose; its links, if any were stored, never', () => {
    const got = resolveQuick(
      {},
      [],
      { quickSet: true },
      [
        { id: 'stats' },
        { id: 'c-abcdefgh12', label: 'Drive', href: 'https://drive.example.com', icon: 'link' },
      ],
      'seo',
    );
    expect(got).toEqual({ items: [{ id: 'stats' }], source: 'preset' });
  });

  it('drops library actions the role may not use, or that are gone', () => {
    const got = resolveQuick(
      { quickSet: true },
      [{ id: 'open-leads' }, { id: 'stats' }, { id: 'gone' }],
      {},
      [],
      'seo',
    );
    expect(got.items).toEqual([{ id: 'stats' }]);
  });
});

describe('presets hold the target role to what it may have (D3)', () => {
  const none = {
    role: 'seo' as const,
    version: 0,
    dashboard: {},
    quickActions: [],
    updatedAt: null,
  };

  it('refuses a widget or an action the role cannot use (the modal sends none)', () => {
    expect(() => presetValues('seo', { dashboard: layout(['kpis'], ['leads'], []) }, none)).toThrow(
      /Not available to this role: leads/,
    );
    expect(() => presetValues('seo', { quickActions: [{ id: 'open-leads' }] }, none)).toThrow(
      /open-leads/,
    );
  });

  it('marks the layout `quickSet` when it carries quick actions, and keeps the stored half', () => {
    expect(presetValues('seo', { quickActions: [{ id: 'stats' }] }, none)).toEqual({
      dashboard: { top: [], left: [], right: [], hidden: [], quickSet: true },
      quick_actions: [{ id: 'stats' }],
    });
    const stored = {
      ...none,
      dashboard: { ...layout(['kpis'], [], []), quickSet: true },
      quickActions: [{ id: 'edit-seo' }],
    };
    expect(presetValues('seo', { dashboard: layout([], ['pages'], []) }, stored)).toEqual({
      dashboard: { top: [], left: ['pages'], right: [], hidden: [], quickSet: true },
      quick_actions: [{ id: 'edit-seo' }],
    });
  });
});
