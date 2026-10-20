import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { reachableHrefs } from '../nav';
import { formatDate } from '../relTime';
import { THRESHOLDS, daysUntil } from '@/lib/health/thresholds';
import type { ProbeReport } from './probes';
import { securityFacts } from './security';
import {
  BUDGETS,
  MIN_SAMPLES,
  VITAL_NAMES,
  formatVital,
  judged,
  siteVital,
  type VitalMetric,
  type VitalsReport,
} from './vitals';

// The site health checklist (Admin v2 U2, docs/admin-v2/ui.md "Site health v1"): a registry
// of rules, each reading what the context holds and answering ok, fail, info or unknown.
//
//   gated by capability   Each rule names the capabilities it needs (any one of them, in
//                         full). A role without them is not checked ("not checked for your
//                         role"): nothing is read that its RLS would refuse, and the score
//                         counts only what the role could see (README D4). The data is read
//                         as the person, never with the service role.
//   honest states         `unknown` (not enough visits, a read that failed) and `info` (a
//                         figure, not a fault) never count as failures.
//   fix links             A failing rule may name the screen where it is fixed; the link
//                         shows only to a role that reaches that screen from its menu (and
//                         holds `fixCaps`, when the screen shows the thing to that role only).
//
// A later slice adds its rule here (U14: links to hidden pages), with its test in
// tests/lib/healthChecklist.spec.ts.

export const HEALTH_GROUPS = ['Content', 'SEO', 'Speed', 'Errors', 'Security', 'Backups'] as const;
export type HealthGroup = (typeof HEALTH_GROUPS)[number];

export type CheckState = 'ok' | 'fail' | 'info' | 'unknown';

export interface CheckOutcome {
  state: CheckState;
  /** What is true, in one plain line. */
  text: string;
  count?: number;
  /** A second line: what it means or what to do. */
  detail?: string;
}

/** The checklist's content and SEO counts (public.content_health, migration 0052). */
export interface ContentHealth {
  placeholdersLive: number;
  missingAlt: number;
  consentMissing: number;
  published: number;
  ownDescription: number;
  missingArabic: number;
  defaultDescriptionEn: boolean;
  defaultDescriptionAr: boolean;
}

/** The newest backup export's outcome row (audit_log, `export.backup.outcome`). */
export interface BackupFact {
  at: string;
  status: string;
  rows: number;
}

export interface HealthContext {
  role: Role;
  /** Null when not read (the role lacks siteHealth.view) or when the read failed. */
  vitals: VitalsReport | null;
  content: ContentHealth | null;
  /** Errors logged in the last 7 days; null when not read. */
  errors7d: number | null;
  /** The last backup export; null when there is none; undefined when not read. */
  lastBackup?: BackupFact | null | undefined;
  /**
   * The uptime, domain and certificate readings (Admin v2 G2, health_probes); null when the
   * read failed; undefined when not read (the role lacks siteHealth.view).
   */
  probes?: ProbeReport | null | undefined;
  /**
   * Active members without two factor sign in (Admin v2 U17, public.staff_accounts): null
   * when the directory could not be read; undefined when not read (the role lacks
   * users.manage).
   */
  withoutTwoStep?: number | null | undefined;
  now: number;
}

export interface HealthRule {
  id: string;
  group: HealthGroup;
  /** What the rule checks, for a role it is not checked for. */
  title: string;
  /** Checked only for a role holding one of these in full; none means every role. */
  needs: readonly Capability[];
  evaluate(ctx: HealthContext): CheckOutcome;
  /** Where a failing row is fixed (an admin screen, with a tab when the screen has them). */
  fix?: string;
  /** The fix screen shows the thing to these only (any one, in full). */
  fixCaps?: readonly Capability[];
}

export interface CheckResult extends CheckOutcome {
  id: string;
  group: HealthGroup;
  /** False when the role may not check it: `state` is then `unknown`. */
  checked: boolean;
  /** The fix link for this role, or null. */
  fix: string | null;
}

