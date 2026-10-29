import { AdminApiError, adminFetch } from '@/lib/admin/client';
import { announceDiscarded, announceSettled } from '@/lib/admin/releaseEvents';
import type {
  CompareResult,
  PublishResult,
  ReleaseCheck,
  ResolveRequest,
  ScheduleResult,
} from '@schemas/release';
import type { PendingSummary } from './model';

// What the savebar and the publish dialog ask the server (Admin v2 R12), behind one seam so
// the kit gallery (/admin/kit) can draw the same islands over made-up changes with no request
// at all. The live seam is the draft and release endpoints R3b, R6 and R12 built; every one
// decides again who may do what (the kernel's capabilities, then each change's own, then RLS).

export interface PublishSelection {
  items: { draftId: string; draftVersion: number }[];
  note?: string | undefined;
}

/** A refusal, as the dialog reads it: the status, the code, and the whole answer. */
export interface ReleaseRefusal {
  status: number;
  error: string;
  detail?: string | undefined;
  body: Readonly<Record<string, unknown>>;
}

export interface ReleaseApi {
  pending(): Promise<PendingSummary>;
  /** POST /api/admin/releases/validate: the check (and the dry run when it is clean). */
  validate(selection: PublishSelection): Promise<ReleaseCheck>;
  /** POST /api/admin/releases: publish now. */
  publish(selection: PublishSelection): Promise<PublishResult>;
  /**
   * POST /api/admin/releases with `scheduleAt` (R11): the same checks as a publish, then the
   * changes are dry-run, stored on a scheduled release and locked until it goes live.
   */
  schedule(selection: PublishSelection & { scheduleAt: string }): Promise<ScheduleResult>;
  /** POST /api/admin/drafts/discard: mine (200 a request), or the ones named. */
  discard(
    request: { scope: 'mine' } | { items: PublishSelection['items'] },
  ): Promise<{ discarded: number; more?: boolean }>;
  /** POST /api/admin/drafts/[id]/resolve. */
  resolve(
    draftId: string,
    request: Partial<ResolveRequest> & { version: number },
  ): Promise<unknown>;
  /** GET /api/admin/drafts/[id]/compare. */
  compare(draftId: string): Promise<CompareResult>;
}

/**
 * The dialog's Keep my version / Use the live version: settle the conflict, then tell an editor
 * open on this change that its version moved (R12 pre-merge review), so it reads the change
 * again, keeping what was typed, instead of meeting "Someone else saved changes" on its next
 * save. Nothing is announced when the settle is refused (it throws to the dialog).
 */
export async function settleChange(
  api: Pick<ReleaseApi, 'resolve'>,
  draftId: string,
  version: number,
  choice: 'keepMine' | 'useLive',
  columns: readonly string[],
): Promise<void> {
  await api.resolve(draftId, { version, [choice]: [...columns] });
  announceSettled(draftId);
}

/**
 * The dialog's Discard and the savebar's Discard my changes: throw the changes away, then tell
 * the page editor (E2 review), whose live preview laid them over the page and whose sections
 * still name them. Nothing is announced when the discard is refused (it throws to the caller).
 */
export async function discardChanges(
  api: Pick<ReleaseApi, 'discard'>,
  request: Parameters<ReleaseApi['discard']>[0],
): Promise<{ discarded: number; more?: boolean }> {
  const result = await api.discard(request);
  announceDiscarded();
  return result;
}

/** An AdminApiError as the dialog reads it; anything else is a refusal with no status. */
export function refusalOf(err: unknown): ReleaseRefusal {
  if (err instanceof AdminApiError) {
    return {
      status: err.info.status,
      error: err.info.error,
      detail: err.info.detail,
      body: err.body,
    };
  }
  return {
    status: 0,
    error: 'network',
    detail: err instanceof Error ? err.message : undefined,
    body: {},
  };
}

/** The endpoints themselves. */
export const LIVE_RELEASE_API: ReleaseApi = {
  pending: () => adminFetch<PendingSummary>('/api/admin/releases/pending'),
  validate: (selection) =>
    adminFetch<ReleaseCheck>('/api/admin/releases/validate', {
      method: 'POST',
      body: selection,
    }),
  publish: (selection) =>
    adminFetch<PublishResult>('/api/admin/releases', { method: 'POST', body: selection }),
  schedule: (selection) =>
    adminFetch<ScheduleResult>('/api/admin/releases', { method: 'POST', body: selection }),
  discard: (request) =>
    adminFetch<{ discarded: number; more?: boolean }>('/api/admin/drafts/discard', {
      method: 'POST',
      body: request,
    }),
  resolve: (draftId, request) =>
    adminFetch(`/api/admin/drafts/${encodeURIComponent(draftId)}/resolve`, {
      method: 'POST',
      body: request,
    }),
  compare: (draftId) =>
    adminFetch<CompareResult>(`/api/admin/drafts/${encodeURIComponent(draftId)}/compare`),
};
