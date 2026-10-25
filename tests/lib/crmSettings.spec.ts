import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { InUseError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import {
  readCrmSettings,
  saveCrmSettings,
  saveLeadStages,
  SETTINGS_COLUMNS,
  settingsPatch,
  settingsView,
  stagesView,
} from '@/lib/crm/settings';
import {
  ASSIGNMENT_RULES,
  CrmSettingsSaveSchema,
  DEFAULT_SCORING,
  LeadStagesSaveSchema,
  MAX_ASSIGNMENT_POOL,
  MAX_LEAD_SCORE,
  MAX_SIGNAL_POINTS,
  MAX_SLA_HOURS,
  MAX_STAGE_LABEL,
  MAX_STAGES,
  MIN_SLA_HOURS,
  MIN_STAGES,
  SCORE_SIGNALS,
  STAGE_KINDS,
  STAGE_TONES,
} from '@schemas/crm';
import {
  KIND_NAMES,
  leadsCount,
  removeBlocked,
  RULE_COPY,
  SIGNAL_COPY,
  TONE_NAMES,
  ALL_SIGNALS,
  KINDS,
  LIMITS,
  TONES,
} from '@/components/admin/screens/crmSettings/copy';
import { pipelineProblem, stagesPayload } from '@/components/admin/screens/crmSettings/StagesCard';
import { maxScore, scoringOf } from '@/components/admin/screens/crmSettings/ScoringCard';
import { assignmentPayload, personName } from '@/components/admin/screens/crmSettings/ResponseCard';

// CRM settings for leads (Admin v2 C9a). Held here: the schemas the routes parse with, against
// the CHECKs and the door in the migrations (0034, 0035, 0091); the tone palette against the
// contrast gate (each tone a text-on-tint pair scripts/contrast-audit.mjs proves AA); the two
// writes' error mapping (a 409 for a stale save, "Move its N leads first", the field a refused
// assignee belongs to) and what their audit rows may say (names and counts, never values);
// and the screen's own rules. RLS, the grants and the door itself are proven in pgTAP
// (supabase/tests/crm_settings.test.sql); the authorization matrix in tests/authz/cases/crm.ts.

const MIGRATIONS = 'supabase/migrations';
const sql = (prefix: string) => {
  const file = readdirSync(MIGRATIONS).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`no migration ${prefix}`);
  return readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
};
const C9A = (() => {
  const file = readdirSync(MIGRATIONS).find((f) => /_crm_settings\.sql$/.test(f));
  if (!file) throw new Error('no CRM settings migration');
  return readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
})();
const quoted = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTH = {
  tenantId: UUID(900),
  userId: UUID(901),
  role: 'admin',
  isActive: true,
} as AuthContext;

describe('the vocabularies equal the database (0034, 0035, 0091)', () => {
  it('stage tones and kinds are 0034’s CHECK lists', () => {
    const pipeline = sql('0034_');
    expect(quoted(/tone text not null check \(tone in \(([^)]*)\)\)/.exec(pipeline)![1]!)).toEqual([
      ...STAGE_TONES,
    ]);
    expect(quoted(/kind text not null check \(kind in \(([^)]*)\)\)/.exec(pipeline)![1]!)).toEqual([
      ...STAGE_KINDS,
    ]);
    expect(pipeline).toContain(`char_length(label) between 1 and ${MAX_STAGE_LABEL}`);
    expect(pipeline).toContain(`n < ${MIN_STAGES} or n > ${MAX_STAGES}`);
  });

  it('the response time and the points are 0035’s CHECKs', () => {
    const ingest = sql('0035_');
    expect(ingest).toContain(`sla_hours between ${MIN_SLA_HOURS} and ${MAX_SLA_HOURS}`);
    expect(ingest).toContain(`between 0 and ${MAX_SIGNAL_POINTS}`);
  });

  it('the assignment rules and the pool size are 0091’s', () => {
    expect(quoted(/check \(assignment_rule in \(([^)]*)\)\)/.exec(C9A)![1]!)).toEqual([
      ...ASSIGNMENT_RULES,
    ]);
    expect(C9A).toContain(`cardinality(p) <= ${MAX_ASSIGNMENT_POOL}`);
    expect(RULE_COPY.map((r) => r.rule)).toEqual([...ASSIGNMENT_RULES]);
  });

  it('the door takes exactly the keys the schema sends', () => {
    const keys = quoted(/where k not in \(([^)]*)\)\)/.exec(C9A)![1]!);
    expect(keys).toEqual(['id', 'label', 'label_ar', 'tone', 'kind']);
    const sent = Object.keys(LeadStagesSaveSchema._def.schema.shape.stages.element.shape);
    for (const key of sent) expect(keys).toContain(key);
  });

  it('the screen offers every live signal; service_page waits for attribution (C13)', () => {
    expect(SIGNAL_COPY.map((s) => s.signal).sort()).toEqual(
      SCORE_SIGNALS.filter((s) => s !== 'service_page').sort(),
    );
  });
});

