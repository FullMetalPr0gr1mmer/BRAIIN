import { TeamNotesPutSchema } from '@schemas/dashboard';
import { readTeamNotes, saveTeamNotes } from '@/lib/admin/dashboard/teamNotes';
import { defineAdminRoute } from '@/lib/admin/route';

// The team notes (Admin v2 U1, README U1 D4 to D6): one shared note per tenant, for every
// holder of analytics.read (the dashboard's own capability). GET reads it (version 0: never
// saved); PATCH saves it under the version read, through public.save_team_notes() (0060), a
// definer that checks the live role, refuses contact details and control characters again,
// and writes the audit row (the length, never the text) in the same transaction, so this
// route queues none. 409 on a stale version, 422 on a refused text (the schema's sentence on
// the field). PATCH, not PUT: the editor is the field kit's singleton form (useEntitySave),
// which saves a singleton by PATCH.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => readTeamNotes(sb, auth),
});

export const PATCH = defineAdminRoute({
  cap: 'analytics.read',
  input: TeamNotesPutSchema,
  handler: async ({ auth, sb, input }) => saveTeamNotes(sb, auth, input.body, input.version),
});
