import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGAL } from '@/lib/legal/content';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_NOTICE_HELD,
  ATTRIBUTION_PRIVACY,
} from '@/lib/legal/attribution';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { ATTRIBUTION_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { FIRST_TOUCH_KEY } from '@/lib/client/attribution';

// C13's part of the notices (HELD for O-11; src/lib/legal/attribution.ts). The text the site
// shows is the text the lawyer signs off (docs/legal/privacy-notice-c13-attribution.md), and
// it says what the code does: only with analytics consent, these columns and never the IP, kept
// for the visit in session storage and then with the inquiry.

const LOCALES = ['en', 'ar'] as const;
const SIGN_OFF = readFileSync(
  join(process.cwd(), 'docs', 'legal', 'privacy-notice-c13-attribution.md'),
  'utf8',
);
const REGISTER = readFileSync(join(process.cwd(), 'docs', 'legal', 'review-register.md'), 'utf8');

/**
 * The notices' date before C13's sections (legal.spec derives the "Last updated" lines from the
 * recruitment notice version, J-17): the merge must move it past this.
 */
const PRE_C13_NOTICE_VERSION = '2026-10-04';

/** C13's register rows: [id, severity, status]. */
const C13_ROWS = [
  ...REGISTER.matchAll(/^\| (L-C13-\d+) \|.*\| (HIGH|MEDIUM|LOW) \| ([a-z]+) \|/gm),
].map((m) => [m[1]!, m[2]!, m[3]!] as const);

describe('the notices carry C13’s sections, in both languages', () => {
  it('the privacy notice has the attribution section just before the Join one, the cookie policy ends with the storage one', () => {
    for (const locale of LOCALES) {
      const sections = LEGAL[locale].privacy.sections;
      expect(sections.at(-2), locale).toBe(ATTRIBUTION_PRIVACY[locale]);
      expect(sections.at(-1)?.id, locale).toBe('recruitment');
      expect(LEGAL[locale].cookie.sections.at(-1), locale).toBe(ATTRIBUTION_COOKIE[locale]);
    }
  });

  it('the sections have the same ids and the same number of paragraphs in EN and AR', () => {
    for (const doc of [ATTRIBUTION_PRIVACY, ATTRIBUTION_COOKIE]) {
      expect(doc.ar.id).toBe(doc.en.id);
      expect(doc.ar.body).toHaveLength(doc.en.body.length);
    }
  });

  it('every heading and paragraph is in the sign-off file, word for word', () => {
    for (const doc of [ATTRIBUTION_PRIVACY, ATTRIBUTION_COOKIE]) {
      for (const locale of LOCALES) {
        expect(SIGN_OFF, `${locale} heading`).toContain(`**${doc[locale].heading}**`);
        for (const paragraph of doc[locale].body) expect(SIGN_OFF, paragraph).toContain(paragraph);
      }
    }
  });

  it('never claims compliance, and uses no token (the mailbox stays the DSAR line’s)', () => {
    const all = JSON.stringify([ATTRIBUTION_PRIVACY, ATTRIBUTION_COOKIE]);
    expect(all).not.toMatch(/complian|PDPL-compliant|fully legal/i);
    expect(all).not.toMatch(/%[a-z_]+%/i);
    expect(SIGN_OFF).toMatch(/Nothing here is legal advice or a compliance sign-off/);
  });
});

describe('held until the lawyer approves, and the dates move at the merge (C13 review COR-4)', () => {
  it('the register carries C13’s rows', () => {
    expect(C13_ROWS.length).toBeGreaterThanOrEqual(8);
  });

  it('held while a C13 HIGH question is open; released once none is', () => {
    const openHigh = C13_ROWS.filter(([, sev, status]) => sev === 'HIGH' && status === 'open');
    // Recording the lawyer's answers (merge step 1) fails this until ATTRIBUTION_NOTICE_HELD
    // is set to false, which then requires the dates below to move.
    expect(ATTRIBUTION_NOTICE_HELD).toBe(openHigh.length > 0);
  });

  it('released: the notices are dated after C13’s sections were added', () => {
    if (ATTRIBUTION_NOTICE_HELD) {
      // Held: the sign-off file still says so. (The dates may move first with C5's part, which
      // shares the notices' dates.)
      expect(SIGN_OFF).toMatch(/Status: draft, not approved/);
      expect(RECRUITMENT_POLICY_VERSION >= PRE_C13_NOTICE_VERSION).toBe(true);
    } else {
      expect(RECRUITMENT_POLICY_VERSION > PRE_C13_NOTICE_VERSION).toBe(true);
    }
  });
});

describe('the words match the code', () => {
  const en = ATTRIBUTION_PRIVACY.en.body.join('\n');

  it('only with analytics consent, and the lawful basis is that consent', () => {
    expect(en).toMatch(/if you have allowed analytics cookies/);
    expect(en).toMatch(/Lawful basis: your consent/);
    expect(ATTRIBUTION_PRIVACY.ar.body.join('\n')).toMatch(/الأساس النظامي: موافقتك/);
  });

  it('names every column it records, and what it never records', () => {
    // landing_path, referrer_host, utm_source/medium/campaign, device_class, country
    expect(ATTRIBUTION_LEAD_COLUMNS.split(',')).toHaveLength(7);
    for (const phrase of [
      'the page you sent it from',
      'the name of the website that sent you',
      'source, medium and campaign name',
      'a phone, a tablet or a computer',
      'the country your connection comes from',
    ]) {
      expect(en, phrase).toContain(phrase);
    }
    for (const phrase of ['IP address', 'full web addresses', 'your city']) {
      expect(en, phrase).toContain(phrase);
    }
  });

  it('says what the build does: the first page seen with consent, a stored identifier, the tab (C13 review)', () => {
    const ar = ATTRIBUTION_PRIVACY.ar.body.join('\n');
    // The tags and referrer are those of the first page seen WITH consent (COR-2, S7).
    expect(en).toMatch(/first page you viewed in that visit after allowing analytics cookies/);
    expect(en).not.toMatch(/the link you first arrived by/);
    expect(ar).toMatch(/أول صفحة زرتها في تلك الزيارة بعد موافقتك/);
    // No stored identifier, not "nothing that links" (S4; the inference is register L-C13-8).
    expect(en).toMatch(/We store no identifier that links your inquiry/);
    expect(en).not.toMatch(/or anything that links your inquiry/);
    // bs_ft stays in the tab until it closes; an inquiry keeps a copy (COR-3).
    expect(en).toMatch(/kept in the tab’s session storage until you close the tab/);
    expect(en).not.toMatch(/until you send an inquiry/);
    expect(ar).toMatch(/تُحفظ نسخة منه مع طلبك/);
    expect(REGISTER).toMatch(/\| L-C13-8 \|/);
  });

  it('names the session storage key the browser uses', () => {
    for (const locale of LOCALES) {
      expect(ATTRIBUTION_COOKIE[locale].body.join('\n'), locale).toContain(FIRST_TOUCH_KEY);
    }
  });

  it('never names Google Analytics or its cookies (that is the GA4 switch-on’s notice)', () => {
    const all = JSON.stringify([ATTRIBUTION_PRIVACY, ATTRIBUTION_COOKIE]);
    expect(all).not.toMatch(/Google Analytics|\b_ga\b/);
  });
});
