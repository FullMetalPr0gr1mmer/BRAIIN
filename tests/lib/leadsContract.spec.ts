import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  FULL_LEAD_COLUMNS,
  GATED_LEAD_COLUMNS,
  LEAD_WRITE_COLUMNS,
  LEGACY_LEAD_COLUMNS,
  PIPELINE_LEAD_COLUMNS,
  SAFE_LEAD_COLUMNS,
  SENSITIVE_LEAD_COLUMNS,
} from '@/lib/admin/leadFields';
import { DECRYPTED_FIELDS, PLAIN_GATED_FIELDS } from '@/lib/crm/reveal';
import { SETTINGS_COLUMNS } from '@/lib/crm/settings';
import { CASES } from '../authz/cases';
import { nodesOf, scanTree, type ScannedFile } from './sourceScan';

// The leads contract, part one (Admin v2 C14a): the Worker stops using what C14b drops, so the
// code runs on today's production schema (the legacy columns present, the legacy sync and the
// notes mirror still running) AND on C14b's (the columns gone), because C14b is applied while
// this code is live. A query naming a dropped column fails there (PostgREST's 42703), and a
// privilege or column removal needs a gate, not a grep (Wave 3 corrections, rule 6). This file
// is that gate, read with the TypeScript parser (comments are not code):
//
//   1. the two lead-only legacy columns (`timeline_band`, `ip_inet`) are named by no code under
//      src/, packages/, scripts/ or supabase/functions/, but the one list stripSensitive uses;
//      `internal_notes` only there and in job-application code (job_applications keeps its own,
//      0029);
//   2. no lead query names `status` or any dropped column: a `.from('leads')` chain, the
//      variable it is kept in and the calls made on it later, the crud helpers called with
//      'leads', and an embedded `leads(...)` read from another table; the identifiers such a
//      query names (a constant, an import, a function's result, a parameter's call sites) are
//      followed to what they hold;
//   3. no `crm_settings` query names `timezone` (U9 moved the studio's zone to site_settings);
//   4. the removed routes stay removed: the legacy list's GET, and the `?pii=1` alias (the CRM's
//      POST reveal is the one reveal).
//
// docs/admin-v2/as-built/C14a.md, "Notes for C14b", is the migration this protects.

const ROOTS = ['src', 'packages', 'scripts', join('supabase', 'functions')];
const DROPPED = ['status', 'internal_notes', 'ip_inet', 'timeline_band'] as const;
const LEAD_TABLES = new Set(['leads', 'leads_safe']);
const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Every scanned file under the roots, .astro frontmatter parsed as TypeScript. */
function sources(): ScannedFile[] {
  return ROOTS.filter((root) => existsSync(root)).flatMap((root) =>
    scanTree(root).map((file) => {
      if (!file.path.endsWith('.astro')) return file;
      const text = readFileSync(file.path, 'utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      const ast = ts.createSourceFile(`${file.path}.ts`, front, ts.ScriptTarget.Latest, true);
      // The template is read as words (comments too): stricter, never looser.
      return { ...file, ast, template: text.slice(front.length) } as ScannedFile;
    }),
  );
}

const FILES = sources();

/** The words a file's CODE uses: identifiers, and every word of its string literals. */
function codeWords(file: ScannedFile): Set<string> {
  const template = (file as ScannedFile & { template?: string }).template;
  if (!file.ast) return new Set(file.names);
  const words = new Set<string>(template ? (template.match(WORD) ?? []) : []);
  for (const node of nodesOf(file.ast)) {
    if (ts.isIdentifier(node)) words.add(node.text);
    else if (literalText(node) !== null) {
      for (const w of literalText(node)!.match(WORD) ?? []) words.add(w);
    }
  }
  return words;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  return null;
}

// ── Following a name to what it holds ──────────────────────────────────────────────────────

const parsed = new Map<string, ts.SourceFile | null>();

function astOf(path: string): ts.SourceFile | null {
  if (!parsed.has(path)) {
    const known = FILES.find((f) => f.path === path)?.ast;
    if (known) parsed.set(path, known);
    else if (existsSync(path) && statSync(path).isFile() && /\.[cm]?[jt]sx?$/.test(path)) {
      parsed.set(
        path,
        ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true),
      );
    } else parsed.set(path, null);
  }
  return parsed.get(path) ?? null;
}

