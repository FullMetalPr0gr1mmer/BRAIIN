-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0105 — Integrations, typed (Admin v2 U11, AV-20). Forward-only: EXPAND, plus one narrowing
-- the deployed Worker tolerates (the staff read of site_integrations, below). Built with the
-- placeholder 0105, kept at the merge train: it sorts above R10's 0104 (check-migrations.mjs).
-- Depends on 0001 (tenants, app.effective_tenant_id), 0009 (public.site_integrations, its
-- triggers), 0011 (the grant regime), 0013 (app.current_role), 0033 (app.live_role), 0038 (the
-- release registry, which this table stays out of), 0069 (H11: the help-guide catalog,
-- app.put_help_guide) and 0097 (C10a: the Sales role and its guide, put again here).
--
-- WHY. site_integrations held four free-form jsonb boxes (ga4, search_console, calendly,
-- recaptcha) that any CMS staff token could read, and a box that takes any JSON takes a
-- secret too. The design (docs/admin-v2/ui.md "Integrations, Forms, Notifications (AV-20)")
-- keeps secrets out of every staff-readable row and gives each integration a typed field;
-- the decisions and every departure are in docs/admin-v2/as-built/U11.md.
--
--   1. app.role_manages_integrations(r): settings.integrations (Admin, SEO), one helper per
--      capability (CLAUDE.md §8), held equal to ROLE_CAPS by tests/authz/sqlHelpers.spec.ts.
--   2. Three typed columns for PUBLIC identifiers, each with a CHECK no markup, no quote and
--      no foreign host can pass (a shape cannot tell a pasted key from a code: the Search
--      Console field says its code is published on the home page, and anon reads that column):
--      ga4_measurement_id (G- and 4 to 15 capitals or
--      digits), search_console_token (the content of Google's verification meta tag: 10 to
--      100 of A-Z a-z 0-9 _ -), calendly_url (https://calendly.com/ and up to three path
--      segments, no query, no fragment, at most 200 characters). The same patterns are
--      packages/schemas/integrations.ts (tests/lib/integrationsSql.spec.ts holds the two
--      equal). No captcha column: the provider is not chosen (owner item O-19), so the
--      screen says Not set up and E8 adds what the chosen provider needs.
--   3. No backfill from the legacy jsonb: the boxes never had a shape. A NOTICE counts the
--      rows that hold any (a count, never a value): the owner reads it at the push, and clears
--      by hand anything secret pasted there before. The jsonb columns stay, granted as before,
--      for the Worker deployed until this slice's own deploy: until then, and until the
--      contract step, Admin and SEO tokens can still read and write them through the API (the
--      residual; this slice's code never does). The contract step is a small migration of its
--      own right after that deploy, not tied to U15 or O-18: it revokes authenticated INSERT
--      and UPDATE, then SELECT, on ga4, search_console, calendly and recaptcha, or drops them.
--   4. Row security, the tenant predicate first everywhere: staff read, insert and update
--      narrowed from every CMS role to Admin + SEO (§5 Integrations: Content Creator and
--      Developer hold none of it; until now only the Worker refused them), TO authenticated;
--      a RESTRICTIVE live check (app.live_role(), read now) so a demoted, deactivated or locked
--      token reads and writes nothing (closes this table's line in the stale-token deviation);
--      and an anon read of the launch tenant's row, TO anon, because the verification code is
--      public by design: the home page's <head> carries it.
--   5. Grants stated for both Supabase grant regimes (P-14): staff by column (every value
--      column, the key and the version; INSERT the key and the values; UPDATE the values; no
--      DELETE, as 0011); the service role SELECT, INSERT, UPDATE, DELETE; anon SELECT on
--      tenant_id and search_console_token only; nothing else for anyone (no TRUNCATE,
--      REFERENCES or TRIGGER; MAINTAIN on 17+). No sequence (the key is the tenant).
--   6. The guides, through H11's catalog: integrations (new, place 62), forms-and-spam (new,
--      place 85), your-account (the bell's settings screen and one line, on U17's text),
--      the-sales-role (the bell's settings are the one setting Sales opens, on C10a's text).
--
-- The narrowing is safe in one push: the deployed Worker reads and writes this row only as
-- Admin or SEO (assertCap, settings.integrations), and a real session's token carries the
-- `sub` app.live_role() needs. No other reader exists: src/, scripts/ and the migrations
-- were searched for every `from('site_integrations')` and every function naming it (the
-- result is in the as-built). Immediate, never staged (P-3): not in app.release_entities.
--
-- Production as of 2026-10-22: PostgreSQL 17.6, one tenant; the ledger holds every migration
-- through 0101, and the merge train pushes U9's 0102, R7's 0103 and R10's 0104, in that order,
-- before this one (none of them touches site_integrations or the four guides put here). CLAUDE.md §3 (Pillar 1), §5 (Integrations), §8 (Admin v2 lanes, UI), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. One helper for the capability ═════════════════════════════════════════════════════
-- `language sql immutable`, so the planner inlines it (0033's helpers). settings.integrations:
-- Admin and SEO (CLAUDE.md §5).
create or replace function app.role_manages_integrations(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'seo'), false) $$;  -- settings.integrations
revoke all on function app.role_manages_integrations(text) from public, anon, authenticated, service_role;
grant execute on function app.role_manages_integrations(text) to authenticated, service_role;

-- ═══ 2. The typed columns ═══════════════════════════════════════════════════════════════════
alter table public.site_integrations
  add column if not exists ga4_measurement_id text,
  add column if not exists search_console_token text,
  add column if not exists calendly_url text;

alter table public.site_integrations drop constraint if exists site_integrations_ga4_shape;
alter table public.site_integrations drop constraint if exists site_integrations_gsc_shape;
alter table public.site_integrations drop constraint if exists site_integrations_calendly_shape;
alter table public.site_integrations
  add constraint site_integrations_ga4_shape
    check (ga4_measurement_id is null or ga4_measurement_id ~ '^G-[A-Z0-9]{4,15}$'),
  add constraint site_integrations_gsc_shape
    check (search_console_token is null or search_console_token ~ '^[A-Za-z0-9_-]{10,100}$'),
  add constraint site_integrations_calendly_shape
    check (calendly_url is null
           or (char_length(calendly_url) <= 200
               and calendly_url ~ '^https://calendly\.com/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,2}/?$'));

comment on column public.site_integrations.ga4_measurement_id is
  'GA4 measurement id (G-…): public once loaded. Stored only until U15 loads it behind analytics consent.';
comment on column public.site_integrations.search_console_token is
  'The content of Google''s verification meta tag: public by design, SeoHead emits it on the home pages. Anon reads this column.';
comment on column public.site_integrations.calendly_url is
  'A https://calendly.com/ booking link: public by design. Stored only; no page shows it yet.';

-- ═══ 3. The legacy boxes: counted, never shown, never copied ═══════════════════════════════
do $$
declare
  n int;
begin
  select count(*) into n
    from public.site_integrations
   where ga4 <> '{}'::jsonb or search_console <> '{}'::jsonb
      or calendly <> '{}'::jsonb or recaptcha <> '{}'::jsonb;
  raise notice 'U11: % site_integrations row(s) hold legacy integration JSON (not shown, not copied; check them before the merge: Admin and SEO can read them until the contract step)', n;
end $$;

-- ═══ 4. Row security (the fence before any grant, 0011 §5) ═══════════════════════════════
-- The token's role opens the door (permissive); the profile's role, read now, must hold it
-- open (RESTRICTIVE). Every USING and WITH CHECK leads with the tenant predicate.
drop policy if exists site_integrations_read on public.site_integrations;
drop policy if exists site_integrations_write on public.site_integrations;
drop policy if exists site_integrations_insert on public.site_integrations;
drop policy if exists site_integrations_update on public.site_integrations;
drop policy if exists site_integrations_live on public.site_integrations;
drop policy if exists site_integrations_public_read on public.site_integrations;

create policy site_integrations_read on public.site_integrations for select to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_integrations(app.current_role()));
create policy site_integrations_insert on public.site_integrations for insert to authenticated
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_integrations(app.current_role()));
create policy site_integrations_update on public.site_integrations for update to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_integrations(app.current_role()))
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_integrations(app.current_role()));
create policy site_integrations_live on public.site_integrations
  as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_integrations((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_integrations((select app.live_role())));
-- The verification code is in the home page's HTML: a visitor may read it, for the tenant the
-- server resolves (the anon fence) and through the one column granted below.
create policy site_integrations_public_read on public.site_integrations for select to anon
  using (tenant_id = app.effective_tenant_id());

-- ═══ 5. Grants (stated, never inherited: both grant regimes) ═══════════════════════════════
-- Revoking a table privilege also revokes it on every column, so each role starts from nothing.
revoke all on public.site_integrations from public, anon, authenticated, service_role;
grant select (tenant_id, ga4_measurement_id, search_console_token, calendly_url,
              ga4, search_console, calendly, recaptcha, version, updated_at)
  on public.site_integrations to authenticated;
grant insert (tenant_id, ga4_measurement_id, search_console_token, calendly_url,
              ga4, search_console, calendly, recaptcha)
  on public.site_integrations to authenticated;
grant update (ga4_measurement_id, search_console_token, calendly_url,
              ga4, search_console, calendly, recaptcha)
  on public.site_integrations to authenticated;
grant select, insert, update, delete on public.site_integrations to service_role;
grant select (tenant_id, search_console_token) on public.site_integrations to anon;

-- ═══ 6. The guides ═══════════════════════════════════════════════════════════════════════════
-- H11's app.put_help_guide (0069), one guide each: the nine keys exactly, at the revision the
-- migrations before this one leave (0 for a new guide). Each put holds its guide to
-- help_articles' CHECKs and re-seeds that one slug into every tenant; a sibling's put of the
-- same guide landing first makes this one stale (55000), never a silent revert.
--   integrations     new, place 62 (after seo-and-redirects, 60): the Integrations screen.
--   forms-and-spam   new, place 85 (between personal-data, 80, and job-applications, 90): the
--                    Forms screen, for settings.general.
--   your-account     revision 2 (U17's 0072 left it there): /admin/settings/notifications among
--                    its screens and one line on the bell's settings.
--   the-sales-role   revision 1 (C10a's 0097 left it there): a Sales account now opens one
--                    setting, the bell's own (Settings › Notifications), so "no setting"
--                    becomes "no site setting" and one line names it, in both languages.
select app.put_help_guide($guide$
{
  "slug": "integrations",
  "sort_order": 62,
  "minutes": 3,
  "tags": ["settings", "seo"],
  "screens": ["/admin/integrations"],
  "caps": ["settings.integrations"],
  "title": "Integrations: Search Console, Analytics and Calendly",
  "title_ar": "الربط بالأدوات: Search Console وAnalytics وCalendly",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Integrations links the site to tools you already use. Nothing here is a password or a secret key, and nothing here is needed for the site to run. Only Admins and the SEO role open this screen, and every change shows in the activity log."
      },
      {
        "t": "h",
        "x": "Google Search Console"
      },
      {
        "t": "ol",
        "x": [
          "In Search Console, add the site and choose the HTML tag method to prove you own it.",
          "Copy the tag it shows. Here, choose Set up on Google Search Console, paste the whole tag or just the code inside content, and choose Save.",
          "The home page, in English and in Arabic, carries the tag at once. Go back to Search Console and press Verify."
        ]
      },
      {
        "t": "tip",
        "x": "Whoever sets this code can claim the site in Search Console and see its search data, so check with the site's owner before you change it."
      },
      {
        "t": "h",
        "x": "Google Analytics 4"
      },
      {
        "t": "p",
        "x": "Save the measurement ID that starts with G-. The site does not load Google Analytics yet. When it does, it will load only for visitors who accept analytics cookies, and the built-in website stats stay the main numbers."
      },
      {
        "t": "h",
        "x": "Calendly"
      },
      {
        "t": "p",
        "x": "Save your booking link, the one that starts with https://calendly.com/. No page shows a booking button yet."
      },
      {
        "t": "h",
        "x": "Captcha"
      },
      {
        "t": "p",
        "x": "Not set up yet: the provider is still to be chosen. Until then the forms are protected by a hidden field that only bots fill in, and by limits on how often one address can send."
      },
      {
        "t": "tip",
        "x": "To take a setting away, open it and choose Remove. You can add it again any time."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تربط شاشة Integrations الموقع بأدوات تستخدمها أصلًا. لا شيء هنا كلمة مرور أو مفتاح سري، ولا شيء هنا ضروري لعمل الموقع. لا يفتح هذه الشاشة إلا المسؤولون (Admin) ودور SEO، ويظهر كل تغيير في سجل النشاط."
      },
      {
        "t": "h",
        "x": "أداة Google Search Console"
      },
      {
        "t": "ol",
        "x": [
          "في Search Console أضف الموقع واختر طريقة وسم HTML لتثبت أنك تملكه.",
          "انسخ الوسم الذي يعرضه. ثم اختر هنا Set up على Google Search Console، والصق الوسم كاملًا أو الرمز الذي داخل content فقط، واختر Save.",
          "تحمل الصفحة الرئيسية بالعربية والإنجليزية الوسم فورًا. ارجع إلى Search Console واضغط Verify."
        ]
      },
      {
        "t": "tip",
        "x": "من يضبط هذا الرمز يستطيع أن يطالب بالموقع في Search Console ويطّلع على بيانات البحث الخاصة به، لذا راجع مالك الموقع قبل أن تغيّره."
      },
      {
        "t": "h",
        "x": "أداة Google Analytics 4"
      },
      {
        "t": "p",
        "x": "احفظ معرّف القياس الذي يبدأ بـ G-. لا يحمّل الموقع Google Analytics بعد. وعندما يفعل، فلن يحمّله إلا للزوار الذين يقبلون ملفات تعريف الارتباط الخاصة بالتحليلات، وتبقى إحصاءات الموقع المدمجة هي الأرقام الأساسية."
      },
      {
        "t": "h",
        "x": "رابط Calendly"
      },
      {
        "t": "p",
        "x": "احفظ رابط الحجز الخاص بك، وهو الذي يبدأ بـ https://calendly.com/. لا تعرض أي صفحة زر حجز بعد."
      },
      {
        "t": "h",
        "x": "التحقق من الزائر (Captcha)"
      },
      {
        "t": "p",
        "x": "غير مُعدّ بعد، فمزوّد الخدمة لم يُختر حتى الآن. وإلى أن يُعدّ تحمي النماذجَ خانةٌ مخفية لا يملؤها إلا الروبوتات، وحدودٌ لعدد المرات التي يرسل فيها العنوان الواحد."
      },
      {
        "t": "tip",
        "x": "لإزالة إعداد افتحه واختر Remove، ويمكنك أن تضيفه من جديد في أي وقت."
      }
    ]
  }
}
$guide$::jsonb, 0);

