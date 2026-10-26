import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '@consent/gate';
import { HelpArticleSeedSchema } from '@schemas/help';
import { LEGAL, type LegalDoc } from '@/lib/legal/content';
import { helpSet, readMigrations } from '../fixtures/helpSet';

// The GA4 switch (Admin v2 U15): GA4_NOTICE_READY, an astro:env public server variable, default
// off. `astro build` inlines it, and wrangler.jsonc's `vars` win over the build environment, so
// production loads Google Analytics exactly when that file says "true" (launch runbook §2e).
// Today it must not: the privacy notice says the site's analytics are first-party, and the
// consent visitors gave was to that notice.
//
//   1. Where it is on and off today: off in wrangler.jsonc and in the deploy and Lighthouse
//      builds, on in the e2e build only (tests/admin/ga4.e2e.ts proves the loader there).
//   2. The switch-on guard: once wrangler.jsonc turns it on, the PR that does so must also
//      carry everything listed by switchOnGaps(): the notices naming Google in both languages
//      with their dates moved, the cookie policy naming the _ga cookies, the banner naming
//      Google, a new consent version (so a yes given to the first-party notice never loads
//      Google: the loader compares versions), the integrations guide no longer saying GA4
//      does not load, and a control that reopens the banner, so withdrawing is as easy as
//      consenting (architecture §4.12: a persistent "Cookie settings" link). A notice that
//      names Google while the switch is off is untrue the other way, and refused too.

const read = (path: string) => readFileSync(path, 'utf8');
/** A file without its comment lines (`//` for JSONC and TS, `#` for YAML). */
const code = (text: string, comment: '//' | '#') =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith(comment))
    .join('\n');

/** wrangler.jsonc's value for the switch: production's, since `vars` win over the build env. */
function productionSwitch(wrangler = read('wrangler.jsonc')): boolean {
  const vars = code(wrangler, '//');
  const match = /"GA4_NOTICE_READY"\s*:\s*("?)(true|false)\1/.exec(vars);
  return match?.[2] === 'true';
}

/** The dates the first-party notices carry: the switch-on PR moves them. */
const FIRST_PARTY_DATES = {
  en: 'Last updated: 4 October 2026',
  ar: 'آخر تحديث: 4 أكتوبر 2026',
} as const;

interface SwitchOnInputs {
  legal: typeof LEGAL;
  /** src/components/ConsentBanner.astro. */
  banner: string;
  consentVersion: number;
  /** The integrations guide as the catalog leaves it, in each language. */
  guide: { en: string; ar: string };
  /** Every public component and layout, joined. */
  publicMarkup: string;
}

const docText = (doc: LegalDoc) =>
  [doc.title, doc.intro, ...doc.sections.flatMap((s) => [s.heading, ...s.body])].join('\n');

/** The banner's copy for one language: its STR entry. */
function bannerCopy(banner: string, lang: 'en' | 'ar'): string {
  const en = banner.indexOf('\n  en: {');
  const ar = banner.indexOf('\n  ar: {');
  const end = banner.indexOf('}[locale]');
  if (en === -1 || ar === -1 || end === -1) return '';
  return lang === 'en' ? banner.slice(en, ar) : banner.slice(ar, end);
}

/** What the switch-on PR still lacks: empty when it may turn GA4 on in production. */
function switchOnGaps(input: SwitchOnInputs): string[] {
  const gaps: string[] = [];
  for (const lang of ['en', 'ar'] as const) {
    const privacy = input.legal[lang].privacy;
    const cookie = input.legal[lang].cookie;
    if (!/Google Analytics/.test(docText(privacy))) {
      gaps.push(`${lang}: the privacy notice names Google Analytics as a recipient`);
    }
    if (!/\b_ga\b/.test(docText(cookie))) {
      gaps.push(`${lang}: the cookie policy lists the _ga cookies and their lifetimes`);
    }
    if (privacy.updated === FIRST_PARTY_DATES[lang] || cookie.updated === FIRST_PARTY_DATES[lang]) {
      gaps.push(`${lang}: the privacy notice and the cookie policy carry the new date`);
    }
    if (!/Google/.test(bannerCopy(input.banner, lang))) {
      gaps.push(`${lang}: the consent banner names Google`);
    }
  }
  if (input.consentVersion < 2) {
    gaps.push('CONSENT_VERSION moved, so a yes given to the first-party notice never loads Google');
  }
  if (/does not load Google Analytics yet/.test(input.guide.en)) {
    gaps.push('en: the integrations guide says the site loads Google Analytics');
  }
  if (/لا يحمّل الموقع Google Analytics بعد/.test(input.guide.ar)) {
    gaps.push('ar: the integrations guide says the site loads Google Analytics');
  }
  if (!/data-consent-open/.test(input.publicMarkup)) {
    gaps.push('a control on every page reopens the consent banner (data-consent-open)');
  }
  return gaps;
}

/** Every .astro file under src/components (the admin's aside) and src/layouts. */
function publicMarkup(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'admin') walk(path);
      } else if (entry.name.endsWith('.astro')) out.push(read(path));
    }
  };
  walk(join('src', 'components'));
  walk(join('src', 'layouts'));
  return out.join('\n');
}

