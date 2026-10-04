import { describe, expect, it } from 'vitest';
import { LEGAL, type LegalDoc } from '@/lib/legal/content';
import {
  LEGAL_TOKENS,
  legalParty,
  legalSegments,
  legalText,
  type LegalParty,
} from '@/lib/legal/render';
import { IDENTITY_FALLBACK, type Identity } from '@/lib/identity/fallback';
import { APPLICATION_RETENTION_MONTHS, SPAM_RETENTION_DAYS } from '@schemas/application';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';

// The legal copy (src/lib/legal/content.ts), filled from the public identity by
// src/lib/legal/render.ts and rendered by LegalPage.astro. Join: the application form's
// consent links to the privacy notice's recruitment section (/privacy#recruitment,
// /ar/privacy#recruitment) — so that section must exist in BOTH languages, under that id,
// and say what the brief and the schema say: what is collected, why, on what basis, for how
// long, who sees it, where it is kept, the CV caveats and the applicant's rights.
//
// Who and where come from `site_profile` (design-port J-17). The defect this replaces: the
// notices sent rights requests to a hardcoded mailbox on a domain the studio never owned.

const LOCALES = ['en', 'ar'] as const;
const KEYS = ['privacy', 'terms', 'cookie'] as const;

/** How the notices spell a month (MSA, the Gregorian names the copy already uses). */
const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const AR_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

const recruitment = (locale: 'en' | 'ar') =>
  LEGAL[locale].privacy.sections.find((s) => s.id === 'recruitment');

/** Every string of a document, labelled by where it sits. */
function slots(doc: LegalDoc): { where: string; text: string }[] {
  return [
    { where: 'title', text: doc.title },
    { where: 'updated', text: doc.updated },
    { where: 'draftNotice', text: doc.draftNotice },
    { where: 'intro', text: doc.intro },
    ...doc.sections.flatMap((s, i) => [
      { where: `sections[${i}].heading`, text: s.heading },
      ...s.body.map((text, j) => ({ where: `sections[${i}].body[${j}]`, text })),
    ]),
  ];
}

/** A document with every token filled — what a visitor reads. */
function filled(doc: LegalDoc, party: LegalParty): string {
  return slots(doc)
    .map(({ text }) => legalText(text, party))
    .join('\n');
}

describe('legal content', () => {
  it('section ids are unique, fragment-safe, and the same in both languages', () => {
    for (const key of KEYS) {
      const ids = (locale: 'en' | 'ar') =>
        LEGAL[locale][key].sections.map((s) => s.id).filter((id) => id !== undefined);
      expect(ids('ar'), key).toEqual(ids('en'));
      expect(new Set(ids('en')).size, key).toBe(ids('en').length);
      for (const id of ids('en')) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('the EN and AR documents have the same shape (section for section)', () => {
    for (const key of KEYS) {
      expect(LEGAL.ar[key].sections.length, key).toBe(LEGAL.en[key].sections.length);
    }
  });

  it('spells no brand, no company and no address: the identity fills them (CLAUDE.md §1)', () => {
    const all = JSON.stringify(LEGAL);
    expect(all).not.toMatch(/Braiin|بري[ّ]?ن|ستيشن/);
    expect(all).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it('uses only the three tokens, and only in the intro and the body', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        for (const { where, text } of slots(LEGAL[locale][key])) {
          for (const [, word] of text.matchAll(/%([A-Za-z_]+)%/g)) {
            expect(LEGAL_TOKENS, `${locale}.${key}.${where}: %${word}%`).toContain(word);
            expect(where, `${locale}.${key}: a token in ${where}`).toMatch(
              /^(intro|sections\[\d+\]\.body)/,
            );
          }
        }
      }
    }
  });

  it('the mailbox appears exactly twice per locale — the DSAR line and the recruitment section', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        const hits = slots(LEGAL[locale][key]).flatMap(({ where, text }) =>
          text.includes('%mailbox%') ? [where] : [],
        );
        if (key !== 'privacy') expect(hits, `${locale}.${key}`).toEqual([]);
        else expect(hits, locale).toHaveLength(2);
      }
      const dsar = LEGAL[locale].privacy.sections[3]!;
      expect(dsar.heading, locale).toBe(locale === 'en' ? 'Your rights (DSAR)' : 'حقوقك');
      expect(dsar.body.join('\n'), locale).toContain('%mailbox%');
      expect(recruitment(locale)!.body.join('\n'), locale).toContain('%mailbox%');
    }
  });

  it('every notice carries the newest recruitment notice’s date — one change (J-17)', () => {
    // Derived, never spelled here: the notices' `updated` lines and the version appended to
    // RECRUITMENT_POLICY_VERSIONS name the day the change merges, so a re-date moves both
    // and this fails when only one moves. J-17's rule (an identity edit moves the dates and
    // appends a version) keeps them equal; a later edit to the notices that changes no
    // recruitment text revises this test.
    const [year, month, day] = RECRUITMENT_POLICY_VERSION.split('-').map(Number) as [
      number,
      number,
      number,
    ];
    const en = `Last updated: ${day} ${EN_MONTHS[month - 1]!} ${year}`;
    const ar = `آخر تحديث: ${day} ${AR_MONTHS[month - 1]!} ${year}`;
    for (const key of KEYS) {
      expect(LEGAL.en[key].updated, key).toBe(en);
      expect(LEGAL.ar[key].updated, key).toBe(ar);
    }
  });
});

