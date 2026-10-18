-- pgTAP: website stats v2, goals (migration 0071, Admin v2 G1c; CLAUDE.md §5 "Analytics
-- goals — set"). Run with `supabase test db`.
--
--   • analytics.goals: Admin and SEO create, change (the version moves; a stale version
--     changes nothing) and delete goals; Content Creator and Developer read them and are
--     refused every write (RLS); anon is refused at the grant layer; another tenant's Admin
--     cannot place a goal in this tenant (WITH CHECK) and reads none of its goals.
--   • the live layer: a token that still says seo whose profile is now content_creator
--     cannot create, change or delete; a deactivated or a locked Admin reads nothing.
--   • the rules: at most 20 goals per tenant (23514, named analytics_goals_limit); the name,
--     the metric and click pairing and the target are CHECKed.
--   • goal_progress: this calendar month in UTC days, from the rollups; inquiries for lead
--     workers only (Admin, Developer), null for SEO and Content Creator; another tenant gets
--     the empty shape.
--   • the helper answers analytics.goals; the grants are stated (table and column).
--
-- Fixtures are two tenants of this file's own.

begin;
select plan(43);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('71c00000-0000-0000-0000-000000000001', 'G1c one'),
  ('71c00000-0000-0000-0000-0000000000ff', 'G1c two');
insert into auth.users (id, email) values
  ('71c00000-0000-0000-0000-0000000000a1', 'g1c-admin@example.test'),
  ('71c00000-0000-0000-0000-0000000000e1', 'g1c-seo@example.test'),
  ('71c00000-0000-0000-0000-0000000000c1', 'g1c-creator@example.test'),
  ('71c00000-0000-0000-0000-0000000000d1', 'g1c-developer@example.test'),
  ('71c00000-0000-0000-0000-0000000000e2', 'g1c-demoted@example.test'),
  ('71c00000-0000-0000-0000-0000000000a3', 'g1c-inactive@example.test'),
  ('71c00000-0000-0000-0000-0000000000a4', 'g1c-locked@example.test'),
  ('71c00000-0000-0000-0000-0000000000f1', 'g1c-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('71c00000-0000-0000-0000-0000000000a1', '71c00000-0000-0000-0000-000000000001', 'admin', true, null),
  ('71c00000-0000-0000-0000-0000000000e1', '71c00000-0000-0000-0000-000000000001', 'seo', true, null),
  ('71c00000-0000-0000-0000-0000000000c1', '71c00000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('71c00000-0000-0000-0000-0000000000d1', '71c00000-0000-0000-0000-000000000001', 'developer', true, null),
  -- Stale: the token below still says seo.
  ('71c00000-0000-0000-0000-0000000000e2', '71c00000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('71c00000-0000-0000-0000-0000000000a3', '71c00000-0000-0000-0000-000000000001', 'admin', false, null),
  ('71c00000-0000-0000-0000-0000000000a4', '71c00000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes'),
  ('71c00000-0000-0000-0000-0000000000f1', '71c00000-0000-0000-0000-0000000000ff', 'admin', true, null);

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;
-- Goals of tenant one, as the CURRENT role.
create function _seen() returns int language sql as $$
  select count(*)::int from public.analytics_goals where tenant_id = '71c00000-0000-0000-0000-000000000001'
$$;
create function _goal(p_name text) returns uuid language sql security definer as $$
  select id from public.analytics_goals where name = p_name
$$;

-- What the month holds (UTC days): visits today and on the 1st, and a visit last month that
-- must not count; one click key; a lead this month, a spam lead, and a lead last month.
-- (On the 1st of a month "today" is the 1st: its row is then the 1st's, and the month holds 10.)
insert into public.rollup_daily_visits (tenant_id, day, visits, one_page_visits, visit_views,
                                        service_visits, service_inquiry_visits, inquiry_visits) values
  ('71c00000-0000-0000-0000-000000000001', date_trunc('month', now() at time zone 'UTC')::date, 10, 1, 20, 4, 2, 3),
  ('71c00000-0000-0000-0000-000000000001', date_trunc('month', now() at time zone 'UTC')::date - 1, 100, 0, 100, 0, 0, 0);
insert into public.rollup_daily_visits (tenant_id, day, visits, one_page_visits, visit_views,
                                        service_visits, service_inquiry_visits, inquiry_visits)
select '71c00000-0000-0000-0000-000000000001', (now() at time zone 'UTC')::date, 5, 1, 9, 1, 0, 1
 where (now() at time zone 'UTC')::date <> date_trunc('month', now() at time zone 'UTC')::date;
create function _month_visits() returns int language sql stable as $$
  select case when (now() at time zone 'UTC')::date = date_trunc('month', now() at time zone 'UTC')::date
              then 10 else 15 end
$$;
insert into public.rollup_daily_events (tenant_id, day, event_type, key, events, visits) values
  ('71c00000-0000-0000-0000-000000000001', (now() at time zone 'UTC')::date, 'cta_click', 'whatsapp', 7, 5),
  ('71c00000-0000-0000-0000-000000000001', (now() at time zone 'UTC')::date, 'cta_click', '*', 9, 6);
insert into public.leads (tenant_id, name, email_enc, message, created_at, is_spam) values
  ('71c00000-0000-0000-0000-000000000001', 'A', '\x00', 'm', now(), false),
  ('71c00000-0000-0000-0000-000000000001', 'B', '\x00', 'm', now(), true),
  ('71c00000-0000-0000-0000-000000000001', 'C', '\x00', 'm',
   (date_trunc('month', now() at time zone 'UTC') - interval '1 day') at time zone 'UTC', false);

-- ── 1. Admin and SEO write; Content Creator and Developer read ───────────────────────
set local role authenticated;
select _as('71c00000-0000-0000-0000-0000000000a1', 'admin', '71c00000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Visits this month', 'visits', 100) $$,
  'admin adds a goal');
select is((select created_by::text from public.analytics_goals where name = 'Visits this month'),
  '71c00000-0000-0000-0000-0000000000a1', 'the actor is stamped from the token');
select _as('71c00000-0000-0000-0000-0000000000e1', 'seo', '71c00000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, cta, target)
     values ('71c00000-0000-0000-0000-000000000001', 'WhatsApp clicks', 'cta', 'whatsapp', 20) $$,
  'seo adds a goal that counts a click');
select lives_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Inquiries', 'inquiries', 10) $$,
  'and one that counts inquiries');
select _as('71c00000-0000-0000-0000-0000000000c1', 'content_creator', '71c00000-0000-0000-0000-000000000001');
select is(_seen(), 3, 'content_creator reads the goals (analytics.read)');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Mine', 'visits', 1) $$,
  '42501', null, 'content_creator cannot add one (RLS)');
select is(_rows($$ update public.analytics_goals set target = 1 where tenant_id = '71c00000-0000-0000-0000-000000000001' $$),
  0, 'nor change one');
select is(_rows($$ delete from public.analytics_goals where tenant_id = '71c00000-0000-0000-0000-000000000001' $$),
  0, 'nor delete one');
select _as('71c00000-0000-0000-0000-0000000000d1', 'developer', '71c00000-0000-0000-0000-000000000001');
select is(_seen(), 3, 'developer reads the goals');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Mine', 'visits', 1) $$,
  '42501', null, 'developer cannot add one (RLS)');
select is(_rows($$ update public.analytics_goals set target = 1 where tenant_id = '71c00000-0000-0000-0000-000000000001' $$)
          + _rows($$ delete from public.analytics_goals where tenant_id = '71c00000-0000-0000-0000-000000000001' $$),
  0, 'nor change or delete one');

-- Optimistic locking (crud.updateRow: WHERE version = the one read; the trigger bumps it).
select _as('71c00000-0000-0000-0000-0000000000a1', 'admin', '71c00000-0000-0000-0000-000000000001');
select is(_rows(format($$ update public.analytics_goals set target = 150 where id = %L and version = 1 $$,
                       _goal('Visits this month'))),
  1, 'admin changes a goal at the version it read');
select is((select version from public.analytics_goals where id = _goal('Visits this month')), 2,
  'the version moves');
select is(_rows(format($$ update public.analytics_goals set target = 160 where id = %L and version = 1 $$,
                       _goal('Visits this month'))),
  0, 'a stale version changes nothing');
select _as('71c00000-0000-0000-0000-0000000000e1', 'seo', '71c00000-0000-0000-0000-000000000001');
select is(_rows(format($$ update public.analytics_goals set name = 'WhatsApp clicks this month' where id = %L $$,
                       _goal('WhatsApp clicks'))),
  1, 'seo changes a goal');
select throws_ok(
  format($$ update public.analytics_goals set version = 9 where id = %L $$, _goal('Inquiries')),
  '42501', null, 'nobody writes the version (no column grant)');

-- ── 2. the live layer: stale, deactivated and locked tokens ───────────────────────────
select _as('71c00000-0000-0000-0000-0000000000e2', 'seo', '71c00000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Stale', 'visits', 1) $$,
  '42501', null, 'a token that still says seo, for a profile now content_creator, cannot add a goal');
