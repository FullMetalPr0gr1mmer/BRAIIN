import type { IconName } from '@/lib/admin/icons';
import type { BadgeTone } from '@/lib/admin/tones';

// The collections (Admin v2 U7, ui.md "Collections (AV-16)", the prototype's COLLECTIONS):
// the lists the site draws from in several places, each edited on one screen, the
// AdminCollection island: a sortable list of rows, a drawer to add or edit one, Duplicate.
// What a collection edits is its resource's (src/lib/admin/resources/<entity>.ts, the API
// and its rules) and its form's (src/lib/admin/ui/<entity>.ts, the fields); what is here is
// only how its list reads: the page's title and line, each row's words and badges, whether
// and how a row is copied, and the drawer's note. Pure data and small functions, read by
// the island and by the pages' frontmatter (the title and the line, server-rendered).
//
// Copy rules (P-12): plain, warm, no em or en dash, the brand never spelled, digits as typed.

type Row = Record<string, unknown>;

export interface CollectionBadge {
  label: string;
  /** A tone (`.badge[data-tone]`), or a content status (its own tone and word). */
  tone?: BadgeTone | undefined;
  status?: string | undefined;
}

export interface CollectionDef {
  /** The resource's admin slug: /admin/<slug>, /api/admin/<slug>. */
  slug: string;
  /** The page's title, the menu's word for it. */
  title: string;
  /** The line under the title. */
  sub: string;
  /** One item, lower case: "New question", "Delete the question". */
  noun: string;
  /** The row's icon (the lists show no thumbnails: as-built U7, departure 4). */
  icon: IconName;
  rowTitle: (row: Row) => string;
  rowSub: (row: Row) => string | null;
  badges: (row: Row) => CollectionBadge[];
  /**
   * Duplicate: the changes a copy takes over the original's fields (always a draft, never a
   * design sample), or null for a row that may not be copied. Absent: no Duplicate at all.
   */
  copy?: ((row: Row) => Row | null) | undefined;
  /** A note under the drawer's fields. */
  note?: string | undefined;
  /** Testimonials: a design sample is made real in one save (the sample flow). */
  samples?: boolean | undefined;
}

/** A bilingual value's English, else its Arabic, else ''. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const en = typeof record['en'] === 'string' ? record['en'].trim() : '';
    const ar = typeof record['ar'] === 'string' ? record['ar'].trim() : '';
    return en || ar;
  }
  return '';
}

/** The first `max` characters of a text, cut at a character, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('').trimEnd()}…`;
}

/** A status badge for every state but Published (a live row needs no word). */
function statusBadges(row: Row): CollectionBadge[] {
  const status = typeof row['status'] === 'string' ? row['status'] : '';
  return status && status !== 'published' ? [{ label: '', status }] : [];
}

const SAMPLE: CollectionBadge = { label: 'Sample', tone: 'klein' };
const isSample = (row: Row) => row['is_placeholder'] === true;

/**
 * A copy's slug: `<slug>-copy`, then `-copy-2`, `-copy-3`… whichever no row in `taken`
 * holds, cut to the slug columns' 64 characters.
 */
