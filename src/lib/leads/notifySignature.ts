import { hmacHex } from '@/lib/crypto/hmac';
import { timingSafeEqual } from '@/lib/http/csrf';

// The lead-notification signature (CLAUDE.md §10, migration 0048). The leads_notify trigger
// signs each call it queues instead of carrying a bearer token, because on Supabase every
// login role may read pg_net's queue (EXC-012) and a token there would be anyone's:
//
//   X-Braiin-Timestamp: <unix seconds when the lead was saved>
//   X-Braiin-Signature: v1=<hex HMAC-SHA-256 under the shared secret of '<ts>.<lead_id>.<tenant_id>'>
//
// The shared secret is the Vault secret notify_lead_secret on the database side and the
// Worker secret NOTIFY_LEAD_SECRET here, the same value. The canonical string is signed,
// not the JSON body, so no serializer on either side can break it; the ids are the
// lowercase text Postgres prints for a uuid, which is what the trigger's body carries. A
// queued request is then good for one lead within the window below, and replaying it only
// announces that lead again.

/** How far the signed timestamp may be from this Worker's clock, either way, in seconds. */
export const NOTIFY_SIGNATURE_WINDOW_S = 300;

/** A shorter secret never verifies: an unset or truncated secret must not become a key (the
 * runbook makes it 64 hex characters). */
export const NOTIFY_SECRET_MIN_LENGTH = 16;

export const NOTIFY_TIMESTAMP_HEADER = 'x-braiin-timestamp';
export const NOTIFY_SIGNATURE_HEADER = 'x-braiin-signature';

/** The string the trigger signs. */
export function notifySignedString(ts: string, leadId: string, tenantId: string): string {
  return `${ts}.${leadId}.${tenantId}`;
}

/** `v1=<hex HMAC-SHA-256>`, exactly as 0048 computes it with pgcrypto's hmac. */
export async function notifySignature(
  secret: string,
  ts: string,
  leadId: string,
  tenantId: string,
): Promise<string> {
  return `v1=${await hmacHex(secret, notifySignedString(ts, leadId, tenantId))}`;
}

/**
 * The two headers, well formed and inside the window, or null. Checked before the body is
 * read, so an unsigned or stale call makes the Worker parse nothing.
 */
export function readNotifyHeaders(
  headers: Headers,
  nowMs: number,
): { ts: string; signature: string } | null {
  const ts = headers.get(NOTIFY_TIMESTAMP_HEADER);
  const signature = headers.get(NOTIFY_SIGNATURE_HEADER);
  if (ts === null || signature === null) return null;
  if (!/^[0-9]{1,12}$/.test(ts) || !/^v1=[0-9a-f]{64}$/.test(signature)) return null;
  if (Math.abs(nowMs / 1000 - Number(ts)) > NOTIFY_SIGNATURE_WINDOW_S) return null;
  return { ts, signature };
}

/** Whether `signature` signs these ids at `ts` under `secret`, compared in constant time. */
export async function notifySignatureValid(
  secret: string,
  ts: string,
  signature: string,
  leadId: string,
  tenantId: string,
): Promise<boolean> {
  if (secret.length < NOTIFY_SECRET_MIN_LENGTH) return false;
  return timingSafeEqual(await notifySignature(secret, ts, leadId, tenantId), signature);
}
