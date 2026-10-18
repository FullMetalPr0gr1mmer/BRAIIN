import { can } from '@/lib/authz/matrix';
import { PROBE_COLUMNS } from '@schemas/healthProbe';
import { THRESHOLDS, daysUntil } from '@/lib/health/thresholds';
import { formatDate, formatTime } from '../relTime';
import { reportOf } from '../health/probes';
import { PER_SOURCE, WINDOW_DAYS, type NotificationSource, type SourceItem } from './types';

// Site health in the bell (Admin v2 G2, decision D5): what only the health probes know, from
// ONE read of the tenant's three `health_probes` rows, for siteHealth.view roles only (Admin,
// Developer: Content Creator and SEO never run it, so they never even count it; RLS applies
// the rule again). The full checklist stays on the screen and the dashboard widget: it costs
// four reads, too many for every admin render.
//
//   the site is down          uptime `fail`, since its state began
//   an outage                 each incident in the window, new from when it was first seen
//   the domain                `fail`: expiring within 30 days, or no registration found
//   the certificate           `fail`: expiring within 14 days
//   a probe that went stale   six failed reads in a row (an hour), not when it is off
//
// A slow month (uptime under 99.9%, `warn`) is not an item: the screen shows it. Every
// `since` is when the condition began, so a new failure lights the dot even after the person
// marked the bell read (F8's watermark rule), and every id is stable across loads.

const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const HEALTH = '/admin/site-health';
const SECURITY = '/admin/site-health?tab=security';

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const health: NotificationSource = {
  kind: 'health',
  visible: (role) => can(role, 'siteHealth.view') === 'full',
  async load({ sb, auth, now }) {
    const { data, error } = await sb
      .from('health_probes')
      .select(PROBE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .limit(3);
    if (error) throw new Error(`notifications (health): ${error.message}`);
    const report = reportOf(Array.isArray(data) ? data : []);
    const items: SourceItem[] = [];
    const inWindow = (at: string) => {
      const age = now.getTime() - Date.parse(at);
      return Number.isFinite(age) && age >= 0 && age <= WINDOW_MS;
    };

    const up = report.uptime;
    if (up?.state === 'fail') {
      const down = up.facts?.monitors.filter(
        (m) => m.status === 'down' || m.status === 'seems-down',
      );
      const where = (down ?? []).map((m) => m.path ?? m.name).filter(Boolean);
      items.push({
        id: `health:uptime:${up.stateSince}`,
        kind: 'health',
        icon: 'warn',
        text: 'The site is down',
        detail: where.length > 0 ? `Monitor: ${where.join(', ')}` : null,
        at: up.stateSince,
        since: up.stateSince,
        href: HEALTH,
      });
    }
    for (const incident of up?.facts?.incidents ?? []) {
      if (!inWindow(incident.start)) continue;
      const n = minutes(incident.durationSec);
      items.push({
        id: `health:incident:${incident.id}`,
        kind: 'health',
        icon: 'clock',
        text: `The site was down for ${n} ${plural(n, 'minute', 'minutes')}`,
        detail: `${formatDate(incident.start)}, ${formatTime(incident.start)}`,
        at: incident.start,
        since: incident.seenAt,
        href: HEALTH,
      });
    }

    const domain = report.domain;
    const domainText = (facts: NonNullable<NonNullable<typeof domain>['facts']>): string | null => {
      const apex = facts.apex ?? 'The domain';
      if (facts.outcome === 'not-found') return `No registration found for ${apex}`;
      if (facts.outcome === 'invalid') return `The site's domain, ${apex}, is not a domain name`;
      if (facts.outcome !== 'ok' || !facts.expires) return null;
      // Judged again now: a domain renewed since the last read rings nothing.
      const left = daysUntil(facts.expires, now);
      if (left > THRESHOLDS.domainFailDays) return null;
      return left < 0
        ? `${apex} has expired`
        : `${apex} expires in ${left} ${plural(left, 'day', 'days')}`;
    };
    const domainLine = domain?.state === 'fail' && domain.facts ? domainText(domain.facts) : null;
    if (domain && domainLine) {
      items.push({
        id: `health:domain:${domain.stateSince}`,
        kind: 'health',
        icon: 'warn',
        text: domainLine,
        detail: null,
        at: domain.stateSince,
        since: domain.stateSince,
        href: SECURITY,
      });
    }

    const cert = report.certificate;
    const certLeft = cert?.facts?.expires ? daysUntil(cert.facts.expires, now) : null;
    if (cert?.state === 'fail' && certLeft !== null && certLeft <= THRESHOLDS.certificateFailDays) {
      const left = certLeft;
      items.push({
        id: `health:certificate:${cert.stateSince}`,
        kind: 'health',
        icon: 'warn',
        text:
          left < 0
            ? 'The certificate has expired'
            : `The certificate expires in ${left} ${plural(left, 'day', 'days')}`,
        detail: null,
        at: cert.stateSince,
        since: cert.stateSince,
        href: SECURITY,
      });
    }

    // Stale: six failed reads in a row. The certificate is read with the uptime, so the
    // uptime's item covers both.
    for (const [kind, probe] of [
      ['uptime', report.uptime],
      ['domain', report.domain],
    ] as const) {
      if (!probe || probe.state === 'off' || probe.failures < THRESHOLDS.staleAfter) continue;
      const last = probe.okAt;
      const when = last ? `${formatDate(last)}, ${formatTime(last)}` : null;
      const what = kind === 'uptime' ? 'The uptime monitor' : "The domain's registration record";
      items.push({
        id: `health:stale:${kind}:${last ?? 'never'}`,
        kind: 'health',
        icon: 'warn',
        text: when ? `${what} has not answered since ${when}` : `${what} has not answered yet`,
        detail: null,
        // When it went stale: the stamps trigger (0067) moves state_since at the sixth failed
        // read in a row, whether it turns the state `unknown` or finds it so already (a probe
        // never read), and keeps it while the probe stays stale.
        at: probe.stateSince,
        since: probe.stateSince,
        href: HEALTH,
      });
    }

    return items
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
      .slice(0, PER_SOURCE);
  },
};
