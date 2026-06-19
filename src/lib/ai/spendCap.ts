// AI daily USD spend cap (CLAUDE.md §3 Pillar 1 — "daily USD spend cap in DO + alert";
// breaker-open → cached/rule-based path). Pure + store-injectable: checked BEFORE any model
// call so a runaway can't burn budget. At the 501 stub no spend is recorded, so this always
// passes — but the gate exists and is tested. Production store = Cloudflare DO (KAN-20).

export const AI_DAILY_USD_CAP = 25; // placeholder ceiling; tuned with the alert at provisioning

export interface SpendStore {
  /** USD spent so far in the current UTC day for `key` (e.g. tenant or global). */
  spentTodayUsd(key: string): Promise<number>;
}

export interface SpendResult {
  ok: boolean;
  spent: number;
  cap: number;
}

export async function underSpendCap(
  store: SpendStore,
  key: string,
  capUsd: number = AI_DAILY_USD_CAP,
): Promise<SpendResult> {
  const spent = await store.spentTodayUsd(key);
  return { ok: spent < capUsd, spent, cap: capUsd };
}

/** Stub store: nothing is spent at the 501 boundary. Swapped for the DO-backed store
 *  (with the spend alert) at provisioning. */
export class ZeroSpendStore implements SpendStore {
  async spentTodayUsd(): Promise<number> {
    return 0;
  }
}
