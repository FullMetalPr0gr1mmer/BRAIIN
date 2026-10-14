import type { AboutIntroSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// Home "Why {brand}" (AboutIntro.astro), the approved design's copy. The tag names the
// studio through `%brand%`, filled from the public identity. The built-in heading bolds one
// run, written as `<b>…</b>` and split into a text run and a <b> element (splitBold), never
// injected; an authored heading is plain text.

export const ABOUT_INTRO_COPY: BuiltIn<
  AboutIntroSectionContent,
  'tag' | 'heading' | 'lead' | 'columns'
> = {
  tag: { en: 'Why %brand%', ar: 'ليش %brand%' },
  heading: {
    en: 'Born in Jeddah. Built to move ideas <b>from the brain into the real world</b>.',
    ar: 'وُلدنا في جدة. وُجدنا لننقل الأفكار <b>من الدماغ إلى أرض الواقع</b>.',
  },
  lead: {
    en: 'We build brands that are seen, understood, and remembered. On a screen, on a stage, on a shelf, in any language.',
    ar: 'نبني علامات تُرى وتُفهم وتُتذكَّر. على الشاشة، وعلى المسرح، وعلى الرف، وبأي لغة.',
  },
  columns: [
    {
      title: { en: 'Strategy before pixels', ar: 'الاستراتيجية قبل التصميم' },
      body: {
        en: "Every identity, film, and campaign starts with a question about the business, not a mood board. If the work isn't earning something, it isn't finished.",
        ar: 'كل هوية وكل فيلم وكل حملة تبدأ بسؤال عن العمل نفسه، لا بلوحة إلهام. وإن لم يكن الشغل يحقّق شيئاً، فهو غير مكتمل.',
      },
    },
    {
      title: { en: 'One studio, five disciplines', ar: 'استوديو واحد، خمسة تخصصات' },
      body: {
        en: 'Identity, film, sound, events, merch, and web all live under one roof, so the idea never gets diluted in the handoff between three vendors.',
        ar: 'الهوية والإنتاج والصوت والفعاليات والمنتجات والويب تحت سقف واحد، فلا تضيع الفكرة في التنقل بين ثلاث جهات.',
      },
    },
    {
      title: { en: 'Native in any language', ar: 'أصليّ بأي لغة' },
      body: {
        en: 'Arabic, English, or whatever the market speaks. Every language is written, typeset, and designed natively, so none of them ends up reading like a translation of another.',
        ar: 'عربي، إنجليزي، أو أي لغة يتحدثها السوق. كل لغة تُكتب وتُنسّق وتُصمَّم بلغتها، فلا تبدو أي واحدة منها ترجمة للأخرى.',
      },
    },
  ],
};
