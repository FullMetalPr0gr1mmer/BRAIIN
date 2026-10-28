// Unused zod schemas leave the browser bundles (Admin v2 R13 merge train, owner item O-15).
//
// THE PROBLEM. A module in packages/schemas declares many schemas at its top level
// (`export const X = z.object({...}).strict()`), and a screen imports two or three of them.
// The bundler drops an unused export only when it can prove the statement has no side
// effects, and a call is opaque to it: `z.object(...)` might do anything, so every schema of
// every imported module shipped, used or not. In the admin chunks that was about 42 KB of
// minified schema code no screen ever ran (7 KB gzipped, measured on R13's merge with E1).
//
// THE FIX. Building a zod 3 schema has no side effects: it constructs objects and stores the
// callbacks it is given (zod 3's `types.js`, nothing global). This transform marks a call
// chain rooted at the module's zod import `/* @__PURE__ */`, so Rolldown may drop the
// statement when nothing reads its result; a schema something uses is kept exactly as
// written. A chain (`z.object(...).strict()`) is marked once, at its first character, which
// covers the whole chain; a nested call (`z.array(z.string())`) gets its own mark, because
// the arguments of a pure call are still checked for side effects.
//
// AN ALLOW-LIST, FAILING CLOSED (R13 review). A chain is marked only when
//   • every step is a schema-building member: a factory on `z` (ZOD_FACTORIES, or
//     `z.coerce.<ZOD_COERCE>`), then only calls of ZodType methods in ZOD_METHODS. A parse
//     (parse, safeParse, parseAsync, safeParseAsync, spa), a global write (setErrorMap) or a
//     zod 4 registry write (meta, register, describe) is refused, as is any property step that
//     is not called (`.options.map(fn)`, `.shape.x`, `.util`), a computed or optional step,
//     and a call of a call's result; and
//   • the chain sits where its value is used: a variable's initialiser, an object property's
//     value, an array element, an argument of another zod chain's call, an arrow's concise
//     body or a return value.
// Anything else (a statement on its own, `void`, `&&`, `?:`, a comma sequence, an optional
// call, a parse whose result an unused local holds) makes the BUILD FAIL naming the file and
// the rule, never a silent mark: marked pure, such a call could be deleted, and a validation
// would quietly vanish from the browser bundle while vitest, `astro dev` and the server
// bundle (none of which run this transform) still showed it working. A method or factory not
// on the lists is refused too: add it here, after checking zod 3 builds it without effects.
//
// AUTHORING RULES for packages/schemas (CLAUDE.md §8): one named `import { z } from 'zod'`
// per module (no namespace, default or other value import of zod, no second `z` binding of
// any kind); schemas only; no parse and no effect at module level.
//
// ZOD 3 ONLY. Zod 4's `.meta()`, `.register()` and `.describe()` write to `z.globalRegistry`,
// so the purity premise does not carry over: the plugin refuses to load unless the installed
// zod's major version is 3, and the premise must be reviewed before that changes.
//
// WHY NOT `treeshake.manualPureFunctions: ['z']`. Rolldown matches that list by NAME, not by
// binding: any function called `z` anywhere in the graph becomes pure, a minified
// dependency's local `z(...)` included, and its side effects would be deleted (tried: a
// local `z` that logs was removed). The marks here are placed only where the identifier IS
// the zod import, only in our own schema modules, and the transform refuses a module that
// declares another `z`, so a later edit cannot make it mark something that is not zod.
//
// SCOPE. `astro build`'s client environment only (the islands' and scripts' bundles); vitest,
// `astro dev` and the server and prerender bundles never run it. Server code is unchanged;
// the server manifest changes only by the admin chunk hashes it names. The public routes'
// JavaScript did not change when this landed (no public script reaches an unused schema);
// the admin chunks are what shrink. The transform returns no source map (client source maps
// are off), so it refuses a build that turns them on. Tested in tests/lib/zodPure.spec.ts.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Our schema modules: the only files the transform edits. */
export const SCHEMA_MODULE = /[\\/]packages[\\/]schemas[\\/][^\\/]+\.ts$/;

/** The import sources that name zod 3's `z`. */
const ZOD_SOURCES = new Set(['zod', 'zod/v3']);

