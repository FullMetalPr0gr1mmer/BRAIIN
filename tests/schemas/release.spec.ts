import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApplyConflictDetailSchema,
  ApplyForbiddenDetailSchema,
  ApplyItemSchema,
  ApplyRefusedDetailSchema,
  ApplyRequestSchema,
  ApplyResultSchema,
  ContentDraftRowSchema,
  DRAFT_CONFLICT_CODES,
  DRAFT_LABEL_MAX_BYTES,
  DRAFT_LABEL_TEXT_MAX,
  DraftConflictDetailSchema,
  DraftLabelSchema,
  DraftRefFieldsSchema,
  DiscardRequestSchema,
  DryRunReportSchema,
  IntakeRequestSchema,
  PendingItemSchema,
  ResolveRequestSchema,
  DRAFT_STALE_DAYS,
  LedgerItemRowSchema,
  RELEASE_ATTENTION_KINDS,
  RELEASE_ATTENTION_WINDOW_DAYS,
  RELEASE_OVERDUE_MINUTES,
  WRITE_DRAFTS_MAX_OPS,
  WriteDraftsDiscardSchema,
  WriteDraftsOpsSchema,
  WriteDraftsPutSchema,
  WriteDraftsResultSchema,
  PUBLISHER_ROLES,
  RELEASE_CHILD_MEDIA_MAX,
  ContentReleaseRowSchema,
  DRAFT_FIELD_NAME,
  DRAFT_FIELDS_MAX,
  DRAFT_OPS,
  DRAFT_PAYLOAD_MAX_BYTES,
  DraftPayloadSchema,
  PURGE_STATUSES,
  PublishRequestSchema,
  RELEASE_AREAS,
  RELEASE_ENTITY_TYPES,
  RELEASE_KINDS,
  RELEASE_MAX_ITEMS,
  RELEASE_STATUSES,
  ReleaseItemRowSchema,
  ReleaseNoteSchema,
  jsonBytes,
} from '@schemas/release';
import { RELEASE_LEDGER_SQL, checkList, registryRows } from '../fixtures/releaseRegistry';

// The release shapes (Admin v2 R1). The vocabularies live twice, here and in the SQL of
// migration 0038 (CHECKs and the registry rows), so the second half holds them equal.

