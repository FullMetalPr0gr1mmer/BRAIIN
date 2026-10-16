-- ─────────────────────────────────────────────────────────────────────────────
-- 0054 — The activity log v2 (Admin v2 U13, AV-22+). Forward-only, expand only. Depends on
-- 0001 (profiles, app.current_role), 0002 (audit_log, audit_read, audit_insert), 0031 (the
-- chain trigger, serialized), 0033 (app.live_role), 0044 (app.staff_directory, the one
-- people directory), 0046 (the help centre), 0050 (the actor binding and audit_log's stated
-- grants, H10) and 0052 (U2: the guides as it left them).
--
-- /admin/audit becomes a server-rendered log that names people, filtered by kind, person and
-- day, with a CSV export under the export lockdown. What the database adds for it:
--
--   • app.role_views_audit(r): one helper for audit.view (CLAUDE.md §8, held equal to
--     ROLE_CAPS by tests/authz/sqlHelpers.spec.ts): Admin and Developer.
--   • audit_read (0002, the JWT layer, permissive) restated with the helper: same answer.
--   • audit_log_live_read, RESTRICTIVE FOR SELECT TO authenticated: the tenant predicate
--     first, then app.role_views_audit((select app.live_role())). The JWT layer reads the
--     role from the access token, which lives up to an hour, so a Developer demoted,
--     deactivated or locked kept reading the whole log at PostgREST until it expired (the
--     stale-token gap, H10's "left open"). app.live_role() is the profile's role read at
--     query time, null unless the profile is active, unlocked, in the token's tenant and
--     agrees with the token (0033), so such a token now reads nothing. SELECT only: a stale
--     token's audit INSERT stays allowed (no RETURNING is read, so no SELECT policy applies
--     to it; the Worker refuses stale sessions, and 0050's audit_log_actor binds the row to
--     its caller, so the attempt is chained under the account that made it). The chain
--     trigger reads its predecessor as its owner (a definer), outside these TO
--     authenticated policies, so a stale writer cannot fork the chain either.
--   • Two indexes for the filters: by person, (tenant_id, actor_id, id desc), and by day,
--     (tenant_id, created_at desc). Plain CREATE INDEX: the table is small, and the SHARE
--     lock it takes blocks audit inserts only while it builds (lock_timeout below).
--   • public.audit_people(p_tenant, p_ids): the people directory's audit door (README P-7:
--     one directory, documented doors). The log names who acted, and some of them have
--     left: app.staff_directory() lists active members only, so a log read through it
--     would lose the names of former members, the entries most worth reading. So this door
--     names any profile of the tenant among the ids asked (at most 100; 22023 above), active
--     or not, with its role and whether it is active, never an e-mail; and only to a caller
--     whose LIVE role views the log, for the tenant that is the token's. A SECURITY
--     DEFINER, because a staff token reads no other profile (profiles_self_select);
--     executable by authenticated alone.
--   • app.help_article_set() restated and seeded into every tenant again: only the
--     site-health-and-logs guide changes (the activity log's names, filters, export and
--     permanence, and that the database writes who made an entry).
--
-- Not here: the actor binding (audit_log_actor) and audit_log's grants are H10's (0050) and
-- unchanged; the postconditions re-check both.
--
-- Production as of 2026-10-16: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046,
-- 0048, 0050, 0051 and 0052. Grants are stated for both Supabase privilege regimes (README P-14).
-- CLAUDE.md §3 (Pillar 1), §5, §7, §8.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0050). The policies and the
-- indexes lock public.audit_log, which every audited action writes; the reseed writes
-- public.help_articles. A statement below that waits more than five seconds for a lock
-- raises instead, the whole migration rolls back, and the push is retried later.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. One helper for audit.view ----------------------------------------------------------
-- `language sql immutable`, so the planner inlines it (as app.role_works_leads, 0033).
create or replace function app.role_views_audit(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- audit.view
revoke all on function app.role_views_audit(text) from public, anon, authenticated, service_role;
grant execute on function app.role_views_audit(text) to authenticated, service_role;

-- ---- 2. Reading the log: the JWT layer restated, the live layer added ------------------------
-- audit_read keeps its command, its kind and its roles (0002); only the role test is the
-- helper now. ALTER keeps the policy in place: there is no moment without it.
alter policy audit_read on public.audit_log
  using (tenant_id = app.effective_tenant_id() and app.role_views_audit(app.current_role()));

-- RESTRICTIVE: ANDed with audit_read, so it can only narrow.
drop policy if exists audit_log_live_read on public.audit_log;
create policy audit_log_live_read on public.audit_log as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_views_audit((select app.live_role())));

-- ---- 3. The filters' indexes --------------------------------------------------------------
create index if not exists audit_log_tenant_actor_idx
  on public.audit_log (tenant_id, actor_id, id desc);
create index if not exists audit_log_tenant_created_idx
  on public.audit_log (tenant_id, created_at desc);

-- ---- 4. The directory's audit door ----------------------------------------------------------
-- Names for the entries a page shows (or a file holds): the profiles of the tenant among
-- p_ids, former members included. Empty unless the caller's live role views the log and the
-- tenant named is the token's.
create or replace function public.audit_people(p_tenant uuid, p_ids uuid[])
  returns table (id uuid, display_name text, role text, is_active boolean)
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce(cardinality(p_ids), 0) > 100 then
    raise exception 'audit_people: at most 100 ids at a time' using errcode = '22023';
  end if;
  return query
    select p.id, p.display_name, p.role::text, p.is_active
      from public.profiles p
     where p.tenant_id = app.effective_tenant_id()
       and p_tenant = app.effective_tenant_id()
       and app.role_views_audit((select app.live_role()))
       and p.id = any (p_ids)
     order by p.id;
