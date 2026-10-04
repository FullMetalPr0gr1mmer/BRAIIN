-- pgTAP: leads — PII gated to Admin + Developer in both layers; CC/SEO/anon denied;
-- cross-tenant fence. Run with `supabase test db`. Exercises RLS by switching to the
-- non-superuser `anon`/`authenticated` roles and injecting JWT claims (set_config), the
-- Supabase pattern.
--
-- Since 0033 two more things hold, and both need a real profile behind each token:
--   • the live half: a token whose profile has since been demoted, deactivated, locked or
--     moved, or that never matched it, reads and changes nothing (app.live_role(), the
--     RESTRICTIVE leads_live policy; CLAUDE.md §9(b));
--   • the column half: a staff token reads only the safe columns. The gated ones
--     (ciphertext, budget, timeline, notes, address, retention) leave the database only
--     through the Worker's audited service-role paths.

begin;
select plan(42);

-- Setup runs as the migration/superuser role (RLS bypassed here).
insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');
insert into public.leads (id, tenant_id, name, email_enc, message, discipline_of_interest,
                          internal_notes, timeline_band)
  values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'Lead', '\x00', 'hi',
          'branding', 'Called back', '1-3m');

-- One profile per principal. The last five hold tokens their profiles no longer back.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'inactive-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'locked-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'claims-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'moved-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null),
  -- demoted: the token still says developer
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  -- deactivated
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'admin', false, null),
  -- locked
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'admin', true, now() + interval '1 hour'),
  -- the token claims admin; the profile says developer
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  -- moved to T2; the token still says T1
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null);

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

-- Rows a statement touched, as the CURRENT role (security invoker).
create function _rows(p_sql text) returns int language plpgsql as $f$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;

-- Which of the given lead columns the CURRENT role may select (each tried on its own).
create function _readable(p_cols text[]) returns text[] language plpgsql as $f$
declare
  c text;
  v text[] := '{}';
begin
  foreach c in array p_cols loop
    begin
      execute format('select %I from public.leads limit 1', c);
      v := v || c;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  return v;
end $f$;

-- ---- anon: refused at the GRANT layer ---------------------------------------------
-- It used to assert `count(*) = 0`, i.e. the table is readable and RLS filters it to
-- nothing. 0011 revoked anon's table privilege outright, so the query is rejected before
-- RLS is consulted at all, which is strictly stronger.
set local role anon;
select _as(null, null, null);
select throws_ok(
  $$ select count(*) from public.leads $$,
  '42501', null, 'anon is denied public.leads at the GRANT layer (before RLS)');
select throws_ok(
  $$ select app.live_role() $$,
  '42501', null, 'anon cannot call app.live_role()');

set local role authenticated;

-- ---- content_creator and seo: no lead access --------------------------------------
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'content_creator sees no leads');
select is((select count(*)::int from public.leads_safe), 0,
  'content_creator sees NO row of leads_safe');
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y') $$,
  '42501', null, 'content_creator cannot insert leads');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'seo sees no leads');
select is((select count(*)::int from public.leads_safe), 0, 'seo sees NO row of leads_safe');

-- ---- developer and admin, live: the lead ------------------------------------------
-- 0028: "{Discipline}, help me choose" is carried in leads_safe for the lead-viewing roles
-- only. leads_safe is security_invoker, so the base table's RLS decides who sees the row.
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 1, 'developer sees the lead');
select is((select discipline_of_interest::text from public.leads_safe
            where id = '00000000-0000-0000-0000-0000000000aa'),
  'branding', 'developer reads discipline_of_interest through leads_safe');
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 1, 'admin sees the lead');
select is((select discipline_of_interest::text from public.leads_safe
            where id = '00000000-0000-0000-0000-0000000000aa'),
  'branding', 'admin reads discipline_of_interest through leads_safe');
select is(app.live_role(), 'admin',
  'app.live_role() is the profile''s role when profile and token agree');

-- ---- other tenant: zero rows ------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.leads
            where id = '00000000-0000-0000-0000-0000000000aa'), 0,
  'admin of another tenant sees no leads');
select is((select count(*)::int from public.leads_safe
            where id = '00000000-0000-0000-0000-0000000000aa'), 0,
  'admin of another tenant sees no leads_safe row');

-- ---- stale tokens read and change nothing (0033, the live check) ------------------
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0,
  'a demoted developer''s old token reads no lead (the profile says seo)');
select is(app.live_role(), null::text,
  'app.live_role() is null when the profile disagrees with the token');
select is(_rows($$ update public.leads set status = 'done'
                    where id = '00000000-0000-0000-0000-0000000000aa' $$), 0,
  'a demoted developer''s old token changes no lead');
select _as('00000000-0000-0000-0000-0000000000a2', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'a deactivated admin''s token reads no lead');
select _as('00000000-0000-0000-0000-0000000000a3', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'a locked admin''s token reads no lead');
select _as('00000000-0000-0000-0000-0000000000a4', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0,
  'a token claiming admin over a developer profile reads nothing (divergence denies)');
select _as('00000000-0000-0000-0000-0000000000a5', 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0,
  'a profile moved to another tenant reads nothing with its old token');
