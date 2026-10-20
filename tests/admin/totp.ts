import { createHmac } from 'node:crypto';

// A test's authenticator app (Admin v2 U17): RFC 6238 TOTP as GoTrue checks it (SHA-1,
// 30-second steps, 6 digits) from the base32 key /admin/2fa shows. node:crypto only: no new
// dependency. Held to the RFC's own vectors by tests/lib/totp.spec.ts.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, spaces and padding ignored, any case. */
export function base32Bytes(key: string): Buffer {
  const clean = key.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for a moment (ms since the epoch), `digits` long. */
export function totp(key: string, at: number = Date.now(), digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', base32Bytes(key)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Milliseconds until the next 30-second step starts. */
export function untilNextStep(at: number = Date.now()): number {
  return 30_000 - (at % 30_000);
}
