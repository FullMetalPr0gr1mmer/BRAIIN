import { MEDIA_LIBRARY_PAGE_SIZE } from '@schemas/media';
import { cleanQuery } from '@/components/admin/fields/media/format';

export { cleanQuery };

// Where the media library stands, and its address (Admin v2 U4). The page reads it from the
// URL on the server (the first page is server-rendered), the island keeps the URL equal to
// it with history.replaceState, so a reload, a shared link or the back button lands on the
// same view: `?q=`, `?tab=videos`, `?alt=missing`, `?page=N`, and `/admin/media/<id>` while
// a picture's drawer is open. `?upload=1` (the dashboard's "Upload media", the old
// /admin/media/new) is read once and never written back.

export type LibraryTab = 'images' | 'videos';

export interface LibraryView {
  tab: LibraryTab;
  /** The search as typed: at most 64 characters, no control character. */
  q: string;
  needsAlt: boolean;
  /** The first row's offset (a page is MEDIA_LIBRARY_PAGE_SIZE rows). */
  offset: number;
  /** The picture whose drawer is open. */
  openId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The view a URL asks for, every value held to what the library takes. */
export function viewFromUrl(params: URLSearchParams, openId: string | null = null): LibraryView {
  const page = Number(params.get('page'));
  const pageNumber = Number.isInteger(page) && page >= 1 && page <= 200 ? page : 1;
  return {
    tab: params.get('tab') === 'videos' ? 'videos' : 'images',
    q: cleanQuery(params.get('q')),
    needsAlt: params.get('alt') === 'missing',
    offset: (pageNumber - 1) * MEDIA_LIBRARY_PAGE_SIZE,
    openId: openId && UUID.test(openId) ? openId.toLowerCase() : null,
  };
}

/** The address of a view: the drawer's picture in the path, the rest as a short query. */
export function viewHref(view: LibraryView): string {
  const params = new URLSearchParams();
  if (view.tab === 'videos') params.set('tab', 'videos');
  if (view.q.trim()) params.set('q', view.q.trim());
  if (view.needsAlt) params.set('alt', 'missing');
  const page = Math.floor(view.offset / MEDIA_LIBRARY_PAGE_SIZE) + 1;
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  const path = view.openId ? `/admin/media/${view.openId}` : '/admin/media';
  return query ? `${path}?${query}` : path;
}

/** The library route's query for a view (the images tab). */
export function libraryQuery(view: LibraryView): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(MEDIA_LIBRARY_PAGE_SIZE),
    offset: String(view.offset),
  });
  if (view.q.trim()) params.set('q', view.q.trim());
  if (view.needsAlt) params.set('alt', 'missing');
  return params;
}

/** "Storage used: 214 MB of 1 GB", in binary units, as the storage plan counts them. */
export function storageText(bytes: number, quota: number): string {
  const unit = (n: number) => {
    const gb = n / 1024 ** 3;
    if (gb >= 1) return `${Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
    const mb = n / 1024 ** 2;
    if (mb >= 1) return `${Math.round(mb).toLocaleString('en-GB')} MB`;
    return `${Math.round(n / 1024).toLocaleString('en-GB')} KB`;
  };
  return `Storage used: ${unit(Math.max(0, bytes))} of ${unit(Math.max(1, quota))}`;
}

/**
 * The meter's width bucket, 0 to 100 in fives, for `.bar-fill[data-width]`: charts.ts's
 * barBucket rule (anything above zero gets at least 5), restated so the charts module stays
 * out of the browser (tests/lib/mediaUsageLinks.spec.ts holds the two equal).
 */
export function meterBucket(value: number, max: number): number {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  const m = Number.isFinite(max) && max > 0 ? max : 0;
  if (v === 0 || m === 0) return 0;
  return Math.min(100, Math.max(5, Math.round(((v / m) * 100) / 5) * 5));
}

/** What the role may do here, decided on the server from ROLE_CAPS and the nav registry. */
export interface MediaPermissions {
  /** media.write at full: Upload and Replace (with uploads set up). */
  write: boolean;
  /** media.hardDelete at full: Delete. */
  hardDelete: boolean;
  /** The "Used in" screens the role's sidebar opens. */
  opens: readonly string[];
}
