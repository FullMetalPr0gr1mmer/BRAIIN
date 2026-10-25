import type { APIRoute } from 'astro';
import { z } from 'zod';
import { NOTIFY_LEAD_SECRET, LEAD_PII_ENC_KEY } from 'astro:env/server';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { decryptPII } from '@/lib/crypto/pii';
import { canManageLeads, receivesLeadPiiUnasked } from '@/lib/admin/leadFields';
import { ROLES, isRole } from '@/lib/auth/types';
import { writeSystemLog } from '@/lib/data/systemLog';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { notifySignatureValid, readNotifyHeaders } from '@/lib/leads/notifySignature';

// Lead-notification receiver (CLAUDE.md §10). Called by the `leads_notify` AFTER INSERT
// trigger via pg_net, over the public `*.workers.dev` hop.
//
// ── What that hop means for the design ───────────────────────────────────────────
// The call travels over the open internet to a URL anyone can discover. Three
// consequences, all of them deliberate:
//
//   1. The request body carries ONLY `lead_id` + `tenant_id`. No name, no email, no
//      message. PII never crosses the hop; this Worker re-reads the row server-side.
//   2. The call is SIGNED, not bearer-authenticated (0048, src/lib/leads/notifySignature.ts):
//      a timestamp and an HMAC over '<ts>.<lead_id>.<tenant_id>' under NOTIFY_LEAD_SECRET,
//      recomputed here over the body's ids and compared in CONSTANT TIME. pg_net's queue,
//      where the request waits, is readable by every database login role (EXC-012), so it
//      must never hold the secret itself; a signature there is good for one lead for five
//      minutes. This endpoint is unauthenticated by URL and unlimited by retry, which is
//      the exact shape a timing attack wants.
//   3. An unsigned, stale or mis-signed POST answers 401 and nothing else: a body that
//      cannot be verified is not parsed into an error that describes it. §9(d) requires a
//      test for precisely this, because "notification endpoint that accepts anything" is
//      how a lead table leaks one row at a time.
//   4. Before the signature is checked, the body is all anyone's: the headers only prove
//      a fresh timestamp and a well-formed signature, which anyone can write. So at most
//      MAX_BODY_BYTES of it is ever read. The call must declare its size (pg_net, which is
//      libcurl, always sends Content-Length with a POST body; a chunked body declares none)
//      and declare at most that, and the body is then read through a reader that stops,
//      and cancels the stream, the moment it passes the cap, whatever was declared. Both
//      count bytes, not UTF-16 code units.
//
// Recipients are field-gated through the SAME helper file the admin UI uses
// (src/lib/admin/leadFields.ts) — §10 asks for one shared field-visibility rule, and the
// failure mode of two rules is that budget and internal notes get emailed to someone the
// CMS itself refuses to show them to. Since Admin v2 C10a the gate is
// `receivesLeadPiiUnasked`: `leads.pii` together with `export.csv` (Admin, Developer).
// Sales holds `leads.pii` one lead at a time (owner default O-6), through the audited,
// rate-limited reveal only, so a notification never hands it a lead's details.

export const prerender = false;

// Exactly what the trigger sends: the two ids, nothing else.
const PayloadSchema = z
  .object({
    lead_id: z.string().uuid(),
    tenant_id: z.string().uuid(),
  })
  .strict();

/** The trigger's body is about 90 bytes; anything far larger is not from it. In bytes. */
const MAX_BODY_BYTES = 1024;

/** A Content-Length of one to four digits: anything longer is over the cap anyway. */
const CONTENT_LENGTH = /^[0-9]{1,4}$/;

/**
 * Who gets notified: every role that works leads (`leads.manage` in ROLE_CAPS, §5), never
 * a list of its own (Admin v2 C10a, crm.md D8). How much each sees is decided per role
 * below. Roles come from §5, never from the body.
 */
const RECIPIENT_ROLES: readonly string[] = ROLES.filter(canManageLeads);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

const unauthorized = () => json({ ok: false, error: 'unauthorized' }, 401);

