import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CTA_IDS, INQUIRY_CTAS, INQUIRY_PATH, SERVICE_PATH } from '@schemas/analytics';
import { GOAL_METRICS } from '@schemas/analyticsGoals';
import { trackHref } from '@/lib/analytics/track';
import { STUDIO_TIME_ZONES } from '@schemas/timeZones';

// The website stats' vocabulary (Admin v2 G1) is written twice: in TypeScript, where the
// public site sends and the ingest checks it, and in migration 0071, where the rollups count
// it. Held equal here, and to the markup: every `data-track` id a public component renders is
// in CTA_IDS, and every id in CTA_IDS is rendered somewhere (a closed list with an id no link
// carries would be a goal that can never move).

const MIGRATION = readFileSync('supabase/migrations/0071_stats_v2.sql', 'utf8');

/** Every .astro and .ts file below src/components, as text. */
function components(): { path: string; text: string }[] {
  return (readdirSync('src/components', { recursive: true, encoding: 'utf8' }) as string[])
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => /\.(astro|ts|tsx)$/.test(f) && !f.startsWith('admin/'))
    .map((f) => ({
      path: `src/components/${f}`,
      text: readFileSync(`src/components/${f}`, 'utf8'),
    }));
}

/** The ids a component names in `data-track`: literal values, and the values of an expression. */
function trackedIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/data-track="([^"]*)"/g)) ids.push(m[1] ?? '');
  for (const m of text.matchAll(/data-track=\{([^}]*)\}/g)) {
    const expr = m[1] ?? '';
    // A ternary's results (`x === 'ar' ? 'language_ar' : 'language_en'`), not its test.
    for (const q of expr.matchAll(/[?:]\s*'([a-z_]+)'/g)) ids.push(q[1] ?? '');
    // trackHref(...) renders contact_link or nothing.
    if (/\btrackHref\(/.test(expr)) ids.push('contact_link');
  }
  return ids;
}

describe('the click vocabulary', () => {
  const rendered = components().flatMap((c) =>
    trackedIds(c.text).map((id) => ({ id, path: c.path })),
  );

  it('finds the links (the scan is not vacuous)', () => {
    expect(rendered.length).toBeGreaterThanOrEqual(10);
  });

  it('every id a public component renders is in CTA_IDS', () => {
    const known = new Set<string>(CTA_IDS);
    expect(rendered.filter((r) => !known.has(r.id))).toEqual([]);
  });

  it('every id in CTA_IDS is rendered somewhere', () => {
    const seen = new Set(rendered.map((r) => r.id));
    expect(CTA_IDS.filter((id) => !seen.has(id))).toEqual([]);
  });

  it('no data-track on a form field: nothing is sent from the contact form (G1 D4)', () => {
    for (const { path, text } of components()) {
      expect(text, path).not.toMatch(/<(input|select|textarea|button|form)\b[^>]*data-track/);
    }
  });

  it('a link to the contact page counts as contact_link, in both languages, nothing else does', () => {
    for (const href of ['/contact', '/ar/contact', '/contact/', '/contact#inquiry']) {
      expect(trackHref(href)).toBe('contact_link');
    }
    for (const href of ['/contacts', '/services', 'https://x.example/contact', null, undefined]) {
      expect(trackHref(href)).toBeUndefined();
    }
  });
});

describe('TypeScript and migration 0071 say the same', () => {
  it('INQUIRY_CTAS equal the rollup’s literal', () => {
    const literal = /\(e\.props ->> 'cta'\) in \(([^)]*)\)/.exec(MIGRATION)?.[1];
    expect(literal).toBeDefined();
    const ids = [...(literal ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(ids).toEqual([...INQUIRY_CTAS]);
  });

  it('the service page and the contact page are matched by the same patterns', () => {
    expect(MIGRATION).toContain(`e.path ~ '${SERVICE_PATH.source.replaceAll('\\/', '/')}'`);
    expect(MIGRATION).toContain(`e.path ~ '${INQUIRY_PATH.source.replaceAll('\\/', '/')}'`);
    for (const yes of ['/services/logo', '/ar/services/logo/', '/services/3d-design']) {
      expect(SERVICE_PATH.test(yes), yes).toBe(true);
    }
    for (const no of ['/services', '/services/', '/services/a/b', '/en/services/logo']) {
      expect(SERVICE_PATH.test(no), no).toBe(false);
    }
    expect(INQUIRY_PATH.test('/ar/contact/')).toBe(true);
    expect(INQUIRY_PATH.test('/contact/thanks')).toBe(false);
  });

  it('a goal’s metrics equal the analytics_goals CHECK', () => {
    const check = /check \(metric in \(([^)]*)\)\)/.exec(MIGRATION)?.[1];
    const metrics = [...(check ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(metrics).toEqual([...GOAL_METRICS]);
  });

  it('busy_hours accepts the CRM’s time zones (0035), Riyadh among them', () => {
    const crm = readFileSync(
      readdirSync('supabase/migrations')
        .filter((f) => f.startsWith('0035_'))
        .map((f) => `supabase/migrations/${f}`)[0] ?? '',
      'utf8',
    );
    const zones = (sql: string, re: RegExp) =>
      [...(re.exec(sql)?.[1] ?? '').matchAll(/'([A-Za-z_/]+)'/g)].map((m) => m[1]);
    const crmZones = zones(crm, /timezone in \(([\s\S]*?)\)\)/);
    const readerZones = zones(MIGRATION, /p_tz not in \(([\s\S]*?)\) then/);
    expect(crmZones.length).toBeGreaterThan(5);
    expect(readerZones).toEqual(crmZones);
    // The studio's zone (site_settings.timezone, Admin v2 U9) is what the page passes: every
    // value the setting can hold is one the reader takes.
    expect(readerZones).toEqual(STUDIO_TIME_ZONES.map((z) => z.value));
  });

  it('a click id fits the rollup’s key and the goal’s cta CHECK', () => {
    for (const id of CTA_IDS) {
      expect(id).toMatch(/^[a-z0-9_:-]{1,66}$/);
      expect(id).toMatch(/^[a-z0-9_]{1,40}$/);
    }
  });
});
