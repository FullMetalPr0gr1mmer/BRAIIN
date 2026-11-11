import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// Contact files (Admin v2 C16): the upload refuses before it costs anything (the length, the
// live recheck, the contact, the name, the BYTES, then the day's slot) and compensates a
// refused row by removing the object; the download runs the CV's order (live recheck, limit,
// the caller's read, the path as the service role, an audit row WRITTEN before the file) and
// answers an attachment that no browser renders; the removal takes the object first and is
// audited before and after; the person erasure removes the files' objects, then their rows,
// before the door, and stops when an object stays; the sweep removes what no row names and
// logs counts only; no answer carries an object path or a file's name into the audit log.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const FILE = '44444444-4444-4444-8444-444444444444';
const PATH = `${TENANT}/${CONTACT}/${FILE}.pdf`;

let auditOk = true;
let limited = false;
let rlsSeesFile = true;
let rlsSeesContact = true;
let storageOk = true;
let sessionRole = 'admin';
let liveProfile: Record<string, unknown> = { role: 'admin', is_active: true, locked_until: null };
let personFileRows: { id: string; object_path: string }[] = [];
let orphanNames: string[] = [];
const events: string[] = [];
const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const claims: { op: string; limits: unknown }[] = [];
const rpcCalls: { owner: string; fn: string; args: Record<string, unknown> }[] = [];
const uploads: { path: string; type: string; options: Record<string, unknown> }[] = [];
const removed: string[][] = [];
const logs: { level: string; source: string; message: string; detail?: unknown }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (
    _sb: unknown,
    _auth: unknown,
    entry: { action: string; entityId?: string; detail?: Record<string, unknown> },
  ) => {
    events.push(`audit:${entry.action}`);
    audits.push(entry);
    return auditOk;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: { level: string; source: string; message: string }) => {
    logs.push(entry);
    return true;
  },
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_a: unknown, op: string, limits?: unknown) => {
      events.push(`ops:${op}`);
      claims.push({ op, limits });
      if (limited) throw new RateLimitError(`${op}:user`);
    },
  };
});

const FILE_ROW = {
  id: FILE,
  contact_id: CONTACT,
  name: 'Huda contract.pdf',
  content_type: 'application/pdf',
  bytes: 1234,
  created_at: '2026-11-11T10:00:00Z',
  created_by: USER,
  // Poison: a staff read never answers this, and no response may carry it on.
  object_path: PATH,
};

function builder(table: string, owner: 'svc' | 'rls') {
  const b: Record<string, unknown> = {};
  for (const method of ['in', 'is', 'eq', 'order', 'limit', 'select']) b[method] = () => b;
  b['delete'] = () => {
    events.push(`${owner}:delete:${table}`);
    return b;
  };
  b['maybeSingle'] = async () => {
    events.push(`${owner}:${table}`);
    if (table === 'profiles') return { data: liveProfile, error: null };
    if (table === 'crm_contacts') {
      return { data: rlsSeesContact ? { id: CONTACT, merged_into: null } : null, error: null };
    }
    if (table === 'crm_contact_files') {
      if (owner === 'svc') return { data: { object_path: PATH }, error: null };
      return { data: rlsSeesFile ? FILE_ROW : null, error: null };
    }
    return { data: null, error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => {
    events.push(`${owner}:list:${table}`);
    let data: unknown[] = [];
    if (table === 'crm_contact_files') data = owner === 'svc' ? personFileRows : [FILE_ROW];
    if (table === 'crm_contacts') data = [];
    return Promise.resolve({ data, error: null }).then(ok);
  };
  return b;
}

function client(owner: 'svc' | 'rls') {
  return {
    from: (table: string) => builder(table, owner),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      events.push(`${owner}:rpc:${fn}`);
      rpcCalls.push({ owner, fn, args });
      if (fn === 'crm_file_orphans') {
        return { data: orphanNames.map((n) => ({ object_name: n })), error: null };
      }
      return rpcAnswers[fn] ?? { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob, options: Record<string, unknown>) => {
          events.push(`storage:upload:${bucket}`);
          uploads.push({ path, type: blob.type, options });
          return { error: storageOk ? null : { message: 'down' } };
        },
        remove: async (paths: string[]) => {
          events.push(`storage:remove:${bucket}`);
          removed.push(paths);
          return { error: storageOk ? null : { message: 'down' } };
        },
        download: async () => {
          events.push(`storage:download:${bucket}`);
          return { data: new Blob(['%PDF-1.4 ... %%EOF']), error: null };
        },
      }),
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => client('svc') }));

