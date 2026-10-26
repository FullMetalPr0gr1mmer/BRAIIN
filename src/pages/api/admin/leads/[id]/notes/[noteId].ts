import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';

// Deleting one note from a lead's thread (Admin v2 C3): `crm.erase`, Admin only. Notes are
// otherwise append-only (a correction is a new note); this is for a note that should never
// have been written down, such as someone's ID number. In order:
//
//   live recheck → the caller's own client must see the lead (RLS; a 404 otherwise) → an
//   attempt audit row WRITTEN (fail-closed: no row, no delete) → public.crm_delete_lead_note
//   as the service role (the thread is service-role only, 0034), which checks the acting
//   profile itself, live, through app.role_crm_erase → an outcome audit row.
//
// Two rows, as erase has, because the attempt is written before anyone knows whether the
// note is on that lead: the outcome says what happened (ok, not_found, refused or failed),
// so a 404 never reads as a deletion in the log. Ids and the note's source only, never its
// words. A note the old notes field's mirror wrote (source 'legacy') is deleted like any
// other: the field and its mirror are gone (C14b).

export const prerender = false;

function requireUuid(value: string | undefined, entity: string): string {
  if (!value || !z.string().uuid().safeParse(value).success) throw new NotFoundError(entity);
  return value;
}

interface DoorError {
  code?: string;
}

/** What the outcome row says about a refusal by the door (never its text). */
function outcomeOf(error: DoorError): 'not_found' | 'refused' | 'failed' {
  if (error.code === 'P0002') return 'not_found';
  if (error.code === '42501') return 'refused';
  return 'failed';
}

export const DELETE = defineAdminRoute({
  cap: 'crm.erase',
  handler: async ({ auth, sb, params }) => {
    const id = requireUuid(params['id'], 'lead');
    const noteId = requireUuid(params['noteId'], 'note');
    await liveRecheck(auth);
    await getRow(sb, 'leads', auth, id, 'id');

    const logged = await writeAudit(sb, auth, {
      action: 'lead.note.delete.attempt',
      entityType: 'lead',
      entityId: id,
      detail: { note: noteId },
    });
    if (!logged) throw new AuthorizationError('crm.erase', 'audit unavailable, delete refused');

    let data: unknown = null;
    let error: DoorError | null = null;
    try {
      ({ data, error } = await serviceClient().rpc('crm_delete_lead_note', {
        p_tenant: auth.tenantId,
        p_lead: id,
        p_note: noteId,
        p_actor: auth.userId,
      }));
    } catch {
      // The door could not be reached: the attempt still gets its outcome.
      error = {};
    }

    if (error) {
      await writeAudit(sb, auth, {
        action: 'lead.note.delete.outcome',
        entityType: 'lead',
        entityId: id,
        detail: { note: noteId, status: outcomeOf(error), code: error.code ?? null },
      });
      if (error.code === 'P0002') throw new NotFoundError('note');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.erase', 'the database refused this person');
      }
      throw new Error(`crm_delete_lead_note: ${error.code ?? 'no code'}`);
    }

    const source = typeof data === 'string' ? data : null;
    await writeAudit(sb, auth, {
      action: 'lead.note.delete.outcome',
      entityType: 'lead',
      entityId: id,
      detail: { note: noteId, status: 'ok', source },
    });
    return { deleted: true, source };
  },
});
