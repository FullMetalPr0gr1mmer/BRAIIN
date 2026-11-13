import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { ContactPatchSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { can } from '@/lib/authz/matrix';
import { updateRow } from '@/lib/admin/crud';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { tenantCountry } from '@/lib/crm/leadQuery';
import { serviceClient } from '@/lib/supabase/server';
import {
  CONTACT_CONSTRAINTS,
  CONTACT_DETAIL_COLUMNS,
  channelPresence,
  contactLeads,
  contactError,
  contactPatchValues,
  getContact,
  parseTimeline,
  requireContactId,
  sealChannels,
} from '@/lib/crm/contacts';
import { customFieldDefinitions, validateCustomValues } from '@/lib/crm/contactCustom';

// One contact (Admin v2 C6, crm.md §9): its page (GET) and a change (PATCH). `crm.contacts`.
//
// GET answers what the contact page needs and nothing it does not: the contact's own
// columns, whether it has an e-mail or a phone (kind, primary, where from; never the value:
// that is the audited reveal), its leads (the safe lead columns lead workers read anyway,
// with how each was linked, so a phone match shows as one to check), the first page of its
// timeline (metadata only) and the custom field definitions (none until C9b). Everything is
// read as the caller: RLS and the live check decide. Audited `crm.contact.view` (queued, as
// `lead.view` is: it reveals nothing gated).
//
// PATCH changes the details (a column grant, as the caller, at the version read: 409 on a
// moved version) or stars (unversioned), or the channels (add, remove, make primary): those
// carry ciphertext no staff token may write, so they are live-rechecked and go through
// public.crm_edit_contact_channels as the service role, checked at the version read. One or
// the other per request, never both, so a refusal never leaves half a save.
//
// Removing an e-mail or phone deletes a person's details (one typed in by hand has no copy on
// any lead), so it is erasure's: `crm.erase` (Admin), checked here before anything is read and
// again by the door (C10b review, C10B-SEC-2). A `crm.contacts` holder alone (Sales) adds and
// makes primary.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.contacts',
  handler: async ({ auth, sb, params, audit }) => {
    const id = requireContactId(params);
    const contact = await getContact(sb, auth, id);
    const [channels, leadPage, timelineResult] = await Promise.all([
      channelPresence(sb, auth, id),
      contactLeads(sb, auth, id),
      sb.rpc('crm_contact_timeline', {
        p_tenant: auth.tenantId,
        p_contact: id,
        p_filter: { limit: 30 },
      }),
    ]);
    if (timelineResult.error) throw contactError(timelineResult.error, 'the contact timeline');

    audit({ action: 'crm.contact.view', entityType: 'contact', entityId: id });
    const { merged_into: _merged, ...own } = contact;
    return {
      contact: own,
      channels,
      leads: leadPage.leads,
      // True when the contact has more leads than the page lists (C6 review, C6-COR-7).
      moreLeads: leadPage.more,
      timeline: parseTimeline(timelineResult.data),
      customFields: customFieldDefinitions(),
    };
  },
});

export const PATCH = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactPatchSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireContactId(params);
    const values = contactPatchValues(input);

    if (input.channels !== undefined) {
      if (Object.keys(values).length > 0) {
        throw new ValidationError(
          'Save the contact details and the e-mails and phones separately.',
          'channels',
        );
      }
      // The schema refuses a channel change without it; this keeps the types honest.
      if (input.version === undefined) {
        throw new ValidationError('send the version you read', 'version');
      }
      if ((input.channels.remove?.length ?? 0) > 0 && can(auth.role, 'crm.erase') !== 'full') {
        throw new AuthorizationError('crm.erase', 'removing an e-mail or phone is erasure');
      }
      await liveRecheck(auth);
      // Seen by the caller first (RLS, the live check): an unseen contact is a 404.
      await getContact(sb, auth, id, 'id');
      const add = await sealChannels(
        LEAD_PII_ENC_KEY,
        auth.tenantId,
        input.channels.add ?? [],
        tenantCountry(sb, auth.tenantId),
      );
      const { data, error } = await serviceClient().rpc('crm_edit_contact_channels', {
        p_tenant: auth.tenantId,
        p_contact: id,
        p_version: input.version,
        p_add: add,
        p_remove: input.channels.remove ?? [],
        p_primary: input.channels.primary ?? [],
        p_actor: auth.userId,
      });
      if (error) throw contactError(error, 'the contact details');
      const answer = (data ?? {}) as { duplicate?: unknown; added?: unknown; removed?: unknown };
      if (typeof answer.duplicate === 'string') {
        throw new ValidationError(
          'That e-mail address belongs to another contact. Open that contact instead.',
          'channels',
        );
      }
      audit({
        action: 'crm.contact.update',
        entityType: 'contact',
        entityId: id,
        detail: {
          fields: ['channels'],
          added: typeof answer.added === 'number' ? answer.added : 0,
          removed: typeof answer.removed === 'number' ? answer.removed : 0,
          primary: input.channels.primary?.length ?? 0,
        },
      });
      return {
        contact: await getContact(sb, auth, id),
        channels: await channelPresence(sb, auth, id),
      };
    }

    if (input.custom !== undefined) validateCustomValues(customFieldDefinitions(), input.custom);
    const detailFields = Object.keys(values).filter((column) => column !== 'is_starred');

    let row: Record<string, unknown>;
    if (detailFields.length > 0) {
      if (input.version === undefined) {
        throw new ValidationError('send the version you read', 'version');
      }
      // updateRow reads any row the caller sees; a merge tombstone (C12) is not a contact,
      // so it is a 404 here as on every other contact path (C6 review, C6-SEC-4).
      await getContact(sb, auth, id, 'id');
      row = await updateRow<Record<string, unknown>>(
        sb,
        'crm_contacts',
        auth,
        id,
        input.version,
        values,
        CONTACT_DETAIL_COLUMNS,
        { constraints: CONTACT_CONSTRAINTS },
      );
    } else {
      // A star alone: unversioned, as it never moves the version.
      const { data, error } = await sb
        .from('crm_contacts')
        .update(values)
        .eq('tenant_id', auth.tenantId)
        .eq('id', id)
        .is('merged_into', null)
        .select(CONTACT_DETAIL_COLUMNS)
        .maybeSingle();
      if (error) throw contactError(error, 'the star');
      if (!data) throw new NotFoundError('contact');
      row = data as unknown as Record<string, unknown>;
    }

    // Field names and the stage, never what a field holds.
    audit({
      action: 'crm.contact.update',
      entityType: 'contact',
      entityId: id,
      detail: {
        fields: Object.keys(values),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
      },
    });
    const { merged_into: _merged, ...own } = row;
    return { contact: own };
  },
});
