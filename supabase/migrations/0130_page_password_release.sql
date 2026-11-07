-- ─────────────────────────────────────────────────────────────────────────────────────────
-- R14e (Admin v2, owner item B1 option b) — page passwords in release mode. Forward-only and
-- EXPAND only: two functions and one trigger are created, one trigger function is restated with
-- one branch added, one column privilege is granted, and one guide moves through H11's catalog.
-- Nothing is dropped. The number is a
-- placeholder: numbers are assigned at the merge train (docs/admin-v2/migrations.md), and this
-- file is renumbered with scripts/renumber-migration.mjs to the next free number above main's
-- highest. Depends on 0033 (app.live_role), 0038 (app.releases_enabled, the registry), 0057
-- (page_visibility, app.role_manages_visibility), 0061 (page_passwords, set_page_password,
-- page_password_check, app.tg_page_password_sync), 0066 (the release guard), 0069 (H11's
-- catalog, app.put_help_guide), 0128 (the page-visibility guide at revision 2) and 0129 (H16).
--
-- THE GAP (R14B.md, B1). With releases on, page_visibility changes only inside a release (0066's
-- guard), but no release may carry a secret (P-3): the password is never in a draft, a version,
-- an audit row or a log. So with releases on a page could not newly go behind a password; R14b's
-- door changed the password only of a page already behind one.
--
-- THE FIX. The secret is stored at once; the mode and the message above the box are staged as the
-- page's visibility change and go live when it is published. Until then the stored hash is inert:
-- public.page_password_check (0061, unchanged) joins page_visibility on mode = 'password', so it
-- admits no one to a page whose LIVE mode is anything else, and the public gate follows the live
-- snapshot as before.
--   1. public.store_page_password(page, password): SECURITY DEFINER, empty search_path, EXECUTE
--      authenticated alone. The caller is the live profile (app.live_role(): active, unlocked,
--      the token's role and tenant, H16) and manages visibility (Admin, Developer); the tenant
--      is that profile's, never an argument; releases must be on for it (55000 otherwise: with
--      releases off the door keeps calling set_page_password, so nothing there changes); the
--      page is that tenant's and not the homepage; the password 8 to 72 bytes. It writes
--      public.page_passwords (bcrypt, cost 10, as 0061) and, only when the page asks for a
--      password on the live site, that row's exempt password_version + 1, which ends every
--      unlock cookie of the old password (0066's guard lets an update of exempt columns only
--      through, and the capture records nothing for it). Its audit row,
--      page_visibility.password_stored, in the same transaction, names the page, whether the live
--      gate changed and the version: never the password, the hash or the message.
--   2. public.page_password_stored(page): whether a hash is stored, for the release check
--      (src/lib/release/validate.ts), so a change that would put a page in password mode with no
--      password is refused in words before the apply refuses it in its own. Same live check and
--      profile tenant; STABLE; EXECUTE authenticated alone.
--   3. app.tg_page_password_sync restated with one branch: a row ENTERING password mode (an
--      insert, or an update from another mode) whose password_version did not move gets old + 1.
--      A release writes the staged mode and message, never the exempt version, and 0061's CHECK
--      needs a version above 0 in password mode. set_page_password already moves it (an insert
--      at 1, an update at old + 1), so with releases off no write ends differently. The rest is
--      0061's word for word: no writer puts a page into password mode without a stored hash, and
--      leaving the mode deletes the hash, clears the message and moves the version.
--   4. A release may write the message. `note` has been in the registry's allowlist since 0061,
--      but no API role held a privilege on it, and apply_release writes as the publisher, so
--      every release carrying a message was refused (42501): no page could go behind a password
--      through one. INSERT and UPDATE (note) are granted to authenticated, and an invoker guard
--      (page_visibility_note_guard) refuses an API token's message write outside a release, as
--      the missing privilege did (42501), so with releases off a direct write is refused as
--      before and the message is still set only with the password. It asks app.in_release_write()
--      (a definer over app.release_token_valid(), which no API role may execute; EXECUTE
--      authenticated, never anon).
--   5. The page-visibility guide, revision 2 to 3: its release-mode paragraph says what is true now.
--
-- Not changed: page_passwords (no policy, no grant to any API role), set_page_password,
-- page_password_check, the fence, the registry row (page_passwords is never a registry table;
-- password_version stays exempt). Grants are stated for both Supabase grant regimes (P-14).
--
-- Rule 5 (the deployed Worker between this push and the deploy): nothing it calls changes shape.
-- Releases are off in production, where the new functions answer 55000 and are never called.
-- CLAUDE.md §3 (Pillar 1, page visibility), §8 (U14b, R14b, R14e). docs/admin-v2/as-built/R14E.md.
-- ─────────────────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

