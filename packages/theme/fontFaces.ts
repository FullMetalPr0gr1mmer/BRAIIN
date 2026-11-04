import {
  FONT_FAMILIES,
  familyForTokens,
  type FontFamily,
  type FontFamilyId,
  type FontScript,
} from './fonts';

// The font catalogue's faces (Admin v2 E13; docs/fonts.md): for each family, its web faces (the
// pre-subset woff2 files in public/fonts) and its metric-override fallback faces, and the one
// renderer that writes them as `@font-face` rules. SERVER AND TESTS ONLY (the editor reads
// packages/theme/fonts.ts, never these numbers).
//
//   • The brand's two families render exactly the `@font-face` set public/styles/global.css and
//     admin.css hold (tests/lib/fontCatalogue.spec.ts compares them block by block), so the
//     numbers here are the ones docs/fonts.md 2b and 2c measured, copied, not new.
//   • A non-brand family's faces are written into /styles/theme.css ahead of its `:root` rule
//     when a theme chooses it (themeStylesheet, packages/theme/stylesheet.ts), from this table,
//     keyed by the closed token: never from row data.
//   • The one hero-face preload is a family's file at the weight a route's heading renders in
//     (heroFile), so it follows the theme's choice.

/** One pre-subset woff2 of a family. */
export interface WebFace {
  /** A static weight, or a variable font's range. */
  weight: number | readonly [number, number];
  /** The script subset the file holds (an Arabic family carries a Latin one too). */
  subset: FontScript;
  /** Its address: always under /fonts/ (same origin, `font-src 'self'`). */
  file: `/fonts/${string}.woff2`;
  /** The code points the file holds: kept in lock-step with the subsetter. */
  unicodeRange: string;
  /** A variable font's width axis, pinned. */
  stretch?: string;
}

/** A metric-override face over a local font, so the swap to the web face does not move text. */
export interface FallbackFace {
  /** Its family: a family's own fallback family, named in the family's stack. */
  family: string;
  /** Its weight; omitted for a face with no weight descriptor (regular). */
  weight?: number;
  /** The glyphs it stands in for. */
  subset: FontScript;
  /** The local fonts it draws with, in order (Arial first where measured on it). */
  local: readonly string[];
  sizeAdjust: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
  unicodeRange?: string;
}

export interface FamilyFaces {
  web: readonly WebFace[];
  fallbacks: readonly FallbackFace[];
}

const ARCHIVO_LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
// scripts/subset-fonts.py's LATIN and ARABIC lists.
const ALMARAI_LATIN =
  'U+0020-007E, U+00A0, U+00A9, U+00AB, U+00B7, U+00BB, U+00D7, U+2013-2014, U+2018-201D, U+2022, U+2026, U+20AC, U+2122, U+2190-2193, U+2212';
const ALMARAI_ARABIC = 'U+0020, U+00A0, U+0600-06FF, U+200C-200E, U+2010-2011';

const ARIAL = ['Arial', 'Liberation Sans', 'LiberationSans'] as const;
const ARIAL_BOLD = [
  'Arial Bold',
  'Arial-BoldMT',
  'Liberation Sans Bold',
  'LiberationSans-Bold',
] as const;

/** Archivo's fallback at a weight: Arial (or Liberation Sans) below 600, bold from 600. */
const archivoFallback = (
  weight: number | undefined,
  sizeAdjust: string,
  ascentOverride: string,
  descentOverride: string,
): FallbackFace => ({
  family: 'Archivo Fallback',
  ...(weight === undefined ? {} : { weight }),
  subset: 'latin',
  local: (weight ?? 400) >= 600 ? ARIAL_BOLD : ARIAL,
  sizeAdjust,
  ascentOverride,
  descentOverride,
  lineGapOverride: '0%',
});

/** One of Almarai's fallback faces (docs/fonts.md 2b: Arial; 2c: Liberation and DejaVu). */
const almaraiFallback = (
  family: 'Almarai Fallback' | 'Almarai Fallback Linux',
  weight: number,
  subset: FontScript,
  local: readonly string[],
  sizeAdjust: string,
  ascentOverride: string,
  descentOverride: string,
): FallbackFace => ({
  family,
  weight,
  subset,
  local,
  sizeAdjust,
  ascentOverride,
  descentOverride,
  lineGapOverride: '0%',
  ...(subset === 'arabic' ? { unicodeRange: ALMARAI_ARABIC } : {}),
});

