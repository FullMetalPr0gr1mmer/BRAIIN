import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contentClient } from '@/lib/data/source';
import { anonClient } from '@/lib/supabase/client';
import {
  chainRoot,
  insideFunction,
  lineOf,
  nodesOf,
  scanSource,
  scanTree,
  type ScannedFile,
} from './sourceScan';

// The content seam (src/lib/data/source.ts): every public content loader gets its Supabase
// client from contentClient(), so the releases preview (R8, docs/admin-v2/releases.md §6.3)
// has ONE place to swap in its overlay. A loader that reached the anon client another way
// would render live rows inside a preview and could not be caught by looking at the page.
//
// Outside a preview scope contentClient() is the anon client, the same instance, so every
// public query (and with it Tier A output, caching and RLS) is what it was. R8 added the
// scope (withContentSource) and the preview behind it (src/lib/preview); the last block of
// rules below keeps the two apart: only the listed entry points open a scope, the seam and
// the data modules import nothing of the preview, the preview reads through nothing but the
// person's own client, and none of them keeps state that could carry a preview's rows into
// a visitor's request. tests/lib/contentScope.spec.ts drives the scope itself.
//
// The rules read code, never comments: ./sourceScan.ts parses each file with TypeScript.

const files = scanTree(join(process.cwd(), 'src'));
const dataFiles = files.filter((f) => f.path.startsWith('src/lib/data/'));

const naming = (...names: string[]) =>
  files
    .filter((f) => names.some((name) => f.names.has(name)))
    .map((f) => f.path)
    .sort();

/** The only files that may name anonClient, and why. Exact: a stale entry fails too. */
const ANON_CLIENT_ALLOWED: Record<string, string> = {
  'src/lib/supabase/client.ts': 'defines it',
  'src/lib/data/source.ts': 'the seam: contentClient() returns it',
};

/**
 * The only files that may make a Supabase client or hold the anon key, and why. Without
 * this list a loader could build its own anon client and never name anonClient. Exact.
 */
const CLIENT_FACTORIES: Record<string, string> = {
  'src/lib/supabase/client.ts': 'the anon client, reached through the seam',
  'src/lib/supabase/server.ts': 'the service client (the service-role key, past RLS)',
  'src/lib/auth/session.ts': "the staff session client: the anon key with a signed-in user's JWT",
  'src/lib/auth/recovery.ts':
    'the recovery client (Admin v2 F7): the anon key, one per forgot or reset request, no cookie',
};
const FACTORY_NAMES = [
  'createClient',
  'createServerClient',
  'createBrowserClient',
  'PUBLIC_SUPABASE_ANON_KEY',
];

/**
 * The public content loaders: every file that calls contentClient(). Exact, both ways: a
 * loader that stops calling it fails, and so does a new caller until it is listed here.
 */
const CONTENT_LOADERS = [
  'src/lib/data/blog.ts',
  'src/lib/data/certifications.ts',
  'src/lib/data/disciplines.ts',
  'src/lib/data/faq.ts',
  'src/lib/data/ga4.ts',
  'src/lib/data/navigation.ts',
  'src/lib/data/pageSections.ts',
  'src/lib/data/portfolio.ts',
  'src/lib/data/search.ts',
  'src/lib/data/sectionMedia.ts',
  'src/lib/data/seo.ts',
  'src/lib/data/serviceCases.ts',
  'src/lib/data/services.ts',
  'src/lib/data/siteProfile.ts',
  'src/lib/data/siteVerification.ts',
  'src/lib/data/statistics.ts',
  'src/lib/data/taxonomy.ts',
  'src/lib/data/team.ts',
];

/**
 * The modules under src/lib/data/ that query as the SERVICE ROLE instead, and why. None of
 * them reads public content: each writes (or finds the tenant a write lands in) with the
 * tenant resolved server-side, so none belongs behind the seam. Exact, like the lists above.
 */
const SERVICE_ROLE_SINKS: Record<string, string> = {
  'src/lib/data/leads.ts': "the contact form's lead write (the submit-contact-form path)",
  'src/lib/data/systemLog.ts': 'the system_logs sink, written for anonymous callers too',
  'src/lib/data/telemetry.ts': 'the analytics event, web vitals and search query sinks',
  'src/lib/data/tenant.ts': 'the anon tenant fence: which tenant a public write lands in',
};