-- ═══ 1. The secret at once, with releases on ═══════════════════════════════════════════════
create or replace function public.store_page_password(p_page_id uuid, p_password text)
  returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_slug text;
  v_live boolean := false;
  v_pv int;
begin
  -- The person, live (H16): a demoted, deactivated or locked token, another role or another
  -- tenant's token is refused here, before anything is read.
  if v_uid is null or not app.role_manages_visibility((select app.live_role())) then
    raise exception using errcode = '42501',
      message = 'store_page_password: the caller does not manage page visibility';
  end if;
  -- The tenant is the profile's (live_role() has just required it to be the token's too).
  select p.tenant_id into v_tenant from public.profiles p where p.id = v_uid;
  if v_tenant is null then
    raise exception using errcode = '42501',
      message = 'store_page_password: the caller does not manage page visibility';
  end if;
  if not app.releases_enabled(v_tenant) then
    raise exception using errcode = '55000',
      message = 'store_page_password: releases are not switched on for this site';
  end if;
  if p_page_id is null then
    raise exception using errcode = '22023', message = 'store_page_password: no such page in this tenant';
  end if;
  select pg_catalog.lower(p.slug::text) into v_slug
    from public.pages p
   where p.tenant_id = v_tenant and p.id = p_page_id;
  if v_slug is null then
    raise exception using errcode = '22023', message = 'store_page_password: no such page in this tenant';
  end if;
  if v_slug = 'home' then
    raise exception 'The homepage cannot be hidden. Use maintenance mode instead.'
      using errcode = '23514', constraint = 'page_visibility_home';
  end if;
  if p_password is null
     or pg_catalog.octet_length(p_password) < 8
     or pg_catalog.octet_length(p_password) > 72 then
    raise exception using errcode = '22023',
      message = 'store_page_password: a password is 8 to 72 bytes';
  end if;

  insert into public.page_passwords as t (tenant_id, page_id, password_hash, updated_by)
  values (v_tenant, p_page_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), v_uid)
  on conflict (tenant_id, page_id) do update
    set password_hash = excluded.password_hash,
        updated_at = pg_catalog.now(),
        updated_by = excluded.updated_by;

  -- A page that asks for a password on the live site now asks for the new one: its exempt
  -- version moves, so every cookie minted under the old password stops verifying. Nothing else
  -- of the row moves (the guard refuses any other column outside a release).
  update public.page_visibility as v
     set password_version = v.password_version + 1
   where v.tenant_id = v_tenant and v.page_id = p_page_id and v.mode = 'password'
  returning v.password_version into v_pv;
  v_live := v_pv is not null;

  insert into public.audit_log
    (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (v_tenant, v_uid, app.current_role(), 'page_visibility.password_stored', 'page',
          p_page_id::text,
          pg_catalog.jsonb_build_object('live', v_live, 'passwordVersion', v_pv));

  return pg_catalog.jsonb_build_object('live', v_live, 'passwordVersion', v_pv);
end $$;
revoke all on function public.store_page_password(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.store_page_password(uuid, text) to authenticated;
comment on function public.store_page_password(uuid, text) is
  'Admin v2 R14e: with releases on, stores a page''s password (bcrypt) at once; the mode and the '
  'message are staged and go live with a release. Moves the exempt password_version only where '
  'the page already asks for a password live. Never returns or logs the password.';

-- ═══ 2. Whether a password is stored, for the release check ═══════════════════════════════
create or replace function public.page_password_stored(p_page_id uuid)
  returns boolean
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
begin
  if v_uid is null or not app.role_manages_visibility((select app.live_role())) then
    raise exception using errcode = '42501',
      message = 'page_password_stored: the caller does not manage page visibility';
  end if;
  select p.tenant_id into v_tenant from public.profiles p where p.id = v_uid;
  return exists (select 1 from public.page_passwords pw
                  where pw.tenant_id = v_tenant and pw.page_id = p_page_id);
end $$;
revoke all on function public.page_password_stored(uuid) from public, anon, authenticated, service_role;
grant execute on function public.page_password_stored(uuid) to authenticated;
comment on function public.page_password_stored(uuid) is
  'Admin v2 R14e: whether a password is stored for a page of the caller''s tenant (never the '
  'password or its hash), for the release check before a page goes behind one.';

-- ═══ 3. Entering password mode moves the version ═══════════════════════════════════════════
-- 0061's body, with the entry branch added. CREATE OR REPLACE keeps the owner and the trigger;
-- the settings are stated again (a replace resets them) and so is the revoke.
create or replace function app.tg_page_password_sync() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'password' then
    if new.page_id is null
       or not exists (select 1 from public.page_passwords pw
                       where pw.tenant_id = new.tenant_id and pw.page_id = new.page_id) then
      raise exception 'A page goes behind a password only by setting one on the Page visibility screen.'
        using errcode = '23514', constraint = 'page_visibility_password_required';
    end if;
    -- R14e: a release writes the mode, never the exempt version; entering the mode moves it.
    if (tg_op = 'INSERT' and new.password_version <= 0)
       or (tg_op = 'UPDATE' and old.mode <> 'password'
           and new.password_version <= old.password_version) then
      new.password_version := case when tg_op = 'INSERT' then 0 else old.password_version end + 1;
    end if;
  elsif tg_op = 'UPDATE' and old.mode = 'password' then
    delete from public.page_passwords as pw
     where pw.tenant_id = old.tenant_id and pw.page_id = old.page_id;
    new.note := null;
    new.password_version := old.password_version + 1;
  end if;
  return new;
end $$;
revoke all on function app.tg_page_password_sync() from public, anon, authenticated, service_role;

-- ═══ 4. A release may write the message ═══════════════════════════════════════════════════
-- `note` has been in the registry's allowlist since 0061 (a release stages the message), but no
-- API role was granted it: set_page_password writes it as its owner. apply_release writes every
-- change as the publisher (`set local role authenticated`), so a release carrying the message
-- was refused (42501, permission denied for the column) and no page could go behind a password
-- through one. Granted for insert and update, and held by a guard so that OUTSIDE a release an
-- API token still writes no message (exactly as before: 42501): an invoker trigger, so it sees
-- the role the statement runs as (authenticated through PostgREST and inside the apply, the
-- owner inside set_page_password and the other definers), which asks app.in_release_write(), a
-- definer over app.release_token_valid() (executable by no API role, 0038). The
-- service role keeps the table-wide UPDATE it had (0057) and is not refused. The guard is named
-- to run after the release guard and before app.tg_page_password_sync, so it sees the message the
-- statement wrote, not the one that trigger clears when a page leaves password mode.
grant insert (note), update (note) on public.page_visibility to authenticated;

-- Whether this transaction is applying a release, for a trigger that runs as the caller:
-- app.release_token_valid() is executable by no API role (0038), so a definer asks it.
create or replace function app.in_release_write() returns boolean
  language sql stable security definer set search_path = ''
as $$ select app.release_token_valid() $$;
revoke all on function app.in_release_write() from public, anon, authenticated, service_role;
grant execute on function app.in_release_write() to authenticated;

create or replace function app.tg_page_visibility_note_guard() returns trigger
  language plpgsql security invoker set search_path = '' as $$
begin
  -- Nested, so the release question is asked only of an API token's write of the message.
  if current_user in ('authenticated', 'anon') then
    if (case when tg_op = 'INSERT' then new.note is not null
             else new.note is distinct from old.note end) then
      if not app.in_release_write() then
        raise exception 'The message above the password box is set with the password, on the Page visibility screen.'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function app.tg_page_visibility_note_guard() from public, anon, authenticated, service_role;

drop trigger if exists page_visibility_note_guard on public.page_visibility;
create trigger page_visibility_note_guard before insert or update on public.page_visibility
  for each row execute function app.tg_page_visibility_note_guard();

-- ═══ 5. The page-visibility guide, revision 2 to 3 ════════════════════════════════════════
-- 0128's text word for word but the release-mode paragraph, in both languages. Place, screens
-- and caps are unchanged.
select app.put_help_guide($guide$
{
  "slug": "page-visibility",
  "sort_order": 105,
  "minutes": 4,
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
        "x": "Page visibility decides who can see each page of the public site. Until publishing in releases is switched on for your site, a change applies to the live site within a few minutes, and the admin keeps working as usual."
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
        "t": "p",
        "x": "Once publishing in releases is switched on, a change here waits as an unpublished change, like every other, and goes live when it is published; the list marks it Unpublished changes. A password is the one thing saved at once, because no release ever carries it. On a page that already asks for a password, a new one works straight away. To put a page behind a password, set it as usual: the page starts asking for it when that change is published, and a new message above the box goes live the same way."
      },
      {
        "t": "tip",
        "x": "Search engines and AI tools that fetched the sitemap just before a change may keep the old list for up to an hour."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "يحدد ظهور الصفحات من يستطيع رؤية كل صفحة من صفحات الموقع العام. وإلى أن يُفعَّل النشر عبر الإصدارات لموقعك، يسري التغيير على الموقع المباشر خلال بضع دقائق، وتستمر لوحة الإدارة في العمل كالمعتاد."
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
        "t": "p",
        "x": "وبعد تفعيل النشر عبر الإصدارات، ينتظر التغيير هنا كتغيير غير منشور مثل أي تغيير آخر، ويُنشر عند نشره، وتعلّمه القائمة بـ Unpublished changes. أما كلمة المرور فهي الشيء الوحيد الذي يُحفظ فورًا، لأن الإصدارات لا تحملها أبدًا. ففي صفحة تطلب كلمة مرور أصلًا، تعمل الكلمة الجديدة مباشرة. ولوضع صفحة خلف كلمة مرور، اضبطها كالمعتاد: تبدأ الصفحة بطلبها عند نشر ذلك التغيير، وتُنشر الرسالة الجديدة فوق الحقل بالطريقة نفسها."
      },
      {
        "t": "tip",
        "x": "قد تحتفظ محركات البحث وأدوات الذكاء الاصطناعي التي جلبت خريطة الموقع قبيل التغيير بالقائمة القديمة مدة تصل إلى ساعة."
      }
    ]
  }
}
$guide$::jsonb, 2);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
  f text;
