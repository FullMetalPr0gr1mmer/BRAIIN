-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0129 — A stale token writes nothing (Admin v2 H16, the general stale-token fix). Forward-only
-- and EXPAND only: policies are added and one function is restated, nothing is dropped. The
-- number is a placeholder: it is assigned at merge (scripts/renumber-migration.mjs). Depends on
-- 0001 (the content tables and their JWT-role policies, app.effective_tenant_id), 0020
-- (public.update_media_meta), 0033 (app.live_role), 0069 (H11: app.put_help_guide), 0120 (E4:
-- roles-and-access at revision 4) and every migration that created one of the
-- tables named below.
--
-- THE GAP. RLS reads the role from the access token, and an access token lives up to an hour.
-- A role, activity or tenant change ends every session (0055, profiles_revoke_sessions) and the
-- Worker refuses a token whose claims and profile disagree (U12a), but the token itself stays
-- valid at PostgREST until it expires. On the tables below, every staff write was decided by
-- the token's role alone, so a demoted, deactivated or locked person could keep writing with
-- their old rights by calling the API directly: publish, edit or delete content, rewrite
-- redirects and SEO, change media, clear the system log. The tables built since the leads work
-- (0033) each carry their own RESTRICTIVE live policy; these 28 predate it.
--
-- THE FIX
--   1. Three RESTRICTIVE policies on each table, TO authenticated, one per write command:
--        <table>_live_insert   WITH CHECK
--        <table>_live_update   USING and WITH CHECK
--        <table>_live_delete   USING
--      each `tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null`.
--      app.live_role() (0033, SECURITY DEFINER, empty search_path) is the profile's role, read
--      at query time by the token's `sub`, and null unless that profile is active, unlocked, in
--      the token's tenant and holds exactly the token's role. So where it is not null, the JWT
--      role the existing permissive policies read IS the live role: every capability rule
--      stays where it is, now evaluated on a role the database has just confirmed. A stale
--      token's UPDATE and DELETE match no row; its INSERT is refused (42501).
--        • RESTRICTIVE: ANDed with the permissive policies, so it can only narrow.
--        • The tenant predicate first (CLAUDE.md §3).
--        • `(select …)`: an InitPlan, evaluated once per statement (one primary-key lookup on
--          profiles), never once per row.
--        • All three commands on every table, even where authenticated holds no such grant
--          today (audit_log's UPDATE and DELETE, seo_defaults' DELETE…): a grant added by
--          mistake is then not enough on its own (as 0050 did on profiles).
--        • Reads are untouched: no SELECT policy is added, so what anon and every reader see
--          is unchanged, and no anon policy changes.
--      Not affected: the service role (BYPASSRLS: the Worker's server-side writes, the public
--      forms), SECURITY DEFINER functions and triggers (they run as their owner, which these
--      TO authenticated policies do not name: apply_release, publish_scheduled, the snapshot
--      and capture triggers, update_my_profile), the access-token hook and pg_cron. Invoker
--      RPCs (save_portfolio, apply_portfolio_children, write_drafts) are held by the policies
--      of the tables they write, which is the point.
--   2. public.update_media_meta (0020: SEO's "meta only" media write, a SECURITY DEFINER that
--      checked the token's role alone) restated: a stale token is refused as a non-staff one
--      is (42501). Its search_path is pinned to '' with every name qualified; its body is
--      otherwise 0020's. CREATE OR REPLACE keeps the owner; the grants are stated again.
--   3. The roles guide (roles-and-access, through H11's app.put_help_guide): its "One limit to
--      know" paragraph says a pass already handed out changes nothing any more and, until it
--      runs out, still reads what its role could on settings, media, the logs and content.
--   4. Postconditions: the exact policy set added here; the rule that EVERY public table where
--      authenticated holds a write privilege carries a RESTRICTIVE live policy for each
--      command it can run (a later table without one fails supabase/tests/live_staff_writes);
--      the function's settings, body and grants; the guide in the catalog and in every tenant.
--
-- Not changed: a lock (the sign-in lockout) still ends no session (U12a's decision, kept: anyone
-- who knows a staff address can trip it). A locked token writes nothing here (live_role reads
-- locked_until at query time) and the Worker signs it out at its next request. Reads by a stale
-- token on the tables without a live read check stay open until the token expires
-- (docs/admin-v2/as-built/H16.md, residual gaps).
--
-- Rule 5 (the deployed Worker between this push and the deploy): no shape changes. Every write
-- the deployed Worker makes passes resolveAuthContext first, which refuses a session whose
-- profile is inactive, locked, of another tenant or of another role than its token, exactly the
-- tokens live_role() turns away, so no live session's write changes. update_media_meta keeps its
-- signature, result columns and error codes.
--
-- Production as of 2026-11-05: PostgreSQL 17.6, one tenant; main holds every migration through
-- 0127. CLAUDE.md §2 (session invalidation), §3 (Pillar 1), §8, §9 (b).
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later. Each
-- CREATE POLICY takes an ACCESS EXCLUSIVE lock on its table for the rest of the transaction.
set local lock_timeout = '5s';

-- ═══ 1. The live check on every staff write ═══════════════════════════════════════════════
-- The list is the inventory of public tables where authenticated held a write privilege and no
-- RESTRICTIVE live policy (docs/admin-v2/as-built/H16.md). It is spelt out, not derived, so the
-- migration does exactly what it says on every database; section 4 checks nothing was missed.
do $$
declare
  t text;
  tables constant text[] := array[
    'ai_config', 'ai_questions', 'ai_styles', 'audit_log', 'blog_posts', 'categories',
    'certifications', 'clients', 'disciplines', 'entity_seo', 'faq_items', 'media_assets',
    'navigation', 'page_sections', 'pages', 'partner_logos', 'portfolio', 'portfolio_media',
    'portfolio_services', 'redirects', 'sectors', 'seo_defaults', 'service_cases', 'services',
    'statistics', 'system_logs', 'team_members', 'testimonials'];
  live constant text :=
    'tenant_id = app.effective_tenant_id() and (select app.live_role()) is not null';
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', t || '_live_insert', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated with check (%s)',
      t || '_live_insert', t, live);
    execute format('drop policy if exists %I on public.%I', t || '_live_update', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated using (%s) with check (%s)',
      t || '_live_update', t, live, live);
    execute format('drop policy if exists %I on public.%I', t || '_live_delete', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated using (%s)',
      t || '_live_delete', t, live);
  end loop;
end $$;

-- ═══ 2. update_media_meta: live, and its search_path pinned ═════════════════════════════
create or replace function public.update_media_meta(p_id uuid, p_version int, p_patch jsonb)
  returns table (
    id uuid, kind text, storage_path text, folder text, alt jsonb, tags text[],
    version int, updated_at timestamptz
  )
  language plpgsql security definer set search_path = ''
as $$
begin
  -- The token's role must be a staff role AND the profile's, live (H16): a demoted,
  -- deactivated or locked person's token is refused like a non-staff one.
  if app.current_role() not in ('admin', 'content_creator', 'seo', 'developer')
     or app.live_role() is null then
    raise exception 'media metadata is staff-only' using errcode = '42501';
  end if;
  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be an object' using errcode = '22023';
  end if;
  if p_patch ? 'alt' and pg_catalog.jsonb_typeof(p_patch -> 'alt') not in ('object', 'null') then
    raise exception 'alt must be an {en, ar} object or null' using errcode = '22023';
  end if;
  if p_patch ? 'tags' and pg_catalog.jsonb_typeof(p_patch -> 'tags') <> 'array' then
    raise exception 'tags must be an array' using errcode = '22023';
  end if;

  return query
  update public.media_assets m set
    alt = case when p_patch ? 'alt' then nullif(p_patch -> 'alt', 'null'::jsonb) else m.alt end,
    tags = case
      when p_patch ? 'tags'
        then array(select pg_catalog.jsonb_array_elements_text(p_patch -> 'tags'))
      else m.tags
    end,
    folder = case when p_patch ? 'folder' then p_patch ->> 'folder' else m.folder end
  where m.tenant_id = app.effective_tenant_id()
    and m.id = p_id
    and m.version = p_version
  returning m.id, m.kind, m.storage_path, m.folder, m.alt, m.tags, m.version, m.updated_at;
end $$;
revoke all on function public.update_media_meta(uuid, int, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_media_meta(uuid, int, jsonb) to authenticated;

-- ═══ 3. The roles guide says what now holds ═══════════════════════════════════════════════
-- H11's app.put_help_guide (0069). roles-and-access is at revision 4 (E4's put, 0120, which the
-- catalog moved to 4); its "One limit to know" paragraph is rewritten in both languages (a pass
-- already handed out changes nothing any more; until it runs out it still reads what its role
-- could on settings, media, the logs and content) and nothing else.
select app.put_help_guide($guide$
{
  "slug": "roles-and-access",
  "sort_order": 30,
  "minutes": 5,
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
          "Developer: general settings, maintenance, the site's theme (its colours and motion), media, leads, site health, logs and the activity log. It does not write or publish content, and it cannot see job applications.",
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
        "x": "One limit to know: a sign-in pass already handed out keeps working for up to an hour when someone uses it directly against the database, outside the admin. It can no longer change anything with the role it was issued with: every save checks the person's account first. Until it runs out it can still read what that role could read in settings, media, the system logs and content. People and their roles, the security settings, leads, job applications and the activity log check the person's account on every request, reading included, so those close at once."
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
        "t": "p",
        "x": "Require 2FA for everyone, on the same card, asks everyone who has not set up two factor authentication to set it up at their next click, before they can do anything else in the admin. Turn on 2FA for your own account first: until you have, the card does not save the switch."
      },
      {
        "t": "h",
        "x": "Resetting someone's 2FA"
      },
      {
        "t": "p",
        "x": "If someone loses their phone, an Admin opens the person in Users & roles and chooses Reset 2FA. Their authenticator app stops working here and they are signed out on every device; the reset is recorded in the activity log. You cannot reset your own 2FA there (turn it off from your account), nor the account owner's, which only whoever runs the database can reset."
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
          "Developer (مطوّر): الإعدادات العامة، ووضع الصيانة، ومظهر الموقع (ألوانه وحركته)، والوسائط، والعملاء المحتملون، وصحة الموقع، والسجلات، وسجل النشاط. لا يكتب المحتوى ولا ينشره، ولا يرى طلبات التوظيف.",
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
        "x": "وهناك حدّ ينبغي معرفته: تصريح الدخول الذي صدر بالفعل يبقى صالحًا حتى ساعة إذا استُخدم مباشرة على قاعدة البيانات، خارج لوحة الإدارة. لكنه لم يعد يستطيع تغيير أي شيء بالدور الذي صدر به: فكل حفظ يتحقق من حساب الشخص أولًا. وإلى أن ينتهي يبقى قادرًا على قراءة ما كان ذلك الدور يقرؤه في الإعدادات والوسائط وسجلات النظام والمحتوى. أما الأشخاص وأدوارهم، وإعدادات الأمان، والعملاء المحتملون، وطلبات التوظيف، وسجل النشاط فتتحقق من حساب الشخص عند كل طلب، بما في ذلك القراءة، فيُغلق الوصول إليها فورًا."
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
        "t": "p",
        "x": "ويطلب الخيار Require 2FA for everyone، في البطاقة نفسها، من كل من لم يُعدّ التحقق بخطوتين أن يُعدّه عند نقرته التالية، قبل أن يستطيع فعل أي شيء آخر في لوحة الإدارة. شغّل 2FA لحسابك أنت أولًا: لا تحفظ البطاقة هذا الخيار قبل ذلك."
      },
      {
        "t": "h",
        "x": "إعادة ضبط 2FA لشخص ما"
      },
      {
        "t": "p",
        "x": "إذا فقد شخص هاتفه، يفتح المسؤول (Admin) حسابه في Users & roles ويختار Reset 2FA. يتوقف تطبيق المصادقة لديه عن العمل هنا ويُسجَّل خروجه من كل أجهزته، وتُسجَّل إعادة الضبط في سجل النشاط. لا يمكنك إعادة ضبط 2FA الخاص بك من هناك (أوقفه من حسابك)، ولا الخاص بمالك الحساب، فذلك لا يفعله إلا من يدير قاعدة البيانات."
      },
      {
        "t": "tip",
        "x": "الأدوار ثابتة، ولا استثناءات لشخص بعينه. من يحتاج إلى صلاحيات أكثر يحتاج إلى دور مختلف."
      }
    ]
  }
}
$guide$::jsonb, 4);

