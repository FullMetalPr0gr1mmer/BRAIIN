import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';
import {
  ContactCustomSchema,
  CrmSettingsSaveSchema,
  CUSTOM_FIELD_KEY,
  CUSTOM_FIELD_TYPES,
  CustomFieldsSaveSchema,
  MAX_CUSTOM_FIELD_LABEL,
  MAX_CUSTOM_FIELDS,
  MAX_CUSTOM_NUMBER,
  MAX_CUSTOM_TEXT,
  type CustomFieldDefinition,
} from '@schemas/crm';
import { ValidationError } from '@/lib/admin/errors';
import {
  isCustomDate,
  mergeCustom,
  parseCustomFields,
  validateCustomValues,
} from '@/lib/crm/contactCustom';
import { customFieldsChange } from '@/lib/crm/settings';
import { CONTACT_STAGE_LABELS, CONTACT_STAGE_TONES } from '@/lib/crm/contactView';
import {
  CONTACT_STAGE_COPY,
  CUSTOM_LIMITS,
  FIELD_KEY,
  FIELD_TYPE_NAMES,
  keyFromLabel,
  retentionLine,
} from '@/components/admin/screens/crmSettings/copy';
import {
  fieldDrafts,
  fieldsPayload,
  fieldsProblem,
  removedFields,
  removeQuestion,
  type FieldDraft,
} from '@/components/admin/screens/crmSettings/CustomFieldsCard';
import { foundWords } from '@/components/admin/screens/crmSettings/EraseFinder';
import {
  CUSTOM_LIMITS as FORM_LIMITS,
  customErrors,
  customFormValues,
  customPatch,
} from '@/components/admin/screens/contacts/customFields';

// Custom contact fields (Admin v2 C9b, crm.md §4.7, §5.1, "CRM-9"). Held here: the schemas and
// the screens' own copies of the limits against the C9b migration's CHECK and value trigger;
// the Worker's value check and merge; what the settings route reads, writes and records (counts,
// never a label, a key or a value); the contact routes checking values against the tenant's
// definitions before anything is written, and laying a change over what is stored; the screens'
// own rules. RLS, the grants and the triggers are proven in pgTAP
// (supabase/tests/crm_custom_fields.test.sql).

const MIGRATION = (() => {
  const dir = 'supabase/migrations';
  const file = readdirSync(dir).find((f) => /_crm_custom_fields\.sql$/.test(f));
  if (!file) throw new Error('no C9b migration');
  return readFileSync(`${dir}/${file}`, 'utf8');
})();
const source = (path: string) => readFileSync(path, 'utf8');

const FIELDS: CustomFieldDefinition[] = [
  { key: 'industry_note', label: 'Industry note', type: 'text' },
  { key: 'renewal', label: 'Renewal date', type: 'date' },
  { key: 'seats', label: 'Seats', type: 'number' },
];

describe('the vocabularies equal the database (the C9b migration)', () => {
  it('the types, the count, the key and the label are the CHECK’s', () => {
    const check = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function app.crm_custom_fields_ok'),
      MIGRATION.indexOf('alter table public.crm_settings'),
    );
    expect(check).toContain(`jsonb_array_length(p) <= ${MAX_CUSTOM_FIELDS}`);
    expect(check).toContain(
      `(e ->> 'type') not in (${CUSTOM_FIELD_TYPES.map((t) => `'${t}'`).join(', ')})`,
    );
    expect(check).toContain(`(e ->> 'key') !~ '${CUSTOM_FIELD_KEY.source}'`);
    expect(check).toContain(
      `char_length(e ->> 'label') not between 1 and ${MAX_CUSTOM_FIELD_LABEL}`,
    );
  });

  it('the value bounds are the trigger’s', () => {
    const trigger = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function app.tg_crm_contact_custom'),
    );
    expect(trigger).toContain(`char_length(r.value #>> '{}') <= ${MAX_CUSTOM_TEXT}`);
    expect(MAX_CUSTOM_NUMBER).toBe(1e15);
    expect(trigger).toContain("abs((r.value #>> '{}')::numeric) <= 1e15");
  });

  it('the screens’ own copies equal the schema’s (they import none of it at run time)', () => {
    expect(CUSTOM_LIMITS.maxFields).toBe(MAX_CUSTOM_FIELDS);
    expect(CUSTOM_LIMITS.maxLabel).toBe(MAX_CUSTOM_FIELD_LABEL);
    expect(FIELD_KEY.source).toBe(CUSTOM_FIELD_KEY.source);
    expect(Object.keys(FIELD_TYPE_NAMES)).toEqual([...CUSTOM_FIELD_TYPES]);
    expect(FORM_LIMITS.maxText).toBe(MAX_CUSTOM_TEXT);
    expect(FORM_LIMITS.maxNumber).toBe(MAX_CUSTOM_NUMBER);
    for (const f of ['CustomFieldsCard', 'ContactStagesCard', 'PrivacyCard', 'EraseFinder']) {
      const text = source(`src/components/admin/screens/crmSettings/${f}.tsx`);
      expect(text, f).not.toMatch(/^import (?!type)[^;]*from '@schemas\/crm'/m);
    }
  });

  it('the contact stages’ words and tones are the contact screens’', () => {
    expect(CONTACT_STAGE_COPY.map((s) => s.stage)).toEqual(Object.keys(CONTACT_STAGE_LABELS));
    for (const { stage, label, tone } of CONTACT_STAGE_COPY) {
      expect(label).toBe(CONTACT_STAGE_LABELS[stage]);
      expect(tone).toBe(CONTACT_STAGE_TONES[stage]);
    }
  });
});

