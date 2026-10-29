// The Header screen's two small previews (Admin v2 E5), pure so they are unit-tested
// (tests/lib/headerScreen.spec.ts): what each sketch of the bar shows for the form's current
// values, as the closed values the CSS keys on (`data-*`, never a style: CSP).

type Values = Readonly<Record<string, unknown>>;

export interface BarSketch {
  /** The backdrop: see-through, one of the tints, or the solid bar. */
  backdrop: 'none' | 'light' | 'medium' | 'dark' | 'solid';
  /** The blur behind it, drawn only on the solid bar. */
  blur: 'none' | 'soft' | 'strong';
  logo: 's' | 'm' | 'l';
  logoPosition: 'start' | 'center';
  align: 'start' | 'center' | 'end';
  /** The button's English words, or null when it is not shown. */
  button: string | null;
}

const pick = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

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
 * (`after: true`): solid when it turns solid, else as it was over the hero.
 */
export function barSketch(values: Values, after: boolean): BarSketch {
  const tint = pick(values['tint'], ['none', 'light', 'medium', 'dark'] as const, 'none');
  const solid = after && values['solidAfterHero'] !== false;
  return {
    backdrop: solid ? 'solid' : tint,
    blur: solid ? pick(values['blur'], ['none', 'soft', 'strong'] as const, 'soft') : 'none',
    logo: pick(values['logoSize'], ['s', 'm', 'l'] as const, 'm'),
    logoPosition: pick(values['logoPosition'], ['start', 'center'] as const, 'start'),
    align: pick(values['menuAlign'], ['start', 'center', 'end'] as const, 'center'),
    button: buttonOf(values),
  };
}

/** The line under the second sketch's title. */
export function afterLine(values: Values): string {
  if (values['sticky'] === false) return 'Scrolls away with the page';
  return values['solidAfterHero'] === false ? 'Stays as it is' : 'Turns solid';
}
