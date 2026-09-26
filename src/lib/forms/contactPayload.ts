// The contact form's wire contract: which form fields exist in each variant, and how a
// submission becomes the JSON body /api/contact validates with LeadInputSchema.
//
// Pure (no DOM) so it is unit-tested — and that test is the point. LeadInputSchema is a
// NON-strict z.object: a key it does not know is silently DROPPED, not refused. A form
// that posts `deadline` while the schema calls it `timelineText` would therefore "work"
// (200 OK) and lose the answer on every submission. tests/lib/contactForm.spec.ts holds
// every key this module can emit to the schema's own key list.

/** Form control `name` → LeadInputSchema key. */
export const CONTACT_FIELD_TO_LEAD = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  company: 'company',
  message: 'message',
  service: 'serviceOfInterest',
  budget: 'budgetBand',
  timeline: 'timelineBand',
  deadline: 'timelineText',
} as const;
export type ContactField = keyof typeof CONTACT_FIELD_TO_LEAD;

/** Keys every submission carries besides its fields. */
export const CONTACT_FIXED_KEYS = ['kind', 'locale', 'consentMarketing', 'hp'] as const;

/**
 * The fields of each ContactForm variant, in DOM order (ContactForm.astro renders from
 * this list). `compact` is the home form of the UI v2 design (name, email, company,
 * service, message); `full` is /contact's, unchanged until the contact page is ported.
 */
export const CONTACT_FORM_FIELDS = {
  compact: ['name', 'email', 'company', 'service', 'message'],
  full: ['name', 'email', 'phone', 'company', 'service', 'budget', 'timeline', 'message'],
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
    const v = text(field);
    if (v !== undefined) payload[key] = v;
    else if (key === 'name' || key === 'email' || key === 'message') payload[key] = '';
  }
  return payload;
}

const LEAD_TO_FIELD = new Map<string, ContactField>(
  Object.entries(CONTACT_FIELD_TO_LEAD).map(([field, key]) => [key, field as ContactField]),
);

/** The server's 422 `fields` (schema keys) → the form controls to mark. Unknown keys drop. */
export function leadKeysToFields(keys: readonly unknown[]): ContactField[] {
  const out: ContactField[] = [];
  for (const key of keys) {
    const field = typeof key === 'string' ? LEAD_TO_FIELD.get(key) : undefined;
    if (field && !out.includes(field)) out.push(field);
  }
  return out;
}
