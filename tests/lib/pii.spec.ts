import { describe, it, expect } from 'vitest';
import { encryptPII, decryptPII } from '@/lib/crypto/pii';

const KEY = 'test-master-key-please-rotate';

describe('PII envelope encryption (AES-256-GCM)', () => {
  it('round-trips plaintext', async () => {
    const ct = await encryptPII('client@example.com', KEY);
    expect(ct).not.toContain('client@example.com');
    expect(await decryptPII(ct, KEY)).toBe('client@example.com');
  });

  it('uses a random IV (ciphertext differs each time)', async () => {
    const a = await encryptPII('same', KEY);
    const b = await encryptPII('same', KEY);
    expect(a).not.toBe(b);
    expect(await decryptPII(a, KEY)).toBe('same');
    expect(await decryptPII(b, KEY)).toBe('same');
  });

  it('fails to decrypt with the wrong key', async () => {
    const ct = await encryptPII('secret', KEY);
    await expect(decryptPII(ct, 'wrong-key')).rejects.toBeTruthy();
  });
});
