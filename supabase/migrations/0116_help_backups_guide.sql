-- ─────────────────────────────────────────────────────────────────────────────────────────
-- R13 (Admin v2, release UX II) — the Backups & versions help guide, backups-and-versions.
-- Forward-only and EXPAND only: one new guide through H11's catalog. Nothing else changes. The
-- number is a placeholder: numbers are assigned at the merge train
-- (docs/admin-v2/migrations.md), and this file is renumbered with
-- scripts/renumber-migration.mjs to the next free number above main's highest. Depends on the
-- help centre (help_articles, U16) and H11's catalog (app.help_guide_catalog,
-- app.put_help_guide).
--
-- R13 adds the /admin/backups screen with no schema change; its guide lands here, as H11 asks
-- of a new guide: one top-level app.put_help_guide at revision 0, sort_order 125 (a free place
-- after site-health-and-logs, 120, as Backups & versions closes the Settings menu). For the
-- roles that open the screen: its capabilities are exactly the release read capabilities
-- (src/lib/release/readCaps.ts, equal to PENDING_ANY_CAP), twelve, the catalog's limit, so
-- Admin, Content Creator, SEO and Developer read it and Sales does not (the Worker's filter from
-- ROLE_CAPS). Its one screen is /admin/backups; PAGE_GUIDES (src/lib/admin/help/pageGuides.ts)
-- offers it there. It is true whether publishing in releases is on or off (R14 switches it on).
--
-- No table, function, grant or policy is created or changed, so there is no privilege to
-- state; the put re-seeds this one slug into every tenant and touches no other guide.
-- ─────────────────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

select app.put_help_guide($guide$
{
  "slug": "backups-and-versions",
  "sort_order": 125,
  "minutes": 3,
  "tags": [
    "content",
    "site"
  ],
  "screens": [
    "/admin/backups"
  ],
  "caps": [
    "blog.write",
    "categories.manage",
    "maintenance.manage",
    "nav.edit",
    "pages.write",
    "portfolio.write",
    "redirects.manage",
    "seo.entityMeta",
    "seo.globalDefaults",
    "services.write",
    "settings.general",
    "theme.edit"
  ],
  "title": "Backups and versions",
  "title_ar": "النسخ الاحتياطية والإصدارات",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Backups & versions, in Settings, lists every version of the site that went live and keeps a copy of its content within reach."
      },
      {
        "t": "h",
        "x": "Versions"
      },
      {
        "t": "p",
        "x": "Once publishing in releases is switched on for your site, every publish becomes a numbered version. Until then the page says so, and what you save goes live straight away."
      },
      {
        "t": "ol",
        "x": [
          "Preview shows the site as an earlier version was, with today's design and pictures.",
          "Details lists what a version changed, in the areas your role opens.",
          "Restore brings an earlier version back as unpublished changes. Nothing goes live until it is published, and the version stays in the list.",
          "A scheduled release can have its time changed or be unscheduled. A release that could not go live says why, and its changes wait to be published again."
        ]
      },
      {
        "t": "tip",
        "x": "The editor of a service, a project, a post or another item in a list also has a History button: it lists the versions of that one item, newest first."
      },
      {
        "t": "h",
        "x": "Backups"
      },
      {
        "t": "p",
        "x": "An Admin or a Developer can download the site's content as one file, up to three times an hour. Leads, job applications, consent records, the activity log and people's accounts are never in it, and each download is recorded in the activity log."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تعرض صفحة النسخ الاحتياطية والإصدارات في الإعدادات كل إصدار من الموقع نُشر، وتتيح نسخة من محتواه."
      },
      {
        "t": "h",
        "x": "الإصدارات"
      },
      {
        "t": "p",
        "x": "بعد تفعيل النشر عبر الإصدارات لموقعك، يصبح كل نشر إصدارًا مرقّمًا. وإلى أن يُفعَّل، توضح الصفحة ذلك، وما تحفظه يُنشر فورًا."
      },
      {
        "t": "ol",
        "x": [
          "المعاينة تعرض الموقع كما كان في إصدار سابق، بالتصميم والصور الحالية.",
          "التفاصيل تعرض ما غيّره الإصدار في الأقسام التي يتيحها دورك.",
          "الاستعادة تعيد إصدارًا سابقًا كتغييرات غير منشورة، ولا يُنشر شيء حتى يتم النشر، ويبقى الإصدار في القائمة.",
          "يمكن تغيير موعد الإصدار المجدول أو إلغاء جدولته. والإصدار الذي تعذّر نشره يوضح السبب، وتبقى تغييراته بانتظار النشر من جديد."
        ]
      },
      {
        "t": "tip",
        "x": "ولمحرر الخدمة أو المشروع أو المقالة أو أي عنصر آخر في قائمة زر السجل أيضًا، ويعرض إصدارات ذلك العنصر وحده، من الأحدث إلى الأقدم."
      },
      {
        "t": "h",
        "x": "النسخ الاحتياطية"
      },
      {
        "t": "p",
        "x": "يستطيع المسؤول أو المطوّر تنزيل محتوى الموقع في ملف واحد، حتى ثلاث مرات في الساعة. لا يتضمن الملف العملاء المحتملين ولا طلبات التوظيف ولا سجلات الموافقة ولا سجل النشاط ولا حسابات الأشخاص، ويُسجَّل كل تنزيل في سجل النشاط."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  -- ---- 1. The guide: in the catalog at revision 1 (a new guide), place 125, twelve caps ---
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'backups-and-versions' and c.revision = 1 and c.sort_order = 125
                    and cardinality(c.caps) = 12) then
    raise exception 'R13: the backups-and-versions guide is not in the catalog at revision 1, place 125, with its 12 caps';
  end if;

  -- ---- 2. Every tenant holds it, field for field as the catalog renders it ----------------
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'backups-and-versions'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'R13: tenants without the backups-and-versions guide as the catalog holds it: %', v_bad;
  end if;

  -- ---- 3. The set renders it in its place ---------------------------------------------------
  if not exists (select 1 from jsonb_array_elements(app.help_article_set()) e
                  where e->>'slug' = 'backups-and-versions' and (e->>'sort_order')::int = 125) then
    raise exception 'R13: app.help_article_set() does not list backups-and-versions at 125';
  end if;
end $$;
