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
import type { ProbeReport, ProbeView } from '@/lib/admin/health/probes';
import { probeFacts, type ProbeKind } from '@schemas/healthProbe';
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
    withoutTwoStep: 0,
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

  it('two factor sign in (U17): fails with how many lack it, ok for none, unknown unread', () => {
    const some = outcome('security.two_step', ctx({ withoutTwoStep: 3 }));
    expect(some).toMatchObject({
      state: 'fail',
      count: 3,
      text: '3 team members without two factor sign in',
    });
    expect(outcome('security.two_step', ctx({ withoutTwoStep: 1 })).text).toBe(
      '1 team member without two factor sign in',
    );
    expect(outcome('security.two_step', ctx({ withoutTwoStep: 0 }))).toMatchObject({
      state: 'ok',
      text: 'Everyone uses two factor sign in',
    });
    for (const withoutTwoStep of [null, undefined]) {
      expect(outcome('security.two_step', ctx({ withoutTwoStep })).state).toBe('unknown');
    }
    // Checked for users.manage only (Admin): never a count another role's RLS would hide.
    expect(rule('security.two_step').needs).toEqual(['users.manage']);
    for (const role of ROLES) {
      expect(mayCheck(role, rule('security.two_step')), role).toBe(role === 'admin');
    }
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

  it('Admin is checked on every rule; Developer on every rule but the team’s 2FA (U17)', () => {
    expect(runChecklist(ctx({ role: 'admin' })).every((r) => r.checked)).toBe(true);
    expect(
      runChecklist(ctx({ role: 'developer' }))
        .filter((r) => !r.checked)
        .map((r) => r.id),
    ).toEqual(['security.two_step']);
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
    withoutTwoStep: 2,
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
      'content.alt': '/admin/media?alt=missing',
      'content.consent': '/admin/testimonials',
      'seo.default-description': '/admin/seo?tab=site',
      'seo.arabic': '/admin/seo?tab=pages',
      'speed.lcp': '/admin/site-health?tab=speed',
      'errors.recent': '/admin/site-health?tab=errors',
      'security.two_step': '/admin/users',
    });
  });

  it('SEO fixes go to the SEO screen for the roles that edit there (U10)', () => {
    for (const role of ['seo', 'admin'] as const) {
      const fixes = Object.fromEntries(
        runChecklist({ ...failing, role }).map((r) => [r.id, r.fix]),
      );
      expect(fixes['seo.arabic'], role).toBe('/admin/seo?tab=pages');
      expect(fixes['seo.default-description'], role).toBe('/admin/seo?tab=site');
    }
    // Content Creator reads a page's meta in its editor, never on /admin/seo.
    const creator = Object.fromEntries(
      runChecklist({ ...failing, role: 'content_creator' }).map((r) => [r.id, r.fix]),
    );
    expect(creator['seo.arabic']).toBeNull();
    expect(creator['seo.default-description']).toBeNull();
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
    expect(fixes['content.alt']).toBe('/admin/media?alt=missing');
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
    expect(ids).toEqual(['sitemap', 'hreflang', 'canonical', 'robots', 'schema']);
    const sitemap = source('src/pages/sitemap.xml.ts');
    for (const loader of ['getPublishedServices', 'getCaseStudyIndex', 'getPublishedPosts']) {
      expect(sitemap).toContain(loader);
    }
    // "open to search engines", "at most an hour behind" (U10): the indexability filter, and
    // the hour the sitemap may be cached for.
    expect(sitemap).toContain('isIndexedPath(ix, path, base, ref ?? null)');
    expect(sitemap).toContain("'cache-control': 'public, max-age=3600'");
    expect(source('src/pages/llms.txt.ts')).toContain('isIndexedPath(ix, path, site, ref)');
    // "each in its own": the override is localized per language (src/lib/seo/canonical.ts).
    expect(source('src/components/SeoHead.astro')).toContain('localizedCanonical(');
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
      if (name === 'staff_accounts') {
        // U17: the directory (0072), one active member with 2FA and one without, and a
        // switched-off one, who is not counted.
        const row = (id: string, twoStep: boolean, active: boolean) => ({
          id,
          email: null,
          invited_at: null,
          email_confirmed_at: null,
          last_sign_in_at: null,
          is_owner: false,
          two_step: twoStep,
          is_active: active,
        });
        return {
          data: [
            row('11111111-1111-4111-8111-111111111111', true, true),
            row('22222222-2222-4222-8222-222222222222', false, true),
            row('33333333-3333-4333-8333-333333333333', false, false),
          ],
          error: null,
        };
      }
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
  it('Admin: reads vitals, the counts, the errors, the last backup, the readings and the directory, each for its tenant', async () => {
    const { sb, calls } = stub();
    const report = await loadHealthReport(sb, authOf('admin'), Date.parse('2026-10-15T12:00:00Z'));
    expect(calls.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      'from:audit_log',
      'from:health_probes',
      'from:system_logs',
      'rpc:content_health',
      'rpc:staff_accounts',
      'rpc:vitals_summary',
    ]);
    expect(report.checks.find((c) => c.id === 'security.two_step')).toMatchObject({
      state: 'fail',
      count: 1,
      fix: '/admin/users',
    });
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
      ['Uptime, 30 days', 'Not set up'],
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
    // No siteHealth.view: no readings read, no uptime tile, uptime out of the score.
    expect(report.probes).toBeNull();
    expect(report.uptime).toBeNull();
    expect(report.tiles.some((t) => t.label === 'Uptime, 30 days')).toBe(false);
  });

  it('a read that fails is logged and its rows say so; the rest still renders', async () => {
    logs.length = 0;
    const { sb } = stub(['vitals_summary', 'system_logs']);
    const report = await loadHealthReport(sb, authOf('developer'));
    expect(report.vitals).toBeNull();
    // No users.manage: the directory is not read for a Developer (U17).
    expect(report.checks.find((c) => c.id === 'security.two_step')?.checked).toBe(false);
    // The readings were read (the stub's rows are not probe rows, so none parse: not set up).
    expect(report.uptime).toMatchObject({ status: 'off' });
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
      'security.two_step',
    ]);
  });
});

