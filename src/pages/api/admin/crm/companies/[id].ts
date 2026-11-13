import { CompanyDeleteSchema, CompanyPatchSchema } from '@schemas/crmCompanies';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import {
  changedCompanyFields,
  companyBody,
  companyError,
  parseCompanyRead,
  pickCompany,
  requireCompanyId,
} from '@/lib/crm/companies';

// One company (Admin v2 C11, crm.md §9): the company and its contacts (GET), a change (PATCH)
// and its removal (DELETE). `crm.contacts`. Immediate (P-3). All three run as the caller
// through SECURITY INVOKER functions, so RLS and the live check decide; an unseen company is a
// 404 (another tenant's, a stale token's, none).
//
// GET: the drawer's read, and its read again after a 409. The contacts are named only (name,
// title, stage), as the People list shows them. Not audited: it reveals nothing gated.
// PATCH: explicit Save at the version read (a 409 when it moved: "Someone else changed this.
// Refreshed."). A rename reaches the linked contacts' company name in the database.
// DELETE: at the version read; its contacts stay, keeping the name as free text.
// Both writes are audited (`crm.company.update` with the field names, `crm.company.delete`
// with how many contacts it named), never with what a field holds.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.contacts',
  handler: async ({ auth, sb, params }) => {
    const id = requireCompanyId(params);
    const { data, error } = await sb.rpc('crm_company_read', {
      p_tenant: auth.tenantId,
      p_company: id,
    });
    if (error) throw companyError(error, 'the company');
    const read = parseCompanyRead(data);
    if (!read.company) throw new NotFoundError('company');
    return read;
  },
});

export const PATCH = defineAdminRoute({
  cap: 'crm.contacts',
  input: CompanyPatchSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireCompanyId(params);
    const { data, error } = await sb.rpc('crm_company_update', {
      p_tenant: auth.tenantId,
      p_company: id,
      p_version: input.version,
      p_patch: companyBody(input),
    });
    if (error) throw companyError(error, 'the company');
    const company = pickCompany(data);
    if (!company) throw new NotFoundError('company');
    audit({
      action: 'crm.company.update',
      entityType: 'company',
      entityId: id,
      detail: { fields: changedCompanyFields(input) },
    });
    return company;
  },
});

export const DELETE = defineAdminRoute({
  cap: 'crm.contacts',
  input: CompanyDeleteSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireCompanyId(params);
    const { data, error } = await sb.rpc('crm_company_delete', {
      p_tenant: auth.tenantId,
      p_company: id,
      p_version: input.version,
    });
    if (error) throw companyError(error, 'the company');
    const was = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const contacts = typeof was['contacts'] === 'number' ? was['contacts'] : 0;
    audit({
      action: 'crm.company.delete',
      entityType: 'company',
      entityId: id,
      detail: { contacts },
    });
    return { id, contacts };
  },
});