select is(_rows($$ update public.analytics_goals set target = 2 where tenant_id = '71c00000-0000-0000-0000-000000000001' $$)
          + _rows($$ delete from public.analytics_goals where tenant_id = '71c00000-0000-0000-0000-000000000001' $$),
  0, 'nor change or delete one');
select is(_seen(), 0, 'and reads nothing either: the live layer sees the token and the profile disagree');
select _as('71c00000-0000-0000-0000-0000000000a3', 'admin', '71c00000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a deactivated admin reads nothing');
select _as('71c00000-0000-0000-0000-0000000000a4', 'admin', '71c00000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a locked admin reads nothing');
select is(_rows($$ delete from public.analytics_goals where tenant_id = '71c00000-0000-0000-0000-000000000001' $$),
  0, 'and deletes nothing');

-- ── 3. another tenant, and anon ──────────────────────────────────────────────────────
select _as('71c00000-0000-0000-0000-0000000000f1', 'admin', '71c00000-0000-0000-0000-0000000000ff');
select is(_seen(), 0, 'another tenant''s admin reads none of this tenant''s goals');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Foreign', 'visits', 1) $$,
  '42501', null, 'and cannot place one in it (WITH CHECK)');
select is(public.goal_progress('71c00000-0000-0000-0000-000000000001') -> 'goals', '[]'::jsonb,
  'goal_progress naming this tenant gives the empty shape');
