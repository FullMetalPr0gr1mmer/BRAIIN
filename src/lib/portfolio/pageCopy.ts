import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';

// The case study's own words (UI v2 PR11, project.html), verbatim in both languages: the labels
// around a project's content, gathered here from the case-study components (Admin v2 E3) so the
// project template's editor finds them in one place. These are the BUILT-IN words, which
// `public.template_copy` overrides key by key (the catalogue, packages/schemas/templateCopy.ts;
// the page's resolved words, src/lib/templates/copy.ts). Pure, so the words and the accent word
// ranges are unit-tested.
//
// `confidential` is FacetTags' wording, so a hidden client reads the same everywhere; it is not
// in the editable catalogue (the Our Work cards share it).

export interface CasePageCopy {
  /** The banner's tag ("Case study"). */
  bannerTag: string;
  confidential: string;
  /** The title band: the way back, and the keyword list's name. */
  back: string;
  keywords: string;
  /** The overview's four headings and the final film's label. */
  overview: string;
  scope: string;
  goal: string;
  result: string;
  final: string;
  /** The breakdown band: its tag, heading ("From the *first sketch* to set"), lead and kinds. */
  breakdownTag: string;
  breakdownHeading: string;
  breakdownLead: string;
  sketch: string;
  bts: string;
  process: string;
  /** The gallery band: its tag and heading ("Stills from *the final*"). */
  galleryTag: string;
  galleryHeading: string;
  /** The image viewer's control names (read by screen readers). */
  viewer: string;
  viewerClose: string;
  viewerPrevious: string;
  viewerNext: string;
  /** The "Next project" band. */
  nextProject: string;
}

export const CASE_PAGE_COPY: Record<Locale, CasePageCopy> = {
  en: {
    bannerTag: 'Case study',
    confidential: 'Confidential client',
    back: 'All projects',
    keywords: 'Keywords',
    overview: 'Overview',
    scope: 'Scope of work',
    goal: 'The goal',
    result: 'The result',
    final: 'Final film',
    breakdownTag: 'Breakdown',
    breakdownHeading: 'From the first sketch to set',
    breakdownLead: 'How the idea got made: the sketches, the tests, and the days on set.',
    sketch: 'Sketch',
    bts: 'Behind the scenes',
    process: 'Process',
    galleryTag: 'Gallery',
    galleryHeading: 'Stills from the final',
    viewer: 'Image viewer',
    viewerClose: 'Close',
    viewerPrevious: 'Previous',
    viewerNext: 'Next',
    nextProject: 'Next project',
  },
  ar: {
    bannerTag: 'دراسة حالة',
    confidential: 'عميل غير مُعلَن',
    back: 'كل المشاريع',
    keywords: 'الكلمات المفتاحية',
    overview: 'نظرة عامة',
    scope: 'نطاق العمل',
    goal: 'الهدف',
    result: 'النتيجة',
    final: 'الفيلم النهائي',
    breakdownTag: 'كواليس العمل',
    breakdownHeading: 'من أول رسمة إلى موقع التصوير',
    breakdownLead: 'كيف انصنعت الفكرة: الرسومات والتجارب وأيام التصوير.',
    sketch: 'رسمة',
    bts: 'خلف الكواليس',
    process: 'مراحل العمل',
    galleryTag: 'المعرض',
    galleryHeading: 'لقطات من العمل النهائي',
    viewer: 'عارض الصور',
    viewerClose: 'إغلاق',
    viewerPrevious: 'السابق',
    viewerNext: 'التالي',
    nextProject: 'المشروع التالي',
  },
};

/** "first sketch" / "أول رسمة" — the mockup's <em>, as a word range per locale. */
export const BREAKDOWN_ACCENT: Accent = { en: { from: 2, to: 4 }, ar: { from: 1, to: 3 } };

/** "the final" / "العمل النهائي" — the mockup's <em>. */
export const GALLERY_ACCENT: Accent = { en: { from: 2 }, ar: { from: 2 } };
