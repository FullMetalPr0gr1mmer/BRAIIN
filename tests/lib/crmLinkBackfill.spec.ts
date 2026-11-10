import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LINK_BATCH, parseLinkRun, runContactLinkBackfill } from '@/lib/crm/linkBackfill';

// The daily contact linking (Admin v2 C5): one call to public.crm_link_backfill, counts back,
// nothing read or decrypted in the Worker (the database compares blind indexes and copies the
// ciphertext). A failure says its code, never the database's message, which can quote a value.

function client(answer: { data: unknown; error: { code?: string; message?: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const sb = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return answer;
    },
    from: () => {
      throw new Error('the link backfill reads no table');
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const COUNTS = { scanned: 3, email: 1, phone: 1, new: 1, skipped: 0, failed: 0 };

describe('runContactLinkBackfill', () => {
  it('makes one call, with the batch, and answers the counts', async () => {
    const { sb, calls } = client({ data: COUNTS, error: null });
    await expect(runContactLinkBackfill(sb)).resolves.toEqual(COUNTS);
    expect(calls).toEqual([{ fn: 'crm_link_backfill', args: { p_limit: LINK_BATCH } }]);
  });

  it('a refusal throws with its code only', async () => {
    const { sb } = client({
      data: null,
      error: { code: '57014', message: 'canceling statement: sara@example.test' },
    });
    await expect(runContactLinkBackfill(sb)).rejects.toThrow(/^contact link backfill: 57014$/);
  });

  it('refuses an answer of any other shape, quoting nothing of it', () => {
    for (const bad of [null, [], 'x', { ...COUNTS, failed: -1 }, { ...COUNTS, new: '1' }, {}]) {
      expect(() => parseLinkRun(bad)).toThrow(/^contact link backfill: an unexpected answer$/);
    }
  });

  it('keeps only the counts, whatever else the answer carries', () => {
    expect(parseLinkRun({ ...COUNTS, email_hmac: 'a'.repeat(64) })).toEqual(COUNTS);
  });

  it('decrypts nothing: the module imports no key and no decryption', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/crm/linkBackfill.ts'), 'utf8');
    expect(source).not.toMatch(/crypto\/pii|decryptPII|LEAD_PII_ENC_KEY|astro:env/);
  });
});