const almaraiWeb = (weight: number): WebFace[] => [
  // The Latin face first and the Arabic face claiming the spaces (docs/fonts.md: with
  // overlapping ranges the LAST-declared face is tried first).
  {
    weight,
    subset: 'latin',
    file: `/fonts/almarai-${weight}-latin.woff2`,
    unicodeRange: ALMARAI_LATIN,
  },
  {
    weight,
    subset: 'arabic',
    file: `/fonts/almarai-${weight}-arabic.woff2`,
    unicodeRange: ALMARAI_ARABIC,
  },
];

export const FONT_FACES: Readonly<Record<FontFamilyId, FamilyFaces>> = {
  archivo: {
    web: [
      {
        weight: [400, 800],
        subset: 'latin',
        file: '/fonts/archivo-var-latin.woff2',
        unicodeRange: ARCHIVO_LATIN,
        stretch: '100%',
      },
    ],
    fallbacks: [
      archivoFallback(undefined, '98.7%', '88.96%', '21.28%'),
      archivoFallback(500, '100.23%', '87.6%', '20.95%'),
      archivoFallback(600, '94.77%', '92.65%', '22.16%'),
      archivoFallback(700, '98.06%', '89.54%', '21.42%'),
      archivoFallback(800, '103.01%', '85.23%', '20.39%'),
    ],
  },
  almarai: {
    web: [...almaraiWeb(400), ...almaraiWeb(700), ...almaraiWeb(800)],
    fallbacks: [
      // Windows and macOS: Arial, per weight and per script, each on its weight file's box.
      almaraiFallback(
        'Almarai Fallback',
        400,
        'latin',
        ['Arial', 'ArialMT'],
        '95.11%',
        '95.15%',
        '22.18%',
      ),
      almaraiFallback(
        'Almarai Fallback',
        400,
        'arabic',
        ['Arial', 'ArialMT'],
        '126.2%',
        '70.6%',
        '16.6%',
      ),
      almaraiFallback(
        'Almarai Fallback',
        700,
        'latin',
        ['Arial Bold', 'Arial-BoldMT'],
        '92.4%',
        '135.9%',
        '31.9%',
      ),
      almaraiFallback(
        'Almarai Fallback',
        700,
        'arabic',
        ['Arial Bold', 'Arial-BoldMT'],
        '127.7%',
        '98.3%',
        '23.1%',
      ),
      almaraiFallback(
        'Almarai Fallback',
        800,
        'latin',
        ['Arial Bold', 'Arial-BoldMT'],
        '100.75%',
        '88.4%',
        '20.8%',
      ),
      almaraiFallback(
        'Almarai Fallback',
        800,
        'arabic',
        ['Arial Bold', 'Arial-BoldMT'],
        '133.1%',
        '66.9%',
        '15.7%',
      ),
      // Linux: Liberation Sans for Latin, DejaVu Sans for Arabic, on Almarai's box as Linux
      // draws it (hhea, 0.905 / 0.211, at every weight).
      almaraiFallback(
        'Almarai Fallback Linux',
        400,
        'latin',
        ['Liberation Sans', 'LiberationSans'],
        '95.11%',
        '95.15%',
        '22.18%',
      ),
      almaraiFallback(
        'Almarai Fallback Linux',
        400,
        'arabic',
        ['DejaVu Sans', 'DejaVuSans'],
        '96.92%',
        '93.38%',
        '21.77%',
      ),
      almaraiFallback(
        'Almarai Fallback Linux',
        700,
        'latin',
        ['Liberation Sans Bold', 'LiberationSans-Bold'],
        '92.4%',
        '97.94%',
        '22.84%',
      ),
      almaraiFallback(
        'Almarai Fallback Linux',
        700,
        'arabic',
        ['DejaVu Sans Bold', 'DejaVuSans-Bold'],
        '85.63%',
        '105.69%',
        '24.64%',
      ),
      almaraiFallback(
        'Almarai Fallback Linux',
        800,
        'latin',
        ['Liberation Sans Bold', 'LiberationSans-Bold'],
        '100.75%',
        '89.83%',
        '20.94%',
      ),
      almaraiFallback(
        'Almarai Fallback Linux',
        800,
        'arabic',
        ['DejaVu Sans Bold', 'DejaVuSans-Bold'],
        '89.25%',
        '101.4%',
        '23.64%',
      ),
    ],
  },
};

type Descriptor = readonly [string, string];

const weightOf = (w: WebFace['weight']) => (typeof w === 'number' ? String(w) : `${w[0]} ${w[1]}`);

/** A web face's descriptors, in global.css's order. */
function webDescriptors(name: string, face: WebFace): Descriptor[] {
  return [
    ['font-family', `'${name}'`],
    ['font-style', 'normal'],
    ['font-weight', weightOf(face.weight)],
    ...(face.stretch ? [['font-stretch', face.stretch] as const] : []),
    ['font-display', 'swap'],
    ['src', `url('${face.file}') format('woff2')`],
    ['unicode-range', face.unicodeRange],
  ];
}

