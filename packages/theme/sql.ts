import pairs from './pairs.json';
import { THEME_TOKEN_NAMES, THEME_TOKEN_PATTERNS } from '../schemas/themeTokens';

// The database's copy of the theme rules (Admin v2 E4), generated from the one source the
// editor and the Worker read: the pairs (pairs.json) and the token shapes
// (packages/schemas/themeTokens.ts). The E4 migration holds these blocks verbatim, between
// `-- BEGIN <name>` and `-- END <name>` lines, and tests/lib/themeSql.spec.ts fails when they
// differ, so the CHECK cannot drift from the gate. A change to either source needs a new
// migration that restates the function the block lives in.

type Def = string | [string, number, string];
interface Block {
  colors: Record<string, Def>;
  pairs: [string, string, number, string][];
}

const ROLE_ARG: Record<string, string> = {
  primary: 'p_primary',
  hover: 'p_hover',
  accent: 'p_accent',
  skySoft: 'p_sky_soft',
};

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A colour of a block as a SQL expression over the four arguments. */
function expr(block: Block, name: string, depth = 0): string {
  if (depth > 6) throw new Error(`pairs.json: ${name} nests too deep`);
  const def = block.colors[name];
  if (def === undefined) throw new Error(`pairs.json: no colour ${name}`);
  if (Array.isArray(def)) {
    const k = Math.round(def[1] * 100);
    return `app.theme_mix(${expr(block, def[0], depth + 1)}, ${k}, ${expr(block, def[2], depth + 1)})`;
  }
  if (def.startsWith('#')) return quote(def.toLowerCase());
  const arg = ROLE_ARG[def];
  if (!arg) throw new Error(`pairs.json: ${name} is ${def}`);
  return arg;
}

/** The pairs as `(fg, bg, min)` rows of a VALUES list, site then admin. */
export function pairsValuesSql(): string {
  const rows: string[] = [];
  for (const block of [pairs.site, pairs.admin] as unknown as Block[]) {
    for (const [fg, bg, min] of block.pairs) {
      rows.push(`    (${expr(block, fg)}, ${expr(block, bg)}, ${min.toFixed(1)}::float8)`);
    }
  }
  return rows.join(',\n');
}

/** The token shapes as `(name, pattern)` rows of a VALUES list. */
export function tokenRulesValuesSql(): string {
  return THEME_TOKEN_NAMES.map(
    (name) => `    (${quote(name)}, ${quote(THEME_TOKEN_PATTERNS[name].source)})`,
  ).join(',\n');
}

/** The brand defaults as `(role, hex)` rows (upper case, as settings store them). */
export function defaultsValuesSql(): string {
  return (['primary', 'hover', 'accent'] as const)
    .map((role) => `    (${quote(role)}, ${quote(pairs.defaults[role])})`)
    .join(',\n');
}

/** Every generated block, by the name its markers carry in the migration. */
export function themeSqlBlocks(): Record<string, string> {
  return {
    'theme pairs': pairsValuesSql(),
    'theme token rules': tokenRulesValuesSql(),
    'theme defaults': defaultsValuesSql(),
  };
}
