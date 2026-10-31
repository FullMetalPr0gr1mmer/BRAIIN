// What a public form says it asked as required (Admin v2 E8, review finding CR1). Zod-free:
// the contact form's script imports it.
//
// A page is Tier A and a visitor may keep one open for hours, so a page can be rendered under
// one forms config and sent under the next. When the next config makes an optional field
// required (the budget, LinkedIn, the CV) and the open page never showed it, holding the send to
// the new config would refuse it on a field the visitor cannot see, on every try, until a
// reload. So each form posts the optional fields it showed as required, in one hidden control,
// and the endpoints require a field only when the published config requires it AND the sending
// page showed it as required (src/lib/forms/config.ts checkInquiry, checkApplication). A send
// with no claim at all (a page from before this control, a hand-made request) is held to the
// published config.
//
// The claim can only NARROW the requirement; it is the visitor's word, like the contact form's
// `form` (the variant), and a required field is the studio's wish for a complete answer, not a
// protection: the schemas stay the floor, and what the config hides is dropped whatever the
// claim says (data minimisation never follows the client).

/** The hidden control both forms carry: the optional fields shown as required, space-separated. */
export const REQUIRED_CLAIM_INPUT = 'required_fields';

/** At most this many names are read from a claim (each form has at most five optional fields). */
const CLAIM_MAX = 16;

/** The control's value for the fields a form shows as required. */
export function requiredClaimValue(fields: readonly string[]): string {
  return fields.join(' ');
}

/**
 * A posted claim → the names it lists (unknown names are kept here and ignored by the checks),
 * or undefined when nothing was posted: a string (the form control, space-separated) or an
 * array of strings (the contact form's JSON). Anything else is no claim.
 */
export function parseRequiredClaim(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') {
    return raw.split(/\s+/).filter(Boolean).slice(0, CLAIM_MAX);
  }
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string').slice(0, CLAIM_MAX);
  }
  return undefined;
}
