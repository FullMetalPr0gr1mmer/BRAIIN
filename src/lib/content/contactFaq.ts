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
      q: 'ماذا تشمل الهوية البصرية الكاملة؟',
      a: 'الاستراتيجية، واتجاه التسمية إن احتجته، ونظام شعار متكامل، والخطوط والألوان، والإخراج الفني، ودليل استخدام. تخرج بملفات يستطيع فريقك أو أي جهة تتعامل معها مستقبلًا العمل عليها فعليًا، لا مجرّد مجلد صور.',
    },
    {
      q: 'كم اتجاهًا إبداعيًا سنرى؟',
      a: 'اتجاهان أو ثلاثة، وكل واحد منها اتجاه يسعدنا تنفيذه. لا نملأ العرض بخيارات لا نؤمن بها لمجرد أن يبدو أكبر.',
    },
    {
      q: 'كم جولة تعديلات تشملها؟',
      a: 'جولتان مضمّنتان في كل مرحلة. وإذا احتجت المزيد نحتسبها بالساعة، ونخبرك قبل أن يبدأ العدّاد لا بعده.',
    },
    {
      q: 'كم يستغرق المشروع؟',
      a: 'الهوية البصرية عادةً من ستة إلى عشرة أسابيع. الفيلم يعتمد على أيام التصوير. الحملة على منصات التواصل قد تتحرك خلال أسبوعين. تستلم جدولًا بتواريخ محددة قبل بدء العمل، لا بعد أن يتأخر.',
    },
    {
      q: 'هل يمكننا طلب خدمة واحدة فقط؟',
      a: 'نعم. اختر واحدة من الأربع عشرة خدمة أو اطلبها كلها. لا شيء مربوط ببعضه لتكبير الفاتورة.',
    },
    {
      q: 'هل تعملون مع علامات تجارية قائمة؟',
      a: 'كثيرًا. أحيانًا يكون الجواب إعادة بناء كاملة، وأحيانًا مجرد ضبط وتحديث، وسنخبرك بصراحة أيّهما تحتاج حتى لو كان العمل الأصغر هو الخيار الصحيح.',
    },
    {
      q: 'بأي لغات تعملون؟',
      a: 'العربية والإنجليزية داخل الاستوديو وبشكل أصلي. وأي لغة أخرى عبر شركاء مُعتمدين لدينا، مع بقاء التنسيق الطباعي والإخراج الفني تحت إشراف فريقنا حتى لا تبدو النتيجة وكأنها ترجمة.',
    },
    {
      q: 'كيف تُحدَّد الأسعار؟',
      a: 'سعر ثابت للمشروع بعد الاتفاق على نطاق العمل، أو عقد شهري للأعمال المستمرة. بلا مفاجآت محتسبة بالساعة في النهاية.',
    },
    {
      q: 'لمن تعود ملكية العمل النهائي؟',
      a: 'لك أنت. نقل كامل للحقوق عند السداد النهائي، وملفات المصدر مشمولة.',
    },
    {
      q: 'كيف نبدأ؟',
      a: 'أرسل النموذج أعلاه أو راسلنا مباشرة. سيصلك ردّ خلال يوم عمل واحد يتضمّن أسئلتنا، ونطاقًا سعريًا مبدئيًا، وموعدًا للحديث.',
    },
  ],
};
