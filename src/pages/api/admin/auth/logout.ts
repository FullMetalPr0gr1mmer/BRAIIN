import type { APIRoute } from 'astro';
import { clearSessionCookies } from '@/lib/auth/session';
import { writeAudit } from '@/lib/admin/audit';
import { json } from '@/lib/admin/route';

// Sign-out. Deliberately NOT built on defineAdminRoute: that kernel is organised around
// "prove you hold capability X", and logging out requires no capability — only a
// session, which the middleware has already verified.
//
// The order below matters. `signOut()` revokes the refresh token server-side FIRST, so
// that a failure at any later step still leaves the session dead rather than leaving a
// user who saw "logged out" holding a token that still works.

export const prerender = false;

export const POST: APIRoute = async ({ locals, cookies }) => {
  const supabase = locals.supabase;
  const auth = locals.session;
  if (!supabase) return json({ ok: false, error: 'server' }, 500);

  if (auth) {
    await writeAudit(supabase, auth, {
      action: 'auth.logout',
      entityType: 'profile',
      entityId: auth.userId,
    });
  }

  try {
    await supabase.auth.signOut();
  } catch {
    // Network failure to GoTrue must not strand the browser holding a cookie: clearing
    // it below is the part the user can observe, so it happens either way.
  }
  clearSessionCookies(cookies);

  return json({ ok: true, data: { loggedOut: true } });
};
