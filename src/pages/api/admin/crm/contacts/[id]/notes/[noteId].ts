import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';
import { getContact, requireContactId } from '@/lib/crm/contacts';

// Deleting one note from a contact (Admin v2 C6): `crm.erase`, Admin only. Notes are otherwise
// append-only; this is for a note that should never have been written down. The lead note's
// order (src/pages/api/admin/leads/[id]/notes/[noteId].ts):
//
//   live recheck → the caller's own client must see the contact (RLS; a 404 otherwise) → an
//   attempt audit row WRITTEN (fail-closed: no row, no delete) → public.crm_delete_contact_note
//   as the service role, which checks the acting profile itself, live (app.crm_eraser_ok),
//   and writes the timeline's `note_deleted` (the id only) → an outcome audit row.
//
// Ids only, never the note's words.

export const prerender = false;

interface DoorError {
  code?: string;
}

function outcomeOf(error: DoorError): 'not_found' | 'refused' | 'failed' {
  if (error.code === 'P0002') return 'not_found';
  if (error.code === '42501') return 'refused';
  return 'failed';
}

export const DELETE = defineAdminRoute({
  cap: 'crm.erase',
  handler: async ({ auth, sb, params }) => {
    const id = requireContactId(params);
    const noteId = params['noteId'];
    if (!noteId || !z.string().uuid().safeParse(noteId).success) throw new NotFoundError('note');
    await liveRecheck(auth);
    await getContact(sb, auth, id, 'id');

    const logged = await writeAudit(sb, auth, {
      action: 'crm.contact.note.delete.attempt',
      entityType: 'contact',
      entityId: id,
      detail: { note: noteId },
    });
    if (!logged) throw new AuthorizationError('crm.erase', 'audit unavailable, delete refused');

    let error: DoorError | null = null;
    try {
      ({ error } = await serviceClient().rpc('crm_delete_contact_note', {
        p_tenant: auth.tenantId,
        p_contact: id,
        p_note: noteId,
        p_actor: auth.userId,
      }));
    } catch {
      // The door could not be reached: the attempt still gets its outcome.
      error = {};
    }

    if (error) {
      await writeAudit(sb, auth, {
        action: 'crm.contact.note.delete.outcome',
        entityType: 'contact',
        entityId: id,
        detail: { note: noteId, status: outcomeOf(error), code: error.code ?? null },
      });
      if (error.code === 'P0002') throw new NotFoundError('note');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.erase', 'the database refused this person');
      }
      throw new Error(`crm_delete_contact_note: ${error.code ?? 'no code'}`);
    }

    await writeAudit(sb, auth, {
      action: 'crm.contact.note.delete.outcome',
      entityType: 'contact',
      entityId: id,
      detail: { note: noteId, status: 'ok' },
    });
    return { deleted: true };
  },
});
