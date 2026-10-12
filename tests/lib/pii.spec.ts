import { describe, it, expect } from 'vitest';
import { encryptPII, decryptPII, importPIIKey } from '@/lib/crypto/pii';

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

  // The CSV export decrypts four fields a row and imports the key once a request (C3 review).
  it('decrypts with a key imported once, as with the material', async () => {
    const key = await importPIIKey(KEY);
    const values = ['client@example.com', '+966500000000', 'سارة', ''];
    const cts = await Promise.all(values.map((v) => encryptPII(v, KEY)));
    for (const [i, ct] of cts.entries()) {
      expect(await decryptPII(ct, key)).toBe(values[i]);
    }
    await expect(decryptPII(cts[0]!, await importPIIKey('wrong-key'))).rejects.toBeTruthy();
  });

  it('a tampered ciphertext fails to decrypt with an imported key', async () => {
    const key = await importPIIKey(KEY);
    const ct = await encryptPII('secret', KEY);
    const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptPII(tampered, key)).rejects.toBeTruthy();
  });
});
