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
// to the code): only with analytics consent under the current notice (src/lib/crm/attribution.ts
// hasAttributionConsent); the page, and for the first page seen with consent the referring
// site's name and the three campaign tags, the device class and the country (migration 0132's
// columns); never the IP, the full browser details, a full URL, a city or a stored link to page
// views; kept in the tab's session storage until it closes (`bs_ft`,
// src/lib/client/attribution.ts: an inquiry does not remove it), with a copy kept with an
// inquiry and deleted with it.
//
// No token is used (%mailbox% stays the DSAR line's and the recruitment section's alone): the
// rights line points to "Your rights" above.

/**
 * True while the lawyer has not approved this text (O-11). tests/lib/legalAttribution.spec.ts
 * holds it to the register: once no C13 HIGH row is open it must be false, and then the notices'
 * "Last updated" dates must have moved past C13's sections (C13 review COR-4). Nothing else
 * reads it.
 */
export const ATTRIBUTION_NOTICE_HELD: boolean = true;

export const ATTRIBUTION_PRIVACY: Readonly<Record<Locale, LegalSection>> = {
  en: {
    id: 'inquiry-attribution',
    heading: 'How you found us (recorded with an inquiry)',
    body: [
      'What we record: if you have allowed analytics cookies and you send us an inquiry, we record with it how you reached our site: the page you sent it from; for the first page you viewed in that visit after allowing analytics cookies, the name of the website that sent you to it (its name only, such as a search engine, never the full link) and the campaign tags of its link (source, medium and campaign name); whether you used a phone, a tablet or a computer; and the country your connection comes from.',
      'What we never record for this: your IP address, the full details of your browser, full web addresses or the searches in them, or your city. We store no identifier that links your inquiry to your visits to our pages.',
      'Why: to understand which channels bring us inquiries, and to help us decide which inquiries to answer first; an inquiry sent from a service page counts toward that.',
      'Lawful basis: your consent, given by accepting analytics cookies in the consent banner. Without it none of this is recorded, and we still answer your inquiry. You can withdraw your consent at any time; nothing more is recorded after that, and withdrawing does not affect what was done before.',
      'Retention: in your browser, it is kept in the tab’s session storage until you close the tab. If you send an inquiry, a copy is kept with it for as long as the inquiry is kept (see “Retention” above) and deleted with it.',
      'Who can see it: our staff who handle inquiries. We do not share it with advertising or analytics companies.',
      'Your rights: you can ask to see, correct or erase it together with the rest of your inquiry, as under “Your rights” above.',
    ],
  },
  ar: {
    id: 'inquiry-attribution',
    heading: 'كيف وصلت إلينا (يُسجَّل مع طلبك)',
    body: [
      'ما نسجّله: إذا وافقت على ملفات تعريف الارتباط التحليلية ثم أرسلت إلينا طلبًا، نسجّل معه كيف وصلت إلى موقعنا: الصفحة التي أرسلته منها؛ وعن أول صفحة زرتها في تلك الزيارة بعد موافقتك على ملفات تعريف الارتباط التحليلية: اسم الموقع الذي أحالك إليها (اسمه فقط، كمحرك بحث، لا الرابط الكامل) ووسوم الحملة في رابطها (المصدر والوسيط واسم الحملة)؛ ونوع جهازك (جوال أو جهاز لوحي أو حاسوب)؛ والدولة التي يأتي منها اتصالك.',
      'ما لا نسجّله لهذا الغرض أبدًا: عنوان IP الخاص بك، أو التفاصيل الكاملة لمتصفحك، أو عناوين الويب الكاملة أو عبارات البحث التي فيها، أو مدينتك. ولا نحفظ أي معرّف يربط طلبك بزياراتك لصفحاتنا.',
      'الغرض: معرفة القنوات التي تصلنا منها الطلبات، والمساعدة في تحديد الطلبات التي نرد عليها أولًا؛ ويُحتسب إرسال الطلب من صفحة خدمة ضمن ذلك.',
      'الأساس النظامي: موافقتك التي تمنحها بقبول ملفات تعريف الارتباط التحليلية في شريط الموافقة. وبدونها لا يُسجَّل شيء من ذلك، ونرد على طلبك مع ذلك. ويمكنك سحب موافقتك في أي وقت، فلا يُسجَّل شيء بعد ذلك، ولا يؤثر سحبها في ما تم قبله.',
      'مدة الاحتفاظ: يُحفظ في متصفحك في التخزين المؤقت لجلسة علامة التبويب حتى تغلقها. فإذا أرسلت طلبًا، تُحفظ نسخة منه مع طلبك طوال مدة الاحتفاظ به (انظر «مدة الاحتفاظ» أعلاه) وتُحذف معه.',
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
      'With analytics consent only, the site keeps two items in your browser’s session storage for the visit: a random visit number used to count visits (bs_sid), and how you reached the first page you viewed after allowing analytics (bs_ft: the name of the website that sent you there and the campaign tags of its link, or a note that you came from another page of this site), so that an inquiry you send can say how you found us. Both are cleared when you close the tab, and bs_ft is removed if you withdraw your consent or the consent banner asks you to choose again.',
    ],
  },
  ar: {
    id: 'session-storage',
    heading: 'التخزين في متصفحك',
    body: [
      'بموافقتك على التحليلات فقط، يحفظ الموقع عنصرين في التخزين المؤقت لجلسة متصفحك طوال الزيارة: رقمًا عشوائيًا للزيارة يُستخدم لعدّ الزيارات (bs_sid)، وكيف وصلت إلى أول صفحة زرتها بعد موافقتك على التحليلات (bs_ft: اسم الموقع الذي أحالك إليها ووسوم الحملة في رابطها، أو إشارة إلى أنك جئت من صفحة أخرى في هذا الموقع)، ليذكر طلبك إن أرسلته كيف وصلت إلينا. ويُمسح كلاهما عند إغلاق علامة التبويب، ويُحذف bs_ft إذا سحبت موافقتك أو طلب منك شريط الموافقة الاختيار من جديد.',
    ],
  },
};
