import { z } from 'zod';
import { LeadNoteInputSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';

// A lead's notes thread (Admin v2 C2b): `leads.pii` (Admin, Developer), the capability the
// old internal_notes column carried. lead_notes is reachable by the service role only
// (0034), so this route is the thread's only door, and it is audited:
//
//   GET   live recheck → the caller's own client must see the lead (RLS, live check) → an
//         audit row WRITTEN (fail-closed: no row, no notes) → the thread, newest first
//   POST  live recheck → the lead must be visible → the note, as the service role, its
//         author the session's user (never a client-supplied id) → its timeline event
//
// Notes are append-only: a correction is a new note.

export const prerender = false;

const THREAD_LIMIT = 200;

function requireId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('lead');
  return id;
}

export const GET = defineAdminRoute({
  cap: 'leads.pii',
  handler: async ({ auth, sb, params }) => {
    const id = requireId(params);
    await liveRecheck(auth);
    await getRow(sb, 'leads', auth, id, 'id');

    const logged = await writeAudit(sb, auth, {
      action: 'lead.view_notes',
      entityType: 'lead',
      entityId: id,
    });
    if (!logged) throw new AuthorizationError('leads.pii', 'audit unavailable — refused');

    const svc = serviceClient();
    const { data, error } = await svc
      .from('lead_notes')
      .select('id,body,source,created_by,created_at')
      .eq('tenant_id', auth.tenantId)
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(THREAD_LIMIT);
    if (error) throw new Error(`lead notes: ${error.message}`);
    const notes = (data ?? []) as Record<string, unknown>[];

    // Authors by name (this tenant's profiles only); a removed author shows as unknown.
    const authorIds = [
      ...new Set(
        notes.map((n) => n['created_by']).filter((v): v is string => typeof v === 'string'),
      ),
    ];
    const names = new Map<string, string | null>();
    if (authorIds.length > 0) {
      const { data: people } = await svc
        .from('profiles')
        .select('id,display_name')
        .eq('tenant_id', auth.tenantId)
        .in('id', authorIds);
      for (const person of (people ?? []) as { id: string; display_name: string | null }[]) {
        names.set(person.id, person.display_name);
      }
    }
    return {
      notes: notes.map((note) => ({
        id: note['id'],
        body: note['body'],
        source: note['source'],
        created_at: note['created_at'],
        author:
          typeof note['created_by'] === 'string'
            ? { id: note['created_by'], display_name: names.get(note['created_by']) ?? null }
            : null,
      })),
    };
  },
});

export const POST = defineAdminRoute({
  cap: 'leads.pii',
  input: LeadNoteInputSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireId(params);
    await liveRecheck(auth);
    await getRow(sb, 'leads', auth, id, 'id');

    const svc = serviceClient();
    const { data, error } = await svc
      .from('lead_notes')
      .insert({
        tenant_id: auth.tenantId,
        lead_id: id,
        body: input.body,
        source: 'staff',
        created_by: auth.userId,
      })
      .select('id,created_at')
      .single();
    if (error || !data) throw new Error(`add lead note: ${error?.message ?? 'no row'}`);
    const note = data as { id: string; created_at: string };

    const { error: eventError } = await svc.from('lead_events').insert({
      tenant_id: auth.tenantId,
      lead_id: id,
      actor_id: auth.userId,
      kind: 'note_added',
      detail: { note_id: note.id },
    });
    if (eventError) throw new Error(`lead note event: ${eventError.message}`);

    audit({ action: 'lead.note_add', entityType: 'lead', entityId: id, detail: { note: note.id } });
    return { id: note.id, created_at: note.created_at };
  },
});
