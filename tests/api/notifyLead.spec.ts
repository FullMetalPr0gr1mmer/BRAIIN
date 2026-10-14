import { describe, it, expect, vi } from 'vitest';

// §9(d): "notify-lead (unsigned POST → 401, no PII in body)".
//
// This endpoint is the one public URL that can read the lead table. It is
// unauthenticated by URL, discoverable, and retryable without limit — so the signature
// check (0048: a timestamp and an HMAC over the ids, src/lib/leads/notifySignature.ts) is
// the only thing between the internet and a lead row, and it has to be proven rather than
// assumed.

const inserted: Record<string, unknown>[] = [];

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) builder[m] = chain;
    builder['insert'] = (row: Record<string, unknown>) => {
      inserted.push(row);
      return Promise.resolve({ data: null, error: null });
    };
    builder['maybeSingle'] = async () => ({
      data: {
        id: 'lead-1',
        tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'A Person',
        message: 'hello',
        service_of_interest: null,
        discipline_of_interest: 'branding',
        locale: 'en',
        email_enc: '',
        phone_enc: '',
        budget_enc: '',
        timeline_band: '3-6m',
        created_at: '2026-07-27T00:00:00Z',
      },
      error: null,
    });
    builder['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [{ id: 'u1', role: 'admin' }], error: null }));
    return { from: () => builder };
  },
}));

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({}),
}));

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { POST } = await import('@/pages/api/hooks/notify-lead');
const {
  NOTIFY_SIGNATURE_WINDOW_S,
  notifySignature,
  notifySignatureValid,
  notifySignedString,
  readNotifyHeaders,
} = await import('@/lib/leads/notifySignature');

const SECRET = 'test-dummy-notify-lead-secret'; // matches tests/stubs/astro-env-server.ts
const BODY = {
  lead_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const nowS = () => Math.floor(Date.now() / 1000);

interface Signing {
  /** The signed timestamp; now by default. */
  ts?: number;
  /** The key; the Worker's by default. */
  secret?: string;
  /** The ids the signature covers; the body's by default. */
  signedLead?: string;
  signedTenant?: string;
}

async function signedHeaders(body: { lead_id: string; tenant_id: string }, o: Signing = {}) {
  const ts = String(o.ts ?? nowS());
  return {
    'x-braiin-timestamp': ts,
    'x-braiin-signature': await notifySignature(
      o.secret ?? SECRET,
      ts,
      o.signedLead ?? body.lead_id,
      o.signedTenant ?? body.tenant_id,
    ),
  };
}

const URL_ = 'https://example.test/api/hooks/notify-lead';
const handle = (request: Request) =>
  (POST as unknown as (ctx: { request: Request }) => Promise<Response>)({ request });

/** As pg_net (libcurl) sends it: the body with its Content-Length, counted in bytes. */
function call(headers: Record<string, string>, body: unknown = BODY) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return handle(
    new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(text).byteLength),
        ...headers,
      },
      body: text,
    }),
  );
}

/**
 * A body that keeps coming: `chunks` chunks of `size` bytes, and the number of times the
 * reader pulled one, so a test can show how much of it the hook asked for.
 */
function stream(chunks: number, size = 256, fill = 0x20) {
  const counter = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      counter.pulls += 1;
      if (counter.pulls > chunks) controller.close();
      else controller.enqueue(new Uint8Array(size).fill(fill));
    },
  });
  return { body, counter };
}

function streamed(headers: Record<string, string>, body: ReadableStream<Uint8Array>) {
  const request = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, response: handle(request) };
}

const signedCall = async (o: Signing = {}) => call(await signedHeaders(BODY, o));

