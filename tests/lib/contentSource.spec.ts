import { join } from 'node:path';
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
// Today the seam is a pass-through: contentClient() is the anon client, the same instance,
// so every public query (and with it Tier A output, caching and RLS) is what it was.
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
  'src/lib/data/navigation.ts',
  'src/lib/data/pageSections.ts',
  'src/lib/data/portfolio.ts',
  'src/lib/data/search.ts',
  'src/lib/data/sectionMedia.ts',
  'src/lib/data/seo.ts',
  'src/lib/data/serviceCases.ts',
  'src/lib/data/services.ts',
  'src/lib/data/siteProfile.ts',
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

/** `contentClient()` itself. */
const isSeamCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'contentClient';

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

/** Lines where a query is built on something other than contentClient() itself. */
const offSeam = (ast: ts.SourceFile): number[] =>
  queries(ast)
    .filter((q) => !isSeamCall(q.root))
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
    // A loader builds every query on contentClient() itself, never on a client of its own.
    const loaders = parsed(files.filter((f) => CONTENT_LOADERS.includes(f.path)));
    expect(loaders).toHaveLength(CONTENT_LOADERS.length);
    expect(loaders.flatMap((f) => where(f.path, offSeam(f.ast)))).toEqual([]);
  });

  it('leaves the service role under src/lib/data/ to the named sinks only', () => {
    const serviceRole = dataFiles
      .filter((f) => f.names.has('serviceClient'))
      .map((f) => f.path)
      .sort();
    expect(serviceRole).toEqual(Object.keys(SERVICE_ROLE_SINKS).sort());
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
