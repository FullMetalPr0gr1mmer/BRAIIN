import type { APIRoute } from 'astro';
import { ForgotPasswordSchema } from '@schemas/admin';
import { readAuthBody, seeOther } from '@/lib/auth/body';
import {
  afterResponse,
  authEmailReady,
  checkForgotLimits,
  sendResetEmail,
  writeAuthAudit,
} from '@/lib/auth/recovery';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { clientIp } from '@/lib/http/maintenance';
import { json } from '@/lib/admin/route';

// "Forgot password?" (Admin v2 F7, docs/admin-v2/ui.md AV-06). Reached without a session
// (the middleware's pre-auth paths), behind the same-origin + `__Host-csrf` check like
// sign-in: a cross-site form could otherwise make a staff member's browser send resets.
//
// ── One answer for every address ─────────────────────────────────────────────────
// A known address, an unknown one and one that is not an address at all get the same
// status and the same body (the form: the same page), and in the same time: the call to
// Supabase, which takes longer when it really sends an e-mail, runs after the answer
// (waitUntil). So the endpoint says nothing about which accounts exist. The answers that
// do differ depend on something other than the address: 429 when a limit is reached (per
// IP address, per e-mail as an HMAC, and per tenant for a request the first two let
// through: src/lib/auth/recovery.ts, checkForgotLimits), 503 when
// e-mail is not set up (owner item O-2) or the limiter cannot answer (fail closed).
//
// Audited: one row per accepted request, written by the service role with no actor and
// nothing that names the requester (there is no account to name: the answer must not
// depend on one). The reset itself is audited against the account (reset.ts).

export const prerender = false;

const FORGOT_PAGE = '/admin/forgot';

type Outcome = 'sent' | 'limited' | 'unavailable' | 'not-set-up';

const JSON_ANSWERS: Record<Outcome, [number, Record<string, unknown>]> = {
  sent: [200, { ok: true, data: { accepted: true } }],
  limited: [429, { ok: false, error: 'rate-limited' }],
  unavailable: [503, { ok: false, error: 'unavailable' }],
  'not-set-up': [503, { ok: false, error: 'not-set-up' }],
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await readAuthBody(request);
  if (!body) return json({ ok: false, error: 'bad-request' }, 400);

  const answer = (outcome: Outcome): Response => {
    if (body.kind === 'form') {
      // The page shows "Not set up" by itself, so that outcome needs no code.
      return seeOther(outcome === 'not-set-up' ? FORGOT_PAGE : `${FORGOT_PAGE}?status=${outcome}`);
    }
    const [status, payload] = JSON_ANSWERS[outcome];
    return json(payload, status);
  };

  if (!authEmailReady()) return answer('not-set-up');

  const parsed = ForgotPasswordSchema.safeParse({ email: body.fields['email'] });
  const email = parsed.success ? parsed.data.email : null;

  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) return answer('unavailable');

  const limited = await checkForgotLimits(tenantId, clientIp(request), email);
  if (limited !== 'ok') return answer(limited === 'limited' ? 'limited' : 'unavailable');

  // An address Supabase does not know is sent nothing, by Supabase; one that is not an
  // address is not sent at all. Either way the answer below is the same.
  if (email) afterResponse(locals.cfContext, sendResetEmail(email));

  await writeAuthAudit({
    tenantId,
    actorId: null,
    actorRole: null,
    action: 'auth.password_reset_requested',
    entityType: 'auth',
    entityId: null,
    detail: {},
  });

  return answer('sent');
};
