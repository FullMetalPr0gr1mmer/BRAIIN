import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import {
  APPLICATION_FORM_FIELDS,
  ApplicationInputSchema,
  CV_FIELD,
  CV_MAX_BYTES,
} from '@schemas/application';
import { LeadInputSchema } from '@schemas/lead';
import { CONTACT_FIELD_TO_LEAD, CONTACT_FORM_FIELDS } from '@/lib/forms/contactPayload';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import { APPLY_LIMITS, CONTACT_LIMITS } from '@/lib/http/publicRateLimit';
import { CONSENT_VERSION, CV_LIMIT, formFacts, perWindow } from '@/lib/admin/forms/overview';

// The Forms overview (Admin v2 U11, /admin/forms) states facts the code decides, and is held
// to each here: the fields are the ones each form renders, in its order; "Required" is what
// the server's schema refuses when a control is left as it starts; the limits and the fail
// modes are EXC-004's; the consent version is the one the Join form posts. A change to a
// form, a schema or a limit fails this spec until the screen says it too.

const facts = formFacts();
const source = (path: string) => readFileSync(path, 'utf8');

describe('the inquiry form', () => {
  it('lists the controls the Contact page renders, in its order, then the consent box', () => {
    expect(source('src/components/sections/ContactInquiry.astro')).toContain('fields="full"');
    expect(facts.inquiry.fields.map((f) => f.key)).toEqual([
      ...CONTACT_FORM_FIELDS.full.map((f) => CONTACT_FIELD_TO_LEAD[f]),
      'consentMarketing',
    ]);
    expect(facts.inquiry.fields.map((f) => f.label)).toEqual([
      ...CONTACT_FORM_FIELDS.full.map((f) => CONTACT_FORM_COPY.en[f]),
      CONTACT_FORM_COPY.en.consent,
    ]);
  });

  it('marks required what the schema refuses blank: name, e-mail and message', () => {
    const required = facts.inquiry.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['name', 'email', 'message']);
    for (const key of required) {
      expect(
        LeadInputSchema.safeParse({
          name: 'N',
          email: 'n@example.test',
          message: 'M',
          [key]: undefined,
        }).success,
        key,
      ).toBe(false);
    }
  });

  it('gives the limit and the fail mode the contact route uses', () => {
    expect(facts.inquiry.limits).toEqual([
      `${CONTACT_LIMITS.perIp.max} an hour from one internet address`,
    ]);
    expect(source('src/lib/http/publicRateLimit.ts')).toContain('the contact form fails');
    expect(facts.inquiry.unchecked).toContain('still goes through');
  });
});

describe('the Join form', () => {
  it('lists every control the form renders, by the schema key it fills, and the CV', () => {
    const form = source('src/components/ApplicationForm.astro');
    const keys = facts.join.fields.map((f) => f.key);
    const named = Object.values(APPLICATION_FORM_FIELDS).filter(
      (k) => k !== 'policyVersion' && k !== 'locale',
    );
    expect([...keys].sort()).toEqual([...named, CV_FIELD].sort());
    // In the order the page renders them.
    const at = (key: string) => {
      const control =
        key === CV_FIELD
          ? 'name={CV_FIELD}'
          : `name={f('${Object.entries(APPLICATION_FORM_FIELDS).find(([, k]) => k === key)![0]}')}`;
      const i = form.indexOf(control);
      expect(i, key).toBeGreaterThan(-1);
      return i;
    };
    const positions = keys.map(at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('marks required what the schema refuses when left as it starts', () => {
    const required = facts.join.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual([
      'name',
      'email',
      'phone',
      'city',
      'role',
      'experience',
      'workType',
      'availability',
      'portfolio',
      'message',
      'consentApplication',
    ]);
    // The schema itself: the crafts may be none, LinkedIn absent, future roles unticked.
    const shape = ApplicationInputSchema.shape;
    expect(shape.skills.safeParse([]).success).toBe(true);
    expect(shape.linkedin.safeParse(undefined).success).toBe(true);
    expect(shape.consentFutureRoles.safeParse(false).success).toBe(true);
    expect(shape.consentApplication.safeParse(false).success).toBe(false);
  });

  it('the CV is optional, a PDF or Word file up to the size the route allows', () => {
    const cv = facts.join.fields.find((f) => f.key === 'cv')!;
    expect(cv.required).toBe(false);
    expect(CV_LIMIT).toBe(`${CV_MAX_BYTES / (1024 * 1024)} MB`);
    expect(cv.hint).toBe(`PDF or Word (.docx), up to ${CV_LIMIT}`);
    expect(source('src/pages/api/apply.ts')).toContain('The CV is optional');
  });

  it('gives the two limits and the fail mode the apply route uses', () => {
    expect(facts.join.limits).toEqual([
      `${APPLY_LIMITS.perIp.max} an hour from one internet address`,
      `${APPLY_LIMITS.perEmail.max} a day from one e-mail`,
    ]);
    expect(source('src/lib/http/publicRateLimit.ts')).toContain('the apply path fails CLOSED');
    expect(facts.join.unchecked).toContain('refused for now');
  });

  it('the consent version is the one the form posts', () => {
    expect(CONSENT_VERSION).toBe(RECRUITMENT_POLICY_VERSION);
    expect(source('src/components/ApplicationForm.astro')).toContain(
      'value={RECRUITMENT_POLICY_VERSION}',
    );
  });
});

describe('the words', () => {
  it('a limit as a person says it', () => {
    expect(perWindow(10, 3600)).toBe('10 an hour');
    expect(perWindow(3, 86_400)).toBe('3 a day');
    expect(perWindow(4, 900)).toBe('4 every 15 minutes');
  });

  it('no dash, and no brand, anywhere on the screen (P-12)', () => {
    const page = source('src/pages/admin/forms.astro');
    const words = JSON.stringify(facts) + page;
    expect(words).not.toMatch(/[–—]/);
    expect(words).not.toMatch(/braiin/i);
  });
});