describe('the signing scheme (src/lib/leads/notifySignature.ts)', () => {
  it('signs the canonical string, not the JSON, exactly as 0048 does', async () => {
    expect(notifySignedString('1760000000', BODY.lead_id, BODY.tenant_id)).toBe(
      '1760000000.11111111-1111-4111-8111-111111111111.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    // The same vector supabase/tests/lead_notify.test.sql computes with pgcrypto's hmac.
    expect(await notifySignature(SECRET, '1760000000', BODY.lead_id, BODY.tenant_id)).toBe(
      'v1=b0d61ac408b980012f8d511b395bf660f9c27e29836763a570d8c2138c7eea22',
    );
  });

  it('never verifies under a short or empty secret', async () => {
    // A short secret, with a signature truly made under it.
    const sig = await notifySignature('short', '1760000000', BODY.lead_id, BODY.tenant_id);
    expect(
      await notifySignatureValid('short', '1760000000', sig, BODY.lead_id, BODY.tenant_id),
    ).toBe(false);
    // An unset one (WebCrypto would refuse an empty key; the length check refuses first).
    expect(
      await notifySignatureValid(
        '',
        '1760000000',
        `v1=${'0'.repeat(64)}`,
        BODY.lead_id,
        BODY.tenant_id,
      ),
    ).toBe(false);
  });

  it('reads the headers only when both are well formed and inside the window', () => {
    const now = 1_760_000_000_000;
    const sig = `v1=${'a'.repeat(64)}`;
    const h = (ts: string | null, signature: string | null) => {
      const headers = new Headers();
      if (ts !== null) headers.set('x-braiin-timestamp', ts);
      if (signature !== null) headers.set('x-braiin-signature', signature);
      return readNotifyHeaders(headers, now);
    };
    expect(h('1760000000', sig)).toEqual({ ts: '1760000000', signature: sig });
    expect(h(String(1_760_000_000 - NOTIFY_SIGNATURE_WINDOW_S), sig)).not.toBeNull();
    expect(h(String(1_760_000_000 - NOTIFY_SIGNATURE_WINDOW_S - 1), sig)).toBeNull();
    expect(h(String(1_760_000_000 + NOTIFY_SIGNATURE_WINDOW_S + 1), sig)).toBeNull();
    expect(h(null, sig)).toBeNull();
    expect(h('1760000000', null)).toBeNull();
    expect(h('1760000000.5', sig)).toBeNull();
    expect(h('-1760000000', sig)).toBeNull();
    expect(h('1760000000', `v1=${'A'.repeat(64)}`)).toBeNull();
    expect(h('1760000000', 'a'.repeat(64))).toBeNull();
    expect(h('1760000000', `v2=${'a'.repeat(64)}`)).toBeNull();
    expect(h('1760000000', `v1=${'a'.repeat(63)}`)).toBeNull();
  });
});

describe('notify-lead authentication', () => {
  it('rejects a POST with no signature (§9(d): unsigned → 401)', async () => {
    expect((await call({})).status).toBe(401);
  });

  it('rejects a call with only one of the two headers', async () => {
    const both = await signedHeaders(BODY);
    expect((await call({ 'x-braiin-timestamp': both['x-braiin-timestamp'] })).status).toBe(401);
    expect((await call({ 'x-braiin-signature': both['x-braiin-signature'] })).status).toBe(401);
  });

  it('rejects the old bearer, even carrying the right secret', async () => {
    expect((await call({ authorization: `Bearer ${SECRET}` })).status).toBe(401);
  });

  it('rejects a signature under another secret', async () => {
    expect((await signedCall({ secret: 'another-secret-of-enough-length' })).status).toBe(401);
  });

  it('rejects a stale or future timestamp, and accepts one inside the window', async () => {
    expect((await signedCall({ ts: nowS() - NOTIFY_SIGNATURE_WINDOW_S - 5 })).status).toBe(401);
    expect((await signedCall({ ts: nowS() + NOTIFY_SIGNATURE_WINDOW_S + 5 })).status).toBe(401);
    expect((await signedCall({ ts: nowS() - NOTIFY_SIGNATURE_WINDOW_S + 5 })).status).toBe(200);
  });

  it('rejects a body naming a lead or tenant other than the signed one', async () => {
    expect((await signedCall({ signedLead: OTHER_ID })).status).toBe(401);
    expect((await signedCall({ signedTenant: OTHER_ID })).status).toBe(401);
    // A valid signature for one lead does not carry over to another body.
    const headers = await signedHeaders(BODY);
    expect((await call(headers, { ...BODY, lead_id: OTHER_ID })).status).toBe(401);
    expect((await call(headers, { ...BODY, tenant_id: OTHER_ID })).status).toBe(401);
  });

  it('answers 401 for a body it cannot verify, and describes nothing', async () => {
    const headers = await signedHeaders(BODY);
    for (const body of ['not json', { garbage: true }, { ...BODY, extra: 1 }]) {
      const res = await call(headers, body);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    }
    expect((await call(headers, { ...BODY, pad: 'x'.repeat(2000) })).status).toBe(401);
  });

  it('accepts a correctly signed call', async () => {
    expect((await signedCall()).status).toBe(200);
  });
});

describe('notify-lead reads at most 1 KB before the signature is checked', () => {
  // Anyone can write headers that pass readNotifyHeaders (a fresh time, 64 hex digits), so
  // everything below runs for an unauthenticated caller.

  it('refuses a declared Content-Length over 1024 without reading the body', async () => {
    const { body, counter } = stream(1_000);
    const headers = { ...(await signedHeaders(BODY)), 'content-length': '1025' };
    const { request, response } = streamed(headers, body);
    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(counter.pulls).toBeLessThanOrEqual(1);
  });

  it('refuses a Content-Length that is not a plain byte count', async () => {
    for (const length of ['', '-1', '1e3', '0x10', '90, 90', '00001024000']) {
      const headers = { ...(await signedHeaders(BODY)), 'content-length': length };
      expect((await call(headers)).status, `content-length ${JSON.stringify(length)}`).toBe(401);
    }
  });

  it('refuses a body with no Content-Length (chunked), however it is signed, unread', async () => {
    // 64 KB on offer; the hook asks for none of it.
    const { body, counter } = stream(256);
    const { request, response } = streamed(await signedHeaders(BODY), body);
    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(counter.pulls).toBeLessThanOrEqual(1);
    // A correctly signed, well-formed body without the header is refused too.
    const ok = new TextEncoder().encode(JSON.stringify(BODY));
    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ok);
        controller.close();
      },
    });
    expect((await streamed(await signedHeaders(BODY), exact).response).status).toBe(401);
  });

  it('stops reading a body that runs past 1 KB, whatever it declared', async () => {
    // Declares 90 bytes, sends 1 MB: the reader cancels as soon as the count passes 1024.
    const { body, counter } = stream(4_096);
    const headers = { ...(await signedHeaders(BODY)), 'content-length': '90' };
    expect((await streamed(headers, body).response).status).toBe(401);
    // 1024 bytes is four 256-byte chunks; the fifth passes the cap. One more may be
    // pulled ahead by the stream's own queue.
    expect(counter.pulls).toBeLessThanOrEqual(6);
  });

  it('counts the cap in bytes, not UTF-16 code units', async () => {
    // 700 characters, 1,400 bytes: under 1024 as a string length, over it in bytes.
    const padded = `{"pad":"${'é'.repeat(700)}"}`;
    expect(padded.length).toBeLessThan(1024);
    const bytes = new TextEncoder().encode(padded);
    expect(bytes.byteLength).toBeGreaterThan(1024);
    const signed = await signedHeaders(BODY);
    // Declared honestly: refused before reading.
    expect((await call(signed, padded)).status).toBe(401);
    // Declared as 90: refused by the reader's byte count.
    const lying = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const headers = { ...signed, 'content-length': '90' };
    expect((await streamed(headers, lying).response).status).toBe(401);
  });

  it('accepts a correctly signed call that declares its size, streamed or not', async () => {
    expect((await signedCall()).status).toBe(200);
    const bytes = new TextEncoder().encode(JSON.stringify(BODY));
    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 40));
        controller.enqueue(bytes.subarray(40));
        controller.close();
      },
    });
    const headers = {
      ...(await signedHeaders(BODY)),
      'content-length': String(bytes.byteLength),
    };
    expect((await streamed(headers, exact).response).status).toBe(200);
  });
});

