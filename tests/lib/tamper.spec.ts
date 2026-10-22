import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { alterSignature } from '../admin/tamper';

// The forged token maintenance.e2e.ts sends must carry a DIFFERENT signature for the auth
// server, not only a different string. base64url's last character of a 32- or 64-byte
// signature carries 4 or 2 padding bits that a lenient decoder (golang-jwt's RawURLEncoding,
// GoTrue's) ignores: swapping 'A' for 'B' there decoded to the same bytes in about 1 run in
// 16 (HS256) or 1 in 4 (ES256), so the bypass answered 200 where the test expected the 503,
// and the retry reused the same stored token.

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const token = (signatureBytes: number) =>
  [
    b64url(Buffer.from(JSON.stringify({ alg: signatureBytes === 32 ? 'HS256' : 'ES256' }))),
    b64url(Buffer.from(JSON.stringify({ sub: 'x', exp: 2_000_000_000 }))),
    b64url(randomBytes(signatureBytes)),
  ].join('.');
/** What a lenient decoder reads: trailing bits that do not fill a byte are dropped. */
const decoded = (segment: string) => Buffer.from(segment, 'base64url');

describe('alterSignature', () => {
  it.each([32, 64])(
    'a %i-byte signature always decodes to different bytes; header and payload unchanged',
    (size) => {
      for (let i = 0; i < 2_000; i += 1) {
        const jwt = token(size);
        const forged = alterSignature(jwt);
        const [h0, p0, s0] = jwt.split('.');
        const [h1, p1, s1] = forged.split('.');
        expect([h1, p1]).toEqual([h0, p0]);
        expect(decoded(s1!).length).toBe(size);
        expect(decoded(s1!).equals(decoded(s0!)), `${s0} -> ${s1}`).toBe(false);
      }
    },
  );

  it('refuses a value that is not a three-part token', () => {
    expect(() => alterSignature('not.a-token')).toThrow();
    expect(() => alterSignature('a.b.')).toThrow();
  });
});
