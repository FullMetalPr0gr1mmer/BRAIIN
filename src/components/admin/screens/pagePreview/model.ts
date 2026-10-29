import { PREVIEW_MESSAGE_VERSION, type ToPreviewMessage } from '@schemas/previewMessage';
import { toPreviewPath } from '@/lib/admin/preview/paths';
import { localizedPath } from '@/lib/i18n';
import type { PreviewLang } from './editorSide';

// The live preview column's rules (Admin v2 E2, docs/admin-v2/ui.md "Preview column (AV-26)"),
// pure so tests/lib/pagePreview.spec.ts holds them: the frame's address per language, the
// device widths and how a width is scaled into the column, what the column sends after the
// preview says it is ready, which section a click in the preview may open, and the words.
// The preview is R9's route (`/admin/preview/**`); its addresses come from R9's own map
// (src/lib/admin/preview/paths.ts), so the column frames exactly what the server renders.

export type { PreviewLang };
export type PreviewDevice = 'desktop' | 'tablet' | 'phone';

/** The widths a page is rendered at (ui.md: 1280 / 834 / 390), then scaled to the column. */
export const DEVICE_WIDTH: Readonly<Record<PreviewDevice, number>> = {
  desktop: 1280,
  tablet: 834,
  phone: 390,
};

export const DEVICE_OPTIONS = [
  { value: 'desktop', label: 'Desktop', icon: 'desktop' },
  { value: 'tablet', label: 'Tablet', icon: 'tablet' },
  { value: 'phone', label: 'Phone', icon: 'mobile' },
] as const;

/** The space kept around the scaled page inside the column's frame area, each side (px). */
export const FRAME_GUTTER = 12;

/** How long the column waits after a save before it reloads the preview (an autosave burst
 * is one reload). With R12's 800 ms idle autosave the preview follows about 1 s after the
 * typing stops (P-5). */
export const RELOAD_DELAY_MS = 250;

/** How long after the frame's `load` the column waits before it says the preview did not
 * answer (a page without the bridge: an error page, another site; see bridgeMissing). */
export const READY_GRACE_MS = 1500;

/**
 * The frame's address for the page's English path in a language, or null (not previewed). The
 * public path in a language is the site's own `localizedPath` (`/about` → `/ar/about`, `/` →
 * `/ar`), the one every page's hreflang twins use.
 */
export function previewSrc(path: string | null, lang: PreviewLang): string | null {
  if (!path) return null;
  return toPreviewPath(localizedPath(path, lang));
}

export interface FrameFit {
  scale: number;
  /** The page's own width and height (the frame's layout box, before the scale). */
  frameWidth: number;
  frameHeight: number;
  /** The box the scaled frame fills in the column. */
  boxWidth: number;
  boxHeight: number;
}

/**
 * The device's width scaled down to the column (never up), the frame as tall as the area at
 * that scale: a phone fits a narrow column nearly at its own size, a desktop is a scaled view.
 */
export function fitFrame(area: { width: number; height: number }, device: PreviewDevice): FrameFit {
  const width = DEVICE_WIDTH[device];
  const availWidth = Math.max(1, area.width - 2 * FRAME_GUTTER);
  const availHeight = Math.max(1, area.height - 2 * FRAME_GUTTER);
  const scale = Math.min(1, availWidth / width);
  return {
    scale,
    frameWidth: width,
    frameHeight: Math.ceil(availHeight / scale),
    boxWidth: Math.floor(width * scale),
    boxHeight: Math.floor(availHeight),
  };
}

/** The pathname of a preview address (`/admin/preview/about?only=…` → `/admin/preview/about`). */
export function pathnameOf(path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  return bare.length > 1 ? bare.replace(/\/$/, '') : bare;
}

/** Whether the preview shows the page the editor edits (and not a page a link led to). */
export function showsPage(shown: string, src: string): boolean {
  return pathnameOf(shown) === pathnameOf(src);
}

/**
 * What the column sends once the preview says it is ready, and after the editor opens another
 * section: on the editor's page, jump to the open section and outline it when the preview shows
 * it, else take any outline away. A section the preview does not list (hidden, or not on the
 * page shown) is never jumped to.
 */
export function followUp(
  listed: readonly string[],
  selected: string,
  onPage: boolean,
): ToPreviewMessage[] {
  const v = PREVIEW_MESSAGE_VERSION;
  if (onPage && listed.includes(selected)) {
    return [
      { v, type: 'jump', sectionId: selected },
      { v, type: 'highlight', sectionId: selected },
    ];
  }
  return [{ v, type: 'highlight', sectionId: null }];
}

/**
 * Whether a click reported by the preview (`select`) may open that section: one the editor
 * lists, on the editor's own page, and not the one already open.
 */
