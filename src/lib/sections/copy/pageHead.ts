import type { PageHeadSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// A page head on black (PageHead.astro). The built-in copy is All projects' own, verbatim
// from the design: "All <em>projects</em>" / "كل <em>المشاريع</em>", the lead, and the back
// link's label (its target, /portfolio, is a link, not copy). The live project count is
// route data, worded by projectCount (src/lib/portfolio/filterText.ts).

export const PAGE_HEAD_COPY: BuiltIn<
  PageHeadSectionContent,
  'heading' | 'accent' | 'lead' | 'backLabel'
> = {
  heading: { en: 'All projects', ar: 'كل المشاريع' },
  accent: { en: { from: 1 }, ar: { from: 1 } },
  lead: {
    en: "Every project we've made. Filter by service, sector, client or year, or tap any tag on a project.",
    ar: 'كل المشاريع اللي صنعناها. فلتر حسب الخدمة أو القطاع أو العميل أو السنة، أو اضغط على أي وسم في المشروع.',
  },
  backLabel: { en: 'Our Work', ar: 'أعمالنا' },
};
