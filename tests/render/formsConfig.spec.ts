import { describe, expect, test } from 'vitest';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { formSettingsFromRow, type FormSettings } from '@/lib/forms/config';
import { APPLY_FORM_COPY } from '@/lib/forms/applicationCopy';
import type { SectionData } from '@/lib/sections/types';
import type { Locale } from '@schemas/primitives';
import { DISCIPLINES, IDENTITY } from './fixtures';
import { LOCALES, renderSections } from './harness';

// The two public forms rendered from a PUBLISHED forms config (Admin v2 E8). sections.spec.ts
// holds the no-row bytes; this file holds what a config changes on the page, through the path a
// page takes (SectionRenderer), in both languages: the order, the hidden and required optional
// fields, the labels, the budget words, the button, the Join consent lines and the version they
// post. The config is laid on the request (`locals.formSettings`, which formSettingsFor reads
// before any database), so no loader is mocked.

const t = (en: string, ar: string) => ({ en, ar });

const SETTINGS: FormSettings = formSettingsFromRow({
  inquiry: {
    fields: {
      name: { label: t('Your name, please', 'اسمك لو سمحت') },
      company: { required: true },
      phone: { visible: false },
      budget: { required: true, label: t('Rough budget', 'الميزانية التقريبية') },
    },
    // The message first, the name last.
    order: ['message', 'email', 'company', 'service', 'phone', 'budget', 'deadline', 'name'],
    button: t('Send it over', 'أرسلها'),
    budgets: { '75k_200k': t('Mid-size', 'متوسطة') },
  },
  application: {
    fields: {
      skills: { required: true, label: t('What you make', 'وش تسوي') },
      linkedin: { visible: false },
      cv: { required: true },
    },
    order: { about: ['city', 'name', 'email', 'phone'] },
    button: t('Apply now', 'قدّم الآن'),
    consent: {
      application: t('Yes, keep {brand} on file.', 'نعم، احتفظوا بـ {brand}.'),
      futureRoles: t('And for later roles too.', 'وللوظائف القادمة أيضاً.'),
    },
  },
  consent_revision: 3,
});

const extra = { formSettings: Promise.resolve(SETTINGS) };
const render = (sections: SectionData[], locale: Locale) =>
  renderSections(sections, locale, IDENTITY, extra);

