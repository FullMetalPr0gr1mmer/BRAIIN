import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FIELDS,
  APPLICATION_OPTIONAL_FIELDS,
  ApplicationConfigSchema,
  FORM_COPY_FORBIDDEN,
  FormSettingsWriteSchema,
  INQUIRY_FIELDS,
  INQUIRY_OPTIONAL_FIELDS,
  InquiryConfigSchema,
} from '@schemas/forms';
import { ApplicationInputSchema, RecruitmentPolicyVersionSchema } from '@schemas/application';
import { BUDGET_BAND_LABELS } from '@schemas/lead';
import { RECRUITMENT_CONSENT, RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import {
  APPLICATION_LABELS,
  BUILT_IN_FORMS,
  FORM_SETTINGS_PUBLIC_COLUMNS,
  INQUIRY_LABELS,
  applicationView,
  checkApplication,
  checkInquiry,
  consentVersion,
  formSettingsFromRow,
  inquiryFieldsFor,
  inquiryView,
  readApplicationConfig,
  readInquiryConfig,
} from '@/lib/forms/config';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import {
  CONTACT_FORM_FIELDS,
  buildContactPayload,
  variantOfForm,
} from '@/lib/forms/contactPayload';
import { parseRequiredClaim, REQUIRED_CLAIM_INPUT } from '@/lib/forms/requiredClaim';

// The forms config (Admin v2 E8): the closed field sets, the copy rules, the resolution over the
// built-in forms, and the per-variant rules /api/contact applies. The endpoints' own behaviour
// is tests/api/contactForms.spec.ts and tests/api/apply.spec.ts.

const BI = (en: string, ar: string) => ({ en, ar });

describe('the closed field sets', () => {
  it("INQUIRY_FIELDS keeps every variant's own order (each variant is a subsequence)", () => {
    for (const [variant, fields] of Object.entries(CONTACT_FORM_FIELDS)) {
      const order = INQUIRY_FIELDS.filter((f) => (fields as readonly string[]).includes(f));
      expect(order, variant).toEqual([...fields]);
    }
    expect([...new Set(Object.values(CONTACT_FORM_FIELDS).flat())].sort()).toEqual(
      [...INQUIRY_FIELDS].sort(),
    );
  });

  it('only optional fields can be hidden or required: name, e-mail and message have a label only', () => {
    expect(INQUIRY_OPTIONAL_FIELDS).not.toContain('name');
    expect(INQUIRY_OPTIONAL_FIELDS).not.toContain('email');
    expect(INQUIRY_OPTIONAL_FIELDS).not.toContain('message');
    for (const field of ['name', 'email', 'message']) {
      expect(
        InquiryConfigSchema.safeParse({ fields: { [field]: { visible: false } } }).success,
      ).toBe(false);
      expect(
        InquiryConfigSchema.safeParse({ fields: { [field]: { label: BI('A', 'ب') } } }).success,
      ).toBe(true);
    }
  });

  it("the Join form's optional controls are exactly what ApplicationInputSchema leaves optional", () => {
    const shape = ApplicationInputSchema.shape as Record<string, { isOptional(): boolean }>;
    // The CV is a file, not a schema key; skills default to [] (optional to the visitor).
    for (const field of APPLICATION_FIELDS) {
      if (field === 'cv' || field === 'skills' || field === 'workType') continue;
      expect(shape[field]?.isOptional(), field).toBe(
        (APPLICATION_OPTIONAL_FIELDS as readonly string[]).includes(field),
      );
    }
    for (const field of APPLICATION_FIELDS.filter(
      (f) => !(APPLICATION_OPTIONAL_FIELDS as readonly string[]).includes(f),
    )) {
      expect(
        ApplicationConfigSchema.safeParse({ fields: { [field]: { required: false } } }).success,
        field,
      ).toBe(false);
    }
  });

  it('no field can be added: an unknown key is refused', () => {
    expect(InquiryConfigSchema.safeParse({ fields: { website: {} } }).success).toBe(false);
    expect(ApplicationConfigSchema.safeParse({ fields: { salary: {} } }).success).toBe(false);
    expect(InquiryConfigSchema.safeParse({ captcha: true }).success).toBe(false);
  });

  it('an order is a whole permutation, each field once', () => {
    expect(InquiryConfigSchema.safeParse({ order: [...INQUIRY_FIELDS].reverse() }).success).toBe(
      true,
    );
    expect(InquiryConfigSchema.safeParse({ order: INQUIRY_FIELDS.slice(1) }).success).toBe(false);
    const twice = [...INQUIRY_FIELDS.slice(0, -1), 'name'];
    expect(InquiryConfigSchema.safeParse({ order: twice }).success).toBe(false);
  });

  it('a hidden field cannot be required', () => {
    expect(
      InquiryConfigSchema.safeParse({ fields: { phone: { visible: false, required: true } } })
        .success,
    ).toBe(false);
  });
});

describe('copy is plain text, in both languages', () => {
  it('refuses markup brackets, line breaks and control characters, and an empty Arabic half', () => {
    for (const bad of ['<b>Send</b>', 'a > b', 'Se\nnd', 'tab\there', '\u0085']) {
      expect(FORM_COPY_FORBIDDEN.test(bad), JSON.stringify(bad)).toBe(true);
      expect(InquiryConfigSchema.safeParse({ button: BI(bad, 'أرسل') }).success).toBe(false);
    }
    expect(InquiryConfigSchema.safeParse({ button: { en: 'Send' } }).success).toBe(false);
    expect(InquiryConfigSchema.safeParse({ button: BI('Send', '  ') }).success).toBe(false);
    expect(InquiryConfigSchema.safeParse({ button: BI('Send it', 'أرسل') }).success).toBe(true);
  });

  it('the admin save is strict and carries the version', () => {
    expect(FormSettingsWriteSchema.safeParse({ version: 0 }).success).toBe(true);
    expect(FormSettingsWriteSchema.safeParse({ inquiry: {}, version: 1 }).success).toBe(true);
    expect(FormSettingsWriteSchema.safeParse({ inquiry: {} }).success).toBe(false);
    expect(
      FormSettingsWriteSchema.safeParse({ inquiry: {}, version: 1, consentRevision: 9 }).success,
    ).toBe(false);
  });
});

describe('the built-in forms, and a stored config read part by part', () => {
  it('with no row every form is as built: the code labels, budgets and consent lines', () => {
    expect(formSettingsFromRow(null)).toBe(BUILT_IN_FORMS);
    const view = inquiryView(BUILT_IN_FORMS.inquiry, 'full', 'en');
    expect(view.fields.map((f) => f.field)).toEqual([...CONTACT_FORM_FIELDS.full]);
    expect(view.fields.map((f) => f.label)).toEqual(
      CONTACT_FORM_FIELDS.full.map((f) => CONTACT_FORM_COPY.en[f]),
    );
    expect(view.button).toBeNull();
    expect(view.budgets.gt_200k).toBe(BUDGET_BAND_LABELS.gt_200k.en);
    const join = applicationView(BUILT_IN_FORMS, 'ar');
    expect(join.consent).toEqual({
      application: RECRUITMENT_CONSENT.ar.application,
      futureRoles: RECRUITMENT_CONSENT.ar.futureRoles,
    });
    expect(join.policyVersion).toBe(RECRUITMENT_POLICY_VERSION);
    expect(INQUIRY_LABELS.name.ar).toBe(CONTACT_FORM_COPY.ar.name);
    expect(APPLICATION_LABELS.cv.en.length).toBeGreaterThan(0);
  });

  it('a stored config relabels, reorders, hides and requires', () => {
    const config = InquiryConfigSchema.parse({
      fields: {
        company: { visible: false },
        phone: { required: true, label: BI('Mobile', 'الجوال') },
      },
      order: ['email', 'name', 'phone', 'company', 'service', 'budget', 'deadline', 'message'],
      button: BI('Go', 'اذهب'),
      budgets: { lt_25k: BI('Small', 'صغير') },
    });
    expect(inquiryFieldsFor(config, 'hello')).toEqual([
      'email',
      'name',
      'phone',
      'service',
      'budget',
      'message',
    ]);
    const view = inquiryView(config, 'hello', 'ar');
    expect(view.fields.find((f) => f.field === 'phone')).toEqual({
      field: 'phone',
      label: 'الجوال',
      required: true,
    });
    expect(view.button).toBe('اذهب');
    expect(view.budgets.lt_25k).toBe('صغير');
  });

  it('a row written around the Worker costs each bad part its built-in value, never the page', () => {
    const inquiry = readInquiryConfig({
      button: '<b>x</b>',
      order: ['name'],
      fields: { phone: { required: true }, name: { visible: false } },
      budgets: { lt_25k: BI('Small', 'صغير'), gt_200k: 'big' },
    });
    expect(inquiry).toEqual({
      fields: { phone: { required: true } },
      budgets: { lt_25k: BI('Small', 'صغير') },
    });
    expect(readApplicationConfig('nope')).toEqual({});
    expect(readApplicationConfig({ consent: { application: BI('Yes', 'نعم'), extra: 1 } })).toEqual(
      {
        consent: { application: BI('Yes', 'نعم') },
      },
    );
    expect(formSettingsFromRow({ inquiry: 5, application: [], consent_revision: -2 })).toEqual({
      inquiry: {},
      application: {},
      consentRevision: 0,
    });
  });
});

describe('the consent version', () => {
  const reworded = (revision: number) =>
    formSettingsFromRow({
      inquiry: {},
      application: { consent: { application: BI('I agree', 'أوافق') } },
      consent_revision: revision,
    });

  it('is the notice date, plus .rN once the lines are reworded', () => {
    expect(consentVersion(BUILT_IN_FORMS)).toBe(RECRUITMENT_POLICY_VERSION);
    expect(consentVersion(reworded(3))).toBe(`${RECRUITMENT_POLICY_VERSION}.r3`);
    expect(applicationView(reworded(3), 'en').consent.application).toBe('I agree');
  });

  it('a reworded config with no revision shows the notice lines, never an unrecorded version', () => {
    expect(consentVersion(reworded(0))).toBe(RECRUITMENT_POLICY_VERSION);
    expect(applicationView(reworded(0), 'en').consent.application).toBe(
      RECRUITMENT_CONSENT.en.application,
    );
  });

  it('the schema takes a published date with an optional revision, never a revision 0', () => {
    expect(
      RecruitmentPolicyVersionSchema.safeParse(`${RECRUITMENT_POLICY_VERSION}.r12`).success,
    ).toBe(true);
    expect(
      RecruitmentPolicyVersionSchema.safeParse(`${RECRUITMENT_POLICY_VERSION}.r0`).success,
    ).toBe(false);
    expect(RecruitmentPolicyVersionSchema.safeParse('1999-01-01.r1').success).toBe(false);
  });
});

describe('which form sent it', () => {
  it('is read from its data-form-variant, a known variant only (CR8)', () => {
    for (const variant of Object.keys(CONTACT_FORM_FIELDS)) {
      expect(variantOfForm(variant)).toBe(variant);
    }
    for (const other of [undefined, null, '', 'contact-form--hello', 'sidebar', 'toString']) {
      expect(variantOfForm(other)).toBeUndefined();
    }
  });

  it('checkInquiry never lets a submission keep a field its own form does not show', () => {
    const lead = {
      kind: 'contact',
      locale: 'en',
      name: 'Sam',
      email: 'sam@example.com',
      message: 'Hi there.',
      phone: '+966500000001',
      consentMarketing: false,
      hp: '',
    } as Parameters<typeof checkInquiry>[0];
    const out = checkInquiry(lead, {}, 'full');
    expect(out.ok && 'phone' in out.data).toBe(false);
    const hello = checkInquiry(lead, {}, 'hello');
    expect(hello.ok && hello.data.phone).toBe('+966500000001');
  });
});

describe('what the sending page showed as required (CR1)', () => {
  const lead = {
    kind: 'contact',
    locale: 'en',
    name: 'Sam',
    email: 'sam@example.com',
    message: 'Hi there.',
    consentMarketing: false,
    hp: '',
  } as Parameters<typeof checkInquiry>[0];
  const budgetRequired = { fields: { budget: { required: true } } };

  it('each view lists the optional fields it shows as required, and only those', () => {
    expect(inquiryView({}, 'full', 'en').requiredOptional).toEqual([]);
    expect(
      inquiryView(
        { fields: { budget: { required: true }, phone: { required: true } } },
        'full',
        'en',
      ).requiredOptional,
    ).toEqual(['budget']);
    expect(applicationView(BUILT_IN_FORMS, 'en').requiredOptional).toEqual([]);
    const join = formSettingsFromRow({
      application: { fields: { cv: { required: true }, linkedin: { visible: false } } },
    });
    expect(applicationView(join, 'ar').requiredOptional).toEqual(['cv']);
  });

  it('checkInquiry requires a field only when the page showed it as required; no claim, the config alone', () => {
    expect(checkInquiry(lead, budgetRequired, 'full', []).ok).toBe(true);
    expect(checkInquiry(lead, budgetRequired, 'full', ['budget'])).toEqual({
      ok: false,
      fields: ['budgetBand'],
    });
    expect(checkInquiry(lead, budgetRequired, 'full')).toEqual({
      ok: false,
      fields: ['budgetBand'],
    });
    // A claim never requires what the config does not.
    expect(checkInquiry(lead, {}, 'full', ['budget', 'company']).ok).toBe(true);
    // The claim is not part of the lead.
    const out = checkInquiry({ ...lead, requiredFields: [] }, {}, 'full', []);
    expect(out.ok && 'requiredFields' in out.data).toBe(false);
  });

  it('checkApplication: the same rule for the crafts, LinkedIn and the CV', () => {
    const input = ApplicationInputSchema.parse({
      locale: 'en',
      name: 'Noura',
      email: 'noura@example.com',
      phone: '+966500000000',
      city: 'Jeddah',
      role: 'Motion designer',
      experience: '3-6',
      workType: 'freelance',
      availability: 'month',
      skills: [],
      portfolio: 'https://behance.net/noura',
      message: 'The launch film.',
      consentApplication: true,
      consentFutureRoles: false,
      policyVersion: RECRUITMENT_POLICY_VERSION,
    });
    const settings = formSettingsFromRow({
      application: {
        fields: {
          skills: { required: true },
          linkedin: { required: true },
          cv: { required: true },
        },
      },
    });
    expect(checkApplication(input, false, settings, []).ok).toBe(true);
    expect(checkApplication(input, false, settings, ['cv'])).toEqual({ ok: false, fields: ['cv'] });
    expect(checkApplication(input, false, settings)).toEqual({
      ok: false,
      fields: ['skills', 'linkedin', 'cv'],
    });
  });

  it('the claim is read from the form control or the JSON, and is absent when nothing was sent', () => {
    expect(parseRequiredClaim('budget  service')).toEqual(['budget', 'service']);
    expect(parseRequiredClaim('')).toEqual([]);
    expect(parseRequiredClaim(['cv', 3, 'skills'])).toEqual(['cv', 'skills']);
    expect(parseRequiredClaim(null)).toBeUndefined();
    expect(parseRequiredClaim(undefined)).toBeUndefined();
    // Only the claim's first 528 characters are read (16 names of 32): a 10 MB value posted to
    // /api/apply is bounded before it is split (E8 check P1), so a name past the bound is unread.
    expect(parseRequiredClaim(`${' '.repeat(10_000)}cv`)).toEqual([]);
    expect(parseRequiredClaim(`cv${' x'.repeat(5_000_000)}`)).toHaveLength(16);
    expect(parseRequiredClaim([...Array<number>(100).fill(0), 'cv'])).toEqual([]);
    // The contact form posts it as requiredFields, an empty list included.
    const fields: Record<string, string> = {
      name: 'Sam',
      email: 'sam@example.com',
      message: 'Hi',
      [REQUIRED_CLAIM_INPUT]: '',
    };
    const get = (name: string) => fields[name] ?? null;
    expect(buildContactPayload(get, { kind: 'contact', locale: 'en' })['requiredFields']).toEqual(
      [],
    );
    delete fields[REQUIRED_CLAIM_INPUT];
    expect(buildContactPayload(get, { kind: 'contact', locale: 'en' })).not.toHaveProperty(
      'requiredFields',
    );
  });
});

describe('one list of the columns the published config is read with (CR10)', () => {
  it('both readers select FORM_SETTINGS_PUBLIC_COLUMNS, and it is the anon grant less the tenant', () => {
    for (const file of ['src/lib/forms/published.ts', 'src/lib/data/forms.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('.select(FORM_SETTINGS_PUBLIC_COLUMNS)');
      expect(source, file).not.toMatch(/'inquiry,application,consent_revision'/);
    }
    const migration = readdirSync('supabase/migrations').find((f) =>
      f.endsWith('_forms_config.sql'),
    );
    const sql = readFileSync(`supabase/migrations/${migration}`, 'utf8');
    const grant = /grant select \(([^)]+)\) on public\.form_settings to anon;/.exec(sql);
    const columns = grant![1]!.split(',').map((c) => c.trim());
    expect(columns.filter((c) => c !== 'tenant_id')).toEqual(
      FORM_SETTINGS_PUBLIC_COLUMNS.split(','),
    );
  });
});