select app.put_help_guide($guide$
{
  "slug": "forms-and-spam",
  "sort_order": 85,
  "minutes": 3,
  "tags": ["settings", "leads"],
  "screens": ["/admin/forms"],
  "caps": ["settings.general"],
  "title": "Forms and spam protection",
  "title_ar": "النماذج والحماية من الرسائل المزعجة",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Forms shows the two forms on the site, the inquiry form on the home page, the Contact page and the services pages, and the application form on Join: the fields each one asks for and how each one keeps spam out. The fields are fixed. Each one is checked on the server, and contact details are stored encrypted."
      },
      {
        "t": "h",
        "x": "What each form asks for"
      },
      {
        "t": "ol",
        "x": [
          "The inquiry form needs a name, an e-mail and a message. The company, a phone number, the service, the budget, when it is needed and the agreement to be contacted are optional. Not every place asks for all of them: only the services pages ask for a phone number, the Contact page and the services pages for the budget, and only the Contact page for when it is needed.",
          "The Join form needs a name, an e-mail, a phone number, a city, the role, the experience, how the person wants to work, when they could start, a portfolio link, a message and the box that lets you keep the application. The crafts, LinkedIn, the CV and the box for future roles are optional. A CV is a PDF or Word file of up to 10 MB."
        ]
      },
      {
        "t": "h",
        "x": "Keeping spam out"
      },
      {
        "t": "ol",
        "x": [
          "A hidden field is always on. People never see it, and a send that fills it in is not stored.",
          "The inquiry form takes up to 10 sends an hour from one internet address. If that count cannot be checked, the send still goes through, so no inquiry is lost.",
          "The Join form takes up to 5 sends an hour from one internet address and 3 a day from one e-mail. If those counts cannot be checked, the send is refused for now, because it carries a file.",
          "A captcha is not set up yet."
        ]
      },
      {
        "t": "h",
        "x": "Consent on Join"
      },
      {
        "t": "p",
        "x": "Each application stores which version of the consent text the person agreed to. The Join tab shows the version the form uses now."
      },
      {
        "t": "h",
        "x": "Changing the words"
      },
      {
        "t": "p",
        "x": "On the home page, the Contact page, the Services page and Join, the words around each form, such as its heading, are edited with that page, in Pages, by the roles that edit pages. On each service page those words are fixed, and the heading names the service. Admins open and close job applications in General settings."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تعرض شاشة Forms نموذجَي الموقع، نموذج الاستفسار في الصفحة الرئيسية وصفحة التواصل وصفحات الخدمات، ونموذج التقديم في صفحة الانضمام: الحقول التي يطلبها كل منهما، وكيف يصد كل منهما الرسائل المزعجة. الحقول ثابتة، ويُتحقق من كل حقل على الخادم، وتُحفظ بيانات التواصل مشفّرة."
      },
      {
        "t": "h",
        "x": "ما يطلبه كل نموذج"
      },
      {
        "t": "ol",
        "x": [
          "يحتاج نموذج الاستفسار إلى اسم وبريد إلكتروني ورسالة. أما الشركة ورقم الجوال والخدمة والميزانية وموعد الحاجة والموافقة على التواصل فاختيارية. ولا يطلب كل مكان هذه الحقول كلها: صفحات الخدمات وحدها تطلب رقم الجوال، وصفحة التواصل وصفحات الخدمات تطلبان الميزانية، وصفحة التواصل وحدها تطلب موعد الحاجة.",
          "يحتاج نموذج الانضمام إلى اسم وبريد إلكتروني ورقم جوال ومدينة والوظيفة والخبرة وطريقة العمل المفضلة وموعد البدء ورابط أعمال ورسالة، والخانة التي تسمح بحفظ الطلب. أما الحِرف ولينكدإن والسيرة الذاتية وخانة الوظائف المستقبلية فاختيارية. السيرة الذاتية ملف PDF أو Word حتى 10 ميجابايت."
        ]
      },
      {
        "t": "h",
        "x": "صد الرسائل المزعجة"
      },
      {
        "t": "ol",
        "x": [
          "خانة مخفية تعمل دائمًا. لا يراها الناس، وأي إرسال يملؤها لا يُحفظ.",
          "يقبل نموذج الاستفسار حتى 10 إرسالات في الساعة من عنوان إنترنت واحد. وإذا تعذّر التحقق من هذا العدد يمر الإرسال، فلا يضيع أي استفسار.",
          "يقبل نموذج الانضمام حتى 5 إرسالات في الساعة من عنوان إنترنت واحد، و3 في اليوم من بريد إلكتروني واحد. وإذا تعذّر التحقق من هذه الأعداد يُرفض الإرسال مؤقتًا، لأنه يحمل ملفًا.",
          "التحقق من الزائر (Captcha) غير مُعدّ بعد."
        ]
      },
      {
        "t": "h",
        "x": "الموافقة في نموذج الانضمام"
      },
      {
        "t": "p",
        "x": "يحفظ كل طلب نسخة نص الموافقة التي وافق عليها صاحبه. ويعرض تبويب Join النسخة التي يستخدمها النموذج الآن."
      },
      {
        "t": "h",
        "x": "تغيير النصوص"
      },
      {
        "t": "p",
        "x": "في الصفحة الرئيسية وصفحة التواصل وصفحة الخدمات وصفحة الانضمام تُحرَّر النصوص حول كل نموذج، ومنها عنوانه، مع تلك الصفحة في Pages، وذلك للأدوار التي تحرر الصفحات. أما في صفحة كل خدمة فهذه النصوص ثابتة، ويحمل العنوان اسم الخدمة. ويفتح المسؤولون (Admin) التقديم على الوظائف ويغلقونه من General settings."
      }
    ]
  }
}
$guide$::jsonb, 0);

