import { hmacHex } from '@/lib/crypto/hmac';
import { CRM_INDEX_LABEL, labelledKeyMaterial } from '@/lib/applications/keys';

// Blind indexes (Admin v2, crm.md §6.1): an HMAC of a normalised e-mail or phone, so the
// CRM can ask "have we seen this person before?" with an exact match, without the address
// being stored anywhere in the clear. The key is a labelled derivation of
// LEAD_PII_ENC_KEY (no new secret) and lives only in the Worker, so a leaked database
// cannot be brute-forced, even for a low-entropy phone number.
//
// Salted by tenant (no cross-tenant correlation) and separated by kind (an e-mail and a
// phone that happened to share a string never collide). Pure apart from WebCrypto.

export type BlindIndexKind = 'email' | 'phone' | 'domain';

export function blindIndex(
  rootKey: string,
  kind: BlindIndexKind,
  tenantId: string,
  normalized: string,
): Promise<string> {
  return hmacHex(
    labelledKeyMaterial(rootKey, CRM_INDEX_LABEL),
    `${kind}\u0000${tenantId}\u0000${normalized}`,
  );
}