/** Any import of zod, whatever the subpath. */
const ANY_ZOD = /^zod(\/|$)/;

/**
 * The factories on `z` a chain may start with: what packages/schemas uses, plus the zod 3
 * factories the review named. Each only constructs a schema (zod 3 `types.js` `create`).
 */
export const ZOD_FACTORIES = new Set([
  'any',
  'array',
  'bigint',
  'boolean',
  'date',
  'discriminatedUnion',
  'enum',
  'intersection',
  'lazy',
  'literal',
  'nativeEnum',
  'never',
  'null',
  'nullable',
  'number',
  'object',
  'optional',
  'preprocess',
  'record',
  'string',
  'tuple',
  'undefined',
  'union',
  'unknown',
]);

/** `z.coerce.<name>()`: the one property step a chain may take before its first call. */
export const ZOD_COERCE = new Set(['bigint', 'boolean', 'date', 'number', 'string']);

/**
 * The ZodType methods a chain may continue with: each returns a new schema and stores what it
 * is given (a callback is not run until a parse). Built from a scan of packages/schemas, plus
 * the schema-building methods the review named.
 */
export const ZOD_METHODS = new Set([
  'and',
  'array',
  'catch',
  'datetime',
  'default',
  'email',
  'extend',
  'finite',
  'int',
  'length',
  'max',
  'merge',
  'min',
  'multipleOf',
  'nonnegative',
  'nullable',
  'nullish',
  'omit',
  'optional',
  'or',
  'partial',
  'passthrough',
  'pick',
  'pipe',
  'positive',
  'refine',
  'regex',
  'startsWith',
  'strict',
  'superRefine',
  'toLowerCase',
  'toUpperCase',
  'transform',
  'trim',
  'url',
  'uuid',
]);

/** Members named in the refusal because they run or register something when called. */
const EFFECTFUL = new Set([
  'describe',
  'meta',
  'parse',
  'parseAsync',
  'register',
  'safeParse',
  'safeParseAsync',
  'setErrorMap',
  'spa',
]);

/** Wrappers that do not change where a value goes (gone after TypeScript is stripped). */
const TRANSPARENT = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
]);

/** Positions that are not a value, named for the refusal message. */
const POSITION_NAMES = {
  ExpressionStatement: 'a statement on its own',
  UnaryExpression: 'a unary operand (void, !, typeof)',
  LogicalExpression: 'an operand of && / || / ??',
  ConditionalExpression: 'a branch of ?:',
  SequenceExpression: 'a comma sequence',
  CallExpression: 'an argument of a call that is not a zod chain',
  ChainExpression: 'an optional chain',
};

const PURE = '/* @__PURE__ */ ';

/**
 * Throws unless `version` is a zod 3 release.
 * @param {string} version
 */
export function assertZodMajor(version) {
  if (Number.parseInt(version, 10) !== 3) {
    throw new Error(
      `scripts/zod-pure.mjs: the installed zod is ${version}, not 3. The plugin marks zod calls pure on zod 3's premise that building a schema has no side effects; zod 4's meta(), register() and describe() write to z.globalRegistry. Review the premise (and the allow-lists) before building with zod ${version}.`,
    );
  }
}

/** The installed zod's version, read from its package.json. */
export function installedZodVersion() {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(require.resolve('zod/package.json'), 'utf8'));
  return String(manifest.version);
}

/** @param {unknown} node */
function isNode(node) {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (/** @type {any} */ (node).type) === 'string'
  );
}

/**
 * Every AST node under `node`, depth first, with its parent.
 * @param {any} node
 * @param {any} parent
 * @param {(n: any, parent: any) => void} visit
 */
