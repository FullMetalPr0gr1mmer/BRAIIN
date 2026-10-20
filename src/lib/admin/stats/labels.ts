import { CTA_IDS, type CtaId } from '@schemas/analytics';
import type { GoalMetric } from '@schemas/analyticsGoals';

// The words the website stats use for the public site's events and the goals' metrics
// (Admin v2 G1). Pure: the server partials and the goals island both import it, so it reads
// no database and imports nothing server-only. The click names follow the prototype's
// (data.js, `stats.events`) where they are true of this site.

/** A click's name on the Conversions tab, per id of CTA_IDS (packages/schemas/analytics.ts). */
export const CTA_LABELS: Readonly<Record<CtaId, string>> = {
  whatsapp: 'WhatsApp click',
  email: 'Email click',
  skip_to_inquiry: 'Service page: skip to inquiry',
  start_project: 'Explorer: start a project',
  language_ar: 'Language switched to AR',
  language_en: 'Language switched to EN',
  discipline_card: 'Discipline card opened',
  project_card: 'Project opened',
  contact_link: 'Link to the contact page',
};

/** A click id's name, or the id itself for one the vocabulary no longer has. */
export function ctaLabel(key: string): string {
  return (CTA_IDS as readonly string[]).includes(key) ? CTA_LABELS[key as CtaId] : key;
}

/** What a goal counts, in words (the goals card and the drawer's select). */
export const METRIC_LABELS: Readonly<Record<GoalMetric, string>> = {
  visits: 'Visits',
  pageviews: 'Page views',
  service_visits: 'Visits that opened a service page',
  inquiry_visits: 'Visits that reached an inquiry form',
  cta: 'Clicks on one link',
  interest: 'Interest in a discipline or service',
  inquiries: 'Inquiries received',
};

/** "Counts: WhatsApp click": a goal's metric, with its click when it counts one. */
export function goalCounts(metric: GoalMetric, cta: string | null): string {
  return metric === 'cta' && cta ? `Clicks: ${ctaLabel(cta)}` : METRIC_LABELS[metric];
}

/** The two kinds of service interest the explorer sends, by their rollup key's prefix. */
export type InterestKind = 'discipline' | 'service';

/** `d:branding` → a discipline's slug; `s:logo` → a service's; anything else → null. */
export function interestKey(key: string): { kind: InterestKind; slug: string } | null {
  const match = /^([ds]):([a-z0-9-]{1,64})$/.exec(key);
  if (!match) return null;
  return { kind: match[1] === 'd' ? 'discipline' : 'service', slug: match[2] as string };
}

/** A goal's progress in percent, whole, at most 100; null when its count is not shown. */
export function goalPercent(goal: { done: number | null; target: number }): number | null {
  if (goal.done === null) return null;
  return Math.min(100, Math.round((goal.done / Math.max(1, goal.target)) * 100));
}