describe('the screen’s own copy of the limits equals the schema’s', () => {
  // The screen cannot import @schemas/crm at run time (its chunk is the leads screens'), so it
  // keeps its own copy, held here.
  it('limits, signals, tones and kinds', () => {
    expect(LIMITS).toEqual({
      minStages: MIN_STAGES,
      maxStages: MAX_STAGES,
      maxLabel: MAX_STAGE_LABEL,
      maxPoints: MAX_SIGNAL_POINTS,
      maxScore: MAX_LEAD_SCORE,
      maxPool: MAX_ASSIGNMENT_POOL,
      minSla: MIN_SLA_HOURS,
      maxSla: MAX_SLA_HOURS,
    });
    expect(ALL_SIGNALS).toEqual([...SCORE_SIGNALS]);
    expect(TONES).toEqual([...STAGE_TONES]);
    expect(KINDS).toEqual([...STAGE_KINDS]);
  });

  it('nothing in the screen imports the schema at run time (types only)', () => {
    for (const f of readdirSync('src/components/admin/screens/crmSettings')) {
      const source = readFileSync(`src/components/admin/screens/crmSettings/${f}`, 'utf8');
      expect(source, f).not.toMatch(/^import \{[^}]*\} from '@schemas\//m);
      expect(source, f).not.toMatch(/from '@\/lib\/crm\//);
    }
  });
});

describe('the tone palette is the contrast gate’s (AA)', () => {
  const css = readFileSync('public/styles/admin.css', 'utf8');
  const audit = readFileSync('scripts/contrast-audit.mjs', 'utf8');

  it.each([...STAGE_TONES])(
    '%s: its badge is a text-on-tint pair the audit holds to 4.5:1',
    (tone) => {
      const rule = new RegExp(
        String.raw`\.badge\[data-tone='${tone}'\][^{]*\{\s*background: var\(--ad-([a-z0-9-]+)\);\s*color: var\(--ad-([a-z0-9-]+)\);`,
      ).exec(css);
      expect(rule, tone).not.toBeNull();
      const [, bg, fg] = rule!;
      expect(audit, `${fg} on ${bg}`).toContain(`['${fg}', '${bg}', 4.5,`);
    },
  );

  it('every tone has a name to choose it by, and only these tones exist', () => {
    expect(Object.keys(TONE_NAMES).sort()).toEqual([...STAGE_TONES].sort());
    expect(Object.keys(KIND_NAMES).sort()).toEqual([...STAGE_KINDS].sort());
  });

  it('the screen sets no colour itself: tones are data-tone, never a style', () => {
    for (const f of ['StagesCard', 'ScoringCard', 'ResponseCard', 'CrmSettingsScreen']) {
      const source = readFileSync(`src/components/admin/screens/crmSettings/${f}.tsx`, 'utf8');
      expect(source, f).not.toMatch(/style=\{|#[0-9a-f]{3,6}\b/i);
    }
  });
});

describe('the schemas', () => {
  const known = [
    { id: UUID(1), version: 1 },
    { id: UUID(2), version: 3 },
  ];
  const pipeline = [
    { id: UUID(1), label: 'New', tone: 'klein', kind: 'open' },
    { label: 'Won', tone: 'ok', kind: 'won' },
    { id: UUID(2), label: 'Lost', tone: 'gray', kind: 'lost' },
  ];
  const ok = (stages: unknown) => LeadStagesSaveSchema.safeParse({ known, stages }).success;

  it('a pipeline: 2 to 10 stages, a won and a lost, the first one kept first, each once', () => {
    expect(ok(pipeline)).toBe(true);
    expect(ok(pipeline.slice(0, 1))).toBe(false);
    expect(ok([...pipeline, ...Array.from({ length: 8 }, () => pipeline[1])])).toBe(false);
    expect(ok(pipeline.filter((s) => s.kind !== 'won'))).toBe(false);
    expect(ok(pipeline.filter((s) => s.kind !== 'lost'))).toBe(false);
    expect(ok([pipeline[1], pipeline[0], pipeline[2]])).toBe(false);
    expect(ok([...pipeline, pipeline[2]])).toBe(false);
  });

  it('a stage: a closed tone and kind, a label of 1 to 40, no other key', () => {
    const one = (patch: Record<string, unknown>) =>
      ok([pipeline[0], { ...pipeline[1], ...patch }, pipeline[2]]);
    expect(one({ tone: '#ff0000' })).toBe(false);
    expect(one({ kind: 'spam' })).toBe(false);
    expect(one({ label: '   ' })).toBe(false);
    expect(one({ label: 'x'.repeat(MAX_STAGE_LABEL + 1) })).toBe(false);
    expect(one({ is_initial: true })).toBe(false);
    expect(one({ key: 'won' })).toBe(false);
  });

  it('a settings save: one card at a version, the whole closed points set, the limits', () => {
    const parse = (v: unknown) => CrmSettingsSaveSchema.safeParse(v).success;
    expect(parse({ version: 1, slaHours: 12 })).toBe(true);
    expect(parse({ version: 1, scoring: DEFAULT_SCORING })).toBe(true);
    expect(parse({ version: 1 })).toBe(false);
    expect(parse({ slaHours: 12 })).toBe(false);
    expect(parse({ version: 1, slaHours: 0 })).toBe(false);
    expect(parse({ version: 1, slaHours: MAX_SLA_HOURS + 1 })).toBe(false);
    expect(parse({ version: 1, scoring: { ...DEFAULT_SCORING, returning: 51 } })).toBe(false);
    expect(parse({ version: 1, scoring: { ...DEFAULT_SCORING, made_up: 5 } })).toBe(false);
    const { returning: _drop, ...partial } = DEFAULT_SCORING;
    expect(parse({ version: 1, scoring: partial })).toBe(false);
    expect(parse({ version: 1, timezone: 'UTC' })).toBe(false);
  });

  it('an assignment: a person for "always", someone in a rotation, at most 20, each once', () => {
    const parse = (assignment: unknown) =>
      CrmSettingsSaveSchema.safeParse({ version: 1, assignment }).success;
    expect(parse({ rule: 'manual', pool: [], fixedTo: null })).toBe(true);
    expect(parse({ rule: 'fixed', pool: [], fixedTo: UUID(3) })).toBe(true);
    expect(parse({ rule: 'fixed', pool: [], fixedTo: null })).toBe(false);
    expect(parse({ rule: 'round_robin', pool: [UUID(3)], fixedTo: null })).toBe(true);
    expect(parse({ rule: 'round_robin', pool: [], fixedTo: null })).toBe(false);
    expect(parse({ rule: 'round_robin', pool: [UUID(3), UUID(3)], fixedTo: null })).toBe(false);
    const many = Array.from({ length: MAX_ASSIGNMENT_POOL + 1 }, (_, i) => UUID(i + 10));
    expect(parse({ rule: 'round_robin', pool: many, fixedTo: null })).toBe(false);
    expect(parse({ rule: 'by_service', pool: [], fixedTo: null })).toBe(false);
  });
});

// ── The writes, against a stand-in client ────────────────────────────────────────────────

interface Call {
  table?: string;
  rpc?: string;
  update?: Record<string, unknown>;
  select?: string;
  args?: Record<string, unknown>;
  eq: [string, unknown][];
}

function fakeDb(answer: { data?: unknown; error?: Record<string, unknown> | null }) {
  const calls: Call[] = [];
  const builder = (call: Call) => {
    const b: Record<string, unknown> = {};
    b['update'] = (values: Record<string, unknown>) => ((call.update = values), b);
    b['select'] = (columns?: string) => {
      if (columns !== undefined) call.select = columns;
      return b;
    };
    b['order'] = () => b;
    b['eq'] = (col: string, val: unknown) => (call.eq.push([col, val]), b);
    b['maybeSingle'] = async () => ({ data: answer.data ?? null, error: answer.error ?? null });
    b['then'] = (resolve: (v: unknown) => void) =>
      resolve({ data: answer.data ?? null, error: answer.error ?? null });
    return b;
  };
  const sb = {
    from: (table: string) => {
      const call: Call = { table, eq: [] };
      calls.push(call);
      return builder(call);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ rpc: fn, args, eq: [] });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe('saving the settings', () => {
  const row = {
    version: 4,
    scoring: DEFAULT_SCORING,
    sla_hours: 12,
    assignment_rule: 'manual',
    assignment_pool: [],
    assignment_fixed_to: null,
    updated_at: '2026-10-19T08:00:00Z',
  };

  it('writes the card’s columns at the version read, in the caller’s tenant', async () => {
    const { sb, calls } = fakeDb({ data: row });
    const saved = await saveCrmSettings(sb, AUTH, {
      version: 3,
      slaHours: 12,
      assignment: { rule: 'manual', pool: [], fixedTo: null },
    });
    expect(saved.version).toBe(4);
    expect(calls[0]!.table).toBe('crm_settings');
    expect(calls[0]!.update).toEqual({
      sla_hours: 12,
      assignment_rule: 'manual',
      assignment_pool: [],
      assignment_fixed_to: null,
    });
    expect(calls[0]!.eq).toEqual([
      ['tenant_id', AUTH.tenantId],
      ['version', 3],
    ]);
  });

  it('a version that moved on is a 409', async () => {
    const { sb } = fakeDb({ data: null });
    await expect(saveCrmSettings(sb, AUTH, { version: 3, slaHours: 12 })).rejects.toBeInstanceOf(
      OptimisticLockError,
    );
  });

  it('a refused assignee is a 422 on its field, in plain words', async () => {
    const { sb } = fakeDb({
      error: {
        code: '23514',
        message:
          'everyone in the pool must be an active lead worker of this tenant (constraint "crm_settings_assignment_pool")',
      },
    });
    const err = await saveCrmSettings(sb, AUTH, {
      version: 3,
      assignment: { rule: 'round_robin', pool: [UUID(5)], fixedTo: null },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe('pool');
    expect((err as ValidationError).detail).not.toMatch(/constraint|tenant/);
  });

  it('the audit names the cards’ fields, never their values', () => {
    const { fields } = settingsPatch({
      version: 1,
      scoring: DEFAULT_SCORING,
      slaHours: 6,
      assignment: { rule: 'fixed', pool: [], fixedTo: UUID(7) },
    });
    expect(fields).toEqual(['lead_scoring', 'response_time', 'assignment']);
  });
});

describe('saving the pipeline', () => {
  const input = {
    known: [
      { id: UUID(1), version: 1 },
      { id: UUID(2), version: 1 },
      { id: UUID(3), version: 1 },
    ],
    stages: [
      { id: UUID(1), label: 'New', tone: 'klein' as const, kind: 'open' as const },
      { label: 'Won', tone: 'ok' as const, kind: 'won' as const },
      { id: UUID(3), label: 'Lost', tone: 'gray' as const, kind: 'lost' as const },
    ],
  };

  it('calls the door as the caller, with the stages as loaded, and counts what changed', async () => {
    const { sb, calls } = fakeDb({ data: [{ id: UUID(1) }] });
    const saved = await saveLeadStages(sb, AUTH, input);
    expect(calls[0]).toMatchObject({
      rpc: 'save_lead_stages',
      args: { p_tenant: AUTH.tenantId, p_known: input.known, p_stages: input.stages },
    });
    expect({ added: saved.added, removed: saved.removed }).toEqual({ added: 1, removed: 1 });
  });

  it.each([
    ['40001', OptimisticLockError],
    ['42501', AuthorizationError],
    ['22023', ValidationError],
    ['23514', ValidationError],
  ])('%s is mapped, never echoed', async (code, kind) => {
    const { sb } = fakeDb({ error: { code, message: 'save_lead_stages: internal words' } });
    const err = await saveLeadStages(sb, AUTH, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(kind);
    expect(String((err as Error & { detail?: string }).detail ?? '')).not.toContain('internal');
  });

  it.each(['23503', '23001'])(
    'a stage that holds leads (%s): "Move its N leads first"',
    async (code) => {
      const details = JSON.stringify({
        stageId: UUID(2),
        label: 'Proposal sent',
        leads: 3,
        change: 'delete',
      });
      const { sb } = fakeDb({ error: { code, message: 'x', details } });
      const err = await saveLeadStages(sb, AUTH, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InUseError);
      expect((err as InUseError).detail).toBe(
        'Proposal sent holds 3 leads. Move its 3 leads first.',
      );
    },
  );

  it('a kind change on a stage that holds a lead says it keeps its kind', async () => {
    const details = JSON.stringify({ label: 'Contacted', leads: 1, change: 'kind' });
    const { sb } = fakeDb({ error: { code: '23503', message: 'x', details } });
    const err = (await saveLeadStages(sb, AUTH, input).catch((e: unknown) => e)) as InUseError;
    expect(err.detail).toBe('Contacted holds 1 lead, so it keeps its kind. Move its 1 lead first.');
  });
});

describe('what the screen reads', () => {
  it('the settings, the stages with their counts, the people: four reads in the caller’s tenant', async () => {
    const { sb, calls } = fakeDb({ data: { version: 2, sla_hours: 24 } });
    const answer = await readCrmSettings(sb, AUTH);
    expect(calls.map((c) => c.table ?? c.rpc)).toEqual([
      'crm_settings',
      'lead_stages',
      'lead_stage_counts',
      'crm_people',
    ]);
    for (const call of calls.filter((c) => c.table)) {
      expect(call.eq).toContainEqual(['tenant_id', AUTH.tenantId]);
    }
    for (const call of calls.filter((c) => c.rpc))
      expect(call.args).toEqual({ p_tenant: AUTH.tenantId });
    expect(answer.settings.version).toBe(2);
  });

  // Admin v2 C14a: the studio's zone is site_settings.timezone (U9), and the deprecated
  // crm_settings.timezone is the contract's to drop (C14b), so neither the read nor a save's
  // answer names it: the screen works on the schema before and after that migration.
  it('never names the deprecated crm_settings.timezone, reading or saving', async () => {
    const read = fakeDb({ data: { version: 2, sla_hours: 24 } });
    const answer = await readCrmSettings(read.sb, AUTH);
    const saved = fakeDb({ data: { version: 3, sla_hours: 12 } });
    await saveCrmSettings(saved.sb, AUTH, { version: 2, slaHours: 12 });
    for (const call of [read.calls[0]!, saved.calls[0]!]) {
      expect(call.table).toBe('crm_settings');
      expect(call.select?.split(',')).toEqual(SETTINGS_COLUMNS.split(','));
    }
    expect(SETTINGS_COLUMNS.split(',')).not.toContain('timezone');
    expect(Object.keys(saved.calls[0]!.update ?? {})).not.toContain('timezone');
    expect(answer.settings).not.toHaveProperty('timezone');
  });

  it('shapes rows leniently: unknown keys dropped, counts joined by stage', () => {
    expect(
      settingsView({
        version: 1,
        scoring: { returning: 10, bad: 'x' },
        extra: 1,
        assignment_pool: null,
      }),
    ).toMatchObject({ scoring: { returning: 10 }, assignment: { rule: 'manual', pool: [] } });
    const [stage] = stagesView(
      [{ id: UUID(1), key: 'new', label: 'New', tone: 'klein', kind: 'open', is_initial: true }],
      [{ stage_id: UUID(1), leads: 4 }],
    );
    expect(stage).toMatchObject({ leads: 4, is_initial: true });
  });
});

describe('the screen’s own rules', () => {
  it('the pipeline payload keeps board order and ids, trims labels', () => {
    const loaded = [
      {
        id: UUID(1),
        key: 'new',
        label: 'New',
        label_ar: null,
        tone: 'klein',
        kind: 'open',
        is_initial: true,
        sort_order: 10,
        version: 2,
        leads: 0,
      },
    ];
    expect(
      stagesPayload(loaded, [
        {
          id: UUID(1),
          local: UUID(1),
          label: ' New ',
          tone: 'klein',
          kind: 'open',
          is_initial: true,
          leads: 0,
        },
        { local: 'new-1', label: 'Won', tone: 'ok', kind: 'won', is_initial: false, leads: 0 },
      ]),
    ).toEqual({
      known: [{ id: UUID(1), version: 2 }],
      stages: [
        { id: UUID(1), label: 'New', tone: 'klein', kind: 'open' },
        { label: 'Won', tone: 'ok', kind: 'won' },
      ],
    });
  });

  it('says what stops a pipeline before the server does', () => {
    const d = (kind: string, label = 'S') => ({
      local: kind + label,
      label,
      tone: 'gray',
      kind,
      is_initial: false,
      leads: 0,
    });
    expect(pipelineProblem([d('open'), d('won'), d('lost')])).toBeNull();
    expect(pipelineProblem([d('open')])).toMatch(/2 to 10/);
    expect(pipelineProblem([d('open'), d('lost')])).toMatch(/Won/);
    expect(pipelineProblem([d('open'), d('won')])).toMatch(/Lost/);
    expect(pipelineProblem([d('open'), d('won', ' '), d('lost')])).toMatch(/label/);
  });

  it('a stage that holds leads, or the first, cannot be removed, and says why', () => {
    expect(removeBlocked({ is_initial: true, leads: 0 })).toMatch(/starts here/);
    expect(removeBlocked({ leads: 2 })).toBe('Move its 2 leads first.');
    expect(removeBlocked({ leads: 0 })).toBeNull();
    expect(leadsCount(1)).toBe('1 lead');
  });

  it('the assignment sends only people still offered, in rotation order', () => {
    const people = [
      { id: UUID(1), display_name: 'Sara', role: 'admin' },
      { id: UUID(2), display_name: null, role: 'developer' },
    ];
    expect(assignmentPayload('round_robin', [UUID(2), UUID(9), UUID(1)], UUID(9), people)).toEqual({
      rule: 'round_robin',
      pool: [UUID(2), UUID(1)],
      fixedTo: null,
    });
    expect(personName(people[0]!)).toBe('Sara (Admin)');
    expect(personName(people[1]!)).toBe('A team member (Developer)');
  });

  it('the highest score shown is capped at 100, from the offered signals', () => {
    const all50 = Object.fromEntries(SCORE_SIGNALS.map((s) => [s, 50]));
    expect(maxScore(all50)).toBe(MAX_LEAD_SCORE);
    expect(maxScore({ returning: 10, company_named: 5, service_page: 50 })).toBe(15);
    expect(
      scoringOf({
        version: 1,
        scoring: { returning: 3 },
        slaHours: 24,
        assignment: { rule: 'manual', pool: [], fixedTo: null },
        updatedAt: null,
      }),
    ).toEqual({ ...Object.fromEntries(SCORE_SIGNALS.map((x) => [x, 0])), returning: 3 });
  });

  it('the copy keeps the client’s rules: no em or en dash (P-12)', () => {
    for (const f of [
      'copy.ts',
      'StagesCard.tsx',
      'ScoringCard.tsx',
      'ResponseCard.tsx',
      'CrmSettingsScreen.tsx',
    ]) {
      expect(readFileSync(`src/components/admin/screens/crmSettings/${f}`, 'utf8'), f).not.toMatch(
        /[–—]/,
      );
    }
    expect(readFileSync('src/lib/crm/settings.ts', 'utf8')).not.toMatch(/[–—]/);
  });
});
