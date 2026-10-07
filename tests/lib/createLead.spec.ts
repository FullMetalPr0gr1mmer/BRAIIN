import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The public lead path since 0035 (Admin v2 C1b): one RPC with the Worker's own id,
// blind indexes and signals computed before encryption, nothing in the clear; and the
// fail-open fallback taken ONLY when the RPC itself is unavailable, so a real refusal is
// never hidden behind a second write.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const rpcs: { fn: string; args: { p_tenant: string; p_lead: Record<string, unknown> } }[] = [];
const inserts: Record<string, unknown>[] = [];
const logs: { level: string; message: string }[] = [];
let rpcError: { code?: string; message?: string } | null = null;
let insertError: { code?: string } | null = null;
let country = 'SA';
let countryFails = false;

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: { p_tenant: string; p_lead: Record<string, unknown> }) => {
      rpcs.push({ fn, args });
      return { data: null, error: rpcError };
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['maybeSingle'] = async () => {
        if (countryFails) throw new Error('site_profile unreachable');
        return {
          data: table === 'site_profile' ? { address_country: country } : null,
          error: null,
        };
      };
      b['insert'] = async (row: Record<string, unknown>) => {
        inserts.push(row);
        return { error: insertError };
      };
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/tenant', () => ({ resolveLaunchTenantId: async () => TENANT }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: { level: string; message: string }) => {
    logs.push(entry);
    return true;
  },
}));

const { createLead, isRpcUnavailable } = await import('@/lib/data/leads');
const { LeadInputSchema } = await import('@schemas/lead');
const { decryptPII } = await import('@/lib/crypto/pii');
const { blindIndex } = await import('@/lib/crm/blindIndex');
const { LEAD_PII_ENC_KEY } = await import('astro:env/server');

const input = (over: Record<string, unknown> = {}) =>
  LeadInputSchema.parse({
    name: 'Sara',
    email: 'Sara@Acme.SA',
    phone: '050 123 4567',
    message: 'We need a logo.',
    company: 'Acme',
    serviceOfInterest: 'logo',
    budgetBand: 'gt_200k',
    timelineText: 'Before Ramadan',
    ...over,
  });

beforeEach(() => {
  rpcs.length = 0;
  inserts.length = 0;
  logs.length = 0;
  rpcError = null;
  insertError = null;
  country = 'SA';
  countryFails = false;
});

/** crm_ingest_lead's allow-list, read from the migration: a key outside it is a 22023. */
const INGEST_KEYS = (() => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0035_crm_ingest.sql'),
    'utf8',
  );
  const list = /\bk not in \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
})();

describe('the payload keeps to the RPC allow-list (0035)', () => {
  it('every key createLead sends is one crm_ingest_lead accepts', async () => {
    expect(INGEST_KEYS.length).toBeGreaterThan(10);
    await createLead(input());
    const keys = Object.keys(rpcs[0]!.args.p_lead);
    for (const key of keys) expect(INGEST_KEYS, key).toContain(key);
    expect(keys).toEqual(expect.arrayContaining(['score_signals', 'email_hmac', 'phone_hmac']));
  });

  it('when the indexes cannot be computed, the lead still goes, without the signals', async () => {
    // No signals is how the RPC knows to leave crm_indexed_at null for the daily cron.
    countryFails = true;
    expect(await createLead(input())).toEqual({ ok: true });
    const keys = Object.keys(rpcs[0]!.args.p_lead);
    for (const key of keys) expect(INGEST_KEYS, key).toContain(key);
    expect(keys).not.toContain('score_signals');
  });
});