/** The days the errors row looks back over. */
export const ERROR_WINDOW_DAYS = 7;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const unread = (what: string): CheckOutcome => ({
  state: 'unknown',
  text: `${what}: could not be read just now`,
});

function speedRule(metric: VitalMetric): HealthRule {
  const name = VITAL_NAMES[metric];
  return {
    id: `speed.${metric.toLowerCase()}`,
    group: 'Speed',
    title: name,
    needs: ['siteHealth.view'],
    fix: '/admin/site-health?tab=speed',
    evaluate: ({ vitals }) => {
      if (!vitals) return unread(name);
      const row = siteVital(vitals, metric);
      const rating = judged(row);
      if (!row || rating === null) {
        return {
          state: 'unknown',
          text: `${name}: not enough visits yet to judge`,
          count: row?.samples ?? 0,
          detail: `${row?.samples ?? 0} of the ${MIN_SAMPLES} visits it needs in the last ${vitals.days} days.`,
        };
      }
      // The value is the p75, or the upper edge of its bucket over a range: either way 3
      // visits in 4 were at it or better.
      const seen = row.open
        ? `More than a quarter of visits were over ${formatVital(metric, row.p75)}`
        : `3 visits in 4 were at ${formatVital(metric, row.p75)} or better`;
      return rating === 'good'
        ? { state: 'ok', text: `${name} is within budget`, detail: `${seen}.` }
        : {
            state: 'fail',
            text: `${name} is over budget`,
            detail: `${seen}; the budget is ${formatVital(metric, BUDGETS[metric])}.`,
          };
    },
  };
}

const days = (n: number) => `${n} ${plural(n, 'day', 'days')}`;

/**
 * The domain's renewal (Admin v2 G2): from its public registration record (RDAP), read by
 * the health schedule about once a day. The domain is always named, so a misspelt one is
 * visible. No fix link: renewal is at the registrar, not in this admin.
 */
function domainRule(ctx: HealthContext): CheckOutcome {
  if (!ctx.probes) return unread('Domain renewal');
  const probe = ctx.probes.domain;
  if (!probe) {
    return {
      state: 'unknown',
      text: 'Domain renewal: not checked yet',
      detail: 'The registration record is read about once a day.',
    };
  }
  const facts = probe.facts;
  if (!facts || (probe.state === 'unknown' && !probe.readOk)) return unread('Domain renewal');
  const apex = facts.apex ?? 'the domain';
  const who = facts.registrar ? ` (${facts.registrar})` : '';
  switch (facts.outcome) {
    case 'ok': {
      if (!facts.expires) break;
      const left = daysUntil(facts.expires, new Date(ctx.now));
      if (left > THRESHOLDS.domainFailDays) {
        return {
          state: 'ok',
          text: `${apex} renews in ${days(left)}`,
          detail: `Registered until ${formatDate(facts.expires, { year: 'always' })}${facts.registrar ? `, with ${facts.registrar}` : ''}.`,
        };
      }
      return {
        state: 'fail',
        text:
          left < 0
            ? `${apex} expired on ${formatDate(facts.expires, { year: 'always' })}`
            : `${apex} expires in ${days(left)}`,
        detail: `Renew it at the registrar${who}, or ask whoever manages the domain.`,
      };
    }
    case 'not-found':
      return {
        state: 'fail',
        text: `No registration found for ${apex}`,
        detail:
          "Check that the site's domain is spelt right; whoever runs the site can correct it.",
      };
    case 'invalid':
      return {
        state: 'fail',
        text: `The site's domain, ${apex}, is not a domain name`,
        detail: 'Whoever runs the site can correct it.',
      };
    case 'not-applicable':
      return facts.apex
        ? {
            state: 'info',
            text: 'Domain renewal: not checked: the site is on a Cloudflare address',
            detail: 'Its own domain is checked once the site moves to it.',
          }
        : {
            state: 'info',
            text: 'Domain renewal: not checked: no domain is recorded for the site',
            detail: 'Whoever runs the site can record it.',
          };
    default:
      break;
  }
  return {
    state: 'info',
    text: facts.rdap
      ? `${apex}: its registration record gives no renewal date`
      : `${apex}: no public registration record covers this domain`,
    detail: 'Check the renewal date at the registrar.',
  };
}