export const POST: APIRoute = async ({ request }) => {
  // The headers first, before the body is read: an unsigned or stale call (outside the
  // 300 s window) makes us parse nothing.
  const signed = readNotifyHeaders(request.headers, Date.now());
  if (!signed) return unauthorized();
  // The size, declared and within the cap, before a byte is read (point 4): no
  // Content-Length (a chunked body) is refused, not taken as zero.
  const declared = request.headers.get('content-length');
  if (declared === null || !CONTENT_LENGTH.test(declared) || Number(declared) > MAX_BODY_BYTES) {
    return unauthorized();
  }

  // The signature covers the body's ids, so the body is read to verify it; until it
  // verifies, every failure is the same 401.
  const bytes = await readCapped(request.body, MAX_BODY_BYTES);
  if (bytes === null) return unauthorized();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return unauthorized();
  }
  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) return unauthorized();
  const verified = await notifySignatureValid(
    NOTIFY_LEAD_SECRET,
    signed.ts,
    signed.signature,
    parsed.data.lead_id,
    parsed.data.tenant_id,
  );
  if (!verified) return unauthorized();

  if (!supabaseConfigured()) return json({ ok: false, error: 'unavailable' }, 503);

  const sb = serviceClient();

  // Re-fetch server-side. The trigger told us WHICH lead, not WHAT it says. Only columns that
  // exist before and after the contract slice (Admin v2 C14a: no legacy band; C14b drops it).
  const { data: lead, error } = await sb
    .from('leads')
    .select(
      'id,tenant_id,name,company,message,service_of_interest,discipline_of_interest,locale,email_enc,phone_enc,budget_enc,timeline_text_enc,created_at',
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

  const sensitiveHolders = (recipients ?? []).filter((r) => {
    const role = (r as { role?: unknown }).role;
    return isRole(role) && receivesLeadPiiUnasked(role);
  });

  // Readable labels for the interest slugs (Round 3): the recipient reads "Videography
  // (now Photography / Videography)", not a slug a cached page posted. EN — the
  // notification channel is staff-facing; the admin shows both languages.
  const labelled = withInterestLabels(
    lead,
    await resolveLeadInterests(sb, parsed.data.tenant_id, [lead]),
  );

  // Build the two payload shapes once. Everything below the gate is omitted for a
  // recipient that may not be handed lead PII unasked (`receivesLeadPiiUnasked`).
  const safe = {
    id: lead['id'],
    name: lead['name'],
    company: lead['company'],
    message: lead['message'],
    service: lead['service_of_interest'],
    serviceLabel: labelled.service_label?.en ?? null,
    // "{Discipline}, help me choose" (0028): the visitor picked a discipline, not a service.
    discipline: lead['discipline_of_interest'],
    disciplineLabel: labelled.discipline_label?.en ?? null,
    locale: lead['locale'],
    receivedAt: lead['created_at'],
  };

  let sensitive: Record<string, unknown> | null = null;
  if (sensitiveHolders.length > 0) {
    sensitive = {
      email: await safeDecrypt(lead['email_enc']),
      phone: await safeDecrypt(lead['phone_enc']),
      budget: await safeDecrypt(lead['budget_enc']),
      // The deadline (0017): the visitor's own words, or a legacy band's, which the daily
      // cron stored there encrypted (0035). Since C14a nothing reads the plaintext band.
      timeline: await safeDecrypt(lead['timeline_text_enc']),
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

/**
 * The body's bytes when there are at most `max` of them, else null (as for a body that
 * cannot be read). Stops reading, and cancels the stream, as soon as the count passes `max`,
 * so a body larger than it declared is never buffered: at most one chunk past the cap is
 * ever held.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const out = new Uint8Array(max);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out.slice(0, size);
      if (value.byteLength > max - size) return null;
      out.set(value, size);
      size += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    // Not awaited: the answer does not wait on the sender.
    void reader.cancel().catch(() => undefined);
  }
}

async function safeDecrypt(ciphertext: unknown): Promise<string | null> {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  try {
    return await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
  } catch {
    return null;
  }
}
