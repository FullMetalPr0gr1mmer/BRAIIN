import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';
import { TaskCreateSchema, TaskPatchSchema } from '@schemas/crmTasks';

// The tasks API (Admin v2 C8, crm.md §9 and §13): every route reads and writes as the caller
// through the INVOKER functions, naming the caller's tenant; the answers are cut to the named
// task fields; an edit carries its version, a tick does not; a refusal maps to its status and
// never the database's text; audit rows carry ids, the type and field names, never the words;
// the calendar file is an attachment, no-store and nosniff, with the title and the admin link
// only, its brand the tenant's.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';

const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};
let taskRow: Record<string, unknown> | null = null;
let brand: unknown = { en: 'Studio Name', ar: 'اسم' };
const fromCalls: { table: string; eqs: [string, unknown][] }[] = [];

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/data/siteProfile', () => ({
  getSiteProfile: async () => ({ brandName: { en: 'Fallback Brand', ar: 'x' } }),
}));
vi.mock('astro:env/client', () => ({ PUBLIC_SITE_URL: 'https://www.example.test' }));

/** A task as the database answers it, with a field no answer may pass on. */
const ROW = {
  id: TASK,
  title: 'Call Huda',
  type: 'call',
  note: 'Bring the samples',
  due_at: '2026-11-11T07:00:00+00:00',
  due_date: '2026-11-11',
  due_time: '10:00',
  done_at: null,
  owner_id: USER,
  contact_id: CONTACT,
  contact_name: 'Huda Saleh',
  contact_company: 'Acme',
  lead_id: null,
  lead_number: null,
  lead_name: null,
  version: 2,
  created_at: '2026-11-10T10:00:00+00:00',
  email_enc: 'enc:huda@acme.sa',
};

function client() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcAnswers[fn] ?? { data: null, error: null };
    },
    from: (table: string) => {
      const call = { table, eqs: [] as [string, unknown][] };
      fromCalls.push(call);
      const builder: Record<string, unknown> = {};
      builder['select'] = () => builder;
      builder['eq'] = (column: string, value: unknown) => {
        call.eqs.push([column, value]);
        return builder;
      };
      builder['maybeSingle'] = async () =>
        table === 'site_profile'
          ? { data: brand === undefined ? null : { brand_name: brand }, error: null }
          : { data: taskRow, error: null };
      return builder;
    },
  };
}

