import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/*
 * The deploy pipeline's rules, as tests (CLAUDE.md §2, deploys amendment; launch runbook
 * §5a/§5b). ci.yml's `deploy` waits for EVERY gate, ships only main's head, runs the guard
 * before any dependency code, and keeps each secret in the one step that uses it; the gate
 * workflows it calls run only when called; and .github/branch-protection.json requires
 * exactly the checks the workflows produce — a renamed job would otherwise leave a required
 * context that never reports, and every PR would wait on it forever.
 *
 * Parsed with `yaml` (YAML 1.2, so `on:` stays a key and the anchors resolve as GitHub does).
 */

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  'runs-on'?: string;
  uses?: string;
  secrets?: unknown;
  permissions?: unknown;
  env?: Record<string, unknown>;
  concurrency?: unknown;
  'continue-on-error'?: unknown;
  'timeout-minutes'?: number;
  steps?: Step[];
}
interface Workflow {
  on: string | string[] | Record<string, unknown>;
  permissions?: unknown;
  env?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
  jobs: Record<string, Job>;
}

const DIR = '.github/workflows';
const read = (file: string): string => readFileSync(`${DIR}/${file}`, 'utf8');
const load = (file: string): Workflow => parse(read(file)) as Workflow;
const triggers = (wf: Workflow): string[] =>
  typeof wf.on === 'string' ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on);

const ci = load('ci.yml');
const jobs = ci.jobs;
const deploy = jobs['deploy']!;
const deploySteps = deploy.steps ?? [];
const called: Record<string, Workflow> = {
  './.github/workflows/db-tests.yml': load('db-tests.yml'),
  './.github/workflows/perf-seo-a11y.yml': load('perf-seo-a11y.yml'),
};
const workflows: [string, Workflow][] = [['ci.yml', ci], ...Object.entries(called)];

const isPrOnly = (job: Job): boolean =>
  (job.if ?? '').trim().startsWith("github.event_name == 'pull_request'");
const isPushOnly = (job: Job): boolean =>
  (job.if ?? '').trim().startsWith("github.event_name == 'push'");

/** Every step of every job in the three files, labelled "<file> <job>: <step name>". */
const allSteps = workflows.flatMap(([file, wf]) =>
  Object.entries(wf.jobs).flatMap(([id, job]) =>
    (job.steps ?? []).map((step) => ({ label: `${file} ${id}: ${step.name ?? step.uses}`, step })),
  ),
);

