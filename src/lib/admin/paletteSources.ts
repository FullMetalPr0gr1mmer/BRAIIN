import type { Role } from '@/lib/auth/types';
import { visibleNav } from './nav';
import { quickActionsFor } from './quickActions';
import type { PaletteGroup } from './palette';

// What the command palette lists before the server is asked anything (Admin v2 F3): the
// screens the role's menu reaches and the quick actions it may take. Built on the SERVER
// from ROLE_CAPS and handed to the island as props, so the client bundle carries no
// capability matrix and no role ever sees a destination its menu would not offer.

export function paletteGroupsFor(role: Role): PaletteGroup[] {
  const screens = visibleNav(role).flatMap((group) =>
    group.links.flatMap((link) => [
      {
        key: `s:${link.href}`,
        label: link.label,
        href: link.href,
        icon: link.icon,
        detail: group.title,
      },
      ...(link.tabs ?? [])
        .filter((tab) => tab.href !== link.href)
        .map((tab) => ({
          key: `s:${tab.href}`,
          label: tab.label,
          href: tab.href,
          icon: link.icon,
          detail: link.label,
        })),
    ]),
  );
  const actions = quickActionsFor(role).map((action) => ({
    key: `a:${action.href}`,
    label: action.label,
    href: action.href,
    icon: action.icon,
  }));
  return [
    { title: 'Go to', items: screens },
    ...(actions.length > 0 ? [{ title: 'Quick actions', items: actions }] : []),
  ];
}
