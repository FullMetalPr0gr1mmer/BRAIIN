import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The companies API (Admin v2 C11, crm.md §9 and §13): every route reads and writes as the
// caller through the INVOKER functions, naming the caller's tenant; answers are cut to the
// named fields (never the domain index); a change and a removal carry the version; a refusal
// maps to its status and plain words; the audit rows carry ids, field names and counts, never
// what a field holds.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';

const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};
let contactRow: Record<string, unknown> | null = null;

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const ROW = {
  id: COMPANY,
  name: 'Acme Trading',
  website: 'https://acme.example',
  size: null,
  city: 'Jeddah',
  stage: 'client',
  owner_id: USER,
  notes: 'Met at the fair',
  sector_id: null,
  sector_name: null,
  client_id: null,
  client_name: null,
  auto: false,
  contacts: 2,
  won_value: 0,
  version: 3,
  created_at: '2026-11-11T10:00:00Z',
  updated_at: '2026-11-11T10:00:00Z',
  domain_hmac: 'b'.repeat(64),
};

function client() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcAnswers[fn] ?? { data: null, error: null };
    },
    from: () => {
      const builder: Record<string, unknown> = {};
      builder['select'] = () => builder;
      builder['eq'] = () => builder;
      builder['maybeSingle'] = async () => ({ data: contactRow, error: null });
      return builder;
    },
  };
}