reset role;
set local role anon;
select _as(null, null, null);
select throws_ok($$ select count(*) from public.analytics_goals $$, '42501', null,
  'anon is refused analytics_goals at the grant layer');
select throws_ok($$ select public.goal_progress('71c00000-0000-0000-0000-000000000001') $$, '42501', null,
  'anon may not call goal_progress');
reset role;

-- ── 4. the rules ───────────────────────────────────────────────────────────────────
set local role authenticated;
select _as('71c00000-0000-0000-0000-0000000000a1', 'admin', '71c00000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', '<b>Visits</b>', 'visits', 1) $$,
  '23514', null, 'a name with markup is refused');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Clicks', 'cta', 1) $$,
  '23514', null, 'a click goal must name its click');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, cta, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Visits', 'visits', 'email', 1) $$,
  '23514', null, 'and no other goal names one');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'Nothing', 'visits', 0) $$,
  '23514', null, 'a target of 0 is refused');
select lives_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     select '71c00000-0000-0000-0000-000000000001', 'Goal ' || g, 'pageviews', g
       from generate_series(1, 17) g $$,
  'the 18th to 20th goals are added');
select throws_ok(
  $$ insert into public.analytics_goals (tenant_id, name, metric, target)
     values ('71c00000-0000-0000-0000-000000000001', 'One too many', 'visits', 1) $$,
  '23514', 'new row for relation "analytics_goals" violates check constraint "analytics_goals_limit"',
  'the 21st is refused, naming analytics_goals_limit');
