-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0093 — The Sales role, part B: what the role may reach (Admin v2 C10a, owner decision A4;
-- docs/admin-v2/crm.md §10, the approved plan's B2 C10a paragraph). Forward-only. Depends on
-- 0092 (the enum value, committed in its own file: 55P04), 0001 (app.current_role,
-- app.is_staff), 0002 (audit_log, audit_insert), 0021/0028 (testimonials, disciplines,
-- service_cases and the sample lock), 0024 (media_assets' public read), 0030 + 0041 (the
-- staff UPDATE grant on leads), 0033 (app.role_works_leads), 0044 (app.staff_directory,
-- crm_people), 0046 (help_articles), 0050 (the audit actor binding) and 0052
-- (app.role_analytics_read).
--
-- Sales works leads, and is NOT CMS staff. ROLE_CAPS gives it three capabilities:
-- leads.manage, leads.pii (one lead at a time, through the reveal: live-rechecked,
-- rate-limited and audited before anything is decrypted; owner default O-6) and
-- analytics.read (prototype parity, README's CRM matrix). Nothing else: no content, no
-- settings, no exports or backups, no job applications, no logs, activity log or site
-- health, no users, no erasure, no bulk contact details (A4).
--
-- Every existing policy names its roles (app.is_staff() names four, the helpers their own
-- lists), so a new enum value gets nothing until something names it. This file names it
-- where ROLE_CAPS says, and closes the places where "a signed-in token that is not staff"
-- used to mean "a trusted context", now that such a token can exist:
--
--   1. app.is_member(): any of the five roles, by the token's claim. Used by exactly one
--      policy, audit_insert (README P-6: "is_member is for audit_insert only"). app.is_staff()
--      is NOT changed: it stays the four CMS roles and keeps gating drafts, media, redirects,
--      themes, settings, integrations, versions, page visibility, the password fence and the
--      rest, so Sales reads none of those.
--   2. audit_insert: the tenant predicate first, then app.is_member(), then the row names
--      its writer (actor_id = auth.uid(); 0050's trigger already stamps it, so this is the
--      policy agreeing with the trigger rather than trusting it alone). Sales writes its own
--      audit rows (the reveal's fail-closed row is written with the caller's token) and no
--      token writes one in a colleague's name.
--   3. The capability helpers gain 'sales' where ROLE_CAPS says so: app.role_works_leads
--      (leads.manage) and app.role_analytics_read (analytics.read). The others are
--      unchanged (users, audit, site health, visibility, erasure stay off for Sales).
--      tests/authz/sqlHelpers.spec.ts holds every helper equal to ROLE_CAPS.
--   4. A RESTRICTIVE non-staff block on three of the four tables whose published rows anon
--      reads while `authenticated` holds more columns than anon: testimonials (the consent
--      columns, consent_obtained_at and consent_reference, which are personal data),
--      service_cases (its schedule, placeholder and bookkeeping columns) and media_assets
--      (folders, tags, the provider's reference, the stored name). RLS is row-level and
--      Postgres cannot tell the app roles apart in a GRANT (they share one role), so a
--      signed-in token that is not CMS staff reads NO row of these three; staff are
--      untouched, anon is untouched (the policies are TO authenticated). The fourth,
--      disciplines, is NOT blocked: the services a visitor sees hang on their discipline's
--      row (services_discipline_published, 0028, reads it under the caller's own RLS), so a
--      block would hide every published service from Sales and break its leads' interest
--      labels. Its extra columns are the schedule and bookkeeping (scheduled_for, version,
--      created_at and the ids of the staff who wrote it), no visitor's data; it is the one
--      named exception in supabase/tests/rls_sales_role.test.sql, which proves from the
--      catalog that Sales sees no more than anon of every other relation outside the CRM.
--   5. The sample lock's trusted context (app.tg_testimonial_sample_lock, 0028) was "not
--      app.is_staff()": seeds, psql and the cron carry no role claim. A Sales token is not
--      staff but does carry one, so the test is now "no role claim at all", and the lock
--      holds for every signed-in token.
--   6. The legacy UPDATE on leads(status, internal_notes) (0030) is revoked from
--      authenticated. Nothing writes them as a person any more: C4b's PATCH refuses
--      internalNotes, and this slice's refuses the legacy status (the pipeline's stage is
--      the one way to move a lead; the BEFORE trigger still keeps status in step, which
--      needs no column privilege). Staff UPDATE on leads is exactly the pipeline's columns.
--   7. The people directory (app.staff_directory, P-7): CMS staff get every active member,
--      as before; a member who is not CMS staff gets only the assignable lead workers, and
--      only while its own live role works leads. crm_people (0044), which reads the
--      directory, so answers Sales with the assignable lead workers and nobody else.
--   8. help_articles: any live member reads its tenant's guides (the Worker then shows a
--      role only the guides for capabilities it holds, src/lib/admin/help/access.ts; the
--      guides are in the public repository, 0046). By the live role, not app.is_member().
--   8b. admin_role_defaults (0060): an Admin saves a dashboard preset for every role, Sales
--      included (the Worker's modal lists ROLES), but 0060's read required app.is_staff(),
--      so a Sales token read no row and its preset was silently ignored. The read is now any
--      live member's own role's preset, an Admin every role's: app.is_staff() is replaced by
--      the live check (0060's RESTRICTIVE admin_role_defaults_live already requires one;
--      it is restated in the permissive branch so the policy reads alone). The writes are
--      unchanged (an Admin, by the live role).
--
-- Sales holds no new grant: every privilege it uses is `authenticated`'s, which the staff
-- roles already share. No table is created here.
--
-- HELP GUIDES (section 9): this slice's guide, the-sales-role (sort_order 75), is put into
-- H11's catalog, and the roles guide (roles-and-access) is put again with five roles. Neither
-- restates app.help_article_set().
--
-- Rollout (docs/launch-runbook.md): 0092, then this file, then the deploy; then invite Sales
-- users. This file revokes a privilege (section 6), and the Worker that merges with it
-- already refuses the legacy status, so the code may deploy first; the old Worker answers a
-- legacy-status PATCH from a stale tab with a refusal between the push and the deploy.
-- Production: PostgreSQL 17.6, migrations run as postgres (BYPASSRLS), one tenant.
-- CLAUDE.md §3 (Pillar 1), §5, §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A statement that waits more than five seconds for a lock raises, the migration rolls
-- back, and the push is retried later. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. app.is_member() ------------------------------------------------------------------
-- The token's claim, like app.is_staff(): a policy branch, not a live check. Every caller of
-- a write it opens is also bound by that table's own rules (audit_log's actor trigger).
create or replace function app.is_member() returns boolean
  language sql stable set search_path = ''
as $$ select app.current_role() in ('admin', 'content_creator', 'seo', 'developer', 'sales') $$;
revoke all on function app.is_member() from public, anon, authenticated, service_role;
grant execute on function app.is_member() to authenticated, service_role;

-- ---- 2. audit_insert -----------------------------------------------------------------------
drop policy if exists audit_insert on public.audit_log;
create policy audit_insert on public.audit_log for insert
  with check (tenant_id = app.effective_tenant_id() and app.is_member()
              and actor_id = (select auth.uid()));

-- ---- 3. The capability helpers -------------------------------------------------------------
-- `language sql immutable`, inlined by the planner (0033). Each mirrors one ROLE_CAPS column.
create or replace function app.role_works_leads(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer', 'sales'), false) $$;  -- leads.manage
revoke all on function app.role_works_leads(text) from public, anon, authenticated, service_role;
grant execute on function app.role_works_leads(text) to authenticated, service_role;

create or replace function app.role_analytics_read(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'content_creator', 'developer', 'sales', 'seo'), false) $$;  -- analytics.read
revoke all on function app.role_analytics_read(text) from public, anon, authenticated, service_role;
grant execute on function app.role_analytics_read(text) to authenticated, service_role;

-- ---- 4. The non-staff block ----------------------------------------------------------------
-- RESTRICTIVE, FOR SELECT, TO authenticated: the tenant predicate first (P-14), then CMS
-- staff. Staff already pass every permissive read these tables have; anon is not named.
drop policy if exists testimonials_staff_columns on public.testimonials;
create policy testimonials_staff_columns on public.testimonials
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

drop policy if exists service_cases_staff_columns on public.service_cases;
create policy service_cases_staff_columns on public.service_cases
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

drop policy if exists media_assets_staff_columns on public.media_assets;
create policy media_assets_staff_columns on public.media_assets
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());

-- ---- 5. The sample lock's trusted context ----------------------------------------------------
-- 0028's function with its first test changed, and nothing else: "no role claim" instead of
-- "not CMS staff". A claim that is not JSON raises (fail closed) rather than counting as none.
create or replace function app.tg_testimonial_sample_lock() returns trigger
  language plpgsql set search_path = public, app, pg_temp as $$
begin
  if (nullif(current_setting('request.jwt.claims', true), '')::jsonb
        #>> '{app_metadata,role}') is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.is_placeholder then
      raise exception 'testimonial % cannot be created as a design sample', new.slug
        using errcode = '42501',
              hint = 'Design samples come only from the seed files; a real quote needs recorded consent.';
    end if;
    return new;
  end if;
  if new.is_placeholder and not old.is_placeholder then
    raise exception 'testimonial % cannot be turned into a design sample', old.slug
      using errcode = '42501',
            hint = 'is_placeholder can be cleared, never set; a real quote needs recorded consent.';
  end if;
  if old.is_placeholder and new.is_placeholder
     and (new.quote is distinct from old.quote
          or new.author_name is distinct from old.author_name
          or new.author_role is distinct from old.author_role
          or new.avatar_media_id is distinct from old.avatar_media_id
          or new.client_id is distinct from old.client_id
          or new.portfolio_id is distinct from old.portfolio_id) then
    raise exception 'testimonial % is a design sample: its words and attribution are locked', old.slug
      using errcode = '42501',
            hint = 'Make it real in one save: the real words, the consent record, and is_placeholder cleared.';
  end if;
  return new;
end $$;
-- A trigger function: fired by the table, never called. Default-deny (0011 §6c).
revoke all on function app.tg_testimonial_sample_lock() from public, anon, authenticated, service_role;

-- ---- 6. The legacy lead writes, withdrawn ----------------------------------------------------
revoke update (status, internal_notes) on public.leads from authenticated;

-- ---- 7. The people directory ------------------------------------------------------------------
-- 0044's directory, with one branch added for a member who is not CMS staff: the assignable
-- lead workers, while the caller's own live role works leads. Same signature, so callers and
-- grants stand; the revoke is restated anyway.
create or replace function app.staff_directory()
  returns table (id uuid, display_name text, role text, assignable boolean)
  language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.role::text,
         (p.locked_until is null or p.locked_until <= now()) as assignable
    from public.profiles p
   where (select app.live_role()) is not null
     and p.tenant_id = app.effective_tenant_id()
     and p.is_active
     and (app.is_staff()
          or (app.role_works_leads((select app.live_role()))
              and app.role_works_leads(p.role::text)
              and (p.locked_until is null or p.locked_until <= now())))
   order by p.display_name nulls last, p.id
$$;
revoke all on function app.staff_directory() from public, anon, authenticated, service_role;

-- ---- 8. Help guides for every live member -----------------------------------------------------
drop policy if exists help_articles_member_read on public.help_articles;
create policy help_articles_member_read on public.help_articles for select to authenticated
  using (tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null);

-- ---- 8b. Dashboard presets for every live member --------------------------------------------
-- 0060's read with app.is_staff() replaced by a live member: the tenant first (P-14), then a
-- live profile, then the token's own role's preset or, for users.manage, every role's.
drop policy if exists admin_role_defaults_read on public.admin_role_defaults;
create policy admin_role_defaults_read on public.admin_role_defaults for select to authenticated
  using (tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null
         and ((role)::text = app.current_role() or app.role_manages_users(app.current_role())));

-- ---- 9. The help guides ----------------------------------------------------------------------
-- H11's catalog (0069): one top-level put per guide, outside any DO block. the-sales-role is
-- new (revision 0, the free place 75, for the lead workers: leads.manage); roles-and-access
-- (revision 1, as 0068 left it) now says five roles and gains the Sales line. Each put
-- re-seeds that one slug into every tenant and touches no other guide.
select app.put_help_guide($guide$
{
  "slug": "the-sales-role",
  "sort_order": 75,
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
        "x": "Sales is the role for the people who follow up inquiries. A Sales account works leads and nothing else: it opens no page, setting, media or job application, and it cannot change anyone's role."
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
          "Open the dashboard and the website stats."
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
          "Change content, settings, people or the theme, or read job applications, the logs or the activity log."
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
        "x": "دور Sales (المبيعات) مخصّص لمن يتابعون الاستفسارات. يعمل حساب Sales على العملاء المحتملين فقط: لا يفتح الصفحات ولا الإعدادات ولا الوسائط ولا طلبات التوظيف، ولا يستطيع تغيير دور أي شخص."
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
          "يفتح لوحة المعلومات وإحصاءات الموقع."
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
          "تغيير المحتوى أو الإعدادات أو الأشخاص أو المظهر، أو قراءة طلبات التوظيف أو السجلات أو سجل النشاط."
        ]
      },
      {
        "t": "tip",
        "x": "يجعل المسؤول (Admin) شخصًا ما Sales من Settings › Users & roles. امنح كل شخص اسمًا ظاهرًا، ليسهل التمييز بين من يمكن إسناد العميل المحتمل إليهم."
      }
    ]
  }
}
$guide$::jsonb, 0);