end $$;
revoke all on function public.audit_people(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.audit_people(uuid, uuid[]) to authenticated;

-- ---- 5. The guides --------------------------------------------------------------------------
-- The set as 0052 (U2) left it, with the activity log's part of the site-health-and-logs guide
-- rewritten for this screen (U2 rewrote the rest of that guide and website-stats; both kept as
-- 0052 has them). A later slice that changes a guide restates the set from this text (U16's
-- rule).
create or replace function app.help_article_set() returns jsonb
  language sql immutable set search_path = '' as $fn$
  select $help$
[
  {
    "slug": "finding-your-way",
    "sort_order": 10,
    "minutes": 2,
    "tags": [
      "basics"
    ],
    "screens": [
      "/admin",
      "/admin/search",
      "/admin/help"
    ],
    "caps": [],
    "title": "Finding your way around",
    "title_ar": "التنقل في لوحة الإدارة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The menu on the left shows only the screens your role can use. If you expect a screen and cannot find it, your role does not include it: ask an Admin."
        },
        {
          "t": "h",
          "x": "Getting around faster"
        },
        {
          "t": "ol",
          "x": [
            "Search: press Ctrl K, or ⌘K on a Mac, or click Search anything at the top. Type a few letters to jump to a screen or to find a page, service, project or post.",
            "The bell lists what arrived or changed for you lately.",
            "Your name at the bottom of the menu opens your account.",
            "View site opens the public site in a new tab, so you can check your work.",
            "The Help centre button at the top, an i in a circle, opens these guides, starting with the ones for the screen you are on."
          ]
        },
        {
          "t": "tip",
          "x": "Search never lists leads or job applications. They hold personal details, so they have their own screens, and every look at contact details is logged."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعرض القائمة على اليسار الشاشات التي يتيحها دورك فقط. إذا توقعت شاشة ولم تجدها فهي ليست ضمن صلاحيات دورك، فاطلبها من أحد المسؤولين (Admin)."
        },
        {
          "t": "h",
          "x": "للتنقل بسرعة أكبر"
        },
        {
          "t": "ol",
          "x": [
            "البحث: اضغط Ctrl K، أو ⌘K على أجهزة ماك، أو انقر على Search anything في الأعلى. اكتب بضعة أحرف للانتقال إلى شاشة أو للعثور على صفحة أو خدمة أو مشروع أو مقال.",
            "يعرض الجرس ما وصلك أو تغيّر لك مؤخرًا.",
            "يفتح اسمك أسفل القائمة صفحة حسابك.",
            "يفتح View site الموقع العام في تبويب جديد لتتحقق من عملك.",
            "يفتح زر Help centre في الأعلى، وهو حرف i داخل دائرة، هذه الأدلة، بدءًا بأدلة الشاشة التي أنت عليها."
          ]
        },
        {
          "t": "tip",
          "x": "لا يعرض البحث العملاء المحتملين ولا طلبات التوظيف أبدًا، لأنها تحتوي على بيانات شخصية، فلها شاشاتها الخاصة، وكل اطلاع على بيانات التواصل يُسجَّل."
        }
      ]
    }
  },
  {
    "slug": "your-account",
    "sort_order": 20,
    "minutes": 3,
    "tags": [
      "account",
      "basics"
    ],
    "screens": [
      "/admin/account",
      "/admin/notifications"
    ],
    "caps": [],
    "title": "Your account, password and bell",
    "title_ar": "حسابك وكلمة المرور والإشعارات",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Your account holds your display name (shown at the bottom of the menu and, to Admins, in Users & roles), your password, and a plain list of what your role can do. Open it from your name at the bottom of the menu."
        },
        {
          "t": "h",
          "x": "Changing your password"
        },
        {
          "t": "ol",
          "x": [
            "Type your current password, then the new one twice. A new password has at least 10 characters.",
            "Five wrong current passwords within 15 minutes lock your account for 15 minutes, as on the sign-in page.",
            "Once the change goes through, every other device you are signed in on is signed out. This one stays signed in."
          ]
        },
        {
          "t": "h",
          "x": "Your e-mail address"
        },
        {
          "t": "p",
          "x": "Changing it needs outgoing e-mail, which is not set up yet, so your account shows Not set up for now."
        },
        {
          "t": "h",
          "x": "The bell"
        },
        {
          "t": "ol",
          "x": [
            "It shows up to 30 items from the last 14 days: new inquiries and job applications for the roles that handle them, services and posts going live today for the roles that write them, and maintenance switched on or off for everyone.",
            "Mark all as read marks what you were shown. Anything that arrives while the list is open stays new."
          ]
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يضم حسابك اسم العرض (ويظهر أسفل القائمة، وللمسؤولين في Users & roles)، وكلمة المرور، وقائمة واضحة بما يستطيع دورك فعله. افتحه من اسمك أسفل القائمة."
        },
        {
          "t": "h",
          "x": "تغيير كلمة المرور"
        },
        {
          "t": "ol",
          "x": [
            "اكتب كلمة المرور الحالية، ثم الجديدة مرتين. يجب ألا تقل كلمة المرور الجديدة عن 10 أحرف.",
            "خمس محاولات خاطئة لكلمة المرور الحالية خلال 15 دقيقة تقفل حسابك 15 دقيقة، كما في صفحة تسجيل الدخول.",
            "بعد نجاح التغيير يُسجَّل خروجك من كل جهاز آخر كنت مسجّلًا فيه، ويبقى هذا الجهاز مسجّلًا."
          ]
        },
        {
          "t": "h",
          "x": "بريدك الإلكتروني"
        },
        {
          "t": "p",
          "x": "يحتاج تغييره إلى خدمة إرسال البريد، وهي غير مُعدّة بعد، لذلك يظهر في حسابك Not set up حاليًا."
        },
        {
          "t": "h",
          "x": "الجرس"
        },
        {
          "t": "ol",
          "x": [
            "يعرض حتى 30 عنصرًا من آخر 14 يومًا: الاستفسارات الجديدة وطلبات التوظيف للأدوار التي تتولاها، والخدمات والمقالات التي تُنشر اليوم للأدوار التي تكتبها، وتشغيل وضع الصيانة أو إيقافه للجميع.",
            "يحدّد Mark all as read ما عُرض عليك كمقروء، وما يصل أثناء فتح القائمة يبقى جديدًا."
          ]
        }
      ]
    }
  },
  {
    "slug": "roles-and-access",
    "sort_order": 30,
    "minutes": 3,
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
          "x": "There are four roles. Each sees only the screens it can use, and the server checks the role again on every save, so a hidden button is never the only lock."
        },
        {
          "t": "ol",
          "x": [
            "Admin: everything, including people and their roles, archiving and deleting, and job applications.",
            "Content Creator: writes and publishes the site's content (services, projects, posts, pages, testimonials and the rest) and manages media. No settings and no leads.",
            "SEO: SEO defaults, redirects, integrations, and the website and search stats. It can open pages, services, projects and posts without changing their content.",
            "Developer: general settings, maintenance, the theme editor (saved themes do not change the site yet), media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications."
          ]
        },
        {
          "t": "h",
          "x": "Changing someone's role"
        },
        {
          "t": "p",
          "x": "Only an Admin can, in Settings › Users & roles. The admin checks a person's role and account again on every request, so a role taken away stops working at their next click, and someone whose account is switched off is signed out at that click. A role given reaches every save once their sign-in renews, within the hour, or at once if they sign out and in again."
        },
        {
          "t": "p",
          "x": "One limit to know: a sign-in already handed out lasts up to an hour. Until it runs out, it can still reach the database directly, outside the admin, with the role it was issued with. Leads and job applications check the person's account on every read, so those close at once."
        },
        {
          "t": "tip",
          "x": "Roles are fixed: there are no exceptions for one person. If someone needs more, they need a different role."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "هناك أربعة أدوار. يرى كل دور الشاشات التي يستطيع استخدامها فقط، ويتحقق الخادم من الدور مرة أخرى عند كل حفظ، فلا يكون إخفاء الزر هو القفل الوحيد أبدًا."
        },
        {
          "t": "ol",
          "x": [
            "Admin (مسؤول): كل شيء، بما في ذلك الأشخاص وأدوارهم، والأرشفة والحذف، وطلبات التوظيف.",
            "Content Creator (صانع محتوى): يكتب محتوى الموقع وينشره (الخدمات والمشاريع والمقالات والصفحات والتوصيات وغيرها) ويدير الوسائط. لا إعدادات ولا عملاء محتملين.",
            "SEO (تحسين محركات البحث): إعدادات SEO الافتراضية، وإعادة التوجيه، والتكاملات، وإحصاءات الموقع والبحث. يستطيع فتح الصفحات والخدمات والمشاريع والمقالات دون تغيير محتواها.",
            "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، ومحرر المظهر (لا تغيّر المظاهر المحفوظة الموقع بعد)، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف."
          ]
        },
        {
          "t": "h",
          "x": "تغيير دور شخص ما"
        },
        {
          "t": "p",
          "x": "يستطيع ذلك المسؤول (Admin) فقط، من Settings › Users & roles. تتحقق لوحة الإدارة من دور الشخص وحسابه من جديد عند كل طلب، فالدور الذي يُسحب يتوقف عن العمل عند نقرته التالية، ومن أُوقف حسابه يُسجَّل خروجه عند تلك النقرة. أما الدور الجديد فيشمل كل حفظ بعد تجديد جلسة دخوله، خلال ساعة، أو فورًا إن سجّل خروجه ثم دخل من جديد."
        },
        {
          "t": "p",
          "x": "وهناك حدّ ينبغي معرفته: جلسة الدخول التي صدرت بالفعل تبقى صالحة حتى ساعة. وإلى أن تنتهي، يمكن استخدامها للوصول إلى قاعدة البيانات مباشرة، خارج لوحة الإدارة، بالدور الذي صدرت به. أما العملاء المحتملون وطلبات التوظيف فتتحقق من حساب الشخص عند كل قراءة، فيُغلق الوصول إليها فورًا."
        },
        {
          "t": "tip",
          "x": "الأدوار ثابتة، ولا استثناءات لشخص بعينه. من يحتاج إلى صلاحيات أكثر يحتاج إلى دور مختلف."
        }
      ]
    }
  },
  {
    "slug": "saving-and-publishing",
    "sort_order": 40,
    "minutes": 4,
    "tags": [
      "content"
    ],
    "screens": [
      "/admin/pages",
      "/admin/sections",
      "/admin/services",
      "/admin/disciplines",
      "/admin/service-cases",
      "/admin/portfolio",
      "/admin/sectors",
      "/admin/blog",
      "/admin/categories",
      "/admin/testimonials",
      "/admin/clients",
      "/admin/team",
      "/admin/statistics",
      "/admin/certifications",
      "/admin/navigation"
    ],
    "caps": [
      "pages.write",
      "services.write",
      "portfolio.write",
      "blog.write",
      "nav.edit",
      "categories.manage"
    ],
    "title": "Saving, publishing and scheduling",
    "title_ar": "الحفظ والنشر والجدولة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Every editor works the same way: change the fields, then press Save changes. What you save is what the site shows, so a change to something already published is live as soon as it is saved."
        },
        {
          "t": "h",
          "x": "Status"
        },
        {
          "t": "p",
          "x": "Most items have a status:"
        },
        {
          "t": "ol",
          "x": [
            "Draft: saved, not on the site.",
            "Scheduled: goes live by itself within five minutes of its Scheduled for time. Team, Statistics and Certifications have no Scheduled for field, so there Scheduled keeps an item off the site until you set it to Published.",
            "Published: on the site.",
            "Archived: off the site and kept. Only an Admin can archive or delete."
          ]
        },
        {
          "t": "h",
          "x": "If someone else saved first"
        },
        {
          "t": "p",
          "x": "When a colleague saves the same item while you are editing it, your save is stopped with a message instead of overwriting their work. Reload to see their version, then make your change again."
        },
        {
          "t": "h",
          "x": "Both languages"
        },
        {
          "t": "p",
          "x": "The site is in English and Arabic, so most text fields come in pairs. Fill both, so Arabic visitors see the same page as English ones."
        },
        {
          "t": "tip",
          "x": "An item marked Placeholder (design sample), or Design placeholder on a page section, came with the design delivery. On the live site it cannot be published or shown until you replace its content and untick the box, unless the site's owner has allowed design samples for that kind of item."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعمل جميع المحررات بالطريقة نفسها: عدّل الحقول ثم اضغط Save changes. ما تحفظه هو ما يعرضه الموقع، لذا يظهر أي تغيير على محتوى منشور فور حفظه."
        },
        {
          "t": "h",
          "x": "الحالة"
        },
        {
          "t": "p",
          "x": "لمعظم العناصر حالة:"
        },
        {
          "t": "ol",
          "x": [
            "Draft (مسودة): محفوظ، وليس على الموقع.",
            "Scheduled (مجدول): يُنشر تلقائيًا خلال خمس دقائق من وقت Scheduled for. ولا يوجد حقل Scheduled for في Team وStatistics وCertifications، لذا تُبقي حالة Scheduled العنصر هناك خارج الموقع حتى تجعله Published.",
            "Published (منشور): على الموقع.",
            "Archived (مؤرشف): أُزيل من الموقع مع الاحتفاظ به. الأرشفة والحذف للمسؤول (Admin) فقط."
          ]
        },
        {
          "t": "h",
          "x": "إذا حفظ أحد قبلك"
        },
        {
          "t": "p",
          "x": "إذا حفظ زميل العنصر نفسه أثناء تعديلك له، يتوقف حفظك برسالة بدل أن يكتب فوق عمله. أعد تحميل الصفحة لترى نسخته، ثم أعد تعديلك."
        },
        {
          "t": "h",
          "x": "اللغتان"
        },
        {
          "t": "p",
          "x": "الموقع باللغتين الإنجليزية والعربية، لذا تأتي معظم الحقول النصية في أزواج. املأ الاثنين ليرى زوار العربية الصفحة نفسها التي يراها زوار الإنجليزية."
        },
        {
          "t": "tip",
          "x": "العنصر المعلَّم بـ Placeholder (design sample)، أو بـ Design placeholder في أقسام الصفحات، جاء مع تسليم التصميم. ولا يمكن نشره أو عرضه على الموقع المباشر حتى تستبدل محتواه وتزيل العلامة، إلا إذا سمح مالك الموقع بعرض عينات التصميم لهذا النوع من العناصر."
        }
      ]
    }
  },
  {
    "slug": "media-library",
    "sort_order": 50,
    "minutes": 2,
    "tags": [
      "content",
      "media"
    ],
    "screens": [
      "/admin/media"
    ],
    "caps": [
      "media.write"
    ],
    "title": "The media library and alt text",
    "title_ar": "مكتبة الوسائط والنص البديل",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The media library lists the images, videos and files the site uses. Each keeps its alt text: the short description screen readers read aloud and search engines index."
        },
        {
          "t": "ol",
          "x": [
            "Every image needs alt text in English and Arabic. Say what the image shows in a sentence, not the file name.",
            "Folders and tags help you find things here. Visitors never see them.",
            "Only an Admin can delete an asset for good, and only once nothing on the site uses it."
          ]
        },
        {
          "t": "tip",
          "x": "Good alt text helps twice: people using a screen reader hear it, and search engines read it."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تعرض مكتبة الوسائط الصور والفيديوهات والملفات التي يستخدمها الموقع، ولكل منها نص بديل: وصف قصير تقرؤه برامج قراءة الشاشة بصوت عالٍ وتفهرسه محركات البحث."
        },
        {
          "t": "ol",
          "x": [
            "تحتاج كل صورة إلى نص بديل بالإنجليزية والعربية. صف ما تُظهره الصورة في جملة، لا اسم الملف.",
            "تساعدك المجلدات والوسوم على إيجاد الملفات هنا، ولا يراها الزوار أبدًا.",
            "حذف الملف نهائيًا للمسؤول (Admin) فقط، وفقط حين لا يستخدمه أي جزء من الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "النص البديل الجيد يفيد مرتين: يسمعه من يستخدم قارئ الشاشة، وتقرؤه محركات البحث."
        }
      ]
    }
  },
  {
    "slug": "seo-and-redirects",
    "sort_order": 60,
    "minutes": 4,
    "tags": [
      "seo"
    ],
    "screens": [
      "/admin/seo",
      "/admin/redirects"
    ],
    "caps": [
      "seo.globalDefaults",
      "redirects.manage"
    ],
    "title": "SEO defaults and redirects",
    "title_ar": "إعدادات SEO الافتراضية وإعادة التوجيه",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "SEO defaults are the titles, descriptions and link-preview image that search engines and social sites see wherever a page has none of its own. Set them once, the text in both languages."
        },
        {
          "t": "h",
          "x": "Redirects"
        },
        {
          "t": "p",
          "x": "A redirect sends visitors and search engines from an old address to a new one, so links shared before a rename keep working."
        },
        {
          "t": "ol",
          "x": [
            "From is the old path, such as /old-page. A path that still shows a page is refused: a redirect only covers addresses that would otherwise find nothing.",
            "To is where it leads: a path on this site or a full https:// address. Point at the final address, because a redirect to another redirect is refused.",
            "301 is a permanent move and 302 a temporary one. 308 is permanent too, for addresses that receive forms.",
            "A rule takes effect within a minute of saving, and a rule for an English path also covers its Arabic twin under /ar."
          ]
        },
        {
          "t": "tip",
          "x": "Browsers can remember a permanent redirect for up to a day. If you are not sure a move is final, start with 302: it can be changed or removed at once."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "إعدادات SEO الافتراضية هي العناوين والأوصاف وصورة معاينة الروابط التي تراها محركات البحث ومواقع التواصل حيثما لا تملك الصفحة ما يخصها. اضبطها مرة واحدة، والنصوص باللغتين."
        },
        {
          "t": "h",
          "x": "إعادة التوجيه"
        },
        {
          "t": "p",
          "x": "تنقل إعادة التوجيه الزوار ومحركات البحث من عنوان قديم إلى عنوان جديد، فتبقى الروابط التي تمت مشاركتها قبل تغيير الاسم صالحة."
        },
        {
          "t": "ol",
          "x": [
            "From هو المسار القديم، مثل /old-page. يُرفض المسار الذي ما زال يعرض صفحة، فإعادة التوجيه تغطي فقط العناوين التي لن تجد شيئًا بدونها.",
            "To هو الوجهة: مسار في هذا الموقع أو عنوان كامل يبدأ بـ https://. وجّهها إلى العنوان النهائي، لأن إعادة التوجيه إلى إعادة توجيه أخرى تُرفض.",
            "301 نقل دائم و302 نقل مؤقت، و308 نقل دائم أيضًا للعناوين التي تستقبل النماذج.",
            "تسري القاعدة خلال دقيقة من الحفظ، والقاعدة الخاصة بمسار إنجليزي تشمل نظيره العربي تحت /ar."
          ]
        },
        {
          "t": "tip",
          "x": "قد تتذكر المتصفحات إعادة التوجيه الدائمة حتى يوم كامل. إن لم تكن متأكدًا من أن النقل نهائي فابدأ بـ 302، إذ يمكن تغييرها أو حذفها فورًا."
        }
      ]
    }
  },
  {
    "slug": "working-with-leads",
    "sort_order": 70,
    "minutes": 3,
    "tags": [
      "leads"
    ],
    "screens": [
      "/admin/leads"
    ],
    "caps": [
      "leads.manage"
    ],
    "title": "Working with leads",
    "title_ar": "التعامل مع العملاء المحتملين",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Every inquiry sent through the site's contact forms arrives here as a lead. The list shows when it came in, the person's name and what they asked about. Contact details stay hidden until you ask for them."
        },
        {
          "t": "ol",
          "x": [
            "Set each lead's status as you work on it: new, in progress, done or spam. The filter above the list shows one status at a time.",
            "View opens the message. Reveal contact details and notes shows the e-mail, phone, budget and timeline. Each reveal is logged against your account, up to 60 an hour.",
            "Internal notes appear after a reveal, for the roles that may see contact details.",
            "Export CSV downloads the leads as a file, at most three times an hour. Every export is logged."
          ]
        },
        {
          "t": "tip",
          "x": "A lead marked as spam is deleted sooner: after 30 days by default, instead of 24 months."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يصل هنا كل استفسار يُرسل عبر نماذج التواصل في الموقع على هيئة عميل محتمل. تعرض القائمة وقت وصوله واسم صاحبه وما سأل عنه، وتبقى بيانات التواصل مخفية حتى تطلبها."
        },
        {
          "t": "ol",
          "x": [
            "حدّد حالة كل عميل محتمل أثناء العمل عليه: new أو in progress أو done أو spam. ويعرض المرشّح أعلى القائمة حالة واحدة في كل مرة.",
            "يفتح View الرسالة، ويُظهر Reveal contact details and notes البريد الإلكتروني والهاتف والميزانية والمدة الزمنية. يُسجَّل كل كشف باسم حسابك، بحد أقصى 60 مرة في الساعة.",
            "تظهر الملاحظات الداخلية بعد الكشف، للأدوار المخوّلة برؤية بيانات التواصل.",
            "ينزّل Export CSV العملاء المحتملين في ملف، بحد أقصى ثلاث مرات في الساعة، ويُسجَّل كل تصدير."
          ]
        },
        {
          "t": "tip",
          "x": "العميل المحتمل المعلَّم كرسالة مزعجة (spam) يُحذف أسرع: بعد 30 يومًا افتراضيًا بدلًا من 24 شهرًا."
        }
      ]
    }
  },
  {
    "slug": "personal-data",
    "sort_order": 80,
    "minutes": 4,
    "tags": [
      "privacy",
      "leads",
      "hiring"
    ],
    "screens": [
      "/admin/leads",
      "/admin/applications"
    ],
    "caps": [
      "leads.pii",
      "applications.pii"
    ],
    "title": "Personal data and the PDPL",
    "title_ar": "البيانات الشخصية ونظام حمايتها",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Saudi Arabia's Personal Data Protection Law (PDPL) covers everything visitors send through the site. The admin makes the careful way the default, so there is little to remember."
        },
        {
          "t": "ol",
          "x": [
            "Contact details are stored encrypted. They are shown one person at a time, only when you ask, and each look is recorded against your account, with the time.",
            "Visits are counted only for visitors who accept analytics cookies on the site.",
            "Leads are deleted after 24 months by default, spam after 30 days. Job applications go after 12 months, or 24 if the applicant agreed to be kept for future roles.",
            "Exports and CV downloads are logged too, and exports are limited per hour.",
            "When an applicant asks for their data to be deleted, an Admin can erase the application, CV included."
          ]
        },
        {
          "t": "tip",
          "x": "Reveal contact details only when you are about to get in touch. Each look is recorded against the account that made it, and the activity log lists it with its time and that account's role."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يشمل نظام حماية البيانات الشخصية في المملكة العربية السعودية كل ما يرسله الزوار عبر الموقع. وتجعل لوحة الإدارة الطريقة الحذرة هي الطريقة الافتراضية، فلا يبقى الكثير لتتذكره."
        },
        {
          "t": "ol",
          "x": [
            "تُحفظ بيانات التواصل مشفّرة، وتُعرض بيانات شخص واحد في كل مرة وعند طلبك فقط، ويُسجَّل كل اطلاع على حسابك مع وقته.",
            "لا تُحتسب الزيارات إلا لمن يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات.",
            "يُحذف العملاء المحتملون بعد 24 شهرًا افتراضيًا، والرسائل المزعجة بعد 30 يومًا. وتُحذف طلبات التوظيف بعد 12 شهرًا، أو 24 شهرًا إذا وافق المتقدم على الاحتفاظ بطلبه لوظائف مستقبلية.",
            "يُسجَّل التصدير وتنزيل السير الذاتية أيضًا، ولعمليات التصدير حد في الساعة.",
            "عندما يطلب متقدم حذف بياناته، يستطيع المسؤول (Admin) محو طلبه بما فيه سيرته الذاتية."
          ]
        },
        {
          "t": "tip",
          "x": "اكشف بيانات التواصل فقط حين توشك على التواصل. يُسجَّل كل اطلاع على الحساب الذي قام به، ويعرضه سجل النشاط مع وقته ودور ذلك الحساب."
        }
      ]
    }
  },
  {
    "slug": "job-applications",
    "sort_order": 90,
    "minutes": 3,
    "tags": [
      "hiring"
    ],
    "screens": [
      "/admin/applications"
    ],
    "caps": [
      "applications.manage"
    ],
    "title": "Job applications",
    "title_ar": "طلبات التوظيف",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Applications sent from the Join page arrive here. The form on the site is open only while Accepting job applications is ticked in General settings, which only an Admin can change."
        },
        {
          "t": "ol",
          "x": [
            "Set each application's status as you review it.",
            "Reveal contact details shows the e-mail and phone, and Download CV fetches the file. Both are logged against your account.",
            "Erase application removes the application and its CV for good. Use it when someone asks for their data to be deleted.",
            "Applications are kept 12 months, or 24 if the applicant agreed to be considered for future roles. One marked spam goes after 30 days."
          ]
        },
        {
          "t": "tip",
          "x": "CVs are not scanned for viruses. Open them with care, and keep them inside the team."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تصل هنا الطلبات المرسلة من صفحة Join. ولا يكون النموذج في الموقع مفتوحًا إلا عند تفعيل Accepting job applications في الإعدادات العامة، وتغييره للمسؤول (Admin) فقط."
        },
        {
          "t": "ol",
          "x": [
            "حدّد حالة كل طلب أثناء مراجعته.",
            "يُظهر Reveal contact details البريد الإلكتروني والهاتف، ويجلب Download CV الملف، ويُسجَّل الاثنان باسم حسابك.",
            "يحذف Erase application الطلب وسيرته الذاتية نهائيًا. استخدمه عندما يطلب أحد حذف بياناته.",
            "تُحفظ الطلبات 12 شهرًا، أو 24 شهرًا إذا وافق المتقدم على النظر في طلبه لوظائف مستقبلية. والطلب المعلَّم كرسالة مزعجة (spam) يُحذف بعد 30 يومًا."
          ]
        },
        {
          "t": "tip",
          "x": "لا تُفحص السير الذاتية بحثًا عن الفيروسات. افتحها بحذر وأبقِها داخل الفريق."
        }
      ]
    }
  },
  {
    "slug": "maintenance-mode",
    "sort_order": 100,
    "minutes": 2,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/maintenance"
    ],
    "caps": [
      "maintenance.manage"
    ],
    "title": "Maintenance mode",
    "title_ar": "وضع الصيانة",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Maintenance mode puts a short notice in front of the public site while you fix something. It takes effect within about a minute, and the admin keeps working as usual."
        },
        {
          "t": "ol",
          "x": [
            "Tick Maintenance mode is on and save. Visitors see the maintenance notice instead of the site.",
            "To keep seeing the real site yourself, add your IP address to the allowlist, one per line.",
            "While it is on, everyone in the admin sees Maintenance on in the top bar, and the bell says when it was switched on or off.",
            "Untick it and save to bring the site back."
          ]
        },
        {
          "t": "tip",
          "x": "Switch it off as soon as the fix is in, so visitors and search engines are not kept waiting."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يضع وضع الصيانة إشعارًا قصيرًا أمام الموقع العام أثناء إصلاحك لشيء ما. يسري خلال دقيقة تقريبًا، وتستمر لوحة الإدارة في العمل كالمعتاد."
        },
        {
          "t": "ol",
          "x": [
            "فعّل Maintenance mode is on واحفظ، فيرى الزوار إشعار الصيانة بدل الموقع.",
            "لتواصل رؤية الموقع الحقيقي بنفسك، أضف عنوان IP الخاص بك إلى قائمة السماح، عنوانًا في كل سطر.",
            "أثناء تفعيله يرى الجميع في لوحة الإدارة Maintenance on في الشريط العلوي، ويُعلمك الجرس بوقت تشغيله أو إيقافه.",
            "ألغِ التفعيل واحفظ لإعادة الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "أوقفه فور انتهاء الإصلاح، حتى لا يطول انتظار الزوار ومحركات البحث."
        }
      ]
    }
  },
  {
    "slug": "website-stats",
    "sort_order": 110,
    "minutes": 2,
    "tags": [
      "stats"
    ],
    "screens": [
      "/admin/analytics",
      "/admin/analytics/search"
    ],
    "caps": [
      "analytics.read"
    ],
    "title": "Website stats",
    "title_ar": "إحصاءات الموقع",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Website stats counts page views by page and by language. The numbers are the site's own, with no outside tracker, and only visitors who accept analytics cookies are counted."
        },
        {
          "t": "ol",
          "x": [
            "Pick 7, 30 or 90 days at the top. Overview shows page views, the Arabic share, English and Arabic views day by day and the top pages; Pages lists every page with its views in each language. If you work with leads, Overview also shows new leads and inquiries per 1,000 page views.",
            "A change against the previous period shows only when there is a previous period to compare: the same number of days just before.",
            "Counts are added up every 15 minutes, by days that run midnight to midnight UTC (3 am in Riyadh), so the latest visits can take a while to show.",
            "Where your role has a Search tab, it shows what visitors typed into the site's search, and which searches found nothing. A search that finds nothing is often a page worth writing.",
            "Raw visit records are kept 90 days; the daily totals the screen reads are kept after that."
          ]
        },
        {
          "t": "tip",
          "x": "A low number can simply mean few visitors accepted cookies, not few visitors."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تحتسب إحصاءات الموقع مشاهدات الصفحات حسب الصفحة واللغة. الأرقام خاصة بالموقع نفسه دون أي أداة تتبع خارجية، ولا يُحتسب إلا من يقبل من الزوار ملفات تعريف الارتباط الخاصة بالتحليلات."
        },
        {
          "t": "ol",
          "x": [
            "اختر 7 أو 30 أو 90 يومًا في الأعلى. يعرض تبويب Overview مشاهدات الصفحات وحصة العربية والمشاهدات بالإنجليزية والعربية يومًا بيوم وأكثر الصفحات زيارة، ويسرد تبويب Pages كل صفحة مع مشاهداتها بكل لغة. وإذا كنت تعمل على العملاء المحتملين فسيعرض Overview أيضًا العملاء الجدد والاستفسارات لكل 1,000 مشاهدة.",
            "لا يظهر التغيّر مقارنة بالفترة السابقة إلا إذا وُجدت فترة سابقة للمقارنة، أي العدد نفسه من الأيام التي تسبقها مباشرة.",
            "تُجمع الأرقام كل 15 دقيقة، بأيام تمتد من منتصف الليل إلى منتصف الليل بتوقيت UTC (الثالثة فجرًا بتوقيت الرياض)، لذا قد تتأخر أحدث الزيارات في الظهور.",
            "إذا كان لدورك تبويب Search فهو يعرض ما كتبه الزوار في بحث الموقع، وعمليات البحث التي لم تجد شيئًا. والبحث الذي لا يجد شيئًا كثيرًا ما يشير إلى صفحة تستحق الكتابة.",
            "تُحفظ سجلات الزيارات الأولية 90 يومًا، وتبقى المجاميع اليومية التي تقرؤها الشاشة بعد ذلك."
          ]
        },
        {
          "t": "tip",
          "x": "قد يعني الرقم المنخفض ببساطة أن قلة من الزوار قبلوا ملفات تعريف الارتباط، لا أن الزوار قليلون."
        }
      ]
    }
  },
  {
    "slug": "site-health-and-logs",
    "sort_order": 120,
    "minutes": 3,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/site-health",
      "/admin/audit"
    ],
    "caps": [
      "siteHealth.view",
      "logs.view",
      "audit.view"
    ],
    "title": "Site health, errors and the activity log",
    "title_ar": "صحة الموقع والأخطاء وسجل النشاط",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Site health shows how fast the site feels to real visitors (Core Web Vitals), measured in their own browsers when they accept analytics cookies, beside a checklist of things worth fixing."
        },
        {
          "t": "ol",
          "x": [
            "The score is half speed and half checklist. Speed comes from real visits over the last 28 days: each of LCP, INP and CLS counts in full when it is within budget, half when it needs work and not at all when it is poor. Uptime is not measured here yet.",
            "The checklist groups what it checks: content, SEO, speed, errors, security and backups. A row that needs fixing links to the screen where you fix it, and a row your role cannot check says so.",
            "Speed lists each page's figures from visitors' browsers, added up every hour and kept 400 days. Lab scores run in CI on every change, so none are shown here.",
            "Errors lists problems the site ran into. Every night, entries older than 30 days are deleted by themselves; an Admin can clear them sooner with Clear logs, choosing entries older than 7 days, older than 30 days, or all of them, and the clearing itself is recorded in the activity log.",
            "The activity log records saves, publishes, reveals of contact details, sign-ins and exports, each against the account that made it, with the time. The database itself writes who made an entry and when, so nobody can record something in someone else's name. Each entry names the person, former members included, and says what they did in plain words, with the names of the fields a save changed, never what they hold. Nobody can edit or delete an entry, not even an Admin, and the log is kept for good.",
            "Narrow the log to a kind of activity, a person or a range of days. Publishing finds publishes recorded since these filters arrived; earlier ones are listed as updates. Export downloads the entries that match as a spreadsheet file (CSV), up to three times an hour, and each download is recorded in the log too; the file names each item by its type and id, not its title. If the line above the list says the latest entries do not link up, tell whoever runs the site."
          ]
        },
        {
          "t": "tip",
          "x": "To find out when something changed, and who changed it, look in the activity log."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تُظهر صحة الموقع مدى سرعة الموقع كما يشعر بها الزوار الحقيقيون (Core Web Vitals)، وتُقاس في متصفحاتهم عندما يقبلون ملفات تعريف الارتباط الخاصة بالتحليلات، إلى جانب قائمة تحقق بما يستحق الإصلاح."
        },
        {
          "t": "ol",
          "x": [
            "نصف الدرجة للسرعة ونصفها لقائمة التحقق. تأتي السرعة من زيارات حقيقية خلال آخر 28 يومًا: يُحتسب كل من LCP وINP وCLS كاملًا إذا كان ضمن الحد المستهدف، ونصفه إذا احتاج إلى تحسين، ولا يُحتسب إذا كان ضعيفًا. ولا يُقاس وقت التشغيل هنا بعد.",
            "تجمع قائمة التحقق ما تفحصه في مجموعات: المحتوى وSEO والسرعة والأخطاء والأمان والنسخ الاحتياطية. والبند الذي يحتاج إلى إصلاح يرتبط بالشاشة التي تصلحه منها، والبند الذي لا يستطيع دورك فحصه يذكر ذلك.",
            "يعرض تبويب Speed أرقام كل صفحة من متصفحات الزوار، تُجمع كل ساعة وتُحفظ 400 يوم. أما درجات المختبر فتُشغَّل في CI مع كل تغيير، لذا لا تظهر هنا.",
            "يعرض تبويب Errors المشكلات التي واجهها الموقع. تُحذف كل ليلة الإدخالات الأقدم من 30 يومًا تلقائيًا، ويستطيع المسؤول (Admin) مسحها قبل ذلك بزر Clear logs، فيختار الإدخالات الأقدم من 7 أيام أو الأقدم من 30 يومًا أو كلها، ويُسجَّل المسح نفسه في سجل النشاط.",
            "يسجّل سجل النشاط الحفظ والنشر وكشف بيانات التواصل وتسجيل الدخول والتصدير، كلًّا على الحساب الذي قام به مع وقته. وتكتب قاعدة البيانات بنفسها صاحب كل إدخال ووقته، فلا يستطيع أحد أن يسجّل شيئًا باسم غيره. ويذكر كل إدخال اسم الشخص، ومنهم من غادر الفريق، وما فعله بكلمات واضحة، مع أسماء الحقول التي غيّرها الحفظ دون محتواها. ولا يستطيع أحد تعديل أي إدخال أو حذفه، ولا حتى المسؤول (Admin)، ويُحتفظ بالسجل دائمًا.",
            "ضيّق السجل حسب نوع النشاط أو الشخص أو مدة من الأيام. يجد مرشّح Publishing ما نُشر منذ إضافة هذه المرشّحات، ويظهر ما نُشر قبلها كتحديثات. ويُنزّل زر Export الإدخالات المطابقة في ملف جدول بيانات (CSV) حتى ثلاث مرات في الساعة، ويُسجَّل كل تنزيل في السجل أيضًا، ويذكر الملف كل عنصر بنوعه ومعرّفه لا بعنوانه. وإذا ذكر السطر أعلى القائمة أن أحدث الإدخالات لا تتصل كما ينبغي، فأبلغ المسؤول عن الموقع."
          ]
        },
        {
          "t": "tip",
          "x": "لمعرفة متى تغيّر شيء ومن قام بتغييره، ارجع إلى سجل النشاط."
        }
      ]
    }
  }
]
$help$::jsonb
$fn$;