function walk(node, parent, visit) {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, node, visit);
    } else if (isNode(value)) {
      walk(value, node, visit);
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
 * The local name of the module's one `{ z }` import from zod, or null when it imports none.
 * Throws on any other value import of zod, or on two.
 * @param {any} program
 * @param {(rule: string) => never} refuse
 */
function zodBinding(program, refuse) {
  /** @type {string[]} */
  const locals = [];
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration' || !ANY_ZOD.test(stmt.source.value)) continue;
    if (stmt.importKind === 'type') continue;
    for (const spec of stmt.specifiers) {
      if (spec.importKind === 'type') continue;
      const imported =
        spec.type === 'ImportSpecifier'
          ? spec.imported.type === 'Identifier'
            ? spec.imported.name
            : spec.imported.value
          : null;
      if (imported !== 'z' || !ZOD_SOURCES.has(stmt.source.value)) {
        refuse(
          `imports zod other than as one named \`{ z }\` from 'zod' (here \`${spec.local.name}\` from '${stmt.source.value}')`,
        );
      }
      locals.push(spec.local.name);
    }
  }
  if (locals.length > 1) refuse(`imports zod's \`z\` more than once (${locals.join(', ')})`);
  return locals[0] ?? null;
}

/**
 * Marks every zod chain of a schema module pure, or throws when a chain is not on the
 * allow-list (see the header). Returns the new code, or null when the module imports no zod.
 * @param {string} code the module's code
 * @param {any} program its ESTree Program (offsets in UTF-16 code units)
 * @param {string} [id] the module's path, for the error message
 * @returns {string | null}
 */
