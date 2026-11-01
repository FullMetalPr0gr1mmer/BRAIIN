import {
  HEADER_BLURS,
  HEADER_COLUMNS,
  HEADER_DEFAULTS,
  HEADER_LOGO_POSITIONS,
  HEADER_LOGO_SIZES,
  HEADER_MENU_ALIGNS,
  HEADER_MOBILE_MENUS,
  HEADER_TINTS,
  HeaderCtaHrefSchema,
  HeaderCtaLabelSchema,
  tintAllowed,
  type HeaderLogoSize,
  type HeaderSettings,
} from '@schemas/appearance';
import { sanitizeHref } from '@/lib/content/tiptap';

// The header's settings as the public site reads them (Admin v2 E5, `public.site_appearance`).
// Pure: no request state, no database. src/lib/data/appearance.ts reads the row; SiteHeader
// renders what `headerAttributes` returns.
//
// A row is read option by option: a value outside its bucket (a row written around the Worker,
// or a column a later slice widened) costs that option its built-in value, never the page.

type Row = Readonly<Record<string, unknown>>;

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/** A stored row (or none) → the header's settings, every unreadable option at its default. */
export function headerFromRow(row: Row | null | undefined): HeaderSettings {
  if (!row) return { ...HEADER_DEFAULTS };
  const c = HEADER_COLUMNS;
  const d = HEADER_DEFAULTS;
  const label = HeaderCtaLabelSchema.safeParse(row[c.ctaLabel]);
  // The link renders into `<a href>` on every page: the write's two checks again (the
  // pattern, then the menus' scheme allowlist, which also refuses a URL that does not parse,
  // such as "https://a:b"), so a row written around the Worker renders no stranger a link.
  const href = HeaderCtaHrefSchema.safeParse(row[c.ctaHref]);
  const ctaHref = href.success && sanitizeHref(href.data) !== null ? href.data : null;
  const out: HeaderSettings = {
    logoPosition: oneOf(HEADER_LOGO_POSITIONS, row[c.logoPosition], d.logoPosition),
    logoSize: oneOf(HEADER_LOGO_SIZES, row[c.logoSize], d.logoSize),
    menuAlign: oneOf(HEADER_MENU_ALIGNS, row[c.menuAlign], d.menuAlign),
    sticky: flag(row[c.sticky], d.sticky),
    hideOnScroll: flag(row[c.hideOnScroll], d.hideOnScroll),
    solidAfterHero: flag(row[c.solidAfterHero], d.solidAfterHero),
    tint: oneOf(HEADER_TINTS, row[c.tint], d.tint),
    blur: oneOf(HEADER_BLURS, row[c.blur], d.blur),
    mobileMenu: oneOf(HEADER_MOBILE_MENUS, row[c.mobileMenu], d.mobileMenu),
    ctaShow: flag(row[c.ctaShow], d.ctaShow),
    ctaLabel: label.success ? label.data : null,
    ctaHref,
  };
  // A button with no words or no destination is no button.
  if (!out.ctaLabel || !out.ctaHref) out.ctaShow = false;
  // A bar left see-through over the page's light sections must be readable: the CHECK refuses
  // it in the database; a row that got past it turns solid after the hero, as built.
  if (!tintAllowed(out)) out.solidAfterHero = true;
  return out;
}

/** What the header's markup says about each option that differs from the header as built. */
export type HeaderAttributes = Partial<
  Record<
    | 'data-logo'
    | 'data-logo-pos'
    | 'data-align'
    | 'data-sticky'
    | 'data-hide'
    | 'data-solid'
    | 'data-tint'
    | 'data-blur'
    | 'data-mobile',
    string
  >
>;

/**
 * One `data-*` attribute per option that differs from its default, and none for an option at
 * its default, so the header as built renders the same bytes as before E5. global.css maps
 * each value to a fixed rule; the scroll script reads data-sticky, data-hide and data-solid.
 */
export function headerAttributes(s: HeaderSettings): HeaderAttributes {
  const d = HEADER_DEFAULTS;
  const out: HeaderAttributes = {};
  if (s.logoSize !== d.logoSize) out['data-logo'] = s.logoSize;
  if (s.logoPosition !== d.logoPosition) out['data-logo-pos'] = s.logoPosition;
  if (s.menuAlign !== d.menuAlign) out['data-align'] = s.menuAlign;
  if (s.sticky !== d.sticky) out['data-sticky'] = 'off';
  if (s.hideOnScroll !== d.hideOnScroll) out['data-hide'] = 'off';
  if (s.solidAfterHero !== d.solidAfterHero) out['data-solid'] = 'off';
  if (s.tint !== d.tint) out['data-tint'] = s.tint;
  if (s.blur !== d.blur) out['data-blur'] = s.blur;
  if (s.mobileMenu !== d.mobileMenu) out['data-mobile'] = s.mobileMenu;
  return out;
}

/**
 * The logo's rendered width per size (`--bs-logo-w`, global.css), which is also the logo's
 * `<Picture sizes>`: the browser picks the file by the box it will really fill. M is the
 * header as built. Every preset keeps the 96 px floor at narrow widths but S, so the
 * small-screen bar (logo, key link, menu and language) still fits at 320 px.
 */
export const LOGO_SIZES: Readonly<Record<HeaderLogoSize, string>> = {
  s: 'clamp(80px, 8vw, 108px)',
  m: 'clamp(96px, 10vw, 132px)',
  l: 'clamp(96px, 12vw, 160px)',
};
