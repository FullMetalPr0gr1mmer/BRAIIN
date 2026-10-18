import { z } from 'zod';
import { SCORE_SIGNALS, type ScoreSignal } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { revealLead } from '@/lib/crm/reveal';

// "Show contact details" for one lead (Admin v2 C2b): `leads.pii` (Admin, Developer). A
// POST, because it has an effect: it spends a rate-limit slot and writes an audit row
// before anything is decrypted (src/lib/crm/reveal.ts has the order and the reasons).
// Returns the contact details and, since C4a, the score's reasons (decision D7: three of
// them disclose the budget band and the timeline, so they leave only here, and the audit
// row names `score_signals`). The CRM already holds the rest of the lead, and the notes
// thread has its own audited endpoint.

export const prerender = false;

/** The stored reasons, known keys only, in the order the scoring lists them. */
function scoreReasons(stored: unknown): ScoreSignal[] {
  const given = new Set(Array.isArray(stored) ? stored.filter((s) => typeof s === 'string') : []);
  return SCORE_SIGNALS.filter((signal) => given.has(signal));
}

export const POST = defineAdminRoute({
  cap: 'leads.pii',
  handler: async ({ auth, sb, params }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('lead');
    // The legacy select value too, kept until the daily cron has moved it into `timeline`.
    const { plain, decrypted } = await revealLead(auth, sb, id, ['timeline_band', 'score_signals']);
    return {
      email: decrypted.email,
      phone: decrypted.phone,
      budget: decrypted.budget,
      timeline: decrypted.timeline,
      timeline_band: plain.timeline_band ?? null,
      score_reasons: scoreReasons(plain.score_signals),
    };
  },
});