/**
 * The loaders that ALSO query as the service role, and why. Each is a public content loader
 * that stays behind the seam for everything a visitor may read, and reaches past it for one
 * named thing the seam cannot serve. Exact, like the lists above: a stale entry fails too.
 */
const SERVICE_ROLE_IN_LOADERS: Record<string, string> = {
  'src/lib/data/pageSections.ts':
    'the page password (Admin v2 U14b): a page behind a password is fenced from anon at RLS ' +
    '(0061), so a request that typed the password reads its sections through ' +
    'public.page_sections_unlocked, inside the page-access scope and for that page alone',
  'src/lib/data/sectionMedia.ts':
    "the page password (Admin v2 U14b): the media policy reads page_sections under anon's " +
    'RLS, which the fence (0061) now covers, so a request that typed the password reads the ' +
    "images its page's visible sections name through public.page_media_unlocked, inside the " +
    'page-access scope and for that page alone',
};

/** `contentClient()` itself. */
const isSeamCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'contentClient';

/** `serviceClient()`: the one other client a loader may name, for a listed reason. */
const isServiceCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'serviceClient';

/** A Supabase query starts at a client's .from() / .rpc() / .schema() / .channel() … */
const QUERY_CALLS = new Set(['from', 'rpc', 'schema', 'channel']);
/** … or at its .storage / .functions. */
const QUERY_PROPS = new Set(['storage', 'functions']);
/** Built-ins whose .from() is no query: Array.from, Buffer.from, the typed arrays. */
const NOT_A_CLIENT = /^(?:Array|Buffer|(?:Big)?(?:Ui|I)nt\d+(?:Clamped)?Array|Float\d+Array)$/;

/** Every query a file starts, with the expression its chain starts from. */
function queries(ast: ts.SourceFile): { line: number; root: ts.Expression }[] {
  return nodesOf(ast).flatMap((node) => {
    let receiver: ts.Expression | null = null;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      QUERY_CALLS.has(node.expression.name.text)
    ) {
      receiver = node.expression.expression;
    } else if (ts.isPropertyAccessExpression(node) && QUERY_PROPS.has(node.name.text)) {
      receiver = node.expression;
    }
    if (receiver === null) return [];
    const root = chainRoot(receiver);
    if (ts.isIdentifier(root) && NOT_A_CLIENT.test(root.text)) return [];
    return [{ line: lineOf(node), root }];
  });
}

/**
 * Lines where a query is built on something other than contentClient() itself. A loader
 * listed in SERVICE_ROLE_IN_LOADERS may also build one on serviceClient(), and must: the
 * count is asserted, so a listing left behind fails.
 */
const offSeam = (ast: ts.SourceFile, allowService = false): number[] =>
  queries(ast)
    .filter((q) => !isSeamCall(q.root) && !(allowService && isServiceCall(q.root)))
    .map((q) => q.line);

/** Lines where a query is built on serviceClient(). */
const onService = (ast: ts.SourceFile): number[] =>
  queries(ast)
    .filter((q) => isServiceCall(q.root))
    .map((q) => q.line);

/** Lines where contentClient() runs as its module loads, so one client would be kept. */
const atModuleLoad = (ast: ts.SourceFile): number[] =>
  nodesOf(ast)
    .filter((node) => isSeamCall(node) && !insideFunction(node))
    .map(lineOf);

/**
 * Lines where a builder made from contentClient() (directly, or through a variable such as
 * `let query = contentClient().from(…)`) is handed a callback instead of being awaited.
 */
function builderCallbacks(ast: ts.SourceFile): number[] {
  const nodes = nodesOf(ast);
  const builders = new Set<string>();
  const isBuilder = (e: ts.Expression): boolean => {
    const root = chainRoot(e);
    return isSeamCall(root) || (ts.isIdentifier(root) && builders.has(root.text));
  };
  // Grows until stable: `query = query.eq(…)` keeps a builder a builder.
  for (let grew = true; grew;) {
    grew = false;
    for (const node of nodes) {
      let name: string | null = null;
      let value: ts.Expression | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        name = node.name.text;
        value = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        name = node.left.text;
        value = node.right;
      }
      if (name !== null && value && !builders.has(name) && isBuilder(value)) {
        builders.add(name);
        grew = true;
      }
    }
  }
  return nodes
    .filter(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['then', 'catch', 'finally'].includes(node.expression.name.text) &&
        isBuilder(node.expression.expression),
    )
    .map(lineOf);
}

