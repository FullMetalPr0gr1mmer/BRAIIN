import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The admin's help guides as the migrations leave them (Admin v2 U16, H11), read from the SQL
// so the tests can hold them to the rules no CHECK can see (tests/lib/helpCentre.spec.ts).
//
// Until H11 every slice that touched a guide restated the whole set: app.help_article_set()
// was one `$help$ [...] $help$` literal, and the last migration to define it was the set.
// H11 (0069, numbered at merge) moved the guides into app.help_guide_catalog, one row per
// guide, filled from the set as the database held it, so the catalog starts as the LAST
// restatement before the catalog's own migration, every guide at revision 1. From then on a
// migration adds or changes one guide with a top-level
//
//   select app.put_help_guide($guide$ { ...one guide... } $guide$::jsonb, N);
//
// and retires one with `select app.drop_help_guide('slug', N);`, each statement starting a
// line, N the revision of the guide the migration was written against (0 for a new guide). A
// put that changes a guide moves its revision by one; one that changes nothing leaves it. The
// set is the seed plus every later put and drop, in migration order and, inside a migration,
// in the order written; listed by sort_order, as app.help_article_set() lists it.
//
// The revision is the guard hs_rebase.py was: two slices that edit one guide cannot both land
// silently. The second names a revision the guide has left, and fails here (with the revision
// to re-base on) as the database refuses it at the push (55000).
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

/** One guide as the migrations write it (HelpArticleSeedSchema holds its shape). */
export interface GuideJson {
  slug: string;
  sort_order: number;
  [key: string]: unknown;
}

export interface HelpSet {
  /** The migration whose `$help$` literal the catalog was filled from. */
  base: string;
  /** The migration that creates the catalog, or null before H11 (the base is the set). */
  catalog: string | null;
  /** Every put and drop after the catalog, in order, with the revision each names. */
  edits: { file: string; op: 'put' | 'drop'; slug: string; revision: number }[];
  /** The guides, by sort_order then slug. */
  set: GuideJson[];
  /** Each guide's revision as the catalog holds it (what the next edit of it must name). */
  revisions: Map<string, number>;
}

const RESTATES = /create or replace function app\.help_article_set\(\)/;
const LITERAL = /\$help\$([\s\S]*?)\$help\$/;
const CREATES_CATALOG = /create table if not exists app\.help_guide_catalog\b/;
/** A put or a drop, as a whole top-level statement. */
const EDIT =
  /^select app\.(?:put_help_guide\(\$guide\$([\s\S]*?)\$guide\$::jsonb, (\d+)\)|drop_help_guide\('([^'\n]*)', (\d+)\));[ \t]*\r?$/gm;
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

/** JSON with every object's keys sorted: equal values, equal text (as jsonb compares). */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

/** The set the migrations leave: the last restatement before the catalog, then every edit. */
export function helpSet(files: MigrationFile[]): HelpSet {
  const at = files.findIndex((f) => CREATES_CATALOG.test(f.sql));
  const before = at === -1 ? files : files.slice(0, at);
  const restatements = before.filter((f) => RESTATES.test(f.sql));
  const baseFile = restatements[restatements.length - 1];
  if (!baseFile) throw new Error('no migration defines app.help_article_set()');
  const guides = new Map(literalSet(baseFile).map((g) => [g.slug, g]));
  const revisions = new Map([...guides.keys()].map((slug) => [slug, 1]));
  const edits: HelpSet['edits'] = [];
  const stale = (file: string, op: string, slug: string, named: number) =>
    new Error(
      `${file}: ${op}s ${slug} at revision ${named}, but the migrations before it leave it at ` +
        `${revisions.get(slug) ?? 0}: a sibling changed it first. Merge main, write the guide on ` +
        `its current text and name revision ${revisions.get(slug) ?? 0}.`,
    );
  if (at !== -1) {
    for (const file of files.slice(at + 1)) {
      for (const m of file.sql.matchAll(EDIT)) {
        if (m[1] !== undefined) {
          const guide = JSON.parse(m[1]) as GuideJson;
          if (typeof guide.slug !== 'string') throw new Error(`${file.name}: a put without a slug`);
          const named = Number(m[2]);
          // As the database: a put names the revision the guide is at (0 for a new one).
          if (named !== (revisions.get(guide.slug) ?? 0))
            throw stale(file.name, 'put', guide.slug, named);
          const old = guides.get(guide.slug);
          if (!old) revisions.set(guide.slug, 1);
          else if (canonical(old) !== canonical(guide)) revisions.set(guide.slug, named + 1);
          guides.set(guide.slug, guide);
          edits.push({ file: file.name, op: 'put', slug: guide.slug, revision: named });
        } else {
          const slug = m[3] ?? '';
          const named = Number(m[4]);
          // As the database: a slug the catalog does not hold fails the push (P0002), and so
          // does a revision the guide is not at (55000).
          if (!guides.has(slug)) throw new Error(`${file.name}: drops ${slug}, which no guide is`);
          if (named !== revisions.get(slug)) throw stale(file.name, 'drop', slug, named);
          guides.delete(slug);
          revisions.delete(slug);
          edits.push({ file: file.name, op: 'drop', slug, revision: named });
        }
      }
    }
  }
  return {
    base: baseFile.name,
    catalog: at === -1 ? null : (files[at]?.name ?? null),
    edits,
    set: [...guides.values()].sort(byPlace),
    revisions,
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
