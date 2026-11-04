import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mix } from '@theme/colour';
import { channels } from '@theme/colour';
import { compileTheme, DEFAULT_THEME_SETTINGS, THEME_EFFECTS } from '@theme/compile';
import { themeSqlBlocks } from '@theme/sql';
import {
  ThemeColorsSchema,
  ThemeFontsSchema,
  ThemeMotionSchema,
  ThemeSettingsV1Schema,
  ThemeSettingsV2Schema,
  ThemeSettingsV3Schema,
  ThemeShapesSchema,
  ThemeTypeSchema,
} from '@schemas/theme';
import { FONT_STACK_TOKENS, THEME_TOKEN_NAMES } from '@schemas/themeTokens';
import { FONT_SCRIPTS, FONT_TOKENS, familiesOf, fontTokenRules } from '@theme/fonts';
import { SHAPE_TOKEN_NAMES, SHAPE_TOKEN_RULES } from '@theme/shapes';

// The database's copy of the theme rules (Admin v2 E4, E12): custom_themes_theme_v1, the CHECK
// the E4 migration adds, calls app.theme_row_ok and app.theme_palette_ok, whose pairs, token
// shapes, brand defaults, (since E12) shape and type choices and (since E13) the font catalogue's
// families are GENERATED from the files the editor and the Worker read (packages/theme/sql.ts).
// If they drift, the database refuses a theme the Worker accepted, or takes one it refused.
// pgTAP (supabase/tests/theme_settings, theme_shapes and theme_fonts) proves the CHECK runs;
// this proves it checks the same things.

const DIR = 'supabase/migrations';
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string | undefined) =>
  f ? readFileSync(`${DIR}/${f}`, 'utf8').replace(/\r\n/g, '\n') : '';
// E4's migration (the colour maths and the pairs), and the LATEST migration that restates
// app.theme_row_ok (E13's since the font catalogue: the token rules, the defaults, the effects,
// the shapes and type, the fonts). A later restatement takes over the second role, and these
// tests follow it.
const FILE = FILES.find((f) => /^\d{4}_theme_settings\.sql$/.test(f));
const SQL = read(FILE);
const ROW_OK_FILE = FILES.filter((f) =>
  read(f).includes('create or replace function app.theme_row_ok('),
).at(-1);
const ROW_OK_SQL = read(ROW_OK_FILE);

/** The latest migration that writes a block's markers. */
const holderOf = (name: string) =>
  FILES.filter((f) => read(f).includes(`-- BEGIN ${name}\n`)).at(-1);

/** The lines between `-- BEGIN <name>` and `-- END <name>`, as written. */
function block(name: string, sql: string): string | null {
  const open = sql.indexOf(`-- BEGIN ${name}\n`);
  const close = sql.indexOf(`\n    -- END ${name}\n`, open);
  if (open < 0 || close < 0) return null;
  return sql.slice(open + `-- BEGIN ${name}\n`.length, close);
}

