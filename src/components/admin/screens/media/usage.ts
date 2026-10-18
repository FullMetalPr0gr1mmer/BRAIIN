// "Used in" (Admin v2 U4): where a picture shows, in words, from `media_usage()` (0028; the
// usage route, GET /api/admin/media/<id>/usage). Each entry is a link only where the role's
// own sidebar would open the target screen, else plain words: a link that answers 403 is a
// dead end. Which screens those are is decided on the server (usageScreensFor in
// src/lib/admin/mediaLibrary.ts: isVisible over ADMIN_NAV) and handed to the island, so the
// menu's registry never ships in the browser. An entity type this map does not know (R5,
// U10a and U9a add some) is said in its own words, with no link, and never breaks the list.

export interface UsageRow {
  entityType: string;
  entityId: string;
  label: string | null;
}

export interface UsageEntry {
  key: string;
  words: string;
  href: string | null;
}

interface Kind {
  /** The screen that edits it: the list's address, the entity's id after it. */
  screen: string;
  words: (label: string | null) => string;
}

const named = (noun: string) => (label: string | null) => (label ? `${noun}: ${label}` : noun);

export const USAGE_KINDS: Readonly<Record<string, Kind>> = {
  portfolio: { screen: '/admin/portfolio', words: named('Project') },
  // The entity is the project; the label is the picture's role in it (hero, gallery…).
  portfolio_media: {
    screen: '/admin/portfolio',
    words: (label) => (label ? `Project (${label})` : 'Project (media)'),
  },
  client: { screen: '/admin/clients', words: named('Client') },
  testimonial: { screen: '/admin/testimonials', words: named('Testimonial') },
  team_member: { screen: '/admin/team', words: named('Team') },
  page_section: {
    screen: '/admin/sections',
    words: (label) => (label ? `Page section (${label})` : 'Page section'),
  },
  discipline: { screen: '/admin/disciplines', words: named('Discipline') },
  service: { screen: '/admin/services', words: named('Service') },
};

/** Every screen a "Used in" entry may link to. */
export const USAGE_SCREENS: readonly string[] = [
  ...new Set(Object.values(USAGE_KINDS).map((kind) => kind.screen)),
];

export function usageEntries(
  opens: ReadonlySet<string> | readonly string[],
  usage: readonly UsageRow[],
): UsageEntry[] {
  const open = opens instanceof Set ? opens : new Set(opens as readonly string[]);
  return usage.map((row, index) => {
    const kind = USAGE_KINDS[row.entityType];
    const key = `${row.entityType}-${row.entityId}-${index}`;
    if (!kind) {
      const noun = row.entityType.replace(/_/g, ' ');
      const words = noun.charAt(0).toUpperCase() + noun.slice(1);
      return { key, words: row.label ? `${words}: ${row.label}` : words, href: null };
    }
    const href = open.has(kind.screen)
      ? `${kind.screen}/${encodeURIComponent(row.entityId)}`
      : null;
    return { key, words: kind.words(row.label), href };
  });
}