-- ═══ 4. Postconditions ═══════════════════════════════════════════════════════════════════
-- Expressions are read as pg_get_expr prints them, with or without the schema qualifier.
do $$
declare
  v_expr constant text :=
    '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\)\)$';
  v_bad text;
  v_count int;
begin
  -- 4a. Each policy this migration made: RESTRICTIVE, TO authenticated alone, the expression
  --     exactly, on the sides its command has and on no other.
  select count(*)::int,
         string_agg(c.relname || '.' || p.polname, ', ') filter (where not (
           not p.polpermissive
           and p.polroles = array['authenticated'::regrole::oid]
           and case p.polcmd
                 when 'a' then p.polqual is null
                               and pg_get_expr(p.polwithcheck, p.polrelid) ~ v_expr
                 when 'w' then pg_get_expr(p.polqual, p.polrelid) ~ v_expr
                               and pg_get_expr(p.polwithcheck, p.polrelid) ~ v_expr
                 when 'd' then p.polwithcheck is null
                               and pg_get_expr(p.polqual, p.polrelid) ~ v_expr
                 else false
               end
           and p.polname = c.relname || case p.polcmd
                                          when 'a' then '_live_insert'
                                          when 'w' then '_live_update'
                                          when 'd' then '_live_delete' end))
    into v_count, v_bad
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any (array[
       'ai_config', 'ai_questions', 'ai_styles', 'audit_log', 'blog_posts', 'categories',
       'certifications', 'clients', 'disciplines', 'entity_seo', 'faq_items', 'media_assets',
       'navigation', 'page_sections', 'pages', 'partner_logos', 'portfolio', 'portfolio_media',
       'portfolio_services', 'redirects', 'sectors', 'seo_defaults', 'service_cases', 'services',
       'statistics', 'system_logs', 'team_members', 'testimonials'])
     and p.polname ~ '_live_(insert|update|delete)$';
  if v_count <> 84 or v_bad is not null then
    raise exception 'H16: expected 84 live write policies of the one shape, found % (wrong: %)',
      v_count, coalesce(v_bad, 'none');
  end if;

  -- 4b. The rule: every public table (partitions are reached through their parent) where
  --     authenticated holds a write privilege, table-wide or on a column, carries a
  --     RESTRICTIVE policy for authenticated, on that command or ALL, that consults the live
  --     profile (app.live_role or app.is_live_admin, 0029).
  with t as (
    select c.oid, c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  ), need as (
    select t.oid, t.relname, cmd.c
      from t
      cross join lateral (values
        ('a', has_table_privilege('authenticated', t.oid, 'INSERT')
              or has_any_column_privilege('authenticated', t.oid, 'INSERT')),
        ('w', has_table_privilege('authenticated', t.oid, 'UPDATE')
              or has_any_column_privilege('authenticated', t.oid, 'UPDATE')),
        ('d', has_table_privilege('authenticated', t.oid, 'DELETE'))) as cmd(c, held)
     where cmd.held
  )
  select string_agg(need.relname || ':' || need.c, ', ' order by need.relname, need.c)
    into v_bad
    from need
   where not exists (
     select 1 from pg_policy p
      where p.polrelid = need.oid
        and not p.polpermissive
        and p.polcmd in (need.c::"char", '*')
        and (p.polroles = array[0::oid] or 'authenticated'::regrole::oid = any (p.polroles))
        and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
              || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
            ~ '(live_role|is_live_admin)\(\)');
  if v_bad is not null then
    raise exception 'H16: a staff write with no RESTRICTIVE live policy: %', v_bad;
  end if;

  -- 4c. update_media_meta: a definer with an empty search_path that asks for the live role,
  --     executable by authenticated alone.
  if not exists (
    select 1 from pg_proc
     where oid = 'public.update_media_meta(uuid, int, jsonb)'::regprocedure
       and prosecdef
       and proconfig = array['search_path=""']
       and prosrc ~ 'app\.live_role\(\) is null'
  ) then
    raise exception 'H16: update_media_meta must be a definer with an empty search_path that checks app.live_role()';
  end if;
  if not has_function_privilege('authenticated', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
     or exists (
       select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = 'public.update_media_meta(uuid, int, jsonb)'::regprocedure
          and a.grantee = 0) then
    raise exception 'H16: update_media_meta must be executable by authenticated alone';
  end if;

  -- 4d. The roles guide: revision 5 in the catalog, the new paragraph in both languages, and
  --     every tenant's copy holds it.
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'roles-and-access' and revision = 5
                    and body::text like '%It can no longer change anything with the role it was issued with%'
                    and body::text like '%لكنه لم يعد يستطيع تغيير أي شيء%'
                    and body::text not like '%it still carries the role it was issued with%') then
    raise exception 'H16: roles-and-access must be at revision 5 with the rewritten paragraph';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'roles-and-access'
                        and h.body::text like '%It can no longer change anything%');
  if v_bad is not null then
    raise exception 'H16: tenants without the rewritten roles guide: %', v_bad;
  end if;

  -- 4e. app.live_role() is what every policy above stands on: still a definer with an empty
  --     search_path, executable by authenticated, and not by anon or PUBLIC.
  if not exists (
    select 1 from pg_proc
     where oid = 'app.live_role()'::regprocedure
       and prosecdef
       and proconfig = array['search_path=""']
  ) or not has_function_privilege('authenticated', 'app.live_role()', 'execute')
    or has_function_privilege('anon', 'app.live_role()', 'execute') then
    raise exception 'H16: app.live_role() is not the definer the live policies need';
  end if;
end $$;
