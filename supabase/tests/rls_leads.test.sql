-- pgTAP: leads RLS — PII gated to Admin + Developer; CC/SEO/anon denied; cross-tenant
-- fence. Run with `supabase test db`. Exercises RLS by switching to the non-superuser
-- `anon`/`authenticated` roles and injecting JWT claims (set_config), the Supabase pattern.

begin;
select plan(26);

-- Setup runs as the migration/superuser role (RLS bypassed here).
insert into public.tenants (id, name) values ('00000000-0000-0000-0000-000000000001', 'T1');
insert into public.leads (id, tenant_id, name, email_enc, message, discipline_of_interest)
  values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'Lead', '\x00', 'hi',
          'branding');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- anon: no lead access — and since 0011, denied a step EARLIER than this test assumed.
-- It used to assert `count(*) = 0`, i.e. the table is readable and RLS filters it to
-- nothing. 0011 revoked anon's table privilege outright, so the query is now rejected by
-- the GRANT layer before RLS is consulted at all. Postgres authorization is two gates in
-- sequence and anon no longer clears the first, which is strictly stronger — assert the
-- stronger property rather than relax 0011 back to the weaker one.
set local role anon;
select _claims(null, null);
select throws_ok(
  $$ select count(*) from public.leads $$,
  '42501', null, 'anon is denied public.leads at the GRANT layer (before RLS)'
);

set local role authenticated;

-- content_creator: no lead access
select _claims('content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'content_creator sees no leads');

-- seo: no lead access
select _claims('seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 0, 'seo sees no leads');

-- developer: full lead access
select _claims('developer', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 1, 'developer sees the lead');

-- admin: full lead access
select _claims('admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.leads)::int, 1, 'admin sees the lead');

-- admin of ANOTHER tenant: zero rows (cross-tenant fence)
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*) from public.leads)::int, 0, 'admin of other tenant sees no leads');

-- content_creator cannot insert a lead (no insert policy → RLS denies)
select _claims('content_creator', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y') $$,
  '42501', null, 'content_creator cannot insert leads'
);

-- 0028: "{Discipline}, help me choose" is carried in leads_safe for the lead-viewing roles
-- only. leads_safe is security_invoker, so the base table's RLS decides who sees the row.
select _claims('developer', '00000000-0000-0000-0000-000000000001');
select is((select discipline_of_interest::text from public.leads_safe
            where id = '00000000-0000-0000-0000-0000000000aa'),
  'branding', 'developer reads discipline_of_interest through leads_safe');
select _claims('admin', '00000000-0000-0000-0000-000000000001');
select is((select discipline_of_interest::text from public.leads_safe
            where id = '00000000-0000-0000-0000-0000000000aa'),
  'branding', 'admin reads discipline_of_interest through leads_safe');
select _claims('content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.leads_safe), 0,
  'content_creator sees NO row of leads_safe (the new column included)');
select _claims('seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.leads_safe), 0,
  'seo sees NO row of leads_safe');
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*)::int from public.leads_safe
            where id = '00000000-0000-0000-0000-0000000000aa'), 0,
  'admin of another tenant sees no leads_safe row');

reset role;
select _claims(null, null);
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message, discipline_of_interest)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y', 'Not a slug!') $$,
  '23514', null, 'discipline_of_interest must be a slug (CHECK, every write path)');
-- ---- leads_safe must stay SECURITY INVOKER -------------------------------------
--
-- 0002 grants `select on public.leads_safe to authenticated`, so this view is readable
-- by every signed-in user including Content Creator and SEO, who are supposed to have
-- NO lead access whatsoever. The ONLY thing standing between them and every tenant's
-- leads is `security_invoker`, which makes the view run RLS as the caller rather than
-- as its definer.
--
-- `create or replace view` does NOT inherit reloptions: re-issuing the definition
-- without the clause silently reverts the view to definer rights and turns a
-- defence-in-depth measure into a cross-tenant leak. 0015 re-stated it when adding
-- `company`; this asserts nobody drops it next time.
select ok(
  (select reloptions::text[] @> array['security_invoker=true']
     from pg_class where relname = 'leads_safe' and relnamespace = 'public'::regnamespace),
  'leads_safe is SECURITY INVOKER (without it, every authenticated role reads all leads)'
);

-- `company` is deliberately NON-sensitive: it belongs in leads_safe alongside `name`,
-- not in the Admin/Developer-gated set. Pinning it here means a future migration cannot
-- quietly move it either way without a failing test.
select ok(
  (select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'company'),
  'leads_safe exposes company (non-sensitive business-contact data)'
);

-- 0017: the free-text deadline is a §3 `timeline` field — Admin/Developer only. It must
-- exist on the base table and must NEVER appear in the safe view.
select ok(
  (select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads' and column_name = 'timeline_text_enc')
  and
  (select count(*) = 0 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'timeline_text_enc'),
  'leads.timeline_text_enc exists and is ABSENT from leads_safe (Admin/Developer-gated)'
);

-- 0028: discipline_of_interest is non-sensitive (a slug, like service_of_interest) and
-- belongs in leads_safe; recreating the view must not have dropped security_invoker (above).
select ok(
  (select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'discipline_of_interest'),
  'leads_safe exposes discipline_of_interest (0028)'
);

-- 0030: the GRANT layer, stated (hotfix H2). Admin and Developer hold the FOR ALL
-- policy, so without these grants RLS alone would stand between a staff token and a
-- forged, deleted or rewritten lead. Inserts belong to the service role (the public
-- form), deletes to the retention job; the admin writes status and notes only.
set local role authenticated;
select _claims('admin', '00000000-0000-0000-0000-000000000001');
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
select lives_ok(
  $$ update public.leads set status = 'in_progress', internal_notes = 'Called back'
     where id = '00000000-0000-0000-0000-0000000000aa' $$,
  'admin can still update status and notes (0030)');
select _claims('developer', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.leads (tenant_id, name, email_enc, message)
     values ('00000000-0000-0000-0000-000000000001', 'x', '\x00', 'y') $$,
  '42501', null, 'developer cannot insert a lead through the API (0030)');
select throws_ok(
  $$ delete from public.leads where id = '00000000-0000-0000-0000-0000000000aa' $$,
  '42501', null, 'developer cannot delete a lead through the API (0030)');
reset role;
select _claims(null, null);
select ok(
  not has_table_privilege('authenticated', 'public.leads', 'insert')
  and not has_table_privilege('authenticated', 'public.leads', 'delete')
  and not has_table_privilege('authenticated', 'public.leads', 'truncate')
  and not has_table_privilege('authenticated', 'public.leads', 'update')
  and has_column_privilege('authenticated', 'public.leads', 'status', 'update'),
  'authenticated: no insert/delete/truncate, UPDATE only on named columns (0030)');

select is(1, 1, 'cleanup ok');

select * from finish();
rollback;
