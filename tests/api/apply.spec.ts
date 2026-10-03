import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';

// POST /api/apply — the Join form's endpoint, driven through the real handler with the
// service client faked at the module boundary. The whole status matrix (CLAUDE.md §9:
// prove the SERVER refuses), plus the two rules that matter most: a failed row deletes its
// CV again, and nothing is stored for a bot.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let accepting: boolean | 'error' = true;
let hitCount = 1;
let rpcError = false;
let insertError = false;
let insertThrows = false;
let encryptThrows = false;
let uploadError = false;
const inserts: Record<string, unknown>[] = [];
const uploads: { path: string; type: string }[] = [];
const removed: string[][] = [];
const rpcCalls: Record<string, unknown>[] = [];

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['maybeSingle'] = async () =>
        table === 'site_profile'
          ? accepting === 'error'
            ? { data: null, error: { message: 'down' } }
            : { data: { accepting_applications: accepting }, error: null }
          : { data: null, error: null };
      b['insert'] = async (row: Record<string, unknown>) => {
        if (insertThrows) throw new Error('socket closed');
        inserts.push(row);
        return { data: null, error: insertError ? { message: 'nope' } : null };
      };
      return b;
    },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return rpcError
        ? { data: null, error: { message: 'down' } }
        : { data: hitCount, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path: string, file: Blob) => {
          uploads.push({ path, type: file.type });
          return {
            data: uploadError ? null : { path },
            error: uploadError ? { message: 'x' } : null,
          };
        },
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { data: [], error: null };
        },
      }),
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/tenant', () => ({ resolveLaunchTenantId: async () => TENANT }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/crypto/pii', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/crypto/pii')>();
  return {
    ...real,
    encryptPII: async (...a: Parameters<typeof real.encryptPII>) => {
      if (encryptThrows) throw new Error('bad key');
      return real.encryptPII(...a);
    },
  };
});

const { POST } = await import('@/pages/api/apply');

const enc = new TextEncoder();
const PDF = new File([enc.encode('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n')], 'my cv.pdf', {
  type: 'application/octet-stream',
});

function form(over: Record<string, string | null> = {}, file: File | null = PDF): FormData {
  const fd = new FormData();
  const fields: Record<string, string> = {
    locale: 'en',
    name: 'Noura',
    email: 'noura@example.com',
    phone: '+966500000000',
    city: 'Jeddah',
    role: 'Motion designer',
    experience: '3-6',
    work_type: 'freelance',
    availability: 'month',
    portfolio: 'https://behance.net/noura',
    message: 'The launch film for a client, end to end.',
    consent_application: 'on',
    policy_version: RECRUITMENT_POLICY_VERSION,
    hp: '',
  };
  for (const [k, v] of Object.entries({ ...fields, ...over })) {
    if (v !== null) fd.set(k, v);
  }
  fd.append('skills', 'animation');
  fd.append('skills', 'motion-graphics');
  if (file) fd.set('cv', file);
  return fd;
}

async function send(
  body: FormData | string,
  opts: { json?: boolean; origin?: string; length?: string | null; type?: string } = {},
): Promise<Response> {
  const probe = new Request('https://www.braiinstation.com/api/apply', { method: 'POST', body });
  const headers = new Headers(probe.headers);
  headers.set('host', 'www.braiinstation.com');
  headers.set('origin', opts.origin ?? 'https://www.braiinstation.com');
  if (opts.json !== false) headers.set('accept', 'application/json');
  if (opts.type) headers.set('content-type', opts.type);
  const bytes = await probe.arrayBuffer();
  if (opts.length === null) headers.delete('content-length');
  else headers.set('content-length', opts.length ?? String(bytes.byteLength));
  const request = new Request('https://www.braiinstation.com/api/apply', {
    method: 'POST',
    headers,
    body: bytes,
  });
  return (POST as unknown as (c: { request: Request }) => Promise<Response>)({ request });
}

const statusOf = async (res: Response) => ((await res.json()) as { status: string }).status;

beforeEach(() => {
  accepting = true;
  hitCount = 1;
  rpcError = false;
  insertError = false;
  insertThrows = false;
  encryptThrows = false;
  uploadError = false;
  inserts.length = 0;
  uploads.length = 0;
  removed.length = 0;
  rpcCalls.length = 0;
});