describe('the schemas', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `f${i}`, label: `Field ${i}`, type: 'text' }));

  it('a set: at most 12, each key once, exactly {key, label, type} of text, number or date', () => {
    expect(CustomFieldsSaveSchema.safeParse(FIELDS).success).toBe(true);
    expect(CustomFieldsSaveSchema.safeParse(many(12)).success).toBe(true);
    expect(CustomFieldsSaveSchema.safeParse(many(13)).success).toBe(false);
    for (const bad of [
      [FIELDS[0], { ...FIELDS[1], key: 'industry_note' }],
      [{ ...FIELDS[0], type: 'select' }],
      [{ ...FIELDS[0], type: 'boolean' }],
      [{ ...FIELDS[0], options: ['a'] }],
      [{ ...FIELDS[0], key: 'Industry' }],
      [{ ...FIELDS[0], key: '1st' }],
      [{ ...FIELDS[0], label: '   ' }],
      [{ ...FIELDS[0], label: 'x'.repeat(61) }],
      [{ ...FIELDS[0], label: 'two\nlines' }],
    ]) {
      expect(CustomFieldsSaveSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a settings save may carry the fields alone, at a version', () => {
    expect(CrmSettingsSaveSchema.safeParse({ version: 2, customFields: [] }).success).toBe(true);
    expect(CrmSettingsSaveSchema.safeParse({ version: 2, customFields: FIELDS }).success).toBe(
      true,
    );
    expect(CrmSettingsSaveSchema.safeParse({ customFields: FIELDS }).success).toBe(false);
  });

  it('a value is a short text, a number or null; never a yes or no or an object', () => {
    expect(ContactCustomSchema.safeParse({ a: 'x', b: 2, c: null }).success).toBe(true);
    expect(ContactCustomSchema.safeParse({ a: true }).success).toBe(false);
    expect(ContactCustomSchema.safeParse({ a: { b: 1 } }).success).toBe(false);
    expect(ContactCustomSchema.safeParse({ a: 'x'.repeat(MAX_CUSTOM_TEXT + 1) }).success).toBe(
      false,
    );
  });
});

