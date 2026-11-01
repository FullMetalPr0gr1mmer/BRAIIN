import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/contact held to the published forms config (Admin v2 E8): the server follows the
// config, never the client. LeadInputSchema stays the floor; the config only narrows it: a
// field the sending form does not ask (or the config hides) is dropped, a field it requires is
// a 422 when empty, and an unreadable config leaves the floor (the form fails open, EXC-004).

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** The published row: null = none, 'error' = unreadable, 'throw' = the client throws. */
let formRow: Record<string, unknown> | null | 'error' | 'throw' = null;
const inserts: Record<string, unknown>[] = [];
const formReads: { table: string; tenant: unknown }[] = [];
/** When each read starts and the limiter answers (CR9: the two reads run together). */
const events: string[] = [];
/** The limiter's count for this address (over 10 an hour is limited). */
let hits = 1;

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async () => {
      events.push('limit');
      // The limiter's round trip: a few turns of the event loop.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      events.push('limit-answered');
      return { data: hits, error: null };
    },
    from: (table: string) => {
      events.push(`read:${table}`);
      if (formRow === 'throw') throw new Error('socket closed');
      const read = { table, tenant: undefined as unknown };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (_col: string, value: unknown) => {
          read.tenant = value;
          return b;
        },
        maybeSingle: async () => {
          formReads.push(read);
          return formRow === 'error'
            ? { data: null, error: { message: 'down' } }
            : { data: formRow, error: null };
        },
      };
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/tenant', () => ({ resolveLaunchTenantId: async () => TENANT }));
vi.mock('@/lib/data/leads', () => ({
  createLead: async (input: Record<string, unknown>) => {
    inserts.push(input);
    return { ok: true };
  },
}));

const { POST } = await import('@/pages/api/contact');

const BASE = { name: 'Sam', email: 'sam@example.com', message: 'Hello there.' };