/** The opening tag of the element with this id. */
const tagOf = (html: string, id: string): string => {
  const at = html.indexOf(`id="${id}"`);
  if (at === -1) throw new Error(`no #${id}`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
};
const isRequired = (html: string, id: string) => /\srequired(\s|>|=)/.test(tagOf(html, id));
const before = (html: string, a: string, b: string) =>
  html.indexOf(`id="${a}"`) < html.indexOf(`id="${b}"`);

const INQUIRY_SECTIONS: Record<string, { sections: SectionData[]; asks: string[] }> = {
  // The home form (compact): name, email, company, service, message.
  contact: {
    sections: [{ type: 'contact', props: {}, data: { groups: DISCIPLINES } }],
    asks: ['cf-message', 'cf-email', 'cf-company', 'cf-service', 'cf-name'],
  },
  // /contact (full): the same plus the budget and the deadline.
  contactInquiry: {
    sections: [{ type: 'contactInquiry', props: {}, data: { groups: DISCIPLINES } }],
    asks: [
      'cf-message',
      'cf-email',
      'cf-company',
      'cf-service',
      'cf-budget',
      'cf-deadline',
      'cf-name',
    ],
  },
  // The services pages' Say hello (hello): the phone too, which this config hides.
  hello: {
    sections: [{ type: 'hello', props: {}, data: { groups: DISCIPLINES } }],
    asks: ['cf-message', 'cf-email', 'cf-company', 'cf-service', 'cf-budget', 'cf-name'],
  },
};

describe('the inquiry form follows the published config', () => {
  for (const [type, { sections, asks }] of Object.entries(INQUIRY_SECTIONS)) {
    for (const locale of LOCALES) {
      test(`${type} (${locale})`, async () => {
        const html = await render(sections, locale);
        // The variant's own fields, in the config's order; a hidden one is not drawn.
        for (let i = 1; i < asks.length; i += 1) {
          expect(before(html, asks[i - 1]!, asks[i]!), `${asks[i - 1]} before ${asks[i]}`).toBe(
            true,
          );
        }
        expect(html).not.toContain('id="cf-phone"');
        // Required: the pipeline's three always, the company and the budget by the config.
        expect(isRequired(html, 'cf-company')).toBe(true);
        expect(isRequired(html, 'cf-name')).toBe(true);
        expect(isRequired(html, 'cf-service')).toBe(false);
        if (asks.includes('cf-budget')) {
          expect(isRequired(html, 'cf-budget')).toBe(true);
          expect(html).toContain(locale === 'en' ? 'Rough budget' : 'الميزانية التقريبية');
          expect(html).toContain(locale === 'en' ? 'Mid-size' : 'متوسطة');
        }
        if (asks.includes('cf-deadline')) expect(isRequired(html, 'cf-deadline')).toBe(false);
        // The labels and the button in the page's language.
        expect(html).toContain(locale === 'en' ? 'Your name, please' : 'اسمك لو سمحت');
        expect(html).toContain(locale === 'en' ? 'Send it over' : 'أرسلها');
      });
    }
  }

  test("a section's own button text still wins over the config's (Pages)", async () => {
    const html = await render(
      [
        {
          type: 'contactInquiry',
          props: { submitLabel: t('Authored submit', 'إرسال مكتوب') },
          data: { groups: DISCIPLINES },
        },
      ],
      'en',
    );
    expect(html).toContain('Authored submit');
    expect(html).not.toContain('Send it over');
  });
});

describe('the Join form follows the published config', () => {
  const sections: SectionData[] = [{ type: 'joinApply', props: {}, data: { answer: null } }];

  for (const locale of LOCALES) {
    test(`joinApply (${locale})`, async () => {
      const html = await render(sections, locale);
      const copy = APPLY_FORM_COPY[locale];
      // The order inside a group, and a hidden control not drawn.
      expect(before(html, 'af-city', 'af-name')).toBe(true);
      expect(before(html, 'af-name', 'af-email')).toBe(true);
      expect(html).not.toContain('id="af-linkedin"');
      // A required CV marks its input.
      expect(isRequired(html, 'af-cv')).toBe(true);
      // Required crafts: the label says so and the group carries the client's hook and words.
      const group = tagOf(html, 'af-skills-label');
      expect(group).toContain('class="af-label"');
      const chips = html.slice(html.lastIndexOf('<div', html.indexOf('id="af-skills-label"')));
      expect(chips.slice(0, chips.indexOf('>') + 1)).toContain('data-required="true"');
      expect(chips.slice(0, chips.indexOf('>') + 1)).toContain(
        `data-err-required="${copy.errors.skills}"`,
      );
      expect(html).toContain(locale === 'en' ? 'What you make' : 'وش تسوي');
      expect(html).toContain(copy.skillsRequired);
      // The button, the reworded consent lines (the brand filled) and the version they post.
      expect(html).toContain(locale === 'en' ? 'Apply now' : 'قدّم الآن');
      const brand = IDENTITY.brandName[locale];
      expect(html).toContain(
        locale === 'en' ? `Yes, keep ${brand} on file.` : `نعم، احتفظوا بـ ${brand}.`,
      );
      expect(html).toContain(
        locale === 'en' ? 'And for later roles too.' : 'وللوظائف القادمة أيضاً.',
      );
      expect(tagOf(html, 'apply-form')).toBeTruthy();
      expect(html).toContain(`name="policy_version" value="${RECRUITMENT_POLICY_VERSION}.r3"`);
    });
  }

  test('optional crafts carry no requirement (the built-in form)', async () => {
    const html = await renderSections(sections, 'en');
    const chips = html.slice(html.lastIndexOf('<div', html.indexOf('id="af-skills-label"')));
    expect(chips.slice(0, chips.indexOf('>') + 1)).not.toContain('data-required');
    expect(html).not.toContain(APPLY_FORM_COPY.en.skillsRequired);
    expect(html).toContain(`name="policy_version" value="${RECRUITMENT_POLICY_VERSION}"`);
  });
});
