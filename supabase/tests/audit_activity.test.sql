-- pgTAP: the activity log v2 (0054, Admin v2 U13). Run with `supabase test db`.
--
-- Rows for admin, content_creator, seo, developer, anon and another tenant's admin, plus the
-- three stale Developer tokens the live read exists for: one whose profile was demoted to seo,
-- one deactivated and one locked, each still carrying a `developer` claim (CLAUDE.md §9 (b)).
--   • reading audit_log: Admin and Developer read their tenant's rows and no other tenant's;
--     Content Creator and SEO read none; anon holds no privilege; each stale token reads
--     none (audit_log_live_read), while the same Developer, live, reads them all; another
--     tenant's Admin reads only its own tenant's;
--   • writing it is unchanged: a stale token's insert still lands, bound to the stale account
--     (0050's actor binding), and the chain links every row in id order, those written before
--     and after the new policy alike;
--   • public.audit_people names the tenant's people among the ids asked, former members
--     included, for a live Admin or Developer only: nothing for Content Creator, SEO, a stale
--     token, another tenant's Admin or a tenant that is not the token's; 22023 over 100 ids;
--     anon cannot call it;
--   • the catalog: the helper, the exact policy set (the tenant predicate first in each), the
--     two triggers in order, the grants, the indexes, and the rewritten guide in every tenant.

begin;
select plan(43);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('54000000-0000-0000-0000-000000000001', 'T1'),
  ('54000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('54000000-0000-0000-0000-0000000000a1', 'u13-admin@example.test'),
  ('54000000-0000-0000-0000-0000000000d1', 'u13-developer@example.test'),
  ('54000000-0000-0000-0000-0000000000d2', 'u13-demoted@example.test'),
  ('54000000-0000-0000-0000-0000000000d3', 'u13-inactive@example.test'),
  ('54000000-0000-0000-0000-0000000000d4', 'u13-locked@example.test'),
  ('54000000-0000-0000-0000-0000000000c1', 'u13-creator@example.test'),
  ('54000000-0000-0000-0000-0000000000e1', 'u13-seo@example.test'),
  ('54000000-0000-0000-0000-0000000000f1', 'u13-other-admin@example.test'),
  ('54000000-0000-0000-0000-0000000000b1', 'u13-former@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name) values
  ('54000000-0000-0000-0000-0000000000a1', '54000000-0000-0000-0000-000000000001', 'admin', true, null, 'Amal'),
  ('54000000-0000-0000-0000-0000000000d1', '54000000-0000-0000-0000-000000000001', 'developer', true, null, 'Dana'),
  -- Stale: each token below still says developer.
  ('54000000-0000-0000-0000-0000000000d2', '54000000-0000-0000-0000-000000000001', 'seo', true, null, 'Demoted'),
  ('54000000-0000-0000-0000-0000000000d3', '54000000-0000-0000-0000-000000000001', 'developer', false, null, 'Gone'),
  ('54000000-0000-0000-0000-0000000000d4', '54000000-0000-0000-0000-000000000001', 'developer', true,
   now() + interval '10 minutes', 'Locked'),
  ('54000000-0000-0000-0000-0000000000c1', '54000000-0000-0000-0000-000000000001', 'content_creator', true, null, 'Cyrus'),
  ('54000000-0000-0000-0000-0000000000e1', '54000000-0000-0000-0000-000000000001', 'seo', true, null, 'Eli'),
  ('54000000-0000-0000-0000-0000000000f1', '54000000-0000-0000-0000-0000000000ff', 'admin', true, null, 'Faris'),
  -- A former member: switched off, still named in the log.
  ('54000000-0000-0000-0000-0000000000b1', '54000000-0000-0000-0000-000000000001', 'content_creator', false, null, 'Bashir');

-- Three T1 entries and one T2 entry, written as an operator would (kept as written, chained).
insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail) values
  ('54000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-0000000000b1', 'content_creator',
   'service.update', 'service', '54000000-0000-0000-0000-00000000aa01', '{"fields": ["title"]}'),
  ('54000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-0000000000a1', 'admin',
   'service.update', 'service', '54000000-0000-0000-0000-00000000aa01', '{"fields": ["status"], "status": "published"}'),
  ('54000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-0000000000d1', 'developer',
   'lead.view_pii', 'lead', '54000000-0000-0000-0000-00000000bb01', '{}'),
  ('54000000-0000-0000-0000-0000000000ff', '54000000-0000-0000-0000-0000000000f1', 'admin',
   'service.update', 'service', '54000000-0000-0000-0000-00000000aa02', '{"fields": ["title"]}');

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

-- The T1 and T2 entries the CURRENT role reads, as "t1/t2".
create function _seen() returns text language sql stable as $$
  select (select count(*) from public.audit_log where tenant_id = '54000000-0000-0000-0000-000000000001')::text
         || '/' ||
         (select count(*) from public.audit_log where tenant_id = '54000000-0000-0000-0000-0000000000ff')::text
$$;

-- The people audit_people names for the CURRENT role, as "name:active" sorted by name.
create function _named(p_tenant uuid, p_ids uuid[]) returns text language sql as $$
  select coalesce(string_agg(display_name || ':' || is_active::text, ',' order by display_name), '')
    from public.audit_people(p_tenant, p_ids)
$$;

grant execute on function _as(text, text, text), _seen(), _named(uuid, uuid[])
  to anon, authenticated, service_role;

-- ── 1. the catalog ─────────────────────────────────────────────────────────────
select ok(
  app.role_views_audit('admin') and app.role_views_audit('developer')
    and not app.role_views_audit('content_creator') and not app.role_views_audit('seo')
    and not app.role_views_audit('anon') and not app.role_views_audit(null),
  'app.role_views_audit is audit.view: Admin and Developer');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'audit_log'),
  'audit_insert INSERT PERMISSIVE {public}, '
  'audit_log_live_read SELECT RESTRICTIVE {authenticated}, '
  'audit_read SELECT PERMISSIVE {public}',
  'audit_log carries exactly the staff insert, the JWT read and the RESTRICTIVE live read');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'audit_log'
      and coalesce(qual, with_check) ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '),
  3, 'each policy names the tenant predicate first');
