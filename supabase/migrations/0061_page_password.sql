-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0061 — Page visibility: "Behind a password" (Admin v2 U14b, AV-13+). Forward-only, expand
-- only. Depends on 0001 (pages, page_sections, page_sections_read, app.current_role,
-- app.effective_tenant_id), 0002 (audit_log and its chain), 0009 (the actor and version
-- triggers), 0011 (page_sections_published_only, the RESTRICTIVE published-parent fence),
-- 0012 (pgcrypto in schema extensions), 0016 (anon's SELECT on page_sections), 0033
-- (app.live_role), 0038 (the release registry), 0046 (the help centre), 0050 (the audit
-- actor trigger), 0051 (app.tg_release_capture), 0057 (page_visibility, U14a) and 0060
-- (the guides as U1 left them).
--
-- U14a shipped public / hidden / link only. This adds the fourth mode: a page a visitor opens
-- only after typing a password. It is numbered 0061, not the 0058 the Wave 2 ledger reserved:
-- U1's 0060 merges first, and a 0058 would then sort below main's highest, which
-- scripts/check-migrations.mjs refuses (Wave 3 therefore starts at 0062).
--
-- A password is a secret, so the slice is built around four rules:
--
--   1. IT IS NEVER STORED IN THE CLEAR. public.page_passwords keeps one bcrypt hash per page
--      (extensions.crypt / extensions.gen_salt('bf', 10)) and nothing else about it. The
--      table has RLS ENABLE + FORCE, no policy, and no privilege for any API role: anon,
--      authenticated and the service role cannot read, write or reference it at all. The only
--      code that touches it is the definers below, which run as this file's owner.
--   2. IT IS NEVER READ BACK. Nothing returns the hash, and no function turns a page into a
--      password. Changing the message above the box, or the password itself, is one call:
--      set_page_password. An admin who forgets a password sets a new one.
--   3. CHECKING IT IS SERVER-SIDE ONLY. public.page_password_check is executable by the
--      service role alone — the Worker's unlock route, behind a same-origin check and a rate
--      limit that fails closed (src/pages/api/page-access.ts). It answers the page's
--      password_version on a match and null otherwise, and runs crypt() against a fixed dummy
--      hash when there is no secret, so "no such page" costs what "wrong password" costs. The
--      KV snapshot the edge reads carries that version and never a hash
--      (src/lib/http/visibility.ts), so a reader of the snapshot learns nothing that unlocks a
--      page; the cookie that proves an unlock is signed by the Worker under a labelled
--      derivation of LEAD_PII_ENC_KEY (src/lib/visibility/access.ts).
--   4. THE PAGE'S WORDS ARE FENCED IN THE DATABASE, NOT ONLY AT THE EDGE. Without that, a
--      password page's text would still be one anonymous request away at
--      /rest/v1/page_sections?page_id=eq.<id> with the public anon key — the
--      CSP-'unsafe-inline' kind of claim CLAUDE.md §3 forbids. page_sections_password_fence is
--      a RESTRICTIVE SELECT policy TO anon and authenticated that only staff pass (a signed-in
--      role that is not one of the four, such as the planned Sales role, reads no more than
--      anon), and an unlocked request reads the page's sections through
--      public.page_sections_unlocked and their images through public.page_media_unlocked
--      (service role only), which return exactly the rows and columns anon would have read
--      without the fence. So the edge gate failing open (decision D6, a KV error) still leaks
--      nothing, and an unlocked page renders what a public one would.
--
-- What this file adds:
--   • page_visibility.mode gains 'password' (templates still take public or hidden only, and
--     the homepage still takes nothing but public: 0057's guard refuses every other mode).
--   • page_visibility.note jsonb — the bilingual line above the password box ({en, ar}, each
--     at most 140 characters, no markup and no control characters, in the style of
--     app.help_text_ok) — and page_visibility.password_version int, which every password
--     change moves, ending every cookie minted under the old one.
--   • public.page_passwords, public.set_page_password (Admin and Developer, live-checked),
--     public.page_password_check, public.page_sections_unlocked and
--     public.page_media_unlocked (service role),
--     app.page_is_password_locked (the fence's predicate) and the trigger
--     app.tg_page_password_sync, which refuses password mode without a secret and deletes the
--     secret, clears the note and moves the version when a page leaves password mode.
--   • The registry row restated: `columns` gains `note`, `exempt_columns` `password_version`
--     (a secret is immediate, P-3: a release never carries one).
--   • app.help_article_set() restated with the page-visibility guide's password section.
--
-- Grants are stated for both Supabase privilege regimes (README P-14). Production as of
-- 2026-10-17: PostgreSQL 17.6; the ledger holds 0001-0038, 0041, 0044-0046, 0048, 0050-0052,
-- 0054-0057 and 0060 (U1). CLAUDE.md §3 (Pillar 1), §5, §7, §8, §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: page_visibility takes an ACCESS EXCLUSIVE
-- lock while its CHECKs are replaced and its columns added, page_sections one for the new
-- policy, and the reseed writes public.help_articles. A statement that waits more than five
-- seconds for a lock raises, the whole migration rolls back, and the push is retried later.
-- Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 1. The fourth mode, the message and the version ------------------------------------
-- Widening a CHECK is expand-only: every row that satisfied the old one satisfies this.
alter table public.page_visibility drop constraint if exists page_visibility_mode_known;
alter table public.page_visibility add constraint page_visibility_mode_known
  check (mode in ('public', 'hidden', 'link', 'password'));

alter table public.page_visibility
  add column if not exists note jsonb,
  add column if not exists password_version int not null default 0;

comment on column public.page_visibility.note is
  'The line shown above the password box, {en, ar} (either may be absent). Authored content, '
  'never a secret; rendered as text, never as markup.';
comment on column public.page_visibility.password_version is
  'Moves on every password change and whenever a page leaves password mode, so every unlock '
  'cookie minted under the old one stops verifying (src/lib/visibility/access.ts).';

-- The note belongs to the password gate, so it exists only while the page has one; the
-- trigger below clears it when the mode changes.
alter table public.page_visibility drop constraint if exists page_visibility_note_password;
alter table public.page_visibility add constraint page_visibility_note_password
  check (note is null or mode = 'password');

-- {en, ar}, at least one of them, each a non-blank string of at most 140 characters with no
-- `<`, `>` and no control or format character — app.help_text_ok's rule, written out because
-- a CHECK should not depend on a function no API role may execute. CASE, not a chain of ANDs:
-- PostgreSQL does not promise AND short-circuits, and `jsonb - text[]` raises on a scalar.
alter table public.page_visibility drop constraint if exists page_visibility_note_ok;
alter table public.page_visibility add constraint page_visibility_note_ok check (
  note is null
  or case jsonb_typeof(note)
       when 'object' then
         (note - array['en', 'ar']) = '{}'::jsonb
         and (note -> 'en' is not null or note -> 'ar' is not null)
         and (note -> 'en' is null
              or (jsonb_typeof(note -> 'en') = 'string'
                  and char_length(note ->> 'en') <= 140
                  and note ->> 'en' ~ '[^[:space:]]'
                  and note ->> 'en' !~ '[<>\u0001-\u001F\u007F-\u009F]'))
         and (note -> 'ar' is null
              or (jsonb_typeof(note -> 'ar') = 'string'
                  and char_length(note ->> 'ar') <= 140
                  and note ->> 'ar' ~ '[^[:space:]]'
                  and note ->> 'ar' !~ '[<>\u0001-\u001F\u007F-\u009F]'))
       else false
     end);

-- A page in password mode has had a password set at least once (set_page_password writes the
-- secret and the mode in one statement), so its version is never the default 0.
alter table public.page_visibility drop constraint if exists page_visibility_password_version_ok;
alter table public.page_visibility add constraint page_visibility_password_version_ok
  check (password_version >= 0 and (mode <> 'password' or password_version > 0));

-- ---- 2. The secret ----------------------------------------------------------------------
-- One bcrypt hash per page. RLS ENABLE + FORCE with NO policy and no grant to any API role:
-- anon, authenticated and the service role hold nothing here, not even SELECT, so the hash
-- cannot be reached at PostgREST by any token, and the definers below — owned by this file's
-- owner, which bypasses RLS — are the only code that touches it. Its composite key names a
-- page of its own tenant, whoever writes it (0057's pages_tenant_id_id), and the row goes
-- with the page.
create table if not exists public.page_passwords (
  tenant_id uuid not null default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  page_id uuid not null,
  -- bcrypt, cost 10: `$2a$10$` and 53 characters of the bcrypt alphabet. A shape check, not a
  -- strength one: it refuses a plaintext password written here by mistake.
  password_hash text not null constraint page_passwords_hash_bcrypt
    check (password_hash ~ '^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (tenant_id, page_id),
  constraint page_passwords_page_fk foreign key (tenant_id, page_id)
    references public.pages (tenant_id, id) on delete cascade
);
alter table public.page_passwords enable row level security;
alter table public.page_passwords force row level security;
revoke all on public.page_passwords from public, anon, authenticated, service_role;
comment on table public.page_passwords is
  'One bcrypt hash per page behind a password (Admin v2 U14b, 0061). No policy and no grant '
  'to any API role: set_page_password writes it, page_password_check reads it, nothing '
  'returns it. A page is never in password mode without a row here (app.tg_page_password_sync).';

-- ---- 3. A page is never in password mode without a password ------------------------------
-- BEFORE INSERT OR UPDATE on page_visibility, for every writer: the migration role, a staff
-- token, the service role and a release apply alike. Entering password mode needs the secret
-- to be there already (set_page_password writes it first, in the same transaction); leaving
-- it deletes the secret, clears the message and moves the version, so no cookie minted under
-- it can outlive the mode. SECURITY DEFINER because page_passwords is readable by nobody
-- else; it reads and writes that one table and no other.
--
-- Trigger order: PostgreSQL fires BEFORE triggers in name order, so page_visibility_actor,
-- then page_visibility_guard (0057: the homepage and the fixed target), then this one.
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
  elsif tg_op = 'UPDATE' and old.mode = 'password' then
    delete from public.page_passwords as pw
     where pw.tenant_id = old.tenant_id and pw.page_id = old.page_id;
    new.note := null;
    new.password_version := old.password_version + 1;
  end if;
  return new;
end $$;
revoke all on function app.tg_page_password_sync() from public, anon, authenticated, service_role;

drop trigger if exists page_visibility_password on public.page_visibility;
create trigger page_visibility_password before insert or update on public.page_visibility
  for each row execute function app.tg_page_password_sync();

-- ---- 4. The data fence --------------------------------------------------------------------
-- Is this page behind a password, for the tenant this request resolves to? STABLE and
-- SECURITY DEFINER because page_visibility is staff-only (0057, decision D3) and the fence
-- below has to ask the question for anon. It reads one row by the (tenant_id, page_id) unique
-- index and returns a boolean: it tells a visitor nothing it does not already know from being
-- asked for a password.
create or replace function app.page_is_password_locked(p_page_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.page_visibility v
                  where v.tenant_id = app.effective_tenant_id()
                    and v.page_id = p_page_id
                    and v.mode = 'password')
$$;
revoke all on function app.page_is_password_locked(uuid) from public, anon, authenticated, service_role;
grant execute on function app.page_is_password_locked(uuid) to anon, authenticated;

-- RESTRICTIVE, so it cuts what 0001's page_sections_read and 0011's
-- page_sections_published_only already allow. TO anon and authenticated, with staff passing
-- it, so the editors keep editing the page while any other signed-in token is fenced as
-- anon is: page_sections_read is TO public, and 0011's fence lets a non-staff token read
-- what anon reads, so a fifth role (the planned Sales role, which app.is_staff() leaves out
-- by design, P-6) would otherwise read a locked page's words. The tenant predicate first,
-- as every policy states it.
drop policy if exists page_sections_password_fence on public.page_sections;
create policy page_sections_password_fence on public.page_sections
  as restrictive for select to anon, authenticated
  using (tenant_id = app.effective_tenant_id()
         and (app.is_staff() or not app.page_is_password_locked(page_id)));

-- What a visitor who HAS typed the password reads: exactly the rows and columns anon would
-- have read without the fence (0001's tenant match, 0011's "visible section of a published
-- page"), and nothing else — no id, no style, no placeholder flag, no draft page. Service role
-- only: the Worker calls it for one request, inside the page-access scope
-- (src/lib/visibility/scope.ts), and only for the page that request unlocked.
create or replace function public.page_sections_unlocked(p_tenant uuid, p_page_id uuid)
returns table (type text, content jsonb, visible boolean, sort_order int)
  language sql stable security definer set search_path = '' as $$
  select s.type, s.content, s.visible, s.sort_order
    from public.page_sections s
    join public.pages p on p.tenant_id = s.tenant_id and p.id = s.page_id
   where s.tenant_id = p_tenant
     and s.page_id = p_page_id
     and s.visible
     and p.status = 'published'
   order by s.sort_order, s.id
$$;
revoke all on function public.page_sections_unlocked(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.page_sections_unlocked(uuid, uuid) to service_role;

-- The images those sections name. anon reads a media row only while something public
-- references it (0045's media_assets_public_read), and that policy's page_sections branch
-- runs under anon's own RLS, the fence included: a still used only by a locked page (About's
-- "who we are" poster, Our Work's intro frames) is anon-readable while the page is public
-- and gone once it is locked, unlocked visitor or not. This answers, for the page a request
-- unlocked, what that branch would answer were the page public: the rows among p_ids that a
-- VISIBLE section of that PUBLISHED page names by `mediaId` (0024's `$.**.mediaId` key), of a
-- provider the public may render, in PUBLIC_MEDIA_COLUMNS (packages/schemas/content.ts) and
-- nothing else. An id no such section names, a hidden section's, a draft page's and another
-- tenant's answer nothing. Service role only, called inside the page-access scope
-- (src/lib/data/sectionMedia.ts).
create or replace function public.page_media_unlocked(p_tenant uuid, p_page_id uuid, p_ids uuid[])
returns table (id uuid, kind text, provider text, storage_path text, width int, height int,
               alt jsonb, stream_uid text)
  language sql stable security definer set search_path = '' as $$
  select m.id, m.kind, m.provider, m.storage_path, m.width, m.height, m.alt, m.stream_uid
    from public.media_assets m
   where m.tenant_id = p_tenant
     and m.id = any (p_ids)
     and m.provider in ('static', 'cf_images', 'stream', 'storage')
     and exists (select 1
                   from public.page_sections s
                   join public.pages pg on pg.tenant_id = s.tenant_id and pg.id = s.page_id
                  where s.tenant_id = p_tenant
                    and s.page_id = p_page_id
                    and s.visible
                    and pg.status = 'published'
                    and jsonb_path_exists(s.content, 'lax $.**.mediaId ? (@ == $id)',
                                          jsonb_build_object('id', m.id::text)))
$$;
revoke all on function public.page_media_unlocked(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.page_media_unlocked(uuid, uuid, uuid[]) to service_role;

-- ---- 5. Setting a password ------------------------------------------------------------------
-- The one door. Admin and Developer (maintenance.manage), checked against the LIVE profile as
-- 0057's RESTRICTIVE policies do, so a demoted, deactivated or locked token sets nothing even
-- through the API directly. The secret and the mode are written in one transaction, so a page
-- is never in password mode without a password, and the audit row is written in the same one,
-- so a change whose audit row cannot be chained does not happen. The row it writes records the
-- mode, the new version and whether a message was set — never the password, never the message.
create or replace function public.set_page_password(
  p_tenant uuid, p_page_id uuid, p_password text, p_note jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_slug text;
  v_row public.page_visibility%rowtype;
begin
  if v_uid is null
     or p_tenant is null
     or p_tenant is distinct from app.effective_tenant_id()
     or not app.role_manages_visibility((select app.live_role())) then
    raise exception using errcode = '42501',
      message = 'set_page_password: the caller does not manage page visibility in this tenant';
  end if;
  select pg_catalog.lower(p.slug::text) into v_slug
    from public.pages p
   where p.tenant_id = p_tenant and p.id = p_page_id;
  if v_slug is null then
    raise exception using errcode = '22023',
      message = 'set_page_password: no such page in this tenant';
  end if;
  -- 0057's guard would refuse it too; this gives the admin the sentence it shows.
  if v_slug = 'home' then
    raise exception 'The homepage cannot be hidden. Use maintenance mode instead.'
      using errcode = '23514', constraint = 'page_visibility_home';
  end if;
  -- bcrypt reads at most 72 bytes, so a longer one would silently be its first 72.
  if p_password is null
     or pg_catalog.octet_length(p_password) < 8
     or pg_catalog.octet_length(p_password) > 72 then
    raise exception using errcode = '22023',
      message = 'set_page_password: a password is 8 to 72 bytes';
  end if;

  insert into public.page_passwords as t (tenant_id, page_id, password_hash, updated_by)
  values (p_tenant, p_page_id,
          extensions.crypt(p_password, extensions.gen_salt('bf', 10)), v_uid)
  on conflict (tenant_id, page_id) do update
    set password_hash = excluded.password_hash,
        updated_at = pg_catalog.now(),
        updated_by = excluded.updated_by;

  insert into public.page_visibility as v
    (tenant_id, page_id, mode, note, password_version, redirect_page_id, hide_from, show_on)
  values (p_tenant, p_page_id, 'password', p_note, 1, null, null, null)
  on conflict (tenant_id, page_id) do update
    set mode = 'password',
        note = excluded.note,
        password_version = v.password_version + 1,
        redirect_page_id = null,
        hide_from = null,
        show_on = null
  returning v.* into v_row;

  insert into public.audit_log
    (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, v_uid, app.current_role(), 'page_visibility.password_set', 'page',
          p_page_id::text,
          pg_catalog.jsonb_build_object('mode', 'password',
                                        'passwordVersion', v_row.password_version,
                                        'note', p_note is not null));

  return pg_catalog.jsonb_build_object('id', v_row.id,
                                       'version', v_row.version,
                                       'passwordVersion', v_row.password_version,
                                       'updatedAt', v_row.updated_at);
end $$;
revoke all on function public.set_page_password(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_page_password(uuid, uuid, text, jsonb) to authenticated;

-- ---- 6. Checking a password -------------------------------------------------------------
-- The service role alone: the Worker's unlock route, which has already checked the origin and
-- counted the attempt against a limiter that fails closed. Answers the page's current
-- password_version on a match — the Worker signs that number into the cookie, so a later
-- password change ends the session — and null on anything else, with no way to tell "wrong
-- password" from "no such page": crypt() always runs once, against the row's hash or, when
-- there is none, against a fixed dummy of the same cost.
create or replace function public.page_password_check(
  p_tenant uuid, p_page_id uuid, p_password text
) returns int
  language plpgsql volatile security definer set search_path = '' as $$
declare
  -- A syntactically valid bcrypt setting of the same cost, and not the hash of anything that
  -- is used: crypt() needs a well-formed setting, and only its cost and salt are read.
  v_dummy constant text :=
    '$2a$10$braiinPagePasswordDum.yQDIRnFpXwTBoCB3UzOcQ.PXa7WMFTe';
  v_hash text;
  v_pv int;
begin
  -- bcrypt would read only the first 72 bytes anyway; a huge body is refused before the hash.
  if p_password is null or pg_catalog.octet_length(p_password) > 1024 then
    return null;
  end if;
  select pw.password_hash, v.password_version into v_hash, v_pv
    from public.page_passwords pw
    join public.page_visibility v
      on v.tenant_id = pw.tenant_id and v.page_id = pw.page_id and v.mode = 'password'
   where pw.tenant_id = p_tenant and pw.page_id = p_page_id;
  -- COALESCE is a SQL construct, not a function, so it takes no pg_catalog. prefix (and
  -- needs none: nothing can shadow it).
  if extensions.crypt(p_password, coalesce(v_hash, v_dummy))
       = coalesce(v_hash, v_dummy)
     and v_hash is not null then
    return v_pv;
  end if;
  return null;
end $$;
revoke all on function public.page_password_check(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.page_password_check(uuid, uuid, text) to service_role;

-- ---- 7. The release registry ----------------------------------------------------------------
-- 0057's row, restated so `note` is a staged column and `password_version` an exempt one: a
-- release may carry the message above the box, never the secret or its version (P-3, a secret
-- is immediate). `do update`, so this row replaces 0057's; tests/fixtures/releaseRegistry.ts
-- folds the migrations in order and reads this shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('page_visibility', 'page_visibility', 'id', 'settings', '{admin,developer}', '{}',
   '{page_id,template,mode,redirect_page_id,hide_from,show_on,note}',
   '{}', '{}', '{password_version}', 85, false, null)
on conflict (entity_type) do update
  set table_name = excluded.table_name,
      key_column = excluded.key_column,
      area = excluded.area,
      author_roles = excluded.author_roles,
      delete_roles = excluded.delete_roles,
      columns = excluded.columns,
      deferred_columns = excluded.deferred_columns,
      unique_flags = excluded.unique_flags,
      exempt_columns = excluded.exempt_columns,
      apply_order = excluded.apply_order,
      has_status = excluded.has_status,
      publish_flag = excluded.publish_flag;

-- ---- 8. The guides --------------------------------------------------------------------------
-- The set as 0060 (U1) left it, with the page-visibility guide gaining its password
-- section (restated from 0057's and re-based onto 0060's when U1 merged first). A later
-- slice that changes a guide restates the set from this text (U16's rule);
-- scratchpad/hs_rebase.py re-bases a restatement onto a newer set.
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

-- Every tenant gets the rewritten guide (app.seed_help_articles inserts a guide a tenant
-- lacks and updates one only where it differs from the set; 0046).
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
-- app is not on the search path), so the patterns allow both.
do $$
declare
  -- Every table privilege the server knows. MAINTAIN exists from PostgreSQL 17 (production
  -- runs 17.6, CI 15), and the privilege functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  -- page_visibility's grants are 0057's and must still be exactly these: the two new columns
  -- are readable (the table-wide SELECT) and written by no API role.
  v_insert constant text[] := array['hide_from', 'id', 'mode', 'page_id', 'redirect_page_id',
                                    'show_on', 'template', 'tenant_id'];
  v_update constant text[] := array['hide_from', 'mode', 'redirect_page_id', 'show_on'];
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_have text[];
  v_cols text[];
  v_bad text;
  v_owner oid;
  v_set jsonb;
  p text;
begin
  -- ---- The definers' owner bypasses RLS. page_passwords has RLS FORCEd and no policy, so
  -- the three functions below read it only because their owner carries BYPASSRLS (or is a
  -- superuser). If that ever stops being true they would silently see zero rows, which would
  -- make every password check fail and every page in password mode unopenable.
  select proowner into v_owner from pg_proc
   where oid = 'public.page_password_check(uuid,uuid,text)'::regprocedure;
  if not exists (select 1 from pg_roles r
                  where r.oid = v_owner and (r.rolbypassrls or r.rolsuper)) then
    raise exception '0061: the definers are owned by %, which does not bypass RLS; page_passwords would read as empty',
      v_owner::regrole;
  end if;
  if (select count(distinct proowner) from pg_proc
       where oid in ('public.page_password_check(uuid,uuid,text)'::regprocedure,
                     'public.set_page_password(uuid,uuid,text,jsonb)'::regprocedure,
                     'public.page_sections_unlocked(uuid,uuid)'::regprocedure,
                     'app.page_is_password_locked(uuid)'::regprocedure,
                     'app.tg_page_password_sync()'::regprocedure)) <> 1 then
    raise exception '0061: the password functions are not all owned by one role';
  end if;
  -- pgcrypto, where 0012 found it.
  if to_regprocedure('extensions.crypt(text,text)') is null
     or to_regprocedure('extensions.gen_salt(text,integer)') is null then
    raise exception '0061: extensions.crypt / extensions.gen_salt (pgcrypto) not found';
  end if;

  -- ---- page_visibility: the four modes, and the table's rules by name.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.page_visibility'::regclass
                    and conname = 'page_visibility_mode_known'
                    and pg_get_constraintdef(oid) ~ '''hidden''' and pg_get_constraintdef(oid) ~ '''link'''
                    and pg_get_constraintdef(oid) ~ '''password''' and pg_get_constraintdef(oid) ~ '''public''') then
    raise exception '0061: page_visibility_mode_known does not admit public, hidden, link and password';
  end if;
  select coalesce(array_agg(conname::text order by conname), '{}') into v_have
    from pg_constraint
   where conrelid = 'public.page_visibility'::regclass and contype in ('c', 'u');
  if v_have is distinct from array['page_visibility_dates_hidden', 'page_visibility_dates_order',
                                   'page_visibility_mode_known', 'page_visibility_note_ok',
                                   'page_visibility_note_password', 'page_visibility_one_target',
                                   'page_visibility_page_unique',
                                   'page_visibility_password_version_ok',
                                   'page_visibility_redirect_hidden',
                                   'page_visibility_redirect_not_self',
                                   'page_visibility_template_known',
                                   'page_visibility_template_modes',
                                   'page_visibility_template_unique'] then
    raise exception '0061: page_visibility CHECK and UNIQUE constraints are %', v_have;
  end if;
  -- The two new columns, their types and their default.
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.page_visibility'::regclass and a.attname = 'note'
                    and a.atttypid = 'jsonb'::regtype and not a.attnotnull and not a.attisdropped)
     or not exists (select 1 from pg_attribute a
                     where a.attrelid = 'public.page_visibility'::regclass
                       and a.attname = 'password_version' and a.atttypid = 'int4'::regtype
                       and a.attnotnull and not a.attisdropped) then
    raise exception '0061: page_visibility.note (jsonb, nullable) and page_visibility.password_version (int not null) are not as stated';
  end if;
  -- The note's rule, as a value: the shapes it takes and the ones it refuses.
  if not ('{"en":"Ask the studio for the password."}'::jsonb -> 'en' is not null
          and (('{"en":"a","ar":"ب"}'::jsonb - array['en', 'ar']) = '{}'::jsonb)
          and (('{"en":"a","x":"b"}'::jsonb - array['en', 'ar']) <> '{}'::jsonb)) then
    raise exception '0061: the jsonb operators the note CHECK is built on do not behave as expected';
  end if;

  -- ---- page_visibility's grants are untouched: the two new columns are readable through
  -- the table-wide SELECT and writable by no API role (set_page_password is the only writer).
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.page_visibility'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.page_visibility', a.attname::text, 'insert');
  if v_cols is distinct from v_insert then
    raise exception '0061: authenticated inserts columns % (expected exactly %)', v_cols, v_insert;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_cols
    from pg_attribute a
   where a.attrelid = 'public.page_visibility'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.page_visibility', a.attname::text, 'update');
  if v_cols is distinct from v_update then
    raise exception '0061: authenticated updates columns % (expected exactly %)', v_cols, v_update;
  end if;
  foreach p in array array['public', 'anon'] loop
    if has_any_column_privilege(p::name, 'public.page_visibility',
                                'select, insert, update, references') then
      raise exception '0061: % holds a column privilege on page_visibility', p;
    end if;
  end loop;

  -- ---- page_passwords: RLS forced, NO policy, and not one privilege for any API role,
  -- table-wide or per column, under either grant regime.
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.page_passwords'::regclass) then
    raise exception '0061: page_passwords is not ENABLE + FORCE row level security';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'page_passwords') then
    raise exception '0061: page_passwords has a policy; it must have none';
  end if;
  select string_agg(format('%s %s', g.who, g.priv), ', ' order by g.who, g.priv) into v_bad
    from (select x.who, pr.priv
            from unnest(array['public', 'anon', 'authenticated', 'service_role']) as x(who)
            cross join unnest(v_privs) as pr(priv)
           where has_table_privilege(x.who::name, 'public.page_passwords', pr.priv)) g;
  if v_bad is not null then
    raise exception '0061: an API role holds a privilege on page_passwords: %', v_bad;
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_any_column_privilege(p::name, 'public.page_passwords',
                                'select, insert, update, references') then
      raise exception '0061: % holds a column privilege on page_passwords', p;
    end if;
  end loop;
  if exists (select 1 from pg_class c
             cross join lateral aclexplode(c.relacl) a
              where c.oid = 'public.page_passwords'::regclass and a.grantee <> c.relowner) then
    raise exception '0061: page_passwords is granted to a role other than its owner';
  end if;
  -- Its key names a page of its own tenant, and the row goes with the page.
  if not exists (select 1 from pg_constraint f
                  join pg_constraint k on k.conrelid = 'public.pages'::regclass
                                      and k.conname = 'pages_tenant_id_id' and k.conindid = f.conindid
                 where f.conrelid = 'public.page_passwords'::regclass
                   and f.conname = 'page_passwords_page_fk' and f.contype = 'f'
                   and pg_get_constraintdef(f.oid) ~
                       '^FOREIGN KEY \(tenant_id, page_id\) REFERENCES (public\.)?pages\(tenant_id, id\) ON DELETE CASCADE$') then
    raise exception '0061: page_passwords_page_fk does not rest on pages_tenant_id_id with ON DELETE CASCADE';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.page_passwords'::regclass and contype = 'p'
                    and pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id, page_id)') then
    raise exception '0061: page_passwords is not keyed on (tenant_id, page_id)';
  end if;

  -- ---- The page_sections fence: exactly one new policy, RESTRICTIVE, FOR SELECT, TO anon
  -- and authenticated, the tenant predicate first, staff through, and 0011's published-parent
  -- fence still beside it.
  select coalesce(array_agg(e order by e), '{}') into v_have
    from (select format('%s %s %s %s', policyname, cmd, permissive, roles) as e
            from pg_policies
           where schemaname = 'public' and tablename = 'page_sections') s;
  if v_have is distinct from array['page_sections_delete_admin DELETE RESTRICTIVE {public}',
                                   'page_sections_password_fence SELECT RESTRICTIVE {anon,authenticated}',
                                   'page_sections_published_only SELECT RESTRICTIVE {public}',
                                   'page_sections_read SELECT PERMISSIVE {public}',
                                   'page_sections_write ALL PERMISSIVE {public}'] then
    raise exception '0061: page_sections policies are %', v_have;
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'page_sections'
                    and policyname = 'page_sections_password_fence'
                    and qual ~ ('^\(' || v_tenant || ' AND \((app\.)?is_staff\(\) OR \(NOT (app\.)?page_is_password_locked\(page_id\)\)\)\)$')
                    and with_check is null) then
    raise exception '0061: page_sections_password_fence is not "the tenant, then staff or not locked"';
  end if;
  -- anon still reads page_sections (0016) and still writes nothing.
  if not has_table_privilege('anon', 'public.page_sections', 'select')
     or has_table_privilege('anon', 'public.page_sections', 'insert')
     or has_table_privilege('anon', 'public.page_sections', 'update')
     or has_table_privilege('anon', 'public.page_sections', 'delete') then
    raise exception '0061: anon''s privileges on page_sections are not read-only';
  end if;

  -- ---- The functions: what each is, and who may call it.
  if not exists (select 1 from pg_proc
                  where oid = 'app.page_is_password_locked(uuid)'::regprocedure
                    and prosecdef and provolatile = 's'
                    and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                 where c in ('search_path=""', 'search_path='))) then
    raise exception '0061: app.page_is_password_locked must be a STABLE SECURITY DEFINER with an empty search_path';
  end if;
  if not has_function_privilege('anon', 'app.page_is_password_locked(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'app.page_is_password_locked(uuid)', 'execute')
     or has_function_privilege('service_role', 'app.page_is_password_locked(uuid)', 'execute')
     or has_function_privilege('public', 'app.page_is_password_locked(uuid)', 'execute') then
    raise exception '0061: app.page_is_password_locked must be executable by anon and authenticated only';
  end if;
  select string_agg(format('%s %s', f.fn, who.r), ', ' order by f.fn, who.r) into v_bad
    from (values
      -- the function, and the ONE API role that may call it
      ('public.set_page_password(uuid,uuid,text,jsonb)', 'authenticated'),
      ('public.page_password_check(uuid,uuid,text)', 'service_role'),
      ('public.page_sections_unlocked(uuid,uuid)', 'service_role'),
      ('public.page_media_unlocked(uuid,uuid,uuid[])', 'service_role')) as f(fn, allowed)
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as who(r)
   where has_function_privilege(who.r, f.fn::regprocedure, 'execute') <> (who.r = f.allowed);
  if v_bad is not null then
    raise exception '0061: the password functions'' EXECUTE grants are wrong (function role): %', v_bad;
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.tg_page_password_sync()', 'execute') then
      raise exception '0061: % may execute app.tg_page_password_sync()', p;
    end if;
  end loop;
  if exists (select 1 from pg_proc
              where oid in ('public.set_page_password(uuid,uuid,text,jsonb)'::regprocedure,
                            'public.page_password_check(uuid,uuid,text)'::regprocedure,
                            'public.page_sections_unlocked(uuid,uuid)'::regprocedure,
                            'public.page_media_unlocked(uuid,uuid,uuid[])'::regprocedure,
                            'app.tg_page_password_sync()'::regprocedure,
                            'app.page_is_password_locked(uuid)'::regprocedure)
                and not (prosecdef
                         and exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) c
                                      where c in ('search_path=""', 'search_path=')))) then
    raise exception '0061: every password function must be SECURITY DEFINER with an empty search_path';
  end if;
  -- Nothing returns the hash: page_sections_unlocked answers the four section columns,
  -- page_media_unlocked PUBLIC_MEDIA_COLUMNS, and the other two a jsonb summary and an int.
  if (select pg_get_function_result('public.page_sections_unlocked(uuid,uuid)'::regprocedure))
       <> 'TABLE(type text, content jsonb, visible boolean, sort_order integer)'
     or (select pg_get_function_result('public.page_media_unlocked(uuid,uuid,uuid[])'::regprocedure))
       <> 'TABLE(id uuid, kind text, provider text, storage_path text, width integer, height integer, alt jsonb, stream_uid text)'
     or (select provolatile from pg_proc
          where oid = 'public.page_media_unlocked(uuid,uuid,uuid[])'::regprocedure) <> 's'
     or (select pg_get_function_result('public.page_password_check(uuid,uuid,text)'::regprocedure)) <> 'integer'
     or (select pg_get_function_result('public.set_page_password(uuid,uuid,text,jsonb)'::regprocedure)) <> 'jsonb' then
    raise exception '0061: a password function returns something other than its stated shape';
  end if;
  -- The only two functions whose text names the hash column at all.
  select string_agg(f.oid::regprocedure::text, ', ' order by f.oid::regprocedure::text) into v_bad
    from pg_proc f
   where f.prosrc ~ 'password_hash'
     and f.oid not in ('public.page_password_check(uuid,uuid,text)'::regprocedure,
                       'public.set_page_password(uuid,uuid,text,jsonb)'::regprocedure)
     and f.pronamespace in ('public'::regnamespace, 'app'::regnamespace);
  if v_bad is not null then
    raise exception '0061: % names page_passwords.password_hash; only the setter and the checker may', v_bad;
  end if;

  -- ---- The trigger set on page_visibility: 0057's six and this one, by name, timing and
  -- function (tgtype: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16).
  select coalesce(array_agg(t.tgname::text order by t.tgname collate "C"), '{}') into v_have
    from pg_trigger t
   where t.tgrelid = 'public.page_visibility'::regclass and not t.tgisinternal;
  if v_have is distinct from array['page_visibility_actor', 'page_visibility_guard',
                                   'page_visibility_password', 'page_visibility_release_capture',
                                   'page_visibility_snapshot', 'page_visibility_updated_at',
                                   'page_visibility_version'] then
    raise exception '0061: page_visibility triggers are %', v_have;
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.page_visibility'::regclass and t.tgname = 'page_visibility_password'
         and t.tgtype = 23 and t.tgnargs = 0 and t.tgenabled::text = 'O' and t.tgqual is null
         and t.tgfoid = 'app.tg_page_password_sync()'::regprocedure) <> 1 then
    raise exception '0061: page_visibility_password must be BEFORE INSERT OR UPDATE, for each row, enabled, with no WHEN';
  end if;
  -- It sorts after the guard, so the homepage is refused before a secret is ever looked for.
  if not ('page_visibility_guard' < 'page_visibility_password' collate "C") then
    raise exception '0061: page_visibility_password would fire before page_visibility_guard';
  end if;

  -- ---- The registry row: the note staged, the version exempt, everything else 0057's.
  if not exists (
       select 1 from app.release_entities e
        where e.entity_type = 'page_visibility' and e.table_name = 'page_visibility'
          and e.key_column = 'id' and e.area = 'settings'
          and e.author_roles = array['admin', 'developer'] and e.delete_roles = '{}'::text[]
          and e.columns = array['page_id', 'template', 'mode', 'redirect_page_id', 'hide_from',
                                'show_on', 'note']
          and e.deferred_columns = '{}'::text[] and e.unique_flags = '{}'::text[]
          and e.exempt_columns = array['password_version'] and e.apply_order = 85
          and not e.has_status and e.publish_flag is null) then
    raise exception '0061: the page_visibility registry row is not as stated';
  end if;
  if exists (select 1 from app.release_entities e where e.table_name = 'page_passwords') then
    raise exception '0061: page_passwords must not be in the release registry (a secret is immediate)';
  end if;

  -- ---- The guides: the set parses, no API role reads it, and every tenant holds the
  -- page-visibility guide with its password section.
  v_set := app.help_article_set();
  if jsonb_typeof(v_set) <> 'array'
     or not exists (select 1 from jsonb_array_elements(v_set) a
                     where a ->> 'slug' = 'page-visibility'
                       and a -> 'caps' = '["maintenance.manage"]'::jsonb
                       and a -> 'screens' = '["/admin/visibility"]'::jsonb
                       and a -> 'body' ->> 'en' like '%Behind a password%') then
    raise exception '0061: app.help_article_set() does not hold the page-visibility guide with its password section';
  end if;
  foreach p in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(p, 'app.help_article_set()', 'execute') then
      raise exception '0061: % may execute app.help_article_set()', p;
    end if;
  end loop;
  if exists (select 1 from public.tenants t
              where not exists (
                select 1 from public.help_articles h
                  join jsonb_to_recordset(v_set) as a (slug text, body jsonb)
                    on a.slug = h.slug
                 where h.tenant_id = t.id and h.slug = 'page-visibility'
                   and h.body = a.body)) then
    raise exception '0061: a tenant does not hold the page-visibility guide as the set states it';
  end if;

  -- ---- Nothing was seeded: no row is still public, and no page has a password yet.
  if (select count(*) from public.page_passwords) <> 0 then
    raise exception '0061: page_passwords is not empty after the migration';
  end if;
  if (select count(*) from public.page_visibility where mode = 'password') <> 0 then
    raise exception '0061: a page is already in password mode after the migration';
  end if;
end $$;
