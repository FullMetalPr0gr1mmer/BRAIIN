import type { SupabaseClient } from '@supabase/supabase-js';
import { RATE_LIMIT_LABEL, labelledKeyMaterial } from '@/lib/applications/keys';

// The public write limiter (EXC-004): counters in Postgres (`public_write_attempts`,
// migration 0029), one row per (scope, hashed key, fixed window), bumped atomically by
// `public.public_write_hit()`.
//
// Why Postgres and not memory: the Worker runs as many short-lived isolates, so an
// in-memory counter resets itself into uselessness under exactly the load it should bound
// (the same reason the admin's `privileged_ops` ledger exists). Why not the Workers Rate
// Limiting binding: it is a second ring EXC-004 named, not available to verify here; this
// one ring is the authoritative count, and the WAF ring arrives with the zone (KAN-20).
//
// The key is an HMAC of the address or e-mail under a labelled derivation of
// LEAD_PII_ENC_KEY, so the table never holds a raw IP or address and a leaked table cannot
// be reversed by guessing.
//
// Callers choose what an unreachable limiter means: the apply path fails CLOSED (an
// unbounded file-upload endpoint is the risk EXC-004 exists for); the contact form fails
// OPEN (losing a lead is worse than one unthrottled minute).

export interface PublicLimitRule {
  /** e.g. `apply:ip`, `apply:email`, `contact:ip`. */
  scope: string;
  /** The value being counted (an IP, an e-mail). Hashed before it leaves the Worker. */
  value: string;
  max: number;
  windowSeconds: number;
}

export type LimitOutcome = 'ok' | 'limited' | 'unavailable';

export const APPLY_LIMITS = {
  perIp: { max: 5, windowSeconds: 3600 },
  perEmail: { max: 3, windowSeconds: 86_400 },
} as const;
export const CONTACT_LIMITS = { perIp: { max: 10, windowSeconds: 3600 } } as const;

const enc = new TextEncoder();

/** HMAC-SHA-256(key, message) as 64 lowercase hex characters. */
export async function hmacHex(keyMaterial: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let hex = '';
  for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** The stored key for a rule: never the raw value. */
export function limitKey(rootKey: string, scope: string, value: string): Promise<string> {
  return hmacHex(
    labelledKeyMaterial(rootKey, RATE_LIMIT_LABEL),
    `${scope}\u0000${value.trim().toLowerCase()}`,
  );
}

/**
 * Counts one attempt against every rule and reports the worst outcome. Every rule is
 * counted even when an earlier one is already over (an attacker rotating addresses still
 * fills the per-e-mail window).
 */
export async function checkPublicLimits(
  sb: SupabaseClient,
  tenantId: string,
  rootKey: string,
  rules: readonly PublicLimitRule[],
): Promise<LimitOutcome> {
  let outcome: LimitOutcome = 'ok';
  for (const rule of rules) {
    try {
      const { data, error } = await sb.rpc('public_write_hit', {
        p_tenant: tenantId,
        p_scope: rule.scope,
        p_key_hash: await limitKey(rootKey, rule.scope, rule.value),
        p_window_seconds: rule.windowSeconds,
      });
      if (error || typeof data !== 'number') return 'unavailable';
      if (data > rule.max) outcome = 'limited';
    } catch {
      return 'unavailable';
    }
  }
  return outcome;
}
