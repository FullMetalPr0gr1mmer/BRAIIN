-- pgTAP: the Sales role (0096 + 0097, Admin v2 C10a, owner decision A4). Run with
-- `supabase test db`.
--
-- Sales is the first signed-in principal that is not CMS staff, so this file proves what
-- it may reach from both sides:
--   1. the catalog: 'sales' is in app_role; app.is_staff() still names four roles and
--      app.is_member() five; every capability helper answers ROLE_CAPS for every enum value
--      (a literal copy of CLAUDE.md §5); audit_insert, the non-staff block (0097's three
--      tables and 0098's faq_items) and the sample lock read as written;
--   2. the CRM: a live Sales token reads and works leads (the stages, the timeline, the
--      settings, the people it may assign to) through RLS and the pipeline's column grant,
--      and writes nothing else of a lead: no insert, no delete, no legacy status, no
--      ciphertext, no notes table;
--   3. everything else, FROM THE CATALOG: for every relation in public that `authenticated`
--      can read at all, outside the CRM and the member's own rows, a Sales token reads no
--      more rows than anon, and wherever it reads a row it reads no column anon cannot read
--      (disciplines is the one named exception, 0097 §4 says why). The fixtures give every
--      relation `authenticated` holds more of than anon at least one row in the Sales tenant,
--      and a test fails when one has none THERE (rows of another tenant, seed.sql's, prove
--      nothing about this comparison; a view with no tenant_id column is counted as an Admin
--      of that tenant reads it), so a new staff-only table cannot pass by being empty; a
--      relation with no fixture would be named with its reason (_no_fixture: none since H13,
--      whose 0100_attention_staff.sql made the attention list answer CMS staff only); the FAQ
--      (0098), the block's fourth table, and the attention list are also asserted on their
--      own;
--   4. the member's own rows (its profile, its preferences, its tenant, the guides, its
--      role's dashboard preset), the stats and the team note analytics.read gives it, the password fence (U14b's 0061: a Sales token reads
--      no section of a locked page), the definers it may call (the people directory gives
--      it the assignable lead workers only), its audit rows (its own, never a colleague's
--      name), and the sample lock's trusted context (no role claim);
--   5. stale Sales tokens (demoted, deactivated, locked) and another tenant's Sales read no
--      lead, no timeline and nobody in the directory.

begin;
select plan(66);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()): anon and Sales then read one tenant.
insert into public.tenants (id, name, created_at) values
  ('93000000-0000-0000-0000-000000000001', 'Sales T1', '2000-01-01T00:00:00Z'),
  ('93000000-0000-0000-0000-0000000000ff', 'Sales T2', '2000-01-02T00:00:00Z');

