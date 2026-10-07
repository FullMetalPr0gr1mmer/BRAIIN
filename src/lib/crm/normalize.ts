// Normalising contact details before they are blind-indexed (Admin v2, crm.md §6.2).
// Pure: no keys, no I/O. Two spellings of one address must give one index, and two
// different addresses must never collide, so this folds only what is certainly the same:
// case, Unicode compatibility forms, the domain's IDN spelling, and phone punctuation.
// No gmail dot or plus folding: aggressive folding merges different people.

/** Free mailbox providers: an address here says nothing about a company. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'outlook.sa',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'yandex.com',
  'mail.com',
  'zoho.com',
]);

/**
 * Trimmed, NFKC, lower-cased, the domain in its ASCII (punycode) form. Null for anything
 * that is not one local part and one dotted domain.
 */
export function normalizeEmail(raw: string): string | null {
  const value = raw.normalize('NFKC').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  if (/\s/.test(local)) return null;
  let domain: string;
  try {
    // The WHATWG URL parser applies IDNA (UTS 46): an Arabic or accented domain becomes
    // its xn-- form, which is what the mail system resolves anyway.
    domain = new URL(`http://${value.slice(at + 1)}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return `${local}@${domain}`;
}

/** The domain of a normalised address. */
export function emailDomain(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf('@') + 1);
}

/** Whether a normalised address is at a free mailbox provider. */
export function isFreemail(normalized: string): boolean {
  return FREEMAIL_DOMAINS.has(emailDomain(normalized));
}

/** Calling codes for the countries a tenant can be based in (site_profile.address_country). */
const CALLING_CODES: Readonly<Record<string, string>> = {
  SA: '966',
  AE: '971',
  KW: '965',
  QA: '974',
  BH: '973',
  OM: '968',
  EG: '20',
  JO: '962',
};

/** Countries whose mobile numbers are nine digits starting with 5 when dialled locally. */
const NINE_DIGIT_FIVE = new Set(['SA', 'AE']);

/** The E.164 shape the site's phone fields use (migration 0019). */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * E.164 (`+9665…`), or null when the number cannot be read with confidence. A null still
 * stores the phone, encrypted, as given; it only means no index, so no automatic match.
 */
export function normalizePhone(raw: string, defaultCountry: string): string | null {
  // Arabic-Indic (U+0660–0669) and Persian (U+06F0–06F9) digits to ASCII.
  let value = raw.normalize('NFKC').replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  // Separators people type: spaces, dashes, dots, slashes, brackets.
  value = value.replace(/[\s \-./()[\]]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (value.startsWith('+')) return E164.test(value) ? value : null;
  if (!/^[0-9]+$/.test(value)) return null;

  const code = CALLING_CODES[defaultCountry];
  if (!code) return null;
  let national: string | null = null;
  if (value.startsWith('0')) national = value.slice(1);
  else if (NINE_DIGIT_FIVE.has(defaultCountry) && /^5[0-9]{8}$/.test(value)) national = value;
  else if (value.startsWith(code) && value.length > code.length + 6) return toE164(value);
  if (!national) return null;
  return toE164(code + national);
}

function toE164(digits: string): string | null {
  const value = `+${digits}`;
  return E164.test(value) ? value : null;
}
