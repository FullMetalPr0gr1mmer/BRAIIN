import {
  APPLICATION_FIELDS,
  APPLICATION_GROUPS,
  APPLICATION_GROUP_IDS,
  APPLICATION_OPTIONAL_FIELDS,
  INQUIRY_FIELDS,
  INQUIRY_OPTIONAL_FIELDS,
  type ApplicationField,
} from '@schemas/forms';
import { BUDGET_BANDS, BUDGET_BAND_LABELS } from '@schemas/lead';
import { RECRUITMENT_CONSENT, RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { APPLICATION_LABELS, INQUIRY_LABELS } from '@/lib/forms/config';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import { APPLY_FORM_COPY } from '@/lib/forms/applicationCopy';
import { CONTACT_FORM_FIELDS, type ContactFormVariant } from '@/lib/forms/contactPayload';
import type { FormsScreenProps } from '@/components/admin/screens/forms/FormsScreen';
import { INQUIRY_PLACES, type FormId } from './overview';

// The Forms editor's props (Admin v2 E8), built on the server from the code that decides the
// forms, so the island ships no schema and no copy table: every field in its built-in order
// with the words the visitor reads now, which may be hidden or required, the button, the budget
// words and the Join consent lines. tests/lib/formsEditor.spec.ts holds them to the code.

const VARIANTS = Object.keys(CONTACT_FORM_FIELDS) as ContactFormVariant[];

/** Where an inquiry field is asked, when not every place asks it. */
function askedWhere(field: string): string | undefined {
  const places = VARIANTS.filter((v) =>
    (CONTACT_FORM_FIELDS[v] as readonly string[]).includes(field),
  ).map((v) => INQUIRY_PLACES[v]);
  if (places.length === VARIANTS.length) return undefined;
  const words =
    places.length < 2
      ? (places[0] ?? '')
      : `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`;
  return `Asked on ${words}`;
}

const GROUP_TITLES: Readonly<Record<keyof typeof APPLICATION_GROUPS, string>> = {
  about: 'About you',
  role: 'The role',
  work: 'Your work',
};

const groupOf = (field: ApplicationField): string =>
  APPLICATION_GROUP_IDS.find((g) => (APPLICATION_GROUPS[g] as readonly string[]).includes(field)) ??
  'about';

export function editorPropsFor(form: FormId): FormsScreenProps {
  if (form === 'inquiry') {
    return {
      form: 'inquiry',
      fields: INQUIRY_FIELDS.map((key) => ({
        key,
        label: INQUIRY_LABELS[key],
        optional: (INQUIRY_OPTIONAL_FIELDS as readonly string[]).includes(key),
        where: askedWhere(key),
      })),
      button: { en: CONTACT_FORM_COPY.en.submit, ar: CONTACT_FORM_COPY.ar.submit },
      budgets: BUDGET_BANDS.map((key) => ({ key, label: { ...BUDGET_BAND_LABELS[key] } })),
    };
  }
  return {
    form: 'join',
    fields: APPLICATION_FIELDS.map((key) => ({
      key,
      label: APPLICATION_LABELS[key],
      optional: (APPLICATION_OPTIONAL_FIELDS as readonly string[]).includes(key),
      group: groupOf(key),
    })),
    groups: APPLICATION_GROUP_IDS.map((id) => ({ id, title: GROUP_TITLES[id] })),
    button: { en: APPLY_FORM_COPY.en.submit, ar: APPLY_FORM_COPY.ar.submit },
    consent: {
      application: {
        en: RECRUITMENT_CONSENT.en.application,
        ar: RECRUITMENT_CONSENT.ar.application,
      },
      futureRoles: {
        en: RECRUITMENT_CONSENT.en.futureRoles,
        ar: RECRUITMENT_CONSENT.ar.futureRoles,
      },
    },
    notice: RECRUITMENT_POLICY_VERSION,
  };
}
