import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The admin visual baselines (Admin v2 Z1, ui.md AV-34) stay out of every required gate:
 *   - .github/workflows/admin-visual.yml runs only by hand, read-only, with a timeout, is never a
 *     required check nor a need of the deploy, and is the e2e job of perf-seo-a11y.yml step for
 *     step up to the preview; after it, only the admin-visual project runs, with ADMIN_VISUAL set;
 *   - playwright.config.ts adds that project only while ADMIN_VISUAL is `update` or `compare`,
 *     after the sample rows, its baselines kept per platform; and the spec's file name is one the
 *     root testMatch (`**\/*.e2e.ts`) never collects, so the required job cannot run it.
 */

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
}
interface Job {
  name?: string;
  uses?: string;
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
const visual = load('admin-visual.yml');
const gates = load('perf-seo-a11y.yml');
const ci = load('ci.yml');
const job = visual.jobs['admin-visual']!;
const e2e = gates.jobs['e2e']!;

const actionOf = (uses: string | undefined) => (uses === undefined ? null : uses.split('@')[0]!);
const acts = (step: Step) => ({
  name: step.name ?? null,
  uses: step.uses ?? null,
  run: step.run ?? null,
  with: step.with ?? null,
  if: step.if ?? null,
  timeout: step['timeout-minutes'] ?? null,
});

const SPEC = 'tests/visual/admin.visual.ts';

describe('.github/workflows/admin-visual.yml', () => {
  it('runs only by hand (a mode to choose), read-only, one job with a timeout', () => {
    const on = visual.on as Record<string, { inputs?: Record<string, { options?: string[] }> }>;
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    expect(on['workflow_dispatch']?.inputs?.['mode']?.options?.sort()).toEqual([
      'compare',
      'update',
    ]);
    expect(visual.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(visual.jobs)).toEqual(['admin-visual']);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
    expect(visual.env).toEqual(gates.env);
    expect(job.env).toEqual(e2e.env);
  });

  it('is the e2e job step for step up to the preview, the same pins included', () => {
    const steps = job.steps ?? [];
    const upTo = (list: Step[]) =>
      list.slice(0, list.findIndex((step) => step.name === 'Wait for preview') + 1);
    expect(upTo(e2e.steps ?? []).length).toBeGreaterThan(5);
    expect(upTo(steps).map(acts)).toEqual(upTo(e2e.steps ?? []).map(acts));
  });

  it('then runs the admin-visual project alone, with ADMIN_VISUAL set, and nothing quietly', () => {
    const steps = job.steps ?? [];
    const after = steps.slice(steps.findIndex((step) => step.name === 'Wait for preview') + 1);
    const runs = after.filter((step) => step.run?.includes('playwright test'));
    expect(runs.length).toBe(3);
    for (const step of runs) {
      expect(step.run).toContain('--project=admin-visual');
      expect(['update', 'compare']).toContain(step.env?.['ADMIN_VISUAL']);
      expect(step.run).toMatch(/--update-snapshots=(all|none)/);
    }
    // update makes them (all), then a second run compares (none): stable across two runs.
    const update = runs.filter((step) => step.if === "inputs.mode == 'update'");
    expect(update.map((step) => step.run!.match(/--update-snapshots=(\w+)/)![1])).toEqual([
      'all',
      'none',
    ]);
    for (const step of steps) expect(step['continue-on-error'], step.name).toBeUndefined();
    const uploads = after.filter((step) => actionOf(step.uses) === 'actions/upload-artifact');
    expect(uploads.map((step) => step.with?.['name'])).toEqual([
      'admin-visual-baselines',
      'admin-visual-report',
    ]);
    expect(uploads[0]!.with?.['path']).toBe('tests/visual/admin-baselines/linux');
  });

  it('is never a need of the deploy, nor a required check, nor called by ci.yml', () => {
    for (const [id, gate] of Object.entries(ci.jobs)) {
      expect(gate.uses ?? '', id).not.toContain('admin-visual');
    }
    const protection = readFileSync('.github/branch-protection.json', 'utf8');
    expect(protection).not.toContain('Admin visual');
    expect(protection).not.toContain('admin-visual');
  });
});

describe('playwright.config.ts and the admin-visual project', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function projects(mode: string) {
    vi.resetModules();
    vi.stubEnv('ADMIN_VISUAL', mode);
    vi.stubEnv('E2E_RELEASES', '');
    const { default: config } = await import('../../playwright.config');
    return { config, list: config.projects ?? [] };
  }

  it('unset (the required e2e job), or any other value: no admin-visual project', async () => {
    for (const mode of ['', 'on', 'true']) {
      const { list } = await projects(mode);
      expect(
        list.map((p) => p.name),
        mode,
      ).not.toContain('admin-visual');
    }
  });

  it('set: the project after the sample rows, its baselines kept per platform', async () => {
    for (const mode of ['update', 'compare']) {
      const { list } = await projects(mode);
      const project = list.find((p) => p.name === 'admin-visual');
      expect(project, mode).toBeDefined();
      expect(project!.dependencies).toEqual(['admin-samples']);
      expect(project!.testDir).toBe('./tests/visual');
      expect((project!.testMatch as RegExp).test(`/repo/${SPEC}`)).toBe(true);
      expect(project!.snapshotPathTemplate).toBe('{testDir}/admin-baselines/{platform}/{arg}{ext}');
      // Every other project is what it is while unset.
      const { list: unset } = await projects('');
      expect(list.filter((p) => p.name !== 'admin-visual')).toEqual(unset);
    }
  });

  it('the spec is a file the required job never collects', async () => {
    expect(existsSync(SPEC)).toBe(true);
    const { config } = await projects('');
    expect(config.testMatch).toBe('**/*.e2e.ts');
    expect(SPEC.endsWith('.e2e.ts')).toBe(false);
    // Nor does any project of the required job match it by its own pattern.
    for (const project of config.projects ?? []) {
      const match = project.testMatch;
      if (match instanceof RegExp) expect(match.test(`/repo/${SPEC}`), project.name).toBe(false);
    }
  });
});