select _as(null, 'admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'a token with no subject reads nothing');

-- ---- the column grant (0033) --------------------------------------------------------
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(
  _readable(array['email_enc', 'phone_enc', 'budget_enc', 'timeline_band', 'timeline_text_enc',
                  'internal_notes', 'ip_inet', 'retention_delete_after']),
  '{}'::text[], 'admin reads no gated lead column through the API (0033)');
select throws_ok(
  $$ select * from public.leads $$,
  '42501', null, 'select * is refused: it fails loudly instead of leaking (0033)');
select lives_ok(
  $$ select id, tenant_id, kind, locale, name, company, message, service_of_interest,
            discipline_of_interest, status, consent_marketing, created_at, updated_at
       from public.leads $$,
  'admin reads every safe column');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(
  _readable(array['email_enc', 'phone_enc', 'budget_enc', 'timeline_band', 'timeline_text_enc',
                  'internal_notes', 'ip_inet', 'retention_delete_after']),
  '{}'::text[], 'developer reads no gated lead column through the API (0033)');

-- ---- writes: status and notes only (0030) -----------------------------------------
-- Admin and Developer hold the update policy, so without these grants RLS alone would
-- stand between a staff token and a forged, deleted or rewritten lead. Inserts belong to
-- the service role (the public form), deletes to the retention job.
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y') $$,
  '42501', null, 'admin cannot insert a lead through the API (0030)');
select throws_ok(
  $$ delete from public.leads where id = '00000000-0000-0000-0000-0000000000aa' $$,
  '42501', null, 'admin cannot delete a lead through the API (0030)');
select throws_ok(
  $$ update public.leads set email_enc = '\x01' where id = '00000000-0000-0000-0000-0000000000aa' $$,
  '42501', null, 'admin cannot rewrite email_enc (0030)');
select throws_ok(
  $$ update public.leads set retention_delete_after = now() + interval '10 years'
     where id = '00000000-0000-0000-0000-0000000000aa' $$,
  '42501', null, 'admin cannot extend a lead''s retention (0030)');
select is(_rows($$ update public.leads set status = 'in_progress', internal_notes = 'Sent the proposal'
                    where id = '00000000-0000-0000-0000-0000000000aa' $$), 1,
  'a live admin still updates status and writes notes, without being able to read them');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y') $$,
  '42501', null, 'developer cannot insert a lead through the API (0030)');
select throws_ok(
  $$ delete from public.leads where id = '00000000-0000-0000-0000-0000000000aa' $$,
  '42501', null, 'developer cannot delete a lead through the API (0030)');

-- ---- as the owner: the stored values, the view and the catalog ---------------------
reset role;
select _as(null, null, null);
select is(
  (select internal_notes || ' / ' || status from public.leads
    where id = '00000000-0000-0000-0000-0000000000aa'),
  'Sent the proposal / in_progress',
  'the live admin''s write landed: notes are written without being readable');
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message, discipline_of_interest)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y', 'Not a slug!') $$,
  '23514', null, 'discipline_of_interest must be a slug (CHECK, every write path)');

-- leads_safe must stay SECURITY INVOKER. It is granted to every signed-in role, Content
-- Creator and SEO included, because a GRANT cannot tell app roles apart (they all share
-- `authenticated`). Invoker rights make the base table's RLS decide the rows.
-- `create or replace view` does NOT inherit reloptions, so a careless re-definition would
-- turn it into a cross-tenant leak.
select ok(
  (select reloptions::text[] @> array['security_invoker=true']
     from pg_class where relname = 'leads_safe' and relnamespace = 'public'::regnamespace),
  'leads_safe is SECURITY INVOKER (without it, every authenticated role reads all leads)');

-- `company` is deliberately NON-sensitive: it belongs in leads_safe alongside `name`.
select ok(
  (select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'company'),
  'leads_safe exposes company (non-sensitive business-contact data)');

-- 0017: the free-text deadline is a §3 `timeline` field — Admin/Developer only.
select ok(
  (select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads' and column_name = 'timeline_text_enc')
  and
  (select count(*) = 0 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'timeline_text_enc'),
  'leads.timeline_text_enc exists and is ABSENT from leads_safe (Admin/Developer-gated)');

-- 0028: discipline_of_interest is non-sensitive (a slug, like service_of_interest).
select ok(
  (select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'discipline_of_interest'),
  'leads_safe exposes discipline_of_interest (0028)');

select ok(
  not has_table_privilege('authenticated', 'public.leads', 'select')
  and not has_table_privilege('authenticated', 'public.leads', 'insert')
  and not has_table_privilege('authenticated', 'public.leads', 'delete')
  and not has_table_privilege('authenticated', 'public.leads', 'truncate')
  and not has_table_privilege('authenticated', 'public.leads', 'update')
  and has_column_privilege('authenticated', 'public.leads', 'status', 'update')
  and has_column_privilege('authenticated', 'public.leads', 'internal_notes', 'update')
  and not has_column_privilege('authenticated', 'public.leads', 'internal_notes', 'select'),
  'authenticated: column SELECT, UPDATE on status and notes only, no insert/delete/truncate (0030, 0033)');

select ok(
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_live'
             and permissive = 'RESTRICTIVE' and cmd = 'ALL'
             and qual like '%live_role%' and qual like '%effective_tenant_id%'
             and with_check like '%live_role%' and with_check like '%effective_tenant_id%')
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'leads'
                     and permissive = 'PERMISSIVE' and cmd in ('ALL', 'INSERT', 'DELETE')),
  'leads_live is RESTRICTIVE with the live check and a tenant predicate; no permissive insert/delete path');

select ok(
  has_table_privilege('service_role', 'public.leads', 'select')
  and has_table_privilege('service_role', 'public.leads', 'insert')
  and has_table_privilege('service_role', 'public.leads', 'update')
  and has_table_privilege('service_role', 'public.leads', 'delete'),
  'service_role keeps the ingest, notify, reveal and export paths (stated, not inherited)');

select * from finish();
rollback;
