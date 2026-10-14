-- ─────────────────────────────────────────────────────────────────────────────
-- 0046 — The help centre (Admin v2 U16, docs/admin-v2/README.md "Slice sequence"). Forward-
-- only, expand only. Depends on 0001 (tenants), 0003 and 0006 (the Arabic fold,
-- app.normalize_ar_q), 0011 (the app schema's grants) and 0013 (app.effective_tenant_id,
-- app.is_staff).
--
-- Short guides for the admin, the "?" drawer's content, stored per tenant as typed blocks:
--
--   • public.help_articles: one row per guide and tenant. A title in each language (§8: a
--     scalar → `_ar`), a body locale-keyed in one JSONB ({"en": [...], "ar": [...]}), the
--     reading time, tag keys, the admin screens the guide belongs to (`screens`, matched by
--     the Worker against the page the drawer opens on) and the capabilities whose holders
--     it is for (`caps`, none meaning every staff member).
--   • A body is typed blocks, never HTML: {"t": "p" | "h" | "tip", "x": text} or
--     {"t": "ol", "x": [text, ...]}. app.help_body_ok holds that shape in a CHECK, and no
--     text anywhere in a row may hold `<` or `>` or a control character (app.help_text_ok),
--     so no markup is ever stored. packages/schemas/help.ts states the same rules for the
--     Worker, which renders every text as a text node.
--   • Who writes: the migrations, through app.seed_help_articles (the set below) and the
--     service role. No staff role writes help: CLAUDE.md §5 assigns no capability to it, and
--     the design defers editing (TDD phase 7, docs/admin-v2/verification.md). Staff read
--     their own tenant's guides: tenant_id = app.effective_tenant_id() and app.is_staff().
--   • `caps` is a relevance filter applied by the Worker from ROLE_CAPS (src/lib/admin/help),
--     so nobody is sent to a screen they cannot open; it is not a secret. RLS lets every staff
--     member of the tenant read every guide: the guides describe the admin, hold no data, and
--     are published in this file (the repository is public). Copying ROLE_CAPS into SQL to
--     filter by capability would hide nothing and add a second matrix to keep in step.
--   • public.help_search(p_tenant, p_q): the drawer's search, SECURITY INVOKER (RLS decides
--     the rows). "Contains" over `search_text`, a generated column holding both titles, the
--     tag keys and every text of both bodies, folded the way CLAUDE.md §8 folds Arabic for a
--     contains search (app.normalize_ar_q: tashkeel, alef forms, ة→ه, kashida; no article
--     stripping, which only the FTS index needs, app.ar_fts_text) and lower-cased; the query
--     is folded by the same function, and `%`, `_` and `\` in it are characters, not
--     patterns.
--     A query is at most 64 printable characters (22023 otherwise), under two characters
--     finds nothing, and the answer is at most 100 guides under a 500 ms statement timeout:
--     the list's own cap, so the role's filter, which the Worker applies, comes before the
--     cut to the 20 the drawer shows (a cut here would count other roles' guides, and a
--     role would lose ones it may read). Like crm_people, the Worker names the tenant and
--     gets nothing unless it is the token's.
--   • app.help_article_set(): the guides themselves, one JSON array, written for the
--     features that are built (the client's prototype articles rewritten; nothing describes
--     a screen that does not exist). app.seed_help_articles(p_tenant) upserts the set into a
--     tenant: run below for every tenant, and by a trigger for each new one, so a tenant
--     always has its guides. A later slice that changes a screen a guide describes ships a
--     migration that replaces app.help_article_set() and seeds every tenant again; one that
--     retires a guide deletes it there by slug.
--
-- Grants are stated for both Supabase privilege regimes (README P-14): everything is revoked
-- from public, anon, authenticated and service_role first, then granted exactly, and the
-- postconditions check what must and what must not be held. The table has no sequence (its
-- key is a uuid). CLAUDE.md §3 (Pillar 1), §5, §8.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038, 0041 and 0044). The tenant
-- key takes a SHARE ROW EXCLUSIVE lock on public.tenants, and so does the trigger on it;
-- every request's tenant fence reads that table. A statement below that waits more than
-- five seconds for a lock raises instead, the whole migration rolls back, and the push is
-- retried later. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. What a guide may hold -------------------------------------------------------------
-- Plain text: not blank, at most p_max characters, no `<` or `>` (no markup, ever) and no
-- C0 or C1 control character. Invoker; the writers (the service role, and the owner through
-- the seed) evaluate it in the CHECKs below.
create or replace function app.help_text_ok(p_text text, p_max int) returns boolean
  language sql immutable set search_path = '' as $$
  select p_text is not null
     and char_length(p_text) <= p_max
     and p_text ~ '[^[:space:]]'
     and p_text !~ '[<>\u0001-\u001F\u007F-\u009F]'
$$;

-- A list of keys (tags, screens, capabilities): one dimension, at most p_max of them, each
-- at most 120 characters and matching p_pattern, none repeated.
create or replace function app.help_keys_ok(p_keys text[], p_pattern text, p_max int)
  returns boolean language sql immutable set search_path = '' as $$
  select p_keys is not null
     and (array_ndims(p_keys) is null or array_ndims(p_keys) = 1)
     and cardinality(p_keys) <= p_max
     and not exists (select 1 from unnest(p_keys) k
                      where k is null or char_length(k) > 120 or k !~ p_pattern)
     and cardinality(p_keys) = (select count(distinct k) from unnest(p_keys) k)
$$;

-- A body: exactly {"en": [...], "ar": [...]}, each 1 to 40 blocks; a block exactly {t, x}:
-- p and tip up to 1,200 characters, h up to 120, ol 1 to 12 items of up to 600. At most
-- 64 KB in all. Anything else (another kind, another key, a number where text belongs, an
-- object inside a list) is refused.
create or replace function app.help_body_ok(p_body jsonb) returns boolean
  language plpgsql immutable set search_path = '' as $$
declare
  v_lang text;
  v_blocks jsonb;
  v_block jsonb;
  v_item jsonb;
  v_kind text;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' or octet_length(p_body::text) > 65536
     or (select array_agg(k order by k) from jsonb_object_keys(p_body) k)
        is distinct from array['ar', 'en'] then
    return false;
  end if;
  foreach v_lang in array array['en', 'ar'] loop
    v_blocks := p_body -> v_lang;
    if jsonb_typeof(v_blocks) <> 'array' or jsonb_array_length(v_blocks) not between 1 and 40 then
      return false;
    end if;
    for v_block in select b from jsonb_array_elements(v_blocks) b loop
      if jsonb_typeof(v_block) <> 'object'
         or (select array_agg(k order by k) from jsonb_object_keys(v_block) k)
            is distinct from array['t', 'x']
         or jsonb_typeof(v_block -> 't') <> 'string' then
        return false;
      end if;
      v_kind := v_block ->> 't';
      if v_kind in ('p', 'tip', 'h') then
        if jsonb_typeof(v_block -> 'x') <> 'string'
           or not app.help_text_ok(v_block ->> 'x', case when v_kind = 'h' then 120 else 1200 end) then
          return false;
        end if;
      elsif v_kind = 'ol' then
        if jsonb_typeof(v_block -> 'x') <> 'array'
           or jsonb_array_length(v_block -> 'x') not between 1 and 12 then
          return false;
        end if;
        for v_item in select i from jsonb_array_elements(v_block -> 'x') i loop
          if jsonb_typeof(v_item) <> 'string' or not app.help_text_ok(v_item #>> '{}', 600) then
            return false;
          end if;
        end loop;
      else
        return false;
      end if;
    end loop;
  end loop;
  return true;
end $$;

-- What search reads: both titles, the tag keys and every text of both bodies, folded like
-- 0036's leads.search_text (app.normalize_ar_q, then lower case). Immutable, for a STORED
-- generated column, which is computed in the WRITER's session (0011): the writers hold
-- EXECUTE on it, and on app.normalize_ar_q already.
create or replace function app.help_search_text(p_title text, p_title_ar text, p_tags text[],
                                                p_body jsonb)
  returns text language sql immutable set search_path = '' as $$
  select lower(app.normalize_ar_q(
    coalesce(p_title, '') || ' ' || coalesce(p_title_ar, '') || ' '
    || coalesce(array_to_string(p_tags, ' '), '') || ' '
    || coalesce((select string_agg(v #>> '{}', ' ')
                   from jsonb_path_query(p_body, 'lax $.*[*].x[*]') v), '')))
$$;

-- ---- 2. The table ---------------------------------------------------------------------------
create table if not exists public.help_articles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Lower case by its CHECK, so a text slug is unique the way citext would make it (§8).
  slug text not null,
  title text not null,
  title_ar text not null,
  minutes smallint not null,
  tags text[] not null default '{}',
  screens text[] not null,
  caps text[] not null default '{}',
  body jsonb not null,
  sort_order int not null default 0,
  search_text text generated always as (app.help_search_text(title, title_ar, tags, body)) stored,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint help_articles_tenant_slug unique (tenant_id, slug),
  constraint help_articles_slug_shape check (
    char_length(slug) <= 64 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint help_articles_titles_ok check (
    app.help_text_ok(title, 120) and app.help_text_ok(title_ar, 120)),
  constraint help_articles_minutes_range check (minutes between 1 and 30),
  constraint help_articles_tags_ok check (app.help_keys_ok(tags, '^[a-z][a-z0-9-]{0,23}$', 6)),
  constraint help_articles_screens_ok check (
    cardinality(screens) >= 1 and app.help_keys_ok(screens, '^/admin(/[a-z0-9-]+)*$', 16)),
  constraint help_articles_caps_ok check (
    app.help_keys_ok(caps, '^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$', 12)),
  constraint help_articles_body_ok check (app.help_body_ok(body))
);

alter table public.help_articles enable row level security;
alter table public.help_articles force row level security;

-- Staff read their own tenant's guides; nothing else. No write policy: no API role but the
-- service role (which bypasses RLS) writes, and staff hold no write privilege either.
drop policy if exists help_articles_staff_read on public.help_articles;
create policy help_articles_staff_read on public.help_articles for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

-- The version, the stamps and the authorship belong to the database, and a guide keeps its
-- tenant, its slug (links name it) and its id. The version moves only when the guide does,
-- so a seed that finds nothing to change leaves it as it was. INVOKER (a trigger needs no
-- privilege of its own); search_path '' with qualified names.
create or replace function app.tg_help_articles() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    return new;
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.slug is distinct from old.slug then
    raise exception using errcode = '23514',
      message = 'help_articles: a guide keeps its id, its tenant and its slug';
  end if;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  if row(new.title, new.title_ar, new.minutes, new.tags, new.screens, new.caps, new.body,
         new.sort_order)
     is distinct from row(old.title, old.title_ar, old.minutes, old.tags, old.screens, old.caps,
                          old.body, old.sort_order) then
    new.version := old.version + 1;
    new.updated_at := now();
    new.updated_by := auth.uid();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;

drop trigger if exists help_articles_guard on public.help_articles;
create trigger help_articles_guard before insert or update on public.help_articles
  for each row execute function app.tg_help_articles();

-- ---- 3. Search ------------------------------------------------------------------------------
-- The drawer's search. INVOKER: the caller's RLS decides the rows (staff of the tenant). The
-- Worker names the tenant, as for crm_people, and gets nothing unless it is the token's. A
-- query the Worker would never send (over 64 characters, a control character) is a 22023,
-- never quietly searched; one under two characters finds nothing. At most 100 guides, the
-- Worker's MAX_GUIDES (src/lib/admin/help): it filters them by role, THEN keeps 20.
create or replace function public.help_search(p_tenant uuid, p_q text)
  returns table (id uuid, slug text, title text, title_ar text, minutes smallint, tags text[],
                 screens text[], caps text[], sort_order int)
  language plpgsql stable security invoker
  set search_path = '' set statement_timeout = '500ms' as $$
declare
  v_needle text;
begin
  if p_q is null or char_length(p_q) > 64 or p_q ~ '[\u0001-\u001F\u007F-\u009F]' then
    raise exception using errcode = '22023',
      message = 'help_search: a query is at most 64 printable characters';
  end if;
  if char_length(btrim(p_q)) < 2 or p_tenant is distinct from app.effective_tenant_id() then
    return;
  end if;
  -- Folded like search_text, then escaped: a % or _ in the query is a character.
  v_needle := replace(replace(replace(lower(app.normalize_ar_q(btrim(p_q))),
                '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select h.id, h.slug, h.title, h.title_ar, h.minutes, h.tags, h.screens, h.caps, h.sort_order
      from public.help_articles h
     where h.tenant_id = p_tenant
       and h.search_text like '%' || v_needle || '%' escape '\'
     -- A guide whose title holds the words first, then the set's own order.
     order by (lower(app.normalize_ar_q(h.title || ' ' || h.title_ar))
                 like '%' || v_needle || '%' escape '\') desc,
              h.sort_order, h.slug
     limit 100;
end $$;

-- ---- 4. The guides --------------------------------------------------------------------------
-- The set, as one JSON array (packages/schemas/help.ts, HelpArticleSeedSchema, is held to it
-- by tests/lib/helpCentre.spec.ts, with the rules no CHECK can see: every capability is one
-- ROLE_CAPS names, every screen is an admin page, and each reader of a guide can open one of
-- its screens; no dash the copy rules forbid, P-12). Written for the features that are
-- built; the admin's own labels (Save changes, Reveal contact details…) stay in English in the
-- Arabic text, because the admin is in English. No brand is spelled (CLAUDE.md §1).
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
            "It shows up to 30 items from the last 14 days: new inquiries and job applications for the roles that handle them, services and posts going live today, and maintenance switched on or off.",
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
            "يعرض حتى 30 عنصرًا من آخر 14 يومًا: الاستفسارات الجديدة وطلبات التوظيف للأدوار التي تتولاها، والخدمات والمقالات التي تُنشر اليوم، وتشغيل وضع الصيانة أو إيقافه.",
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
            "Developer: general settings, maintenance, the theme, media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications."
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
            "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، والمظهر، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف."
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
          "x": "تنقل إعادة التوجيه الزوار ومحركات البحث من عنوان قديم إلى عنوان جديد، فتبقى الروابط التي شوركت قبل تغيير الاسم صالحة."
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
            "Counts are added up on a schedule, so the latest visits can take a while to show.",
            "Where your role has a Search tab, it shows what visitors typed into the site's search, and which searches found nothing. A search that finds nothing is often a page worth writing.",
            "Raw visit records are kept 90 days."
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
            "تُجمع الأرقام وفق جدول زمني، لذا قد تتأخر أحدث الزيارات في الظهور.",
            "إذا كان لدورك تبويب Search فهو يعرض ما كتبه الزوار في بحث الموقع، وعمليات البحث التي لم تجد شيئًا. والبحث الذي لا يجد شيئًا كثيرًا ما يشير إلى صفحة تستحق الكتابة.",
            "تُحفظ سجلات الزيارات الأولية 90 يومًا."
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
      "/admin/logs",
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
          "x": "Site health shows how fast the site feels to real visitors (Core Web Vitals), measured in their own browsers when they accept analytics cookies."
        },
        {
          "t": "ol",
          "x": [
            "Each measure has a budget. Over budget means visitors wait longer than they should, which is worth raising with whoever looks after the site's code.",
            "Errors lists problems the site ran into. An Admin can clear entries older than 30 days.",
            "The activity log records saves, publishes, reveals of contact details and exports, each against the account that made it, with the time. The screen lists the time, the role, the action and what it touched. Nobody can edit or delete it, not even an Admin."
          ]
        },
        {
          "t": "tip",
          "x": "To find out when something changed, and which role changed it, look in the activity log."
        }
      ],
      "ar": [
        {
          "t": "p",
          "x": "تُظهر صحة الموقع مدى سرعة الموقع كما يشعر بها الزوار الحقيقيون (Core Web Vitals)، وتُقاس في متصفحاتهم عندما يقبلون ملفات تعريف الارتباط الخاصة بالتحليلات."
        },
        {
          "t": "ol",
          "x": [
            "لكل مقياس حد مستهدف، وتجاوزه يعني أن الزوار ينتظرون أكثر مما ينبغي، ويستحق ذلك إبلاغ المسؤول عن برمجة الموقع.",
            "يعرض Errors المشكلات التي واجهها الموقع، ويستطيع المسؤول (Admin) مسح الإدخالات الأقدم من 30 يومًا.",
            "يسجّل سجل النشاط الحفظ والنشر وكشف بيانات التواصل والتصدير، كلًّا على الحساب الذي قام به مع وقته. وتعرض الشاشة الوقت والدور والإجراء وما تناوله. ولا يستطيع أحد تعديله أو حذفه، ولا حتى المسؤول (Admin)."
          ]
        },
        {
          "t": "tip",
          "x": "لمعرفة متى تغيّر شيء وأي دور غيّره، ارجع إلى سجل النشاط."
        }
      ]
    }
  }
]
$help$::jsonb
$fn$;

-- Upserts the set into one tenant: a guide the set holds is inserted, or brought back to the
-- set's text where it differs (the guard moves its version); a guide the set does not hold
-- is left alone. A definer: it runs for the migration below and for the tenants trigger,
-- whoever inserts the tenant, and writes past RLS as its owner.
create or replace function app.seed_help_articles(p_tenant uuid) returns void
  language sql security definer set search_path = '' as $$
  insert into public.help_articles as h
    (tenant_id, slug, title, title_ar, minutes, tags, screens, caps, body, sort_order)
  select p_tenant, a.slug, a.title, a.title_ar, a.minutes, a.tags, a.screens, a.caps, a.body,
         a.sort_order
    from jsonb_to_recordset(app.help_article_set())
      as a (slug text, title text, title_ar text, minutes smallint, tags text[], screens text[],
            caps text[], body jsonb, sort_order int)
  on conflict (tenant_id, slug) do update
     set title = excluded.title, title_ar = excluded.title_ar, minutes = excluded.minutes,
         tags = excluded.tags, screens = excluded.screens, caps = excluded.caps,
         body = excluded.body, sort_order = excluded.sort_order
   where row(h.title, h.title_ar, h.minutes, h.tags, h.screens, h.caps, h.body, h.sort_order)
         is distinct from row(excluded.title, excluded.title_ar, excluded.minutes, excluded.tags,
                              excluded.screens, excluded.caps, excluded.body,
                              excluded.sort_order)
$$;

-- A new tenant gets the guides with it (as 0034 gives it the lead pipeline).
create or replace function app.tg_tenant_help_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_help_articles(new.id);
  return null;
end $$;
drop trigger if exists tenants_help_defaults on public.tenants;
create trigger tenants_help_defaults after insert on public.tenants
  for each row execute function app.tg_tenant_help_defaults();

-- ---- 5. Grants, stated (Admin v2 P-14: both Supabase grant regimes) -----------------------
revoke all on public.help_articles from public, anon, authenticated, service_role;
grant select on public.help_articles to authenticated;
-- The backend of record (an operator's correction between migrations), as 0037 states it for
-- the tables staff only read. Nothing in U16 uses it.
grant select, insert, update, delete on public.help_articles to service_role;

-- The CHECKs and the generated column run as the writer: the service role holds EXECUTE on
-- what they call (the owner, which the seed runs as, needs no grant). No staff role writes.
revoke all on function app.help_text_ok(text, int) from public, anon, authenticated, service_role;
revoke all on function app.help_keys_ok(text[], text, int) from public, anon, authenticated, service_role;
revoke all on function app.help_body_ok(jsonb) from public, anon, authenticated, service_role;
revoke all on function app.help_search_text(text, text, text[], jsonb) from public, anon, authenticated, service_role;
grant execute on function app.help_text_ok(text, int) to service_role;
grant execute on function app.help_keys_ok(text[], text, int) to service_role;
grant execute on function app.help_body_ok(jsonb) to service_role;
grant execute on function app.help_search_text(text, text, text[], jsonb) to service_role;

revoke all on function app.tg_help_articles() from public, anon, authenticated, service_role;
revoke all on function app.help_article_set() from public, anon, authenticated, service_role;
revoke all on function app.seed_help_articles(uuid) from public, anon, authenticated, service_role;
revoke all on function app.tg_tenant_help_defaults() from public, anon, authenticated, service_role;

revoke all on function public.help_search(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.help_search(uuid, text) to authenticated;

-- ---- 6. Every tenant gets the guides --------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them, the same
-- on PostgreSQL 15 and 17 (a function's schema printed only when app is not on the search
-- path, so the patterns allow both).
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_read constant text :=
    '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?is_staff\(\)\)$';
  v_have text[];
  v_want text[];
  v_bad text;
  v_n int;
  p text;
begin
  -- RLS on, and forced.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.help_articles'::regclass) then
    raise exception '0046: help_articles is not ENABLE + FORCE row level security';
  end if;

  -- ---- Table privileges, as each API role holds them (directly or through a role it is a
  -- member of): exactly these, and nothing else of v_privs. PUBLIC and anon nothing;
  -- authenticated SELECT; service_role SELECT, INSERT, UPDATE and DELETE, never TRUNCATE,
  -- REFERENCES, TRIGGER or MAINTAIN.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.help_articles', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select', 'insert', 'update', 'delete']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0046: wrong table privileges on help_articles (role privilege): %', v_bad;
  end if;

  -- ---- The table's own ACL, grantee by grantee: the owner's, plus exactly the grants
  -- above. A grant to any other role fails here.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s',
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_class c
            cross join lateral aclexplode(c.relacl) a
           where c.oid = 'public.help_articles'::regclass
             and a.grantee <> c.relowner) s;
  v_want := array['authenticated select', 'service_role delete', 'service_role insert',
                  'service_role select', 'service_role update'];
  if v_have is distinct from v_want then
    raise exception '0046: help_articles is granted %, expected %', v_have, v_want;
  end if;

  -- ---- Columns: no column grant to anyone; PUBLIC and anon hold no column privilege, staff
  -- may not insert or update any column, and no one REFERENCES a column.
  if exists (select 1 from pg_attribute att
               where att.attrelid = 'public.help_articles'::regclass
                 and att.attnum > 0 and not att.attisdropped and att.attacl is not null
                 and cardinality(att.attacl) > 0) then
    raise exception '0046: help_articles has a column grant';
  end if;
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.help_articles', 'select, insert, update, references') then
      raise exception '0046: % holds a column privilege on help_articles', p;
    end if;
  end loop;
  if has_any_column_privilege('authenticated', 'public.help_articles', 'insert, update, references')
     or has_any_column_privilege('service_role', 'public.help_articles', 'references') then
    raise exception '0046: an API role holds a column write or REFERENCES on help_articles';
  end if;

  -- ---- Policies: exactly the one read policy, for any role, its USING the tenant and the
  -- staff check, and no WITH CHECK. A write policy, a second read policy or a widened role
  -- fails here.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'help_articles') s;
  if v_have is distinct from array['help_articles_staff_read SELECT PERMISSIVE {authenticated}'] then
    raise exception '0046: help_articles policies are %, expected the staff read policy only', v_have;
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'help_articles'
                    and policyname = 'help_articles_staff_read'
                    and qual ~ v_read and with_check is null) then
    raise exception '0046: help_articles_staff_read is not (tenant predicate AND is_staff)';
  end if;

  -- ---- Keys and shape: one foreign key (the tenant), the slug unique per tenant, every
  -- CHECK in place, search_text a stored generated column, and no sequence of its own.
  if (select count(*) from pg_constraint
       where conrelid = 'public.help_articles'::regclass and contype = 'f') <> 1
     or not exists (
       select 1 from pg_constraint
        where conrelid = 'public.help_articles'::regclass and contype = 'f'
          and pg_get_constraintdef(oid) ~ '^FOREIGN KEY \(tenant_id\) REFERENCES (public\.)?tenants\(id\) ON DELETE CASCADE$')
     or not exists (
       select 1 from pg_constraint
        where conrelid = 'public.help_articles'::regclass and conname = 'help_articles_tenant_slug'
          and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, slug)') then
    raise exception '0046: help_articles must have its tenant key and a slug unique per tenant';
  end if;
  select coalesce(array_agg(conname::text order by conname), '{}') into v_have
    from pg_constraint
   where conrelid = 'public.help_articles'::regclass and contype = 'c';
  v_want := array['help_articles_body_ok', 'help_articles_caps_ok', 'help_articles_minutes_range',
                  'help_articles_screens_ok', 'help_articles_slug_shape', 'help_articles_tags_ok',
                  'help_articles_titles_ok'];
  if not (v_have @> v_want) then
    raise exception '0046: help_articles CHECKs are %, expected at least %', v_have, v_want;
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.help_articles'::regclass and attname = 'search_text'
                    and attgenerated = 's') then
    raise exception '0046: help_articles.search_text is not a stored generated column';
  end if;
  if exists (select 1 from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
              where d.refobjid = 'public.help_articles'::regclass) then
    raise exception '0046: help_articles owns a sequence (its key is a uuid)';
  end if;

  -- ---- Functions. The search: an invoker with an empty search path and a statement
  -- timeout, callable by staff tokens and by nobody else.
  if has_function_privilege('anon', 'public.help_search(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.help_search(uuid, text)', 'execute')
     or has_function_privilege('public', 'public.help_search(uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.help_search(uuid, text)', 'execute') then
    raise exception '0046: public.help_search must be executable by authenticated only';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'public.help_search(uuid, text)'::regprocedure and not prosecdef
                    and proconfig @> array['statement_timeout=500ms']
                    and exists (select 1 from unnest(proconfig) c
                                 where c in ('search_path=""', 'search_path='))) then
    raise exception '0046: public.help_search must be SECURITY INVOKER with an empty search_path and a 500 ms timeout';
  end if;
  -- The validators and the search text: the service role's (the writer's), nobody else's.
  foreach p in array array['app.help_text_ok(text, integer)',
                           'app.help_keys_ok(text[], text, integer)',
                           'app.help_body_ok(jsonb)',
                           'app.help_search_text(text, text, text[], jsonb)'] loop
    if not has_function_privilege('service_role', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('anon', p, 'execute')
       or has_function_privilege('public', p, 'execute') then
      raise exception '0046: % must be executable by service_role only', p;
    end if;
  end loop;
  -- The set, the seed and the triggers: no API role at all.
  foreach p in array array['app.help_article_set()', 'app.seed_help_articles(uuid)',
                           'app.tg_help_articles()', 'app.tg_tenant_help_defaults()'] loop
    if has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute')
       or has_function_privilege('public', p, 'execute') then
      raise exception '0046: % is executable by an API role', p;
    end if;
  end loop;
  -- Invokers and definers, each with an empty search path.
  foreach p in array array['app.help_text_ok(text, integer)',
                           'app.help_keys_ok(text[], text, integer)', 'app.help_body_ok(jsonb)',
                           'app.help_search_text(text, text, text[], jsonb)',
                           'app.help_article_set()', 'app.tg_help_articles()'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and not prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0046: % must be SECURITY INVOKER with an empty search_path', p;
    end if;
  end loop;
  foreach p in array array['app.seed_help_articles(uuid)', 'app.tg_tenant_help_defaults()'] loop
    if not exists (select 1 from pg_proc
                    where oid = p::regprocedure and prosecdef
                      and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                   where c in ('search_path=""', 'search_path='))) then
      raise exception '0046: % must be SECURITY DEFINER with an empty search_path', p;
    end if;
  end loop;

  -- ---- Triggers: the guard is the table's only BEFORE trigger, enabled; the tenants trigger
  -- seeds each new tenant, after the insert, enabled.
  if (select coalesce(array_agg(distinct t.trigger_name::text order by t.trigger_name::text), '{}')
        from information_schema.triggers t
       where t.event_object_schema = 'public' and t.event_object_table = 'help_articles'
         and t.action_timing = 'BEFORE') <> array['help_articles_guard']
     or not exists (select 1 from pg_trigger tg
                     where tg.tgrelid = 'public.help_articles'::regclass
                       and tg.tgname = 'help_articles_guard' and tg.tgenabled = 'O') then
    raise exception '0046: help_articles must have exactly one BEFORE trigger, help_articles_guard, enabled';
  end if;
  if not exists (select 1 from pg_trigger tg
                  where tg.tgrelid = 'public.tenants'::regclass and not tg.tgisinternal
                    and tg.tgname = 'tenants_help_defaults' and tg.tgenabled = 'O'
                    and pg_get_triggerdef(tg.oid) ~
                        ('^CREATE TRIGGER tenants_help_defaults AFTER INSERT ON (public\.)?tenants '
                         'FOR EACH ROW EXECUTE FUNCTION (app\.)?tg_tenant_help_defaults\(\)$')) then
    raise exception '0046: tenants_help_defaults is missing, disabled or not as stated';
  end if;

  -- ---- The rules do what they say: markup, a control character, a blank text, a kind or a
  -- key the shape does not know and a missing language are refused; plain text passes.
  if not (app.help_text_ok('Plain words, 10 characters.', 120)
          and not app.help_text_ok('<b>bold</b>', 120)
          and not app.help_text_ok(E'a\tb', 120)
          and not app.help_text_ok('   ', 120)
          and not app.help_text_ok(repeat('x', 121), 120)
          and app.help_body_ok('{"en": [{"t": "p", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}')
          and not app.help_body_ok('{"en": [{"t": "p", "x": "a"}]}')
          and not app.help_body_ok('{"en": [{"t": "html", "x": "a"}], "ar": [{"t": "p", "x": "ب"}]}')
          and not app.help_body_ok('{"en": [{"t": "p", "x": "a", "y": 1}], "ar": [{"t": "p", "x": "ب"}]}')
          and not app.help_body_ok('{"en": [{"t": "ol", "x": [{"t": "p"}]}], "ar": [{"t": "p", "x": "ب"}]}')
          and not app.help_body_ok('{"en": [{"t": "p", "x": "<script>"}], "ar": [{"t": "p", "x": "ب"}]}')
          and app.help_keys_ok(array['basics', 'leads'], '^[a-z][a-z0-9-]{0,23}$', 6)
          and not app.help_keys_ok(array['leads', 'leads'], '^[a-z][a-z0-9-]{0,23}$', 6)
          and not app.help_keys_ok(array[['a', 'b'], ['c', 'd']], '^[a-z]$', 6)) then
    raise exception '0046: the help validators do not apply the rules they state';
  end if;

  -- ---- Every tenant holds every guide of the set, each as the set has it.
  select count(*)::int into v_n
    from public.tenants t
    cross join jsonb_to_recordset(app.help_article_set()) as a (slug text, title text)
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = a.slug and h.title = a.title);
  if v_n > 0 or jsonb_array_length(app.help_article_set()) < 1 then
    raise exception '0046: % guide(s) of the set are missing from a tenant', v_n;
  end if;
end $$;
