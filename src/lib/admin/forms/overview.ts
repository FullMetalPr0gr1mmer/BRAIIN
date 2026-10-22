import type { ZodTypeAny } from 'zod';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { ApplicationInputSchema, CV_MAX_BYTES } from '@schemas/application';
import { LeadInputSchema } from '@schemas/lead';
import { APPLY_FORM_COPY } from '@/lib/forms/applicationCopy';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import { CONTACT_FIELD_TO_LEAD, CONTACT_FORM_FIELDS } from '@/lib/forms/contactPayload';
import { APPLY_LIMITS, CONTACT_LIMITS } from '@/lib/http/publicRateLimit';

// The Forms overview (Admin v2 U11, docs/admin-v2/ui.md "Integrations, Forms, Notifications
// (AV-20)"): what the site's two forms ask for and how each keeps spam out, read-only (E8
// makes the forms configurable). Every fact is DERIVED from the code that decides it, so the
// screen cannot drift from the forms: the fields from the variant the Contact page renders
// (CONTACT_FORM_FIELDS.full) and from the Join form's controls; each label is the one the
// visitor reads; "Required" is whatever the server's schema refuses when the control is left
// as it starts (blank text, no craft picked, a box unticked); the limits are EXC-004's
// constants. tests/lib/formsOverview.spec.ts holds each fact to its source.

export type FormId = 'inquiry' | 'join';

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

/** The inquiry form on Contact: the full variant, in the order the page renders it. */
function inquiryFields(): FormFieldFact[] {
  const shape = LeadInputSchema.shape;
  const fields: FormFieldFact[] = CONTACT_FORM_FIELDS.full.map((field) => {
    const key = CONTACT_FIELD_TO_LEAD[field];
    return {
      key,
      label: contactLabel(field),
      required: refusesUntouched(shape[key], undefined),
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
      where: 'On the Contact page, in English and Arabic.',
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
