-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0057 — Page visibility, without the password mode (Admin v2 U14a, AV-13+). Forward-only,
-- expand only. Depends on 0001 (pages, tenants, app.current_role, app.is_staff), 0009 (the
-- actor and version triggers), 0033 (app.live_role), 0038 (the release registry and
-- app.tg_snapshot_version), 0046 (the help centre), 0051 (app.tg_release_capture) and 0055
-- (the guides as U12a left them).
--
-- Who can see each CMS page of the public site, set by Admin and Developer (§5 "Maintenance /
-- hidden pages / page visibility", `maintenance.manage`). The Worker snapshots the table into
-- KV `site:visibility` on every save, and the middleware answers from that snapshot before it
-- renders anything (src/middleware.ts, src/lib/http/visibility.ts); the database is never on
-- a public request's path. What the database adds for it:
--
--   • pages_tenant_id_id, UNIQUE (tenant_id, id) on pages, for the composite keys below (the
--     profiles_tenant_id_id precedent, 0041): a row can name only a page of its own tenant,
--     whoever writes it, the service role included. A later file that drops it drops the two
--     foreign keys first.
--   • app.role_manages_visibility(r): one helper for maintenance.manage (CLAUDE.md §8, held
--     equal to ROLE_CAPS by tests/authz/sqlHelpers.spec.ts): Admin and Developer.
--   • public.page_visibility: one row per CMS page, or per template, that has ever been set.
--     No row is public, so nothing is seeded. Modes: public, hidden (a redirect to another
--     page of the tenant, or none: a 404) and link (unlisted: out of the menus, the sitemap,
--     llms.txt and search, noindex, but the link works). Hide-from and show-on instants
--     bound a hidden window ([hide_from, show_on), either end open). The two templates,
--     `service` (/services/[slug]) and `case_study` (/portfolio/[slug]), take public or
--     hidden only (U14 decision D1). The homepage is always public: the guard trigger
--     refuses any other mode on it, for every writer (23514 page_visibility_home).
--   • RLS, ENABLE + FORCE: every CMS role reads (registry contract #1: drafts and release
--     items will carry these rows); Admin and Developer insert and update, through the JWT
--     role and, RESTRICTIVE, through the live profile (app.live_role(), 0033), so a token
--     demoted, deactivated or locked writes nothing even at PostgREST. No DELETE policy and
--     no DELETE grant: "public" is a mode, so a row never needs deleting, and one goes only
--     with its page (on delete cascade). No anon access (decision D3): nothing public reads
--     the table, and an anon read would list every unlisted page.
--   • pages_route_slug_fixed, a trigger on public.pages: the slugs the public routes render
--     (PAGE_PATHS) never change, no page takes one by rename, and a page with a visibility row
--     keeps its slug, for every writer (23514). A setting is stored by page id and enforced by
--     slug, so a rename would otherwise let a role without maintenance.manage move or drop one.
--   • The release registry row (registry contract #4) with the snapshot and capture triggers
--     every registry table carries (0038, 0051): staged once releases switch on (P-3, R14),
--     immediate until then.
--   • app.help_article_set() restated and seeded into every tenant again: 0055's set and one
--     new guide, page-visibility.
--
-- Grants are stated for both Supabase privilege regimes (README P-14). Production as of
-- 2026-10-16: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046, 0048, 0050-0052,
-- 0054 and 0055 (U12a). CLAUDE.md §3 (Pillar 1), §5, §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: pages gains a unique constraint (its index
-- build holds a SHARE lock) and the reseed writes public.help_articles. A statement that waits
-- more than five seconds for a lock raises, the whole migration rolls back, and the push is
-- retried later. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. The pages' composite key ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.pages'::regclass and conname = 'pages_tenant_id_id') then
    alter table public.pages add constraint pages_tenant_id_id unique (tenant_id, id);
  end if;
end $$;

-- ---- 2. One helper for maintenance.manage -----------------------------------------------------
-- `language sql immutable`, so the planner inlines it (as app.role_works_leads, 0033).
create or replace function app.role_manages_visibility(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- maintenance.manage
revoke all on function app.role_manages_visibility(text) from public, anon, authenticated, service_role;
grant execute on function app.role_manages_visibility(text) to authenticated, service_role;

-- ---- 3. The table -------------------------------------------------------------------------------
create table if not exists public.page_visibility (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  -- Exactly one of the two: a CMS page, or a template.
  page_id uuid,
  template text constraint page_visibility_template_known
    check (template in ('service', 'case_study')),
  mode text not null default 'public'
    constraint page_visibility_mode_known check (mode in ('public', 'hidden', 'link')),
  -- Where a hidden page sends its visitors (a 302): another page of the tenant, or null for
  -- a 404. Set to null when that page is deleted.
  redirect_page_id uuid,
  -- The hidden window, [hide_from, show_on): either end may be open. The admin sets them as
  -- Riyadh days, stored as the instant of that day's midnight in Riyadh (decision D4).
  hide_from timestamptz,
  show_on timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint page_visibility_one_target check (num_nonnulls(page_id, template) = 1),
  constraint page_visibility_page_fk foreign key (tenant_id, page_id)
    references public.pages (tenant_id, id) on delete cascade,
  constraint page_visibility_redirect_fk foreign key (tenant_id, redirect_page_id)
    references public.pages (tenant_id, id) on delete set null (redirect_page_id),
  constraint page_visibility_page_unique unique (tenant_id, page_id),
  constraint page_visibility_template_unique unique (tenant_id, template),
  constraint page_visibility_redirect_hidden check (redirect_page_id is null or mode = 'hidden'),
  constraint page_visibility_dates_hidden
    check ((hide_from is null and show_on is null) or mode = 'hidden'),
  constraint page_visibility_dates_order
    check (hide_from is null or show_on is null or show_on > hide_from),
  constraint page_visibility_template_modes check (template is null or mode in ('public', 'hidden')),
  -- Null on either side passes (a template has no page to be; a 404 has no target).
  constraint page_visibility_redirect_not_self
    check (redirect_page_id is null or redirect_page_id <> page_id)
);
-- The redirect key's lookup when a page is deleted (the set-null action reads by it).
create index if not exists page_visibility_redirect_idx
  on public.page_visibility (tenant_id, redirect_page_id) where redirect_page_id is not null;
alter table public.page_visibility enable row level security;
alter table public.page_visibility force row level security;
comment on table public.page_visibility is
  'Who can see each CMS page of the public site (Admin v2 U14a, 0057): public, hidden (a 302 '
  'to another page, or a 404) or link only, with an optional hidden window; the two templates '
  'public or hidden only; the homepage always public. No row = public. The Worker snapshots '
  'it into KV site:visibility, which the middleware reads; nothing public reads the table.';

-- ---- 4. Triggers ---------------------------------------------------------------------------------
-- The guard: the homepage is always public (to take the whole site down, maintenance mode),
-- and a row's target never moves (a row is about one page or one template for good). Invoker:
-- it reads the page's slug under the writer's RLS, which shows staff every page of their
-- tenant, and the service role all of them; the composite key has already refused a page of
-- another tenant.
create or replace function app.tg_page_visibility_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (new.page_id is distinct from old.page_id or new.template is distinct from old.template
          or new.tenant_id is distinct from old.tenant_id) then
    raise exception 'page_visibility: a row''s page or template cannot change'
      using errcode = '23514', constraint = 'page_visibility_target_fixed';
  end if;
  if new.page_id is not null and new.mode <> 'public'
     and exists (select 1 from public.pages p
                  where p.tenant_id = new.tenant_id and p.id = new.page_id
                    and pg_catalog.lower(p.slug::text) = 'home') then
    raise exception 'The homepage cannot be hidden. Use maintenance mode instead.'
      using errcode = '23514', constraint = 'page_visibility_home';
  end if;
  return new;
end $$;
revoke all on function app.tg_page_visibility_guard() from public, anon, authenticated, service_role;

drop trigger if exists page_visibility_actor on public.page_visibility;
create trigger page_visibility_actor before insert or update on public.page_visibility
  for each row execute function app.tg_set_actor();
drop trigger if exists page_visibility_guard on public.page_visibility;
create trigger page_visibility_guard before insert or update on public.page_visibility
  for each row execute function app.tg_page_visibility_guard();
drop trigger if exists page_visibility_updated_at on public.page_visibility;
create trigger page_visibility_updated_at before update on public.page_visibility
  for each row execute function app.tg_set_updated_at();
drop trigger if exists page_visibility_version on public.page_visibility;
create trigger page_visibility_version before update on public.page_visibility
  for each row execute function app.tg_bump_version();
-- History, as every registry table but team_members keeps it (0038).
drop trigger if exists page_visibility_snapshot on public.page_visibility;
create trigger page_visibility_snapshot after insert or update on public.page_visibility
  for each row execute function app.tg_snapshot_version('page_visibility');
-- What a release changes, as every registry table but team_members records it (0051); the
-- table has no generated column, so the third argument is empty.
drop trigger if exists page_visibility_release_capture on public.page_visibility;
create trigger page_visibility_release_capture
  after insert or update or delete on public.page_visibility
  for each row execute function app.tg_release_capture('page_visibility', 'id', '');

-- The route-bound pages keep their slugs. A setting is stored by page id, but the edge
-- enforces it by the page's slug (the snapshot names each page by slug, and each public route
-- renders one fixed slug, src/lib/visibility/routes.ts), and Content Creator may edit
-- `pages.slug` (pages.write). Without this, renaming a hidden page off its route would show
-- the route again at the next snapshot, and swapping two slugs would move a setting from one
-- page to another: a role without maintenance.manage changing who sees a page. So a slug in
-- the route map never changes, no page takes one by rename, and a page with a visibility row
-- keeps its slug, for every writer, the service role and the migration role included. Nothing
-- legitimate is lost: renaming one of these pages already breaks its route. The homepage's
-- guard (above) reads the slug when a row is written, and this keeps it true afterwards.
-- Invoker: it reads page_visibility under the writer's RLS (every CMS role reads its tenant's
-- rows; the service role all of them). The slug list is PAGE_PATHS's keys; tests/lib/
-- visibilityRoutes.spec.ts holds the two equal.
create or replace function app.tg_pages_route_slug_fixed() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if new.slug::text is distinct from old.slug::text
     and (pg_catalog.lower(old.slug::text) = any (array['home', 'about', 'contact', 'join',
                                                       'services', 'portfolio', 'portfolio-all'])
          or pg_catalog.lower(new.slug::text) = any (array['home', 'about', 'contact', 'join',
                                                          'services', 'portfolio', 'portfolio-all'])
          or exists (select 1 from public.page_visibility v
                      where v.tenant_id = old.tenant_id and v.page_id = old.id)) then
    raise exception 'This page''s address is part of the site''s routes and cannot change.'
      using errcode = '23514', constraint = 'pages_route_slug_fixed',
            detail = 'Failing row violates check constraint "pages_route_slug_fixed".';
  end if;
  return new;
