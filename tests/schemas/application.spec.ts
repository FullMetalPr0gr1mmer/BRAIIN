import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  APPLICATION_FORM_FIELDS,
  APPLICATION_STATUSES,
  APPLY_BODY_MAX_BYTES,
  APPLY_HTTP_STATUS,
  APPLY_STATUSES,
  AVAILABILITY,
  ApplicationInputSchema,
  ApplicationListQuerySchema,
  ApplicationUpdateSchema,
  CRAFTS,
  CV_KINDS,
  CV_MAX_BYTES,
  EXPERIENCE_LEVELS,
  WORK_TYPES,
  applicationKeyToField,
  formToApplicationInput,
  optionLabel,
} from '@schemas/application';
import {
  RECRUITMENT_CONSENT,
  RECRUITMENT_POLICY_VERSION,
  recruitmentConsent,
} from '@consent/recruitment';

// The Join contract (packages/schemas/application.ts): the strict input schema, the form
// mapping, the option tables — and that the database (0029) refuses exactly what the
// schema refuses, so a value can never pass one layer and break on the other.

const valid = {
  locale: 'en',
  name: 'Noura Al-Harbi',
  email: 'noura@example.com',
  phone: '+966 50 000 0000',
  city: 'Riyadh',
  role: 'Motion designer',
  experience: '3-6',
  workType: 'full-time',
  availability: 'month',
  skills: ['motion-graphics', 'animation'],
  portfolio: 'https://behance.net/noura',
  message: 'Hello.',
  consentApplication: true,
  consentFutureRoles: false,
  policyVersion: RECRUITMENT_POLICY_VERSION,
};

