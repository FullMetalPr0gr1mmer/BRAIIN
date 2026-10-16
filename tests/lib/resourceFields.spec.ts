import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { RESOURCES } from '@/lib/admin/resources';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { PAGE_VISIBILITY } from '@/lib/admin/pageVisibility';
import { RELEASE_REGISTRY, type RegistryEntry } from '@/lib/release/registry';
import { registryRows } from '../fixtures/releaseRegistry';
import { SAMPLE_NOW, sampleOf, samplesFor } from '../fixtures/resourceSamples';

// Every release-managed config's `fields` (payload key → the columns it can emit) is
// exactly what its `toRow` writes (Admin v2 R2, decision D1).
//
// `fields` is declared beside `toRow`, both built from one key-map constant, so a plain
// key cannot drift; what this catches is a DERIVED column (a body's HTML and reading
// time, a clip's columns, a publish stamp, the statistic value rule) that `toRow` writes
// and `fields` leaves out, or a column `fields` names that nothing writes. It drives each
// `toRow` with every key alone, every key cleared, every pair of keys and the full sample,
// then holds the union of `fields` to app.release_entities' allowlist: a release writes a
// column only when both agree, and the apply refuses any other with 22023.

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SAMPLE_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

type ToRow = (input: Record<string, unknown>) => Record<string, unknown>;

/** The columns one input writes; a refused input (an unsafe href cleared to null) writes none. */
function emitted(toRow: ToRow, input: Record<string, unknown>): string[] {
  try {
    return Object.keys(toRow(input));
  } catch {
    return [];
  }
}

const union = (fields: Readonly<Record<string, readonly string[]>>, keys: readonly string[]) =>
  new Set(keys.flatMap((key) => fields[key] ?? []));

const sorted = (list: Iterable<string>) => [...list].sort();

/**
 * The release-managed entries whose `toRow` takes a partial payload (not entity SEO's PUT,
 * nor page visibility's, Admin v2 U14a: both full replaces, checked below).
 */
const PATCHABLE = Object.values(RELEASE_REGISTRY).filter(
  (e) => e.kind !== 'entitySeo' && e.kind !== 'pageVisibility',
);

function toRowOf(entry: RegistryEntry): ToRow {
  return (entry.resource?.toRow ?? entry.singleton?.toRow)!;
}

describe('every release-managed config declares fields', () => {
  it('each resource and singleton the registry binds has a non-empty map', () => {
    for (const entry of Object.values(RELEASE_REGISTRY)) {
      expect(Object.keys(entry.fields).length, entry.entityType).toBeGreaterThan(0);
    }
  });

  it('configs outside the registry (immediate by decision) may omit it', () => {
    const bound = new Set(Object.values(RELEASE_REGISTRY).map((e) => e.resource));
    for (const config of Object.values(RESOURCES)) {
      if (!bound.has(config)) expect(config.fields, config.entity).toBeUndefined();
    }
  });
});

for (const entry of PATCHABLE) {
  describe(`${entry.entityType}: toRow writes only what fields declares`, () => {
    const toRow = toRowOf(entry);
    const keys = Object.keys(entry.fields);
    const entity = entry.entityType;

    it('each key alone, and each key cleared, writes only its own columns', () => {
      for (const key of keys) {
        const allowed = new Set(entry.fields[key]);
        for (const value of [sampleOf(entity, key), null]) {
          const extra = emitted(toRow, { [key]: value }).filter((c) => !allowed.has(c));
          expect(extra, `${entity}.${key} = ${JSON.stringify(value)}`).toEqual([]);
        }
      }
    });

    it('every pair of keys writes only the two keys’ columns', () => {
      for (const [i, a] of keys.entries()) {
        for (const b of keys.slice(i + 1)) {
          const allowed = union(entry.fields, [a, b]);
          const input = { [a]: sampleOf(entity, a), [b]: sampleOf(entity, b) };
          const extra = emitted(toRow, input).filter((c) => !allowed.has(c));
          expect(extra, `${entity}: ${a} + ${b}`).toEqual([]);
        }
      }
    });

    it('the full sample writes only declared columns', () => {
      const allowed = union(entry.fields, keys);
      expect(emitted(toRow, samplesFor(entity)).filter((c) => !allowed.has(c))).toEqual([]);
    });

    it('every column a key declares is written by some input carrying that key', () => {
      for (const key of keys) {
        const seen = new Set<string>();
        const inputs: Record<string, unknown>[] = [
          { [key]: sampleOf(entity, key) },
          { [key]: null },
          samplesFor(entity),
          ...keys
            .filter((other) => other !== key)
            .map((other) => ({ [key]: sampleOf(entity, key), [other]: sampleOf(entity, other) })),
        ];
        for (const input of inputs) for (const c of emitted(toRow, input)) seen.add(c);
        const phantom = entry.fields[key]!.filter((c) => !seen.has(c));
        expect(phantom, `${entity}.${key}`).toEqual([]);
      }
    });
  });
}

