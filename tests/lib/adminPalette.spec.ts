import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import { reachableHrefs } from '@/lib/admin/nav';
import {
  filterGroups,
  flatten,
  matches,
  move,
  normalize,
  remoteGroups,
  seeAll,
  type PaletteGroup,
} from '@/lib/admin/palette';
import { ALL_QUICK_ACTIONS, quickActionsFor } from '@/lib/admin/quickActions';
import { paletteGroupsFor } from '@/lib/admin/paletteSources';
import { pageFileFor } from '../admin/routes';

// The command palette's model (Admin v2 F3): what it lists, where the keyboard moves,
// and that a role is only ever offered destinations and actions it may use.

describe('matching', () => {
  it('matches every query word against the start of a label word', () => {
    expect(matches('Case studies', 'case st')).toBe(true);
    expect(matches('New project', 'pro new')).toBe(true);
    expect(matches('Website stats', 'stats')).toBe(true);
    expect(matches('Start here', 'art')).toBe(false);
  });

  it('ignores case, accents and spacing', () => {
    expect(normalize('  Créative   Knowledge ')).toBe('creative knowledge');
    expect(matches('Créative Knowledge', 'CREATIVE')).toBe(true);
  });

  it('lists everything for an empty query', () => {
    expect(matches('Anything', '   ')).toBe(true);
  });

  it('drops the groups a query empties', () => {
    const groups: PaletteGroup[] = [
      { title: 'Go to', items: [{ key: 'a', label: 'Services', href: '/s', icon: 'layers' }] },
      {
        title: 'Quick actions',
        items: [{ key: 'b', label: 'New post', href: '/p', icon: 'plus' }],
      },
    ];
    expect(filterGroups(groups, 'serv').map((g) => g.title)).toEqual(['Go to']);
    expect(flatten(filterGroups(groups, '')).map((i) => i.key)).toEqual(['a', 'b']);
  });
});

describe('keyboard movement', () => {
  it('wraps at both ends', () => {
    expect(move(0, 3, 1)).toBe(1);
    expect(move(2, 3, 1)).toBe(0);
    expect(move(0, 3, -1)).toBe(2);
  });

  it('enters the list from either end, and stays out of an empty one', () => {
    expect(move(-1, 3, 1)).toBe(0);
    expect(move(-1, 3, -1)).toBe(2);
    expect(move(0, 0, 1)).toBe(-1);
  });
});

describe('server results', () => {
  it('become palette groups with their path as the detail', () => {
    const groups = remoteGroups([
      {
        group: 'Services',
        hits: [{ href: '/admin/services/1', label: 'Logo Design', detail: '/logo' }],
      },
    ]);
    expect(groups[0]?.items[0]).toMatchObject({ label: 'Logo Design', detail: '/logo' });
  });

  it('end with the full results page for the same query, encoded', () => {
    expect(seeAll(' brand & logo ').href).toBe('/admin/search?q=brand%20%26%20logo');
  });
});

describe('quick actions', () => {
  it('each opens a page that exists', () => {
    for (const action of ALL_QUICK_ACTIONS) {
      expect(() => pageFileFor(action.href), action.href).not.toThrow();
    }
  });

  it('are offered only with the capability in full', () => {
    expect(quickActionsFor('seo').map((a) => a.label)).toEqual(['New redirect']);
    expect(quickActionsFor('developer').map((a) => a.label)).toEqual(['Upload media']);
    expect(quickActionsFor('content_creator').map((a) => a.label)).not.toContain('Invite a user');
    expect(quickActionsFor('admin')).toHaveLength(ALL_QUICK_ACTIONS.length);
  });
});

describe('the palette sources', () => {
  it("list exactly the screens the role's menu reaches", () => {
    for (const role of ROLES) {
      const screens = paletteGroupsFor(role)
        .find((g) => g.title === 'Go to')
        ?.items.map((i) => i.href);
      expect(new Set(screens)).toEqual(new Set(reachableHrefs(role)));
    }
  });

  it('never offer a role a lead or application screen it cannot open', () => {
    for (const role of ['content_creator', 'seo'] as const) {
      const hrefs = flatten(paletteGroupsFor(role)).map((i) => i.href);
      expect(hrefs).not.toContain('/admin/leads');
      expect(hrefs).not.toContain('/admin/applications');
    }
  });

  it('give every option a unique key', () => {
    for (const role of ROLES) {
      const keys = flatten(paletteGroupsFor(role)).map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