end $$;
revoke all on function app.tg_pages_route_slug_fixed() from public, anon, authenticated, service_role;

drop trigger if exists pages_route_slug_fixed on public.pages;
create trigger pages_route_slug_fixed before update of slug on public.pages
  for each row execute function app.tg_pages_route_slug_fixed();

-- ---- 5. RLS ------------------------------------------------------------------------------------
-- Every policy is for staff tokens (TO authenticated) and states the tenant first. The JWT
-- layer: every CMS role reads; Admin and Developer insert and update. The live layer,
-- RESTRICTIVE, one per writing command: the profile's role read at query time must manage
-- visibility, so a token whose profile was demoted, deactivated or locked writes nothing.
drop policy if exists page_visibility_read on public.page_visibility;
create policy page_visibility_read on public.page_visibility for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
drop policy if exists page_visibility_insert on public.page_visibility;
create policy page_visibility_insert on public.page_visibility for insert to authenticated
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_visibility(app.current_role()));
drop policy if exists page_visibility_update on public.page_visibility;
create policy page_visibility_update on public.page_visibility for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_manages_visibility(app.current_role()))
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_visibility(app.current_role()));
drop policy if exists page_visibility_live_insert on public.page_visibility;
create policy page_visibility_live_insert on public.page_visibility
  as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_visibility((select app.live_role())));
