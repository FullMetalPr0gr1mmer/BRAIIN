import type { Role } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS, type Access, type Capability } from '@/lib/authz/matrix';

// Which guides a ROLE is shown (Admin v2 U16), decided on the server from ROLE_CAPS: a guide
// names the capabilities whose holders it is for (`caps`), and a role sees it when it holds
// any of them at full, view or meta (the menu's rule, src/lib/admin/nav), every role when it
// names none. A capability this build does not know counts for nobody, so a guide naming
// only those is shown to no one (fail closed). This is a relevance filter, not a secret (the
// guides are in the public repository): it keeps anyone from being sent to a screen they
// cannot open, and RLS does not repeat it (0046's header says why).
//
// Server only: it reads the capability matrix, which never ships to the browser.

const SEE: readonly Access[] = ['full', 'view', 'meta'];
const KNOWN = new Set<string>(CAPABILITIES);

/** May this role read a guide meant for these capabilities? */
export function mayRead(role: Role, caps: readonly string[]): boolean {
  if (caps.length === 0) return true;
  return caps.some((cap) => KNOWN.has(cap) && SEE.includes(ROLE_CAPS[role][cap as Capability]));
}