function ctx(request: Request, params: Record<string, string> = {}): APIContext {
  return {
    request,
    url: new URL(request.url),
    params: { id: CONTACT, ...params },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: sessionRole, email: 'a@x', isActive: true },
      supabase: client('rls'),
    },
  } as unknown as APIContext;
}

const BASE = `https://admin.example.test/api/admin/crm/contacts/${CONTACT}/files`;

/** A multipart upload as the browser sends it, with its Content-Length. */
async function uploadRequest(bytes: Uint8Array<ArrayBuffer> | string, name = 'Huda contract.pdf') {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'text/plain' }), 'whatever.txt');
  form.set('name', name);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return new Request(BASE, {
    method: 'POST',
    body,
    headers: {
      'content-type': encoded.headers.get('content-type') ?? '',
      'content-length': String(body.byteLength),
    },
  });
}

const PDF = '%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n';
function png(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(45);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  out.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  return out;
}
function webp(size = 30): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  const ascii = (s: string, at: number) =>
    out.set(
      [...s].map((c) => c.charCodeAt(0)),
      at,
    );
  ascii('RIFF', 0);
  new DataView(out.buffer).setUint32(4, size - 8, true);
  ascii('WEBP', 8);
  ascii('VP8 ', 12);
  return out;
}

const list = await import('@/pages/api/admin/crm/contacts/[id]/files');
const one = await import('@/pages/api/admin/crm/contacts/[id]/files/[fileId]');
const erase = await import('@/pages/api/admin/crm/contacts/[id]/erase');
const erasePreview = await import('@/pages/api/admin/crm/contacts/[id]/erase-preview');
const { sniffContactFile } = await import('@/lib/crm/fileSniff');
const { downloadName, CRM_FILE_UPLOAD_LIMITS, CRM_FILE_DOWNLOAD_LIMITS } =
  await import('@/lib/crm/files');
const { runCrmFileOrphanSweep, CRM_FILE_ORPHANS_JOB } = await import('@/lib/crm/fileOrphans');

beforeEach(() => {
  auditOk = true;
  limited = false;
  rlsSeesFile = true;
  rlsSeesContact = true;
  storageOk = true;
  sessionRole = 'admin';
  liveProfile = { role: 'admin', is_active: true, locked_until: null };
  personFileRows = [];
  orphanNames = [];
  events.length = 0;
  audits.length = 0;
  claims.length = 0;
  rpcCalls.length = 0;
  uploads.length = 0;
  removed.length = 0;
  logs.length = 0;
  rpcAnswers = {};
});

describe('the byte sniff', () => {
  it('takes a PDF, a PNG, a JPEG and a WebP by their bytes, whatever the browser said', async () => {
    expect(await sniffContactFile(new Blob([PDF]))).toEqual({ ok: true, kind: 'pdf' });
    expect(await sniffContactFile(new Blob([png()]))).toEqual({ ok: true, kind: 'png' });
    expect(
      await sniffContactFile(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])])),
    ).toEqual({ ok: true, kind: 'jpeg' });
    expect(await sniffContactFile(new Blob([webp()]))).toEqual({ ok: true, kind: 'webp' });
  });

  it('refuses an SVG, HTML, an empty file, a PNG without IHDR and a WebP with bytes after it', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expect(await sniffContactFile(new Blob([svg]))).toEqual({ ok: false, reason: 'unknown_type' });
    expect(await sniffContactFile(new Blob(['<html></html>']))).toEqual({
      ok: false,
      reason: 'unknown_type',
    });
    expect(await sniffContactFile(new Blob([]))).toEqual({ ok: false, reason: 'empty' });
    const bad = png();
    bad.set([0x58], 12);
    expect(await sniffContactFile(new Blob([bad]))).toEqual({
      ok: false,
      reason: 'image_structure',
    });
    const padded = new Uint8Array(40);
    padded.set(webp(30));
    expect(await sniffContactFile(new Blob([padded]))).toEqual({
      ok: false,
      reason: 'image_structure',
    });
  });

  it('refuses a PDF with no end (a truncated or disguised file)', async () => {
    expect(await sniffContactFile(new Blob(['%PDF-1.7 no end here']))).toEqual({
      ok: false,
      reason: 'pdf_structure',
    });
  });
});

