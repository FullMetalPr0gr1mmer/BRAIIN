import { describe, expect, it } from 'vitest';
import { contrast, fromHsl } from '@theme/colour';
import { compileTheme, DEFAULT_THEME_SETTINGS, hasTokens, themeCss } from '@theme/compile';
import { gate, ratioText, simplePalette } from '@theme/gate';
import { DEFAULT_COLORS, THEME_SWATCHES } from '@theme/palette';
import { upgradeThemeSettings } from '@theme/shapes';
import { ThemeMotionSchema, ThemeSettingsSchema, type ThemeSettings } from '@schemas/theme';
import {
  THEME_TOKEN_NAMES,
  THEME_TOKEN_PATTERNS,
  ThemeTokensSchema,
  type ThemeTokenName,
} from '@schemas/themeTokens';

// Settings → tokens → theme.css (Admin v2 E4, AV-27). The design's tests: ThemeTokensSchema is a
// closed set of keys, each with one shape; theme.css can never emit `;` `{` `}` `<` `>` (nor a
// backslash) inside a value, nor any selector but :root; the brand's own settings compile to no
// token at all, so no page links a stylesheet for them; and the settings a person saves are
// strict, contrast-gated and can only reduce motion.

const THEMED: ThemeSettings = {
  v: 2,
  mode: 'advanced',
  colors: { primary: '#000000', hover: '#615757', accent: '#938A8D' },
  motion: { marquee: 'slower', reveal: false },
  shapes: { corners: 'brand', buttons: 'pill' },
  type: { headingWeight: 800, headingCase: 'uppercase' },
};

/** E4's settings, as a theme saved before E12 holds them. */
const THEMED_V1 = {
  v: 1,
  mode: THEMED.mode,
  colors: THEMED.colors,
  motion: THEMED.motion,
} as const;

/** Values that would break out of a declaration, a <style> or a stylesheet. */
const HOSTILE = [
  'red; } body { display:none',
  '#000000;}',
  '#000000</style><script>alert(1)</script>',
  'url(javascript:alert(1))',
  '#00000\\0',
  'expression(alert(1))',
  '#000000 !important',
  'rgba(1, 2, 3, 0.4);x',
  '0 1px 2px rgba(1, 2, 3, 0.4)}',
  '1.5; --x: 1',
  '\n#000000',
  '#000000\n',
];

