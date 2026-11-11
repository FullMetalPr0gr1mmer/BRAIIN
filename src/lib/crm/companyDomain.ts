import { blindIndex } from './blindIndex';
import { FREEMAIL_DOMAINS, emailDomain, normalizeEmail } from './normalize';

// Find-or-create a company by e-mail domain at an inquiry's arrival (Admin v2 C11, README's
// C11 row "a company is found or created by non-freemail domain or normalised name"; crm.md
// §6.1). The name half runs in the database as the lead is linked; this is the domain half,
// which needs the key: the blind index (crm-index/v1, kind 'domain', tenant salted) of the
// e-mail's domain, only when it is not a consumer mailbox (a gmail.com or yahoo.co.uk
// address says nothing about a company: isConsumerMailbox below). The index is recorded on
// the lead's e-mail channel by the service role's door (public.crm_lead_domain), whose
// trigger links a contact with no company to the company a person made or edited that holds
// the domain, or teaches the contact's company its domain when the system made that company
// and nobody has edited it (the C11 migration's two rules: C11-SEC-1, C11-SEC-2).
//
// NEVER blocks or changes the inquiry's answer (CLAUDE.md §3: the contact form fails open):
// it runs after the lead is in, and any failure is a system_logs warning carrying a code
// only, never the address, the domain or the lead.

// Which domains are consumer mailboxes, for THIS step (C11 review, C11-SEC-2 and C11-COR-1).
// C1's FREEMAIL_DOMAINS (normalize.ts) was written for one score point and holds exact
// domains only, mostly .com; here a miss joins strangers' records, so the test is wider and
// errs towards skipping (a company domain skipped only loses an automatic link a person can
// make by hand): the scoring list, a list of other consumer providers' own domains, and any
// domain with a provider's name as one of its labels before the last, in any country's form
// (yahoo.co.uk, hotmail.fr, live.com.sa, outlook.com.sa, mail.yahoo.co.uk). crm.md §6.2 names
// the providers this way, without a TLD. The scoring list is left as C1 made it.

/** Consumer mailbox providers' names: a label equal to one of these marks a mailbox. */
export const CONSUMER_MAIL_LABELS: ReadonlySet<string> = new Set([
  'gmail',
  'googlemail',
  'hotmail',
  'outlook',
  'live',
  'windowslive',
  'msn',
  'passport',
  'yahoo',
  'ymail',
  'rocketmail',
  'icloud',
  'me',
  'mac',
  'aol',
  'aim',
  'proton',
  'protonmail',
  'pm',
  'gmx',
  'yandex',
  'ya',
  'mail',
  'email',
  'inbox',
  'zoho',
  'zohomail',
  'tutanota',
  'tuta',
  'tutamail',
  'fastmail',
  'hushmail',
  'mailbox',
  'posteo',
  'startmail',
  'runbox',
  'duck',
  'hey',
  'qq',
  'foxmail',
  '163',
  '126',
  'yeah',
  'sina',
  'sohu',
  'naver',
  'hanmail',
  'daum',
  'rediffmail',
  'rambler',
  'seznam',
  'libero',
  'virgilio',
  'laposte',
  'wanadoo',
  'btinternet',
  'virginmedia',
  'comcast',
  'verizon',
  'sbcglobal',
  'bellsouth',
  'earthlink',
  'bigpond',
  'optusnet',
  'sympatico',
  'interia',
  'ukr',
]);

/** Consumer providers whose own name is too common a word to match as a label. */
export const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'web.de',
  't-online.de',
  'freenet.de',
  'arcor.de',
  'free.fr',
  'orange.fr',
  'sfr.fr',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'bk.ru',
  'list.ru',
  'sky.com',
  'att.net',
  'cox.net',
  'charter.net',
  'shaw.ca',
  'rogers.com',
  'xtra.co.nz',
  'tiscali.it',
  'telenet.be',
  'skynet.be',
  'ziggo.nl',
  'home.nl',
  'kpnmail.nl',
]);

/**
 * Whether an e-mail domain is a consumer mailbox for the company step: the scoring list, the
 * providers' own domains, or a provider's name as a label before the last ("yahoo.co.uk").
 */
export function isConsumerMailbox(domain: string): boolean {
  const value = domain.toLowerCase();
  if (FREEMAIL_DOMAINS.has(value) || CONSUMER_MAIL_DOMAINS.has(value)) return true;
  const labels = value.split('.');
  return labels.slice(0, -1).some((label) => CONSUMER_MAIL_LABELS.has(label));
}

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
  const domain = emailDomain(normalized);
  if (isConsumerMailbox(domain)) return { skip: 'freemail' };
  return { hmac: await blindIndex(rootKey, 'domain', tenantId, domain) };
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
