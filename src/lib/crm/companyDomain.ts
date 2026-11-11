import { blindIndex } from './blindIndex';
import { emailDomain, isFreemail, normalizeEmail } from './normalize';

// Find-or-create a company by e-mail domain at an inquiry's arrival (Admin v2 C11, README's
// C11 row "a company is found or created by non-freemail domain or normalised name"; crm.md
// §6.1). The name half runs in the database as the lead is linked; this is the domain half,
// which needs the key: the blind index (crm-index/v1, kind 'domain', tenant salted) of the
// e-mail's domain, only when it is not a free mailbox provider (a gmail.com address says
// nothing about a company). The index is recorded on the lead's e-mail channel by the service
// role's door (public.crm_lead_domain), whose trigger links a contact with no company to the
// company holding that domain, or teaches the contact's company its domain.
//
// NEVER blocks or changes the inquiry's answer (CLAUDE.md §3: the contact form fails open):
// it runs after the lead is in, and any failure is a system_logs warning carrying a code
// only, never the address, the domain or the lead.

/** The minimal RPC surface this needs (the service client, or a stub in tests). */
export interface DomainRpcClient {
  rpc(
    fn: 'crm_lead_domain',
    args: { p_tenant: string; p_lead: string; p_domain_hmac: string },
  ): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
}

/** What happened, for the tests and the log line (never a value). */
export type DomainOutcome =
  'recorded' | 'missing' | 'unlinked' | 'spam' | 'no_channel' | 'no_domain' | 'freemail' | 'failed';

/** The domain's blind index of a typed e-mail, or why there is none. Pure apart from WebCrypto. */
export async function domainIndex(
  rootKey: string,
  tenantId: string,
  email: string | null | undefined,
): Promise<{ hmac: string } | { skip: 'no_domain' | 'freemail' }> {
  const normalized = email ? normalizeEmail(email) : null;
  if (!normalized) return { skip: 'no_domain' };
  if (isFreemail(normalized)) return { skip: 'freemail' };
  return { hmac: await blindIndex(rootKey, 'domain', tenantId, emailDomain(normalized)) };
}

/**
 * Records the domain index of an inquiry that is in. Never throws: a failure is reported to
 * `warn` (a code only) and answered as 'failed'.
 */
export async function recordLeadDomain(
  sb: DomainRpcClient,
  rootKey: string,
  tenantId: string,
  leadId: string,
  email: string | null | undefined,
  warn: (code: string) => void,
): Promise<DomainOutcome> {
  try {
    const index = await domainIndex(rootKey, tenantId, email);
    if ('skip' in index) return index.skip;
    const { data, error } = await sb.rpc('crm_lead_domain', {
      p_tenant: tenantId,
      p_lead: leadId,
      p_domain_hmac: index.hmac,
    });
    if (error) {
      warn(error.code ?? 'no code');
      return 'failed';
    }
    const known: readonly string[] = ['recorded', 'missing', 'unlinked', 'spam', 'no_channel'];
    return typeof data === 'string' && known.includes(data) ? (data as DomainOutcome) : 'failed';
  } catch {
    warn('threw');
    return 'failed';
  }
}
