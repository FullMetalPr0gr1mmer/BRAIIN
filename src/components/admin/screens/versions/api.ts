import { adminFetch } from '@/lib/admin/client';
import type { PublishResult, PurgeRetryResult, RestoreResult } from '@schemas/release';

// What Backups & versions asks the server (Admin v2 R13), behind one seam so the kit gallery
// draws the same list over made-up versions with no request at all (as R12's savebar). Every
// route decides again who may do what: the kernel's capabilities, each change's own (P-2), the
// person re-read live where it writes, RLS.

export interface DraftRef {
  draftId: string;
  draftVersion: number;
}

export interface VersionsApi {
  /** POST /api/admin/releases/[id]/restore (R10): stage the site as it was at that version. */
  restore(releaseId: string): Promise<RestoreResult>;
  /** POST /api/admin/releases with `kind: 'rollback'` (R10): publish a restore as one version. */
  publishRollback(items: readonly DraftRef[]): Promise<PublishResult>;
  /** PATCH /api/admin/releases/[id] (R11): move a scheduled release. */
  reschedule(
    releaseId: string,
    version: number,
    scheduleAt: string,
  ): Promise<{ release: { id: string; scheduledFor: string; version: number } }>;
  /** DELETE /api/admin/releases/[id]?version=n (R11): cancel it; its changes are pending again. */
  unschedule(releaseId: string, version: number): Promise<unknown>;
  /** POST /api/admin/releases/[id]/purge (R13): send a failed purge again. */
  retryPurge(releaseId: string): Promise<PurgeRetryResult>;
}

const path = (id: string) => `/api/admin/releases/${encodeURIComponent(id)}`;

export const LIVE_VERSIONS_API: VersionsApi = {
  restore: (id) => adminFetch<RestoreResult>(`${path(id)}/restore`, { method: 'POST', body: {} }),
  publishRollback: (items) =>
    adminFetch<PublishResult>('/api/admin/releases', {
      method: 'POST',
      body: { items: [...items], kind: 'rollback' },
    }),
  reschedule: (id, version, scheduleAt) =>
    adminFetch(path(id), { method: 'PATCH', body: { version, scheduleAt } }),
  unschedule: (id, version) => adminFetch(`${path(id)}?version=${version}`, { method: 'DELETE' }),
  retryPurge: (id) =>
    adminFetch<PurgeRetryResult>(`${path(id)}/purge`, { method: 'POST', body: {} }),
};
