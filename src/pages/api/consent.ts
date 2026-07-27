import type { APIRoute } from 'astro';
import { ConsentRecordSchema } from '@schemas/analytics';
import { isSameOrigin } from '@/lib/http/csrf';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';

// PDPL consent ledger (CLAUDE.md §7 / §4.12). Records that consent was granted or
// withdrawn, for which categories, against which policy version.
//
// ── Why the subject is a KEYED HASH and not an id ────────────────────────────────
// The ledger has to answer "can you demonstrate this person consented" — an
// accountability obligation — WITHOUT itself becoming a new store of personal data to
// secure, honour DSARs against, and purge. So what is stored is an HMAC of the consent
// cookie's own random id, keyed with a server-side secret.
//
// That gives the properties we actually need and none we do not:
//   • the same browser hashes to the same value, so grant→withdraw is a coherent trail
//   • the hash cannot be reversed to the cookie id, and the cookie id was never an
//     identity in the first place
//   • an attacker with the whole table and no key cannot correlate it to anything
//
// The cookie itself is set client-side by the banner; this endpoint only witnesses it.

export const prerender = false;

const NO_STORE = { 'cache-control': 'private, no-store' } as const;

/** HMAC-SHA256 of the subject id, hex. Key never leaves the Worker. */
async function hashSubject(subject: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(subject));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return new Response('bad origin', { status: 403, headers: NO_STORE });
  }
  if (!supabaseConfigured()) return new Response(null, { status: 204, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400, headers: NO_STORE });
  }

  const parsed = ConsentRecordSchema.safeParse(body);
  if (!parsed.success) return new Response('invalid', { status: 422, headers: NO_STORE });

  // The subject is the consent cookie's own value — already in the request, never sent
  // in the body, so a caller cannot choose whose consent they are recording.
  const raw = cookies.get('__Host-consent')?.value ?? '';
  if (!raw) return new Response(null, { status: 204, headers: NO_STORE });

  try {
    const { LEAD_PII_ENC_KEY } = await import('astro:env/server');
    const subjectHash = await hashSubject(raw, LEAD_PII_ENC_KEY);

    // security-definer RPC: consent_log has no INSERT policy at all, so there is
    // exactly one write path and no session can append to the ledger directly.
    await serviceClient().rpc('record_consent', {
      p_subject_hash: subjectHash,
      p_categories: parsed.data.categories,
      p_policy_version: parsed.data.policyVersion,
      p_action: parsed.data.action,
    });
  } catch {
    // A ledger write must not break the banner. The cookie is already set client-side;
    // the visitor's choice is honoured either way.
  }

  return new Response(null, { status: 204, headers: NO_STORE });
};