function ctx(path: string, method = 'GET', body?: unknown): APIContext {
  const url = new URL(`https://admin.example.test${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: TASK },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', email: 'a@x', isActive: true },
      supabase: client(),
    },
  } as unknown as APIContext;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  audits.length = 0;
  rpcCalls.length = 0;
  fromCalls.length = 0;
  rpcAnswers = {};
  taskRow = null;
  brand = { en: 'Studio Name', ar: 'اسم' };
});

describe('GET /api/admin/crm/tasks', () => {
  it('reads the groups as the caller, for the caller’s tenant, cut to the named fields', async () => {
    const { GET } = await import('@/pages/api/admin/crm/tasks/index');
    rpcAnswers['crm_tasks_grouped'] = {
      data: {
        tz: 'Asia/Riyadh',
        now: '2026-11-10T12:00:00+00:00',
        today: '2026-11-10',
        counts: { overdue: 1, today: 0, upcoming: 0, done: 0 },
        mine_open: 1,
        overdue: [ROW],
        today_tasks: [],
        upcoming: [],
        done: [],
        extra: 'dropped',
      },
      error: null,
    };
    const res = await GET(ctx(`/api/admin/crm/tasks?view=mine&contact=${CONTACT}`));
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([
      {
        fn: 'crm_tasks_grouped',
        args: { p_tenant: TENANT, p_filter: { view: 'mine', contact: CONTACT } },
      },
    ]);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'counts',
        'done',
        'dueToday',
        'mineOpen',
        'now',
        'overdue',
        'today',
        'tz',
        'upcoming',
      ].sort(),
    );
    const first = (data['overdue'] as Record<string, unknown>[])[0]!;
    expect(first['email_enc']).toBeUndefined();
    expect(first['contact_name']).toBe('Huda Saleh');
    expect(audits).toEqual([]);
  });

  it('refuses an unknown filter before the database (422)', async () => {
    const { GET } = await import('@/pages/api/admin/crm/tasks/index');
    const res = await GET(ctx('/api/admin/crm/tasks?q=sara'));
    expect(res.status).toBe(422);
    expect(rpcCalls).toEqual([]);
  });

  it('maps a database refusal to a 403, never quoting it', async () => {
    const { GET } = await import('@/pages/api/admin/crm/tasks/index');
    rpcAnswers['crm_tasks_grouped'] = {
      data: null,
      error: { code: '42501', message: 'permission denied for table crm_tasks' },
    };
    const res = await GET(ctx('/api/admin/crm/tasks'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await json(res))).not.toContain('crm_tasks');
  });
});

describe('POST /api/admin/crm/tasks', () => {
  it('sends the local date and time in the database’s names and audits ids and the type only', async () => {
    const { POST } = await import('@/pages/api/admin/crm/tasks/index');
    rpcAnswers['crm_task_create'] = { data: ROW, error: null };
    const res = await POST(
      ctx('/api/admin/crm/tasks', 'POST', {
        title: '  Call Huda  ',
        type: 'call',
        dueDate: '2026-11-11',
        dueTime: '10:00',
        contactId: CONTACT,
        ownerId: USER,
        note: '',
      }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0]).toEqual({
      fn: 'crm_task_create',
      args: {
        p_tenant: TENANT,
        p_task: {
          title: 'Call Huda',
          type: 'call',
          due_date: '2026-11-11',
          due_time: '10:00',
          contact_id: CONTACT,
          owner_id: USER,
          note: null,
        },
      },
    });
    expect(audits).toEqual([
      {
        action: 'crm.task.create',
        entityType: 'task',
        entityId: TASK,
        detail: { type: 'call', contact: CONTACT, mine: true },
      },
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/Huda|samples/);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(data['email_enc']).toBeUndefined();
  });

  it('says which field the owner rule refused (422 on ownerId)', async () => {
    const { POST } = await import('@/pages/api/admin/crm/tasks/index');
    rpcAnswers['crm_task_create'] = {
      data: null,
      error: {
        code: '23514',
        message:
          'the owner must be an active tasks user of this tenant (constraint "crm_tasks_owner_active")',
      },
    };
    const res = await POST(
      ctx('/api/admin/crm/tasks', 'POST', { title: 'x', dueDate: '2026-11-11', dueTime: '10:00' }),
    );
    expect(res.status).toBe(422);
    expect((await json(res))['field']).toBe('ownerId');
    expect(audits).toEqual([]);
  });

  it('refuses a missing time, an unknown key and a bad date before the database', async () => {
    const { POST } = await import('@/pages/api/admin/crm/tasks/index');
    for (const body of [
      { title: 'x', dueDate: '2026-11-11' },
      { title: 'x', dueDate: '2026-11-11', dueTime: '10:00', colour: 'red' },
      { title: 'x', dueDate: '2026-02-30', dueTime: '10:00' },
      { title: 'x', dueDate: '2026-11-11', dueTime: '24:00' },
      { title: '   ', dueDate: '2026-11-11', dueTime: '10:00' },
    ]) {
      const res = await POST(ctx('/api/admin/crm/tasks', 'POST', body));
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(rpcCalls).toEqual([]);
  });
});

describe('PATCH /api/admin/crm/tasks/[id]', () => {
  it('a tick is unversioned: p_version null, the field names audited', async () => {
    const { PATCH } = await import('@/pages/api/admin/crm/tasks/[id]');
    rpcAnswers['crm_task_update'] = {
      data: { ...ROW, done_at: '2026-11-10T12:00:00Z' },
      error: null,
    };
    const res = await PATCH(ctx(`/api/admin/crm/tasks/${TASK}`, 'PATCH', { done: true }));
    expect(res.status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_task: TASK,
      p_version: null,
      p_patch: { done: true },
    });
    expect(audits[0]).toEqual({
      action: 'crm.task.update',
      entityType: 'task',
      entityId: TASK,
      detail: { fields: ['done'], done: true },
    });
  });

  it('an edit or a snooze needs the version read (422 before the database)', async () => {
    const { PATCH } = await import('@/pages/api/admin/crm/tasks/[id]');
    for (const body of [{ title: 'New' }, { snooze: 'tomorrow_10' }, { dueDate: '2026-11-12' }]) {
      const res = await PATCH(ctx(`/api/admin/crm/tasks/${TASK}`, 'PATCH', body));
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(rpcCalls).toEqual([]);
  });

  it('a moved version is a 409, an unseen task a 404, a stale token a 403', async () => {
    const { PATCH } = await import('@/pages/api/admin/crm/tasks/[id]');
    for (const [code, status] of [
      ['40001', 409],
      ['P0002', 404],
      ['42501', 403],
    ] as const) {
      rpcAnswers['crm_task_update'] = { data: null, error: { code, message: 'x' } };
      const res = await PATCH(
        ctx(`/api/admin/crm/tasks/${TASK}`, 'PATCH', { version: 2, snooze: 'tomorrow_10' }),
      );
      expect(res.status, code).toBe(status);
    }
    expect(audits).toEqual([]);
  });

  it('sends the snooze for the database to work out, with the version', async () => {
    const { PATCH } = await import('@/pages/api/admin/crm/tasks/[id]');
    rpcAnswers['crm_task_update'] = { data: ROW, error: null };
    await PATCH(
      ctx(`/api/admin/crm/tasks/${TASK}`, 'PATCH', { version: 2, snooze: 'tomorrow_10' }),
    );
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_task: TASK,
      p_version: 2,
      p_patch: { snooze: 'tomorrow_10' },
    });
  });

  it('a task id that is not one is a 404 before the database', async () => {
    const { PATCH } = await import('@/pages/api/admin/crm/tasks/[id]');
    const c = ctx('/api/admin/crm/tasks/nope', 'PATCH', { done: true });
    (c as unknown as { params: Record<string, string> }).params = { id: 'nope' };
    const res = await PATCH(c);
    expect(res.status).toBe(404);
    expect(rpcCalls).toEqual([]);
  });
});

describe('DELETE /api/admin/crm/tasks/[id]', () => {
  it('removes at the version read and audits what it was about, by id', async () => {
    const { DELETE } = await import('@/pages/api/admin/crm/tasks/[id]');
    rpcAnswers['crm_task_delete'] = {
      data: { contact_id: CONTACT, lead_id: null, done: false },
      error: null,
    };
    const res = await DELETE(ctx(`/api/admin/crm/tasks/${TASK}`, 'DELETE', { version: 3 }));
    expect(res.status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_task: TASK, p_version: 3 });
    expect(audits[0]).toEqual({
      action: 'crm.task.delete',
      entityType: 'task',
      entityId: TASK,
      detail: { contact: CONTACT, done: false },
    });
  });

  it('needs the version', async () => {
    const { DELETE } = await import('@/pages/api/admin/crm/tasks/[id]');
    const res = await DELETE(ctx(`/api/admin/crm/tasks/${TASK}`, 'DELETE', {}));
    expect(res.status).toBe(422);
    expect(rpcCalls).toEqual([]);
  });
});

describe('GET /api/admin/crm/tasks/[id]/ics', () => {
  it('is a calendar attachment, no-store and nosniff, read as the caller in the caller’s tenant', async () => {
    const { GET } = await import('@/pages/api/admin/crm/tasks/[id]/ics');
    taskRow = { id: TASK, title: 'Call Huda, about the logo', due_at: '2026-11-11T07:00:00+00:00' };
    const res = await GET(ctx(`/api/admin/crm/tasks/${TASK}/ics`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="call-huda-about-the-logo.ics"',
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const task = fromCalls.find((c) => c.table === 'crm_tasks')!;
    expect(task.eqs).toEqual([
      ['tenant_id', TENANT],
      ['id', TASK],
    ]);
    // Unfolded (RFC 5545 folds a long line with CRLF and a space).
    const body = (await res.text()).replace(/\r\n /g, '');
    expect(body).toContain(`UID:${TASK}@www.example.test`);
    expect(body).toContain('PRODID:-//Studio Name//Admin//EN');
    expect(body).toContain(`DESCRIPTION:https://www.example.test/admin/tasks#task-${TASK}`);
    expect(body).toContain('SUMMARY:Call Huda\\, about the logo');
    expect(audits).toEqual([{ action: 'crm.task.ics', entityType: 'task', entityId: TASK }]);
  });

  it('falls back to the public brand when the tenant’s cannot be read', async () => {
    const { GET } = await import('@/pages/api/admin/crm/tasks/[id]/ics');
    taskRow = { id: TASK, title: 'x', due_at: '2026-11-11T07:00:00+00:00' };
    brand = undefined;
    const body = await (await GET(ctx(`/api/admin/crm/tasks/${TASK}/ics`))).text();
    expect(body).toContain('PRODID:-//Fallback Brand//Admin//EN');
  });

  it('is a 404 for a task the caller does not see, and audits nothing', async () => {
    const { GET } = await import('@/pages/api/admin/crm/tasks/[id]/ics');
    taskRow = null;
    const res = await GET(ctx(`/api/admin/crm/tasks/${TASK}/ics`));
    expect(res.status).toBe(404);
    expect(audits).toEqual([]);
  });
});

