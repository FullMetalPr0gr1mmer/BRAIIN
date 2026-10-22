-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0101 — Job applications and the Style-Finder on the kit, and the editors' tabs (Admin v2 U8,
-- the folded U8a + U8b PR): the help guides only. Forward-only and EXPAND only: no table, no
-- column, no policy, no grant and no function changes; two guides go through H11's catalog
-- (0069) and nothing else is written. The number is a placeholder: it is assigned at merge
-- (scripts/renumber-migration.mjs). Depends on 0046 (help_articles), 0055/0068 (the last
-- restatement, job-applications as the catalog was filled) and 0069 (the catalog's put).
--
-- The design is docs/admin-v2/ui.md "Creative Knowledge, Style-Finder and Job applications
-- (AV-17)", as the Wave 3 U8 brief decides it (D8); the departures are in
-- docs/admin-v2/as-built/U8.md. U8b (the tabbed and read-only editors) needs no SQL: the post
-- editor stays under saving-and-publishing, whose words are still true.
--
--   1. style-finder: a NEW guide (revision 0), for the three Style-Finder screens
--      (/admin/ai-questions, /admin/ai-styles, /admin/ai-config) and the roles that open them
--      (ai.editContent: Admin and Content Creator; ai.config: Admin). Its place is 115, free
--      in the catalog (45, 65, 75, 95 and 125 are taken by slices in flight; 115 sits beside
--      website-stats, the other Growth screen). It says, truthfully, that the quiz is not on
--      the site yet: /api/ai/style-finder is the 501 stub, nothing reads ai_config, and the
--      limits are the code's constants (60 an hour per address, 20 per visitor;
--      tests/lib/helpCentre.spec.ts holds the numbers to src/lib/ai/rateLimit.ts).
--   2. job-applications: its first step rewritten for the drawer (opening one is recorded;
--      the contact details stay hidden until revealed), at revision 1, as the catalog was
--      filled. Slug, place, caps, screens, title and every other sentence unchanged.
--
-- Each literal is the file under docs/admin-v2/guides/ verbatim (the spec holds them equal).
-- A put re-seeds that one guide into every tenant and touches no other; a stale revision is
-- refused (55000), so a sibling that changes either guide first makes this fail until it is
-- re-based. Postconditions check both guides in the catalog and in every tenant.

set local lock_timeout = '5s';

