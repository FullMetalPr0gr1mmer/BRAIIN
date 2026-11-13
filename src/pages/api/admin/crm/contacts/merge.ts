import { ContactMergeSchema } from '@schemas/crmMerge';
import { defineAdminRoute } from '@/lib/admin/route';
import { AuthorizationError } from '@/lib/authz/errors';
import { can } from '@/lib/authz/matrix';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, MANUAL_LEAD_LIMITS, PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';
import { receivesLeadPiiUnasked } from '@/lib/admin/leadFields';
import { serviceClient } from '@/lib/supabase/server';
import { getContact } from '@/lib/crm/contacts';
import { CONTACT_REVEAL_OP } from '@/lib/crm/contactReveal';
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
//   live recheck → for a role without crm.files (Sales), whether either record holds a file
//   (below) → a reveal slot, for a role that may not take every lead's details at once
//   (below) → a limit of its own (`crm-merge`, the manual add's numbers: 60 an hour per
//   person, 300 per tenant; a merge is irreversible, so a stolen session cannot fold the
//   tenant's people together faster than anyone could notice) → the caller's own client must
//   see both people (RLS, the live check; a merged record is a 404) → the door.
//
// The reveal slot (C12 review, C12-SEC-R2-1): a merge moves the other record's e-mails and
// phones onto the one kept, and one reveal of it then decrypts both people's. So a role that
// sees details one person at a time (Sales once C10b gives it crm.contacts: `leads.pii`
// without `export.csv`) spends one slot of the reveal's own limiter here (`pii-reveal`,
// fail-closed, before anything is read), as C10b's link confirm does: every value a Sales
// reveal shows has cost it a slot. Admin may take every lead's details at once anyway
// (`receivesLeadPiiUnasked`), so its merge spends none.
//
// Files (the owner's decision of 2026-11-13): a merge where either record holds a file needs an
// Admin (crm.files). For any other role the route counts the two records' files as the service
// role (Sales reads no file row) BEFORE the reveal slot, the merge limit or any read of the two
// people, so a refusal spends nothing and moves nothing: a 403 naming crm.files, which the
// Merge dialog words as "ask an Admin". The door refuses it again with both rows locked (0141).
// The refusal tells a Sales user that the person has files: accepted by the owner. A count
// that fails refuses too (fail-closed).
//
// The answer is counts and the kept record's new version, never a value.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactMergeSchema,
  handler: async ({ auth, sb, input }) => {
    await liveRecheck(auth);
    if (can(auth.role, 'crm.files') !== 'full') {
      const { count, error: filesError } = await serviceClient()
        .from('crm_contact_files')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', auth.tenantId)
        .in('contact_id', [input.keepId, input.dropId]);
      if (filesError) throw new Error(`the merge's file check: ${filesError.code ?? 'no code'}`);
      if (count === null || count > 0) {
        throw new AuthorizationError(
          'crm.files',
          'a merge of records holding files needs an Admin',
        );
      }
    }
    if (!receivesLeadPiiUnasked(auth.role)) {
      await claimPrivilegedOp(auth, CONTACT_REVEAL_OP, PII_REVEAL_LIMITS);
    }
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
