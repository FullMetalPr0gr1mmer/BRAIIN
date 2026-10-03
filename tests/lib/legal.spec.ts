import { describe, expect, it } from 'vitest';
import { LEGAL, PRIVACY_MAILBOX } from '@/lib/legal/content';
import { APPLICATION_RETENTION_MONTHS, SPAM_RETENTION_DAYS } from '@schemas/application';

// The legal copy (src/lib/legal/content.ts), rendered by LegalPage.astro. Join: the
// application form's consent links to the privacy notice's recruitment section
// (/privacy#recruitment, /ar/privacy#recruitment) — so that section must exist in BOTH
// languages, under that id, and say what the brief and the schema say: what is collected,
// why, on what basis, for how long, who sees it, where it is kept, the CV caveats and the
// applicant's rights.

const recruitment = (locale: 'en' | 'ar') =>
  LEGAL[locale].privacy.sections.find((s) => s.id === 'recruitment');

describe('legal content', () => {
  it('section ids are unique, fragment-safe, and the same in both languages', () => {
    for (const key of ['privacy', 'terms', 'cookie'] as const) {
      const ids = (locale: 'en' | 'ar') =>
        LEGAL[locale][key].sections.map((s) => s.id).filter((id) => id !== undefined);
      expect(ids('ar'), key).toEqual(ids('en'));
      expect(new Set(ids('en')).size, key).toBe(ids('en').length);
      for (const id of ids('en')) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('the EN and AR documents have the same shape (section for section)', () => {
    for (const key of ['privacy', 'terms', 'cookie'] as const) {
      expect(LEGAL.ar[key].sections.length, key).toBe(LEGAL.en[key].sections.length);
    }
  });

  it('the DSAR line and the recruitment section name the same mailbox', () => {
    for (const locale of ['en', 'ar'] as const) {
      const all = LEGAL[locale].privacy.sections.flatMap((s) => s.body).join('\n');
      expect(all.split(PRIVACY_MAILBOX).length - 1, locale).toBe(2);
    }
  });
});

describe('the privacy notice’s recruitment section (Join)', () => {
  for (const locale of ['en', 'ar'] as const) {
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
      const text = recruitment(locale)!.body.join(' ');
      expect(text).toMatch(
        locale === 'en' ? /Lawful basis: your consent/ : /الأساس النظامي: موافقتك/,
      );
      expect(text).toMatch(locale === 'en' ? /withdraw/ : /سحب/);
      expect(text).toMatch(locale === 'en' ? /erase/ : /حذفه/);
      expect(text).toContain(PRIVACY_MAILBOX);
      // What the form collects, CV included.
      expect(text).toMatch(
        locale === 'en' ? /your CV, if you attach one/ : /سيرتك الذاتية إن أرفقتها/,
      );
    });
  }

  it('the old brand spelling appears nowhere in it', () => {
    for (const locale of ['en', 'ar'] as const) {
      expect(recruitment(locale)!.body.join(' ')).not.toMatch(/Braiin Station\b/);
    }
  });
});
