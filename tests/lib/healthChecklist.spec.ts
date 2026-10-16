import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { reachableHrefs } from '@/lib/admin/nav';
import {
  HEALTH_GROUPS,
  HEALTH_RULES,
  byGroup,
  fixFor,
  mayCheck,
  runChecklist,
  tally,
  type ContentHealth,
  type HealthContext,
  type HealthRule,
} from '@/lib/admin/health/checklist';
import { ADMIN_PRIVATE, securityFacts } from '@/lib/admin/health/security';
import { SEO_BUILT_IN } from '@/lib/admin/health/seo';
import { loadHealthReport, loadHealthSummary } from '@/lib/admin/health/summary';
import type { VitalsReport } from '@/lib/admin/health/vitals';
import { pageFileFor } from '../admin/routes';

const { logs } = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

// The site health checklist (Admin v2 U2, src/lib/admin/health/checklist.ts): every rule in
// each of its states on a fixture, the gating by capability (a role is never shown a count
// its RLS would have hidden, and never sent to a screen it cannot open), the security and
// SEO facts held to the code that makes them true, and the loader reading only what the
// role may read.

const CLEAN: ContentHealth = {
  placeholdersLive: 0,
  missingAlt: 0,
  consentMissing: 0,
  published: 12,
  ownDescription: 4,
  missingArabic: 0,
  defaultDescriptionEn: true,
  defaultDescriptionAr: true,
};

const vitalsWith = (samples: number, lcp: number, inp: number, cls: number): VitalsReport => ({
  days: 28,
  from: '2026-09-18',
  rolledUpAt: '2026-10-15T00:07:00Z',
  rows: [
    { path: '*', metric: 'LCP', samples, p75: lcp, approx: true, open: false },
    { path: '*', metric: 'INP', samples, p75: inp, approx: true, open: false },
    { path: '*', metric: 'CLS', samples, p75: cls, approx: true, open: false },
  ],
});

function ctx(overrides: Partial<HealthContext> = {}): HealthContext {
  return {
    role: 'admin',
    vitals: vitalsWith(500, 1800, 120, 0.02),
    content: CLEAN,
    errors7d: 0,
    lastBackup: null,
    now: Date.parse('2026-10-15T12:00:00Z'),
    ...overrides,
  };
}

const rule = (id: string): HealthRule => {
  const found = HEALTH_RULES.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
};
const outcome = (id: string, c: HealthContext = ctx()) => rule(id).evaluate(c);

