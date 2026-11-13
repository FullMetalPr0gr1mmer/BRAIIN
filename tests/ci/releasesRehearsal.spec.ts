import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * Release mode in the required e2e job (Admin v2 R14c, the owner's go of 2026-11-13; before it
 * the hand-run release-mode rehearsal of R14-prep, plan B5). Held here:
 *   - perf-seo-a11y.yml's `e2e` job keeps its id and its name, so the required check is still
 *     "perf-seo-a11y / E2E + axe + CSP + video bytes", and runs with E2E_RELEASES=on: the
 *     rehearsal's job step for step (the switch's psql client before the preview,
 *     `wrangler dev --test-scheduled`, no design capture);
 *   - a second job, "E2E with releases off", is main's e2e job as it was (the capture included)
 *     with E2E_RELEASES unset, and is never a required check;
 *   - the rehearsal workflow is retired: the required job does what it did;
 *   - Playwright's projects are exactly main's while E2E_RELEASES is unset (the releases-off
 *     job), and with it on the switch runs after the sample rows and before every other project,
 *     the drill alone after them;
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

const DIR = '.github/workflows';
const load = (file: string) => parse(readFileSync(`${DIR}/${file}`, 'utf8')) as Workflow;
const gates = load('perf-seo-a11y.yml');
const ci = load('ci.yml');
/** The required e2e job: release mode since R14c. */
const e2e = gates.jobs['e2e']!;
/** Main's e2e job as it was before R14c: releases off, not required. */
const off = gates.jobs['e2e-releases-off']!;
const protection = readFileSync('.github/branch-protection.json', 'utf8');
const REQUIRED_E2E = 'perf-seo-a11y / E2E + axe + CSP + video bytes';
const RELEASES_OFF_CHECK = 'perf-seo-a11y / E2E with releases off';

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

const PSQL_STEP: Step = {
  name: 'psql (the client the switch is sent with)',
  run: [
    'command -v psql >/dev/null 2>&1 ||',
    '  { sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends postgresql-client; }',
    'psql --version',
    '',
  ].join('\n'),
};

