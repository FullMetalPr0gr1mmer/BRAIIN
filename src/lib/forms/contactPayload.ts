// The contact form's wire contract: which form fields exist in each variant, and how a
// submission becomes the JSON body /api/contact validates with LeadInputSchema.
//
// Pure (no DOM) so it is unit-tested — and that test is the point. LeadInputSchema is a
// NON-strict z.object: a key it does not know is silently DROPPED, not refused. A form
// that posts `deadline` while the schema calls it `timelineText` would therefore "work"
// (200 OK) and lose the answer on every submission. tests/lib/contactForm.spec.ts holds
// every key this module can emit to the schema's own key list.

import { serviceChoice } from './serviceSelect';

/**
 * Form control `name` → LeadInputSchema key. Only controls a form actually renders: the
 * home and /contact forms have no phone and no timeline select (the schema still ACCEPTS
 * the legacy `timelineBand`, for pages cached before PR9 — see packages/schemas/lead.ts);
 * the services pages' "Say hello" form adds the phone (Round 2), which the server
 * envelope-encrypts like the email.
 *
 * `service` is the one control with TWO keys: its value space is grouped by discipline
 * (src/lib/forms/serviceSelect.ts), and a "{Discipline}, help me choose" choice
 * (`discipline:<slug>`) posts as `disciplineOfInterest` instead. The key listed here is the
 * plain-slug one; SERVICE_LEAD_KEYS names both.
 */
export const CONTACT_FIELD_TO_LEAD = {
  name: 'name',
  email: 'email',
  company: 'company',
  phone: 'phone',
  message: 'message',
  service: 'serviceOfInterest',
  budget: 'budgetBand',
  deadline: 'timelineText',
} as const;
/** Every lead key the `service` control can post under (serviceChoice decides which). */
export const SERVICE_LEAD_KEYS = ['serviceOfInterest', 'disciplineOfInterest'] as const;
export type ContactField = keyof typeof CONTACT_FIELD_TO_LEAD;

/** Keys every submission carries besides its fields. */
export const CONTACT_FIXED_KEYS = ['kind', 'locale', 'consentMarketing', 'hp'] as const;

/**
 * The fields of each ContactForm variant, in DOM order (ContactForm.astro renders from
 * this list). `compact` is the home form of the UI v2 design (name, email, company,
 * service, message); `full` is /contact's (UI v2 PR9): the same plus the budget range and
 * the free-text deadline ("A date, a season, or ASAP"); `hello` is the services pages'
 * "Say hello" form (Round 2): the design's name, email, company, phone, service, budget
 * and message — no deadline.
 */
export const CONTACT_FORM_FIELDS = {
  compact: ['name', 'email', 'company', 'service', 'message'],
  full: ['name', 'email', 'company', 'service', 'budget', 'deadline', 'message'],
  hello: ['name', 'email', 'company', 'phone', 'service', 'budget', 'message'],
} as const satisfies Record<string, readonly ContactField[]>;
export type ContactFormVariant = keyof typeof CONTACT_FORM_FIELDS;

/** What the form posts as `kind` (LeadKindSchema). */
export type ContactKind = 'contact' | 'project_inquiry';

type Get = (name: string) => FormDataEntryValue | null;

/**
 * FormData → the /api/contact body. An empty control is omitted rather than sent as ""
 * (an empty `serviceOfInterest` would fail the slug check), except the three required
 * fields, which go as "" so the server names them if the client check was bypassed.
 */
export function buildContactPayload(
  get: Get,
  opts: { kind: ContactKind; locale: string },
): Record<string, unknown> {
  const text = (name: string) => {
    const v = get(name);
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  };
  const payload: Record<string, unknown> = {
    kind: opts.kind,
    locale: opts.locale === 'ar' ? 'ar' : 'en',
    consentMarketing: get('consent') === 'on',
    hp: typeof get('hp') === 'string' ? (get('hp') as string) : '',
  };
  for (const [field, key] of Object.entries(CONTACT_FIELD_TO_LEAD)) {
    if (field === 'service') {
      // `discipline:<slug>` → disciplineOfInterest, a slug → serviceOfInterest; "not sure"
      // (empty) posts neither.
      const choice = serviceChoice(text(field));
      if (choice) payload[choice.key] = choice.slug;
      continue;
    }
    const v = text(field);
    if (v !== undefined) payload[key] = v;
    else if (key === 'name' || key === 'email' || key === 'message') payload[key] = '';
  }
  return payload;
}

// Both service keys point back at the one control, so a 422 on either marks the select.
const LEAD_TO_FIELD = new Map<string, ContactField>([
  ...Object.entries(CONTACT_FIELD_TO_LEAD).map(
    ([field, key]) => [key, field as ContactField] as const,
  ),
  ...SERVICE_LEAD_KEYS.map((key) => [key, 'service'] as const),
]);

/** The server's 422 `fields` (schema keys) → the form controls to mark. Unknown keys drop. */
export function leadKeysToFields(keys: readonly unknown[]): ContactField[] {
  const out: ContactField[] = [];
  for (const key of keys) {
    const field = typeof key === 'string' ? LEAD_TO_FIELD.get(key) : undefined;
    if (field && !out.includes(field)) out.push(field);
  }
  return out;
}