describe('the registry', () => {
  it('has unique ids, known groups, and a title for every rule', () => {
    expect(new Set(HEALTH_RULES.map((r) => r.id)).size).toBe(HEALTH_RULES.length);
    for (const r of HEALTH_RULES) {
      expect(HEALTH_GROUPS).toContain(r.group);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  it('checks every group the design lists', () => {
    expect(new Set(HEALTH_RULES.map((r) => r.group))).toEqual(new Set(HEALTH_GROUPS));
  });

  it('names only capabilities ROLE_CAPS knows', () => {
    for (const r of HEALTH_RULES) {
      for (const cap of [...r.needs, ...(r.fixCaps ?? [])]) {
        expect(Object.keys(ROLE_CAPS.admin), `${r.id}: ${cap}`).toContain(cap);
      }
    }
  });

  it('every fix link is an admin page', () => {
    for (const r of HEALTH_RULES.filter((x) => x.fix)) {
      expect(() => pageFileFor(r.fix!), r.id).not.toThrow();
    }
  });

  it('no line uses a dash the copy rules forbid (P-12)', () => {
    const results = [
      ...runChecklist(ctx()),
      ...runChecklist(ctx({ role: 'content_creator' })),
      ...runChecklist(
        ctx({
          content: {
            ...CLEAN,
            placeholdersLive: 2,
            missingAlt: 1,
            consentMissing: 3,
            missingArabic: 1,
          },
          vitals: vitalsWith(10, 1, 1, 0),
          errors7d: 4,
          lastBackup: { at: '2026-10-01T10:00:00Z', status: 'partial', rows: 1200 },
        }),
      ),
    ];
    for (const r of results) expect(`${r.text} ${r.detail ?? ''}`).not.toMatch(/[–—]/);
  });
});

describe('each rule, state by state', () => {
  it('design placeholders: fail with the count, ok with none, unknown when unread', () => {
    expect(outcome('content.placeholders')).toMatchObject({ state: 'ok' });
    expect(
      outcome('content.placeholders', ctx({ content: { ...CLEAN, placeholdersLive: 3 } })),
    ).toMatchObject({
      state: 'fail',
      count: 3,
      text: '3 design placeholders are live on the site',
    });
    expect(
      outcome('content.placeholders', ctx({ content: { ...CLEAN, placeholdersLive: 1 } })).text,
    ).toBe('1 design placeholder is live on the site');
    expect(outcome('content.placeholders', ctx({ content: null })).state).toBe('unknown');
  });

  it('alt text', () => {
    expect(outcome('content.alt').state).toBe('ok');
    expect(outcome('content.alt', ctx({ content: { ...CLEAN, missingAlt: 2 } }))).toMatchObject({
      state: 'fail',
      text: '2 published projects have images without alt text',
    });
    expect(outcome('content.alt', ctx({ content: null })).state).toBe('unknown');
  });

  it('consent', () => {
    expect(outcome('content.consent').state).toBe('ok');
    expect(
      outcome('content.consent', ctx({ content: { ...CLEAN, consentMissing: 1 } })),
    ).toMatchObject({
      state: 'fail',
      text: '1 testimonial is placed on a page without consent recorded',
    });
  });

  it('Arabic search text', () => {
    expect(outcome('seo.arabic').state).toBe('ok');
    expect(outcome('seo.arabic', ctx({ content: { ...CLEAN, missingArabic: 2 } }))).toMatchObject({
      state: 'fail',
      count: 2,
    });
  });

  it('the default description names the missing language', () => {
    expect(outcome('seo.default-description').state).toBe('ok');
    expect(
      outcome(
        'seo.default-description',
        ctx({ content: { ...CLEAN, defaultDescriptionAr: false } }),
      ).text,
    ).toBe("The site's default description is missing in Arabic");
    expect(
      outcome(
        'seo.default-description',
        ctx({ content: { ...CLEAN, defaultDescriptionEn: false, defaultDescriptionAr: false } }),
      ).text,
    ).toBe("The site's default description is missing in English and Arabic");
  });

  it('page descriptions are information, never a failure', () => {
    expect(outcome('seo.own-descriptions')).toMatchObject({
      state: 'info',
      text: '4 of 12 published pages have a search description of their own',
    });
  });

  it('speed: within budget is ok, over is a failure, few visits unknown, never read unknown', () => {
    expect(outcome('speed.lcp').state).toBe('ok');
    expect(outcome('speed.lcp').detail).toBe('3 visits in 4 were at 1.8 s or better.');
    const slow = outcome('speed.lcp', ctx({ vitals: vitalsWith(500, 3000, 120, 0.02) }));
    expect(slow).toMatchObject({ state: 'fail', text: 'Largest paint (LCP) is over budget' });
    expect(slow.detail).toBe('3 visits in 4 were at 3.0 s or better; the budget is 2.5 s.');
    expect(outcome('speed.inp', ctx({ vitals: vitalsWith(49, 1, 900, 0) }))).toMatchObject({
      state: 'unknown',
      text: 'Response to a tap (INP): not enough visits yet to judge',
      count: 49,
    });
    expect(outcome('speed.cls', ctx({ vitals: null })).state).toBe('unknown');
    expect(outcome('speed.cls', ctx({ vitals: vitalsWith(500, 1, 1, 0.1) })).state).toBe('ok');
    expect(outcome('speed.cls', ctx({ vitals: vitalsWith(500, 1, 1, 0.125) })).state).toBe('fail');
  });

  it('an open bucket says "over"', () => {
    const report = vitalsWith(500, 20000, 1, 0);
    report.rows[0] = { ...report.rows[0]!, open: true };
    expect(outcome('speed.lcp', ctx({ vitals: report })).detail).toBe(
      'More than a quarter of visits were over 20.0 s; the budget is 2.5 s.',
    );
  });

  it('errors in 7 days', () => {
    expect(outcome('errors.recent')).toMatchObject({
      state: 'ok',
      text: 'No errors logged in the last 7 days',
    });
    expect(outcome('errors.recent', ctx({ errors7d: 1 })).text).toBe(
      '1 error logged in the last 7 days',
    );
    expect(outcome('errors.recent', ctx({ errors7d: null })).state).toBe('unknown');
  });

  it('backups are information only, until they are scheduled', () => {
    expect(outcome('backups.last')).toMatchObject({
      state: 'info',
      text: 'No backup export recorded yet',
    });
    const last = outcome(
      'backups.last',
      ctx({ lastBackup: { at: '2026-10-01T10:00:00Z', status: 'ok', rows: 1200 } }),
    );
    expect(last.state).toBe('info');
    expect(last.text).toMatch(/^Last backup export .+, complete$/);
    expect(outcome('backups.last', ctx({ lastBackup: undefined })).state).toBe('unknown');
  });

  it('security facts pass on this build', () => {
    for (const id of ['security.csp', 'security.hsts', 'security.admin', 'security.crawlers']) {
      expect(outcome(id).state, id).toBe('ok');
    }
  });
});

describe('gated by capability (README D4)', () => {
  it('a role is checked on a rule only when it holds one of its needs', () => {
    for (const role of ROLES) {
      for (const r of HEALTH_RULES) {
        const holds = r.needs.some((cap) => ROLE_CAPS[role][cap] === 'full');
        expect(mayCheck(role, r), `${role} ${r.id}`).toBe(r.needs.length === 0 || holds);
      }
    }
  });

  it('a rule the role may not check says so, is never evaluated, and never counts', () => {
    const evaluate = vi.fn(() => ({ state: 'fail' as const, text: 'should not run' }));
    const guarded: HealthRule = {
      id: 'x.guarded',
      group: 'Errors',
      title: 'A guarded rule',
      needs: ['logs.view'],
      evaluate,
    };
    const [result] = runChecklist(ctx({ role: 'content_creator' }), [guarded]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      checked: false,
      state: 'unknown',
      text: 'A guarded rule: not checked for your role',
      fix: null,
    });
    expect(tally([result!])).toEqual({ ok: 0, judged: 0 });
  });

  it('Content Creator and SEO are not checked on speed, errors or backups', () => {
    for (const role of ['content_creator', 'seo'] as Role[]) {
      const results = runChecklist(ctx({ role }));
      for (const id of ['speed.lcp', 'speed.inp', 'speed.cls', 'errors.recent', 'backups.last']) {
        expect(results.find((r) => r.id === id)?.checked, `${role} ${id}`).toBe(false);
      }
    }
  });

  it('Admin and Developer are checked on every rule', () => {
    for (const role of ['admin', 'developer'] as Role[]) {
      expect(
        runChecklist(ctx({ role })).every((r) => r.checked),
        role,
      ).toBe(true);
    }
  });
});

describe('fix links', () => {
  const failing = ctx({
    content: {
      ...CLEAN,
      placeholdersLive: 1,
      missingAlt: 1,
      consentMissing: 1,
      missingArabic: 1,
      defaultDescriptionAr: false,
    },
    vitals: vitalsWith(500, 9000, 900, 0.5),
    errors7d: 2,
  });

  it('show only on a failing row', () => {
    for (const r of runChecklist(ctx())) expect(r.fix, r.id).toBeNull();
  });

  it('go only to screens the role reaches from its menu', () => {
    for (const role of ROLES) {
      for (const r of runChecklist({ ...failing, role })) {
        if (!r.fix) continue;
        const screen = r.fix.split('?')[0]!;
        expect(reachableHrefs(role), `${role} ${r.id} → ${r.fix}`).toContain(screen);
      }
    }
  });

  it('Admin is sent to every fix', () => {
    const fixes = Object.fromEntries(runChecklist(failing).map((r) => [r.id, r.fix]));
    expect(fixes).toMatchObject({
      'content.placeholders': '/admin',
      'content.alt': '/admin/media',
      'content.consent': '/admin/testimonials',
      'seo.default-description': '/admin/seo',
      'speed.lcp': '/admin/site-health?tab=speed',
      'errors.recent': '/admin/site-health?tab=errors',
    });
    expect(fixes['seo.arabic']).toBeNull(); // no per-page SEO screen yet
  });

  it('Developer is not sent to screens that do not show it the problem', () => {
    const fixes = Object.fromEntries(
      runChecklist({ ...failing, role: 'developer' }).map((r) => [r.id, r.fix]),
    );
    // The dashboard lists placeholders to the content roles only; testimonials and SEO
    // defaults are not in a Developer's menu.
    expect(fixes['content.placeholders']).toBeNull();
    expect(fixes['content.consent']).toBeNull();
    expect(fixes['seo.default-description']).toBeNull();
    expect(fixes['content.alt']).toBe('/admin/media');
    expect(fixes['errors.recent']).toBe('/admin/site-health?tab=errors');
    expect(fixFor('developer', rule('speed.lcp'))).toBe('/admin/site-health?tab=speed');
  });
});

describe('grouping and tallies', () => {
  it('groups in the design’s order and counts only ok and fail', () => {
    const results = runChecklist(ctx({ errors7d: 3 }));
    expect(byGroup(results).map((g) => g.group)).toEqual([...HEALTH_GROUPS]);
    const errors = byGroup(results).find((g) => g.group === 'Errors')!;
    expect(tally(errors.results)).toEqual({ ok: 0, judged: 1 });
    const backups = byGroup(results).find((g) => g.group === 'Backups')!;
    expect(tally(backups.results)).toEqual({ ok: 0, judged: 0 });
  });
});

describe('the facts are true of the code', () => {
  const source = (path: string) => readFileSync(path, 'utf8');

  it('the admin is private: no-store from the middleware, noindex from the layout', () => {
    expect(ADMIN_PRIVATE).toBe(true);
    const middleware = source('src/middleware.ts');
    expect(middleware).toContain(
      "const PRIVATE_CACHE = 'private, no-store, max-age=0, must-revalidate';",
    );
    expect(middleware).toMatch(/isPrivate\) out\.headers\.set\('Cache-Control', PRIVATE_CACHE\)/);
    expect(source('src/layouts/AdminLayout.astro')).toContain(
      '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet" />',
    );
  });

  it('the security rows read the constants they describe', () => {
    const facts = Object.fromEntries(securityFacts().map((f) => [f.id, f]));
    expect(facts['csp']?.ok).toBe(true);
    expect(source('src/lib/http/securityHeaders.ts')).toContain(
      'export const CSP_REPORT_ONLY = false;',
    );
    expect(facts['hsts']?.ok).toBe(true);
    expect(facts['crawlers']?.detail).toMatch(/^6 training crawlers are refused/);
  });

  it('the SEO built-in rows name what the code does', () => {
    const ids = SEO_BUILT_IN.map((f) => f.id);
    expect(ids).toEqual(['sitemap', 'hreflang', 'robots', 'schema']);
    const sitemap = source('src/pages/sitemap.xml.ts');
    for (const loader of ['getPublishedServices', 'getCaseStudyIndex', 'getPublishedPosts']) {
      expect(sitemap).toContain(loader);
    }
    expect(source('src/components/SeoHead.astro')).toContain('hreflangAlternates');
    expect(source('src/pages/robots.txt.ts')).toContain("'Disallow: /admin'");
    expect(existsSync('tests/seo/jsonld.spec.ts')).toBe(true);
  });
});

// ── The loader: what it reads, for whom ─────────────────────────────────────────────────

interface Call {
  kind: 'rpc' | 'from';
  name: string;
  args?: unknown;
  filters: [string, unknown][];
}

/** A stub client recording each read; `fail` names reads that answer an error. */
function stub(fail: readonly string[] = []) {
  const calls: Call[] = [];
  const answer = (name: string) =>
    fail.includes(name) ? { data: null, error: { message: `${name} refused` }, count: null } : null;
  const sb = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: 'rpc', name, args, filters: [] });
      const failed = answer(name);
      if (failed) return failed;
      if (name === 'vitals_summary') {
        return {
          data: {
            days: 28,
            from: '2026-09-18',
            rolled_up_at: '2026-10-15T00:07:00Z',
            rows: [
              { path: '*', metric: 'LCP', samples: 200, p75: 2000, approx: true, open: false },
              { path: '*', metric: 'INP', samples: 200, p75: 150, approx: true, open: false },
              { path: '*', metric: 'CLS', samples: 200, p75: 0.3, approx: true, open: false },
            ],
          },
          error: null,
        };
      }
      return {
        data: {
          placeholders_live: 1,
          missing_alt: 0,
          consent_missing: 0,
          published: 9,
          own_description: 2,
          missing_arabic: 0,
          default_description_en: true,
          default_description_ar: true,
        },
        error: null,
      };
    },
    from: (name: string) => {
      const call: Call = { kind: 'from', name, filters: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'gte']) builder[m] = () => builder;
      builder['eq'] = (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return builder;
      };
      builder['then'] = (resolve: (v: unknown) => unknown) =>
        resolve(
          answer(name) ??
            (name === 'system_logs'
              ? { data: null, error: null, count: 5 }
              : {
                  data: [
                    {
                      created_at: '2026-10-10T09:00:00Z',
                      detail: { status: 'ok', rows: 340 },
                    },
                  ],
                  error: null,
                }),
        );
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const authOf = (role: Role): AuthContext => ({
  userId: 'u1',
  tenantId: 't1',
  role,
  isActive: true,
  email: `${role}@example.test`,
});