describe('the Worker’s value check and merge', () => {
  it('a date is a real calendar day written YYYY-MM-DD', () => {
    expect(isCustomDate('2028-02-29')).toBe(true);
    expect(isCustomDate('2027-02-29')).toBe(false);
    expect(isCustomDate('2027-2-1')).toBe(false);
    expect(isCustomDate('01/03/2027')).toBe(false);
  });

  it('refuses a value no field has, naming it; and a value of the wrong kind, naming the field', () => {
    const err = (values: Record<string, unknown>) => {
      try {
        validateCustomValues(FIELDS, values as never);
        return null;
      } catch (e) {
        return e as ValidationError;
      }
    };
    expect(err({ nope: 'x' })?.detail).toBe('There is no custom field called nope.');
    expect(err({ seats: 'ten' })?.detail).toBe('Seats: enter a number.');
    expect(err({ renewal: '2027-02-30' })?.detail).toBe('Renewal date: enter a date.');
    expect(err({ seats: 2e15 })?.detail).toBe('Seats: that number is too large.');
    expect(err({ industry_note: 'a\tb' })?.detail).toBe('Industry note: keep it to one line.');
    expect(err({ seats: 3, renewal: null, industry_note: 'Retail' })).toBeNull();
  });

  it('a change is laid over what is stored: set what is sent, clear a null or an empty text', () => {
    expect(mergeCustom({ seats: 3, renewal: '2027-01-31' }, { seats: 4, renewal: null })).toEqual({
      seats: 4,
    });
    expect(mergeCustom({ industry_note: 'x' }, { industry_note: '  ' })).toEqual({});
    expect(mergeCustom({ industry_note: 'x' }, { seats: 2 })).toEqual({
      industry_note: 'x',
      seats: 2,
    });
    expect(mergeCustom(null, { industry_note: ' Retail ' })).toEqual({ industry_note: 'Retail' });
  });

  it('reads the definitions leniently: a field that does not parse, or a key twice, is left out', () => {
    expect(
      parseCustomFields([
        ...FIELDS,
        { key: 'seats', label: 'Again', type: 'text' },
        { key: 'x', label: 'X', type: 'select' },
        'nonsense',
      ]),
    ).toEqual(FIELDS);
    expect(parseCustomFields(null)).toEqual([]);
    expect(parseCustomFields({ key: 'a' })).toEqual([]);
  });
});

describe('the settings card’s rules', () => {
  const drafts = (list: Partial<FieldDraft>[]): FieldDraft[] =>
    list.map((d, i) => ({
      local: `l${i}`,
      key: `k${i}`,
      label: `Label ${i}`,
      type: 'text',
      saved: false,
      keyTyped: false,
      ...d,
    }));

  it('a key from a label: snake_case, a letter first, unique, a number for a label with none', () => {
    expect(keyFromLabel('Renewal date', new Set(), 1)).toBe('renewal_date');
    expect(keyFromLabel('2nd phone', new Set(), 1)).toBe('field_2nd_phone');
    expect(keyFromLabel('تاريخ التجديد', new Set(), 3)).toBe('field_3');
    expect(keyFromLabel('Renewal date', new Set(['renewal_date']), 1)).toBe('renewal_date_2');
    const long = keyFromLabel('a'.repeat(80), new Set(['a'.repeat(40)]), 1);
    expect(long).toMatch(FIELD_KEY);
    expect(long).toHaveLength(40);
    expect(long.endsWith('_2')).toBe(true);
  });

  it('says what stops a set before the server does', () => {
    expect(fieldsProblem(drafts([{}, {}]))).toBeNull();
    expect(fieldsProblem(drafts([{ label: ' ' }]))).toBe('Every field needs a label.');
    expect(fieldsProblem(drafts([{ key: 'Bad Key' }]))).toMatch(/lower-case letters/);
    expect(fieldsProblem(drafts([{ key: 'same' }, { key: 'same' }]))).toBe(
      'Each field needs its own key.',
    );
    expect(fieldsProblem(drafts(Array.from({ length: 13 }, (_, i) => ({ key: `k${i}` }))))).toBe(
      'Up to 12 custom fields.',
    );
  });

  it('names the saved fields a save removes, and asks before it deletes their values', () => {
    const loaded = FIELDS;
    const kept = fieldDrafts(loaded).filter((d) => d.key !== 'seats');
    // A new field reusing a removed key does not keep the old values: it is still a removal.
    const reused = [...kept, ...drafts([{ key: 'seats', type: 'text' }])];
    expect(removedFields(loaded, reused).map((f) => f.key)).toEqual(['seats']);
    expect(removedFields(loaded, fieldDrafts(loaded))).toEqual([]);
    expect(removeQuestion([FIELDS[2]!])).toBe(
      'Remove Seats? What every contact holds in it is deleted. This cannot be undone.',
    );
    expect(removeQuestion(FIELDS.slice(1))).toMatch(/^Remove Renewal date, Seats\? .* in them /);
  });

  it('the payload is the set in order, labels trimmed, valid for the schema', () => {
    const payload = fieldsPayload([
      ...fieldDrafts(FIELDS),
      ...drafts([{ key: 'tier', label: ' Tier ', type: 'number' }]),
    ]);
    expect(payload.at(-1)).toEqual({ key: 'tier', label: 'Tier', type: 'number' });
    expect(CustomFieldsSaveSchema.safeParse(payload).success).toBe(true);
  });

  it('saved fields come back with their key and type fixed', () => {
    expect(fieldDrafts(FIELDS).every((d) => d.saved && d.keyTyped)).toBe(true);
  });
});

