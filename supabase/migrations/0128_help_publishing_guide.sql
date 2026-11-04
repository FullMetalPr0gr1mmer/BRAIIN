-- ─────────────────────────────────────────────────────────────────────────────────────────
-- R14b (Admin v2, what the release switch-on needs) — the publishing guide, saving-and-publishing,
-- for both ways of publishing. Forward-only and EXPAND only: one guide changes through H11's
-- catalog. Nothing else changes. The number is a placeholder: numbers are assigned at the merge
-- train (docs/admin-v2/migrations.md), and this file is renumbered with
-- scripts/renumber-migration.mjs to the next free number above main's highest. Depends on the
-- help centre (help_articles, U16) and H11's catalog (app.help_guide_catalog,
-- app.put_help_guide).
--
-- saving-and-publishing is the guide every content editor's head opens (PAGE_GUIDES). Its words
-- describe saving with releases off, which stays true until the owner switches releases on
-- (launch runbook §6p), and say nothing of release mode, where Save no longer changes the site.
-- This put keeps every sentence that is still true today, says which way of publishing it
-- describes, and adds what changes once releases are on: Save keeps an unpublished change, the
-- bar counts them, Publish puts them live as a numbered version, a release is scheduled (never
-- one item), History and Backups & versions restore. Its place (40), screens and capabilities
-- are unchanged; revision 1 (the catalog's fill, 0069) moves to 2.
--
-- No table, function, grant or policy is created or changed, so there is no privilege to
-- state; the put re-seeds this one slug into every tenant and touches no other guide.
-- ─────────────────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

select app.put_help_guide($guide$
{
  "slug": "saving-and-publishing",
  "sort_order": 40,
  "minutes": 5,
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
        "x": "Every editor works the same way: change the fields, then press Save changes. What a save does depends on whether publishing in releases is switched on for your site. Until it is, what you save is what the site shows, so a change to something already published is live as soon as it is saved."
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
        "x": "Once publishing in releases is switched on"
      },
      {
        "t": "p",
        "x": "Save no longer changes the site. It keeps your work as an unpublished change, the editor says Saved as an unpublished change, and the bar at the bottom of the screen counts what is waiting. An editor also saves by itself when you leave a field you changed. Nothing goes live until someone publishes it."
      },
      {
        "t": "ol",
        "x": [
          "The status becomes a Visible on the site switch, and there is no Scheduled for field: a whole release is scheduled, never one item.",
          "Previewing shows a page with the unpublished changes in it before anyone else sees them.",
          "Publish in the bar lists the changes your role may publish, all ticked. Untick any you want to hold back; Publish puts the rest live together as a new numbered version.",
          "Schedule for, in the same window, publishes them at a day and time instead. A scheduled change is locked until it goes live.",
          "Discard throws unpublished changes away. The live site does not change.",
          "History on an editor, and Backups & versions in Settings, bring an earlier version back as unpublished changes for you to check and publish."
        ]
      },
      {
        "t": "tip",
        "x": "What you may publish follows what you may edit. A change you cannot publish waits in the list for someone who can. Maintenance mode, users, integrations, leads, job applications and media details still save at once."
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
        "t": "p",
        "x": "With publishing in releases on, everyone's changes to one item are one unpublished change. If the live site changed under it, the editor names the fields and offers Keep my version or Use the live version."
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
        "x": "تعمل جميع المحررات بالطريقة نفسها: عدّل الحقول ثم اضغط Save changes. وما يفعله الحفظ يتوقف على تفعيل النشر عبر الإصدارات لموقعك. فإلى أن يُفعَّل، ما تحفظه هو ما يعرضه الموقع، لذا يظهر أي تغيير على محتوى منشور فور حفظه."
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
        "x": "بعد تفعيل النشر عبر الإصدارات"
      },
      {
        "t": "p",
        "x": "لا يغيّر الحفظ الموقع بعد الآن، بل يحتفظ بعملك تغييرًا غير منشور، ويعرض المحرر Saved as an unpublished change، ويعدّ الشريط أسفل الشاشة ما ينتظر النشر. ويحفظ المحرر أيضًا من تلقاء نفسه عندما تغادر حقلًا غيّرته. ولا يُنشر شيء حتى ينشره أحد."
      },
      {
        "t": "ol",
        "x": [
          "تصبح الحالة مفتاح Visible on the site، ولا يوجد حقل Scheduled for: يُجدول الإصدار كاملًا، لا عنصر واحد.",
          "المعاينة تعرض الصفحة بما فيها من تغييرات غير منشورة قبل أن يراها أحد غيرك.",
          "يعرض Publish في الشريط التغييرات التي يتيح لك دورك نشرها، وكلها محددة. ألغِ تحديد ما تريد تأجيله، ثم ينشر Publish الباقي معًا إصدارًا مرقّمًا جديدًا.",
          "يتيح Schedule for في النافذة نفسها نشرها في يوم ووقت تختارهما بدلًا من ذلك. ويبقى التغيير المجدول مقفلًا حتى يُنشر.",
          "يتخلص Discard من التغييرات غير المنشورة، ولا يتغير الموقع المباشر.",
          "يعيد History في المحرر، وBackups & versions في الإعدادات، إصدارًا سابقًا كتغييرات غير منشورة لتراجعها ثم تنشرها."
        ]
      },
      {
        "t": "tip",
        "x": "ما يمكنك نشره يتبع ما يمكنك تعديله. والتغيير الذي لا يمكنك نشره ينتظر في القائمة من يستطيع نشره. أما وضع الصيانة والمستخدمون والتكاملات والعملاء المحتملون وطلبات التوظيف وبيانات الوسائط فتُحفظ فورًا كما كانت."
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
        "t": "p",
        "x": "وبعد تفعيل النشر عبر الإصدارات، تكون تغييرات الجميع على العنصر الواحد تغييرًا واحدًا غير منشور. وإذا تغيّر الموقع المباشر تحته، يسمّي المحرر الحقول ويعرض Keep my version أو Use the live version."
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
}
$guide$::jsonb, 1);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  -- ---- 1. The guide: in the catalog at revision 2, place 40, its six caps -----------------
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'saving-and-publishing' and c.revision = 2 and c.sort_order = 40
                    and cardinality(c.caps) = 6
                    and c.body #>> '{en,5,x}' like 'Save no longer changes the site.%') then
    raise exception 'R14b: saving-and-publishing is not at revision 2, place 40, with its release-mode words';
  end if;

  -- ---- 2. Every tenant holds it, field for field as the catalog renders it ----------------
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'saving-and-publishing'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'R14b: tenants without the catalog''s saving-and-publishing: %', v_bad;
  end if;
end $$;
