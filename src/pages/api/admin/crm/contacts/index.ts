import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { ContactCreateSchema } from '@schemas/crm';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, MANUAL_LEAD_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { tenantCountry } from '@/lib/crm/leadQuery';
import { contactError, sealChannels } from '@/lib/crm/contacts';
import { customFieldDefinitions, validateCustomValues } from '@/lib/crm/contactCustom';

// Adding a contact by hand (Admin v2 C6, crm.md §9): `crm.contacts`, then a live recheck,
// because the contact is written as the service role (no staff token inserts contacts or
// writes a channel's ciphertext, C5), then the manual-lead numbers as a limit of its own
// (60 an hour per person, 300 per tenant, fail-closed), claimed before any lookup: each add
// writes a person's contact details and tells the caller whether an e-mail is already
// someone's. The e-mails and phones are encrypted and blind-indexed here and never reach the
// database as typed. public.crm_create_contact checks the acting profile itself, live. An
// e-mail another contact holds writes nothing and answers 409 with that contact's id
// (crm.md §9), audited with the id only.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactCreateSchema,
  handler: async ({ auth, sb, input, audit }) => {
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'crm-contact-add', MANUAL_LEAD_LIMITS);
    const custom = validateCustomValues(customFieldDefinitions(), input.custom ?? {});
    const channels = await sealChannels(
      LEAD_PII_ENC_KEY,
      auth.tenantId,
      input.channels ?? [],
      tenantCountry(sb, auth.tenantId),
    );

    const source = input.source ?? 'manual';
    const contact: Record<string, unknown> = {
      display_name: input.displayName,
      title: input.title ?? null,
      company_name: input.companyName ?? null,
      stage: input.stage ?? 'lead',
      source,
      owner_id: input.ownerId ?? null,
      locale: input.locale ?? 'en',
      city: input.city ?? null,
      country: input.country ?? null,
      tags: input.tags ?? [],
      custom,
      channels,
    };
    const { data, error } = await serviceClient().rpc('crm_create_contact', {
      p_tenant: auth.tenantId,
      p_contact: contact,
      p_actor: auth.userId,
    });
    if (error) throw contactError(error, 'the new contact');
    const answer = (data ?? {}) as { id?: unknown; duplicate?: unknown };

    if (typeof answer.duplicate === 'string') {
      audit({
        action: 'crm.contact.create.duplicate',
        entityType: 'contact',
        entityId: answer.duplicate,
        detail: { matches: [answer.duplicate] },
      });
      return json({ ok: false, error: 'duplicate', contactId: answer.duplicate }, 409);
    }
    if (typeof answer.id !== 'string') throw new Error('crm_create_contact: no id');
    // Kinds and counts; never the person's details.
    audit({
      action: 'crm.contact.create',
      entityType: 'contact',
      entityId: answer.id,
      detail: {
        source,
        emails: channels.filter((c) => c.kind === 'email').length,
        phones: channels.filter((c) => c.kind === 'phone').length,
      },
    });
    return { id: answer.id };
  },
});
