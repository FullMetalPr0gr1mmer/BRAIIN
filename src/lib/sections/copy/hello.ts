import type { HelloSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// "Say hello" (Hello.astro, Round 2): the inquiry block closing /services and every service
// page, verbatim from the mockups (services.html / service.html `h.*`): "Say <em>hello</em>"
// / "قل <em>هلا</em>". A service page hands the block its own heading and lead instead
// (SERVICE_PAGE_COPY, src/lib/services/pageCopy.ts). The form's copy is the form's own
// (src/lib/forms/contactCopy.ts).

export const HELLO_COPY: BuiltIn<
  HelloSectionContent,
  'tag' | 'heading' | 'accent' | 'lead' | 'points'
> = {
  tag: { en: 'Project inquiry', ar: 'طلب مشروع' },
  heading: { en: 'Say hello', ar: 'قل هلا' },
  accent: { en: { from: 1 }, ar: { from: 1 } },
  lead: {
    en: 'Big idea or small fix, tell us where you want to go. The more you share, the more useful our first reply is.',
    ar: 'فكرة كبيرة أو تعديل بسيط، قل لنا وين تبي توصل. كل ما شاركتنا أكثر، صار ردنا الأول أنفع.',
  },
  points: [
    { text: { en: 'A reply within one business day', ar: 'رد خلال يوم عمل واحد' } },
    {
      text: {
        en: 'A fixed price once the scope is agreed',
        ar: 'سعر ثابت بعد الاتفاق على النطاق',
      },
    },
    {
      text: {
        en: 'One team from the first sketch to launch',
        ar: 'فريق واحد من أول رسمة إلى الإطلاق',
      },
    },
  ],
};