describe('the contact forms’ rules', () => {
  it('starts from what the contact holds, as text', () => {
    expect(customFormValues(FIELDS, { seats: 12, renewal: '2027-01-31', other: 'x' })).toEqual({
      industry_note: '',
      renewal: '2027-01-31',
      seats: '12',
    });
    expect(customFormValues(FIELDS, null)).toEqual({ industry_note: '', renewal: '', seats: '' });
  });

  it('sends only what changed: a number as a number, a cleared box as null', () => {
    const before = customFormValues(FIELDS, { seats: 12, industry_note: 'Retail' });
    expect(customPatch(FIELDS, before, before)).toBeNull();
    const patch = customPatch(FIELDS, before, { ...before, seats: '14', industry_note: '' });
    expect(patch).toEqual({ seats: 14, industry_note: null });
    expect(ContactCustomSchema.safeParse(patch).success).toBe(true);
    // A new contact: only the filled boxes.
    expect(
      customPatch(FIELDS, {}, { industry_note: '', renewal: '2027-01-31', seats: '' }),
    ).toEqual({ renewal: '2027-01-31' });
  });

  it('refuses a box that cannot be its field’s kind, in plain words', () => {
    expect(
      customErrors(FIELDS, {
        seats: 'many',
        renewal: '2027-02-30',
        industry_note: 'x'.repeat(501),
      }),
    ).toEqual({
      seats: 'Enter a number.',
      renewal: 'Enter a date.',
      industry_note: 'Keep it to 500 characters.',
    });
    expect(customErrors(FIELDS, { seats: '', renewal: '', industry_note: '' })).toEqual({});
  });
});

describe('the audit row’s counts', () => {
  it('counts what changed, never a label, a key or a value', () => {
    const change = customFieldsChange(FIELDS, [
      { ...FIELDS[0]!, label: 'Sector notes' },
      FIELDS[1]!,
      { key: 'tier', label: 'Tier', type: 'number' },
    ]);
    expect(change).toEqual({ fields: 3, added: 1, removed: 1, renamed: 1 });
    expect(JSON.stringify(change)).not.toMatch(/Sector|Seats|tier|seats/);
  });
});

describe('the Data and privacy card', () => {
  it('states the horizon in words, or that it could not be read', () => {
    expect(retentionLine(24)).toBe(
      'Leads and contacts are kept 24 months after their last activity.',
    );
    expect(retentionLine(null)).toBe('How long leads and contacts are kept could not be read.');
  });

  it('says what the search found (WCAG 4.1.3)', () => {
    expect(foundWords(null)).toBe('');
    expect(foundWords([])).toBe('Nobody matches.');
    expect(foundWords([{ id: 'a', name: 'A', company: null }])).toBe('1 contact found.');
  });

  it('loads the erase dialog with import() only, so the contacts’ code is not on this screen', () => {
    const card = source('src/components/admin/screens/crmSettings/PrivacyCard.tsx');
    expect(card).toContain("import('@/components/admin/screens/contacts/EraseContactDialog')");
    expect(card).not.toMatch(/^import (?!type)[^;]*from '@\/components\/admin\/screens\/contacts/m);
    for (const f of ['CustomFieldsCard', 'ContactStagesCard', 'EraseFinder', 'CrmSettingsScreen']) {
      expect(source(`src/components/admin/screens/crmSettings/${f}.tsx`), f).not.toMatch(
        /from '@\/components\/admin\/screens\/contacts|from '\.\.\/contacts/,
      );
    }
  });

  it('the copy keeps the client’s rules: no em or en dash (P-12)', () => {
    for (const f of [
      'src/components/admin/screens/crmSettings/CustomFieldsCard.tsx',
      'src/components/admin/screens/crmSettings/ContactStagesCard.tsx',
      'src/components/admin/screens/crmSettings/PrivacyCard.tsx',
      'src/components/admin/screens/crmSettings/EraseFinder.tsx',
      'src/components/admin/screens/contacts/customFields.tsx',
      'src/lib/crm/contactCustom.ts',
    ]) {
      expect(source(f), f).not.toMatch(/[–—]/);
    }
  });
});

// ── The routes ──────────────────────────────────────────────────────────────────────────────

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const CONTACT = '22222222-2222-4222-8222-222222222222';

let sessionRole = 'admin';
let storedFields: unknown = FIELDS;
let storedCustom: unknown = { industry_note: 'Retail', seats: 3 };
let settingsAnswer: { data: unknown; error: unknown } = { data: null, error: null };
const calls: {
  owner: string;
  table?: string;
  rpc?: string;
  select?: string;
  update?: unknown;
  args?: unknown;
}[] = [];
const audits: { action: string; detail?: Record<string, unknown> }[] = [];

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (
    _sb: unknown,
    _auth: unknown,
    entry: { action: string; detail?: Record<string, unknown> },
  ) => {
    audits.push(entry);
    return true;
  },
  writeAuditMany: async () => true,
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  return { ...actual, claimPrivilegedOp: async () => undefined };
});

