import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASES_SWITCH_SQL,
  isLoopbackDbUrl,
  loopbackPsqlTarget,
  psqlEnv,
} from '../admin/releasesSwitch';
import { releasesOn } from '../admin/staff';

/*
 * The release-mode rehearsal (Admin v2 R14-prep; plan B5): the whole e2e suite with releases ON
 * for the e2e tenant, by hand, before the production switch-on. Held here:
 *   - the workflow runs only by hand, is read-only, is never a required check nor a need of
 *     the deploy, and is the e2e job of perf-seo-a11y.yml step for step but for its two named
 *     differences (the switch's psql client, `wrangler dev --test-scheduled`) and the design
 *     capture it leaves out;
 *   - Playwright's projects are exactly main's while E2E_RELEASES is unset (the required job),
 *     and with it on the switch runs after the sample rows and before every other project, the
 *     drill alone after them;
 *   - the switch the setup sends is migration 0112's function, on a loopback database only.
 */

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
}
interface Job {
  name?: string;
  uses?: string;
  needs?: string | string[];
  env?: Record<string, unknown>;
  'timeout-minutes'?: number;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown> | string | string[];
  permissions?: unknown;
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const load = (file: string) => parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as Workflow;
const rehearsal = load('releases-rehearsal.yml');
const gates = load('perf-seo-a11y.yml');
const ci = load('ci.yml');
const job = rehearsal.jobs['e2e-releases-on']!;
const e2e = gates.jobs['e2e']!;

/** An action without its ref (a tag or a commit): the pins are checked on their own. */
const actionOf = (uses: string | undefined) => (uses === undefined ? null : uses.split('@')[0]!);

/** A step as it acts: what it runs or uses, with what, and its own timeout. */
const acts = (step: Step) => ({
  name: step.name ?? null,
  uses: actionOf(step.uses),
  run: step.run ?? null,
  with: step.with ?? null,
  if: step.if ?? null,
  timeout: step['timeout-minutes'] ?? null,
});

describe('.github/workflows/releases-rehearsal.yml', () => {
  it('runs only by hand, read-only, with a timeout, and sets E2E_RELEASES=on', () => {
    expect(Object.keys(rehearsal.on as Record<string, unknown>)).toEqual(['workflow_dispatch']);
    expect(rehearsal.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(rehearsal.jobs)).toEqual(['e2e-releases-on']);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
    expect(job.env?.['E2E_RELEASES']).toBe('on');
    // Nothing else of the e2e job's environment differs.
    const { E2E_RELEASES: _on, ...rest } = job.env ?? {};
    expect(rest).toEqual(e2e.env);
    expect(rehearsal.env).toEqual(gates.env);
  });

  it('is the e2e job step for step, but for the psql client, --test-scheduled and no capture', () => {
    const capture = (step: Step) => step['continue-on-error'] === true;
    const expected = (e2e.steps ?? [])
      .filter((step) => !capture(step))
      .flatMap((step) => {
        if (step.name === 'Start preview (wrangler dev)') {
          return [
            PSQL_STEP,
            { ...step, run: `${step.run!.replace(/ &$/, '')} --test-scheduled &` },
          ];
        }
        return [step];
      })
      .map(acts);
    // The comments and the CLI pin's note may differ; what each step does may not.
    expect((job.steps ?? []).map(acts)).toEqual(expected);
  });

  it('pins every action to the commit the e2e job pins (CLAUDE.md §3 supply chain; O-26)', () => {
    // The e2e job's pins are the ones already trusted; checkout and setup-node are also the
    // deploy job's.
    const e2ePins = new Map(
      (e2e.steps ?? [])
        .filter((step) => step.uses !== undefined)
        .map((step) => [actionOf(step.uses)!, step.uses!]),
    );
    const deployPins = new Map(
      (ci.jobs['deploy']!.steps ?? [])
        .filter((step) => step.uses !== undefined)
        .map((step) => [actionOf(step.uses)!, step.uses!]),
    );
    for (const step of job.steps ?? []) {
      if (step.uses === undefined) continue;
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      expect(step.uses).toBe(e2ePins.get(actionOf(step.uses)!));
      const deployPin = deployPins.get(actionOf(step.uses)!);
      if (deployPin !== undefined) expect(step.uses).toBe(deployPin);
    }
  });

  it('is never a need of the deploy, nor a required check, nor called by ci.yml', () => {
    for (const [id, gate] of Object.entries(ci.jobs)) {
      expect(gate.uses ?? '', id).not.toContain('releases-rehearsal');
    }
    const protection = readFileSync('.github/branch-protection.json', 'utf8');
    expect(protection).not.toContain('releases on');
    expect(protection).not.toContain('Releases rehearsal');
  });
});

const PSQL_STEP: Step = {
  name: 'psql (the client the switch is sent with)',
  run: [
    'command -v psql >/dev/null 2>&1 ||',
    '  { sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends postgresql-client; }',
    'psql --version',
    '',
  ].join('\n'),
};

describe('playwright.config.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function projects(on: boolean) {
    vi.resetModules();
    vi.stubEnv('E2E_RELEASES', on ? 'on' : '');
    const { default: config } = await import('../../playwright.config');
    return new Map(
      (config.projects ?? []).map((p) => [
        p.name!,
        { dependencies: p.dependencies ?? [], testIgnore: p.testIgnore },
      ]),
    );
  }

