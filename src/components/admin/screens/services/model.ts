// The Services area's rules (Admin v2 U5, AV-14), pure so they are unit-tested
// (tests/lib/servicesArea.spec.ts): how the overview groups and numbers what it lists, what
// the eye does, how a discipline's services are reordered inside the numbers the discipline
// already holds, and what Duplicate posts. No React, no fetch.
//
// Restated here rather than imported: U7's collection helpers (screens/collection/) live in
// the shared admin-screens chunk, and importing them would make this screen load that chunk
// (every collection, the SEO screen and the media library) to reach a few lines. The rules
// are the same, and the spec holds them to each other.

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };

/** A content row's lifecycle state (content_status). */
export type Status = 'draft' | 'scheduled' | 'published' | 'archived';

/** A bilingual value's English, else its Arabic, else ''. */
export function textOf(value: unknown, lang: 'en' | 'ar' = 'en'): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = record[lang];
  return typeof own === 'string' ? own.trim() : '';
}

/** A row's English name (its `title` or `name`), its Arabic when it has no English. */
export function nameOf(row: Row, key: 'title' | 'name' = 'title'): string {
  return textOf(row[key], 'en') || textOf(row[key], 'ar') || 'Untitled';
}

/** "01": a discipline's place in the list (the site numbers the cards so; deviations §8.5). */
export function placeLabel(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/** By `sort_order`, then by id (two rows on one number keep one order everywhere). */
export function bySort(a: Row, b: Row): number {
  const d = Number(a['sort_order'] ?? 0) - Number(b['sort_order'] ?? 0);
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

export interface Grouped {
  /** Each discipline's services, by the discipline's id, in their order. */
  byDiscipline: ReadonlyMap<string, Row[]>;
  /** Services filed under no discipline, or under one this list does not hold. */
  unfiled: Row[];
}

/** The services under their disciplines, each list in its order; the rest apart. */
export function groupServices(disciplines: readonly Row[], services: readonly Row[]): Grouped {
  const known = new Set(disciplines.map((d) => d.id));
  const byDiscipline = new Map<string, Row[]>(disciplines.map((d) => [d.id, []]));
  const unfiled: Row[] = [];
  for (const service of [...services].sort(bySort)) {
    const owner = service['discipline_id'];
    if (typeof owner === 'string' && known.has(owner)) byDiscipline.get(owner)!.push(service);
    else unfiled.push(service);
  }
  return { byDiscipline, unfiled };
}

/** The pills a discipline's row shows: its first services by name, and how many more. */
export function servicePills(
  services: readonly Row[],
  shown = 4,
): { names: string[]; more: number } {
  return {
    names: services.slice(0, shown).map((s) => nameOf(s)),
    more: Math.max(0, services.length - shown),
  };
}

/** "8 services", "1 service", "No services yet". */
export function servicesCount(n: number): string {
  if (n === 0) return 'No services yet';
  return n === 1 ? '1 service' : `${n} services`;
}

/** Whether a row is on the site: published. Scheduled, draft and archived are not, yet. */
export function isShown(row: Row): boolean {
  return row['status'] === 'published';
}

/**
 * Where the eye takes a row: a published one to draft (hidden), a draft or scheduled one to
 * published (shown now). An archived row has no eye: it is an Admin's to restore, in its
 * editor, and nobody else may write it (H12).
 */
export function eyeTarget(status: unknown): Status | null {
  if (status === 'published') return 'draft';
  if (status === 'draft' || status === 'scheduled') return 'published';
  return null;
}

/** What the eye says it does, for its accessible name: "Hide Branding", "Show Logo". */
export function eyeLabel(row: Row, name: string): string {
  return `${isShown(row) ? 'Hide' : 'Show'} ${name}`;
}

/**
 * The question before a live discipline is hidden: its services go with it (the RESTRICTIVE
 * `services_discipline_published` hides a service whose discipline is not published). The
 * name is a bidi isolate (FSI…PDI), so an Arabic name cannot reorder the sentence.
 */
export function hideDisciplineQuestion(name: string, services: number): string {
  const tail =
    services === 0
      ? 'It has no services yet.'
      : services === 1
        ? 'Its service is hidden from the site too.'
        : `Its ${services} services are hidden from the site too.`;
  return `Hide ⁨${name}⁩? ${tail}`;
}

/** The rows a person's move may renumber: all for one who may archive, else the unarchived. */
export function renumberable<T extends Readonly<Record<string, unknown>>>(
  rows: readonly T[],
  mayArchive: boolean,
): T[] {
  return mayArchive ? [...rows] : rows.filter((row) => row['status'] !== 'archived');
}

export interface Positioned {
  id: string;
  sort_order: number;
}

export interface OrderChange {
  id: string;
  sortOrder: number;
}

/** The step between two disciplines' numbers after a move. */
export const ORDER_STEP = 10;

/**
 * The updates that give `order` as numbers in tens from 10, keeping only the rows whose
 * number changes (U7's orderChanges: each update is one subrequest, P-15). For the
 * disciplines, a short list the site numbers by its order.
 */
export function tensOrderChanges(
  rows: readonly Positioned[],
  order: readonly string[],
): OrderChange[] {
  const current = new Map(rows.map((row) => [row.id, row.sort_order]));
  const changes: OrderChange[] = [];
  order
    .filter((id) => current.has(id))
    .forEach((id, index) => {
      const next = (index + 1) * ORDER_STEP;
      if (current.get(id) !== next) changes.push({ id, sortOrder: next });
    });
  return changes;
}

/**
 * A discipline's services in a new order, renumbered INSIDE the numbers they already hold
 * (AV-14: "the reorder endpoint is remapped inside the discipline's range"). A service's
 * `sort_order` is one sequence across every discipline (the Services page and the home cards
 * read it per discipline, the inquiry form across them), so a move inside one discipline must
 * not reach into another's range. The moved rows take the same numbers, sorted, in their new
 * order; two that shared a number are parted by one (the first move settles a seed's ties).
 * `rows` are the rows the person may renumber (renumberable); an id `order` holds that `rows`
 * does not (an archived row, for a person who may not archive) keeps its number and takes no
 * place. Only the rows whose number changes are sent.
 */
export function rangeOrderChanges(
  rows: readonly Positioned[],
  order: readonly string[],
): OrderChange[] {
  const current = new Map(rows.map((row) => [row.id, row.sort_order]));
  const moved = order.filter((id) => current.has(id));
  const slots = moved.map((id) => current.get(id)!).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]! <= slots[i - 1]!) slots[i] = slots[i - 1]! + 1;
  }
  const changes: OrderChange[] = [];
  moved.forEach((id, index) => {
    if (current.get(id) !== slots[index]) changes.push({ id, sortOrder: slots[index]! });
  });
  return changes;
}