select app.put_help_guide($guide$
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
        "x": "There are five roles. Each sees only the screens it can use, and the server checks the role again on every save, so a hidden button is never the only lock."
      },
      {
        "t": "ol",
        "x": [
          "Admin: everything, including people and their roles, archiving and deleting, and job applications.",
          "Content Creator: writes and publishes the site's content (services, projects, posts, pages, testimonials and the rest) and manages media. No settings and no leads.",
          "SEO: SEO defaults, redirects, integrations, and the website and search stats. It can open pages, services, projects and posts without changing their content.",
          "Developer: general settings, maintenance, the theme editor (saved themes do not change the site yet), media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications.",
          "Sales: works leads, reveals one lead's contact details at a time, and reads the dashboard and the website stats. No content, settings, exports, job applications, logs or people."
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
        "x": "هناك خمسة أدوار. يرى كل دور الشاشات التي يستطيع استخدامها فقط، ويتحقق الخادم من الدور مرة أخرى عند كل حفظ، فلا يكون إخفاء الزر هو القفل الوحيد أبدًا."
      },
      {
        "t": "ol",
        "x": [
          "Admin (مسؤول): كل شيء، بما في ذلك الأشخاص وأدوارهم، والأرشفة والحذف، وطلبات التوظيف.",
          "Content Creator (صانع محتوى): يكتب محتوى الموقع وينشره (الخدمات والمشاريع والمقالات والصفحات والتوصيات وغيرها) ويدير الوسائط. لا إعدادات ولا عملاء محتملين.",
          "SEO (تحسين محركات البحث): إعدادات SEO الافتراضية، وإعادة التوجيه، والتكاملات، وإحصاءات الموقع والبحث. يستطيع فتح الصفحات والخدمات والمشاريع والمقالات دون تغيير محتواها.",
          "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، ومحرر المظهر (لا تغيّر المظاهر المحفوظة الموقع بعد)، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف.",
          "Sales (المبيعات): يعمل على العملاء المحتملين، ويكشف بيانات التواصل لعميل محتمل واحد في كل مرة، ويقرأ لوحة المعلومات وإحصاءات الموقع. لا محتوى ولا إعدادات ولا تصدير ولا طلبات توظيف ولا سجلات ولا أشخاص."
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
}
$guide$::jsonb, 1);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them.
do $$
declare
  v_have text[];
  v_bad text;
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_cols text[];
  t text;
  p text;
begin
  -- The value is there, and app.is_staff() still names the four CMS roles only.
  if not ('sales' = any (enum_range(null::public.app_role)::text[])) then
    raise exception '0093: app_role has no sales value (apply 0092 first, in its own transaction)';
  end if;
  if pg_get_functiondef('app.is_staff()'::regprocedure) ~ 'sales' then
    raise exception '0093: app.is_staff() names sales; it must stay the four CMS roles (P-6)';
  end if;
  if pg_get_functiondef('app.is_member()'::regprocedure) !~
     $re$in \('admin', 'content_creator', 'seo', 'developer', 'sales'\)$re$ then
    raise exception '0093: app.is_member() is not the five roles';
  end if;

  -- The helpers answer ROLE_CAPS for Sales: leads.manage and analytics.read, and nothing else.
  if not (app.role_works_leads('sales') and app.role_works_leads('admin')
          and app.role_works_leads('developer') and not app.role_works_leads('seo')
          and not app.role_works_leads('content_creator') and not app.role_works_leads('anon')
          and not app.role_works_leads(null)) then
    raise exception '0093: app.role_works_leads is not leads.manage (admin, developer, sales)';
  end if;
  if not (app.role_analytics_read('sales') and app.role_analytics_read('admin')
          and app.role_analytics_read('content_creator') and app.role_analytics_read('seo')
          and app.role_analytics_read('developer') and not app.role_analytics_read('anon')
          and not app.role_analytics_read(null)) then
    raise exception '0093: app.role_analytics_read is not analytics.read (the five roles)';
  end if;
  if app.role_crm_erase('sales') or app.role_manages_users('sales')
     or app.role_views_audit('sales') or app.role_site_health('sales')
     or app.role_manages_visibility('sales') then
    raise exception '0093: a helper Sales must not pass answers true for sales';
  end if;

  -- EXECUTE, stated: the two API roles that evaluate policies, never anon or PUBLIC.
  foreach p in array array['app.is_member()', 'app.role_works_leads(text)',
                           'app.role_analytics_read(text)'] loop
    if has_function_privilege('anon', p, 'execute')
       or not has_function_privilege('authenticated', p, 'execute')
       or not has_function_privilege('service_role', p, 'execute')
       or exists (select 1 from pg_proc f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
                   where f.oid = p::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception '0093: EXECUTE on % is wrong', p;
    end if;
  end loop;
  foreach p in array array['app.staff_directory()', 'app.tg_testimonial_sample_lock()'] loop
    if has_function_privilege('anon', p, 'execute')
       or has_function_privilege('authenticated', p, 'execute')
       or has_function_privilege('service_role', p, 'execute') then
      raise exception '0093: % is executable by an API role', p;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.crm_people(uuid)', 'execute')
     or has_function_privilege('anon', 'public.crm_people(uuid)', 'execute') then
    raise exception '0093: EXECUTE on public.crm_people(uuid) moved';
  end if;
  if pg_get_functiondef('app.staff_directory()'::regprocedure) !~ 'role_works_leads' then
    raise exception '0093: app.staff_directory() has no lead-worker branch';
  end if;

  -- audit_log: the three policies, audit_insert the tenant, the member test and the actor.
  select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                            order by policyname), '{}')
    into v_have
    from pg_policies where schemaname = 'public' and tablename = 'audit_log';
  if v_have is distinct from array['audit_insert INSERT PERMISSIVE {public}',
                                   'audit_log_live_read SELECT RESTRICTIVE {authenticated}',
                                   'audit_read SELECT PERMISSIVE {public}'] then
    raise exception '0093: audit_log policies are %', v_have;
  end if;
  if (select with_check from pg_policies
       where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_insert')
     !~ ('^\(' || v_tenant || ' AND (app\.)?is_member\(\) AND \(actor_id = \( SELECT auth\.uid\(\) AS uid\)\)\)$')
     or (select qual from pg_policies
          where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_insert')
        is not null then
    raise exception '0093: audit_insert is not (tenant, is_member, actor = caller)';
  end if;

  -- The block: one RESTRICTIVE SELECT TO authenticated per table, tenant first, then staff.
  foreach t in array array['testimonials', 'service_cases', 'media_assets'] loop
    if (select count(*) from pg_policies
         where schemaname = 'public' and tablename = t and policyname = t || '_staff_columns'
           and cmd = 'SELECT' and permissive = 'RESTRICTIVE' and roles = '{authenticated}'
           and with_check is null
           and qual ~ ('^\(' || v_tenant || ' AND (app\.)?is_staff\(\)\)$')) <> 1 then
      raise exception '0093: %_staff_columns is missing or is not (tenant, is_staff)', t;
    end if;
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = ('public.' || t)::regclass) then
      raise exception '0093: % is not ENABLE + FORCE row level security', t;
    end if;
  end loop;

  -- help_articles: the staff read and the live member read, nothing that writes.
  select coalesce(array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles)
                            order by policyname), '{}')
    into v_have
    from pg_policies where schemaname = 'public' and tablename = 'help_articles';
  if v_have is distinct from array['help_articles_member_read SELECT PERMISSIVE {authenticated}',
                                   'help_articles_staff_read SELECT PERMISSIVE {authenticated}'] then
    raise exception '0093: help_articles policies are %', v_have;
  end if;
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'help_articles'
        and policyname = 'help_articles_member_read')
     !~ ('^\(' || v_tenant || ' AND \(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\)\)$') then
    raise exception '0093: help_articles_member_read is not (tenant, a live member)';
  end if;

  -- leads: staff UPDATE is exactly the pipeline's columns; the legacy pair is gone.
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname, 'update');
  if v_cols is distinct from array['assigned_to', 'is_spam', 'is_starred', 'last_contact_at',
                                   'last_contact_channel', 'read_at', 'stage_id', 'tags',
                                   'value_sar'] then
    raise exception '0093: authenticated may update leads columns % (expected the pipeline''s)', v_cols;
  end if;
  if has_table_privilege('authenticated', 'public.leads', 'update')
     or has_table_privilege('anon', 'public.leads', 'update') then
    raise exception '0093: a table-wide UPDATE on leads is held';
  end if;

  -- admin_role_defaults_read: the tenant, a live member, its own role's preset or users.manage.
  if coalesce((select qual from pg_policies where schemaname = 'public' and tablename = 'admin_role_defaults'
                 and policyname = 'admin_role_defaults_read' and cmd = 'SELECT'
                 and permissive = 'PERMISSIVE' and roles = '{authenticated}'), '')
     !~ ('^\(' || v_tenant || ' AND \(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\) AND '
         || '\(\(\(role\)::text = (app\.)?"?current_role"?\(\)\) OR (app\.)?role_manages_users\((app\.)?"?current_role"?\(\)\)\)\)$') then
    raise exception '0093: admin_role_defaults_read is not (tenant, a live member, own role or users.manage)';
  end if;

  -- The two guides: in the catalog and in every tenant, the roles guide naming five roles.
  if (select count(*) from app.help_guide_catalog where slug = 'the-sales-role'
        and sort_order = 75 and caps = array['leads.manage']) <> 1
     or exists (select 1 from public.tenants t
                 where not exists (select 1 from public.help_articles h
                                    where h.tenant_id = t.id and h.slug = 'the-sales-role')) then
    raise exception '0093: the-sales-role is not in the catalog and every tenant';
  end if;
  if exists (select 1 from public.tenants t
              where not exists (select 1 from public.help_articles h
                                 where h.tenant_id = t.id and h.slug = 'roles-and-access'
                                   and h.body::text ~ 'There are five roles\.'
                                   and h.body::text ~ 'Sales: works leads')) then
    raise exception '0093: a tenant''s roles-and-access guide does not name five roles and Sales';
  end if;

  -- The sample lock: no role claim is the only trusted context.
  if pg_get_functiondef('app.tg_testimonial_sample_lock()'::regprocedure) ~ 'is_staff'
     or pg_get_functiondef('app.tg_testimonial_sample_lock()'::regprocedure) !~ 'app_metadata,role' then
    raise exception '0093: the sample lock still trusts "not staff"';
  end if;
end $$;
