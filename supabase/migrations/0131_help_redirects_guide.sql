-- ─────────────────────────────────────────────────────────────────────────────────────────
-- R14c (Admin v2, the required e2e job in release mode, at the owner's go of 2026-11-13) — the
-- seo-and-redirects guide's redirect timing, for both ways of publishing. Forward-only and EXPAND
-- only: one guide changes through H11's catalog (app.put_help_guide, 0069); nothing else.
--
-- The number is a placeholder: production and main hold 0001 to 0130, so this is 0131. The HELD
-- CRM chain (#143 to #155, migrations 0131 to 0141, not on main) renumbers at its merge with
-- scripts/renumber-migration.mjs, to the next free numbers above main's highest; none of its
-- files puts this guide, so the revision named below does not race. Inside the SQL the slice is
-- named, never the number.
--
-- Why (as-built R14F, "For R14c's copy"): the guide said "A rule takes effect within a minute of
-- saving", true only while releases are off. Once publishing in releases is switched on (launch
-- runbook §6p) a redirect is staged like any registry row (the registry's `redirect` entry) and
-- the edge map is rebuilt when it is published, so a rule takes effect within a minute of being
-- published. The sentence now says both, with the same words the form's help uses
-- (src/lib/admin/ui/redirects.ts; tests/lib/helpCentre.spec.ts holds the two). Every other word,
-- its place (60), screens and capabilities are unchanged; revision 2 (0073's put) moves to 3.
-- The literal is docs/admin-v2/guides/seo-and-redirects.json verbatim.
--
-- No table, function, grant or policy is created or changed, so there is no privilege to state;
-- the put re-seeds its one slug into every tenant and touches no other guide.
-- ─────────────────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

select app.put_help_guide($guide$
{
  "slug": "seo-and-redirects",
  "sort_order": 60,
  "minutes": 5,
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
  "title": "SEO, share images and redirects",
  "title_ar": "SEO وصور المشاركة وإعادة التوجيه",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "The SEO screen has three tabs. Pages lists every page, service, project and post with what search engines and social sites see for it. Redirects keeps old links working. Site wide holds the defaults every page starts from."
      },
      {
        "t": "h",
        "x": "Pages"
      },
      {
        "t": "p",
        "x": "Each row says, for the title and the description, whether the page has words of its own (Custom) or uses its default (Default), whether search engines may index it, and whether its Arabic is complete. Choose Edit SEO on a row to open its panel."
      },
      {
        "t": "p",
        "x": "An empty box keeps the page’s default, which the box shows in grey. A title or a description written in one language needs the other too. A title works best at 50 to 60 characters and a description at 150 to 160; the boxes stop at 120 and 320."
      },
      {
        "t": "p",
        "x": "The share image is a picture from the media library, shown when the page is shared. Without one, the page’s own image is used (a service’s poster, a project’s banner, a post’s cover), then the site’s default share image, then the built-in logo card. It is sent as a JPEG at most 1,200 pixels wide, in the picture’s own shape."
      },
      {
        "t": "p",
        "x": "Let search engines index this page stays on unless you hide the page. Turning it off asks first: search engines stop showing the page and it leaves the sitemap, but people with the link can still open it. Until you choose, the page follows the site default."
      },
      {
        "t": "p",
        "x": "Under Advanced you can name another address on this site that search engines should index instead, such as /services/logo. The Arabic page follows on its own. Leave it empty for almost every page: a page pointing elsewhere also leaves the sitemap."
      },
      {
        "t": "p",
        "x": "The two previews show the search result in English and in Arabic, with the site’s title template, as you type."
      },
      {
        "t": "h",
        "x": "Redirects"
      },
      {
        "t": "p",
        "x": "A redirect sends visitors and search engines from an old address to a new one, so links shared before a rename keep working. Add or edit one in its panel. The list says whether the live site has every rule, and Sync to edge sends them again."
      },
      {
        "t": "ol",
        "x": [
          "From is the old path, such as /old-page. A path that still shows a page is refused: a redirect only covers addresses that would otherwise find nothing.",
          "To is where it leads: a path on this site or a full https:// address. Point at the final address, because a redirect to another redirect is refused.",
          "301 is a permanent move and 302 a temporary one. 308 is permanent too, for addresses that receive forms.",
          "A rule takes effect within a minute of saving until publishing in releases is switched on for your site; once it is, within a minute of being published. A rule for an English path also covers its Arabic twin under /ar."
        ]
      },
      {
        "t": "h",
        "x": "Site wide"
      },
      {
        "t": "p",
        "x": "The title template places a page’s title in every tab and search result: %s is the page’s title and %brand% the studio’s name, as in %brand% | %s. The default title and description are used only by a page with no words of its own, and the default share image only by a page with no image."
      },
      {
        "t": "p",
        "x": "Search engines can be kept away from the whole site. Because that hides every page, the save asks you to type noindex first."
      },
      {
        "t": "p",
        "x": "Built in lists what the site does on its own: the sitemap and llms.txt, read from what is published at most an hour behind; English and Arabic pages pointing to each other; each language naming itself; the crawler rules; and the structured data, checked on every change."
      },
      {
        "t": "tip",
        "x": "Browsers can remember a permanent redirect for up to a day. If you are not sure a move is final, start with 302: it can be changed or removed at once."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "لشاشة SEO ثلاث علامات تبويب. تعرض Pages كل صفحة وخدمة ومشروع ومقال مع ما تراه محركات البحث ومواقع التواصل لكل منها. وتُبقي Redirects الروابط القديمة صالحة. وتضم Site wide الإعدادات الافتراضية التي تبدأ منها كل صفحة."
      },
      {
        "t": "h",
        "x": "الصفحات"
      },
      {
        "t": "p",
        "x": "يوضح كل صف، للعنوان وللوصف، إن كانت للصفحة كلماتها الخاصة (Custom) أو تستخدم نصها الافتراضي (Default)، وإن كان مسموحًا لمحركات البحث بفهرستها، وإن كان نصها العربي مكتملًا. اختر Edit SEO في الصف لفتح لوحته."
      },
      {
        "t": "p",
        "x": "الحقل الفارغ يُبقي النص الافتراضي للصفحة، ويعرضه الحقل باللون الرمادي. العنوان أو الوصف المكتوب بلغة يحتاج إلى اللغة الأخرى أيضًا. يعمل العنوان بأفضل شكل بين 50 و60 حرفًا والوصف بين 150 و160، ويتوقف الحقلان عند 120 و320."
      },
      {
        "t": "p",
        "x": "صورة المشاركة صورة من مكتبة الوسائط تظهر عند مشاركة الصفحة. وإن لم تُختر، تُستخدم صورة الصفحة نفسها (ملصق الخدمة أو لافتة المشروع أو غلاف المقال)، ثم صورة المشاركة الافتراضية للموقع، ثم بطاقة الشعار المدمجة. وتُرسل بصيغة JPEG بعرض 1,200 بكسل على الأكثر، وبشكل الصورة الأصلي."
      },
      {
        "t": "p",
        "x": "يبقى خيار Let search engines index this page مفعّلًا ما لم تُخفِ الصفحة. ويطلب إيقافه تأكيدًا أولًا: تتوقف محركات البحث عن عرض الصفحة وتخرج من خريطة الموقع، لكن من يملك الرابط يستطيع فتحها. وإلى أن تختار، تتبع الصفحة الإعداد الافتراضي للموقع."
      },
      {
        "t": "p",
        "x": "ضمن Advanced يمكنك تسمية عنوان آخر في هذا الموقع تفهرسه محركات البحث بدلًا من الصفحة، مثل /services/logo. وتتبعه الصفحة العربية تلقائيًا. اتركه فارغًا لمعظم الصفحات: فالصفحة التي تشير إلى عنوان آخر تخرج أيضًا من خريطة الموقع."
      },
      {
        "t": "p",
        "x": "تعرض المعاينتان نتيجة البحث بالإنجليزية وبالعربية، مع قالب عنوان الموقع، أثناء الكتابة."
      },
      {
        "t": "h",
        "x": "إعادة التوجيه"
      },
      {
        "t": "p",
        "x": "تنقل إعادة التوجيه الزوار ومحركات البحث من عنوان قديم إلى عنوان جديد، فتبقى الروابط التي تمت مشاركتها قبل تغيير الاسم صالحة. أضف قاعدة أو عدّلها في لوحتها. وتوضح القائمة إن كان الموقع المباشر يملك كل القواعد، ويعيد Sync to edge إرسالها."
      },
      {
        "t": "ol",
        "x": [
          "From هو المسار القديم، مثل /old-page. يُرفض المسار الذي ما زال يعرض صفحة، فإعادة التوجيه تغطي فقط العناوين التي لن تجد شيئًا بدونها.",
          "To هو الوجهة: مسار في هذا الموقع أو عنوان كامل يبدأ بـ https://. وجّهها إلى العنوان النهائي، لأن إعادة التوجيه إلى إعادة توجيه أخرى تُرفض.",
          "301 نقل دائم و302 نقل مؤقت، و308 نقل دائم أيضًا للعناوين التي تستقبل النماذج.",
          "إلى أن يُفعَّل النشر عبر الإصدارات لموقعك، تسري القاعدة خلال دقيقة من الحفظ؛ وبعد تفعيله، تسري خلال دقيقة من نشرها. والقاعدة الخاصة بمسار إنجليزي تشمل نظيره العربي تحت /ar."
        ]
      },
      {
        "t": "h",
        "x": "على مستوى الموقع"
      },
      {
        "t": "p",
        "x": "يضع قالب العنوان عنوان الصفحة في كل تبويب وكل نتيجة بحث: %s هو عنوان الصفحة و%brand% اسم الاستوديو، كما في %brand% | %s. ولا يُستخدم العنوان والوصف الافتراضيان إلا لصفحة ليست لها كلماتها الخاصة، ولا تُستخدم صورة المشاركة الافتراضية إلا لصفحة بلا صورة."
      },
      {
        "t": "p",
        "x": "يمكن إبعاد محركات البحث عن الموقع كله. ولأن ذلك يخفي كل الصفحات، يطلب الحفظ أن تكتب noindex أولًا."
      },
      {
        "t": "p",
        "x": "تعرض Built in ما يفعله الموقع من تلقاء نفسه: خريطة الموقع وllms.txt، وتُقرآن مما هو منشور بتأخير لا يتجاوز ساعة؛ وصفحات إنجليزية وعربية تشير كل منها إلى الأخرى؛ وكل لغة تسمي نفسها؛ وقواعد برامج الزحف؛ والبيانات المنظمة التي تُفحص مع كل تغيير."
      },
      {
        "t": "tip",
        "x": "قد تتذكر المتصفحات إعادة التوجيه الدائمة حتى يوم كامل. إن لم تكن متأكدًا من أن النقل نهائي فابدأ بـ 302، إذ يمكن تغييرها أو حذفها فورًا."
      }
    ]
  }
}
$guide$::jsonb, 2);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  -- ---- 1. The guide: in the catalog at revision 3, place 60, both modes' redirect timing ----
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'seo-and-redirects' and c.revision = 3 and c.sort_order = 60
                    and c.caps = array['seo.globalDefaults', 'redirects.manage']
                    and c.body::text like '%within a minute of saving until publishing in releases is switched on%'
                    and c.body::text like '%within a minute of being published%') then
    raise exception 'R14c: seo-and-redirects is not at revision 3, place 60, with both modes'' redirect timing';
  end if;

  -- ---- 2. Every tenant holds it, field for field as the catalog renders it ----------------
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'seo-and-redirects'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'R14c: tenants without the catalog''s seo-and-redirects: %', v_bad;
  end if;
end $$;