select app.put_help_guide($guide$
{
  "slug": "your-account",
  "sort_order": 20,
  "minutes": 4,
  "tags": [
    "account",
    "basics"
  ],
  "screens": [
    "/admin/account",
    "/admin/notifications",
    "/admin/2fa",
    "/admin/settings/notifications"
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
          "Mark all as read marks what you were shown. Anything that arrives while the list is open stays new.",
          "To choose what it tells you about, open Notifications under Settings. Each kind of news your role gets has its own switch. Turning one off only quiets the bell: everything still shows on its own screen."
        ]
      },
      {
        "t": "h",
        "x": "Two factor authentication (2FA)"
      },
      {
        "t": "ol",
        "x": [
          "With 2FA on, signing in asks for a 6-digit code from an authenticator app on your phone after your password, so a password alone does not get anyone in. To turn it on, open Two factor authentication in your account and choose Set up.",
          "Add the account to your app: type the key the page shows, or, on the phone that has the app, choose Add it to the app. Then type the 6-digit code the app shows and choose Turn on 2FA.",
          "From then on, after your password the admin asks for a code from the app. Five wrong codes within 15 minutes lock your account for 15 minutes, as wrong passwords do.",
          "To turn it off, choose Manage and type a current code. If your team requires 2FA, it stays on."
        ]
      },
      {
        "t": "tip",
        "x": "Lost your phone? Ask an Admin to reset your 2FA in Users & roles. That signs you out on every device, and you can set 2FA up again with your new phone."
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
          "يحدّد Mark all as read ما عُرض عليك كمقروء، وما يصل أثناء فتح القائمة يبقى جديدًا.",
          "لتختار ما يخبرك به، افتح Notifications ضمن Settings. لكل نوع من الأخبار التي يتلقاها دورك مفتاح خاص به. إيقاف أحدها يُسكت الجرس فقط، ويبقى كل شيء ظاهرًا في شاشته."
        ]
      },
      {
        "t": "h",
        "x": "التحقق بخطوتين (2FA)"
      },
      {
        "t": "ol",
        "x": [
          "عند تشغيل 2FA يطلب تسجيل الدخول، بعد كلمة المرور، رمزًا من 6 أرقام من تطبيق مصادقة على هاتفك، فلا تكفي كلمة المرور وحدها لدخول أي شخص. لتشغيله افتح Two factor authentication في حسابك واختر Set up.",
          "أضف الحساب إلى تطبيقك: اكتب المفتاح الذي تعرضه الصفحة، أو اختر Add it to the app على الهاتف الذي يحمل التطبيق. ثم اكتب الرمز المكوّن من 6 أرقام الذي يعرضه التطبيق واختر Turn on 2FA.",
          "بعد ذلك تطلب لوحة الإدارة رمزًا من التطبيق بعد كلمة المرور. خمسة رموز خاطئة خلال 15 دقيقة تقفل حسابك 15 دقيقة، كما تفعل كلمات المرور الخاطئة.",
          "لإيقافه اختر Manage واكتب رمزًا حاليًا. إذا كان فريقك يشترط 2FA فإنه يبقى مفعّلًا."
        ]
      },
      {
        "t": "tip",
        "x": "فقدت هاتفك؟ اطلب من مسؤول (Admin) إعادة ضبط 2FA الخاص بك من Users & roles. يُسجَّل بذلك خروجك من كل جهاز، ثم تستطيع إعداد 2FA من جديد بهاتفك الجديد."
      }
    ]
  }
}
$guide$::jsonb, 2);

