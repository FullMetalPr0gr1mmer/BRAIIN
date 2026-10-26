import type { ReleaseFailureCode } from '@schemas/release';

// Why a scheduled release could not go live, in words (Admin v2 R11): the bell's line and, from
// R13, the versions page's "Couldn't publish on {date}: {reason}". Pure (client-safe). The
// failure itself is a code on the release (`content_releases.failure`), never a message, so
// these are the only words a failure ever has. P-12: plain, warm, no dashes. Every code has its
// line (tests/lib/releaseSchedule.spec.ts).

export const RELEASE_FAILURE_COPY: Readonly<Record<ReleaseFailureCode, string>> = {
  scheduler: 'The person who scheduled it can no longer publish.',
  forbidden: 'The role of the person who scheduled it can no longer publish all of it.',
  changed: 'One of its changes is not as it was when it was scheduled.',
  conflict: 'The live site changed under one of its changes.',
  refused: 'The site refused one of its changes.',
  'releases-off': 'Publishing was switched off.',
  error: 'Something went wrong while it was going live.',
};

/** The line for a stored failure code; an unknown one reads as `error`. */
export function failureWords(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(RELEASE_FAILURE_COPY, code)
    ? RELEASE_FAILURE_COPY[code as ReleaseFailureCode]
    : RELEASE_FAILURE_COPY.error;
}

/** What follows any failure: its changes are pending again, for someone to publish. */
export const FAILURE_NEXT = 'Its changes are waiting to be published again.';