describe('downloadName', () => {
  it('is an ASCII slug of the name with the kind’s own extension', () => {
    expect(downloadName('Huda contract v2.PDF', 'pdf')).toBe('Huda-contract-v2.pdf');
    expect(downloadName('brief.exe', 'pdf')).toBe('brief.pdf');
    expect(downloadName('عقد هدى', 'docx')).toBe('file.docx');
    expect(downloadName('a"b\r\nSet-Cookie: x', 'png')).toBe('a-b-Set-Cookie-x.png');
  });
});

describe('GET /[id]/files', () => {
  it('reads the contact, then its files, as the caller; never an object path', async () => {
    const res = await list.GET(ctx(new Request(BASE)));
    expect(res.status).toBe(200);
    expect(events.slice(0, 2)).toEqual(['rls:crm_contacts', 'rls:list:crm_contact_files']);
    const text = await res.text();
    expect(text).not.toContain('object_path');
    expect(text).not.toContain(TENANT + '/');
    expect(audits).toEqual([
      expect.objectContaining({ action: 'crm.file.list', entityId: CONTACT, detail: { files: 1 } }),
    ]);
  });

  it('is a 404 for a contact the caller cannot see, before any file is read', async () => {
    rlsSeesContact = false;
    const res = await list.GET(ctx(new Request(BASE)));
    expect(res.status).toBe(404);
    expect(events).toEqual(['rls:crm_contacts']);
  });
});

describe('POST /[id]/files (upload)', () => {
  it('runs its order: live recheck, the contact, the sniff, the slot, the object, the door', async () => {
    rpcAnswers['crm_file_add'] = { data: { ...FILE_ROW }, error: null };
    const res = await list.POST(ctx(await uploadRequest(PDF)));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'rls:crm_contacts',
      'ops:crm-file-upload',
      'storage:upload:crm-files',
      'svc:rpc:crm_file_add',
      'audit:crm.file.upload',
    ]);
    expect(claims[0]!.limits).toBe(CRM_FILE_UPLOAD_LIMITS);
    // The sniffed type, never the browser's text/plain; a path of ids, never the name.
    expect(uploads[0]!.type).toBe('application/pdf');
    expect(uploads[0]!.options['contentType']).toBe('application/pdf');
    expect(uploads[0]!.options['upsert']).toBe(false);
    const path = uploads[0]!.path;
    expect(path).toMatch(
      new RegExp(
        `^${TENANT}/${CONTACT}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`,
      ),
    );
    const args = rpcCalls[0]!.args;
    expect(args['p_actor']).toBe(USER);
    expect(args['p_file']).toEqual({
      id: path.split('/')[2]!.replace('.pdf', ''),
      object_path: path,
      name: 'Huda contract.pdf',
      content_type: 'application/pdf',
      bytes: PDF.length,
    });
    // The audit row: ids, the kind and the size; never the name.
    expect(JSON.stringify(audits)).not.toContain('Huda');
    expect(audits[0]!.detail).toEqual({ file: FILE, kind: 'pdf', bytes: 1234 });
    const body = await res.text();
    expect(body).not.toContain('object_path');
  });

  it('refuses a file its bytes do not make one of the five, before a slot or the bucket', async () => {
    const res = await list.POST(ctx(await uploadRequest('<svg><script>x</script></svg>')));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'Add a PDF, a Word document (.docx) or a PNG, JPEG or WebP image.',
    );
    expect(claims).toEqual([]);
    expect(uploads).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a name with a slash (422) before the sniff', async () => {
    const res = await list.POST(ctx(await uploadRequest(PDF, 'folder/secret.pdf')));
    expect(res.status).toBe(422);
    expect(uploads).toEqual([]);
  });

  it('refuses a body over 10 MB by its length, before the live recheck', async () => {
    const res = await list.POST(
      ctx(
        new Request(BASE, {
          method: 'POST',
          body: 'x',
          headers: { 'content-length': String(11 * 1024 * 1024) },
        }),
      ),
    );
    expect(res.status).toBe(413);
    expect(events).toEqual([]);
  });

  it('refuses a demoted Admin (live recheck) before the contact or the bucket', async () => {
    liveProfile = { role: 'content_creator', is_active: true, locked_until: null };
    const res = await list.POST(ctx(await uploadRequest(PDF)));
    expect(res.status).toBe(403);
    expect(events).toEqual(['svc:profiles']);
  });

  it('is a 429 past the day’s limit, before the bucket', async () => {
    limited = true;
    const res = await list.POST(ctx(await uploadRequest(PDF)));
    expect(res.status).toBe(429);
    expect(uploads).toEqual([]);
  });

  it('removes the object again when the door refuses the row (a tombstone, the ceiling)', async () => {
    rpcAnswers['crm_file_add'] = {
      data: null,
      error: { code: '23514', message: 'crm_contact_files_cap: a contact keeps up to 20 files' },
    };
    const res = await list.POST(ctx(await uploadRequest(PDF)));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'A contact keeps up to 20 files. Remove one before adding another.',
    );
    expect(removed).toEqual([[uploads[0]!.path]]);
    expect(audits).toEqual([]);

    rpcAnswers['crm_file_add'] = { data: null, error: { code: 'P0002' } };
    removed.length = 0;
    uploads.length = 0;
    const gone = await list.POST(ctx(await uploadRequest(PDF)));
    expect(gone.status).toBe(404);
    expect(removed).toEqual([[uploads[0]!.path]]);
  });

  it('writes no row when the bucket refuses the object', async () => {
    storageOk = false;
    const res = await list.POST(ctx(await uploadRequest(PDF)));
    expect(res.status).toBe(502);
    expect(rpcCalls).toEqual([]);
  });
});

