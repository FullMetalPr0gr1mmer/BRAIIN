-- ─────────────────────────────────────────────────────────────────────────────────────────
-- E3 — The template pages' shared text: public.template_copy (Admin v2 E3, AV-31+).
-- Forward-only and EXPAND only: one new table (a staged per-tenant row), one new capability
-- helper, the shared text's CHECK, its release-registry row, a new help guide and one sentence
-- of the forms guide. Nothing that exists narrows. The number is a placeholder: numbers are
-- assigned at the merge train (docs/admin-v2/migrations.md, scripts/renumber-migration.mjs).
-- Depends on 0001 (tenants, app.current_role, app.tg_set_updated_at), 0009 (app.tg_bump_version,
-- app.tg_set_actor), 0033 (app.live_role), 0038 (the release registry,
-- app.tg_snapshot_singleton), 0051 (app.tg_release_capture), 0066 (app.tg_release_guard),
-- 0069 (H11: app.put_help_guide), 0097 (C10a: the non-staff block this table joins) and 0105
-- (the forms-and-spam guide, revision 1, whose one sentence on the service pages changes).
--
-- The design is docs/admin-v2/README.md (the E3 row: "`template_copy`, staged, AR required,
-- code defaults"; P-3: "template shared text" is staged), ui.md "### Template editors
-- (AV-31)" (whose read-only "Shared text" the README row overrules) and verification.md's
-- challenge on UI deviation 11; what was built and every departure is
-- docs/admin-v2/as-built/E3.md.
--
--   1. app.role_edits_pages(r): the one helper for pages.write (Admin, Content Creator), held
--      equal to ROLE_CAPS by tests/authz/sqlHelpers.spec.ts.
--   2. app.template_copy_ok(kind, copy): a stored template is a JSON object of at most 16 KB
--      whose keys are that template's catalogue (packages/schemas/templateCopy.ts
--      TEMPLATE_COPY_KEYS, held equal by tests/lib/templateCopySql.spec.ts): a text key is
--      exactly {"en", "ar"}, two non-blank strings of at most 300 characters; an accent key is
--      {"en"?, "ar"?}, each {"from", "to"?}, word indexes 0 to 30 and 1 to 31, `to` after
--      `from`; no string anywhere carries `<`, `>` or a C0/C1 control character (no markup,
--      no line break). The Worker's Zod is the other layer (the per-key caps, the trim). Every
--      reader parses key by key (src/lib/templates/copy.ts), so a row written around the
--      Worker costs a key its built-in words, never a page.
--   3. public.template_copy: one row per tenant (key tenant_id, created on the first save, as
--      seo_defaults, form_settings and site_appearance), `service` and `project` holding only
--      what differs from the built-in words (an absent key is the code's words, so no row
--      renders every template page as it was), version, stamps and actors.
--   4. RLS, ENABLE + FORCE, the tenant predicate FIRST in every USING and WITH CHECK: everyone
--      reads the tenant's row (it is public copy: anon renders it); a signed-in token that is
--      not CMS staff reads none (0097's non-staff block); Admin and Content Creator insert and
--      update by the token's role (app.role_edits_pages(app.current_role())) and, RESTRICTIVE,
--      by the live profile (app.live_role()); nobody deletes (no policy, no grant).
--   5. Grants, stated for both Supabase grant regimes (P-14): anon SELECTs tenant_id, service
--      and project (never the version, the stamps or the actors); authenticated SELECT,
--      INSERT, UPDATE; the service role SELECT, INSERT, UPDATE, DELETE; no TRUNCATE,
--      REFERENCES, TRIGGER or MAINTAIN for anyone.
--   6. Triggers, BEFORE ones in the order their names sort: the release guard
--      (`template_copy__release_guard`, first), the actor, updated_at and the version; AFTER:
--      the history snapshot (app.tg_snapshot_singleton('template_copy')) and the release
--      capture (keyed by tenant_id).
--   7. The release registry row (registry contract #4): staged once releases switch on (P-3);
--      area pages, authors Admin and Content Creator (pages.write; publishing it also needs
--      content.publish, a content area), never removed by a release.
--   8. The guides: page-templates (new, place 48) for the two template editors; forms-and-spam
--      at revision 1 (0105's), its sentence on the service pages' "Say hello" words, which are
--      now the service template's shared text, not fixed.
--
-- No ROLE_CAPS or §5 change: pages.write exists (Admin, Content Creator). No content is seeded:
-- no row is the template pages as built.
--
-- CLAUDE.md §3 (Pillar 1, Pillar 2: the template pages stay Tier A and zero-JS), §8 (Admin v2
-- lanes), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. The capability helper ═══════════════════════════════════════════════════════════════
create or replace function app.role_edits_pages(r text) returns boolean
  language sql immutable
  set search_path = ''
as $$ select coalesce(r in ('admin', 'content_creator'), false) $$;  -- pages.write
revoke all on function app.role_edits_pages(text) from public, anon, authenticated, service_role;
grant execute on function app.role_edits_pages(text) to authenticated, service_role;

-- ═══ 2. The shared text's CHECK ═════════════════════════════════════════════════════════════
-- The key lists are the catalogue's, one array per template and kind of key, in the
-- catalogue's order (tests/lib/templateCopySql.spec.ts parses them from this function). A key
-- added to the catalogue is a migration restating this function.
create or replace function app.template_copy_ok(p_kind text, p jsonb) returns boolean
  language sql immutable set search_path = ''
as $$
  with catalogue (lines, accents) as (
    select case p_kind
             when 'service' then array['services', 'home', 'skipKicker', 'skip', 'seeCase',
               'whatTag', 'get', 'valueTag', 'valueHeading', 'valueLead', 'caseTag',
               'seeProject', 'context', 'problem', 'did', 'helloLeadIn', 'helloLead', 'moreTag',
               'moreLeadIn', 'all', 'fab']
             when 'project' then array['bannerTag', 'back', 'keywords', 'overview', 'scope',
               'goal', 'result', 'final', 'breakdownTag', 'breakdownHeading', 'breakdownLead',
               'sketch', 'bts', 'process', 'galleryTag', 'galleryHeading', 'viewer',
               'viewerClose', 'viewerPrevious', 'viewerNext', 'nextProject']
           end,
           case p_kind
             when 'service' then array['valueHeadingAccent']
             when 'project' then array['breakdownHeadingAccent', 'galleryHeadingAccent']
           end
  )
  select coalesce((
    select pg_catalog.jsonb_typeof(p) = 'object'
       and pg_catalog.octet_length(p::text) <= 16384
       and c.lines is not null
       and not pg_catalog.jsonb_path_exists(
         p, '$.** ? (@.type() == "string" && @ like_regex "[<>\u0001-\u001f\u007f-\u009f]")')
       and not exists (
         select 1
           from pg_catalog.jsonb_each(p) e
          where not coalesce(
            case
              -- A line: exactly {en, ar}, two non-blank strings of at most 300 characters.
              when e.key = any (c.lines) then
                pg_catalog.jsonb_typeof(e.value) = 'object'
                and (select pg_catalog.array_agg(k order by k collate "C")
                       from pg_catalog.jsonb_object_keys(e.value) k) = array['ar', 'en']
                and pg_catalog.jsonb_typeof(e.value -> 'en') = 'string'
                and pg_catalog.jsonb_typeof(e.value -> 'ar') = 'string'
                and pg_catalog.btrim(e.value ->> 'en') <> ''
                and pg_catalog.btrim(e.value ->> 'ar') <> ''
                and pg_catalog.char_length(e.value ->> 'en') <= 300
                and pg_catalog.char_length(e.value ->> 'ar') <= 300
              -- An accent: {en?, ar?}, each {from, to?}: from 0 to 30, to 1 to 31 and after from.
              when e.key = any (c.accents) then
                pg_catalog.jsonb_typeof(e.value) = 'object'
                and not exists (
                  select 1
                    from pg_catalog.jsonb_each(e.value) h
                   where not coalesce(
                     h.key in ('en', 'ar')
                     and pg_catalog.jsonb_typeof(h.value) = 'object'
                     and not exists (select 1 from pg_catalog.jsonb_object_keys(h.value) hk
                                      where hk not in ('from', 'to'))
                     and pg_catalog.jsonb_typeof(h.value -> 'from') = 'number'
                     and (h.value ->> 'from') ~ '^([0-9]|[12][0-9]|30)$'
                     and (not (h.value ? 'to')
                          or (pg_catalog.jsonb_typeof(h.value -> 'to') = 'number'
                              and (h.value ->> 'to') ~ '^([1-9]|[12][0-9]|3[01])$'
                              and (h.value ->> 'to')::int > (h.value ->> 'from')::int)),
                     false))
              else false
            end,
            false))
      from catalogue c),
    false)
$$;
-- A CHECK runs with the writer's privileges: the two roles that write may call it.
revoke all on function app.template_copy_ok(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function app.template_copy_ok(text, jsonb) to authenticated, service_role;

-- ═══ 3. The table ═════════════════════════════════════════════════════════════════════════
create table if not exists public.template_copy (
  tenant_id uuid primary key default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  service jsonb not null default '{}'::jsonb,
  project jsonb not null default '{}'::jsonb,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint template_copy_service check (app.template_copy_ok('service', service)),
  constraint template_copy_project check (app.template_copy_ok('project', project))
);
alter table public.template_copy enable row level security;
alter table public.template_copy force row level security;
comment on table public.template_copy is
  'The template pages'' shared text (Admin v2 E3, pages.write): per tenant, what the service '
  'page template (service) and the project page template (project) change from the built-in '
  'words, key by key from a closed catalogue, English and Arabic both. Read by the service '
  'pages and the case studies (src/lib/data/templateCopy.ts); a missing key is the code''s words.';

-- ═══ 4. Row security (the fence before any grant) ═════════════════════════════════════════
drop policy if exists template_copy_read on public.template_copy;
create policy template_copy_read on public.template_copy for select
  using (tenant_id = app.effective_tenant_id());
-- The non-staff block (0097 §4, Admin v2 C10a): a signed-in token that is not CMS staff reads
-- no more than anon outside the CRM, and a GRANT cannot tell the app roles apart. RESTRICTIVE,
-- FOR SELECT, TO authenticated, the tenant predicate first, then app.is_staff(). anon is not
-- named: anon reads its columns through template_copy_read.
drop policy if exists template_copy_staff_columns on public.template_copy;
create policy template_copy_staff_columns on public.template_copy
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
drop policy if exists template_copy_insert on public.template_copy;
create policy template_copy_insert on public.template_copy for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_pages(app.current_role()));
drop policy if exists template_copy_update on public.template_copy;
create policy template_copy_update on public.template_copy for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_edits_pages(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_pages(app.current_role()));
-- The live check (as 0102 for site_profile): the profile, read now, must still hold
-- pages.write, so a demoted, deactivated or locked token writes nothing.
drop policy if exists template_copy_live_insert on public.template_copy;
create policy template_copy_live_insert on public.template_copy as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_pages((select app.live_role())));
drop policy if exists template_copy_live_update on public.template_copy;
create policy template_copy_live_update on public.template_copy as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_edits_pages((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_edits_pages((select app.live_role())));

-- ═══ 5. Grants (stated, never inherited: both grant regimes) ══════════════════════════════
-- Readers and writers: anon reads the two templates' words (every service page and case
-- study, the preview's dataset); staff read the row and Admin and Content Creator write it
-- (the template editors, through the singleton kernel); the service role reads, inserts,
-- updates and deletes it (apply_release's conflict lock, the seeds, R17's restore, the e2e
-- reset). Never TRUNCATE (it fires no row trigger: neither the guard nor the capture would see
-- it, 0066).
revoke all on public.template_copy from public, anon, authenticated, service_role;
grant select (tenant_id, service, project) on public.template_copy to anon;
grant select, insert, update on public.template_copy to authenticated;
grant select, insert, update, delete on public.template_copy to service_role;

-- ═══ 6. Triggers ══════════════════════════════════════════════════════════════════════════
-- BEFORE row triggers fire in name order: the guard (its double underscore sorts first)
-- refuses before any other BEFORE trigger's work runs, as 0066 gives every registry table.
drop trigger if exists template_copy__release_guard on public.template_copy;
create trigger template_copy__release_guard before insert or update or delete on public.template_copy
  for each row execute function app.tg_release_guard();
drop trigger if exists template_copy_actor on public.template_copy;
create trigger template_copy_actor before insert or update on public.template_copy
  for each row execute function app.tg_set_actor();
drop trigger if exists template_copy_updated_at on public.template_copy;
create trigger template_copy_updated_at before update on public.template_copy
  for each row execute function app.tg_set_updated_at();
drop trigger if exists template_copy_version on public.template_copy;
create trigger template_copy_version before update on public.template_copy
  for each row execute function app.tg_bump_version();
-- History, keyed by the tenant (a singleton, 0038).
drop trigger if exists template_copy_snapshot on public.template_copy;
create trigger template_copy_snapshot after insert or update on public.template_copy
  for each row execute function app.tg_snapshot_singleton('template_copy');
-- What a release changes (0051), built as 0051's loop builds it: the generated columns read
-- from the catalog (none), keyed by tenant_id.
do $$
declare
  v_generated text;
begin
  select coalesce(string_agg(a.attname::text, ',' order by a.attnum), '') into v_generated
    from pg_attribute a
   where a.attrelid = 'public.template_copy'::regclass
     and a.attnum > 0 and not a.attisdropped and a.attgenerated = 's';
  execute 'drop trigger if exists template_copy_release_capture on public.template_copy';
  execute format('create trigger template_copy_release_capture after insert or update or delete '
                 'on public.template_copy for each row execute function '
                 'app.tg_release_capture(%L, %L, %L)', 'template_copy', 'tenant_id', v_generated);
end $$;

-- ═══ 7. The release registry ════════════════════════════════════════════════════════════
-- Registry contract #4 (releases.md §1.3): staged once releases switch on (P-3). Authors are
-- the holders of pages.write; publishing it also needs content.publish (a content area, P-2);
-- never removed by a release. One row per line group, parsed by
-- tests/fixtures/releaseRegistry.ts: keep the shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('template_copy', 'template_copy', 'tenant_id', 'pages', '{admin,content_creator}', '{}',
   '{service,project}',
   '{}', '{}', '{}', 110, false, null)
on conflict (entity_type) do nothing;

-- ═══ 8. The guides ═══════════════════════════════════════════════════════════════════════
-- H11's app.put_help_guide (0069). page-templates is NEW, so revision 0; sort_order 48, a free
-- place after the appearance guides (43 to 46). For the roles that open the template editors:
-- pages.write (Admin, Content Creator; the Worker's filter from ROLE_CAPS). Its screens are the
-- two editors; PAGE_GUIDES (src/lib/admin/help/pageGuides.ts) offers it there.
-- tests/lib/helpCentre.spec.ts reads these statements (tests/fixtures/helpSet.ts) and holds the
-- copy to the words the screen uses.
select app.put_help_guide($guide$
{
  "slug": "page-templates",
  "sort_order": 48,
  "minutes": 2,
  "tags": ["content"],
  "screens": ["/admin/pages/template/service", "/admin/pages/template/project"],
  "caps": ["pages.write"],
  "title": "The service and project page templates",
  "title_ar": "قالبا صفحة الخدمة وصفحة المشروع",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Every service and every project has its own page, built from one template each. Open Service page or Project page under Templates in Pages to see one of those pages beside the words that make it."
      },
      { "t": "h", "x": "Showing" },
      {
        "t": "p",
        "x": "Showing picks the service or project the preview shows. Services are grouped by their discipline. The template's parts are listed in the page's order: pick one and the preview moves to it. The parts themselves are fixed."
      },
      { "t": "h", "x": "This service and this project" },
      {
        "t": "p",
        "x": "The words that belong to the one you are showing: its name, its tagline, its intro and the rest. They are the same fields as in its full editor and save the same way. Full editor opens everything else, such as its address, its case study and its SEO."
      },
      { "t": "h", "x": "Shared text" },
      {
        "t": "p",
        "x": "The words every page of the template shows around its own content, such as the tags, the headings and the buttons, grouped by part. Leave a line empty in both languages to keep the built-in words, which show in grey. A line you change needs English and Arabic. Use {c} in More in for the discipline's name. A heading you rewrite can colour some of its words: choose which below it."
      },
      {
        "t": "tip",
        "x": "A change to the shared text shows on every service page or every project page at once. History lists every saved version of it."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "لكل خدمة ولكل مشروع صفحة خاصة، مبنية من قالب واحد لكل منهما. افتح Service page أو Project page تحت Templates في Pages لترى إحدى تلك الصفحات بجانب النصوص التي تصنعها."
      },
      { "t": "h", "x": "ما تعرضه المعاينة (Showing)" },
      {
        "t": "p",
        "x": "يحدّد Showing الخدمة أو المشروع الذي تعرضه المعاينة. وتُجمَّع الخدمات حسب مجالها. وتظهر أجزاء القالب بترتيبها في الصفحة: اختر جزءًا لتنتقل المعاينة إليه. والأجزاء نفسها ثابتة."
      },
      { "t": "h", "x": "هذه الخدمة وهذا المشروع" },
      {
        "t": "p",
        "x": "النصوص الخاصة بما تعرضه: اسمه وسطره التعريفي ومقدمته وغيرها. وهي الحقول نفسها في محرره الكامل وتُحفظ بالطريقة نفسها. ويفتح Full editor كل ما عدا ذلك، مثل عنوانه ودراسة الحالة وإعدادات SEO."
      },
      { "t": "h", "x": "النص المشترك" },
      {
        "t": "p",
        "x": "النصوص التي تعرضها كل صفحات القالب حول محتواها الخاص، مثل الوسوم والعناوين والأزرار، مجمّعة حسب الجزء. اترك السطر فارغًا باللغتين لتبقى النصوص الأصلية، وهي تظهر بالرمادي. والسطر الذي تغيّره يحتاج إلى الإنجليزية والعربية. استخدم {c} في More in لاسم المجال. والعنوان الذي تعيد كتابته يمكن أن تلوّن بعض كلماته: اختر أيها تحته."
      },
      {
        "t": "tip",
        "x": "يظهر أي تغيير في النص المشترك في كل صفحات الخدمات أو كل صفحات المشاريع دفعة واحدة. ويعرض History كل نسخة محفوظة منه."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- forms-and-spam at revision 1 (0105's put): word for word but one sentence of "Changing the
-- words", in each language. A service page's "Say hello" words were fixed; since E3 they are the
-- service page template's shared text (helloLeadIn, helloLead), edited in Pages by the roles that
-- edit pages. src/lib/admin/forms/overview.ts says the same on the Forms screen
-- (tests/lib/helpU11.spec.ts holds the two together); docs/admin-v2/guides/forms-and-spam.json
-- is this text.
select app.put_help_guide($guide$
{
  "slug": "forms-and-spam",
  "sort_order": 85,
  "minutes": 3,
  "tags": ["settings", "leads"],
  "screens": ["/admin/forms"],
  "caps": ["settings.general"],
  "title": "Forms and spam protection",
  "title_ar": "النماذج والحماية من الرسائل المزعجة",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Forms shows the two forms on the site, the inquiry form on the home page, the Contact page and the services pages, and the application form on Join: the fields each one asks for and how each one keeps spam out. The fields are fixed. Each one is checked on the server, and contact details are stored encrypted."
      },
      {
        "t": "h",
        "x": "What each form asks for"
      },
      {
        "t": "ol",
        "x": [
          "The inquiry form needs a name, an e-mail and a message. The company, a phone number, the service, the budget, when it is needed and the agreement to be contacted are optional. Not every place asks for all of them: only the services pages ask for a phone number, the Contact page and the services pages for the budget, and only the Contact page for when it is needed.",
          "The Join form needs a name, an e-mail, a phone number, a city, the role, the experience, how the person wants to work, when they could start, a portfolio link, a message and the box that lets you keep the application. The crafts, LinkedIn, the CV and the box for future roles are optional. A CV is a PDF or Word file of up to 10 MB."
        ]
      },
      {
        "t": "h",
        "x": "Keeping spam out"
      },
      {
        "t": "ol",
        "x": [
          "A hidden field is always on. People never see it, and a send that fills it in is not stored.",
          "The inquiry form takes up to 10 sends an hour from one internet address. If that count cannot be checked, the send still goes through, so no inquiry is lost.",
          "The Join form takes up to 5 sends an hour from one internet address and 3 a day from one e-mail. If those counts cannot be checked, the send is refused for now, because it carries a file.",
          "A captcha is not set up yet."
        ]
      },
      {
        "t": "h",
        "x": "Consent on Join"
      },
      {
        "t": "p",
        "x": "Each application stores which version of the consent text the person agreed to. The Join tab shows the version the form uses now."
      },
      {
        "t": "h",
        "x": "Changing the words"
      },
      {
        "t": "p",
        "x": "On the home page, the Contact page, the Services page and Join, the words around each form, such as its heading, are edited with that page, in Pages, by the roles that edit pages. On each service page those words are the service page template's shared text, edited in Pages, and the heading names the service. Admins open and close job applications in General settings."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تعرض شاشة Forms نموذجَي الموقع، نموذج الاستفسار في الصفحة الرئيسية وصفحة التواصل وصفحات الخدمات، ونموذج التقديم في صفحة الانضمام: الحقول التي يطلبها كل منهما، وكيف يصد كل منهما الرسائل المزعجة. الحقول ثابتة، ويُتحقق من كل حقل على الخادم، وتُحفظ بيانات التواصل مشفّرة."
      },
      {
        "t": "h",
        "x": "ما يطلبه كل نموذج"
      },
      {
        "t": "ol",
        "x": [
          "يحتاج نموذج الاستفسار إلى اسم وبريد إلكتروني ورسالة. أما الشركة ورقم الجوال والخدمة والميزانية وموعد الحاجة والموافقة على التواصل فاختيارية. ولا يطلب كل مكان هذه الحقول كلها: صفحات الخدمات وحدها تطلب رقم الجوال، وصفحة التواصل وصفحات الخدمات تطلبان الميزانية، وصفحة التواصل وحدها تطلب موعد الحاجة.",
          "يحتاج نموذج الانضمام إلى اسم وبريد إلكتروني ورقم جوال ومدينة والوظيفة والخبرة وطريقة العمل المفضلة وموعد البدء ورابط أعمال ورسالة، والخانة التي تسمح بحفظ الطلب. أما الحِرف ولينكدإن والسيرة الذاتية وخانة الوظائف المستقبلية فاختيارية. السيرة الذاتية ملف PDF أو Word حتى 10 ميجابايت."
        ]
      },
      {
        "t": "h",
        "x": "صد الرسائل المزعجة"
      },
      {
        "t": "ol",
        "x": [
          "خانة مخفية تعمل دائمًا. لا يراها الناس، وأي إرسال يملؤها لا يُحفظ.",
          "يقبل نموذج الاستفسار حتى 10 إرسالات في الساعة من عنوان إنترنت واحد. وإذا تعذّر التحقق من هذا العدد يمر الإرسال، فلا يضيع أي استفسار.",
          "يقبل نموذج الانضمام حتى 5 إرسالات في الساعة من عنوان إنترنت واحد، و3 في اليوم من بريد إلكتروني واحد. وإذا تعذّر التحقق من هذه الأعداد يُرفض الإرسال مؤقتًا، لأنه يحمل ملفًا.",
          "التحقق من الزائر (Captcha) غير مُعدّ بعد."
        ]
      },
      {
        "t": "h",
        "x": "الموافقة في نموذج الانضمام"
      },
      {
        "t": "p",
        "x": "يحفظ كل طلب نسخة نص الموافقة التي وافق عليها صاحبه. ويعرض تبويب Join النسخة التي يستخدمها النموذج الآن."
      },
      {
        "t": "h",
        "x": "تغيير النصوص"
      },
      {
        "t": "p",
        "x": "في الصفحة الرئيسية وصفحة التواصل وصفحة الخدمات وصفحة الانضمام تُحرَّر النصوص حول كل نموذج، ومنها عنوانه، مع تلك الصفحة في Pages، وذلك للأدوار التي تحرر الصفحات. أما في صفحة كل خدمة فهذه النصوص هي النص المشترك لقالب صفحة الخدمة، وتُحرَّر في Pages، ويحمل العنوان اسم الخدمة. ويفتح المسؤولون (Admin) التقديم على الوظائف ويغلقونه من General settings."
      }
    ]
  }
}
$guide$::jsonb, 1);

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
  r text;
  pr text;
begin
  -- ---- 1. RLS enabled and forced --------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.template_copy'::regclass) then
    raise exception 'E3: public.template_copy is not ENABLE + FORCE row level security';
  end if;

  -- ---- 2. The exact policy set ----------------------------------------------------------
  v_want := array[
    'template_copy_insert INSERT PERMISSIVE {authenticated}',
    'template_copy_live_insert INSERT RESTRICTIVE {authenticated}',
    'template_copy_live_update UPDATE RESTRICTIVE {authenticated}',
    'template_copy_read SELECT PERMISSIVE {public}',
    'template_copy_staff_columns SELECT RESTRICTIVE {authenticated}',
    'template_copy_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles) order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'template_copy';
  if v_got is distinct from v_want then
    raise exception 'E3: template_copy policies are %, expected %', v_got, v_want;
  end if;

  -- ---- 3. The tenant predicate is the first conjunct of every USING and WITH CHECK -------
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'template_copy'
     and ((qual is not null and qual !~ v_tenant_first)
          or (with_check is not null and with_check !~ v_tenant_first)
          or coalesce(qual, with_check) is null);
  if v_bad is not null then
    raise exception 'E3: template_copy policies that do not lead with the tenant predicate: %', v_bad;
  end if;
  -- The read is the tenant fence alone, and the non-staff block is (tenant, is_staff).
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'template_copy'
        and policyname = 'template_copy_read') !~ ('^' || v_tenant || '$')
     or (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'template_copy'
            and policyname = 'template_copy_staff_columns' and with_check is null
            and qual ~ ('^\(' || v_tenant || ' AND (app\.)?is_staff\(\)\)$')) <> 1 then
    raise exception 'E3: template_copy_read or template_copy_staff_columns is not as written';
  end if;
  -- Every write policy names pages.write's helper; the live ones read the live role.
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'template_copy' and cmd in ('INSERT', 'UPDATE')
     and (coalesce(with_check, '') !~ 'role_edits_pages'
          or (cmd = 'UPDATE' and coalesce(qual, '') !~ 'role_edits_pages')
          or (policyname like '%live%' and with_check !~ 'live_role\(\)')
          -- current_role is a keyword: the catalog prints it quoted.
          or (policyname not like '%live%' and with_check !~ 'current_role"?\(\)'));
  if v_bad is not null then
    raise exception 'E3: template_copy write policies that do not check pages.write as written: %', v_bad;
  end if;

  -- ---- 4. The helpers: pages.write's holders; the CHECK; both executable by the writers ---
  if not app.role_edits_pages('admin') or not app.role_edits_pages('content_creator')
     or app.role_edits_pages('developer') or app.role_edits_pages('seo')
     or app.role_edits_pages('sales') or app.role_edits_pages(null) then
    raise exception 'E3: app.role_edits_pages does not answer exactly Admin and Content Creator';
  end if;
  foreach pr in array array['app.role_edits_pages(text)', 'app.template_copy_ok(text,jsonb)'] loop
    if not has_function_privilege('authenticated', pr, 'execute')
       or not has_function_privilege('service_role', pr, 'execute')
       or has_function_privilege('anon', pr, 'execute')
       or has_function_privilege('public', pr, 'execute') then
      raise exception 'E3: % must be executable by authenticated and service_role only', pr;
    end if;
    if (select proconfig from pg_proc where oid = pr::regprocedure) is distinct from array['search_path=""']
       or (select prosecdef from pg_proc where oid = pr::regprocedure) then
      raise exception 'E3: % must be INVOKER with its search_path pinned to empty', pr;
    end if;
  end loop;
  if not app.template_copy_ok('service', '{}')
     or not app.template_copy_ok('project', '{}')
     or not app.template_copy_ok('service',
       '{"seeCase":{"en":"Read it","ar":"اقرأ"},"valueHeadingAccent":{"en":{"from":1,"to":3}}}')
     or app.template_copy_ok('other', '{}')
     or app.template_copy_ok('service', '[]')
     or app.template_copy_ok('service', '{"nope":{"en":"a","ar":"ب"}}')
     or app.template_copy_ok('service', '{"seeCase":{"en":"a"}}')
     or app.template_copy_ok('service', '{"seeCase":{"en":"a","ar":" "}}')
     or app.template_copy_ok('service', '{"seeCase":{"en":"<b>a</b>","ar":"ب"}}')
     or app.template_copy_ok('service', '{"seeCase":{"en":"a\nb","ar":"ب"}}')
     or app.template_copy_ok('service', '{"seeCase":{"en":"a","ar":"ب","x":"c"}}')
     or app.template_copy_ok('service', '{"valueHeadingAccent":{"en":{"from":3,"to":2}}}')
     or app.template_copy_ok('project', '{"seeCase":{"en":"a","ar":"ب"}}') then
    raise exception 'E3: app.template_copy_ok does not hold the catalogue and the shapes';
  end if;

  -- ---- 5. Privileges, exactly ---------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.template_copy',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.template_copy', 'maintain')
                else false end) then
      raise exception 'E3: % holds a table privilege on public.template_copy', r;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update'] loop
    if not has_table_privilege('authenticated', 'public.template_copy', pr) then
      raise exception 'E3: authenticated lacks % on public.template_copy', pr;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.template_copy', pr) then
      raise exception 'E3: service_role lacks % on public.template_copy', pr;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.template_copy', 'delete') then
    raise exception 'E3: authenticated holds DELETE on public.template_copy';
  end if;
  foreach r in array array['authenticated', 'service_role'] loop
    -- CASE, not AND: the privilege functions refuse MAINTAIN before PostgreSQL 17 (CI runs 15).
    if has_table_privilege(r::name, 'public.template_copy', 'truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.template_copy', 'maintain')
                else false end) then
      raise exception 'E3: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.template_copy', r;
    end if;
  end loop;
  -- Column level: anon SELECTs exactly tenant_id and the two templates; PUBLIC nothing; no
  -- column-level grant to authenticated or service_role (their access is the table grant).
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.template_copy'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['project', 'service', 'tenant_id'] then
    raise exception 'E3: anon''s SELECT columns on template_copy are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.template_copy', 'insert, update, references')
     or has_any_column_privilege('public', 'public.template_copy', 'select, insert, update, references') then
    raise exception 'E3: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select string_agg(format('%s.%s', g.grantee::regrole, a.attname), ', ') into v_bad
    from pg_attribute a
    cross join lateral aclexplode(a.attacl) g
   where a.attrelid = 'public.template_copy'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attacl is not null
     and g.grantee in ('authenticated'::regrole, 'service_role'::regrole);
  if v_bad is not null then
    raise exception 'E3: column-level grants to authenticated or service_role: %', v_bad;
  end if;

  -- ---- 6. The triggers: exactly these six, with their functions and timing ----------------
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  select array_agg(format('%s %s %s', t.tgname, t.tgtype, t.tgfoid::regprocedure)
                   order by t.tgname collate "C") into v_got
    from pg_trigger t
   where t.tgrelid = 'public.template_copy'::regclass and not t.tgisinternal and t.tgenabled = 'O';
  v_want := array[
    'template_copy__release_guard 31 app.tg_release_guard()',
    'template_copy_actor 23 app.tg_set_actor()',
    'template_copy_release_capture 29 app.tg_release_capture()',
    'template_copy_snapshot 21 app.tg_snapshot_singleton()',
    'template_copy_updated_at 19 app.tg_set_updated_at()',
    'template_copy_version 19 app.tg_bump_version()'];
  if v_got is distinct from v_want then
    raise exception 'E3: template_copy triggers are %, expected %', v_got, v_want;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.template_copy'::regclass
                    and t.tgname = 'template_copy_snapshot'
                    and t.tgnargs = 1 and t.tgargs = convert_to('template_copy', 'UTF8') || '\x00'::bytea)
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.template_copy'::regclass
                       and t.tgname = 'template_copy_release_capture' and t.tgnargs = 3
                       and t.tgargs = convert_to('template_copy', 'UTF8') || '\x00'::bytea
                                      || convert_to('tenant_id', 'UTF8') || '\x00'::bytea
                                      || '\x00'::bytea) then
    raise exception 'E3: the snapshot or the capture trigger has the wrong arguments';
  end if;

  -- ---- 7. The CHECKs: one per template ----------------------------------------------------
  select array_agg(c.conname::text order by c.conname::text collate "C") into v_got
    from pg_constraint c
   where c.conrelid = 'public.template_copy'::regclass and c.contype = 'c';
  if v_got is distinct from array['template_copy_project', 'template_copy_service'] then
    raise exception 'E3: template_copy CHECKs are %', v_got;
  end if;

  -- ---- 8. The registry row, exactly ---------------------------------------------------------
  if not exists (select 1 from app.release_entities e
                  where e.entity_type = 'template_copy' and e.table_name = 'template_copy'
                    and e.key_column = 'tenant_id' and e.area = 'pages'
                    and e.author_roles = array['admin', 'content_creator']
                    and e.delete_roles = '{}' and e.columns = array['service', 'project']
                    and e.deferred_columns = '{}' and e.unique_flags = '{}'
                    and e.exempt_columns = '{}' and e.apply_order = 110 and not e.has_status
                    and e.publish_flag is null) then
    raise exception 'E3: the template_copy registry row is missing or differs';
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
    raise exception 'E3: registry tables without exactly one guard firing first: %', v_bad;
  end if;

  -- ---- 10. The guides: page-templates new (revision 1, place 48, alone there), forms-and-spam
  -- at revision 2 with the new sentence; every tenant holds both as the catalog renders them --
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'page-templates' and c.revision = 1 and c.sort_order = 48
                    and c.screens = array['/admin/pages/template/service',
                                          '/admin/pages/template/project']
                    and c.caps = array['pages.write'])
     or (select count(*) from app.help_guide_catalog where sort_order = 48) <> 1 then
    raise exception 'E3: the page-templates guide is not in the catalog at revision 1, place 48';
  end if;
  if not exists (select 1 from app.help_guide_catalog c
                  where c.slug = 'forms-and-spam' and c.revision = 2 and c.sort_order = 85
                    and strpos(c.body::text, 'those words are fixed') = 0
                    and strpos(c.body::text, 'service page template''s shared text') > 0) then
    raise exception 'E3: forms-and-spam is not at revision 2 with the service pages'' new sentence';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where (select count(*)
            from public.help_articles h
            join app.help_guide_catalog c on c.slug = h.slug
           where h.tenant_id = t.id and h.slug in ('page-templates', 'forms-and-spam')
             and h.sort_order = c.sort_order and h.minutes = c.minutes and h.tags = c.tags
             and h.screens = c.screens and h.caps = c.caps and h.title = c.title
             and h.title_ar = c.title_ar and h.body = c.body) <> 2;
  if v_bad is not null then
    raise exception 'E3: tenants without the two guides as the catalog holds them: %', v_bad;
  end if;

  -- ---- 11. Releases are still off everywhere (0038, 0051, 0062, 0066) ----------------------
  if exists (select 1 from app.release_tenants) then
    raise exception 'E3: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
