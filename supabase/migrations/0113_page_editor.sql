-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0113 — The page editor (Admin v2 E1, AV-25). Forward-only and EXPAND only. The number is a
-- placeholder: it is assigned at merge (scripts/renumber-migration.mjs). Depends on 0001
-- (public.page_sections), 0011 (its table grants to authenticated), 0016 (anon's SELECT on
-- page_sections behind the published-page fence), 0038 (app.release_entities and its
-- page_section row) and 0069 (H11: app.put_help_guide).
--
-- The design is docs/admin-v2/ui.md "Page editor (/admin/pages/[id], flush; AV-25/26)" and
-- slice AV-25 ("00NN_page_sections_label.sql: page_sections.label text null CHECK length ≤
-- 60"); what was built and every departure is docs/admin-v2/as-built/E1.md.
--
--   1. public.page_sections.label: the name a section carries in the page editor's sections
--      column ("Hero, top of the page"), set by its Rename dialog. Null shows the type's own
--      name. A CHECK holds what packages/schemas/admin.ts SectionLabelSchema holds: 1 to 60
--      characters, trimmed, no C0/C1 control character (a newline included). No public page
--      renders it, but the column rides the table's existing grants: anon's SELECT (0016)
--      reads it on a visible section of a published page, as the verification accepted
--      ("page_sections.label is public", README "Verification findings", UI row), and staff
--      write it under the table's RLS as every other column. No grant changes.
--   2. The release registry's page_section row, restated with `label` appended to its
--      columns (0038's row otherwise, word for word), so a release stages and publishes a
--      rename like any other column. apply_release builds its statements from the registry;
--      the snapshot, capture and guard triggers are row-generic, so nothing else is
--      restated. src/lib/release/registry.ts derives the same list from the resource config
--      (tests/lib/releaseRegistry.spec.ts holds the two equal).
--   3. editing-pages: a NEW guide (revision 0) through H11's catalog, for the page editor
--      (/admin/pages) and the roles that edit pages (pages.write: Admin and Content Creator;
--      SEO opens Pages for SEO only, which seo-and-redirects covers). Its place is 41, free in
--      the catalog (40 is saving-and-publishing, 42 is U5 + U6's services-and-projects, 45
--      collections-and-faq). The literal is docs/admin-v2/guides/editing-pages.json verbatim
--      (tests/lib/helpCentre.spec.ts holds them equal); its number (60 characters) is
--      SECTION_LABEL_MAX.
--
-- Rule 5 (the deployed Worker between this push and the deploy): no reader's shape changes.
-- The deployed admin lists sections with an explicit column list that does not name `label`,
-- the public loaders select explicit columns, and the preview mirror (R8) reads the table's
-- rows into PageSectionRowSchema, whose parse drops a key it does not know (not .strict()).
-- A staged change made by the deployed Worker carries no `label`, which the restated row
-- simply allows.
--
-- The Sales boundary (C10a, U7, H13) is untouched: no relation is added, and Sales reads no
-- more of page_sections than anon does. Releases stay off (app.release_tenants empty).
--
-- Production as of 2026-10-26: PostgreSQL 17.6, one tenant; main holds every migration
-- through 0112 (0110 U11c, 0111 U5 + U6, 0112 R11, whose apply_release reads the registry's
-- columns row-generically), and U15 (GA4) is in flight with its own placeholder; none of
-- them touches page_sections or this guide. Grants are untouched, so both Supabase privilege
-- regimes (README P-14) read the same. CLAUDE.md §8 (Section engine; Admin v2 lanes, UI), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
set local lock_timeout = '5s';

-- ═══ 1. page_sections.label ═══════════════════════════════════════════════════════════════
alter table public.page_sections add column if not exists label text;

alter table public.page_sections drop constraint if exists page_sections_label_shape;
alter table public.page_sections
  add constraint page_sections_label_shape
    check (label is null
           or (char_length(label) between 1 and 60
               and label = pg_catalog.btrim(label)
               and label !~ '[\u0001-\u001F\u007F-\u009F]'));

comment on column public.page_sections.label is
  'Admin v2 E1: the section''s name in the page editor (Rename), 1 to 60 characters, trimmed, no control character; null shows the type''s name. Admin naming only: no public page renders it, though anon''s table-level SELECT reads it.';

-- ═══ 2. The release registry: page_section with `label` ════════════════════════════════════
-- 0038's row word for word, `label` appended to the columns.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('page_section', 'page_sections', 'id', 'pages', '{admin,content_creator}', '{admin}',
   '{page_id,type,content,style,visible,sort_order,is_placeholder,label}',
   '{}', '{}', '{}', 90, false, 'visible')
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

-- ═══ 3. editing-pages (new) ════════════════════════════════════════════════════════════════
-- H11's app.put_help_guide (0069): the nine keys exactly, at revision 0 (a new guide); the
-- catalog moves it to 1 and seeds it into every tenant.
select app.put_help_guide($guide$
{
  "slug": "editing-pages",
  "sort_order": 41,
  "minutes": 3,
  "tags": [
    "content"
  ],
  "screens": [
    "/admin/pages"
  ],
  "caps": [
    "pages.write"
  ],
  "title": "Editing pages",
  "title_ar": "تعديل الصفحات",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Pages lists every page of the site. Open one to change its sections: their order, which ones show, and every word in English and Arabic."
      },
      {
        "t": "h",
        "x": "Sections"
      },
      {
        "t": "ol",
        "x": [
          "The column on the left lists the page's sections in the order the site shows them. Drag one by its handle, or use Move up and Move down, to change the order.",
          "The eye shows or hides a section on the site. A section the page always needs, such as the contact form, says so: the page shows it either way.",
          "Add section lists the kinds of section this page can take. A kind it already has, or cannot take, is shown with the reason. A new section starts hidden, at the end: fill it in, move it, then show it.",
          "Rename gives a section a name of up to 60 characters, shown only here. Only an Admin can delete a section; anyone else can hide it instead."
        ]
      },
      {
        "t": "h",
        "x": "Words"
      },
      {
        "t": "ol",
        "x": [
          "Every field starts as the words the page already shows. Change one to make it yours; a field you leave keeps the built-in words, even when they are improved later. Reset to the built-in copy puts them all back.",
          "English, العربية or Both at the top chooses the language you edit. Arabic missing counts the fields with English and no Arabic, and Next gap takes you to each one.",
          "Highlighted words are a range of the heading's words, from one word to another.",
          "Press Save changes, or Ctrl+S. If someone else saved the section meanwhile, nothing is overwritten: you are asked to reload their version first."
        ]
      },
      {
        "t": "h",
        "x": "SEO and history"
      },
      {
        "t": "ol",
        "x": [
          "SEO opens the page's title, description and share image for search engines and shared links. Admin and SEO change them; a Content Creator reads them.",
          "History lists the saves of the open section, or of the page details, newest first, with who saved and when."
        ]
      },
      {
        "t": "tip",
        "x": "Hiding a section is not deleting it: its words stay saved and come back when you show it again."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تعرض شاشة Pages كل صفحات الموقع. افتح صفحة لتغيير أقسامها: ترتيبها، وما يظهر منها، وكل كلمة فيها بالإنجليزية والعربية."
      },
      {
        "t": "h",
        "x": "الأقسام (Sections)"
      },
      {
        "t": "ol",
        "x": [
          "يعرض العمود الأيسر أقسام الصفحة بالترتيب الذي يظهر به الموقع. اسحب قسمًا من مقبضه، أو استخدم Move up وMove down، لتغيير الترتيب.",
          "تُظهر العين القسم في الموقع أو تخفيه. والقسم الذي تحتاجه الصفحة دائمًا، مثل نموذج التواصل، يقول ذلك: فالصفحة تعرضه في كل الأحوال.",
          "يعرض Add section أنواع الأقسام التي تقبلها الصفحة. والنوع الموجود فيها أو الذي لا تقبله يظهر مع السبب. ويبدأ القسم الجديد مخفيًا في آخر الصفحة: املأه، وانقله، ثم أظهره.",
          "يمنح Rename القسم اسمًا من 60 حرفًا على الأكثر، لا يظهر إلا هنا. ولا يستطيع حذف قسم إلا المسؤول (Admin)، ويستطيع غيره إخفاءه بدلًا من ذلك."
        ]
      },
      {
        "t": "h",
        "x": "الكلمات"
      },
      {
        "t": "ol",
        "x": [
          "يبدأ كل حقل بالكلمات التي تعرضها الصفحة الآن. غيّر حقلًا ليصبح نصك أنت، والحقل الذي تتركه يحتفظ بالكلمات المدمجة حتى إن تحسّنت لاحقًا. ويعيدها Reset to the built-in copy كلها.",
          "يختار English أو العربية أو Both في الأعلى لغة التعديل. ويعدّ Arabic missing الحقول التي فيها إنجليزية بلا عربية، وينقلك Next gap إلى كل منها.",
          "الكلمات المميزة نطاق من كلمات العنوان، من كلمة إلى أخرى.",
          "اضغط Save changes أو Ctrl+S. وإن حفظ شخص آخر القسم في الأثناء فلا يُكتب فوق شيء: يُطلب منك تحميل نسخته أولًا."
        ]
      },
      {
        "t": "h",
        "x": "SEO والسجل"
      },
      {
        "t": "ol",
        "x": [
          "يفتح SEO عنوان الصفحة ووصفها وصورة المشاركة لمحركات البحث والروابط المشتركة. يغيّرها المسؤول (Admin) ودور SEO، ويقرؤها صانع المحتوى (Content Creator).",
          "يعرض History مرات حفظ القسم المفتوح، أو تفاصيل الصفحة، من الأحدث، مع من حفظ ومتى."
        ]
      },
      {
        "t": "tip",
        "x": "إخفاء القسم ليس حذفًا: تبقى كلماته محفوظة وتعود حين تُظهره من جديد."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- ═══ Postconditions ════════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
  v_got text[];
  r text;
begin
  -- ---- 1. the column: text, nullable, its CHECK as written --------------------------------
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'page_sections'
                    and column_name = 'label' and data_type = 'text' and is_nullable = 'YES'
                    and column_default is null) then
    raise exception '0113: public.page_sections.label must be a nullable text column with no default';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.page_sections'::regclass
                    and conname = 'page_sections_label_shape' and contype = 'c' and convalidated
                    and pg_get_constraintdef(oid) ~ 'char_length\(label\) >= 1'
                    and pg_get_constraintdef(oid) ~ 'char_length\(label\) <= 60'
                    and pg_get_constraintdef(oid) ~ 'btrim\(label\)') then
    raise exception '0113: page_sections_label_shape is missing, unvalidated or not as written';
  end if;
  -- The rule itself, on values (the CHECK's own expression, evaluated here).
  if not (select bool_and(ok) from (values
            ((null::text is null)),
            (char_length('Hero, top of the page') between 1 and 60),
            (not (char_length('') between 1 and 60)),
            (' Hero' <> pg_catalog.btrim(' Hero')),
            (E'Two\nlines' ~ '[\u0001-\u001F\u007F-\u009F]'),
            (not ('Hero' ~ '[\u0001-\u001F\u007F-\u009F]')),
            (not ('الصفحة الرئيسية' ~ '[\u0001-\u001F\u007F-\u009F]'))) as t(ok)) then
    raise exception '0113: the label rule does not hold on its own samples';
  end if;

  -- ---- 2. grants: unchanged. anon reads (0016) and writes nothing; authenticated keeps 0011's
  -- four; nobody holds TRUNCATE (R5, 0066, revoked it on every registry table). REFERENCES
  -- and TRIGGER are whatever the regime left them: this file grants and revokes nothing.
  if not has_column_privilege('anon', 'public.page_sections', 'label', 'select') then
    raise exception '0113: anon must read page_sections.label as every other column (0016)';
  end if;
  if has_any_column_privilege('anon', 'public.page_sections', 'insert, update')
     or has_table_privilege('anon', 'public.page_sections', 'insert, update, delete') then
    raise exception '0113: anon holds a write privilege on page_sections';
  end if;
  if not (has_table_privilege('authenticated', 'public.page_sections', 'select')
          and has_table_privilege('authenticated', 'public.page_sections', 'insert')
          and has_table_privilege('authenticated', 'public.page_sections', 'update')
          and has_table_privilege('authenticated', 'public.page_sections', 'delete')) then
    raise exception '0113: authenticated lost one of 0011''s privileges on page_sections';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.page_sections', 'truncate') then
      raise exception '0113: % holds TRUNCATE on page_sections (0066 revoked it)', r;
    end if;
  end loop;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.page_sections'::regclass) then
    raise exception '0113: public.page_sections is not ENABLE + FORCE row level security';
  end if;

  -- ---- 3. the registry stages a rename: page_section's columns hold label, and nothing else
  -- of the row moved.
  select columns into v_got from app.release_entities where entity_type = 'page_section';
  if v_got is distinct from array['page_id', 'type', 'content', 'style', 'visible',
                                  'sort_order', 'is_placeholder', 'label'] then
    raise exception '0113: the page_section registry columns are %', v_got;
  end if;
  if not exists (select 1 from app.release_entities
                  where entity_type = 'page_section' and table_name = 'page_sections'
                    and key_column = 'id' and area = 'pages'
                    and author_roles = array['admin', 'content_creator']
                    and delete_roles = array['admin']
                    and deferred_columns = '{}' and unique_flags = '{}'
                    and exempt_columns = '{}' and apply_order = 90 and not has_status
                    and publish_flag = 'visible') then
    raise exception '0113: the page_section registry row moved beyond its columns';
  end if;
  if exists (select 1 from app.release_tenants) then
    raise exception '0113: releases must stay off (app.release_tenants is not empty)';
  end if;

  -- ---- 4. the guide: in the catalog at revision 1 (new), its place, caps and screens -------
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'editing-pages' and revision = 1 and sort_order = 41
                    and title = 'Editing pages' and caps = array['pages.write']
                    and screens = array['/admin/pages']) then
    raise exception '0113: the catalog must hold editing-pages at revision 1, place 41';
  end if;
  if (select count(*) from app.help_guide_catalog where sort_order = 41) <> 1 then
    raise exception '0113: place 41 must hold one guide';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'editing-pages'
                        and h.sort_order = 41 and h.title = 'Editing pages');
  if v_bad is not null then
    raise exception '0113: tenants without the editing-pages guide: %', v_bad;
  end if;

  -- ---- 5. no API role gained anything on the help machinery -------------------------------
  if has_function_privilege('anon', 'app.help_article_set()', 'execute')
     or has_function_privilege('authenticated', 'app.help_article_set()', 'execute')
     or has_function_privilege('service_role', 'app.help_article_set()', 'execute')
     or has_function_privilege('anon', 'app.seed_help_articles(uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.seed_help_articles(uuid)', 'execute')
     or has_function_privilege('service_role', 'app.seed_help_articles(uuid)', 'execute')
     or has_table_privilege('authenticated', 'app.help_guide_catalog', 'select')
     or has_table_privilege('anon', 'app.help_guide_catalog', 'select') then
    raise exception '0113: an API role may read the help set, the catalog or seed guides';
  end if;
end $$;