describe('POST /api/apply — refusals, in order', () => {
  it('a cross-origin post is a plain 403 and never a redirect', async () => {
    const res = await send(form(), { origin: 'https://evil.example', json: false });
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it('a body that is not multipart is refused (415, invalid)', async () => {
    const res = await send('{"name":"x"}', { type: 'application/json' });
    expect(res.status).toBe(415);
    expect(await statusOf(res)).toBe('invalid');
  });

  it('no Content-Length → 411 before a byte is read; an oversized one → 413 too_large', async () => {
    expect((await send(form(), { length: null })).status).toBe(411);
    const big = await send(form(), { length: String(11 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect(await statusOf(big)).toBe('too_large');
    expect(rpcCalls).toHaveLength(0);
  });

  it('closed → 409 closed, before the limiter counts anything', async () => {
    accepting = false;
    const res = await send(form());
    expect(res.status).toBe(409);
    expect(await statusOf(res)).toBe('closed');
    expect(rpcCalls).toHaveLength(0);
  });

  it('an unreadable open flag fails closed (503 unavailable)', async () => {
    accepting = 'error';
    expect(await statusOf(await send(form()))).toBe('unavailable');
  });

  it('over the per-IP limit → 429; an unreachable limiter FAILS CLOSED (503)', async () => {
    hitCount = 6;
    const res = await send(form());
    expect(res.status).toBe(429);
    expect(await statusOf(res)).toBe('rate_limited');
    hitCount = 1;
    rpcError = true;
    expect(await statusOf(await send(form()))).toBe('unavailable');
    expect(inserts).toHaveLength(0);
  });

  it('the limiter stores an HMAC, never the address or the e-mail', async () => {
    await send(form());
    expect(rpcCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of rpcCalls) {
      expect(c['p_key_hash']).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c)).not.toContain('noura@example.com');
    }
  });

  it('a filled honeypot answers ok and stores NOTHING', async () => {
    const res = await send(form({ hp: 'i am a bot' }));
    expect(await statusOf(res)).toBe('ok');
    expect(inserts).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it('a schema failure is a 422 naming the keys (never their values)', async () => {
    const res = await send(form({ email: 'not-an-email', portfolio: 'http://insecure.example' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { status: string; fields: string[] };
    expect(body.status).toBe('invalid');
    expect(body.fields.sort()).toEqual(['email', 'portfolio']);
    expect(JSON.stringify(body)).not.toContain('not-an-email');
  });

  it('the required consent must be given — the 422 names it', async () => {
    const noConsent = await send(form({ consent_application: null }));
    expect(((await noConsent.json()) as { fields: string[] }).fields).toContain(
      'consentApplication',
    );
  });

  it('over the per-e-mail limit → 429', async () => {
    let n = 0;
    hitCount = 1;
    // first rpc (ip) passes, second (email) is over
    const realPush = rpcCalls.push.bind(rpcCalls);
    rpcCalls.push = (...a: Record<string, unknown>[]) => {
      n += 1;
      hitCount = n === 2 ? 4 : 1;
      return realPush(...a);
    };
    const res = await send(form());
    rpcCalls.push = realPush;
    expect(res.status).toBe(429);
  });

  it('a refused CV is not counted against the e-mail (no lockout, no "did they apply" oracle)', async () => {
    const exe = new File([enc.encode('MZ not a cv')], 'cv.pdf', { type: 'application/pdf' });
    expect(await statusOf(await send(form({}, exe)))).toBe('bad_type');
    expect(rpcCalls.map((c) => c['p_scope'])).toEqual(['apply:ip']);
  });

  it('a notice version that was never published is refused', async () => {
    const res = await send(form({ policy_version: '2025-01-01' }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['policyVersion']);
  });

  it('a CV that is not a PDF or .docx → 415 bad_type, nothing stored', async () => {
    const exe = new File([enc.encode('MZ\x90\x00 not a cv')], 'cv.pdf', {
      type: 'application/pdf',
    });
    const res = await send(form({}, exe));
    expect(res.status).toBe(415);
    expect(await statusOf(res)).toBe('bad_type');
    expect(uploads).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe('POST /api/apply — storing', () => {
  it('stores the CV under a random path with the SNIFFED type, then the row; email and phone encrypted', async () => {
    const res = await send(form());
    expect(res.status).toBe(200);
    expect(await statusOf(res)).toBe('ok');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.type).toBe('application/pdf');
    expect(uploads[0]!.path).toMatch(new RegExp(`^${TENANT}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.pdf$`));
    expect(uploads[0]!.path).not.toContain('my cv');
    const row = inserts[0]!;
    expect(row['cv_path']).toBe(uploads[0]!.path);
    expect(row['email_enc']).not.toContain('noura@example.com');
    expect(row['phone_enc']).not.toContain('500000000');
    expect(row['skills']).toEqual(['animation', 'motion-graphics']);
    expect(row['consent_version']).toBe(RECRUITMENT_POLICY_VERSION);
    expect(row['future_roles_consent']).toBe(false);
  });

  it('retention: 12 months, or 24 with the future-roles consent', async () => {
    await send(form());
    await send(form({ consent_future: 'on' }));
    const months = (r: Record<string, unknown>) =>
      Math.round(
        (Date.parse(String(r['retention_delete_after'])) - Date.now()) / (30.44 * 86_400_000),
      );
    expect(months(inserts[0]!)).toBe(12);
    expect(months(inserts[1]!)).toBe(24);
    expect(inserts[1]!['future_roles_consent']).toBe(true);
  });

  it('a CV is optional', async () => {
    const res = await send(form({}, null));
    expect(await statusOf(res)).toBe('ok');
    expect(uploads).toHaveLength(0);
    expect(inserts[0]!['cv_path']).toBeNull();
  });

  it('a failed row deletes its CV again (no orphan the retention job cannot see)', async () => {
    insertError = true;
    const res = await send(form());
    expect(res.status).toBe(500);
    expect(await statusOf(res)).toBe('error');
    expect(removed).toEqual([[uploads[0]!.path]]);
  });

  it('an insert that throws still deletes its CV again', async () => {
    insertThrows = true;
    expect(await statusOf(await send(form()))).toBe('error');
    expect(uploads).toHaveLength(1);
    expect(removed).toEqual([[uploads[0]!.path]]);
  });

  it('a failed encryption uploads nothing and stores nothing (it runs before the upload)', async () => {
    encryptThrows = true;
    expect(await statusOf(await send(form()))).toBe('error');
    expect(uploads).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('a failed upload stores no row', async () => {
    uploadError = true;
    expect(await statusOf(await send(form()))).toBe('error');
    expect(inserts).toHaveLength(0);
  });

  it('without JavaScript the answer is a 303 back to the page, in the form’s language', async () => {
    const en = await send(form(), { json: false });
    expect(en.status).toBe(303);
    expect(en.headers.get('location')).toBe('/join?status=ok#apply');
    const ar = await send(form({ locale: 'ar' }), { json: false });
    expect(ar.headers.get('location')).toBe('/ar/join?status=ok#apply');
    expect(ar.headers.get('cache-control')).toBe('no-store');
  });
});