export function copySlug(slug: string, taken: ReadonlySet<string>): string {
  const base = slug.replace(/-copy(-\d+)?$/, '');
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-copy-${Date.now() % 100000}`;
}

/** The placements a row is shown on, in words ("Home · Our Work"). */
function placesOf(row: Row, names: Readonly<Record<string, string>>): string {
  const placements = Array.isArray(row['placements']) ? (row['placements'] as unknown[]) : [];
  return placements
    .map((p) => (typeof p === 'string' ? (names[p] ?? p) : ''))
    .filter(Boolean)
    .join(' · ');
}

const PAGE_NAMES: Readonly<Record<string, string>> = {
  home: 'Home',
  about: 'About',
  work: 'Our Work',
  services: 'Services page',
};

export const COLLECTIONS: Readonly<Record<string, CollectionDef>> = {
  // U7a: the FAQ, the first collection on the island.
  faq: {
    slug: 'faq',
    title: 'FAQ',
    sub: 'Questions on the Contact page.',
    noun: 'question',
    icon: 'note',
    rowTitle: (row) => textOf(row['question']) || 'Untitled question',
    rowSub: (row) => clip(textOf(row['answer']), 80) || null,
    badges: statusBadges,
    copy: () => ({}),
    note: 'While no question is published, the Contact page shows no FAQ.',
  },
  // U7b: the five collections that had a table and a form each.
  testimonials: {
    slug: 'testimonials',
    title: 'Testimonials',
    sub: 'Quotes for the homepage slider, Our Work, and project pages.',
    noun: 'quote',
    icon: 'quote',
    rowTitle: (row) => {
      const who = textOf(row['author_name']) || 'Untitled quote';
      const quote = clip(textOf(row['quote']), 60);
      return quote ? `${who} · ${quote}` : who;
    },
    rowSub: (row) => placesOf(row, PAGE_NAMES) || null,
    badges: (row) => [
      ...(isSample(row) ? [SAMPLE] : []),
      ...(!isSample(row) && !row['consent_obtained_at']
        ? [{ label: 'Needs consent', tone: 'warn' as const }]
        : []),
      ...statusBadges(row),
    ],
    // A design sample is never copied: the sample lock refuses creating one, and its words
    // copied into a real draft invite publishing words nobody said. A real quote's copy
    // records no consent of its own.
    copy: (row) => (isSample(row) ? null : { consentObtainedAt: null, consentReference: null }),
    samples: true,
  },
  clients: {
    slug: 'clients',
    title: 'Clients',
    sub: 'Names in the scrolling marquee. Add logos when you have permission to show them.',
    noun: 'client',
    icon: 'star',
    rowTitle: (row) => textOf(row['name']) || 'Untitled client',
    rowSub: (row) =>
      [row['logo_media_id'] ? 'Logo' : 'Text only', row['show_in_marquee'] ? 'In the marquee' : '']
        .filter(Boolean)
        .join(' · '),
    badges: (row) => [
      ...(isSample(row) ? [SAMPLE] : []),
      ...(row['visible'] === true ? [] : [{ label: 'Not cleared to name', tone: 'gray' as const }]),
    ],
    // A copy is hidden until someone clears it, whatever the original says.
    copy: (row) => (isSample(row) ? null : { visible: false }),
  },
  team: {
    slug: 'team',
    title: 'Team',
    sub: 'The leadership slider on the About page, and the authors of Creative Knowledge posts.',
    noun: 'team member',
    icon: 'users',
    rowTitle: (row) => textOf(row['name']) || 'Untitled team member',
    rowSub: (row) => textOf(row['role']) || null,
    badges: (row) => [
      ...(isSample(row) ? [SAMPLE] : []),
      ...(row['is_leadership'] === true ? [{ label: 'Leadership', tone: 'sky' as const }] : []),
      ...statusBadges(row),
    ],
    // No Duplicate: people are not copied by accident (ui.md, U7b).
  },
  statistics: {
    slug: 'statistics',
    title: 'Numbers',
    sub: 'The numbers the site counts up to, and the pages each one shows on.',
    noun: 'number',
    icon: 'grid',
    rowTitle: (row) => {
      const value = typeof row['value'] === 'string' ? row['value'].trim() : '';
      const label = textOf(row['label']);
      return [value, label].filter(Boolean).join(' ') || 'Untitled number';
    },
    rowSub: (row) => placesOf(row, PAGE_NAMES) || 'Not shown on any page',
    badges: (row) => [...(isSample(row) ? [SAMPLE] : []), ...statusBadges(row)],
    copy: (row) => (isSample(row) ? null : {}),
  },
  certifications: {
    slug: 'certifications',
    title: 'Certifications',
    sub: 'Certifications and partnerships the site can show, in this order.',
    noun: 'certification',
    icon: 'tag',
    rowTitle: (row) => textOf(row['name']) || 'Untitled certification',
    rowSub: (row) => {
      const year = typeof row['year'] === 'number' ? String(row['year']) : '';
      return [textOf(row['issuer']), year].filter(Boolean).join(', ') || null;
    },
    badges: statusBadges,
    copy: () => ({}),
  },
};

export function collectionOf(slug: string): CollectionDef {
  const def = COLLECTIONS[slug];
  if (!def) throw new Error(`no collection "${slug}"`);
  return def;
}

/**
 * The delete confirmation names the row, in a bidi isolate (FSI…PDI) so an Arabic name
 * cannot reorder the sentence around it.
 */
export function deleteQuestion(def: CollectionDef, name: string): string {
  return `Delete the ${def.noun} “⁨${name}⁩”? This cannot be undone.`;
}

/**
 * What a drawer's Delete did, read from the server's answer (Admin v2 R12): a live delete
 * (releases off: no `draft` key), a removal staged for the next publish (`pendingRemoval`), or
 * a pending new item thrown away (`draft: null`, nothing staged: it was never on the site).
 */
export type DeleteOutcome = 'deleted' | 'removal' | 'discarded';

export function deleteOutcome(result: Readonly<Row>): DeleteOutcome {
  if (!('draft' in result)) return 'deleted';
  return result['pendingRemoval'] === true ? 'removal' : 'discarded';
}

/** The toast for each outcome. */
export const DELETE_WORDS: Readonly<Record<DeleteOutcome, string>> = {
  deleted: 'Deleted.',
  removal: 'Removal saved. It comes off the site when it is published.',
  discarded: 'Thrown away. It was never on the site.',
};
