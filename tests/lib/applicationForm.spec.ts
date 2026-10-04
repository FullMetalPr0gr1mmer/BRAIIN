import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FORM_FIELDS,
  APPLY_HTTP_STATUS,
  APPLY_STATUSES,
  ApplicationInputSchema,
  CRAFTS,
  CV_FIELD,
  CV_KINDS,
  CV_MAX_BYTES,
  HONEYPOT_FIELD,
  applicationKeyToField,
  formToApplicationInput,
} from '@schemas/application';
import {
  RECRUITMENT_POLICY_VERSION,
  RECRUITMENT_POLICY_VERSIONS,
  recruitmentConsent,
} from '@consent/recruitment';
import {
  FORM_OUTCOMES,
  applyStatusFromHttp,
  checkField,
  outcomeOf,
  statusFromHttp,
} from '@/lib/client/formErrors';
import {
  APPLY_FIELD_OF_KEY,
  CV_EXTENSIONS,
  CV_LIMIT_BYTES,
  applyFieldsFor,
  applyOutcome,
  cvProblem,
  fileSizeLabel,
  openFromStatusBody,
} from '@/lib/client/applicationForm';
import { APPLY_FORM_COPY, applyStatusText } from '@/lib/forms/applicationCopy';

// The Join application form's pure halves: the wire contract (the form's control names →
// ApplicationInputSchema, both directions), the client checks that mirror the schema, the
// endpoint's answers → what the visitor is told, and the copy every answer needs. The DOM
// half is tests/e2e/join-page.e2e.ts.

const FORM = readFileSync(join(process.cwd(), 'src/components/ApplicationForm.astro'), 'utf8');

/** A FormData built the way the form posts it: every control under its rendered name. */
function submission(overrides: Record<string, string | string[] | null> = {}): FormData {
  const values: Record<string, string | string[] | null> = {
    name: 'Noura Al-Harbi',
    email: 'noura@example.com',
    phone: '+966 50 123 4567',
    city: 'Jeddah',
    role: 'Motion designer',
    experience: '3-6',
    work_type: 'full-time',
    availability: 'month',
    skills: ['motion-graphics', 'animation'],
    portfolio: 'https://behance.net/noura',
    linkedin: '',
    message: 'The launch film for a coffee brand. I animated it end to end.',
    consent_application: 'yes',
    consent_future: null,
    policy_version: RECRUITMENT_POLICY_VERSION,
    locale: 'en',
    [HONEYPOT_FIELD]: '',
    ...overrides,
  };
  const fd = new FormData();
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue; // an unchecked box is not sent
    for (const v of Array.isArray(value) ? value : [value]) fd.append(name, v);
  }
  // A chosen CV travels as a file part; the schema never sees it.
  fd.append(CV_FIELD, new File(['%PDF-1.7'], 'noura-cv.pdf', { type: 'application/pdf' }));
  return fd;
}

