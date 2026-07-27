import type { APIContext, APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AuthContext } from '@/lib/auth/types';
import { assertAnyCap, assertCap, type Access, type Capability } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { NotFoundError, OptimisticLockError, RateLimitError, ValidationError } from './errors';
import { writeAudit, type AuditEntry } from './audit';
import { writeSystemLog } from '@/lib/data/systemLog';

// The kernel every /api/admin/** endpoint goes through.
//
// It exists so that the six things that must happen on EVERY admin mutation cannot be
// forgotten one endpoint at a time:
//
//   1. a verified session (middleware already denied anonymous callers)
//   2. assertCap() — the SECONDARY authz layer; RLS is the primary one and runs
//      independently inside Postgres against the same request's JWT
//   3. Zod validation of the body/query — the single input boundary (CLAUDE.md §8)
//   4. `no-store` on the response
//   5. uniform error mapping, so a 403 is never accidentally rendered as a 500 (or,
//      worse, a 200 with an empty list that looks like "you have no services")
//   6. an audit row for anything that changes state
//
// Endpoints written by hand would each get five of the six right, and it would be a
// different five each time.

export interface AdminRouteContext<TInput> {
  /** The verified caller. Non-null by construction — assertCap() narrowed it. */
  readonly auth: AuthContext;
  /** RLS-bound client (anon key + caller's JWT). Use this for all tenant data. */
  readonly sb: SupabaseClient;
  /** Zod-parsed input. `undefined` when the route declares no schema. */
  readonly input: TInput;
  readonly request: Request;
  readonly url: URL;
  readonly params: Record<string, string | undefined>;
  /** Queue an audit row; written after the handler returns successfully. */
  audit(entry: AuditEntry): void;
}

export interface AdminRouteOptions<TSchema extends z.ZodTypeAny | undefined> {
  /** Capability checked by the secondary layer. */
  cap: Capability;
  /**
   * Alternative capabilities, ANY of which satisfies the check. When present this
   * REPLACES `cap` in the gate (`cap` stays for the audit/log label).
   *
   * Reading a content list is why this exists. Listing services is reachable two ways
   * in §5 — `services.write` and `seo.entityMeta` — and an earlier version of this
   * kernel checked only the first, then let the handler widen the check afterwards.
   * That ordering meant SEO was refused 403 by the kernel before the widening ever
   * ran: a capability the matrix grants, denied by the layer that enforces it. The
   * lesson generalises — a gate that runs before the full policy is known is not a
   * gate, it is a race with the policy.
   */
  anyCap?: readonly Capability[];
  /** Access levels that satisfy it. Defaults to ['full']. */
  access?: readonly Access[];
  /** Input schema. Applied to the JSON body for mutations, to query params for GET. */
  input?: TSchema;
  handler: (
    ctx: AdminRouteContext<TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined>,
  ) => Promise<unknown>;
}

const NO_STORE = 'private, no-store, max-age=0, must-revalidate';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': NO_STORE },
  });
}

/** Query params → a plain object so one Zod schema can serve GET and POST alike. */
function queryToObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

/**
 * Maps a thrown error to its status + client-safe body.
 *
 * The message of an unexpected error is deliberately NOT echoed: Postgres error text
 * routinely contains column names, constraint names and sometimes row values, and this
 * is an authenticated-but-not-necessarily-trusted surface (an SEO user probing a leads
 * endpoint is exactly the case). The detail goes to system_logs instead, where the
 * Developer role can read it.
 */
function mapError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof AuthorizationError) {
    return { status: 403, body: { ok: false, error: 'forbidden', capability: err.capability } };
  }
  if (err instanceof OptimisticLockError) {
    return { status: 409, body: { ok: false, error: 'conflict', entity: err.entity } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { ok: false, error: 'not-found', entity: err.entity } };
  }
  if (err instanceof ValidationError) {
    return {
      status: 422,
      body: { ok: false, error: 'validation', detail: err.detail, field: err.field },
    };
  }
  if (err instanceof RateLimitError) {
    return { status: 429, body: { ok: false, error: 'rate-limit', scope: err.scope } };
  }
  if (err instanceof z.ZodError) {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'validation',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  return { status: 500, body: { ok: false, error: 'server' } };
}

export function defineAdminRoute<TSchema extends z.ZodTypeAny | undefined = undefined>(
  opts: AdminRouteOptions<TSchema>,
): APIRoute {
  return async (context: APIContext): Promise<Response> => {
    const { locals, request, url, params } = context;
    const auth = locals.session;
    const sb = locals.supabase;

    // Belt-and-braces: middleware guarantees both on /api/admin/**, but an endpoint
    // that got mounted on the wrong path should fail closed rather than crash with a
    // TypeError that a reader would have to guess the meaning of.
    if (!sb) return json({ ok: false, error: 'unauthenticated' }, 401);

    const pending: AuditEntry[] = [];

    try {
      // Layer 2. Throws AuthorizationError → 403 for anon, inactive, or under-privileged
      // callers, and narrows `auth` to AuthContext for the handler.
      if (opts.anyCap && opts.anyCap.length > 0) {
        assertAnyCap(auth, opts.anyCap, opts.access ?? ['full']);
      } else {
        assertCap(auth, opts.cap, opts.access ?? ['full']);
      }

      let input: unknown;
      if (opts.input) {
        const raw =
          request.method === 'GET' || request.method === 'HEAD'
            ? queryToObject(url)
            : await readJsonBody(request);
        input = opts.input.parse(raw);
      }

      const result = await opts.handler({
        auth,
        sb,
        input: input as TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined,
        request,
        url,
        params,
        audit: (entry) => pending.push(entry),
      });

      // Audit AFTER the operation succeeded, so the log records what happened rather
      // than what was attempted. (The export endpoints additionally write a PRE-entry —
      // there, "an attempt was made" is itself the security-relevant fact.)
      for (const entry of pending) await writeAudit(sb, auth, entry);

      if (result instanceof Response) return result;
      return json({ ok: true, data: result ?? null });
    } catch (err) {
      const { status, body } = mapError(err);
      if (status === 500) {
        // Fire-and-forget; writeSystemLog never throws.
        void writeSystemLog({
          level: 'error',
          source: `admin:${opts.cap}`,
          message: err instanceof Error ? err.message : 'unknown admin route error',
          detail: { path: url.pathname, method: request.method, role: auth?.role ?? 'anon' },
        });
      }
      return json(body, status);
    }
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('body must be valid JSON');
  }
}
