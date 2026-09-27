import type { Identity } from './fallback';

// The contact page's WhatsApp card (UI v2 PR9). The design ships `wa.me/9665XXXXXXXX` and
// "+966 5X XXX XXXX": a placeholder link on the one page whose whole job is being
// reachable. The card therefore exists only for a REAL number — an E.164 value in the
// public identity (validated on write by SiteProfileSchema, and again here, so a row
// edited outside the admin can never render a broken wa.me link).

const E164 = /^\+[1-9][0-9]{7,14}$/;

export interface WhatsappChannel {
  /** https://wa.me/<digits> — wa.me wants the number without the plus. */
  href: string;
  /** What the card shows: the authored display form, else the E.164 number. */
  display: string;
}

export function whatsappChannel(
  identity: Pick<Identity, 'whatsappE164' | 'whatsappDisplay'>,
): WhatsappChannel | null {
  const e164 = identity.whatsappE164?.trim() ?? '';
  if (!E164.test(e164)) return null;
  const display = identity.whatsappDisplay?.trim();
  return { href: `https://wa.me/${e164.slice(1)}`, display: display || e164 };
}
