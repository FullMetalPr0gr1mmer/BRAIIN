import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The admin's application routes, past assertCap: what each one refuses when the audit
// trail cannot record it, the order of an erase, the CV download's headers, and a demoted
// admin (CLAUDE.md §9(b): demotion is effective immediately).

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';
const PATH = `${TENANT}/${APP}/33333333-3333-4333-8333-333333333333.pdf`;

let auditOk = true;
let liveRole = 'admin';
let removeOk = true;
const audits: string[] = [];
const calls: string[] = [];
const row = {
  id: APP,
  name: 'Noura',
  cv_path: PATH,
  cv_content_type: 'application/pdf',
  cv_bytes: 12,
  email_enc: 'enc:noura@example.com',
  phone_enc: 'enc:+966500000000',
  skills: [],
};

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: { action: string }) => {
    audits.push(entry.action);
    return auditOk;
  },
}));
vi.mock('@/lib/crypto/pii', () => ({
  encryptPII: async (v: string) => `enc:${v}`,
  decryptPII: async (v: string) => {
    calls.push('decrypt');
    return v.replace(/^enc:/, '');
  },
}));
vi.mock('@/lib/admin/rateLimit', () => ({
  assertPrivilegedOpAllowed: async () => undefined,
  recordPrivilegedOp: async () => undefined,
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['maybeSingle'] = async () => ({
        data: { role: liveRole, is_active: true, locked_until: null },
        error: null,
      });
      return b;
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          calls.push(`remove:${paths.join(',')}`);
          return removeOk ? { data: [], error: null } : { data: null, error: { message: 'x' } };
        },
        download: async () => {
          calls.push('download');
          return { data: new Blob(['%PDF-1.7 %%EOF'], { type: 'application/pdf' }), error: null };
        },
      }),
    },
  }),
}));

function rlsClient() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update']) b[m] = () => b;
  b['maybeSingle'] = async () => ({ data: row, error: null });
  b['delete'] = () => {
    calls.push('delete-row');
    const d: Record<string, unknown> = {};
    d['eq'] = () => d;
    d['then'] = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ error: null, count: 1 }).then(ok);
    return d;
  };
  return { from: () => b };
}

function ctx(method: string, path: string): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  return {
    request: new Request(url, { method }),
    url,
    params: { id: APP },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', email: 'a@x', isActive: true },
      supabase: rlsClient(),
    },
  } as unknown as APIContext;
}

const detail = await import('@/pages/api/admin/applications/[id]');
const cv = await import('@/pages/api/admin/applications/[id]/cv');

beforeEach(() => {
  auditOk = true;
  liveRole = 'admin';
  removeOk = true;
  audits.length = 0;
  calls.length = 0;
});

describe('contact details (?pii=1)', () => {
  it('decrypts after an audit row is written, and never returns ciphertext or the path', async () => {
    const res = await detail.GET(ctx('GET', `/api/admin/applications/${APP}?pii=1`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(audits).toEqual(['application.view_pii']);
    expect(body.data['email']).toBe('noura@example.com');
    expect(body.data['email_enc']).toBeUndefined();
    expect(body.data['cv_path']).toBeUndefined();
    expect(body.data['has_cv']).toBe(true);
  });

  it('refuses — and decrypts nothing — when the audit row cannot be written', async () => {
    auditOk = false;
    const res = await detail.GET(ctx('GET', `/api/admin/applications/${APP}?pii=1`));
    expect(res.status).toBe(403);
    expect(calls).not.toContain('decrypt');
  });

  it('a demoted admin is refused at once (live recheck), before any audit or decrypt', async () => {
    liveRole = 'developer';
    const res = await detail.GET(ctx('GET', `/api/admin/applications/${APP}?pii=1`));
    expect(res.status).toBe(403);
    expect(audits).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('the CV download', () => {
  it('streams the file as an attachment under a sandbox CSP, audited first', async () => {
    const res = await cv.GET(ctx('GET', `/api/admin/applications/${APP}/cv`));
    expect(res.status).toBe(200);
    expect(audits).toEqual(['application.cv_download']);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="cv-${APP.slice(0, 8)}.pdf"`,
    );
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('no audit row, no file', async () => {
    auditOk = false;
    const res = await cv.GET(ctx('GET', `/api/admin/applications/${APP}/cv`));
    expect(res.status).toBe(403);
    expect(calls).not.toContain('download');
  });
});

describe('erase (DSAR)', () => {
  it('audits, removes the CV object, THEN deletes the row', async () => {
    const res = await detail.DELETE(ctx('DELETE', `/api/admin/applications/${APP}`));
    expect(res.status).toBe(200);
    expect(audits).toEqual(['application.erase']);
    expect(calls).toEqual([`remove:${PATH}`, 'delete-row']);
  });

  it('keeps the row when the object cannot be removed, so the erase can be retried', async () => {
    removeOk = false;
    const res = await detail.DELETE(ctx('DELETE', `/api/admin/applications/${APP}`));
    expect(res.status).toBe(500);
    expect(calls).not.toContain('delete-row');
  });
});

describe('panel helpers', async () => {
  const { formatBytes, safeLink } = await import('@/components/admin/ApplicationsPanel');
  it('formats sizes and only links https', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(900)).toBe('1 KB');
    expect(formatBytes(null)).toBe('');
    expect(safeLink('https://behance.net/x')).toBe('https://behance.net/x');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('http://x')).toBeNull();
  });
});