describe('loadHealthReport', () => {
  it('Admin: reads vitals, the counts, the errors and the last backup, each for its tenant', async () => {
    const { sb, calls } = stub();
    const report = await loadHealthReport(sb, authOf('admin'), Date.parse('2026-10-15T12:00:00Z'));
    expect(calls.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      'from:audit_log',
      'from:system_logs',
      'rpc:content_health',
      'rpc:vitals_summary',
    ]);
    for (const c of calls) {
      if (c.kind === 'rpc') expect(c.args).toMatchObject({ p_tenant: 't1' });
      else expect(c.filters).toContainEqual(['tenant_id', 't1']);
    }
    expect(calls.find((c) => c.name === 'system_logs')?.filters).toContainEqual(['level', 'error']);
    expect(calls.find((c) => c.name === 'audit_log')?.filters).toContainEqual([
      'action',
      'export.backup.outcome',
    ]);
    expect(report.errors7d).toBe(5);
    expect(report.tiles.map((t) => [t.label, t.value])).toEqual([
      ['Largest paint (LCP)', '2.0 s'],
      ['Response to a tap (INP)', '150 ms'],
      ['Layout shift (CLS)', '0.30'],
      ['Errors, 7 days', '5'],
      ['Checklist', expect.stringMatching(/^\d+ \/ \d+$/)],
    ]);
    // LCP good (100), INP good (100), CLS poor (0): speed 66.7; the score has both halves.
    expect(report.score.vitalsPart).toBeCloseTo(66.67, 1);
    expect(report.score.formula).toMatch(/^Speed from real visits \(half\)/);
    expect(report.checks.find((c) => c.id === 'backups.last')?.text).toMatch(/complete$/);
  });

  it('Content Creator: reads only the counts every staff role may read', async () => {
    const { sb, calls } = stub();
    const report = await loadHealthReport(sb, authOf('content_creator'));
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['rpc:content_health']);
    expect(report.errors7d).toBeNull();
    expect(report.tiles.find((t) => t.label === 'Errors, 7 days')?.value).toBe('Not checked');
  });

  it('a read that fails is logged and its rows say so; the rest still renders', async () => {
    logs.length = 0;
    const { sb } = stub(['vitals_summary', 'system_logs']);
    const report = await loadHealthReport(sb, authOf('developer'));
    expect(report.vitals).toBeNull();
    expect(report.checks.find((c) => c.id === 'speed.lcp')?.text).toBe(
      'Largest paint (LCP): could not be read just now',
    );
    expect(report.checks.find((c) => c.id === 'errors.recent')?.state).toBe('unknown');
    expect(report.checks.find((c) => c.id === 'content.placeholders')?.state).toBe('fail');
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain('t1');
  });

  it('the summary the dashboard shows: the first four failing rows, and how many fail', async () => {
    const { sb } = stub();
    const summary = await loadHealthSummary(sb, authOf('admin'));
    expect(summary.failing.length).toBeLessThanOrEqual(4);
    expect(summary.failing.every((c) => c.state === 'fail')).toBe(true);
    expect(summary.failingCount).toBeGreaterThanOrEqual(summary.failing.length);
    expect(summary.failing.map((c) => c.id)).toEqual([
      'content.placeholders',
      'speed.cls',
      'errors.recent',
    ]);
  });
});
