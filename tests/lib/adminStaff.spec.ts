import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import { STAFF_ROLES, authFile, isLoopbackUrl, staffEmail, staffEnv } from '../admin/staff';

// The admin e2e harness creates staff accounts with the service role (tests/admin/staff.ts).
// Its one safety property is WHERE it may do that: a local stack, never staging or
// production. These are the checks on that guard, and on the accounts never being seeded.

const LOCAL = 'http://127.0.0.1:54321';
const KEY = 'local-service-role-key';

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://[::1]:54321',
    'https://localhost',
  ])('accepts %s', (url) => expect(isLoopbackUrl(url)).toBe(true));

  it.each([
    'https://xkxthzcmmvtnwicerlup.supabase.co',
    'https://braiin-station.braiin.workers.dev',
    'http://localhost.example.com',
    'http://127.0.0.1@example.com',
    'http://10.0.0.5:54321',
    'http://127.0.0.2:54321',
    'ftp://localhost',
    'localhost:54321',
    '',
    'not a url',
  ])('refuses %s', (url) => expect(isLoopbackUrl(url)).toBe(false));
});

describe('staffEnv', () => {
  it('is available for a local Supabase and a local preview', () => {
    expect(staffEnv({ PUBLIC_SUPABASE_URL: `${LOCAL}/`, SUPABASE_SERVICE_ROLE_KEY: KEY })).toEqual({
      url: LOCAL,
      serviceKey: KEY,
    });
  });

  it('refuses a remote Supabase, whatever the key', () => {
    expect(
      staffEnv({
        PUBLIC_SUPABASE_URL: 'https://xkxthzcmmvtnwicerlup.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: KEY,
      }),
    ).toBeNull();
  });

  it('refuses a remote preview: the sign-ins would land on a real project', () => {
    expect(
      staffEnv({
        PUBLIC_SUPABASE_URL: LOCAL,
        SUPABASE_SERVICE_ROLE_KEY: KEY,
        PREVIEW_URL: 'https://braiin-station.braiin.workers.dev',
      }),
    ).toBeNull();
  });

  it('refuses without the service key', () => {
    expect(staffEnv({ PUBLIC_SUPABASE_URL: LOCAL })).toBeNull();
    expect(staffEnv({ PUBLIC_SUPABASE_URL: LOCAL, SUPABASE_SERVICE_ROLE_KEY: '' })).toBeNull();
  });
});

describe('the staff accounts', () => {
  it('one per role, on a reserved domain', () => {
    expect(STAFF_ROLES).toEqual(ROLES);
    const emails = STAFF_ROLES.map(staffEmail);
    expect(new Set(emails).size).toBe(ROLES.length);
    for (const email of emails) expect(email).toMatch(/^e2e-[a-z-]+@example\.com$/);
  });

  it('sessions are saved under the gitignored playwright/.auth', () => {
    for (const role of STAFF_ROLES) {
      expect(isAbsolute(authFile(role))).toBe(true);
      expect(authFile(role).replace(/\\/g, '/')).toMatch(/\/playwright\/\.auth\/[a-z_]+\.json$/);
    }
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^playwright\/\.auth\/$/m);
  });

  it('are never in a seed file (seed.sql also runs on staging)', () => {
    for (const file of ['supabase/seed.sql', 'supabase/seeds/production.sql']) {
      const sql = readFileSync(file, 'utf8');
      expect(sql, file).not.toContain('e2e00000-');
      for (const role of STAFF_ROLES) expect(sql, file).not.toContain(staffEmail(role));
    }
  });
});
