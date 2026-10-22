import type { ZodTypeAny } from 'zod';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { ApplicationInputSchema, CV_MAX_BYTES } from '@schemas/application';
import { LeadInputSchema } from '@schemas/lead';
import { APPLY_FORM_COPY } from '@/lib/forms/applicationCopy';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import {
  CONTACT_FIELD_TO_LEAD,
  CONTACT_FORM_FIELDS,
  type ContactField,
  type ContactFormVariant,
} from '@/lib/forms/contactPayload';
import { APPLY_LIMITS, CONTACT_LIMITS } from '@/lib/http/publicRateLimit';

// The Forms overview (Admin v2 U11, docs/admin-v2/ui.md "Integrations, Forms, Notifications
// (AV-20)"): what the site's two forms ask for and how each keeps spam out, read-only (E8
// makes the forms configurable). Every fact is DERIVED from the code that decides it, so the
// screen cannot drift from the forms: the fields from every variant the site renders of the
// inquiry form (CONTACT_FORM_FIELDS: home, Contact, the services pages), each marked with the
// places that ask it when not all do, and from the Join form's controls; each label is the
// one the visitor reads; "Required" is whatever the server's schema refuses when the control
// is left as it starts (blank text, no craft picked, a box unticked); the limits are
// EXC-004's constants. tests/lib/formsOverview.spec.ts holds each fact to its source.

/** The overview's tabs, in their order; the first is the bare page. */
export const FORM_IDS = ['inquiry', 'join'] as const;
export type FormId = (typeof FORM_IDS)[number];

/** The Forms screen's address. */
export const FORMS_PATH = '/admin/forms';

/**
 * Each tab's link (zero JS: a tab is a URL of the page). tests/lib/adminRoutes.spec.ts holds
 * every one to the per-role sweep (tests/admin/routes.ts EXTRA_LINKS).
 */
export function formsTabHref(id: FormId): string {
  return id === FORM_IDS[0] ? FORMS_PATH : `${FORMS_PATH}?tab=${id}`;
}

export interface FormFieldFact {
  /** The schema key the control fills. */
  key: string;
  /** What the visitor reads beside it (English: the admin is English, L7). */
  label: string;
  required: boolean;
  /** A line under the label, when the field has a rule worth naming. */
  hint?: string | undefined;
}

export interface FormFacts {
  id: FormId;
  /** The tab's name. */
  name: string;
  /** Where the form is, for the person reading the overview. */
  where: string;
  fields: readonly FormFieldFact[];
  /** How often one sender may send, in words, from the EXC-004 limits. */
  limits: readonly string[];
  /** What happens when the limit cannot be checked (the route's choice, EXC-004). */
  unchecked: string;
}

/** True when the schema refuses the value an untouched control sends. */
function refusesUntouched(schema: ZodTypeAny, untouched: unknown): boolean {
  return !schema.safeParse(untouched).success;
}

/** "10 an hour", "3 a day": a limit as a person says it. */
export function perWindow(max: number, windowSeconds: number): string {
  if (windowSeconds === 3600) return `${max} an hour`;
  if (windowSeconds === 86_400) return `${max} a day`;
  return `${max} every ${Math.round(windowSeconds / 60)} minutes`;
}

/** The size the CV may be, in the units the Join form states. */
export const CV_LIMIT = `${Math.round(CV_MAX_BYTES / (1024 * 1024))} MB`;

const contactLabel = (field: keyof typeof CONTACT_FIELD_TO_LEAD): string =>
  CONTACT_FORM_COPY.en[field];

/**
 * Where each variant of the inquiry form is on the site, in words: the section that renders it
 * (`fields="..."` on ContactForm) is HomeContact (home), ContactInquiry (Contact) and Hello
 * (closing /services and every service page). tests/lib/formsOverview.spec.ts holds each to its
 * call site, and a new variant to a place here.
 */
export const INQUIRY_PLACES = {
  compact: 'the home page',
  full: 'the Contact page',
  hello: 'the services pages',
} as const satisfies Record<ContactFormVariant, string>;

const INQUIRY_VARIANTS = Object.keys(CONTACT_FORM_FIELDS) as ContactFormVariant[];

