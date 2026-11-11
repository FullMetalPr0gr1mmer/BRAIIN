import { ContactMergeSchema } from '@schemas/crmMerge';
import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, MANUAL_LEAD_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { getContact } from '@/lib/crm/contacts';
import { mergeError, parseMergeOutcome } from '@/lib/crm/merge';

// Merge one contact into another (Admin v2 C12, crm.md §5.5 and §9): `crm.contacts`. The
// record kept takes the other's leads, e-mails and phones, notes, tasks and timeline; its
// blanks are filled from the other; the other becomes a scrubbed tombstone that the nightly
// run removes. It cannot be undone.
//
// No staff token may move a channel, a note, a lead's link or a timeline line (C5's grants),
// so this is the service role's door, public.crm_merge_contacts, which checks the acting
// profile itself, live, and writes the `crm.contact.merge` audit row inside the merge's own
// transaction (no row, no merge). Before it:
//
//   live recheck → a limit of its own (`crm-merge`, the manual add's numbers: 60 an hour per
//   person, 300 per tenant; a merge is irreversible, so a stolen session cannot fold the
//   tenant's people together faster than anyone could notice) → the caller's own client must
//   see both people (RLS, the live check; a merged record is a 404) → the door.
//
// The answer is counts and the kept record's new version, never a value.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactMergeSchema,
  handler: async ({ auth, sb, input }) => {
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'crm-merge', MANUAL_LEAD_LIMITS);
    await getContact(sb, auth, input.keepId, 'id');
    await getContact(sb, auth, input.dropId, 'id');

    const { data, error } = await serviceClient().rpc('crm_merge_contacts', {
      p_tenant: auth.tenantId,
      p_keep: input.keepId,
      p_keep_version: input.keepVersion,
      p_drop: input.dropId,
      p_drop_version: input.dropVersion,
      p_actor: auth.userId,
    });
    if (error) throw mergeError(error, 'the merge');
    return parseMergeOutcome(data, input.keepId);
  },
});
