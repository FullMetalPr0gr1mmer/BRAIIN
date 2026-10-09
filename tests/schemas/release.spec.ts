import { describe, it, expect } from 'vitest';
import {
  ContentDraftRowSchema,
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

  it('is strict: scheduling (R11) and unknown fields are refused, not ignored', () => {
    expect(
      PublishRequestSchema.safeParse({ items: refs(1), scheduleAt: '2026-10-10T10:00:00Z' })
        .success,
    ).toBe(false);
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
