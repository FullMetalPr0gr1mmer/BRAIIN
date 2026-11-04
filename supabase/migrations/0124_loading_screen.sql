-- ─────────────────────────────────────────────────────────────────────────────────────────
-- E7 — The loading screen's look: five intro_ columns on public.site_appearance (Admin v2 E7,
-- AV-30). Forward-only and EXPAND only: five new columns, each with its default (the intro as
-- built) and a named CHECK, anon's column grant widened to them, the release registry's
-- site_appearance row restated with them appended, and the loading screen's help guide. Nothing
-- that exists narrows: the row E5 stores today takes the five defaults. The number is a
-- placeholder: numbers are assigned at the merge train (docs/admin-v2/migrations.md,
-- scripts/renumber-migration.mjs).
-- Depends on the site_appearance migration (E5: the table, its RLS, grants, triggers and
-- registry row), 0038 (the release registry), 0066 (the release guard), 0069 (H11:
-- app.put_help_guide) and 0098 (app.faq_text_ok, the bilingual plain-text shape the tagline
-- reuses).
--
-- The design is docs/admin-v2/README.md (the E7 row: "all styles incl. bar and tagline; lhci
-- re-gate"; its Appearance list: "loading styles: logo/video/black/light/bar/text, <= 1.5 s"),
-- P-2 (theme and header/intro publish under theme.edit), P-3 (site_appearance is staged), P-9
-- (the intro's look is this row under theme.edit; the on/off switch stays the home hero
-- section's `intro`, page_sections under pages.write, so no row is split), O-14 (Content Creator
-- keeps that switch), ui.md "### Loading screen" and "### AV-30" (the timing buckets);
-- docs/hero-intro.md (the choreography derived from two tokens); what was built and every
-- departure is docs/admin-v2/as-built/E7.md.
--
--   1. Five columns, one per option, each a closed set held by a named CHECK (the Worker's Zod,
--      packages/schemas/appearance.ts, is the other layer; tests/lib/introOptions.spec.ts holds
--      the two equal):
--        intro_backdrop  video | black | light            (default video: the logo over the loop)
--        intro_bar       boolean                          (default false)
--        intro_tagline   {"en", "ar"}, 1-60 each, or null (default null)
--        intro_hold_ms   500 to 1500, step 100            (default 1000: --bs-intro-hold 1s)
--        intro_fade_ms   300 to 600, step 50              (default 450: --bs-intro-fade .45s)
--      The defaults are the intro as built, so no row, the stored row and a default row render
--      the same bytes (tests/render/introOptions.spec.ts).
--   2. anon SELECTs the five (the home page's intro reads them through the content seam); the
--      table grants of authenticated and the service role already cover new columns. RLS and
--      the policies are untouched: the row's read, the non-staff block and the theme.edit writes
--      (live-checked, RESTRICTIVE) apply to the new columns as to the header's.
--   3. The release registry's site_appearance row, restated with the five columns appended (E5's
--      row otherwise, word for word), so a release stages and publishes the loading screen like
--      the header. apply_release builds its statements from the registry; the snapshot, capture
--      and guard triggers are row-generic, so nothing else is restated.
--      src/lib/release/registry.ts derives the same list from the singleton
--      (tests/authz/releaseRegistry.spec.ts holds the two equal).
--   4. loading-screen: a NEW guide (revision 0) through H11's catalog, for Appearance ›
--      Loading screen and the roles that open it (pages.write: Admin and Content Creator, the
--      on/off switch; theme.edit: Admin and Developer, the look). Its place is 46, free in the
--      catalog (43 header-and-menu, 44 footer, 45 collections-and-faq).
--
-- Grants under both Supabase privilege regimes (README P-14): the column grant is stated
-- (anon's SELECT list is checked exactly below), and nothing else changes. The Sales boundary
-- (C10a) is untouched: no relation is added, and the non-staff block covers every column.
--
-- Rule 5 (the deployed Worker between this push and the deploy): the deployed public loaders
-- select explicit columns (the header's) and never name an intro_ one; the deployed Header
-- screen saves through the singleton, whose `toRow` writes only the header keys it maps, so the
-- five keep their defaults; the deployed singleton's GET selects its own column list. A staged
-- change the deployed admin makes names only header columns, which the restated row allows.
-- Releases stay off (app.release_tenants empty).
--
-- CLAUDE.md §3 (Pillar 1; Pillar 2: the intro stays Tier A, zero new JS, and the home LCP stays
-- the intro logo, §6), §8 (Admin v2 lanes), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. The five columns ════════════════════════════════════════════════════════════════════
-- Constant defaults: adding them rewrites nothing (PostgreSQL 11+ stores the default in the
-- catalog); each CHECK validates the at most one row per tenant at once.
alter table public.site_appearance
  add column if not exists intro_backdrop text not null default 'video'
    constraint site_appearance_intro_backdrop check (intro_backdrop in ('video', 'black', 'light')),
  add column if not exists intro_bar boolean not null default false,
  -- {"en": …, "ar": …}, each 1 to 60 characters, trimmed, no control character (0098's shape);
  -- rendered as text, never markup.
  add column if not exists intro_tagline jsonb
    constraint site_appearance_intro_tagline check (
      intro_tagline is null or app.faq_text_ok(intro_tagline, 60)),
  -- The site rule: the logo never holds longer than 1.5 s.
  add column if not exists intro_hold_ms int not null default 1000
    constraint site_appearance_intro_hold check (
      intro_hold_ms between 500 and 1500 and intro_hold_ms % 100 = 0),
  add column if not exists intro_fade_ms int not null default 450
    constraint site_appearance_intro_fade check (
      intro_fade_ms between 300 and 600 and intro_fade_ms % 50 = 0);

comment on table public.site_appearance is
  'The site''s appearance settings (Admin v2 E5 and E7, P-9: theme.edit): per tenant, the '
  'header''s bucketed options (header_*) and the loading screen''s look (intro_*). Read by the '
  'public header and the home page''s intro (src/lib/data/appearance.ts); every option defaults '
  'to the site as built. Whether the intro shows is the home hero section''s `intro` '
  '(page_sections, pages.write), not this row.';

-- ═══ 2. anon's columns ══════════════════════════════════════════════════════════════════════
-- Added to E5's column grant (tenant_id and the twelve header options): the five intro options,
-- never the version, the stamps or the actors.
grant select (intro_backdrop, intro_bar, intro_tagline, intro_hold_ms, intro_fade_ms)
  on public.site_appearance to anon;

-- ═══ 3. The release registry: site_appearance with the intro columns ═══════════════════════
-- E5's row word for word, the five intro columns appended to its columns.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('site_appearance', 'site_appearance', 'tenant_id', 'appearance', '{admin,developer}', '{}',
   '{header_logo_position,header_logo_size,header_menu_align,header_sticky,header_hide_on_scroll,header_solid_after_hero,header_tint,header_blur,header_mobile_menu,header_cta_show,header_cta_label,header_cta_href,intro_backdrop,intro_bar,intro_tagline,intro_hold_ms,intro_fade_ms}',
   '{}', '{}', '{}', 110, false, null)
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

-- ═══ 4. loading-screen (new) ═══════════════════════════════════════════════════════════════
-- H11's app.put_help_guide (0069): the nine keys exactly, at revision 0 (a new guide); the
-- catalog moves it to 1 and seeds it into every tenant. For the roles that open the Loading
-- screen: pages.write (the switch: Admin, Content Creator) and theme.edit (the look: Admin,
-- Developer). PAGE_GUIDES (src/lib/admin/help/pageGuides.ts) offers it there;
-- tests/lib/helpCentre.spec.ts holds the copy to the words the screen uses.
select app.put_help_guide($guide$
{
  "slug": "loading-screen",
  "sort_order": 46,
  "minutes": 2,
  "tags": ["site"],
  "screens": ["/admin/appearance/loading"],
  "caps": ["pages.write", "theme.edit"],
  "title": "The loading screen",
  "title_ar": "شاشة التحميل",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Appearance › Loading screen holds the short intro on the home page: the logo on its own for a moment before the page appears. Each card is for the people who look after that part, so you may see only one of them."
      },
      { "t": "h", "x": "On or off" },
      {
        "t": "p",
        "x": "Show the loading screen turns the intro on or off for the home page, in English and Arabic. It belongs to the home page's hero, so it is saved like an edit of that page."
      },
      { "t": "h", "x": "Style" },
      {
        "t": "p",
        "x": "Choose what sits behind the logo: Logo over the video, Logo on black or Logo on light. Add a progress bar under the logo, and a short tagline in both languages if you like. The logo itself always shows: it is the first thing the home page draws."
      },
      { "t": "h", "x": "Timing" },
      {
        "t": "p",
        "x": "Duration is how long the logo holds, from 500 to 1500 ms: the site rule is never longer than 1.5 seconds. Fade is how long the intro takes to leave, from 300 to 600 ms. The headline and the rest of the hero follow on their own."
      },
      {
        "t": "p",
        "x": "Play preview shows your choices before you save. Press Save the loading screen to keep them."
      },
      {
        "t": "tip",
        "x": "Visitors see it once per visit, in each tab. Visitors who ask for less motion never see it, and any tap, key or scroll skips it. History lists every saved version of these settings, together with the header's."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تضم Appearance › Loading screen المقدّمة القصيرة في الصفحة الرئيسية: يظهر الشعار وحده لحظة قبل ظهور الصفحة. كل بطاقة مخصّصة لمن يتولّى ذلك الجزء، فقد لا ترى إلا إحداها."
      },
      { "t": "h", "x": "التشغيل والإيقاف" },
      {
        "t": "p",
        "x": "يشغّل Show the loading screen المقدّمة في الصفحة الرئيسية أو يوقفها، بالإنجليزية والعربية. وهو جزء من واجهة الصفحة الرئيسية، فيُحفظ مثل أي تعديل على تلك الصفحة."
      },
      { "t": "h", "x": "النمط" },
      {
        "t": "p",
        "x": "اختر ما يظهر خلف الشعار: Logo over the video أو Logo on black أو Logo on light. ويمكنك إضافة شريط تقدّم تحت الشعار، وعبارة قصيرة باللغتين إن أردت. ويظهر الشعار نفسه دائمًا، لأنه أول ما ترسمه الصفحة الرئيسية."
      },
      { "t": "h", "x": "التوقيت" },
      {
        "t": "p",
        "x": "Duration هي مدة بقاء الشعار، من 500 إلى 1500 ملّي ثانية، وقاعدة الموقع ألا تزيد على ثانية ونصف. وFade هي مدة اختفاء المقدّمة، من 300 إلى 600 ملّي ثانية. ويتبعها العنوان وبقية الواجهة من تلقاء نفسها."
      },
      {
        "t": "p",
        "x": "يعرض Play preview اختياراتك قبل الحفظ. اضغط Save the loading screen للاحتفاظ بها."
      },
      {
        "t": "tip",
        "x": "يرى الزائر المقدّمة مرة واحدة في كل زيارة، في كل تبويب. ولا يراها من طلب حركة أقل، ويتخطّاها أي نقر أو ضغط مفتاح أو تمرير. ويعرض History كل نسخة محفوظة من هذه الإعدادات مع إعدادات الشريط العلوي."
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
  v_options constant text[] := array['header_blur', 'header_cta_href', 'header_cta_label',
    'header_cta_show', 'header_hide_on_scroll', 'header_logo_position', 'header_logo_size',
    'header_menu_align', 'header_mobile_menu', 'header_solid_after_hero', 'header_sticky',
    'header_tint', 'intro_backdrop', 'intro_bar', 'intro_fade_ms', 'intro_hold_ms',
    'intro_tagline'];
  r text;
  pr text;
begin
  -- ---- 1. The five columns: their types, nullability and defaults --------------------------
  select array_agg(format('%s %s %s %s', a.attname, format_type(a.atttypid, a.atttypmod),
                          case when a.attnotnull then 'not null' else 'null' end,
                          coalesce(pg_get_expr(d.adbin, d.adrelid), '-'))
                   order by a.attname::text collate "C") into v_got
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0
     and not a.attisdropped and a.attname::text like 'intro\_%';
  v_want := array[
    'intro_backdrop text not null ''video''::text',
    'intro_bar boolean not null false',
    'intro_fade_ms integer not null 450',
    'intro_hold_ms integer not null 1000',
    'intro_tagline jsonb null -'];
  if v_got is distinct from v_want then
    raise exception 'E7: the intro_ columns are %, expected %', v_got, v_want;
  end if;

  -- ---- 2. The CHECKs: E5's ten and the four intro ones, each as written ---------------------
  select array_agg(c.conname::text order by c.conname::text collate "C") into v_got
    from pg_constraint c
   where c.conrelid = 'public.site_appearance'::regclass and c.contype = 'c';
  if v_got is distinct from array['site_appearance_blur', 'site_appearance_cta_complete',
       'site_appearance_cta_href', 'site_appearance_cta_label', 'site_appearance_intro_backdrop',
       'site_appearance_intro_fade', 'site_appearance_intro_hold', 'site_appearance_intro_tagline',
       'site_appearance_logo_position', 'site_appearance_logo_size', 'site_appearance_menu_align',
       'site_appearance_mobile_menu', 'site_appearance_tint', 'site_appearance_tint_minimum'] then
    raise exception 'E7: site_appearance CHECKs are %', v_got;
  end if;
  select string_agg(c.conname::text, ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'public.site_appearance'::regclass and c.contype = 'c'
     and c.conname::text like 'site\_appearance\_intro\_%'
     and (not c.convalidated
          or (c.conname = 'site_appearance_intro_backdrop'
              and pg_get_constraintdef(c.oid) !~ 'intro_backdrop = ANY \(ARRAY\[''video''::text, ''black''::text, ''light''::text\]\)')
          or (c.conname = 'site_appearance_intro_tagline'
              and pg_get_constraintdef(c.oid) !~ 'faq_text_ok\(intro_tagline, 60\)')
          or (c.conname = 'site_appearance_intro_hold'
              and pg_get_constraintdef(c.oid) !~ 'intro_hold_ms >= 500.*intro_hold_ms <= 1500.*intro_hold_ms % 100\) = 0')
          or (c.conname = 'site_appearance_intro_fade'
              and pg_get_constraintdef(c.oid) !~ 'intro_fade_ms >= 300.*intro_fade_ms <= 600.*intro_fade_ms % 50\) = 0'));
  if v_bad is not null then
    raise exception 'E7: intro CHECKs not validated or not as written: %', v_bad;
  end if;

  -- ---- 3. RLS still ENABLE + FORCE, and the policy set is E5's, unchanged ------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.site_appearance'::regclass) then
    raise exception 'E7: public.site_appearance is not ENABLE + FORCE row level security';
  end if;
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
    raise exception 'E7: site_appearance policies are %, expected %', v_got, v_want;
  end if;

  -- ---- 4. Privileges, exactly (both grant regimes) ------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.site_appearance',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.site_appearance', 'maintain')
                else false end) then
      raise exception 'E7: % holds a table privilege on public.site_appearance', r;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update'] loop
    if not has_table_privilege('authenticated', 'public.site_appearance', pr) then
      raise exception 'E7: authenticated lacks % on public.site_appearance', pr;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.site_appearance', pr) then
      raise exception 'E7: service_role lacks % on public.site_appearance', pr;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.site_appearance', 'delete') then
    raise exception 'E7: authenticated holds DELETE on public.site_appearance';
  end if;
  foreach r in array array['authenticated', 'service_role'] loop
    -- CASE, not AND: the privilege functions refuse MAINTAIN before PostgreSQL 17 (CI runs 15).
    if has_table_privilege(r::name, 'public.site_appearance', 'truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.site_appearance', 'maintain')
                else false end) then
      raise exception 'E7: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.site_appearance', r;
    end if;
  end loop;
  -- Column level: anon SELECTs exactly tenant_id, the twelve header options and the five intro
  -- options; PUBLIC nothing; no column-level grant to authenticated or service_role.
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from (v_options || array['tenant_id']) then
    raise exception 'E7: anon''s SELECT columns on site_appearance are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.site_appearance', 'insert, update, references')
     or has_any_column_privilege('public', 'public.site_appearance', 'select, insert, update, references') then
    raise exception 'E7: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select string_agg(format('%s.%s', g.grantee::regrole, a.attname), ', ') into v_bad
    from pg_attribute a
    cross join lateral aclexplode(a.attacl) g
   where a.attrelid = 'public.site_appearance'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attacl is not null
     and g.grantee in ('authenticated'::regrole, 'service_role'::regrole);
  if v_bad is not null then
    raise exception 'E7: column-level grants to authenticated or service_role: %', v_bad;
  end if;

  -- ---- 5. The registry row, exactly: E5's with the intro columns, and its columns real -----
  select columns into v_got from app.release_entities where entity_type = 'site_appearance';
  if v_got is distinct from array['header_logo_position', 'header_logo_size', 'header_menu_align',
       'header_sticky', 'header_hide_on_scroll', 'header_solid_after_hero', 'header_tint',
       'header_blur', 'header_mobile_menu', 'header_cta_show', 'header_cta_label',
       'header_cta_href', 'intro_backdrop', 'intro_bar', 'intro_tagline', 'intro_hold_ms',
       'intro_fade_ms'] then
    raise exception 'E7: the site_appearance registry columns are %', v_got;
  end if;
  if not exists (select 1 from app.release_entities e
                  where e.entity_type = 'site_appearance' and e.table_name = 'site_appearance'
                    and e.key_column = 'tenant_id' and e.area = 'appearance'
                    and e.author_roles = array['admin', 'developer']
                    and e.delete_roles = '{}'
                    and (select array_agg(x order by x collate "C") from unnest(e.columns) x) = v_options
                    and e.deferred_columns = '{}' and e.unique_flags = '{}'
                    and e.exempt_columns = '{}' and e.apply_order = 110 and not e.has_status
                    and e.publish_flag is null) then
    raise exception 'E7: the site_appearance registry row moved beyond its columns';
  end if;

  -- ---- 6. The release guard: still first on site_appearance (0066's postcondition 3) -------
  if (select tg.tgname from pg_trigger tg
       where tg.tgrelid = 'public.site_appearance'::regclass and not tg.tgisinternal
         and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 2
       order by tg.tgname collate "C" limit 1) is distinct from 'site_appearance__release_guard' then
    raise exception 'E7: site_appearance__release_guard no longer fires first on site_appearance';
  end if;

  -- ---- 7. The guide: in the catalog at revision 1 (new), place 46, alone there; every tenant
  -- holds it as the catalog renders it -------------------------------------------------------
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'loading-screen' and c.revision = 1 and c.sort_order = 46
                    and c.screens = array['/admin/appearance/loading']
                    and c.caps = array['pages.write', 'theme.edit'])
     or (select count(*) from app.help_guide_catalog where sort_order = 46) <> 1 then
    raise exception 'E7: the loading-screen guide is not in the catalog at revision 1, place 46';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'loading-screen'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'E7: tenants without the loading-screen guide as the catalog holds it: %', v_bad;
  end if;

  -- ---- 8. Releases are still off everywhere (0038, 0051, 0062, 0066) ----------------------
  if exists (select 1 from app.release_tenants) then
    raise exception 'E7: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
