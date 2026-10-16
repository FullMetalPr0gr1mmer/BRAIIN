import { writeSystemLog } from '@/lib/data/systemLog';
import { scrubPii } from '@/lib/log/scrub';
import { ValidationError } from '../errors';
import { offsetOf } from '../pager';

// What the stats and health loaders do with a read the database refused (Admin v2 U2): log
// it to system_logs, scrubbed, then throw, so a JSON route answers 500 and a server page
// shows the read failed instead of empty figures that look real.

export async function readFailed(source: string, what: string, message: string): Promise<Error> {
  await writeSystemLog({
    level: 'error',
    source,
    message: `${what} could not be read`,
    detail: { error: scrubPii(message) },
  });
  return new Error(`${what} could not be read`);
}

/**
 * The furthest offset a stats or health list reads: pageview_paths' own bound (0052). A page
 * past it is clamped here, so a crafted `?page=` never reaches the database as a refusal;
 * a list that long reads its last page instead.
 */
export const MAX_OFFSET = 100_000;

/** The offset of a 1-based page, clamped to MAX_OFFSET. */
export function boundedOffset(page: number): number {
  return Math.min(offsetOf(page), MAX_OFFSET);
}

/** A reader's own bound refusals (22023 a value out of range, 22003 one out of its type). */
const BOUND_CODES = new Set(['22023', '22003']);

/**
 * What a reader's error becomes. A bound refusal is the request's fault, not the site's: a
 * 422 for a route, never a system_logs row (a staff member could otherwise write error rows,
 * and flip site health's errors check, at will). Anything else is logged, as readFailed.
 */
export async function readError(
  source: string,
  what: string,
  error: { code?: string | undefined; message: string },
): Promise<Error> {
  if (error.code && BOUND_CODES.has(error.code)) {
    return new ValidationError(`${what}: a bound is out of range`);
  }
  return readFailed(source, what, error.message);
}

/** A count from a JSON number or numeric string; anything else is 0. */
export function count(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** An array field of an RPC's JSON answer, or none. */
export function list(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : [];
}

/** An object answer, or an empty one (the authz harness's stub answers null). */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
