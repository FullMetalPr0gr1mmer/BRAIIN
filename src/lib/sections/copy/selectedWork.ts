import type { SelectedWorkSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// Home "Selected work" (SelectedWork.astro), the design's copy: "Ideas that <em>leave the
// brain</em> and land in the world." / "أفكار <em>تطلع من الدماغ</em> وتوصل للعالم.", the
// three numbered lines, the featured project's link and the closing button. The projects
// are the portfolio table's; the button's target (/portfolio) is a link, not copy.

export const SELECTED_WORK_COPY: BuiltIn<
  SelectedWorkSectionContent,
  'tag' | 'heading' | 'accent' | 'lines' | 'featuredLinkLabel'
> & { button: { label: { en: string; ar: string } } } = {
  tag: { en: 'Selected work', ar: 'مختارات من أعمالنا' },
  heading: {
    en: 'Ideas that leave the brain and land in the world.',
    ar: 'أفكار تطلع من الدماغ وتوصل للعالم.',
  },
  accent: { en: { from: 2, to: 5 }, ar: { from: 1, to: 4 } },
  lines: [
    {
      text: { en: 'Made to be remembered, not just seen.', ar: 'مصنوعة عشان تنتذكر، مو بس تنشاف.' },
    },
    {
      text: {
        en: 'Built to perform on every screen and stage.',
        ar: 'مبنية عشان تحقق نتائج على كل شاشة ومسرح.',
      },
    },
    {
      text: { en: 'Delivered by one team, start to finish.', ar: 'فريق واحد من البداية للنهاية.' },
    },
  ],
  featuredLinkLabel: { en: 'See the project', ar: 'شوف المشروع' },
  button: { label: { en: 'See all our work', ar: 'شوف كل أعمالنا' } },
};