/**
 * The only files that may enter a preview scope (`withContentSource`), and why. Exact. R9:
 * the `/admin/preview` branch of src/middleware.ts, which calls this one after its session
 * gate (tests/lib/previewHandler.spec.ts drives it).
 */
const SCOPE_ENTRIES: Record<string, string> = {
  'src/lib/http/preview.ts':
    "the /admin/preview branch: after the middleware's session gate, the preview read caps, no page-access scope, a Tier A path",
};

/** Names src/lib/preview/** never uses: it reads only through the person's own client. */
const PREVIEW_FORBIDDEN_NAMES = [
  'anonClient',
  'serviceClient',
  'contentClient',
  'withContentSource',
  ...FACTORY_NAMES,
];

/**
 * Module-level values the seam, the loaders and the preview may create, and why: none holds a
 * request's data. Exact. Anything else at module level that is a `let`, a `var`, a `new …()`
 * or a constant something mutates fails, because a preview's overlaid rows kept there could
 * be served to a visitor from the same isolate. A new entry is a security review item.
 */
const MODULE_STATE_ALLOWED: Record<string, string> = {
  'src/lib/data/source.ts:scope': 'the AsyncLocalStorage instance the scope runs in',
  'src/lib/data/source.ts:openScopes': 'the sources open right now, each removed as its scope ends',
  'src/lib/preview/select.ts:memo': 'parse trees keyed by the select string alone (code constants)',
  'src/lib/data/pageSections.ts:KNOWN': 'the section type names, a constant set only read',
};

/**
 * Module-level values a NON-ADMIN module that reaches a loader through its imports may
 * create, and why (the seam, the loaders and the preview are the list above). A memo in a
 * loader's caller (identity, a page composer, the head builder) would carry a preview's
 * rows into a visitor's render just as one in a loader would. Exact; a new entry is a
 * security review item. Admin modules (src/lib/admin, src/components/admin, src/pages/admin,
 * src/pages/api/admin) never render a public page.
 */
const CALLER_STATE_ALLOWED: Record<string, string> = {
  'src/lib/legal/render.ts:TOKEN':
    'a global RegExp of the legal-notice tokens: no data (replace and matchAll reset lastIndex)',
  // The middleware reaches a loader since Admin v2 U15 (it reads the GA4 id before the
  // render, src/lib/data/ga4.ts). Its five module-level Sets are the request rules, built once
  // from literals and only ever asked `.has()`: no request writes them.
  'src/middleware.ts:OWN_BODY_LIMIT_ROUTES':
    'the public endpoints that bound their own bodies (H14), a constant Set only read (.has)',
  'src/middleware.ts:PRE_AUTH_PATHS': 'the pre-auth paths, a constant Set only read (.has)',
  'src/middleware.ts:REDIRECTABLE_METHODS':
    'the methods an authored redirect answers, a constant Set only read (.has)',
  'src/middleware.ts:SAFE_METHODS': 'the safe methods, a constant Set only read (.has)',
  'src/middleware.ts:SECOND_STEP_PATHS':
    "the second step's two paths, a constant Set only read (.has)",
};

/** Paths of admin code, which never renders a public page. */
const ADMIN_CODE = /^src\/(?:lib\/admin|components\/admin|pages\/admin|pages\/api\/admin)\//;

const MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'set',
  'add',
  'delete',
  'clear',
]);

/** The identifier a member chain starts at (`a` for `a.b[c].d`), or null. */
function memberRoot(expr: ts.Expression): string | null {
  let e = expr;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : null;
}

