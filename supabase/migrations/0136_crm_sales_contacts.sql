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
--
-- Production behaviour: none until C10b's Worker deploys and someone holds the Sales role.
-- Rule 5 (the deployed Worker between the push and the deploy): the deployed Worker's
-- ROLE_CAPS still refuses Sales every contacts and tasks route and page (assertCap), so the
-- widened helpers are reachable only through PostgREST directly, where a live Sales token now
-- reads and writes what the Worker will offer it; the new function has no deployed caller.
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
-- in both languages, and three minutes. roles-and-access is at revision 5 (H16's put, 0129):
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
          "Reveal one lead's contact details, budget and timeline at a time, or one contact's e-mails and phones. Each reveal is logged against the account that made it, up to 60 an hour for each person and 300 an hour for the whole team, leads and contacts together.",
          "Read and add notes, log a call or a message, and add a lead by hand. Opening a lead's notes is logged too, within a limit of the same size.",
          "Open Contacts: see the people behind the leads, add and edit them, add notes, and say whether a lead matched by phone number is the same person. Confirming a match counts as a reveal, because it brings that lead's contact details to the contact.",
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
          "Erase a lead or a contact, delete a contact's note, or receive a new lead's contact details in a notification. Sales reveals them on the lead's or the contact's page instead, one at a time.",
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
          "يكشف بيانات التواصل والميزانية والمدة الزمنية لعميل محتمل واحد في كل مرة، أو عناوين البريد الإلكتروني وأرقام الهاتف لجهة اتصال واحدة. يُسجَّل كل كشف باسم الحساب الذي قام به، بحد أقصى 60 مرة في الساعة لكل شخص و300 مرة في الساعة للفريق كله، للعملاء المحتملين وجهات الاتصال معًا.",
          "يقرأ الملاحظات ويضيفها، ويسجّل مكالمة أو رسالة، ويضيف عميلًا محتملًا يدويًا. يُسجَّل فتح ملاحظات العميل المحتمل أيضًا، ضمن حد بالحجم نفسه.",
          "يفتح Contacts: يرى الأشخاص الذين يقفون خلف العملاء المحتملين، ويضيفهم ويعدّلهم، ويضيف الملاحظات، ويحدد ما إذا كان عميل محتمل طابق رقم هاتفه هو الشخص نفسه. يُحتسب تأكيد التطابق كشفًا، لأنه ينقل بيانات التواصل لذلك العميل المحتمل إلى جهة الاتصال.",
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
          "محو عميل محتمل أو جهة اتصال، أو حذف ملاحظة جهة اتصال، أو تلقّي بيانات التواصل لعميل محتمل جديد في إشعار. يكشفها Sales في صفحة العميل المحتمل أو جهة الاتصال بدلًا من ذلك، واحدًا في كل مرة.",
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
end $$;
