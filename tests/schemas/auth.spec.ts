import { describe, expect, it } from 'vitest';
import {
  ForgotPasswordSchema,
  LoginSchema,
  RECOVERY_TOKEN_PATTERN,
  ResetPasswordSchema,
  newPasswordProblem,
} from '@schemas/admin';
import { PASSWORD_MAX_BYTES, PASSWORD_MIN, PasswordChangeSchema } from '@schemas/adminPrefs';

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
    password: 'x'.repeat(PASSWORD_MIN),
    confirm: 'x'.repeat(PASSWORD_MIN),
  };

  it('takes a token of the right shape and a password typed twice, 10 characters to 72 bytes', () => {
    expect(PASSWORD_MIN).toBe(10);
    expect(PASSWORD_MAX_BYTES).toBe(72);
    expect(ResetPasswordSchema.safeParse(good).success).toBe(true);
    const longest = 'y'.repeat(PASSWORD_MAX_BYTES);
    expect(
      ResetPasswordSchema.safeParse({ ...good, password: longest, confirm: longest }).success,
    ).toBe(true);
  });

  it('refuses a short or long password, a mismatch, or a token of another shape', () => {
    const short = 'x'.repeat(PASSWORD_MIN - 1);
    const long = 'x'.repeat(PASSWORD_MAX_BYTES + 1);
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

  it('newPasswordProblem counts bytes as bcrypt does: 36 Arabic letters fit, 37 do not', () => {
    expect(newPasswordProblem('x'.repeat(PASSWORD_MIN - 1))).toBe('short');
    expect(newPasswordProblem('x'.repeat(PASSWORD_MIN))).toBeNull();
    // Two bytes a letter in UTF-8: the characters fit under 72, the bytes may not.
    expect(newPasswordProblem('ب'.repeat(36))).toBeNull();
    expect(newPasswordProblem('ب'.repeat(37))).toBe('long');
    expect(newPasswordProblem('x'.repeat(10_000))).toBe('long');
  });

  it("is the account screen's rule (F8): one password policy for a change and a reset", () => {
    for (const value of [
      'x'.repeat(PASSWORD_MIN - 1),
      'x'.repeat(PASSWORD_MIN),
      'ب'.repeat(36),
      'ب'.repeat(37),
    ]) {
      const change = PasswordChangeSchema.safeParse({
        current: 'old',
        next: value,
        confirm: value,
      });
      expect(newPasswordProblem(value) === null, value).toBe(change.success);
    }
  });

  it('the token pattern accepts GoTrue’s hex hash and its pkce_ form, nothing with markup', () => {
    expect(RECOVERY_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(RECOVERY_TOKEN_PATTERN.test(`pkce_${TOKEN}`)).toBe(true);
    expect(RECOVERY_TOKEN_PATTERN.test(`${TOKEN}"><script>`)).toBe(false);
  });
});
