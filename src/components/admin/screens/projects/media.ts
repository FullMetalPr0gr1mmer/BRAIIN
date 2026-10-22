// A project's media by role (Admin v2 U6, AV-15): the editor shows `portfolio_media` as four
// controls in three tabs (the hero banner in Basics, the final film in Case study, the
// breakdown and the gallery in Breakdown & gallery), while the API, `save_portfolio` and the
// release path keep ONE ordered `media` set (resources/portfolio.ts, PortfolioWriteSchema). So
// the editor's form is a view over that one field: `splitMedia` turns the set (the form state
// of the `media` repeater, as useEntitySave loaded it) into the four controls' values, and
// `joinMedia` turns them back into the set the save sends, in a fixed order (hero, final film,
// breakdown, gallery; within a role, the order the person gave). Pure, unit-tested
// (tests/lib/projectEditor.spec.ts); the hook that wires it is ProjectEditor.tsx.
//
//   kind     each item's `kind` follows what it holds: a video clip makes it a video (its
//            picture is then the poster), a picture alone an image. Nothing chosen is no item
//            (an empty hero or final film is not sent).
//   kept     every key an item holds that its control does not draw (a hero's caption, a
//            gallery video's clip) rides along unchanged, so a reorder or an edit elsewhere
//            never loses what is stored.
//   errors   the server names an item by its place in the set (`media.3.mediaId`); the
//            layout `splitMedia` returns maps that place to the control holding the item, so a
//            refused save lands on the hero, the film, the right breakdown item or the gallery
//            (remapMediaErrors).

export type Item = Record<string, unknown>;

export const MEDIA_ROLES = ['hero', 'final', 'breakdown', 'gallery'] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

/** The four controls' field names, by the role each holds. */
export const VIEW_FIELD: Readonly<Record<MediaRole, string>> = {
  hero: 'heroItem',
  final: 'finalFilm',
  breakdown: 'breakdown',
  gallery: 'gallery',
};

/** The media view's field names (the editor's own; never sent). */
export const MEDIA_VIEW_FIELDS: ReadonlySet<string> = new Set(Object.values(VIEW_FIELD));

export interface MediaView {
  heroItem: Item;
  finalFilm: Item;
  breakdown: Item[];
  gallery: Item[];
}

/** Where item k of the set sits in the view: its control, and its place in a list. */
export interface Slot {
  role: MediaRole;
  index: number;
}

/** True when an item's clip (the ClipField's state) names a video. */
export function hasClip(item: Item): boolean {
  const clip = item['clip'];
  return Boolean(clip && typeof clip === 'object' && (clip as Item)['source']);
}

/** True when an item's picture is chosen. */
function hasPicture(item: Item): boolean {
  return typeof item['mediaId'] === 'string' && item['mediaId'] !== '';
}

/** An item without its role (the control knows it). */
function withoutRole(item: Item): Item {
  const { role: _role, ...rest } = item;
  return rest;
}

/**
 * The set → the four controls' values, and where each item of the set went: `layout[k]` is
 * the control (and the place in it) of the set's item k, in the set's OWN order, which is the
 * order the save sends it (as loaded until a media control changes, then joinMedia's), so the
 * server's `media.k` lands on the right control either way.
 */
export function splitMedia(media: unknown): { view: MediaView; layout: Slot[] } {
  const items = Array.isArray(media) ? (media as Item[]) : [];
  const view: MediaView = { heroItem: {}, finalFilm: {}, breakdown: [], gallery: [] };
  const layout: Slot[] = [];
  let hero = false;
  let final = false;
  for (const item of items) {
    const role = item['role'];
    if (role === 'hero' && !hero) {
      hero = true;
      view.heroItem = withoutRole(item);
      layout.push({ role: 'hero', index: 0 });
    } else if (role === 'final' && !final) {
      final = true;
      view.finalFilm = withoutRole(item);
      layout.push({ role: 'final', index: 0 });
    } else if (role === 'breakdown') {
      layout.push({ role: 'breakdown', index: view.breakdown.length });
      view.breakdown.push(withoutRole(item));
    } else {
      // A gallery item, and anything the database would not hold twice (a second hero or
      // film, which 0022's unique indexes refuse): shown in the gallery, never dropped.
      layout.push({ role: 'gallery', index: view.gallery.length });
      view.gallery.push(withoutRole(item));
    }
  }
  return { view, layout };
}

/** One item of the set, its kind following what it holds; null when it holds nothing. */
function asItem(role: MediaRole, item: Item): Item | null {
  const clip = hasClip(item);
  if (!clip && !hasPicture(item)) return null;
  return { ...item, role, kind: clip ? 'video' : 'image' };
}