begin
  -- ---- 1. The two definers: empty search_path, executable by authenticated alone ----------
  foreach f in array array['public.store_page_password(uuid, text)', 'public.page_password_stored(uuid)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = f::regprocedure and p.prosecdef
                      and p.proconfig = array['search_path=""']
                      and p.prosrc ~ 'app\.role_manages_visibility\(\(select app\.live_role\(\)\)\)') then
      raise exception 'R14e: % must be a definer with an empty search_path that checks the live role', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('anon', f, 'execute')
       or has_function_privilege('service_role', f, 'execute')
       or exists (select 1 from pg_catalog.pg_proc p,
                         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = f::regprocedure and a.grantee = 0) then
      raise exception 'R14e: % must be executable by authenticated alone', f;
    end if;
    if (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p where p.oid = f::regprocedure)
       in ('anon', 'authenticated', 'service_role') then
      raise exception 'R14e: % is owned by an API role', f;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'public.store_page_password(uuid, text)'::regprocedure
                    and p.prosrc ~ 'app\.releases_enabled\(v_tenant\)'
                    and p.prosrc !~ 'p_tenant') then
    raise exception 'R14e: store_page_password must take the tenant from the profile and need releases on';
  end if;

  -- ---- 2. The trigger function: 0061's rules plus the entry branch -------------------------
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'app.tg_page_password_sync()'::regprocedure and p.prosecdef
                    and p.proconfig = array['search_path=""']
                    and p.prosrc ~ 'page_visibility_password_required'
                    and p.prosrc ~ 'old\.mode <> ''password'''
                    and p.prosrc ~ 'delete from public\.page_passwords') then
    raise exception 'R14e: app.tg_page_password_sync is not 0061''s with the entry branch';
  end if;
  if has_function_privilege('authenticated', 'app.tg_page_password_sync()', 'execute')
     or has_function_privilege('anon', 'app.tg_page_password_sync()', 'execute') then
    raise exception 'R14e: app.tg_page_password_sync must not be executable by an API role';
  end if;

  -- ---- 2b. The message: writable by a release, guarded outside one ------------------------
  if not has_column_privilege('authenticated', 'public.page_visibility', 'note', 'insert')
     or not has_column_privilege('authenticated', 'public.page_visibility', 'note', 'update')
     or has_column_privilege('anon', 'public.page_visibility', 'note', 'update')
     or has_column_privilege('authenticated', 'public.page_visibility', 'password_version', 'update')
     or has_column_privilege('authenticated', 'public.page_visibility', 'password_version', 'insert') then
    raise exception 'R14e: authenticated must write the message (a release) and never the password version';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgrelid = 'public.page_visibility'::regclass
                    and t.tgname = 'page_visibility_note_guard' and not t.tgisinternal
                    and t.tgfoid = 'app.tg_page_visibility_note_guard()'::regprocedure)
     or (select p.prosecdef from pg_catalog.pg_proc p
          where p.oid = 'app.tg_page_visibility_note_guard()'::regprocedure) then
    raise exception 'R14e: page_visibility_note_guard must be an invoker trigger on page_visibility';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'app.in_release_write()'::regprocedure and p.prosecdef
                    and p.proconfig = array['search_path=""']
                    and p.prosrc ~ '^ *select app\.release_token_valid\(\) *$')
     or not has_function_privilege('authenticated', 'app.in_release_write()', 'execute')
     or has_function_privilege('anon', 'app.in_release_write()', 'execute')
     or has_function_privilege('service_role', 'app.in_release_write()', 'execute') then
    raise exception 'R14e: app.in_release_write must be a definer over release_token_valid, for authenticated alone';
  end if;
  if 'page_visibility_note_guard' collate "C" <= 'page_visibility__release_guard' collate "C"
     or 'page_visibility_note_guard' collate "C" >= 'page_visibility_password' collate "C" then
    raise exception 'R14e: the note guard must fire after the release guard and before the password sync';
  end if;

  -- ---- 3. The secret stays outside every API role and every release ------------------------
  if exists (select 1 from app.release_entities e where e.table_name = 'page_passwords')
     or not exists (select 1 from app.release_entities e
                     where e.entity_type = 'page_visibility'
                       and e.exempt_columns = array['password_version']
                       and not ('password_version' = any (e.columns))) then
    raise exception 'R14e: page_passwords must stay out of the registry, password_version exempt';
  end if;
  if exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'page_passwords')
     or exists (select 1
                  from pg_catalog.pg_class c,
                       aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 where c.oid = 'public.page_passwords'::regclass
                   and a.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid,
                                     'service_role'::regrole::oid)) then
    raise exception 'R14e: page_passwords must have no policy and no privilege for any API role';
  end if;

  -- ---- 4. The guide at revision 3, in the catalog and in every tenant ---------------------
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'page-visibility' and c.revision = 3 and c.sort_order = 105
                    and c.caps = array['maintenance.manage']
                    and c.body #>> '{en,2,x}' like 'Once publishing in releases is switched on%'
                    and c.body #>> '{en,2,x}' like '%the page starts asking for it when that change is published%'
                    and c.body #>> '{ar,2,x}' like '%تبدأ الصفحة بطلبها عند نشر ذلك التغيير%') then
    raise exception 'R14e: page-visibility is not at revision 3 with its release-mode words';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'page-visibility'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'R14e: tenants without the catalog''s page-visibility: %', v_bad;
  end if;
end $$;
