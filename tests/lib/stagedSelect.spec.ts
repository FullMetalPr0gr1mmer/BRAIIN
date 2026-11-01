import { describe, expect, it } from 'vitest';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { stagedEntry, stagedSelect } from '@/lib/release/staged';
import { RESOURCES } from '@/lib/admin/resources';

// A staged save records, for each column it patches, the live value it started from
// (`recordBase` reads `live[column] ?? null`). A column the live read did not select would be
// recorded as a false null, and the publish (R4) would then refuse the change as a conflict.
// So the staged live read covers the registry's whole writable allowlist, whatever the
// editor's own select names (Admin v2 R3a).

/** The top-level names of a PostgREST select list (an embed by its name, an alias by itself). */
function names(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of `${list},`) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim().replace(/\(.*$/s, '').split(':')[0]!.trim());
      current = '';
    } else current += ch;
  }
  return out.filter(Boolean);
}

const entries = Object.values(RELEASE_REGISTRY);
const resources = entries.filter((e) => e.kind === 'resource');

describe('the staged live select covers the writable allowlist', () => {
  it('finds the entries it checks (the scan is not vacuous)', () => {
    expect(resources.length).toBeGreaterThanOrEqual(17);
    // four singletons (the identity, the SEO defaults, the forms config: E8, the header: E5),
    // entity SEO, visibility
    expect(entries.length).toBe(resources.length + 6);
  });

  it.each(resources.map((e) => [e.entityType, e] as const))(
    '%s: the editor’s select, widened',
    (_type, entry) => {
      const select = stagedSelect(entry, entry.resource!.columns);
      const got = new Set(names(select));
      for (const column of [...entry.columns, entry.key, 'version']) {
        expect(got.has(column), `${entry.entityType}.${column}`).toBe(true);
      }
      // Everything the editor selected is still selected, embeds included.
      for (const column of names(entry.resource!.columns)) expect(got.has(column)).toBe(true);
    },
  );

  it.each(entries.map((e) => [e.entityType, e] as const))(
    '%s: even from a select of the key alone',
    (_type, entry) => {
      const got = new Set(names(stagedSelect(entry, entry.key)));
      for (const column of [...entry.columns, entry.key, 'version']) {
        expect(got.has(column), `${entry.entityType}.${column}`).toBe(true);
      }
    },
  );

  it('names no column twice, and leaves `*` alone', () => {
    for (const entry of entries) {
      const list = names(stagedSelect(entry, entry.resource?.columns ?? entry.key));
      expect(new Set(list).size, entry.entityType).toBe(list.length);
    }
    expect(stagedSelect(resources[0]!, '*')).toBe('*');
  });

  it('every kernel config on a release-managed table stages through its own registry entry', () => {
    const staged = Object.values(RESOURCES).filter((config) => stagedEntry(config));
    expect(staged.map((c) => c.table).sort()).toEqual(resources.map((e) => e.table).sort());
    for (const config of staged) expect(stagedEntry(config)!.resource).toBe(config);
    // The media and Style-Finder configs stay immediate.
    for (const slug of ['media', 'ai-questions', 'ai-styles']) {
      expect(stagedEntry(RESOURCES[slug]!), slug).toBeUndefined();
    }
  });
});
