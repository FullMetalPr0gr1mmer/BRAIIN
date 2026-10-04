import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The lead detail route, past assertCap: the contact-details reveal must be audited
// BEFORE anything is decrypted, and refused when the audit row cannot be written
// (CLAUDE.md §3: "audit-log every view"; PDPL accountability). The kernel's queued
// audit runs after the handler and cannot stop a response, so the reveal writes its
// row directly, as the job-applications reveal does. Also covers the notes editor,
// which must not appear before the reveal or it would save an empty value over the
// real notes.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';

let auditOk = true;
let liveRole = 'admin';
const events: string[] = [];
const row = {
  id: LEAD,
  kind: 'contact',
  locale: 'en',
  name: 'Sara',
  company: 'Acme',
  message: 'Hello',
  service_of_interest: 'logo',
  status: 'new',
  consent_marketing: true,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  discipline_of_interest: null,
  email_enc: 'enc:sara@example.com',
  phone_enc: 'enc:+966500000000',
  budget_enc: 'enc:b25_75',
  timeline_band: null,
  timeline_text_enc: null,
  internal_notes: 'Called back on Monday',
  ip_inet: null,
};

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: { action: string }) => {
    events.push(`audit:${entry.action}`);
    return auditOk;
  },
}));
vi.mock('@/lib/crypto/pii', () => ({
  decryptPII: async (v: string) => {
    events.push('decrypt');
    return v.replace(/^enc:/, '');
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));
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
  }),
}));

function rlsClient() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) b[m] = () => b;
  b['maybeSingle'] = async () => ({ data: row, error: null });
  return { from: () => b };
}

function ctx(path: string, role = 'admin'): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  return {
    request: new Request(url, { method: 'GET' }),
    url,
    params: { id: LEAD },
    locals: {
      session: { userId: USER, tenantId: TENANT, role, email: 'a@x', isActive: true },
      supabase: rlsClient(),
    },
  } as unknown as APIContext;
}

const detail = await import('@/pages/api/admin/leads/[id]');
const { showNotesEditor } = await import('@/components/admin/LeadsPanel');

beforeEach(() => {
  auditOk = true;
  liveRole = 'admin';
  events.length = 0;
});

describe('lead contact details (?pii=1)', () => {
  it('writes the audit row first, then decrypts, and never returns ciphertext', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events[0]).toBe('audit:lead.view_pii');
    expect(events.slice(1).every((e) => e === 'decrypt')).toBe(true);
    expect(events.filter((e) => e.startsWith('audit:'))).toEqual(['audit:lead.view_pii']);
    expect(body.data['email']).toBe('sara@example.com');
    expect(body.data['phone']).toBe('+966500000000');
    expect(body.data['email_enc']).toBeUndefined();
    expect(body.data['phone_enc']).toBeUndefined();
    expect(body.data['budget_enc']).toBeUndefined();
  });

  it('refuses, and decrypts nothing, when the audit row cannot be written', async () => {
    auditOk = false;
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(events).not.toContain('decrypt');
    expect(JSON.stringify(body)).not.toContain('sara@example.com');
  });

  it('a demoted user is refused at once (live recheck), before any audit or decrypt', async () => {
    liveRole = 'seo';
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(res.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('Developer holds leads.pii and gets the same audited reveal', async () => {
    liveRole = 'developer';
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`, 'developer'));
    expect(res.status).toBe(200);
    expect(events[0]).toBe('audit:lead.view_pii');
  });
});

describe('lead detail without the reveal', () => {
  it('returns safe columns only, decrypts nothing, and logs a plain view', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events).toEqual(['audit:lead.view']);
    expect(body.data['name']).toBe('Sara');
    for (const hidden of ['email_enc', 'phone_enc', 'budget_enc', 'internal_notes', 'ip_inet']) {
      expect(body.data[hidden], hidden).toBeUndefined();
    }
  });
});

describe('the notes editor', () => {
  it('appears only after the audited reveal, so a save can never blank the real notes', () => {
    expect(showNotesEditor(true, false)).toBe(false);
    expect(showNotesEditor(true, true)).toBe(true);
    expect(showNotesEditor(false, true)).toBe(false);
    expect(showNotesEditor(false, false)).toBe(false);
  });
});
