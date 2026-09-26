import type { ImageMetadata } from 'astro';
import type { Locale } from '@schemas/primitives';
import type { PublicMediaRow } from '@schemas/content';
import { VideoClipSchema, type VideoClip } from '@schemas/media';
import { staticImage } from './static';

// Public media rows (packages/schemas/content.ts PublicMediaRowSchema) → what a component
// renders. One place decides which providers can reach a page:
//   static     the build-time registry (src/lib/media/static.ts) — dimensions come from
//              the file itself, never from the row
//   cf_images  UI v2 PR5 (editor uploads) adds it, with image.remotePatterns pinned to our
//              account hash; until then it resolves to null
//   anything else (a legacy external URL, a Stream row used as an image) → null
// A null image is not rendered, so a bad row degrades to a missing picture, never to an
// arbitrary URL on the page.

export interface ImageRef {
  id: string;
  src: ImageMetadata;
  width: number;
  height: number;
  /** Authored per locale; '' = decorative (the dashboard flags it — 0025 missing_alt). */
  alt: { en: string; ar: string };
}

export function imageRef(row: PublicMediaRow | null | undefined): ImageRef | null {
  if (!row || row.kind !== 'image') return null;
  if (row.provider !== 'static') return null;
  const src = staticImage(row.storage_path);
  if (!src) return null;
  return {
    id: row.id,
    src,
    width: src.width,
    height: src.height,
    alt: { en: row.alt?.en?.trim() ?? '', ar: row.alt?.ar?.trim() ?? '' },
  };
}

/** Alt text for the page's locale (an override wins, e.g. a case-study caption). */
export function altFor(image: ImageRef, locale: Locale, override?: string | null): string {
  const text = override?.trim();
  return text ? text : image.alt[locale];
}

/**
 * Clip columns (uid | path + window) → a validated VideoClip, or null. Run through the
 * same schema the admin writes with, so a row that slipped past it (a hand edit) still
 * cannot put an unexpected source on the page.
 */
export function clipOf(cols: {
  uid: string | null;
  path: string | null;
  startS: number | null;
  endS: number | null;
}): VideoClip | null {
  const candidate: Record<string, unknown> = {};
  if (cols.uid) candidate['streamUid'] = cols.uid;
  if (cols.path) candidate['path'] = cols.path;
  if (cols.startS !== null) candidate['startS'] = cols.startS;
  if (cols.endS !== null) candidate['endS'] = cols.endS;
  if (!cols.uid && !cols.path) return null;
  const parsed = VideoClipSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
