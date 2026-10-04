import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runLeadIndexBackfill } from '@/lib/crm/indexBackfill';
import { blindIndex } from '@/lib/crm/blindIndex';
import { decryptPII, encryptPII } from '@/lib/crypto/pii';

// The daily lead indexing (Admin v2 C1b): what arrival would have computed, written per
// lead through crm_index_lead; an undecryptable lead indexed as empty so it never blocks
// the queue; a failed write left for tomorrow; a legacy plaintext band moved into the
// encrypted timeline.

const KEY = 'test-root-key';
const T1 = '00000000-0000-4000-8000-000000000001';

let rows: Record<string, unknown>[] = [];
let failIds = new Set<string>();
const writes: Record<string, unknown>[] = [];
let selectFilter: { is?: [string, unknown]; limit?: number } = {};

function client(): SupabaseClient {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = () => b;
      b['order'] = () => b;
      b['is'] = (column: string, value: unknown) => {
        selectFilter.is = [column, value];
        return b;
      };
      b['limit'] = async (n: number) => {
        selectFilter.limit = n;
        return { data: rows, error: null };
      };
      b['maybeSingle'] = async () => ({
        data: table === 'site_profile' ? { address_country: 'SA' } : null,
        error: null,
      });
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      writes.push({ fn, ...args });
      return { data: true, error: failIds.has(args['p_id'] as string) ? { code: '57014' } : null };
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  rows = [];
  failIds = new Set();
  writes.length = 0;
  selectFilter = {};
});

describe('runLeadIndexBackfill', () => {
  it('indexes the oldest unindexed leads, as arrival would have', async () => {
    rows = [
      {
        id: 'l1',
        tenant_id: T1,
        email_enc: await encryptPII('Sara@Acme.SA', KEY),
        phone_enc: await encryptPII('0501234567', KEY),
        budget_enc: await encryptPII('gt_200k', KEY),
        timeline_text_enc: null,
        timeline_band: '1_3m',
        service_of_interest: 'logo',
        company: 'Acme',
      },
    ];
    const run = await runLeadIndexBackfill(client(), KEY, 50);
    expect(run).toEqual({ scanned: 1, indexed: 1, failed: 0 });
    expect(selectFilter).toEqual({ is: ['crm_indexed_at', null], limit: 50 });
    const write = writes[0]!;
    expect(write['fn']).toBe('crm_index_lead');
    expect(write['p_email_hmac']).toBe(await blindIndex(KEY, 'email', T1, 'sara@acme.sa'));
    expect(write['p_phone_hmac']).toBe(await blindIndex(KEY, 'phone', T1, '+966501234567'));
    expect((write['p_signals'] as string[]).sort()).toEqual([
      'budget_200k_plus',
      'budget_given',
      'company_email',
      'company_named',
      'named_service',
      'timeline_given',
    ]);
    // The legacy band leaves as its words, encrypted.
    expect(await decryptPII(write['p_timeline_text_enc'] as string, KEY)).toBe(
      'In 1 to 3 months (legacy band)',
    );
  });

  it('indexes an undecryptable lead as empty, so it never blocks the queue', async () => {
    rows = [
      {
        id: 'bad',
        tenant_id: T1,
        email_enc: 'not-ciphertext',
        phone_enc: null,
        budget_enc: null,
        timeline_text_enc: 'still-encrypted',
        timeline_band: null,
        service_of_interest: null,
        company: null,
      },
    ];
    const run = await runLeadIndexBackfill(client(), KEY);
    expect(run.indexed).toBe(1);
    expect(writes[0]).toMatchObject({
      p_email_hmac: null,
      p_phone_hmac: null,
      p_timeline_text_enc: null,
    });
    // The deadline's presence still counts; its words stay encrypted.
    expect(writes[0]!['p_signals']).toEqual(['timeline_given']);
  });

  it('counts a failed write and carries on with the next lead', async () => {
    const lead = (id: string) => ({
      id,
      tenant_id: T1,
      email_enc: null,
      phone_enc: null,
      budget_enc: null,
      timeline_text_enc: null,
      timeline_band: null,
      service_of_interest: null,
      company: null,
    });
    rows = [lead('a'), lead('b')];
    failIds = new Set(['a']);
    expect(await runLeadIndexBackfill(client(), KEY)).toEqual({
      scanned: 2,
      indexed: 1,
      failed: 1,
    });
    expect(writes.map((w) => w['p_id'])).toEqual(['a', 'b']);
  });
});