/**
 * The TLS certificate (Admin v2 G2, decision D3): its expiry when the uptime monitor reports
 * one; otherwise Cloudflare issues and renews it, and the row says so rather than guess.
 */
function certificateRule(ctx: HealthContext): CheckOutcome {
  if (!ctx.probes) return unread('Certificate');
  const probe = ctx.probes.certificate;
  const byCloudflare = 'Certificates are issued and renewed by Cloudflare';
  if (!probe || probe.state === 'off') {
    return {
      state: 'info',
      text: byCloudflare,
      detail: 'Once the uptime monitor is set up, its expiry date shows here.',
    };
  }
  const facts = probe.facts;
  if (!facts || (probe.state === 'unknown' && !probe.readOk)) return unread('Certificate');
  if (facts.source === 'cloudflare' || !facts.expires) {
    return {
      state: 'info',
      text: byCloudflare,
      detail: 'The uptime monitor reports no expiry date for this site.',
    };
  }
  const left = daysUntil(facts.expires, new Date(ctx.now));
  const issuer = facts.issuer ? `Issued by ${facts.issuer}. ` : '';
  return left > THRESHOLDS.certificateFailDays
    ? {
        state: 'ok',
        text: `Certificate renews in ${days(left)}`,
        detail: `${issuer}Cloudflare renews it about 30 days before it expires.`,
      }
    : {
        state: 'fail',
        text:
          left < 0
            ? `The certificate expired on ${formatDate(facts.expires, { year: 'always' })}`
            : `Certificate expires in ${days(left)}`,
        detail: `${issuer}Cloudflare renews certificates about 30 days before they expire, so this one is stuck: tell whoever runs the site.`,
      };
}

function backupLine(fact: BackupFact): string {
  const outcome = fact.status === 'ok' ? 'complete' : 'partial';
  return `Last backup export ${formatDate(fact.at)}, ${outcome}`;
}