/** The repo file an import names (the tsconfig aliases), or null for a package. */
function moduleFile(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('@schemas/')) base = `packages/schemas/${spec.slice(9)}`;
  else if (spec.startsWith('.')) base = join(dirname(from), spec).replaceAll('\\', '/');
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const fileOf = (node: ts.Node) => node.getSourceFile().fileName.replace(/\.astro\.ts$/, '.astro');

/** Every declaration of `name` in the file: a variable, a function, an import, a parameter. */
function declarations(ast: ts.SourceFile, name: string): ts.Node[] {
  return nodesOf(ast).filter(
    (node) =>
      ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.name.text === name) ||
      (ts.isImportSpecifier(node) && node.name.text === name),
  );
}

/** A function's name, for finding its calls: `function f` or `const f = (…) =>`. */
function functionName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text;
  }
  return null;
}

/** What a declaration holds, as words, following the names it uses in turn. */
function declarationWords(decl: ts.Node, seen: Set<ts.Node>, out: Set<string>): void {
  if (seen.has(decl) || seen.size > 400) return;
  seen.add(decl);
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    wordsOf(decl.initializer, seen, out);
  } else if (ts.isFunctionDeclaration(decl) && decl.body) {
    wordsOf(decl.body, seen, out);
  } else if (ts.isImportSpecifier(decl)) {
    const imported = (decl.propertyName ?? decl.name).text;
    const spec = decl.parent.parent.parent.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) return;
    const target = moduleFile(fileOf(decl), spec.text);
    const ast = target ? astOf(target) : null;
    if (!ast) return;
    for (const found of declarations(ast, imported)) {
      if (!ts.isParameter(found)) declarationWords(found, seen, out);
    }
  } else if (ts.isParameter(decl)) {
    // A parameter holds what its callers pass: the same file's calls of its function.
    const fn = decl.parent;
    const name = functionName(fn);
    const index = (fn as ts.SignatureDeclaration).parameters.indexOf(decl);
    if (!name || index < 0) return;
    for (const node of nodesOf(decl.getSourceFile())) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name &&
        node.arguments[index]
      ) {
        wordsOf(node.arguments[index]!, seen, out);
      }
    }
  }
}

/**
 * The words an expression puts in a query: its string literals' words, the keys of its
 * object literals, and what the names it uses hold. A member name (`input.status`'s
 * `status`) is not one: it reads a value, it names no column.
 */
function wordsOf(root: ts.Node, seen: Set<ts.Node>, out: Set<string>): void {
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null) {
      for (const w of text.match(WORD) ?? []) out.add(w);
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (ts.isPropertyAssignment(parent) && parent.name === node) out.add(node.text);
      else if (ts.isShorthandPropertyAssignment(parent)) {
        out.add(node.text);
        for (const decl of declarations(node.getSourceFile(), node.text)) {
          declarationWords(decl, seen, out);
        }
      } else if (
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !(
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isBindingElement(parent) ||
            ts.isFunctionDeclaration(parent)) &&
          parent.name === node
        )
      ) {
        for (const decl of declarations(node.getSourceFile(), node.text)) {
          declarationWords(decl, seen, out);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

// ── Lead queries ────────────────────────────────────────────────────────────────────────────

/** Filters whose first argument names a column; the value after it names none. */
const COLUMN_FIRST = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'likeAllOf',
  'likeAnyOf',
  'ilikeAllOf',
  'ilikeAnyOf',
  'is',
  'in',
  'contains',
  'containedBy',
  'overlaps',
  'rangeGt',
  'rangeGte',
  'rangeLt',
  'rangeLte',
  'rangeAdjacent',
  'textSearch',
  'not',
  'order',
]);
/** Calls every argument of which can name a column (a list, a filter string, a row's keys). */
const COLUMN_ALL = new Set(['select', 'or', 'filter', 'match', 'update', 'insert', 'upsert']);

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isAwaitExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

interface Link {
  method: string;
  args: readonly ts.Expression[];
}

/** The calls of a member chain, innermost first, and the expression it starts from. */
function chainOf(expr: ts.Expression): { root: ts.Expression; links: Link[] } {
  const links: Link[] = [];
  let e = unwrap(expr);
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    links.unshift({ method: e.expression.name.text, args: e.arguments });
    e = unwrap(e.expression.expression);
  }
  return { root: e, links };
}

/** `.from('<table>')` in a chain, or null. */
function tableOf(links: readonly Link[]): string | null {
  for (const link of links) {
    const arg = link.args[0];
    if (link.method === 'from' && arg && ts.isStringLiteralLike(arg)) return arg.text;
  }
  return null;
}

const isOutermost = (node: ts.CallExpression) =>
  !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node);

