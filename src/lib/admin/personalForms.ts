import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { assertCap } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import {
  DisplayNameSchema,
  NotificationsSeenSchema,
  PasswordChangeSchema,
} from '@schemas/adminPrefs';
import {
  PASSWORD_REFUSALS,
  changeMyPassword,
  endSession,
  updateMyDisplayName,
  type AccountFlash,
} from './account';
import { ValidationError } from './errors';
import { markNotificationsSeen, seenUpTo } from './prefs';

// The forms of the personal layer's no-JS pages (Admin v2 F8): /admin/account (rename,
// password, sign out) and /admin/notifications ("Mark all as read") post to themselves.
// What a post does lives here rather than in the pages' frontmatter, so it is unit-tested
// the way the JSON routes the drawers call are (tests/lib/personalForms.spec.ts), and each
// outcome answers the status its JSON twin answers: a refused name 422, a session that may
// no longer change it 403, a locked account 423, an auth server that cannot answer 502.
// The middleware has checked the origin and the double-submit token before either runs.

/** What a page does with a post: go somewhere else (303), or render with a status. */
export type FormResult<F> =
  { kind: 'redirect'; location: string } | { kind: 'render'; status: number; flash: F };

/**
 * Who may post either page's forms: any active member, as the JSON routes'
 * `analytics.read` gate (every role holds it). A page answers 403 to anyone else, before
 * reading the body.
 */
export function mayPostPersonalForm(session: AuthContext | null): session is AuthContext {
  try {
    assertCap(session, 'analytics.read');
    return true;
  } catch {
    return false;
  }
}

// ── /admin/account ──────────────────────────────────────────────────────────────────

export interface AccountFormContext {
  sb: SupabaseClient;
  session: AuthContext;
  form: FormData;
  cookies: AstroCookies;
  ip: string | null;
}

/** An account post's result; a refused rename also returns what was typed, to show again. */
export type AccountFormResult =
  | FormResult<AccountFlash | null>
  | { kind: 'render'; status: number; flash: AccountFlash; submittedName: string };

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export async function accountFormPost(ctx: AccountFormContext): Promise<AccountFormResult> {
  const { sb, session, form } = ctx;
  const intent = form.get('intent');

  if (intent === 'signout') {
    await endSession(sb, session, ctx.cookies);
    return { kind: 'redirect', location: '/admin/login' };
  }

  if (intent === 'name') {
    const raw = text(form, 'display_name');
    const parsed = DisplayNameSchema.safeParse({ display_name: raw });
    const refuse = (status: number, message: string, typed: string): AccountFormResult => ({
      kind: 'render',
      status,
      flash: { form: 'name', kind: 'error', field: 'display_name', text: message },
      submittedName: typed,
    });
    if (!parsed.success) {
      return refuse(422, parsed.error.issues[0]?.message ?? 'Check your name.', raw.slice(0, 200));
    }
    try {
      // Audited by update_my_profile() itself, in the same transaction (0044).
      await updateMyDisplayName(sb, session, parsed.data.display_name);
      return { kind: 'redirect', location: '/admin/account?saved=name' };
    } catch (err) {
      const typed = parsed.data.display_name;
      if (err instanceof ValidationError) return refuse(422, err.detail, typed);
      if (err instanceof AuthorizationError) {
        return refuse(403, 'Your session can no longer change this. Sign in again.', typed);
      }
      return refuse(500, 'Your name could not be saved just now. Try again.', typed);
    }
  }

  if (intent === 'password') {
    const parsed = PasswordChangeSchema.safeParse({
      current: text(form, 'current'),
      next: text(form, 'next'),
      confirm: text(form, 'confirm'),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'render',
        status: 422,
        flash: {
          form: 'password',
          kind: 'error',
          field: String(issue?.path[0] ?? 'next'),
          text: issue?.message ?? 'Check the passwords.',
        },
      };
    }
    const outcome = await changeMyPassword(sb, session, parsed.data, ctx.ip);
    if (outcome.ok) {
      return {
        kind: 'redirect',
        location: `/admin/account?saved=${outcome.othersSignedOut ? 'password' : 'password-here'}`,
      };
    }
    const refusal = PASSWORD_REFUSALS[outcome.reason];
    return {
      kind: 'render',
      // As POST /api/admin/me/password answers the same outcomes.
      status: outcome.reason === 'locked' ? 423 : outcome.reason === 'failed' ? 502 : 422,
      flash: { form: 'password', kind: 'error', field: refusal.field, text: refusal.message },
    };
  }

  // Not a form this page renders.
  return { kind: 'render', status: 400, flash: null };
}

/** The note a redirect after a saved form shows (`?saved=`), or none. */
export function savedAccountFlash(saved: string | null): AccountFlash | null {
  if (saved === 'name') return { form: 'name', kind: 'ok', text: 'Your name is saved.' };
  if (saved === 'password') {
    return {
      form: 'password',
      kind: 'ok',
      text: 'Your password is changed. You are signed out on your other devices.',
    };
  }
  if (saved === 'password-here') {
    return {
      form: 'password',
      kind: 'ok',
      text: 'Your password is changed. Sign out on your other devices yourself: they could not be signed out just now.',
    };
  }
  return null;
}

// ── /admin/notifications ──────────────────────────────────────────────────────────────

export interface NotificationsFormContext {
  sb: SupabaseClient;
  session: AuthContext;
  form: FormData;
}

/**
 * "Mark all as read" from the no-JS page: up to `as_of`, the moment the list the form was
 * rendered with was read (the feed's `asOf`), never the time of the click. A form without
 * one is not this page's (400); a watermark that cannot be saved is a 503.
 */
export async function notificationsFormPost(
  ctx: NotificationsFormContext,
): Promise<FormResult<'malformed' | 'unavailable'>> {
  const seen = NotificationsSeenSchema.safeParse({ asOf: ctx.form.get('as_of') });
  if (ctx.form.get('intent') !== 'seen' || !seen.success) {
    return { kind: 'render', status: 400, flash: 'malformed' };
  }
  try {
    await markNotificationsSeen(ctx.sb, ctx.session, seenUpTo(seen.data.asOf));
    return { kind: 'redirect', location: '/admin/notifications?done=seen' };
  } catch {
    return { kind: 'render', status: 503, flash: 'unavailable' };
  }
}
