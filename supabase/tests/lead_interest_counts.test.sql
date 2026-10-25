-- pgTAP: the Services area's lead counts and its guide (0111, Admin v2 U5 + U6).
-- Run with `supabase test db`.
--
-- public.lead_interest_counts(p_tenant) runs as the caller (SECURITY INVOKER), so leads' RLS,
-- the RESTRICTIVE live check (app.live_role()) and the column grant decide what it counts: the
-- lead workers (admin, developer, sales) count their own tenant's non-spam leads by the
-- service they name, every other role counts nothing, a stale token (demoted, deactivated,
-- locked) nothing, and another tenant is never counted. Counts only: the answer is an object
-- of slugs to numbers. Then the function's shape and callers, and the new guide.

begin;
select plan(24);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'sales@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'inactive@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'locked@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'sales', true, null, 'Sami'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  -- Stale tokens: a developer token whose profile is now SEO, one deactivated, one locked.
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null, 'Demoted'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'developer', false, null, 'Gone'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-000000000001', 'developer', true, now() + interval '1 hour', 'Locked');

create function _stage(p_tid text, p_key text) returns uuid language sql as $$
  select id from public.lead_stages where tenant_id = p_tid::uuid and key = p_key
$$;

-- T1: two leads for pgu5-logo (one spelled in capitals: the column is citext), one for
-- pgu5-motion, a "help me choose" lead naming no service, and two spam leads (one naming
-- pgu5-logo) that no count includes. T2: one lead for pgu5-logo.
insert into public.leads (id, tenant_id, name, email_enc, message, created_at, source, channel,
                          stage_id, is_spam, service_of_interest, discipline_of_interest) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'Sara', 'x',
   'A logo', now() - interval '5 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), false, 'pgu5-logo', null),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'Omar', 'x',
   'Another logo', now() - interval '4 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'won'), false, 'PGU5-Logo', null),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000001', 'Lina', 'x',
   'A motion piece', now() - interval '3 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'contacted'), false, 'pgu5-motion', null),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000001', 'Huda', 'x',
   'Help me choose', now() - interval '2 hours', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), false, null, 'branding'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-000000000001', 'Spam', 'x',
   'cheap watches', now() - interval '1 hour', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), true, 'pgu5-logo', null),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-000000000001', 'Spam 2', 'x',
   'cheap shoes', now() - interval '30 minutes', 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-000000000001', 'new'), true, null, null),
  ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000ff', 'Other', 'x',
   'Other tenant', now(), 'web_form', 'unknown',
   _stage('00000000-0000-0000-0000-0000000000ff', 'new'), false, 'pgu5-logo', null);

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

create function _t1() returns jsonb language sql as $$
  select public.lead_interest_counts('00000000-0000-0000-0000-000000000001')
$$;
create function _t2() returns jsonb language sql as $$
  select public.lead_interest_counts('00000000-0000-0000-0000-0000000000ff')
$$;

-- ---- The lead workers count their own tenant ---------------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{"pgu5-logo": 2, "pgu5-motion": 1}'::jsonb,
  'admin counts its tenant''s non-spam leads by service: capitals folded, spam and no-service leads left out');
select is(_t2(), '{}'::jsonb, 'admin naming another tenant counts nothing');

select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{"pgu5-logo": 2, "pgu5-motion": 1}'::jsonb, 'developer (leads.manage) counts the same');

select _as('00000000-0000-0000-0000-0000000000b1', 'sales', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{"pgu5-logo": 2, "pgu5-motion": 1}'::jsonb, 'sales (leads.manage, C10a) counts the same');

-- ---- Every other role counts nothing -----------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{}'::jsonb, 'content_creator reads no lead, so counts nothing');

select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{}'::jsonb, 'seo reads no lead, so counts nothing');

select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(_t1(), '{}'::jsonb, 'another tenant''s admin naming this tenant counts nothing (other_tenant)');
select is(_t2(), '{"pgu5-logo": 1}'::jsonb, 'and counts its own tenant''s leads only');

-- ---- Stale tokens: the RESTRICTIVE live check reads the profile at query time -------------------
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{}'::jsonb, 'a developer token whose profile was demoted to seo counts nothing');
select _as('00000000-0000-0000-0000-0000000000d3', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{}'::jsonb, 'a deactivated developer counts nothing');
select _as('00000000-0000-0000-0000-0000000000d4', 'developer', '00000000-0000-0000-0000-000000000001');
select is(_t1(), '{}'::jsonb, 'a locked developer counts nothing');

-- A signed-in token with no role claim (no caller sends one) counts nothing either.
select _as(null, null, null);
select is(_t1(), '{}'::jsonb, 'an authenticated token with no role claim counts nothing');

-- ---- Counts only: every value a whole number, every key a slug the leads name -----------------
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select ok((select bool_and(jsonb_typeof(v) = 'number') from jsonb_each(_t1()) e(k, v))
          and (select bool_and(k ~ '^[a-z0-9-]+$') from jsonb_each(_t1()) e(k, v)),
  'the answer is slugs to numbers, nothing else');

-- ---- anon: no EXECUTE ---------------------------------------------------------------------------
reset role;
set local role anon;
select _as(null, null, null);
select throws_ok($$ select public.lead_interest_counts('00000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'anon cannot call it');

-- ---- The function: an invoker, stable, search path empty; authenticated alone executes it ------
reset role;
select ok(not (select prosecdef from pg_proc where oid = 'public.lead_interest_counts(uuid)'::regprocedure),
  'SECURITY INVOKER: RLS and the live check decide');
select is((select provolatile::text from pg_proc where oid = 'public.lead_interest_counts(uuid)'::regprocedure),
  's', 'STABLE');
select ok((select proconfig @> array['search_path=""'] or proconfig @> array['search_path=']
             from pg_proc where oid = 'public.lead_interest_counts(uuid)'::regprocedure),
  'search_path is empty');
select ok(has_function_privilege('authenticated', 'public.lead_interest_counts(uuid)', 'execute'),
  'authenticated executes it');
select ok(not has_function_privilege('anon', 'public.lead_interest_counts(uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.lead_interest_counts(uuid)', 'execute'),
  'neither anon nor the service role does');
select ok(not exists (select 1 from pg_proc pr,
                        aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) a
                       where pr.oid = 'public.lead_interest_counts(uuid)'::regprocedure
                         and a.grantee = 0),
  'PUBLIC holds no EXECUTE');

-- ---- The guide -------------------------------------------------------------------------------------
select ok(exists (select 1 from app.help_guide_catalog
                   where slug = 'services-and-projects' and revision >= 1 and sort_order = 42
                     and caps = array['services.write', 'portfolio.write', 'seo.entityMeta']
                     and screens = array['/admin/services', '/admin/disciplines', '/admin/portfolio']),
  'the catalog holds services-and-projects at place 42, for the three screens');
select ok(exists (select 1 from public.help_articles
                   where tenant_id = '00000000-0000-0000-0000-000000000001'
                     and slug = 'services-and-projects'
                     and jsonb_array_length(body -> 'en') = jsonb_array_length(body -> 'ar')),
  'a tenant made after the migration holds the guide, English and Arabic block for block');
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.help_articles where slug = 'services-and-projects'), 1,
  'seo reads it in its tenant (it opens the screens for their SEO)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.help_articles
            where slug = 'services-and-projects'
              and tenant_id = '00000000-0000-0000-0000-000000000001'), 0,
  'another tenant''s admin reads none of this tenant''s copy');
reset role;

select * from finish();
rollback;
