import type { APIRoute } from 'astro';
import { z } from 'zod';
import { NOTIFY_LEAD_SECRET, LEAD_PII_ENC_KEY } from 'astro:env/server';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { decryptPII } from '@/lib/crypto/pii';
import { canSeeLeadPii } from '@/lib/admin/leadFields';
import { writeSystemLog } from '@/lib/data/systemLog';
import { timingSafeEqual } from '@/lib/http/csrf';

// Lead-notification receiver (CLAUDE.md §10). Called by the `leads_notify` AFTER INSERT
// trigger via pg_net, over the public `*.workers.dev` hop.
//
// ── What that hop means for the design ───────────────────────────────────────────
// The call travels over the open internet to a URL anyone can discover. Three
// consequences, all of them deliberate:
//
//   1. The request body carries ONLY `lead_id` + `tenant_id`. No name, no email, no
//      message. PII never crosses the hop; this Worker re-reads the row server-side.
//   2. The bearer token is compared in CONSTANT TIME. This endpoint is unauthenticated
//      by URL and unlimited by retry, which is the exact shape a timing attack wants.
//   3. An unsigned POST answers 401 with no body. §9(d) requires a test for precisely
//      this, because "notification endpoint that accepts anything" is how a lead table
//      leaks one row at a time.
//
// Recipients are field-gated through the SAME helper the admin UI uses
// (`canSeeLeadPii`) — §10 asks for one shared field-visibility rule, and the failure
// mode of two rules is that budget and internal notes get emailed to someone the CMS
// itself refuses to show them to.

export const prerender = false;

const PayloadSchema = z.object({
  lead_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

/** Who gets notified, and how much they see. Roles come from §5, never from the body. */
const RECIPIENT_ROLES = ['admin', 'developer'] as const;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Constant-time, and checked BEFORE the body is read — an unauthenticated caller
  // should not be able to make us parse anything.
  if (!presented || !timingSafeEqual(presented, NOTIFY_LEAD_SECRET)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (!supabaseConfigured()) return json({ ok: false, error: 'unavailable' }, 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: 'validation' }, 422);

  const sb = serviceClient();

  // Re-fetch server-side. The trigger told us WHICH lead, not WHAT it says.
  const { data: lead, error } = await sb
    .from('leads')
    .select(
      'id,tenant_id,name,message,service_of_interest,locale,email_enc,phone_enc,budget_enc,timeline_band,created_at',
    )
    .eq('tenant_id', parsed.data.tenant_id)
    .eq('id', parsed.data.lead_id)
    .maybeSingle<Record<string, unknown>>();

  if (error || !lead) return json({ ok: false, error: 'not-found' }, 404);

  const { data: recipients } = await sb
    .from('profiles')
    .select('id,role,display_name')
    .eq('tenant_id', parsed.data.tenant_id)
    .eq('is_active', true)
    .in('role', [...RECIPIENT_ROLES]);

  const sensitiveHolders = (recipients ?? []).filter((r) =>
    canSeeLeadPii((r as { role: 'admin' | 'developer' }).role),
  );

  // Build the two payload shapes once. Everything below the gate is omitted for a
  // recipient without `leads.pii` — the same rule the admin API applies.
  const safe = {
    id: lead['id'],
    name: lead['name'],
    message: lead['message'],
    service: lead['service_of_interest'],
    locale: lead['locale'],
    receivedAt: lead['created_at'],
  };

  let sensitive: Record<string, unknown> | null = null;
  if (sensitiveHolders.length > 0) {
    sensitive = {
      email: await safeDecrypt(lead['email_enc']),
      phone: await safeDecrypt(lead['phone_enc']),
      budget: await safeDecrypt(lead['budget_enc']),
      timeline: lead['timeline_band'],
    };
  }

  // TODO(launch+1): dispatch to the real channel (transactional email / CRM webhook,
  // HMAC-signed per §10). The ledger row below is written either way, so a delivery
  // outage is visible in the admin rather than silent.
  const { error: logError } = await sb.from('notification_log').insert({
    tenant_id: parsed.data.tenant_id,
    lead_id: parsed.data.lead_id,
    channel: 'inbox',
    status: 'queued',
    // Field NAMES and recipient COUNT — never the values. This table is readable by
    // Admin + Developer and is not the place to duplicate the lead's PII.
    detail: {
      recipients: (recipients ?? []).length,
      sensitiveRecipients: sensitiveHolders.length,
      fields: sensitive ? [...Object.keys(safe), ...Object.keys(sensitive)] : Object.keys(safe),
    },
  });

  if (logError) {
    void writeSystemLog({
      level: 'warn',
      source: 'notify-lead',
      message: 'could not write notification_log',
      detail: { leadId: parsed.data.lead_id },
    });
  }

  return json({ ok: true, notified: (recipients ?? []).length }, 200);
};

async function safeDecrypt(ciphertext: unknown): Promise<string | null> {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  try {
    return await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
  } catch {
    return null;
  }
}
