import { describe, expect, it } from 'vitest';
import { accessClaims, decodeJwtPayload, signedInAt } from '@/lib/auth/claims';

// The access token's claims (Admin v2 U12a, src/lib/auth/claims.ts). Lenient by design: only
// `sub` and `exp` are required, so a change in what GoTrue writes elsewhere in the token
// cannot sign everyone out; `amr` is read entry by entry.

const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const token = (payload: unknown) =>
  `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;

const BASE = {
  sub: '11111111-1111-4111-8111-111111111111',
  exp: 1_800_000_000,
  session_id: '22222222-2222-4222-8222-222222222222',
  app_metadata: {
    role: 'seo',
    tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    provider: 'email',
  },
  amr: [{ method: 'password', timestamp: 1_799_990_000 }],
};

describe('decodeJwtPayload', () => {
  it('decodes base64url with and without padding, and UTF-8 text', () => {
    for (const name of ['a', 'ab', 'abc', 'سارة', 'Zoë 🚀']) {
      expect(decodeJwtPayload(token({ name }))).toEqual({ name });
    }
  });

  it.each([
    ['an empty string', ''],
    ['one segment', 'abc'],
    ['two segments', 'a.b'],
    ['four segments', 'a.b.c.d'],
    ['an empty payload', 'a..c'],
    ['standard base64 characters', `a.${Buffer.from('{"a":1}').toString('base64')}+/.c`],
    ['not JSON', `a.${b64url('{nope')}.c`],
    ['bytes that are not UTF-8', `a.${Buffer.from([0xff, 0xfe, 0x7b]).toString('base64url')}.c`],
  ])('answers null for %s', (_label, raw) => {
    expect(decodeJwtPayload(raw)).toBeNull();
  });

  it('answers null, never throws, for a value that is not a string', () => {
    expect(decodeJwtPayload(42 as unknown as string)).toBeNull();
    expect(decodeJwtPayload(undefined as unknown as string)).toBeNull();
  });
});

describe('accessClaims', () => {
  it('reads sub, exp, the session, the role and tenant, and the sign-in methods', () => {
    expect(accessClaims(token(BASE))).toEqual({
      sub: BASE.sub,
      exp: BASE.exp,
      sessionId: BASE.session_id,
      role: 'seo',
      tenantId: BASE.app_metadata.tenant_id,
      amr: [{ method: 'password', timestamp: 1_799_990_000 }],
      aal: null,
    });
  });

  it('reads the assurance level: aal1, aal2, and null for anything else (U17)', () => {
    expect(accessClaims(token({ ...BASE, aal: 'aal1' }))?.aal).toBe('aal1');
    expect(accessClaims(token({ ...BASE, aal: 'aal2' }))?.aal).toBe('aal2');
    // Missing or junk never fails the token: it only counts as below aal2.
    expect(accessClaims(token(BASE))?.aal).toBeNull();
    for (const junk of ['aal3', 'AAL2', '', 2, null, ['aal2'], { aal: 'aal2' }]) {
      const claims = accessClaims(token({ ...BASE, aal: junk }));
      expect(claims).not.toBeNull();
      expect(claims?.aal).toBeNull();
    }
  });

  it.each([
    ['no sub', { ...BASE, sub: undefined }],
    ['an empty sub', { ...BASE, sub: '' }],
    ['a numeric sub', { ...BASE, sub: 7 }],
    ['no exp', { ...BASE, exp: undefined }],
    ['an exp in text', { ...BASE, exp: '1800000000' }],
    ['a payload that is a list', [BASE]],
    ['a payload that is null', null],
  ])('refuses a token with %s', (_label, payload) => {
    expect(accessClaims(token(payload))).toBeNull();
  });

  it('keeps a token whose other claims are missing or odd (lenient)', () => {
    const minimal = accessClaims(token({ sub: BASE.sub, exp: BASE.exp }));
    expect(minimal).toEqual({
      sub: BASE.sub,
      exp: BASE.exp,
      sessionId: null,
      role: undefined,
      tenantId: undefined,
      amr: null,
      aal: null,
    });
    // app_metadata that is not an object fails the whole token: it is where the role lives.
    expect(accessClaims(token({ ...BASE, app_metadata: 'admin' }))).toBeNull();
    // An odd amr never fails it.
    expect(accessClaims(token({ ...BASE, amr: 'password' }))?.amr).toBeNull();
    expect(accessClaims(token({ ...BASE, amr: { method: 'password' } }))?.amr).toBeNull();
  });

  it('reads amr entry by entry: objects with a time, bare strings, and skips the rest', () => {
    const parsed = accessClaims(
      token({
        ...BASE,
        amr: [
          { method: 'password', timestamp: 100 },
          'otp',
          { method: 'totp' },
          { method: 'sso', timestamp: '200' },
          { timestamp: 300 },
          42,
          null,
        ],
      }),
    );
    expect(parsed?.amr).toEqual([
      { method: 'password', timestamp: 100 },
      { method: 'otp', timestamp: null },
      { method: 'totp', timestamp: null },
    ]);
  });
});

describe('signedInAt', () => {
  it('is the newest time the token records', () => {
    expect(
      signedInAt({
        amr: [
          { method: 'password', timestamp: 100 },
          { method: 'totp', timestamp: 500 },
          { method: 'otp', timestamp: null },
        ],
      }),
    ).toBe(500);
  });

  it('is null when no entry carries a time, or there is no list', () => {
    expect(signedInAt({ amr: null })).toBeNull();
    expect(signedInAt({ amr: [] })).toBeNull();
    expect(signedInAt({ amr: [{ method: 'pwd', timestamp: null }] })).toBeNull();
  });
});
