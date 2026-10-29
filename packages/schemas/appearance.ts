import { z } from 'zod';

// The site's appearance settings (Admin v2 E5, `public.site_appearance`, the E5 migration): one
// row per tenant under theme.edit (P-9). E5 holds the header's options; E7 adds the loading
// screen's to the same row. Every option is a CLOSED set (Track UI: bucketed options, no free
// CSS or HTML) mirrored by a SQL CHECK, and every default is the header as built, so a site
// with no row renders exactly what it rendered before E5.
//
// The CTA's words are plain text (rendered as text, never markup): trimmed, no control
// character, English and Arabic both required, at most 40 characters each (the SQL CHECK
// reuses 0098's app.faq_text_ok). Its link is a path on this site or an https link.

export const HEADER_LOGO_POSITIONS = ['start', 'center'] as const;
export const HEADER_LOGO_SIZES = ['s', 'm', 'l'] as const;
export const HEADER_MENU_ALIGNS = ['start', 'center', 'end'] as const;
/** Black over the hero at 0, 25, 45 and 62% (the solid state's own). */
export const HEADER_TINTS = ['none', 'light', 'medium', 'dark'] as const;
/** The solid state's blur: none, 14 px (as built) or 24 px. */
export const HEADER_BLURS = ['none', 'soft', 'strong'] as const;
export const HEADER_MOBILE_MENUS = ['drawer', 'full'] as const;

export type HeaderLogoPosition = (typeof HEADER_LOGO_POSITIONS)[number];
export type HeaderLogoSize = (typeof HEADER_LOGO_SIZES)[number];
export type HeaderMenuAlign = (typeof HEADER_MENU_ALIGNS)[number];
export type HeaderTint = (typeof HEADER_TINTS)[number];
export type HeaderBlur = (typeof HEADER_BLURS)[number];
export type HeaderMobileMenu = (typeof HEADER_MOBILE_MENUS)[number];

/** The tint a bar must use when it stays on screen and never turns solid (the SQL CHECK). */
export const HEADER_TINT_MINIMUM: HeaderTint = 'dark';
export const HEADER_CTA_LABEL_MAX = 40;
export const HEADER_CTA_HREF_MAX = 300;

/**
 * A CTA link: a path on this site ("/contact#inquiry", never "//" or a backslash) or an https
 * link, with no space, quote or angle bracket. The same pattern as the SQL CHECK.
 */
export const HEADER_CTA_HREF_PATTERN =
  /^(\/([^/\\\s<>"'][^\\\s<>"']*)?|https:\/\/[^/\\\s<>"'][^\\\s<>"']*)$/;

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const ctaHalf = z
  .string()
  .trim()
  .min(1)
  .max(HEADER_CTA_LABEL_MAX)
  .refine((v) => !CONTROL.test(v), { message: 'Use plain words, without line breaks.' });

export const HeaderCtaLabelSchema = z.object({ en: ctaHalf, ar: ctaHalf });
export type HeaderCtaLabel = z.infer<typeof HeaderCtaLabelSchema>;

export const HeaderCtaHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(HEADER_CTA_HREF_MAX)
  .regex(HEADER_CTA_HREF_PATTERN, {
    message: 'Use a page of this site, starting with /, or a link starting with https://',
  });

/** The header's settings as the site reads them (every option known). */
export interface HeaderSettings {
  logoPosition: HeaderLogoPosition;
  logoSize: HeaderLogoSize;
  menuAlign: HeaderMenuAlign;
  sticky: boolean;
  hideOnScroll: boolean;
  solidAfterHero: boolean;
  tint: HeaderTint;
  blur: HeaderBlur;
  mobileMenu: HeaderMobileMenu;
  ctaShow: boolean;
  ctaLabel: HeaderCtaLabel | null;
  ctaHref: string | null;
}

/** The header as built: what no row, and every unreadable option, means. */
export const HEADER_DEFAULTS: Readonly<HeaderSettings> = {
  logoPosition: 'start',
  logoSize: 'm',
  menuAlign: 'center',
  sticky: true,
  hideOnScroll: true,
  solidAfterHero: true,
  tint: 'none',
  blur: 'soft',
  mobileMenu: 'drawer',
  ctaShow: false,
  ctaLabel: null,
  ctaHref: null,
};

/** Payload key → column (the singleton's `toRow` and `fields`). */
export const HEADER_COLUMNS: Readonly<Record<keyof HeaderSettings, string>> = {
  logoPosition: 'header_logo_position',
  logoSize: 'header_logo_size',
  menuAlign: 'header_menu_align',
  sticky: 'header_sticky',
  hideOnScroll: 'header_hide_on_scroll',
  solidAfterHero: 'header_solid_after_hero',
  tint: 'header_tint',
  blur: 'header_blur',
  mobileMenu: 'header_mobile_menu',
  ctaShow: 'header_cta_show',
  ctaLabel: 'header_cta_label',
  ctaHref: 'header_cta_href',
};

/** A tint that leaves the bar readable over the page (the SQL CHECK site_appearance_tint_minimum). */
export function tintAllowed(s: Pick<HeaderSettings, 'sticky' | 'solidAfterHero' | 'tint'>) {
  return !s.sticky || s.solidAfterHero || s.tint === HEADER_TINT_MINIMUM;
}

/**
 * A save from the Header screen: the whole header (the editor always sends every option) and
 * the row's version (0 before the first save, as every singleton). The two rules that span
 * options are checked here and again by the SQL CHECKs.
 */
export const SiteAppearanceWriteSchema = z
  .object({
    logoPosition: z.enum(HEADER_LOGO_POSITIONS),
    logoSize: z.enum(HEADER_LOGO_SIZES),
    menuAlign: z.enum(HEADER_MENU_ALIGNS),
    sticky: z.boolean(),
    hideOnScroll: z.boolean(),
    solidAfterHero: z.boolean(),
    tint: z.enum(HEADER_TINTS),
    blur: z.enum(HEADER_BLURS),
    mobileMenu: z.enum(HEADER_MOBILE_MENUS),
    ctaShow: z.boolean(),
    ctaLabel: HeaderCtaLabelSchema.nullable(),
    ctaHref: HeaderCtaHrefSchema.nullable(),
    version: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    if (value.ctaShow && !value.ctaLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ctaLabel'],
        message: 'Give the button its words in both languages.',
      });
    }
    if (value.ctaShow && !value.ctaHref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ctaHref'],
        message: 'Say where the button goes.',
      });
    }
    if (!tintAllowed(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tint'],
        message:
          'A bar that stays see-through after the hero needs the darkest tint, so its links stay readable.',
      });
    }
  });
export type SiteAppearanceWrite = z.infer<typeof SiteAppearanceWriteSchema>;
