import { describe, expect, it } from 'vitest';
import { base32Bytes, totp, untilNextStep } from '../admin/totp';

// The e2e's authenticator app (tests/admin/totp.ts, Admin v2 U17), held to RFC 6238's test
// vectors (Appendix B, SHA-1): the secret "12345678901234567890", whose base32 is below.
// An app that computed codes wrongly would make tests/admin/twoStep.e2e.ts fail for the
// wrong reason.

const RFC_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('the test authenticator (RFC 6238, SHA-1)', () => {
  it('decodes base32 as RFC 4648 does, spaces and case ignored', () => {
    expect(base32Bytes(RFC_KEY).toString('ascii')).toBe('12345678901234567890');
    expect(base32Bytes('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii')).toBe(
      '12345678901234567890',
    );
    expect(() => base32Bytes('A1')).toThrow();
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('at %i seconds the 8-digit code is %s', (seconds, code) => {
    expect(totp(RFC_KEY, seconds * 1000, 8)).toBe(code);
  });

  it('a 6-digit code is the last six of the same number', () => {
    expect(totp(RFC_KEY, 59_000)).toBe('287082');
    expect(totp(RFC_KEY, 1111111109_000)).toBe('081804');
  });

  it('knows when the next 30-second step starts', () => {
    expect(untilNextStep(60_000)).toBe(30_000);
    expect(untilNextStep(89_999)).toBe(1);
  });
});
