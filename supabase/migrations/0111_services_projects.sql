-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0111 — The Services area and the Projects area on the kit (Admin v2 U5 + U6, one folded PR).
-- Forward-only and EXPAND only. The number is a placeholder: it is assigned at merge
-- (scripts/renumber-migration.mjs). Depends on 0002 (public.leads), 0033 (the staff column
-- grant on leads: tenant_id, service_of_interest), 0034 (is_spam, its grant, the RESTRICTIVE
-- live check through app.live_role()), 0097 (C10a: the lead workers include Sales) and 0069
-- (H11: app.put_help_guide).
--
-- The design is docs/admin-v2/ui.md "Services (AV-14)" and "Projects (AV-15)"; what was built
-- and every departure is docs/admin-v2/as-built/U5-U6.md. The screens need two things from the
-- database, and nothing else changes: no table, no column, no policy and no grant on a table.
--
--   1. public.lead_interest_counts(p_tenant): the discipline page's "N leads" badges and its
--      "Leads by service" chart (AV-14), `{ "<service slug>": n }` over the tenant's leads that
--      are not spam and name a service. Counts only: no lead's id, name or words leave it.
--      SECURITY INVOKER, so leads' own RLS, the RESTRICTIVE live check (app.live_role(): a
--      demoted, deactivated or locked token counts nothing) and the column grant decide what
--      it counts: the lead workers (Admin, Developer, Sales) their own tenant's leads, every
--      other role nothing, `{}`. Empty, never an error, for a tenant that is not the token's.
--      The slug is folded to lower case (the column is citext), so one service is one key.
--      STABLE, search_path ''. P-14: EXECUTE revoked from PUBLIC, anon, authenticated and the
--      service role, then granted to authenticated alone (the Worker calls it with the
--      person's own client: GET /api/admin/leads/interest-counts, leads.manage).
--   2. services-and-projects: a NEW guide (revision 0) through H11's catalog, for the three
--      screens this slice rebuilds (/admin/services, /admin/disciplines, /admin/portfolio) and
--      the roles that open them (services.write, portfolio.write: Admin and Content Creator;
--      seo.entityMeta: Admin and SEO, who open them for their SEO). Its place is 42, free in
--      the catalog (40 is saving-and-publishing, 45 collections-and-faq; 62 and 85 are U11's).
--      The literal is docs/admin-v2/guides/services-and-projects.json verbatim (the spec holds
--      them equal); its numbers (4 value cards, 5 problems) are the admin schemas' caps.
--
-- The Sales boundary (C10a, U7, H13) is untouched: no relation is added, so the catalog walk
-- in rls_sales_role.test.sql needs no fixture. Releases are untouched: services and projects
-- stay staged entities whose writes go through the resource kernel; nothing here writes them.
--
-- Production as of 2026-10-23: PostgreSQL 17.6, one tenant, releases off; main holds every
-- migration through 0102, and R7 (0103), R10 (0104) and U11 (0105) merge before this one.
-- Grants are stated for both Supabase privilege regimes (README P-14). CLAUDE.md §3 (Pillar 1:
-- lead personal data stays behind its gates), §5 ("Leads: view list": Admin, Developer, and
-- Sales since C10a), §8.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing: the put re-seeds public.help_articles.
set local lock_timeout = '5s';

-- ═══ 1. public.lead_interest_counts ════════════════════════════════════════════════════════
create or replace function public.lead_interest_counts(p_tenant uuid)
  returns jsonb
  language sql stable security invoker
  set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.slug, c.n order by c.slug), '{}'::jsonb)
    from (select lower(l.service_of_interest::text) as slug, count(*)::int as n
            from public.leads l
           where l.tenant_id = app.effective_tenant_id()
             and l.tenant_id = p_tenant
             and not l.is_spam
             and l.service_of_interest is not null
           group by 1) c
$$;

comment on function public.lead_interest_counts(uuid) is
  'Admin v2 U5: how many of the tenant''s non-spam leads name each service, keyed by '
  'the service slug. Counts only. INVOKER: leads'' RLS, the live check and the column grant '
  'decide; {} for another tenant or a role that reads no lead.';