const sql = readFileSync('supabase/migrations/0029_job_applications.sql', 'utf8');
/** The quoted values in the CHECK of one `job_applications` column (0029), in order. */
function sqlList(column: string): string[] {
  const at = sql.indexOf(`\n  ${column} `);
  expect(at, column).toBeGreaterThan(-1);
  const rest = sql.slice(at + 1);
  const end = rest.search(/\n {2}[a-z_]+ (text|int|uuid|boolean|timestamptz)|\n {2}constraint /);
  const definition = rest.slice(0, end);
  const check = definition.slice(definition.indexOf('check ('));
  return [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('ApplicationInputSchema', () => {
  it('accepts a complete application', () => {
    expect(ApplicationInputSchema.safeParse(valid).success).toBe(true);
  });

  it('is strict: an unknown key is refused, never dropped', () => {
    expect(ApplicationInputSchema.safeParse({ ...valid, salary: '10k' }).success).toBe(false);
  });

  it('requires the application consent itself — the future-roles box is optional', () => {
    expect(ApplicationInputSchema.safeParse({ ...valid, consentApplication: false }).success).toBe(
      false,
    );
    const { consentApplication: _, ...without } = valid;
    expect(ApplicationInputSchema.safeParse(without).success).toBe(false);
    expect(ApplicationInputSchema.safeParse({ ...valid, consentFutureRoles: true }).success).toBe(
      true,
    );
  });

  it('takes https links only (the admin opens them)', () => {
    for (const portfolio of ['http://behance.net/x', 'javascript:alert(1)', 'behance.net/x']) {
      expect(ApplicationInputSchema.safeParse({ ...valid, portfolio }).success, portfolio).toBe(
        false,
      );
    }
    expect(
      ApplicationInputSchema.safeParse({ ...valid, linkedin: 'http://linkedin.com/in/x' }).success,
    ).toBe(false);
    expect(
      ApplicationInputSchema.safeParse({ ...valid, linkedin: 'https://linkedin.com/in/x' }).success,
    ).toBe(true);
  });

  it('takes skills from the 16 crafts only, each at most once in number', () => {
    expect(ApplicationInputSchema.safeParse({ ...valid, skills: ['plumbing'] }).success).toBe(
      false,
    );
    expect(
      ApplicationInputSchema.safeParse({ ...valid, skills: Object.keys(CRAFTS) }).success,
    ).toBe(true);
    expect(
      ApplicationInputSchema.safeParse({ ...valid, skills: [...Object.keys(CRAFTS), 'branding'] })
        .success,
    ).toBe(false);
    expect(ApplicationInputSchema.safeParse({ ...valid, skills: [] }).success).toBe(true);
  });

  it('bounds the free text and the option keys', () => {
    const bad: Record<string, unknown>[] = [
      { name: '' },
      { name: 'x'.repeat(121) },
      { phone: '12345' },
      { phone: '1'.repeat(33) },
      { email: 'not-an-email' },
      { message: 'x'.repeat(4001) },
      { experience: '10-plus' },
      { workType: 'part-time' },
      { availability: 'never' },
      { policyVersion: '30-09-2026' },
      { locale: 'fr' },
    ];
    for (const patch of bad) {
      expect(
        ApplicationInputSchema.safeParse({ ...valid, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe('formToApplicationInput', () => {
  function form(entries: [string, string][]): FormData {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  }

  it('maps every control to its key, skills from every value', () => {
    const input = formToApplicationInput(
      form([
        ['locale', 'ar'],
        ['name', '  Noura  '],
        ['email', 'noura@example.com'],
        ['phone', '+966500000000'],
        ['city', 'Riyadh'],
        ['role', 'Designer'],
        ['experience', 'student'],
        ['work_type', 'freelance'],
        ['availability', 'later'],
        ['skills', 'branding'],
        ['skills', ''],
        ['skills', 'gaming'],
        ['portfolio', 'https://example.com'],
        ['linkedin', ''],
        ['message', 'Hi'],
        ['consent_application', 'on'],
        ['policy_version', RECRUITMENT_POLICY_VERSION],
      ]),
    );
    expect(input).toEqual({
      locale: 'ar',
      name: 'Noura',
      email: 'noura@example.com',
      phone: '+966500000000',
      city: 'Riyadh',
      role: 'Designer',
      experience: 'student',
      workType: 'freelance',
      availability: 'later',
      skills: ['branding', 'gaming'],
      portfolio: 'https://example.com',
      message: 'Hi',
      consentApplication: true,
      consentFutureRoles: false,
      policyVersion: RECRUITMENT_POLICY_VERSION,
    });
    expect(ApplicationInputSchema.safeParse(input).success).toBe(true);
  });

  it('an unticked required consent is absent (a 422 names it), a ticked optional one is true', () => {
    const input = formToApplicationInput(form([['consent_future', 'on']]));
    expect(input).not.toHaveProperty('consentApplication');
    expect(input['consentFutureRoles']).toBe(true);
  });

  it('a file in a text control is ignored, not stringified', () => {
    const f = new FormData();
    f.append('name', new Blob(['x']), 'x.txt');
    expect(formToApplicationInput(f)).not.toHaveProperty('name');
  });
});

describe('field names and statuses', () => {
  it('a 422 key maps back to its control, both ways', () => {
    for (const [control, key] of Object.entries(APPLICATION_FORM_FIELDS)) {
      expect(applicationKeyToField(key)).toBe(control);
    }
    expect(applicationKeyToField('somethingElse')).toBe('somethingElse');
  });

  it('every apply status has an HTTP code, and only ok is a 2xx', () => {
    expect(Object.keys(APPLY_HTTP_STATUS).sort()).toEqual([...APPLY_STATUSES].sort());
    for (const s of APPLY_STATUSES) {
      expect(APPLY_HTTP_STATUS[s] < 300, s).toBe(s === 'ok');
    }
  });

  it('labels a stored key in either language, and an unknown key as itself', () => {
    expect(optionLabel(CRAFTS, 'motion-graphics')).toBe('Motion Graphics');
    expect(optionLabel(CRAFTS, 'motion-graphics', 'ar')).toBe('الموشن جرافيك');
    expect(optionLabel(WORK_TYPES, 'hand-edited')).toBe('hand-edited');
  });

  it('the admin update is strict and bounded', () => {
    expect(ApplicationUpdateSchema.safeParse({ status: 'spam' }).success).toBe(true);
    expect(ApplicationUpdateSchema.safeParse({ status: 'archived' }).success).toBe(false);
    expect(ApplicationUpdateSchema.safeParse({ internalNotes: 'x'.repeat(5001) }).success).toBe(
      false,
    );
    expect(ApplicationUpdateSchema.safeParse({ retentionDeleteAfter: '2030-01-01' }).success).toBe(
      false,
    );
  });

  it('the list query defaults and caps its page', () => {
    expect(ApplicationListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(ApplicationListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ApplicationListQuerySchema.parse({ limit: '25', status: 'new' })).toEqual({
      limit: 25,
      offset: 0,
      status: 'new',
    });
  });
});

describe('the database refuses what the schema refuses (0029)', () => {
  it('the option CHECKs list exactly the code-owned keys', () => {
    expect(sqlList('experience')).toEqual(Object.keys(EXPERIENCE_LEVELS));
    expect(sqlList('work_type')).toEqual(Object.keys(WORK_TYPES));
    expect(sqlList('availability')).toEqual(Object.keys(AVAILABILITY));
    expect(sqlList('skills')).toEqual(Object.keys(CRAFTS));
    expect(sqlList('status')).toEqual([...APPLICATION_STATUSES]);
  });

  it('the CV CHECKs match the upload rules', () => {
    expect(sqlList('cv_content_type')).toEqual(Object.values(CV_KINDS).map((k) => k.contentType));
    expect(sql).toContain(`cv_bytes between 1 and ${CV_MAX_BYTES}`);
    expect(sql).toContain(
      `\\.(${Object.values(CV_KINDS)
        .map((k) => k.extension)
        .join('|')})$'`,
    );
    // The bucket is created with the same limit and types.
    expect(sql).toContain(`'applications', 'applications', false, ${CV_MAX_BYTES},`);
    expect(sql).toContain(`cardinality(skills) <= ${Object.keys(CRAFTS).length}`);
    expect(APPLY_BODY_MAX_BYTES).toBeGreaterThan(CV_MAX_BYTES);
  });
});

describe('recruitment consent copy', () => {
  it('fills the brand in both languages and leaves no token', () => {
    for (const locale of ['en', 'ar'] as const) {
      const c = recruitmentConsent(locale, 'Braiin Statiion');
      expect(c.application).toContain('Braiin Statiion');
      expect(c.application).not.toContain('{brand}');
      expect(c.futureRoles).toBe(RECRUITMENT_CONSENT[locale].futureRoles);
    }
  });

  it('the policy version is a date the schema accepts', () => {
    expect(RECRUITMENT_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
