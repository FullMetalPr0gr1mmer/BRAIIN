-- ─────────────────────────────────────────────────────────────────────────────────────────
-- E5 — The site's appearance settings: public.site_appearance (Admin v2 E5, the header).
-- Forward-only and EXPAND only: one new table (a staged per-tenant singleton), one new
-- capability helper, its release-registry row and the header's help guide. Nothing that
-- exists narrows. The number is a placeholder: numbers are assigned at the merge train
-- (docs/admin-v2/migrations.md, scripts/renumber-migration.mjs).
-- Depends on 0001 (tenants, app.current_role, app.tg_set_updated_at), 0009 (app.tg_bump_version,
-- app.tg_set_actor), 0033 (app.live_role), 0038 (the release registry,
-- app.tg_snapshot_singleton), 0051 (app.tg_release_capture), 0066 (app.tg_release_guard),
-- 0069 (H11: app.put_help_guide), 0097 (C10a: the non-staff block this table joins) and 0098
-- (app.faq_text_ok, the bilingual plain-text shape the CTA label reuses).
--
-- The design is docs/admin-v2/README.md (the E5 row; P-2: theme and header/intro publish under
-- theme.edit; P-3: site_appearance is staged; P-9: header and intro settings on this row under
-- theme.edit, footer settings on site_profile under settings.general), ui.md "### Header" and
-- "### AV-28" (whose site_chrome is this table, plan decision 15), deviations.md "Header" and
-- the TDD rows §6.1 header; what was built and every departure is
-- docs/admin-v2/as-built/E5.md.
--
--   1. app.role_edits_theme(r): the one helper for theme.edit (Admin, Developer), held equal to
--      ROLE_CAPS by tests/authz/sqlHelpers.spec.ts.
--   2. public.site_appearance: one row per tenant (key tenant_id, created on the first save, as
--      seo_defaults and form_settings), one typed column per header option, each a closed set
--      (the Worker's Zod, packages/schemas/appearance.ts, is the other layer). The defaults are
--      the header as built, so no row and a default row render the same bytes. E7 (the loading
--      screen) adds its intro_ columns to THIS row (AV-28: no second table).
--   3. RLS, ENABLE + FORCE, the tenant predicate FIRST in every USING and WITH CHECK: everyone
--      reads the tenant's row (the public header renders it); a signed-in token that is not CMS
--      staff reads none (0097's non-staff block); Admin and Developer insert and update by the
--      token's role and, RESTRICTIVE, by the live profile (app.live_role()), as 0102 holds
--      site_profile; nobody deletes (no policy, no grant).
--   4. Grants, stated for both Supabase grant regimes (P-14): anon SELECTs tenant_id and the
--      twelve option columns (never the version, the stamps or the actors); authenticated
--      SELECT, INSERT, UPDATE; the service role SELECT, INSERT, UPDATE, DELETE; no TRUNCATE,
--      REFERENCES, TRIGGER or MAINTAIN for anyone.
--   5. Triggers, BEFORE ones in the order their names sort: the release guard
--      (`site_appearance__release_guard`, first), the actor, updated_at and the version; AFTER:
--      the history snapshot (app.tg_snapshot_singleton('site_appearance')) and the release
--      capture (keyed by tenant_id).
--   6. The release registry row (registry contract #4): staged once releases switch on (P-3);
--      authors Admin and Developer (theme.edit), never removed by a release.
--   7. The header's help guide, header-and-menu (H11's put, revision 0).
--
-- No ROLE_CAPS or §5 change: theme.edit exists (Admin, Developer). No content is seeded: no row
-- is the header as built.
--
-- CLAUDE.md §3 (Pillar 1, Pillar 2: the header stays Tier A and zero-JS), §8 (Admin v2 lanes),
-- §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. The capability helper ═══════════════════════════════════════════════════════════════
create or replace function app.role_edits_theme(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- theme.edit
revoke all on function app.role_edits_theme(text) from public, anon, authenticated, service_role;
grant execute on function app.role_edits_theme(text) to authenticated, service_role;

-- ═══ 2. The table ═════════════════════════════════════════════════════════════════════════
-- The defaults are the header as built: the logo at the start, medium; the links mid-bar
-- (today's space-between); sticky, hidden while scrolling down, solid after the hero; no tint
-- over the hero; the solid state's 14 px blur ('soft'); the small-screen menu as a panel under
-- the bar ('drawer'); no call-to-action button.
create table if not exists public.site_appearance (
  tenant_id uuid primary key default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  header_logo_position text not null default 'start',
  header_logo_size text not null default 'm',
  header_menu_align text not null default 'center',
  header_sticky boolean not null default true,
  header_hide_on_scroll boolean not null default true,
  header_solid_after_hero boolean not null default true,
  header_tint text not null default 'none',
  header_blur text not null default 'soft',
  header_mobile_menu text not null default 'drawer',
  header_cta_show boolean not null default false,
  header_cta_label jsonb,
  header_cta_href text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint site_appearance_logo_position check (header_logo_position in ('start', 'center')),
  constraint site_appearance_logo_size check (header_logo_size in ('s', 'm', 'l')),
  constraint site_appearance_menu_align check (header_menu_align in ('start', 'center', 'end')),
  constraint site_appearance_tint check (header_tint in ('none', 'light', 'medium', 'dark')),
  constraint site_appearance_blur check (header_blur in ('none', 'soft', 'strong')),
  constraint site_appearance_mobile_menu check (header_mobile_menu in ('drawer', 'full')),
  -- {"en": …, "ar": …}, each 1 to 40 characters, trimmed, no control character (0098's shape).
  constraint site_appearance_cta_label check (
    header_cta_label is null or app.faq_text_ok(header_cta_label, 40)),
  -- A path on this site ("/contact#inquiry": never "//", never a backslash) or an https link;
  -- no space, quote or angle bracket. Never the Arabic prefix: an Arabic page adds "/ar" to a
  -- site path itself (localizedHref), so "/ar/…" would render "/ar/ar/…". The Worker also runs
  -- the nav's scheme allowlist.
  constraint site_appearance_cta_href check (
    header_cta_href is null
    or (char_length(header_cta_href) <= 300
        and header_cta_href ~ '^(/([^/\\[:space:]<>"''][^\\[:space:]<>"'']*)?|https://[^/\\[:space:]<>"''][^\\[:space:]<>"'']*)$'
        and header_cta_href !~ '^/ar([/?#]|$)')),
  -- A button that shows has words and a destination.
  constraint site_appearance_cta_complete check (
    not header_cta_show or (header_cta_label is not null and header_cta_href is not null)),
  -- The tint's minimum: a bar that stays on screen and does not turn solid after the hero keeps
  -- its white links over the page's light sections, so it takes the darkest tint (black at 62%,
  -- the solid state's own; white text over white needs at least 54% for 4.5:1).
  constraint site_appearance_tint_minimum check (
    not header_sticky or header_solid_after_hero or header_tint = 'dark')
);
alter table public.site_appearance enable row level security;
alter table public.site_appearance force row level security;
comment on table public.site_appearance is
  'The site''s appearance settings (Admin v2 E5, P-9: theme.edit): per tenant, the header''s '
  'bucketed options (header_*); the loading screen''s (intro_*) join this row in E7. Read by '
  'the public header (src/lib/data/appearance.ts); every option defaults to the header as built.';

-- ═══ 3. Row security (the fence before any grant) ═════════════════════════════════════════
drop policy if exists site_appearance_read on public.site_appearance;
create policy site_appearance_read on public.site_appearance for select
  using (tenant_id = app.effective_tenant_id());
-- The non-staff block (0097 §4, Admin v2 C10a): a signed-in token that is not CMS staff reads
-- no more than anon outside the CRM, and a GRANT cannot tell the app roles apart. RESTRICTIVE,
-- FOR SELECT, TO authenticated, the tenant predicate first, then app.is_staff(). anon is not
-- named: anon reads its columns through site_appearance_read.
drop policy if exists site_appearance_staff_columns on public.site_appearance;
create policy site_appearance_staff_columns on public.site_appearance
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
drop policy if exists site_appearance_insert on public.site_appearance;
create policy site_appearance_insert on public.site_appearance for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_theme(app.current_role()));
drop policy if exists site_appearance_update on public.site_appearance;
create policy site_appearance_update on public.site_appearance for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_edits_theme(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_theme(app.current_role()));
-- The live check (as 0102 for site_profile): the profile, read now, must still hold theme.edit,
-- so a demoted, deactivated or locked token writes nothing.
drop policy if exists site_appearance_live_insert on public.site_appearance;
create policy site_appearance_live_insert on public.site_appearance as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_theme((select app.live_role())));
drop policy if exists site_appearance_live_update on public.site_appearance;
create policy site_appearance_live_update on public.site_appearance as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_edits_theme((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_theme((select app.live_role())));

-- ═══ 4. Grants (stated, never inherited: both grant regimes) ══════════════════════════════
-- Readers and writers: anon reads the options (every public page's header, the preview's
-- dataset); staff read the row and Admin and Developer write it (the Header screen, through the
-- singleton kernel); the service role reads, inserts, updates and deletes it (apply_release's
-- conflict lock, the seeds, R17's restore, the e2e reset). Never TRUNCATE (it fires no row
-- trigger: neither the guard nor the capture would see it, 0066).
revoke all on public.site_appearance from public, anon, authenticated, service_role;
grant select (tenant_id, header_logo_position, header_logo_size, header_menu_align, header_sticky,
              header_hide_on_scroll, header_solid_after_hero, header_tint, header_blur,
              header_mobile_menu, header_cta_show, header_cta_label, header_cta_href)
  on public.site_appearance to anon;
grant select, insert, update on public.site_appearance to authenticated;
grant select, insert, update, delete on public.site_appearance to service_role;

-- ═══ 5. Triggers ══════════════════════════════════════════════════════════════════════════
-- BEFORE row triggers fire in name order: the guard (its double underscore sorts first)
-- refuses before any other BEFORE trigger's work runs, as 0066 gives every registry table.
drop trigger if exists site_appearance__release_guard on public.site_appearance;
create trigger site_appearance__release_guard before insert or update or delete on public.site_appearance
  for each row execute function app.tg_release_guard();
drop trigger if exists site_appearance_actor on public.site_appearance;
create trigger site_appearance_actor before insert or update on public.site_appearance
  for each row execute function app.tg_set_actor();
drop trigger if exists site_appearance_updated_at on public.site_appearance;
create trigger site_appearance_updated_at before update on public.site_appearance
  for each row execute function app.tg_set_updated_at();
drop trigger if exists site_appearance_version on public.site_appearance;
create trigger site_appearance_version before update on public.site_appearance
  for each row execute function app.tg_bump_version();
-- History, keyed by the tenant (a singleton, 0038).
drop trigger if exists site_appearance_snapshot on public.site_appearance;
create trigger site_appearance_snapshot after insert or update on public.site_appearance
  for each row execute function app.tg_snapshot_singleton('site_appearance');
-- What a release changes (0051), built as 0051's loop builds it: the generated columns read
-- from the catalog (none), keyed by tenant_id.
do $$
declare
  v_generated text;
begin
  select coalesce(string_agg(a.attname::text, ',' order by a.attnum), '') into v_generated
    from pg_attribute a
   where a.attrelid = 'public.site_appearance'::regclass
     and a.attnum > 0 and not a.attisdropped and a.attgenerated = 's';
  execute 'drop trigger if exists site_appearance_release_capture on public.site_appearance';
  execute format('create trigger site_appearance_release_capture after insert or update or delete '
                 'on public.site_appearance for each row execute function '
                 'app.tg_release_capture(%L, %L, %L)', 'site_appearance', 'tenant_id', v_generated);
end $$;

-- ═══ 6. The release registry ════════════════════════════════════════════════════════════
-- Registry contract #4 (releases.md §1.3): staged once releases switch on (P-3). Authors are
-- the holders of theme.edit (P-2); never removed by a release. E7 restates this row with its
-- intro_ columns appended. One row per line group, parsed by tests/fixtures/releaseRegistry.ts:
-- keep the shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('site_appearance', 'site_appearance', 'tenant_id', 'appearance', '{admin,developer}', '{}',
   '{header_logo_position,header_logo_size,header_menu_align,header_sticky,header_hide_on_scroll,header_solid_after_hero,header_tint,header_blur,header_mobile_menu,header_cta_show,header_cta_label,header_cta_href}',
   '{}', '{}', '{}', 110, false, null)
on conflict (entity_type) do nothing;

-- ═══ 7. The help guide ═══════════════════════════════════════════════════════════════════
-- A NEW guide, so revision 0 (H11, 0069: one top-level put, held to help_articles' CHECKs,
-- re-seeding this one slug into every tenant and touching no other guide). sort_order 43, a
-- free place after editing-pages (41) and its neighbour (42). For the roles that open the
-- Header screen: theme.edit (the options: Admin, Developer) and nav.edit (the menu: Admin,
-- Content Creator), so Admin, Content Creator and Developer read it (the Worker's filter from
-- ROLE_CAPS). Its one screen is /admin/appearance/header; PAGE_GUIDES
-- (src/lib/admin/help/pageGuides.ts) offers it there. tests/lib/helpCentre.spec.ts reads this
-- statement (tests/fixtures/helpSet.ts) and holds the copy to the words the screen uses.
select app.put_help_guide($guide$
{
  "slug": "header-and-menu",
  "sort_order": 43,
  "minutes": 2,
  "tags": ["site"],
  "screens": ["/admin/appearance/header"],
  "caps": ["nav.edit", "theme.edit"],
  "title": "The header and its menu",
  "title_ar": "الشريط العلوي وقائمته",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Appearance › Header holds the bar at the top of every page: its menu links, and how it looks and behaves. Each card is for the people who look after that part, so you may see only one of them."
      },
      { "t": "h", "x": "Menu items" },
      {
        "t": "p",
        "x": "The links in the order the site shows them. Move up and Move down change the order, the eye hides a link or shows it again, and the star marks the key link, the one that stays in the bar on phones. There is one key link at a time. To change a link's words or address, add a link or remove one, use Edit or Add a link, which open the Menus screen."
      },
      { "t": "h", "x": "Layout and behaviour" },
      {
        "t": "p",
        "x": "Choose where the logo sits and how big it is, where the links sit, whether the bar stays at the top, hides while scrolling down, turns solid after the hero, how dark its tint is over the hero and what the menu looks like on phones. The two small sketches follow your choices before you save."
      },
      {
        "t": "p",
        "x": "A bar that stays see-through after the hero needs the darkest tint, so its links stay readable over the light parts of the page. The English and Arabic switch always shows."
      },
      { "t": "h", "x": "The button" },
      {
        "t": "p",
        "x": "Show a button lets you add one filled button at the end of the bar, and at the end of the menu on phones. Give it words in both languages and a link: a page of this site starting with /, or a link starting with https://."
      },
      {
        "t": "tip",
        "x": "The header is on every page, so a saved change shows on the whole site. History lists every saved version of these settings."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تضم Appearance › Header الشريط الظاهر أعلى كل صفحة: روابط قائمته، وشكله وسلوكه. كل بطاقة مخصّصة لمن يتولّى ذلك الجزء، فقد لا ترى إلا إحداها."
      },
      { "t": "h", "x": "عناصر القائمة" },
      {
        "t": "p",
        "x": "الروابط بالترتيب الذي يعرضها به الموقع. يغيّر Move up وMove down الترتيب، وتُخفي العين الرابط أو تُظهره من جديد، وتحدّد النجمة الرابط الرئيسي، وهو الذي يبقى في الشريط على الهواتف. لا يكون إلا رابط رئيسي واحد في كل مرة. لتغيير نص الرابط أو عنوانه، أو لإضافة رابط أو حذفه، استخدم Edit أو Add a link، فهما يفتحان شاشة Menus."
      },
      { "t": "h", "x": "التخطيط والسلوك" },
      {
        "t": "p",
        "x": "اختر موضع الشعار وحجمه، وموضع الروابط، وهل يبقى الشريط في الأعلى، وهل يختفي عند التمرير إلى الأسفل، وهل يصبح معتمًا بعد الواجهة، ومدى قتامة لونه فوق الواجهة، وشكل القائمة على الهواتف. يتبع الرسمان الصغيران اختياراتك قبل الحفظ."
      },
      {
        "t": "p",
        "x": "الشريط الذي يبقى شفافًا بعد الواجهة يحتاج إلى أغمق درجة، حتى تبقى روابطه مقروءة فوق الأجزاء الفاتحة من الصفحة. ويظهر مفتاح التبديل بين الإنجليزية والعربية دائمًا."
      },
      { "t": "h", "x": "الزر" },
      {
        "t": "p",
        "x": "يتيح لك Show a button إضافة زر واحد ملوّن في نهاية الشريط، وفي نهاية القائمة على الهواتف. اكتب نصه باللغتين وحدّد رابطه: صفحة من هذا الموقع تبدأ بـ /، أو رابطًا يبدأ بـ https://."
      },
      {
        "t": "tip",
        "x": "الشريط العلوي موجود في كل صفحة، لذا يظهر أي تغيير محفوظ في الموقع كله. ويعرض History كل نسخة محفوظة من هذه الإعدادات."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them.
do $$
declare
  v_bad text;
  v_want text[];
  v_got text[];
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  v_options constant text[] := array['header_blur', 'header_cta_href', 'header_cta_label',
    'header_cta_show', 'header_hide_on_scroll', 'header_logo_position', 'header_logo_size',
    'header_menu_align', 'header_mobile_menu', 'header_solid_after_hero', 'header_sticky',
    'header_tint'];
  r text;
  pr text;
begin
  -- ---- 1. RLS enabled and forced --------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.site_appearance'::regclass) then
    raise exception 'E5: public.site_appearance is not ENABLE + FORCE row level security';
  end if;

  -- ---- 2. The exact policy set ----------------------------------------------------------
  v_want := array[
    'site_appearance_insert INSERT PERMISSIVE {authenticated}',
    'site_appearance_live_insert INSERT RESTRICTIVE {authenticated}',
    'site_appearance_live_update UPDATE RESTRICTIVE {authenticated}',
    'site_appearance_read SELECT PERMISSIVE {public}',
    'site_appearance_staff_columns SELECT RESTRICTIVE {authenticated}',
    'site_appearance_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles) order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'site_appearance';
  if v_got is distinct from v_want then
    raise exception 'E5: site_appearance policies are %, expected %', v_got, v_want;
  end if;

  -- ---- 3. The tenant predicate is the first conjunct of every USING and WITH CHECK -------
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'site_appearance'
     and ((qual is not null and qual !~ v_tenant_first)
          or (with_check is not null and with_check !~ v_tenant_first)
          or coalesce(qual, with_check) is null);
  if v_bad is not null then
    raise exception 'E5: site_appearance policies that do not lead with the tenant predicate: %', v_bad;
  end if;
  -- The read is the tenant fence alone, and the non-staff block is (tenant, is_staff).
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'site_appearance'
        and policyname = 'site_appearance_read') !~ ('^' || v_tenant || '$')
     or (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'site_appearance'
            and policyname = 'site_appearance_staff_columns' and with_check is null
            and qual ~ ('^\(' || v_tenant || ' AND (app\.)?is_staff\(\)\)$')) <> 1 then
    raise exception 'E5: site_appearance_read or site_appearance_staff_columns is not as written';
  end if;
  -- Every write policy names theme.edit's helper; the live ones read the live role.
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'site_appearance' and cmd in ('INSERT', 'UPDATE')
     and (coalesce(with_check, '') !~ 'role_edits_theme'
          or (cmd = 'UPDATE' and coalesce(qual, '') !~ 'role_edits_theme')
          or (policyname like '%live%' and with_check !~ 'live_role\(\)')
          -- current_role is a keyword: the catalog prints it quoted.
          or (policyname not like '%live%' and with_check !~ 'current_role"?\(\)'));
  if v_bad is not null then
    raise exception 'E5: site_appearance write policies that do not check theme.edit as written: %', v_bad;
  end if;

  -- ---- 4. The helper: theme.edit's holders, executable by the two roles that write -------
  if not app.role_edits_theme('admin') or not app.role_edits_theme('developer')
     or app.role_edits_theme('content_creator') or app.role_edits_theme('seo')
     or app.role_edits_theme('sales') or app.role_edits_theme(null) then
    raise exception 'E5: app.role_edits_theme does not answer exactly Admin and Developer';
  end if;
  if not has_function_privilege('authenticated', 'app.role_edits_theme(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_edits_theme(text)', 'execute')
     or has_function_privilege('anon', 'app.role_edits_theme(text)', 'execute')
     or has_function_privilege('public', 'app.role_edits_theme(text)', 'execute') then
    raise exception 'E5: app.role_edits_theme must be executable by authenticated and service_role only';
  end if;

  -- ---- 5. Privileges, exactly ---------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.site_appearance',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.site_appearance', 'maintain')
                else false end) then
      raise exception 'E5: % holds a table privilege on public.site_appearance', r;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update'] loop
    if not has_table_privilege('authenticated', 'public.site_appearance', pr) then
      raise exception 'E5: authenticated lacks % on public.site_appearance', pr;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.site_appearance', pr) then
      raise exception 'E5: service_role lacks % on public.site_appearance', pr;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.site_appearance', 'delete') then
    raise exception 'E5: authenticated holds DELETE on public.site_appearance';
  end if;
  foreach r in array array['authenticated', 'service_role'] loop
    -- CASE, not AND: the privilege functions refuse MAINTAIN before PostgreSQL 17 (CI runs 15).
    if has_table_privilege(r::name, 'public.site_appearance', 'truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.site_appearance', 'maintain')
                else false end) then
      raise exception 'E5: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.site_appearance', r;
    end if;
  end loop;
  -- Column level: anon SELECTs exactly tenant_id and the twelve options; PUBLIC nothing; no
  -- column-level grant to authenticated or service_role (their access is the table grant).
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from (v_options || array['tenant_id']) then
    raise exception 'E5: anon''s SELECT columns on site_appearance are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.site_appearance', 'insert, update, references')
     or has_any_column_privilege('public', 'public.site_appearance', 'select, insert, update, references') then
    raise exception 'E5: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select string_agg(format('%s.%s', g.grantee::regrole, a.attname), ', ') into v_bad
    from pg_attribute a
    cross join lateral aclexplode(a.attacl) g
   where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attacl is not null
     and g.grantee in ('authenticated'::regrole, 'service_role'::regrole);
  if v_bad is not null then
    raise exception 'E5: column-level grants to authenticated or service_role: %', v_bad;
  end if;

  -- ---- 6. The triggers: exactly these six, with their functions and timing ----------------
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  select array_agg(format('%s %s %s', t.tgname, t.tgtype, t.tgfoid::regprocedure)
                   order by t.tgname collate "C") into v_got
    from pg_trigger t
   where t.tgrelid = 'public.site_appearance'::regclass and not t.tgisinternal and t.tgenabled = 'O';
  v_want := array[
    'site_appearance__release_guard 31 app.tg_release_guard()',
    'site_appearance_actor 23 app.tg_set_actor()',
    'site_appearance_release_capture 29 app.tg_release_capture()',
    'site_appearance_snapshot 21 app.tg_snapshot_singleton()',
    'site_appearance_updated_at 19 app.tg_set_updated_at()',
    'site_appearance_version 19 app.tg_bump_version()'];
  if v_got is distinct from v_want then
    raise exception 'E5: site_appearance triggers are %, expected %', v_got, v_want;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.site_appearance'::regclass
                    and t.tgname = 'site_appearance_snapshot'
                    and t.tgnargs = 1 and t.tgargs = convert_to('site_appearance', 'UTF8') || '\x00'::bytea)
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.site_appearance'::regclass
                       and t.tgname = 'site_appearance_release_capture' and t.tgnargs = 3
                       and t.tgargs = convert_to('site_appearance', 'UTF8') || '\x00'::bytea
                                      || convert_to('tenant_id', 'UTF8') || '\x00'::bytea
                                      || '\x00'::bytea) then
    raise exception 'E5: the snapshot or the capture trigger has the wrong arguments';
  end if;

  -- ---- 7. The CHECKs: every bucket and rule is a named constraint -------------------------
  select array_agg(c.conname::text order by c.conname::text collate "C") into v_got
    from pg_constraint c
   where c.conrelid = 'public.site_appearance'::regclass and c.contype = 'c';
  if v_got is distinct from array['site_appearance_blur', 'site_appearance_cta_complete',
       'site_appearance_cta_href', 'site_appearance_cta_label', 'site_appearance_logo_position',
       'site_appearance_logo_size', 'site_appearance_menu_align', 'site_appearance_mobile_menu',
       'site_appearance_tint', 'site_appearance_tint_minimum'] then
    raise exception 'E5: site_appearance CHECKs are %', v_got;
  end if;

  -- ---- 8. The registry row, exactly, and its columns real ---------------------------------
  if not exists (select 1 from app.release_entities e
                  where e.entity_type = 'site_appearance' and e.table_name = 'site_appearance'
                    and e.key_column = 'tenant_id' and e.area = 'appearance'
                    and e.author_roles = array['admin', 'developer']
                    and e.delete_roles = '{}'
                    and (select array_agg(x order by x collate "C") from unnest(e.columns) x) = v_options
                    and e.deferred_columns = '{}' and e.unique_flags = '{}'
                    and e.exempt_columns = '{}' and e.apply_order = 110 and not e.has_status
                    and e.publish_flag is null) then
    raise exception 'E5: the site_appearance registry row is missing or differs';
  end if;

  -- ---- 9. The release guard: still first on every registry table (0066's postcondition 3) --
  select string_agg(e.table_name, ', ' order by e.table_name) into v_bad
    from app.release_entities e
   where (select count(*) from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgfoid = 'app.tg_release_guard()'::regprocedure
             and tg.tgname = e.table_name || '__release_guard'
             and tg.tgtype = 31 and tg.tgenabled = 'O' and tg.tgnargs = 0) <> 1
      or (select tg.tgname from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 2
           order by tg.tgname collate "C" limit 1) is distinct from e.table_name || '__release_guard';
  if v_bad is not null then
    raise exception 'E5: registry tables without exactly one guard firing first: %', v_bad;
  end if;

  -- ---- 10. The guide: in the catalog at revision 1 (new), place 43, alone there; every tenant
  -- holds it as the catalog renders it -------------------------------------------------------
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'header-and-menu' and c.revision = 1 and c.sort_order = 43
                    and c.screens = array['/admin/appearance/header']
                    and c.caps = array['nav.edit', 'theme.edit'])
     or (select count(*) from app.help_guide_catalog where sort_order = 43) <> 1 then
    raise exception 'E5: the header-and-menu guide is not in the catalog at revision 1, place 43';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'header-and-menu'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'E5: tenants without the header-and-menu guide as the catalog holds it: %', v_bad;
  end if;

  -- ---- 11. Releases are still off everywhere (0038, 0051, 0062, 0066) ----------------------
  if exists (select 1 from app.release_tenants) then
    raise exception 'E5: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
