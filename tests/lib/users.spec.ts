import { describe, expect, it } from 'vitest';
import {
  INVITE_MESSAGE_MAX,
  InviteDomainSchema,
  InviteMessageSchema,
  SecuritySettingsSchema,
  UserInviteV2Schema,
  StaffAccountRowSchema,
  TransferOwnershipSchema,
} from '@schemas/users';
import {
  canCancelInvite,
  canResendInvite,
  inviteDomainRefusal,
  isOwnerGuardError,
  isPendingInvite,
  ownerRefusal,
  securityFromRow,
  userStatus,
} from '@/lib/admin/users';

// The users screen's rules (Admin v2 U12a), pure: who counts as invited, removed or locked;
// what touches the owner; the allowed invite domain; the Security card's input.

const NOW = Date.UTC(2026, 9, 15, 12);
const base = {
  isActive: true,
  lockedUntil: null as string | null,
  invitedAt: null as string | null,
  confirmed: true,
  lastSignInAt: '2026-10-14T10:00:00Z' as string | null,
};

describe('userStatus', () => {
  it('removed beats everything, then locked, then invited, else active', () => {
    expect(userStatus(base, NOW)).toBe('active');
    expect(userStatus({ ...base, isActive: false, lockedUntil: '2099-01-01T00:00:00Z' }, NOW)).toBe(
      'removed',
    );
    expect(userStatus({ ...base, lockedUntil: new Date(NOW + 60_000).toISOString() }, NOW)).toBe(
      'locked',
    );
    expect(userStatus({ ...base, lockedUntil: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(
      'active',
    );
    expect(
      userStatus(
        { ...base, invitedAt: '2026-10-14T00:00:00Z', confirmed: false, lastSignInAt: null },
        NOW,
      ),
    ).toBe('invited');
    // An invite that was accepted, or an account that has signed in, is no longer "invited".
    expect(userStatus({ ...base, invitedAt: '2026-10-14T00:00:00Z' }, NOW)).toBe('active');
  });
});

describe('ownerRefusal', () => {
  const owner = { is_owner: true };
  it('refuses demoting or switching off the owner', () => {
    expect(ownerRefusal(owner, { role: 'seo' })).toBe(true);
    expect(ownerRefusal(owner, { isActive: false })).toBe(true);
  });
  it('lets the owner be renamed, kept an Admin, or switched on', () => {
    expect(ownerRefusal(owner, {})).toBe(false);
    expect(ownerRefusal(owner, { role: 'admin' })).toBe(false);
    expect(ownerRefusal(owner, { isActive: true })).toBe(false);
  });
  it('never refuses anyone else', () => {
    expect(ownerRefusal({ is_owner: false }, { role: 'seo', isActive: false })).toBe(false);
    expect(ownerRefusal({}, { role: 'seo' })).toBe(false);
    expect(ownerRefusal({ is_owner: 'true' }, { role: 'seo' })).toBe(false);
  });
  it('recognises the database guard by its code and message only', () => {
    expect(isOwnerGuardError({ code: '42501', message: 'owner_protected' })).toBe(true);
    expect(isOwnerGuardError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isOwnerGuardError({ code: '23514', message: 'owner_protected' })).toBe(false);
    expect(isOwnerGuardError(null)).toBe(false);
  });
});

describe('inviteDomainRefusal', () => {
  it('allows anyone while no domain is set', () => {
    expect(inviteDomainRefusal('a@anything.test', null)).toBeNull();
  });
  it('allows exactly the domain, whatever the case', () => {
    expect(inviteDomainRefusal('a@example.com', 'example.com')).toBeNull();
    expect(inviteDomainRefusal('A@EXAMPLE.COM', 'example.com')).toBeNull();
  });
  it.each([
    'a@sub.example.com',
    'a@example.com.evil.test',
    'a@notexample.com',
    'a@example.co',
    'example.com',
  ])('refuses %s (a subdomain is another domain)', (email) => {
    expect(inviteDomainRefusal(email, 'example.com')).toBe(
      'Only example.com addresses can be invited. Change it in Security.',
    );
  });
});

describe('the Security card input', () => {
  it('normalises the domain: trimmed, lower case, no leading @; empty is none', () => {
    expect(InviteDomainSchema.parse(' @Example.COM ')).toBe('example.com');
    expect(InviteDomainSchema.parse('mail.example.co.uk')).toBe('mail.example.co.uk');
    expect(InviteDomainSchema.parse('   ')).toBeNull();
  });
  it.each([
    'localhost',
    'https://example.com',
    'example.com/path',
    'team@example.com',
    '-example.com',
    'exa_mple.com',
    `${'a'.repeat(64)}.com`,
    `${'a.'.repeat(127)}com`,
  ])('refuses %s', (value) => {
    expect(InviteDomainSchema.safeParse(value).success).toBe(false);
  });
  it('takes 1 or 7 days only, a version, and nothing else', () => {
    expect(
      SecuritySettingsSchema.parse({ sessionMaxDays: 1, inviteDomain: null, version: 0 }),
    ).toEqual({ sessionMaxDays: 1, inviteDomain: null, version: 0 });
    for (const days of [0, 2, 30, '7']) {
      expect(
        SecuritySettingsSchema.safeParse({ sessionMaxDays: days, inviteDomain: null, version: 0 })
          .success,
      ).toBe(false);
    }
    expect(
      SecuritySettingsSchema.safeParse({ sessionMaxDays: 7, inviteDomain: null, version: -1 })
        .success,
    ).toBe(false);
    expect(
      SecuritySettingsSchema.safeParse({
        sessionMaxDays: 7,
        inviteDomain: null,
        version: 1,
        requireMfa: true,
      }).success,
    ).toBe(false);
  });
  it('reads a stored row, and the defaults at version 0 for none', () => {
    expect(securityFromRow(null)).toEqual({ sessionMaxDays: 7, inviteDomain: null, version: 0 });
    expect(securityFromRow({ session_max_days: 1, invite_domain: 'x.test', version: 2 })).toEqual({
      sessionMaxDays: 1,
      inviteDomain: 'x.test',
      version: 2,
    });
  });
  it('parses the directory rows and the transfer target', () => {
    expect(
      StaffAccountRowSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'a@b.test',
        invited_at: null,
        email_confirmed_at: null,
        last_sign_in_at: null,
        is_owner: false,
      }).success,
    ).toBe(true);
    expect(TransferOwnershipSchema.safeParse({ to: 'nope' }).success).toBe(false);
  });
});

describe('invites (Admin v2 U12b)', () => {
  const pending = {
    invitedAt: '2026-10-14T10:00:00Z',
    confirmed: false,
    lastSignInAt: null,
    isOwner: false,
    isActive: true,
  };

  it('an invite is pending until it is confirmed or signed in with, and only then cancelled or resent', () => {
    expect(isPendingInvite(pending)).toBe(true);
    expect(isPendingInvite({ ...pending, confirmed: true })).toBe(false);
    expect(isPendingInvite({ ...pending, lastSignInAt: '2026-10-15T00:00:00Z' })).toBe(false);
    expect(isPendingInvite({ ...pending, invitedAt: null })).toBe(false);
    expect(canCancelInvite(pending)).toBe(true);
    expect(canCancelInvite({ ...pending, isOwner: true })).toBe(false);
    expect(canResendInvite(pending)).toBe(true);
    expect(canResendInvite({ ...pending, isActive: false })).toBe(false);
    // A switched-off pending invite can still be cancelled.
    expect(canCancelInvite({ ...pending, isActive: false })).toBe(true);
  });

  it('the message: plain text up to 300 characters, line breaks as spaces, empty is none', () => {
    expect(InviteMessageSchema.parse('  Welcome!\r\nSee you Monday.\t ')).toBe(
      'Welcome! See you Monday.',
    );
    expect(InviteMessageSchema.parse('   ')).toBeNull();
    expect(InviteMessageSchema.parse('مرحبًا بك في الفريق')).toBe('مرحبًا بك في الفريق');
    expect(InviteMessageSchema.parse('x'.repeat(INVITE_MESSAGE_MAX))).toHaveLength(300);
    for (const bad of [
      'x'.repeat(INVITE_MESSAGE_MAX + 1),
      'a <b> tag',
      'a > b',
      'bell\u0007',
      'bidi\u202Eoverride',
      'zero\u200Bwidth',
    ]) {
      expect(InviteMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the invite takes the message beside the e-mail, role and name', () => {
    expect(UserInviteV2Schema.parse({ email: ' A@B.test ', role: 'seo', message: 'Hi' })).toEqual({
      email: 'a@b.test',
      role: 'seo',
      message: 'Hi',
    });
    expect(UserInviteV2Schema.parse({ email: 'a@b.test', role: 'seo' })).toEqual({
      email: 'a@b.test',
      role: 'seo',
    });
    expect(UserInviteV2Schema.safeParse({ email: 'a@b.test', role: 'owner' }).success).toBe(false);
  });
});