describe('ThemeTokensSchema: a closed set, one shape a key', () => {
  it('names every key once, in the order theme.css writes them', () => {
    expect([...THEME_TOKEN_NAMES].sort()).toEqual(Object.keys(THEME_TOKEN_PATTERNS).sort());
    expect(new Set(THEME_TOKEN_NAMES).size).toBe(THEME_TOKEN_NAMES.length);
    expect(Object.keys(ThemeTokensSchema.shape)).toEqual([...THEME_TOKEN_NAMES]);
  });

  it('one entry per pattern, each that pattern, at most 60 characters, optional (CR10)', () => {
    // Built from THEME_TOKEN_PATTERNS (E12 code review CR10), so a key and its shape are written
    // once: a pattern added without a schema entry, or an entry reading another key's pattern,
    // cannot happen.
    expect(Object.keys(ThemeTokensSchema.shape)).toEqual(Object.keys(THEME_TOKEN_PATTERNS));
    for (const name of Object.keys(THEME_TOKEN_PATTERNS) as ThemeTokenName[]) {
      const entry = ThemeTokensSchema.shape[name];
      expect(entry.isOptional(), name).toBe(true);
      const checks = (entry.unwrap()._def as { checks: { kind: string }[] }).checks;
      expect(checks, name).toEqual([
        { kind: 'max', value: 60, message: undefined },
        { kind: 'regex', regex: THEME_TOKEN_PATTERNS[name], message: undefined },
      ]);
    }
  });

  it.each([...THEME_TOKEN_NAMES])('%s refuses every hostile value', (name) => {
    for (const value of HOSTILE) {
      expect(ThemeTokensSchema.safeParse({ [name]: value }).success, value).toBe(false);
    }
  });

  it('no pattern can match a character that ends a declaration, a rule or a tag', () => {
    // The alphabet of each pattern: its character classes expanded and its literal characters,
    // after the anchors, the groups and the counted repeats are taken out. Anchored at both
    // ends, with no wildcard, no negated class and no shorthand class, a value can hold
    // nothing but these.
    for (const name of THEME_TOKEN_NAMES) {
      const source = THEME_TOKEN_PATTERNS[name].source;
      expect(source.startsWith('^') && source.endsWith('$'), name).toBe(true);
      expect(source, name).not.toMatch(/(^|[^\\])\.|\[\^|\\[sSwWdDbB]|[*+?]/);
      const alphabet = new Set<string>();
      const rest = source
        .slice(1, -1)
        .replace(/\{\d+(,\d+)?\}/g, '')
        .replace(/\[([^\]]+)\]/g, (_m, cls: string) => {
          for (const [, a, b] of cls.matchAll(/(.)(?:-(.))?/g)) {
            const from = a!.charCodeAt(0);
            const to = (b ?? a)!.charCodeAt(0);
            for (let c = from; c <= to; c++) alphabet.add(String.fromCharCode(c));
          }
          return '';
        })
        .replace(/\\(.)/g, (_m, ch: string) => {
          alphabet.add(ch);
          return '';
        })
        .replace(/[()|]/g, '');
      for (const ch of rest) alphabet.add(ch);
      for (const ch of [';', '{', '}', '<', '>', '\\', '"', "'", '\n', '/', '!', '@']) {
        expect(alphabet.has(ch), `${name} can hold ${JSON.stringify(ch)}`).toBe(false);
      }
    }
  });

  it('refuses a key outside the set, an old free-form token and motion that adds', () => {
    for (const tokens of [
      { '--x': 'red' },
      { '--ad-primary': '#000000' },
      { '--bs-bg': '#ffffff' },
      { color: 'red' },
      { '--bs-marquee-scale': '0.5' },
      { '--bs-marquee-scale': '1' },
      { '--bs-rv-from': '0.5' },
      { '--bs-rv-shift': '60px' },
    ]) {
      expect(ThemeTokensSchema.safeParse(tokens).success, JSON.stringify(tokens)).toBe(false);
    }
  });
});

describe('compileTheme', () => {
  it('the brand’s own settings compile to no token, and nothing links them', () => {
    expect(compileTheme(DEFAULT_THEME_SETTINGS)).toEqual({});
    expect(hasTokens(compileTheme(DEFAULT_THEME_SETTINGS))).toBe(false);
    expect(themeCss(compileTheme(DEFAULT_THEME_SETTINGS))).toBe('');
    // The colours in any case, and either mode, are the brand's too.
    expect(
      compileTheme({
        ...DEFAULT_THEME_SETTINGS,
        mode: 'advanced',
        colors: { primary: '#0024bc', hover: '#024cff', accent: '#22a9ff' },
      }),
    ).toEqual({});
  });

  it('a theme writes all eight colour tokens, lower case, derived from its colours', () => {
    expect(compileTheme(THEMED)).toEqual({
      '--bs-klein': '#000000',
      '--bs-cobalt': '#615757',
      '--bs-sky': '#938a8d',
      '--bs-sky-soft': '#c3bdbf',
      '--bs-glow-klein': 'rgba(0, 0, 0, 0.42)',
      '--bs-glow-sky': 'rgba(147, 138, 141, 0.45)',
      '--bs-shadow-klein': '0 12px 38px rgba(0, 0, 0, 0.45)',
      '--bs-shadow-cobalt': '0 18px 48px rgba(97, 87, 87, 0.45)',
      '--bs-marquee-scale': '1.5',
      '--bs-rv-from': '1',
      '--bs-rv-shift': '0px',
    });
  });

  it('motion only ever reduces: the brand colours with calmer motion write motion tokens only', () => {
    const cases: [ThemeSettings['motion'], Record<string, string>][] = [
      [{ marquee: 'normal', reveal: true }, {}],
      [{ marquee: 'slower', reveal: true }, { '--bs-marquee-scale': '1.5' }],
      [{ marquee: 'slowest', reveal: true }, { '--bs-marquee-scale': '2.5' }],
      [
        { marquee: 'normal', reveal: false },
        { '--bs-rv-from': '1', '--bs-rv-shift': '0px' },
      ],
    ];
    for (const [motion, tokens] of cases) {
      expect(compileTheme({ ...DEFAULT_THEME_SETTINGS, motion })).toEqual(tokens);
    }
    // The schema has no faster marquee to compile.
    expect(ThemeMotionSchema.shape.marquee.options).toEqual(['normal', 'slower', 'slowest']);
  });

  it('what it compiles always parses, for every swatch, many mains and every motion', () => {
    const mains = [
      ...THEME_SWATCHES,
      ...Array.from({ length: 30 }, (_, i) => fromHsl(i * 12, 70, 25)),
    ];
    const motions: ThemeSettings['motion'][] = [
      { marquee: 'normal', reveal: true },
      { marquee: 'slowest', reveal: false },
    ];
    let compiled = 0;
    for (const main of mains) {
      const colors = simplePalette(main.toUpperCase());
      if (!gate(colors).ok) continue;
      for (const motion of motions) {
        const tokens = compileTheme({ ...DEFAULT_THEME_SETTINGS, colors, motion });
        expect(ThemeTokensSchema.safeParse(tokens).success, JSON.stringify(tokens)).toBe(true);
        compiled++;
      }
    }
    expect(compiled).toBeGreaterThan(20);
  });
});

