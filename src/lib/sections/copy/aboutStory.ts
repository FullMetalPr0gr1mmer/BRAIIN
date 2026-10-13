import type { AboutStorySectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The pre-UI-v2 About hero's built-in story (AboutStory.astro, the `aboutStory` type; About
// itself now opens with `aboutWho`). Answer-first, named, concrete (GEO authoring defaults,
// CLAUDE.md Pillar 3). The studio is named through `%brand%`, here and in authored copy
// alike, so the public identity is the only place its name is spelled.

export const ABOUT_STORY_COPY: BuiltIn<
  AboutStorySectionContent,
  'heading' | 'lead' | 'missionTitle' | 'mission' | 'visionTitle' | 'vision'
> = {
  heading: { en: 'About %brand%', ar: 'عن %brand%' },
  lead: {
    en: '%brand% is a bilingual creative studio in Saudi Arabia — five disciplines, one team, building brands that work in Arabic and English alike.',
    ar: '%brand% استوديو إبداعي ثنائي اللغة في المملكة العربية السعودية — خمسة تخصصات، وفريق واحد، يبني علامات تعمل بالعربية والإنجليزية على حدٍ سواء.',
  },
  missionTitle: { en: 'Our mission', ar: 'رسالتنا' },
  mission: {
    en: 'To give ambitious brands in the region a single, accountable creative partner — from identity and film to web and search — measured by the results we ship, not the awards we chase.',
    ar: 'أن نمنح العلامات الطموحة في المنطقة شريكًا إبداعيًا واحدًا مسؤولًا — من الهوية والفيلم إلى الويب والبحث — نُقاس بالنتائج التي نحققها لا بالجوائز.',
  },
  visionTitle: { en: 'Our vision', ar: 'رؤيتنا' },
  vision: {
    en: 'A MENA creative scene where world-class work is expected, bilingual by default, and made close to the audiences it serves.',
    ar: 'مشهد إبداعي في منطقة الشرق الأوسط وشمال أفريقيا يكون فيه العمل عالمي المستوى هو المتوقع، ثنائي اللغة بطبيعته، وقريبًا من الجمهور الذي يخدمه.',
  },
};