-- P-14, both regimes: a regime that grants new functions to anon, authenticated and the
-- service role is exactly what the revoke undoes. Authenticated alone executes it.
revoke all on function public.lead_interest_counts(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.lead_interest_counts(uuid) to authenticated;

-- ═══ 2. services-and-projects (new) ════════════════════════════════════════════════════════
select app.put_help_guide($guide$
{
  "slug": "services-and-projects",
  "sort_order": 42,
  "minutes": 3,
  "tags": [
    "content"
  ],
  "screens": [
    "/admin/services",
    "/admin/disciplines",
    "/admin/portfolio"
  ],
  "caps": [
    "services.write",
    "portfolio.write",
    "seo.entityMeta"
  ],
  "title": "Services and projects",
  "title_ar": "الخدمات والمشاريع",
  "body": {
    "en": [
      {
        "t": "p",
        "x": "Services are filed under disciplines, the big cards on the home page and the Services page. Projects are the case studies on Our Work. Change what you need, then press Save changes."
      },
      {
        "t": "h",
        "x": "Services"
      },
      {
        "t": "ol",
        "x": [
          "Services lists the disciplines in the order the site shows them. Drag one, or use Move up and Move down, to change the order. The eye shows or hides a discipline, and hiding one hides its services too.",
          "Open a discipline to order its services, show or hide each one, and add a service. An Admin also sees how many inquiries named each service.",
          "A service opens in tabs: Content, Case study, SEO, Leads and Publishing. It shows at most 4 value cards; three work best.",
          "The case study has its own Save. It takes at most 5 problems. A design sample says so: write the real words and switch off Placeholder to make it real."
        ]
      },
      {
        "t": "h",
        "x": "Projects"
      },
      {
        "t": "ol",
        "x": [
          "Search by title or type, or narrow the list with the chips: Featured, a sector, or Hidden for projects that are not published.",
          "Manage tags edits the sectors and opens each client. Switch a client on only when they have agreed to be named.",
          "A project opens in tabs: Basics, Case study, Breakdown & gallery, SEO and Publishing. Its pictures, films and gallery are saved with the rest, in one save.",
          "To publish, a project needs its title and type in both languages, and a poster with alt text in both languages. The Publishing tab lists what is missing."
        ]
      },
      {
        "t": "tip",
        "x": "Only an Admin can archive or delete a service, a discipline or a project. The SEO role opens them to change their SEO; everything else is read only for it."
      }
    ],
    "ar": [
      {
        "t": "p",
        "x": "تُصنَّف الخدمات تحت المجالات، وهي البطاقات الكبيرة في الصفحة الرئيسية وصفحة الخدمات. أما المشاريع فهي دراسات الحالة في صفحة أعمالنا. غيّر ما تحتاجه، ثم اضغط Save changes."
      },
      {
        "t": "h",
        "x": "الخدمات (Services)"
      },
      {
        "t": "ol",
        "x": [
          "تعرض شاشة Services المجالات بالترتيب الذي يظهر به الموقع. اسحب مجالًا، أو استخدم Move up وMove down، لتغيير الترتيب. وتُظهر العين المجال أو تخفيه، وإخفاء المجال يُخفي خدماته أيضًا.",
          "افتح مجالًا لترتيب خدماته، وإظهار كل خدمة أو إخفائها، وإضافة خدمة. ويرى المسؤول (Admin) أيضًا عدد الاستفسارات التي ذكرت كل خدمة.",
          "تُفتح الخدمة في تبويبات: Content وCase study وSEO وLeads وPublishing. وتعرض 4 بطاقات قيمة على الأكثر، وثلاث هي الأفضل.",
          "لدراسة الحالة زر Save خاص بها، وتتسع لـ 5 مشكلات على الأكثر. ونموذج التصميم يقول ذلك: اكتب الكلمات الحقيقية وأطفئ Placeholder لجعله حقيقيًا."
        ]
      },
      {
        "t": "h",
        "x": "المشاريع (Projects)"
      },
      {
        "t": "ol",
        "x": [
          "ابحث بالعنوان أو النوع، أو ضيّق القائمة بالشرائح: Featured، أو قطاع، أو Hidden للمشاريع غير المنشورة.",
          "يعدّل Manage tags القطاعات ويفتح كل عميل. لا تشغّل العميل إلا إذا وافق على ذكر اسمه.",
          "يُفتح المشروع في تبويبات: Basics وCase study وBreakdown & gallery وSEO وPublishing. وتُحفظ صوره وأفلامه ومعرضه مع الباقي، في حفظ واحد.",
          "ليُنشر المشروع يحتاج إلى عنوانه ونوعه باللغتين، وإلى صورة غلاف بنص بديل باللغتين. ويسرد تبويب Publishing ما ينقص."
        ]
      },
      {
        "t": "tip",
        "x": "لا يستطيع أرشفة خدمة أو مجال أو مشروع أو حذفها إلا المسؤول (Admin). ويفتحها دور SEO لتغيير بيانات SEO الخاصة بها، وكل ما عدا ذلك للقراءة فقط بالنسبة له."
      }
    ]
  }
}
$guide$::jsonb, 0);

-- ═══ Postconditions ════════════════════════════════════════════════════════════════════════
do $$
declare
  v_fn constant regprocedure := to_regprocedure('public.lead_interest_counts(uuid)');
  v_bad text;
  p text;
begin
  -- ---- 1. the counts: an invoker, stable, search path empty, jsonb ---------------------------
  if v_fn is null then
    raise exception 'U5+U6: public.lead_interest_counts(uuid) is missing';
  end if;
  if exists (select 1 from pg_proc where oid = v_fn and (prosecdef or provolatile <> 's')) then
    raise exception 'U5+U6: public.lead_interest_counts must be SECURITY INVOKER and STABLE';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = v_fn
                    and (proconfig @> array['search_path=""'] or proconfig @> array['search_path='])) then
    raise exception 'U5+U6: public.lead_interest_counts must set search_path = ''''';
  end if;
  if (select prorettype from pg_proc where oid = v_fn) <> 'jsonb'::regtype then
    raise exception 'U5+U6: public.lead_interest_counts must return jsonb';
  end if;

  -- ---- its callers: authenticated alone. No ACL entry for PUBLIC (grantee 0), and neither
  -- anon nor the service role holds EXECUTE through any path.
  if not has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception 'U5+U6: authenticated must execute public.lead_interest_counts';
  end if;
  foreach p in array array['anon', 'service_role'] loop
    if has_function_privilege(p, v_fn, 'execute') then
      raise exception 'U5+U6: % may execute public.lead_interest_counts', p;
    end if;
  end loop;
  if exists (select 1 from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) a
              where pr.oid = v_fn and a.grantee = 0) then
    raise exception 'U5+U6: PUBLIC may execute public.lead_interest_counts';
  end if;
  if exists (select 1 from pg_proc pr, aclexplode(pr.proacl) a
              where pr.oid = v_fn and a.grantee <> pr.proowner
                and a.grantee <> 'authenticated'::regrole::oid) then
    raise exception 'U5+U6: public.lead_interest_counts is granted to a role other than authenticated';
  end if;

  -- ---- what it reads stays readable by the staff token through the column grant, and no
  -- gated column is reached: the three columns are granted (0033, 0034), the table is not.
  if not (has_column_privilege('authenticated', 'public.leads', 'tenant_id', 'select')
          and has_column_privilege('authenticated', 'public.leads', 'service_of_interest', 'select')
          and has_column_privilege('authenticated', 'public.leads', 'is_spam', 'select')) then
    raise exception 'U5+U6: authenticated must read leads.tenant_id, service_of_interest and is_spam';
  end if;
  if has_table_privilege('authenticated', 'public.leads', 'select') then
    raise exception 'U5+U6: authenticated must read leads through the column grant, never table-wide';
  end if;

  -- ---- 2. the guide: in the catalog at revision 1 (new), its place, caps and screens -------
  if not exists (select 1 from app.help_guide_catalog
                  where slug = 'services-and-projects' and revision = 1 and sort_order = 42
                    and title = 'Services and projects'
                    and caps = array['services.write', 'portfolio.write', 'seo.entityMeta']
                    and screens = array['/admin/services', '/admin/disciplines', '/admin/portfolio']) then
    raise exception 'U5+U6: the catalog must hold services-and-projects at revision 1, place 42';
  end if;
  if (select count(*) from app.help_guide_catalog where sort_order = 42) <> 1 then
    raise exception 'U5+U6: place 42 must hold one guide';
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from public.tenants t
   where not exists (select 1 from public.help_articles h
                      where h.tenant_id = t.id and h.slug = 'services-and-projects'
                        and h.sort_order = 42 and h.title = 'Services and projects');
  if v_bad is not null then
    raise exception 'U5+U6: tenants without the services-and-projects guide: %', v_bad;
  end if;

  -- ---- 3. no API role gained anything on the help machinery -------------------------------
  if has_function_privilege('anon', 'app.help_article_set()', 'execute')
     or has_function_privilege('authenticated', 'app.help_article_set()', 'execute')
     or has_function_privilege('service_role', 'app.help_article_set()', 'execute')
     or has_function_privilege('anon', 'app.seed_help_articles(uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.seed_help_articles(uuid)', 'execute')
     or has_function_privilege('service_role', 'app.seed_help_articles(uuid)', 'execute')
     or has_table_privilege('authenticated', 'app.help_guide_catalog', 'select')
     or has_table_privilege('anon', 'app.help_guide_catalog', 'select') then
    raise exception 'U5+U6: an API role may read the help set, the catalog or seed guides';
  end if;
end $$;