describe('.github/workflows/perf-seo-a11y.yml: the required e2e job in release mode (R14c)', () => {
  it('has the release-mode job, the releases-off job and Lighthouse, and nothing else', () => {
    expect(Object.keys(gates.jobs)).toEqual(['e2e', 'e2e-releases-off', 'lighthouse']);
  });

  it('keeps the required job’s id and name, and runs it with E2E_RELEASES=on', () => {
    expect(e2e.name).toBe('E2E + axe + CSP + video bytes');
    expect(protection).toContain(`"${REQUIRED_E2E}"`);
    expect(e2e.env?.['E2E_RELEASES']).toBe('on');
    // Nothing else of the environment differs from the releases-off job's.
    const { E2E_RELEASES: _on, ...rest } = e2e.env ?? {};
    expect(rest).toEqual(off.env);
    expect(e2e['timeout-minutes']).toBeGreaterThan(0);
    expect(e2e['timeout-minutes']).toBeLessThanOrEqual(60);
  });

  it('keeps a releases-off job of its own name, with E2E_RELEASES unset, never required', () => {
    expect(off.name).toBe('E2E with releases off');
    expect(Object.keys(off.env ?? {})).not.toContain('E2E_RELEASES');
    expect(protection).not.toContain(RELEASES_OFF_CHECK);
    expect(protection).not.toContain('releases off');
    expect(off['timeout-minutes']).toBeGreaterThan(0);
    expect(off['timeout-minutes']).toBeLessThanOrEqual(60);
    // The release mode is the job's own: the shared env and the Lighthouse job never set it.
    expect(Object.keys(gates.env ?? {})).not.toContain('E2E_RELEASES');
    expect(Object.keys(gates.jobs['lighthouse']!.env ?? {})).not.toContain('E2E_RELEASES');
  });

  it('is the releases-off job step for step, but for the psql client, --test-scheduled and no capture', () => {
    const capture = (step: Step) => step['continue-on-error'] === true;
    expect((off.steps ?? []).filter(capture).map((step) => step.name ?? step.uses)).toEqual([
      'Design capture (public + admin full-page screenshots for the mockup comparison, not assertions)',
      'Upload design capture',
    ]);
    const expected = (off.steps ?? [])
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
    // The comments may differ; what each step does may not.
    expect((e2e.steps ?? []).map(acts)).toEqual(expected);
  });

  it('installs psql right before the preview starts, and the preview takes the scheduled trigger', () => {
    const names = (e2e.steps ?? []).map((step) => step.name ?? '');
    const psql = names.indexOf(PSQL_STEP.name!);
    const preview = names.indexOf('Start preview (wrangler dev)');
    const tests = names.indexOf(
      'Playwright (e2e, axe WCAG 2.2 AA, CSP, served HTML, video bytes, admin sweep)',
    );
    expect(psql).toBeGreaterThan(0);
    expect(preview).toBe(psql + 1);
    expect(tests).toBeGreaterThan(preview);
    expect(e2e.steps![preview]!.run).toMatch(/ --test-scheduled &$/);
    const offPreview = (off.steps ?? []).find((s) => s.name === 'Start preview (wrangler dev)');
    expect(offPreview?.run).toBe(
      'npx wrangler dev --port 8788 --env-file dist/server/.preview.env &',
    );
    expect(JSON.stringify(off.steps)).not.toContain('psql');
  });

  it('pins every action of the job to the releases-off job’s and the deploy’s commit (CLAUDE.md §3; O-26)', () => {
    const pinsOf = (steps: Step[] | undefined) =>
      new Map(
        (steps ?? [])
          .filter((step) => step.uses !== undefined)
          .map((step) => [actionOf(step.uses)!, step.uses!]),
      );
    const offPins = pinsOf(off.steps);
    const deployPins = pinsOf(ci.jobs['deploy']!.steps);
    for (const step of e2e.steps ?? []) {
      if (step.uses === undefined) continue;
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      expect(step.uses).toBe(offPins.get(actionOf(step.uses)!));
      const deployPin = deployPins.get(actionOf(step.uses)!);
      if (deployPin !== undefined) expect(step.uses).toBe(deployPin);
    }
  });

  it('retires the hand-run rehearsal: the required job does what it did', () => {
    expect(existsSync(`${DIR}/releases-rehearsal.yml`)).toBe(false);
    for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
      // E2E_RELEASES is set by the required job alone.
      const setting = Object.values(load(file).jobs).filter(
        (job) => job.env?.['E2E_RELEASES'] !== undefined,
      );
      expect(
        setting.map((job) => job.name),
        file,
      ).toEqual(file === 'perf-seo-a11y.yml' ? ['E2E + axe + CSP + video bytes'] : []);
    }
    for (const [id, gate] of Object.entries(ci.jobs)) {
      expect(gate.uses ?? '', id).not.toContain('releases-rehearsal');
    }
    expect(protection).not.toContain('Releases rehearsal');
  });
});