  it('unset (the required e2e job): main’s projects, no switch and no drill', async () => {
    const off = await projects(false);
    expect([...off.keys()]).toEqual([
      'chromium',
      'admin-setup',
      'admin-samples',
      'admin',
      'blocks',
      'visibility',
      'general',
      'ga4',
      'maintenance',
      'maintenance-teardown',
    ]);
    expect(off.get('chromium')!.dependencies).toEqual([]);
    expect(off.get('admin')!.dependencies).toEqual(['admin-samples']);
    // Admin v2 E10: the section blocks run alone after the public and admin specs.
    expect(off.get('blocks')!.dependencies).toEqual(['chromium', 'admin']);
    expect(off.get('visibility')!.dependencies).toEqual(['blocks']);
  });

  it('unset: every project is main’s, field for field, but the admin project ignoring the drill', async () => {
    // main 42b61c6f's projects as written. The one addition while unset: the admin project
    // ignores the drill's file, which would otherwise be one of its specs (and only skip).
    // Since Admin v2 E10 (in both modes, not a rehearsal change): the section blocks' own
    // project between the admin specs and page visibility, its spec ignored by the admin one.
    vi.resetModules();
    vi.stubEnv('E2E_RELEASES', '');
    const { default: config } = await import('../../playwright.config');
    const { devices } = await import('@playwright/test');
    const src = (re: unknown) => (re instanceof RegExp ? re.source : re);
    const shape = (config.projects ?? []).map((p) => ({
      name: p.name,
      testDir: p.testDir ?? null,
      testMatch: src(p.testMatch) ?? null,
      testIgnore: Array.isArray(p.testIgnore) ? p.testIgnore.map(src) : (src(p.testIgnore) ?? null),
      dependencies: p.dependencies ?? null,
      teardown: p.teardown ?? null,
      chrome: JSON.stringify(p.use) === JSON.stringify(devices['Desktop Chrome']),
    }));
    const admin = './tests/admin';
    const spec = (name: string) => `[\\\\/]tests[\\\\/]admin[\\\\/]${name}\\.e2e\\.ts$`;
    const p = (
      name: string,
      fields: Partial<Omit<(typeof shape)[number], 'name' | 'chrome'>> = {},
    ) => ({
      name,
      testDir: admin,
      testMatch: null,
      testIgnore: null,
      dependencies: null,
      teardown: null,
      chrome: true,
      ...fields,
    });
    expect(shape).toEqual([
      p('chromium', { testDir: null, testIgnore: '[\\\\/]tests[\\\\/]admin[\\\\/]' }),
      p('admin-setup', { testMatch: 'staff\\.setup\\.ts$' }),
      p('admin-samples', { testMatch: 'samples\\.setup\\.ts$', dependencies: ['admin-setup'] }),
      p('admin', {
        testIgnore: [
          spec('visibility'),
          spec('general'),
          spec('ga4'),
          spec('maintenance'),
          'maintenance\\.teardown\\.ts$',
          spec('releases-mode'),
          spec('section-blocks'),
        ],
        dependencies: ['admin-samples'],
      }),
      p('blocks', { testMatch: spec('section-blocks'), dependencies: ['chromium', 'admin'] }),
      p('visibility', { testMatch: spec('visibility'), dependencies: ['blocks'] }),
      p('general', { testMatch: spec('general'), dependencies: ['visibility'] }),
      p('ga4', { testMatch: spec('ga4'), dependencies: ['general'] }),
      p('maintenance', {
        testMatch: spec('maintenance'),
        dependencies: ['ga4'],
        teardown: 'maintenance-teardown',
      }),
      p('maintenance-teardown', { testMatch: 'maintenance\\.teardown\\.ts$' }),
    ]);
  });

  it('on: the switch after the samples and before every spec; the drill alone after them', async () => {
    const on = await projects(true);
    expect(on.get('releases-on')!.dependencies).toEqual(['admin-samples']);
    expect(on.get('chromium')!.dependencies).toEqual(['releases-on']);
    expect(on.get('admin')!.dependencies).toEqual(['releases-on']);
    expect(on.get('releases-mode')!.dependencies).toEqual(['chromium', 'admin']);
    // The projects that change the whole site wait for the drill.
    expect(on.get('visibility')!.dependencies).toEqual(['releases-mode']);
    // The section blocks (Admin v2 E10) are written for releases off: no project here.
    expect(on.has('blocks')).toBe(false);
  });

