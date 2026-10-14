import type { TestimonialsSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The client quotes carousel (Testimonials.astro: the `testimonials` type, and the quotes
// inside Our Work's `proof` band), the design's copy: "In <em>their words</em>" /
// "بكلماتهم <em>هم</em>". Both layouts share it. The quotes are the testimonials table's.

export const TESTIMONIALS_COPY: BuiltIn<TestimonialsSectionContent, 'tag' | 'heading' | 'accent'> =
  {
    tag: { en: 'Testimonials', ar: 'آراء العملاء' },
    heading: { en: 'In their words', ar: 'بكلماتهم هم' },
    accent: { en: { from: 2 }, ar: { from: 1 } },
  };

/**
 * The carousel's controls and accessible names (the WAI-ARIA APG pattern), which no content
 * field holds. `slide` names each quote: "{i} of {n}".
 */
export const TESTIMONIALS_LABELS = {
  prev: { en: 'Previous testimonial', ar: 'الرأي السابق' },
  next: { en: 'Next testimonial', ar: 'الرأي التالي' },
  pause: { en: 'Pause the testimonials', ar: 'إيقاف تبديل الآراء' },
  play: { en: 'Play the testimonials', ar: 'تشغيل تبديل الآراء' },
  slide: { en: '{i} of {n}', ar: '{i} من {n}' },
  carousel: { en: 'carousel', ar: 'عرض دوّار' },
  slideRole: { en: 'slide', ar: 'شريحة' },
} as const;