const send = (body: Record<string, unknown>) =>
  (POST as unknown as (c: { request: Request }) => Promise<Response>)({
    request: new Request('https://www.braiinstation.com/api/contact', {
      method: 'POST',
      headers: {
        host: 'www.braiinstation.com',
        origin: 'https://www.braiinstation.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  });

const inquiry = (config: Record<string, unknown>) => ({
  inquiry: config,
  application: {},
  consent_revision: 0,
});

beforeEach(() => {
  formRow = null;
  inserts.length = 0;
  formReads.length = 0;
  events.length = 0;
  hits = 1;
});

describe('POST /api/contact — the published forms config (Admin v2 E8)', () => {
  it('reads the config of the tenant it resolved, never one the visitor names', async () => {
    expect((await send({ ...BASE, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status).toBe(
      200,
    );
    expect(formReads).toEqual([{ table: 'form_settings', tenant: TENANT }]);
  });

  it('a field the config requires is a 422 naming its lead key when it is empty, and nothing is stored', async () => {
    formRow = inquiry({ fields: { phone: { required: true }, service: { required: true } } });
    // The services pages' form asks both.
    const res = await send({ ...BASE, form: 'hello' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'validation',
      fields: ['phone', 'serviceOfInterest'],
    });
    expect(inserts).toHaveLength(0);
    const ok = await send({
      ...BASE,
      form: 'hello',
      phone: '+966500000001',
      disciplineOfInterest: 'branding',
    });
    expect(ok.status).toBe(200);
    expect(inserts).toHaveLength(1);
  });

  it('a required field the sending form does not ask is not required of it (the home form has no phone)', async () => {
    formRow = inquiry({ fields: { phone: { required: true } } });
    expect((await send({ ...BASE, form: 'compact' })).status).toBe(200);
  });

  it('a field the config hides is dropped, never stored', async () => {
    formRow = inquiry({ fields: { company: { visible: false } } });
    expect((await send({ ...BASE, form: 'full', company: 'Acme' })).status).toBe(200);
    expect(inserts[0]).not.toHaveProperty('company');
  });

  it('a field the sending form does not ask is dropped (a crafted post)', async () => {
    expect((await send({ ...BASE, form: 'compact', budgetBand: 'gt_200k' })).status).toBe(200);
    expect(inserts[0]).not.toHaveProperty('budgetBand');
  });

  it('with no form named, a field is required only when every form asks it', async () => {
    formRow = inquiry({ fields: { phone: { required: true }, budget: { required: true } } });
    expect((await send(BASE)).status).toBe(200);
    // Every form asks the company.
    formRow = inquiry({ fields: { company: { required: true } } });
    const res = await send(BASE);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['company']);
  });

  it('the pipeline fields stay required whatever the config (the schema floor)', async () => {
    formRow = inquiry({ fields: { name: { visible: false } } });
    const res = await send({ email: 'sam@example.com', message: 'Hello there.', form: 'full' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { fields: string[] }).fields).toContain('name');
  });

  it('an unreadable config, or a client that throws, leaves the floor: the lead is stored', async () => {
    formRow = 'error';
    expect((await send({ ...BASE, form: 'full' })).status).toBe(200);
    formRow = 'throw';
    expect((await send({ ...BASE, form: 'full' })).status).toBe(200);
    expect(inserts).toHaveLength(2);
  });

  it('an unreadable config still drops what the sending form does not ask (minimisation never fails open)', async () => {
    for (const row of ['error', 'throw'] as const) {
      formRow = row;
      inserts.length = 0;
      const res = await send({
        ...BASE,
        form: 'compact',
        phone: '+966500000001',
        budgetBand: 'gt_200k',
        timelineText: 'next month',
        company: 'Acme',
      });
      expect(res.status).toBe(200);
      expect(inserts).toHaveLength(1);
      // The home form asks the company, never the phone, budget or deadline.
      expect(inserts[0]).toHaveProperty('company', 'Acme');
      expect(inserts[0]).not.toHaveProperty('phone');
      expect(inserts[0]).not.toHaveProperty('budgetBand');
      expect(inserts[0]).not.toHaveProperty('timelineText');
    }
  });

  it('a page drawn before a field became required still sends: the claim of what it showed as required narrows the config (CR1)', async () => {
    formRow = inquiry({ fields: { budget: { required: true } } });
    // Contact's form, drawn when the budget was optional: it showed nothing as required.
    const stale = await send({ ...BASE, form: 'full', requiredFields: [] });
    expect(stale.status).toBe(200);
    expect(inserts[0]).not.toHaveProperty('requiredFields');
    // Drawn under this config: it showed the budget as required, and the send must answer it.
    const fresh = await send({ ...BASE, form: 'full', requiredFields: ['budget'] });
    expect(fresh.status).toBe(422);
    expect(((await fresh.json()) as { fields: string[] }).fields).toEqual(['budgetBand']);
    // No claim (a page from before it, or a hand-made post): the config decides alone.
    expect((await send({ ...BASE, form: 'full' })).status).toBe(422);
    // A claim never requires what the config does not, and names it does not know are ignored.
    formRow = inquiry({});
    expect(
      (await send({ ...BASE, form: 'full', requiredFields: ['budget', 'favourite colour'] }))
        .status,
    ).toBe(200);
    expect(inserts).toHaveLength(2);
  });

  it('the config is read while the limiter answers, and a limited send is still a 429 (CR9)', async () => {
    expect((await send({ ...BASE, form: 'full' })).status).toBe(200);
    expect(events.indexOf('read:form_settings')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('read:form_settings')).toBeLessThan(events.indexOf('limit-answered'));
    hits = 11;
    formRow = inquiry({ fields: { budget: { required: true } } });
    const limited = await send({ ...BASE, form: 'full' });
    expect(limited.status).toBe(429);
    expect(inserts).toHaveLength(1);
  });

  it('a form the schema does not know is refused (422 names form)', async () => {
    const res = await send({ ...BASE, form: 'sidebar' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['form']);
  });
});