  it('the drill is never one of the admin project’s specs', async () => {
    for (const on of [false, true]) {
      const ignored = (await projects(on)).get('admin')!.testIgnore as RegExp[];
      expect(ignored.some((re) => re.test('/repo/tests/admin/releases-mode.e2e.ts'))).toBe(true);
    }
  });

  it('releasesOn reads E2E_RELEASES=on and nothing else', () => {
    expect(releasesOn({ E2E_RELEASES: 'on' })).toBe(true);
    expect(releasesOn({ E2E_RELEASES: 'true' })).toBe(false);
    expect(releasesOn({})).toBe(false);
  });
});

describe('the switch the rehearsal sends', () => {
  const migration = readFileSync('supabase/migrations/0112_release_schedule.sql', 'utf8');
  const T = '00000000-0000-0000-0000-0000000000b1';
  const A = 'e2e00000-0000-4000-8000-000000000001';

  it('is 0112’s owner-only function, with the operator as its own fallback scheduler', () => {
    expect(migration).toContain(
      'create or replace function app.enable_releases(p_tenant uuid, p_operator uuid, p_fallback_scheduler uuid)',
    );
    const sql = RELEASES_SWITCH_SQL(T, A);
    expect(sql.enable).toBe(`select app.enable_releases('${T}'::uuid, '${A}'::uuid, '${A}'::uuid)`);
    expect(sql.isOn).toBe(`select app.releases_enabled('${T}'::uuid)`);
    expect(() => RELEASES_SWITCH_SQL(`${T}'; drop table x; --`, A)).toThrow();
  });

  it('goes to a loopback database only', () => {
    expect(isLoopbackDbUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe(true);
    expect(isLoopbackDbUrl('postgres://postgres:postgres@localhost:54322/postgres')).toBe(true);
    expect(isLoopbackDbUrl('postgresql://postgres:x@db.example.supabase.co:5432/postgres')).toBe(
      false,
    );
    expect(isLoopbackDbUrl('http://127.0.0.1:54322')).toBe(false);
    expect(isLoopbackDbUrl('')).toBe(false);
  });

  it('refuses a loopback URL whose query or fragment could redirect libpq (review S3)', () => {
    // libpq reads URI query parameters as connection keywords that replace the URL's host.
    for (const tail of [
      '?host=db.example.supabase.co',
      '?hostaddr=203.0.113.5',
      '?service=prod',
      '?options=-c%20search_path%3Dx',
      '?sslmode=disable',
      '#x',
    ]) {
      const url = `postgresql://postgres:pw@127.0.0.1:54322/postgres${tail}`;
      expect(isLoopbackDbUrl(url), url).toBe(false);
      expect(loopbackPsqlTarget(url), url).toBeNull();
    }
    expect(isLoopbackDbUrl('postgresql://postgres:pw@localhost/postgres?service=prod')).toBe(false);
    for (const url of [
      'postgresql://postgres:pw@127.0.0.1@evil.example/postgres',
      'postgresql://postgres:pw@localhost.evil.example/postgres',
      'postgresql://postgres:pw@127.0.0.1.nip.io/postgres',
    ]) {
      expect(isLoopbackDbUrl(url), url).toBe(false);
    }
  });

  it('hands psql the parsed loopback address, never the URL, and no PG variable but the password', () => {
    expect(loopbackPsqlTarget('postgresql://postgres:p%40ss@127.0.0.1:54322/postgres')).toEqual({
      conninfo: 'host=127.0.0.1 hostaddr=127.0.0.1 port=54322 user=postgres dbname=postgres',
      password: 'p@ss',
    });
    expect(loopbackPsqlTarget('postgres://postgres:x@localhost/postgres')?.conninfo).toBe(
      'host=127.0.0.1 hostaddr=127.0.0.1 port=5432 user=postgres dbname=postgres',
    );
    expect(loopbackPsqlTarget('postgres://postgres:x@[::1]:54322/postgres')?.conninfo).toBe(
      'host=::1 hostaddr=::1 port=54322 user=postgres dbname=postgres',
    );
    // A database or user name psql would read as a connection string of its own.
    expect(
      loopbackPsqlTarget('postgres://postgres:x@127.0.0.1/host%3Devil.example%20dbname%3Dx'),
    ).toBeNull();
    expect(loopbackPsqlTarget('postgres://u%20host%3Devil:x@127.0.0.1/postgres')).toBeNull();
    const env = psqlEnv({ PATH: '/bin', PGSERVICE: 'prod', PGHOSTADDR: '203.0.113.5' }, 'pw');
    expect(env).toEqual({ PATH: '/bin', PGPASSWORD: 'pw' });
    // The setup sends exactly that: the parsed target and its environment.
    const setup = readFileSync('tests/admin/releases.setup.ts', 'utf8');
    expect(setup).toContain("execFileSync('psql', [conninfo, ");
    expect(setup).toContain('env: psqlEnv(process.env, password)');
    expect(setup).not.toMatch(/execFileSync\('psql', \[url/);
  });
});
