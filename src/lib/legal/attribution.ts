import type { Locale } from '@schemas/primitives';
import type { LegalSection } from './content';

// ═══ C13: lead attribution, its part of the notices (HELD for O-11) ═══════════════════════════
// Admin v2 C13 (crm.md §7.3). The privacy notice's section on what an inquiry records about
// how the visitor found the site, and the cookie policy's line on the browser storage behind
// it. DRAFT, pending the client's lawyer: the same text, for sign-off, is in
// docs/legal/privacy-notice-c13-attribution.md (tests/lib/legalAttribution.spec.ts holds the
// two equal), kept apart from C5's privacy-notice file so the two PRs touch different files.
// content.ts adds each section in its own hunk, after the sections it had; the notices'
// "Last updated" dates move on the day the lawyer approves the text, at the merge.
//
// What it must say, and what the code does (tests/lib/legalAttribution.spec.ts holds the words
// to the code): only with analytics consent (src/lib/crm/attribution.ts hasConsent); the page,
// the referring site's name, the three campaign tags, the device class and the country
// (migration 0132's columns); never the IP, the full browser details, a full URL, a city or a
// link to page views; kept for the visit in session storage (`bs_ft`,
// src/lib/client/attribution.ts), then with the inquiry and deleted with it.
//
// No token is used (%mailbox% stays the DSAR line's and the recruitment section's alone): the
// rights line points to "Your rights" above.

export const ATTRIBUTION_PRIVACY: Readonly<Record<Locale, LegalSection>> = {
  en: {
    id: 'inquiry-attribution',
    heading: 'How you found us (recorded with an inquiry)',
    body: [
      'What we record: if you have allowed analytics cookies and you send us an inquiry, we record with it how you reached our site: the page you sent it from; the name of the website that sent you to us (its name only, such as a search engine, never the full link); the campaign tags of the link you first arrived by (its source, medium and campaign name); whether you used a phone, a tablet or a computer; and the country your connection comes from.',
      'What we never record for this: your IP address, the full details of your browser, full web addresses or the searches in them, your city, or anything that links your inquiry to your visits to our pages.',
      'Why: to understand which channels bring us inquiries, and to help us decide which inquiries to answer first; an inquiry sent from a service page counts toward that.',
      'Lawful basis: your consent, given by accepting analytics cookies in the consent banner. Without it none of this is recorded, and we still answer your inquiry. You can withdraw your consent at any time; nothing more is recorded after that, and withdrawing does not affect what was done before.',
      'Retention: until you send an inquiry, it stays in your browser for the visit only (the session storage of the tab, cleared when you close it). Once sent, it is kept with your inquiry for as long as the inquiry is kept (see “Retention” above) and deleted with it.',
      'Who can see it: our staff who handle inquiries. We do not share it with advertising or analytics companies.',
      'Your rights: you can ask to see, correct or erase it together with the rest of your inquiry, as under “Your rights” above.',
    ],
  },
  ar: {
    id: 'inquiry-attribution',
    heading: 'كيف وصلت إلينا (يُسجَّل مع طلبك)',
    body: [
      'ما نسجّله: إذا وافقت على ملفات تعريف الارتباط التحليلية ثم أرسلت إلينا طلبًا، نسجّل معه كيف وصلت إلى موقعنا: الصفحة التي أرسلته منها؛ واسم الموقع الذي أحالك إلينا (اسمه فقط، كمحرك بحث، لا الرابط الكامل)؛ ووسوم الحملة في الرابط الذي وصلت عبره أول مرة (المصدر والوسيط واسم الحملة)؛ ونوع جهازك (جوال أو جهاز لوحي أو حاسوب)؛ والدولة التي يأتي منها اتصالك.',
      'ما لا نسجّله لهذا الغرض أبدًا: عنوان IP الخاص بك، أو التفاصيل الكاملة لمتصفحك، أو عناوين الويب الكاملة أو عبارات البحث التي فيها، أو مدينتك، أو أي شيء يربط طلبك بزياراتك لصفحاتنا.',
      'الغرض: معرفة القنوات التي تصلنا منها الطلبات، والمساعدة في تحديد الطلبات التي نرد عليها أولًا؛ ويُحتسب إرسال الطلب من صفحة خدمة ضمن ذلك.',
      'الأساس النظامي: موافقتك التي تمنحها بقبول ملفات تعريف الارتباط التحليلية في شريط الموافقة. وبدونها لا يُسجَّل شيء من ذلك، ونرد على طلبك مع ذلك. ويمكنك سحب موافقتك في أي وقت، فلا يُسجَّل شيء بعد ذلك، ولا يؤثر سحبها في ما تم قبله.',
      'مدة الاحتفاظ: يبقى في متصفحك طوال الزيارة فقط (في التخزين المؤقت لجلسة علامة التبويب، ويُمسح عند إغلاقها) إلى أن ترسل طلبًا. فإذا أرسلته، يُحفظ مع طلبك طوال مدة الاحتفاظ به (انظر «مدة الاحتفاظ» أعلاه) ويُحذف معه.',
      'من يطّلع عليه: أعضاء فريقنا الذين يتولّون الطلبات. ولا نشاركه مع شركات الإعلان أو التحليلات.',
      'حقوقك: يمكنك طلب الاطلاع عليه أو تصحيحه أو حذفه مع بقية طلبك، كما في قسم «حقوقك» أعلاه.',
    ],
  },
};

export const ATTRIBUTION_COOKIE: Readonly<Record<Locale, LegalSection>> = {
  en: {
    id: 'session-storage',
    heading: 'Storage in your browser',
    body: [
      'With analytics consent only, the site keeps two items in your browser’s session storage for the visit: a random visit number used to count visits (bs_sid), and how you first arrived (bs_ft: the name of the website that sent you and the campaign tags of the link), so that an inquiry you send can say how you found us. Both are cleared when you close the tab, and bs_ft is removed if you withdraw your consent.',
    ],
  },
  ar: {
    id: 'session-storage',
    heading: 'التخزين في متصفحك',
    body: [
      'بموافقتك على التحليلات فقط، يحفظ الموقع عنصرين في التخزين المؤقت لجلسة متصفحك طوال الزيارة: رقمًا عشوائيًا للزيارة يُستخدم لعدّ الزيارات (bs_sid)، وكيف وصلت أول مرة (bs_ft: اسم الموقع الذي أحالك ووسوم الحملة في الرابط)، ليذكر طلبك إن أرسلته كيف وصلت إلينا. ويُمسح كلاهما عند إغلاق علامة التبويب، ويُحذف bs_ft إذا سحبت موافقتك.',
    ],
  },
};
