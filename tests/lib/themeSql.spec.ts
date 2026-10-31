import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mix } from '@theme/colour';
import { compileTheme, DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { themeSqlBlocks } from '@theme/sql';
import { ThemeColorsSchema, ThemeMotionSchema, ThemeSettingsSchema } from '@schemas/theme';
import { THEME_TOKEN_NAMES } from '@schemas/themeTokens';

// The database's copy of the theme rules (Admin v2 E4): custom_themes_theme_v1, the CHECK the
// E4 migration adds, calls app.theme_row_ok and app.theme_palette_ok, whose pairs, token shapes
// and brand defaults are GENERATED from the files the editor and the Worker read
// (packages/theme/sql.ts). If they drift, the database refuses a theme the Worker accepted, or
// takes one it refused. pgTAP (supabase/tests/theme_settings.test.sql) proves the CHECK runs;
// this proves it checks the same things.

const DIR = 'supabase/migrations';
const FILE = readdirSync(DIR).find((f) => /^\d{4}_theme_settings\.sql$/.test(f));
const SQL = FILE ? readFileSync(`${DIR}/${FILE}`, 'utf8') : '';

/** The lines between `-- BEGIN <name>` and `-- END <name>`, as written. */
function block(name: string): string | null {
  const open = SQL.indexOf(`-- BEGIN ${name}\n`);
  const close = SQL.indexOf(`\n    -- END ${name}\n`, open);
  if (open < 0 || close < 0) return null;
  return SQL.slice(open + `-- BEGIN ${name}\n`.length, close);
}

/** A function's body in the migration, from its `create or replace` to the next one. */
function fn(name: string): string {
  const at = SQL.indexOf(`create or replace function app.${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  const end = SQL.indexOf('create or replace function', at + 10);
  return SQL.slice(at, end < 0 ? undefined : end);
}

describe('the E4 migration holds the generated rules', () => {
  it('exists once', () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith('_theme_settings.sql'))).toHaveLength(1);
  });

  it.each(Object.entries(themeSqlBlocks()))('%s: verbatim between its markers', (name, body) => {
    expect(block(name), name).toBe(body);
    // Once: a second copy would be a block nothing holds equal.
    expect(SQL.split(`-- BEGIN ${name}\n`)).toHaveLength(2);
  });

  it('the pairs are in app.theme_palette_ok, the shapes and defaults in app.theme_row_ok', () => {
    expect(fn('theme_palette_ok')).toContain('-- BEGIN theme pairs');
    expect(fn('theme_row_ok')).toContain('-- BEGIN theme token rules');
    expect(fn('theme_row_ok')).toContain('-- BEGIN theme defaults');
  });
});

describe('app.theme_row_ok checks what the schemas and the compiler say', () => {
  const body = fn('theme_row_ok');
  const array = (re: RegExp) => {
    const m = re.exec(body);
    expect(m, String(re)).not.toBeNull();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };

  it('the settings keys, each level closed', () => {
    const top = array(/is distinct from array\[('colors'[^\]]*)\]/);
    expect(top).toEqual(['colors', 'mode', 'motion', 'v']);
    expect(Object.keys(ThemeSettingsSchema.innerType().shape).sort()).toEqual(top);
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
