// Unused zod schemas leave the browser bundles (Admin v2 R13 merge train, owner item O-15).
//
// THE PROBLEM. A module in packages/schemas declares many schemas at its top level
// (`export const X = z.object({...}).strict()`), and a screen imports two or three of them.
// The bundler drops an unused export only when it can prove the statement has no side
// effects, and a call is opaque to it: `z.object(...)` might do anything, so every schema of
// every imported module shipped, used or not. In the admin chunks that was about 42 KB of
// minified schema code no screen ever ran (7 KB gzipped, measured on R13's merge with E1).
//
// THE FIX. Building a zod schema has no side effects: it constructs objects and stores the
// callbacks it is given (zod 3's `types.js`, nothing global). This transform marks each call
// rooted at the module's zod import `/* @__PURE__ */`, so Rolldown may drop the statement
// when nothing reads its result; a schema something uses is kept exactly as written. A chain
// (`z.object(...).strict()`) is marked once, at its first character, which covers the whole
// chain; a nested call (`z.array(z.string())`) gets its own mark, because the arguments of a
// pure call are still checked for side effects. A zod call made for its effect alone (a
// statement such as `z.setErrorMap(...)`) is refused: marked pure, it would be deleted.
//
// WHY NOT `treeshake.manualPureFunctions: ['z']`. Rolldown matches that list by NAME, not by
// binding: any function called `z` anywhere in the graph becomes pure, a minified
// dependency's local `z(...)` included, and its side effects would be deleted (tried: a
// local `z` that logs was removed). The marks here are placed only where the identifier IS
// the zod import, only in our own schema modules, and the transform refuses a module that
// declares another `z`, so a later edit cannot make it mark something that is not zod.
//
// SCOPE. The client environment only (the islands' and scripts' bundles). The server bundle
// is untouched: its size is not a budget, and its behaviour stays byte-for-byte as before.
// The public routes' JavaScript did not change when this landed (no public script reaches an
// unused schema); the admin chunks are what shrink. Tested in tests/lib/zodPure.spec.ts.

/** Our schema modules: the only files the transform edits. */
export const SCHEMA_MODULE = /[\\/]packages[\\/]schemas[\\/][^\\/]+\.ts$/;

/** The import sources that name zod. */
const ZOD_SOURCES = new Set(['zod', 'zod/v3']);

const PURE = '/* @__PURE__ */ ';

/** @param {unknown} node */
function isNode(node) {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (/** @type {any} */ (node).type) === 'string'
  );
}

/**
 * Every AST node under `node`, depth first.
 * @param {any} node
 * @param {(n: any) => void} visit
 */
function walk(node, visit) {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

/**
 * The names a binding pattern declares (`a`, `{ a, b: c }`, `[a, ...d]`, `a = 1`).
 * @param {any} pattern
 * @returns {string[]}
 */
function bindingNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((p) =>
        bindingNames(p.type === 'RestElement' ? p.argument : p.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((e) => bindingNames(e));
    case 'RestElement':
      return bindingNames(pattern.argument);
    case 'AssignmentPattern':
      return bindingNames(pattern.left);
    case 'TSParameterProperty':
      return bindingNames(pattern.parameter);
    default:
      return [];
  }
}

/**
 * The identifier a call chain starts from: `z` for `z.object(...).strict()`, else null.
 * @param {any} node
 * @returns {string | null}
 */
function chainRoot(node) {
  let n = node;
  for (;;) {
    if (n.type === 'Identifier') return n.name;
    if (n.type === 'MemberExpression') n = n.object;
    else if (n.type === 'CallExpression') n = n.callee;
    else return null;
  }
}

/**
 * Marks every call rooted at the module's zod import pure. Returns the new code, or null
 * when the module imports no zod (nothing to mark). Throws when the module declares a
 * second binding with the import's name: the marks would then reach calls that are not zod.
 * @param {string} code the module's code
 * @param {any} program its ESTree Program (offsets in UTF-16 code units)
 * @param {string} [id] the module's path, for the error message
 * @returns {string | null}
 */
export function annotateZodCalls(code, program, id = 'module') {
  /** @type {string | null} */
  let local = null;
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration' || !ZOD_SOURCES.has(stmt.source.value)) continue;
    if (stmt.importKind === 'type') continue;
    for (const spec of stmt.specifiers) {
      if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') continue;
      const imported =
        spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
      if (imported === 'z') local = spec.local.name;
    }
  }
  if (local === null) return null;
  const name = local;

  /** @type {Set<number>} */
  const marks = new Set();
  walk(program, (node) => {
    /** @type {string[]} */
    let declared = [];
    switch (node.type) {
      case 'VariableDeclarator':
        declared = bindingNames(node.id);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        declared = [...(node.id ? [node.id.name] : []), ...node.params.flatMap(bindingNames)];
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        declared = node.id ? [node.id.name] : [];
        break;
      case 'CatchClause':
        declared = bindingNames(node.param);
        break;
      case 'ExpressionStatement':
        if (
          node.expression.type === 'CallExpression' &&
          chainRoot(node.expression.callee) === name
        ) {
          throw new Error(
            `${id}: calls \`${name}\` for its effect alone; scripts/zod-pure.mjs would mark the call pure and the bundler would delete it`,
          );
        }
        break;
      case 'CallExpression':
        if (chainRoot(node.callee) === name) marks.add(node.start);
        break;
    }
    if (declared.includes(name)) {
      throw new Error(
        `${id}: declares its own \`${name}\` beside zod's; scripts/zod-pure.mjs marks every call rooted at \`${name}\` pure, so rename one of them`,
      );
    }
  });
  if (marks.size === 0) return code;

  let out = code;
  for (const at of [...marks].sort((a, b) => b - a)) {
    // A chain's calls share a start; each is marked once, at the chain's first character.
    if (!code.startsWith(name, at)) {
      throw new Error(`${id}: a zod call at offset ${at} does not start with \`${name}\``);
    }
    out = out.slice(0, at) + PURE + out.slice(at);
  }
  return out;
}

/**
 * The Vite plugin: the client environment's schema modules, after TypeScript is stripped.
 * @returns {import('vite').Plugin}
 */
export function zodPurePlugin() {
  return {
    name: 'braiin:zod-pure',
    apply: 'build',
    enforce: 'post',
    applyToEnvironment: (environment) => environment.name === 'client',
    transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (!SCHEMA_MODULE.test(file)) return null;
      const next = annotateZodCalls(code, this.parse(code, { lang: 'ts' }), file);
      return next === null || next === code ? null : { code: next, map: null };
    },
  };
}
