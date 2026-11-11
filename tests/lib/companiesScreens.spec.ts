import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CompaniesList from '@/components/admin/screens/contacts/CompaniesList';
import ContactCompanyCard from '@/components/admin/screens/contacts/ContactCompanyCard';
import ContactDetailsCard from '@/components/admin/screens/contacts/ContactDetailsCard';

// The companies screens' first render (Admin v2 C11, crm.md §11): no inline style (CSP), a
// company's and a person's words in their own direction, states in words, addresses that
// carry ids only, the drawer reached through import() only, and the contact page's Company
// card in its three states (linked, typed, none). Plus the free text read-only while linked.

const html = (component: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(component as never, props as never));

const ID = '11111111-1111-4111-8111-111111111111';
const ROW = {
  id: ID,
  name: 'شركة الرشيد',
  website: 'https://alrashid.example/about',
  size: '11-50',
  city: 'جدة',
  stage: 'client',
  owner_id: null,
  notes: null,
  sector_id: null,
  sector_name: 'Retail',
  client_id: null,
  client_name: null,
  auto: true,
  contacts: 3,
  won_value: 50000,
  version: 1,
  created_at: '2026-11-11T10:00:00Z',
  updated_at: '2026-11-11T10:00:00Z',
};
const CHOICES = { sectors: [], clients: [], people: [] };

describe('the Companies tab', () => {
  it('draws the page it was given, in words, with no inline style', () => {
    const out = html(CompaniesList, {
      initial: { rows: [ROW], total: 1 },
      choices: CHOICES,
      me: ID,
    });
    expect(out).not.toMatch(/style=/);
    expect(out).toContain('1 company');
    expect(out).toContain('Made from an inquiry');
    expect(out).toContain('alrashid.example');
    expect(out).toContain(
      `<a class="data-link" href="/admin/contacts/companies?company=${ID}" dir="auto">شركة الرشيد</a>`,
    );
    expect(out).toContain('<span dir="auto">جدة</span>');
    expect(out).toContain(`href="/admin/contacts/companies?company=${ID}"`);
    expect(out).not.toMatch(/company=[^"]*%D8/);
  });

  it('says so when there are none, and reaches the drawer through import() only', () => {
    const out = html(CompaniesList, { initial: { rows: [], total: 0 }, choices: CHOICES, me: ID });
    expect(out).toContain('No companies yet');
    const source = readFileSync('src/components/admin/screens/contacts/CompaniesList.tsx', 'utf8');
    expect(source).toMatch(/import\('\.\/CompanyDrawer'\)/);
    expect(source).not.toMatch(/^import (?!type)[^;]*from '\.\/CompanyDrawer'/m);
  });
});

describe("a contact's Company card", () => {
  const change = async () => true;
  it('linked: the company in its own direction, Open in Companies by id, Unlink', () => {
    const out = html(ContactCompanyCard, {
      contact: { id: ID, version: 2, company_id: ID, company_name: 'شركة الرشيد' },
      busy: false,
      change,
    });
    expect(out).not.toMatch(/style=/);
    expect(out).toContain('<strong dir="auto">شركة الرشيد</strong>');
    expect(out).toContain(`href="/admin/contacts/companies?company=${ID}"`);
    expect(out).toContain('Unlink');
    expect(out).not.toContain('Create company from this name');
  });

  it('typed but not linked: "Create company from this name" and the search', () => {
    const out = html(ContactCompanyCard, {
      contact: { id: ID, version: 2, company_id: null, company_name: 'Acme' },
      busy: false,
      change,
    });
    expect(out).toContain('Create company from this name');
    expect(out).toContain('Link to a company');
    expect(out).toContain('role="status"');
  });

  it('nothing typed: says so, and offers the search only', () => {
    const out = html(ContactCompanyCard, {
      contact: { id: ID, version: 2, company_id: null, company_name: null },
      busy: false,
      change,
    });
    expect(out).toContain('Not linked to a company.');
    expect(out).not.toContain('Create company from this name');
  });

  it("Details' free text is read-only while linked, and says where to change it", () => {
    const linked = html(ContactDetailsCard, {
      contact: { id: ID, version: 2, display_name: 'Huda', company_id: ID, company_name: 'Acme' },
      customFields: [],
      busy: false,
      save: async () => true,
    });
    expect(linked).toMatch(/readOnly=""|readonly=""/);
    expect(linked).toContain('Linked to a company record.');
    const free = html(ContactDetailsCard, {
      contact: { id: ID, version: 2, display_name: 'Huda', company_id: null, company_name: 'Acme' },
      customFields: [],
      busy: false,
      save: async () => true,
    });
    expect(free).not.toMatch(/readOnly=""|readonly=""/);
  });
});
