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
//   audit row WRITTEN (fail-closed: no row, no delete) → public.crm_delete_lead_note as
//   the service role (the thread is service-role only, 0034), which checks the acting
//   profile itself, live, through app.role_crm_erase.
//
// The legacy mirror of the old internal_notes field (the expand window) is deleted by
// clearing that field, so its words cannot come back with the next legacy save.

export const prerender = false;

function requireUuid(value: string | undefined, entity: string): string {
  if (!value || !z.string().uuid().safeParse(value).success) throw new NotFoundError(entity);
  return value;
}

export const DELETE = defineAdminRoute({
  cap: 'crm.erase',
  handler: async ({ auth, sb, params }) => {
    const id = requireUuid(params['id'], 'lead');
    const noteId = requireUuid(params['noteId'], 'note');
    await liveRecheck(auth);
    await getRow(sb, 'leads', auth, id, 'id');

    const logged = await writeAudit(sb, auth, {
      action: 'lead.note.delete',
      entityType: 'lead',
      entityId: id,
      detail: { note: noteId },
    });
    if (!logged) throw new AuthorizationError('crm.erase', 'audit unavailable, delete refused');

    const { data, error } = await serviceClient().rpc('crm_delete_lead_note', {
      p_tenant: auth.tenantId,
      p_lead: id,
      p_note: noteId,
      p_actor: auth.userId,
    });
    if (error) {
      if (error.code === 'P0002') throw new NotFoundError('note');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.erase', 'the database refused this person');
      }
      throw new Error(`crm_delete_lead_note: ${error.code ?? 'no code'}`);
    }
    return { deleted: true, source: typeof data === 'string' ? data : null };
  },
});
