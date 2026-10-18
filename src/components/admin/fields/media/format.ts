// What a picture is called and how big it is, in words (Admin v2 U4): the tile, the drawer,
// the upload dialog and the picker say it the same way. Pure; en-GB digits (P-12: an Arabic
// digit is never produced, and none is transformed); KB is 1,000 bytes (P-10's unit).

import { MEDIA_LIBRARY_QUERY_MAX } from '@schemas/media';

export type MediaRow = Record<string, unknown>;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A search as the route will take it: control characters dropped, cut to 64. */
export function cleanQuery(value: string | null | undefined): string {
  const cut = (value ?? '').replace(CONTROL, '').slice(0, MEDIA_LIBRARY_QUERY_MAX);
  // A cut between the two halves of a character (an emoji) would leave half of it, which no
  // URL or text column can carry: drop the half. The route counts UTF-16 units, so the cut does.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * What a picture's alt text lacks, in words, or null when both languages have it (Admin v2
 * F5a's badge; MediaField re-exports it under its frozen name).
 */
export function altGap(row: MediaRow | null): string | null {
  if (!row || !('alt' in row)) return null;
  const alt = (row['alt'] && typeof row['alt'] === 'object' ? row['alt'] : {}) as MediaRow;
  const has = (lang: string) =>
    typeof alt[lang] === 'string' && (alt[lang] as string).trim() !== '';
  if (!has('en') && !has('ar')) return 'No alt text';
  if (!has('ar')) return 'No Arabic alt';
  if (!has('en')) return 'No English alt';
  return null;
}

const NUMBER = new Intl.NumberFormat('en-GB');
const ONE_DECIMAL = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** "412 KB", "3.4 MB", "900 B"; null for a size that is not a whole number of bytes. */
export function sizeText(bytes: unknown): string | null {
  const n = typeof bytes === 'number' ? bytes : typeof bytes === 'string' ? Number(bytes) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${NUMBER.format(Math.round(n))} B`;
  if (n < 1_000_000) return `${NUMBER.format(Math.round(n / 1000))} KB`;
  if (n < 1_000_000_000) return `${ONE_DECIMAL.format(n / 1_000_000)} MB`;
  return `${ONE_DECIMAL.format(n / 1_000_000_000)} GB`;
}

/** "2,560 by 1,707"; null when either side is missing. */
export function dimsText(width: unknown, height: unknown): string | null {
  const w = Number(width);
  const h = Number(height);
  if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) return null;
  return `${NUMBER.format(w)} by ${NUMBER.format(h)}`;
}

/** The last segment of a stored path: a still's file name ("p0.jpg"). */
function fileOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * What a picture is called: the name it was uploaded with, else its English alt text, else a
 * still's file name. Never an upload's random key.
 */
export function caption(row: MediaRow): string {
  const name = typeof row['display_name'] === 'string' ? row['display_name'].trim() : '';
  if (name) return name;
  const alt = row['alt'] && typeof row['alt'] === 'object' ? (row['alt'] as MediaRow) : {};
  const en = typeof alt['en'] === 'string' ? alt['en'].trim() : '';
  if (en) return en;
  const path = typeof row['storage_path'] === 'string' ? row['storage_path'] : '';
  if (path && row['provider'] !== 'storage') return fileOf(path);
  return 'Untitled picture';
}

/** The picture's type in words, for the drawer's facts. */
export function typeText(row: MediaRow): string {
  switch (row['provider']) {
    case 'storage':
      return 'WebP image';
    case 'static':
      return 'Image shipped with the site';
    case 'external':
      return 'Image from another address';
    case 'cf_images':
      return 'Cloudflare Images';
    case 'stream':
      return 'Cloudflare Stream video';
    default:
      return 'Image';
  }
}

/** "2,560 by 1,707, 412 KB" without the parts a row does not have. */
export function factsLine(row: MediaRow): string {
  return [dimsText(row['width'], row['height']), sizeText(row['size_bytes'])]
    .filter(Boolean)
    .join(', ');
}