/** "a", "a and b", "a, b and c". */
function inWords(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Every variant's fields as one list that keeps each variant's order: a field one variant adds
 * goes right after the field it follows there.
 */
export function inquiryFieldOrder(): ContactField[] {
  const out: ContactField[] = [];
  for (const variant of INQUIRY_VARIANTS) {
    const list: readonly ContactField[] = CONTACT_FORM_FIELDS[variant];
    list.forEach((field, i) => {
      if (out.includes(field)) return;
      const after = list
        .slice(0, i)
        .reverse()
        .find((f) => out.includes(f));
      out.splice(after === undefined ? 0 : out.indexOf(after) + 1, 0, field);
    });
  }
  return out;
}

/** The places that ask for a field, when not all of them do. */
function askedOnlyOn(field: ContactField): string | undefined {
  const variants = INQUIRY_VARIANTS.filter((v) =>
    (CONTACT_FORM_FIELDS[v] as readonly ContactField[]).includes(field),
  );
  if (variants.length === INQUIRY_VARIANTS.length) return undefined;
  return `Only on ${inWords(variants.map((v) => INQUIRY_PLACES[v]))}`;
}

/**
 * The inquiry form: every field any of its variants asks for, in the order the pages render
 * them, each marked with the places that ask it when not every place does.
 */
function inquiryFields(): FormFieldFact[] {
  const shape = LeadInputSchema.shape;
  const fields: FormFieldFact[] = inquiryFieldOrder().map((field) => {
    const key = CONTACT_FIELD_TO_LEAD[field];
    return {
      key,
      label: contactLabel(field),
      required: refusesUntouched(shape[key], undefined),
      hint: askedOnlyOn(field),
    };
  });
  fields.push({
    key: 'consentMarketing',
    label: CONTACT_FORM_COPY.en.consent,
    required: refusesUntouched(shape.consentMarketing, false),
  });
  return fields;
}

/** The Join form's controls, in the order the page renders them. */
const JOIN_CONTROLS = [
  'name',
  'email',
  'phone',
  'city',
  'role',
  'experience',
  'workType',
  'availability',
  'skills',
  'portfolio',
  'linkedin',
  'cv',
  'message',
  'consentApplication',
  'consentFutureRoles',
] as const;
type JoinControl = (typeof JOIN_CONTROLS)[number];

const JOIN_LABELS: Record<JoinControl, string> = {
  name: APPLY_FORM_COPY.en.name,
  email: APPLY_FORM_COPY.en.email,
  phone: APPLY_FORM_COPY.en.phone,
  city: APPLY_FORM_COPY.en.city,
  role: APPLY_FORM_COPY.en.role,
  experience: APPLY_FORM_COPY.en.experience,
  workType: APPLY_FORM_COPY.en.workType,
  availability: APPLY_FORM_COPY.en.availability,
  skills: APPLY_FORM_COPY.en.skills,
  portfolio: APPLY_FORM_COPY.en.portfolio,
  linkedin: APPLY_FORM_COPY.en.linkedin,
  cv: 'CV',
  message: APPLY_FORM_COPY.en.message,
  consentApplication: 'Agreement to keep and review this application',
  consentFutureRoles: 'Agreement to be contacted about future roles',
};

/** What each Join control sends when it is left as it starts. */
const UNTOUCHED: Partial<Record<JoinControl, unknown>> = {
  skills: [],
  consentApplication: false,
  consentFutureRoles: false,
};

function joinFields(): FormFieldFact[] {
  const shape = ApplicationInputSchema.shape;
  return JOIN_CONTROLS.map((control) => {
    if (control === 'cv') {
      // The file is not a schema key: the route stores it when one is sent (src/pages/api/apply.ts).
      return {
        key: 'cv',
        label: JOIN_LABELS.cv,
        required: false,
        hint: `PDF or Word (.docx), up to ${CV_LIMIT}`,
      };
    }
    return {
      key: control,
      label: JOIN_LABELS[control],
      required: refusesUntouched(shape[control], UNTOUCHED[control]),
    };
  });
}

/** Both forms, as the overview shows them. */
export function formFacts(): Record<FormId, FormFacts> {
  return {
    inquiry: {
      id: 'inquiry',
      name: 'Inquiry form',
      where: `On ${inWords(INQUIRY_VARIANTS.map((v) => INQUIRY_PLACES[v]))}, in English and Arabic. Some fields are asked only in some of those places, as noted under them.`,
      fields: inquiryFields(),
      limits: [
        `${perWindow(CONTACT_LIMITS.perIp.max, CONTACT_LIMITS.perIp.windowSeconds)} from one internet address`,
      ],
      unchecked:
        'If the count cannot be checked, the send still goes through, so no inquiry is lost.',
    },
    join: {
      id: 'join',
      name: 'Join form',
      where: 'On the Join page, in English and Arabic, while applications are open.',
      fields: joinFields(),
      limits: [
        `${perWindow(APPLY_LIMITS.perIp.max, APPLY_LIMITS.perIp.windowSeconds)} from one internet address`,
        `${perWindow(APPLY_LIMITS.perEmail.max, APPLY_LIMITS.perEmail.windowSeconds)} from one e-mail`,
      ],
      unchecked:
        'If the counts cannot be checked, the send is refused for now, because it carries a file.',
    },
  };
}

/** The consent text version the Join form shows now (stored with each application). */
export const CONSENT_VERSION = RECRUITMENT_POLICY_VERSION;
