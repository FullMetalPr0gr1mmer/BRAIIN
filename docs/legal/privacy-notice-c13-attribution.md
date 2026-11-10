# Privacy notice update, part C13: lead attribution (DRAFT for the lawyer, O-11)

> **Status: draft, not approved. Nothing here is legal advice or a compliance sign-off.**
> This is the Admin v2 slice C13's part of the privacy-notice update that owner item O-11 asks
> the client's Saudi-licensed lawyer to approve. C5 (contacts) carries its own part in its own
> file; the two are kept apart so neither PR edits the other's text. The open questions about
> this part are in [review-register.md](review-register.md) (rows L-C13-1 to L-C13-8).
>
> The text below is the exact text the site will show, in English and Arabic. It lives in the
> code in `src/lib/legal/attribution.ts`, and `tests/lib/legalAttribution.spec.ts` fails if the
> code and this file differ. The notices' "Last updated" date is set to the day of approval when
> the slice merges. The PR stays held until the lawyer approves it.

## What the code does (for the reviewer)

- **Only with consent.** Nothing is recorded unless the visitor accepted analytics cookies in the
  consent banner. The server checks the consent cookie itself through the site's one consent
  gate (`hasAttributionConsent`, which calls `hasConsent`), whatever the browser sends, and the
  browser checks it too. The yes must have been given under the current consent version, as for
  Google Analytics: a choice made under an older notice, which the banner asks about again,
  records nothing. The first version that counts for attribution is a constant
  (`ATTRIBUTION_CONSENT_VERSION`) set at the merge to what the lawyer decides under L-C13-2.
- **Recorded with an inquiry** (the contact and project-inquiry forms): the page the form was sent
  from (a path, no query); for the first page of the visit seen with consent, the referring
  website's host name (no URL, never an IP address) and the three campaign tags of its link
  (`utm_source`, `utm_medium`, `utm_campaign`, as short lower-case words); the device class
  (phone, tablet or computer); the country of the connection (a two-letter code from the hosting
  network, Cloudflare). A value with an `@`, an encoded `@` or seven digits (in a row or split by
  separators such as `050-123-4567`) is dropped, so an e-mail address or a phone number written
  plainly in a link is not kept. From these the server derives a channel (search, social, ads,
  referral, direct, e-mail); when the visitor allowed analytics only on a later page of the visit,
  how they arrived was never seen and the channel is recorded as unknown, never as direct. Tags
  and referrers seen before consent are deliberately not kept: keeping them would mean storing
  them before the yes.
- **Scoring.** An inquiry sent from a service page gets the `service_page` points of the lead
  score that staff use to decide what to answer first (10 points of 100 by default, editable by
  an Admin). Because the page is recorded only with consent, these points apply only with
  consent.
- **Never recorded:** the IP address, the full User-Agent, full URLs or query strings, the city,
  the analytics visit number, or any link between the inquiry and page views.
- **In the browser:** the first touch is kept in the tab's session storage under `bs_ft` (with
  consent only; removed when consent is withdrawn or the banner asks again; gone when the tab
  closes; sending an inquiry does not remove it, so a second inquiry from the same tab carries it
  too). The analytics visit number `bs_sid` already existed and is listed for completeness.
- **Linking by inference:** nothing stored links an inquiry to page views, but the page an
  inquiry was sent from and its time could be matched against the raw page-view records (path,
  visit number and time, kept 90 days) to guess the visit on a quiet day. Register L-C13-8.
- **Retention and access:** the values are columns of the inquiry (lead) row: deleted with it
  (24 months, 30 days for spam, or on an erasure request), readable by the staff roles that handle
  inquiries (Admin, Developer and Sales), never writable by staff, never sent to a
  third party.
- **Where it is stored:** with the inquiry, in the site's database (Supabase), as the rest of the
  inquiry. The country code comes from Cloudflare, which already serves every request.

## Privacy notice: new section (`/privacy#inquiry-attribution`)

### English

**How you found us (recorded with an inquiry)**

What we record: if you have allowed analytics cookies and you send us an inquiry, we record with it how you reached our site: the page you sent it from; for the first page you viewed in that visit after allowing analytics cookies, the name of the website that sent you to it (its name only, such as a search engine, never the full link) and the campaign tags of its link (source, medium and campaign name); whether you used a phone, a tablet or a computer; and the country your connection comes from.

What we never record for this: your IP address, the full details of your browser, full web addresses or the searches in them, or your city. We store no identifier that links your inquiry to your visits to our pages.

Why: to understand which channels bring us inquiries, and to help us decide which inquiries to answer first; an inquiry sent from a service page counts toward that.

Lawful basis: your consent, given by accepting analytics cookies in the consent banner. Without it none of this is recorded, and we still answer your inquiry. You can withdraw your consent at any time; nothing more is recorded after that, and withdrawing does not affect what was done before.

Retention: in your browser, it is kept in the tab’s session storage until you close the tab. If you send an inquiry, a copy is kept with it for as long as the inquiry is kept (see “Retention” above) and deleted with it.

