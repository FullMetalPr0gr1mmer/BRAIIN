import { DUPLICATE_PAIR_LIMIT } from '@schemas/crmMerge';
import { defineAdminRoute } from '@/lib/admin/route';
import { mergeError, parseDuplicatePairs } from '@/lib/crm/merge';

// The likely duplicates (Admin v2 C12, crm.md §9): `crm.contacts`. Pairs of people the
// database found by the same phone (its blind index) or the same name at the same company,
// at most 50, never a pair someone said is not one, never a merged record.
//
// As the caller (public.crm_duplicate_pairs, INVOKER): RLS, the live check and the column
// grants decide what is seen of each person; the blind indexes are compared inside a narrow
// definer that answers nothing unless the caller's live role holds crm.contacts. The answer is
// cut to named fields (src/lib/crm/merge.ts): who the two people are and counts, never an
// e-mail, a phone, an index or a note. A list, as the People list, so it is not audited; the
// merge and "Not a duplicate" are.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.contacts',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb.rpc('crm_duplicate_pairs', {
      p_tenant: auth.tenantId,
      p_limit: DUPLICATE_PAIR_LIMIT,
    });
    if (error) throw mergeError(error, 'the duplicates');
    return { pairs: parseDuplicatePairs(data) };
  },
});
