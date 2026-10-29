import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_ENTITY_META } from '@/lib/release/areas';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { COPY } from '@/components/admin/screens/versions/model';

// The release switch-on's runbook and read-back (Admin v2 R14-prep; docs/launch-runbook.md §6p,
// scripts/releases-switch-readback.sql). The owner runs both by hand on production, so what they
// name is held here to what the migrations define: the two switches' signatures (0112), the
// eight tables the switch converts, the other status tables it counts, and the read-back's
// columns to its own expected lists.

const runbook = readFileSync('docs/launch-runbook.md', 'utf8');
const section = runbook.slice(
  runbook.indexOf('### 6p. Releases: the switch-on'),
  runbook.indexOf('## 7. Cloudflare WAF'),
);
const readback = readFileSync('scripts/releases-switch-readback.sql', 'utf8');
const migration = readFileSync('supabase/migrations/0112_release_schedule.sql', 'utf8');

/** The `--   key = value` lines under one "Expected …:" heading of the read-back. */
function expectedKeys(heading: string): string[] {
  const lines = readback.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`-- ${heading}`));
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^--   ([a-z_0-9]+)\s+= /.exec(line);
    if (m) out.push(m[1]!);
    else if (!line.startsWith('--   ')) break;
  }
  return out;
}

/** The select list's aliases, in order. */
const aliases = [...readback.matchAll(/\bas ([a-z_0-9]+)(?:,|;)\s*$/gm)].map((m) => m[1]!);

/** app.enable_releases's own list of app.publish_scheduled()'s tables (0112). */
const switchTables = (() => {
  const m = /c_tables constant text\[\] := array\[([^\]]+)\]/.exec(migration);
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
})();

describe('scripts/releases-switch-readback.sql', () => {
  it('answers one column per expected line, in order, and nothing else', () => {
    const before = expectedKeys('Expected before the switch:');
    expect(before.length).toBeGreaterThan(15);
    expect(aliases).toEqual(before);
    // The "after" list names only columns the query has.
    for (const key of expectedKeys('Expected after the switch')) expect(aliases).toContain(key);
  });

  it('counts the eight tables the switch converts, as 0112 lists them', () => {
    expect(switchTables).toHaveLength(8);
    const block = readback.slice(
      readback.indexOf('(select\n'),
      readback.indexOf(') as legacy_to_convert'),
    );
    const converted = [...block.matchAll(/from public\.([a-z_]+) x/g)].map((m) => m[1]!);
    expect(converted.sort()).toEqual([...switchTables].sort());
    // Exactly app.publish_scheduled()'s rows: scheduled, with a time.
    expect(block.match(/'scheduled' and x\.scheduled_for is not null\)/g)).toHaveLength(8);
  });

  it('counts what the switch leaves: those tables with no time, and every other status table', () => {
    const left = readback.slice(
      readback.indexOf(') as legacy_to_convert'),
      readback.indexOf(') as left_scheduled'),
    );
    const named = [...left.matchAll(/from public\.([a-z_]+) x/g)].map((m) => m[1]!);
    const others = Object.values(RELEASE_REGISTRY)
      .filter((entry) => RELEASE_ENTITY_META[entry.entityType].hasStatus)
      .map((entry) => entry.table)
      .filter((table) => !switchTables.includes(table));
    expect(new Set(named)).toEqual(new Set([...switchTables, ...others]));
    // The other status tables count every scheduled row (no time needed to be left).
    for (const table of others) {
      expect(left).toMatch(new RegExp(`from public\\.${table} x where [^\\n]*'scheduled'\\)`));
    }
  });

  it('reads only: one SELECT, no write, no function but the flag and the catalog', () => {
    const body = readback
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/i);
    expect(body).not.toMatch(/enable_releases\(|disable_releases\(/);
    expect(body.trim().startsWith('with')).toBe(true);
    expect(body.trim().endsWith(';')).toBe(true);
  });
});

describe('docs/launch-runbook.md §6p', () => {
  it('rolls the drill back to the version just before its own, never to v1 (review S2, C1)', () => {
    // Restore vN takes back every version after N (releases.md §6.2), and a converted legacy
    // schedule can go live at any minute of the window: restoring v1 would take it back too.
    const drill = section.slice(section.indexOf('5. **The drill**'), section.indexOf('6. **End'));
    expect(drill).not.toMatch(/Restore\*? v1\b/);
    expect(drill).toContain('*Restore* the version listed just below it');
    expect(drill).toMatch(/check that vD\s+is still the newest version/);
    // The restore must hold the drill question alone, read off the confirm the page shows.
    expect(drill).toContain('"Its 1 change go live together"');
    expect(COPY.publishAgainBody(1, 1)).toContain('Its 1 change go live together');
    expect(drill).toContain('**Stop instead**');
    expect(drill).toContain('**Wait for the converted releases.**');
    // Every count after the switch is relative to the converted releases that fired.
    expect(readback).not.toMatch(/published_versions\s+= [1-9][0-9]*\s*$/m);
    expect(readback).not.toMatch(/= 3 and live_version = 3/);
    expect(readback).toMatch(/^--   published_versions\s+= 1 \+ legacy_fired$/m);
    expect(readback).toMatch(/^--   live_version\s+= published_versions$/m);
    expect(aliases).toContain('legacy_fired');
    expect(section).toContain('`legacy_fired`');
  });

  it('runs 0112’s switches as the owner, with the operator and the fallback scheduler (O-5)', () => {
    expect(migration).toContain(
      'create or replace function app.enable_releases(p_tenant uuid, p_operator uuid, p_fallback_scheduler uuid)',
    );
    expect(migration).toMatch(
      /create or replace function app\.disable_releases\(p_tenant uuid, p_operator uuid,\s+p_discard_pending boolean default false\)/,
    );
    expect(section).toContain(
      "select app.enable_releases('<tenant id>', '<operator profile id>', '<fallback admin profile id>');",
    );
    expect(section).toContain(
      "select app.disable_releases('<tenant id>', '<operator profile id>');",
    );
    expect(section).toContain(
      "select app.disable_releases('<tenant id>', '<operator profile id>', p_discard_pending => true);",
    );
  });

  it('names the freeze, the read-back before and after, the rehearsal, the drill and the discard rule', () => {
    expect(section).toMatch(/about 15 minutes/);
    expect(section).toContain('scripts/releases-switch-readback.sql');
    expect(existsSync('scripts/releases-switch-readback.sql')).toBe(true);
    expect(section).toContain('Expected before the switch');
    expect(section).toContain('Expected after the switch');
    expect(readback).toContain('-- Expected before the switch:');
    expect(readback).toContain('-- Expected after the switch');
    expect(section).toContain('Releases rehearsal');
    expect(existsSync('.github/workflows/releases-rehearsal.yml')).toBe(true);
    expect(section).toContain('tests/admin/releases-mode.e2e.ts');
    expect(section).toMatch(/\*Publish vN again\*/);
    expect(section).toContain('**The discard rule**');
    expect(section).toContain('not_restored');
    // The Worker's rollback line while releases are on.
    expect(section).toContain('42b61c6f');
  });
});
