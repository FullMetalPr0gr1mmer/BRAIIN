-- ─────────────────────────────────────────────────────────────────────────────
-- 0055 — Users v2 and the session posture (Admin v2 U12a). Forward-only, expand only.
-- Depends on 0001 (profiles, profiles_self_select, profiles_admin_write), 0009 (the lockout
-- RPCs), 0010 (the access-token hook and profiles_auth_admin_read), 0031 (the audit chain),
-- 0033 (app.live_role), 0037 (profiles' stated grants), 0044 (the display-name rule) and
-- 0050 (app.role_manages_users, the three RESTRICTIVE live write policies on profiles, the
-- audit actor binding).
--
-- What H10 (0050) left open, and what the users screen needs:
--
--   • A ROLE CHANGE ENDS EVERY SESSION. RLS reads the role from the access token, which
--     lives up to an hour, and nothing revoked a session when a role changed (CLAUDE.md §3
--     said "on role/tenant change, force-revoke sessions"; no code did). Now
--     app.tg_profiles_revoke_sessions(), an AFTER UPDATE trigger on profiles, deletes every
--     auth.sessions and auth.refresh_tokens row of a person whose role, is_active or tenant
--     changes, whoever writes it: the users screen, a direct API call, the service role, an
--     operator. No refresh is possible afterwards; GoTrue answers session_not_found to the
--     next getUser(), so the admin turns the person away at their next click, and their next
--     sign-in mints a token the hook stamps with the new role. A SECURITY DEFINER, because
--     no API role may touch the auth schema: its owner (the migration role, `postgres` on
--     Supabase) must hold DELETE on both tables and bypass RLS. THE POSTCONDITIONS BELOW
--     CHECK BOTH AND REFUSE THE MIGRATION OTHERWISE, so a project where the owner cannot is
--     never left with a trigger that fails every role change (scratchpad readback_0055.sql
--     carries the read-only query to run first).
--   • COLLEAGUES' PROFILES ARE READ LIVE. profiles_self_select (0001) lets a token whose
--     claim says admin read every profile of its tenant; a demoted, deactivated or locked
--     Admin kept that for up to an hour. profiles_live_read, RESTRICTIVE, TO authenticated:
--     the tenant predicate first, then your own row or app.role_manages_users(live role).
--     With H10's three write policies, every staff command on profiles is now live. Not
--     affected: the access-token hook (supabase_auth_admin, not authenticated), the
--     definers that read profiles (app.live_role, app.is_live_admin, app.staff_directory,
--     the lockout RPCs, app.crm_eraser_ok: their owner bypasses RLS, checked below), the
--     service role (BYPASSRLS), and a person reading their own row (the shell's name).
--   • THE ACCOUNT OWNER. profiles.is_owner, at most one per tenant (profiles_one_owner), set
--     by an operator (launch runbook §3), never by this migration (the oldest Admin may be
--     the developer's account) and never claimable from the admin. app.tg_profiles_owner_guard
--     (BEFORE INSERT OR UPDATE OR DELETE, every caller): the owner cannot be deleted (an
--     auth.users cascade included: unmark first); a row that is, or becomes, the owner must
--     be an active Admin, and the owner cannot move tenant; only an operator or a definer
--     (current_user not anon, authenticated or service_role) may set or clear the marker.
--     The lockout columns stay writable for the owner (the lockout RPCs keep working).
--     Ownership moves by the owner's own action only: public.transfer_ownership.
--   • public.admin_security_settings: one row per tenant, created on first save. The
--     session length (1 or 7 days; the Worker revokes a sign-in older than that, from the
--     token's newest `amr` time) and the domain invites may go to. Admin only in both
--     layers (users.manage), with a RESTRICTIVE live check; immediate (P-3), so not in the
--     release registry and no snapshot. The service role reads it (the session check).
--   • public.staff_accounts(p_tenant): colleagues' e-mails and sign-in times from
--     auth.users, for a live Admin of the token's tenant only (empty for anyone else);
--     the Worker's assertCap('users.manage') is the second layer.
--   • public.transfer_ownership(p_tenant, p_to): the owner hands ownership to another
--     active, unlocked Admin of the tenant, audited in the same transaction.
--   • The roles guide (app.help_article_set(), U16's rule): rewritten for what H10 and this
--     migration close and what stays open; every other guide is main's text unchanged.
--
-- Production as of 2026-10-16: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046,
-- 0048, 0050, 0051, 0052 and 0054. The help set below is 0054's (which carries 0052's
-- website-stats and site-health-and-logs and 0054's site-health-and-logs), so applying this
-- one after them keeps their guides. Grants are stated for both Supabase privilege regimes
-- (README P-14). CLAUDE.md §2 (session invalidation), §3 (Pillar 1), §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0050). The column, the
-- index, the policy and the triggers take locks on public.profiles, which every admin
-- request and every sign-in reads; the help re-seed writes public.help_articles. A
-- statement below that waits more than five seconds for a lock raises instead, the whole
-- migration rolls back, and the push is retried later. Transaction-local.
set local lock_timeout = '5s';

-- ---- 1. The account owner ---------------------------------------------------------------
-- A constant default: no table rewrite. No grant names the column, so no API role writes
-- it (0037's column UPDATE grant stays role, is_active and display_name); staff read it
-- with the rest of the row (table-level SELECT, behind RLS).
alter table public.profiles add column if not exists is_owner boolean not null default false;
create unique index if not exists profiles_one_owner on public.profiles (tenant_id) where is_owner;

-- SECURITY INVOKER, so current_user is the writer: anon, authenticated and service_role
-- are API roles; anything else is an operator or a definer running as its owner.
create or replace function app.tg_profiles_owner_guard() returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception using errcode = '42501', message = 'owner_protected',
        detail = 'The account owner cannot be deleted. An operator clears profiles.is_owner first (launch runbook §3).';
    end if;
    return old;
  end if;

  -- The marker moves only by an operator's hand or a definer's (transfer_ownership).
  if (tg_op = 'INSERT' and new.is_owner)
     or (tg_op = 'UPDATE' and new.is_owner is distinct from old.is_owner) then
    if current_user in ('anon', 'authenticated', 'service_role') then
      raise exception using errcode = '42501', message = 'owner_protected',
        detail = 'The account owner is set by an operator and moved by the owner (public.transfer_ownership).';
    end if;
  end if;

  -- The owner stays an active Admin of their tenant, whoever writes.
  if new.is_owner
     and (new.role::text is distinct from 'admin'
          or new.is_active is not true
          or (tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id)) then
    raise exception using errcode = '42501', message = 'owner_protected',
      detail = 'The account owner keeps the Admin role, stays active and stays in its tenant.';
  end if;
  return new;
end $$;
-- A trigger function: fired by its trigger, called by no session.
revoke all on function app.tg_profiles_owner_guard() from public, anon, authenticated, service_role;

drop trigger if exists profiles_owner_guard on public.profiles;
create trigger profiles_owner_guard before insert or update or delete on public.profiles
  for each row execute function app.tg_profiles_owner_guard();

-- ---- 2. A role, activity or tenant change ends every session ------------------------------
-- Deleting the sessions also deletes their refresh tokens and amr claims (GoTrue's foreign
-- keys cascade); the second delete takes the refresh tokens no session names (GoTrue's
-- user_id column there is text). AFTER, so a refused write revokes nothing.
create or replace function app.tg_profiles_revoke_sessions() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  delete from auth.sessions where user_id = new.id;
  delete from auth.refresh_tokens where user_id = new.id::text;
  return null;
end $$;
revoke all on function app.tg_profiles_revoke_sessions() from public, anon, authenticated, service_role;

drop trigger if exists profiles_revoke_sessions on public.profiles;
create trigger profiles_revoke_sessions after update of role, is_active, tenant_id on public.profiles
  for each row
  when (old.role is distinct from new.role
        or old.is_active is distinct from new.is_active
        or old.tenant_id is distinct from new.tenant_id)
  execute function app.tg_profiles_revoke_sessions();

-- ---- 3. Reading colleagues' profiles is live -----------------------------------------------
-- RESTRICTIVE: ANDed with profiles_self_select and profiles_admin_write, so it only narrows.
-- Your own row stays readable whatever your token (the shell reads your name through it).
drop policy if exists profiles_live_read on public.profiles;
create policy profiles_live_read on public.profiles as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id()
         and (id = (select auth.uid()) or app.role_manages_users((select app.live_role()))));

-- ---- 4. The Security card's settings --------------------------------------------------------
create table if not exists public.admin_security_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  -- How long a sign-in lasts, in days, from the token's newest amr time (the Worker's
  -- check). 7 is the session cookie's own Max-Age (F7), so nothing longer is offered.
  session_max_days smallint not null default 7 check (session_max_days in (1, 7)),
  -- The one domain invites may go to (lower case, no scheme, no @), or any when null.
  invite_domain text check (
    invite_domain is null
    or (char_length(invite_domain) <= 253
        and invite_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);
alter table public.admin_security_settings enable row level security;
alter table public.admin_security_settings force row level security;

drop trigger if exists admin_security_settings_updated_at on public.admin_security_settings;
create trigger admin_security_settings_updated_at before update on public.admin_security_settings
  for each row execute function app.tg_set_updated_at();
drop trigger if exists admin_security_settings_actor on public.admin_security_settings;
create trigger admin_security_settings_actor before insert or update on public.admin_security_settings
  for each row execute function app.tg_set_actor();
drop trigger if exists admin_security_settings_version on public.admin_security_settings;
create trigger admin_security_settings_version before update on public.admin_security_settings
  for each row execute function app.tg_bump_version();

-- The JWT layer: an Admin of the tenant reads, creates and changes the row. No DELETE policy.
drop policy if exists admin_security_settings_read on public.admin_security_settings;
create policy admin_security_settings_read on public.admin_security_settings
  for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_manages_users(app.current_role()));
drop policy if exists admin_security_settings_insert on public.admin_security_settings;
create policy admin_security_settings_insert on public.admin_security_settings
  for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_manages_users(app.current_role()));
drop policy if exists admin_security_settings_update on public.admin_security_settings;
create policy admin_security_settings_update on public.admin_security_settings
  for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_manages_users(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_manages_users(app.current_role()));
-- The live layer: the profile, read now, must still be an Admin's.
drop policy if exists admin_security_settings_live on public.admin_security_settings;
create policy admin_security_settings_live on public.admin_security_settings
  as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_manages_users((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_manages_users((select app.live_role())));

-- Grants, stated (P-14). Staff: read; insert the key and the two settings; update the two
-- settings. The service role: read (resolveAuthContext embeds the row in its profile read).
-- No sequence (the key is the tenant).
revoke all on public.admin_security_settings from public, anon, authenticated, service_role;
grant select on public.admin_security_settings to authenticated, service_role;
grant insert (tenant_id, session_max_days, invite_domain) on public.admin_security_settings to authenticated;
grant update (session_max_days, invite_domain) on public.admin_security_settings to authenticated;

-- ---- 5. Colleagues' e-mails: a live Admin's directory ---------------------------------------
-- auth.users is no API role's to read, so a definer reads it, and checks its caller itself:
-- the tenant named is the token's, and the caller's profile, read live, is an Admin's.
create or replace function public.staff_accounts(p_tenant uuid)
  returns table (id uuid, email text, invited_at timestamptz, email_confirmed_at timestamptz,
                 last_sign_in_at timestamptz, is_owner boolean)
  language sql stable security definer set search_path = '' as $$
  select p.id, u.email::text, u.invited_at, u.email_confirmed_at, u.last_sign_in_at, p.is_owner
    from public.profiles p
    join auth.users u on u.id = p.id
   where p_tenant = app.effective_tenant_id()
     and p.tenant_id = p_tenant
     and app.role_manages_users((select app.live_role()))
   order by p.created_at, p.id
   limit 200
$$;
revoke all on function public.staff_accounts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_accounts(uuid) to authenticated;

-- ---- 6. Handing ownership on ---------------------------------------------------------------
-- The caller: a live Admin of the token's tenant who is its owner (42501 otherwise). The
-- target: another active, unlocked Admin of the same tenant (22023 otherwise). The caller's
-- marker is cleared before the target's is set (profiles_one_owner holds at every statement),
-- both rows locked first, and the audit row is written in the same transaction, so a
-- transfer whose audit row cannot be chained does not happen.
create or replace function public.transfer_ownership(p_tenant uuid, p_to uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_owner boolean;
begin
  if v_uid is null
     or p_tenant is distinct from app.effective_tenant_id()
     or not app.role_manages_users(app.live_role()) then
    raise exception using errcode = '42501',
      message = 'transfer_ownership: the caller is not a live Admin of this tenant';
  end if;
  select p.is_owner into v_owner
    from public.profiles p
   where p.id = v_uid and p.tenant_id = p_tenant
   for update;
  if v_owner is not true then
    raise exception using errcode = '42501',
      message = 'transfer_ownership: only the account owner can hand ownership on';
  end if;
  if p_to is null or p_to = v_uid then
    raise exception using errcode = '22023', message = 'transfer_ownership: choose another Admin';
  end if;
  perform 1
     from public.profiles p
    where p.id = p_to and p.tenant_id = p_tenant
      and p.role::text = 'admin' and p.is_active
      and (p.locked_until is null or p.locked_until <= now())
    for update;
  if not found then
    raise exception using errcode = '22023',
      message = 'transfer_ownership: the new owner must be an active, unlocked Admin of this tenant';
  end if;
  update public.profiles set is_owner = false where id = v_uid and tenant_id = p_tenant;
  update public.profiles set is_owner = true where id = p_to and tenant_id = p_tenant;
  -- Hash-chained by audit_log's own triggers, as every insert is.
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, v_uid, 'admin', 'user.ownership_transfer', 'profile', p_to::text,
          jsonb_build_object('to', p_to));
end $$;
revoke all on function public.transfer_ownership(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;

-- ---- 7. The guides ---------------------------------------------------------------------------
-- U16's rule: a slice that changes a screen a guide describes replaces the whole set and
-- seeds every tenant again. Only roles-and-access changes; every other guide is 0054's text.
-- The set as 0054_activity_log.sql left it, with roles-and-access rewritten (the owner, the
-- sign-out on every device, the hour that remains at the database, the Security card).
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
revoke all on function app.help_article_set() from public, anon, authenticated, service_role;

-- Every tenant gets the set again (app.seed_help_articles brings a changed guide back to
-- the set's text and moves its version; the others are left alone).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_help_articles(t.id);
  end loop;
end $$;

-- ---- Postconditions ---------------------------------------------------------------------
-- Each block says what it checks. Expressions are read as pg_get_expr prints them (each
-- operator in parentheses, each AND list in one pair; a function's schema printed only when
-- its schema is not on the search path, and `current_role` quoted as the keyword it is, so
-- the patterns allow both). The first block is the one the push depends on: if the owner of
-- these functions cannot reach the auth schema, the migration refuses here and rolls back.
do $$
declare
  v_me name := current_user;
  v_owner oid;
begin
  -- ---- The session revocation can run: its owner deletes from auth.sessions and
  -- auth.refresh_tokens past any row security, and the definers read auth.users.
  foreach v_owner in array array[
      (select proowner from pg_proc where oid = 'app.tg_profiles_revoke_sessions()'::regprocedure),
      (select proowner from pg_proc where oid = 'public.staff_accounts(uuid)'::regprocedure),
      (select proowner from pg_proc where oid = 'public.transfer_ownership(uuid, uuid)'::regprocedure)] loop
    if v_owner is distinct from (select oid from pg_roles where rolname = v_me) then
      raise exception '0055: the definers must be owned by the migration role %', v_me;
    end if;
  end loop;
  if not exists (select 1 from pg_roles r where r.rolname = v_me and (r.rolsuper or r.rolbypassrls)) then
    raise exception '0055: the definers'' owner (%) does not bypass RLS: profiles_live_read would hide colleagues from app.live_role''s callers, and a delete on an RLS-enabled auth table would delete nothing', v_me;
  end if;
  if to_regclass('auth.sessions') is null or to_regclass('auth.refresh_tokens') is null then
    raise exception '0055: auth.sessions or auth.refresh_tokens is missing: no session can be revoked';
  end if;
  if not has_table_privilege(v_me, 'auth.sessions', 'delete')
     or not has_table_privilege(v_me, 'auth.refresh_tokens', 'delete') then
    raise exception '0055: % cannot DELETE from auth.sessions and auth.refresh_tokens, so profiles_revoke_sessions would fail every role change. Refused (run the readback''s pre-push query)', v_me;
  end if;
  if not has_table_privilege(v_me, 'auth.users', 'select') then
    raise exception '0055: % cannot SELECT auth.users, so public.staff_accounts would fail', v_me;
  end if;
  -- The privilege, exercised: a statement that deletes nothing still needs it, as the
  -- trigger does, so a refused one fails here and not at the first role change.
  execute 'delete from auth.sessions where false';
  execute 'delete from auth.refresh_tokens where false';
  perform 1 from auth.users where false;
end $$;

do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_live constant text := '(app\.)?role_manages_users\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)';
  v_jwt constant text := '(app\.)?role_manages_users\((app\.)?"?current_role"?\(\)\)';
  v_have text[];
  v_want text[];
  v_cols text[];
  v_bad text;
  v_def text;
  p text;
begin
  -- ---- The owner marker: the column, and at most one owner per tenant.
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.profiles'::regclass and a.attname = 'is_owner'
                    and a.atttypid = 'boolean'::regtype and a.attnotnull and not a.attisdropped
                    and pg_get_expr((select d.adbin from pg_attrdef d
                                      where d.adrelid = a.attrelid and d.adnum = a.attnum),
                                    a.attrelid) = 'false') then
    raise exception '0055: profiles.is_owner must be boolean NOT NULL DEFAULT false';
  end if;
  select pg_get_indexdef(i.indexrelid) into v_def
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.profiles'::regclass and c.relname = 'profiles_one_owner';
  if v_def is null or v_def !~ '^CREATE UNIQUE INDEX profiles_one_owner ON public\.profiles USING btree \(tenant_id\) WHERE is_owner$' then
    raise exception '0055: profiles_one_owner is %, expected a unique index on (tenant_id) WHERE is_owner', v_def;
  end if;

  -- ---- profiles: RLS on and forced, and exactly these policies (name, command, kind and
  -- roles compared as a set): 0001's two, 0010's hook read, 0050's three live writes and the
  -- live read.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.profiles'::regclass) then
    raise exception '0055: profiles is not ENABLE + FORCE row level security';
  end if;
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'profiles') s;
  select array_agg(w order by w) into v_want
    from unnest(array['profiles_admin_write ALL PERMISSIVE {public}',
                      'profiles_auth_admin_read SELECT PERMISSIVE {supabase_auth_admin}',
                      'profiles_live_delete DELETE RESTRICTIVE {authenticated}',
                      'profiles_live_insert INSERT RESTRICTIVE {authenticated}',
                      'profiles_live_read SELECT RESTRICTIVE {authenticated}',
                      'profiles_live_update UPDATE RESTRICTIVE {authenticated}',
                      'profiles_self_select SELECT PERMISSIVE {public}']) as w;
  if v_have is distinct from v_want then
    raise exception '0055: profiles policies are %, expected %', v_have, v_want;
  end if;
  -- Each live policy, side by side: the tenant predicate first, then the live check (the
  -- read lets your own row through). A side the command does not have is absent.
  select string_agg(format('%s %s', x.policy, x.side), ', ' order by x.policy, x.side) into v_bad
    from (values
            ('profiles_live_read', 'using',
             '^\(' || v_tenant || ' AND \(\(id = \( SELECT auth\.uid\(\) AS uid\)\) OR ' || v_live || '\)\)$'),
            ('profiles_live_read', 'with check', null),
            ('profiles_live_update', 'using', '^\(' || v_tenant || ' AND ' || v_live || '\)$'),
            ('profiles_live_update', 'with check', '^\(' || v_tenant || ' AND ' || v_live || '\)$'),
            ('profiles_live_insert', 'using', null),
            ('profiles_live_insert', 'with check', '^\(' || v_tenant || ' AND ' || v_live || '\)$'),
            ('profiles_live_delete', 'using', '^\(' || v_tenant || ' AND ' || v_live || '\)$'),
            ('profiles_live_delete', 'with check', null)) as x(policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = 'profiles' and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0055: profiles live policy expressions are not as stated: %', v_bad;
  end if;

  -- ---- profiles' grants, as 0037 and 0050 left them: PUBLIC and anon nothing;
  -- authenticated SELECT at table level and UPDATE on exactly role, is_active and
  -- display_name (never is_owner); the service role its four.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.profiles', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0055: wrong table privileges on profiles (role privilege): %', v_bad;
  end if;
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.profiles', p) then
      raise exception '0055: the service role lost % on profiles (the invite, the session check)', p;
    end if;
  end loop;
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.profiles', 'select, insert, update, references') then
      raise exception '0055: % holds a column privilege on profiles', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.profiles', a.attname::text, 'update');
  if v_cols is distinct from array['display_name', 'is_active', 'role'] then
    raise exception '0055: authenticated updates profiles columns % (expected exactly display_name, is_active, role; never is_owner)', v_cols;
  end if;
  if has_any_column_privilege('authenticated', 'public.profiles', 'insert, references') then
    raise exception '0055: authenticated holds a column INSERT or REFERENCES on profiles';
  end if;

  -- ---- profiles' triggers, by name, event and function: 0001's updated_at, 0044's name rule,
  -- the owner guard (BEFORE INSERT OR UPDATE OR DELETE, every row) and the revocation (AFTER
  -- UPDATE OF role, is_active, tenant_id, only when one of them changes).
  select coalesce(array_agg(t.tgname::text order by t.tgname collate "C"), '{}') into v_have
    from pg_trigger t
   where t.tgrelid = 'public.profiles'::regclass and not t.tgisinternal;
  if v_have is distinct from array['profiles_display_name_rule', 'profiles_owner_guard',
                                   'profiles_revoke_sessions', 'profiles_updated_at'] then
    raise exception '0055: profiles triggers are %, expected the name rule, the owner guard, the revocation and updated_at', v_have;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'profiles_owner_guard'
                    and t.tgenabled::text = 'O' and t.tgqual is null
                    and t.tgfoid = 'app.tg_profiles_owner_guard()'::regprocedure
                    -- ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16
                    and t.tgtype = 31) then
    raise exception '0055: profiles_owner_guard must be BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW, enabled, unconditional';
  end if;
  select pg_get_triggerdef(t.oid) into v_def
    from pg_trigger t
   where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'profiles_revoke_sessions'
     and t.tgenabled::text = 'O' and t.tgfoid = 'app.tg_profiles_revoke_sessions()'::regprocedure;
  if v_def is null
     or v_def !~ '^CREATE TRIGGER profiles_revoke_sessions AFTER UPDATE OF role, is_active, tenant_id ON public\.profiles FOR EACH ROW WHEN \(\(\(old\.role IS DISTINCT FROM new\.role\) OR \(old\.is_active IS DISTINCT FROM new\.is_active\) OR \(old\.tenant_id IS DISTINCT FROM new\.tenant_id\)\)\) EXECUTE FUNCTION app\.tg_profiles_revoke_sessions\(\)$' then
    raise exception '0055: profiles_revoke_sessions is %, expected AFTER UPDATE OF role, is_active, tenant_id WHEN one of them changes', v_def;
  end if;

  -- ---- The functions: their kind, their search_path and who may call them.
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.tg_profiles_owner_guard()'::regprocedure and not f.prosecdef
                    and f.proconfig = array['search_path=""']) then
    raise exception '0055: app.tg_profiles_owner_guard() must be SECURITY INVOKER with search_path = ''''';
  end if;
  foreach p in array array['app.tg_profiles_revoke_sessions()', 'public.staff_accounts(uuid)',
                           'public.transfer_ownership(uuid, uuid)'] loop
    if not exists (select 1 from pg_proc f
                    where f.oid = p::regprocedure and f.prosecdef
                      and f.proconfig = array['search_path=""']) then
      raise exception '0055: % must be SECURITY DEFINER with search_path = ''''', p;
    end if;
  end loop;
  select string_agg(format('%s %s', r, f), ', ' order by f, r) into v_bad
    from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r
    cross join (values ('app.tg_profiles_owner_guard()', array[]::text[]),
                       ('app.tg_profiles_revoke_sessions()', array[]::text[]),
                       ('public.staff_accounts(uuid)', array['authenticated']),
                       ('public.transfer_ownership(uuid, uuid)', array['authenticated']))
                 as x(f, allowed)
   where has_function_privilege(r, f, 'execute') is distinct from (r = any (x.allowed));
  if v_bad is not null then
    raise exception '0055: wrong EXECUTE (role function): %', v_bad;
  end if;
  -- What the definers stand on: live_role (a definer staff call) and the users.manage helper.
  if not exists (select 1 from pg_proc where oid = 'app.live_role()'::regprocedure and prosecdef)
     or not app.role_manages_users('admin') or app.role_manages_users('developer')
     or app.role_manages_users('content_creator') or app.role_manages_users('seo')
     or app.role_manages_users(null) then
    raise exception '0055: app.live_role() or app.role_manages_users() is not as 0033 and 0050 left it';
  end if;

  -- ---- admin_security_settings: forced RLS, its columns' rules, its policies, its grants.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.admin_security_settings'::regclass) then
    raise exception '0055: admin_security_settings is not ENABLE + FORCE row level security';
  end if;
  -- Its two CHECKs, by what they constrain (pgTAP exercises them on values).
  select coalesce(array_agg(pg_get_constraintdef(k.oid) order by pg_get_constraintdef(k.oid)), '{}')
    into v_have
    from pg_constraint k
   where k.conrelid = 'public.admin_security_settings'::regclass and k.contype = 'c';
  if cardinality(v_have) <> 2
     or v_have[1] !~ 'invite_domain IS NULL'
     or v_have[2] !~ 'session_max_days = ANY \(ARRAY\[1, 7\]\)' then
    raise exception '0055: admin_security_settings CHECKs are %', v_have;
  end if;
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'admin_security_settings') s;
  if v_have is distinct from array['admin_security_settings_insert INSERT PERMISSIVE {authenticated}',
                                   'admin_security_settings_live ALL RESTRICTIVE {authenticated}',
                                   'admin_security_settings_read SELECT PERMISSIVE {authenticated}',
                                   'admin_security_settings_update UPDATE PERMISSIVE {authenticated}'] then
    raise exception '0055: admin_security_settings policies are %', v_have;
  end if;
  select string_agg(format('%s %s', x.policy, x.side), ', ' order by x.policy, x.side) into v_bad
    from (values
            ('admin_security_settings_read', 'using', '^\(' || v_tenant || ' AND ' || v_jwt || '\)$'),
            ('admin_security_settings_read', 'with check', null),
            ('admin_security_settings_insert', 'using', null),
            ('admin_security_settings_insert', 'with check', '^\(' || v_tenant || ' AND ' || v_jwt || '\)$'),
            ('admin_security_settings_update', 'using', '^\(' || v_tenant || ' AND ' || v_jwt || '\)$'),
            ('admin_security_settings_update', 'with check', '^\(' || v_tenant || ' AND ' || v_jwt || '\)$'),
            ('admin_security_settings_live', 'using', '^\(' || v_tenant || ' AND ' || v_live || '\)$'),
            ('admin_security_settings_live', 'with check', '^\(' || v_tenant || ' AND ' || v_live || '\)$'))
           as x(policy, side, pattern)
    left join pg_policies pol
      on pol.schemaname = 'public' and pol.tablename = 'admin_security_settings'
     and pol.policyname = x.policy
    cross join lateral (select case x.side when 'using' then pol.qual
                                           else pol.with_check end as expr) e
   where pol.policyname is null
      or (x.pattern is null and e.expr is not null)
      or (x.pattern is not null and coalesce(e.expr, '') !~ x.pattern);
  if v_bad is not null then
    raise exception '0055: admin_security_settings policy expressions are not as stated: %', v_bad;
  end if;
  -- Table level: SELECT for staff and the service role, nothing else for anyone.
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv,
                 has_table_privilege(x.who::name, 'public.admin_security_settings', pr.priv) as held,
                 pr.priv = any (x.allowed) as wanted
            from (values ('public', array[]::text[]),
                         ('anon', array[]::text[]),
                         ('authenticated', array['select']),
                         ('service_role', array['select']))
                   as x(who, allowed)
            cross join unnest(v_privs) as pr(priv)) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0055: wrong table privileges on admin_security_settings (role privilege): %', v_bad;
  end if;
  -- Column level: staff insert the key and the two settings and update the two settings;
  -- nobody holds REFERENCES; PUBLIC, anon and the service role hold no column write.
  select string_agg(format('%s %s.%s', g.who, g.priv, g.col), ', ' order by g.who, g.col, g.priv) into v_bad
    from (select x.who, pr.priv, a.attname::text as col,
                 has_column_privilege(x.who::name, 'public.admin_security_settings', a.attname::text, pr.priv) as held,
                 (x.who = 'authenticated'
                  and ((pr.priv = 'insert' and a.attname in ('tenant_id', 'session_max_days', 'invite_domain'))
                       or (pr.priv = 'update' and a.attname in ('session_max_days', 'invite_domain')))) as wanted
            from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as x(who)
            cross join unnest(array['insert', 'update', 'references']) as pr(priv)
            cross join pg_attribute a
           where a.attrelid = 'public.admin_security_settings'::regclass and a.attnum > 0
             and not a.attisdropped) g
   where g.held is distinct from g.wanted;
  if v_bad is not null then
    raise exception '0055: wrong column privileges on admin_security_settings (role privilege.column): %', v_bad;
  end if;
  -- Its triggers: updated_at, the actor and the version, by function.
  select coalesce(array_agg(t.tgname::text order by t.tgname collate "C"), '{}') into v_have
    from pg_trigger t
   where t.tgrelid = 'public.admin_security_settings'::regclass and not t.tgisinternal
     and ((t.tgname = 'admin_security_settings_actor' and t.tgfoid = 'app.tg_set_actor()'::regprocedure)
          or (t.tgname = 'admin_security_settings_updated_at' and t.tgfoid = 'app.tg_set_updated_at()'::regprocedure)
          or (t.tgname = 'admin_security_settings_version' and t.tgfoid = 'app.tg_bump_version()'::regprocedure));
  if v_have is distinct from array['admin_security_settings_actor', 'admin_security_settings_updated_at',
                                   'admin_security_settings_version']
     or (select count(*) from pg_trigger t
          where t.tgrelid = 'public.admin_security_settings'::regclass and not t.tgisinternal) <> 3 then
    raise exception '0055: admin_security_settings triggers are %', v_have;
  end if;
  -- Not a release-managed entity (immediate, P-3): never in the registry.
  if exists (select 1 from app.release_entities where table_name = 'admin_security_settings') then
    raise exception '0055: admin_security_settings must not be in the release registry';
  end if;

  -- ---- Every tenant holds every guide of the set, each as the set has it.
  if exists (select 1
               from public.tenants t
               cross join jsonb_to_recordset(app.help_article_set())
                 as a (slug text, title text, body jsonb, minutes smallint)
              where not exists (select 1 from public.help_articles h
                                 where h.tenant_id = t.id and h.slug = a.slug and h.title = a.title
                                   and h.body = a.body and h.minutes = a.minutes)) then
    raise exception '0055: a guide of the set is missing from a tenant, or differs from the set';
  end if;
end $$;
