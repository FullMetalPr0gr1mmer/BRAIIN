import { z } from 'zod';

// The access token's own claims (Admin v2 U12a), read by resolveAuthContext.
//
// What this is NOT: a signature check. It decodes the payload of a token that the auth
// server verified in the same request (`getUser(token)` answered with this token's user),
// so the claims are the auth server's own words. A token nobody verified must never reach
// this module's callers as anything but a string; resolveAuthContext only calls it after
// getUser has answered for exactly that token.
//
// Why the claims, and not getUser()'s user record: RLS reads the role from the token, and
// a token keeps the role it was minted with for up to an hour. getUser() returns the
// account as it is NOW (its app_metadata, which the users screen rewrites together with the
// profile), so comparing the profile with it could never see a stale token. The claims can.
//
// LENIENT BY DESIGN, because a mistake here signs everyone out on every request: only `sub`
// and `exp` are required. The role and tenant are read as unknown (the caller decides what
// a missing role means). `amr` (the sign-in methods and their times) is read entry by entry:
// an entry without a numeric time contributes nothing, and an `amr` that is absent or not a
// list is reported as null, which the caller treats as "no age check", never as a refusal.

/** One sign-in method the token records: GoTrue writes `{ method, timestamp }` (seconds). */
export interface AmrEntry {
  method: string;
  /** Seconds since the epoch, or null when the entry carries none (RFC 8176's bare string). */
  timestamp: number | null;
}

export interface AccessClaims {
  /** The user's id. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** GoTrue's session id, when the token names one. */
  sessionId: string | null;
  /** `app_metadata.role` as the token carries it (the access-token hook's stamp), unvalidated. */
  role: unknown;
  /** `app_metadata.tenant_id` as the token carries it, unvalidated. */
  tenantId: unknown;
  /** The sign-in methods, or null when the token has no list of them. */
  amr: readonly AmrEntry[] | null;
}

const PayloadSchema = z
  .object({
    sub: z.string().min(1),
    exp: z.number().finite(),
    session_id: z.string().optional(),
    app_metadata: z.record(z.string(), z.unknown()).optional(),
    amr: z.unknown().optional(),
  })
  .passthrough();

const AmrObjectSchema = z
  .object({ method: z.string(), timestamp: z.number().finite().optional() })
  .passthrough();

/** A JWT's payload, decoded from base64url and parsed as JSON; null for anything else. */
export function decodeJwtPayload(token: string): unknown {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const segment = parts[1] ?? '';
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    // `fatal`: a payload that is not UTF-8 is not a token GoTrue wrote.
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** The sign-in methods a token's `amr` lists, read entry by entry; null when it lists none. */
function amrEntries(raw: unknown): AmrEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: AmrEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      entries.push({ method: item, timestamp: null });
      continue;
    }
    const parsed = AmrObjectSchema.safeParse(item);
    if (parsed.success) {
      entries.push({ method: parsed.data.method, timestamp: parsed.data.timestamp ?? null });
    }
  }
  return entries;
}

/** The claims of an access token the auth server has verified in this request, or null. */
export function accessClaims(token: string): AccessClaims | null {
  const parsed = PayloadSchema.safeParse(decodeJwtPayload(token));
  if (!parsed.success) return null;
  const { sub, exp, session_id: sessionId, app_metadata: meta, amr } = parsed.data;
  return {
    sub,
    exp,
    sessionId: sessionId ?? null,
    role: meta?.['role'],
    tenantId: meta?.['tenant_id'],
    amr: amrEntries(amr),
  };
}

/**
 * When the person last proved who they are, in seconds: the newest time the token's `amr`
 * records (a password sign-in, later a second factor). Null when it records none, which the
 * caller treats as "no age check". The newest, not the oldest, so a check never ends a
 * session earlier than the most recent sign-in would.
 */
export function signedInAt(claims: Pick<AccessClaims, 'amr'>): number | null {
  if (!claims.amr) return null;
  let newest: number | null = null;
  for (const entry of claims.amr) {
    if (entry.timestamp !== null && (newest === null || entry.timestamp > newest)) {
      newest = entry.timestamp;
    }
  }
  return newest;
}