function client(owner: 'svc' | 'rls') {
  const builder = (call: (typeof calls)[number]) => {
    const b: Record<string, unknown> = {};
    for (const m of ['eq', 'is', 'in', 'order', 'limit']) b[m] = () => b;
    b['select'] = (columns?: string) => {
      if (columns !== undefined && call.select === undefined) call.select = columns;
      return b;
    };
    b['update'] = (values: unknown) => ((call.update = values), b);
    b['maybeSingle'] = async () => {
      if (call.table === 'profiles') {
        return { data: { role: sessionRole, is_active: true, locked_until: null }, error: null };
      }
      if (call.table === 'crm_settings') {
        if (call.update) return settingsAnswer;
        return { data: { custom_fields: storedFields }, error: null };
      }
      if (call.table === 'site_settings')
        return { data: { retention: { leads_months: 18 } }, error: null };
      if (call.table === 'crm_contacts') {
        return {
          data: {
            id: CONTACT,
            version: 3,
            custom: call.update ? (call.update as { custom?: unknown }).custom : storedCustom,
            merged_into: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    b['then'] = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(ok);
    return b;
  };
  return {
    from: (table: string) => {
      const call = { owner, table };
      calls.push(call);
      return builder(call);
    },
    rpc: async (fn: string, args: unknown) => {
      calls.push({ owner, rpc: fn, args });
      if (fn === 'crm_create_contact') return { data: { id: CONTACT }, error: null };
      return { data: [], error: null };
    },
  };
}
vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => client('svc') }));

function ctx(path: string, method: string, body?: unknown): APIContext {
  const url = new URL(`https://admin.example.test${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: CONTACT },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: sessionRole, email: 'a@x', isActive: true },
      supabase: client('rls'),
    },
  } as unknown as APIContext;
}
const json = async (res: Response) =>
  ((await res.json()) as { data: Record<string, unknown> }).data;

const settingsRoute = await import('@/pages/api/admin/crm/settings');
const contactRoute = await import('@/pages/api/admin/crm/contacts/[id]');
const addRoute = await import('@/pages/api/admin/crm/contacts/index');

beforeEach(() => {
  sessionRole = 'admin';
  storedFields = FIELDS;
  storedCustom = { industry_note: 'Retail', seats: 3 };
  settingsAnswer = { data: null, error: null };
  calls.length = 0;
  audits.length = 0;
});

describe('GET and PUT /api/admin/crm/settings', () => {
  it('reads the fields and what the privacy card states; an Admin may erase and change the horizon', async () => {
    const res = await settingsRoute.GET(ctx('/api/admin/crm/settings', 'GET'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body['settings'] as { customFields: unknown }).customFields).toEqual(FIELDS);
    expect(body['privacy']).toEqual({
      retentionMonths: 18,
      canErase: true,
      canEditRetention: true,
    });
  });

  it('saves the whole set at the version read, and the audit counts what changed', async () => {
    settingsAnswer = {
      data: { version: 5, scoring: {}, custom_fields: FIELDS.slice(0, 2) },
      error: null,
    };
    const res = await settingsRoute.PUT(
      ctx('/api/admin/crm/settings', 'PUT', { version: 4, customFields: FIELDS.slice(0, 2) }),
    );
    expect(res.status).toBe(200);
    const write = calls.find((c) => c.table === 'crm_settings' && c.update);
    expect(write?.owner).toBe('rls');
    expect(write?.update).toEqual({ custom_fields: FIELDS.slice(0, 2) });
    const row = audits.find((a) => a.action === 'crm.settings.update');
    expect(row?.detail).toEqual({
      fields: ['custom_fields'],
      version: 5,
      customFields: { fields: 2, added: 0, removed: 1, renamed: 0 },
    });
    expect(JSON.stringify(row)).not.toMatch(/Seats|seats|Renewal|renewal/);
  });

  it('a kept field whose type changed is a 422 on the fields, in plain words', async () => {
    settingsAnswer = {
      data: null,
      error: {
        code: '23514',
        message: 'a custom field keeps its type (constraint "crm_settings_custom_field_type")',
      },
    };
    const res = await settingsRoute.PUT(
      ctx('/api/admin/crm/settings', 'PUT', {
        version: 4,
        customFields: [{ ...FIELDS[2], type: 'text' }],
      }),
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain(
      'A saved field keeps its type. Remove it and add a new field instead.',
    );
  });

  it.each(['content_creator', 'seo', 'developer', 'sales'])('%s is refused (403)', async (role) => {
    sessionRole = role;
    const res = await settingsRoute.PUT(
      ctx('/api/admin/crm/settings', 'PUT', { version: 4, customFields: [] }),
    );
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.update)).toBe(false);
  });
});

describe('a contact’s custom values through the API', () => {
  it('PATCH checks the values against the tenant’s fields and lays them over what is stored', async () => {
    const res = await contactRoute.PATCH(
      ctx(`/api/admin/crm/contacts/${CONTACT}`, 'PATCH', {
        version: 3,
        custom: { seats: 4, renewal: '2027-01-31', industry_note: null },
      }),
    );
    expect(res.status).toBe(200);
    const write = calls.find((c) => c.table === 'crm_contacts' && c.update);
    expect(write?.update).toEqual({ custom: { seats: 4, renewal: '2027-01-31' } });
    const row = audits.find((a) => a.action === 'crm.contact.update');
    expect(row?.detail).toEqual({ fields: ['custom'] });
  });

  it('PATCH refuses a value no field has, or of the wrong kind, before writing anything', async () => {
    for (const custom of [{ nope: 'x' }, { seats: 'ten' }, { renewal: '2027-02-30' }]) {
      calls.length = 0;
      const res = await contactRoute.PATCH(
        ctx(`/api/admin/crm/contacts/${CONTACT}`, 'PATCH', { version: 3, custom }),
      );
      expect(res.status, JSON.stringify(custom)).toBe(422);
      expect(calls.some((c) => c.update)).toBe(false);
    }
  });

  it('PATCH refuses every value while the tenant defines no field', async () => {
    storedFields = [];
    const res = await contactRoute.PATCH(
      ctx(`/api/admin/crm/contacts/${CONTACT}`, 'PATCH', { version: 3, custom: { seats: 1 } }),
    );
    expect(res.status).toBe(422);
  });

  it('GET hands the page the tenant’s fields', async () => {
    const res = await contactRoute.GET(ctx(`/api/admin/crm/contacts/${CONTACT}`, 'GET'));
    expect(res.status).toBe(200);
    expect((await json(res))['customFields']).toEqual(FIELDS);
  });

  it('add sends only checked values to the door, and reads no fields when none are sent', async () => {
    const ok = await addRoute.POST(
      ctx('/api/admin/crm/contacts', 'POST', {
        displayName: 'Nadia',
        custom: { seats: 2, industry_note: ' Retail ', renewal: null },
      }),
    );
    expect(ok.status).toBe(200);
    const door = calls.find((c) => c.rpc === 'crm_create_contact');
    expect((door?.args as { p_contact: { custom: unknown } }).p_contact.custom).toEqual({
      seats: 2,
      industry_note: 'Retail',
    });

    calls.length = 0;
    const bare = await addRoute.POST(
      ctx('/api/admin/crm/contacts', 'POST', { displayName: 'Omar' }),
    );
    expect(bare.status).toBe(200);
    expect(calls.some((c) => c.table === 'crm_settings')).toBe(false);

    calls.length = 0;
    const bad = await addRoute.POST(
      ctx('/api/admin/crm/contacts', 'POST', { displayName: 'Huda', custom: { nope: 1 } }),
    );
    expect(bad.status).toBe(422);
    expect(calls.some((c) => c.rpc === 'crm_create_contact')).toBe(false);
  });
});
