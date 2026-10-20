import { describe, expect, it } from 'vitest';
import {
  aalOf,
  factorsOf,
  hasVerifiedTotp,
  secondStepNeeded,
  type Aal,
  type SecondStep,
} from '@/lib/auth/twoStep';

// The two-step rule (Admin v2 U17), the Worker's half. The DATABASE's half is the access-token
// hook and app.mfa_required (supabase/migrations/0072_two_step_sign_in.sql), proven by
// supabase/tests/two_step.test.sql over the same cases: keep the two tables visibly equal.
//
// The hook answers only "stamp the role or not": it stamps when nothing is owed or when the
// token is at aal2. So every row below says what the hook does (stamp) and what the Worker does
// (the second step owed). The one place they differ on purpose is the last two rows: an aal2
// token in a tenant that requires 2FA, with no factor (reset mid-session). The hook stamps it
// (aal2 is all it can see); the Worker, stricter, sends the person to set 2FA up again.

interface Row {
  label: string;
  verifiedFactor: boolean;
  tenantRequires: boolean;
  aal: Aal | null;
  /** What public.custom_access_token_hook does with the role (0072). */
  hook: 'stamp' | 'strip';
  /** What resolveAuthContext owes the session. */
  worker: SecondStep | null;
}

const TABLE: readonly Row[] = [
  // two_step.test.sql: "admin, no factor, tenant not requiring, aal1: stamped" (and the other roles)
  {
    label: 'no factor, not required, aal1',
    verifiedFactor: false,
    tenantRequires: false,
    aal: 'aal1',
    hook: 'stamp',
    worker: null,
  },
  // "nothing required and no aal in the event: stamped, as before 0072"
  {
    label: 'no factor, not required, no aal',
    verifiedFactor: false,
    tenantRequires: false,
    aal: null,
    hook: 'stamp',
    worker: null,
  },
  // a password and a code with no factor left (turned off since): nothing is owed
  {
    label: 'no factor, not required, aal2',
    verifiedFactor: false,
    tenantRequires: false,
    aal: 'aal2',
    hook: 'stamp',
    worker: null,
  },
  // "a verified factor at aal1: stripped"
  {
    label: 'verified factor, aal1',
    verifiedFactor: true,
    tenantRequires: false,
    aal: 'aal1',
    hook: 'strip',
    worker: 'challenge',
  },
  // "a verified factor and an aal GoTrue never writes: stripped" (aalOf maps it to null)
  {
    label: 'verified factor, unknown aal',
    verifiedFactor: true,
    tenantRequires: false,
    aal: null,
    hook: 'strip',
    worker: 'challenge',
  },
  // "a verified factor at aal2: stamped"
  {
    label: 'verified factor, aal2',
    verifiedFactor: true,
    tenantRequires: false,
    aal: 'aal2',
    hook: 'stamp',
    worker: null,
  },
  // "an unverified (abandoned) factor only, aal1: stamped" (factorsOf counts it as none)
  {
    label: 'unverified factor only, aal1',
    verifiedFactor: false,
    tenantRequires: false,
    aal: 'aal1',
    hook: 'stamp',
    worker: null,
  },
  // "tenant requires 2FA, no factor, aal1: stripped"
  {
    label: 'required, no factor, aal1',
    verifiedFactor: false,
    tenantRequires: true,
    aal: 'aal1',
    hook: 'strip',
    worker: 'enrol',
  },
  // "tenant requires 2FA and the event has no aal: stripped"
  {
    label: 'required, no factor, no aal',
    verifiedFactor: false,
    tenantRequires: true,
    aal: null,
    hook: 'strip',
    worker: 'enrol',
  },
  // required, a factor, aal1: both say the code
  {
    label: 'required, verified factor, aal1',
    verifiedFactor: true,
    tenantRequires: true,
    aal: 'aal1',
    hook: 'strip',
    worker: 'challenge',
  },
  {
    label: 'required, verified factor, aal2',
    verifiedFactor: true,
    tenantRequires: true,
    aal: 'aal2',
    hook: 'stamp',
    worker: null,
  },
  // "tenant requires 2FA, aal2: stamped" — and the Worker, stricter, asks for a setup again
  {
    label: 'required, no factor, aal2 (reset mid-session)',
    verifiedFactor: false,
    tenantRequires: true,
    aal: 'aal2',
    hook: 'stamp',
    worker: 'enrol',
  },
];

/** The hook's decision, in TypeScript: stamp when nothing is required or the token is at aal2. */
function hookStamps(row: Row): boolean {
  const required = row.verifiedFactor || row.tenantRequires; // app.mfa_required
  return row.aal === 'aal2' || !required;
}

describe('the two-step rule (src/lib/auth/twoStep.ts)', () => {
  it.each(TABLE)('$label: the Worker owes $worker', (row) => {
    expect(
      secondStepNeeded({
        verifiedFactor: row.verifiedFactor,
        tenantRequires: row.tenantRequires,
        aal: row.aal,
      }),
    ).toBe(row.worker);
  });

  it.each(TABLE)('$label: the hook would $hook the role', (row) => {
    expect(hookStamps(row) ? 'stamp' : 'strip').toBe(row.hook);
  });

  it('the Worker is never looser than the hook: whatever the hook strips, the Worker holds back', () => {
    for (const row of TABLE) {
      if (row.hook === 'strip') expect(row.worker, row.label).not.toBeNull();
    }
  });

  it('covers every combination of factor, requirement and level', () => {
    const seen = new Set(TABLE.map((r) => `${r.verifiedFactor}/${r.tenantRequires}/${r.aal}`));
    for (const f of [true, false])
      for (const t of [true, false])
        for (const a of ['aal1', 'aal2', null]) {
          // The rows the table leaves out answer like their aal1 neighbour (null = below aal2).
          const key = `${f}/${t}/${a}`;
          const twin = `${f}/${t}/aal1`;
          expect(seen.has(key) || (a === null && seen.has(twin)), key).toBe(true);
        }
  });
});

describe('reading GoTrue’s factors', () => {
  const APP = '33333333-3333-4333-8333-333333333333';

  it('a verified authenticator app: verified, with its id', () => {
    expect(factorsOf([{ id: APP, factor_type: 'totp', status: 'verified' }])).toEqual({
      verified: true,
      totpId: APP,
    });
    expect(
      hasVerifiedTotp({ factors: [{ id: APP, factor_type: 'totp', status: 'verified' }] }),
    ).toBe(true);
  });

  it('an abandoned setup is nothing; a verified factor of another type counts, without an app', () => {
    expect(factorsOf([{ id: APP, factor_type: 'totp', status: 'unverified' }])).toEqual({
      verified: false,
      totpId: null,
    });
    expect(factorsOf([{ id: APP, factor_type: 'phone', status: 'verified' }])).toEqual({
      verified: true,
      totpId: null,
    });
  });

  it('anything not in GoTrue’s shape counts as nothing, never throws', () => {
    for (const odd of [null, undefined, [], [null], [{}], [{ status: 'VERIFIED' }]] as unknown[]) {
      expect(factorsOf(odd as never)).toEqual({ verified: false, totpId: null });
    }
    expect(hasVerifiedTotp({})).toBe(false);
  });

  it('the level: aal1 and aal2, anything else unknown', () => {
    expect(aalOf('aal1')).toBe('aal1');
    expect(aalOf('aal2')).toBe('aal2');
    for (const odd of ['aal3', 'AAL2', '', null, undefined, 2]) expect(aalOf(odd)).toBeNull();
  });
});
