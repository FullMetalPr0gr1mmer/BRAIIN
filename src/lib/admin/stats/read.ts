import { writeSystemLog } from '@/lib/data/systemLog';
import { logSafeError } from '../globalSearch';

// What the stats and health loaders do with a read the database refused (Admin v2 U2): log
// it to system_logs, scrubbed, then throw, so a JSON route answers 500 and a server page
// shows the read failed instead of empty figures that look real.

export async function readFailed(source: string, what: string, message: string): Promise<Error> {
  await writeSystemLog({
    level: 'error',
    source,
    message: `${what} could not be read`,
    detail: { error: logSafeError(message, []) },
  });
  return new Error(`${what} could not be read`);
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
