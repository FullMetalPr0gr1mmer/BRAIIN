// Authenticated encryption-at-rest for lead PII (AES-256-GCM via Web Crypto — works
// on the Cloudflare Worker and Node 20). The key is passed in (not imported) so this
// stays pure + unit-testable; callers supply LEAD_PII_ENC_KEY. A per-record random IV
// is prepended to the ciphertext. (KMS-backed envelope wrapping is a hardening
// follow-up; this is the at-rest gate of record for Phase 1.)

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(keyMaterial: string): Promise<CryptoKey> {
  // Derive a stable 256-bit key from the provided material so any key string works.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Returns base64(iv ‖ ciphertext+tag). */
export async function encryptPII(plaintext: string, keyMaterial: string): Promise<string> {
  const key = await importKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decryptPII(payload: string, keyMaterial: string): Promise<string> {
  const key = await importKey(keyMaterial);
  const data = b64decode(payload);
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
