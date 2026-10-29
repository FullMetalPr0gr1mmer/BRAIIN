import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import {
  APPLICATION_FORM_FIELDS,
  ApplicationInputSchema,
  CV_FIELD,
  CV_MAX_BYTES,
} from '@schemas/application';
import { LeadInputSchema } from '@schemas/lead';
import {
  CONTACT_FIELD_TO_LEAD,
  CONTACT_FORM_FIELDS,
  type ContactField,
  type ContactFormVariant,
} from '@/lib/forms/contactPayload';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import { APPLY_LIMITS, CONTACT_LIMITS } from '@/lib/http/publicRateLimit';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { DEFAULT_SERVICES_SECTIONS } from '@/lib/sections/types';
import {
  CONSENT_VERSION,
  CV_LIMIT,
  FORM_WORDING,
  INQUIRY_PLACES,
  formFacts,
  inquiryFieldOrder,
  perWindow,
} from '@/lib/admin/forms/overview';

// The Forms overview (Admin v2 U11, /admin/forms) states facts the code decides, and is held
// to each here: the fields are the ones each form renders, in its order; "Required" is what
// the server's schema refuses when a control is left as it starts; the limits and the fail
// modes are EXC-004's; the consent version is the one the Join form posts. A change to a
// form, a schema or a limit fails this spec until the screen says it too.

const facts = formFacts();
const source = (path: string) => readFileSync(path, 'utf8');

/** Every .astro file under src that renders the inquiry form, and the variant it asks for. */
function contactFormCallSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.astro')) {
        const text = source(path);
        for (const call of text.matchAll(/<ContactForm\b[^>]*?>/g)) {
          const variant = /\bfields="([a-z]+)"/.exec(call[0])?.[1] ?? '(none)';
          const file = path.split(sep).join('/');
          sites.set(variant, [...(sites.get(variant) ?? []), file]);
        }
      }
    }
  };
  walk('src');
  return sites;
}

const VARIANTS = Object.keys(CONTACT_FORM_FIELDS) as ContactFormVariant[];
const has = (variant: ContactFormVariant, field: ContactField) =>
  (CONTACT_FORM_FIELDS[variant] as readonly ContactField[]).includes(field);

describe('the inquiry form', () => {
  it('names a place for every variant, each held to the one section that renders it', () => {
    expect(Object.keys(INQUIRY_PLACES).sort()).toEqual([...VARIANTS].sort());
    expect(Object.fromEntries(contactFormCallSites())).toEqual({
      compact: ['src/components/sections/HomeContact.astro'],
      full: ['src/components/sections/ContactInquiry.astro'],
      hello: ['src/components/sections/Hello.astro'],
    });
    // Where those sections are: the home page, Contact, and /services and each service page.
    expect(INQUIRY_PLACES).toEqual({
      compact: 'the home page',
      full: 'the Contact page',
      hello: 'the services pages',
    });
    expect(facts.inquiry.where).toContain(
      'On the home page, the Contact page and the services pages, in English and Arabic.',
    );
  });

  it('lists every field any variant asks for, keeping each one’s order, then the consent box', () => {
    const order = inquiryFieldOrder();
    expect(order).toEqual([
      'name',
      'email',
      'company',
      'phone',
      'service',
      'budget',
      'deadline',
      'message',
    ]);
    expect([...order].sort()).toEqual(
      [...new Set(VARIANTS.flatMap((v) => [...CONTACT_FORM_FIELDS[v]]))].sort(),
    );
    for (const variant of VARIANTS) {
      expect(
        order.filter((f) => has(variant, f)),
        variant,
      ).toEqual([...CONTACT_FORM_FIELDS[variant]]);
    }
    expect(facts.inquiry.fields.map((f) => f.key)).toEqual([
      ...order.map((f) => CONTACT_FIELD_TO_LEAD[f]),
      'consentMarketing',
    ]);
    expect(facts.inquiry.fields.map((f) => f.label)).toEqual([
      ...order.map((f) => CONTACT_FORM_COPY.en[f]),
      CONTACT_FORM_COPY.en.consent,
    ]);
  });

  it('marks a field asked only in some places with those places; the phone is the services pages’', () => {
    const hints = Object.fromEntries(facts.inquiry.fields.map((f) => [f.key, f.hint]));
    expect(hints).toEqual({
      name: undefined,
      email: undefined,
      company: undefined,
      phone: 'Only on the services pages',
      serviceOfInterest: undefined,
      budgetBand: 'Only on the Contact page and the services pages',
      timelineText: 'Only on the Contact page',
      message: undefined,
      consentMarketing: undefined,
    });
    for (const field of inquiryFieldOrder()) {
      const askedBy = VARIANTS.filter((v) => has(v, field));
      const hint = hints[CONTACT_FIELD_TO_LEAD[field]];
      if (askedBy.length === VARIANTS.length) expect(hint, field).toBeUndefined();
      else for (const v of askedBy) expect(hint, field).toContain(INQUIRY_PLACES[v]);
    }
    // The phone is optional, and the server keeps it encrypted like the e-mail.
    expect(facts.inquiry.fields.find((f) => f.key === 'phone')?.required).toBe(false);
    expect(LeadInputSchema.shape.phone.safeParse(undefined).success).toBe(true);
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
    // Admin v2 E8: the form posts the version its config resolves (the notice's date until the
    // consent lines are reworded, src/lib/forms/config.ts consentVersion).
    expect(source('src/components/ApplicationForm.astro')).toContain(
      'value={view.policyVersion}',
    );
  });
});

describe('where the words around each form are edited', () => {
  // Each form sits in a section a page in Pages composes, but a service page renders its
  // "Say hello" block itself, with fixed words: the screen must not send anyone to Pages for it.
  const renderer = source('src/components/SectionRenderer.astro');

  it('the home page, Contact, the Services page and Join render theirs in a section', () => {
    for (const [type, component] of [
      ['contact', 'HomeContact'],
      ['contactInquiry', 'ContactInquiry'],
      ['hello', 'Hello'],
      ['joinApply', 'JoinApply'],
    ] as const) {
      expect(SECTION_TYPES, type).toContain(type);
      expect(renderer, type).toContain(`  ${type}: ${component},\n`);
    }
    expect(DEFAULT_SERVICES_SECTIONS.map((s) => s.type)).toContain('hello');
    expect(facts.inquiry.wording[0]).toBe(
      'On the home page, the Contact page and the Services page, the words around the form, such as its heading, are edited with that page, in Pages.',
    );
    expect(facts.join.wording).toEqual(FORM_WORDING.join);
    expect(facts.join.wording.join(' ')).toContain('edited with the Join page, in Pages');
  });

  it('a service page renders the Hello block itself, with fixed words that name the service', () => {
    const page = source('src/components/service/ServicePage.astro');
    const calls = [...page.matchAll(/<Hello\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('headingOverride={serviceHelloHeading(name, locale)}');
    expect(calls[0]).toContain('leadOverride={copy.helloLead}');
    expect(calls[0]).not.toContain('{...');
    expect(source('src/components/sections/Hello.astro')).toContain(
      'Direct props (never reachable from CMS content',
    );
    expect(facts.inquiry.wording).toContain(
      'On each service page those words are fixed, and the heading names the service.',
    );
    // No line of the inquiry tab sends every place to Pages.
    expect(facts.inquiry.wording.join(' ')).not.toMatch(/the page that holds it/);
  });

  it('the screen says what the overview says, line by line', () => {
    const page = source('src/pages/admin/forms.astro');
    expect(page).toContain('form.wording.map(');
    expect(page).not.toContain('page that holds it');
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