-- CREATE OR REPLACE keeps the ACL; restated anyway (0046: no API role reads the set).
revoke all on function app.help_article_set() from public, anon, authenticated, service_role;

-- Every tenant gets the rewritten guide (app.seed_help_articles updates a guide only where it
-- differs from the set, moving its version; 0046).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair; a function's schema printed only when
-- app is not on the search path, and current_role, a reserved word, quoted), so the patterns
-- allow both.
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_read constant text :=
    '^\(' || v_tenant || ' AND (app\.)?role_views_audit\((app\.)?"?current_role"?\(\)\)\)$';
  v_live constant text :=
    '^\(' || v_tenant || ' AND (app\.)?role_views_audit\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$';
  v_insert constant text := '^\(' || v_tenant || ' AND (app\.)?is_staff\(\)\)$';
  v_have text[];
  v_bad text;
  v_set jsonb;
  p text;
begin
  -- ---- The helper: Admin and Developer, for every role the enum knows and for none; staff
  -- and the service role may call it, anon and PUBLIC may not; inlinable (immutable, invoker).
  if not (app.role_views_audit('admin')
          and app.role_views_audit('developer')
          and not app.role_views_audit('content_creator')
          and not app.role_views_audit('seo')
          and not app.role_views_audit('anon')
          and not app.role_views_audit(null)) then
    raise exception '0054: app.role_views_audit does not answer audit.view (Admin and Developer)';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.role_views_audit(text)'::regprocedure
                    and provolatile = 'i' and not prosecdef) then
    raise exception '0054: app.role_views_audit must be IMMUTABLE and SECURITY INVOKER';
  end if;
  if not has_function_privilege('authenticated', 'app.role_views_audit(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_views_audit(text)', 'execute')
     or has_function_privilege('anon', 'app.role_views_audit(text)', 'execute')
     or has_function_privilege('public', 'app.role_views_audit(text)', 'execute') then
    raise exception '0054: app.role_views_audit must be executable by authenticated and service_role only';
  end if;
  -- The live role it is given: a definer staff tokens alone may call (0033).
  if not exists (select 1 from pg_proc where oid = 'app.live_role()'::regprocedure and prosecdef)
     or not has_function_privilege('authenticated', 'app.live_role()', 'execute')
     or has_function_privilege('anon', 'app.live_role()', 'execute') then
    raise exception '0054: app.live_role() must be a SECURITY DEFINER that authenticated alone executes';
  end if;

  -- ---- audit_log: RLS on and forced, and exactly these policies (name, command, kind and
  -- roles compared as a set, so one added, dropped, renamed, made permissive or widened to
  -- another role fails here).
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.audit_log'::regclass) then
    raise exception '0054: audit_log is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'audit_log') s;
  if v_have is distinct from array['audit_insert INSERT PERMISSIVE {public}',
                                   'audit_log_live_read SELECT RESTRICTIVE {authenticated}',
                                   'audit_read SELECT PERMISSIVE {public}'] then
    raise exception '0054: audit_log policies are %, expected audit_insert, audit_log_live_read and audit_read', v_have;
  end if;

  -- ---- Each side of each policy, read separately: the tenant predicate first, then the
  -- role test, on every side the command has; a side it does not have is absent.
  select string_agg(format('%s %s', x.policy, x.side), ', ' order by x.policy, x.side) into v_bad
    from (values ('audit_read', 'using', v_read),
                 ('audit_read', 'with check', null),
                 ('audit_log_live_read', 'using', v_live),
                 ('audit_log_live_read', 'with check', null),
                 ('audit_insert', 'using', null),
                 ('audit_insert', 'with check', v_insert)) as x(policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = 'audit_log' and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0054: audit_log policy expressions are not as stated: %', v_bad;
  end if;

  -- ---- The triggers are H10's, untouched: exactly two, both BEFORE INSERT FOR EACH ROW
  -- (tgtype 7: ROW 1 + BEFORE 2 + INSERT 4), enabled, no WHEN clause or argument, the actor
  -- binding then the chain (BEFORE triggers on one event fire in name order, byte order), each
  -- function compared by oid, not by its printed name.
  select coalesce(array_agg(t.tgname::text order by t.tgname collate "C"), '{}')
    into v_have
    from pg_trigger t
   where t.tgrelid = 'public.audit_log'::regclass and not t.tgisinternal
     and t.tgenabled::text = 'O' and t.tgtype = 7 and t.tgqual is null and t.tgnargs = 0
     and ((t.tgname = 'audit_log_actor' and t.tgfoid = 'app.tg_audit_actor()'::regprocedure)
          or (t.tgname = 'audit_log_chain' and t.tgfoid = 'app.tg_audit_chain()'::regprocedure));
  if v_have is distinct from array['audit_log_actor', 'audit_log_chain']
     or (select count(*) from pg_trigger t
          where t.tgrelid = 'public.audit_log'::regclass and not t.tgisinternal) <> 2 then
    raise exception '0054: audit_log triggers are %, expected audit_log_actor then audit_log_chain, both BEFORE INSERT FOR EACH ROW', v_have;
  end if;
  -- Neither trigger function is callable by an API role.
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.tg_audit_actor()', 'execute')
       or has_function_privilege(p, 'app.tg_audit_chain()', 'execute') then
      raise exception '0054: % may execute an audit_log trigger function', p;
    end if;
  end loop;

  -- ---- audit_log's privileges, as 0050 stated them: exactly SELECT and INSERT for
  -- authenticated and service_role, nothing for anon and PUBLIC, so nobody may UPDATE, DELETE
  -- or TRUNCATE a row, the service role included. No column grant.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.audit_log', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select', 'insert']),
                         ('service_role', array['select', 'insert']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0054: wrong table privileges on audit_log (role privilege): %', v_bad;
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0
                and not a.attisdropped and cardinality(coalesce(a.attacl, '{}'::aclitem[])) > 0) then
    raise exception '0054: audit_log carries a column grant';
  end if;

  -- ---- The filters' indexes, as built.
  if (select pg_get_indexdef('public.audit_log_tenant_actor_idx'::regclass))
       !~ 'ON public\.audit_log USING btree \(tenant_id, actor_id, id DESC\)$'
     or (select pg_get_indexdef('public.audit_log_tenant_created_idx'::regclass))
       !~ 'ON public\.audit_log USING btree \(tenant_id, created_at DESC\)$' then
    raise exception '0054: the activity log''s filter indexes are not as stated';
  end if;

  -- ---- The directory's audit door: a definer with an empty search_path, answering the four
  -- columns and never an e-mail, that staff tokens alone may call.
  if not exists (select 1 from pg_proc
                  where oid = 'public.audit_people(uuid, uuid[])'::regprocedure and prosecdef
                    and provolatile = 's'
                    and pg_get_function_result(oid)
                        = 'TABLE(id uuid, display_name text, role text, is_active boolean)'
                    and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                 where c in ('search_path=""', 'search_path='))) then
    raise exception '0054: public.audit_people must be a STABLE SECURITY DEFINER with an empty search_path answering id, display_name, role, is_active';
  end if;
  if not has_function_privilege('authenticated', 'public.audit_people(uuid, uuid[])', 'execute')
     or has_function_privilege('anon', 'public.audit_people(uuid, uuid[])', 'execute')
     or has_function_privilege('public', 'public.audit_people(uuid, uuid[])', 'execute')
     or has_function_privilege('service_role', 'public.audit_people(uuid, uuid[])', 'execute') then
    raise exception '0054: public.audit_people must be executable by authenticated alone';
  end if;
  if (select prosrc from pg_proc where oid = 'public.audit_people(uuid, uuid[])'::regprocedure)
       ~* 'email' then
    raise exception '0054: public.audit_people must never read an e-mail';
  end if;

  -- ---- The guides: the set parses, no API role reads it, and every tenant holds the
  -- rewritten guide as the set states it.
  v_set := app.help_article_set();
  if jsonb_typeof(v_set) <> 'array'
     or not exists (select 1 from jsonb_array_elements(v_set) a
                     where a ->> 'slug' = 'site-health-and-logs'
                       and a::text like '%former members included%') then
    raise exception '0054: app.help_article_set() does not hold the rewritten activity-log guide';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.help_article_set()', 'execute') then
      raise exception '0054: % may execute app.help_article_set()', p;
    end if;
  end loop;
  if exists (select 1 from public.tenants t
              where not exists (
                select 1 from public.help_articles h
                  join jsonb_to_recordset(v_set) as a (slug text, body jsonb)
                    on a.slug = h.slug
                 where h.tenant_id = t.id and h.slug = 'site-health-and-logs'
                   and h.body = a.body)) then
    raise exception '0054: a tenant does not hold the rewritten site-health-and-logs guide';
  end if;
end $$;
