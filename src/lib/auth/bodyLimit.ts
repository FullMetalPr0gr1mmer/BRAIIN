// How much a private request's body may carry before the middleware reads it (Admin v2 F7,
// final review).
//
// A body sent without a session is read only on the eight pre-auth paths (the four sign-in
// screens and their four endpoints; the invite page joined in Admin v2 U12b, its form no
// larger than the reset's): on every other private path the middleware answers a
// signed-out post (401, or the sign-in redirect) before it reads a byte (src/middleware.ts);
// until the review's second pass the CSRF check cloned any urlencoded body first, unbounded.
// On a pre-auth path a post is read more than once: the CSRF check reads a clone of a form
// body for its `_csrf` field, a refused sign-in form is read again for what goes back to its
// page (src/lib/auth/expiredForm.ts), and the handler reads it once more. So the middleware
// refuses a body over PRE_AUTH_BODY_LIMIT there before anything reads it: by its declared
// Content-Length, with no read at all; or, when none is declared (a chunked body), by
// reading a copy up to the limit and no further. Behind a session, the one body the
// middleware itself reads (a urlencoded form's clone, for its token) is held to
// PRIVATE_FORM_BODY_LIMIT; what a handler reads is the handler's (an upload checks its own
// Content-Length, up to 20 MB, src/lib/media/upload.ts).
//
// 16 KB, not the 8 the review suggested: the largest form the schemas accept is about 9.3 KB
// (the sign-in form with a 2,048-character `next` of characters each `%XX` once form-encoded,
// a 256-character password of 3-byte characters, a 254-character e-mail of characters the
// encoding triples, and the CSRF token), and a cap must never refuse a form a person can
// send. tests/lib/bodyLimit.spec.ts builds that form and holds it under the cap.

export const PRE_AUTH_BODY_LIMIT = 16 * 1024;

/**
 * 1 MB: a signed-in urlencoded form the middleware reads for its token. The admin's own
 * forms of that kind (the account and notification no-JS twins) send under a kilobyte; its
 * saves are JSON with the token in a header, which the middleware never reads.
 */
export const PRIVATE_FORM_BODY_LIMIT = 1024 * 1024;

/**
 * 128 KB: a public endpoint's body (H14), refused by the middleware before any handler reads
 * it. The public JSON endpoints (/api/contact, /api/consent, /api/rum, /api/analytics,
 * /api/clientlog, /api/ai/style-finder) read `request.json()` with no cap of their own, so a
 * visitor could post up to the platform's request limit (100 MB) and have it parsed and
 * validated; with zod 3's array handling (GHSA-mrhx-c7xc-m3w5, EXC-013: every item of an
 * over-long array is still parsed) that is a memory-exhaustion path. The largest body their
 * schemas accept, every free-text character escaped to six bytes, is the Style-Finder's
 * (40 answers: about 84 KB), then the contact form's (about 33 KB, plus a captcha token), so
 * the cap never refuses a request a person can send; tests/lib/publicBodyLimit.spec.ts builds
 * each worst case. The routes with a limit of their own (the Join form's multipart, the signed
 * hook, the page password) keep it (src/middleware.ts).
 */
export const PUBLIC_API_BODY_LIMIT = 128 * 1024;

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
