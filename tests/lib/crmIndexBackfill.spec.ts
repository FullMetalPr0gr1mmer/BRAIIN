import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { INDEX_BATCH, newIndexRun, runLeadIndexBackfill } from '@/lib/crm/indexBackfill';
import { DAILY_JOBS } from '@/lib/cron/jobs';
import { blindIndex } from '@/lib/crm/blindIndex';
import { decryptPII, encryptPII } from '@/lib/crypto/pii';

// The daily lead indexing (Admin v2 C1b): what arrival would have computed, written per
// lead through crm_index_lead; each field decrypted on its own, so one corrupt field costs
// only its own index; a key that decrypts nothing writes nothing; an unreadable lead
// indexed with what could be read so it never blocks the queue; a failed write left for
// tomorrow; a legacy plaintext band moved into the encrypted timeline.

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

/** A lead with no ciphertext problems unless the caller says otherwise. */
async function lead(id: string, over: Record<string, unknown> = {}, key = KEY) {
  return {
    id,
    tenant_id: T1,
    email_enc: await encryptPII(`${id}@acme.sa`, key),
    phone_enc: null,
    budget_enc: null,
    timeline_text_enc: null,
    timeline_band: null,
    service_of_interest: null,
    company: null,
    ...over,
  };
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
      await lead('l1', {
        email_enc: await encryptPII('Sara@Acme.SA', KEY),
        phone_enc: await encryptPII('0501234567', KEY),
        budget_enc: await encryptPII('gt_200k', KEY),
        timeline_band: '1_3m',
        service_of_interest: 'logo',
        company: 'Acme',
      }),
    ];
    const run = await runLeadIndexBackfill(client(), KEY, 50);
    expect(run).toEqual({ scanned: 1, indexed: 1, failed: 0, unreadable: 0 });
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

  it('one corrupt field costs only its own index: the e-mail and phone are still indexed', async () => {
    rows = [
      await lead('l1', {
        email_enc: await encryptPII('sara@acme.sa', KEY),
        phone_enc: await encryptPII('0501234567', KEY),
        budget_enc: 'not-ciphertext',
      }),
    ];
    const run = await runLeadIndexBackfill(client(), KEY);
    expect(run).toEqual({ scanned: 1, indexed: 1, failed: 0, unreadable: 1 });
    expect(writes[0]).toMatchObject({
      p_email_hmac: await blindIndex(KEY, 'email', T1, 'sara@acme.sa'),
      p_phone_hmac: await blindIndex(KEY, 'phone', T1, '+966501234567'),
    });
    expect(writes[0]!['p_signals']).not.toContain('budget_given');
  });

  it('a lead nothing of which decrypts is indexed with what is known, so it never blocks the queue', async () => {
    rows = [
      await lead('bad', {
        email_enc: 'not-ciphertext',
        timeline_text_enc: 'still-encrypted',
      }),
      await lead('good'),
    ];
    const run = await runLeadIndexBackfill(client(), KEY);
    expect(run).toEqual({ scanned: 2, indexed: 2, failed: 0, unreadable: 1 });
    expect(writes[0]).toMatchObject({
      p_id: 'bad',
      p_email_hmac: null,
      p_phone_hmac: null,
      p_timeline_text_enc: null,
    });
    // The deadline's presence still counts; its words stay encrypted.
    expect(writes[0]!['p_signals']).toEqual(['timeline_given']);
  });

  it('a key that decrypts nothing in the batch writes nothing: no index, no band re-encrypted', async () => {
    rows = [
      await lead('a', { timeline_band: '3_6m' }, 'another-key'),
      await lead('b', { phone_enc: await encryptPII('0501234567', 'another-key') }, 'another-key'),
    ];
    const run = await runLeadIndexBackfill(client(), KEY);
    expect(run).toEqual({ scanned: 2, indexed: 0, failed: 0, unreadable: 0, stopped: 'key' });
    expect(writes).toEqual([]);
  });

  it('counts a failed write and carries on with the next lead', async () => {
    rows = [await lead('a'), await lead('b')];
    failIds = new Set(['a']);
    expect(await runLeadIndexBackfill(client(), KEY)).toEqual({
      scanned: 2,
      indexed: 1,
      failed: 1,
      unreadable: 0,
    });
    expect(writes.map((w) => w['p_id'])).toEqual(['a', 'b']);
  });

  it("fills in the caller's run as it goes", async () => {
    rows = [await lead('a'), await lead('b')];
    const run = newIndexRun();
    await runLeadIndexBackfill(client(), KEY, INDEX_BATCH, run);
    expect(run.indexed).toBe(2);
  });

  it('a batch fits the Free plan beside the other daily jobs (src/lib/cron/jobs.ts)', () => {
    // The indexing job's budget is the read, a country lookup, one write per lead and its
    // log line; with every other registered job's, it stays inside the 50 per invocation.
    const indexing = DAILY_JOBS.find((job) => job.name === 'crm-index');
    expect(indexing?.budget).toBe(2 + INDEX_BATCH + 2);
    expect(DAILY_JOBS.reduce((sum, job) => sum + job.budget, 0)).toBeLessThanOrEqual(50);
  });
});
