import type { AboutWhoSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// About "Who we are" (AboutWho.astro), the design's copy verbatim: the page's <h1>, which
// accents "from the brain into the real world." (EN word 7, AR word 6), the lead line and
// the manifesto. The poster and its clip are seeded content, never a code fallback, so the
// built-in section is text only.

export const ABOUT_WHO_COPY: BuiltIn<
  AboutWhoSectionContent,
  'tag' | 'heading' | 'accent' | 'lead' | 'paragraphs'
> = {
  tag: { en: 'Who we are', ar: 'من نحن' },
  heading: {
    en: 'Born in Jeddah. Built to move ideas from the brain into the real world.',
    ar: 'وُلدنا في جدة. وُجدنا لننقل الأفكار من الدماغ إلى أرض الواقع.',
  },
  accent: { en: { from: 7 }, ar: { from: 6 } },
  lead: {
    en: 'We build brands that are seen, understood, and remembered. On a screen, on a stage, on a shelf, in any language.',
    ar: 'نبني علامات تُرى وتُفهم وتُتذكَّر. على الشاشة، وعلى المسرح، وعلى الرف، وبأي لغة.',
  },
  paragraphs: [
    {
      title: { en: 'Strategy before pixels.', ar: 'الاستراتيجية قبل التصميم.' },
      body: {
        en: "Every identity, film, and campaign starts with a question about the business, not a mood board. If the work isn't earning something, it isn't finished.",
        ar: 'كل هوية وكل فيلم وكل حملة تبدأ بسؤال عن العمل نفسه، لا بلوحة إلهام. وإن لم يكن الشغل يحقّق شيئاً، فهو غير مكتمل.',
      },
    },
    {
      title: { en: 'One studio, five disciplines.', ar: 'استوديو واحد، خمسة تخصصات.' },
      body: {
        en: 'Identity, film, sound, events, merch, and web all live under one roof, so the idea never gets diluted in the handoff between vendors.',
        ar: 'الهوية والإنتاج والصوت والفعاليات والمنتجات والويب تحت سقف واحد، فلا تضيع الفكرة في التنقل بين الجهات.',
      },
    },
    {
      title: { en: 'Native in any language.', ar: 'أصليّ بأي لغة.' },
      body: {
        en: 'Every language is written, typeset, and designed as itself, so none of them reads like a translation of another.',
        ar: 'كل لغة تُكتب وتُنسّق وتُصمَّم بلغتها، فلا تبدو أي واحدة منها ترجمة للأخرى.',
      },
    },
  ],
};