function ctx(path: string, method = 'GET', body?: unknown, id = COMPANY): APIContext {
  const url = new URL(`https://admin.example.test${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', email: 'a@x', isActive: true },
      supabase: client(),
    },
  } as unknown as APIContext;
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  audits.length = 0;
  rpcCalls.length = 0;
  rpcAnswers = {};
  contactRow = null;
});

describe('POST /api/admin/crm/companies/query', () => {
  it('reads as the caller for the caller’s tenant, cut to the named fields', async () => {
    const { POST } = await import('@/pages/api/admin/crm/companies/query');
    rpcAnswers['crm_companies_list'] = { data: { total: 1, rows: [ROW] }, error: null };
    const res = await POST(
      ctx('/api/admin/crm/companies/query', 'POST', { q: 'acme', sort: 'value' }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0]).toEqual({
      fn: 'crm_companies_list',
      args: { p_tenant: TENANT, p_filter: { q: 'acme', sort: 'value', limit: 25 } },
    });
    const body = (await json(res))['data'] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('domain_hmac');
    expect(body['total']).toBe(1);
    expect(audits).toEqual([]);
  });

  it('a refused filter is a 422', async () => {
    const { POST } = await import('@/pages/api/admin/crm/companies/query');
    rpcAnswers['crm_companies_list'] = { data: null, error: { code: '22023' } };
    expect((await POST(ctx('/api/admin/crm/companies/query', 'POST', {}))).status).toBe(422);
  });
});

describe('POST /api/admin/crm/companies', () => {
  it('creates as the caller, in the database’s names, audited with field names only', async () => {
    const { POST } = await import('@/pages/api/admin/crm/companies/index');
    rpcAnswers['crm_company_create'] = { data: ROW, error: null };
    const res = await POST(
      ctx('/api/admin/crm/companies', 'POST', {
        name: 'Acme Trading',
        website: 'https://acme.example',
        notes: 'Met at the fair',
        ownerId: USER,
      }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_company: {
        name: 'Acme Trading',
        website: 'https://acme.example',
        notes: 'Met at the fair',
        owner_id: USER,
      },
    });
    expect(audits).toEqual([
      {
        action: 'crm.company.create',
        entityType: 'company',
        entityId: COMPANY,
        detail: { fields: ['name', 'notes', 'ownerId', 'website'] },
      },
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/Acme|fair/);
  });

  it('an owner the database refuses is a 422 on that field, in plain words', async () => {
    const { POST } = await import('@/pages/api/admin/crm/companies/index');
    rpcAnswers['crm_company_create'] = {
      data: null,
      error: { code: '23514', message: 'x (constraint "crm_companies_owner_active")' },
    };
    const res = await POST(ctx('/api/admin/crm/companies', 'POST', { name: 'X', ownerId: USER }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await json(res))).toMatch(/Pick someone who works with contacts/);
    expect(audits).toEqual([]);
  });

  it('a website that is not https never reaches the database', async () => {
    const { POST } = await import('@/pages/api/admin/crm/companies/index');
    const res = await POST(
      ctx('/api/admin/crm/companies', 'POST', { name: 'X', website: 'http://x.example' }),
    );
    expect(res.status).toBe(422);
    expect(rpcCalls).toEqual([]);
  });
});

describe('/api/admin/crm/companies/[id]', () => {
  it('GET reads one company and its contacts, names only; an unseen one is a 404', async () => {
    const { GET } = await import('@/pages/api/admin/crm/companies/[id]');
    rpcAnswers['crm_company_read'] = {
      data: {
        company: ROW,
        contacts: [{ id: CONTACT, display_name: 'Huda', title: null, stage: 'lead', phone: '1' }],
        more: false,
      },
      error: null,
    };
    const res = await GET(ctx(`/api/admin/crm/companies/${COMPANY}`));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await json(res))).not.toMatch(/domain_hmac|phone/);
    rpcAnswers['crm_company_read'] = { data: null, error: { code: 'P0002' } };
    expect((await GET(ctx(`/api/admin/crm/companies/${COMPANY}`))).status).toBe(404);
    expect((await GET(ctx('/api/admin/crm/companies/nope', 'GET', undefined, 'nope'))).status).toBe(
      404,
    );
  });

  it('PATCH carries the version read; a moved one is a 409; the audit names the fields', async () => {
    const { PATCH } = await import('@/pages/api/admin/crm/companies/[id]');
    rpcAnswers['crm_company_update'] = { data: ROW, error: null };
    const res = await PATCH(
      ctx(`/api/admin/crm/companies/${COMPANY}`, 'PATCH', {
        version: 3,
        name: 'Acme Co',
        city: '',
      }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_company: COMPANY,
      p_version: 3,
      p_patch: { name: 'Acme Co', city: null },
    });
    expect(audits[0]).toMatchObject({
      action: 'crm.company.update',
      entityId: COMPANY,
      detail: { fields: ['city', 'name'] },
    });
    rpcAnswers['crm_company_update'] = { data: null, error: { code: '40001' } };
    expect(
      (await PATCH(ctx(`/api/admin/crm/companies/${COMPANY}`, 'PATCH', { version: 2, city: 'x' })))
        .status,
    ).toBe(409);
    expect(
      (await PATCH(ctx(`/api/admin/crm/companies/${COMPANY}`, 'PATCH', { city: 'x' }))).status,
    ).toBe(422);
  });

  it('DELETE carries the version and audits how many contacts it named', async () => {
    const { DELETE } = await import('@/pages/api/admin/crm/companies/[id]');
    rpcAnswers['crm_company_delete'] = { data: { contacts: 2 }, error: null };
    const res = await DELETE(ctx(`/api/admin/crm/companies/${COMPANY}`, 'DELETE', { version: 3 }));
    expect(res.status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_company: COMPANY, p_version: 3 });
    expect(audits).toEqual([
      {
        action: 'crm.company.delete',
        entityType: 'company',
        entityId: COMPANY,
        detail: { contacts: 2 },
      },
    ]);
    rpcAnswers['crm_company_delete'] = { data: null, error: { code: '42501' } };
    expect(
      (await DELETE(ctx(`/api/admin/crm/companies/${COMPANY}`, 'DELETE', { version: 3 }))).status,
    ).toBe(403);
  });
});

describe('POST /api/admin/crm/contacts/[id]/company', () => {
  it('links at the contact’s version, answers the contact as its page reads it, audited', async () => {
    const { POST } = await import('@/pages/api/admin/crm/contacts/[id]/company');
    rpcAnswers['crm_contact_company'] = {
      data: { company_id: COMPANY, how: 'linked' },
      error: null,
    };
    contactRow = {
      id: CONTACT,
      display_name: 'Huda',
      company_name: 'Acme Trading',
      company_id: COMPANY,
      version: 4,
      merged_into: null,
    };
    const res = await POST(
      ctx(
        `/api/admin/crm/contacts/${CONTACT}/company`,
        'POST',
        { action: 'link', version: 3, companyId: COMPANY },
        CONTACT,
      ),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0]).toEqual({
      fn: 'crm_contact_company',
      args: {
        p_tenant: TENANT,
        p_contact: CONTACT,
        p_version: 3,
        p_action: 'link',
        p_company: COMPANY,
      },
    });
    const body = (await json(res))['data'] as { contact: Record<string, unknown>; how: string };
    expect(body.contact).not.toHaveProperty('merged_into');
    expect(body.contact['version']).toBe(4);
    expect(body.how).toBe('linked');
    expect(audits).toEqual([
      {
        action: 'crm.contact.update',
        entityType: 'contact',
        entityId: CONTACT,
        detail: { fields: ['company'], action: 'link', how: 'linked', company: COMPANY },
      },
    ]);
  });

  it('"Create company from this name" sends no company; refusals map to their status', async () => {
    const { POST } = await import('@/pages/api/admin/crm/contacts/[id]/company');
    const url = `/api/admin/crm/contacts/${CONTACT}/company`;
    rpcAnswers['crm_contact_company'] = {
      data: null,
      error: { code: '23514', message: 'x (constraint "crm_contacts_company_named")' },
    };
    const named = await POST(ctx(url, 'POST', { action: 'create', version: 1 }, CONTACT));
    expect(rpcCalls[0]!.args['p_company']).toBeNull();
    expect(named.status).toBe(422);
    expect(JSON.stringify(await json(named))).toMatch(/names no company yet/);
    rpcAnswers['crm_contact_company'] = { data: null, error: { code: '40001' } };
    expect((await POST(ctx(url, 'POST', { action: 'unlink', version: 1 }, CONTACT))).status).toBe(
      409,
    );
    rpcAnswers['crm_contact_company'] = { data: null, error: { code: 'P0002' } };
    expect((await POST(ctx(url, 'POST', { action: 'unlink', version: 1 }, CONTACT))).status).toBe(
      404,
    );
    expect(audits).toEqual([]);
  });
});
