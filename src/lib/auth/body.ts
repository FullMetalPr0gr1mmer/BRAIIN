// The sign-in endpoints (login, forgot, reset: Admin v2 F7) take two kinds of body.
//
//   - JSON, from a script (or a test): answered with JSON, status codes and all.
//   - A plain HTML form post (application/x-www-form-urlencoded): the sign-in screens are
//     zero-JS forms, so this is what a person's browser sends. Answered with a 303 back to
//     a page (POST, redirect, GET), which renders the outcome from a fixed list of codes in
//     its query string. Nothing a person typed travels in that URL.
//
// The CSRF token of a form post is its hidden `_csrf` field, which the middleware reads
// before the handler runs (src/middleware.ts, submittedCsrf). Anything else (multipart, a
// body that does not parse) is null, and the endpoint answers 400 before reading a field.

export interface AuthBody {
  kind: 'json' | 'form';
  /** Field values. A form's repeated or file fields are dropped; JSON is as parsed. */
  fields: Record<string, unknown>;
}

const NO_STORE = 'no-store';

export async function readAuthBody(request: Request): Promise<AuthBody | null> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    try {
      const form = await request.formData();
      const fields: Record<string, unknown> = {};
      for (const [key, value] of form) {
        if (typeof value === 'string' && !(key in fields)) fields[key] = value;
      }
      return { kind: 'form', fields };
    } catch {
      return null;
    }
  }
  if (type.includes('multipart/form-data')) return null;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { kind: 'json', fields: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** The no-JS answer: 303 to a same-origin page, never cached. */
export function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, 'cache-control': NO_STORE },
  });
}

/** A checkbox in a form post: sent (with any value) when ticked, absent when not. */
export function ticked(fields: Record<string, unknown>, name: string): boolean {
  return typeof fields[name] === 'string';
}