/** Where a new service of a discipline goes: after its last one, else after every service. */
export function nextServiceOrder(inDiscipline: readonly Row[], all: readonly Row[]): number {
  const max = (rows: readonly Row[]) =>
    rows.reduce((m, row) => Math.max(m, Number(row['sort_order'] ?? 0)), 0);
  return inDiscipline.length > 0 ? max(inDiscipline) + 1 : max(all) + ORDER_STEP;
}

/**
 * A slug of its own for a copy (`<slug>-copy`, then `-copy-2`…), at most 64 characters (U7's
 * copySlug, restated: see the header).
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

/**
 * Duplicate (AV-14): the create payload a service's copy is posted with, from the payload its
 * saved form would send (`formToPayload` of the values as stored): a draft, never scheduled,
 * a slug of its own, "(copy)" after the English name, right after the original in its
 * discipline. The case study is not copied: it is its own row, one per service.
 */
export function duplicatePayload(
  payload: Readonly<Record<string, unknown>>,
  takenSlugs: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  delete out['scheduledFor'];
  delete out['version'];
  out['status'] = 'draft';
  if (typeof out['slug'] === 'string' && out['slug'] !== '') {
    out['slug'] = copySlug(out['slug'], takenSlugs);
  }
  const title = (out['title'] ?? {}) as Record<string, unknown>;
  const en = typeof title['en'] === 'string' ? title['en'] : '';
  out['title'] = { ...title, en: en ? `${en} (copy)` : en };
  out['sortOrder'] = Number(payload['sortOrder'] ?? 0) + 1;
  return out;
}

/**
 * A slug from an English name, for the Add modals: lower case letters, digits and single
 * hyphens, at most 64 (SlugSchema). Accents fall away (é → e); a name with no Latin letters
 * gives '' and the person types the address.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** A clip window in words: "Video window 3s to 9s of showreel.mp4", or null for none. */
export function clipWords(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object') return null;
  const clip = preview as Record<string, unknown>;
  const path = typeof clip['path'] === 'string' ? clip['path'] : '';
  if (!path) return null;
  const file = path.split('/').pop() ?? path;
  const start = clip['startS'];
  const end = clip['endS'];
  return typeof start === 'number' && typeof end === 'number'
    ? `Video window ${trimNumber(start)}s to ${trimNumber(end)}s of ${file}`
    : `Video: ${file}`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** A bar's length as a 5% bucket of the longest (charts.ts barBucket, restated: admin-ui). */
export function barWidth(value: number, max: number): number {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  const m = Number.isFinite(max) && max > 0 ? max : 0;
  if (v === 0 || m === 0) return 0;
  return Math.min(100, Math.max(5, Math.round(((v / m) * 100) / 5) * 5));
}

/** "3 leads", "1 lead", "No leads". */
export function leadsCount(n: number): string {
  if (n === 0) return 'No leads';
  return n === 1 ? '1 lead' : `${n} leads`;
}
