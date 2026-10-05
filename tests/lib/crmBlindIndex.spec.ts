import { describe, it, expect } from 'vitest';
import { blindIndex } from '@/lib/crm/blindIndex';
import { limitKey } from '@/lib/http/publicRateLimit';
import { hmacHex } from '@/lib/crypto/hmac';
import { hmacHex as reExported } from '@/lib/http/publicRateLimit';

// Blind indexes (Admin v2 C1b): deterministic for one tenant and kind, different across
// tenants and kinds, and never equal to the rate limiter's keys for the same value, since
// each purpose has its own labelled key.

const KEY = 'test-root-key';
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';

describe('blindIndex', () => {
  it('is 64 hex characters and the same for the same input', async () => {
    const a = await blindIndex(KEY, 'email', T1, 'sara@example.com');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await blindIndex(KEY, 'email', T1, 'sara@example.com')).toBe(a);
  });

  it('is salted by tenant and separated by kind', async () => {
    const base = await blindIndex(KEY, 'email', T1, 'sara@example.com');
    expect(await blindIndex(KEY, 'email', T2, 'sara@example.com')).not.toBe(base);
    expect(await blindIndex(KEY, 'domain', T1, 'sara@example.com')).not.toBe(base);
  });

  it('depends on the root key', async () => {
    expect(await blindIndex('another-key', 'email', T1, 'sara@example.com')).not.toBe(
      await blindIndex(KEY, 'email', T1, 'sara@example.com'),
    );
  });

  it("never equals the rate limiter's key for the same value (separate labels)", async () => {
    expect(await blindIndex(KEY, 'email', T1, 'sara@example.com')).not.toBe(
      await limitKey(KEY, 'contact:email', 'sara@example.com'),
    );
  });

  it('hmacHex moved without changing (the old import path re-exports it)', async () => {
    expect(reExported).toBe(hmacHex);
    // RFC 4231 test case 2.
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});