describe('legalParty — who the notices name', () => {
  it('sends privacy requests to the site’s contact address — never the one-i domain', () => {
    // Fixed reference: the code fallback IS the production identity's address
    // (tests/seed/seeds.spec.ts holds the seeded row to it).
    for (const locale of LOCALES) {
      const party = legalParty(IDENTITY_FALLBACK, locale);
      expect(party.mailbox).toBe(IDENTITY_FALLBACK.contactEmail);
      expect(party.mailbox).toBe('hello@braiinstatiion.com');
      expect(party.mailbox).not.toMatch(/@braiinstation\.com$/i);
    }
  });

  it('the controller is the brand until a registered legal name is set, then that name', () => {
    expect(legalParty(IDENTITY_FALLBACK, 'en')).toEqual({
      brand: 'Braiin Statiion',
      controller: 'Braiin Statiion',
      mailbox: 'hello@braiinstatiion.com',
    });
    expect(legalParty(IDENTITY_FALLBACK, 'ar').controller).toBe('بريّن ستيشن');

    const registered: Identity = {
      ...IDENTITY_FALLBACK,
      legalName: { en: '  Braiin Statiion Co.  ', ar: 'شركة بريّن ستيشن' },
    };
    expect(legalParty(registered, 'en').controller).toBe('Braiin Statiion Co.');
    expect(legalParty(registered, 'ar').controller).toBe('شركة بريّن ستيشن');
    expect(legalParty(registered, 'en').brand).toBe('Braiin Statiion');

    // A blank translation falls back to the brand rather than naming nobody.
    const blank: Identity = { ...IDENTITY_FALLBACK, legalName: { en: 'Co.', ar: '  ' } };
    expect(legalParty(blank, 'ar').controller).toBe('بريّن ستيشن');
  });
});