function integrationsGuide(): { en: string; ar: string } {
  const guide = HelpArticleSeedSchema.parse(
    helpSet(readMigrations()).set.find((g) => g.slug === 'integrations'),
  );
  const text = (lang: 'en' | 'ar') =>
    guide.body[lang].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x])).join('\n');
  return { en: text('en'), ar: text('ar') };
}

const REAL: SwitchOnInputs = {
  legal: LEGAL,
  banner: read('src/components/ConsentBanner.astro'),
  consentVersion: CONSENT_VERSION,
  guide: integrationsGuide(),
  publicMarkup: publicMarkup(),
};

describe('where the GA4 switch is on today', () => {
  it('production: not in wrangler.jsonc, whose `vars` the deploy build reads', () => {
    expect(productionSwitch()).toBe(false);
  });

  it('reads the switch-on line as the switch-on PR will write it, and nothing else', () => {
    const vars = (line: string) => `{
  "vars": {
    "AI_DAILY_USD_CAP": "5",
${line}
  },
}`;
    expect(productionSwitch(vars('    "GA4_NOTICE_READY": "true",'))).toBe(true);
    expect(productionSwitch(vars('    "GA4_NOTICE_READY": true,'))).toBe(true);
    expect(productionSwitch(vars('    "GA4_NOTICE_READY": "false",'))).toBe(false);
    expect(productionSwitch(vars('    // "GA4_NOTICE_READY": "true",'))).toBe(false);
    expect(productionSwitch(vars(''))).toBe(false);
  });

  it('the declared default is off', () => {
    expect(read('astro.config.mjs')).toContain(
      "GA4_NOTICE_READY: envField.boolean({ context: 'server', access: 'public', default: false })",
    );
  });

  it('no build in ci.yml sets it (the deploy builds as production does)', () => {
    expect(code(read('.github/workflows/ci.yml'), '#')).not.toContain('GA4_NOTICE_READY');
  });

  it('the e2e job turns it on for its own build; the Lighthouse job and the shared env never do', () => {
    const workflow = code(read('.github/workflows/perf-seo-a11y.yml'), '#');
    const jobs = workflow.indexOf('\njobs:\n');
    const e2e = workflow.indexOf('\n  e2e:\n');
    const lighthouse = workflow.indexOf('\n  lighthouse:\n');
    expect(jobs).toBeGreaterThan(0);
    expect(e2e).toBeGreaterThan(jobs);
    expect(lighthouse).toBeGreaterThan(e2e);
    expect(workflow.slice(0, jobs)).not.toContain('GA4_NOTICE_READY');
    expect(workflow.slice(e2e, lighthouse).match(/GA4_NOTICE_READY: (.*)/g)).toEqual([
      "GA4_NOTICE_READY: 'true'",
    ]);
    expect(workflow.slice(lighthouse)).not.toContain('GA4_NOTICE_READY');
  });
});

