// HMAC-SHA-256 as lowercase hex: the one keyed hash the Worker computes. The public write
// limiter (src/lib/http/publicRateLimit.ts) and the CRM blind indexes
// (src/lib/crm/blindIndex.ts) both call it, each under its own labelled derivation of
// LEAD_PII_ENC_KEY (src/lib/applications/keys.ts), so neither can stand in for the other.

const enc = new TextEncoder();

/** HMAC-SHA-256(key, message) as 64 lowercase hex characters. */
export async function hmacHex(keyMaterial: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let hex = '';
  for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return hex;
}