/** A fallback face's descriptors, in global.css's order. */
function fallbackDescriptors(face: FallbackFace): Descriptor[] {
  return [
    ['font-family', `'${face.family}'`],
    ...(face.weight === undefined ? [] : [['font-weight', String(face.weight)] as const]),
    ['src', face.local.map((l) => `local('${l}')`).join(', ')],
    ['size-adjust', face.sizeAdjust],
    ['ascent-override', face.ascentOverride],
    ['descent-override', face.descentOverride],
    ['line-gap-override', face.lineGapOverride],
    ...(face.unicodeRange ? [['unicode-range', face.unicodeRange] as const] : []),
  ];
}

/** A family's faces, as descriptor lists: its web faces, then its fallback faces. */
export function familyFaceRules(
  family: Pick<FontFamily, 'id' | 'name'>,
  faces: FamilyFaces | undefined = FONT_FACES[family.id as FontFamilyId],
): Descriptor[][] {
  if (!faces) throw new Error(`no faces for the font family ${family.id}`);
  return [
    ...faces.web.map((face) => webDescriptors(family.name, face)),
    ...faces.fallbacks.map(fallbackDescriptors),
  ];
}

/**
 * The `@font-face` rules: `spaced` as global.css reads with its whitespace collapsed (what the
 * parity tests compare), `compact` as theme.css writes them.
 */
export function fontFaceCss(rules: Descriptor[][], style: 'spaced' | 'compact'): string[] {
  return rules.map((descriptors) =>
    style === 'spaced'
      ? `@font-face { ${descriptors.map(([k, v]) => `${k}: ${v};`).join(' ')} }`
      : `@font-face{${descriptors.map(([k, v]) => `${k}:${v}`).join(';')}}`,
  );
}

/**
 * The faces /styles/theme.css carries for a theme's tokens: each script's chosen family's, when
 * it is not the brand's (whose faces global.css already declares). '' for the brand's fonts, so
 * a theme without a font token writes exactly what it wrote before E13.
 */
export function chosenFontFaces(
  tokens: Readonly<Partial<Record<string, string | undefined>>> | null | undefined,
  families: readonly FontFamily[] = FONT_FAMILIES,
  faces: Readonly<Record<string, FamilyFaces>> = FONT_FACES,
): string {
  const out: string[] = [];
  for (const script of ['latin', 'arabic'] as const) {
    const family = familyForTokens(script, tokens, families);
    if (family.brand) continue;
    out.push(...fontFaceCss(familyFaceRules(family, faces[family.id]), 'compact'));
  }
  return out.join('');
}

/**
 * The weight a face of these weights renders a CSS weight in (CSS Fonts 4 §5.2, font-weight
 * matching): the weight itself; for 400 to 500, up to 500, then down, then up; below 400, down
 * then up; above 500, up then down. A variable face takes any weight in its range.
 */
export function matchWeight(desired: number, faces: readonly WebFace['weight'][]): number {
  for (const w of faces) {
    if (typeof w !== 'number' && desired >= w[0] && desired <= w[1]) return desired;
  }
  const available = [
    ...new Set(faces.flatMap((w) => (typeof w === 'number' ? [w] : [w[0], w[1]]))),
  ].sort((a, b) => a - b);
  if (available.includes(desired)) return desired;
  const up = available.filter((w) => w > desired);
  const down = available.filter((w) => w < desired).reverse();
  if (desired >= 400 && desired <= 500) {
    const toFive = up.filter((w) => w <= 500);
    const rest = up.filter((w) => w > 500);
    return [...toFive, ...down, ...rest][0]!;
  }
  return (desired < 400 ? [...down, ...up] : [...up, ...down])[0]!;
}

/**
 * The file a family's pages draw a heading of this CSS weight from: its own script's subset at
 * the weight the face matching picks (a variable face's one file for every weight).
 */
export function heroFile(
  family: Pick<FontFamily, 'id' | 'script'>,
  weight: number,
  faces: FamilyFaces | undefined = FONT_FACES[family.id as FontFamilyId],
): WebFace['file'] {
  const own = (faces?.web ?? []).filter((f) => f.subset === family.script);
  if (own.length === 0) throw new Error(`${family.id}: no ${family.script} web face`);
  const picked = matchWeight(
    weight,
    own.map((f) => f.weight),
  );
  const face = own.find((f) =>
    typeof f.weight === 'number'
      ? f.weight === picked
      : picked >= f.weight[0] && picked <= f.weight[1],
  );
  return face!.file;
}
