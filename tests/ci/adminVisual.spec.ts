import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { greeting } from '@/lib/admin/dashboard/greeting';
import { agoLabel } from '@/lib/admin/notifications/ago';
import { STAFF_ROLES } from '../admin/staff';
import { captureRoutes } from '../admin/routes';
import {
  FRAMED,
  GREETING_HOLDERS,
  STEADY_GREETING,
  WHEN,
  frameFor,
  steadyGreeting,
} from '../visual/adminVisualSteady';

/*
 * The admin visual baselines (Admin v2 Z1, ui.md AV-34) stay out of every required gate:
 *   - .github/workflows/admin-visual.yml runs only by hand, read-only, with a timeout, is never a
 *     required check nor a need of the deploy, and is the releases-off e2e job of
 *     perf-seo-a11y.yml step for step up to the preview (since Admin v2 R14c the required e2e
 *     job runs in release mode, and the committed baselines are of releases off); after it, only
 *     the admin-visual project runs, with ADMIN_VISUAL set;
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
  permissions?: unknown;
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

const text = (file: string) => readFileSync(`.github/workflows/${file}`, 'utf8');
const load = (file: string) => parse(text(file)) as Workflow;
const visual = load('admin-visual.yml');
const gates = load('perf-seo-a11y.yml');
const ci = load('ci.yml');
const job = visual.jobs['admin-visual']!;
/**
 * The job the baselines are made beside: the releases-off e2e job (Admin v2 R14c). Before R14c
 * it was the e2e job itself; R14c moved that one to release mode and kept this one as it was, so
 * the committed baselines (#142, made releases off) still compare. Re-baselining in release mode
 * is a separate, owner-approved step: set E2E_RELEASES in admin-visual.yml (its psql client and
 * the switch then follow, playwright.config.ts) and commit the new pictures.
 */
const e2e = gates.jobs['e2e-releases-off']!;

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