const enclosingFunction = (node: ts.Node): ts.Node => {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return at;
  return node.getSourceFile();
};

export interface Query {
  file: string;
  line: number;
  table: string;
  words: Set<string>;
}

/** Every query of a parsed file on `tables`: its column words, followed through names. */
export function queriesOf(ast: ts.SourceFile, tables: ReadonlySet<string>): Query[] {
  const file = fileOf(ast);
  const line = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const chains = nodesOf(ast)
    .filter((n): n is ts.CallExpression => ts.isCallExpression(n) && isOutermost(n))
    .map((node) => ({ node, ...chainOf(node) }));

  // A chain kept in a variable, and carried on later from it (`let q = …from('leads')…;
  // q = q.eq(…)`): the variable's calls in the same function are that table's too.
  const kept = new Map<string, string>(); // "<function start>:<name>" → table
  const keyOf = (node: ts.Node, name: string) => `${enclosingFunction(node).pos}:${name}`;
  for (const chain of chains) {
    const table = tableOf(chain.links);
    if (!table || !tables.has(table)) continue;
    const holder = chain.node.parent;
    const target =
      ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
        ? holder.name
        : ts.isBinaryExpression(holder) &&
            holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(holder.left)
          ? holder.left
          : null;
    if (target) kept.set(keyOf(holder, target.text), table);
  }

  const out: Query[] = [];
  for (const chain of chains) {
    let table = tableOf(chain.links);
    if (!table && ts.isIdentifier(chain.root)) {
      table = kept.get(keyOf(chain.node, chain.root.text)) ?? null;
    }
    if (table && tables.has(table)) {
      const words = new Set<string>();
      for (const link of chain.links) {
        const args = COLUMN_ALL.has(link.method)
          ? link.args
          : COLUMN_FIRST.has(link.method)
            ? link.args.slice(0, 1)
            : [];
        for (const arg of args) wordsOf(arg, new Set(), words);
      }
      out.push({ file, line: line(chain.node), table, words });
    }
    // The crud helpers: getRow(sb, 'leads', auth, id, columns), listRows(…, { columns, … }).
    const call = chain.node;
    if (ts.isIdentifier(call.expression)) {
      const named = call.arguments.find((a) => ts.isStringLiteralLike(a) && tables.has(a.text));
      if (named && ts.isStringLiteralLike(named)) {
        const words = new Set<string>();
        for (const arg of call.arguments.slice(1)) {
          if (arg !== named) wordsOf(arg, new Set(), words);
        }
        out.push({ file, line: line(call), table: named.text, words });
      }
    }
  }
  return out;
}

/** An embedded read of a lead table from another table's select: `leads(...)`, `leads!x(...)`. */
function embeddedLeadColumns(ast: ts.SourceFile): string[][] {
  const out: string[][] = [];
  for (const node of nodesOf(ast)) {
    const text = literalText(node);
    if (text === null) continue;
    for (const m of text.matchAll(/\bleads(?:_safe)?(?:![\w]+)?\s*\(([^)]*)\)/g)) {
      out.push(m[1]!.match(WORD) ?? []);
    }
  }
  return out;
}

const parse = (code: string) => ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true);

// ── The gate ────────────────────────────────────────────────────────────────────────────────

describe('the columns C14b drops', () => {
  it('are named once, for stripSensitive and the tests, as the as-built note lists them', () => {
    expect([...LEGACY_LEAD_COLUMNS]).toEqual([...DROPPED]);
  });

  it('are in none of the projections a query sends, nor the reveal or the CRM settings', () => {
    const projections: Record<string, string> = {
      SAFE_LEAD_COLUMNS,
      GATED_LEAD_COLUMNS,
      PIPELINE_LEAD_COLUMNS,
      LEAD_WRITE_COLUMNS,
      FULL_LEAD_COLUMNS,
      SENSITIVE_LEAD_COLUMNS: SENSITIVE_LEAD_COLUMNS.join(','),
      PLAIN_GATED_FIELDS: PLAIN_GATED_FIELDS.join(','),
      DECRYPTED_FIELDS: Object.values(DECRYPTED_FIELDS).join(','),
    };
    for (const [name, list] of Object.entries(projections)) {
      for (const column of DROPPED)
        expect(list.split(','), `${name}: ${column}`).not.toContain(column);
    }
    expect(SETTINGS_COLUMNS.split(',')).not.toContain('timezone');
  });
});

