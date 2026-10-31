import { describe, expect, it } from 'vitest';
import { contrast, fromHsl } from '@theme/colour';
import { compileTheme, DEFAULT_THEME_SETTINGS, hasTokens, themeCss } from '@theme/compile';
import { gate, ratioText, simplePalette } from '@theme/gate';
import { DEFAULT_COLORS, THEME_SWATCHES } from '@theme/palette';
import { ThemeSettingsSchema, type ThemeSettings } from '@schemas/theme';
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
  v: 1,
  mode: 'advanced',
  colors: { primary: '#000000', hover: '#615757', accent: '#938A8D' },
  motion: { marquee: 'slower', reveal: false },
};

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
    expect(ThemeSettingsSchema.innerType().shape.motion.shape.marquee.options).toEqual([
      'normal',
      'slower',
      'slowest',
    ]);
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
      { ...THEMED, v: 2 },
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