export const HEALTH_RULES: readonly HealthRule[] = [
  // ---- Content (dashboard_attention, through public.content_health) ----
  {
    id: 'content.placeholders',
    group: 'Content',
    title: 'Design placeholders',
    needs: [],
    fix: '/admin',
    // The dashboard lists them to the roles that work on content (src/pages/admin/index.astro).
    fixCaps: ['blog.write', 'services.write', 'seo.entityMeta'],
    evaluate: ({ content }) => {
      if (!content) return unread('Design placeholders');
      const n = content.placeholdersLive;
      return n > 0
        ? {
            state: 'fail',
            count: n,
            text: `${n} design ${plural(n, 'placeholder is', 'placeholders are')} live on the site`,
            detail: 'Replace each with real content, then clear its placeholder box.',
          }
        : { state: 'ok', text: 'No design placeholders are live' };
    },
  },
  {
    id: 'content.alt',
    group: 'Content',
    title: 'Alt text on published projects',
    needs: [],
    // U4: the library filtered to the pictures that still lack alt text in a language.
    fix: '/admin/media?alt=missing',
    evaluate: ({ content }) => {
      if (!content) return unread('Alt text');
      const n = content.missingAlt;
      return n > 0
        ? {
            state: 'fail',
            count: n,
            text: `${n} published ${plural(n, 'project has', 'projects have')} images without alt text`,
            detail: 'Alt text in English and Arabic helps search and screen readers.',
          }
        : { state: 'ok', text: 'Every image on a published project has alt text' };
    },
  },
  {
    id: 'content.consent',
    group: 'Content',
    title: 'Consent for testimonials',
    needs: [],
    fix: '/admin/testimonials',
    evaluate: ({ content }) => {
      if (!content) return unread('Consent for testimonials');
      const n = content.consentMissing;
      return n > 0
        ? {
            state: 'fail',
            count: n,
            text: `${n} ${plural(n, 'testimonial is', 'testimonials are')} placed on a page without consent recorded`,
          }
        : { state: 'ok', text: 'Every placed testimonial has consent recorded' };
    },
  },
  // ---- SEO (entity_seo and seo_defaults, through public.content_health) ----
  {
    id: 'seo.arabic',
    group: 'SEO',
    title: 'Arabic search text',
    needs: [],
    // Admin v2 U10: the SEO screen's Pages tab edits each page's search text (Admin, SEO).
    fix: '/admin/seo?tab=pages',
    fixCaps: ['seo.entityMeta'],
    evaluate: ({ content }) => {
      if (!content) return unread('Arabic search text');
      const n = content.missingArabic;
      return n > 0
        ? {
            state: 'fail',
            count: n,
            text: `${n} published ${plural(n, 'page has', 'pages have')} English search text but no Arabic`,
            detail: 'The Arabic page then shows its default title or description.',
          }
        : { state: 'ok', text: 'Every page with its own search text has it in Arabic too' };
    },
  },
  {
    id: 'seo.default-description',
    group: 'SEO',
    title: 'Default description',
    needs: [],
    fix: '/admin/seo?tab=site',
    fixCaps: ['seo.globalDefaults'],
    evaluate: ({ content }) => {
      if (!content) return unread('Default description');
      const missing = [
        content.defaultDescriptionEn ? null : 'English',
        content.defaultDescriptionAr ? null : 'Arabic',
      ].filter((lang): lang is string => lang !== null);
      return missing.length > 0
        ? {
            state: 'fail',
            text: `The site's default description is missing in ${missing.join(' and ')}`,
            detail: 'Pages without their own description fall back to it.',
          }
        : { state: 'ok', text: "The site's default description is written in English and Arabic" };
    },
  },
  {
    id: 'seo.own-descriptions',
    group: 'SEO',
    title: 'Page descriptions',
    needs: [],
    evaluate: ({ content }) => {
      if (!content) return unread('Page descriptions');
      return {
        state: 'info',
        count: content.ownDescription,
        text: `${content.ownDescription} of ${content.published} published ${plural(content.published, 'page has', 'pages have')} a search description of ${plural(content.published, 'its', 'their')} own`,
        detail: "The rest use their own summary or the site's default description.",
      };
    },
  },
  // ---- Speed (rollup_daily_vitals, through public.vitals_summary) ----
  speedRule('LCP'),
  speedRule('INP'),
  speedRule('CLS'),
  // ---- Errors (system_logs) ----
  {
    id: 'errors.recent',
    group: 'Errors',
    title: 'Errors in the last 7 days',
    needs: ['logs.view'],
    fix: '/admin/site-health?tab=errors',
    fixCaps: ['logs.view'],
    evaluate: ({ errors7d }) => {
      if (errors7d === null) return unread('Errors');
      return errors7d > 0
        ? {
            state: 'fail',
            count: errors7d,
            text: `${errors7d} ${plural(errors7d, 'error', 'errors')} logged in the last ${ERROR_WINDOW_DAYS} days`,
          }
        : { state: 'ok', text: `No errors logged in the last ${ERROR_WINDOW_DAYS} days` };
    },
  },
  // ---- Security (code constants, src/lib/admin/health/security.ts) ----
  ...securityFacts().map((fact): HealthRule => ({
    id: `security.${fact.id}`,
    group: 'Security',
    title: fact.text,
    needs: [],
    evaluate: () => ({ state: fact.ok ? 'ok' : 'fail', text: fact.text, detail: fact.detail }),
  })),
  // ---- Security, read from outside (health_probes, Admin v2 G2) ----
  {
    id: 'security.domain',
    group: 'Security',
    title: 'Domain renewal',
    needs: ['siteHealth.view'],
    evaluate: domainRule,
  },
  {
    id: 'security.certificate',
    group: 'Security',
    title: 'Certificate',
    needs: ['siteHealth.view'],
    evaluate: certificateRule,
  },
  // ---- Security, the team's sign-in (public.staff_accounts, Admin v2 U17): after the
  // website's rows, as the prototype's "Admin and data" card follows its "Website" card ----
  {
    id: 'security.two_step',
    group: 'Security',
    title: 'Two factor sign in',
    needs: ['users.manage'],
    fix: '/admin/users',
    evaluate: ({ withoutTwoStep }) => {
      if (withoutTwoStep === undefined || withoutTwoStep === null) {
        return unread('Two factor sign in');
      }
      return withoutTwoStep > 0
        ? {
            state: 'fail',
            count: withoutTwoStep,
            text: `${withoutTwoStep} ${plural(withoutTwoStep, 'team member', 'team members')} without two factor sign in`,
            detail: 'Each person turns it on from their account. Users & roles can require it.',
          }
        : { state: 'ok', text: 'Everyone uses two factor sign in' };
    },
  },
  // ---- Backups (audit_log) ----
  // Information only until backups are scheduled (R17): a row that could only fail until
  // then would drag the score for ever (README D5).
  {
    id: 'backups.last',
    group: 'Backups',
    title: 'Last backup export',
    needs: ['audit.view'],
    evaluate: ({ lastBackup }) => {
      if (lastBackup === undefined) return unread('Last backup export');
      return lastBackup
        ? {
            state: 'info',
            text: backupLine(lastBackup),
            detail: `${lastBackup.rows.toLocaleString('en-GB')} rows. Backups are exported by hand until they are scheduled.`,
          }
        : {
            state: 'info',
            text: 'No backup export recorded yet',
            detail: 'Backups are exported by hand until they are scheduled.',
          };
    },
  },
];