/** `{ contents: 'read' }` or a narrower grant: no scope above `read`. */
const isReadOnly = (grant: unknown) =>
  grant !== null &&
  typeof grant === 'object' &&
  Object.values(grant as Record<string, unknown>).every(
    (level) => level === 'read' || level === 'none',
  );

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

  it('gives the job no rights of its own and no repository secret, in any step', () => {
    // The top-level read-only grant is the job's: a job-level `permissions` would replace it.
    expect(job.permissions === undefined || isReadOnly(job.permissions), 'job permissions').toBe(
      true,
    );
    // The stack runs on the ci-dummy keys (the env above); nothing reads a repository secret,
    // nor the token's write scopes, in the steps after the preview either.
    expect(text('admin-visual.yml')).not.toMatch(/\bsecrets\s*\./);
    expect(text('admin-visual.yml')).not.toMatch(/\bsecrets\s*\[/);
    expect(text('admin-visual.yml')).not.toMatch(/github\.token|GITHUB_TOKEN/);
  });

  it('is the releases-off e2e job step for step up to the preview, the same pins included', () => {
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

  it('is said to take the releases-off job’s env wherever a comment says whose (review R14C-CS-1)', () => {
    // playwright.config.ts and the spec explain which mode the baselines picture; since R14c the
    // workflow is held to `e2e-releases-off` (above), not to the required, release-mode job.
    for (const file of ['playwright.config.ts', SPEC]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain("releases-off e2e job's (`e2e-releases-off`");
      expect(src, file).not.toMatch(/env is the e2e job's/);
    }
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

  async function projects(mode: string, releases = false) {
    vi.resetModules();
    vi.stubEnv('ADMIN_VISUAL', mode);
    vi.stubEnv('E2E_RELEASES', releases ? 'on' : '');
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

  it('releases on as well (R14b; once admin-visual.yml sets E2E_RELEASES): after the switch, never beside it', async () => {
    for (const mode of ['update', 'compare']) {
      const { list } = await projects(mode, true);
      const names = list.map((p) => p.name);
      const project = list.find((p) => p.name === 'admin-visual');
      expect(project, mode).toBeDefined();
      // releases-on (tests/admin/releases.setup.ts) runs after the sample rows itself.
      expect(project!.dependencies).toEqual(['releases-on']);
      expect(names.indexOf('releases-on')).toBeGreaterThan(-1);
      expect(project!.snapshotPathTemplate).toBe('{testDir}/admin-baselines/{platform}/{arg}{ext}');
      // Every other project is the release-mode chain's, field for field.
      const { list: on } = await projects('', true);
      expect(list.filter((p) => p.name !== 'admin-visual')).toEqual(on);
      // And the drill, the section blocks and the chain after them are never its dependencies.
      expect(on.find((p) => p.name === 'blocks')!.dependencies).toEqual(['releases-mode']);
    }
  });

  it('the spec is a file the required job never collects', async () => {
    expect(existsSync(SPEC)).toBe(true);
    // Nor does any project of the required job match it by its own pattern, in either release
    // mode (R14b: the section blocks' project exists in both).
    for (const releases of [false, true]) {
      const { config } = await projects('', releases);
      expect(config.testMatch).toBe('**/*.e2e.ts');
      expect(SPEC.endsWith('.e2e.ts')).toBe(false);
      for (const project of config.projects ?? []) {
        const match = project.testMatch;
        if (match instanceof RegExp) {
          expect(match.test(`/repo/${SPEC}`), `${project.name} (releases ${releases})`).toBe(false);
        }
      }
    }
  });
});

describe('the dashboard greeting in the baselines (tests/visual/adminVisualSteady.ts)', () => {
  // The greeting is written on the server by the studio's hour, so a baseline made in the
  // morning would fail a compare run in the evening unless the picture holds it steady.
  it('reads the same at every hour of the day', () => {
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 10, 5, hour, 30));
      const said = greeting(now, 'Amal Example', 'e2e-admin@example.com', 'UTC');
      expect(said).toMatch(/^Good (?:morning|afternoon|evening), Amal$/);
      seen.add(steadyGreeting(said));
    }
    expect([...seen]).toEqual([`${STEADY_GREETING}, Amal`]);
  });

  it('is rewritten where the dashboard prints it, before every picture', () => {
    expect(GREETING_HOLDERS).toContain('.admin-header h1');
    expect(GREETING_HOLDERS).toContain('.crumbs [aria-current="page"]');
    const head = readFileSync('src/components/admin/ui/PageHead.astro', 'utf8');
    expect(head).toMatch(
      /<header class="admin-header">[\s\S]*?<h1\b[^>]*>\{heading \?\? title\}<\/h1>/,
    );
    const top = readFileSync('src/components/admin/ui/Topbar.astro', 'utf8');
    expect(top).toMatch(/<nav class="crumbs"[\s\S]*?<li aria-current="page">\{title\}<\/li>/);
    const spec = readFileSync(SPEC, 'utf8');
    const steady = spec.indexOf('await steadyText(page);');
    expect(steady).toBeGreaterThan(0);
    expect(steady).toBeLessThan(spec.indexOf('toHaveScreenshot('));
  });
});

describe('the activity log’s frame in the baselines (R14d, adminVisualSteady.ts FRAMED)', () => {
  // The log grows with every write anywhere, the visual run's own included, so its list is held
  // in a fixed, masked frame; every other screen is pictured as it renders.
  it('frames exactly the activity log’s capture routes, and nothing else', () => {
    const framed: string[] = [];
    for (const role of STAFF_ROLES) {
      for (const route of captureRoutes(role)) {
        if (frameFor(route.path)) framed.push(`${role} ${route.path}`);
      }
    }
    expect(framed.sort()).toEqual([
      'admin /admin/audit',
      'admin /admin/audit?kind=leads&from=2026-01-01',
    ]);
    expect(Object.keys(FRAMED)).toEqual(['/admin/audit']);
  });

  it('holds the list’s card fixed and masked, and leaves the chain note out', () => {
    expect(frameFor('/admin/audit')).toEqual([
      { selector: '.act-note[data-tone="ok"]', hold: 'hidden' },
      { selector: '.card.dt', hold: 'fixed', blockSize: 480 },
    ]);
    // The regions are the markup's: the page's notes and its server table, whose card is the
    // one `.card.dt` on the page.
    const page = readFileSync('src/pages/admin/audit.astro', 'utf8');
    expect(page).toMatch(
      /<Note[\s\S]*?class="act-note"[\s\S]*?The latest \$\{result\.chain\.checked\} entries link up/,
    );
    expect(page.match(/<ServerTable\b/g)).toHaveLength(1);
    const table = readFileSync('src/components/admin/ui/ServerTable.astro', 'utf8');
    expect(table).toContain('<div class="card card--flush dt">');
  });

  it('leaves out only the chain note that links up: a broken chain and every other note stay in (review SEC-3)', () => {
    // A frame that hid every `.act-note` took the broken chain's alert ("Entry N does not link
    // to the one before it"), the export refusals and the dropped-filter note out of every
    // baseline. Only the `ok` note's words follow the count.
    const hidden = (frameFor('/admin/audit') ?? []).filter((r) => r.hold === 'hidden');
    expect(hidden.map((r) => r.selector)).toEqual(['.act-note[data-tone="ok"]']);
    const page = readFileSync('src/pages/admin/audit.astro', 'utf8');
    const tones = [...page.matchAll(/<Note\s+tone=(\{[^}]*\}|"[a-z]+")[^>]*class="act-note"/g)].map(
      (m) => m[1],
    );
    expect(tones).toEqual([
      '"warn"',
      '"err"',
      '"warn"',
      '"err"',
      "{result.chain.contiguous ? 'ok' : 'err'}",
    ]);
    // The tone is on the same element as the class, so the selector reads it.
    const note = readFileSync('src/components/admin/ui/Note.astro', 'utf8');
    expect(note).toContain("<div class:list={['note', className]} data-tone={tone} role={role}>");
  });

  it('frames the page after it has loaded and before the picture, the card masked too', () => {
    const spec = readFileSync(SPEC, 'utf8');
    const framing = spec.indexOf('if (framed) await frame(page, framed);');
    expect(framing).toBeGreaterThan(spec.indexOf('await steadyText(page);'));
    expect(framing).toBeLessThan(spec.indexOf('toHaveScreenshot('));
    expect(spec).toMatch(
      /mask: fixed\.length \? \[\.\.\.masks\(page\), page\.locator\(fixed\.join/,
    );
    // Through the CSSOM, never a style attribute (style-src has no 'unsafe-inline').
    expect(spec).toContain("el.style.setProperty('display', 'none')");
    expect(spec).not.toMatch(/setAttribute\(\s*'style'/);
  });
});

describe('relative times in the baselines (R14f, adminVisualSteady.ts WHEN)', () => {
  const NOW = Date.parse('2026-11-08T12:00:00Z');
  const SECONDS = [
    0,
    30,
    59,
    60,
    61,
    90,
    150,
    3_599,
    3_600,
    7_200,
    86_399,
    86_400,
    2 * 86_400,
    6 * 86_400,
    7 * 86_400,
    13 * 86_400,
    20 * 86_400,
    29 * 86_400,
    30 * 86_400,
    45 * 86_400,
    200 * 86_400,
    364 * 86_400,
    365 * 86_400,
    800 * 86_400,
  ];

  it('masks every label the bell and the Notifications page can print, past and future', () => {
    for (const s of SECONDS) {
      for (const sign of [-1, 1]) {
        const label = agoLabel(new Date(NOW + sign * s * 1000).toISOString(), NOW);
        expect(label, String(sign * s)).not.toBe('');
        expect(WHEN.test(label), `${sign * s}s: "${label}"`).toBe(true);
        // As printed: after the item's detail, " · ".
        expect(WHEN.test(`New inquiry · ${label}`), label).toBe(true);
      }
    }
  });

  it('still masks the short forms, and leaves ordinary words alone', () => {
    for (const label of [
      'just now',
      '5 min ago',
      'in 2 h',
      '3 d ago',
      'yesterday',
      '14:05',
      '8 Nov',
    ]) {
      expect(WHEN.test(label), label).toBe(true);
    }
    for (const word of [
      'Check now',
      'Back up now',
      'Notifications',
      'Minutes of the meeting',
      'Last name',
    ]) {
      expect(WHEN.test(word), word).toBe(false);
    }
  });

  it('is the one pattern the spec masks with', () => {
    const spec = readFileSync('tests/visual/admin.visual.ts', 'utf8');
    expect(spec).toContain('page.getByText(WHEN)');
    expect(spec).not.toMatch(/const WHEN\s*=/);
  });
});
