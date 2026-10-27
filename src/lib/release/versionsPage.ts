import type { SupabaseClient } from '@supabase/supabase-js';
import { RELEASE_MAX_ITEMS } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { can, type Access } from '@/lib/authz/matrix';
import type { AdminRouteContext } from '@/lib/admin/route';
import { PENDING_ANY_CAP } from './draftEndpoints';
import { untouchedRestore } from './drafts';
import { listVersions, versionDetail, type VersionSummary } from './versions';

// Backups & versions, `/admin/backups` (Admin v2 R13; plan B7.3; releases.md §7 "Versions
// page"; ui.md §4 "Backups & versions"). SERVER ONLY: what the page reads, through the person's
// own RLS-bound client and R10's readers, so the page and `GET /api/admin/releases` read the
// same rows the same way.
//
//   - who may open it: a CMS role holding a release read capability (`PENDING_ANY_CAP` at full,
//     view or meta: Admin, Content Creator, SEO, Developer); Sales and anyone else get the
//     page's 403 and read nothing (`mayOpenVersions`). RLS is the other layer: the ledger is
//     CMS staff's (0038).
//   - releases off (every tenant until R14): the flag is the only read, and the page says so;
//     no version exists, so nothing else is asked.
//   - on: R10's versions list (published newest first, 50 a page, scheduled and failed on top,
//     people named), and the restores waiting to be published, by the version they restore:
//     the changes a restore staged and marked (`origin_kind = 'restore'`), so the version's row
//     can publish them as its rollback (R10: every open change of that restore, untouched since).
//   - one version's changes for `?details=<id>`: R10's `versionDetail` (each change listed only
//     in an area the person reads, the others counted).

type Row = Record<string, unknown>;

const READ_LEVELS: readonly Access[] = ['full', 'view', 'meta'];

/** May this role open Backups & versions (B7.3: a release read capability; never Sales)? */
export function mayOpenVersions(role: AuthContext['role']): boolean {
  return PENDING_ANY_CAP.some((cap) => READ_LEVELS.includes(can(role, cap)));
}

/** A restore's changes, as the rollback publish names them. */
export interface RestoreRef {
  draftId: string;
  draftVersion: number;
}

/** A restore waiting to be published, for the version it restores. */
export interface OpenRestore {
  /** The changes the restore staged, as they stand. */
  items: RestoreRef[];
  /** Every one is as the restore left it, so they publish as the version's rollback. */
  untouched: boolean;
}

export interface VersionsPage {
  enabled: boolean;
  live: number | null;
  versions: VersionSummary[];
  upcoming: VersionSummary[];
  more: boolean;
  /** Open restores by the id of the version they restore. */
  restores: Record<string, OpenRestore>;
}

export interface VersionsPageInput {
  sb: SupabaseClient;
  auth: AuthContext;
  before?: number | undefined;
}

/** The flag, read once: `public.releases_enabled` (0062); a failed read is off. */
export async function releasesOn(sb: SupabaseClient, auth: AuthContext): Promise<boolean> {
  const { data, error } = await sb.rpc('releases_enabled', { p_tenant: auth.tenantId });
  return !error && data === true;
}

/** What R10's readers need of a route's context, built for a page that already knows the flag. */
function readerContext(
  input: VersionsPageInput,
  enabled: boolean,
  params: Record<string, string | undefined> = {},
): AdminRouteContext<unknown> {
  return {
    sb: input.sb,
    auth: input.auth,
    params,
    releasesEnabled: async () => enabled,
  } as unknown as AdminRouteContext<unknown>;
}

/** The restores waiting to be published, grouped by the version each restores. */
async function openRestores(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<Record<string, OpenRestore>> {
  const { data, error } = await sb
    .from('content_drafts')
    .select('id,version,origin_kind,origin_release_id,release_id')
    .eq('tenant_id', auth.tenantId)
    .eq('origin_kind', 'restore')
    .limit(4 * RELEASE_MAX_ITEMS);
  if (error) throw new Error(`read open restores: ${error.message}`);
  const out: Record<string, OpenRestore> = {};
  for (const row of (data ?? []) as Row[]) {
    const origin = row['origin_release_id'];
    if (typeof origin !== 'string' || typeof row['version'] !== 'number') continue;
    const entry = (out[origin] ??= { items: [], untouched: true });
    entry.items.push({ draftId: String(row['id']), draftVersion: row['version'] });
    // A change a scheduled release holds is not this restore's to publish now.
    if (
      !untouchedRestore({ origin_kind: 'restore', version: row['version'] }) ||
      typeof row['release_id'] === 'string'
    ) {
      entry.untouched = false;
    }
  }
  return out;
}

/** The page's versions card: nothing but the flag while releases are off. */
export async function loadVersionsPage(input: VersionsPageInput): Promise<VersionsPage> {
  const enabled = await releasesOn(input.sb, input.auth);
  if (!enabled) {
    return { enabled, live: null, versions: [], upcoming: [], more: false, restores: {} };
  }
  const [list, restores] = await Promise.all([
    listVersions(readerContext(input, enabled), input.before) as Promise<{
      live: number | null;
      versions: VersionSummary[];
      upcoming: VersionSummary[];
      more: boolean;
    }>,
    openRestores(input.sb, input.auth),
  ]);
  return {
    enabled,
    live: list.live,
    versions: list.versions,
    upcoming: list.upcoming,
    more: list.more,
    restores,
  };
}

/** One version's changes as R10 lists them, or null when there is no such version. */
export interface VersionDetails {
  release: VersionSummary;
  items: {
    id: number;
    entityType: string;
    entityId: string;
    op: string;
    area: string;
    label: Row | null;
    cascade: boolean;
    fields: {
      column: string;
      kind: 'text' | 'bilingual' | 'changed';
      before?: unknown;
      after?: unknown;
    }[];
  }[];
  hidden: number;
  truncated: boolean;
}

export async function loadVersionDetails(
  input: VersionsPageInput,
  id: string,
): Promise<VersionDetails | null> {
  const answer = await versionDetail(readerContext(input, true, { id }));
  return answer instanceof Response ? null : (answer as VersionDetails);
}
