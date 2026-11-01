import {
  HEADER_BLURS,
  HEADER_DEFAULTS,
  HEADER_LOGO_POSITIONS,
  HEADER_LOGO_SIZES,
  HEADER_MENU_ALIGNS,
  HEADER_TINTS,
  inBucket,
  type HeaderBlur,
  type HeaderLogoPosition,
  type HeaderLogoSize,
  type HeaderMenuAlign,
  type HeaderTint,
} from '@schemas/appearance';

// The Header screen's two small previews (Admin v2 E5), pure so they are unit-tested
// (tests/lib/headerOptions.spec.ts): what each sketch of the bar shows for the form's current
// values, as the closed values the CSS keys on (`data-*`, never a style: CSP). The buckets and
// the header as built are the schema's (packages/schemas/appearance.ts), so a value the site
// would not render draws the bar as built.

type Values = Readonly<Record<string, unknown>>;

export interface BarSketch {
  /**
   * What lies under the bar: the hero as the page opens, the page's own light sections once it
   * has scrolled past the hero (where the tint's minimum matters).
   */
  ground: 'hero' | 'page';
  /** False once a bar that is not sticky has scrolled away with the page. */
  shown: boolean;
  /** The backdrop: see-through, one of the tints, or the solid bar. */
  backdrop: HeaderTint | 'solid';
  /** The blur behind it, drawn only on the solid bar. */
  blur: HeaderBlur;
  logo: HeaderLogoSize;
  logoPosition: HeaderLogoPosition;
  align: HeaderMenuAlign;
  /** The button's English words, or null when it is not shown. */
  button: string | null;
}

/** The button's English words, when it shows and has them. */
function buttonOf(values: Values): string | null {
  if (values['ctaShow'] !== true) return null;
  const label = values['ctaLabel'];
  const en =
    label && typeof label === 'object' && typeof (label as Values)['en'] === 'string'
      ? ((label as Values)['en'] as string).trim()
      : '';
  return en || null;
}

/**
 * The bar as it looks over the hero (`after: false`) or once the page has scrolled past it
 * (`after: true`), over the page's light sections: solid when it turns solid, else as it was
 * over the hero, and gone when it is not sticky (it scrolled away with the page).
 */
export function barSketch(values: Values, after: boolean): BarSketch {
  const d = HEADER_DEFAULTS;
  const tint = inBucket(HEADER_TINTS, values['tint'], d.tint);
  const solid = after && values['solidAfterHero'] !== false;
  return {
    ground: after ? 'page' : 'hero',
    shown: !(after && values['sticky'] === false),
    backdrop: solid ? 'solid' : tint,
    blur: solid ? inBucket(HEADER_BLURS, values['blur'], d.blur) : 'none',
    logo: inBucket(HEADER_LOGO_SIZES, values['logoSize'], d.logoSize),
    logoPosition: inBucket(HEADER_LOGO_POSITIONS, values['logoPosition'], d.logoPosition),
    align: inBucket(HEADER_MENU_ALIGNS, values['menuAlign'], d.menuAlign),
    button: buttonOf(values),
  };
}

/** The line under the second sketch's title. */
export function afterLine(values: Values): string {
  if (values['sticky'] === false) return 'Scrolls away with the page';
  return values['solidAfterHero'] === false ? 'Stays as it is' : 'Turns solid';
}