/** Module-level state a file creates: `let`/`var`, `new …()`, or a mutated constant. */
function moduleState(ast: ts.SourceFile): string[] {
  const found: string[] = [];
  const consts = new Set<string>();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) {
        found.push('a destructured module-level binding');
        continue;
      }
      const name = decl.name.text;
      if (!isConst) {
        found.push(name);
        continue;
      }
      let init = decl.initializer;
      while (
        init &&
        (ts.isAsExpression(init) ||
          ts.isSatisfiesExpression(init) ||
          ts.isParenthesizedExpression(init))
      ) {
        init = init.expression;
      }
      if (init && ts.isNewExpression(init)) found.push(name);
      else consts.add(name);
    }
  }
  for (const node of nodesOf(ast)) {
    let target: ts.Expression | null = null;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      target = node.left;
    } else if (ts.isDeleteExpression(node)) {
      target = node.expression;
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MUTATORS.has(node.expression.name.text)
    ) {
      target = node.expression.expression;
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Object' &&
      node.expression.name.text === 'assign' &&
      node.arguments[0]
    ) {
      target = node.arguments[0];
    }
    const root = target ? memberRoot(target) : null;
    if (root && consts.has(root) && !found.includes(root)) found.push(root);
  }
  return found;
}

/** A file's import and export specifiers (type-only too), as repo paths where they are ours. */
function importsOf(path: string, ast: ts.SourceFile): string[] {
  const specs: string[] = [];
  for (const node of nodesOf(ast)) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
  }
  return specs.map((spec) =>
    spec.startsWith('.')
      ? posix.normalize(posix.join(dirname(path).split('\\').join('/'), spec))
      : spec.replace(/^@\//, 'src/'),
  );
}

const parsed = (list: ScannedFile[]) =>
  list.flatMap((f) => (f.ast ? [{ path: f.path, ast: f.ast }] : []));
const where = (path: string, lines: number[]) => lines.map((line) => `${path}:${line}`);

describe('contentClient()', () => {
  it('is the anon client, the same memoised instance', () => {
    expect(contentClient()).toBe(anonClient());
    expect(contentClient()).toBe(contentClient());
  });
});

describe('the content seam', () => {
  it('is the only way to the anon client: no other file in src/ names anonClient', () => {
    expect(naming('anonClient')).toEqual(Object.keys(ANON_CLIENT_ALLOWED).sort());
  });

  it('leaves making a Supabase client, and the anon key, to the named factories', () => {
    expect(naming(...FACTORY_NAMES)).toEqual(Object.keys(CLIENT_FACTORIES).sort());
  });

  it('is used by the pinned content loaders, and by no other file', () => {
    expect(naming('contentClient')).toEqual([...CONTENT_LOADERS, 'src/lib/data/source.ts'].sort());
  });

  it('carries every query under src/lib/data/ except the named service-role sinks', () => {
    // Every module that queries is a loader or a sink, and each loader queries.
    const querying = parsed(dataFiles)
      .filter((f) => queries(f.ast).length > 0)
      .map((f) => f.path)
      .sort();
    expect(querying).toEqual([...CONTENT_LOADERS, ...Object.keys(SERVICE_ROLE_SINKS)].sort());
    // A loader that reaches past the seam is a loader first: it is on the list above.
    for (const path of Object.keys(SERVICE_ROLE_IN_LOADERS)) {
      expect(CONTENT_LOADERS).toContain(path);
    }
    // A loader builds every query on contentClient() itself, never on a client of its own.
    const loaders = parsed(files.filter((f) => CONTENT_LOADERS.includes(f.path)));
    expect(loaders).toHaveLength(CONTENT_LOADERS.length);
    expect(
      loaders.flatMap((f) => where(f.path, offSeam(f.ast, f.path in SERVICE_ROLE_IN_LOADERS))),
    ).toEqual([]);
    // Exactly the listed loaders reach past the seam, each with exactly one such query.
    const reaching = loaders
      .filter((f) => onService(f.ast).length > 0)
      .map((f) => f.path)
      .sort();
    expect(reaching).toEqual(Object.keys(SERVICE_ROLE_IN_LOADERS).sort());
    for (const f of loaders.filter((f) => f.path in SERVICE_ROLE_IN_LOADERS)) {
      expect(where(f.path, onService(f.ast))).toHaveLength(1);
    }
  });

  it('leaves the service role under src/lib/data/ to the named sinks only', () => {
    const serviceRole = dataFiles
      .filter((f) => f.names.has('serviceClient'))
      .map((f) => f.path)
      .sort();
    expect(serviceRole).toEqual(
      [...Object.keys(SERVICE_ROLE_SINKS), ...Object.keys(SERVICE_ROLE_IN_LOADERS)].sort(),
    );
  });

  it('is looked up as each query is built: never at module load, never in a builder callback', () => {
    // The preview's AsyncLocalStorage scope (R8) is not fully carried into a thenable's
    // then(), and a supabase-js builder is one; source.ts has the whole rule.
    const breaks = parsed(files.filter((f) => f.names.has('contentClient'))).flatMap((f) => [
      ...where(f.path, atModuleLoad(f.ast)),
      ...where(f.path, builderCallbacks(f.ast)),
    ]);
    expect(breaks).toEqual([]);
  });
});

