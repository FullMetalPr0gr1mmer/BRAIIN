// "Used in" (Admin v2 U4): where a picture shows, in words, from `media_usage()` (0028; the
// usage route, GET /api/admin/media/<id>/usage). Each entry is a link only where the role's
// own sidebar would open the target screen, else plain words: a link that answers 403 is a
// dead end. Which screens those are is decided on the server (usageScreensFor in
// src/lib/admin/mediaLibrary.ts: isVisible over ADMIN_NAV) and handed to the island, so the
// menu's registry never ships in the browser. An entity type this map does not know (R5 adds
// some) is said in its own words, with no link, and never breaks the list.
//
// Since media_usage v4 (0066, Admin v2 R5) a row may be a pending change (`pending`): a draft
// that names the picture, not yet live. It is said as one ("Pending change to service: logo")
// and never linked, because the screen behind the link shows the live entity, which does not
// use the picture (and a pending new entity has no page yet). The hard delete's refusal
// (DELETE /api/admin/media/<id>) words each reference with `usageWords`, so the drawer and the
// refusal say the same thing.

export interface UsageRow {
  entityType: string;
  entityId: string;
  label: string | null;
  /** A pending change, not a live reference (media_usage v4, 0066). Absent: live. */
  pending?: boolean;
}

export interface UsageEntry {
  key: string;
  words: string;
  href: string | null;
}

interface Kind {
  /** The screen that edits it: the list's address, the entity's id after it. */
  screen: string;
  /** Where the entry links, when it is not `<screen>/<id>` (a screen with no edit page). */
  href?: (entityId: string) => string;
  /** What it is, in lower case, for a pending change's words. */
  noun: string;
  words: (label: string | null) => string;
}

const named = (noun: string) => (label: string | null) => (label ? `${noun}: ${label}` : noun);

export const USAGE_KINDS: Readonly<Record<string, Kind>> = {
  portfolio: { screen: '/admin/portfolio', noun: 'project', words: named('Project') },
  // The entity is the project; the label is the picture's role in it (hero, gallery…).
  portfolio_media: {
    screen: '/admin/portfolio',
    noun: 'project',
    words: (label) => (label ? `Project (${label})` : 'Project (media)'),
  },
  client: { screen: '/admin/clients', noun: 'client', words: named('Client') },
  testimonial: { screen: '/admin/testimonials', noun: 'testimonial', words: named('Testimonial') },
  team_member: { screen: '/admin/team', noun: 'team member', words: named('Team') },
  page_section: {
    screen: '/admin/sections',
    noun: 'page section',
    words: (label) => (label ? `Page section (${label})` : 'Page section'),
  },
  discipline: { screen: '/admin/disciplines', noun: 'discipline', words: named('Discipline') },
  service: { screen: '/admin/services', noun: 'service', words: named('Service') },
  // Admin v2 U10 (media_usage v5, 0073): a share image. The entity is the page the SEO row
  // describes, its label "<kind>: <slug>" ("service: logo"); both open the SEO screen, which
  // has no page per row (its Pages tab lists them).
  entity_seo: {
    screen: '/admin/seo',
    noun: 'share image',
    words: (label) => (label ? `Share image (${label})` : 'Share image'),
    href: () => '/admin/seo',
  },
  seo_defaults: {
    screen: '/admin/seo',
    noun: 'default share image',
    words: () => 'Default share image',
    href: () => '/admin/seo?tab=site',
  },
  // Admin v2 U9 (media_usage v6, 0075): the site's favicon or app icon. The entity is the
  // tenant's identity row, its label which icon; it opens General settings.
  site_profile: {
    screen: '/admin/settings',
    noun: 'site icon',
    words: (label) =>
      label === 'app icon' ? 'App icon (General settings)' : 'Favicon (General settings)',
    href: () => '/admin/settings',
  },
};

/** Every screen a "Used in" entry may link to. */
export const USAGE_SCREENS: readonly string[] = [
  ...new Set(Object.values(USAGE_KINDS).map((kind) => kind.screen)),
];

/**
 * The label media_usage v4 gives a pending change with no English label and no slug (0066's
 * ninth branch). It says nothing the words do not already say, so it is dropped.
 */
export const PENDING_FALLBACK_LABEL = 'pending change';

/** The drawer's reason the Delete button is off: every reference is live. */
export const IN_USE_TEXT = 'This file is in use. Remove it from those places first.';
/** The same, when at least one reference is a pending change. */
export const IN_USE_PENDING_TEXT =
  'This file is in use or in a pending change. Remove it from those places first.';

/** An entity type no kind names, in its own words: `entity_seo` is "entity seo". */
const nounOfType = (entityType: string) => entityType.replace(/_/g, ' ');

/** One reference in words: "Service: logo", or "Pending change to service: logo". */
export function usageWords(row: UsageRow): string {
  const kind = USAGE_KINDS[row.entityType];
  if (row.pending) {
    const noun = kind ? kind.noun : nounOfType(row.entityType);
    const label = row.label && row.label !== PENDING_FALLBACK_LABEL ? row.label : null;
    return label ? `Pending change to ${noun}: ${label}` : `Pending change to ${noun}`;
  }
  if (kind) return kind.words(row.label);
  const noun = nounOfType(row.entityType);
  const words = noun.charAt(0).toUpperCase() + noun.slice(1);
  return row.label ? `${words}: ${row.label}` : words;
}

/** Why the drawer's Delete is off while the picture has references (null: it has none). */
export function inUseText(usage: readonly UsageRow[]): string | null {
  if (usage.length === 0) return null;
  return usage.some((row) => row.pending) ? IN_USE_PENDING_TEXT : IN_USE_TEXT;
}

export function usageEntries(
  opens: ReadonlySet<string> | readonly string[],
  usage: readonly UsageRow[],
): UsageEntry[] {
  const open = opens instanceof Set ? opens : new Set(opens as readonly string[]);
  return usage.map((row, index) => {
    const kind = USAGE_KINDS[row.entityType];
    const key = `${row.pending ? 'pending' : 'live'}-${row.entityType}-${row.entityId}-${index}`;
    const href =
      kind && !row.pending && open.has(kind.screen)
        ? (kind.href?.(row.entityId) ?? `${kind.screen}/${encodeURIComponent(row.entityId)}`)
        : null;
    return { key, words: usageWords(row), href };
  });
}
