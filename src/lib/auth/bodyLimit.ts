// How much a request to a sign-in path may carry (Admin v2 F7, final review).
//
// The six pre-auth paths (the three sign-in screens and their three endpoints) are the only
// private paths anyone can post to without a session, and each post is read more than once:
// the middleware's CSRF check reads a clone of a form body for its `_csrf` field, a refused
// sign-in form is read again for what goes back to its page (src/lib/auth/expiredForm.ts),
// and the handler reads it once more. With no bound, one request could make the Worker
// buffer as much as the platform lets in, several times over. So the middleware refuses a
// body over PRE_AUTH_BODY_LIMIT before anything reads it: by its declared Content-Length,
// with no read at all; or, when none is declared (a chunked body), by reading a copy up to
// the limit and no further.
//
// 16 KB, not the 8 the review suggested: the largest form the schemas accept is about 9.3 KB
// (the sign-in form with a 2,048-character `next` of slashes, each `%2F` once form-encoded,
// a 256-character password of 3-byte characters, a 254-character e-mail of characters the
// encoding triples, and the CSRF token), and a cap must never refuse a form a person can
// send. tests/lib/bodyLimit.spec.ts builds that form and holds it under the cap.

export const PRE_AUTH_BODY_LIMIT = 16 * 1024;

/** A Content-Length a parser would accept: digits only. */
const DECLARED_LENGTH = /^\d{1,15}$/;

/**
 * True when the request's body is at most `limit` bytes. A declared Content-Length decides
 * without reading anything (one that is not a number is refused). Without one, a copy is
 * read until it ends or passes the limit, never further; the request's own body is left for
 * the handler.
 */
export async function bodyWithinLimit(
  request: Request,
  limit: number = PRE_AUTH_BODY_LIMIT,
): Promise<boolean> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const value = declared.trim();
    return DECLARED_LENGTH.test(value) && Number(value) <= limit;
  }
  if (request.body === null) return true;
  const reader = request.clone().body?.getReader();
  if (!reader) return true;
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      seen += value.byteLength;
      if (seen > limit) return false;
    }
  } catch {
    return false;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