describe('themeCss: one :root rule of the closed set, nothing else', () => {
  it('writes the tokens in a fixed order, one declaration each', () => {
    const css = themeCss(compileTheme(THEMED));
    expect(css).toBe(
      ':root{--bs-klein:#000000;--bs-cobalt:#615757;--bs-sky:#938a8d;--bs-sky-soft:#c3bdbf;' +
        '--bs-glow-klein:rgba(0, 0, 0, 0.42);--bs-glow-sky:rgba(147, 138, 141, 0.45);' +
        '--bs-shadow-klein:0 12px 38px rgba(0, 0, 0, 0.45);' +
        '--bs-shadow-cobalt:0 18px 48px rgba(97, 87, 87, 0.45);--bs-marquee-scale:1.5;' +
        '--bs-rv-from:1;--bs-rv-shift:0px;}',
    );
    // Well under a kilobyte: the cost of the one extra request a themed page makes.
    expect(new TextEncoder().encode(css).length).toBeLessThan(600);
  });

  it('cannot be made to write anything but custom properties on :root', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      'body{}',
      [],
      { '--x': 'red' },
      ...THEME_TOKEN_NAMES.flatMap((name) => HOSTILE.map((v) => ({ [name]: v }))),
      { '--bs-klein': '#000000', '--x': 'red' },
      { '--bs-klein': '#000000', '--bs-cobalt': '#000000}body{display:none' },
    ];
    for (const input of inputs) {
      const css = themeCss(input);
      expect(css, JSON.stringify(input)).toBe('');
    }
    // A valid set, whatever extra keys were tried around it: only the set, and no breakout.
    const css = themeCss({ '--bs-klein': '#123456' });
    expect(css).toBe(':root{--bs-klein:#123456;}');
    const inner = css.slice(':root{'.length, -1);
    expect(inner).not.toMatch(/[{}<>\\]/);
    for (const declaration of inner.split(';').filter(Boolean)) {
      expect(declaration).toMatch(/^--bs-[a-z-]+:[^;{}<>\\]+$/);
    }
  });

  it('every token a valid theme can hold, alone, makes one declaration', () => {
    const one: Record<ThemeTokenName, string> = {
      '--bs-klein': '#000000',
      '--bs-cobalt': '#615757',
      '--bs-sky': '#938a8d',
      '--bs-sky-soft': '#c3bdbf',
      '--bs-glow-klein': 'rgba(0, 0, 0, 0.42)',
      '--bs-glow-sky': 'rgba(147, 138, 141, 0.45)',
      '--bs-shadow-klein': '0 12px 38px rgba(0, 0, 0, 0.45)',
      '--bs-shadow-cobalt': '0 18px 48px rgba(97, 87, 87, 0.45)',
      '--bs-marquee-scale': '2.5',
      '--bs-rv-from': '1',
      '--bs-rv-shift': '0px',
      '--bs-radius-scale': '0.5',
      '--bs-btn-radius': '0px',
      '--bs-heading-weight': '700',
      '--bs-heading-case': 'none',
    };
    for (const name of THEME_TOKEN_NAMES) {
      expect(themeCss({ [name]: one[name] })).toBe(`:root{${name}:${one[name]};}`);
    }
  });
});

