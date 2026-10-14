import { describe, expect, it } from 'vitest';
import { PRE_AUTH_BODY_LIMIT, bodyWithinLimit } from '@/lib/auth/bodyLimit';
import { safeNext } from '@/lib/auth/next';

// The pre-auth body limit (Admin v2 F7, final review): anyone can post to the sign-in paths,
// and their bodies are read several times, so the middleware bounds them before any read.

const URL_ = 'https://admin.example.test/api/admin/auth/login';

/** A request whose body is a stream of `chunks` chunks of `size` bytes, no Content-Length. */
function chunked(chunks: number, size: number, pulls = { count: 0 }) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.count += 1;
      if (sent >= chunks) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return new Request(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('bodyWithinLimit', () => {
  it('decides by a declared Content-Length, reading nothing', async () => {
    const declared = (length: string) =>
      new Request(URL_, { method: 'POST', headers: { 'content-length': length }, body: 'x' });
    expect(await bodyWithinLimit(declared(String(PRE_AUTH_BODY_LIMIT)))).toBe(true);
    const over = declared(String(PRE_AUTH_BODY_LIMIT + 1));
    expect(await bodyWithinLimit(over)).toBe(false);
    expect(over.bodyUsed).toBe(false);
    // One a parser would not accept is refused.
    for (const odd of ['-1', '1e9', 'abc', '12 34', '9'.repeat(16)]) {
      expect(await bodyWithinLimit(declared(odd)), odd).toBe(false);
    }
  });

  it('without one, measures a copy and leaves the body for the handler', async () => {
    const small = chunked(4, 1024);
    expect(await bodyWithinLimit(small)).toBe(true);
    expect((await small.text()).length).toBe(4096);
    expect(await bodyWithinLimit(chunked(16, 1024))).toBe(true);
    expect(await bodyWithinLimit(chunked(16, 1024 + 1))).toBe(false);
    expect(await bodyWithinLimit(new Request(URL_, { method: 'POST' }))).toBe(true);
  });

  it('stops reading at the limit: an endless body costs only that much', async () => {
    const pulls = { count: 0 };
    expect(await bodyWithinLimit(chunked(Number.POSITIVE_INFINITY, 1024, pulls))).toBe(false);
    // 16 chunks fit, the 17th is over; a tee may pull a chunk or two ahead.
    expect(pulls.count).toBeLessThanOrEqual(PRE_AUTH_BODY_LIMIT / 1024 + 3);
  });

  it('never refuses a form a person can send: the largest the schemas accept fits', async () => {
    // The sign-in form at every field's longest, in the characters form-encoding expands
    // most: a 2,048-character `next` of slashes (each `%2F`), a 256-character password of
    // 3-byte characters (each `%XX%XX%XX`), a 254-character e-mail of `+` (each `%2B`).
    const next = safeNext(`/admin${'/'.repeat(2042)}`);
    expect(next.length).toBe(2048);
    const body = new URLSearchParams({
      _csrf: 'a'.repeat(64),
      next,
      email: `${'+'.repeat(241)}@example.test`,
      password: '日'.repeat(256),
      remember: '1',
    }).toString();
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeGreaterThan(8 * 1024);
    expect(bytes).toBeLessThanOrEqual(PRE_AUTH_BODY_LIMIT);
    const form = new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(await bodyWithinLimit(form)).toBe(true);
  });
});