describe('playwright.config.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function projects(on: boolean) {
    vi.resetModules();
    vi.stubEnv('E2E_RELEASES', on ? 'on' : '');
    // The admin visual baselines' project (Admin v2 Z1) is the hand-run workflow's alone.
    vi.stubEnv('ADMIN_VISUAL', '');
    const { default: config } = await import('../../playwright.config');
    return new Map(
      (config.projects ?? []).map((p) => [
        p.name!,
        { dependencies: p.dependencies ?? [], testIgnore: p.testIgnore },
      ]),
    );
  }

  it('unset (the releases-off job): main’s projects, no switch and no drill', async () => {
    const off = await projects(false);
    expect([...off.keys()]).toEqual([
      'chromium',
      'admin-setup',
      'admin-samples',
      'admin',
      'blocks',
      'visibility',
      'general',
      'header',
      'footer',
      'loading',
      'ga4',
      'theme',
      'templates',
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
    vi.stubEnv('ADMIN_VISUAL', '');
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
          spec('header'),
          spec('footer'),
          spec('loading'),
          spec('ga4'),
          spec('theme'),
          spec('templates'),
          spec('maintenance'),
          'maintenance\\.teardown\\.ts$',
          spec('releases-mode'),
          spec('section-(?:blocks|appearance)'),
        ],
        dependencies: ['admin-samples'],
      }),
      p('blocks', {
        testMatch: spec('section-(?:blocks|appearance)'),
        dependencies: ['chromium', 'admin'],
      }),
      p('visibility', { testMatch: spec('visibility'), dependencies: ['blocks'] }),
      p('general', { testMatch: spec('general'), dependencies: ['visibility'] }),
      // Admin v2 E5: the header's options, alone after general settings.
      p('header', { testMatch: spec('header'), dependencies: ['general'] }),
      // Admin v2 E6: the footer, alone after the header.
      p('footer', { testMatch: spec('footer'), dependencies: ['header'] }),
      // Admin v2 E7: the loading screen, alone after the footer.
      p('loading', { testMatch: spec('loading'), dependencies: ['footer'] }),
      p('ga4', { testMatch: spec('ga4'), dependencies: ['loading'] }),
      // Admin v2 E4: the theme, alone, between GA4 and maintenance.
      p('theme', { testMatch: spec('theme'), dependencies: ['ga4'] }),
      // Admin v2 E3: the template editors, alone, between the theme and maintenance.
      p('templates', { testMatch: spec('templates'), dependencies: ['theme'] }),
      p('maintenance', {
        testMatch: spec('maintenance'),
        dependencies: ['templates'],
        teardown: 'maintenance-teardown',
      }),
      p('maintenance-teardown', { testMatch: 'maintenance\\.teardown\\.ts$' }),
    ]);
  });

  it('on (the required e2e job since R14c): the switch after the samples and before every spec; the drill alone after them', async () => {
    const on = await projects(true);
    expect(on.get('releases-on')!.dependencies).toEqual(['admin-samples']);
    expect(on.get('chromium')!.dependencies).toEqual(['releases-on']);
    expect(on.get('admin')!.dependencies).toEqual(['releases-on']);
    expect(on.get('releases-mode')!.dependencies).toEqual(['chromium', 'admin']);
    // The projects that change the whole site wait for the drill: the section blocks first
    // (Admin v2 R14b: in both modes), then page visibility and the rest of the chain.
    expect(on.get('blocks')!.dependencies).toEqual(['releases-mode']);
    expect(on.get('visibility')!.dependencies).toEqual(['blocks']);
    expect([...on.keys()]).toEqual([
      'chromium',
      'admin-setup',
      'admin-samples',
      'admin',
      'releases-on',
      'releases-mode',
      'blocks',
      'visibility',
      'general',
      'header',
      'footer',
      'loading',
      'ga4',
      'theme',
      'templates',
      'maintenance',
      'maintenance-teardown',
    ]);
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

describe('the switch the release-mode job sends', () => {
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

describe('the drill (tests/admin/releases-mode.e2e.ts, R14a)', () => {
  const drill = readFileSync('tests/admin/releases-mode.e2e.ts', 'utf8');
  const code = drill.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const migration = readFileSync('supabase/migrations/0112_release_schedule.sql', 'utf8');

  it('fires the minute cron through miniflare’s own trigger, and fails on its answer', () => {
    // wrangler's `/__scheduled` is a middleware it bundles into the Worker, and the Astro
    // adapter's build is no_bundle, so that path reached the site (a 404) and the scheduled
    // release never fired: the first rehearsal's poll timed out on it.
    expect(code).toContain("page.request.get('/cdn-cgi/local/scheduled?cron=*+*+*+*+*')");
    expect(code).toMatch(/expect\(fired\.status\(\), await fired\.text\(\)\)\.toBe\(200\)/);
    expect(code).not.toContain('/__scheduled');
  });

  it('unschedules what is still scheduled before it starts and after it ends', () => {
    // A release a failed attempt left is a second "Scheduled" card on the retry, and fires with
    // the drill's own. The database's path, as the e2e Admin: 0112's signature.
    expect(migration).toContain(
      'create or replace function public.unschedule_release(p_actor uuid, p_role text, p_release uuid,',
    );
    expect(code).toMatch(/svc\.rpc\('unschedule_release', \{\s*p_actor: STAFF_IDS\.admin,/);
    const before = /test\.beforeAll\(async \(\) => \{\s*await unscheduleAll\(\);/;
    const after =
      /test\.afterAll\(async \(\) => \{\s*if \(!staffEnv\(\)\) return;\s*await unscheduleAll\(\);/;
    expect(code).toMatch(before);
    expect(code).toMatch(after);
  });
});
