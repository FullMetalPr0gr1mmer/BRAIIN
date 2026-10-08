import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Reads source files as CODE for the static guard tests (tests/lib/contentSource.spec.ts).
// The TypeScript parser decides what a comment is, so a `/*` inside a string or a `//`
// comment ('https://*.cloudflarestream.com', "a /media/*.mp4 path") can never hide the code
// after it. A regex stripper did exactly that: it blanked an import in src/lib/client/clips.ts
// and most of the CSP builder in src/lib/http/securityHeaders.ts.
//
// TypeScript and JavaScript files are parsed. Any other text file (an .astro page, a
// stylesheet) is read whole, as words, its comments included: reading too much can only
// make a guard fail where it need not, never let code through.

/** Files the parser reads. */
const PARSED = /\.[cm]?[jt]sx?$/;
/** Files that hold no code at all: images, fonts, video. */
const BINARY = /\.(?:jpe?g|png|webp|avif|gif|ico|woff2?|ttf|otf|mp4|webm|pdf)$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export interface ScannedFile {
  /** Repo-relative, with forward slashes. */
  readonly path: string;
  /** Every name the code uses: identifiers, and string literals shaped like one. */
  readonly names: ReadonlySet<string>;
  /** The parsed file (parent pointers set), or null for a file read as words. */
  readonly ast: ts.SourceFile | null;
}

export function scanSource(path: string, text: string): ScannedFile {
  if (!PARSED.test(path)) {
    return { path, names: new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []), ast: null };
  }
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const node of nodesOf(ast)) {
    if (ts.isIdentifier(node)) names.add(node.text);
    // `client['anonClient']` names it too.
    else if (ts.isStringLiteralLike(node) && IDENTIFIER.test(node.text)) names.add(node.text);
  }
  return { path, names, ast };
}

/** Every text file under `dir`, scanned. */
export function scanTree(dir: string, root = process.cwd()): ScannedFile[] {
  const walk = (at: string): string[] =>
    readdirSync(at).flatMap((name) => {
      const path = join(at, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(dir)
    .filter((path) => !BINARY.test(path))
    .map((path) =>
      scanSource(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    );
}

/** Every node of a parsed file. Comments are not nodes, and neither is JSDoc here. */
export function nodesOf(ast: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

/** Where a member chain starts: `contentClient()` for `contentClient().from('x').select()`. */
export function chainRoot(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e)
    ) {
      e = e.expression;
    } else if (ts.isCallExpression(e) && !ts.isIdentifier(e.expression)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

/** True when the node runs inside a function body, not as its module loads. */
export function insideFunction(node: ts.Node): boolean {
  for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return true;
  return false;
}

/** The node's 1-based line. */
export function lineOf(node: ts.Node): number {
  const file = node.getSourceFile();
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}
