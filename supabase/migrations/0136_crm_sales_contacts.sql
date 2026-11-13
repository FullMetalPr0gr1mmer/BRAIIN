-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0136 — the Sales role gains contacts and tasks (Admin v2 C10b, crm.md §2.1, §10 and
-- CRM-10). Forward-only, EXPAND only. HELD: the PR merges only after the owner's lawyer signs
-- off the privacy-notice update (owner item O-11, register L-2 to L-4) and after C5, C6, C7,
-- C8 and their integration. The number is a placeholder: the merge train assigns it
-- (scripts/renumber-migration.mjs). Depends on 0033 (app.live_role), 0096/0097 (C10a: the
-- 'sales' enum value, app.is_member), 0069 (H11: app.put_help_guide), 0105 (U11: the Sales
-- guide as it stands), 0129 (H16: the roles guide as it stands) and the contacts chain: C5's
-- app.role_crm_contacts, C6's app.crm_retention_months, C8's app.role_crm_tasks.
--
-- WHAT IT CHANGES
--   1. The two capability helpers answer Admin and Sales (CLAUDE.md §5, ROLE_CAPS;
--      tests/authz/sqlHelpers.spec.ts holds each equal to the holders of its capability):
--      app.role_crm_contacts (crm.contacts) and app.role_crm_tasks (crm.tasks). Every
--      policy, RESTRICTIVE live check, service-role door, owner rule and reader C5, C6 and C8
--      wrote calls one of them, so nothing else is restated: a live Sales token reads and
--      writes the contacts (through C5's column grants: never a channel's ciphertext or
--      blind index, never a note, which only the audited doors read) and the tasks, and a
--      demoted, switched-off or locked one nothing. crm.erase (app.crm_eraser_ok) and
--      crm.settings stay Admin's; Developer still holds no crm.* (owner default O-7).
--   2. public.crm_contact_retention_months(): how long a contact is kept after its last
--      activity, for the contact page's "kept until" line. SECURITY INVOKER, over C6's
--      definer app.crm_retention_months() (the caller's own tenant only), answering for a
--      live crm.contacts holder alone (null otherwise). The page read site_settings.retention
--      as the caller, and site_settings is CMS staff's (app.is_staff()), which Sales is not.
--   3. The help guides (H11's catalog): the-sales-role (revision 2) and roles-and-access
--      (revision 5, as 0129 left it) say that Sales also works the contacts and the tasks,
--      reveals one person at a time (a confirmed phone match counts as a reveal) and erases
--      nothing. Each put re-seeds that one slug into every tenant and touches no other guide.
--   4. (C10b review, C10B-SEC-1) app.crm_link_lead_core (C5) restated: an arrival linked by
--      its e-mail adds its phone to the contact only below app.crm_channel_cap() (ten), as
--      every other door that adds a channel does, so one reveal shows at most ten e-mails and
--      ten phones. Before, each arrival with another number added one, without a ceiling.
--   5. (C10b review, C10B-SEC-2) public.crm_edit_contact_channels (C6) restated: removing an
--      e-mail or phone needs an actor who may erase (crm.erase, Admin); a crm.contacts holder
--      alone (Sales) adds and makes primary. Nothing else in either function changes.
--
-- Production behaviour: none until C10b's Worker deploys and someone holds the Sales role.
-- Rule 5 (the deployed Worker between the push and the deploy): the deployed Worker's
-- ROLE_CAPS still refuses Sales every contacts and tasks route and page (assertCap), so the
-- widened helpers are reachable only through PostgREST directly, where a live Sales token now
-- reads and writes what the Worker will offer it; the new function has no deployed caller.
-- Items 4 and 5 take effect at once for every caller of the two doors: a contact already at
-- ten phones takes no more from an arrival (its lead keeps the phone), and an Admin, the only
-- deployed actor of the channel editor, still removes. Neither table is in production before
-- the contacts chain (C5, C6) is, and this migration merges after it.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- ═══ 1. The capability helpers ═════════════════════════════════════════════════════════════
-- The form every app.role_* helper has (immutable, inlined by the planner, no search_path).
create or replace function app.role_crm_contacts(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'sales'), false) $$;  -- crm.contacts
revoke all on function app.role_crm_contacts(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_contacts(text) to authenticated, service_role;

create or replace function app.role_crm_tasks(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'sales'), false) $$;  -- crm.tasks
revoke all on function app.role_crm_tasks(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_tasks(text) to authenticated, service_role;

-- ═══ 2. The retention horizon, for a contacts holder ════════════════════════════════════════
create or replace function public.crm_contact_retention_months() returns int
  language sql stable security invoker set search_path = ''
as $$
  select case when app.role_crm_contacts((select app.live_role()))
              then app.crm_retention_months() end
$$;
revoke all on function public.crm_contact_retention_months() from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_retention_months() to authenticated;

-- ═══ 3. The help guides ════════════════════════════════════════════════════════════════════
-- H11's app.put_help_guide (0069). the-sales-role is at revision 2 (U11's put, 0105, on C10a's):
-- its opening line, the reveal line, two new lines (Contacts, Tasks) and the erasure line,
-- in both languages, and three minutes. (Owner decisions of 2026-11-13, at the C-int
-- integration, this branch unmerged: the reveal line says the main e-mail and the main phone,
-- the Contacts line names adding a detail and merging, and a third new line says what an
-- Admin does: the other e-mails and phones, the main one, a merge of records holding files.) roles-and-access is at revision 5 (H16's put, 0129):
-- the Sales line of its list, in both languages, and nothing else.
select app.put_help_guide($guide$
{
  "slug": "the-sales-role",
  "sort_order": 65,
  "minutes": 3,
  "tags": [
    "leads",
    "team"
  ],
  "screens": [
    "/admin/leads"
  ],
  "caps": [
    "leads.manage"
  ],
  "title": "The Sales role",
  "title_ar": "دور Sales (المبيعات)",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Sales is the role for the people who follow up inquiries. A Sales account works leads, the contacts behind them and follow-up tasks, and nothing else: it opens no page, site setting, media or job application, and it cannot change anyone's role."
      },
      {
        "t": "h",
        "x": "What Sales can do"
      },
      {
        "t": "ol",
        "x": [
          "See every lead, move it through the stages, assign it, star it, tag it and give it a value, like anyone who works leads.",
          "Reveal one lead's contact details, budget and timeline at a time, or one contact's main e-mail and main phone. Each reveal is logged against the account that made it, up to 60 an hour for each person and 300 an hour for the whole team, leads and contacts together.",
          "Read and add notes, log a call or a message, and add a lead by hand. Opening a lead's notes is logged too, within a limit of the same size.",
          "Open Contacts: see the people behind the leads, add and edit them, add an e-mail or phone, add notes, merge two records of one person, and say whether a lead matched by phone number is the same person. Confirming a match or merging two records counts as a reveal, because it brings that person's contact details to the contact.",
          "Plan follow-up tasks in Tasks, for themselves or a colleague, and tick them off.",
          "Open the dashboard and the website stats.",
          "Choose what the bell shows in Settings › Notifications. That setting is the account's own, and the only one Sales opens."
        ]
      },
      {
        "t": "h",
        "x": "What Sales cannot do"
      },
      {
        "t": "ol",
        "x": [
          "Export leads to a file: the Export CSV button does not show.",
          "Erase a lead or a contact, remove a contact's e-mail or phone, delete a contact's note, or receive a new lead's contact details in a notification. Sales reveals them on the lead's or the contact's page instead, one at a time.",
          "See a contact's other e-mails and phones, choose which one is the main one, or merge two records when either of them holds files. An Admin does those.",
          "Change content, the site's settings, people or the theme, or read job applications, the logs or the activity log."
        ]
      },
      {
        "t": "tip",
        "x": "An Admin makes someone Sales in Settings › Users & roles. Give each person a display name, so the people a lead can be assigned to are easy to tell apart."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "دور Sales (المبيعات) مخصّص لمن يتابعون الاستفسارات. يعمل حساب Sales على العملاء المحتملين وجهات الاتصال التي تقف خلفهم ومهام المتابعة فقط: لا يفتح الصفحات ولا إعدادات الموقع ولا الوسائط ولا طلبات التوظيف، ولا يستطيع تغيير دور أي شخص."
      },
      {
        "t": "h",
        "x": "ما يستطيعه Sales"
      },
      {
        "t": "ol",
        "x": [
          "يرى كل العملاء المحتملين، وينقلهم عبر المراحل، ويسندهم، ويميّزهم بنجمة، ويضع لهم الوسوم والقيمة، مثل كل من يعمل على العملاء المحتملين.",
          "يكشف بيانات التواصل والميزانية والمدة الزمنية لعميل محتمل واحد في كل مرة، أو البريد الإلكتروني الرئيسي ورقم الهاتف الرئيسي لجهة اتصال واحدة. يُسجَّل كل كشف باسم الحساب الذي قام به، بحد أقصى 60 مرة في الساعة لكل شخص و300 مرة في الساعة للفريق كله، للعملاء المحتملين وجهات الاتصال معًا.",
          "يقرأ الملاحظات ويضيفها، ويسجّل مكالمة أو رسالة، ويضيف عميلًا محتملًا يدويًا. يُسجَّل فتح ملاحظات العميل المحتمل أيضًا، ضمن حد بالحجم نفسه.",
          "يفتح Contacts: يرى الأشخاص الذين يقفون خلف العملاء المحتملين، ويضيفهم ويعدّلهم، ويضيف بريدًا إلكترونيًا أو رقم هاتف، ويضيف الملاحظات، ويدمج سجلين للشخص نفسه، ويحدد ما إذا كان عميل محتمل طابق رقم هاتفه هو الشخص نفسه. يُحتسب تأكيد التطابق أو دمج سجلين كشفًا، لأنه ينقل بيانات التواصل لذلك الشخص إلى جهة الاتصال.",
          "يخطط لمهام المتابعة في Tasks، لنفسه أو لزميل، ويؤشّر عليها عند إنجازها.",
          "يفتح لوحة المعلومات وإحصاءات الموقع.",
          "يختار ما يعرضه الجرس من Settings › Notifications. هذا الإعداد خاص بحسابه، وهو الإعداد الوحيد الذي يفتحه Sales."
        ]
      },
      {
        "t": "h",
        "x": "ما لا يستطيعه Sales"
      },
      {
        "t": "ol",
        "x": [
          "تصدير العملاء المحتملين إلى ملف: لا يظهر له زر Export CSV.",
          "محو عميل محتمل أو جهة اتصال، أو إزالة بريد إلكتروني أو رقم هاتف من جهة اتصال، أو حذف ملاحظة جهة اتصال، أو تلقّي بيانات التواصل لعميل محتمل جديد في إشعار. يكشفها Sales في صفحة العميل المحتمل أو جهة الاتصال بدلًا من ذلك، واحدًا في كل مرة.",
          "رؤية عناوين البريد الإلكتروني وأرقام الهاتف الأخرى لجهة اتصال، أو اختيار أيٍّ منها هو الرئيسي، أو دمج سجلين إذا كانت لدى أيٍّ منهما ملفات. يتولى المسؤول (Admin) ذلك.",
          "تغيير المحتوى أو إعدادات الموقع أو الأشخاص أو المظهر، أو قراءة طلبات التوظيف أو السجلات أو سجل النشاط."
        ]
      },
      {
        "t": "tip",
        "x": "يجعل المسؤول (Admin) شخصًا ما Sales من Settings › Users & roles. امنح كل شخص اسمًا ظاهرًا، ليسهل التمييز بين من يمكن إسناد العميل المحتمل إليهم."
      }
    ]
  }
}
$guide$::jsonb, 2);