// ── Site health v2 (Admin v2 G2): the domain and the certificate ────────────────────────

const NOW = Date.parse('2026-10-15T12:00:00Z');
const inDays = (n: number) => new Date(NOW + n * 86_400_000 + 3_600_000).toISOString();

function probe<K extends ProbeKind>(
  kind: K,
  state: ProbeView['state'],
  facts: unknown,
  extra: Partial<Omit<ProbeView, 'facts'>> = {},
): ProbeView<K> {
  return {
    state,
    facts: facts === null ? null : (probeFacts(kind, facts) as ProbeView<K>['facts']),
    checkedAt: '2026-10-15T11:50:00Z',
    okAt: '2026-10-15T11:50:00Z',
    readOk: true,
    failures: 0,
    stateSince: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

const domainFacts = (over: Record<string, unknown> = {}) => ({
  apex: 'braiinstatiion.com',
  outcome: 'ok',
  expires: inDays(200),
  registrar: 'Example Registrar',
  rdap: {
    tld: 'com',
    base: 'https://rdap.verisign.com/com/v1/',
    fetchedAt: '2026-10-01T00:00:00Z',
  },
  ...over,
});

const report = (over: Partial<ProbeReport> = {}): ProbeReport => ({
  uptime: null,
  domain: probe('domain', 'ok', domainFacts()),
  certificate: null,
  ...over,
});

describe('security.domain (G2)', () => {
  const run = (probes: ProbeReport | null | undefined) =>
    outcome('security.domain', ctx({ probes, now: NOW }));

  it('names the domain when it renews well ahead, and fails at 30 days or fewer', () => {
    expect(run(report())).toMatchObject({
      state: 'ok',
      text: 'braiinstatiion.com renews in 200 days',
    });
    expect(
      run(report({ domain: probe('domain', 'fail', domainFacts({ expires: inDays(30) })) })),
    ).toMatchObject({
      state: 'fail',
      text: 'braiinstatiion.com expires in 30 days',
    });
    expect(
      run(report({ domain: probe('domain', 'ok', domainFacts({ expires: inDays(31) })) })).state,
    ).toBe('ok');
    expect(
      run(report({ domain: probe('domain', 'fail', domainFacts({ expires: inDays(1) })) })).text,
    ).toBe('braiinstatiion.com expires in 1 day');
    expect(
      run(report({ domain: probe('domain', 'fail', domainFacts({ expires: inDays(-3) })) })).text,
    ).toMatch(/^braiinstatiion\.com expired on \d+ \w+ 2026$/);
  });

  it('fails when no registration is found, naming what was looked up', () => {
    const found = run(
      report({
        domain: probe(
          'domain',
          'fail',
          domainFacts({
            apex: 'braiinstation.com',
            outcome: 'not-found',
            expires: null,
            registrar: null,
          }),
        ),
      }),
    );
    expect(found).toMatchObject({
      state: 'fail',
      text: 'No registration found for braiinstation.com',
    });
  });

  it('is information on a Cloudflare address, or with no domain recorded', () => {
    expect(
      run(
        report({
          domain: probe(
            'domain',
            'info',
            domainFacts({
              apex: 'example-site.example.workers.dev',
              outcome: 'not-applicable',
              expires: null,
              registrar: null,
              rdap: null,
            }),
          ),
        }),
      ),
    ).toMatchObject({
      state: 'info',
      text: 'Domain renewal: not checked: the site is on a Cloudflare address',
    });
    expect(
      run(
        report({
          domain: probe(
            'domain',
            'info',
            domainFacts({
              apex: null,
              outcome: 'not-applicable',
              expires: null,
              registrar: null,
              rdap: null,
            }),
          ),
        }),
      ).text,
    ).toBe('Domain renewal: not checked: no domain is recorded for the site');
  });

  it('is information when the record gives no date, or no registry covers the domain', () => {
    expect(
      run(
        report({
          domain: probe('domain', 'info', domainFacts({ outcome: 'unknown', expires: null })),
        }),
      ).text,
    ).toBe('braiinstatiion.com: its registration record gives no renewal date');
    expect(
      run(
        report({
          domain: probe(
            'domain',
            'info',
            domainFacts({ outcome: 'unknown', expires: null, rdap: null }),
          ),
        }),
      ).text,
    ).toBe('braiinstatiion.com: no public registration record covers this domain');
  });

  it('is unknown when never checked, when the readings could not be read, or when stale', () => {
    expect(run(report({ domain: null }))).toMatchObject({
      state: 'unknown',
      text: 'Domain renewal: not checked yet',
    });
    expect(run(null)).toMatchObject({
      state: 'unknown',
      text: 'Domain renewal: could not be read just now',
    });
    expect(run(undefined).state).toBe('unknown');
    expect(
      run(
        report({
          domain: probe('domain', 'unknown', domainFacts(), { readOk: false, failures: 6 }),
        }),
      ).text,
    ).toBe('Domain renewal: could not be read just now');
    expect(run(report({ domain: probe('domain', 'unknown', null) })).state).toBe('unknown');
  });
});

describe('security.certificate (G2)', () => {
  const run = (probes: ProbeReport | null) =>
    outcome('security.certificate', ctx({ probes, now: NOW }));
  const cert = (expires: string | null, source = 'monitor') =>
    probe('certificate', 'ok', { source, expires, issuer: expires ? "Let's Encrypt" : null });

  it('renews ahead, and fails at 14 days or fewer (renewal is stuck)', () => {
    expect(run(report({ certificate: cert(inDays(60)) }))).toMatchObject({
      state: 'ok',
      text: 'Certificate renews in 60 days',
    });
    expect(run(report({ certificate: cert(inDays(15)) })).state).toBe('ok');
    const stuck = run(report({ certificate: cert(inDays(14)) }));
    expect(stuck).toMatchObject({ state: 'fail', text: 'Certificate expires in 14 days' });
    expect(stuck.detail).toContain("Issued by Let's Encrypt.");
  });

  it('says Cloudflare issues it, never a guess, when the monitor reports none or is off', () => {
    for (const p of [cert(null, 'cloudflare'), null, probe('certificate', 'off', {})]) {
      expect(run(report({ certificate: p })), JSON.stringify(p)).toMatchObject({
        state: 'info',
        text: 'Certificates are issued and renewed by Cloudflare',
      });
    }
    expect(run(null).state).toBe('unknown');
  });
});

describe('the G2 rules, gated and unlinked', () => {
  it('only Admin and Developer are checked on them (siteHealth.view)', () => {
    for (const role of ROLES) {
      const results = runChecklist(ctx({ role, probes: report(), now: NOW }));
      for (const id of ['security.domain', 'security.certificate']) {
        expect(results.find((r) => r.id === id)?.checked, `${role} ${id}`).toBe(
          ROLE_CAPS[role]['siteHealth.view'] === 'full',
        );
      }
    }
  });

  it('carry no fix link: the fix is at the registrar or the monitor', () => {
    for (const id of ['security.domain', 'security.certificate'])
      expect(rule(id).fix).toBeUndefined();
    const failing = report({
      domain: probe('domain', 'fail', domainFacts({ outcome: 'not-found', expires: null })),
    });
    const row = runChecklist(ctx({ probes: failing, now: NOW })).find(
      (r) => r.id === 'security.domain',
    );
    expect(row).toMatchObject({ state: 'fail', fix: null });
  });

  it('sit in the Security group after the code facts, in the prototype’s order', () => {
    expect(HEALTH_RULES.filter((r) => r.group === 'Security').map((r) => r.id)).toEqual([
      'security.csp',
      'security.hsts',
      'security.admin',
      'security.crawlers',
      'security.domain',
      'security.certificate',
      // U17: the team's sign-in, after the website's rows (the prototype's second card).
      'security.two_step',
    ]);
  });
});

describe('loadHealthReport with readings (G2)', () => {
  function probeStub(rows: unknown[] | null) {
    const { sb, calls } = stub(rows === null ? ['health_probes'] : []);
    const base = sb as unknown as { from: (name: string) => Record<string, unknown> };
    const from = base.from.bind(base);
    (sb as unknown as { from: unknown }).from = (name: string) => {
      const b = from(name);
      if (name !== 'health_probes' || rows === null) return b;
      b['then'] = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
      return b;
    };
    return { sb, calls };
  }
  const row = (kind: string, state: string, facts: unknown) => ({
    kind,
    state,
    facts,
    read_ok: true,
    failures: 0,
    checked_at: '2026-10-15T11:50:00Z',
    ok_at: '2026-10-15T11:50:00Z',
    next_at: '2026-10-15T11:55:00Z',
    state_since: '2026-10-01T00:00:00Z',
  });
  const uptimeFacts = {
    ratio30: 99.96,
    ratio90: 99.91,
    days: [],
    incidents: [],
    responseTimes: [],
    monitors: [{ name: 'Home', path: '/', intervalSec: 300, status: 'up' }],
    downSince: null,
  };

  it('a reading: the tile, the 40/40/20 score, the rows, all read for the tenant', async () => {
    const { sb, calls } = probeStub([
      row('uptime', 'ok', uptimeFacts),
      row('domain', 'ok', domainFacts()),
      row('certificate', 'info', { source: 'cloudflare', expires: null, issuer: null }),
    ]);
    const r = await loadHealthReport(sb, authOf('admin'), NOW);
    expect(calls.find((c) => c.name === 'health_probes')?.filters).toContainEqual([
      'tenant_id',
      't1',
    ]);
    expect(r.tiles.find((t) => t.label === 'Uptime, 30 days')).toEqual({
      label: 'Uptime, 30 days',
      value: '99.96%',
      note: 'From the monitor',
    });
    expect(r.score.uptimePart).toBeCloseTo(96, 6);
    expect(r.score.formula).toContain('uptime from the monitor (20%)');
    expect(r.checks.find((c) => c.id === 'security.domain')?.state).toBe('ok');
    expect(r.uptime).toEqual({
      status: 'read',
      state: 'ok',
      ratio30: 99.96,
      checkedAt: '2026-10-15T11:50:00Z',
    });
  });

  it('a stale reading is not scored, and says the monitor could not be read', async () => {
    const { sb } = probeStub([
      { ...row('uptime', 'unknown', uptimeFacts), read_ok: false, failures: 6 },
    ]);
    const r = await loadHealthReport(sb, authOf('developer'), NOW);
    expect(r.score.uptimePart).toBeNull();
    expect(r.score.formula).toContain('Uptime could not be read just now.');
  });

  it('the tile: no reading yet once tried, not reported when the monitor omits it', async () => {
    const tile = async (r: unknown) =>
      (await loadHealthReport(probeStub([r]).sb, authOf('admin'), NOW)).tiles.find(
        (t) => t.label === 'Uptime, 30 days',
      )?.value;
    // Never read: the row exists because a run tried, so "Not checked yet" would be untrue.
    for (const failures of [1, 6]) {
      expect(
        await tile({ ...row('uptime', 'unknown', {}), read_ok: false, failures, ok_at: null }),
      ).toBe('No reading yet');
    }
    expect(await tile(row('uptime', 'ok', { ...uptimeFacts, ratio30: null }))).toBe('Not reported');
  });

  it('a failed read is logged; the tile says so and the score leaves uptime out', async () => {
    logs.length = 0;
    const { sb } = probeStub(null);
    const r = await loadHealthReport(sb, authOf('admin'), NOW);
    expect(r.probes).toBeNull();
    expect(r.tiles.find((t) => t.label === 'Uptime, 30 days')?.value).toBe('Could not be read');
    expect(r.checks.find((c) => c.id === 'security.domain')?.text).toBe(
      'Domain renewal: could not be read just now',
    );
    expect(r.score.formula).toContain('Uptime could not be read just now.');
    expect(logs).toHaveLength(1);
  });

  it('the dashboard summary carries the uptime figure (additive, for U1)', async () => {
    const { sb } = probeStub([row('uptime', 'ok', uptimeFacts)]);
    const summary = await loadHealthSummary(sb, authOf('admin'), NOW);
    expect(summary.uptime).toMatchObject({ status: 'read', ratio30: 99.96 });
  });
});
