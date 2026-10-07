import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { revealLead } from '@/lib/crm/reveal';

// "Show contact details" for one lead (Admin v2 C2b): `leads.pii` (Admin, Developer). A
// POST, because it has an effect: it spends a rate-limit slot and writes an audit row
// before anything is decrypted (src/lib/crm/reveal.ts has the order and the reasons).
// Returns the contact details only; the CRM already holds the rest of the lead, and the
// notes thread has its own audited endpoint.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'leads.pii',
  handler: async ({ auth, sb, params }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('lead');
    // The legacy select value too, kept until the daily cron has moved it into `timeline`.
    const { plain, decrypted } = await revealLead(auth, sb, id, ['timeline_band']);
    return {
      email: decrypted.email,
      phone: decrypted.phone,
      budget: decrypted.budget,
      timeline: decrypted.timeline,
      timeline_band: plain.timeline_band ?? null,
    };
  },
});