drop policy if exists page_visibility_live_update on public.page_visibility;
create policy page_visibility_live_update on public.page_visibility
  as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_visibility((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id()
              and app.role_manages_visibility((select app.live_role())));
-- No permissive DELETE policy exists, so nobody deletes through the API; this one keeps it so
-- if a later file adds one without thinking.
drop policy if exists page_visibility_live_delete on public.page_visibility;
create policy page_visibility_live_delete on public.page_visibility
  as restrictive for delete to authenticated
  using (tenant_id = app.effective_tenant_id()
         and app.role_manages_visibility((select app.live_role())));

-- ---- 6. Grants, stated (README P-14: both Supabase grant regimes) -----------------------------
-- authenticated: read; insert the row's own columns (`id` too: a release's create names the
-- id its draft pre-allocated, 0051) and update the mode and its extras, never the target.
-- service_role: read (the daily cron's re-sync) and UPDATE, which the release apply needs to
-- lock a live row FOR UPDATE as the service role (0051's contract for every registry table).
-- Nothing for anon or PUBLIC. No sequence (the key is a uuid).
revoke all on public.page_visibility from public, anon, authenticated, service_role;
grant select on public.page_visibility to authenticated;
grant insert (id, tenant_id, page_id, template, mode, redirect_page_id, hide_from, show_on)
  on public.page_visibility to authenticated;
grant update (mode, redirect_page_id, hide_from, show_on) on public.page_visibility to authenticated;
grant select, update on public.page_visibility to service_role;

-- ---- 7. The release registry -------------------------------------------------------------------
-- Registry contract #4 (releases.md §1.3): staged once releases switch on (P-3), the KV
-- snapshot rebuilt after every apply and rollback (R7). Apply order 85: after pages (80),
-- whose ids it names. No delete roles: a release never removes a row (see section 5).
-- One row per line group, parsed by tests/fixtures/releaseRegistry.ts: keep the shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('page_visibility', 'page_visibility', 'id', 'settings', '{admin,developer}', '{}',
   '{page_id,template,mode,redirect_page_id,hide_from,show_on}',
   '{}', '{}', '{}', 85, false, null)
on conflict (entity_type) do nothing;

-- ---- 8. The guides ------------------------------------------------------------------------------
-- The set as 0055 (U12a) left it, with one guide added, page-visibility, after
-- maintenance-mode. A later slice that changes a guide restates the set from this text (U16's
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
    "slug": "page-visibility",
    "sort_order": 105,
    "minutes": 2,
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
          "x": "Page visibility decides who can see each page of the public site. A change applies to the live site within a minute, and the admin keeps working as usual."
        },
        {
          "t": "ol",
          "x": [
            "Visible to everyone is the normal setting: the page is in the menus and in search engines, and open to all.",
            "Hidden from the site takes the page out of the menus, the sitemap and search engines. Anyone who opens its link is sent to the page you choose, or sees a page not found screen.",
            "To hide a page for a while, give it a Hide from day, a Show again on day, or both. It is hidden from the start of the first day until the start of the second, Riyadh time. Leave both empty to hide it until you show it again.",
            "Only people with the link keeps the page out of the menus, the sitemap and search engines, but the link still works. It is unlisted, not private: anyone who has the link can open it, so keep anything confidential off it.",
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
          "x": "يحدد ظهور الصفحات من يستطيع رؤية كل صفحة من صفحات الموقع العام. يسري التغيير على الموقع المباشر خلال دقيقة، وتستمر لوحة الإدارة في العمل كالمعتاد."
        },
        {
          "t": "ol",
          "x": [
            "الخيار المعتاد هو Visible to everyone: تظهر الصفحة في القوائم وفي محركات البحث، ويستطيع الجميع فتحها.",
            "يُخرج خيار Hidden from the site الصفحة من القوائم وخريطة الموقع ومحركات البحث. ومن يفتح رابطها يُنقل إلى الصفحة التي تختارها، أو تظهر له صفحة تقول إن الصفحة غير موجودة.",
            "لإخفاء صفحة مدة محددة، حدّد لها يوم Hide from أو يوم Show again on أو كليهما. تبقى مخفية من بداية اليوم الأول حتى بداية اليوم الثاني بتوقيت الرياض. اترك الحقلين فارغين لإخفائها حتى تعيد إظهارها.",
            "يُبقي خيار Only people with the link الصفحة خارج القوائم وخريطة الموقع ومحركات البحث، لكن رابطها يظل يعمل. فهي غير مدرجة وليست خاصة: يستطيع فتحها كل من لديه الرابط، فلا تضع عليها أي معلومات سرية.",
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

-- Every tenant gets the new guide (app.seed_help_articles inserts a guide a tenant lacks and
-- updates one only where it differs from the set; 0046).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions -----------------------------------------------------------------------------
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
  v_insert constant text[] := array['hide_from', 'id', 'mode', 'page_id', 'redirect_page_id',
                                    'show_on', 'template', 'tenant_id'];
  v_update constant text[] := array['hide_from', 'mode', 'redirect_page_id', 'show_on'];
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_read constant text := '^\(' || v_tenant || ' AND (app\.)?is_staff\(\)\)$';
  v_jwt constant text :=
    '^\(' || v_tenant || ' AND (app\.)?role_manages_visibility\((app\.)?"?current_role"?\(\)\)\)$';
  v_live constant text :=
    '^\(' || v_tenant || ' AND (app\.)?role_manages_visibility\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$';
  v_cols text[];
  v_have text[];
  v_want text[];
  v_bad text;
  v_set jsonb;
  p text;
begin
  -- ---- The helper: Admin and Developer, for every role the enum knows and for none; staff
  -- and the service role may call it, anon and PUBLIC may not; inlinable (immutable, invoker).
  if not (app.role_manages_visibility('admin')
          and app.role_manages_visibility('developer')
          and not app.role_manages_visibility('content_creator')
          and not app.role_manages_visibility('seo')
          and not app.role_manages_visibility('anon')
          and not app.role_manages_visibility(null)) then
    raise exception '0057: app.role_manages_visibility does not answer maintenance.manage (Admin and Developer)';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.role_manages_visibility(text)'::regprocedure
                    and provolatile = 'i' and not prosecdef) then
    raise exception '0057: app.role_manages_visibility must be IMMUTABLE and SECURITY INVOKER';
  end if;
  if not has_function_privilege('authenticated', 'app.role_manages_visibility(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_manages_visibility(text)', 'execute')
     or has_function_privilege('anon', 'app.role_manages_visibility(text)', 'execute')
     or has_function_privilege('public', 'app.role_manages_visibility(text)', 'execute') then
    raise exception '0057: app.role_manages_visibility must be executable by authenticated and service_role only';
  end if;
  -- The live role it is given: a definer staff tokens alone may call (0033).
  if not exists (select 1 from pg_proc where oid = 'app.live_role()'::regprocedure and prosecdef)
     or not has_function_privilege('authenticated', 'app.live_role()', 'execute')
     or has_function_privilege('anon', 'app.live_role()', 'execute') then
    raise exception '0057: app.live_role() must be a SECURITY DEFINER that authenticated alone executes';
  end if;

  -- ---- pages_tenant_id_id: unique on exactly (tenant_id, id), and both keys rest on it.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.pages'::regclass and conname = 'pages_tenant_id_id'
                    and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)') then
    raise exception '0057: pages_tenant_id_id must be UNIQUE (tenant_id, id)';
  end if;
  select string_agg(x.name, ', ' order by x.name) into v_bad
    from (values ('page_visibility_page_fk',
                  '^FOREIGN KEY \(tenant_id, page_id\) REFERENCES (public\.)?pages\(tenant_id, id\) ON DELETE CASCADE$'),
                 ('page_visibility_redirect_fk',
                  '^FOREIGN KEY \(tenant_id, redirect_page_id\) REFERENCES (public\.)?pages\(tenant_id, id\) ON DELETE SET NULL \(redirect_page_id\)$'))
           as x(name, pattern)
   where not exists (
     select 1 from pg_constraint f
       join pg_constraint k on k.conrelid = 'public.pages'::regclass
                           and k.conname = 'pages_tenant_id_id' and k.conindid = f.conindid
      where f.conrelid = 'public.page_visibility'::regclass and f.conname = x.name
        and f.contype = 'f' and pg_get_constraintdef(f.oid) ~ x.pattern);
  if v_bad is not null
     or (select count(*) from pg_constraint
          where conrelid = 'public.page_visibility'::regclass and contype = 'f') <> 3 then
    raise exception '0057: page_visibility keys are not as stated (the tenant, the page and the redirect, both on pages_tenant_id_id): %', v_bad;
  end if;

  -- ---- The table's rules, by name: one target, the known modes and templates, the two
  -- unique targets per tenant, the redirect and the dates only on a hidden row, the window in
  -- order, templates public or hidden, no redirect to itself.
  select coalesce(array_agg(conname::text order by conname), '{}') into v_have
    from pg_constraint
   where conrelid = 'public.page_visibility'::regclass and contype in ('c', 'u');
  if v_have is distinct from array['page_visibility_dates_hidden', 'page_visibility_dates_order',
                                   'page_visibility_mode_known', 'page_visibility_one_target',
                                   'page_visibility_page_unique', 'page_visibility_redirect_hidden',
                                   'page_visibility_redirect_not_self',
                                   'page_visibility_template_known',
                                   'page_visibility_template_modes',
                                   'page_visibility_template_unique'] then
    raise exception '0057: page_visibility CHECK and UNIQUE constraints are %', v_have;
  end if;

  -- ---- RLS on and forced, and exactly these policies (name, command, kind and roles compared
  -- as a set, so one added, dropped, renamed, made permissive or widened fails here).
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.page_visibility'::regclass) then
    raise exception '0057: page_visibility is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'page_visibility') s;
  if v_have is distinct from array['page_visibility_insert INSERT PERMISSIVE {authenticated}',
                                   'page_visibility_live_delete DELETE RESTRICTIVE {authenticated}',
                                   'page_visibility_live_insert INSERT RESTRICTIVE {authenticated}',
                                   'page_visibility_live_update UPDATE RESTRICTIVE {authenticated}',
                                   'page_visibility_read SELECT PERMISSIVE {authenticated}',
                                   'page_visibility_update UPDATE PERMISSIVE {authenticated}'] then
    raise exception '0057: page_visibility policies are %', v_have;
  end if;

  -- ---- Each side of each policy, read separately: the tenant predicate first, then the role
  -- test, on every side the command has; a side it does not have is absent.
  select string_agg(format('%s %s', x.policy, x.side), ', ' order by x.policy, x.side) into v_bad
    from (values ('page_visibility_read', 'using', v_read),
                 ('page_visibility_read', 'with check', null),
                 ('page_visibility_insert', 'using', null),
                 ('page_visibility_insert', 'with check', v_jwt),
                 ('page_visibility_update', 'using', v_jwt),
                 ('page_visibility_update', 'with check', v_jwt),
                 ('page_visibility_live_insert', 'using', null),
                 ('page_visibility_live_insert', 'with check', v_live),
                 ('page_visibility_live_update', 'using', v_live),
                 ('page_visibility_live_update', 'with check', v_live),
                 ('page_visibility_live_delete', 'using', v_live),
                 ('page_visibility_live_delete', 'with check', null)) as x(policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = 'page_visibility' and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0057: page_visibility policy expressions are not as stated: %', v_bad;
  end if;

  -- ---- Table privileges, as each API role holds them (directly or through a role it is a
  -- member of): exactly these, and nothing else of v_privs. PUBLIC and anon nothing;
  -- authenticated SELECT (its INSERT and UPDATE are column grants, below); service_role SELECT
  -- and UPDATE, never INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.page_visibility', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select', 'update']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0057: wrong table privileges on page_visibility (role privilege): %', v_bad;
  end if;

  -- ---- The table's own ACL, grantee by grantee: the owner's, plus exactly the grants above.
  -- A grant to any other role (a later custom role, supabase_auth_admin) fails here.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s',
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_class c
            cross join lateral aclexplode(c.relacl) a
           where c.oid = 'public.page_visibility'::regclass
             and a.grantee <> c.relowner) s;
  if v_have is distinct from array['authenticated select', 'service_role select',
                                   'service_role update'] then
    raise exception '0057: page_visibility is granted %, expected authenticated select and service_role select, update', v_have;
  end if;

  -- ---- Column grants: exactly authenticated's INSERT on the row's own columns and UPDATE on
  -- the mode and its extras, and no other column grant to anyone.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s', att.attname,
                        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                        lower(a.privilege_type)) as e
            from pg_attribute att
            cross join lateral aclexplode(att.attacl) a
           where att.attrelid = 'public.page_visibility'::regclass
             and att.attnum > 0 and not att.attisdropped) s;
  select array_agg(e order by e) into v_want
    from (select format('%s authenticated insert', c) as e from unnest(v_insert) c
          union all
          select format('%s authenticated update', c) from unnest(v_update) c) s;
  if v_have is distinct from v_want then
    raise exception '0057: page_visibility column grants are %, expected %', v_have, v_want;
  end if;

  -- ---- Column privileges as held: PUBLIC and anon none on any column; no API role
  -- REFERENCES one; authenticated INSERT exactly v_insert and UPDATE exactly v_update.
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.page_visibility', 'select, insert, update, references') then
      raise exception '0057: % holds a column privilege on page_visibility', p;
    end if;
  end loop;
  foreach p in array array['authenticated', 'service_role'] loop
    if has_any_column_privilege(p::name, 'public.page_visibility', 'references') then
      raise exception '0057: % holds REFERENCES on a column of page_visibility', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.page_visibility'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.page_visibility', a.attname::text, 'insert');
  if v_cols is distinct from v_insert then
    raise exception '0057: authenticated inserts columns % (expected exactly %)', v_cols, v_insert;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.page_visibility'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.page_visibility', a.attname::text, 'update');
  if v_cols is distinct from v_update then
    raise exception '0057: authenticated updates columns % (expected exactly %)', v_cols, v_update;
  end if;

  -- ---- The triggers: exactly these six, enabled, with no WHEN clause, each by name, timing
  -- and events (tgtype: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16) and its function
  -- compared by oid, the snapshot's and the capture's arguments as 0038 and 0051 give them.
  select coalesce(array_agg(t.tgname::text order by t.tgname collate "C"), '{}') into v_have
    from pg_trigger t
   where t.tgrelid = 'public.page_visibility'::regclass and not t.tgisinternal
     and t.tgenabled::text = 'O' and t.tgqual is null
     and ((t.tgname = 'page_visibility_actor' and t.tgtype = 23 and t.tgnargs = 0
           and t.tgfoid = 'app.tg_set_actor()'::regprocedure)
          or (t.tgname = 'page_visibility_guard' and t.tgtype = 23 and t.tgnargs = 0
              and t.tgfoid = 'app.tg_page_visibility_guard()'::regprocedure)
          or (t.tgname = 'page_visibility_updated_at' and t.tgtype = 19 and t.tgnargs = 0
              and t.tgfoid = 'app.tg_set_updated_at()'::regprocedure)
          or (t.tgname = 'page_visibility_version' and t.tgtype = 19 and t.tgnargs = 0
              and t.tgfoid = 'app.tg_bump_version()'::regprocedure)
          or (t.tgname = 'page_visibility_snapshot' and t.tgtype = 21 and t.tgnargs = 1
              and t.tgargs = convert_to('page_visibility', 'UTF8') || '\x00'::bytea
              and t.tgfoid = 'app.tg_snapshot_version()'::regprocedure)
          or (t.tgname = 'page_visibility_release_capture' and t.tgtype = 29 and t.tgnargs = 3
              and t.tgargs = convert_to('page_visibility', 'UTF8') || '\x00'::bytea
                             || convert_to('id', 'UTF8') || '\x00'::bytea || '\x00'::bytea
              and t.tgfoid = 'app.tg_release_capture()'::regprocedure));
  if v_have is distinct from array['page_visibility_actor', 'page_visibility_guard',
                                   'page_visibility_release_capture', 'page_visibility_snapshot',
                                   'page_visibility_updated_at', 'page_visibility_version']
     or (select count(*) from pg_trigger t
          where t.tgrelid = 'public.page_visibility'::regclass and not t.tgisinternal) <> 6 then
    raise exception '0057: page_visibility triggers are %, expected the six as stated', v_have;
  end if;
  -- The guard: an invoker with a pinned search path, callable by no API role.
  if not exists (select 1 from pg_proc
                  where oid = 'app.tg_page_visibility_guard()'::regprocedure and not prosecdef
                    and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                 where c in ('search_path=""', 'search_path='))) then
    raise exception '0057: app.tg_page_visibility_guard must be SECURITY INVOKER with an empty search_path';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.tg_page_visibility_guard()', 'execute') then
      raise exception '0057: % may execute app.tg_page_visibility_guard()', p;
    end if;
  end loop;

  -- ---- The route-bound slugs: one trigger on pages, BEFORE UPDATE OF slug, row level,
  -- enabled, no WHEN, its function an invoker with an empty search path that no API role may
  -- call.
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.pages'::regclass and not t.tgisinternal
         and t.tgname = 'pages_route_slug_fixed' and t.tgtype = 19 and t.tgenabled::text = 'O'
         and t.tgqual is null and t.tgnargs = 0
         and t.tgfoid = 'app.tg_pages_route_slug_fixed()'::regprocedure
         and t.tgattr::text = (select a.attnum::text from pg_attribute a
                                where a.attrelid = 'public.pages'::regclass
                                  and a.attname = 'slug')) <> 1 then
    raise exception '0057: pages_route_slug_fixed must be BEFORE UPDATE OF slug, for each row';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.tg_pages_route_slug_fixed()'::regprocedure and not prosecdef
                    and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                 where c in ('search_path=""', 'search_path='))) then
    raise exception '0057: app.tg_pages_route_slug_fixed must be SECURITY INVOKER with an empty search_path';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.tg_pages_route_slug_fixed()', 'execute') then
      raise exception '0057: % may execute app.tg_pages_route_slug_fixed()', p;
    end if;
  end loop;

  -- ---- The registry row, field by field.
  if not exists (
       select 1 from app.release_entities e
        where e.entity_type = 'page_visibility' and e.table_name = 'page_visibility'
          and e.key_column = 'id' and e.area = 'settings'
          and e.author_roles = array['admin', 'developer'] and e.delete_roles = '{}'::text[]
          and e.columns = array['page_id', 'template', 'mode', 'redirect_page_id', 'hide_from', 'show_on']
          and e.deferred_columns = '{}'::text[] and e.unique_flags = '{}'::text[]
          and e.exempt_columns = '{}'::text[] and e.apply_order = 85
          and not e.has_status and e.publish_flag is null) then
    raise exception '0057: the page_visibility registry row is not as stated';
  end if;

  -- ---- The guides: the set parses, no API role reads it, and every tenant holds the new
  -- guide as the set states it.
  v_set := app.help_article_set();
  if jsonb_typeof(v_set) <> 'array'
     or not exists (select 1 from jsonb_array_elements(v_set) a
                     where a ->> 'slug' = 'page-visibility'
                       and a -> 'caps' = '["maintenance.manage"]'::jsonb
                       and a -> 'screens' = '["/admin/visibility"]'::jsonb) then
    raise exception '0057: app.help_article_set() does not hold the page-visibility guide';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.help_article_set()', 'execute') then
      raise exception '0057: % may execute app.help_article_set()', p;
    end if;
  end loop;
  if exists (select 1 from public.tenants t
              where not exists (
                select 1 from public.help_articles h
                  join jsonb_to_recordset(v_set) as a (slug text, body jsonb)
                    on a.slug = h.slug
                 where h.tenant_id = t.id and h.slug = 'page-visibility'
                   and h.body = a.body)) then
    raise exception '0057: a tenant does not hold the page-visibility guide';
  end if;
end $$;