describe('legalText / legalSegments — filling the copy', () => {
  const party = legalParty(IDENTITY_FALLBACK, 'en');

  it('the DSAR line renders exactly one mailbox slot, with the contact address', () => {
    for (const locale of LOCALES) {
      const p = legalParty(IDENTITY_FALLBACK, locale);
      const line = LEGAL[locale].privacy.sections[3]!.body.find((b) => b.includes('%mailbox%'))!;
      const mailboxes = legalSegments(line, p).filter((s) => s.kind === 'mailbox');
      expect(mailboxes, locale).toEqual([{ kind: 'mailbox', address: 'hello@braiinstatiion.com' }]);
    }
  });

  it('splits text around the mailbox and fills the other tokens in the runs', () => {
    expect(legalSegments('Ask %controller% at %mailbox%. %brand% replies.', party)).toEqual([
      { kind: 'text', text: 'Ask Braiin Statiion at ' },
      { kind: 'mailbox', address: 'hello@braiinstatiion.com' },
      { kind: 'text', text: '. Braiin Statiion replies.' },
    ]);
    expect(legalSegments('%mailbox%', party)).toEqual([
      { kind: 'mailbox', address: 'hello@braiinstatiion.com' },
    ]);
    expect(legalSegments('No tokens.', party)).toEqual([{ kind: 'text', text: 'No tokens.' }]);
    expect(legalText('Write to %mailbox%.', party)).toBe('Write to hello@braiinstatiion.com.');
  });

  it('an identity value is inserted literally — no `$` patterns, no second pass', () => {
    // A brand or legal name is CMS data. Through a replacement STRING, `$&` would echo the
    // token and `$1` the capture; scanned twice, a brand containing %mailbox% would grow a
    // link. One pass with a function replacer does neither.
    const hostile: LegalParty = {
      brand: 'A$&B %mailbox%',
      controller: '$1 Co',
      mailbox: 'hello@braiinstatiion.com',
    };
    const text = 'By %controller% (%brand%): write to %mailbox%.';
    expect(legalText(text, hostile)).toBe(
      'By $1 Co (A$&B %mailbox%): write to hello@braiinstatiion.com.',
    );
    expect(legalSegments(text, hostile)).toEqual([
      { kind: 'text', text: 'By $1 Co (A$&B %mailbox%): write to ' },
      { kind: 'mailbox', address: 'hello@braiinstatiion.com' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves no token unfilled and no old brand in any filled document', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        const text = filled(LEGAL[locale][key], legalParty(IDENTITY_FALLBACK, locale));
        expect(text, `${locale}.${key}`).not.toMatch(/%(?:brand|controller|mailbox)%/);
        expect(text, `${locale}.${key}`).not.toMatch(/Braiin Station\b/);
      }
    }
  });
});

describe('the privacy notice’s recruitment section (Join)', () => {
  for (const locale of LOCALES) {
    it(`exists under #recruitment, last, with its heading — ${locale}`, () => {
      const section = recruitment(locale);
      expect(section).toBeDefined();
      expect(LEGAL[locale].privacy.sections.at(-1)).toBe(section);
      expect(section!.heading).toBe(
        locale === 'en' ? 'Job applications (the Join form)' : 'طلبات التوظيف (نموذج الانضمام)',
      );
    });

    it(`states the retention horizons the application rows carry — ${locale}`, () => {
      const text = recruitment(locale)!.body.join(' ');
      expect(text).toContain(String(APPLICATION_RETENTION_MONTHS.application));
      expect(text).toContain(String(APPLICATION_RETENTION_MONTHS.futureRoles));
      expect(text).toContain(String(SPAM_RETENTION_DAYS));
      expect(text).toMatch(locale === 'en' ? /deleted automatically/ : /يُحذف .* تلقائيًا/);
    });

    it(`says where it is kept, who sees it, and what a CV is not — ${locale}`, () => {
      const text = recruitment(locale)!.body.join(' ');
      expect(text).toContain('Supabase');
      expect(text).toMatch(locale === 'en' ? /London, United Kingdom/ : /لندن بالمملكة المتحدة/);
      expect(text).toMatch(locale === 'en' ? /administrators only/ : /مديرو الموقع فقط/);
      expect(text).toMatch(locale === 'en' ? /private storage bucket/ : /مستودع تخزين خاص/);
      expect(text).toMatch(locale === 'en' ? /not scanned for viruses/ : /لا تُفحص .* الفيروسات/);
      expect(text).toMatch(locale === 'en' ? /only as downloads/ : /كملفات مُنزَّلة فقط/);
    });

    it(`names consent as the basis and the way to withdraw or erase — ${locale}`, () => {
      const text = recruitment(locale)!
        .body.map((b) => legalText(b, legalParty(IDENTITY_FALLBACK, locale)))
        .join(' ');
      expect(text).toMatch(
        locale === 'en' ? /Lawful basis: your consent/ : /الأساس النظامي: موافقتك/,
      );
      expect(text).toMatch(locale === 'en' ? /withdraw/ : /سحب/);
      expect(text).toMatch(locale === 'en' ? /erase/ : /حذفه/);
      // The filled text gives the site's contact address for the rights.
      expect(text).toContain(IDENTITY_FALLBACK.contactEmail);
      // What the form collects, CV included.
      expect(text).toMatch(
        locale === 'en' ? /your CV, if you attach one/ : /سيرتك الذاتية إن أرفقتها/,
      );
    });
  }
});
