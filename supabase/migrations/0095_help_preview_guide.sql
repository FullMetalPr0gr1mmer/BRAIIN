-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0095 — The preview's help guide, previewing-changes (Admin v2 R9). Forward-only and EXPAND
-- only: one new guide through H11's catalog. Nothing else changes. The number is a
-- placeholder: numbers are assigned at merge (docs/admin-v2/migrations.md), and this file is
-- renumbered with scripts/renumber-migration.mjs to the next free number above main's highest.
-- Depends on 0046 (help_articles, U16) and 0069 (H11: app.help_guide_catalog and
-- app.put_help_guide).
--
-- R9 adds the /admin/preview route with no schema change; its guide was written ahead of the
-- catalog (as-built R9.md) and lands here, as H11 asks of a new guide: one top-level
-- app.put_help_guide at revision 0, sort_order 95 (the place assigned to R9: U7 holds 45,
-- C10a 65, C9a 75). For the roles that may preview: its capabilities are exactly
-- PREVIEW_READ_CAPS (src/lib/preview/dataset.ts), twelve, the catalog's limit
-- (help_guide_catalog_caps_ok), so Admin, Content Creator, SEO and Developer read it and a
-- role holding none of them (C10a's Sales) does not (the Worker's filter from ROLE_CAPS). Its
-- screens are the preview, Pages and Page visibility; PAGE_GUIDES
-- (src/lib/admin/help/pageGuides.ts) offers it on the preview's own pages, and
-- tests/lib/previewGuide.spec.ts and tests/lib/helpCentre.spec.ts read this statement
-- (tests/fixtures/helpSet.ts) and hold it to what the preview does.
--
-- No table, function, grant or policy is created or changed, so there is no privilege to
-- state; the put re-seeds this one slug into every tenant and touches no other guide.
-- ─────────────────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

select app.put_help_guide($guide$
{
  "slug": "previewing-changes",
  "sort_order": 95,
  "minutes": 3,
  "tags": [
    "content",
    "site"
  ],
  "screens": [
    "/admin/preview",
    "/admin/pages",
    "/admin/visibility"
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
  "title": "Previewing your changes",
  "title_ar": "معاينة تغييراتك",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "The preview shows a page of the site as visitors will see it once your unpublished changes go live. Nothing in the preview is live, and nobody outside the admin can open it."
      },
      {
        "t": "h",
        "x": "Open a preview"
      },
      {
        "t": "ol",
        "x": [
          "Sign in to the admin.",
          "Open the page's address with /admin/preview in front of it: /admin/preview for the home page, /admin/preview/about for About, and /admin/preview/ar/about for its Arabic twin.",
          "Links inside the preview keep you in the preview, so you can move around the site as a visitor would."
        ]
      },
      {
        "t": "h",
        "x": "Reading the ribbon"
      },
      {
        "t": "p",
        "x": "A dark ribbon in the corner says how many unpublished changes you can see. It also says when a change can't be shown, when a page is hidden or open only to people with its link, and when part of a page, such as search results or redirects, isn't previewed."
      },
      {
        "t": "tip",
        "x": "If the ribbon turns red, the preview may be showing the live site instead of your changes. Reload the page. If it stays red, tell whoever runs the site."
      },
      {
        "t": "h",
        "x": "What the preview never does"
      },
      {
        "t": "p",
        "x": "Forms don't send, nothing is counted in the website stats, and the cookie notice doesn't appear. Search engines never see a preview."
      },
      {
        "t": "p",
        "x": "You see the changes in the areas your role can open. A page behind a password shows its password prompt, as visitors see it."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تعرض المعاينة صفحة من الموقع كما سيراها الزوار بعد نشر تغييراتك غير المنشورة. لا شيء في المعاينة منشور، ولا يستطيع أحد خارج لوحة الإدارة فتحها."
      },
      {
        "t": "h",
        "x": "افتح معاينة"
      },
      {
        "t": "ol",
        "x": [
          "سجّل الدخول إلى لوحة الإدارة.",
          "افتح عنوان الصفحة وفي أوله /admin/preview: العنوان /admin/preview للصفحة الرئيسية، و/admin/preview/about لصفحة من نحن، و/admin/preview/ar/about لنسختها العربية.",
          "الروابط داخل المعاينة تبقيك فيها، فتتنقل في الموقع كما يفعل الزائر."
        ]
      },
      {
        "t": "h",
        "x": "قراءة الشريط"
      },
      {
        "t": "p",
        "x": "يوضح شريط داكن في الزاوية عدد التغييرات غير المنشورة التي تراها. ويوضح أيضًا متى يتعذر عرض تغيير، ومتى تكون الصفحة مخفية أو متاحة فقط لمن لديه رابطها، ومتى لا يُعرض جزء من الصفحة في المعاينة مثل نتائج البحث أو التحويلات."
      },
      {
        "t": "tip",
        "x": "إذا تحول الشريط إلى اللون الأحمر، فقد تعرض المعاينة الموقع المنشور بدلًا من تغييراتك. أعد تحميل الصفحة، وإذا بقي أحمر فأخبر المسؤول عن الموقع."
      },
      {
        "t": "h",
        "x": "ما لا تفعله المعاينة أبدًا"
      },
      {
        "t": "p",
        "x": "لا تُرسل النماذج، ولا يُحتسب شيء في إحصاءات الموقع، ولا يظهر إشعار ملفات تعريف الارتباط. ولا ترى محركات البحث أي معاينة."
      },
      {
        "t": "p",
        "x": "ترى التغييرات في الأقسام التي يتيحها دورك. والصفحة المحمية بكلمة مرور تعرض نافذة كلمة المرور كما يراها الزوار."
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
  -- ---- 1. The guide: in the catalog at revision 1 (a new guide), place 95, twelve caps ----
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'previewing-changes' and c.revision = 1 and c.sort_order = 95
                    and cardinality(c.caps) = 12) then
    raise exception '0095: the previewing-changes guide is not in the catalog at revision 1, place 95, with its 12 caps';
  end if;

  -- ---- 2. Every tenant holds it, field for field as the catalog renders it ----------------
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'previewing-changes'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception '0095: tenants without the previewing-changes guide as the catalog holds it: %', v_bad;
  end if;

  -- ---- 3. The set renders it in its place ---------------------------------------------------
  if not exists (select 1 from jsonb_array_elements(app.help_article_set()) e
                  where e->>'slug' = 'previewing-changes' and (e->>'sort_order')::int = 95) then
    raise exception '0095: app.help_article_set() does not list previewing-changes at 95';
  end if;
end $$;
