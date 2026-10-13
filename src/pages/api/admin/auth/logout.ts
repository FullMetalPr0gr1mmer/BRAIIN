import type { APIRoute } from 'astro';
import { endSession } from '@/lib/admin/account';
import { json } from '@/lib/admin/route';

// Sign-out. Deliberately NOT built on defineAdminRoute: that kernel is organised around
// "prove you hold capability X", and logging out requires no capability — only a
// session, which the middleware has already verified.
//
// The order matters, and lives in endSession() (src/lib/admin/account.ts), shared with the
// account page's no-JS form: the audit row, then `signOut()` revokes the refresh token
// server-side, so a failure at any later step still leaves the session dead rather than
// leaving a user who saw "logged out" holding a token that still works; the cookie is
// cleared either way.

export const prerender = false;

export const POST: APIRoute = async ({ locals, cookies }) => {
  const supabase = locals.supabase;
  if (!supabase) return json({ ok: false, error: 'server' }, 500);
  await endSession(supabase, locals.session, cookies);
  return json({ ok: true, data: { loggedOut: true } });
};
