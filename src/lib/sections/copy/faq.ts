import type { FaqSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The FAQ band's heading (FaqAccordion.astro), the design's copy verbatim (c.faqTag /
// c.faqH): "Questions we get <em>every week</em>" / "أسئلة توصلنا <em>كل أسبوع</em>". The
// questions and answers are not section copy: they are also the page's FAQPage JSON-LD,
// so they are one collection, public.faq_items (Admin v2 U7), read once by the route
// (src/lib/data/faq.ts) for both.

export const FAQ_COPY: BuiltIn<FaqSectionContent, 'tag' | 'heading' | 'accent'> = {
  tag: { en: 'FAQ', ar: 'الأسئلة الشائعة' },
  heading: { en: 'Questions we get every week', ar: 'أسئلة توصلنا كل أسبوع' },
  accent: { en: { from: 3 }, ar: { from: 2 } },
};
