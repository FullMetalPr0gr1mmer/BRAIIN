// Browser-side helper for every admin mutation. Loaded only by /admin pages.
//
// Its whole job is that no call site has to remember the CSRF header. The middleware
// rejects a mutation without a matching `x-csrf-token`, so a forgotten header is a 403
// the developer will notice — but they will notice it at the moment they are trying to
// ship something, and the tempting fix at that moment is to relax the middleware.
// One helper that always attaches it removes the temptation.

export interface ApiError {
  error: string;
  status: number;
  // `| undefined` is required under exactOptionalPropertyTypes: these are built from
  // an optional JSON payload, so "absent" arrives as an explicit undefined.
  detail?: string | undefined;
  issues?: { path: string; message: string }[] | undefined;
}

export class AdminApiError extends Error {
  constructor(readonly info: ApiError) {
    super(info.detail ?? info.error);
    this.name = 'AdminApiError';
  }
}

function csrfToken(): string {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta?.getAttribute('content') ?? '';
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `fetch` with the CSRF header, JSON encoding, and error unwrapping.
 *
 * `credentials: 'same-origin'` is explicit rather than relying on the default: the
 * session lives in a `__Host-` cookie, and a future default change (or a call built
 * from a Request object) that dropped credentials would produce a confusing 401 on an
 * apparently-logged-in page.
 */
export async function adminFetch<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!SAFE.has(method)) {
    headers['x-csrf-token'] = csrfToken();
    if (options.body !== undefined) headers['content-type'] = 'application/json';
  }

  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  const response = await fetch(url, init);

  // 401 means the session died underneath an open tab — an idle editor, or an admin who
  // was just deactivated. Bouncing to login beats rendering "error" over a form whose
  // contents can no longer be saved.
  if (response.status === 401) {
    window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new AdminApiError({ error: 'unauthenticated', status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body (a CSV download, or a proxy error page).
  }

  if (!response.ok || payload['ok'] === false) {
    throw new AdminApiError({
      error: String(payload['error'] ?? 'request-failed'),
      status: response.status,
      detail: typeof payload['detail'] === 'string' ? payload['detail'] : undefined,
      issues: Array.isArray(payload['issues'])
        ? (payload['issues'] as { path: string; message: string }[])
        : undefined,
    });
  }

  return (payload['data'] ?? payload) as T;
}

/** Human-readable text for the error envelope the API kernel returns. */
export function describeError(err: unknown): string {
  if (!(err instanceof AdminApiError)) {
    return err instanceof Error ? err.message : 'Something went wrong.';
  }
  switch (err.info.error) {
    case 'forbidden':
      return 'Your role does not allow that.';
    case 'conflict':
      return 'Someone else saved changes while you were editing. Reload to see their version.';
    case 'not-found':
      return 'That item no longer exists.';
    case 'csrf':
    case 'bad-origin':
      return 'Your session expired. Reload the page and try again.';
    case 'rate-limit':
      return 'Rate limit reached. Try again in an hour.';
    case 'validation':
      return (
        err.info.detail ??
        err.info.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ??
        'Some fields need fixing.'
      );
    default:
      return 'Something went wrong. The details are in the system log.';
  }
}
