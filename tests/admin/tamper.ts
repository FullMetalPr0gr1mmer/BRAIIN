// A forged session for maintenance.e2e.ts (Admin v2 U9b): the same access token with its
// signature changed, so the local pre-filter (a readable, unexpired token) passes it and the
// auth server refuses it. Held by tests/lib/tamper.spec.ts.
//
// The change is made to the signature's BYTES, then encoded canonically: swapping the last
// base64url character can alter only its padding bits, which a lenient decoder (golang-jwt's
// RawURLEncoding, as GoTrue reads it) ignores, so the "altered" token verified about 1 run in
// 16 (HS256) or 1 in 4 (ES256).

/** The token with every bit of its signature's first byte flipped. Throws on a non-JWT. */
export function alterSignature(jwt: string): string {
  const parts = jwt.split('.');
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || !header || !payload || !signature) {
    throw new Error('alterSignature: not a three-part token');
  }
  const bytes = Buffer.from(signature, 'base64url');
  const altered = Buffer.from(bytes);
  altered[0] = (altered[0] ?? 0) ^ 0xff;
  if (bytes.length === 0 || altered.equals(bytes)) {
    throw new Error('alterSignature: the signature did not change');
  }
  return `${header}.${payload}.${altered.toString('base64url')}`;
}