const holds = (role: Role, caps: readonly Capability[]) =>
  caps.some((cap) => ROLE_CAPS[role][cap] === 'full');

/** True when the role may check the rule: it holds one of its `needs`, or it needs none. */
export function mayCheck(role: Role, rule: HealthRule): boolean {
  return rule.needs.length === 0 || holds(role, rule.needs);
}

/** The rule's fix link for this role, or null when it has none or cannot open it. */
export function fixFor(role: Role, rule: HealthRule): string | null {
  if (!rule.fix) return null;
  const screen = rule.fix.split('?')[0] ?? rule.fix;
  if (!reachableHrefs(role).includes(screen)) return null;
  if (rule.fixCaps && !holds(role, rule.fixCaps)) return null;
  return rule.fix;
}

/** Every rule's result for the context's role, in the registry's order. */
export function runChecklist(
  ctx: HealthContext,
  rules: readonly HealthRule[] = HEALTH_RULES,
): CheckResult[] {
  return rules.map((rule) => {
    if (!mayCheck(ctx.role, rule)) {
      return {
        id: rule.id,
        group: rule.group,
        checked: false,
        state: 'unknown',
        text: `${rule.title}: not checked for your role`,
        fix: null,
      };
    }
    const outcome = rule.evaluate(ctx);
    return {
      ...outcome,
      id: rule.id,
      group: rule.group,
      checked: true,
      fix: outcome.state === 'fail' ? fixFor(ctx.role, rule) : null,
    };
  });
}

/** The results by group, in HEALTH_GROUPS order, empty groups left out. */
export function byGroup(
  results: readonly CheckResult[],
): { group: HealthGroup; results: CheckResult[] }[] {
  return HEALTH_GROUPS.map((group) => ({
    group,
    results: results.filter((r) => r.group === group),
  })).filter((g) => g.results.length > 0);
}

/** How many rows passed and how many were judged (ok and fail; info and unknown aside). */
export function tally(results: readonly CheckResult[]): { ok: number; judged: number } {
  const ok = results.filter((r) => r.state === 'ok').length;
  const fail = results.filter((r) => r.state === 'fail').length;
  return { ok, judged: ok + fail };
}
