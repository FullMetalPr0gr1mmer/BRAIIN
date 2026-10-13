import type { SloganSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The pinned slogan band (SloganBand.astro). The accent starts at a word index per language:
// "We don't make noise. <em>We make things people remember.</em>" /
// "لا نصنع ضجيجاً. <em>نصنع أشياء تبقى في الذاكرة.</em>"

export const SLOGAN_COPY: BuiltIn<SloganSectionContent, 'text' | 'accentFromEn' | 'accentFromAr'> =
  {
    text: {
      en: "We don't make noise. We make things people remember.",
      ar: 'لا نصنع ضجيجاً. نصنع أشياء تبقى في الذاكرة.',
    },
    accentFromEn: 4,
    accentFromAr: 3,
  };
