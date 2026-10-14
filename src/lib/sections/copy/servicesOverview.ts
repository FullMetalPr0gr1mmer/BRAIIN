import type { ServicesOverviewSectionContent } from '@schemas/sections';
import type { DisciplineCardsMode } from '@/lib/services/cards';
import type { BuiltIn } from './text';

// The discipline cards' built-in copy (ServicesOverview.astro), per layout (the route's
// `data.mode`), verbatim from the mockups: home is index.html's `services.*` keys, page
// mode services.html's `s.catTag` / `s.catH` / `s.catP` / `s.hint`. The accent is a word
// range of the built-in heading ("Five disciplines, <em>one studio</em>"). Page mode has no
// "All services" button, so no `allLabel`.

type Fields = 'tag' | 'heading' | 'accent' | 'sub' | 'hint';
type Copy = BuiltIn<ServicesOverviewSectionContent, Fields>;

export const SERVICES_OVERVIEW_COPY: {
  home: Copy & BuiltIn<ServicesOverviewSectionContent, 'allLabel'>;
  page: Copy;
} & Record<DisciplineCardsMode, Copy> = {
  home: {
    tag: { en: 'What we do', ar: 'ما نقدّمه' },
    heading: { en: 'Five disciplines, one studio', ar: 'خمسة تخصصات، استوديو واحد' },
    accent: { en: { from: 2 }, ar: { from: 2 } },
    sub: {
      en: 'Take one. Take all of them. The work holds together either way, because it never leaves the building.',
      ar: 'خذ واحدة، أو خذها كلها. الشغل يبقى متماسكاً في الحالتين، لأنه لا يغادر المبنى.',
    },
    hint: { en: 'Open one to see every service inside it', ar: 'افتح أي تخصص وشوف كل خدماته' },
    allLabel: { en: 'All services', ar: 'كل الخدمات' },
  },
  page: {
    tag: { en: 'Our services', ar: 'خدماتنا' },
    heading: { en: 'Everything your brand needs', ar: 'كل اللي تحتاجه علامتك' },
    accent: { en: { from: 3 }, ar: { from: 3 } },
    sub: {
      en: 'Five disciplines, twenty eight services. Open one to see everything inside it.',
      ar: 'خمسة تخصصات وثمان وعشرون خدمة. افتح أي تخصص وشوف كل اللي فيه.',
    },
    hint: { en: 'Tap a discipline to open it', ar: 'اضغط على أي تخصص لفتحه' },
  },
};