describe('the switch-on guard', () => {
  it('production loads GA4 only with notices that name Google, and they name it only then', () => {
    const gaps = switchOnGaps(REAL);
    if (productionSwitch()) {
      expect(gaps, 'what the switch-on PR still lacks (launch runbook §2e)').toEqual([]);
    } else {
      // A notice naming a recipient that receives nothing is untrue too: the switch-on PR
      // carries the text and the switch together.
      expect(gaps).toContain('en: the privacy notice names Google Analytics as a recipient');
      expect(gaps).toContain('ar: the privacy notice names Google Analytics as a recipient');
    }
  });

  it('bites today: every gap is named while the notices are the first-party ones', () => {
    expect(switchOnGaps(REAL)).toEqual([
      'en: the privacy notice names Google Analytics as a recipient',
      'en: the cookie policy lists the _ga cookies and their lifetimes',
      'en: the privacy notice and the cookie policy carry the new date',
      'en: the consent banner names Google',
      'ar: the privacy notice names Google Analytics as a recipient',
      'ar: the cookie policy lists the _ga cookies and their lifetimes',
      'ar: the privacy notice and the cookie policy carry the new date',
      'ar: the consent banner names Google',
      'CONSENT_VERSION moved, so a yes given to the first-party notice never loads Google',
      'en: the integrations guide says the site loads Google Analytics',
      'ar: the integrations guide says the site loads Google Analytics',
      'a control on every page reopens the consent banner (data-consent-open)',
    ]);
  });

  it('passes a switch-on PR that carries all of it', () => {
    const signed = (lang: 'en' | 'ar', date: string): (typeof LEGAL)['en'] => {
      const docs = structuredClone(LEGAL[lang]);
      docs.privacy.updated = date;
      docs.cookie.updated = date;
      docs.privacy.sections.push({ heading: 'GA', body: ['Google Analytics receives…'] });
      docs.cookie.sections.push({ heading: 'GA', body: ['_ga and _ga_<id>: 180 days'] });
      return docs;
    };
    const banner = REAL.banner
      .replace("first-party analytics to improve it. See our'", "Google Analytics too. See our'")
      .replace(
        'لتحسينه إلا بموافقتك. اطّلع على',
        'لتحسينه وGoogle Analytics إلا بموافقتك. اطّلع على',
      );
    expect(banner).not.toBe(REAL.banner);
    expect(
      switchOnGaps({
        legal: {
          en: signed('en', 'Last updated: 1 December 2026'),
          ar: signed('ar', 'آخر تحديث: 1 ديسمبر 2026'),
        },
        banner,
        consentVersion: 2,
        guide: { en: 'It loads only once the notice names Google.', ar: 'يُحمَّل بعد ذلك فقط.' },
        publicMarkup: `${REAL.publicMarkup}<button type="button" data-consent-open>`,
      }),
    ).toEqual([]);
  });
});

describe('the property settings the notice drafts rely on (launch runbook §2e step 1, O-18)', () => {
  // The notice drafts promise what the build alone cannot hold: page addresses "without
  // anything after a ?", and nothing typed into a form or the search box. The loader sets the
  // page address once, at start, without its query; but a page view that enhanced measurement
  // sends on a browser history change reads the address afresh, and the Our Work and All
  // projects filters write their query into it (history.replaceState, catalogFilter.ts), while
  // form interactions and site search read what a visitor did. So the property keeps all three
  // off, and both the runbook's checklist and the owner item must say so.
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  const between = (text: string, start: string, end: string) => {
    const from = text.indexOf(start);
    const to = from === -1 ? -1 : text.indexOf(end, from + start.length);
    return from === -1 || to === -1 ? '' : flat(text.slice(from, to));
  };
  const REQUIRED_OFF = [
    /page changes based on browser history events OFF/i,
    /form interactions OFF/i,
    /site search off/i,
  ];

  it('the runbook’s property checklist turns off every setting that would send more', () => {
    const step = between(
      read('docs/launch-runbook.md'),
      '1. **The property (O-18).**',
      '2. **The notice sign-off.**',
    );
    expect(step).not.toBe('');
    for (const setting of REQUIRED_OFF) expect(step, String(setting)).toMatch(setting);
  });

  it('so does the owner item in the as-built, beside the notice that promises it', () => {
    const asBuilt = read('docs/admin-v2/as-built/U15.md');
    expect(flat(asBuilt)).toContain('without anything after a “?”');
    const item = between(asBuilt, '- **O-18, before the switch-on:**', '\n- **');
    expect(item).not.toBe('');
    for (const setting of REQUIRED_OFF) expect(item, String(setting)).toMatch(setting);
  });
});
