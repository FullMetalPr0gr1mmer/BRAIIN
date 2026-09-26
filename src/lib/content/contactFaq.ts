import type { Locale } from '@schemas/primitives';

// The /contact FAQ — code-owned in v1, deliberately.
//
// This array is the SINGLE source for two things that must never disagree: the visible
// <details> list rendered by FaqAccordion.astro, and the FAQPage JSON-LD emitted in
// <head> by ContactPage.astro. Google issues manual actions for structured data that
// does not match visible content, so a CMS-overridable answer body would let an editor
// create exactly that mismatch with no gate to catch it. When these move to the CMS
// they must move together, behind one loader.
//
// Answers are written answer-first (GEO authoring default, CLAUDE.md Pillar 3): the
// direct answer lands in the first sentence, the qualification follows.
//
// Both languages are the UI v2 design's copy VERBATIM (contact.html FAQ): the English as
// before, the Arabic in the design's Saudi voice (owner decision 6), replacing the earlier
// MSA rewrite. tests/lib/contactPage.spec.ts pins the counts and the language parity.

export interface FaqItem {
  q: string;
  a: string;
}

export const CONTACT_FAQ: Record<Locale, FaqItem[]> = {
  en: [
    {
      q: 'What does a full brand identity include?',
      a: 'Strategy, naming direction if you need it, a logo system, type and colour, art direction, and a usage guide. You leave with files your own team and any future vendor can actually work from, not a folder of JPEGs.',
    },
    {
      q: 'How many concepts do we see?',
      a: "Two or three routes, and every one of them is a direction we would be happy to build. We don't pad a presentation with options we don't believe in just to make the deck look fuller.",
    },
    {
      q: 'How many rounds of revisions come with that?',
      a: 'Two rounds are built into every stage. If you want more we bill by the hour, and we tell you before the clock starts, never after.',
    },
    {
      q: 'How long does a project take?',
      a: "A brand identity usually runs six to ten weeks. A film depends on the shoot. A social campaign can move in two. You get a dated schedule before the work starts, not once it's already late.",
    },
    {
      q: 'Can we hire you for just one service?',
      a: 'Yes. Take one of the fourteen or take all of them. Nothing is bundled together to force a bigger invoice.',
    },
    {
      q: 'Do you work with brands that already exist?',
      a: "Often. Sometimes the answer is a full rebuild and sometimes it's a tune-up, and we'll tell you honestly which one you need even when the smaller job is the right call.",
    },
    {
      q: 'What languages do you work in?',
      a: "Arabic and English are handled natively in house. Anything else runs through partners we've vetted, with our team still owning the typesetting and art direction so the result doesn't read like a translation.",
    },
    {
      q: 'How is pricing structured?',
      a: 'A fixed price per project once the scope is agreed, or a monthly retainer for ongoing work. No hourly surprises at the end.',
    },
    {
      q: 'Who owns the finished work?',
      a: 'You do. Full rights transfer on final payment, source files included.',
    },
    {
      q: 'How do we get started?',
      a: "Send the form above or email us directly. You'll get a reply within one business day with our questions, a rough range, and a time to talk.",
    },
  ],
  ar: [
    {
      q: 'وش تشمل الهوية البصرية الكاملة؟',
      a: 'الاستراتيجية، واتجاه التسمية إذا احتجته، ونظام شعار متكامل، والخطوط والألوان، والإخراج الفني، ودليل استخدام. تخرج بملفات يقدر فريقك أو أي جهة مستقبلية يشتغلون عليها فعلاً، مو مجلد صور.',
    },
    {
      q: 'كم اتجاه نشوف؟',
      a: 'اتجاهين أو ثلاثة، وكل واحد منها اتجاه نسعد ببنائه. ما نحشو العرض بخيارات ما نؤمن فيها عشان يبان أكبر.',
    },
    {
      q: 'كم جولة تعديلات تجي معها؟',
      a: 'جولتان مضمّنتان في كل مرحلة. وإذا احتجت أكثر نحسبها بالساعة، ونخبرك قبل ما يبدأ العداد، لا بعده.',
    },
    {
      q: 'كم ياخذ المشروع وقت؟',
      a: 'الهوية البصرية عادةً من ستة إلى عشرة أسابيع. الفيلم يعتمد على التصوير. الحملة الاجتماعية ممكن تتحرك في أسبوعين. تستلم جدولاً بتواريخ قبل بداية الشغل، مو بعد ما يتأخر.',
    },
    {
      q: 'نقدر نطلب خدمة واحدة بس؟',
      a: 'أكيد. خذ واحدة من الأربع عشرة أو خذها كلها. ما في شيء مربوط ببعضه عشان تكبر الفاتورة.',
    },
    {
      q: 'تشتغلون مع علامات قائمة أصلاً؟',
      a: 'كثير. أحياناً الجواب إعادة بناء كاملة، وأحياناً مجرد ضبط، وبنقول لك بصراحة أي واحدة تحتاجها حتى لو كان الشغل الأصغر هو الصح.',
    },
    {
      q: 'بأي لغات تشتغلون؟',
      a: 'العربية والإنجليزية داخل الاستوديو وبشكل أصلي. وأي لغة ثانية عبر شركاء مجرَّبين، ويبقى التنسيق والإخراج الفني عندنا حتى ما تطلع النتيجة وكأنها ترجمة.',
    },
    {
      q: 'كيف تُحسب الأسعار؟',
      a: 'سعر ثابت للمشروع بعد الاتفاق على النطاق، أو عقد شهري للشغل المستمر. بدون مفاجآت بالساعة في النهاية.',
    },
    {
      q: 'لمن تعود ملكية الشغل؟',
      a: 'لك أنت. نقل كامل للحقوق عند السداد النهائي، وملفات المصدر مشمولة.',
    },
    {
      q: 'كيف نبدأ؟',
      a: 'أرسل النموذج فوق أو راسلنا مباشرة. يوصلك رد خلال يوم عمل واحد فيه أسئلتنا، ونطاق سعري مبدئي، وموعد للمكالمة.',
    },
  ],
};