delete from public.analytics_goals where name like 'Goal %';

-- ── 5. goal_progress ────────────────────────────────────────────────────────────────
select is(
  (select jsonb_object_agg(g ->> 'name', g -> 'done')
     from jsonb_array_elements(public.goal_progress('71c00000-0000-0000-0000-000000000001') -> 'goals') g),
  jsonb_build_object('Visits this month', _month_visits(), 'WhatsApp clicks this month', 7, 'Inquiries', 1),
  'admin: this month''s visits and clicks from the rollups, inquiries not spam and not last month');
select is(public.goal_progress('71c00000-0000-0000-0000-000000000001') ->> 'month_start',
  date_trunc('month', now() at time zone 'UTC')::date::text, 'the month starts on the 1st (UTC)');
select is(
  (select string_agg(g ->> 'name', ', ')
     from jsonb_array_elements(public.goal_progress('71c00000-0000-0000-0000-000000000001') -> 'goals') g),
  'Inquiries, Visits this month, WhatsApp clicks this month',
  'oldest first, then by name (all three were added in this one transaction)');
select _as('71c00000-0000-0000-0000-0000000000d1', 'developer', '71c00000-0000-0000-0000-000000000001');
select is(
  (select g ->> 'done' from jsonb_array_elements(public.goal_progress('71c00000-0000-0000-0000-000000000001') -> 'goals') g
    where g ->> 'metric' = 'inquiries'),
  '1', 'developer sees the inquiries count (leads.manage)');
select _as('71c00000-0000-0000-0000-0000000000e1', 'seo', '71c00000-0000-0000-0000-000000000001');
select is(
  (select jsonb_object_agg(g ->> 'metric', g -> 'done')
     from jsonb_array_elements(public.goal_progress('71c00000-0000-0000-0000-000000000001') -> 'goals') g),
  jsonb_build_object('visits', _month_visits(), 'cta', 7, 'inquiries', null),
  'seo sees the rest, and no inquiries count');
select _as('71c00000-0000-0000-0000-0000000000c1', 'content_creator', '71c00000-0000-0000-0000-000000000001');
select is(
  (select g -> 'done' from jsonb_array_elements(public.goal_progress('71c00000-0000-0000-0000-000000000001') -> 'goals') g
    where g ->> 'metric' = 'inquiries'),
  'null'::jsonb, 'nor does content_creator');
reset role;

-- ── 6. the helper and the catalog ───────────────────────────────────────────────────
select ok(app.role_analytics_goals('admin') and app.role_analytics_goals('seo')
          and not app.role_analytics_goals('content_creator') and not app.role_analytics_goals('developer')
          and not app.role_analytics_goals(null),
  'app.role_analytics_goals answers analytics.goals: Admin and SEO');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, p.priv), ', ' order by w.who, p.priv), '')
     from (values ('public', array[]::text[]), ('anon', array[]::text[]),
                  ('authenticated', array['select', 'delete']),
                  ('service_role', array['select', 'insert', 'update', 'delete'])) as w(who, allowed)
     cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                        ('references'), ('trigger')) as p(priv)
    where has_table_privilege(w.who, 'public.analytics_goals', p.priv)
          is distinct from (p.priv = any (w.allowed))),
  '', 'table grants: staff SELECT and DELETE, the service role the four, PUBLIC and anon nothing');
select is(
  (select string_agg(format('%s %s', p.priv, a.attname), ', ' order by p.priv, a.attname)
     from pg_attribute a
     cross join (values ('insert'), ('update')) as p(priv)
    where a.attrelid = 'public.analytics_goals'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.analytics_goals', a.attname, p.priv)),
  'insert cta, insert metric, insert name, insert target, insert tenant_id, update cta, update metric, update name, update target',
  'column grants: staff insert the tenant and the four fields, and update the four');
select is(
  (select coalesce(string_agg(w.who, ', '), '')
     from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, 'public.goal_progress(uuid)', 'execute') is distinct from (w.who = 'authenticated')),
  '', 'staff alone call goal_progress');

select * from finish();
rollback;