insert into auth.users (id, email) values
  ('93000000-0000-0000-0000-0000000000a1', 'c10a-admin@example.test'),
  ('93000000-0000-0000-0000-0000000000c1', 'c10a-creator@example.test'),
  ('93000000-0000-0000-0000-0000000000e1', 'c10a-seo@example.test'),
  ('93000000-0000-0000-0000-0000000000d1', 'c10a-developer@example.test'),
  ('93000000-0000-0000-0000-0000000000d2', 'c10a-locked-developer@example.test'),
  ('93000000-0000-0000-0000-0000000000b1', 'c10a-sales@example.test'),
  ('93000000-0000-0000-0000-0000000000b2', 'c10a-demoted-sales@example.test'),
  ('93000000-0000-0000-0000-0000000000b3', 'c10a-inactive-sales@example.test'),
  ('93000000-0000-0000-0000-0000000000b4', 'c10a-locked-sales@example.test'),
  ('93000000-0000-0000-0000-0000000000b5', 'c10a-other-sales@example.test'),
  ('93000000-0000-0000-0000-0000000000f1', 'c10a-other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('93000000-0000-0000-0000-0000000000a1', '93000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  ('93000000-0000-0000-0000-0000000000c1', '93000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('93000000-0000-0000-0000-0000000000e1', '93000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('93000000-0000-0000-0000-0000000000d1', '93000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('93000000-0000-0000-0000-0000000000d2', '93000000-0000-0000-0000-000000000001', 'developer', true,
   now() + interval '10 minutes', 'Locked Dev'),
  ('93000000-0000-0000-0000-0000000000b1', '93000000-0000-0000-0000-000000000001', 'sales', true, null, 'Sami'),
  -- Stale: each token below still says sales.
  ('93000000-0000-0000-0000-0000000000b2', '93000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Demoted'),
  ('93000000-0000-0000-0000-0000000000b3', '93000000-0000-0000-0000-000000000001', 'sales', false, null, 'Gone'),
  ('93000000-0000-0000-0000-0000000000b4', '93000000-0000-0000-0000-000000000001', 'sales', true,
   now() + interval '10 minutes', 'Locked'),
  ('93000000-0000-0000-0000-0000000000b5', '93000000-0000-0000-0000-0000000000ff', 'sales', true, null, 'Other'),
  ('93000000-0000-0000-0000-0000000000f1', '93000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris');

-- Public content anon reads, and its staff-only twins.
insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('93000000-0000-0000-0000-00000000d001', '93000000-0000-0000-0000-000000000001', 'c10a-disc',
   '{"en":"Discipline","ar":"تخصص"}', 'published');
insert into public.services (id, tenant_id, slug, title, status, discipline_id) values
  ('93000000-0000-0000-0000-00000000e001', '93000000-0000-0000-0000-000000000001', 'c10a-svc',
   '{"en":"Service","ar":"خدمة"}', 'published', '93000000-0000-0000-0000-00000000d001'),
  ('93000000-0000-0000-0000-00000000e002', '93000000-0000-0000-0000-000000000001', 'c10a-svc-draft',
   '{"en":"Draft","ar":"مسودة"}', 'draft', null);
insert into public.service_cases (tenant_id, service_id, title, status) values
  ('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-00000000e001',
   '{"en":"Case","ar":"حالة"}', 'published');
insert into public.testimonials (id, tenant_id, slug, quote, author_name, status, consent_obtained_at,
                                 consent_reference) values
  ('93000000-0000-0000-0000-00000000f001', '93000000-0000-0000-0000-000000000001', 'c10a-quote',
   '{"en":"Great","ar":"رائع"}', '{"en":"Huda","ar":"هدى"}', 'published', now(), 'signed form 7');
insert into public.pages (id, tenant_id, slug, title, status) values
  ('93000000-0000-0000-0000-00000000a001', '93000000-0000-0000-0000-000000000001', 'about',
   '{"en":"About","ar":"من نحن"}', 'published'),
  ('93000000-0000-0000-0000-00000000a002', '93000000-0000-0000-0000-000000000001', 'contact',
   '{"en":"Contact","ar":"تواصل"}', 'published');
insert into public.media_assets (id, tenant_id, kind, provider, storage_path, mime_type, width,
                                 height, folder, alt) values
  ('93000000-0000-4000-8000-000000000001', '93000000-0000-0000-0000-000000000001', 'image', 'static',
   'stills/work/c10a-1.jpg', 'image/jpeg', 1280, 720, 'stills', '{"en":"one","ar":"واحد"}');
insert into public.page_sections (id, tenant_id, page_id, type, content, visible, sort_order) values
  ('93000000-0000-0000-0000-0000000051a1', '93000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-00000000a001', 'slogan',
   '{"body":{"en":"secret words"},"mediaId":"93000000-0000-4000-8000-000000000001"}', true, 10),
  ('93000000-0000-0000-0000-0000000051a2', '93000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-00000000a002', 'slogan', '{"body":{"en":"open words"}}', true, 10);
-- The FAQ (0098, U7): a published question anon reads, and a draft only staff read.
insert into public.faq_items (id, tenant_id, question, answer, status, sort_order) values
  ('93000000-0000-0000-0000-00000000fa01', '93000000-0000-0000-0000-000000000001',
   '{"en":"Asked?","ar":"سؤال؟"}', '{"en":"Answered.","ar":"جواب."}', 'published', 10),
  ('93000000-0000-0000-0000-00000000fa02', '93000000-0000-0000-0000-000000000001',
   '{"en":"Drafted?","ar":"مسودة؟"}', '{"en":"Not yet.","ar":"ليس بعد."}', 'draft', 20);
-- The attention list (0100_attention_staff.sql, H13): a published post with no cover, which
-- anon reads, gives the list one row (missing_image) in this tenant, so its comparison is
-- not of nothing: CMS staff read it, a Sales token none.
insert into public.blog_posts (id, tenant_id, slug, title, status) values
  ('93000000-0000-0000-0000-00000000b0a1', '93000000-0000-0000-0000-000000000001', 'h13-post',
   '{"en":"Post","ar":"مقال"}', 'published');

-- Staff-only rows, one at least in each relation `authenticated` holds more of than anon.
insert into public.site_settings (tenant_id) values ('93000000-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.site_integrations (tenant_id) values ('93000000-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.ai_config (tenant_id) values ('93000000-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.admin_security_settings (tenant_id) values ('93000000-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.admin_role_defaults (tenant_id, role) values
  ('93000000-0000-0000-0000-000000000001', 'admin'), ('93000000-0000-0000-0000-000000000001', 'sales'),
  ('93000000-0000-0000-0000-0000000000ff', 'sales') on conflict do nothing;
insert into public.team_notes (tenant_id) values ('93000000-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.health_probes (tenant_id, kind, state) values ('93000000-0000-0000-0000-000000000001', 'uptime', 'ok') on conflict do nothing;
insert into public.redirects (tenant_id, source_path, target_path) values ('93000000-0000-0000-0000-000000000001', '/c10a-old', '/');
insert into public.custom_themes (tenant_id, name) values ('93000000-0000-0000-0000-000000000001', 'C10a');
insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot)
  values ('93000000-0000-0000-0000-000000000001', 'service', '93000000-0000-0000-0000-00000000e001', 99, '{}');
insert into public.system_logs (tenant_id, level, message) values ('93000000-0000-0000-0000-000000000001', 'info', 'c10a');
insert into public.consent_log (tenant_id, subject_hash, categories, policy_version)
  values ('93000000-0000-0000-0000-000000000001', 'c10a', '{}', '1');
insert into public.notification_log (tenant_id, channel, status) values ('93000000-0000-0000-0000-000000000001', 'inbox', 'queued');
insert into public.search_queries (tenant_id, q) values ('93000000-0000-0000-0000-000000000001', 'logo');
insert into public.rollup_daily_pageviews (tenant_id, day, path, views) values ('93000000-0000-0000-0000-000000000001', current_date, '/', 3);
-- The stats' rollups and goals (0071, Admin v2 G1): analytics.read reads them.
insert into public.rollup_daily_visits (tenant_id, day, visits, one_page_visits, visit_views, service_visits,
                                        service_inquiry_visits, inquiry_visits)
  values ('93000000-0000-0000-0000-000000000001', current_date, 4, 1, 6, 2, 1, 1);
insert into public.rollup_daily_events (tenant_id, day, event_type, key, events, visits)
  values ('93000000-0000-0000-0000-000000000001', current_date, 'cta_click', '*', 2, 2);
insert into public.rollup_hourly_pageviews (tenant_id, hour, views)
  values ('93000000-0000-0000-0000-000000000001', date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC', 3);
insert into public.rollup_minute_activity (tenant_id, minute, views, active_visits)
  values ('93000000-0000-0000-0000-000000000001', date_trunc('minute', now() at time zone 'UTC') at time zone 'UTC', 1, 1);
insert into public.analytics_goals (tenant_id, name, metric, target)
  values ('93000000-0000-0000-0000-000000000001', 'Visits this month', 'visits', 100);
insert into public.rollup_daily_vitals (tenant_id, day, path, metric, p75, samples, hist)
  values ('93000000-0000-0000-0000-000000000001', current_date, '/', 'LCP', 1200, 3,
          array_fill(0, array[24]) || array[3]);
select app.ensure_telemetry_partitions(1);
insert into public.analytics_events (tenant_id, event_type, path) values ('93000000-0000-0000-0000-000000000001', 'pageview', '/');
insert into public.web_vitals (tenant_id, metric, value, path) values ('93000000-0000-0000-0000-000000000001', 'LCP', 1200, '/');
insert into public.audit_log (tenant_id, actor_id, actor_role, action) values
  ('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-0000000000a1', 'admin', 'c10a.fixture');
insert into public.admin_user_prefs (user_id, tenant_id) values
  ('93000000-0000-0000-0000-0000000000a1', '93000000-0000-0000-0000-000000000001'),
  ('93000000-0000-0000-0000-0000000000b1', '93000000-0000-0000-0000-000000000001');
insert into public.page_visibility (tenant_id, page_id, mode) values
  ('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-00000000a002', 'public');
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload) values
  ('93000000-0000-4000-8000-000000000701', '93000000-0000-0000-0000-000000000001', 'service',
   '93000000-0000-0000-0000-00000000e001', 'update', '{"title":{"en":"New","ar":"جديد"}}');
insert into public.content_releases (id, tenant_id, status) values
  ('93000000-0000-0000-000d-000000000001', '93000000-0000-0000-0000-000000000001', 'applying');
insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after) values
  ('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-000d-000000000001', 'service',
   '93000000-0000-0000-0000-00000000e001', 'update', '{"title":{"en":"Old"}}', '{"title":{"en":"New"}}');
insert into public.job_applications (tenant_id, name, email_enc, phone_enc, city, role, experience,
  work_type, availability, skills, portfolio_url, message, consent_version, retention_delete_after) values
  ('93000000-0000-0000-0000-000000000001', 'Applicant', 'ciphertext', 'ciphertext', 'Jeddah',
   'Motion designer', '1-3', 'freelance', 'month', array['animation'], 'https://example.com/work',
   'My best piece', '2026-09-30', now() + interval '12 months');
insert into public.leads (id, tenant_id, name, email_enc, message, internal_notes) values
  ('93000000-0000-0000-0000-0000000000aa', '93000000-0000-0000-0000-000000000001', 'Lead', '\x00', 'hi', 'Called back'),
  ('93000000-0000-0000-0000-0000000000ab', '93000000-0000-0000-0000-0000000000ff', 'Other', '\x00', 'hi', null);

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true
  )
$$;
create function _sales() returns void language sql as $$
  select _as('93000000-0000-0000-0000-0000000000b1', 'sales', '93000000-0000-0000-0000-000000000001')
$$;

-- A statement as the CURRENT role: 'ok:<rows>' or the SQLSTATE it raised.
create function _run(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;

-- One value as the CURRENT role: its text, '(null)', or the SQLSTATE it raised.
create function _val(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, '(null)');
exception when others then
  return sqlstate;
end $$;

-- The rows of a relation the CURRENT role reads; no privilege at all reads none.
create function _count(p_rel regclass) returns bigint language plpgsql as $$
declare
  n bigint;
begin
  execute format('select count(*) from %s', p_rel) into n;
  return n;
exception when insufficient_privilege then
  return 0;
end $$;

-- The relations compared: every table, view and materialised view in public that
-- `authenticated` can read any column of (partitions are read through their parent).
create function _readable() returns table (rel regclass, name text) language sql stable as $$
  select c.oid::regclass, c.relname::text
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
     and not c.relispartition
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT'))
$$;

-- The columns `authenticated` reads that anon does not, as one string ('' for none).
create function _extra_columns(p_rel regclass) returns text language sql stable as $$
  select coalesce(string_agg(a.attname::text, ',' order by a.attnum), '')
    from pg_attribute a
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', p_rel, a.attnum, 'SELECT')
     and not has_column_privilege('anon', p_rel, a.attnum, 'SELECT')
$$;

-- Whether a relation has a tenant_id column (the catalog only, no read of the relation).
create function _has_tenant(p_rel regclass) returns boolean language sql stable as $$
  select exists (select 1 from pg_attribute a
                  where a.attrelid = p_rel and a.attname = 'tenant_id' and a.attnum > 0
                    and not a.attisdropped)
$$;

-- The rows a relation holds IN THE SALES TENANT (T1), read as the migration role (RLS
-- bypassed): the comparison reads one tenant, so a row of another tenant (seed.sql's launch
-- tenant included) proves nothing about it. A relation with no tenant_id column answers null
-- here and is counted as an Admin token of T1 reads it (_t1_staff, filled in section 3: the
-- RLS of the tables under it keeps T1's rows), never whole.
create function _fixture_rows(p_rel regclass) returns bigint language plpgsql as $$
declare
  n bigint;
begin
  if not _has_tenant(p_rel) then
    return null;
  end if;
  execute format('select count(*) from %s where tenant_id = %L', p_rel,
                 '93000000-0000-0000-0000-000000000001') into n;
  return n;
end $$;

-- What each principal read, relation by relation (filled below, compared after).
create temp table _seen (who text, name text, n bigint);
-- What an Admin token of T1 reads of each compared relation with no tenant_id column.
create temp table _t1_staff (name text, n bigint);

grant execute on function _as(text, text, text), _sales(), _run(text), _val(text), _count(regclass),
  _readable(), _extra_columns(regclass), _has_tenant(regclass) to anon, authenticated, service_role;
grant insert, select on _seen, _t1_staff to anon, authenticated;

-- The CRM, a member's own rows and the stats analytics.read gives: proven on their own below.
create function _not_compared() returns text[] language sql immutable as $$
  select array['leads', 'leads_safe', 'lead_stages', 'lead_events', 'crm_settings',
               'profiles', 'admin_user_prefs', 'tenants', 'help_articles',
               'admin_role_defaults', 'rollup_daily_pageviews', 'team_notes',
               'rollup_daily_visits', 'rollup_daily_events', 'rollup_hourly_pageviews',
               'rollup_minute_activity', 'analytics_goals']
$$;
grant execute on function _not_compared() to anon, authenticated;

-- Compared, but with no fixture row in T1, each for the reason on its line. None: the last,
-- dashboard_attention, has its row since H13 (0100_attention_staff.sql) answers it to CMS
-- staff only.
create function _no_fixture() returns text[] language sql immutable as $$
  select array[]::text[]
$$;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok('sales' = any (enum_range(null::public.app_role)::text[]), 'sales is an app_role (0096)');
set local role authenticated;
select _sales();
select is(app.is_staff()::text || '/' || app.is_member()::text, 'false/true',
  'a Sales token is a member, not CMS staff (app.is_staff() keeps its four roles, P-6)');
select _as('93000000-0000-0000-0000-0000000000d1', 'developer', '93000000-0000-0000-0000-000000000001');
select is(app.is_staff()::text || '/' || app.is_member()::text, 'true/true', 'a Developer token is both');
reset role;
select _as(null, null, null);
select ok(not app.is_member(), 'no role claim is no member');

-- Every helper, for every value of the enum and none: a literal copy of CLAUDE.md §5.
select is(
  (select string_agg(format('%s:%s%s%s%s%s%s%s%s%s%s', r,
            app.role_works_leads(r)::int, app.role_analytics_read(r)::int, app.role_crm_erase(r)::int,
            app.role_manages_users(r)::int, app.role_views_audit(r)::int, app.role_site_health(r)::int,
            app.role_manages_visibility(r)::int, app.role_analytics_goals(r)::int,
            app.role_crm_settings(r)::int, app.role_manages_integrations(r)::int), ' ' order by r)
     from unnest(enum_range(null::public.app_role)::text[] || array['anon']) r),
  'admin:1111111111 anon:0000000000 content_creator:0100000000 developer:1100111000 sales:1100000000 seo:0100000101',
  'each helper answers its capability for each role: Sales works leads and reads the stats, nothing else');

select is(
  (select with_check from pg_policies
    where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_insert'),
  '((tenant_id = app.effective_tenant_id()) AND app.is_member() AND (actor_id = ( SELECT auth.uid() AS uid)))',
  'audit_insert: the tenant first, a member, and the row names its writer');
select is(
  (select string_agg(tablename || ' ' || qual, ' | ' order by tablename) from pg_policies
    where schemaname = 'public' and policyname like '%\_staff\_columns' and permissive = 'RESTRICTIVE'
      and cmd = 'SELECT' and roles = '{authenticated}'),
  'faq_items ((tenant_id = app.effective_tenant_id()) AND app.is_staff()) | '
  'media_assets ((tenant_id = app.effective_tenant_id()) AND app.is_staff()) | '
  'service_cases ((tenant_id = app.effective_tenant_id()) AND app.is_staff()) | '
  'testimonials ((tenant_id = app.effective_tenant_id()) AND app.is_staff())',
  'the non-staff block: four RESTRICTIVE reads (0097''s three, the FAQ''s in 0098), the tenant first, then CMS staff');
select ok(
  not has_column_privilege('authenticated', 'public.leads', 'status', 'update')
    and not has_column_privilege('authenticated', 'public.leads', 'internal_notes', 'update')
    and has_column_privilege('authenticated', 'public.leads', 'stage_id', 'update'),
  'the legacy lead writes are withdrawn; the pipeline''s stay');
select is(
  (select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
     from pg_proc p
    where p.pronamespace in ('app'::regnamespace, 'public'::regnamespace)
      and p.prosrc ~ 'is_member\(\)' and p.proname <> 'is_member'),
  null, 'no function calls app.is_member(): it opens audit_insert and nothing else');

-- ── 2. the CRM ─────────────────────────────────────────────────────────────────
set local role authenticated;
select _sales();
select is(
  (select count(*)::int from public.leads) || '/' || (select count(*)::int from public.leads_safe)
    || '/' || (select count(*)::int from public.lead_stages) || '/' || (select count(*)::int from public.crm_settings),
  '1/1/5/1', 'Sales reads its tenant''s lead, the safe view, the five stages and the CRM settings');
select ok((select count(*) from public.lead_events where lead_id = '93000000-0000-0000-0000-0000000000aa') >= 1,
  'and the lead''s timeline');
select is(_val($$ select (public.leads_list('93000000-0000-0000-0000-000000000001', '{}') ->> 'total') $$), '1',
  'public.leads_list answers Sales (INVOKER: RLS decides)');
select is(_val($$ select internal_notes from public.leads $$), '42501',
  'the gated columns stay out of reach (0033''s column grant)');
select is(_run($$ update public.leads set is_starred = true where id = '93000000-0000-0000-0000-0000000000aa' $$),
  'ok:1', 'Sales works the pipeline through the column grant');
select is(_run($$ update public.leads set status = 'done' $$), '42501', 'but no legacy status (0097)');
select is(_run($$ update public.leads set email_enc = '\x01' $$), '42501', 'nor the ciphertext');
select is(_run($$ insert into public.leads (tenant_id, name, email_enc, message)
                  values ('93000000-0000-0000-0000-000000000001', 'x', '\x00', 'y') $$), '42501',
  'no API insert');
select is(_run($$ delete from public.leads $$), '42501', 'no API delete');
select is(_run($$ select * from public.lead_notes $$), '42501', 'no notes table (the audited route reads it)');
-- Since C9a (0091) `authenticated` holds column grants on crm_settings and lead_stages for
-- crm.settings holders, so the refusal is RLS's: Sales changes no row and adds no stage.
select is(_run($$ update public.crm_settings set sla_hours = 1 $$) || ' '
          || _run($$ update public.lead_stages set label = 'x' $$) || ' '
          || _run($$ delete from public.lead_stages $$) || ' '
          || _run($$ insert into public.lead_stages (label, label_ar, tone, kind, sort_order)
                     values ('x', 'س', 'gray', 'open', 99) $$),
  'ok:0 ok:0 ok:0 42501', 'no CRM settings or stages write (crm.settings is not Sales'', 0091)');
select is(_run($$ select public.save_lead_stages('93000000-0000-0000-0000-000000000001', '[]'::jsonb, '[]'::jsonb) $$),
  '42501', 'and the stages'' one door, save_lead_stages, refuses it in its own tenant (crm.settings)');
select is(
  (select string_agg(display_name || ':' || role, ', ' order by display_name)
     from public.crm_people('93000000-0000-0000-0000-000000000001')),
  'Amal:admin, Dana:developer, Sami:sales',
  'the people it may assign to: active, unlocked lead workers only');
select is(
  (select string_agg(display_name, ', ' order by display_name)
     from public.staff_directory('93000000-0000-0000-0000-000000000001')),
  'Amal, Dana, Sami',
  'the directory gives Sales the same, and no CMS colleague (P-7)');
reset role;

-- ── 3. everything else, from the catalog ───────────────────────────────────────
set local role anon;
select _as(null, null, null);
insert into _seen select 'anon', r.name, _count(r.rel) from _readable() r where r.name <> all (_not_compared());
reset role;
set local role authenticated;
select _sales();
insert into _seen select 'sales', r.name, _count(r.rel) from _readable() r where r.name <> all (_not_compared());
select _as('93000000-0000-0000-0000-0000000000a1', 'admin', '93000000-0000-0000-0000-000000000001');
insert into _t1_staff select r.name, _count(r.rel) from _readable() r
 where r.name <> all (_not_compared()) and not _has_tenant(r.rel);
reset role;
select _as(null, null, null);

select ok((select count(*) from _seen where who = 'sales') >= 40,
  'the comparison covers every readable relation of public outside the CRM (40 or more)');
select is(
  (select string_agg(s.name || ' ' || s.n || '>' || a.n, ', ' order by s.name)
     from _seen s join _seen a on a.name = s.name and a.who = 'anon'
    where s.who = 'sales' and s.n > a.n),
  null, 'Sales reads no more rows than anon of any relation outside the CRM');
select is(
  (select string_agg(s.name || ' [' || _extra_columns(s.name::regclass) || ']', ', ' order by s.name)
     from _seen s
    where s.who = 'sales' and s.n > 0 and _extra_columns(s.name::regclass) <> ''),
  'disciplines [scheduled_for,version,created_at,created_by,updated_by]',
  'wherever Sales reads a row it reads no column anon cannot, but disciplines'' bookkeeping (0097 §4)');
select is(
  (select string_agg(r.name, ', ' order by r.name)
     from _readable() r
    where r.name <> all (_not_compared()) and r.name <> all (_no_fixture())
      and (not has_table_privilege('anon', r.rel, 'SELECT') or _extra_columns(r.rel) <> '')
      and coalesce(_fixture_rows(r.rel), (select t.n from _t1_staff t where t.name = r.name), 0) = 0),
  null, 'every relation authenticated holds more of than anon has a row in the Sales tenant (but _no_fixture''s, named), so none passes empty');
select ok(
  (select bool_and(n > 0) from _seen
    where who = 'anon' and name in ('services', 'disciplines', 'testimonials', 'service_cases',
                                    'media_assets', 'faq_items', 'page_sections', 'pages')),
  'and anon itself reads the public fixtures, so the comparison is not of nothing');

-- The FAQ (0098, U7), the block's fourth table: anon reads the published question (T1 is
-- the launch tenant anon resolves to here), a CMS staff token of the Sales tenant reads both,
-- and a Sales token of the same tenant reads neither.
set local role authenticated;
select _as('93000000-0000-0000-0000-0000000000c1', 'content_creator', '93000000-0000-0000-0000-000000000001');
insert into _seen select 'content_creator', 'faq_items', _count('public.faq_items');
reset role;
select _as(null, null, null);
select is(
  (select string_agg(who || '=' || n, ' ' order by who) from _seen where name = 'faq_items'),
  'anon=1 content_creator=2 sales=0',
  'the FAQ: anon reads the published question, a Content Creator both, a Sales token none (faq_items_staff_columns)');

-- The attention list (0100_attention_staff.sql, H13): an Admin of the Sales tenant reads the
-- published post's missing_image row; anon (no privilege on the view) and a Sales token of
-- the same tenant read none.
select is(
  (select string_agg(who || '=' || n, ' ' order by who) from _seen where name = 'dashboard_attention')
    || ' admin=' || (select n from _t1_staff where name = 'dashboard_attention'),
  'anon=0 sales=0 admin=1',
  'the attention list: an Admin of the Sales tenant reads its one row, anon and a Sales token none (H13)');

-- ── 4. the member's own rows, the stats and the fence ──────────────────────────
set local role authenticated;
select _sales();
select is(
  (select string_agg(id::text, ',') from public.profiles) || ' / '
    || (select string_agg(user_id::text, ',') from public.admin_user_prefs) || ' / '
    || (select string_agg(id::text, ',') from public.tenants),
  '93000000-0000-0000-0000-0000000000b1 / 93000000-0000-0000-0000-0000000000b1 / 93000000-0000-0000-0000-000000000001',
  'Sales reads its own profile, its own preferences and its own tenant, nobody else''s');
select ok((select count(*) from public.help_articles) > 0,
  'Sales reads its tenant''s guides (0097: a live member; the Worker shows its own)');
select is((select sum(views)::int from public.rollup_daily_pageviews), 3,
  'analytics.read: Sales reads the page-view rollup the dashboard draws');
select is(_count('public.rollup_daily_visits') || '/' || _count('public.rollup_daily_events') || '/'
          || _count('public.rollup_hourly_pageviews') || '/' || _count('public.rollup_minute_activity')
          || '/' || _count('public.analytics_goals'),
  '1/1/1/1/1', 'and the stats'' visits, events, hours and realtime rollups and the goals (0071)');
select is(_run($$ insert into public.analytics_goals (tenant_id, name, metric, target)
                  values ('93000000-0000-0000-0000-000000000001', 'x', 'visits', 5) $$) || ' '
          || _run($$ update public.analytics_goals set target = 1 $$) || ' '
          || _run($$ delete from public.analytics_goals $$),
  '42501 ok:0 ok:0', 'but sets, changes and deletes no goal (analytics.goals is not Sales'')');
select is((select string_agg(tenant_id::text || ':' || role::text, ',') from public.admin_role_defaults),
  '93000000-0000-0000-0000-000000000001:sales',
  'Sales reads the dashboard preset an Admin saved for its role, and no other role''s (0097 §8b)');
select is((select count(*)::int from public.team_notes where tenant_id = '93000000-0000-0000-0000-000000000001'), 1,
  'analytics.read: Sales reads its tenant''s team note (0060, by the live role)');
select is(_val($$ select (public.save_team_notes('93000000-0000-0000-0000-000000000001', 'Call the new leads first', 0) ->> 'version') $$),
  '1', 'and saves it through the one door, save_team_notes (analytics.read, audited)');
select is(_val($$ select public.save_team_notes('93000000-0000-0000-0000-0000000000ff', 'x', 0)::text $$),
  '42501', 'but never another tenant''s');
select is(_count('public.rollup_daily_vitals') + _count('public.web_vitals') + _count('public.analytics_events')
          + _count('public.search_queries'), 0::bigint,
  'but not the raw telemetry, the vitals or the searches');
select is(
  _count('public.testimonials') || '/' || _count('public.service_cases') || '/' || _count('public.media_assets')
    || '/' || _count('public.disciplines') || '/' || _count('public.services'),
  '0/0/0/1/1',
  'no quote (its consent record), case study or media row; the published discipline and service anon reads');
select is(
  _count('public.site_settings') + _count('public.site_integrations') + _count('public.redirects')
    + _count('public.custom_themes') + _count('public.content_versions') + _count('public.audit_log')
    + _count('public.system_logs') + _count('public.consent_log') + _count('public.notification_log')
    + _count('public.job_applications') + _count('public.content_drafts') + _count('public.page_visibility')
    + _count('public.ai_config') + _count('public.health_probes') + _count('public.admin_security_settings'),
  0::bigint, 'none of the staff-only tables crm.md §13 lists (and the newer ones)');
reset role;

-- The password fence (0061): staff sets the password, a live Sales token then reads no
-- section of the page; anon neither.
set local role authenticated;
select _as('93000000-0000-0000-0000-0000000000a1', 'admin', '93000000-0000-0000-0000-000000000001');
select is(_val($$ select public.set_page_password('93000000-0000-0000-0000-000000000001',
                    '93000000-0000-0000-0000-00000000a001', 'correct horse battery',
                    '{"en":"Ask us","ar":"اسألنا"}')::text $$) <> '42501', true,
  'an Admin puts About behind a password');
select is((select count(*)::int from public.page_sections where page_id = '93000000-0000-0000-0000-00000000a001'), 1,
  'staff still read the locked page''s section');
select _sales();
select is((select count(*)::int from public.page_sections where page_id = '93000000-0000-0000-0000-00000000a001')
          || '/' || (select count(*)::int from public.page_sections where page_id = '93000000-0000-0000-0000-00000000a002'),
  '0/1', 'a Sales token reads no section of the locked page, and the open page''s section (U14b''s fence)');
reset role;
set local role anon;
select _as(null, null, null);
select is((select count(*)::int from public.page_sections where page_id = '93000000-0000-0000-0000-00000000a001'), 0,
  'anon neither');
reset role;

-- The definers a signed-in token may call: Sales gets nothing that is not its own.
set local role authenticated;
select _sales();
select is(_val($$ select (public.media_library('93000000-0000-0000-0000-000000000001', null, null, null, 50, 0) ->> 'total') $$),
  '0', 'the media library answers Sales empty');
select is(_val($$ select count(*)::text from public.staff_accounts('93000000-0000-0000-0000-000000000001') $$)
          in ('0', '42501'), true, 'no staff accounts');
select is(_val($$ select count(*)::text from public.audit_people('93000000-0000-0000-0000-000000000001', array['93000000-0000-0000-0000-0000000000a1']::uuid[]) $$)
          in ('0', '42501'), true, 'no audit names');
select is(_run($$ select public.transfer_ownership('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-0000000000b1') $$),
  '42501', 'no ownership transfer');
select is(_run($$ select public.set_page_password('93000000-0000-0000-0000-000000000001',
                    '93000000-0000-0000-0000-00000000a002', 'correct horse battery', '{"en":"x","ar":"س"}') $$),
  '42501', 'no page password');
select is(_run($$ select * from public.update_media_meta('93000000-0000-4000-8000-000000000001', 1, '{"tags":[]}') $$),
  '42501', 'no media metadata write');

-- Its audit rows: its own name, whatever it sends; never read back.
select is(_run($$ insert into public.audit_log (tenant_id, actor_id, actor_role, action)
                  values ('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-0000000000a1',
                          'admin', 'c10a.forged') $$), 'ok:1',
  'Sales writes an audit row (audit_insert: a member)');
select is(_count('public.audit_log'), 0::bigint, 'and reads none (audit.view is not Sales'')');
reset role;
select is(
  (select actor_id::text || ' ' || actor_role from public.audit_log where action = 'c10a.forged'),
  '93000000-0000-0000-0000-0000000000b1 sales',
  'the row names the Sales token that wrote it, never the colleague it named');
set local role authenticated;
select _as(null, 'sales', '93000000-0000-0000-0000-000000000001');
select is(_run($$ insert into public.audit_log (tenant_id, action)
                  values ('93000000-0000-0000-0000-000000000001', 'c10a.nobody') $$), '42501',
  'a token with no subject writes no audit row (the actor must be the caller)');
reset role;

-- The sample lock (0028, 0097 §5): a seed (no role claim) may flag a sample; any signed-in
-- token, staff or not, may not, the migration role with a Sales claim included.
select _as(null, null, null);
select is(_run($$ update public.testimonials set is_placeholder = true where id = '93000000-0000-0000-0000-00000000f001' $$),
  'ok:1', 'no role claim is the trusted context: the seed path flags a sample');
update public.testimonials set is_placeholder = false where id = '93000000-0000-0000-0000-00000000f001';
select _sales();
select is(_run($$ update public.testimonials set is_placeholder = true where id = '93000000-0000-0000-0000-00000000f001' $$),
  '42501', 'a Sales claim is not: the lock holds for every signed-in token (no longer "not staff")');
select _as(null, null, null);

-- ── 5. stale and foreign Sales tokens ──────────────────────────────────────────
set local role authenticated;
select _as('93000000-0000-0000-0000-0000000000b2', 'sales', '93000000-0000-0000-0000-000000000001');
select is(_count('public.leads') + _count('public.lead_events') + _count('public.help_articles')
          + (select count(*) from public.crm_people('93000000-0000-0000-0000-000000000001')), 0::bigint,
  'a demoted Sales token (the profile says content_creator) reads no lead, timeline, guide or colleague');
select is(_count('public.admin_role_defaults') + _count('public.team_notes'), 0::bigint,
  'nor its old role''s preset or the team note');
select _as('93000000-0000-0000-0000-0000000000b3', 'sales', '93000000-0000-0000-0000-000000000001');
select is(_count('public.leads') + _count('public.lead_events')
          + (select count(*) from public.crm_people('93000000-0000-0000-0000-000000000001')), 0::bigint,
  'a deactivated Sales token reads none of them');
select _as('93000000-0000-0000-0000-0000000000b4', 'sales', '93000000-0000-0000-0000-000000000001');
select is(_count('public.leads') + _count('public.lead_events')
          + (select count(*) from public.crm_people('93000000-0000-0000-0000-000000000001')), 0::bigint,
  'a locked Sales token reads none of them');
select is(_run($$ update public.leads set is_starred = false $$), 'ok:0', 'and changes no lead');
select _as('93000000-0000-0000-0000-0000000000b5', 'sales', '93000000-0000-0000-0000-0000000000ff');
select is(
  (select count(*)::int from public.leads where tenant_id = '93000000-0000-0000-0000-000000000001')
    + (select count(*)::int from public.crm_people('93000000-0000-0000-0000-000000000001')),
  0, 'another tenant''s Sales reads none of T1''s leads or people');
select is((select count(*)::int from public.leads), 1, 'and its own tenant''s lead only');
select is((select string_agg(tenant_id::text, ',') from public.admin_role_defaults),
  '93000000-0000-0000-0000-0000000000ff', 'and its own tenant''s preset only');
reset role;

select * from finish();
rollback;
