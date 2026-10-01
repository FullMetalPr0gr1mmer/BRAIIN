import type { Locale } from '@schemas/primitives';

// Legal content (PDPL-oriented) for the v1 legal pages. DRAFT skeletons — the copy
// is structurally complete (data, lawful basis, retention, rights/DSAR, cookies)
// but pending legal sign-off. Retention numbers mirror CLAUDE.md / architecture.
//
// Join: the privacy notice's `recruitment` section is what the application form's consent
// links to (/privacy#recruitment). Its retention horizons are the application rows' own
// (APPLICATION_RETENTION_MONTHS, SPAM_RETENTION_DAYS in packages/schemas/application.ts —
// tests/lib/legal.spec.ts holds the words to the numbers).

export interface LegalSection {
  /** The section's fragment id (`/privacy#recruitment`), for a section linked to directly. */
  id?: string;
  heading: string;
  body: string[];
}

/** The mailbox the rights requests go to (the DSAR text and the recruitment section). */
export const PRIVACY_MAILBOX = 'privacy@braiinstation.com';
export interface LegalDoc {
  title: string;
  updated: string;
  draftNotice: string;
  intro: string;
  sections: LegalSection[];
}
export type LegalKey = 'privacy' | 'terms' | 'cookie';

export const LEGAL: Record<Locale, Record<LegalKey, LegalDoc>> = {
  en: {
    privacy: {
      title: 'Privacy Policy',
      updated: 'Last updated: 1 October 2026',
      draftNotice: 'Draft — pending legal review before launch.',
      intro:
        "This policy explains what personal data Braiin Station collects, why, and your rights under Saudi Arabia's Personal Data Protection Law (PDPL).",
      sections: [
        {
          heading: 'Data we collect',
          body: [
            'Contact and project-inquiry submissions: name, email, optional phone, and your message.',
            'Optional project details: service of interest, budget band, and timeline.',
            'Consent-gated, first-party analytics about how pages are used.',
            'Job applications sent through the Join form — see “Job applications” below.',
          ],
        },
        {
          heading: 'Lawful basis and purpose',
          body: [
            'We process contact details to respond to your enquiry, at your request.',
            'Analytics and any marketing cookies are processed only with your consent, which you can withdraw at any time.',
          ],
        },
        {
          heading: 'Retention',
          body: [
            'Leads are retained for up to 24 months; submissions identified as spam are deleted within 30 days.',
            'First-party analytics are retained for 90 days. (Retention horizons are pending legal sign-off and may be shortened.)',
          ],
        },
        {
          heading: 'Your rights (DSAR)',
          body: [
            'You may request access, correction, or deletion of your data, and withdraw consent at any time.',
            `To exercise these rights, contact ${PRIVACY_MAILBOX}.`,
          ],
        },
        {
          heading: 'Security and sharing',
          body: [
            'Sensitive personal data is encrypted at rest; access is role-restricted and logged.',
            'We do not sell your personal data.',
          ],
        },
        {
          id: 'recruitment',
          heading: 'Job applications (the Join form)',
          body: [
            'What we collect: your name, email address, phone number and city; the role you are interested in, your experience, how you would like to work, when you could start and the crafts you work in; your portfolio link and, if you add one, your LinkedIn link; your answer about the work you are proudest of; and your CV, if you attach one.',
            'Why: to review your application and to contact you about it. If you also tick the box for future roles, we keep your application on file and may contact you about roles that open later.',
            'Lawful basis: your consent, given with the boxes on the form. You can withdraw it at any time; withdrawing does not affect what was done before.',
            'Retention: an application is kept for 12 months, or for 24 months if you agreed to be contacted about future roles. Applications marked as spam are kept for 30 days. Each is deleted automatically when its period ends.',
            'Who can see it: administrators only. No other staff role can open applications or CVs.',
            'Where it is stored: with Supabase, in London, United Kingdom. CVs are kept in a private storage bucket, never public, and only administrators can download them.',
            'CVs are not scanned for viruses. Administrators open them only as downloads, never inside the site.',
            `Your rights: you can ask to see, correct or erase your application, and withdraw your consent, at any time — write to ${PRIVACY_MAILBOX}, as under “Your rights” above.`,
          ],
        },
      ],
    },
    terms: {
      title: 'Terms of Service',
      updated: 'Last updated: 10 June 2026',
      draftNotice: 'Draft — pending legal review before launch.',
      intro: 'These terms govern your use of the Braiin Station website.',
      sections: [
        {
          heading: 'Use of the site',
          body: [
            'Use the site lawfully and do not attempt to disrupt or gain unauthorised access to it.',
          ],
        },
        {
          heading: 'Intellectual property',
          body: [
            'All content, branding, and creative work are owned by Braiin Station unless stated otherwise.',
          ],
        },
        {
          heading: 'No warranty',
          body: [
            'The site is provided "as is" without warranties of any kind to the extent permitted by law.',
          ],
        },
        {
          heading: 'Limitation of liability',
          body: [
            'Braiin Station is not liable for indirect or consequential losses arising from use of the site.',
          ],
        },
        {
          heading: 'Governing law',
          body: ['These terms are governed by the laws of the Kingdom of Saudi Arabia.'],
        },
      ],
    },
    cookie: {
      title: 'Cookie Policy',
      updated: 'Last updated: 10 June 2026',
      draftNotice: 'Draft — pending legal review before launch.',
      intro: 'How Braiin Station uses cookies and similar technologies.',
      sections: [
        {
          heading: 'Categories',
          body: [
            'Functional (strictly necessary): always on; required for the site to work.',
            'Analytics: consent-gated; off by default.',
            'Marketing: consent-gated; off by default.',
          ],
        },
        {
          heading: 'Managing your consent',
          body: [
            'You choose your preferences in the consent banner. Everything except functional is denied until you opt in, and you can change your choice at any time.',
          ],
        },
        {
          heading: 'Third-party embeds',
          body: [
            'Video embeds load only after you click the placeholder (a "facade"), so no third-party cookies are set until you choose to play.',
          ],
        },
      ],
    },
  },
  ar: {
    privacy: {
      title: 'سياسة الخصوصية',
      updated: 'آخر تحديث: 1 أكتوبر 2026',
      draftNotice: 'مسودة — قيد المراجعة القانونية قبل الإطلاق.',
      intro:
        'توضح هذه السياسة البيانات الشخصية التي تجمعها بريّن ستيشن، وسبب جمعها، وحقوقك بموجب نظام حماية البيانات الشخصية (PDPL) في المملكة العربية السعودية.',
      sections: [
        {
          heading: 'البيانات التي نجمعها',
          body: [
            'بيانات التواصل وطلبات المشاريع: الاسم، البريد الإلكتروني، الهاتف (اختياري)، ورسالتك.',
            'تفاصيل المشروع الاختيارية: الخدمة المطلوبة، نطاق الميزانية، والجدول الزمني.',
            'تحليلات أولية الطرف خاضعة للموافقة حول طريقة استخدام الصفحات.',
            'طلبات التوظيف المرسلة عبر نموذج الانضمام — انظر «طلبات التوظيف» أدناه.',
          ],
        },
        {
          heading: 'الأساس القانوني والغرض',
          body: [
            'نعالج بيانات التواصل للرد على استفسارك بناءً على طلبك.',
            'لا تُعالج التحليلات أو ملفات التسويق إلا بموافقتك، ويمكنك سحبها في أي وقت.',
          ],
        },
        {
          heading: 'مدة الاحتفاظ',
          body: [
            'يُحتفظ بالعملاء المحتملين حتى 24 شهرًا؛ وتُحذف الرسائل المصنّفة كرسائل مزعجة خلال 30 يومًا.',
            'تُحفظ التحليلات الأولية الطرف لمدة 90 يومًا. (مدد الاحتفاظ قيد الاعتماد القانوني وقد تُقلَّص.)',
          ],
        },
        {
          heading: 'حقوقك',
          body: [
            'يمكنك طلب الوصول إلى بياناتك أو تصحيحها أو حذفها، وسحب موافقتك في أي وقت.',
            `لممارسة هذه الحقوق، تواصل عبر ${PRIVACY_MAILBOX}.`,
          ],
        },
        {
          heading: 'الأمان والمشاركة',
          body: [
            'تُشفّر البيانات الحساسة أثناء التخزين، والوصول إليها مقيّد بالأدوار ومُسجّل.',
            'لا نبيع بياناتك الشخصية.',
          ],
        },
        {
          id: 'recruitment',
          heading: 'طلبات التوظيف (نموذج الانضمام)',
          body: [
            'ما نجمعه: اسمك وبريدك الإلكتروني ورقم جوالك ومدينتك؛ والوظيفة التي تهمك، وخبرتك، وطريقة العمل التي تفضّلها، والموعد الذي يمكنك البدء فيه، والمجالات التي تعمل فيها؛ ورابط أعمالك، ورابط حسابك على لينكدإن إن أضفته؛ وإجابتك عن العمل الذي تفخر به أكثر؛ وسيرتك الذاتية إن أرفقتها.',
            'الغرض: مراجعة طلبك والتواصل معك بشأنه. وإن وافقت أيضًا على التواصل بشأن وظائف مستقبلية، نحتفظ بطلبك وقد نتواصل معك بشأن وظائف تُتاح لاحقًا.',
            'الأساس النظامي: موافقتك التي تمنحها عبر مربعات الموافقة في النموذج. ويمكنك سحبها في أي وقت، ولا يؤثر سحبها في ما تم قبل ذلك.',
            'مدة الاحتفاظ: نحتفظ بالطلب 12 شهرًا، أو 24 شهرًا إن وافقت على التواصل بشأن وظائف مستقبلية، ونحتفظ بالطلبات المصنّفة كرسائل مزعجة 30 يومًا. ويُحذف كل طلب تلقائيًا عند انتهاء مدته.',
            'من يطّلع عليه: مديرو الموقع فقط، ولا يستطيع أي دور آخر من فريق العمل فتح الطلبات أو السير الذاتية.',
            'مكان التخزين: لدى Supabase في لندن بالمملكة المتحدة. وتُحفظ السير الذاتية في مستودع تخزين خاص غير متاح للعامة، ولا يمكن تنزيلها إلا لمديري الموقع.',
            'لا تُفحص السير الذاتية بحثًا عن الفيروسات، ويفتحها مديرو الموقع كملفات مُنزَّلة فقط، لا داخل الموقع.',
            `حقوقك: يمكنك في أي وقت طلب الاطلاع على طلبك أو تصحيحه أو حذفه، وسحب موافقتك، بمراسلة ${PRIVACY_MAILBOX} كما في قسم «حقوقك» أعلاه.`,
          ],
        },
      ],
    },
    terms: {
      title: 'شروط الخدمة',
      updated: 'آخر تحديث: 10 يونيو 2026',
      draftNotice: 'مسودة — قيد المراجعة القانونية قبل الإطلاق.',
      intro: 'تحكم هذه الشروط استخدامك لموقع بريّن ستيشن.',
      sections: [
        {
          heading: 'استخدام الموقع',
          body: ['استخدم الموقع بشكل قانوني ولا تحاول تعطيله أو الوصول غير المصرّح به إليه.'],
        },
        {
          heading: 'الملكية الفكرية',
          body: [
            'جميع المحتويات والهوية والأعمال الإبداعية مملوكة لبريّن ستيشن ما لم يُذكر خلاف ذلك.',
          ],
        },
        {
          heading: 'إخلاء المسؤولية',
          body: ['يُقدَّم الموقع "كما هو" دون أي ضمانات إلى الحد الذي يسمح به النظام.'],
        },
        {
          heading: 'حدود المسؤولية',
          body: ['لا تتحمل بريّن ستيشن مسؤولية الأضرار غير المباشرة الناتجة عن استخدام الموقع.'],
        },
        { heading: 'القانون الحاكم', body: ['تخضع هذه الشروط لأنظمة المملكة العربية السعودية.'] },
      ],
    },
    cookie: {
      title: 'سياسة ملفات تعريف الارتباط',
      updated: 'آخر تحديث: 10 يونيو 2026',
      draftNotice: 'مسودة — قيد المراجعة القانونية قبل الإطلاق.',
      intro: 'كيف تستخدم بريّن ستيشن ملفات تعريف الارتباط والتقنيات المشابهة.',
      sections: [
        {
          heading: 'الفئات',
          body: [
            'وظيفية (ضرورية): مفعّلة دائمًا ولازمة لعمل الموقع.',
            'تحليلية: خاضعة للموافقة ومعطّلة افتراضيًا.',
            'تسويقية: خاضعة للموافقة ومعطّلة افتراضيًا.',
          ],
        },
        {
          heading: 'إدارة موافقتك',
          body: [
            'تختار تفضيلاتك من شريط الموافقة. كل شيء عدا الوظيفية معطّل حتى توافق، ويمكنك تغيير اختيارك في أي وقت.',
          ],
        },
        {
          heading: 'محتوى الطرف الثالث',
          body: [
            'لا تُحمّل مقاطع الفيديو إلا بعد النقر على الصورة البديلة، فلا تُضبط ملفات الطرف الثالث حتى تختار التشغيل.',
          ],
        },
      ],
    },
  },
};