describe('the form posts exactly the contract', () => {
  it('names a control for every APPLICATION_FORM_FIELDS key, and nothing else', () => {
    const named = new Set([...FORM.matchAll(/name=\{f\('([a-z_]+)'\)\}/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(Object.keys(APPLICATION_FORM_FIELDS).sort());
    // ...plus the file and the honeypot, which are not schema keys.
    expect(FORM).toContain('name={CV_FIELD}');
    expect(FORM).toContain('name={HONEYPOT_FIELD}');
    expect(CV_FIELD).toBe('cv');
    expect(HONEYPOT_FIELD).toBe('hp');
  });

  it('posts multipart to /api/apply for both locales, without browser validation', () => {
    expect(FORM).toMatch(/id="apply-form"/);
    expect(FORM).toMatch(/method="post"/);
    expect(FORM).toMatch(/action="\/api\/apply"/);
    expect(FORM).toMatch(/enctype="multipart\/form-data"/);
    expect(FORM).toMatch(/\snovalidate\s/);
  });

  it('accepts PDF and .docx only: the extensions and media types of CV_KINDS', () => {
    const accept = [
      ...Object.values(CV_KINDS).map((k) => `.${k.extension}`),
      ...Object.values(CV_KINDS).map((k) => k.contentType),
    ].join(',');
    expect(accept).toBe(
      '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(accept).not.toMatch(/\.doc(,|$)/);
  });
});

describe('formToApplicationInput: a FormData built like the form round-trips', () => {
  it('becomes the schema’s input, which validates', () => {
    const input = formToApplicationInput(submission());
    expect(input).toEqual({
      locale: 'en',
      name: 'Noura Al-Harbi',
      email: 'noura@example.com',
      phone: '+966 50 123 4567',
      city: 'Jeddah',
      role: 'Motion designer',
      experience: '3-6',
      workType: 'full-time',
      availability: 'month',
      skills: ['motion-graphics', 'animation'],
      portfolio: 'https://behance.net/noura',
      message: 'The launch film for a coffee brand. I animated it end to end.',
      consentApplication: true,
      consentFutureRoles: false,
      policyVersion: RECRUITMENT_POLICY_VERSION,
    });
    const parsed = ApplicationInputSchema.safeParse(input);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('never carries the file or the honeypot into the strict schema', () => {
    const input = formToApplicationInput(submission({ [HONEYPOT_FIELD]: 'bot' }));
    expect(input).not.toHaveProperty(CV_FIELD);
    expect(input).not.toHaveProperty(HONEYPOT_FIELD);
  });

  it('the future-roles box, ticked, posts true; an empty LinkedIn is absent, not ""', () => {
    const input = formToApplicationInput(submission({ consent_future: 'yes', linkedin: '' }));
    expect(input['consentFutureRoles']).toBe(true);
    expect(input).not.toHaveProperty('linkedin');
    expect(ApplicationInputSchema.safeParse(input).success).toBe(true);
  });

  it('every craft chip posts its key, and all sixteen together validate', () => {
    const input = formToApplicationInput(submission({ skills: Object.keys(CRAFTS) }));
    expect(input['skills']).toEqual(Object.keys(CRAFTS));
    expect(ApplicationInputSchema.safeParse(input).success).toBe(true);
  });

  it('an unticked required consent fails the schema at consentApplication', () => {
    const parsed = ApplicationInputSchema.safeParse(
      formToApplicationInput(submission({ consent_application: null })),
    );
    expect(parsed.success).toBe(false);
    const keys = parsed.error!.issues.map((i) => i.path[0]);
    expect(keys).toEqual(['consentApplication']);
    expect(applicationKeyToField(String(keys[0]))).toBe('consent_application');
  });

  it('a select left on "Choose one" ("") fails as missing, named by its schema key', () => {
    const parsed = ApplicationInputSchema.safeParse(
      formToApplicationInput(submission({ work_type: '' })),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map((i) => i.path[0])).toEqual(['workType']);
  });
});

describe('applicationKeyToField and the client’s mirror of it', () => {
  it('maps every schema key back to the control that fills it', () => {
    for (const [field, key] of Object.entries(APPLICATION_FORM_FIELDS)) {
      expect(applicationKeyToField(key), key).toBe(field);
    }
    expect(applicationKeyToField('somethingElse')).toBe('somethingElse');
  });

  it('the zod-free client copy is the same map, key for key', () => {
    expect(Object.keys(APPLY_FIELD_OF_KEY).sort()).toEqual(
      Object.values(APPLICATION_FORM_FIELDS).sort(),
    );
    for (const [key, field] of Object.entries(APPLY_FIELD_OF_KEY)) {
      expect(field, key).toBe(applicationKeyToField(key));
    }
  });

  it('applyFieldsFor keeps known keys only, once each — never a prototype key', () => {
    expect(applyFieldsFor(['workType', 'email', 'workType', 'nope', 7, 'toString'])).toEqual([
      'work_type',
      'email',
    ]);
    expect(applyFieldsFor('workType')).toEqual([]);
    expect(applyFieldsFor(undefined)).toEqual([]);
  });

  it('the client’s CV rules are the schema’s', () => {
    expect(CV_LIMIT_BYTES).toBe(CV_MAX_BYTES);
    expect([...CV_EXTENSIONS]).toEqual(Object.values(CV_KINDS).map((k) => k.extension));
  });
});

describe('formErrors: the apply endpoint’s outcomes', () => {
  it('knows exactly the endpoint’s statuses', () => {
    expect([...FORM_OUTCOMES].sort()).toEqual([...APPLY_STATUSES].sort());
  });

  it('reads every APPLY_HTTP_STATUS code back to its status', () => {
    for (const status of APPLY_STATUSES) {
      expect(applyStatusFromHttp(APPLY_HTTP_STATUS[status]), status).toBe(status);
    }
    expect(applyStatusFromHttp(400)).toBe('invalid');
    expect(applyStatusFromHttp(502)).toBe('error');
    expect(applyStatusFromHttp(204)).toBe('ok');
  });

  it('leaves the contact form’s mapping as it was', () => {
    expect(statusFromHttp(409)).toBe('error');
    expect(statusFromHttp(413)).toBe('error');
    expect(statusFromHttp(415)).toBe('error');
    expect(statusFromHttp(422)).toBe('invalid');
  });

  it('outcomeOf takes a known status at its word, anything else is null', () => {
    expect(outcomeOf('bad_type')).toBe('bad_type');
    expect(outcomeOf('sending')).toBeNull();
    expect(outcomeOf('OK')).toBeNull();
    expect(outcomeOf(undefined)).toBeNull();
    expect(outcomeOf(415)).toBeNull();
  });
});

describe('checkField: the https link rule', () => {
  const url = { url: true, maxLength: 2048 };

  it('accepts what the server accepts (z.url, https only)', () => {
    expect(checkField('https://behance.net/yourname', url)).toBeNull();
    expect(checkField('  https://linkedin.com/in/yourname  ', url)).toBeNull();
    expect(checkField('https://localhost', url)).toBeNull();
    expect(checkField('https://behance.net/my work', url)).toBeNull();
  });

  it('refuses anything but an absolute https link', () => {
    for (const v of [
      'http://behance.net/x',
      'behance.net/x',
      'www.behance.net',
      'https://',
      'javascript:alert(1)',
      'ftp://files.example.com',
    ]) {
      expect(checkField(v, url), v).toBe('url');
    }
  });

  it('required first, then the link, then the length', () => {
    expect(checkField('', { ...url, required: true })).toBe('required');
    expect(checkField('', url)).toBeNull();
    expect(checkField(`https://a.example/${'x'.repeat(2100)}`, url)).toBe('tooLong');
  });

  it('a control without the rule is not a link check', () => {
    expect(checkField('behance.net/x', {})).toBeNull();
  });
});

describe('cvProblem: the CV, before it is uploaded', () => {
  it('no file is fine (the CV is optional)', () => {
    expect(cvProblem(null)).toBeNull();
    expect(cvProblem(undefined)).toBeNull();
  });

  it('takes a PDF or .docx up to and including 10 MB, any case', () => {
    expect(cvProblem({ name: 'cv.pdf', size: 240_000 })).toBeNull();
    expect(cvProblem({ name: 'CV.PDF', size: CV_MAX_BYTES })).toBeNull();
    expect(cvProblem({ name: 'my.cv.docx', size: 1 })).toBeNull();
  });

  it('refuses the old .doc, other types, no extension and an empty file', () => {
    for (const name of ['cv.doc', 'cv.txt', 'cv.pdf.exe', 'cv', 'cv.pages']) {
      expect(cvProblem({ name, size: 1000 }), name).toBe('badType');
    }
    expect(cvProblem({ name: 'cv.pdf', size: 0 })).toBe('badType');
  });

  it('refuses a file over 10 MB', () => {
    expect(cvProblem({ name: 'cv.pdf', size: CV_MAX_BYTES + 1 })).toBe('tooLarge');
  });
});

describe('fileSizeLabel', () => {
  const units = { en: { kb: 'KB', mb: 'MB' }, ar: { kb: 'كيلوبايت', mb: 'ميجابايت' } };

  it('rounds as the design does, in the page’s digits', () => {
    expect(fileSizeLabel(240 * 1024, 'en', units.en)).toBe('240 KB');
    expect(fileSizeLabel(300, 'en', units.en)).toBe('1 KB');
    expect(fileSizeLabel(1.2 * 1024 * 1024, 'en', units.en)).toBe('1.2 MB');
    expect(fileSizeLabel(2 * 1024 * 1024, 'en', units.en)).toBe('2.0 MB');
    expect(fileSizeLabel(240 * 1024, 'ar', units.ar)).toBe('٢٤٠ كيلوبايت');
    expect(fileSizeLabel(1.2 * 1024 * 1024, 'ar', units.ar)).toBe('١٫٢ ميجابايت');
  });
});

describe('applyOutcome: the endpoint’s answer → what the visitor is told', () => {
  it('reports "received" only for a 2xx that says ok', () => {
    expect(applyOutcome(200, { status: 'ok' }).status).toBe('ok');
    expect(applyOutcome(200, null).status).toBe('error');
    expect(applyOutcome(200, {}).status).toBe('error');
    expect(applyOutcome(200, { status: 'nope' }).status).toBe('error');
    expect(applyOutcome(500, { status: 'ok' }).status).toBe('error');
  });

  it('takes the named status at its word, the HTTP code when there is none', () => {
    expect(applyOutcome(415, { status: 'bad_type' }).status).toBe('bad_type');
    expect(applyOutcome(409, { status: 'closed' }).status).toBe('closed');
    expect(applyOutcome(413, null).status).toBe('too_large');
    expect(applyOutcome(429, '<html>').status).toBe('rate_limited');
    expect(applyOutcome(503, undefined).status).toBe('unavailable');
  });

  it('an invalid answer names the controls to mark; no other answer does', () => {
    expect(applyOutcome(422, { status: 'invalid', fields: ['email', 'workType'] })).toEqual({
      status: 'invalid',
      fields: ['email', 'work_type'],
    });
    expect(applyOutcome(422, null)).toEqual({ status: 'invalid', fields: [] });
    expect(applyOutcome(409, { status: 'closed', fields: ['email'] }).fields).toEqual([]);
  });

  it('GET /api/apply/status: open or closed, else no answer', () => {
    expect(openFromStatusBody({ open: true })).toBe(true);
    expect(openFromStatusBody({ open: false })).toBe(false);
    expect(openFromStatusBody({ open: 'no' })).toBeNull();
    expect(openFromStatusBody(null)).toBeNull();
    expect(openFromStatusBody([])).toBeNull();
  });
});

describe('the form’s copy', () => {
  it('has a message for every answer, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const copy = APPLY_FORM_COPY[locale];
      for (const status of [...APPLY_STATUSES, 'sending'] as const) {
        expect(applyStatusText(copy, status, 'OK!').trim(), `${locale} ${status}`).not.toBe('');
      }
      expect(applyStatusText(copy, 'ok', 'Received.')).toBe('Received.');
    }
  });

  it('the two languages carry the same keys', () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' ? keys(v as object).map((s) => `${k}.${s}`) : [k],
      );
    expect(keys(APPLY_FORM_COPY.ar).sort()).toEqual(keys(APPLY_FORM_COPY.en).sort());
  });

  it('is the brief’s wording where it gave one', () => {
    expect(APPLY_FORM_COPY.en.status.closed).toBe(
      "We're not taking applications right now. Check back soon.",
    );
    expect(APPLY_FORM_COPY.en.status.bad_type).toBe(
      "That file won't work. Use a PDF or Word (.docx) file under 10 MB.",
    );
    expect(APPLY_FORM_COPY.en.cvHint).toBe('PDF or Word (.docx), up to 10 MB');
    // The Arabic hint keeps "(.docx)" on the Arabic side of "Word" with U+200F.
    expect(APPLY_FORM_COPY.ar.cvHint).toBe('PDF أو Word ‏(.docx)، حتى ١٠ ميجابايت');
  });

  it('the consent wording is the versioned recruitment copy, with the brand filled in', () => {
    const en = recruitmentConsent('en', 'Braiin Statiion');
    expect(en.application).toContain('Braiin Statiion can store and review this application');
    expect(en.application).not.toContain('{brand}');
    expect(recruitmentConsent('ar', 'بريّن ستيشن').application).toContain('بريّن ستيشن');
    expect(RECRUITMENT_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the notice versions only grow: dated, oldest first, the form showing the newest', () => {
    // Append-only (packages/consent/recruitment.ts): a stored consent names its version, so
    // an old one is never removed and a new one always sorts after it. 2026-10-04 is the
    // notice whose rights line comes from the Site profile (design-port J-17).
    expect(RECRUITMENT_POLICY_VERSIONS[0]).toBe('2026-09-30');
    expect(RECRUITMENT_POLICY_VERSIONS).toContain('2026-10-04');
    for (const [i, version] of RECRUITMENT_POLICY_VERSIONS.entries()) {
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (i > 0) expect(version > RECRUITMENT_POLICY_VERSIONS[i - 1]!, version).toBe(true);
    }
    expect(RECRUITMENT_POLICY_VERSION).toBe(RECRUITMENT_POLICY_VERSIONS.at(-1));
  });
});
