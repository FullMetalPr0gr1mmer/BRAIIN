import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATE_DEFAULTS, DATASET_ONLY_COLUMNS } from '@/lib/preview/dataset';
import { PREVIEW_TABLES } from '@/lib/preview/relations';
import { ANON_COLUMNS, MIRRORED_POLICIES } from '@/lib/preview/visibility';

// The preview's copies of the database, held two-sided (Admin v2 R8): the three literals in
// supabase/tests/preview_dataset.test.sql are what pgTAP proves the database holds (anon's
// column grants, the column defaults a pending create starts from, the policies on an anon
// SELECT), and this spec proves the TypeScript maps equal those literals. A migration that
// moves a grant, a default or a policy fails pgTAP until the literal follows, and this spec
// until the mirror does.

const SQL = readFileSync(join(process.cwd(), 'supabase/tests/preview_dataset.test.sql'), 'utf8');

/** The body of one of the file's literal functions. */
function body(fn: string): string {
  const start = SQL.indexOf(`create function ${fn}()`);
  expect(start, fn).toBeGreaterThan(-1);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$', open + 2);
  return SQL.slice(open + 2, close);
}

/** A column default as pg_get_expr prints it → the JavaScript value it stands for. */
function defaultValue(expr: string): unknown {
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (/^-?\d+$/.test(expr)) return Number(expr);
  const typed = /^'(.*)'::([a-z_]+(?:\[\])?)$/.exec(expr);
  if (!typed) throw new Error(`a default this spec cannot read: ${expr}`);
  const [, text, type] = typed;
  if (type === 'jsonb') return JSON.parse(text!);
  if (type === 'text[]') {
    if (text !== '{}') throw new Error(`a non-empty array default: ${expr}`);
    return [];
  }
  return text;
}

describe('the mirror against the pgTAP literals', () => {
  it('ANON_COLUMNS equals _anon_columns()', () => {
    const rows = [...body('_anon_columns').matchAll(/\('([a-z_]+)', '([a-z0-9_,]+)'\)/g)].map(
      ([, table, cols]) => [table!, cols!.split(',')] as const,
    );
    // Since E8 and E4 (form_settings, custom_themes): eight.
    expect(rows).toHaveLength(8);
    expect(Object.fromEntries(rows)).toEqual(ANON_COLUMNS);
  });

  it('DATASET_ONLY_COLUMNS equals _dataset_only_columns()', () => {
    const rows = [...body('_dataset_only_columns').matchAll(/\('([a-z_]+)', '([a-z_,]+)'\)/g)].map(
      ([, table, cols]) => [table!, cols!.split(',')] as const,
    );
    expect(rows).toHaveLength(2);
    expect(Object.fromEntries(rows)).toEqual(DATASET_ONLY_COLUMNS);
  });

  it('CREATE_DEFAULTS equals _create_defaults()', () => {
    const literal: Record<string, Record<string, unknown>> = {};
    for (const [, table, column, expr] of body('_create_defaults').matchAll(
      /\('([a-z_]+)', '([a-z_]+)', \$d\$(.*?)\$d\$\)/g,
    )) {
      (literal[table!] ??= {})[column!] = defaultValue(expr!);
    }
    expect(literal).toEqual(CREATE_DEFAULTS);
  });

  it('MIRRORED_POLICIES equals _anon_policies() (name, kind, USING md5), for every preview table', () => {
    const rows = [...body('_anon_policies').matchAll(/\('([a-z_]+)', '([a-zA-Z0-9_:,]+)'\)/g)].map(
      ([, table, pins]) =>
        [
          table!,
          Object.fromEntries(
            pins!.split(',').map((pin) => {
              const [name, kind, md5] = pin.split(':');
              return [name!, `${kind}:${md5}`];
            }),
          ),
        ] as const,
    );
    expect(rows.map(([table]) => table).sort()).toEqual([...PREVIEW_TABLES].sort());
    expect(Object.fromEntries(rows)).toEqual(MIRRORED_POLICIES);
    for (const pins of Object.values(MIRRORED_POLICIES)) {
      for (const pin of Object.values(pins))
        expect(pin).toMatch(/^(PERMISSIVE|RESTRICTIVE):[0-9a-f]{32}$/);
    }
  });

  it('the pgTAP plan counts its assertions', () => {
    const plan = Number(/select plan\((\d+)\);/.exec(SQL)?.[1]);
    const asserted = SQL.split('\n').filter((line) =>
      /^select (is|ok|throws_ok)\(/.test(line),
    ).length;
    expect(asserted).toBe(plan);
  });
});