const uuid = (n: number) => `38000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ draftId: uuid(i + 1), draftVersion: 1 }));

// Built from code points so this file stays plain ASCII.
const NUL = String.fromCharCode(0x00);
const TAB = String.fromCharCode(0x09);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x85);

describe('PublishRequestSchema', () => {
  it('accepts one to sixty changes and defaults the kind to publish', () => {
    const one = PublishRequestSchema.parse({ items: refs(1) });
    expect(one.kind).toBe('publish');
    expect(PublishRequestSchema.safeParse({ items: refs(RELEASE_MAX_ITEMS) }).success).toBe(true);
    expect(RELEASE_MAX_ITEMS).toBe(60);
  });

  it('refuses an empty release and one past the cap (the dialog splits it)', () => {
    expect(PublishRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(PublishRequestSchema.safeParse({ items: refs(RELEASE_MAX_ITEMS + 1) }).success).toBe(
      false,
    );
  });

  it('refuses the same change twice', () => {
    const [first] = refs(1);
    expect(PublishRequestSchema.safeParse({ items: [first, first] }).success).toBe(false);
  });

  it('refuses a draft id that is not a uuid, and a version that is not a positive integer', () => {
    expect(
      PublishRequestSchema.safeParse({ items: [{ draftId: 'abc', draftVersion: 1 }] }).success,
    ).toBe(false);
    for (const draftVersion of [0, -1, 1.5, '1']) {
      expect(
        PublishRequestSchema.safeParse({ items: [{ draftId: uuid(1), draftVersion }] }).success,
      ).toBe(false);
    }
  });

  it('takes a time to schedule it (R11), with its offset; unknown fields are refused', () => {
    expect(
      PublishRequestSchema.parse({ items: refs(1), scheduleAt: '2026-10-10T10:00:00+03:00' })
        .scheduleAt,
    ).toBe('2026-10-10T10:00:00+03:00');
    expect(
      PublishRequestSchema.safeParse({ items: refs(1), scheduleAt: '2026-10-10T10:00:00Z' })
        .success,
    ).toBe(true);
    // A local time names no zone: refused rather than guessed.
    expect(
      PublishRequestSchema.safeParse({ items: refs(1), scheduleAt: '2026-10-10T10:00:00' }).success,
    ).toBe(false);
    expect(PublishRequestSchema.safeParse({ items: refs(1), scheduleAt: 'tomorrow' }).success).toBe(
      false,
    );
    expect(
      PublishRequestSchema.safeParse({
        items: [{ draftId: uuid(1), draftVersion: 1, entityType: 'service' }],
      }).success,
    ).toBe(false);
  });

  it('takes publish or rollback, never a ledger-only kind', () => {
    expect(PublishRequestSchema.parse({ items: refs(1), kind: 'rollback' }).kind).toBe('rollback');
    for (const kind of ['baseline', 'legacy_schedule', 'schedule']) {
      expect(PublishRequestSchema.safeParse({ items: refs(1), kind }).success).toBe(false);
    }
  });
});

describe('ReleaseNoteSchema', () => {
  it('trims and accepts up to 280 characters, Arabic included', () => {
    expect(ReleaseNoteSchema.parse('  Spring update  ')).toBe('Spring update');
    expect(ReleaseNoteSchema.safeParse('x'.repeat(280)).success).toBe(true);
    expect(ReleaseNoteSchema.safeParse('x'.repeat(281)).success).toBe(false);
    expect(ReleaseNoteSchema.safeParse('تحديث الصفحة الرئيسية').success).toBe(true);
  });

  it('refuses control characters (C0, TAB, DEL, C1)', () => {
    for (const ch of [NUL, TAB, DEL, C1]) {
      expect(ReleaseNoteSchema.safeParse(`ab${ch}cd`).success).toBe(false);
    }
  });

  it('is optional on a publish request', () => {
    expect(PublishRequestSchema.parse({ items: refs(1), note: 'v2' }).note).toBe('v2');
    expect(PublishRequestSchema.parse({ items: refs(1) }).note).toBeUndefined();
  });
});

describe('DraftPayloadSchema', () => {
  it('is an object, at most 512 KB as sent', () => {
    expect(DraftPayloadSchema.safeParse({ title: { en: 'Logo', ar: 'شعار' } }).success).toBe(true);
    expect(DraftPayloadSchema.safeParse([1, 2]).success).toBe(false);
    expect(DraftPayloadSchema.safeParse('{}').success).toBe(false);
    const big = { body: 'x'.repeat(DRAFT_PAYLOAD_MAX_BYTES) };
    expect(DraftPayloadSchema.safeParse(big).success).toBe(false);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(jsonBytes({ a: 'ش' })).toBe('{"a":""}'.length + 2);
    expect(jsonBytes(undefined)).toBe(0);
  });
});

describe('row shapes', () => {
  const at = '2026-10-09T08:00:00+00:00';

  it('reads a draft row', () => {
    const row = {
      id: uuid(1),
      tenant_id: uuid(2),
      entity_type: 'service',
      entity_id: uuid(3),
      op: 'update',
      payload: { title: { en: 'Logo' } },
      fields: ['title'],
      base: { title: { en: 'Old' } },
      base_version: 4,
      label: { en: 'Logo', ar: 'شعار' },
      origin_kind: null,
      origin_release_id: null,
      release_id: null,
      version: 1,
      created_at: at,
      updated_at: at,
      created_by: uuid(4),
      updated_by: uuid(4),
    };
    expect(ContentDraftRowSchema.parse(row).entity_type).toBe('service');
    expect(ContentDraftRowSchema.safeParse({ ...row, entity_type: 'lead' }).success).toBe(false);
    expect(ContentDraftRowSchema.safeParse({ ...row, op: 'archive' }).success).toBe(false);
  });

  it('a draft lists up to 200 changed columns, each a name of up to 63 characters', () => {
    const draft = (fields: string[]) => ({
      id: uuid(1),
      tenant_id: uuid(2),
      entity_type: 'page',
      entity_id: uuid(3),
      op: 'update',
      payload: {},
      fields,
      base: {},
      base_version: 1,
      label: null,
      origin_kind: null,
      origin_release_id: null,
      release_id: null,
      version: 1,
      created_at: at,
      updated_at: at,
      created_by: null,
      updated_by: null,
    });
    const ok = (fields: string[]) => ContentDraftRowSchema.safeParse(draft(fields)).success;
    expect(ok(['title', 'sort_order', 'sortOrder', 'a'.repeat(63)])).toBe(true);
    expect(ok(Array.from({ length: DRAFT_FIELDS_MAX }, () => 'title'))).toBe(true);
    expect(ok(Array.from({ length: DRAFT_FIELDS_MAX + 1 }, () => 'title'))).toBe(false);
    for (const bad of [
      'a'.repeat(64),
      '',
      '1title',
      'a long, free text',
      'title"',
      `ti${NUL}tle`,
    ]) {
      expect(ok(['title', bad])).toBe(false);
    }
  });

  it('reads a release row and a release item', () => {
    const release = {
      id: uuid(1),
      tenant_id: uuid(2),
      number: 3,
      kind: 'publish',
      status: 'published',
      note: null,
      scheduled_for: null,
      scheduled_by: null,
      published_at: at,
      published_by: uuid(4),
      restores_release_id: null,
      item_count: 2,
      areas: ['services', 'seo'],
      tags: ['service:logo'],
      purge_status: 'skipped',
      purge_attempts: 0,
      purge_next_at: null,
      purged_at: null,
      version: 2,
      created_at: at,
      updated_at: at,
    };
    expect(ContentReleaseRowSchema.parse(release).number).toBe(3);
    expect(ContentReleaseRowSchema.safeParse({ ...release, areas: ['leads'] }).success).toBe(false);

    const item = {
      id: 7,
      tenant_id: uuid(2),
      release_id: uuid(1),
      entity_type: 'portfolio_children',
      entity_id: uuid(5),
      op: 'update',
      before: { service_ids: [] },
      after: { service_ids: [uuid(6)] },
      draft_id: null,
      actor_id: uuid(4),
      created_at: at,
    };
    expect(ReleaseItemRowSchema.parse(item).entity_type).toBe('portfolio_children');
    expect(ReleaseItemRowSchema.safeParse({ ...item, entity_type: 'Bad-Type' }).success).toBe(
      false,
    );
  });
});

describe('the vocabularies equal migration 0038', () => {
  const sorted = (values: readonly string[]) => [...values].sort();

  it('the registry holds exactly RELEASE_ENTITY_TYPES', () => {
    expect(sorted(registryRows().map((r) => r.entityType))).toEqual(sorted(RELEASE_ENTITY_TYPES));
  });

  it('areas: the registry CHECK, the releases CHECK and every registry row', () => {
    expect(checkList('area').map(sorted)).toEqual([sorted(RELEASE_AREAS)]);
    const releasesAreas = /areas <@ array\[([^\]]*)\]/.exec(RELEASE_LEDGER_SQL)?.[1] ?? '';
    expect(sorted([...releasesAreas.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!))).toEqual(
      sorted(RELEASE_AREAS),
    );
    for (const row of registryRows()) expect(RELEASE_AREAS).toContain(row.area);
  });

  it('draft and item ops, release kinds, statuses and purge statuses', () => {
    expect(checkList('op').map(sorted)).toEqual([sorted(DRAFT_OPS), sorted(DRAFT_OPS)]);
    expect(checkList('kind').map(sorted)).toEqual([sorted(RELEASE_KINDS)]);
    expect(checkList('status').map(sorted)).toEqual([sorted(RELEASE_STATUSES)]);
    expect(checkList('purge_status').map(sorted)).toEqual([sorted(PURGE_STATUSES)]);
  });

  it('the limits the database enforces', () => {
    expect(RELEASE_LEDGER_SQL).toContain('char_length(note) <= 280');
    expect(RELEASE_LEDGER_SQL).toContain(`pg_column_size(payload) <= ${DRAFT_PAYLOAD_MAX_BYTES}`);
    expect(RELEASE_LEDGER_SQL).toContain(`cardinality(fields) <= ${DRAFT_FIELDS_MAX}`);
  });

  it('a changed column name: the Zod pattern is the one the CHECK applies to each entry', () => {
    // The CHECK reads the array's text form: '{' name (',' name)* '}', each name this pattern.
    const name = DRAFT_FIELD_NAME.source.slice(1, -1); // without ^ and $
    expect(RELEASE_LEDGER_SQL).toContain(String.raw`fields::text ~ '^\{(${name}(,${name})*)?\}$'`);
    expect(RELEASE_LEDGER_SQL).toContain('array_position(fields, null::text) is null');
  });
});

// ---- Applying a release (migration 0051, R4) ------------------------------------------------

const APPLY_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0051_release_apply.sql'),
  'utf8',
).replace(/--[^\n]*/g, '');

const item = (over: Record<string, unknown> = {}) => ({
  draft_id: uuid(1),
  draft_version: 1,
  entity_type: 'service',
  entity_id: uuid(2),
  op: 'update',
  patch: { title: { en: 'Logo', ar: 'شعار' } },
  base: { title: { en: 'Old', ar: 'قديم' } },
  ...over,
});
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => item({ draft_id: uuid(100 + i), entity_id: uuid(200 + i) }));
const request = (over: Record<string, unknown> = {}) => ({
  p_actor: uuid(9),
  p_role: 'content_creator',
  p_mode: 'publish',
  p_items: items(1),
  ...over,
});

describe('ApplyItemSchema', () => {
  it('reads one change as the RPC takes it', () => {
    expect(ApplyItemSchema.parse(item()).op).toBe('update');
    expect(
      ApplyItemSchema.safeParse(item({ op: 'create', base: {}, patch: { slug: 'logo' } })).success,
    ).toBe(true);
    expect(ApplyItemSchema.safeParse(item({ op: 'delete', patch: {}, base: {} })).success).toBe(
      true,
    );
  });

  it('is strict, and every id a uuid and the version a positive integer', () => {
    expect(ApplyItemSchema.safeParse({ ...item(), payload: {} }).success).toBe(false);
    expect(ApplyItemSchema.safeParse(item({ draft_id: 'abc' })).success).toBe(false);
    for (const draft_version of [0, 1.5, '1', 1_000_000_000]) {
      expect(ApplyItemSchema.safeParse(item({ draft_version })).success).toBe(false);
    }
    expect(ApplyItemSchema.safeParse(item({ entity_type: 'lead' })).success).toBe(false);
  });

  it('a removal carries no patch; an update changes something and has a base for it', () => {
    expect(ApplyItemSchema.safeParse(item({ op: 'delete' })).success).toBe(false);
    expect(ApplyItemSchema.safeParse(item({ patch: {}, base: {} })).success).toBe(false);
    expect(ApplyItemSchema.safeParse(item({ base: {} })).success).toBe(false);
  });

  it('never schedules a change on its own, and patch keys are column names', () => {
    expect(
      ApplyItemSchema.safeParse(item({ patch: { status: 'scheduled' }, base: { status: 'draft' } }))
        .success,
    ).toBe(false);
    expect(
      ApplyItemSchema.safeParse(item({ patch: { 'title" = 1, "slug': 'x' }, base: {} })).success,
    ).toBe(false);
  });

  it('link sets: a case study that stays, at most 40 media', () => {
    const children = { service_ids: [uuid(3)], media: [{ role: 'gallery', kind: 'image' }] };
    const project = (over: Record<string, unknown>) =>
      item({ entity_type: 'portfolio', patch: {}, base: {}, children, ...over });
    expect(ApplyItemSchema.safeParse(project({})).success).toBe(true);
    expect(ApplyItemSchema.safeParse(item({ children })).success).toBe(false);
    expect(ApplyItemSchema.safeParse(project({ op: 'delete' })).success).toBe(false);
    const media = Array.from({ length: RELEASE_CHILD_MEDIA_MAX + 1 }, () => ({ role: 'gallery' }));
    expect(ApplyItemSchema.safeParse(project({ children: { media } })).success).toBe(false);
    expect(ApplyItemSchema.safeParse(project({ children: { other: [] } })).success).toBe(false);
    // Link sets name at least one set: {} or two nulls would change nothing.
    expect(ApplyItemSchema.safeParse(project({ children: {} })).success).toBe(false);
    expect(
      ApplyItemSchema.safeParse(project({ children: { service_ids: null, media: null } })).success,
    ).toBe(false);
  });
});

describe('ApplyRequestSchema', () => {
  it('takes one to sixty changes, each draft once, as a CMS role', () => {
    expect(ApplyRequestSchema.parse(request()).p_kind).toBe('publish');
    expect(
      ApplyRequestSchema.safeParse(request({ p_items: items(RELEASE_MAX_ITEMS) })).success,
    ).toBe(true);
    expect(
      ApplyRequestSchema.safeParse(request({ p_items: items(RELEASE_MAX_ITEMS + 1) })).success,
    ).toBe(false);
    expect(ApplyRequestSchema.safeParse(request({ p_items: [] })).success).toBe(false);
    expect(ApplyRequestSchema.safeParse(request({ p_items: [item(), item()] })).success).toBe(
      false,
    );
    expect(ApplyRequestSchema.safeParse(request({ p_role: 'sales' })).success).toBe(false);
    expect([...PUBLISHER_ROLES].sort()).toEqual(['admin', 'content_creator', 'developer', 'seo']);
  });

  it('publish and dry run only (a schedule and a fire have their own shapes, R11)', () => {
    expect(ApplyRequestSchema.safeParse(request({ p_mode: 'dry_run' })).success).toBe(true);
    for (const p_mode of ['schedule', 'fire']) {
      expect(ApplyRequestSchema.safeParse(request({ p_mode })).success).toBe(false);
    }
    expect(
      ApplyRequestSchema.safeParse(request({ p_scheduled_for: '2026-11-01T00:00:00Z' })).success,
    ).toBe(false);
  });

  it('a rollback names the version it restores, a publish none', () => {
    expect(ApplyRequestSchema.safeParse(request({ p_kind: 'rollback' })).success).toBe(false);
    expect(
      ApplyRequestSchema.safeParse(request({ p_kind: 'rollback', p_restores_release_id: uuid(5) }))
        .success,
    ).toBe(true);
    expect(ApplyRequestSchema.safeParse(request({ p_restores_release_id: uuid(5) })).success).toBe(
      false,
    );
  });
});

describe('what apply_release answers', () => {
  const at = '2026-10-15T08:00:00+00:00';

  it('a publish: the release, its number, its items and the team-member changes', () => {
    const result = {
      release_id: uuid(1),
      number: 2,
      items: [
        {
          id: 1,
          tenant_id: uuid(2),
          release_id: uuid(1),
          entity_type: 'service',
          entity_id: uuid(3),
          op: 'update',
          before: { slug: 'logo' },
          after: { slug: 'logo-design' },
          draft_id: uuid(4),
          actor_id: uuid(5),
          created_at: at,
        },
        { entity_type: 'team_member', entity_id: uuid(6), op: 'update', draft_id: uuid(7) },
      ],
    };
    expect(ApplyResultSchema.parse(result).items).toHaveLength(2);
    expect(ApplyResultSchema.safeParse({ ...result, number: 0 }).success).toBe(false);
  });

  it('a dry run: every outcome, conflicts with the live and base values', () => {
    const report = {
      mode: 'dry_run',
      ok: false,
      item_count: 3,
      conflicts: [
        {
          draftId: uuid(1),
          columns: ['sort_order'],
          live: { sort_order: 42 },
          base: { sort_order: 41 },
        },
        { draftId: uuid(2), removed: true },
      ],
      errors: [
        {
          draftId: uuid(3),
          sqlstate: '23505',
          constraint: 'services_tenant_id_slug_key',
          column: null,
          message: 'duplicate key value violates unique constraint "services_tenant_id_slug_key"',
        },
      ],
    };
    expect(DryRunReportSchema.parse(report).ok).toBe(false);
    expect(DryRunReportSchema.safeParse({ ...report, mode: 'publish' }).success).toBe(false);
  });

  it('the error details of BR403, BR409 and BR422', () => {
    expect(ApplyForbiddenDetailSchema.safeParse({ code: 'actor' }).success).toBe(true);
    expect(
      ApplyConflictDetailSchema.safeParse({ code: 'pending-changed', draftIds: [uuid(1)] }).success,
    ).toBe(true);
    expect(
      ApplyConflictDetailSchema.safeParse({
        code: 'conflict',
        items: [{ draftId: uuid(1), columns: ['title'] }],
      }).success,
    ).toBe(true);
    expect(
      ApplyRefusedDetailSchema.safeParse({
        code: 'refused',
        items: [{ draftId: null, sqlstate: '42501', constraint: null, column: null, message: 'x' }],
      }).success,
    ).toBe(true);
    expect(
      ApplyRefusedDetailSchema.safeParse({
        code: 'base-missing',
        draftId: uuid(1),
        columns: ['title'],
      }).success,
    ).toBe(true);
    expect(ApplyRefusedDetailSchema.safeParse({ code: 'conflict', items: [] }).success).toBe(false);
  });
});

describe('the apply shapes equal migration 0051', () => {
  const quoted = (literal: string) =>
    [...literal.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();

  it('the item cap is RELEASE_MAX_ITEMS', () => {
    const cap = /c_max_items constant int := (\d+);/.exec(APPLY_SQL)?.[1];
    expect(Number(cap)).toBe(RELEASE_MAX_ITEMS);
    expect(APPLY_SQL).toContain(`a release holds 1 to ${RELEASE_MAX_ITEMS} changes`);
  });

  it('an item has exactly the keys ApplyItemSchema reads', () => {
    const required = /v_item \?& array\[([^\]]*)\]/.exec(APPLY_SQL)?.[1] ?? '';
    const allowed = /k\.key <> all \(array\[([^\]]*)\]\)/.exec(APPLY_SQL)?.[1] ?? '';
    const shape = Object.keys(ApplyItemSchema.innerType().shape).sort();
    expect(quoted(allowed)).toEqual(shape);
    expect(quoted(required)).toEqual(shape.filter((k) => k !== 'children'));
  });

  it('the publisher roles, the link-set media cap and the purge statuses', () => {
    const roles = /p\.role::text in \(([^)]*)\)/.exec(APPLY_SQL)?.[1] ?? '';
    expect(quoted(roles)).toEqual([...PUBLISHER_ROLES].sort());
    expect(APPLY_SQL).toContain(`jsonb_array_length(p_media) > ${RELEASE_CHILD_MEDIA_MAX}`);
    const purge = /p_status not in \(([^)]*)\)/.exec(APPLY_SQL)?.[1] ?? '';
    expect(quoted(purge)).toEqual([...PURGE_STATUSES].sort());
  });
});

// ---- Staged writes (migration 0062, R3a) -----------------------------------------------------

const DRAFTS_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0062_release_drafts_write.sql'),
  'utf8',
).replace(/--[^\n]*/g, '');

const putOp = (over: Record<string, unknown> = {}) => ({
  action: 'put',
  entity_type: 'service',
  entity_id: uuid(1),
  op: 'update',
  payload: { title: { en: 'Logo' } },
  fields: ['title'],
  base: { title: { en: 'Old' } },
  base_version: 3,
  label: { en: 'Logo', ar: 'شعار' },
  ...over,
});

describe('DraftRefFieldsSchema', () => {
  it('names a pending change by its id and version together, or not at all', () => {
    expect(DraftRefFieldsSchema.safeParse({}).success).toBe(true);
    expect(DraftRefFieldsSchema.safeParse({ draftId: uuid(1), draftVersion: 2 }).success).toBe(
      true,
    );
    expect(DraftRefFieldsSchema.safeParse({ draftId: uuid(1) }).success).toBe(false);
    expect(DraftRefFieldsSchema.safeParse({ draftVersion: 2 }).success).toBe(false);
    expect(DraftRefFieldsSchema.safeParse({ draftId: 'x', draftVersion: 2 }).success).toBe(false);
    expect(DraftRefFieldsSchema.safeParse({ draftId: uuid(1), draftVersion: 0 }).success).toBe(
      false,
    );
  });
});

describe('DraftLabelSchema', () => {
  it('is {en, ar?}, each at most 200 characters', () => {
    expect(DraftLabelSchema.safeParse({ en: 'Logo', ar: 'شعار' }).success).toBe(true);
    expect(DraftLabelSchema.safeParse({ en: 'a'.repeat(DRAFT_LABEL_TEXT_MAX) }).success).toBe(true);
    expect(DraftLabelSchema.safeParse({ en: 'a'.repeat(DRAFT_LABEL_TEXT_MAX + 1) }).success).toBe(
      false,
    );
    expect(DraftLabelSchema.safeParse({ en: 'x', fr: 'y' }).success).toBe(false);
  });
});

describe('WriteDraftsOpsSchema', () => {
  it('a new draft, an edit at a version, a discard at a version', () => {
    expect(WriteDraftsOpsSchema.safeParse([putOp()]).success).toBe(true);
    expect(
      WriteDraftsOpsSchema.safeParse([putOp({ draft_id: uuid(2), expected_version: 4 })]).success,
    ).toBe(true);
    expect(
      WriteDraftsOpsSchema.safeParse([
        { action: 'discard', draft_id: uuid(2), expected_version: 4 },
      ]).success,
    ).toBe(true);
  });

  it('refuses a draft id without its version, a blind discard, an unknown key', () => {
    expect(WriteDraftsOpsSchema.safeParse([putOp({ draft_id: uuid(2) })]).success).toBe(false);
    expect(WriteDraftsOpsSchema.safeParse([{ action: 'discard', draft_id: uuid(2) }]).success).toBe(
      false,
    );
    expect(WriteDraftsOpsSchema.safeParse([putOp({ tenant_id: uuid(9) })]).success).toBe(false);
  });

  it('the shapes the CHECKs require: a removal carries no payload, a create no base version', () => {
    expect(WriteDraftsOpsSchema.safeParse([putOp({ op: 'delete' })]).success).toBe(false);
    expect(
      WriteDraftsOpsSchema.safeParse([putOp({ op: 'delete', payload: {}, fields: [], base: {} })])
        .success,
    ).toBe(true);
    expect(WriteDraftsOpsSchema.safeParse([putOp({ op: 'create' })]).success).toBe(false);
  });

  it('caps: 1 to 200 changes; payload and base 512 KB; fields as the CHECK reads them', () => {
    expect(WriteDraftsOpsSchema.safeParse([]).success).toBe(false);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => putOp({ entity_id: uuid(100 + i) }));
    expect(WriteDraftsOpsSchema.safeParse(many(WRITE_DRAFTS_MAX_OPS)).success).toBe(true);
    expect(WriteDraftsOpsSchema.safeParse(many(WRITE_DRAFTS_MAX_OPS + 1)).success).toBe(false);
    const big = { body: 'x'.repeat(DRAFT_PAYLOAD_MAX_BYTES) };
    expect(WriteDraftsOpsSchema.safeParse([putOp({ payload: big })]).success).toBe(false);
    expect(WriteDraftsOpsSchema.safeParse([putOp({ base: big })]).success).toBe(false);
    expect(WriteDraftsOpsSchema.safeParse([putOp({ fields: ['a long, free text'] })]).success).toBe(
      false,
    );
  });

  it('reads what the writer answers and BR409’s detail', () => {
    expect(
      WriteDraftsResultSchema.safeParse([
        {
          action: 'put',
          draft_id: uuid(1),
          entity_type: 'service',
          entity_id: uuid(2),
          version: 1,
        },
        {
          action: 'discard',
          draft_id: uuid(3),
          entity_type: 'page',
          entity_id: uuid(4),
          version: null,
        },
      ]).success,
    ).toBe(true);
    expect(
      DraftConflictDetailSchema.safeParse({
        code: 'scheduled',
        draft_id: uuid(1),
        entity_type: 'service',
        entity_id: uuid(2),
      }).success,
    ).toBe(true);
    expect(DraftConflictDetailSchema.safeParse({ code: 'other' }).success).toBe(false);
  });
});

describe('the staged-write shapes equal migration 0062', () => {
  const quoted = (literal: string) =>
    [...literal.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();

  it('the op cap is WRITE_DRAFTS_MAX_OPS, the version cap the apply’s', () => {
    expect(Number(/c_max_ops constant int := (\d+);/.exec(DRAFTS_SQL)?.[1])).toBe(
      WRITE_DRAFTS_MAX_OPS,
    );
    expect(DRAFTS_SQL).toContain(String.raw`c_version constant text := '^[1-9][0-9]{0,8}$'`);
  });

  it('a put and a discard have exactly the keys the Zod shapes read', () => {
    const lists = [...DRAFTS_SQL.matchAll(/k\.key <> all \(array\[([^\]]*)\]\)/g)].map((m) =>
      quoted(m[1] ?? ''),
    );
    expect(lists).toEqual([
      Object.keys(WriteDraftsPutSchema.innerType().shape).sort(),
      Object.keys(WriteDraftsDiscardSchema.shape).sort(),
    ]);
  });

  it('the label cap is the content_drafts CHECK’s (0038)', () => {
    expect(RELEASE_LEDGER_SQL).toContain(`pg_column_size(label) <= ${DRAFT_LABEL_MAX_BYTES}`);
  });

  it('BR409 names exactly the codes DraftConflictDetailSchema reads', () => {
    const codes = [...DRAFTS_SQL.matchAll(/'code', '([a-z-]+)'/g)].map((m) => m[1]);
    expect([...new Set(codes)].sort()).toEqual(
      [...DraftConflictDetailSchema.shape.code.options].sort(),
    );
    for (const code of DraftConflictDetailSchema.shape.code.options) {
      expect(DRAFT_CONFLICT_CODES).toContain(code);
    }
  });
});

// ---- R3b: the draft endpoints' and the intake switch's shapes --------------------------------

describe('the draft endpoints and the intake switch (R3b)', () => {
  const ref = (n: number, v = 1) => ({ draftId: uuid(n), draftVersion: v });

  it('discard: mine, or 1 to WRITE_DRAFTS_MAX_OPS distinct changes; never both, never blind', () => {
    expect(DiscardRequestSchema.safeParse({ scope: 'mine' }).success).toBe(true);
    expect(DiscardRequestSchema.safeParse({ items: [ref(1), ref(2)] }).success).toBe(true);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ref(i + 1));
    expect(DiscardRequestSchema.safeParse({ items: many(WRITE_DRAFTS_MAX_OPS) }).success).toBe(
      true,
    );
    for (const bad of [
      {},
      { scope: 'all' },
      { scope: 'mine', items: [ref(1)] },
      { items: [] },
      { items: [ref(1), ref(1, 2)] },
      { items: [{ draftId: uuid(1) }] },
      { items: [{ ...ref(1), extra: true }] },
      { items: many(WRITE_DRAFTS_MAX_OPS + 1) },
    ]) {
      expect(DiscardRequestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 50)).toBe(
        false,
      );
    }
  });

  it('resolve: a version, column names in the content_drafts pattern, disjoint, at least one', () => {
    expect(
      ResolveRequestSchema.safeParse({ version: 2, keepMine: ['title'], useLive: ['blurb'] })
        .success,
    ).toBe(true);
    expect(ResolveRequestSchema.parse({ version: 2, useLive: ['title'] }).keepMine).toEqual([]);
    for (const bad of [
      { version: 2 },
      { version: 0, keepMine: ['title'] },
      { version: 2, keepMine: ['title'], useLive: ['title'] },
      { version: 2, keepMine: ['title', 'title'] },
      { version: 2, keepMine: ['a long, free text'] },
      { version: 2, keepMine: ['title'], other: 1 },
      { version: 2, keepMine: Array.from({ length: DRAFT_FIELDS_MAX + 1 }, (_, i) => `c${i}`) },
    ]) {
      expect(ResolveRequestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 50)).toBe(
        false,
      );
    }
  });

  it('intake: one strict boolean', () => {
    expect(IntakeRequestSchema.safeParse({ acceptingApplications: true }).success).toBe(true);
    for (const bad of [
      {},
      { acceptingApplications: 'true' },
      { acceptingApplications: true, version: 1 },
    ]) {
      expect(IntakeRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('a pending item: stored metadata, a type and area of the registry', () => {
    const item = {
      draftId: uuid(1),
      draftVersion: 3,
      entityType: 'service',
      entityId: uuid(2),
      op: 'update',
      area: 'services',
      label: { en: 'Logo' },
      fields: ['title'],
      updatedBy: uuid(3),
      updatedByName: 'Amal',
      updatedAt: '2026-10-18T08:00:00Z',
      scheduled: false,
      mine: true,
      publishableByMe: true,
      requiredCaps: ['services.write', 'content.publish'],
      waitingFor: ['admin', 'content_creator'],
    };
    expect(PendingItemSchema.safeParse(item).success).toBe(true);
    expect(PendingItemSchema.safeParse({ ...item, entityType: 'lead' }).success).toBe(false);
    expect(PendingItemSchema.safeParse({ ...item, payload: {} }).success).toBe(false);
  });
});

// ---- The guard and complete capture (migration 0066, R5) -------------------------------------

const GUARD_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0066_release_guard.sql'),
  'utf8',
).replace(/--[^\n]*/g, '');

describe('LedgerItemRowSchema (system items, 0066)', () => {
  const at = '2026-10-18T08:00:00+00:00';
  const item = {
    id: 9,
    tenant_id: uuid(2),
    release_id: uuid(1),
    entity_type: 'service',
    entity_id: uuid(5),
    op: 'update',
    before: { sort_order: 1 },
    after: { sort_order: 2 },
    draft_id: uuid(7),
    actor_id: uuid(4),
    created_at: at,
  };

  it('reads a release item and a system item (no release, no draft)', () => {
    expect(LedgerItemRowSchema.parse(item).release_id).toBe(uuid(1));
    const system = { ...item, release_id: null, draft_id: null, actor_id: null };
    expect(LedgerItemRowSchema.parse(system).release_id).toBeNull();
  });

  it('a system item never names a draft (content_release_items_system_shape)', () => {
    expect(LedgerItemRowSchema.safeParse({ ...item, release_id: null }).success).toBe(false);
    expect(GUARD_SQL).toContain('check (release_id is not null or draft_id is null)');
  });

  it("a release's own items still name it (ApplyResultSchema reads ReleaseItemRowSchema)", () => {
    expect(ReleaseItemRowSchema.safeParse({ ...item, release_id: null }).success).toBe(false);
  });
});

describe('the attention kinds and thresholds equal migration 0066', () => {
  const view = GUARD_SQL.slice(
    GUARD_SQL.indexOf('create or replace view public.dashboard_attention'),
    GUARD_SQL.indexOf('revoke all on public.dashboard_attention'),
  );
  const v4 = view.slice(view.indexOf("select 'release_scheduled_today'"));

  it('the view emits exactly RELEASE_ATTENTION_KINDS after its 0028 kinds', () => {
    const kinds = [...v4.matchAll(/select '([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual([...RELEASE_ATTENTION_KINDS]);
  });

  it('late is RELEASE_OVERDUE_MINUTES, stale DRAFT_STALE_DAYS, failures RELEASE_ATTENTION_WINDOW_DAYS', () => {
    const minutes = [...v4.matchAll(/interval '(\d+) minutes'/g)].map((m) => Number(m[1]));
    const days = [...v4.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]));
    expect(minutes).toEqual([RELEASE_OVERDUE_MINUTES, RELEASE_OVERDUE_MINUTES]);
    expect(days).toEqual([
      RELEASE_ATTENTION_WINDOW_DAYS,
      RELEASE_ATTENTION_WINDOW_DAYS,
      DRAFT_STALE_DAYS,
    ]);
  });
});