describe('the scan behind these rules (tests/lib/sourceScan.ts)', () => {
  const scan = (path: string, ...lines: string[]) => scanSource(path, lines.join('\n'));

  it('finds code that sits after a /* in a line comment or a string', () => {
    // A regex stripper read each `/*` below as the start of a block comment and blanked
    // everything up to the next `*/`, so the code after it passed as a comment.
    const afterComment = scan(
      'x.ts',
      '//   data-clip-src      the file (a /media/*.mp4 path under EXC-009)',
      "import { anonClient } from '@/lib/supabase/client';",
      '/** A doc comment. */',
    );
    const afterString = scan(
      'y.ts',
      "const videoSrc = 'https://*.cloudflarestream.com';",
      "export const rows = () => anonClient().from('services');",
      '/** A doc comment. */',
    );
    expect(afterComment.names.has('anonClient')).toBe(true);
    expect(afterString.names.has('anonClient')).toBe(true);
  });

  it('leaves comments of every kind out, and counts a string that names it', () => {
    const commented = scan(
      'x.tsx',
      '// anonClient()',
      '/* anonClient() */',
      '/** {@link anonClient} */',
      'export const A = () => <p>{/* anonClient() */}</p>;',
    );
    expect(commented.names.has('anonClient')).toBe(false);
    expect(scan('y.ts', "const key = 'anonClient';").names.has('anonClient')).toBe(true);
  });

  it('reads an .astro file whole, as words', () => {
    const page = scan(
      'x.astro',
      '---',
      '// a /media/*.mp4 path',
      "import { anonClient } from '@/lib/supabase/client';",
      '---',
      '<p>hello</p>',
    );
    expect(page.ast).toBeNull();
    expect(page.names.has('anonClient')).toBe(true);
  });

  it('catches a query off the seam, a lookup at module load and a builder callback', () => {
    const { ast } = scan(
      'src/lib/data/fixture.ts',
      'const kept = contentClient();',
      'export async function load() {',
      '  const sb = contentClient();',
      "  await sb.from('services').select('id');",
      "  await createClient(URL, KEY).from('services').select('id');",
      "  await contentClient().storage.from('media').list();",
      "  let query = contentClient().from('team_members').select('id');",
      "  query = query.eq('status', 'published');",
      '  await query.then((r) => r);',
      "  await contentClient().rpc('search_content', {}).then((r) => r);",
      "  await Promise.resolve(1).then(() => contentClient().from('pages'));",
      '  return Array.from([kept]);',
      '}',
    );
    expect(offSeam(ast!)).toEqual([4, 5]);
    expect(atModuleLoad(ast!)).toEqual([1]);
    expect(builderCallbacks(ast!)).toEqual([9, 10]);
  });
});

