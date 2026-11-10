# Privacy notice update for contacts and the CRM (draft for the lawyer, owner item O-11)

> **Status: a draft for the client's Saudi-licensed lawyer. Not legal advice, and not a sign-off.**
> Nothing here says the site or the CRM meets any law. The Admin v2 contacts chain (C5 to C8,
> C9b, C10b, C11, C12, C15, C16) and lead attribution (C13) are built as held pull requests and
> merge only after the lawyer approves this text, or a changed version of it, and the answers to
> the questions in register item **L-2** ([review-register.md](review-register.md)). Once
> approved, the words go into `src/lib/legal/content.ts` (English and Arabic, the privacy
> notice's `updated` date moved) in the same PR as the code they describe.

## What changes in the product, in plain words

- **Contacts.** When someone sends an inquiry, the site now also keeps a contact record for
  that person: their name, company and language from the inquiry, and their e-mail address and
  phone number (encrypted, as the inquiry's are). Later inquiries from the same e-mail address
  join the same record. An inquiry that shares only a phone number with an existing record is
  joined to it and marked for a person to check, because a phone line can be shared. Staff can
  add a title, city, country, tags, an owner on the team, notes and (from C8) follow-up tasks.
  Only the account administrator can see contacts today (Sales users later, C10b).
- **Notes and tasks.** Staff notes about an inquiry or a person, and follow-up tasks (calls,
  e-mails, meetings) with due dates.
- **Retention from last activity.** A contact record is deleted automatically when nothing has
  happened with that person for the inquiry retention period (24 months today, the same
  setting as inquiries). "Something happened" means: a new inquiry from them, a stage change,
  a logged call or message, a note, or (from C8) a task completed. Editing details or starring a
  record does not count. A contact made automatically from an inquiry goes once its last inquiry
  is gone, unless a person has worked on it. This can keep a person's details longer than today,
  where each inquiry is deleted 24 months after it arrived (question L-2.3).
- **Attribution (C13 only, not live until C13 merges).** With each inquiry the site records the
  page the form was sent from (never with its query string). Only if the visitor accepted
  analytics cookies, it also records the website that sent them (the site's name only, not the
  full address), campaign tags in the link (source, medium, campaign), the type of device
  (mobile, tablet or desktop) and the country. Never the IP address, never a full address,
  never anything that links the inquiry to an analytics visit.
- **Erasure and backups.** An administrator can erase a person: every inquiry linked to them or
  sent from their e-mail address, the notes and tasks on those, the contact record and its
  history. Inquiries that only share their phone number are erased only when the administrator
  ticks them. Erased data stays in the database's backup copies until those copies are
  replaced, at most 28 days later (question L-2.5).
- **Answering requests.** Requests to see, correct or erase personal data are answered within
  30 days (question L-2.6).

## The English text

Changes to the existing privacy notice (`src/lib/legal/content.ts`, `en.privacy`). Text in
**bold** is new; a line marked "replaces" stands in for the current line quoted.

**Data we collect** (add after "Optional project details: ..."):

> **When you send an inquiry, we also keep a contact record for you: your name, company and
> language from the inquiry, and your e-mail address and phone number, stored encrypted. Later
> inquiries from the same e-mail address are kept together with it. Our team may add notes, a
> job title, your city and country, labels, the team member looking after you, and follow-up
> tasks.**

> **With each inquiry we record the page of our site the form was sent from. Only if you accept
> analytics cookies do we also record the name of the website that sent you to us, the
> campaign tags in the link you followed (source, medium, campaign), your type of device
> (mobile, tablet or desktop) and your country. We never record your IP address, the full
> address of the page that sent you, or anything that connects your inquiry to your visits.**
> *(This paragraph is published only when lead attribution, C13, goes live.)*

**Lawful basis and purpose** (add):

> **We keep the contact record and our notes and tasks to answer your inquiry, to follow it up,
> and to remember earlier conversations if you contact us again.** *(The lawful basis for this
> is question L-2.1.)*

**Retention** (replaces "Leads are retained for up to 24 months; submissions identified as spam
are deleted within 30 days."):

> **Each inquiry is deleted 24 months after it arrived; inquiries identified as spam are
> deleted within 30 days of being marked. Your contact record, with its notes and tasks, is
> deleted when there has been no activity with you for 24 months: no new inquiry, no change in
> where your inquiry stands with us, no call, message or meeting we logged, and no note or task.
> A contact record we made automatically from an inquiry is deleted when its last inquiry is,
> unless our team has added notes or details to it.**

**Your rights** (add after "You may request access, correction, or deletion of your data, and
withdraw consent at any time."):

> **We answer your request within 30 days. If you ask us to delete your data, we delete your
> inquiries, our notes and tasks about you, and your contact record. If another inquiry shares
> only your phone number, we check whether it is yours before deleting it, because a phone
> line can be shared.**

**Security and sharing** (add):

> **Only the members of our team whose role needs it can see inquiries and contact records,
> and each time someone looks at your contact details it is logged. Your e-mail address and
> phone number are stored encrypted. Our database keeps backup copies for recovery; data we
> delete stays in those copies until they are replaced, at most 28 days later.**

## The Arabic text

Changes to `ar.privacy`. The same places as the English.

**البيانات التي نجمعها** (تُضاف بعد «تفاصيل المشروع الاختيارية: ...»):

> **عندما ترسل استفسارًا، نحتفظ أيضًا بسجلّ تواصل خاص بك: اسمك وشركتك واللغة التي كتبت بها
> من الاستفسار، وبريدك الإلكتروني ورقم جوالك مخزّنَين بشكل مشفّر. وتُحفظ الاستفسارات اللاحقة
> المرسلة من البريد الإلكتروني نفسه مع هذا السجلّ. وقد يضيف فريقنا ملاحظات، ومسمّاك الوظيفي،
> ومدينتك ودولتك، وتصنيفات، وعضو الفريق المسؤول عن متابعتك، ومهام متابعة.**

> **مع كل استفسار نسجّل صفحة موقعنا التي أُرسل منها النموذج. وفقط إذا وافقت على ملفات تعريف
> الارتباط الخاصة بالتحليلات، نسجّل أيضًا اسم الموقع الذي أحالك إلينا، ووسوم الحملة في الرابط
> الذي اتبعته (المصدر والوسيلة والحملة)، ونوع جهازك (جوال أو جهاز لوحي أو حاسوب)، ودولتك. ولا
> نسجّل أبدًا عنوان IP الخاص بك، ولا العنوان الكامل للصفحة التي أحالتك، ولا أي شيء يربط
> استفسارك بزياراتك للموقع.** *(تُنشر هذه الفقرة فقط عند تفعيل تسجيل مصدر الاستفسار، C13.)*

**الأساس القانوني والغرض** (تُضاف):

> **نحتفظ بسجلّ التواصل وبملاحظاتنا ومهامنا للرد على استفسارك ومتابعته، ولنتذكّر محادثاتنا
> السابقة إذا تواصلت معنا مرة أخرى.** *(الأساس النظامي لذلك هو السؤال L-2.1.)*

**مدة الاحتفاظ** (تحلّ محل «يُحتفظ بالعملاء المحتملين حتى 24 شهرًا؛ وتُحذف الرسائل المصنّفة
كرسائل مزعجة خلال 30 يومًا.»):

> **يُحذف كل استفسار بعد 24 شهرًا من وصوله، وتُحذف الاستفسارات المصنّفة كرسائل مزعجة خلال 30
> يومًا من تصنيفها. ويُحذف سجلّ التواصل الخاص بك، مع ملاحظاته ومهامه، إذا مضى 24 شهرًا دون أي
> نشاط معك: لا استفسار جديد، ولا تغيير في مرحلة استفسارك لدينا، ولا مكالمة أو رسالة أو اجتماع
> سجّلناه، ولا ملاحظة أو مهمة. وأي سجلّ تواصل أنشأناه تلقائيًا من استفسار يُحذف عند حذف آخر
> استفسار مرتبط به، ما لم يُضِف فريقنا إليه ملاحظات أو تفاصيل.**

**حقوقك** (تُضاف بعد «يمكنك طلب الوصول إلى بياناتك أو تصحيحها أو حذفها، وسحب موافقتك في أي
وقت.»):

> **نرد على طلبك خلال 30 يومًا. وإذا طلبت حذف بياناتك، نحذف استفساراتك وملاحظاتنا ومهامنا
> المتعلقة بك وسجلّ التواصل الخاص بك. وإذا كان هناك استفسار آخر يشترك معك في رقم الجوال فقط،
> نتحقق مما إذا كان يخصّك قبل حذفه، لأن رقم الهاتف قد يكون مشتركًا.**

**الأمان والمشاركة** (تُضاف):

> **لا يطّلع على الاستفسارات وسجلات التواصل إلا أعضاء فريقنا الذين يحتاج دورهم إلى ذلك، ويُسجَّل
> كل اطّلاع على بيانات التواصل الخاصة بك. ويُخزَّن بريدك الإلكتروني ورقم جوالك بشكل مشفّر.
> وتحتفظ قاعدة بياناتنا بنسخ احتياطية للاستعادة؛ وتبقى البيانات التي نحذفها في هذه النسخ إلى
> أن تُستبدل، خلال 28 يومًا على الأكثر.**

## Before the words go live (engineering checks, not legal ones)

- The production database's backup retention (Supabase's own backups today; PITR and the
  off-platform dump are not set up yet, launch runbook §9) is at most the number the notice
  states. If it is longer, the number changes, not the backups.
- `site_settings.retention.leads_months` holds the number the notice states (24 today). The
  contacts' horizon reads the same setting, so a change to one is a change to both, and to this
  text.
- The privacy notice's `updated` date moves in both languages, and the recruitment notice
  version too if the shared sections change (`packages/consent/recruitment.ts`).
- The attribution paragraph is published only with C13.