export function mayOpen(
  sectionId: string,
  rows: readonly string[],
  selected: string,
  onPage: boolean,
): boolean {
  return onPage && sectionId !== selected && rows.includes(sectionId);
}

/**
 * What the column holds back from a hidden frame (P-15). Below 1280 px the column sits in a
 * `display: none` box while the fields are shown, and a frame there still loads (a Worker
 * request for a preview nobody sees) and still takes messages, but a `jump` scrolls nothing
 * (scrollIntoView in an unrendered document is a no-op, and nothing replays it). So while the
 * column is hidden it keeps the address it last gave the frame, and owes the newer address,
 * the reload and the jump; once it is shown again it pays the one that covers the others: a new
 * address loads a new page and a reload a new document, each followed on its `ready`, and only
 * a jump alone is sent as it is.
 */
export interface FrameDebt {
  /** The address the frame was given ('' until the column is first shown). */
  src: string;
  /** The address it should show (the language may change while the column is hidden). */
  want: string;
  /** A save settled while the column was hidden. */
  reload: boolean;
  /** The open section changed, or the frame said `ready`, while the column was hidden. */
  jump: boolean;
}

export type FrameEvent =
  /** The address the editor wants (its language) changed. */
  | { type: 'address'; src: string }
  /** A burst of saves settled. */
  | { type: 'saved' }
  /** The preview is ready, or another section opened: `jump` and `highlight` are due. */
  | { type: 'follow' }
  /** The column was laid out (or resized): pay what is owed. */
  | { type: 'shown' };

/** What the column does now: reload the frame, or send `followUp`. A new `src` loads itself. */
export type FrameAct = 'reload' | 'follow' | null;

/** The frame's first debt: nothing given yet, the editor's address owed. */
export function frameDebt(want: string): FrameDebt {
  return { src: '', want, reload: false, jump: false };
}

/** One event against the debt, with whether the column is laid out right now. */
export function frameStep(
  debt: FrameDebt,
  event: FrameEvent,
  shown: boolean,
): { debt: FrameDebt; act: FrameAct } {
  switch (event.type) {
    case 'address':
      if (event.src === debt.want && event.src === debt.src) return { debt, act: null };
      return shown
        ? { debt: { src: event.src, want: event.src, reload: false, jump: false }, act: null }
        : { debt: { ...debt, want: event.src }, act: null };
    case 'saved':
      return shown ? { debt, act: 'reload' } : { debt: { ...debt, reload: true }, act: null };
    case 'follow':
      return shown ? { debt, act: 'follow' } : { debt: { ...debt, jump: true }, act: null };
    case 'shown': {
      if (!shown) return { debt, act: null };
      const clear = { src: debt.want, want: debt.want, reload: false, jump: false };
      // A new page: its `ready` is followed, and it is the newest anyway.
      if (debt.want !== debt.src) return { debt: clear, act: null };
      if (debt.reload) return { debt: clear, act: 'reload' };
      if (debt.jump) return { debt: clear, act: 'follow' };
      return { debt, act: null };
    }
  }
}

/** Where the frame stands: a page loading, a page whose bridge said `ready`, or neither. */
export type FrameState = 'loading' | 'ready' | 'failed';

/**
 * What a reload asks of the frame now. A ready preview is sent `reload` (one new document).
 * After a save (`by: 'save'`), a frame still loading is not torn down: the reload waits, one
 * for any number of saves, until it is ready (E2 review CR2: remounting on every save while a
 * slow render loaded multiplied Worker requests, and under the 800 ms autosave a frame might
 * never reach ready). A frame that failed, or the person's own Reload while it loads, gets a
 * new frame.
 */
export type ReloadAct = 'send' | 'queue' | 'remount';

export function reloadAct(state: FrameState, by: 'save' | 'person'): ReloadAct {
  if (state === 'ready') return 'send';
  if (state === 'loading' && by === 'save') return 'queue';
  return 'remount';
}

/**
 * Whether the page the frame shows has no bridge, so the preview cannot follow it: the
 * document in the frame now (null when it is another origin's, which the column cannot read)
 * is not one that said `ready`. Held per document, not by counting messages against loads
 * (E2 review CR3): a document's `ready` that reached the column after its frame's `load`
 * would have been credited to the next load, and a page without the bridge after it missed.
 */
export function bridgeMissing(
  shown: object | null,
  readied: { has(document: object): boolean },
): boolean {
  return shown === null || !readied.has(shown);
}

/** The note when the open section is not in the preview, or null when it is shown. */
export function missingNote(
  section: { name: string; visible: boolean } | null,
  listed: readonly string[],
  selected: string,
): string | null {
  if (!section || listed.includes(selected)) return null;
  return section.visible
    ? `${section.name} does not show on this page, so the preview cannot point at it.`
    : `${section.name} is hidden, so the preview does not show it.`;
}