describe('ThemeSettingsSchema', () => {
  it('takes the brand’s settings and a themed one, colours upper case', () => {
    expect(ThemeSettingsSchema.parse(DEFAULT_THEME_SETTINGS)).toEqual(DEFAULT_THEME_SETTINGS);
    const lower = {
      ...THEMED,
      colors: { primary: '#000000', hover: '#615757', accent: '#938a8d' },
    };
    expect(ThemeSettingsSchema.parse(lower).colors.accent).toBe('#938A8D');
  });

  it('is strict at every level: a key this version does not know is refused', () => {
    for (const bad of [
      { ...THEMED, customCss: 'body{}' },
      { ...THEMED, colors: { ...THEMED.colors, dark: '#000000' } },
      { ...THEMED, motion: { ...THEMED.motion, parallax: true } },
      { ...THEMED, v: 3 },
      { ...THEMED_V1, shapes: THEMED.shapes },
      { ...THEMED, shapes: { ...THEMED.shapes, radius: 4 } },
      { ...THEMED, shapes: { ...THEMED.shapes, corners: 'huge' } },
      { ...THEMED, shapes: { ...THEMED.shapes, buttons: 'ghost' } },
      { ...THEMED, type: { ...THEMED.type, headingWeight: 900 } },
      { ...THEMED, type: { ...THEMED.type, headingWeight: '700' } },
      { ...THEMED, type: { ...THEMED.type, headingCase: 'lowercase' } },
      { ...THEMED, type: { headingWeight: 800 } },
      { ...THEMED, mode: 'expert' },
      { ...THEMED, motion: { marquee: 'faster', reveal: true } },
      { ...THEMED, colors: { ...THEMED.colors, primary: '#000' } },
      { ...THEMED, colors: { ...THEMED.colors, primary: 'black' } },
      { ...THEMED, colors: { ...THEMED.colors, primary: 'rgb(0,0,0)' } },
    ]) {
      expect(ThemeSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses colours that fail the gate, naming the pair on the colour to change', () => {
    const result = ThemeSettingsSchema.safeParse({
      ...THEMED,
      colors: { ...DEFAULT_COLORS, hover: '#7FB2FF' },
    });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.path).toEqual(['colors', 'hover']);
    expect(issues.map((i) => i.message)).toContain(
      `White text on Hover is ${ratioText(contrast('#ffffff', '#7fb2ff'))}, needs 4.5:1 (white text on a hovered button).`,
    );
  });

  it('a colour that is not one yet is an issue on that colour, never a thrown error', () => {
    // A half-typed colour reaches the server from a form saved early: zod still runs the
    // gate's refinement on a field that failed its pattern, and the gate must not throw.
    for (const primary of ['#000', 'black', '', '#GGGGGG', 42]) {
      const run = () =>
        ThemeSettingsSchema.safeParse({ ...THEMED, colors: { ...THEMED.colors, primary } });
      expect(run, String(primary)).not.toThrow();
      const result = run();
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['colors', 'primary']);
    }
  });
});