describe('page_visibility: a full replace writes the declared columns', () => {
  const entry = RELEASE_REGISTRY.page_visibility;

  it('a save writes the mode and its three extras; a create adds the target', () => {
    const page = PAGE_VISIBILITY.WriteSchema.parse({
      target: { pageId: '11111111-1111-4111-8111-111111111111' },
      mode: 'hidden',
      redirectPageId: '22222222-2222-4222-8222-222222222222',
      hideFrom: '2026-11-01',
      showOn: '2026-11-08',
      version: 0,
    });
    const template = PAGE_VISIBILITY.WriteSchema.parse({
      target: { template: 'service' },
      mode: 'public',
      version: 0,
    });
    const meta = Object.keys(PAGE_VISIBILITY.toRow(page));
    expect(sorted(meta)).toEqual(['hide_from', 'mode', 'redirect_page_id', 'show_on']);
    expect(Object.keys(PAGE_VISIBILITY.toRow(template)).sort()).toEqual(sorted(meta));
    const targets = [
      ...Object.keys(PAGE_VISIBILITY.target(page)),
      ...Object.keys(PAGE_VISIBILITY.target(template)),
    ];
    expect(sorted([...meta, ...targets])).toEqual(
      sorted(union(entry.fields, Object.keys(entry.fields))),
    );
    expect(PAGE_VISIBILITY.toRow(page).hide_from).toBe('2026-10-31T21:00:00.000Z');
    expect(PAGE_VISIBILITY.toRow(template).redirect_page_id).toBeNull();
  });
});

describe('entity_seo: a full replace writes the declared columns', () => {
  const entry = RELEASE_REGISTRY.entity_seo;

  it('a save writes the six meta columns; a create adds the target', () => {
    const input = ENTITY_SEO.WriteSchema.parse({ ...samplesFor('entity_seo'), version: 0 });
    const meta = Object.keys(ENTITY_SEO.toRow(input));
    const target = Object.keys(ENTITY_SEO.target(input));
    expect(sorted([...meta, ...target])).toEqual(
      sorted(union(entry.fields, Object.keys(entry.fields))),
    );
    expect(sorted(target)).toEqual(['entity_id', 'entity_type']);
    expect(sorted(ENTITY_SEO.targetKeys)).toEqual(['entityId', 'entityType']);
  });
});

describe('the union of fields is the SQL allowlist', () => {
  // Never staged: the apply stamps a first publish, and a release is what gets scheduled.
  const NEVER = new Set(['published_at', 'scheduled_for']);
  // In the SQL allowlist although no payload key writes it (see registry.ts, Extra).
  const RESTORE_ONLY: Record<string, string[]> = { page_section: ['style'] };

  for (const row of registryRows()) {
    it(row.entityType, () => {
      const entry = RELEASE_REGISTRY[row.entityType as keyof typeof RELEASE_REGISTRY];
      const declared = [...union(entry.fields, Object.keys(entry.fields))].filter(
        (c) => !NEVER.has(c) && !entry.immediateColumns.includes(c),
      );
      expect(sorted([...declared, ...(RESTORE_ONLY[row.entityType] ?? [])])).toEqual(
        sorted(row.columns),
      );
      // The immediate columns are in fields (the legacy PATCH writes them) and exempt in SQL.
      for (const column of entry.immediateColumns) {
        expect(union(entry.fields, Object.keys(entry.fields)).has(column)).toBe(true);
      }
    });
  }
});

/** The keys of a write schema's object shape, under any refinements. */
function shapeKeys(schema: z.ZodTypeAny): string[] {
  let current: z.ZodTypeAny = schema;
  while (!('shape' in current) && '_def' in current && 'schema' in (current._def as object)) {
    current = (current._def as { schema: z.ZodTypeAny }).schema;
  }
  return Object.keys((current as z.AnyZodObject).shape).filter((key) => key !== 'version');
}

describe('fields covers exactly the payload keys the write schema accepts', () => {
  for (const entry of Object.values(RELEASE_REGISTRY)) {
    it(entry.entityType, () => {
      const schema =
        entry.resource?.createSchema ??
        entry.singleton?.schema ??
        entry.pageVisibility?.WriteSchema ??
        ENTITY_SEO.WriteSchema;
      expect(sorted([...Object.keys(entry.fields), ...entry.childKeys])).toEqual(
        sorted(shapeKeys(schema)),
      );
    });
  }
});
