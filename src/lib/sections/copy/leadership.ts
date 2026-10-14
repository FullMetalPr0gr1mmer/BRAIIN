import type { LeadershipSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// About "Leadership" (LeadershipSlider.astro), the design's copy: "Meet our <em>leadership</em>
// team" / "تعرّف على <em>فريق القيادة</em>". The people are the team table's.

export const LEADERSHIP_COPY: BuiltIn<
  LeadershipSectionContent,
  'tag' | 'heading' | 'accent' | 'text'
> = {
  tag: { en: 'Leadership', ar: 'القيادة' },
  heading: { en: 'Meet our leadership team', ar: 'تعرّف على فريق القيادة' },
  accent: { en: { from: 2, to: 3 }, ar: { from: 2 } },
  text: {
    en: 'The people who keep five disciplines pulling in the same direction.',
    ar: 'الناس اللي يخلّون خمسة تخصصات تمشي في نفس الاتجاه.',
  },
};

/** The slider's accessible names and controls, which no content field holds. */
export const LEADERSHIP_LABELS = {
  region: { en: 'Leadership team', ar: 'فريق القيادة' },
  prev: { en: 'Previous', ar: 'السابق' },
  next: { en: 'Next', ar: 'التالي' },
  linkedin: {
    en: 'LinkedIn profile (opens in a new tab)',
    ar: 'حساب لينكدإن (يفتح في تبويب جديد)',
  },
} as const;
