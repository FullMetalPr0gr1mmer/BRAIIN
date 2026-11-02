-- ─────────────────────────────────────────────────────────────────────────────────────────
-- E6 — The footer's link columns (Admin v2 E6, AV-29). Forward-only and EXPAND only: one new
-- column on public.navigation, one relaxed NOT NULL held by a new CHECK, one guard trigger,
-- the release registry's nav_item row restated, and the footer's help guide. Nothing that
-- exists narrows: every row stored today satisfies the new CHECK as it is. The number is a
-- placeholder: numbers are assigned at the merge train (docs/admin-v2/migrations.md,
-- scripts/renumber-migration.mjs).
-- Depends on 0009 (public.navigation, navigation_write), 0011 (anon's and authenticated's
-- table grants on navigation, navigation_visible_only), 0019 (navigation.is_key), 0038 (the
-- release registry and its nav_item row), 0066 (navigation__release_guard) and 0069 (H11:
-- app.put_help_guide).
--
-- The design is docs/admin-v2/README.md (the E6 row; P-2: identity and footer publish under
-- settings.general; P-3: identity, footer and navigation are staged; P-9: the footer's
-- settings are site_profile columns under settings.general, stored by U9's 0102), plan
-- decision 6 (U9's "footer columns" are those settings; E6 builds the LINK columns), ui.md
-- "### Footer" and "### AV-29" ("navigation heading rows: href nullable for footer headings;
-- at most 4 columns"); what was built and every departure is docs/admin-v2/as-built/E6.md.
--
--   1. public.navigation.is_heading (boolean, not null, default false) and `href` nullable,
--      held by one CHECK, navigation_heading_shape: a heading is a footer row at the top level
--      with no link that is never the key link; every other row keeps its link. A footer
--      column is a heading row, and its links are the footer rows whose parent_id is it.
--   2. At most four columns per tenant: app.tg_navigation_footer_columns, a BEFORE trigger
--      (INVOKER) that takes a transaction-scoped advisory lock per tenant, then counts the
--      tenant's OTHER heading rows (visible or not: a hidden column is one shown later) and
--      refuses a fifth with 23514 naming navigation_footer_columns_max, which the Worker maps
--      to a 422 on the field (src/lib/admin/resources/navigation.ts). The lock makes two
--      concurrent fourth-and-fifth inserts take turns: under READ COMMITTED the count after
--      the lock sees the other's committed row (0031's pattern). It reads under the writer's
--      RLS, which for staff is the tenant's every row (navigation_read; the visible-only
--      RESTRICTIVE read admits app.is_staff()), and the WITH CHECK refuses another tenant's
--      row after it: a count over rows the writer cannot see tells it nothing.
--   3. The release registry's nav_item row, restated with is_heading appended to its columns
--      (0038's row otherwise, word for word), so a release stages and publishes a heading like
--      any other column. apply_release builds its statements from the registry; the snapshot,
--      capture and guard triggers are row-generic, so nothing else is restated.
--      src/lib/release/registry.ts derives the same list from the resource config
--      (tests/lib/releaseRegistry.spec.ts holds the two equal).
--   4. footer: a NEW guide (revision 0) through H11's catalog, for Appearance › Footer and
--      the roles that open it (settings.general: Admin and Developer, the basics; nav.edit:
--      Admin and Content Creator, the columns). Its place is 44, free in the catalog (43 is
--      E5's header-and-menu, 45 collections-and-faq).
--
-- Grants are untouched: anon's table-level SELECT on navigation (0011) reads is_heading as
-- every other column (a heading's title is public on the footer it heads), and staff write
-- it under the table's RLS (navigation_write: Admin and Content Creator, nav.edit) as every
-- other column. Both Supabase privilege regimes (README P-14) read the same.
--
-- Rule 5 (the deployed Worker between this push and the deploy): the deployed public loader
-- selects explicit columns that do not name is_heading, and no heading row exists until the
-- new Worker (the only writer that can send is_heading) is live; even then the old loader's
-- row schema (href: a string) drops a heading row, and its links are promoted to the flat
-- list (src/lib/data/navigation.ts nest), never lost. The deployed admin lists navigation with
-- an explicit column list, and a staged change it makes carries no is_heading, which the
-- restated row allows. The Sales boundary (C10a) is untouched: no relation is added.
-- Releases stay off (app.release_tenants empty).
--
-- CLAUDE.md §3 (Pillar 1; Pillar 3: the footer stays Tier A and zero-JS), §8 (Admin v2 lanes),
-- §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. navigation.is_heading, href nullable, the shape CHECK ═════════════════════════════
alter table public.navigation add column if not exists is_heading boolean not null default false;
alter table public.navigation alter column href drop not null;

alter table public.navigation drop constraint if exists navigation_heading_shape;
alter table public.navigation
  add constraint navigation_heading_shape
    check (coalesce(
      case when is_heading
           then href is null and location = 'footer' and parent_id is null and not is_key
           else href is not null
      end, false));

comment on column public.navigation.is_heading is
  'Admin v2 E6: a footer column''s heading. No link, top level, footer only, never the key link (navigation_heading_shape); its links are the footer rows under it (parent_id). At most four per tenant (app.tg_navigation_footer_columns).';
comment on column public.navigation.href is
  'The link: site-relative or https (the Worker''s scheme allowlist). Null only on a footer column heading (Admin v2 E6, navigation_heading_shape).';

-- ═══ 2. At most four footer columns per tenant ═════════════════════════════════════════════
-- BEFORE triggers on navigation fire by name: navigation__release_guard (0066) <
-- navigation_actor < navigation_footer_columns < navigation_updated_at < navigation_version.
-- The release guard's refusal comes first; no stamp is computed for a refused row.
create or replace function app.tg_navigation_footer_columns() returns trigger
  language plpgsql security invoker set search_path = ''
as $$
declare
  v_others integer;
begin
  -- Only a row that is (or becomes) a heading can add a column.
  if not new.is_heading then
    return new;
  end if;
  -- An update that leaves a heading a heading of the same tenant adds no column.
  if tg_op = 'UPDATE' and old.is_heading and old.tenant_id = new.tenant_id then
    return new;
  end if;
  -- One writer per tenant at a time, so two concurrent "fifth" columns cannot both pass.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('navigation_footer_columns:' || new.tenant_id::text, 0));
  select count(*) into v_others
    from public.navigation n
   where n.tenant_id = new.tenant_id and n.is_heading and n.id <> new.id;
  if v_others >= 4 then
    raise exception 'new row for relation "navigation" violates check constraint "%"',
      'navigation_footer_columns_max'
      using errcode = '23514',
            detail = 'The footer holds at most four columns.';
  end if;
  return new;
end $$;
revoke all on function app.tg_navigation_footer_columns()
  from public, anon, authenticated, service_role;

drop trigger if exists navigation_footer_columns on public.navigation;
create trigger navigation_footer_columns
  before insert or update of is_heading, tenant_id on public.navigation
  for each row execute function app.tg_navigation_footer_columns();

-- ═══ 3. The release registry: nav_item with is_heading ═════════════════════════════════════
-- 0038's row word for word, is_heading appended to the columns.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('nav_item', 'navigation', 'id', 'navigation', '{admin,content_creator}', '{admin}',
   '{location,parent_id,label,href,visible,is_key,sort_order,is_heading}',
   '{parent_id}', '{is_key}', '{}', 100, false, 'visible')
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

-- ═══ 4. footer (new) ═══════════════════════════════════════════════════════════════════════
-- H11's app.put_help_guide (0069): the nine keys exactly, at revision 0 (a new guide); the
-- catalog moves it to 1 and seeds it into every tenant.
select app.put_help_guide($guide$
{
  "slug": "footer",
  "sort_order": 44,
  "minutes": 2,
  "tags": ["site"],
  "screens": ["/admin/appearance/footer"],
  "caps": ["nav.edit", "settings.general"],
  "title": "The footer",
  "title_ar": "التذييل",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Appearance › Footer holds the bottom of every page: the copyright line and its style, the email address and social icons, and the columns of links. Each card is for the people who look after that part, so you may see only some of them."
      },
      { "t": "h", "x": "Basics" },
      {
        "t": "ol",
        "x": [
          "Copyright line: write it in English and Arabic. {year} becomes this year, {brand} the site name from General, and {place} the location. Leave both blank for the built-in line.",
          "Footer style: Light or Dark. Both keep every word easy to read.",
          "Show the email address shows the studio's mailbox. Show social icons shows the accounts set to Show on the site in General.",
          "Admins and Developers change these. Press Save the footer. History lists every save of the site identity, which these settings are part of."
        ]
      },
      { "t": "h", "x": "Columns" },
      {
        "t": "ol",
        "x": [
          "Add a column gives the footer a column with a title in both languages, up to four. A column has no link of its own.",
          "Every footer link has a Column choice: the column it sits in, or No column to keep it in the row under the columns.",
          "Move up and Move down change the order. The eye shows or hides a column or a link.",
          "Admins and Content Creators change the columns. To rename a column, change a link, add one or remove one, open the Menus screen."
        ]
      },
      { "t": "h", "x": "Legal links" },
      {
        "t": "p",
        "x": "Privacy, Terms and Cookies are always shown: the Saudi data law (PDPL) requires them, so they cannot be switched off."
      },
      {
        "t": "tip",
        "x": "The footer is on every page, so a saved change shows across the whole site."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "يضبط Appearance › Footer أسفل كل صفحة: سطر حقوق النشر ونمطه، والبريد الإلكتروني وأيقونات التواصل الاجتماعي، وأعمدة الروابط. وكل بطاقة لمن يتولى ذلك الجزء، لذا قد ترى بعضها فقط."
      },
      { "t": "h", "x": "الأساسيات (Basics)" },
      {
        "t": "ol",
        "x": [
          "سطر حقوق النشر: اكتبه بالإنجليزية والعربية. يصبح {year} السنة الحالية، و{brand} اسم الموقع من General، و{place} الموقع الجغرافي. اترك الحقلين فارغين لاستخدام السطر المدمج.",
          "نمط التذييل: Light أو Dark. وكلاهما يُبقي كل كلمة سهلة القراءة.",
          "يعرض Show the email address صندوق بريد الاستوديو. ويعرض Show social icons الحسابات المضبوطة على Show on the site في General.",
          "يغيّر هذه الإعدادات المسؤول (Admin) والمطوّر (Developer). اضغط Save the footer. ويعرض History كل مرة حُفظت فيها هوية الموقع، وهذه الإعدادات جزء منها."
        ]
      },
      { "t": "h", "x": "الأعمدة (Columns)" },
      {
        "t": "ol",
        "x": [
          "يضيف Add a column إلى التذييل عمودًا بعنوان باللغتين، حتى أربعة أعمدة. وليس للعمود رابط خاص به.",
          "لكل رابط في التذييل اختيار Column: العمود الذي يظهر فيه، أو No column ليبقى في الصف أسفل الأعمدة.",
          "يغيّر Move up وMove down الترتيب. وتُظهر العين العمود أو الرابط أو تخفيه.",
          "يغيّر الأعمدة المسؤول (Admin) وصانع المحتوى (Content Creator). ولإعادة تسمية عمود أو تغيير رابط أو إضافته أو حذفه، افتح شاشة Menus."
        ]
      },
      { "t": "h", "x": "الروابط القانونية" },
      {
        "t": "p",
        "x": "تظهر روابط الخصوصية والشروط وملفات الارتباط دائمًا: يشترطها نظام حماية البيانات الشخصية السعودي (PDPL)، فلا يمكن إيقافها."
      },
      {
        "t": "tip",
        "x": "التذييل موجود في كل صفحة، لذا يظهر أي تغيير محفوظ في الموقع كله."
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
  v_got text[];
  r text;
begin
  -- ---- 1. The column and the relaxed link ---------------------------------------------------
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'navigation'
                    and column_name = 'is_heading' and data_type = 'boolean'
                    and is_nullable = 'NO' and column_default = 'false') then
    raise exception 'E6: public.navigation.is_heading must be boolean not null default false';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'navigation'
                    and column_name = 'href' and data_type = 'text' and is_nullable = 'YES') then
    raise exception 'E6: public.navigation.href must be a nullable text column';
  end if;

  -- ---- 2. The shape CHECK, validated, and every stored row inside it ------------------------
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.navigation'::regclass
                    and conname = 'navigation_heading_shape' and contype = 'c' and convalidated
                    and pg_get_constraintdef(oid) ~ 'is_heading'
                    and pg_get_constraintdef(oid) ~ 'href IS NULL'
                    and pg_get_constraintdef(oid) ~ 'href IS NOT NULL'
                    and pg_get_constraintdef(oid) ~ 'parent_id IS NULL'
                    and pg_get_constraintdef(oid) ~ 'NOT is_key'
                    and pg_get_constraintdef(oid) ~ '''footer''::text') then
    raise exception 'E6: navigation_heading_shape is missing, unvalidated or not as written';
  end if;
  if exists (select 1 from public.navigation where href is null and not is_heading) then
    raise exception 'E6: a navigation link has no href';
  end if;

  -- ---- 3. The trigger: BEFORE INSERT OR UPDATE OF is_heading, tenant_id, row level, after the
  -- release guard; its function INVOKER, search_path pinned, executable by no API role --------
  if (select count(*) from pg_trigger tg
       where tg.tgrelid = 'public.navigation'::regclass and not tg.tgisinternal
         and tg.tgname = 'navigation_footer_columns'
         and tg.tgfoid = 'app.tg_navigation_footer_columns()'::regprocedure
         and tg.tgtype = 23 and tg.tgenabled = 'O' and tg.tgnargs = 0
         and (select array_agg(a.attname::text order by a.attname::text)
                from pg_attribute a
               where a.attrelid = tg.tgrelid and a.attnum = any (tg.tgattr::int2[]))
             = array['is_heading', 'tenant_id']) <> 1 then
    raise exception 'E6: navigation_footer_columns is missing or not as written';
  end if;
  if not exists (select 1 from pg_proc p
                  where p.oid = 'app.tg_navigation_footer_columns()'::regprocedure
                    and not p.prosecdef
                    and p.proconfig = array['search_path=""']) then
    raise exception 'E6: app.tg_navigation_footer_columns must be INVOKER with search_path pinned';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if r <> 'public' and has_function_privilege(r::name,
         'app.tg_navigation_footer_columns()', 'execute') then
      raise exception 'E6: % may execute app.tg_navigation_footer_columns()', r;
    end if;
  end loop;
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = 'app.tg_navigation_footer_columns()'::regprocedure
                and a.grantee = 0) then
    raise exception 'E6: PUBLIC may execute app.tg_navigation_footer_columns()';
  end if;
  -- The limit holds today: no tenant has more than four headings.
  select string_agg(tenant_id::text, ', ') into v_bad
    from (select tenant_id from public.navigation where is_heading
           group by tenant_id having count(*) > 4) t;
  if v_bad is not null then
    raise exception 'E6: tenants with more than four footer columns: %', v_bad;
  end if;

  -- ---- 4. Grants unchanged: anon reads, writes nothing; authenticated keeps 0011's four;
  -- nobody holds TRUNCATE (R5, 0066) ----------------------------------------------------------
  if not has_column_privilege('anon', 'public.navigation', 'is_heading', 'select') then
    raise exception 'E6: anon must read navigation.is_heading as every other column (0011)';
  end if;
  if has_any_column_privilege('anon', 'public.navigation', 'insert, update')
     or has_table_privilege('anon', 'public.navigation', 'insert, update, delete') then
    raise exception 'E6: anon holds a write privilege on navigation';
  end if;
  if not (has_table_privilege('authenticated', 'public.navigation', 'select')
          and has_table_privilege('authenticated', 'public.navigation', 'insert')
          and has_table_privilege('authenticated', 'public.navigation', 'update')
          and has_table_privilege('authenticated', 'public.navigation', 'delete')) then
    raise exception 'E6: authenticated lost one of 0011''s privileges on navigation';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.navigation', 'truncate') then
      raise exception 'E6: % holds TRUNCATE on navigation (0066 revoked it)', r;
    end if;
  end loop;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.navigation'::regclass) then
    raise exception 'E6: public.navigation is not ENABLE + FORCE row level security';
  end if;

  -- ---- 5. The registry stages a heading: nav_item's columns hold is_heading, and nothing
  -- else of the row moved -----------------------------------------------------------------------
  select columns into v_got from app.release_entities where entity_type = 'nav_item';
  if v_got is distinct from array['location', 'parent_id', 'label', 'href', 'visible', 'is_key',
                                  'sort_order', 'is_heading'] then
    raise exception 'E6: the nav_item registry columns are %', v_got;
  end if;
  if not exists (select 1 from app.release_entities
                  where entity_type = 'nav_item' and table_name = 'navigation'
                    and key_column = 'id' and area = 'navigation'
                    and author_roles = array['admin', 'content_creator']
                    and delete_roles = array['admin']
                    and deferred_columns = array['parent_id'] and unique_flags = array['is_key']
                    and exempt_columns = '{}' and apply_order = 100 and not has_status
                    and publish_flag = 'visible') then
    raise exception 'E6: the nav_item registry row moved beyond its columns';
  end if;
  -- The release guard is still first on navigation (0066's postcondition 3).
  if (select tg.tgname from pg_trigger tg
       where tg.tgrelid = 'public.navigation'::regclass and not tg.tgisinternal
         and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 2
       order by tg.tgname collate "C" limit 1) is distinct from 'navigation__release_guard' then
    raise exception 'E6: navigation__release_guard no longer fires first on navigation';
  end if;

  -- ---- 6. The guide: in the catalog at revision 1 (new), place 44, alone there; every tenant
  -- holds it as the catalog renders it -------------------------------------------------------
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'footer' and c.revision = 1 and c.sort_order = 44
                    and c.screens = array['/admin/appearance/footer']
                    and c.caps = array['nav.edit', 'settings.general'])
     or (select count(*) from app.help_guide_catalog where sort_order = 44) <> 1 then
    raise exception 'E6: the footer guide is not in the catalog at revision 1, place 44';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (
     select 1
       from public.help_articles h
       join app.help_guide_catalog c on c.slug = h.slug
      where h.tenant_id = t.id and h.slug = 'footer'
        and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
        and h.screens = c.screens and h.caps = c.caps and h.title = c.title
        and h.title_ar = c.title_ar and h.body = c.body);
  if v_bad is not null then
    raise exception 'E6: tenants without the footer guide as the catalog holds it: %', v_bad;
  end if;

  -- ---- 7. Releases are still off everywhere (0038, 0051, 0062, 0066) ----------------------
  if exists (select 1 from app.release_tenants) then
    raise exception 'E6: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