export function annotateZodCalls(code, program, id = 'module') {
  /** @param {string} rule @returns {never} */
  const refuse = (rule) => {
    throw new Error(
      `scripts/zod-pure.mjs refuses ${id}: ${rule}. Schema modules hold schemas only (CLAUDE.md §8); see the rules in scripts/zod-pure.mjs.`,
    );
  };
  /** @param {any} node */
  const excerpt = (node) => `\`${code.slice(node.start, node.start + 80).replace(/\s+/g, ' ')}\``;

  const name = zodBinding(program, refuse);
  if (name === null) return null;

  /** @type {Map<any, any>} */
  const parents = new Map();
  /** @type {any[]} */
  const roots = [];
  walk(program, null, (node, parent) => {
    parents.set(node, parent);
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
      case 'MemberExpression':
        if (node.object.type === 'Identifier' && node.object.name === name) roots.push(node);
        break;
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === name) {
          refuse(`calls \`${name}\` itself: ${excerpt(node)}`);
        }
        break;
    }
    if (declared.includes(name)) {
      refuse(
        `declares its own \`${name}\` beside zod's (the marks reach every chain rooted at \`${name}\`, so rename one of them)`,
      );
    }
  });

  /**
   * The outermost transparent wrapper of `node`, and the parent above it.
   * @param {any} node
   */
  const up = (node) => {
    let outer = node;
    let parent = parents.get(node);
    while (parent && TRANSPARENT.has(parent.type)) {
      outer = parent;
      parent = parents.get(parent);
    }
    return { outer, parent };
  };

  /** @type {{ start: number, top: any, calls: any[] }[]} */
  const chains = [];
  /** @type {Set<any>} */
  const chainCalls = new Set();
  for (const first of roots) {
    /** @type {{ name: string, call: boolean }[]} */
    const steps = [];
    /** @type {any[]} */
    const calls = [];
    let cur = first.object;
    for (;;) {
      const { outer, parent } = up(cur);
      if (parent?.type === 'MemberExpression' && parent.object === outer) {
        if (parent.computed || parent.property.type !== 'Identifier') {
          refuse(`a zod chain takes a computed step: ${excerpt(first)}`);
        }
        if (parent.optional) refuse(`a zod chain takes an optional step: ${excerpt(first)}`);
        const above = up(parent);
        const call = above.parent?.type === 'CallExpression' && above.parent.callee === above.outer;
        steps.push({ name: parent.property.name, call });
        if (call) {
          if (above.parent.optional)
            refuse(`a zod chain makes an optional call: ${excerpt(first)}`);
          calls.push(above.parent);
          cur = above.parent;
        } else {
          cur = parent;
        }
        continue;
      }
      if (parent?.type === 'CallExpression' && parent.callee === outer) {
        refuse(`a zod chain calls the result of a call: ${excerpt(first)}`);
      }
      if (parent?.type === 'ChainExpression') {
        refuse(`a zod chain sits in an optional chain: ${excerpt(first)}`);
      }
      break;
    }
    // A chain with no call (`z.ZodIssueCode.custom`, `z.NEVER`) builds nothing: no mark.
    if (calls.length === 0) continue;

    let i = 0;
    const head = steps[0];
    if (head?.name === 'coerce' && !head.call) {
      const next = steps[1];
      if (!next?.call || !ZOD_COERCE.has(next.name)) {
        refuse(`\`${name}.coerce\` is not followed by a coercing factory: ${excerpt(first)}`);
      }
      i = 2;
    } else {
      if (!head?.call || !ZOD_FACTORIES.has(head.name)) {
        refuse(
          `\`${name}.${head?.name}\` is not a schema factory on the allow-list${EFFECTFUL.has(head?.name ?? '') ? ' (it runs or registers something when called)' : ''}: ${excerpt(first)}`,
        );
      }
      i = 1;
    }
    for (const step of steps.slice(i)) {
      if (!step.call) {
        refuse(
          `a zod chain reads the property \`.${step.name}\` (only schema-building calls may follow \`${name}\`): ${excerpt(first)}`,
        );
      }
      if (EFFECTFUL.has(step.name)) {
        refuse(
          `a zod chain calls \`.${step.name}()\`, which runs or registers something when called (a schema module builds schemas only): ${excerpt(first)}`,
        );
      }
      if (!ZOD_METHODS.has(step.name)) {
        refuse(
          `a zod chain calls \`.${step.name}()\`, which is not on the allow-list of schema-building methods: ${excerpt(first)}`,
        );
      }
    }
    for (const call of calls) chainCalls.add(call);
    chains.push({ start: first.start, top: up(cur), calls });
  }

  for (const { top } of chains) {
    const { outer, parent } = top;
    const ok =
      (parent?.type === 'VariableDeclarator' && parent.init === outer) ||
      (parent?.type === 'Property' &&
        parent.value === outer &&
        parent.kind === 'init' &&
        parents.get(parent)?.type === 'ObjectExpression') ||
      (parent?.type === 'ArrayExpression' && parent.elements.includes(outer)) ||
      (parent?.type === 'CallExpression' &&
        parent.arguments.includes(outer) &&
        chainCalls.has(parent)) ||
      (parent?.type === 'ArrowFunctionExpression' && parent.body === outer) ||
      (parent?.type === 'ReturnStatement' && parent.argument === outer);
    if (!ok) {
      const where = POSITION_NAMES[/** @type {keyof typeof POSITION_NAMES} */ (parent?.type)];
      refuse(
        `a zod chain sits in ${where ?? `a ${parent?.type ?? 'missing'} position`}, not where its value is used (a variable, a property, an array element, an argument of a zod call, an arrow body or a return): ${excerpt(outer)}`,
      );
    }
  }
  if (chains.length === 0) return code;

  let out = code;
  for (const at of [...new Set(chains.map((c) => c.start))].sort((a, b) => b - a)) {
    // Each chain is marked once, at its first character (the `z`), which covers the chain.
    if (!code.startsWith(name, at)) {
      refuse(`a zod chain at offset ${at} does not start with \`${name}\``);
    }
    out = out.slice(0, at) + PURE + out.slice(at);
  }
  return out;
}

/**
 * The Vite plugin: the client environment's schema modules, after TypeScript is stripped.
 * Throws at once when the installed zod is not zod 3.
 * @returns {import('vite').Plugin}
 */
export function zodPurePlugin() {
  assertZodMajor(installedZodVersion());
  return {
    name: 'braiin:zod-pure',
    apply: 'build',
    enforce: 'post',
    applyToEnvironment: (environment) => environment.name === 'client',
    buildStart() {
      if (this.environment?.config.build.sourcemap) {
        throw new Error(
          'scripts/zod-pure.mjs: client source maps are on, but the transform returns no map, so every schema module would map to the wrong columns. Return a map (MagicString) before turning them on.',
        );
      }
    },
    transform: {
      filter: { id: /[\\/]packages[\\/]schemas[\\/]/ },
      handler(code, id) {
        const file = id.split('?')[0] ?? id;
        if (!SCHEMA_MODULE.test(file)) return null;
        const next = annotateZodCalls(code, this.parse(code, { lang: 'ts' }), file);
        return next === null || next === code ? null : { code: next, map: null };
      },
    },
  };
}
