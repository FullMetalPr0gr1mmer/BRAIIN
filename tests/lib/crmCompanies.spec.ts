import { describe, it, expect } from 'vitest';
import {
  CompanyCreateSchema,
  CompanyPatchSchema,
  CompanyQuerySchema,
  CompanyWebsiteSchema,
  ContactCompanySchema,
} from '@schemas/crmCompanies';
import {
  COMPANY_CONSTRAINTS,
  companyBody,
  companyError,
  companyFilter,
  parseCompanyList,
  parseCompanyRead,
  pickCompany,
} from '@/lib/crm/companies';
import {
  domainIndex,
  isConsumerMailbox,
  recordLeadDomain,
  type DomainRpcClient,
} from '@/lib/crm/companyDomain';
import { isFreemail } from '@/lib/crm/normalize';
import { blindIndex } from '@/lib/crm/blindIndex';
import { contactsSubline } from '@/lib/crm/contactView';
import {
  checkCompany,
  companyRequest,
  domainWords,
  formOf,
} from '@/components/admin/screens/contacts/CompanyDrawer';
import { changeWords } from '@/components/admin/screens/contacts/ContactCompanyCard';
import { companyQueryBody } from '@/components/admin/screens/contacts/CompaniesList';
import {
  companiesWord,
  companyHref,
  websiteHost,
} from '@/components/admin/screens/contacts/companyShared';

// Companies (Admin v2 C11, crm.md §5.3, §9, §13 "vitest: website must be https and within 2048
// characters; company totals are derived"): the shapes, the answers cut to named fields (never
// the domain index), the refusals' words, the domain half of find-or-create at arrival (only a
// non-freemail domain, as its blind index, never throwing), and the screens' pure rules.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'a'.repeat(64);
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Trading',
  website: 'https://acme.example/about',
  size: '11-50',
  city: 'Jeddah',
  stage: 'client',
  owner_id: null,
  notes: null,
  sector_id: null,
  sector_name: 'Retail',
  client_id: null,
  client_name: null,
  auto: false,
  contacts: 3,
  won_value: 50000,
  version: 2,
  created_at: '2026-11-11T10:00:00Z',
  updated_at: '2026-11-11T10:00:00Z',
  domain_hmac: 'b'.repeat(64),
  email_enc: 'enc:someone',
};