select app.put_help_guide($guide$
{
  "slug": "roles-and-access",
  "sort_order": 30,
  "minutes": 5,
  "tags": [
    "account",
    "team"
  ],
  "screens": [
    "/admin/account",
    "/admin/users"
  ],
  "caps": [],
  "title": "Roles: who can do what",
  "title_ar": "الأدوار: من يستطيع فعل ماذا",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "There are five roles. Each sees only the screens it can use, and the server checks the role again on every save, so a hidden button is never the only lock."
      },
      {
        "t": "ol",
        "x": [
          "Admin: everything, including people and their roles, archiving and deleting, and job applications.",
          "Content Creator: writes and publishes the site's content (services, projects, posts, pages, testimonials and the rest) and manages media. No settings and no leads.",
          "SEO: SEO defaults, redirects, integrations, and the website and search stats. It can open pages, services, projects and posts without changing their content.",
          "Developer: general settings, maintenance, the site's theme (its colours and motion), media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications.",
          "Sales: works leads, the contacts behind them and follow-up tasks, reveals one person's contact details at a time, and reads the dashboard and the website stats. No content, settings, exports, erasing, job applications, logs or people."
        ]
      },
      {
        "t": "h",
        "x": "Changing someone's role"
      },
      {
        "t": "p",
        "x": "Only an Admin can, in Settings › Users & roles: open the person, choose the role or switch off Can sign in, and save. That ends every sign-in the person has, on every device: the admin turns them away at their next click, and they sign in again to get the new role. You cannot change your own role or switch yourself off."
      },
      {
        "t": "p",
        "x": "One limit to know: a sign-in pass already handed out keeps working for up to an hour when someone uses it directly against the database, outside the admin. It can no longer change anything with the role it was issued with: every save checks the person's account first. Until it runs out it can still read what that role could read in settings, media, the system logs and content. People and their roles, the security settings, leads, job applications and the activity log check the person's account on every request, reading included, so those close at once."
      },
      {
        "t": "h",
        "x": "The account owner"
      },
      {
        "t": "p",
        "x": "One Admin is the account owner, marked by whoever runs the database. The owner always keeps the Admin role: nobody can change it, switch the owner off or remove them. To hand ownership on, the owner opens another active Admin and chooses Make account owner."
      },
      {
        "t": "h",
        "x": "Security settings"
      },
      {
        "t": "p",
        "x": "The Security card on Users & roles sets the session length, 1 day or 7 days: someone who signed in longer ago than that is asked to sign in again at their next click. It also sets the allowed email domain: when it is filled in, invites go only to addresses at that domain."
      },
      {
        "t": "p",
        "x": "Require 2FA for everyone, on the same card, asks everyone who has not set up two factor authentication to set it up at their next click, before they can do anything else in the admin. Turn on 2FA for your own account first: until you have, the card does not save the switch."
      },
      {
        "t": "h",
        "x": "Resetting someone's 2FA"
      },
      {
        "t": "p",
        "x": "If someone loses their phone, an Admin opens the person in Users & roles and chooses Reset 2FA. Their authenticator app stops working here and they are signed out on every device; the reset is recorded in the activity log. You cannot reset your own 2FA there (turn it off from your account), nor the account owner's, which only whoever runs the database can reset."
      },
      {
        "t": "tip",
        "x": "Roles are fixed: there are no exceptions for one person. If someone needs more, they need a different role."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "هناك خمسة أدوار. يرى كل دور الشاشات التي يستطيع استخدامها فقط، ويتحقق الخادم من الدور مرة أخرى عند كل حفظ، فلا يكون إخفاء الزر هو القفل الوحيد أبدًا."
      },
      {
        "t": "ol",
        "x": [
          "Admin (مسؤول): كل شيء، بما في ذلك الأشخاص وأدوارهم، والأرشفة والحذف، وطلبات التوظيف.",
          "Content Creator (صانع محتوى): يكتب محتوى الموقع وينشره (الخدمات والمشاريع والمقالات والصفحات والتوصيات وغيرها) ويدير الوسائط. لا إعدادات ولا عملاء محتملين.",
          "SEO (تحسين محركات البحث): إعدادات SEO الافتراضية، وإعادة التوجيه، والتكاملات، وإحصاءات الموقع والبحث. يستطيع فتح الصفحات والخدمات والمشاريع والمقالات دون تغيير محتواها.",
          "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، ومظهر الموقع (ألوانه وحركته)، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف.",
          "Sales (المبيعات): يعمل على العملاء المحتملين وجهات الاتصال التي تقف خلفهم ومهام المتابعة، ويكشف بيانات التواصل لشخص واحد في كل مرة، ويقرأ لوحة المعلومات وإحصاءات الموقع. لا محتوى ولا إعدادات ولا تصدير ولا محو ولا طلبات توظيف ولا سجلات ولا أشخاص."
        ]
      },
      {
        "t": "h",
        "x": "تغيير دور شخص ما"
      },
      {
        "t": "p",
        "x": "يستطيع ذلك المسؤول (Admin) فقط، من Settings › Users & roles: افتح حساب الشخص، واختر الدور أو أوقف Can sign in، ثم احفظ. يُنهي ذلك كل جلسات دخول الشخص على كل أجهزته: ترفضه لوحة الإدارة عند نقرته التالية، ثم يسجّل دخوله من جديد ليحصل على الدور الجديد. لا يمكنك تغيير دورك بنفسك ولا إيقاف حسابك."
      },
      {
        "t": "p",
        "x": "وهناك حدّ ينبغي معرفته: تصريح الدخول الذي صدر بالفعل يبقى صالحًا حتى ساعة إذا استُخدم مباشرة على قاعدة البيانات، خارج لوحة الإدارة. لكنه لم يعد يستطيع تغيير أي شيء بالدور الذي صدر به: فكل حفظ يتحقق من حساب الشخص أولًا. وإلى أن ينتهي يبقى قادرًا على قراءة ما كان ذلك الدور يقرؤه في الإعدادات والوسائط وسجلات النظام والمحتوى. أما الأشخاص وأدوارهم، وإعدادات الأمان، والعملاء المحتملون، وطلبات التوظيف، وسجل النشاط فتتحقق من حساب الشخص عند كل طلب، بما في ذلك القراءة، فيُغلق الوصول إليها فورًا."
      },
      {
        "t": "h",
        "x": "مالك الحساب"
      },
      {
        "t": "p",
        "x": "أحد المسؤولين هو مالك الحساب، ويحدّده من يدير قاعدة البيانات. يحتفظ المالك بدور Admin دائمًا: لا يستطيع أحد تغييره أو إيقاف حساب المالك أو حذفه. ولنقل الملكية، يفتح المالك حساب مسؤول آخر نشط ويختار Make account owner."
      },
      {
        "t": "h",
        "x": "إعدادات الأمان"
      },
      {
        "t": "p",
        "x": "تحدّد بطاقة Security في Users & roles مدة الجلسة، يومًا واحدًا أو 7 أيام: من سجّل دخوله قبل أكثر من ذلك يُطلب منه تسجيل الدخول من جديد عند نقرته التالية. وتحدّد أيضًا نطاق البريد الإلكتروني المسموح به: إذا مُلئ، لا تُرسل الدعوات إلا إلى عناوين ذلك النطاق."
      },
      {
        "t": "p",
        "x": "ويطلب الخيار Require 2FA for everyone، في البطاقة نفسها، من كل من لم يُعدّ التحقق بخطوتين أن يُعدّه عند نقرته التالية، قبل أن يستطيع فعل أي شيء آخر في لوحة الإدارة. شغّل 2FA لحسابك أنت أولًا: لا تحفظ البطاقة هذا الخيار قبل ذلك."
      },
      {
        "t": "h",
        "x": "إعادة ضبط 2FA لشخص ما"
      },
      {
        "t": "p",
        "x": "إذا فقد شخص هاتفه، يفتح المسؤول (Admin) حسابه في Users & roles ويختار Reset 2FA. يتوقف تطبيق المصادقة لديه عن العمل هنا ويُسجَّل خروجه من كل أجهزته، وتُسجَّل إعادة الضبط في سجل النشاط. لا يمكنك إعادة ضبط 2FA الخاص بك من هناك (أوقفه من حسابك)، ولا الخاص بمالك الحساب، فذلك لا يفعله إلا من يدير قاعدة البيانات."
      },
      {
        "t": "tip",
        "x": "الأدوار ثابتة، ولا استثناءات لشخص بعينه. من يحتاج إلى صلاحيات أكثر يحتاج إلى دور مختلف."
      }
    ]
  }
}
$guide$::jsonb, 5);