describe('the schemas', () => {
  it('a new task needs a title, a real date and a time; types are the closed list', () => {
    expect(
      TaskCreateSchema.safeParse({ title: 'x', dueDate: '2026-11-11', dueTime: '09:30' }).success,
    ).toBe(true);
    expect(
      TaskCreateSchema.safeParse({
        title: 'x',
        dueDate: '2026-11-11',
        dueTime: '09:30',
        type: 'fax',
      }).success,
    ).toBe(false);
    expect(
      TaskCreateSchema.safeParse({ title: 'x', dueDate: '1999-12-31', dueTime: '09:30' }).success,
    ).toBe(false);
    expect(
      TaskCreateSchema.safeParse({ title: 'a\u0007b', dueDate: '2026-11-11', dueTime: '09:30' })
        .success,
    ).toBe(false);
  });

  it('a change: a tick alone needs no version; a date needs its time; snooze excludes a date', () => {
    expect(TaskPatchSchema.safeParse({ done: false }).success).toBe(true);
    expect(TaskPatchSchema.safeParse({}).success).toBe(false);
    expect(TaskPatchSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(TaskPatchSchema.safeParse({ version: 1, dueDate: '2026-11-11' }).success).toBe(false);
    expect(
      TaskPatchSchema.safeParse({
        version: 1,
        snooze: 'tomorrow_10',
        dueDate: '2026-11-11',
        dueTime: '10:00',
      }).success,
    ).toBe(false);
    expect(TaskPatchSchema.safeParse({ version: 1, snooze: 'next_week' }).success).toBe(false);
    expect(TaskPatchSchema.safeParse({ version: 1, note: 'line one\nline two' }).success).toBe(
      true,
    );
  });
});
