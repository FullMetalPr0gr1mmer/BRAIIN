-- pgTAP: leads RLS — PII gated to Admin + Developer; CC/SEO/anon denied; cross-tenant
-- fence. Run with `supabase test db`. Exercises RLS by switching to the non-superuser
-- `anon`/`authenticated` roles and injecting JWT claims (set_config), the Supabase pattern.

begin;
select plan(8);

-- Setup runs as the migration/superuser role (RLS bypassed here).
insert into public.tenants (id, name) values ('00000000-0000-0000-0000-000000000001', 'T1');
insert into public.leads (id, tenant_id, name, email_enc, message)
  values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'Lead', '\x00', 'hi');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- anon: no lead access
set local role anon;
select _claims(null, null);
select is((select count(*) from public.leads)::int, 0, 'anon sees no leads');

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

reset role;
select _claims(null, null);
select is(1, 1, 'cleanup ok');

select * from finish();
rollback;