describe('notify-lead payload hygiene', () => {
  it('logs field NAMES and counts, never lead values', async () => {
    inserted.length = 0;
    await signedCall();

    const row = inserted.find((r) => 'channel' in r);
    expect(row, 'no notification_log row written').toBeDefined();

    const serialized = JSON.stringify(row);
    // The notification ledger is readable by Admin + Developer and is not covered by the
    // lead retention purge, so duplicating PII into it would create a second copy that
    // outlives the first.
    expect(serialized).not.toContain('A Person');
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain('3-6m');
    expect(row).toMatchObject({ channel: 'inbox', status: 'queued' });
  });

  it('names the discipline among the fields a recipient is sent (0028)', async () => {
    inserted.length = 0;
    await signedCall();
    const row = inserted.find((r) => 'channel' in r) as { detail: { fields: string[] } };
    expect(row.detail.fields).toContain('discipline');
    expect(row.detail.fields).toContain('service');
  });

  it('sends readable labels beside the slugs (Round 3), still as field NAMES only', async () => {
    inserted.length = 0;
    await signedCall();
    const row = inserted.find((r) => 'channel' in r) as { detail: { fields: string[] } };
    expect(row.detail.fields).toContain('serviceLabel');
    expect(row.detail.fields).toContain('disciplineLabel');
    // the label lookup ran on the service client, tenant-scoped, and wrote nothing
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('A Person');
    expect(serialized).not.toContain('Branding');
  });
});