describe('a website is https and within 2048 characters', () => {
  it('takes an https address with a host', () => {
    expect(CompanyWebsiteSchema.safeParse('https://acme.example').success).toBe(true);
    expect(CompanyWebsiteSchema.safeParse('https://acme.example/about?x=1#y').success).toBe(true);
  });

  it('refuses http, no host, credentials, spaces and anything longer than 2048', () => {
    for (const bad of [
      'http://acme.example',
      'https://',
      'https://user:pass@acme.example',
      'https://acme example',
      'acme.example',
      'javascript:alert(1)',
      `https://acme.example/${'x'.repeat(2030)}`,
    ]) {
      expect(CompanyWebsiteSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(CompanyWebsiteSchema.safeParse(`https://acme.example/${'x'.repeat(2000)}`).success).toBe(
      true,
    );
  });
});

describe('the shapes the routes accept', () => {
  it('a new company needs a name and no unknown field', () => {
    expect(CompanyCreateSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(CompanyCreateSchema.safeParse({ name: 'Acme', domain_hmac: KEY }).success).toBe(false);
    expect(CompanyCreateSchema.safeParse({ name: 'Acme', size: '5-10' }).success).toBe(false);
    expect(CompanyCreateSchema.safeParse({ name: 'Acme\u0007' }).success).toBe(false);
    expect(CompanyCreateSchema.safeParse({ name: 'أكمي', stage: 'partner' }).success).toBe(true);
  });

  it('a change carries its version and something to change', () => {
    expect(CompanyPatchSchema.safeParse({ city: 'Jeddah' }).success).toBe(false);
    expect(CompanyPatchSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(CompanyPatchSchema.safeParse({ version: 1, website: null }).success).toBe(true);
  });

  it('the list query is bounded, and a contact link names a company only to link', () => {
    expect(CompanyQuerySchema.safeParse({ q: 'x'.repeat(65) }).success).toBe(false);
    expect(CompanyQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(CompanyQuerySchema.safeParse({ owner: 'someone' }).success).toBe(false);
    expect(ContactCompanySchema.safeParse({ action: 'link', version: 1 }).success).toBe(false);
    expect(
      ContactCompanySchema.safeParse({ action: 'create', version: 1, companyId: ROW.id }).success,
    ).toBe(false);
    expect(ContactCompanySchema.safeParse({ action: 'unlink', version: 2 }).success).toBe(true);
  });
});

describe('answers are cut to named fields; totals are derived by the database', () => {
  it('pickCompany never passes on the domain index or anything unnamed', () => {
    const company = pickCompany(ROW)!;
    expect(company).not.toHaveProperty('domain_hmac');
    expect(company).not.toHaveProperty('email_enc');
    expect(company.contacts).toBe(3);
    expect(company.won_value).toBe(50000);
  });

  it('reads a bigint total the database sends as text, and refuses a row with no id', () => {
    expect(pickCompany({ ...ROW, won_value: '120000' })!.won_value).toBe(120000);
    expect(pickCompany({ ...ROW, id: undefined })).toBeNull();
  });

  it('says whether a company holds a learnt domain, never which (C11-SEC-1)', () => {
    expect(pickCompany(ROW)!.domain).toBeNull();
    expect(pickCompany({ ...ROW, domain: 'learnt' })!.domain).toBe('learnt');
    expect(pickCompany({ ...ROW, domain: 'joins' })!.domain).toBe('joins');
    expect(pickCompany({ ...ROW, domain: 'b'.repeat(64) })!.domain).toBeNull();
    const page = parseCompanyList({ total: 4, rows: [ROW, { nope: true }] });
    expect(page.total).toBe(4);
    expect(page.rows).toHaveLength(1);
  });

  it("a company's contacts are named only", () => {
    const read = parseCompanyRead({
      company: ROW,
      contacts: [{ id: ROW.id, display_name: 'Huda', title: null, stage: 'lead', email: 'x@y.z' }],
      more: true,
    });
    expect(read.contacts).toEqual([
      { id: ROW.id, display_name: 'Huda', title: null, stage: 'lead' },
    ]);
    expect(read.more).toBe(true);
  });
});

describe('the API names to the database names', () => {
  it('an emptied box is null, absent stays absent', () => {
    expect(companyBody({ name: 'Acme', city: '  ', ownerId: null, website: undefined })).toEqual({
      name: 'Acme',
      city: null,
      owner_id: null,
    });
    expect(companyFilter({ q: '  acme ', stage: 'client', owner: 'me' })).toEqual({
      q: 'acme',
      stage: 'client',
      owner: 'me',
      limit: 25,
    });
  });

  it('a refusal is a status and plain words, never the database text', () => {
    const owner = companyError(
      { code: '23514', message: 'boom "secret" (constraint "crm_companies_owner_active")' },
      'the company',
    ) as Error & { field?: string };
    expect(owner.message).toContain(COMPANY_CONSTRAINTS['crm_companies_owner_active']!.message);
    expect(owner.message).not.toMatch(/secret/);
    expect(companyError({ code: '40001' }, 'x').constructor.name).toBe('OptimisticLockError');
    expect(companyError({ code: 'P0002' }, 'x').constructor.name).toBe('NotFoundError');
    expect(companyError({ code: '42501' }, 'x').constructor.name).toBe('AuthorizationError');
    for (const words of Object.values(COMPANY_CONSTRAINTS)) {
      expect(words.message).not.toMatch(/[–—]/);
    }
  });
});

describe('the domain half of find-or-create at arrival', () => {
  it("is the domain's blind index (kind 'domain', tenant salted) for a company address", async () => {
    const index = await domainIndex(KEY, TENANT, ' Sara@ACME.sa ');
    expect(index).toEqual({ hmac: await blindIndex(KEY, 'domain', TENANT, 'acme.sa') });
    expect(await domainIndex(KEY, TENANT, 'sara@acme.sa')).toEqual(index);
    expect(
      await domainIndex(KEY, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sara@acme.sa'),
    ).not.toEqual(index);
  });

  // (C11 review, C11-COR-1 and C11-SEC-2) The scoring list's exact .com domains missed every
  // regional form of the same providers, and those joined strangers' records.
  it('skips a consumer mailbox in any country form, not only the scoring list', async () => {
    for (const email of [
      'a@yahoo.co.uk',
      'a@yahoo.fr',
      'a@hotmail.fr',
      'a@hotmail.co.uk',
      'a@live.co.uk',
      'a@live.com.sa',
      'a@outlook.com.sa',
      'a@outlook.fr',
      'a@ymail.com',
      'a@rocketmail.com',
      'a@pm.me',
      'a@gmx.de',
      'a@gmx.net',
      'a@web.de',
      'a@mail.ru',
      'a@yandex.ru',
      'a@qq.com',
      'a@163.com',
      'a@mail.yahoo.co.uk',
    ]) {
      expect(await domainIndex(KEY, TENANT, email), email).toEqual({ skip: 'freemail' });
    }
    // A company's own domain still counts, whatever its country form.
    for (const domain of [
      'acme.sa',
      'acme.com.sa',
      'alrashid-trading.com',
      'e2e-x.example.invalid',
    ]) {
      expect(isConsumerMailbox(domain), domain).toBe(false);
    }
    // The scoring list is left as C1 made it: this wider rule is the company step's alone.
    expect(isFreemail('a@yahoo.co.uk')).toBe(false);
  });

  it('skips a free mailbox and an address that does not read as one', async () => {
    expect(await domainIndex(KEY, TENANT, 'sara@gmail.com')).toEqual({ skip: 'freemail' });
    expect(await domainIndex(KEY, TENANT, 'not an address')).toEqual({ skip: 'no_domain' });
    expect(await domainIndex(KEY, TENANT, null)).toEqual({ skip: 'no_domain' });
  });

  it('never throws, and reports a code only', async () => {
    const warned: string[] = [];
    const calls: unknown[] = [];
    const ok: DomainRpcClient = {
      rpc: async (_fn, args) => {
        calls.push(args);
        return { data: 'recorded', error: null };
      },
    };
    const refused: DomainRpcClient = {
      rpc: async () => ({ data: null, error: { code: '42501' } }),
    };
    const broken: DomainRpcClient = {
      rpc: () => Promise.reject(new Error('sara@acme.sa is down')),
    };
    const lead = '22222222-2222-4222-8222-222222222222';
    const warn = (code: string) => warned.push(code);
    expect(await recordLeadDomain(ok, KEY, TENANT, lead, 'sara@acme.sa', warn)).toBe('recorded');
    expect(await recordLeadDomain(ok, KEY, TENANT, lead, 'sara@gmail.com', warn)).toBe('freemail');
    expect(await recordLeadDomain(refused, KEY, TENANT, lead, 'sara@acme.sa', warn)).toBe('failed');
    expect(await recordLeadDomain(broken, KEY, TENANT, lead, 'sara@acme.sa', warn)).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toMatch(/acme|sara/);
    expect(warned).toEqual(['42501', 'threw']);
  });
});

describe('the screens’ pure rules', () => {
  it('the drawer sends only what changed, an emptied box as null', () => {
    const before = pickCompany(ROW)!;
    const form = formOf(before, 'me', true);
    expect(companyRequest(form, before)).toEqual({});
    expect(companyRequest({ ...form, city: '', notes: 'Met at the fair' }, before)).toEqual({
      city: null,
      notes: 'Met at the fair',
    });
    const fresh = companyRequest({ ...formOf(null, ROW.id, true), name: ' New Co ' }, null);
    expect(fresh).toEqual({ name: 'New Co', stage: 'lead', ownerId: ROW.id });
    expect(CompanyCreateSchema.safeParse(fresh).success).toBe(true);
  });

  it('the drawer says a learnt domain is held, and an unlink says what it removed', () => {
    expect(domainWords('joins')).toMatch(/join it\.$/);
    expect(domainWords('learnt')).toMatch(
      /^This company learnt an e-mail domain.*Once someone edits/,
    );
    expect(changeWords('unlink', false)).toBe('Company unlinked.');
    expect(changeWords('unlink', true)).toBe(
      'Company unlinked. The company it left was made from an inquiry and had no other contacts, so it was removed.',
    );
    for (const words of [domainWords('joins'), domainWords('learnt'), changeWords('link', true)]) {
      expect(words).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('the drawer refuses a blank name and a website that is not https first', () => {
    expect(checkCompany({ ...formOf(null, 'me', false), name: ' ' })).toHaveProperty('name');
    expect(
      checkCompany({ ...formOf(null, 'me', false), name: 'X', website: 'http://acme.example' }),
    ).toHaveProperty('website');
    expect(checkCompany({ ...formOf(null, 'me', false), name: 'X', website: '' })).toEqual({});
  });

  it('the list body, the words and the address (ids only)', () => {
    expect(
      companyQueryBody({ chip: 'client', owner: 'none', sort: 'value', page: 3 }, 'acme'),
    ).toEqual({
      q: 'acme',
      stage: 'client',
      owner: 'none',
      sort: 'value',
      limit: 25,
      offset: 50,
    });
    expect(
      CompanyQuerySchema.safeParse(
        companyQueryBody({ chip: 'all', owner: '', sort: 'name', page: 1 }, ''),
      ).success,
    ).toBe(true);
    expect(companiesWord(1)).toBe('1 company');
    expect(companiesWord(0)).toBe('0 companies');
    expect(companyHref(ROW.id)).toBe(`/admin/contacts/companies?company=${ROW.id}`);
    expect(websiteHost('https://acme.example/about')).toBe('acme.example');
    const summary = {
      total: 12,
      lead: 8,
      client: 3,
      past: 1,
      partner: 0,
      starred: 0,
      mine: 0,
      expiring: 0,
      to_check: 0,
    };
    expect(contactsSubline(summary)).toBe('12 people · 3 clients · 8 leads · 1 past client');
    expect(contactsSubline(summary, 2)).toBe(
      '12 people · 3 clients · 8 leads · 1 past client · 2 companies',
    );
  });
});