Who can see it: our staff who handle inquiries. We do not share it with advertising or analytics companies.

Your rights: you can ask to see, correct or erase it together with the rest of your inquiry, as under “Your rights” above.

### Arabic

<div dir="rtl" lang="ar">

**كيف وصلت إلينا (يُسجَّل مع طلبك)**

ما نسجّله: إذا وافقت على ملفات تعريف الارتباط التحليلية ثم أرسلت إلينا طلبًا، نسجّل معه كيف وصلت إلى موقعنا: الصفحة التي أرسلته منها؛ وعن أول صفحة زرتها في تلك الزيارة بعد موافقتك على ملفات تعريف الارتباط التحليلية: اسم الموقع الذي أحالك إليها (اسمه فقط، كمحرك بحث، لا الرابط الكامل) ووسوم الحملة في رابطها (المصدر والوسيط واسم الحملة)؛ ونوع جهازك (جوال أو جهاز لوحي أو حاسوب)؛ والدولة التي يأتي منها اتصالك.

ما لا نسجّله لهذا الغرض أبدًا: عنوان IP الخاص بك، أو التفاصيل الكاملة لمتصفحك، أو عناوين الويب الكاملة أو عبارات البحث التي فيها، أو مدينتك. ولا نحفظ أي معرّف يربط طلبك بزياراتك لصفحاتنا.

الغرض: معرفة القنوات التي تصلنا منها الطلبات، والمساعدة في تحديد الطلبات التي نرد عليها أولًا؛ ويُحتسب إرسال الطلب من صفحة خدمة ضمن ذلك.

الأساس النظامي: موافقتك التي تمنحها بقبول ملفات تعريف الارتباط التحليلية في شريط الموافقة. وبدونها لا يُسجَّل شيء من ذلك، ونرد على طلبك مع ذلك. ويمكنك سحب موافقتك في أي وقت، فلا يُسجَّل شيء بعد ذلك، ولا يؤثر سحبها في ما تم قبله.

مدة الاحتفاظ: يُحفظ في متصفحك في التخزين المؤقت لجلسة علامة التبويب حتى تغلقها. فإذا أرسلت طلبًا، تُحفظ نسخة منه مع طلبك طوال مدة الاحتفاظ به (انظر «مدة الاحتفاظ» أعلاه) وتُحذف معه.

من يطّلع عليه: أعضاء فريقنا الذين يتولّون الطلبات. ولا نشاركه مع شركات الإعلان أو التحليلات.

حقوقك: يمكنك طلب الاطلاع عليه أو تصحيحه أو حذفه مع بقية طلبك، كما في قسم «حقوقك» أعلاه.

</div>

## Cookie policy: new section (`/cookie-policy#session-storage`)

### English

**Storage in your browser**

With analytics consent only, the site keeps two items in your browser’s session storage for the visit: a random visit number used to count visits (bs_sid), and how you reached the first page you viewed after allowing analytics (bs_ft: the name of the website that sent you there and the campaign tags of its link, or a note that you came from another page of this site), so that an inquiry you send can say how you found us. Both are cleared when you close the tab, and bs_ft is removed if you withdraw your consent or the consent banner asks you to choose again.

### Arabic

<div dir="rtl" lang="ar">

**التخزين في متصفحك**

بموافقتك على التحليلات فقط، يحفظ الموقع عنصرين في التخزين المؤقت لجلسة متصفحك طوال الزيارة: رقمًا عشوائيًا للزيارة يُستخدم لعدّ الزيارات (bs_sid)، وكيف وصلت إلى أول صفحة زرتها بعد موافقتك على التحليلات (bs_ft: اسم الموقع الذي أحالك إليها ووسوم الحملة في رابطها، أو إشارة إلى أنك جئت من صفحة أخرى في هذا الموقع)، ليذكر طلبك إن أرسلته كيف وصلت إلينا. ويُمسح كلاهما عند إغلاق علامة التبويب، ويُحذف bs_ft إذا سحبت موافقتك أو طلب منك شريط الموافقة الاختيار من جديد.

</div>

## Proposed wording held back (for the lawyer's decision)

These are NOT in the code. They are ready if the lawyer asks for them (register L-C13-2).

- **Consent banner, English:** "We use functional cookies to run the site, and, only with your
  consent, first-party analytics to improve it and, if you send us an inquiry, to record how you
  found us. See our Cookie Policy."
- **Consent banner, Arabic:** "نستخدم ملفات تعريف الارتباط الوظيفية لتشغيل الموقع، ولا نستخدم
  التحليلات الخاصة بنا لتحسينه ولتسجيل كيف وصلت إلينا إن أرسلت طلبًا إلا بموافقتك. اطّلع على
  سياسة ملفات تعريف الارتباط."
- With either: raising the consent version (`CONSENT_VERSION`) and setting
  `ATTRIBUTION_CONSENT_VERSION` to the new value (`packages/consent/version.ts`), so a choice made
  before the change is asked again and records nothing until the visitor chooses again. This is
  also the step the Google Analytics switch-on plans, so the two would be one re-prompt if they
  ship together.