describe('the preview scope (R8)', () => {
  const preview = files.filter((f) => f.path.startsWith('src/lib/preview/'));

  it('is entered only where listed (the middleware branch R9 added)', () => {
    expect(naming('withContentSource')).toEqual(
      ['src/lib/data/source.ts', ...Object.keys(SCOPE_ENTRIES)].sort(),
    );
  });

  it('the seam and every data module import nothing of the preview', () => {
    const reaching = parsed(dataFiles).flatMap((f) =>
      importsOf(f.path, f.ast)
        .filter((spec) => spec.startsWith('src/lib/preview'))
        .map((spec) => `${f.path} -> ${spec}`),
    );
    expect(reaching).toEqual([]);
  });

  it('the preview names no client factory, no anon key, neither the anon nor the service client', () => {
    expect(preview.length).toBeGreaterThanOrEqual(6);
    const named = preview.flatMap((f) =>
      PREVIEW_FORBIDDEN_NAMES.filter((name) => f.names.has(name)).map(
        (name) => `${f.path}: ${name}`,
      ),
    );
    expect(named).toEqual([]);
    const clients = parsed(preview).flatMap((f) =>
      importsOf(f.path, f.ast)
        .filter((spec) => spec.startsWith('src/lib/supabase') || spec === 'src/lib/auth/session')
        .map((spec) => `${f.path} -> ${spec}`),
    );
    expect(clients).toEqual([]);
  });

  it('keeps no cross-request state in the seam, the loaders or the preview', () => {
    const scanned = parsed(
      files.filter(
        (f) =>
          CONTENT_LOADERS.includes(f.path) ||
          f.path === 'src/lib/data/source.ts' ||
          f.path.startsWith('src/lib/preview/'),
      ),
    );
    expect(scanned).toHaveLength(CONTENT_LOADERS.length + 1 + preview.length);
    const state = scanned.flatMap((f) => moduleState(f.ast).map((name) => `${f.path}:${name}`));
    expect(state.sort()).toEqual(Object.keys(MODULE_STATE_ALLOWED).sort());
  });

  it('the state scan finds let, var, new and a mutated constant; the import scan every form', () => {
    const { ast } = scanSource(
      'src/lib/preview/fixture.ts',
      [
        'let a = 1;',
        'var b = 2;',
        'const c = new Map();',
        'const d: string[] = [];',
        'const e = { n: 0 };',
        'const f = [1, 2] as const;',
        'const g = { list: [] as number[] };',
        'const h = {};',
        'export function run(i: number) {',
        '  const local = new Set();',
        '  local.add(i);',
        '  d.push(String(i));',
        '  e.n += 1;',
        '  g.list.push(i);',
        '  Object.assign(h, { i });',
        '  return f.map((x) => x + i);',
        '}',
      ].join('\n'),
    );
    expect(moduleState(ast!).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'g', 'h']);
    const imports = scanSource(
      'src/lib/data/x.ts',
      [
        "import { a } from '../preview/client';",
        "import type { B } from '@/lib/preview/report';",
        "export { c } from './parse';",
        "const d = () => import('../preview/dataset');",
      ].join('\n'),
    );
    expect(importsOf('src/lib/data/x.ts', imports.ast!)).toEqual([
      'src/lib/preview/client',
      'src/lib/preview/report',
      'src/lib/data/parse',
      'src/lib/preview/dataset',
    ]);
  });

  it('keeps no cross-request state in any non-admin module that reaches a loader', () => {
    const code = parsed(files.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f.path)));
    const byPath = new Map(code.map((f) => [f.path, f]));
    const resolveSpec = (spec: string): string | null => {
      for (const ext of ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts']) {
        if (byPath.has(spec + ext)) return spec + ext;
      }
      return null;
    };
    const imports = new Map(
      code.map((f) => [
        f.path,
        importsOf(f.path, f.ast).flatMap((spec) => resolveSpec(spec) ?? []),
      ]),
    );
    // Every module that imports a loader, directly or through other modules.
    const reaching = new Set<string>(CONTENT_LOADERS);
    for (let grew = true; grew;) {
      grew = false;
      for (const [path, deps] of imports) {
        if (!reaching.has(path) && deps.some((d) => reaching.has(d))) {
          reaching.add(path);
          grew = true;
        }
      }
    }
    const callers = [...reaching].filter(
      (path) =>
        !CONTENT_LOADERS.includes(path) &&
        !path.startsWith('src/lib/preview/') &&
        path !== 'src/lib/data/source.ts' &&
        !ADMIN_CODE.test(path),
    );
    // The composers the review named are among them (the scan is not vacuous).
    expect(callers).toEqual(
      expect.arrayContaining([
        'src/lib/seo/head.ts',
        'src/lib/services/page.ts',
        'src/lib/portfolio/casePage.ts',
      ]),
    );
    const state = callers.flatMap((path) =>
      moduleState(byPath.get(path)!.ast).map((name) => `${path}:${name}`),
    );
    expect(state.sort()).toEqual(Object.keys(CALLER_STATE_ALLOWED).sort());
  });
});
