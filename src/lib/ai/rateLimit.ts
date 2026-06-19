// AI Style-Finder rate limiting (CLAUDE.md §3 Pillar 1 — server-side proxy guardrails,
// enforced BEFORE any token spend, even at the 501 stub). Pure + store-injectable so the
// limits are unit-tested now; the production store swaps to Cloudflare KV/DO at
// provisioning (KAN-20) without touching this logic or the endpoint.

export const HOUR_MS = 3_600_000;
export const AI_IP_LIMIT = 60; // per-IP / hour (CLAUDE.md: 60/hr/IP, NOT 10/60s)
export const AI_SESSION_LIMIT = 20; // per-session / hour (Worker-level, before token spend)

export interface RateStore {
  /** Increment the counter for `key` within a `windowMs` window; return the new count. */
  hit(key: string, windowMs: number): Promise<number>;
}

/** Per-isolate in-memory store — a PLACEHOLDER for the stub. Not durable across isolates;
 *  swapped for a KV/DO-backed store at provisioning (KAN-20). Clock is injectable for tests. */
export class MemoryRateStore implements RateStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async hit(key: string, windowMs: number): Promise<number> {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b || t >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: t + windowMs });
      return 1;
    }
    b.count += 1;
    return b.count;
  }
}

export interface RateRule {
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateResult {
  ok: boolean;
  blocked: string | null; // the rule key that blocked, or null
}

/** Evaluate rules in order, short-circuiting on the first breach. A breaching request
 *  still counts against that rule's window (standard fixed-window behaviour). */
export async function checkRateLimits(store: RateStore, rules: RateRule[]): Promise<RateResult> {
  for (const r of rules) {
    const count = await store.hit(r.key, r.windowMs);
    if (count > r.limit) return { ok: false, blocked: r.key };
  }
  return { ok: true, blocked: null };
}

/** The Style-Finder rule set: per-session (tighter) then per-IP. */
export function styleFinderRules(ip: string, sessionId: string): RateRule[] {
  return [
    { key: `sf:session:${sessionId}`, limit: AI_SESSION_LIMIT, windowMs: HOUR_MS },
    { key: `sf:ip:${ip}`, limit: AI_IP_LIMIT, windowMs: HOUR_MS },
  ];
}
