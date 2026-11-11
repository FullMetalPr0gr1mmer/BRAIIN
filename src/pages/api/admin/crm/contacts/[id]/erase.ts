import { ContactEraseSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, CRM_ERASE_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { getContact, requireContactId } from '@/lib/crm/contacts';
import { personFiles, removeFileObjects } from '@/lib/crm/files';
import { writeSystemLog } from '@/lib/data/systemLog';

// Erasing a person (Admin v2 C6, crm.md §8.2): `crm.erase`, Admin only (CLAUDE.md §5). It
// cannot be undone, so it runs the lead erasure's order (src/pages/api/admin/leads/[id]/
// erase.ts), each step before the next and any failure stopping everything after it:
//
//   1. assertCap('crm.erase')     the kernel
//   2. live recheck               the profile, now (demotion effective immediately)
//   3. rate limit                 the lead erasure's ledger key and numbers (`crm-erase`: 20
//                                 an hour per person, 50 per tenant), fail-closed: one
//                                 allowance for every erasure
//   4. RLS read                   the caller's own client must see the contact; an unseen
//                                 one is a 404 before anything is written
//   5. attempt audit, WRITTEN     fail-closed: no row, no erase
//   6. the person's files         (Admin v2 C16) their object paths, read as the service role
//                                 (the contact's and its merge tombstones'); a failed read
//                                 stops here, nothing erased. Nothing is removed yet
//   7. public.crm_erase_person    as the service role, in one transaction: the person's
//                                 leads (linked other than by phone, or carrying one of the
//                                 person's e-mail indexes), the phone matches the Admin
//                                 ticked in the preview (each must be one: 422 otherwise,
//                                 nothing erased), then the contact with its channels, notes,
//                                 timeline and file rows (the cascade, tombstones' included).
//                                 The database checks the acting profile live
//   8. the files' objects         (C16 review, C16-SEC-1) only once the database has erased:
//                                 a refusal at step 7 (42501, P0002, 22023) leaves every file
//                                 in place. A removal that fails is logged, and the sweep
//                                 (cron:crm-file-orphans) removes them, as it does after a
//                                 retention purge: no row names them any more
//   9. outcome audit              with the counts, or the failure
//
// The audit rows carry ids, the reason and counts, never the person's name or details, which
// is what is being erased. Backups keep an erased row until they roll over (PITR 28 days);
// the privacy notice says so (register L-2).

export const prerender = false;

const ERASE_COUNTS = [
  'contacts',
  'leads',
  'phone_leads',
  'lead_notes',
  'lead_events',
  'link_lines',
  'channels',
  'notes',
  'events',
  'unindexed',
  // (Admin v2 C8) the follow-ups that went with the person.
  'tasks',
] as const;

/** What crm_erase_person answers: counts only, the named keys only. */
function eraseCounts(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of ERASE_COUNTS) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'number') out[key] = value;
    }
  }
  return out;
}

export const POST = defineAdminRoute({
  cap: 'crm.erase',
  input: ContactEraseSchema,
  handler: async ({ auth, sb, input, params }) => {
    const id = requireContactId(params);
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'crm-erase', CRM_ERASE_LIMITS);
    await getContact(sb, auth, id, 'id');
    const extra = input.extraLeads ?? [];

    const logged = await writeAudit(sb, auth, {
      action: 'crm.erase.attempt',
      entityType: 'contact',
      entityId: id,
      detail: { target: 'contact', reason: input.reason, phone_leads: extra.length },
    });
    if (!logged) throw new AuthorizationError('crm.erase', 'audit unavailable, erase refused');

    // (Admin v2 C16) The person's files: their paths now, their objects only after the database
    // has erased (C16 review, C16-SEC-1: nothing that cannot be undone runs before the door's
    // own checks). Their rows go inside the door, with the contact.
    let paths: string[];
    try {
      paths = (await personFiles(serviceClient(), auth.tenantId, id)).map((f) => f.object_path);
    } catch {
      await writeAudit(sb, auth, {
        action: 'crm.erase.outcome',
        entityType: 'contact',
        entityId: id,
        detail: { target: 'contact', status: 'failed', code: 'files' },
      });
      throw new Error("crm erase: the person's files could not be read");
    }
    const files = paths.length;

    let data: unknown = null;
    let error: { code?: string } | null = null;
    try {
      ({ data, error } = await serviceClient().rpc('crm_erase_person', {
        p_tenant: auth.tenantId,
        p_contact: id,
        p_extra_leads: extra,
        p_actor: auth.userId,
      }));
    } catch {
      // The door could not be reached: the attempt still gets its outcome.
      error = {};
    }
    if (error) {
      await writeAudit(sb, auth, {
        action: 'crm.erase.outcome',
        entityType: 'contact',
        entityId: id,
        detail: { target: 'contact', status: 'failed', code: error.code ?? null },
      });
      // Gone between the read and the erase (retention, a merge, a colleague): as unseen.
      if (error.code === 'P0002') throw new NotFoundError('contact');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.erase', 'the database refused this person');
      }
      if (error.code === '22023') {
        throw new ValidationError(
          "A lead you ticked is no longer one of this person's phone matches. Open the preview again.",
          'extraLeads',
        );
      }
      throw new Error(`crm_erase_person: ${error.code ?? 'no code'}`);
    }

    // The rows are gone with the contact; now their objects. A failure is not the erasure's:
    // nothing names them any more, so the sweep removes them within the hour's grace and ten
    // minutes. Counts only in the log line (a path names a tenant and a contact).
    const objectsRemoved = await removeFileObjects(serviceClient(), paths);
    if (!objectsRemoved) {
      await writeSystemLog({
        level: 'warn',
        source: 'crm.erase',
        message: "person erasure: the files' objects were not removed; the sweep will remove them",
        detail: { files },
      });
    }

    const erased = { ...eraseCounts(data), files };
    await writeAudit(sb, auth, {
      action: 'crm.erase.outcome',
      entityType: 'contact',
      entityId: id,
      detail: {
        target: 'contact',
        status: 'ok',
        reason: input.reason,
        ...erased,
        ...(objectsRemoved ? {} : { file_objects: 'sweep' }),
      },
    });
    return { erased: true, counts: erased };
  },
});