describe('settings v2: shapes and type (Admin v2 E12, AV-32)', () => {
  const SHAPED: ThemeSettings = {
    ...THEMED,
    shapes: { corners: 'square', buttons: 'rounded' },
    type: { headingWeight: 700, headingCase: 'as-written' },
  };

  it("reads a v1 theme (E4's) as v2 at the brand's shapes and type, so it compiles as before", () => {
    const read = ThemeSettingsSchema.parse(THEMED_V1);
    expect(read).toEqual({
      ...THEMED_V1,
      v: 2,
      shapes: { corners: 'brand', buttons: 'pill' },
      type: { headingWeight: 800, headingCase: 'uppercase' },
    });
    expect(compileTheme(read)).toEqual(compileTheme(THEMED));
    // Parsing what it answered changes nothing (the resource parses twice: route, then toRow).
    expect(ThemeSettingsSchema.parse(read)).toEqual(read);
    // The restore's round trip upgrades a stored v1 the same way (src/lib/release/rowPayload.ts).
    expect(upgradeThemeSettings(THEMED_V1)).toEqual(read);
    expect(upgradeThemeSettings(read)).toBe(read);
    for (const other of [null, 'x', [], { v: 3 }]) expect(upgradeThemeSettings(other)).toBe(other);
  });

  it("the brand's shapes and type write no token; each other choice writes its one", () => {
    expect(compileTheme(DEFAULT_THEME_SETTINGS)).toEqual({});
    expect(
      compileTheme({ ...DEFAULT_THEME_SETTINGS, shapes: SHAPED.shapes, type: SHAPED.type }),
    ).toEqual({
      '--bs-radius-scale': '0',
      '--bs-btn-radius': '10px',
      '--bs-heading-weight': '700',
      '--bs-heading-case': 'none',
    });
    const one = (shapes: Partial<ThemeSettings['shapes']>, type: Partial<ThemeSettings['type']>) =>
      compileTheme({
        ...DEFAULT_THEME_SETTINGS,
        shapes: { ...DEFAULT_THEME_SETTINGS.shapes, ...shapes },
        type: { ...DEFAULT_THEME_SETTINGS.type, ...type },
      });
    expect(one({ corners: 'soft' }, {})).toEqual({ '--bs-radius-scale': '0.5' });
    expect(one({ corners: 'round' }, {})).toEqual({ '--bs-radius-scale': '1.5' });
    expect(one({ buttons: 'square' }, {})).toEqual({ '--bs-btn-radius': '0px' });
    expect(one({}, { headingWeight: 700 })).toEqual({ '--bs-heading-weight': '700' });
    expect(one({}, { headingCase: 'as-written' })).toEqual({ '--bs-heading-case': 'none' });
    expect(hasTokens(one({ buttons: 'square' }, {}))).toBe(true);
  });

  it('a shaped theme parses, and its stylesheet writes the four tokens last, in order', () => {
    expect(ThemeSettingsSchema.parse(SHAPED)).toEqual(SHAPED);
    const tokens = compileTheme(SHAPED);
    expect(ThemeTokensSchema.safeParse(tokens).success).toBe(true);
    expect(themeCss(tokens)).toMatch(
      /;--bs-radius-scale:0;--bs-btn-radius:10px;--bs-heading-weight:700;--bs-heading-case:none;\}$/,
    );
  });

  it('the token patterns take only the choices, never the brand values or anything else', () => {
    const ok = (name: ThemeTokenName, v: string) => THEME_TOKEN_PATTERNS[name].test(v);
    for (const v of ['0', '0.5', '1.5']) expect(ok('--bs-radius-scale', v)).toBe(true);
    for (const v of ['1', '2', '0.25', '-1', '1.5px'])
      expect(ok('--bs-radius-scale', v)).toBe(false);
    for (const v of ['10px', '0px']) expect(ok('--bs-btn-radius', v)).toBe(true);
    for (const v of ['999px', '0', '50%', '10']) expect(ok('--bs-btn-radius', v)).toBe(false);
    expect(ok('--bs-heading-weight', '700')).toBe(true);
    for (const v of ['800', '900', '400', 'bold']) expect(ok('--bs-heading-weight', v)).toBe(false);
    expect(ok('--bs-heading-case', 'none')).toBe(true);
    for (const v of ['uppercase', 'lowercase', 'capitalize']) {
      expect(ok('--bs-heading-case', v)).toBe(false);
    }
  });
});
