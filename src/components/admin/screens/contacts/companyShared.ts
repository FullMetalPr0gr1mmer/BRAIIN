import type { CompanySize } from '@schemas/crmCompanies';
import type { CompanyOption, CompanyRow } from '@/lib/crm/companies';
import type { ContactPerson } from '@/lib/crm/contactView';

// What the Companies tab and the company drawer share (Admin v2 C11). Words follow P-12:
// plain, warm, no dashes; a company's name and city are drawn in their own direction.

export const COMPANY_SIZE_LABELS: Readonly<Record<CompanySize, string>> = {
  '1-10': '1 to 10 people',
  '11-50': '11 to 50 people',
  '51-200': '51 to 200 people',
  '200+': 'More than 200 people',
};

/** The drawer's choices, read by the page (a link to a client publishes nothing). */
export interface CompanyChoices {
  sectors: readonly CompanyOption[];
  clients: readonly CompanyOption[];
  people: readonly ContactPerson[];
}

/** "1 company", "3 companies": the counts' words. */
export function companiesWord(n: number): string {
  return `${n} ${n === 1 ? 'company' : 'companies'}`;
}

/** A company's name, or words for one with none (never empty). */
export function companyName(company: Pick<CompanyRow, 'name'> | null | undefined): string {
  return company?.name?.trim() || 'A company with no name';
}

/** The deep link to a company: the Companies tab with its drawer open (ids only). */
export function companyHref(id: string): string {
  return `/admin/contacts/companies?company=${encodeURIComponent(id)}`;
}

/** The website's host, for a list cell ("acme.example"); the address itself otherwise. */
export function websiteHost(website: string | null): string {
  if (!website) return '';
  try {
    return new URL(website).host;
  } catch {
    return website;
  }
}

export const CONFLICT = 'Someone else changed this. Refreshed.';