select is(
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_log_live_read')
    ~ 'role_views_audit\(\( SELECT (app\.)?live_role\(\) AS live_role\)\)\)$',
  true, 'the live read asks audit.view of the live role');
select is(
  (select string_agg(t.tgname::text, ',' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.audit_log'::regclass and not t.tgisinternal
      and t.tgtype = 7 and t.tgenabled::text = 'O'
      and ((t.tgname = 'audit_log_actor' and t.tgfoid = 'app.tg_audit_actor()'::regprocedure)
           or (t.tgname = 'audit_log_chain' and t.tgfoid = 'app.tg_audit_chain()'::regprocedure))),
  'audit_log_actor,audit_log_chain',
  'the two BEFORE INSERT triggers are H10''s binding then the chain, by function oid');
select ok(
  has_table_privilege('authenticated', 'public.audit_log', 'select')
    and has_table_privilege('authenticated', 'public.audit_log', 'insert')
    and not has_table_privilege('authenticated', 'public.audit_log', 'update')
    and not has_table_privilege('authenticated', 'public.audit_log', 'delete')
    and not has_table_privilege('authenticated', 'public.audit_log', 'truncate')
    and not has_table_privilege('service_role', 'public.audit_log', 'update')
    and not has_table_privilege('service_role', 'public.audit_log', 'delete')
    and not has_table_privilege('service_role', 'public.audit_log', 'truncate')
    and not has_table_privilege('anon', 'public.audit_log', 'select')
    and not has_table_privilege('anon', 'public.audit_log', 'insert'),
  'audit_log''s grants are 0050''s: staff and the service role read and insert, nobody rewrites');
select ok(
  has_function_privilege('authenticated', 'public.audit_people(uuid, uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.audit_people(uuid, uuid[])', 'execute')
    and not has_function_privilege('service_role', 'public.audit_people(uuid, uuid[])', 'execute')
    and (select prosecdef from pg_proc where oid = 'public.audit_people(uuid, uuid[])'::regprocedure),
  'audit_people is a definer staff tokens alone may call');
select is(
  (select pg_get_function_result('public.audit_people(uuid, uuid[])'::regprocedure)),
  'TABLE(id uuid, display_name text, role text, is_active boolean)',
  'audit_people answers an id, a name, a role and whether the person is active: never an e-mail');
select ok(
  has_function_privilege('authenticated', 'app.role_views_audit(text)', 'execute')
    and has_function_privilege('service_role', 'app.role_views_audit(text)', 'execute')
    and not has_function_privilege('anon', 'app.role_views_audit(text)', 'execute'),
  'the helper is callable by staff and the service role, not anon');
select ok(
  to_regclass('public.audit_log_tenant_actor_idx') is not null
    and to_regclass('public.audit_log_tenant_created_idx') is not null,
  'the person and day filters have their indexes');

-- ── 2. who reads the log ───────────────────────────────────────────────────────
set local role authenticated;

select _as('54000000-0000-0000-0000-0000000000a1', 'admin', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '3/0', 'admin reads its tenant''s entries and no other tenant''s');
select _as('54000000-0000-0000-0000-0000000000d1', 'developer', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '3/0', 'developer reads its tenant''s entries and no other tenant''s');
select _as('54000000-0000-0000-0000-0000000000c1', 'content_creator', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '0/0', 'content_creator reads no entry');
select _as('54000000-0000-0000-0000-0000000000e1', 'seo', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '0/0', 'seo reads no entry');
select _as('54000000-0000-0000-0000-0000000000f1', 'admin', '54000000-0000-0000-0000-0000000000ff');
select is(_seen(), '0/1', 'other_tenant: another tenant''s Admin reads its own entries, none of T1''s');

-- The stale tokens: each claims developer, which the JWT layer (audit_read) still admits.
select _as('54000000-0000-0000-0000-0000000000d2', 'developer', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '0/0', 'a demoted Developer''s token (profile seo) reads no entry');
select _as('54000000-0000-0000-0000-0000000000d3', 'developer', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '0/0', 'a deactivated Developer''s token reads no entry');
select _as('54000000-0000-0000-0000-0000000000d4', 'developer', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '0/0', 'a locked Developer''s token reads no entry');
-- A token that claims more than the profile holds: a Content Creator claiming admin.
select _as('54000000-0000-0000-0000-0000000000c1', 'admin', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '0/0', 'a token whose claim disagrees with the profile reads no entry');

reset role;
select _as(null, null, null);
set local role anon;
select throws_ok($$ select count(*) from public.audit_log $$, '42501', null,
  'anon holds no privilege on the log');
reset role;

-- ── 3. writing is unchanged ────────────────────────────────────────────────────
set local role authenticated;
select _as('54000000-0000-0000-0000-0000000000d2', 'developer', '54000000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.audit_log (tenant_id, action, entity_type, detail)
     values ('54000000-0000-0000-0000-000000000001', 'u13.stale_write', 'service', '{}') $$,
  'a stale token''s insert still lands (the live read narrows SELECT only)');
select _as('54000000-0000-0000-0000-0000000000c1', 'content_creator', '54000000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, detail)
     values ('54000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-0000000000a1', 'admin',
             'u13.creator_write', 'service', '{}') $$,
  'and so does a Content Creator''s, which reads no entry');
reset role;
select is(
  (select string_agg(action || '=' || actor_id::text || '/' || actor_role, ', ' order by id)
     from public.audit_log where action like 'u13.%'),
  'u13.stale_write=54000000-0000-0000-0000-0000000000d2/developer, '
  'u13.creator_write=54000000-0000-0000-0000-0000000000c1/content_creator',
  'each is bound to the account that wrote it (0050), whatever it named');
select ok(
  (select count(*) = 5
          and bool_and(a.hash ~ '^[0-9a-f]{64}$')
          and bool_and(a.prev_hash is not distinct from (
                select b.hash from public.audit_log b
                 where b.tenant_id = a.tenant_id and b.id < a.id
                 order by b.id desc limit 1))
     from public.audit_log a
    where a.tenant_id = '54000000-0000-0000-0000-000000000001'),
  'every T1 entry, written before and after by every kind of writer, links to the one before it');

-- A live Developer sees the stale and the Content Creator's entries too.
set local role authenticated;
select _as('54000000-0000-0000-0000-0000000000d1', 'developer', '54000000-0000-0000-0000-000000000001');
select is(_seen(), '5/0', 'a live Developer reads every T1 entry, the ones it could not have written included');
reset role;

-- ── 4. audit_people ────────────────────────────────────────────────────────────
set local role authenticated;
select _as('54000000-0000-0000-0000-0000000000a1', 'admin', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001',
         array['54000000-0000-0000-0000-0000000000a1', '54000000-0000-0000-0000-0000000000b1',
               '54000000-0000-0000-0000-0000000000d3', '54000000-0000-0000-0000-0000000000f1']::uuid[]),
  'Amal:true,Bashir:false,Gone:false',
  'admin: the people asked for in its tenant, former members included, nobody from another tenant');
