// Authenticated encryption-at-rest for lead PII (AES-256-GCM via Web Crypto — works
// on the Cloudflare Worker and Node 20). The key is passed in (not imported) so this
// stays pure + unit-testable; callers supply LEAD_PII_ENC_KEY. A per-record random IV
// is prepended to the ciphertext. (KMS-backed envelope wrapping is a hardening
// follow-up; this is the at-rest gate of record for Phase 1.)

// One of each for the module: making them costs CPU on every call, and they hold no state.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The AES-GCM key derived from the key material: a SHA-256 of it, so any key string works.
 * Deriving and importing it costs as much CPU as a decrypt does, so a caller decrypting many
 * values (the CSV export) imports it once per request and passes the CryptoKey; a caller
 * decrypting a few passes the material and each call imports it.
 */
export async function importPIIKey(keyMaterial: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(keyMaterial));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Returns base64(iv ‖ ciphertext+tag). */
export async function encryptPII(plaintext: string, keyMaterial: string): Promise<string> {
  const key = await importPIIKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64encode(out);
}

/** Decrypts with the key material, or with a key importPIIKey already made from it. */
export async function decryptPII(payload: string, key: string | CryptoKey): Promise<string> {
  const cryptoKey = typeof key === 'string' ? await importPIIKey(key) : key;
  // Views, not copies: b64decode's array is this call's own.
  const data = b64decode(payload);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12) },
    cryptoKey,
    data.subarray(12),
  );
  return decoder.decode(pt);
}