/** A function's body in a migration, from its `create or replace` to the next one. */
function fn(name: string, sql = SQL): string {
  const at = sql.indexOf(`create or replace function app.${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  const end = sql.indexOf('create or replace function', at + 10);
  return sql.slice(at, end < 0 ? undefined : end);
}

describe('the theme migrations hold the generated rules', () => {
  it("E4's exists once, and E13 restates app.theme_row_ok last", () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith('_theme_settings.sql'))).toHaveLength(1);
    expect(ROW_OK_FILE).toMatch(/^\d{4}_theme_fonts\.sql$/);
  });

  it.each(Object.entries(themeSqlBlocks()))('%s: verbatim between its markers', (name, body) => {
    // The latest migration that writes the block holds what the editor and the Worker check:
    // the pairs in E4's app.theme_palette_ok, the rest in the latest app.theme_row_ok.
    const holder = holderOf(name);
    expect(holder, name).toBe(name === 'theme pairs' ? FILE : ROW_OK_FILE);
    const sql = read(holder);
    expect(block(name, sql), name).toBe(body);
    // Once: a second copy would be a block nothing holds equal.
    expect(sql.split(`-- BEGIN ${name}\n`)).toHaveLength(2);
  });

  it('the pairs are in app.theme_palette_ok, the shapes and defaults in app.theme_row_ok', () => {
    expect(fn('theme_palette_ok')).toContain('-- BEGIN theme pairs');
    const rowOk = fn('theme_row_ok', ROW_OK_SQL);
    expect(rowOk).toContain('-- BEGIN theme token rules');
    expect(rowOk).toContain('-- BEGIN theme defaults');
    expect(rowOk).toContain('-- BEGIN theme effects');
    expect(rowOk).toContain('-- BEGIN theme shape rules');
    expect(rowOk).toContain('-- BEGIN theme font rules');
  });
});

describe('app.theme_row_ok checks what the schemas and the compiler say', () => {
  const body = fn('theme_row_ok', ROW_OK_SQL);
  const arrays = (re: RegExp) =>
    [...body.matchAll(re)].map((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
  const array = (re: RegExp) => {
    const m = re.exec(body);
    expect(m, String(re)).not.toBeNull();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };

  it('the settings keys, each level closed, v1 (E4), v2 (E12) and v3 (E13)', () => {
    const [v1, v2, v3, ...more] = arrays(/is distinct from array\[('colors'[^\]]*)\]/g);
    expect(more).toEqual([]);
    expect(v1).toEqual(Object.keys(ThemeSettingsV1Schema.shape).sort());
    expect(v2).toEqual(Object.keys(ThemeSettingsV2Schema.shape).sort());
    expect(v2).toEqual(['colors', 'mode', 'motion', 'shapes', 'type', 'v']);
    expect(v3).toEqual(Object.keys(ThemeSettingsV3Schema.shape).sort());
    expect(v3).toEqual(['colors', 'fonts', 'mode', 'motion', 'shapes', 'type', 'v']);
    expect(array(/is distinct from array\[('arabic'[^\]]*)\]/)).toEqual(
      Object.keys(ThemeFontsSchema.shape).sort(),
    );
    expect(array(/is distinct from array\[('buttons'[^\]]*)\]/)).toEqual(
      Object.keys(ThemeShapesSchema.shape).sort(),
    );
    expect(array(/is distinct from array\[('headingCase'[^\]]*)\]/)).toEqual(
      Object.keys(ThemeTypeSchema.shape).sort(),
    );
    expect(array(/is distinct from array\[('accent'[^\]]*)\]/)).toEqual(
      Object.keys(ThemeColorsSchema.shape).sort(),
    );
    expect(array(/is distinct from array\[('marquee'[^\]]*)\]/)).toEqual(
      Object.keys(ThemeMotionSchema.shape).sort(),
    );
  });

  it('the modes and marquee speeds, and no other', () => {
    expect(array(/\(p_settings ->> 'mode'\) not in \(([^)]*)\)/)).toEqual(['simple', 'advanced']);
    expect(array(/\(v_motion ->> 'marquee'\) not in \(([^)]*)\)/)).toEqual([
      ...ThemeMotionSchema.shape.marquee.options,
    ]);
  });

  it('the colour tokens it requires are the ones the compiler writes for a theme', () => {
    const keys = array(/v_colour_keys constant text\[\] := array\[([^\]]*)\]/);
    const written = Object.keys(
      compileTheme({
        ...DEFAULT_THEME_SETTINGS,
        colors: { primary: '#000000', hover: '#615757', accent: '#938A8D' },
      }),
    );
    expect(keys).toEqual(written);
    expect(keys).toEqual(THEME_TOKEN_NAMES.slice(0, 8));
    expect(body).toContain('return v_present = 8');
  });

  it("the shape and type tokens: none on a v1 theme, the choice's own on a v2 or v3 one", () => {
    expect(array(/v_shape_keys constant text\[\] := array\[([^\]]*)\]/)).toEqual([
      ...SHAPE_TOKEN_NAMES,
    ]);
    expect([...SHAPE_TOKEN_NAMES]).toEqual(THEME_TOKEN_NAMES.slice(11, 15));
    expect(body).toMatch(/if v_version = 1 then\s+if p_tokens \?\| v_shape_keys then/);
    // Every setting is one of its choices, of its JSON type, and its token is that choice's.
    expect(body).toMatch(
      /-- END theme shape rules\s+\)\s+select 1\s+from \(select distinct grp, key from s\) as k\s+where not exists \(\s+select 1 from s as r\s+where r\.grp = k\.grp and r\.key = k\.key\s+and jsonb_typeof\(p_settings -> r\.grp -> r\.key\) = r\.kind\s+and \(p_settings -> r\.grp ->> r\.key\) = r\.choice\s+and \(p_tokens ->> r\.token\) is not distinct from r\.value\)\) then\s+return false;/,
    );
    // The table's choices are the schema's, every one, and the compiler writes each value.
    const choices = (key: string) =>
      SHAPE_TOKEN_RULES.filter((r) => r.key === key).map((r) => r.choice);
    expect(choices('corners')).toEqual([...ThemeShapesSchema.shape.corners.options]);
    expect(choices('buttons')).toEqual([...ThemeShapesSchema.shape.buttons.options]);
    expect(choices('headingCase')).toEqual([...ThemeTypeSchema.shape.headingCase.options]);
    expect(choices('headingWeight')).toEqual(
      ThemeTypeSchema.shape.headingWeight.options.map((o) => String(o.value)),
    );
    for (const rule of SHAPE_TOKEN_RULES) {
      const settings = {
        ...DEFAULT_THEME_SETTINGS,
        shapes: { ...DEFAULT_THEME_SETTINGS.shapes },
        type: { ...DEFAULT_THEME_SETTINGS.type },
      };
      const group = settings[rule.group] as unknown as Record<string, unknown>;
      group[rule.key] = rule.kind === 'number' ? Number(rule.choice) : rule.choice;
      const tokens = compileTheme(settings);
      expect(tokens[rule.token], `${rule.key} ${rule.choice}`).toBe(rule.value ?? undefined);
    }
  });

  it("the font tokens: none on a v1 or v2 theme, the family's own on a v3 one (E13)", () => {
    expect(array(/v_font_keys constant text\[\] := array\[([^\]]*)\]/)).toEqual([
      ...FONT_STACK_TOKENS,
    ]);
    expect([...FONT_STACK_TOKENS]).toEqual(THEME_TOKEN_NAMES.slice(15));
    expect([...FONT_STACK_TOKENS]).toEqual(FONT_SCRIPTS.map((s) => FONT_TOKENS[s]));
    expect(body).toMatch(/if v_version < 3 then\s+if p_tokens \?\| v_font_keys then/);
    // Each script's family is one of the catalogue's, a string, and its token that family's.
    expect(body).toMatch(
      /-- END theme font rules\s+\)\s+select 1\s+from \(select distinct key from f\) as k\s+where not exists \(\s+select 1 from f as r\s+where r\.key = k\.key\s+and jsonb_typeof\(v_fonts -> r\.key\) = 'string'\s+and \(v_fonts ->> r\.key\) = r\.choice\s+and \(p_tokens ->> r\.token\) is not distinct from r\.value\)\) then\s+return false;/,
    );
    // The table's choices are the schema's, script by script, and the compiler writes each.
    for (const script of FONT_SCRIPTS) {
      expect(
        fontTokenRules()
          .filter((r) => r.key === script)
          .map((r) => r.choice),
      ).toEqual(familiesOf(script).map((f) => f.id));
      expect(familiesOf(script).map((f) => f.id)).toEqual([
        ...ThemeFontsSchema.shape[script].options,
      ]);
    }
    for (const rule of fontTokenRules()) {
      const tokens = compileTheme({
        ...DEFAULT_THEME_SETTINGS,
        fonts: { ...DEFAULT_THEME_SETTINGS.fonts, [rule.key]: rule.choice },
      });
      expect(tokens[rule.token], `${rule.key} ${rule.choice}`).toBe(rule.value ?? undefined);
    }
  });

  it('each glow and shadow must be the compiler’s own string, not only of its shape', () => {
    // E4-SEC-2: a glow is a ground under text (.klein-band::before under white paper text),
    // so a white glow written straight to the table would defeat the contrast pairs.
    expect(body).toMatch(
      /and not exists \(\s*select 1\s+from \(values\s+-- BEGIN theme effects\n[\s\S]*?-- END theme effects\s+\) as e\(token, prefix, role, alpha\)\s+where \(p_tokens ->> e\.token\) is distinct from\s+e\.prefix \|\| app\.theme_rgba\(v_colors ->> e\.role, e\.alpha\)\)/,
    );
    // The table names every glow and shadow token, and the compiler writes each from it.
    expect(THEME_EFFECTS.map((e) => e.token)).toEqual(THEME_TOKEN_NAMES.slice(4, 8));
    const colors = { primary: '#000000', hover: '#615757', accent: '#938A8D' };
    const tokens = compileTheme({ ...DEFAULT_THEME_SETTINGS, colors });
    for (const e of THEME_EFFECTS) {
      const [r, g, b] = channels(colors[e.role])!;
      expect(tokens[e.token], e.token).toBe(`${e.prefix}rgba(${r}, ${g}, ${b}, ${e.alpha})`);
    }
  });

  it('app.theme_rgba writes a colour as the compiler does', () => {
    expect(fn('theme_rgba')).toContain(
      [
        "select 'rgba(' || string_agg(",
        "           (('x' || pg_catalog.substr(p_hex, x.at, 2))::bit(8)::int)::text, ', ' order by x.at)",
        "         || ', ' || p_alpha || ')'",
      ].join('\n'),
    );
    // The postconditions assert this sample; the compiler's channels agree.
    expect(SQL).toContain("app.theme_rgba('#0024BC', '0.42') <> 'rgba(0, 36, 188, 0.42)'");
    expect(channels('#0024BC')).toEqual([0, 36, 188]);
  });

  it('the motion tokens are what the motion settings compile to', () => {
    expect(body).toContain(
      "case v_motion ->> 'marquee' when 'slower' then '1.5' when 'slowest' then '2.5' end",
    );
    const slower = compileTheme({
      ...DEFAULT_THEME_SETTINGS,
      motion: { marquee: 'slower', reveal: true },
    });
    const slowest = compileTheme({
      ...DEFAULT_THEME_SETTINGS,
      motion: { marquee: 'slowest', reveal: false },
    });
    expect(slower).toEqual({ '--bs-marquee-scale': '1.5' });
    expect(slowest).toEqual({
      '--bs-marquee-scale': '2.5',
      '--bs-rv-from': '1',
      '--bs-rv-shift': '0px',
    });
  });
});

describe('the colour maths agree with the migration’s own samples', () => {
  it('mix(): whole channels rounded half up, as app.theme_mix', () => {
    // The postconditions assert these two of app.theme_mix.
    expect(SQL).toContain("app.theme_mix('#ffffff', 80, '#0024bc') <> '#ccd3f2'");
    expect(SQL).toContain("app.theme_mix('#ffffff', 70, '#0024bc') <> '#b3bdeb'");
    expect(mix('#ffffff', 0.8, '#0024bc')).toBe('#ccd3f2');
    expect(mix('#ffffff', 0.7, '#0024bc')).toBe('#b3bdeb');
    // A half: 255 × 0.7 + 0 × 0.3 = 178.5 rounds up in both (floating point would not).
    expect(mix('#ff0000', 0.7, '#000000')).toBe('#b30000');
    expect(fn('theme_mix')).toContain('(t.a * p_k + t.b * (100 - p_k) + 50) / 100');
  });

  it('the contrast threshold carries a tolerance of one billionth, never more', () => {
    expect(fn('theme_palette_ok')).toContain('>= t.m - 1e-9');
  });
});

// app.role_edits_theme (theme.edit's helper, E4-SEC-3) is created by E5's 0119 too.
// Its definition here is the canonical one, search_path pinned (E4 code review CR8): every
// migration that creates it repeats these three lines byte for byte, so the last definition
// never quietly drops the pin (tests/authz/sqlHelpers.spec.ts holds its role list).
const ROLE_EDITS_THEME_SQL = [
  'create or replace function app.role_edits_theme(r text) returns boolean',
  '  language sql immutable',
  "  set search_path = ''",
  "as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- theme.edit",
].join('\n');

describe('app.role_edits_theme: one definition, search_path pinned (CR8)', () => {
  it('every migration that creates it writes the canonical definition', () => {
    const found = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => {
        const sql = readFileSync(`${DIR}/${f}`, 'utf8').replace(/\r\n/g, '\n');
        return [...sql.matchAll(/create or replace function app\.role_edits_theme\(/g)].map(
          (m) => ({ file: f, text: sql.slice(m.index, m.index + ROLE_EDITS_THEME_SQL.length) }),
        );
      });
    expect(found.length).toBeGreaterThan(0);
    for (const { file, text } of found) expect(text, file).toBe(ROLE_EDITS_THEME_SQL);
  });
});