select is(
  (select role from public.audit_people('54000000-0000-0000-0000-000000000001',
                                        array['54000000-0000-0000-0000-0000000000b1']::uuid[])),
  'content_creator', 'a former member keeps the role the log needs');
select is(
  _named('54000000-0000-0000-0000-0000000000ff', array['54000000-0000-0000-0000-0000000000f1']::uuid[]),
  '', 'admin: nothing for a tenant that is not the token''s');
select is(_named('54000000-0000-0000-0000-000000000001', null), '', 'admin: no ids, no names');
select throws_ok(
  $$ select * from public.audit_people('54000000-0000-0000-0000-000000000001',
       (select array_agg(gen_random_uuid()) from generate_series(1, 101))) $$,
  '22023', null, 'more than 100 ids at a time is refused');
select lives_ok(
  $$ select * from public.audit_people('54000000-0000-0000-0000-000000000001',
       (select array_agg(gen_random_uuid()) from generate_series(1, 100))) $$,
  'a page''s 100 ids are not');

select _as('54000000-0000-0000-0000-0000000000d1', 'developer', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001',
         array['54000000-0000-0000-0000-0000000000a1', '54000000-0000-0000-0000-0000000000b1']::uuid[]),
  'Amal:true,Bashir:false', 'developer: the same names');

