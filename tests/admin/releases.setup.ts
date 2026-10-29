import { execFileSync } from 'node:child_process';
import { expect, test as setup } from '@playwright/test';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { RELEASES_SWITCH_SQL, loopbackPsqlTarget, psqlEnv } from './releasesSwitch';
import { SKIP_REASON, STAFF_IDS, releasesOn, staffEnv } from './staff';

/*
 * The release-mode rehearsal's switch (Admin v2 R14-prep; plan B5: "rehearsed first in CI,
 * where the whole e2e suite runs in release mode"). Only with E2E_RELEASES=on
 * (.github/workflows/releases-rehearsal.yml): playwright.config.ts then runs this project after
 * `admin-samples` (the sample rows exist live first, as production's content does before its
 * switch) and before every public and admin spec.
 *
 * It runs `app.enable_releases` exactly as the launch runbook's §6p does in production: as the
 * owner (`postgres`) on a direct session, never through an API role (no API role holds EXECUTE,
 * and the function refuses a role claim), with the e2e Admin as the operator and the fallback
 * scheduler. LOCAL STACKS ONLY: the database URL must be loopback (the e2e job's
 * `supabase status` DB_URL, with no query string), psql is given its parsed address, not the
 * URL, and the harness's own guard (staffEnv: a loopback Supabase and
 * preview, a build that names that Supabase) must hold too. Idempotent on a local stack that
 * outlives one run: already on, it says so and changes nothing.
 */

setup.skip(!releasesOn(), 'releases stay off: the rehearsal sets E2E_RELEASES=on');

setup('switch releases on for the e2e tenant, as the owner', () => {
  expect(staffEnv(), `the rehearsal runs the admin harness: ${SKIP_REASON}`).not.toBeNull();
  // psql gets the loopback address, port and names parsed out of the URL, never the URL itself.
  const target = loopbackPsqlTarget(process.env['SUPABASE_DB_POOL_URL'] ?? '');
  expect(target, 'the rehearsal switches a LOCAL database only').not.toBeNull();
  const { conninfo, password } = target!;

  const psql = (sql: string) =>
    execFileSync('psql', [conninfo, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
      encoding: 'utf8',
      env: psqlEnv(process.env, password),
    }).trim();

  const sql = RELEASES_SWITCH_SQL(TENANT_ID, STAFF_IDS.admin);
  if (psql(sql.isOn) === 't') return;
  const answer = JSON.parse(psql(sql.enable)) as { baseline?: { number?: number } };
  expect(answer.baseline?.number, 'the baseline version').toBeGreaterThanOrEqual(1);
  expect(psql(sql.isOn)).toBe('t');
});
