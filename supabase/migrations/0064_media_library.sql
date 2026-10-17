-- ─────────────────────────────────────────────────────────────────────────────
-- 0064 — The media library's list (Admin v2 U4, AV-12). Forward-only, expand only.
-- Depends on 0001 (media_assets, app.is_staff), 0006 (app.normalize_ar_q), 0011 (the app
-- schema's grants: authenticated executes both helpers), 0045 (U3: display_name, the
-- `storage` provider, mime_type and size_bytes), 0046 (the help centre) and 0061 (U14b: the
-- guides as it left them, U1's 0060 and every earlier restatement included).
--
-- /admin/media becomes one island: a grid of pictures with a real search, an Images |
-- Videos switch, a "Needs alt text" filter and server paging. The kernel's list (GET
-- /api/admin/media) searches one column, the storage path, which for an upload is a random
-- key. What the database adds:
--
--   • public.media_library(p_tenant, p_q, p_kind, p_needs_alt, p_limit, p_offset): the
--     library's one list door. SECURITY INVOKER, so media_assets' own RLS (media_read: the
--     tenant and app.is_staff()) still decides the rows; on top of it, an empty answer unless
--     the caller is staff (a belt, so the first non-staff authenticated principal reads
--     nothing here even where media_assets_public_read would show it rows) and the tenant
--     named is the token's. A "contains" search over the display name, the alt text in both
--     languages, the tags, the folder and, for anything but an upload, the stored path (a
--     still's file name); never an upload's random key, which a two-character query would
--     match everywhere. Folded with app.normalize_ar_q on both sides (§8: the tashkeel,
--     alef and ة the rest of the admin folds), `\`, `%` and `_` escaped, at most 64
--     printable characters, ignored below 2 once folded (an editor typing one letter keeps
--     the list). 1 to 100 rows a page, an offset of at most 10,000, and the total counted
--     apart from the page, so a page past the end still says how many there are. The
--     columns are the media resource's list columns plus mime_type; never provider_ref or
--     stream_uid. 22023 for a query, a kind, a limit or an offset out of bounds.
--     Computed per row, no stored column: a library holds hundreds of rows, and the 500 ms
--     statement timeout is the bound. A stored search_text is a later expand if it grows.
--   • app.help_article_set() restated from 0061's text (U14b, the set on main before this one)
--     and seeded into every tenant: the media-library guide rewritten for the library as it
--     now is (upload, describe, replace, Used in, the filter, the videos). Every other guide
--     is 0061's, byte for byte.
--
-- P-14: the function's EXECUTE is revoked from PUBLIC, anon, authenticated and the service
-- role, then granted to authenticated alone (the Worker calls it with the editor's own
-- client; nothing calls it as the service role). No table, no column, no policy, no
-- capability (§5 "Media — upload / edit metadata" already decides who reads the library),
-- and no grant on media_assets changes. Media is immediate (P-3): no release registry row.
--
-- Production as of 2026-10-18: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046,
-- 0048, 0050-0052, 0054-0057, 0060 and 0061 (0062, R3a, and 0063, C4a, restate no guide).
-- Grants are stated for both Supabase privilege regimes (README P-14). CLAUDE.md §3 (Pillar 1), §5, §8.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0061): the reseed writes
-- public.help_articles. A statement below that waits more than five seconds for a lock
-- raises instead, the whole migration rolls back, and the push is retried later.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. The library's list --------------------------------------------------------------
create or replace function public.media_library(
  p_tenant    uuid,
  p_q         text,
  p_kind      text,
  p_needs_alt boolean,
  p_limit     int,
  p_offset    int)
  returns jsonb
  language plpgsql stable security invoker
  set search_path = '' set statement_timeout = '500ms' as $$
declare
  v_folded text;
  v_needle text;
  v_total bigint;
  v_rows jsonb;
begin
  -- The bounds, before anything is read: the same class of control characters help_search
  -- refuses (C0, DEL and C1), and the four kinds the table holds.
  if p_q is not null and (char_length(p_q) > 64 or p_q ~ '[\u0001-\u001F\u007F-\u009F]') then
    raise exception using errcode = '22023',
      message = 'media_library: a query is at most 64 printable characters';
  end if;
  if p_kind is not null and p_kind not in ('image', 'video', 'audio', 'pdf') then
    raise exception using errcode = '22023',
      message = 'media_library: a kind is image, video, audio or pdf';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'media_library: a page is 1 to 100 rows';
  end if;
  if p_offset is null or p_offset not between 0 and 10000 then
    raise exception using errcode = '22023', message = 'media_library: an offset is 0 to 10000';
  end if;

  -- Empty, never an error: another tenant named, or a caller who is not staff.
  if p_tenant is distinct from app.effective_tenant_id() or not app.is_staff() then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb);
  end if;

  -- Folded like the text it is compared with; the two-character floor is counted on what the
  -- fold leaves, and below it there is no search filter at all.
  v_folded := btrim(lower(app.normalize_ar_q(coalesce(p_q, ''))));
  if char_length(v_folded) >= 2 then
    -- Escaped: a % or _ in the query is a character.
    v_needle := replace(replace(replace(v_folded, '\', '\\'), '%', '\%'), '_', '\_');
  end if;

  with hits as (
    select m.id, m.kind, m.provider, m.storage_path, m.display_name, m.folder, m.alt, m.tags,
           m.width, m.height, m.size_bytes, m.ref_count, m.version, m.created_at, m.mime_type
      from public.media_assets m
     where m.tenant_id = p_tenant
       and (p_kind is null or m.kind = p_kind)
       and (p_needs_alt is not true
            or (m.kind = 'image'
                and (nullif(btrim(m.alt ->> 'en'), '') is null
                     or nullif(btrim(m.alt ->> 'ar'), '') is null)))
       and (v_needle is null
            or lower(app.normalize_ar_q(
                 coalesce(m.display_name, '') || ' ' || coalesce(m.alt ->> 'en', '') || ' '
                 || coalesce(m.alt ->> 'ar', '') || ' ' || array_to_string(m.tags, ' ') || ' '
                 || coalesce(m.folder, '')
                 || case when m.provider <> 'storage' then ' ' || m.storage_path else '' end))
               like '%' || v_needle || '%' escape '\')
  ),
  page as (
    select h.* from hits h
     order by h.created_at desc, h.id desc
     limit p_limit offset p_offset
  )
  select (select count(*) from hits),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', p.id, 'kind', p.kind, 'provider', p.provider,
                     'storage_path', p.storage_path, 'display_name', p.display_name,
                     'folder', p.folder, 'alt', p.alt, 'tags', to_jsonb(p.tags),
                     'width', p.width, 'height', p.height, 'size_bytes', p.size_bytes,
                     'ref_count', p.ref_count, 'version', p.version,
                     'created_at', p.created_at, 'mime_type', p.mime_type)
                   order by p.created_at desc, p.id desc)
                     from page p), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

-- P-14, both regimes: a regime that grants new functions to anon, authenticated and the
-- service role is exactly what the revoke undoes. Authenticated alone executes it.
revoke all on function public.media_library(uuid, text, text, boolean, int, int)
  from public, anon, authenticated, service_role;
grant execute on function public.media_library(uuid, text, text, boolean, int, int)
  to authenticated;

-- ---- 2. The guides --------------------------------------------------------------------------
-- The set as 0061 (U14b) left it, with the media-library guide rewritten; every other guide is
-- 0061's, byte for byte. A later slice that changes a guide restates the set from this text
-- (U16's rule).
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
    "slug": "your-dashboard",
    "sort_order": 15,
    "minutes": 3,
    "tags": [
      "basics"
    ],
    "screens": [
      "/admin"
    ],
    "caps": [],
    "title": "Your dashboard",
    "title_ar": "لوحة التحكم الخاصة بك",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "The dashboard is the first screen after you sign in. Its widgets follow your role: each shows only what your role may see, so leads and job applications appear on it only for the roles that handle them."
        },
        {
          "t": "h",
          "x": "Arranging it your way"
        },
        {
          "t": "ol",
          "x": [
            "Press Customize at the top. Drag a widget by its handle, or use its Move buttons, to change its place or move it to another column.",
            "Hide takes a widget off your dashboard. Add widget brings a hidden one back, on the left or on the right.",
            "Reset puts your dashboard back to your role’s layout, after asking. Done ends customizing. Every change is saved as you make it.",
            "Your layout is yours alone. An Admin can save a layout and a set of quick actions as the default for a role; people in that role who have not arranged their own dashboard see it."
          ]
        },
        {
          "t": "h",
          "x": "Quick actions"
        },
        {
          "t": "p",
          "x": "Quick actions are shortcuts to the screens you use most. Customize on the Quick actions widget lets you pick them from the list your role may use, put them in order, and add up to 8 links of your own: an admin screen, starting with /admin, or an outside address starting with https://. You can have 12 in all."
        },
        {
          "t": "h",
          "x": "Team notes"
        },
        {
          "t": "p",
          "x": "Team notes is one note shared by everyone who sees the dashboard. Edit notes opens it, and Save team notes keeps your change; if someone saved first, reload their version and make your change again. A note is cleared 180 days after its last edit. It refuses anything that looks like an e-mail address or a phone number: any run of 8 or more digits, even with spaces, dots, hyphens or brackets between them. Keep client details in leads, where they are protected."
        },
        {
          "t": "tip",
          "x": "Everyone who sees the dashboard reads the team notes, so write nothing there you would not say to the whole team."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "لوحة التحكم هي أول شاشة تراها بعد تسجيل الدخول، وتتبع عناصرها دورك: يعرض كل عنصر ما يتيحه دورك فقط، فلا يظهر فيها العملاء المحتملون وطلبات التوظيف إلا للأدوار التي تتولاها."
        },
        {
          "t": "h",
          "x": "رتّبها على طريقتك"
        },
        {
          "t": "ol",
          "x": [
            "اضغط Customize في الأعلى، ثم اسحب العنصر من مقبضه، أو استخدم أزرار النقل، لتغيير مكانه أو نقله إلى عمود آخر.",
            "يزيل Hide العنصر من لوحة التحكم، ويعيد Add widget عنصرًا مخفيًا إلى اليسار أو اليمين.",
            "يعيد Reset لوحة التحكم إلى تخطيط دورك بعد أن يطلب تأكيدك، وينهي Done التخصيص. ويُحفظ كل تغيير فور إجرائه.",
            "تخطيطك خاص بك وحدك. ويستطيع المسؤول (Admin) حفظ تخطيط ومجموعة من الإجراءات السريعة كإعداد افتراضي لدور ما، فيراه أصحاب ذلك الدور ممن لم يرتّبوا لوحتهم بأنفسهم."
          ]
        },
        {
          "t": "h",
          "x": "الإجراءات السريعة"
        },
        {
          "t": "p",
          "x": "الإجراءات السريعة اختصارات إلى الشاشات التي تستخدمها أكثر من غيرها. ويتيح لك Customize في عنصر Quick actions اختيارها من القائمة التي يسمح بها دورك، وترتيبها، وإضافة حتى 8 روابط خاصة بك: شاشة إدارة تبدأ بـ /admin، أو عنوان خارجي يبدأ بـ https://. ويمكنك الاحتفاظ بـ 12 إجراءً في المجموع."
        },
        {
          "t": "h",
          "x": "ملاحظات الفريق"
        },
        {
          "t": "p",
          "x": "ملاحظات الفريق ملاحظة واحدة يشترك فيها كل من يرى لوحة التحكم. يفتحها Edit notes، ويحفظ Save team notes تغييرك، وإذا حفظ أحد قبلك فأعد تحميل نسخته ثم أعد تغييرك. وتُمسح الملاحظة بعد 180 يومًا من آخر تعديل. وهي ترفض كل ما يشبه عنوان بريد إلكتروني أو رقم هاتف: أي سلسلة من 8 أرقام أو أكثر، حتى لو فصلت بينها مسافات أو نقاط أو شرطات أو أقواس. فاحتفظ ببيانات العملاء في شاشة العملاء المحتملين حيث تكون محمية."
        },
        {
          "t": "tip",
          "x": "يقرأ ملاحظات الفريق كل من يرى لوحة التحكم، فلا تكتب فيها ما لا تقوله للفريق كله."
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
    "minutes": 4,
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
          "x": "Only an Admin can, in Settings › Users & roles: open the person, choose the role or switch off Can sign in, and save. That ends every sign-in the person has, on every device: the admin turns them away at their next click, and they sign in again to get the new role. You cannot change your own role or switch yourself off."
        },
        {
          "t": "p",
          "x": "One limit to know: a sign-in pass already handed out keeps working for up to an hour when someone uses it directly against the database, outside the admin. On settings, media, the system logs and content it still carries the role it was issued with until it runs out. People and their roles, the security settings, leads, job applications and the activity log check the person's account on every request, so those close at once."
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
          "x": "يستطيع ذلك المسؤول (Admin) فقط، من Settings › Users & roles: افتح حساب الشخص، واختر الدور أو أوقف Can sign in، ثم احفظ. يُنهي ذلك كل جلسات دخول الشخص على كل أجهزته: ترفضه لوحة الإدارة عند نقرته التالية، ثم يسجّل دخوله من جديد ليحصل على الدور الجديد. لا يمكنك تغيير دورك بنفسك ولا إيقاف حسابك."
        },
        {
          "t": "p",
          "x": "وهناك حدّ ينبغي معرفته: تصريح الدخول الذي صدر بالفعل يبقى صالحًا حتى ساعة إذا استُخدم مباشرة على قاعدة البيانات، خارج لوحة الإدارة. ففي الإعدادات والوسائط وسجلات النظام والمحتوى يبقى يحمل الدور الذي صدر به إلى أن ينتهي. أما الأشخاص وأدوارهم، وإعدادات الأمان، والعملاء المحتملون، وطلبات التوظيف، وسجل النشاط فتتحقق من حساب الشخص عند كل طلب، فيُغلق الوصول إليها فورًا."
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
          "t": "tip",
          "x": "الأدوار ثابتة، ولا استثناءات لشخص بعينه. من يحتاج إلى صلاحيات أكثر يحتاج إلى دور مختلف."
        }
      ]
    }
  },
  {
    "slug": "inviting-people",
    "sort_order": 35,
    "minutes": 2,
    "tags": [
      "team"
    ],
    "screens": [
      "/admin/users"
    ],
    "caps": [
      "users.manage"
    ],
    "title": "Inviting people",
    "title_ar": "دعوة الأشخاص",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Only an Admin can invite people. In Settings › Users & roles, choose Invite someone, enter their email and role, and if you like their name and a short message (up to 300 characters) that appears in the email."
        },
        {
          "t": "ol",
          "x": [
            "They get an email with a link to set their password. The link works for one hour. If it runs out, choose Resend on their row under Pending invites.",
            "They choose a password of at least 10 characters, then sign in with their email and that password. Their role is the one you chose.",
            "Until they have accepted the invite, you can Cancel it: the link stops working and the account is removed. After that, use Remove access instead.",
            "When an allowed email domain is set in Security, invites and resends go only to addresses at exactly that domain."
          ]
        },
        {
          "t": "h",
          "x": "Before email is set up"
        },
        {
          "t": "p",
          "x": "Invites need the site to send email. Until that is connected, Invite someone and Resend say Not set up and send nothing. Pending invites, Cancel and the rest of the screen still work."
        },
        {
          "t": "tip",
          "x": "Every invite, resend, cancelled invite and accepted invite is recorded in the activity log, without their email or your message."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يستطيع المسؤول (Admin) وحده دعوة الأشخاص. من Settings › Users & roles اختر Invite someone، وأدخل البريد الإلكتروني للشخص ودوره، ويمكنك إضافة اسمه ورسالة قصيرة (حتى 300 حرف) تظهر في الرسالة الإلكترونية."
        },
        {
          "t": "ol",
          "x": [
            "تصله رسالة بريد إلكتروني فيها رابط لاختيار كلمة المرور. يعمل الرابط ساعة واحدة، وإذا انتهت مدته فاختر Resend في صفه ضمن Pending invites.",
            "يختار كلمة مرور من 10 أحرف على الأقل، ثم يسجّل الدخول ببريده الإلكتروني وكلمة المرور تلك، ويحصل على الدور الذي اخترته.",
            "ما دام لم يقبل الدعوة بعد، يمكنك إلغاءها بزر Cancel: يتوقف الرابط عن العمل ويُحذف الحساب. وبعد ذلك استخدم Remove access بدلًا منه.",
            "إذا حُدّد نطاق بريد مسموح به في بطاقة Security، فلا تُرسل الدعوات ولا يُعاد إرسالها إلا إلى عناوين ذلك النطاق بالضبط."
          ]
        },
        {
          "t": "h",
          "x": "قبل إعداد البريد الإلكتروني"
        },
        {
          "t": "p",
          "x": "تحتاج الدعوات إلى أن يرسل الموقع رسائل بريد إلكتروني. وإلى أن يُربط ذلك، يظهر Not set up على Invite someone وResend ولا يُرسل شيء. أما Pending invites وCancel وبقية الشاشة فتعمل كالمعتاد."
        },
        {
          "t": "tip",
          "x": "تُسجَّل في سجل النشاط كل دعوة وكل إعادة إرسال وكل دعوة أُلغيت أو قُبلت، دون بريد الشخص الإلكتروني أو رسالتك."
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
    "minutes": 3,
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
          "x": "The media library holds the pictures the site shows. Every picture has alt text in English and Arabic: the short description screen readers read aloud and search engines index."
        },
        {
          "t": "h",
          "x": "Adding pictures"
        },
        {
          "t": "ol",
          "x": [
            "Choose Upload, or drop pictures on the page. JPEG, PNG and WebP work, up to 20 MB each. SVG, GIF, HEIC and AVIF files are refused.",
            "Before anything is sent, describe each picture in English and Arabic. Say what it shows in a sentence, not the file name.",
            "Each picture is resized to at most 2,560 pixels and saved as WebP. Location and camera details are removed.",
            "You can upload or replace 50 pictures a day, and the whole team 100.",
            "From any picture field, Choose opens the same library, with Upload there too.",
            "Uploading, replacing and deleting depend on your role. If you do not see Upload, you can still change alt text and tags."
          ]
        },
        {
          "t": "h",
          "x": "Changing a picture"
        },
        {
          "t": "ol",
          "x": [
            "Open a picture to change its alt text or tags. They change on the site at once.",
            "Replace file puts a new picture in the same place everywhere it is used.",
            "Used in lists every place that shows the picture.",
            "Needs alt text shows the pictures still missing a description in either language."
          ]
        },
        {
          "t": "p",
          "x": "Only an Admin can delete a picture, and only once nothing on the site uses it. A deleted or replaced picture can stay reachable for about two hours before it leaves the web."
        },
        {
          "t": "tip",
          "x": "Videos are served from the site itself until video hosting is set up, so they are listed under Videos and cannot be uploaded here yet."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تحفظ مكتبة الوسائط الصور التي يعرضها الموقع. لكل صورة نص بديل بالإنجليزية والعربية: الوصف القصير الذي تقرؤه برامج قراءة الشاشة بصوت عالٍ وتفهرسه محركات البحث."
        },
        {
          "t": "h",
          "x": "إضافة الصور"
        },
        {
          "t": "ol",
          "x": [
            "اختر Upload أو أفلت الصور على الصفحة. تُقبل صور JPEG وPNG وWebP حتى 20 MB لكل صورة، وتُرفض ملفات SVG وGIF وHEIC وAVIF.",
            "قبل إرسال أي شيء، صف كل صورة بالإنجليزية والعربية. قل ما تُظهره الصورة في جملة، لا اسم الملف.",
            "تُصغَّر كل صورة إلى 2,560 بكسل على الأكثر وتُحفظ بصيغة WebP، وتُحذف منها بيانات الموقع والكاميرا.",
            "يمكنك رفع 50 صورة أو استبدالها في اليوم، وللفريق كله 100.",
            "من أي حقل صورة، يفتح Choose المكتبة نفسها، وفيها Upload أيضًا.",
            "الرفع والاستبدال والحذف بحسب دورك. إن لم ترَ Upload، فما زال بإمكانك تغيير النص البديل والوسوم."
          ]
        },
        {
          "t": "h",
          "x": "تغيير صورة"
        },
        {
          "t": "ol",
          "x": [
            "افتح صورة لتغيير نصها البديل أو وسومها. يتغيّر ذلك على الموقع فورًا.",
            "يضع Replace file صورة جديدة في المكان نفسه أينما استُخدمت الصورة.",
            "تعرض Used in كل مكان يُظهر الصورة.",
            "يعرض Needs alt text الصور التي ما زال ينقصها وصف بإحدى اللغتين."
          ]
        },
        {
          "t": "p",
          "x": "حذف الصورة للمسؤول (Admin) فقط، وفقط حين لا يستخدمها أي جزء من الموقع. قد تبقى الصورة المحذوفة أو المستبدلة متاحة نحو ساعتين قبل أن تختفي من الويب."
        },
        {
          "t": "tip",
          "x": "تُعرض الفيديوهات من الموقع نفسه إلى أن تُجهَّز استضافة الفيديو، لذا تظهر تحت Videos ولا يمكن رفعها هنا بعد."
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
    "slug": "page-visibility",
    "sort_order": 105,
    "minutes": 3,
    "tags": [
      "site"
    ],
    "screens": [
      "/admin/visibility"
    ],
    "caps": [
      "maintenance.manage"
    ],
    "title": "Page visibility",
    "title_ar": "ظهور الصفحات",
    "body": {
      "en": [
        {
          "t": "p",
          "x": "Page visibility decides who can see each page of the public site. A change applies to the live site within a few minutes, and the admin keeps working as usual."
        },
        {
          "t": "ol",
          "x": [
            "Visible to everyone is the normal setting: the page is in the menus and in search engines, and open to all.",
            "Hidden from the site takes the page out of the menus, the sitemap and search engines. Anyone who opens its link is sent to the page you choose, or sees a page not found screen.",
            "Hiding is not deleting: the page's words stay published. Unpublish it, or keep confidential details off it. A hidden Join or Contact page still takes what its form sends: to stop job applications, turn off Accepting job applications in General settings.",
            "To hide a page for a while, give it a Hide from day, a Show again on day, or both. It is hidden from the start of the first day until the start of the second, Riyadh time. Leave both empty to hide it until you show it again.",
            "Only people with the link keeps the page out of the menus, the sitemap and search engines, but the link still works. It is unlisted, not private: anyone who has the link can open it, so keep anything confidential off it.",
            "Behind a password asks for a password before the page opens. Type something short you can share, such as on WhatsApp, and, if you like, a line to show above the box in English, Arabic or both.",
            "The password is stored scrambled, so nobody can read it back, not even an Admin and not the people who run the database. To change it, set a new one. Setting a new password closes the page again for everyone who had typed the old one.",
            "A page behind a password is out of the menus, the sitemap and search engines, it is never kept by any cache, and its text is not readable through the site’s data either until someone types the password. Visitors get a few tries every quarter of an hour; after that the page stops answering them for a while.",
            "The service page and the case study page are templates. Hiding one hides every service page, or every project page, at once. To hide a single service or project, unpublish that item instead.",
            "The homepage is always visible. To take the whole site down for a while, use maintenance mode.",
            "If a save says the live site has not picked it up, press Sync to edge. The line above the list says whether the live site has the settings."
          ]
        },
        {
          "t": "tip",
          "x": "Search engines and AI tools that fetched the sitemap just before a change may keep the old list for up to an hour."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "يحدد ظهور الصفحات من يستطيع رؤية كل صفحة من صفحات الموقع العام. يسري التغيير على الموقع المباشر خلال بضع دقائق، وتستمر لوحة الإدارة في العمل كالمعتاد."
        },
        {
          "t": "ol",
          "x": [
            "الخيار المعتاد هو Visible to everyone: تظهر الصفحة في القوائم وفي محركات البحث، ويستطيع الجميع فتحها.",
            "يُخرج خيار Hidden from the site الصفحة من القوائم وخريطة الموقع ومحركات البحث. ومن يفتح رابطها يُنقل إلى الصفحة التي تختارها، أو تظهر له صفحة تقول إن الصفحة غير موجودة.",
            "الإخفاء ليس حذفًا: يبقى نص الصفحة منشورًا. ألغِ نشرها، أو لا تضع عليها أي معلومات سرية. وتظل صفحة Join أو Contact المخفية تستقبل ما يُرسَل عبر نموذجها: لإيقاف طلبات التوظيف، أوقف خيار Accepting job applications في General settings.",
            "لإخفاء صفحة مدة محددة، حدّد لها يوم Hide from أو يوم Show again on أو كليهما. تبقى مخفية من بداية اليوم الأول حتى بداية اليوم الثاني بتوقيت الرياض. اترك الحقلين فارغين لإخفائها حتى تعيد إظهارها.",
            "يُبقي خيار Only people with the link الصفحة خارج القوائم وخريطة الموقع ومحركات البحث، لكن رابطها يظل يعمل. فهي غير مدرجة وليست خاصة: يستطيع فتحها كل من لديه الرابط، فلا تضع عليها أي معلومات سرية.",
            "يطلب خيار Behind a password كلمة مرور قبل فتح الصفحة. اكتب كلمة قصيرة يسهل مشاركتها، عبر واتساب مثلًا، وإن شئت سطرًا يظهر فوق الحقل بالإنجليزية أو العربية أو بكلتيهما.",
            "تُحفظ كلمة المرور مشفّرة، فلا يستطيع أحد قراءتها، ولا حتى المسؤولون (Admin) ولا من يدير قاعدة البيانات. ولتغييرها ضع كلمة جديدة، وهذا يغلق الصفحة من جديد أمام كل من أدخل الكلمة القديمة.",
            "الصفحة المحمية بكلمة مرور خارج القوائم وخريطة الموقع ومحركات البحث، ولا تُحفظ في أي ذاكرة مؤقتة، ولا يُقرأ نصّها عبر بيانات الموقع أيضًا حتى يُدخل أحد كلمة المرور. وللزائر محاولات معدودة كل ربع ساعة، وبعدها تتوقف الصفحة عن الاستجابة له مدة من الوقت.",
            "صفحة الخدمة وصفحة دراسة الحالة قالبان، وإخفاء أحدهما يخفي كل صفحات الخدمات أو كل صفحات المشاريع دفعة واحدة. ولإخفاء خدمة واحدة أو مشروع واحد، ألغِ نشر ذلك العنصر بدلًا من ذلك.",
            "تظهر الصفحة الرئيسية دائمًا. ولإيقاف الموقع كله مؤقتًا استخدم وضع الصيانة.",
            "إذا ذكر الحفظ أن الموقع المباشر لم يستلم التغيير، فاضغط Sync to edge. ويذكر السطر أعلى القائمة إن كان الموقع المباشر قد استلم الإعدادات."
          ]
        },
        {
          "t": "tip",
          "x": "قد تحتفظ محركات البحث وأدوات الذكاء الاصطناعي التي جلبت خريطة الموقع قبيل التغيير بالقائمة القديمة مدة تصل إلى ساعة."
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

-- Every tenant gets the changed guide (app.seed_help_articles inserts a guide it lacks and
-- updates one only where it differs from the set, moving its version; 0046).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  v_fn constant regprocedure :=
    to_regprocedure('public.media_library(uuid, text, text, boolean, integer, integer)');
  v_set jsonb;
  v_guide jsonb;
  p text;
begin
  -- ---- The list: an invoker, stable, its search path empty and its timeout 500 ms.
  if v_fn is null then
    raise exception '0064: public.media_library(uuid, text, text, boolean, int, int) is missing';
  end if;
  if exists (select 1 from pg_proc where oid = v_fn and (prosecdef or provolatile <> 's')) then
    raise exception '0064: public.media_library must be SECURITY INVOKER and STABLE';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = v_fn
                    and proconfig @> array['statement_timeout=500ms']
                    and (proconfig @> array['search_path=""'] or proconfig @> array['search_path='])) then
    raise exception '0064: public.media_library must set search_path = '''' and statement_timeout = 500ms';
  end if;
  if (select prorettype from pg_proc where oid = v_fn) <> 'jsonb'::regtype then
    raise exception '0064: public.media_library must return jsonb';
  end if;

  -- ---- Its callers: authenticated alone. No ACL entry for PUBLIC (grantee 0), and neither
  -- anon nor the service role holds EXECUTE through any path.
  if not has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception '0064: authenticated must execute public.media_library';
  end if;
  foreach p in array array['anon', 'service_role'] loop
    if has_function_privilege(p, v_fn, 'execute') then
      raise exception '0064: % may execute public.media_library', p;
    end if;
  end loop;
  if exists (select 1 from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) a
              where pr.oid = v_fn and a.grantee = 0) then
    raise exception '0064: PUBLIC may execute public.media_library';
  end if;
  if exists (select 1 from pg_proc pr, aclexplode(pr.proacl) a
              where pr.oid = v_fn and a.grantee <> pr.proowner
                and a.grantee <> 'authenticated'::regrole::oid) then
    raise exception '0064: public.media_library is granted to a role other than authenticated';
  end if;

  -- ---- The guides: the set parses and holds 15, media-library keeps its place, screens and
  -- capability, no API role reads the set, and every tenant holds the guide as the set states it.
  v_set := app.help_article_set();
  if jsonb_typeof(v_set) <> 'array' or jsonb_array_length(v_set) <> 15 then
    raise exception '0064: app.help_article_set() must hold 15 guides';
  end if;
  select a into v_guide from jsonb_array_elements(v_set) a where a ->> 'slug' = 'media-library';
  if v_guide is null
     or v_guide -> 'sort_order' <> '50'::jsonb
     or v_guide -> 'minutes' <> '3'::jsonb
     or v_guide -> 'tags' <> '["content", "media"]'::jsonb
     or v_guide -> 'screens' <> '["/admin/media"]'::jsonb
     or v_guide -> 'caps' <> '["media.write"]'::jsonb then
    raise exception '0064: the media-library guide does not keep its place, screens and capability';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.help_article_set()', 'execute') then
      raise exception '0064: % may execute app.help_article_set()', p;
    end if;
  end loop;
  if exists (select 1 from public.tenants tn
              where not exists (
                select 1 from public.help_articles h
                 where h.tenant_id = tn.id and h.slug = 'media-library'
                   and h.title = v_guide ->> 'title'
                   and h.title_ar = v_guide ->> 'title_ar'
                   and h.body = v_guide -> 'body'
                   and h.screens = array['/admin/media']
                   and h.caps = array['media.write'])) then
    raise exception '0064: a tenant does not hold the media-library guide as the set states it';
  end if;
end $$;