describe('a lead arrives through crm_ingest_lead', () => {
  it("sends the Worker's id, the indexes and the signals, and nothing in the clear", async () => {
    expect(await createLead(input())).toEqual({ ok: true });
    expect(rpcs).toHaveLength(1);
    const { fn, args } = rpcs[0]!;
    expect(fn).toBe('crm_ingest_lead');
    expect(args.p_tenant).toBe(TENANT);
    const lead = args.p_lead;
    expect(lead['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(lead['source']).toBe('web_form');
    expect(lead['email_hmac']).toBe(
      await blindIndex(LEAD_PII_ENC_KEY, 'email', TENANT, 'sara@acme.sa'),
    );
    expect(lead['phone_hmac']).toBe(
      await blindIndex(LEAD_PII_ENC_KEY, 'phone', TENANT, '+966501234567'),
    );
    expect((lead['score_signals'] as string[]).sort()).toEqual([
      'budget_200k_plus',
      'budget_given',
      'company_email',
      'company_named',
      'named_service',
      'timeline_given',
    ]);
    const flat = JSON.stringify(lead);
    for (const plain of [
      'Sara@Acme.SA',
      'sara@acme.sa',
      '050 123 4567',
      'gt_200k',
      'Before Ramadan',
    ]) {
      expect(flat, plain).not.toContain(plain);
    }
    expect(await decryptPII(lead['email_enc'] as string, LEAD_PII_ENC_KEY)).toBe('Sara@Acme.SA');
    expect(inserts).toHaveLength(0);
  });

  it('stores a legacy timeline band as its words, encrypted; never plaintext timeline_band', async () => {
    await createLead(input({ timelineText: undefined, timelineBand: '3_6m' }));
    const lead = rpcs[0]!.args.p_lead;
    expect(lead).not.toHaveProperty('timeline_band');
    expect(await decryptPII(lead['timeline_text_enc'] as string, LEAD_PII_ENC_KEY)).toBe(
      'In 3 to 6 months (legacy band)',
    );
  });

  it('a phone that will not normalise is stored, unindexed', async () => {
    await createLead(input({ phone: 'ext. 12' }));
    const lead = rpcs[0]!.args.p_lead;
    expect(lead['phone_hmac']).toBeNull();
    expect(lead['phone_enc']).toEqual(expect.any(String));
  });
});

describe('the fallback (the contact form fails open)', () => {
  it('only an unavailable RPC counts: missing function, or no answer at all', () => {
    expect(isRpcUnavailable({ code: 'PGRST202' })).toBe(true);
    expect(isRpcUnavailable({ code: '42883' })).toBe(true);
    expect(isRpcUnavailable({ message: 'TypeError: fetch failed' })).toBe(true);
    expect(isRpcUnavailable({ code: '23514' })).toBe(false);
    expect(isRpcUnavailable({ code: '22023' })).toBe(false);
  });

  it('writes the plain insert with the SAME id when the RPC is missing', async () => {
    rpcError = { code: 'PGRST202' };
    expect(await createLead(input())).toEqual({ ok: true });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    expect(row['id']).toBe(rpcs[0]!.args.p_lead['id']);
    expect(row['tenant_id']).toBe(TENANT);
    // The pre-0035 shape: none of the new columns, so it works before the migration too.
    for (const key of ['email_hmac', 'phone_hmac', 'score_signals', 'source', 'timeline_band']) {
      expect(row, key).not.toHaveProperty(key);
    }
    expect(logs.at(-1)!.level).toBe('warn');
  });

  it('a duplicate id on the fallback means the RPC did commit: success, one lead', async () => {
    rpcError = { message: 'TypeError: fetch failed' };
    insertError = { code: '23505' };
    expect(await createLead(input())).toEqual({ ok: true });
  });

  it('a real refusal is reported, never retried as an insert', async () => {
    rpcError = { code: '23514', message: 'violates check constraint' };
    expect(await createLead(input())).toEqual({ ok: false, reason: 'insert-failed' });
    expect(inserts).toHaveLength(0);
    expect(logs.at(-1)!.level).toBe('error');
    expect(JSON.stringify(logs)).not.toContain('Sara');
  });

  it('a failed fallback insert is a failure', async () => {
    rpcError = { code: '42883' };
    insertError = { code: '23514' };
    expect(await createLead(input())).toEqual({ ok: false, reason: 'insert-failed' });
  });
});
