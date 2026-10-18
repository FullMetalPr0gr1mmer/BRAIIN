import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The admin's help guides as the migrations leave them (Admin v2 U16, H11), read from the SQL
// so the tests can hold them to the rules no CHECK can see (tests/lib/helpCentre.spec.ts).
//
// Until H11 every slice that touched a guide restated the whole set: app.help_article_set()
// was one `$help$ [...] $help$` literal, and the last migration to define it was the set.
// H11 (0069, numbered at merge) moved the guides into app.help_guide_catalog, one row per
// guide, filled from the set as the database held it, so the catalog starts as the LAST
// restatement before the catalog's own migration. From then on a migration adds or changes
// one guide with a top-level
//
//   select app.put_help_guide($guide$ { ...one guide... } $guide$::jsonb);
//
// and retires one with `select app.drop_help_guide('slug');`, each statement starting a line.
// The set is that seed plus every later put and drop, in migration order and, inside a
// migration, in the order written; listed by sort_order, as app.help_article_set() lists it.
//
// The reader is strict on purpose: a migration it cannot read must FAIL the tests, never be
// skipped. So after the catalog no migration may restate app.help_article_set() (it would
// replace the catalog's reader with a literal, and every guide put since would vanish from
// every new tenant), hold a `$help$` literal, write the catalog other than through put and
// drop, or call put or drop in any other shape (inside a DO block, through `perform`, with a
// non-literal argument): helpSetViolations() names each.

export interface MigrationFile {
  /** The file name, `NNNN_snake_case.sql`. */
  name: string;
  sql: string;
}

export interface HelpSet {
  /** The migration whose `$help$` literal the catalog was filled from. */
  base: string;
  /** The migration that creates the catalog, or null before H11 (the base is the set). */
  catalog: string | null;
  /** Every put and drop after the catalog, in order. */
  edits: { file: string; op: 'put' | 'drop'; slug: string }[];
  /** The guides, by sort_order then slug. */
  set: GuideJson[];
}

/** One guide as the migrations write it (HelpArticleSeedSchema holds its shape). */
export interface GuideJson {
  slug: string;
  sort_order: number;
  [key: string]: unknown;
}

const RESTATES = /create or replace function app\.help_article_set\(\)/;
const LITERAL = /\$help\$([\s\S]*?)\$help\$/;
const CREATES_CATALOG = /create table if not exists app\.help_guide_catalog\b/;
/** A put or a drop, as a whole top-level statement. */
const EDIT =
  /^select app\.(?:put_help_guide\(\$guide\$([\s\S]*?)\$guide\$::jsonb\)|drop_help_guide\('([^'\n]*)'\));[ \t]*\r?$/gm;
const NAMES_EDIT = /\b(?:put|drop)_help_guide\s*\(/;
const WRITES_CATALOG =
  /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into|alter\s+table)\s+(?:only\s+)?app\.help_guide_catalog\b/i;

const isComment = (line: string) => /^\s*--/.test(line);

/** Every migration, in the order production applies them. */
export function readMigrations(
  dir = join(process.cwd(), 'supabase', 'migrations'),
): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/** The `$help$` literal of one restatement, parsed. */
export function literalSet(file: MigrationFile): GuideJson[] {
  const literal = LITERAL.exec(file.sql)?.[1];
  if (literal === undefined)
    throw new Error(`${file.name}: app.help_article_set() has no $help$ literal`);
  return JSON.parse(literal) as GuideJson[];
}

const byPlace = (a: GuideJson, b: GuideJson) =>
  a.sort_order - b.sort_order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** The set the migrations leave: the last restatement before the catalog, then every edit. */
export function helpSet(files: MigrationFile[]): HelpSet {
  const at = files.findIndex((f) => CREATES_CATALOG.test(f.sql));
  const before = at === -1 ? files : files.slice(0, at);
  const restatements = before.filter((f) => RESTATES.test(f.sql));
  const baseFile = restatements[restatements.length - 1];
  if (!baseFile) throw new Error('no migration defines app.help_article_set()');
  const guides = new Map(literalSet(baseFile).map((g) => [g.slug, g]));
  const edits: HelpSet['edits'] = [];
  if (at !== -1) {
    for (const file of files.slice(at + 1)) {
      for (const m of file.sql.matchAll(EDIT)) {
        if (m[1] !== undefined) {
          const guide = JSON.parse(m[1]) as GuideJson;
          if (typeof guide.slug !== 'string') throw new Error(`${file.name}: a put without a slug`);
          guides.set(guide.slug, guide);
          edits.push({ file: file.name, op: 'put', slug: guide.slug });
        } else {
          const slug = m[2] ?? '';
          // As the database: a slug the catalog does not hold fails the push (P0002).
          if (!guides.delete(slug))
            throw new Error(`${file.name}: drops ${slug}, which no guide is`);
          edits.push({ file: file.name, op: 'drop', slug });
        }
      }
    }
  }
  return {
    base: baseFile.name,
    catalog: at === -1 ? null : (files[at]?.name ?? null),
    edits,
    set: [...guides.values()].sort(byPlace),
  };
}

/** What a migration after the catalog may not do, one line per breach (empty: none). */
export function helpSetViolations(files: MigrationFile[]): string[] {
  const at = files.findIndex((f) => CREATES_CATALOG.test(f.sql));
  if (at === -1) return [];
  const out: string[] = [];
  for (const file of files.slice(at + 1)) {
    if (RESTATES.test(file.sql))
      out.push(`${file.name}: restates app.help_article_set(); use app.put_help_guide`);
    if (/\$help\$/.test(file.sql)) out.push(`${file.name}: holds a $help$ literal`);
    // The statements the reader understands, with the lines they span.
    const read = new Set<number>();
    for (const m of file.sql.matchAll(EDIT)) {
      const first = file.sql.slice(0, m.index).split('\n').length - 1;
      const lines = m[0].split('\n').length;
      for (let i = first; i < first + lines; i += 1) read.add(i);
    }
    file.sql.split('\n').forEach((line, i) => {
      if (isComment(line) || read.has(i)) return;
      if (NAMES_EDIT.test(line))
        out.push(`${file.name}:${i + 1}: calls put/drop in a shape the reader cannot follow`);
      if (WRITES_CATALOG.test(line))
        out.push(
          `${file.name}:${i + 1}: writes app.help_guide_catalog other than through put/drop`,
        );
    });
  }
  return out;
}