describe('ci.yml — the deploy waits for every gate', () => {
  it('is the only workflow a push or a pull request starts (one run per commit)', () => {
    const started = readdirSync(DIR)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) =>
        triggers(load(file)).some((t) =>
          ['push', 'pull_request', 'pull_request_target'].includes(t),
        ),
      );
    expect(started).toEqual(['ci.yml']);
  });

  it('needs every job that runs on main, and no PR-only job (a skipped need skips it)', () => {
    const onMain = Object.keys(jobs).filter((id) => id !== 'deploy' && !isPrOnly(jobs[id]!));
    expect([deploy.needs ?? []].flat().sort()).toEqual(onMain.sort());
    // Named, so a new PR-only job is a deliberate choice.
    expect(Object.keys(jobs).filter((id) => isPrOnly(jobs[id]!))).toEqual([
      'migrations',
      'deploy-preflight',
      'deploy-guard-preview',
    ]);
    expect(Object.keys(jobs).filter((id) => isPushOnly(jobs[id]!))).toEqual(['deploy']);
  });

  it('deploys only on a push to main', () => {
    expect(deploy.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });

  it('queues deploys one at a time, never cancelling or replacing a waiting one', () => {
    expect(deploy.concurrency).toEqual({
      group: 'deploy-production',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });

  it('cancels superseded PR runs only — each main run is its own group', () => {
    // Exact: with the branches swapped, every main run would share one group, and a later
    // merge would cancel an earlier one still waiting to start.
    expect(ci.concurrency).toEqual({
      group:
        "${{ github.event_name == 'pull_request' && format('ci-pr-{0}', github.ref) || format('ci-main-{0}', github.run_id) }}",
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
  });

  it('checks freshness first, guards before any dependency code, deploys last', () => {
    const index = (match: (step: Step) => boolean): number => deploySteps.findIndex(match);
    expect(deploySteps.filter((step) => step.if !== undefined)).toEqual([]);
    expect(deploySteps[0]?.uses).toMatch(/^actions\/checkout@/);
    expect(deploySteps[1]?.name).toMatch(/^Freshness/);
    expect(deploySteps[1]?.run).toContain('commits/main');
    expect(deploySteps[1]?.run).toContain('"$GITHUB_SHA"');

    const guard = index((step) => step.run === 'bash scripts/deploy-guard.sh');
    const setupNode = index((step) => step.uses?.startsWith('actions/setup-node@') ?? false);
    const npmCi = index((step) => step.run === 'npm ci');
    const optOut = index((step) => step.run?.includes('ALLOW_LOCAL_SITE_URL') ?? false);
    const build = index((step) => step.run === 'npm run build');
    expect(guard).toBeGreaterThan(1);
    expect(guard).toBeLessThan(setupNode);
    expect(setupNode).toBeLessThan(npmCi);
    expect(npmCi).toBeLessThan(optOut);
    expect(optOut).toBeLessThan(build);
    expect(build).toBe(deploySteps.length - 2);
    expect(deploySteps.at(-1)?.run).toMatch(
      /\nnpx --no wrangler deploy --tag "\$\{GITHUB_SHA:0:12\}" --message "ci \$\{GITHUB_SHA\} run \$\{GITHUB_RUN_ID\}"\n?$/,
    );
    expect(read('ci.yml')).not.toContain('wrangler@');
  });

  it('keeps each secret in the one step that uses it — none in a workflow or job env', () => {
    for (const [file, wf] of workflows) {
      expect(JSON.stringify(wf.env ?? {}), `${file}: env`).not.toMatch(/secrets\.|github\.token/);
      for (const [id, job] of Object.entries(wf.jobs)) {
        expect(JSON.stringify(job.env ?? {}), `${file} ${id}: env`).not.toMatch(
          /secrets\.|github\.token/,
        );
        expect(job.secrets, `${file} ${id}: secrets handed to a called workflow`).toBeUndefined();
      }
    }
    const carrying = (pattern: RegExp): string[] =>
      allSteps.filter(({ step }) => pattern.test(JSON.stringify(step))).map(({ label }) => label);
    expect(carrying(/secrets\./).sort()).toEqual([
      'ci.yml deploy-guard-preview: Deploy guard — production has every migration',
      'ci.yml deploy: Deploy (wrangler)',
      'ci.yml deploy: Deploy guard — production has every migration',
    ]);
    expect(carrying(/github\.token|GITHUB_TOKEN/)).toEqual([
      "ci.yml deploy: Freshness — deploy only main's current head",
    ]);
  });

  it('runs no dependency code where the preview guard holds its secret', () => {
    const preview = jobs['deploy-guard-preview']!;
    expect(preview.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(preview.if).toContain('github.actor == github.repository_owner');
    for (const step of preview.steps ?? []) {
      expect(step.uses ?? '').not.toMatch(/setup-node/);
      expect(step.run ?? '').not.toMatch(/\bnp[mx]\b/);
    }
    // The same two guard steps the deploy runs.
    expect(preview.steps?.slice(1)).toEqual(
      deploySteps.filter((step) => /^(psql|Deploy guard)/.test(step.name ?? '')),
    );
  });

  it('calls the two gate workflows, passing them no secrets', () => {
    const callers = Object.entries(jobs)
      .filter(([, job]) => job.uses !== undefined)
      .map(([id, job]) => [id, job.uses]);
    expect(callers).toEqual([
      ['db-tests', './.github/workflows/db-tests.yml'],
      ['perf-seo-a11y', './.github/workflows/perf-seo-a11y.yml'],
    ]);
  });

  it('pins every action in the deploy jobs to a commit, with no persisted git credentials', () => {
    for (const id of ['deploy', 'deploy-preflight', 'deploy-guard-preview']) {
      const actions = (jobs[id]!.steps ?? []).filter((step) => step.uses !== undefined);
      expect(actions.length, id).toBeGreaterThan(0);
      for (const step of actions) {
        expect(step.uses, id).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        if (step.uses?.startsWith('actions/checkout@')) {
          expect(step.with?.['persist-credentials'], id).toBe(false);
        }
      }
    }
  });

  it('builds the production origin: never the local-preview opt-out, never a local host', () => {
    const envs = [ci.env, ...Object.values(jobs).flatMap((job) => [job.env])]
      .concat(Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => step.env)))
      .filter((env): env is Record<string, unknown> => env !== undefined);
    const origins: string[] = [];
    for (const env of envs) {
      expect(Object.keys(env)).not.toContain('ALLOW_LOCAL_SITE_URL');
      if (typeof env['PUBLIC_SITE_URL'] === 'string') origins.push(env['PUBLIC_SITE_URL']);
    }
    expect(origins.length).toBeGreaterThanOrEqual(2);
    for (const origin of origins) {
      const { protocol, hostname } = new URL(origin);
      expect(protocol, origin).toBe('https:');
      expect(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'], origin).not.toContain(hostname);
      // The one-i spelling is a domain nobody registered.
      expect(hostname, origin).not.toMatch(/(^|\.)braiinstation\.com$/);
    }
    expect(jobs['deploy-preflight']!.env).toEqual(deploy.env);
  });
});

describe('the gate workflows ci.yml calls', () => {
  for (const [path, wf] of Object.entries(called)) {
    it(`${path}: runs only when called or by hand, unthrottled, every job gating`, () => {
      expect(triggers(wf).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
      expect(wf.concurrency).toBeUndefined();
      for (const [id, job] of Object.entries(wf.jobs)) {
        expect(job.concurrency, id).toBeUndefined();
        expect(job.if, id).toBeUndefined();
      }
    });
  }

  it('lets no step fail quietly except the design capture and its upload (not assertions)', () => {
    const tolerated = allSteps.filter(({ step }) => step['continue-on-error'] !== undefined);
    expect(tolerated.map(({ label }) => label)).toEqual([
      './.github/workflows/perf-seo-a11y.yml e2e: Design capture (full-page screenshots for the mockup comparison, not assertions)',
      './.github/workflows/perf-seo-a11y.yml e2e: Upload design capture',
    ]);
    for (const { step } of tolerated) expect(step['continue-on-error']).toBe(true);
  });
});

describe('every workflow', () => {
  const everyJob = workflows.flatMap(([file, wf]) =>
    Object.entries(wf.jobs).map(([id, job]) => ({ label: `${file} ${id}`, job })),
  );

  it('is read-only: the workflow and every job that sets its own permissions', () => {
    for (const [file, wf] of workflows) expect(wf.permissions, file).toEqual({ contents: 'read' });
    // A job's `permissions` replaces the workflow's — a calling job's, for the jobs it calls.
    for (const { label, job } of everyJob) {
      if (job.permissions === undefined) continue; // the workflow's applies
      expect(job.permissions, label).toEqual({ contents: 'read' });
    }
  });

  it('lets no job fail quietly: a job allowed to fail is no gate', () => {
    for (const { label, job } of everyJob) expect(job['continue-on-error'], label).toBeUndefined();
  });

  it('has a timeout on every job that runs', () => {
    for (const { label, job } of everyJob) {
      if (job['runs-on'] === undefined) continue; // a call: its jobs carry their own
      expect(job['timeout-minutes'], label).toBeGreaterThan(0);
      expect(job['timeout-minutes'], label).toBeLessThanOrEqual(60);
    }
  });
});

describe('.github/branch-protection.json — the required checks', () => {
  const protection = JSON.parse(readFileSync('.github/branch-protection.json', 'utf8')) as {
    required_status_checks: { strict: boolean; checks: { context: string; app_id: number }[] };
    enforce_admins: boolean;
    required_pull_request_reviews: { required_approving_review_count: number };
    allow_force_pushes: boolean;
    allow_deletions: boolean;
  };

  it('are exactly the checks a PR run produces (bar the owner-only guard preview)', () => {
    const produced = Object.entries(jobs)
      .filter(([id, job]) => !isPushOnly(job) && id !== 'deploy-guard-preview')
      .flatMap(([id, job]) => {
        const name = job.name ?? id;
        if (job.uses === undefined) return [name];
        return Object.entries(called[job.uses]!.jobs).map(
          ([cid, cjob]) => `${name} / ${cjob.name ?? cid}`,
        );
      });
    const required = protection.required_status_checks.checks.map((check) => check.context);
    expect(required.sort()).toEqual(produced.sort());
  });

  it('binds admins too: strict, PRs only, no force-push or deletion, checks from Actions', () => {
    expect(protection.required_status_checks.strict).toBe(true);
    expect(protection.enforce_admins).toBe(true);
    expect(protection.required_pull_request_reviews.required_approving_review_count).toBe(0);
    expect(protection.allow_force_pushes).toBe(false);
    expect(protection.allow_deletions).toBe(false);
    // 15368 is the GitHub Actions app: a status posted with a token cannot stand in for a check.
    for (const check of protection.required_status_checks.checks) expect(check.app_id).toBe(15368);
  });
});
