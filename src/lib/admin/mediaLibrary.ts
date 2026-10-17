import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { MediaLibraryQuerySchema, type MediaLibraryQuery } from '@schemas/media';
import type { AuthContext } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { MEDIA_STORAGE_QUOTA_BYTES } from '@/lib/media/storage';
import {
  viewFromUrl,
  type LibraryView,
  type MediaPermissions,
} from '@/components/admin/screens/media/libraryState';
import { USAGE_SCREENS } from '@/components/admin/screens/media/usage';
import type { Role } from '@/lib/auth/types';
import { ADMIN_NAV, isVisible, type NavTab } from './nav';
import { getRow } from './crud';
import { NotFoundError, ValidationError } from './errors';
import { uploadsConfigured } from './mediaUpload';
import { mediaResource } from './resources/media';

// The media library's reads (Admin v2 U4), shared by its API routes and the page's first
// render, so the screen and GET /api/admin/media/library answer alike.
//
//   loadMediaLibrary  one page of pictures through `public.media_library` (0064): SECURITY
//                     INVOKER under the caller's own client, the tenant named from the
//                     session (the function answers empty for any other), the search folded
//                     and escaped there. A 22023 (a bound the schema should already have
//                     held) is a 422; any other error is the kernel's 500. Rows go through
//                     the media resource's fromRow, so a tile gets the same `thumb_url` (and
//                     the drawer its `preview_url`) as every other reader of media.
//   loadMediaStats    "Storage used" and whether Upload can be offered (`uploadsReady`, the
//                     upload route's own "Not set up" test; `canUpload`, that and media.write
//                     at full). For the buttons only: the upload route checks both again.

type Row = Record<string, unknown>;

export interface MediaLibraryPage {
  total: number;
  rows: Row[];
}

export interface MediaStats {
  assets: number;
  bytes: number;
  quotaBytes: number;
  uploadsReady: boolean;
  canUpload: boolean;
}

const PageSchema = z.object({
  total: z.coerce.number().int().min(0),
  rows: z.array(z.record(z.unknown())),
});

const StatsRowSchema = z.object({
  assets: z.coerce.number().int().min(0),
  bytes: z.coerce.number().int().min(0),
});

export async function loadMediaLibrary(
  sb: SupabaseClient,
  auth: AuthContext,
  query: MediaLibraryQuery,
): Promise<MediaLibraryPage> {
  const { data, error } = await sb.rpc('media_library', {
    p_tenant: auth.tenantId,
    p_q: query.q ?? null,
    p_kind: query.tab,
    p_needs_alt: query.alt === 'missing',
    p_limit: query.limit,
    p_offset: query.offset,
  });
  if (error) {
    if (error.code === '22023')
      throw new ValidationError('the search or the page is out of range', 'q');
    throw new Error(`media_library: ${error.code ?? 'error'}`);
  }
  if (data === null || data === undefined) return { total: 0, rows: [] };
  const page = PageSchema.parse(data);
  return {
    total: page.total,
    rows: page.rows.map((row) => (mediaResource.fromRow ? mediaResource.fromRow(row) : row)),
  };
}

export async function loadMediaStats(sb: SupabaseClient, auth: AuthContext): Promise<MediaStats> {
  const { data, error } = await sb.rpc('media_storage_stats', { p_tenant: auth.tenantId });
  if (error) throw new Error(`media_storage_stats: ${error.code ?? 'error'}`);
  const row = (Array.isArray(data) ? data[0] : data) ?? { assets: 0, bytes: 0 };
  const { assets, bytes } = StatsRowSchema.parse(row);
  const uploadsReady = uploadsConfigured();
  return {
    assets,
    bytes,
    quotaBytes: MEDIA_STORAGE_QUOTA_BYTES,
    uploadsReady,
    canUpload: uploadsReady && can(auth.role, 'media.write') === 'full',
  };
}

// ── The screen's first render (/admin/media and /admin/media/[id]) ─────────────────────────

/** The sidebar entry (a link or one of its tabs) whose address is `href`. */
function navEntry(href: string): NavTab | null {
  for (const group of ADMIN_NAV) {
    for (const link of group.links) {
      if (link.href === href) return link;
      const tab = link.tabs?.find((t) => t.href === href);
      if (tab) return tab;
    }
  }
  return null;
}

