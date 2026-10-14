import type { JoinStepsSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// "How it works" (JoinSteps.astro): join.html's j.stepsTag / j.stepsH / j.stepsP and STEPS,
// verbatim, each step with its time label. The Arabic third step keeps the design's
// Arabic-Indic digits ("حوالي ٤٥ دقيقة").
// "From application to <em>first brief</em>" / "من التقديم إلى <em>أول بريف</em>"

export const JOIN_STEPS_COPY: BuiltIn<
  JoinStepsSectionContent,
  'tag' | 'heading' | 'accent' | 'lead' | 'items'
> = {
  tag: { en: 'How it works', ar: 'كيف تمشي العملية' },
  heading: { en: 'From application to first brief', ar: 'من التقديم إلى أول بريف' },
  accent: { en: { from: 3 }, ar: { from: 3 } },
  lead: {
    en: "Four steps, and you'll hear from us at every one of them.",
    ar: 'أربع خطوات، وبتسمع منا في كل وحدة منها.',
  },
  items: [
    {
      heading: { en: 'Apply', ar: 'قدّم' },
      time: { en: 'Day one', ar: 'اليوم الأول' },
      text: {
        en: 'Send your portfolio and a few details. Five minutes, no cover letter.',
        ar: 'أرسل أعمالك وبعض التفاصيل. خمس دقائق، بدون خطاب تقديم.',
      },
    },
    {
      heading: { en: 'Portfolio review', ar: 'مراجعة الأعمال' },
      time: { en: 'Within two weeks', ar: 'خلال أسبوعين' },
      text: {
        en: 'A lead from your craft looks at the work itself, not just the CV.',
        ar: 'قائد من نفس حرفتك يراجع الشغل نفسه، مو بس السيرة الذاتية.',
      },
    },
    {
      heading: { en: 'Conversation', ar: 'محادثة' },
      time: { en: 'About 45 minutes', ar: 'حوالي ٤٥ دقيقة' },
      text: {
        en: "A call with the people you'd work with. Bring your questions too.",
        ar: 'مكالمة مع الناس اللي بتشتغل معهم. وجهّز أسئلتك أنت بعد.',
      },
    },
    {
      heading: { en: 'A short brief', ar: 'بريف قصير' },
      time: { en: 'A few days', ar: 'أيام قليلة' },
      text: {
        en: 'A small, real-world task so both sides see how working together feels.',
        ar: 'مهمة صغيرة واقعية عشان الطرفين يشوفون كيف يكون الشغل مع بعض.',
      },
    },
  ],
};