/** The four controls' values → the set the save sends, and where each item came from. */
export function joinMedia(view: MediaView): { media: Item[]; layout: Slot[] } {
  const media: Item[] = [];
  const layout: Slot[] = [];
  const push = (role: MediaRole, index: number, item: Item) => {
    const shaped = asItem(role, item);
    if (!shaped) return;
    media.push(shaped);
    layout.push({ role, index });
  };
  push('hero', 0, view.heroItem ?? {});
  push('final', 0, view.finalFilm ?? {});
  (view.breakdown ?? []).forEach((item, index) => push('breakdown', index, item));
  (view.gallery ?? []).forEach((item, index) => push('gallery', index, item));
  return { media, layout };
}

/** A view with one control's value replaced, from the set as it stands. */
export function setView(media: unknown, name: string, value: unknown): Item[] {
  const { view } = splitMedia(media);
  const next: MediaView = { ...view };
  if (name === VIEW_FIELD.hero) next.heroItem = (value ?? {}) as Item;
  else if (name === VIEW_FIELD.final) next.finalFilm = (value ?? {}) as Item;
  else if (name === VIEW_FIELD.breakdown) next.breakdown = Array.isArray(value) ? value : [];
  else if (name === VIEW_FIELD.gallery) next.gallery = Array.isArray(value) ? value : [];
  return joinMedia(next).media;
}

/** The sub-fields each control draws: an error naming another key lands on the control. */
const DRAWN: Readonly<Record<MediaRole, ReadonlySet<string>>> = {
  hero: new Set(['clip', 'mediaId']),
  final: new Set(['clip', 'mediaId', 'durationLabel']),
  breakdown: new Set(['breakdownKind', 'layout', 'mediaId', 'clip', 'caption']),
  gallery: new Set(),
};

/** The words a control is named by in the error list. */
export const VIEW_LABEL: Readonly<Record<MediaRole, string>> = {
  hero: 'Hero banner',
  final: 'Final film',
  breakdown: 'Breakdown',
  gallery: 'Gallery',
};

/**
 * An element id the API's errors name in the `media` set (`f-media-3-mediaId`, as
 * fieldErrors.ts makes it) → the id of the control holding that item (`f-heroItem-mediaId`,
 * `f-breakdown-1-mediaId`, `f-gallery`). An error about the whole set (`f-media`: a
 * breakdown item without its kind, from the database) lands on the breakdown. Any other id
 * is returned as it is.
 */
export function viewIdOf(id: string, layout: readonly Slot[]): string {
  if (id === 'f-media') return `f-${VIEW_FIELD.breakdown}`;
  const match = /^f-media-(\d+)(?:-(.+))?$/.exec(id);
  if (!match) return id;
  const slot = layout[Number(match[1])];
  if (!slot) return `f-${VIEW_FIELD.breakdown}`;
  const base = `f-${VIEW_FIELD[slot.role]}`;
  const rest = match[2];
  const sub = rest?.split('-')[0];
  const drawn = sub !== undefined && DRAWN[slot.role].has(sub);
  if (slot.role === 'breakdown') {
    return drawn ? `${base}-${slot.index}-${rest}` : `${base}-${slot.index}`;
  }
  return drawn ? `${base}-${rest}` : base;
}

/** The words before a message in the error list, for an item of the set. */
function viewNameOf(id: string, layout: readonly Slot[]): string | null {
  if (id === 'f-media') return 'Breakdown & gallery';
  const match = /^f-media-(\d+)/.exec(id);
  if (!match) return null;
  const slot = layout[Number(match[1])];
  if (!slot) return 'Breakdown & gallery';
  return slot.role === 'breakdown' ? `Breakdown ${slot.index + 1}` : VIEW_LABEL[slot.role];
}

interface Errors {
  byId: Readonly<Record<string, string>>;
  summary: readonly { id?: string | undefined; message: string }[];
}

/**
 * The save's errors with every item of the set moved onto its control. The summary's words
 * name the control ("Hero banner: …", "Breakdown 2: …") instead of the set's place
 * ("Case-study media 3, …"): the message after the first ": " is the server's, kept.
 */
export function remapMediaErrors<E extends Errors>(errors: E, layout: readonly Slot[]): E {
  const byId: Record<string, string> = {};
  for (const [id, message] of Object.entries(errors.byId)) {
    const to = viewIdOf(id, layout);
    byId[to] ??= message;
  }
  const summary = errors.summary.map((item) => {
    if (!item.id || !(item.id === 'f-media' || item.id.startsWith('f-media-'))) return item;
    const name = viewNameOf(item.id, layout);
    const cut = item.message.indexOf(': ');
    const message = name && cut >= 0 ? `${name}: ${item.message.slice(cut + 2)}` : item.message;
    return { ...item, id: viewIdOf(item.id, layout), message };
  });
  return { ...errors, byId, summary };
}
