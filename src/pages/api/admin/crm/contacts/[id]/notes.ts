import { ContactNoteInputSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { getContact, requireContactId } from '@/lib/crm/contacts';

// A contact's notes (Admin v2 C6, crm.md §9): `crm.contacts`. crm_contact_notes has no policy
// (C5): the service role is its only API reader and writer, so this route is the notes' one
// door, audited as the lead thread's is (src/pages/api/admin/leads/[id]/notes.ts).
//
//   GET   live recheck → a slot of the notes' own limit, the reveal's numbers (60 an hour per
//         person, 300 per tenant, fail-closed: a note can quote a phone number or a budget)
//         → the caller's own client must see the contact (RLS, live check) → an audit row
//         WRITTEN (fail-closed: no row, no notes) → the newest 200 notes (ties broken by id),
//         and `more` when there are older ones (C6 review, C6-COR-7)
//   POST  live recheck → the contact must be visible → ONE insert as the service role, its
//         author the session's user (never a client-supplied id). Its `note_added` line and
//         the contact's activity are the database's (C5's trigger), in the same statement.
//
// Notes are append-only: a correction is a new note. Deleting one is `crm.erase`
// (notes/[noteId].ts).

export const prerender = false;

export const NOTES_LIMIT = 200;

export const GET = defineAdminRoute({
  cap: 'crm.contacts',
  handler: async ({ auth, sb, params }) => {
    const id = requireContactId(params);
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'contact-notes-read', PII_REVEAL_LIMITS);
    await getContact(sb, auth, id, 'id');

    const logged = await writeAudit(sb, auth, {
      action: 'crm.contact.view_notes',
      entityType: 'contact',
      entityId: id,
    });
    if (!logged) throw new AuthorizationError('crm.contacts', 'audit unavailable, refused');

    const svc = serviceClient();
    const { data, error } = await svc
      .from('crm_contact_notes')
      .select('id,body,created_by,created_at')
      .eq('tenant_id', auth.tenantId)
      .eq('contact_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(NOTES_LIMIT + 1);
    if (error) throw new Error(`contact notes: ${error.code ?? 'no code'}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    const notes = rows.slice(0, NOTES_LIMIT);

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
        created_at: note['created_at'],
        author:
          typeof note['created_by'] === 'string'
            ? { id: note['created_by'], display_name: names.get(note['created_by']) ?? null }
            : null,
      })),
      more: rows.length > NOTES_LIMIT,
    };
  },
});

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactNoteInputSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireContactId(params);
    await liveRecheck(auth);
    await getContact(sb, auth, id, 'id');

    const { data, error } = await serviceClient()
      .from('crm_contact_notes')
      .insert({
        tenant_id: auth.tenantId,
        contact_id: id,
        body: input.body,
        created_by: auth.userId,
      })
      .select('id,created_at')
      .single();
    if (error || !data) throw new Error(`add contact note: ${error?.code ?? 'no row'}`);
    const note = data as { id: string; created_at: string };

    audit({
      action: 'crm.contact.note_add',
      entityType: 'contact',
      entityId: id,
      detail: { note: note.id },
    });
    return { id: note.id, created_at: note.created_at };
  },
});