/**
 * The "Used in" screens this role's sidebar opens (isVisible over ADMIN_NAV): an entry is a
 * link only to one of these. Decided here so the menu's registry stays on the server.
 */
export function usageScreensFor(role: Role): string[] {
  return USAGE_SCREENS.filter((screen) => {
    const entry = navEntry(screen);
    return entry !== null && isVisible(role, entry);
  });
}

/** What the screen's buttons offer the role (ROLE_CAPS; every route checks again). */
export function mediaPermissionsFor(role: Role): MediaPermissions {
  return {
    write: can(role, 'media.write') === 'full',
    hardDelete: can(role, 'media.hardDelete') === 'full',
    opens: usageScreensFor(role),
  };
}

export interface MediaScreen {
  view: LibraryView;
  permissions: MediaPermissions;
  initial: MediaLibraryPage | null;
  initialError: string | null;
  stats: MediaStats | null;
  openRow: Row | null;
  /** /admin/media/<id> named no picture of this tenant: the page answers 404. */
  notFound: boolean;
  /** "N files. Images are resized and compressed automatically for every screen." */
  subtitle: string;
  /** The page head's Upload is offered (media.write full, uploads set up). */
  canUpload: boolean;
}

export const MEDIA_SCREEN_SUB = 'Images are resized and compressed automatically for every screen.';

/**
 * What the library page renders before the island hydrates: the view the URL asks for, its
 * first page and the stats (one RPC each, in parallel), and the picture a deep link opens.
 * Every read is the caller's own client: RLS and the tenant named by the session decide.
 * A failed read becomes the screen's error line, never a 500.
 */
export async function loadMediaScreen(
  sb: SupabaseClient | null | undefined,
  auth: AuthContext | null,
  url: URL,
  openId: string | null = null,
): Promise<MediaScreen> {
  const view = viewFromUrl(url.searchParams, openId);
  const empty: MediaScreen = {
    view,
    permissions: auth
      ? mediaPermissionsFor(auth.role)
      : { write: false, hardDelete: false, opens: [] },
    initial: null,
    initialError: null,
    stats: null,
    openRow: null,
    notFound: openId !== null && view.openId === null,
    subtitle: MEDIA_SCREEN_SUB,
    canUpload: false,
  };
  const access = auth ? can(auth.role, 'media.write') : 'none';
  if (!sb || !auth || (access !== 'full' && access !== 'meta')) {
    return { ...empty, initialError: 'Your role does not allow that.' };
  }
  if (empty.notFound) return empty;

  const query = MediaLibraryQuerySchema.parse({
    ...(view.q.trim() ? { q: view.q.trim() } : {}),
    ...(view.needsAlt ? { alt: 'missing' } : {}),
    offset: view.offset,
  });
  const [page, stats, open] = await Promise.allSettled([
    loadMediaLibrary(sb, auth, query),
    loadMediaStats(sb, auth),
    view.openId
      ? getRow<Row>(sb, 'media_assets', auth, view.openId, mediaResource.columns)
      : Promise.resolve(null),
  ]);
  if (open.status === 'rejected' && open.reason instanceof NotFoundError) {
    return { ...empty, notFound: true };
  }
  const statsValue = stats.status === 'fulfilled' ? stats.value : null;
  const openRow =
    open.status === 'fulfilled' && open.value
      ? mediaResource.fromRow
        ? mediaResource.fromRow(open.value)
        : open.value
      : null;
  const files = statsValue
    ? `${statsValue.assets.toLocaleString('en-GB')} ${statsValue.assets === 1 ? 'file' : 'files'}. `
    : '';
  return {
    view,
    permissions: empty.permissions,
    initial: page.status === 'fulfilled' ? page.value : null,
    initialError:
      page.status === 'rejected'
        ? 'The pictures could not be loaded just now. Reload to try again.'
        : null,
    stats: statsValue,
    openRow,
    notFound: false,
    subtitle: `${files}${MEDIA_SCREEN_SUB}`,
    canUpload: statsValue?.canUpload === true,
  };
}
