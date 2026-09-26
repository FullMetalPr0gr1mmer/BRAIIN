import { describe, it, expect } from 'vitest';
import { LeadInputSchema } from '@schemas/lead';
import {
  CONTACT_FIELD_TO_LEAD,
  CONTACT_FIXED_KEYS,
  CONTACT_FORM_FIELDS,
  buildContactPayload,
  leadKeysToFields,
} from '@/lib/forms/contactPayload';
import { checkField, statusFromHttp } from '@/lib/client/formErrors';

// The contact form's wire contract (UI v2 PR7). LeadInputSchema is a NON-strict z.object,
// so a key it does not know is dropped in silence: the request still answers 200 and the
// answer is simply gone. Nothing but these tests notices a form field posted under the
// wrong name.

const SCHEMA_KEYS = Object.keys(LeadInputSchema.shape);

describe('ContactForm payload ⊆ LeadInputSchema (the contract test)', () => {
  it('every key the form can post is a key the schema reads', () => {
    for (const key of [...Object.values(CONTACT_FIELD_TO_LEAD), ...CONTACT_FIXED_KEYS]) {
      expect(SCHEMA_KEYS, key).toContain(key);
    }
  });

  it('every field of every variant has a mapping (the markup renders from the same list)', () => {
    for (const [variant, fields] of Object.entries(CONTACT_FORM_FIELDS)) {
      for (const f of fields)
        expect(Object.keys(CONTACT_FIELD_TO_LEAD), `${variant}.${f}`).toContain(f);
    }
  });

  it('the home form is the design’s five fields', () => {
    expect(CONTACT_FORM_FIELDS.compact).toEqual(['name', 'email', 'company', 'service', 'message']);
  });

  for (const variant of ['compact', 'full'] as const) {
    it(`a filled ${variant} form parses, and the schema keeps EVERY key it was sent`, () => {
      const values: Record<string, string> = {
        name: 'Kareem',
        email: 'someone@example.com',
        phone: '+966500000000',
        company: 'Studio',
        service: 'branding',
        budget: 'lt_10k',
        timeline: 'asap',
        message: 'A brand identity for a launch this year.',
        consent: 'on',
        hp: '',
      };
      const present = new Set<string>([...CONTACT_FORM_FIELDS[variant], 'consent', 'hp']);
      const payload = buildContactPayload((k) => (present.has(k) ? (values[k] ?? null) : null), {
        kind: 'contact',
        locale: 'ar',
      });
      const parsed = LeadInputSchema.safeParse(payload);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      // Nothing stripped: a renamed key would vanish here.
      expect(Object.keys(parsed.data!).sort()).toEqual(
        expect.arrayContaining(Object.keys(payload)),
      );
      expect(parsed.data!.kind).toBe('contact');
      expect(parsed.data!.locale).toBe('ar');
      expect(parsed.data!.consentMarketing).toBe(true);
    });
  }

  it('omits empty optional controls (an empty service would fail the slug check)', () => {
    const values: Record<string, string> = {
      name: 'K',
      email: 'k@example.com',
      message: 'Hi',
      service: '',
      company: '   ',
    };
    const payload = buildContactPayload((k) => values[k] ?? null, {
      kind: 'contact',
      locale: 'en',
    });
    expect(payload).not.toHaveProperty('serviceOfInterest');
    expect(payload).not.toHaveProperty('company');
    expect(payload['consentMarketing']).toBe(false);
    expect(payload['hp']).toBe('');
    expect(LeadInputSchema.safeParse(payload).success).toBe(true);
  });

  it('sends empty required fields as "" so the server names them', () => {
    const payload = buildContactPayload(() => null, { kind: 'contact', locale: 'en' });
    expect(payload).toMatchObject({ name: '', email: '', message: '' });
    expect(LeadInputSchema.safeParse(payload).success).toBe(false);
  });

  it('never trusts the locale it is handed', () => {
    const p = buildContactPayload(() => null, { kind: 'project_inquiry', locale: 'fr' });
    expect(p['locale']).toBe('en');
    expect(p['kind']).toBe('project_inquiry');
  });

  it('maps the server’s refused keys back onto form controls', () => {
    expect(
      leadKeysToFields(['email', 'serviceOfInterest', 'timelineText', 'nope', 'email']),
    ).toEqual(['email', 'service', 'deadline']);
    expect(leadKeysToFields([42, null])).toEqual([]);
  });
});

describe('formErrors — status and per-field checks', () => {
  it('maps HTTP answers to what the visitor is told', () => {
    expect(statusFromHttp(200)).toBe('ok');
    expect(statusFromHttp(422)).toBe('invalid');
    expect(statusFromHttp(400)).toBe('invalid');
    expect(statusFromHttp(429)).toBe('rate_limited');
    expect(statusFromHttp(503)).toBe('unavailable');
    expect(statusFromHttp(403)).toBe('error');
    expect(statusFromHttp(500)).toBe('error');
  });

  it('mirrors the schema bounds: required, email shape, max length', () => {
    expect(checkField('', { required: true })).toBe('required');
    expect(checkField('   ', { required: true })).toBe('required');
    expect(checkField('', {})).toBeNull();
    expect(checkField('not-an-email', { email: true })).toBe('email');
    expect(checkField('a@b.co', { email: true, required: true })).toBeNull();
    expect(checkField('x'.repeat(121), { maxLength: 120 })).toBe('tooLong');
    expect(checkField('x'.repeat(120), { maxLength: 120 })).toBeNull();
  });

  it('counts characters, not UTF-16 units, so Arabic and emoji are never blocked early', () => {
    // 60 emoji = 120 UTF-16 units — exactly what the server's .max(120) still accepts. A
    // unit-counting client would agree here, but only a code-point count is never LARGER
    // than the server's, so the client can never refuse what the server would take.
    expect(checkField('😀'.repeat(60), { maxLength: 120 })).toBeNull();
    expect(LeadInputSchema.shape.name.safeParse('😀'.repeat(60)).success).toBe(true);
  });
});