select _as('54000000-0000-0000-0000-0000000000c1', 'content_creator', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001', array['54000000-0000-0000-0000-0000000000a1']::uuid[]),
  '', 'content_creator: nobody');
select _as('54000000-0000-0000-0000-0000000000e1', 'seo', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001', array['54000000-0000-0000-0000-0000000000a1']::uuid[]),
  '', 'seo: nobody');
select _as('54000000-0000-0000-0000-0000000000d2', 'developer', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001', array['54000000-0000-0000-0000-0000000000a1']::uuid[]),
  '', 'a demoted Developer''s token: nobody');
select _as('54000000-0000-0000-0000-0000000000d3', 'developer', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001', array['54000000-0000-0000-0000-0000000000a1']::uuid[]),
  '', 'a deactivated Developer''s token: nobody');
select _as('54000000-0000-0000-0000-0000000000d4', 'developer', '54000000-0000-0000-0000-000000000001');
select is(
  _named('54000000-0000-0000-0000-000000000001', array['54000000-0000-0000-0000-0000000000a1']::uuid[]),
  '', 'a locked Developer''s token: nobody');
select _as('54000000-0000-0000-0000-0000000000f1', 'admin', '54000000-0000-0000-0000-0000000000ff');
select is(
  _named('54000000-0000-0000-0000-000000000001', array['54000000-0000-0000-0000-0000000000a1']::uuid[]),
  '', 'other_tenant: nobody from T1, naming T1');
select is(
  _named('54000000-0000-0000-0000-0000000000ff',
         array['54000000-0000-0000-0000-0000000000a1', '54000000-0000-0000-0000-0000000000f1']::uuid[]),
  'Faris:true', 'other_tenant: its own people only, naming its own tenant');

reset role;
select _as(null, null, null);
set local role anon;
select throws_ok(
  $$ select * from public.audit_people('54000000-0000-0000-0000-000000000001',
       array['54000000-0000-0000-0000-0000000000a1']::uuid[]) $$,
  '42501', null, 'anon cannot call audit_people');
reset role;
set local role service_role;
select throws_ok(
  $$ select * from public.audit_people('54000000-0000-0000-0000-000000000001',
       array['54000000-0000-0000-0000-0000000000a1']::uuid[]) $$,
  '42501', null, 'nor can the service role: the door is for a signed-in reader of the log');
reset role;

-- ── 5. the guide ───────────────────────────────────────────────────────────────
select ok(
  (select bool_and(h.body::text like '%former members included%'
                   and h.body::text like '%up to three times an hour%'
                   and h.body::text not like '%The screen lists the time, the role%')
     from public.help_articles h
    where h.slug = 'site-health-and-logs'
      and h.tenant_id in ('54000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-0000000000ff')),
  'a new tenant is seeded with the rewritten activity-log guide');
select is(
  (select count(*)::int from public.help_articles h
    where h.slug = 'site-health-and-logs'
      and h.body::text like '%The screen lists the time, the role%'),
  0, 'and no tenant keeps the old one');

select * from finish();
rollback;
