import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import {
  STAFF_ROLES,
  authFile,
  builtSupabaseUrls,
  isLoopbackUrl,
  staffEmail,
  staffEnv,
} from '../admin/staff';

// The admin e2e harness creates staff accounts with the service role (tests/admin/staff.ts).
// Its one safety property is WHERE it may do that: a local stack, never staging or
// production. These are the checks on that guard, and on the accounts never being seeded.

const LOCAL = 'http://127.0.0.1:54321';
const KEY = 'local-service-role-key';
/** A preview build compiled against the local Supabase, as the e2e job's is. */
const BUILT_LOCAL = () => [LOCAL];

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
  const env = { PUBLIC_SUPABASE_URL: LOCAL, SUPABASE_SERVICE_ROLE_KEY: KEY };

  it('is available for a local Supabase and a local preview built against it', () => {
    expect(staffEnv({ ...env, PUBLIC_SUPABASE_URL: `${LOCAL}/` }, BUILT_LOCAL)).toEqual({
      url: LOCAL,
      serviceKey: KEY,
    });
  });

  it('refuses a remote Supabase, whatever the key', () => {
    expect(
      staffEnv({ ...env, PUBLIC_SUPABASE_URL: 'https://xkxthzcmmvtnwicerlup.supabase.co' }, () => [
        'https://xkxthzcmmvtnwicerlup.supabase.co',
      ]),
    ).toBeNull();
  });

  it('refuses a remote preview: the sign-ins would land on a real project', () => {
    expect(
      staffEnv({ ...env, PREVIEW_URL: 'https://braiin-station.braiin.workers.dev' }, BUILT_LOCAL),
    ).toBeNull();
  });

  it('refuses a local preview built against a hosted project (a .env build)', () => {
    expect(staffEnv(env, () => ['https://xkxthzcmmvtnwicerlup.supabase.co'])).toBeNull();
    // A build holding both (shell env and .env disagree: scripts/check-site-url.mjs).
    expect(staffEnv(env, () => [LOCAL, 'https://xkxthzcmmvtnwicerlup.supabase.co'])).toBeNull();
  });

  it('refuses when there is no build to read', () => {
    expect(staffEnv(env, () => [])).toBeNull();
  });

  it('refuses without the service key', () => {
    expect(staffEnv({ PUBLIC_SUPABASE_URL: LOCAL }, BUILT_LOCAL)).toBeNull();
    expect(staffEnv({ ...env, SUPABASE_SERVICE_ROLE_KEY: '' }, BUILT_LOCAL)).toBeNull();
  });
});

describe('builtSupabaseUrls', () => {
  function build(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'preview-build-'));
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), source);
    }
    return dir;
  }

  it('reads both spellings a build emits, in nested chunks, once each', () => {
    const dir = build({
      'entry.mjs': `var PUBLIC_SUPABASE_URL = "${LOCAL}";`,
      'chunks/admin-ui_X.mjs': `const env = { "PUBLIC_SUPABASE_URL": "${LOCAL}/" };`,
      'chunks/other_Y.mjs': 'const unrelated = "http://localhost:9999";',
      'wrangler.json': `{ "PUBLIC_SUPABASE_URL": "https://ignored.example" }`,
    });
    expect(builtSupabaseUrls(dir)).toEqual([LOCAL]);
  });

  it('reports every project a build names', () => {
    const dir = build({
      'a.mjs': `var PUBLIC_SUPABASE_URL = "${LOCAL}";`,
      'b.mjs': `var PUBLIC_SUPABASE_URL = "https://xkxthzcmmvtnwicerlup.supabase.co";`,
    });
    expect(builtSupabaseUrls(dir).sort()).toEqual(
      [LOCAL, 'https://xkxthzcmmvtnwicerlup.supabase.co'].sort(),
    );
  });

  it('is empty without a build', () => {
    expect(builtSupabaseUrls(join(tmpdir(), 'no-such-build-dir'))).toEqual([]);
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
