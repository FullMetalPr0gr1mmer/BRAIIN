import ts from 'typescript';
import { PUBLIC_MEDIA_COLUMNS } from '@schemas/content';
import { FORM_SETTINGS_PUBLIC_COLUMNS } from '@/lib/forms/config';
import { chainRoot, lineOf, nodesOf, scanTree } from './sourceScan';
import { join } from 'node:path';

// Every query the public content loaders build, read from their source with the
// TypeScript parser (Admin v2 R8): the table of each `contentClient().from('<table>')`, the
// select list it sends (string constants, templates and `+` concatenations evaluated, as
// the loaders write them), and every `contentClient().rpc('<name>')`. Used by
// tests/lib/previewSelect.spec.ts (each list parses) and tests/lib/previewLoaders.spec.ts
// (each table and embed target is in the preview's relations and mirror), so a slice that
// adds a public read cannot leave the preview behind.

export interface LoaderQuery {
  file: string;
  line: number;
  /** The table of a `.from()`, or null for an rpc. */
  table: string | null;
  /** The rpc's name, or null. */
  rpc: string | null;
  /** The evaluated select list, or null when the chain sends none. */
  select: string | null;
}

/** Identifiers a loader imports whose values a select list uses. */
const IMPORTED: Readonly<Record<string, string>> = {
  PUBLIC_MEDIA_COLUMNS,
  // The forms config's columns (Admin v2 E8): one list for the renderer and the endpoints.
  FORM_SETTINGS_PUBLIC_COLUMNS,
};

function evaluate(expr: ts.Expression, env: ReadonlyMap<string, string>): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr)) return evaluate(expr.expression, env);
  if (ts.isTemplateExpression(expr)) {
    return (
      expr.head.text +
      expr.templateSpans.map((s) => evaluate(s.expression, env) + s.literal.text).join('')
    );
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return evaluate(expr.left, env) + evaluate(expr.right, env);
  }
  if (ts.isIdentifier(expr)) {
    const value = env.get(expr.text) ?? IMPORTED[expr.text];
    if (value === undefined) throw new Error(`cannot evaluate ${expr.text}`);
    return value;
  }
  throw new Error(`cannot evaluate ${ts.SyntaxKind[expr.kind]}`);
}

const isSeamCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'contentClient';

/** Every query of every file under src/lib/data/ that calls contentClient(). */
export function loaderQueries(): LoaderQuery[] {
  const files = scanTree(join(process.cwd(), 'src/lib/data')).filter(
    (f) => f.ast && f.names.has('contentClient') && !f.path.endsWith('/source.ts'),
  );
  const out: LoaderQuery[] = [];
  for (const file of files) {
    const ast = file.ast!;
    const env = new Map<string, string>();
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        try {
          env.set(decl.name.text, evaluate(decl.initializer, env));
        } catch {
          // not a string constant
        }
      }
    }
    for (const node of nodesOf(ast)) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        !['from', 'rpc'].includes(node.expression.name.text) ||
        !isSeamCall(chainRoot(node.expression.expression))
      ) {
        continue;
      }
      const name = node.arguments[0];
      if (!name || !ts.isStringLiteral(name)) throw new Error(`${file.path}: a non-literal name`);
      let select: string | null = null;
      const access = node.parent;
      if (
        ts.isPropertyAccessExpression(access) &&
        access.name.text === 'select' &&
        ts.isCallExpression(access.parent) &&
        access.parent.arguments[0]
      ) {
        select = evaluate(access.parent.arguments[0], env);
      }
      const isRpc = node.expression.name.text === 'rpc';
      out.push({
        file: file.path,
        line: lineOf(node),
        table: isRpc ? null : name.text,
        rpc: isRpc ? name.text : null,
        select,
      });
    }
  }
  return out;
}