describe('no code names the lead-only legacy columns (C14a)', () => {
  it('scans the Worker, the shared packages and the scripts', () => {
    expect(FILES.filter((f) => f.path.startsWith('src/')).length).toBeGreaterThan(300);
    expect(FILES.filter((f) => f.path.startsWith('packages/')).length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.path === 'src/pages/admin/leads/[id].astro' && f.ast)).toBe(true);
  });

  const naming = (word: string) =>
    FILES.filter((f) => codeWords(f).has(word))
      .map((f) => f.path)
      .sort();

  it('timeline_band and ip_inet: only in LEGACY_LEAD_COLUMNS', () => {
    expect(naming('timeline_band')).toEqual(['src/lib/admin/leadFields.ts']);
    expect(naming('ip_inet')).toEqual(['src/lib/admin/leadFields.ts']);
    const fields = FILES.find((f) => f.path === 'src/lib/admin/leadFields.ts')!.ast!;
    for (const node of nodesOf(fields)) {
      if (
        !ts.isStringLiteralLike(node) ||
        !/\b(timeline_band|ip_inet|internal_notes)\b/.test(node.text)
      )
        continue;
      let at: ts.Node | undefined = node.parent;
      while (at && !ts.isVariableDeclaration(at)) at = at.parent;
      expect(at && ts.isVariableDeclaration(at) && at.name.getText(), node.text).toBe(
        'LEGACY_LEAD_COLUMNS',
      );
    }
  });

  it('internal_notes: only there and in job-application code (job_applications keeps its own)', () => {
    expect(naming('internal_notes')).toEqual([
      // The job-application drawer's notes field (0029).
      'src/components/admin/screens/applications/ApplicationDrawer.tsx',
      // job_applications.internal_notes in the detail projection (0029).
      'src/lib/admin/applicationFields.ts',
      'src/lib/admin/applicationView.ts',
      // Labels an audit row's field names: an application's notes, and older lead.update rows.
      'src/lib/admin/auditLabels.ts',
      'src/lib/admin/leadFields.ts',
      // The application PATCH writes job_applications.internal_notes.
      'src/pages/api/admin/applications/[id].ts',
    ]);
  });

  it('LEGACY_LEAD_COLUMNS itself is used by stripSensitive only, never by a query module', () => {
    expect(naming('LEGACY_LEAD_COLUMNS')).toEqual(['src/lib/admin/leadFields.ts']);
  });
});