-- ═══ 1. style-finder (new) ════════════════════════════════════════════════════════════════
select app.put_help_guide($guide$
{
  "slug": "style-finder",
  "sort_order": 115,
  "minutes": 2,
  "tags": [
    "growth"
  ],
  "screens": [
    "/admin/ai-questions",
    "/admin/ai-styles",
    "/admin/ai-config"
  ],
  "caps": [
    "ai.editContent",
    "ai.config"
  ],
  "title": "Style-Finder",
  "title_ar": "أداة Style-Finder",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "The Style-Finder is a short quiz that will suggest a style to visitors. It is not on the site yet: what you write here is saved and waits for the quiz, and publishing a question or a style shows it nowhere."
      },
      {
        "t": "h",
        "x": "Questions and styles"
      },
      {
        "t": "ol",
        "x": [
          "Questions: the prompt in both languages, how visitors answer (one choice, several, a scale or their own words) and, for choices, up to 20 options.",
          "Styles: a result a visitor can be given, with its name and description in both languages.",
          "Move up and Move down in the list set the order. Only an Admin can delete."
        ]
      },
      {
        "t": "h",
        "x": "Results & logic"
      },
      {
        "t": "p",
        "x": "Only an Admin sees this tab. It holds the daily spend cap, the hourly limits, the model and the instructions the quiz will run with. None of it is read yet: until the quiz ships every request to it is turned away, nothing is spent, and the limits are fixed at 60 an hour per address and 20 per visitor."
      },
      {
        "t": "tip",
        "x": "The key for the AI service is never stored here. It is a secret on the server, out of the admin’s reach."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "أداة Style-Finder اختبار قصير سيقترح على الزوار أسلوبًا يناسبهم. وهي ليست على الموقع بعد: ما تكتبه هنا يُحفظ وينتظر الاختبار، ونشر سؤال أو أسلوب لا يُظهره في أي مكان."
      },
      {
        "t": "h",
        "x": "الأسئلة والأساليب"
      },
      {
        "t": "ol",
        "x": [
          "الأسئلة (Questions): نص السؤال باللغتين، وطريقة إجابة الزائر (خيار واحد، أو عدة خيارات، أو مقياس، أو بكلماته)، وللخيارات حتى 20 خيارًا.",
          "الأساليب (Styles): نتيجة قد يحصل عليها الزائر، باسمها ووصفها باللغتين.",
          "يحدد Move up وMove down في القائمة الترتيب. والحذف للمسؤول (Admin) فقط."
        ]
      },
      {
        "t": "h",
        "x": "النتائج والمنطق (Results & logic)"
      },
      {
        "t": "p",
        "x": "لا يرى هذا التبويب إلا المسؤول (Admin). وفيه الحد الأقصى للإنفاق اليومي، والحدود في الساعة، والنموذج، والتعليمات التي سيعمل بها الاختبار. ولا يُقرأ شيء منها بعد: فإلى أن يُطلق الاختبار يُرفض كل طلب إليه، ولا يُنفق شيء، وتبقى الحدود ثابتة عند 60 في الساعة لكل عنوان و20 لكل زائر."
      },
      {
        "t": "tip",
        "x": "لا يُحفظ مفتاح خدمة الذكاء الاصطناعي هنا أبدًا. فهو سرٌّ على الخادم، بعيد عن متناول لوحة الإدارة."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- ═══ 2. job-applications (the first step, for the drawer) ═════════════════════════════════
select app.put_help_guide($guide$
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
          "Open an application to read it, and set its status as you review it. Opening one is recorded in the activity log; its contact details stay hidden until you reveal them.",
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
          "افتح الطلب لقراءته، وحدّد حالته أثناء مراجعته. ويُسجَّل فتحه في سجل النشاط، وتبقى بيانات التواصل مخفية حتى تُظهرها.",
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
}
$guide$::jsonb, 1);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  -- ---- 1. style-finder: in the catalog at revision 1, its caps and screens exact ----------
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'style-finder' and revision = 1 and sort_order = 115
                    and title = 'Style-Finder'
                    and caps = array['ai.editContent', 'ai.config']
                    and screens = array['/admin/ai-questions', '/admin/ai-styles', '/admin/ai-config']) then
    raise exception '0101: the catalog must hold style-finder (revision 1, place 115) for the three Style-Finder screens';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'style-finder'
                        and h.title = 'Style-Finder'
                        and h.caps = array['ai.editContent', 'ai.config']);
  if v_bad is not null then
    raise exception '0101: tenants without the style-finder guide: %', v_bad;
  end if;

  -- ---- 2. job-applications: revision 2, the drawer's first step, nothing else moved -------
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'job-applications' and revision = 2 and sort_order = 90
                    and title = 'Job applications'
                    and caps = array['applications.manage']
                    and screens = array['/admin/applications']
                    and body -> 'en' -> 1 -> 'x' ->> 0 like 'Open an application to read it,%') then
    raise exception '0101: the catalog must hold job-applications at revision 2 with the drawer''s first step';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'job-applications'
                        and h.body -> 'en' -> 1 -> 'x' ->> 0 like 'Open an application to read it,%');
  if v_bad is not null then
    raise exception '0101: tenants without the reworded job-applications guide: %', v_bad;
  end if;

  -- ---- 3. no API role gained anything on the help machinery -------------------------------
  if has_function_privilege('anon', 'app.help_article_set()', 'execute')
     or has_function_privilege('authenticated', 'app.help_article_set()', 'execute')
     or has_function_privilege('service_role', 'app.help_article_set()', 'execute')
     or has_function_privilege('anon', 'app.seed_help_articles(uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.seed_help_articles(uuid)', 'execute')
     or has_function_privilege('service_role', 'app.seed_help_articles(uuid)', 'execute')
     or has_table_privilege('authenticated', 'app.help_guide_catalog', 'select')
     or has_table_privilege('anon', 'app.help_guide_catalog', 'select') then
    raise exception '0101: an API role may read the help set, the catalog or seed guides';
  end if;
end $$;