select app.put_help_guide($guide$
{
  "slug": "the-sales-role",
  "sort_order": 65,
  "minutes": 2,
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
        "x": "Sales is the role for the people who follow up inquiries. A Sales account works leads and nothing else: it opens no page, site setting, media or job application, and it cannot change anyone's role."
      },
      {
        "t": "h",
        "x": "What Sales can do"
      },
      {
        "t": "ol",
        "x": [
          "See every lead, move it through the stages, assign it, star it, tag it and give it a value, like anyone who works leads.",
          "Reveal one lead's contact details, budget and timeline at a time. Each reveal is logged against the account that made it, up to 60 an hour for each person and 300 an hour for the whole team.",
          "Read and add notes, log a call or a message, and add a lead by hand. Opening a lead's notes is logged too, within a limit of the same size.",
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
          "Erase a lead, or receive a new lead's contact details in a notification. Sales reveals them on the lead's page instead, one lead at a time.",
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
        "x": "دور Sales (المبيعات) مخصّص لمن يتابعون الاستفسارات. يعمل حساب Sales على العملاء المحتملين فقط: لا يفتح الصفحات ولا إعدادات الموقع ولا الوسائط ولا طلبات التوظيف، ولا يستطيع تغيير دور أي شخص."
      },
      {
        "t": "h",
        "x": "ما يستطيعه Sales"
      },
      {
        "t": "ol",
        "x": [
          "يرى كل العملاء المحتملين، وينقلهم عبر المراحل، ويسندهم، ويميّزهم بنجمة، ويضع لهم الوسوم والقيمة، مثل كل من يعمل على العملاء المحتملين.",
          "يكشف بيانات التواصل والميزانية والمدة الزمنية لعميل محتمل واحد في كل مرة. يُسجَّل كل كشف باسم الحساب الذي قام به، بحد أقصى 60 مرة في الساعة لكل شخص و300 مرة في الساعة للفريق كله.",
          "يقرأ الملاحظات ويضيفها، ويسجّل مكالمة أو رسالة، ويضيف عميلًا محتملًا يدويًا. يُسجَّل فتح ملاحظات العميل المحتمل أيضًا، ضمن حد بالحجم نفسه.",
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
          "محو عميل محتمل، أو تلقّي بيانات التواصل لعميل محتمل جديد في إشعار. يكشفها Sales في صفحة العميل المحتمل بدلًا من ذلك، عميلًا واحدًا في كل مرة.",
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
$guide$::jsonb, 1);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, an AND list in one pair; a function's schema printed only when it
-- is not on the search path, so the patterns allow both).
do $$
declare
  v_bad text;
  v_want text[];
  v_got text[];
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  r text;
  pr text;
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  -- ---- 1. RLS enabled and forced ----------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.site_integrations'::regclass) then
    raise exception 'U11: public.site_integrations is not ENABLE + FORCE row level security';
  end if;

  -- ---- 2. The exact policy set ------------------------------------------------------------
  v_want := array[
    'site_integrations_insert INSERT PERMISSIVE {authenticated}',
    'site_integrations_live ALL RESTRICTIVE {authenticated}',
    'site_integrations_public_read SELECT PERMISSIVE {anon}',
    'site_integrations_read SELECT PERMISSIVE {authenticated}',
    'site_integrations_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                   order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'site_integrations';
  if v_got is distinct from v_want then
    raise exception 'U11: site_integrations policies are %, expected %', v_got, v_want;
  end if;

  -- ---- 3. The tenant predicate is the first conjunct of every USING and WITH CHECK ---------
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'site_integrations'
     and ((qual is not null and qual !~ v_tenant_first)
          or (with_check is not null and with_check !~ v_tenant_first)
          or coalesce(qual, with_check) is null);
  if v_bad is not null then
    raise exception 'U11: site_integrations policies that do not lead with the tenant predicate: %', v_bad;
  end if;

  -- ---- 4. What each policy asks after the tenant ------------------------------------------
  -- The JWT layer: the helper on the token's role (printed app."current_role"(): a keyword, so
  -- quoted). The live layer: the helper on the profile's role, read now, in USING and WITH
  -- CHECK. The anon read: the tenant alone.
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'site_integrations'
     and policyname in ('site_integrations_read', 'site_integrations_insert', 'site_integrations_update')
     and ((qual is not null
           and qual !~ ('^\(' || v_tenant || ' AND (app\.)?role_manages_integrations\((app\.)?"?current_role"?\(\)\)\)$'))
          or (with_check is not null
              and with_check !~ ('^\(' || v_tenant || ' AND (app\.)?role_manages_integrations\((app\.)?"?current_role"?\(\)\)\)$')));
  if v_bad is not null then
    raise exception 'U11: policies that do not ask for settings.integrations on the token: %', v_bad;
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'site_integrations'
         and policyname = 'site_integrations_live'
         and qual ~ 'role_manages_integrations\(\( SELECT (app\.)?live_role\(\)'
         and with_check ~ 'role_manages_integrations\(\( SELECT (app\.)?live_role\(\)') <> 1 then
    raise exception 'U11: site_integrations_live does not check the live role in USING and WITH CHECK';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'site_integrations'
         and policyname = 'site_integrations_public_read'
         and qual ~ ('^' || v_tenant || '$') and with_check is null) <> 1 then
    raise exception 'U11: site_integrations_public_read is not the tenant predicate alone';
  end if;

  -- ---- 5. The helper: Admin and SEO, not a definer, inlinable, two callers ------------------
  if not (app.role_manages_integrations('admin') and app.role_manages_integrations('seo')
          and not app.role_manages_integrations('content_creator')
          and not app.role_manages_integrations('developer')
          and not app.role_manages_integrations('sales')
          and not app.role_manages_integrations(null)) then
    raise exception 'U11: app.role_manages_integrations does not answer settings.integrations';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.role_manages_integrations(text)'::regprocedure
                    and f.provolatile = 'i' and not f.prosecdef) then
    raise exception 'U11: app.role_manages_integrations must be IMMUTABLE and not SECURITY DEFINER';
  end if;
  if not has_function_privilege('authenticated', 'app.role_manages_integrations(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_manages_integrations(text)', 'execute')
     or has_function_privilege('anon', 'app.role_manages_integrations(text)', 'execute')
     or has_function_privilege('public', 'app.role_manages_integrations(text)', 'execute') then
    raise exception 'U11: app.role_manages_integrations must be executable by authenticated and service_role only';
  end if;

  -- ---- 6. Table privileges, exactly ---------------------------------------------------------
  -- PUBLIC, anon and authenticated hold no table-level privilege (anon and staff go by column);
  -- the service role exactly SELECT, INSERT, UPDATE, DELETE. Nobody TRUNCATE, REFERENCES,
  -- TRIGGER, nor MAINTAIN on 17+ (CASE, not AND: the word is refused before 17; CI runs 15).
  foreach r in array array['public', 'anon', 'authenticated'] loop
    if has_table_privilege(r::name, 'public.site_integrations',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when v_maintain
                then has_table_privilege(r::name, 'public.site_integrations', 'maintain')
                else false end) then
      raise exception 'U11: % holds a table privilege on public.site_integrations', r;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.site_integrations', pr) then
      raise exception 'U11: service_role lacks % on public.site_integrations', pr;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.site_integrations', 'truncate, references, trigger')
     or (case when v_maintain
              then has_table_privilege('service_role', 'public.site_integrations', 'maintain')
              else false end) then
    raise exception 'U11: service_role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.site_integrations';
  end if;

  -- ---- 7. Column privileges, exactly --------------------------------------------------------
  -- Each column list is compared whole (what must hold and what must not, at once).
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['search_console_token', 'tenant_id'] then
    raise exception 'U11: anon''s SELECT columns on site_integrations are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.site_integrations', 'insert, update, references')
     or has_any_column_privilege('public', 'public.site_integrations',
                                 'select, insert, update, references') then
    raise exception 'U11: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['calendly', 'calendly_url', 'ga4', 'ga4_measurement_id', 'recaptcha',
                                  'search_console', 'search_console_token', 'tenant_id',
                                  'updated_at', 'version'] then
    raise exception 'U11: authenticated''s SELECT columns on site_integrations are %', v_got;
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert');
  if v_got is distinct from array['calendly', 'calendly_url', 'ga4', 'ga4_measurement_id', 'recaptcha',
                                  'search_console', 'search_console_token', 'tenant_id'] then
    raise exception 'U11: authenticated''s INSERT columns on site_integrations are %', v_got;
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from array['calendly', 'calendly_url', 'ga4', 'ga4_measurement_id', 'recaptcha',
                                  'search_console', 'search_console_token'] then
    raise exception 'U11: authenticated''s UPDATE columns on site_integrations are %', v_got;
  end if;
  if has_any_column_privilege('authenticated', 'public.site_integrations', 'references') then
    raise exception 'U11: authenticated holds REFERENCES on a site_integrations column';
  end if;

  -- ---- 8. The three CHECKs exist, are validated, and say what they mean ---------------------
  select array_agg(c.conname::text order by c.conname::text collate "C") into v_got
    from pg_constraint c
   where c.conrelid = 'public.site_integrations'::regclass and c.contype = 'c' and c.convalidated
     and c.conname in ('site_integrations_ga4_shape', 'site_integrations_gsc_shape',
                       'site_integrations_calendly_shape');
  if v_got is distinct from array['site_integrations_calendly_shape', 'site_integrations_ga4_shape',
                                  'site_integrations_gsc_shape'] then
    raise exception 'U11: the site_integrations CHECKs are %', v_got;
  end if;
  -- The patterns, evaluated (a CHECK that admits everything would pass the names above).
  if not ('G-ABC123XYZ' ~ '^G-[A-Z0-9]{4,15}$') or 'g-abc123' ~ '^G-[A-Z0-9]{4,15}$'
     or 'UA-12345-1' ~ '^G-[A-Z0-9]{4,15}$'
     or not ('abcDEF012_-xyz' ~ '^[A-Za-z0-9_-]{10,100}$')
     or 'abc"def<ghi>' ~ '^[A-Za-z0-9_-]{10,100}$' or 'short' ~ '^[A-Za-z0-9_-]{10,100}$'
     or not ('https://calendly.com/studio/30min'
             ~ '^https://calendly\.com/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,2}/?$')
     or 'https://calendly.com.evil.example/x'
        ~ '^https://calendly\.com/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,2}/?$'
     or 'http://calendly.com/x' ~ '^https://calendly\.com/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,2}/?$'
     or 'https://calendly.com/x?y=1'
        ~ '^https://calendly\.com/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,2}/?$' then
    raise exception 'U11: an integration pattern admits a value it must refuse, or refuses a good one';
  end if;
  select string_agg(c.conname, ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'public.site_integrations'::regclass and c.contype = 'c'
     and ((c.conname = 'site_integrations_ga4_shape'
           and pg_get_constraintdef(c.oid) !~ 'G-\[A-Z0-9\]\{4,15\}\$')
       or (c.conname = 'site_integrations_gsc_shape'
           and pg_get_constraintdef(c.oid) !~ '\[A-Za-z0-9_-\]\{10,100\}\$')
       or (c.conname = 'site_integrations_calendly_shape'
           and (pg_get_constraintdef(c.oid) !~ 'https://calendly'
                or pg_get_constraintdef(c.oid) !~ '<= 200')));
  if v_bad is not null then
    raise exception 'U11: CHECKs whose pattern is not the one this file states: %', v_bad;
  end if;

  -- ---- 9. Immediate, never staged (P-3), and releases still off --------------------------
  if exists (select 1 from app.release_entities e where e.table_name = 'site_integrations') then
    raise exception 'U11: site_integrations must not be in the release registry (immediate, P-3)';
  end if;
  if exists (select 1 from app.release_tenants) then
    raise exception 'U11: releases must stay switched off (app.release_tenants is not empty)';
  end if;

  -- ---- 10. The guides: in the catalog at the revision this file leaves, in their places, and
  -- every tenant holds each, field for field as the catalog renders it ------------------------
  v_want := array['forms-and-spam 1 85', 'integrations 1 62', 'the-sales-role 2 65',
                   'your-account 3 20'];
  select array_agg(format('%s %s %s', c.slug, c.revision, c.sort_order) order by c.slug collate "C")
    into v_got
    from app.help_guide_catalog c
   where c.slug in ('integrations', 'forms-and-spam', 'your-account', 'the-sales-role');
  if v_got is distinct from v_want then
    raise exception 'U11: the catalog holds %, expected %', v_got, v_want;
  end if;
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'your-account'
                    and '/admin/settings/notifications' = any (c.screens)) then
    raise exception 'U11: your-account does not name /admin/settings/notifications';
  end if;
  select string_agg(format('%s/%s', t.id, g.slug), ', ') into v_bad
    from public.tenants t
    cross join (values ('integrations'), ('forms-and-spam'), ('your-account'),
                       ('the-sales-role')) as g(slug)
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = g.slug
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'U11: tenants without a guide as the catalog holds it: %', v_bad;
  end if;
end $$;