describe('no lead query names a dropped column, and no CRM settings query the time zone', () => {
  const leadQueries = FILES.flatMap((f) => (f.ast ? queriesOf(f.ast, LEAD_TABLES) : []));
  const settingsQueries = FILES.flatMap((f) =>
    f.ast ? queriesOf(f.ast, new Set(['crm_settings'])) : [],
  );

  it('finds the lead queries the Worker makes', () => {
    const files = new Set(leadQueries.map((q) => q.file));
    for (const known of [
      'src/lib/admin/counters/leads.ts',
      'src/lib/admin/dashboard/loaders.ts',
      'src/lib/admin/notifications/leads.ts',
      'src/lib/crm/indexBackfill.ts',
      'src/lib/crm/leadPage.ts',
      'src/lib/crm/reveal.ts',
      'src/lib/data/leads.ts',
      'src/pages/admin/leads/[id].astro',
      'src/pages/api/admin/leads/[id].ts',
      'src/pages/api/admin/leads/export.ts',
      'src/pages/api/hooks/notify-lead.ts',
    ]) {
      expect(files, known).toContain(known);
    }
    // The export's own filters, carried on from the variable its chain is kept in.
    const exported = leadQueries.filter((q) => q.file === 'src/pages/api/admin/leads/export.ts');
    expect(exported.some((q) => q.words.has('assigned_to'))).toBe(true);
    // Followed through names: the projection constants an import holds.
    const detail = leadQueries.find((q) => q.file === 'src/pages/api/admin/leads/[id].ts')!;
    expect(detail.words).toContain('last_contact_channel');
    expect(settingsQueries.map((q) => q.file)).toContain('src/lib/crm/settings.ts');
  });

  it('none names status, internal_notes, ip_inet or timeline_band', () => {
    const found = leadQueries.flatMap((q) =>
      DROPPED.filter((column) => q.words.has(column)).map((c) => `${q.file}:${q.line} ${c}`),
    );
    expect(found).toEqual([]);
  });

  it('no other table embeds a dropped lead column', () => {
    const found = FILES.flatMap((f) =>
      f.ast
        ? embeddedLeadColumns(f.ast)
            .flat()
            .filter((w) => (DROPPED as readonly string[]).includes(w))
            .map((w) => `${f.path} ${w}`)
        : [],
    );
    expect(found).toEqual([]);
  });

  it('no crm_settings query names timezone (site_settings holds the studio zone since U9)', () => {
    const found = settingsQueries
      .filter((q) => q.words.has('timezone'))
      .map((q) => `${q.file}:${q.line}`);
    expect(found).toEqual([]);
  });

  it('the reader catches every way of writing it, and leaves values and other tables alone', () => {
    const hits = (code: string, tables = LEAD_TABLES) =>
      queriesOf(parse(code), tables).some((q) =>
        [...DROPPED, 'timezone'].some((c) => q.words.has(c)),
      );
    expect(hits("sb.from('leads').select('id,status')")).toBe(true);
    expect(hits("await sb.from('leads_safe').select('id').eq('internal_notes', x)")).toBe(true);
    expect(hits("let q = sb.from('leads').select('id'); if (a) q = q.eq('status', a);")).toBe(true);
    expect(hits("getRow(sb, 'leads', auth, id, 'id,timeline_band')")).toBe(true);
    expect(hits("listRows(sb, 'leads', auth, { filters: { status: input.status } })")).toBe(true);
    expect(hits("const COLS = 'id,' + 'ip_inet'; sb.from('leads').select(COLS)")).toBe(true);
    expect(hits('const C = `id,${"status"}`; sb.from("leads").select(C).maybeSingle()')).toBe(true);
    expect(hits("sb.from('leads').update({ internal_notes: null }).eq('id', id)")).toBe(true);
    expect(hits("const v = { status: 'done' }; sb.from('leads').update(v)")).toBe(true);
    expect(
      hits("function read(c: string) { return sb.from('leads').select(c); } read('id,status');"),
    ).toBe(true);
    expect(hits("sb.from('leads').or('status.eq.new,is_spam.eq.true')")).toBe(true);
    expect(
      hits("sb.from('crm_settings').select('version,timezone')", new Set(['crm_settings'])),
    ).toBe(true);
    // Not a column: a value, a member read, another table.
    expect(hits("sb.from('leads').select('id').eq('tenant_id', input.status)")).toBe(false);
    expect(hits("sb.from('services').select('slug').eq('status', 'published')")).toBe(false);
    expect(
      hits("let q = sb.from('services').select('slug'); q = q.eq('status', 'published');"),
    ).toBe(false);
    expect(hits("sb.from('leads').insert({ tenant_id: t, name }).select('id')")).toBe(false);
    expect(
      embeddedLeadColumns(parse("sb.from('lead_stages').select('id,leads!inner(status)')")).flat(),
    ).toContain('status');
  });
});

describe('the removed routes stay removed', () => {
  it('GET /api/admin/leads (the legacy list) is gone; adding a lead by hand stays', async () => {
    const list = await import('@/pages/api/admin/leads/index');
    expect('GET' in list).toBe(false);
    expect(typeof (list as Record<string, unknown>)['POST']).toBe('function');
  });

  it('no endpoint case drives a removed route', () => {
    for (const testCase of CASES) {
      const url = new URL(testCase.url, 'https://admin.example.test');
      const removed =
        (testCase.method === 'GET' && url.pathname === '/api/admin/leads') ||
        (url.pathname.startsWith('/api/admin/leads/') && url.searchParams.has('pii'));
      expect(removed, `${testCase.name}: ${testCase.method} ${testCase.url}`).toBe(false);
    }
  });

  it('no code asks a lead route for ?pii=1, or for the legacy list', () => {
    const found: string[] = [];
    for (const file of FILES) {
      if (!file.ast || !file.path.startsWith('src/')) continue;
      for (const node of nodesOf(file.ast)) {
        if (!ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) continue;
        const text = node.getText(file.ast);
        if (/\/api\/admin\/leads\/[^'"`\s]*[?&]pii=/.test(text)) found.push(`${file.path} ${text}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the CRM reveal is the one reveal: revealLead has one caller, asking for the reasons only', () => {
    const callers: string[] = [];
    for (const file of FILES) {
      if (!file.ast) continue;
      for (const node of nodesOf(file.ast)) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'revealLead'
        ) {
          callers.push(`${file.path} ${node.arguments[3]?.getText(file.ast) ?? ''}`);
        }
      }
    }
    expect(callers).toEqual(["src/pages/api/admin/leads/[id]/reveal.ts ['score_signals']"]);
  });
});
