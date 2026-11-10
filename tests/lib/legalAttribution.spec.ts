import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGAL } from '@/lib/legal/content';
import { ATTRIBUTION_COOKIE, ATTRIBUTION_PRIVACY } from '@/lib/legal/attribution';
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
