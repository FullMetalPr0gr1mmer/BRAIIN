import type { WorkIntroSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// Our Work's intro statement (WorkIntro.astro) and its link's label. The frames are media
// library images, and the link's target is the route's call (workIntroLinkHref).

export const WORK_INTRO_COPY: BuiltIn<WorkIntroSectionContent, 'text' | 'linkLabel'> = {
  text: {
    en: "Every project here started as a sketch in a notebook and ended somewhere people could see it, hold it, or hear it. This is a selection of the work we're proudest of.",
    ar: 'كل مشروع هنا بدأ كرسمة في دفتر، وانتهى في مكان يقدر الناس يشوفونه أو يلمسونه أو يسمعونه. هذه مختارات من الشغل اللي نفتخر فيه أكثر.',
  },
  linkLabel: { en: 'See the projects', ar: 'شوف المشاريع' },
};