-- ═══ 4. The arrival's phone, within the ceiling (C10b review, C10B-SEC-1) ════════════════════
-- C5's app.crm_link_lead_core, restated with ONE change, in step 4: a lead linked by its
-- e-mail (or making a new contact) adds its phone to the contact only while the contact keeps
-- fewer than app.crm_channel_cap() phones (C6's ceiling, ten). Before, every arrival from one
-- address with another number added one more phone, with no ceiling, and the contact's reveal
-- decrypts every channel for one slot: one Sales reveal could show any number of phones. Now
-- every door that adds a channel keeps to the ceiling (the add, the editor, the staff link
-- and this), so one reveal shows at most ten e-mails and ten phones. A phone left out stays on
-- its lead (revealing that lead shows it). Everything else as 0131 wrote it, the function's
-- settings (an empty search_path, lock_timeout 2s) and its grants included.
create or replace function app.crm_link_lead_core(p_tenant uuid, p_lead uuid) returns text
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  l record;
  v_contact uuid;
  v_by text;
  v_n int;
begin
  select x.id, x.name, x.company, x.locale, x.source, x.email_enc, x.phone_enc, x.email_hmac,
         x.phone_hmac, x.contact_id, x.contact_link, x.is_spam, x.crm_indexed_at, x.created_at
    into l
    from public.leads x
   where x.tenant_id = p_tenant and x.id = p_lead
     for update;
  if not found then
    return 'missing';
  end if;
  if l.contact_id is not null or l.contact_link is not null then
    return 'done';
  end if;
  if l.is_spam then
    return 'spam';
  end if;
  if l.crm_indexed_at is null then
    return 'unindexed';
  end if;
  if l.email_hmac is null and l.phone_hmac is null then
    return 'no_index';
  end if;

  -- 1. The e-mail. The lock serialises two arrivals from one new address (the second
  --    waits, then finds the first's contact); the unique index is the backstop below.
  if l.email_hmac is not null then
    perform pg_advisory_xact_lock(hashtextextended('crm-email:' || p_tenant::text || ':' || l.email_hmac, 0));
    select ch.contact_id into v_contact
      from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.kind = 'email' and ch.value_hmac = l.email_hmac;
    if v_contact is not null then
      v_by := 'email';
    end if;
  end if;

  -- 2. The phone: shared lines exist, so this links AND flags (contact_link 'phone'), and
  --    adds nothing to that contact; a person checks it (C6/C7).
  if v_contact is null and l.phone_hmac is not null then
    select ch.contact_id into v_contact
      from public.crm_contact_channels ch
      join public.crm_contacts k on k.tenant_id = ch.tenant_id and k.id = ch.contact_id
     where ch.tenant_id = p_tenant and ch.kind = 'phone' and ch.value_hmac = l.phone_hmac
       and k.merged_into is null
     order by k.last_activity_at desc, k.id
     limit 1;
    if v_contact is not null then
      v_by := 'phone';
    end if;
  end if;

  -- 3. A new contact, from what the lead says about itself. Its activity starts at the
  --    lead's arrival, not at this link (the backfill reaches old leads).
  if v_contact is null then
    insert into public.crm_contacts (tenant_id, display_name, company_name, locale, source,
                                     last_activity_at)
    values (p_tenant,
            coalesce(nullif(left(btrim(regexp_replace(coalesce(l.name, ''), '[[:cntrl:]]', ' ', 'g')), 120), ''),
                     'Unknown'),
            nullif(left(btrim(regexp_replace(coalesce(l.company, ''), '[[:cntrl:]]', ' ', 'g')), 120), ''),
            case when l.locale = 'ar' then 'ar' else 'en' end,
            case when l.source in ('manual', 'import') then l.source else 'web_form' end,
            l.created_at)
    returning id into v_contact;
    v_by := 'new';
    if l.email_hmac is not null and l.email_enc is not null then
      insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                               is_primary, source)
      values (p_tenant, v_contact, 'email', l.email_enc, l.email_hmac, true, 'lead')
      on conflict (tenant_id, value_hmac) where kind = 'email' do nothing;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        -- Another arrival holds the address after all: that contact is the person's.
        delete from public.crm_contacts c where c.tenant_id = p_tenant and c.id = v_contact;
        select ch.contact_id into v_contact
          from public.crm_contact_channels ch
         where ch.tenant_id = p_tenant and ch.kind = 'email' and ch.value_hmac = l.email_hmac;
        v_by := 'email';
      end if;
    end if;
  end if;

  -- 4. The lead's phone joins a contact it is the person's own (by e-mail, or new), unless
  --    the contact keeps as many phones as it may (app.crm_channel_cap, C10b review,
  --    C10B-SEC-1): the link stands and the phone stays on the lead alone, as the staff
  --    link's 'full' does. The contact's row is locked first, as the channel editor locks it,
  --    so two arrivals by two of its e-mails cannot both count nine.
  if v_by in ('email', 'new') and l.phone_hmac is not null and l.phone_enc is not null then
    perform 1 from public.crm_contacts c where c.tenant_id = p_tenant and c.id = v_contact for update;
  end if;
  if v_by in ('email', 'new') and l.phone_hmac is not null and l.phone_enc is not null
     and (select count(*) from public.crm_contact_channels ch
           where ch.tenant_id = p_tenant and ch.contact_id = v_contact and ch.kind = 'phone')
         < app.crm_channel_cap() then
    insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                             is_primary, source)
    values (p_tenant, v_contact, 'phone', l.phone_enc, l.phone_hmac,
            not exists (select 1 from public.crm_contact_channels ch
                         where ch.contact_id = v_contact and ch.kind = 'phone' and ch.is_primary),
            'lead')
    on conflict (tenant_id, contact_id, kind, value_hmac) do nothing;
  end if;

  -- 5. The link (not an edit: app.tg_lead_pipeline's c_derived). app.tg_lead_contact writes
  --    the two timeline lines and the won and owner rules. (C5 review) A phone link is not
  --    the contact's activity: it may be someone else's until a person confirms it.
  update public.leads x set contact_id = v_contact, contact_link = v_by
   where x.tenant_id = p_tenant and x.id = p_lead;
  if v_by <> 'phone' then
    perform app.crm_touch(p_tenant, v_contact, l.created_at);
  end if;
  return v_by;
end $$;
revoke all on function app.crm_link_lead_core(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_link_lead_core(uuid, uuid) to service_role;

-- ═══ 5. Removing an e-mail or phone is erasure's (C10b review, C10B-SEC-2) ═══════════════════
-- C6's public.crm_edit_contact_channels, restated with ONE change: a change that removes a
-- channel needs an actor who may erase (app.crm_eraser_ok: crm.erase, a live Admin of the
-- tenant), or it is a 42501 and nothing is written. A channel a person typed in has no copy
-- on any lead, so removing it deletes that detail for good; C10b gave Sales crm.contacts, and
-- the editor's removal would have been a Sales deletion with no limit and a queued audit row.
-- Sales still adds and makes primary. Everything else as 0133 wrote it, grants included.
create or replace function public.crm_edit_contact_channels(
  p_tenant uuid, p_contact uuid, p_version int, p_add jsonb, p_remove uuid[], p_primary uuid[],
  p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_add jsonb := coalesce(p_add, '[]'::jsonb);
  v_remove uuid[] := coalesce(p_remove, '{}');
  v_primary uuid[] := coalesce(p_primary, '{}');
  v_version int;
  v_holder uuid;
  v_removed int := 0;
  v_added int := 0;
  r record;
  v_id uuid;
begin
  if p_tenant is null or p_contact is null or p_version is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a tenant, a contact, a version and an actor are required';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, false) then
    raise exception using errcode = '42501', message = 'crm_edit_contact_channels: this person may not edit contacts';
  end if;
  if not app.crm_channels_ok(v_add) or cardinality(v_remove) > 10 or cardinality(v_primary) > 2
     or array_position(v_remove, null) is not null or array_position(v_primary, null) is not null then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a change has the wrong shape';
  end if;
  -- (C10b review, C10B-SEC-2) Removing an e-mail or phone deletes a person's details, and one
  -- a person typed in has no copy anywhere else: erasure's (crm.erase, Admin), never a
  -- crm.contacts holder's alone. Sales adds and makes primary; an Admin removes.
  if cardinality(v_remove) > 0 and not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_edit_contact_channels: this person may not remove an e-mail or phone';
  end if;
  select c.version into v_version
    from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_edit_contact_channels: no such contact';
  end if;
  if v_version <> p_version then
    raise exception using errcode = '40001', message = 'crm_edit_contact_channels: the contact changed since it was read';
  end if;
  if exists (select 1 from unnest(v_remove || v_primary) x
              where not exists (select 1 from public.crm_contact_channels ch
                                 where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.id = x)) then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a channel is not this contact''s';
  end if;
  if exists (select 1 from unnest(v_primary) x where x = any (v_remove)) then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a removed channel cannot be made primary';
  end if;
  v_holder := app.crm_email_holder(p_tenant, v_add, p_contact);
  if v_holder is not null then
    return jsonb_build_object('duplicate', v_holder);
  end if;

  for r in delete from public.crm_contact_channels ch
            where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.id = any (v_remove)
            returning ch.kind, ch.source loop
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (p_tenant, p_contact, p_actor, 'channel_removed',
            jsonb_build_object('kind', r.kind, 'source', r.source));
    v_removed := v_removed + 1;
  end loop;

  insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                           is_primary, source, created_by)
  select p_tenant, p_contact, e ->> 'kind', e ->> 'value_enc', e ->> 'value_hmac', false, 'manual', p_actor
    from jsonb_array_elements(v_add) e
  on conflict do nothing;
  get diagnostics v_added = row_count;
  -- At most app.crm_channel_cap() of a kind this change adds to (C6 review, C6-SEC-3); the
  -- whole change is refused, nothing half-saved. The message names the rule for the Worker's
  -- map (src/lib/crm/contacts.ts CONTACT_CONSTRAINTS), as the owner rule's does.
  if exists (select 1 from (select distinct e ->> 'kind' as kind from jsonb_array_elements(v_add) e) k
              where (select count(*) from public.crm_contact_channels ch
                      where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = k.kind)
                    > app.crm_channel_cap()) then
    raise exception using errcode = '23514',
      message = 'a contact keeps at most ten e-mails and ten phones (constraint "crm_contact_channels_cap")';
  end if;

  -- Primary: the one named, per kind; a newly added channel marked primary too.
  foreach v_id in array v_primary || array(
      select ch.id from public.crm_contact_channels ch
        join jsonb_array_elements(v_add) e
          on e ->> 'kind' = ch.kind and e ->> 'value_hmac' = ch.value_hmac
       where ch.tenant_id = p_tenant and ch.contact_id = p_contact
         and coalesce((e ->> 'is_primary')::boolean, false)) loop
    update public.crm_contact_channels ch set is_primary = false
     where ch.contact_id = p_contact and ch.is_primary and ch.id <> v_id
       and ch.kind = (select x.kind from public.crm_contact_channels x where x.id = v_id);
    update public.crm_contact_channels ch set is_primary = true where ch.id = v_id;
  end loop;
  perform app.crm_fill_primary(p_tenant, p_contact);
  return jsonb_build_object('added', v_added, 'removed', v_removed);
end $$;
revoke all on function public.crm_edit_contact_channels(uuid, uuid, int, jsonb, uuid[], uuid[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_edit_contact_channels(uuid, uuid, int, jsonb, uuid[], uuid[], uuid)
  to service_role;

-- ═══ Postconditions ════════════════════════════════════════════════════════════════════════
do $$
declare
  v_role text;
  v_fn text;
  v_bad text;
begin
  -- 1. Each helper answers Admin and Sales, and no other value of the enum (nor null).
  foreach v_role in array (select array_agg(e::text) from unnest(enum_range(null::public.app_role)) e) loop
    if app.role_crm_contacts(v_role) is distinct from (v_role in ('admin', 'sales'))
       or app.role_crm_tasks(v_role) is distinct from (v_role in ('admin', 'sales')) then
      raise exception 'C10b: the contacts or tasks helper answers % wrongly', v_role;
    end if;
  end loop;
  if app.role_crm_contacts(null) or app.role_crm_tasks(null) then
    raise exception 'C10b: a helper answers a missing role';
  end if;
  -- What Sales does not gain: erasure, the CRM settings and the stats goals stay as they were,
  -- and Developer still holds no crm.* (O-7).
  if app.role_crm_erase('sales') or app.role_crm_settings('sales') or app.role_analytics_goals('sales')
     or app.role_crm_contacts('developer') or app.role_crm_tasks('developer')
     or app.role_crm_erase('developer') or app.role_crm_settings('developer') then
    raise exception 'C10b: Sales or Developer holds more than §5 gives it';
  end if;
  -- The invariants (crm.md §2.1): crm.tasks ⇒ crm.contacts ⇒ leads.manage ∧ leads.pii.
  foreach v_role in array (select array_agg(e::text) from unnest(enum_range(null::public.app_role)) e) loop
    if (app.role_crm_tasks(v_role) and not app.role_crm_contacts(v_role))
       or (app.role_crm_contacts(v_role)
           and not (app.role_works_leads(v_role) and app.role_lead_pii(v_role))) then
      raise exception 'C10b: % breaks crm.tasks => crm.contacts => leads.manage and leads.pii', v_role;
    end if;
  end loop;

  -- 2. The helpers' EXECUTE: authenticated and the service role, never anon or PUBLIC.
  foreach v_fn in array array['app.role_crm_contacts(text)', 'app.role_crm_tasks(text)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C10b: % must be executable by authenticated and the service role only', v_fn;
    end if;
  end loop;

  -- 3. The retention door: INVOKER, an empty search_path, authenticated alone.
  if not exists (select 1 from pg_proc
                  where oid = 'public.crm_contact_retention_months()'::regprocedure
                    and not prosecdef and proconfig = array['search_path=""']) then
    raise exception 'C10b: crm_contact_retention_months must be INVOKER with an empty search_path';
  end if;
  if not has_function_privilege('authenticated', 'public.crm_contact_retention_months()', 'execute')
     or has_function_privilege('anon', 'public.crm_contact_retention_months()', 'execute')
     or has_function_privilege('service_role', 'public.crm_contact_retention_months()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = 'public.crm_contact_retention_months()'::regprocedure and a.grantee = 0) then
    raise exception 'C10b: crm_contact_retention_months must be executable by authenticated alone';
  end if;

  -- 4. The guides: the catalog holds the new revisions, and every tenant's copy holds them.
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'the-sales-role' and revision = 3
                    and body::text like '%Plan follow-up tasks in Tasks%'
                    and body::text like '%يخطط لمهام المتابعة في Tasks%') then
    raise exception 'C10b: the-sales-role must be at revision 3 with the contacts and tasks lines';
  end if;
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'roles-and-access' and revision = 6
                    and body::text like '%Sales: works leads, the contacts behind them and follow-up tasks%'
                    and body::text like '%وجهات الاتصال التي تقف خلفهم ومهام المتابعة%') then
    raise exception 'C10b: roles-and-access must be at revision 6 with the new Sales line';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'the-sales-role'
                        and h.body::text like '%Plan follow-up tasks in Tasks%')
      or not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'roles-and-access'
                        and h.body::text like '%the contacts behind them and follow-up tasks%');
  if v_bad is not null then
    raise exception 'C10b: tenants without the new Sales guides: %', v_bad;
  end if;

  -- 5. The two restated doors (C10b review): the arrival's link keeps to the ceiling and stays
  --    a definer with its two settings; the channel editor asks for an eraser before a removal
  --    and stays INVOKER; both executable by the service role alone.
  if not exists (select 1 from pg_proc
                  where oid = 'app.crm_link_lead_core(uuid, uuid)'::regprocedure
                    and prosecdef and 'search_path=""' = any (proconfig)
                    and 'lock_timeout=2s' = any (proconfig)
                    and prosrc like '%app.crm_channel_cap()%') then
    raise exception 'C10b: crm_link_lead_core must be a definer with its settings, keeping to app.crm_channel_cap()';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'public.crm_edit_contact_channels(uuid, uuid, int, jsonb, uuid[], uuid[], uuid)'::regprocedure
                    and not prosecdef and prosrc like '%app.crm_eraser_ok(p_tenant, p_actor)%') then
    raise exception 'C10b: crm_edit_contact_channels must be INVOKER and ask app.crm_eraser_ok before a removal';
  end if;
  foreach v_fn in array array['app.crm_link_lead_core(uuid, uuid)',
                              'public.crm_edit_contact_channels(uuid, uuid, int, jsonb, uuid[], uuid[], uuid)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C10b: % must be executable by the service role alone', v_fn;
    end if;
  end loop;
end $$;