describe('GET /[id]/files/[fileId] (download)', () => {
  const req = () => new Request(`${BASE}/${FILE}`);

  it('runs the CV order and answers an attachment no browser renders', async () => {
    const res = await one.GET(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:crm-file-download',
      'rls:crm_contact_files',
      'svc:crm_contact_files',
      'audit:crm.file.download',
      'storage:download:crm-files',
    ]);
    expect(claims[0]!.limits).toBe(CRM_FILE_DOWNLOAD_LIMITS);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Huda-contract.pdf"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(audits[0]!.detail).toEqual({ file: FILE, kind: 'pdf', bytes: 1234 });
  });

  it('sends no file when its audit row cannot be written (fail-closed)', async () => {
    auditOk = false;
    const res = await one.GET(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(403);
    expect(events).not.toContain('storage:download:crm-files');
  });

  it('is a 404 for a file the caller cannot see, before its path or an audit row', async () => {
    rlsSeesFile = false;
    const res = await one.GET(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(404);
    expect(events).not.toContain('svc:crm_contact_files');
    expect(audits).toEqual([]);
  });

  it('refuses a demoted, switched-off or locked profile before anything is read', async () => {
    for (const profile of [
      { role: 'content_creator', is_active: true, locked_until: null },
      { role: 'admin', is_active: false, locked_until: null },
      { role: 'admin', is_active: true, locked_until: '2999-01-01T00:00:00Z' },
    ]) {
      liveProfile = profile;
      events.length = 0;
      const res = await one.GET(ctx(req(), { fileId: FILE }));
      expect(res.status).toBe(403);
      expect(events).toEqual(['svc:profiles']);
    }
  });

  it('is a 429 past the limit, before the row is read', async () => {
    limited = true;
    const res = await one.GET(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(429);
    expect(events).not.toContain('rls:crm_contact_files');
  });

  it('is a 404 for a file id that is not one', async () => {
    const res = await one.GET(ctx(req(), { fileId: 'not-an-id' }));
    expect(res.status).toBe(404);
    expect(events).toEqual([]);
  });
});

describe('DELETE /[id]/files/[fileId]', () => {
  const req = () => new Request(`${BASE}/${FILE}`, { method: 'DELETE' });

  it('audits the attempt, removes the object, then the row, then the outcome', async () => {
    rpcAnswers['crm_file_remove'] = { data: PATH, error: null };
    const res = await one.DELETE(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'rls:crm_contact_files',
      'svc:crm_contact_files',
      'audit:crm.file.delete.attempt',
      'storage:remove:crm-files',
      'svc:rpc:crm_file_remove',
      'audit:crm.file.delete.outcome',
    ]);
    expect(removed).toEqual([[PATH]]);
    expect(audits[1]!.detail).toEqual({ file: FILE, status: 'ok', code: null });
  });

  it('keeps the row when the object cannot be removed (the removal can be retried)', async () => {
    storageOk = false;
    const res = await one.DELETE(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(audits[1]!.detail).toEqual({ file: FILE, status: 'failed', code: 'storage' });
  });

  it('removes nothing when the attempt row is not written', async () => {
    auditOk = false;
    const res = await one.DELETE(ctx(req(), { fileId: FILE }));
    expect(res.status).toBe(403);
    expect(removed).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
});

describe('the person erasure takes the files first (C6’s route, C16’s step)', () => {
  const req = () =>
    new Request(`https://admin.example.test/api/admin/crm/contacts/${CONTACT}/erase`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'dsar' }),
      headers: { 'content-type': 'application/json' },
    });

  it('removes the objects, then the rows, then calls the door; counts the files', async () => {
    personFileRows = [
      { id: FILE, object_path: PATH },
      { id: 'f2', object_path: `${TENANT}/${CONTACT}/f2.png` },
    ];
    rpcAnswers['crm_erase_person'] = { data: { contacts: 1, leads: 0 }, error: null };
    const res = await erase.POST(ctx(req()));
    expect(res.status).toBe(200);
    const at = (e: string) => events.indexOf(e);
    expect(at('audit:crm.erase.attempt')).toBeLessThan(at('storage:remove:crm-files'));
    expect(at('storage:remove:crm-files')).toBeLessThan(at('svc:delete:crm_contact_files'));
    expect(at('svc:delete:crm_contact_files')).toBeLessThan(at('svc:rpc:crm_erase_person'));
    expect(removed).toEqual([[PATH, `${TENANT}/${CONTACT}/f2.png`]]);
    expect(audits.at(-1)!.detail).toMatchObject({ status: 'ok', files: 2 });
  });

  it('stops before the door when an object cannot be removed', async () => {
    personFileRows = [{ id: FILE, object_path: PATH }];
    storageOk = false;
    const res = await erase.POST(ctx(req()));
    expect(res.status).toBe(500);
    expect(rpcCalls.map((c) => c.fn)).not.toContain('crm_erase_person');
    expect(events).not.toContain('svc:delete:crm_contact_files');
    expect(audits.at(-1)!).toMatchObject({
      action: 'crm.erase.outcome',
      detail: { target: 'contact', status: 'failed', code: 'files' },
    });
  });

  it('the preview counts the person’s files', async () => {
    personFileRows = [{ id: FILE, object_path: PATH }];
    rpcAnswers['crm_erase_preview'] = { data: { leads: 1 }, error: null };
    const res = await erasePreview.POST(
      ctx(
        new Request(`https://admin.example.test/api/admin/crm/contacts/${CONTACT}/erase-preview`, {
          method: 'POST',
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { counts: Record<string, number> } };
    expect(body.data.counts['files']).toBe(1);
    expect(JSON.stringify(body)).not.toContain(PATH);
  });
});

describe('the sweep (cron:crm-file-orphans)', () => {
  it('removes what no row names and logs counts only, never a path', async () => {
    orphanNames = [PATH];
    expect(await runCrmFileOrphanSweep(client('svc') as never)).toEqual({
      found: 1,
      removed: 1,
      errors: [],
    });
    expect(rpcCalls[0]!.args).toEqual({ p_older_than_minutes: 60, p_limit: 100 });
    expect(removed).toEqual([[PATH]]);
    await CRM_FILE_ORPHANS_JOB.run();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(TENANT);
    expect(logs[0]!.source).toBe('cron:crm-file-orphans');
  });

  it('writes no line when there is nothing to do, and stays within its budget', async () => {
    await CRM_FILE_ORPHANS_JOB.run();
    expect(logs).toEqual([]);
    expect(CRM_FILE_ORPHANS_JOB.budget).toBe(4);
  });
});
