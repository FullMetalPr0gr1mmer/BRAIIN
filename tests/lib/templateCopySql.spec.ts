import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_COPY_KEYS,
  TEMPLATE_COPY_MAX_BYTES,
  TEMPLATE_COPY_TEXT_MAX,
  TEMPLATE_KINDS,
  type TemplateCopyKey,
} from '@schemas/templateCopy';
import { TEMPLATE_COPY_PUBLIC_COLUMNS } from '@/lib/data/templateCopy';
import { templateCopySingleton } from '@/lib/admin/singletons/templateCopy';
import { ANON_COLUMNS } from '@/lib/preview/visibility';
import { CREATE_DEFAULTS } from '@/lib/preview/dataset';

// The two layers of the template pages' shared text (Admin v2 E3) say the same thing: the
// Worker's Zod catalogue (packages/schemas/templateCopyKeys.ts) and the database's CHECK
// (`app.template_copy_ok` in the E3 migration). A key added to one and not the other would
// either be refused by the database after the Worker took it (a 422 nobody can fix) or be
// writable around the Worker. The migration's number is a placeholder (the merge train
// renumbers it), so the file is found by its name.

const file = readdirSync('supabase/migrations').find((f) => f.endsWith('_template_copy.sql'));
const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
const fn = (() => {
  const start = sql.indexOf('create or replace function app.template_copy_ok');
  return sql.slice(start, sql.indexOf('$$;', start));
})();

/** The `when '<kind>' then array[...]` lists of the CHECK's catalogue, in order: lines, then accents. */
function sqlLists(kind: string): string[][] {
  const re = new RegExp(`when '${kind}' then array\\[([^\\]]*)\\]`, 'g');
  return [...fn.matchAll(re)].map((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((k) => k[1]!));
}

const keysOf = (kind: 'service' | 'project', which: TemplateCopyKey['kind']) =>
  (Object.entries(TEMPLATE_COPY_KEYS[kind]) as [string, TemplateCopyKey][])
    .filter(([, def]) => def.kind === which)
    .map(([key]) => key);

describe('app.template_copy_ok holds the catalogue (tests/lib/templateCopy.spec.ts is the Zod half)', () => {
  it('the migration is there, and its CHECK function is', () => {
    expect(file).toBeDefined();
    expect(fn).toContain('language sql immutable set search_path');
  });

  it('each template’s text keys and accent keys, in the catalogue’s order', () => {
    for (const kind of TEMPLATE_KINDS) {
      const [lines, accents] = sqlLists(kind);
      expect(lines, `${kind} lines`).toEqual(keysOf(kind, 'text'));
      expect(accents, `${kind} accents`).toEqual(keysOf(kind, 'accent'));
    }
  });

  it('the same outer bounds: 300 characters a line, 16 KB a template', () => {
    expect(fn).toContain(`char_length(e.value ->> 'en') <= ${TEMPLATE_COPY_TEXT_MAX}`);
    expect(fn).toContain(`char_length(e.value ->> 'ar') <= ${TEMPLATE_COPY_TEXT_MAX}`);
    expect(fn).toContain(`octet_length(p::text) <= ${TEMPLATE_COPY_MAX_BYTES}`);
  });

  it('the same forbidden characters: angle brackets and every C0 and C1 control', () => {
    expect(fn).toContain('like_regex "[<>\\u0001-\\u001f\\u007f-\\u009f]"');
  });

  it('one CHECK per template column', () => {
    for (const kind of TEMPLATE_KINDS) {
      expect(sql).toContain(
        `constraint template_copy_${kind} check (app.template_copy_ok('${kind}', ${kind}))`,
      );
      expect(templateCopySingleton.constraintFields?.[`template_copy_${kind}`]?.field).toBe(kind);
    }
  });
});

describe('one list of the columns anon reads', () => {
  it('the grant, the reader, the preview mirror and the create defaults agree', () => {
    const grant = /grant select \(([^)]+)\) on public\.template_copy to anon;/.exec(sql);
    expect(grant).not.toBeNull();
    const columns = grant![1]!.split(',').map((c) => c.trim());
    expect(columns).toEqual(['tenant_id', 'service', 'project']);
    expect(ANON_COLUMNS['template_copy']).toEqual(columns);
    expect(TEMPLATE_COPY_PUBLIC_COLUMNS.split(',')).toEqual(
      columns.filter((c) => c !== 'tenant_id'),
    );
    expect(CREATE_DEFAULTS['template_copy']).toEqual({ service: {}, project: {} });
    expect(templateCopySingleton.defaults).toEqual({ service: {}, project: {} });
  });

  it('the registry row’s writable columns are the two templates', () => {
    expect(sql).toMatch(/'\{admin,content_creator\}', '\{\}',\s*'\{service,project\}'/);
  });
});
