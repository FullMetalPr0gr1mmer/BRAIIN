import { describe, expect, it } from 'vitest';
import {
  ForgotPasswordSchema,
  LoginSchema,
  NEW_PASSWORD_MAX,
  NEW_PASSWORD_MIN,
  RECOVERY_TOKEN_PATTERN,
  ResetPasswordSchema,
} from '@schemas/admin';

// The sign-in schemas (Admin v2 F7). CLAUDE.md §9: 100% branch on schema modules.

const PASSWORD = 'correct horse battery';
const TOKEN = 'a1b2c3d4'.repeat(7);

describe('LoginSchema', () => {
  it('normalises the address and keeps "Keep me signed in" on unless told otherwise', () => {
    expect(LoginSchema.parse({ email: '  Staff@Example.TEST ', password: PASSWORD })).toEqual({
      email: 'staff@example.test',
      password: PASSWORD,
      remember: true,
    });
    expect(
      LoginSchema.parse({ email: 'a@b.test', password: PASSWORD, remember: false }).remember,
    ).toBe(false);
  });

  it('refuses a non-boolean remember, a short or overlong password, a non-address', () => {
    for (const input of [
      { email: 'a@b.test', password: PASSWORD, remember: 'on' },
      { email: 'a@b.test', password: 'short' },
      { email: 'a@b.test', password: 'x'.repeat(257) },
      { email: 'not an address', password: PASSWORD },
      { email: `${'x'.repeat(250)}@b.test`, password: PASSWORD },
    ]) {
      expect(LoginSchema.safeParse(input).success, JSON.stringify(input).slice(0, 60)).toBe(false);
    }
  });
});

describe('ForgotPasswordSchema', () => {
  it('takes one address, normalised', () => {
    expect(ForgotPasswordSchema.parse({ email: ' A@B.test ' })).toEqual({ email: 'a@b.test' });
    expect(ForgotPasswordSchema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(ForgotPasswordSchema.safeParse({}).success).toBe(false);
  });
});

describe('ResetPasswordSchema', () => {
  const good = {
    token: TOKEN,
    password: 'x'.repeat(NEW_PASSWORD_MIN),
    confirm: 'x'.repeat(NEW_PASSWORD_MIN),
  };

  it('takes a token of the right shape and a password typed twice, 12 to 128 characters', () => {
    expect(NEW_PASSWORD_MIN).toBe(12);
    expect(NEW_PASSWORD_MAX).toBe(128);
    expect(ResetPasswordSchema.safeParse(good).success).toBe(true);
    const longest = 'y'.repeat(NEW_PASSWORD_MAX);
    expect(
      ResetPasswordSchema.safeParse({ ...good, password: longest, confirm: longest }).success,
    ).toBe(true);
  });

  it('refuses a short or long password, a mismatch, or a token of another shape', () => {
    const short = 'x'.repeat(NEW_PASSWORD_MIN - 1);
    const long = 'x'.repeat(NEW_PASSWORD_MAX + 1);
    for (const input of [
      { ...good, password: short, confirm: short },
      { ...good, password: long, confirm: long },
      { ...good, confirm: `${good.password}!` },
      { ...good, token: 'short' },
      { ...good, token: `${TOKEN}=` },
      { ...good, token: 'x'.repeat(129) },
    ]) {
      expect(ResetPasswordSchema.safeParse(input).success).toBe(false);
    }
    const mismatch = ResetPasswordSchema.safeParse({ ...good, confirm: 'different!!!!' });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]?.path).toEqual(['confirm']);
  });

  it('the token pattern accepts GoTrue’s hex hash and its pkce_ form, nothing with markup', () => {
    expect(RECOVERY_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(RECOVERY_TOKEN_PATTERN.test(`pkce_${TOKEN}`)).toBe(true);
    expect(RECOVERY_TOKEN_PATTERN.test(`${TOKEN}"><script>`)).toBe(false);
  });
});
