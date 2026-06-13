-- pgTAP: services RLS — public sees only published; Content Creator authors + publishes
-- but cannot archive; SEO cannot write; Admin can archive/delete. Run with `supabase test db`.

begin;
select plan(7);

insert into public.tenants (id, name) values ('00000000-0000-0000-0000-000000000001', 'T1');
insert into public.services (id, tenant_id, slug, title, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'published-svc', '{"en":"P","ar":"ب"}', 'published'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'draft-svc',     '{"en":"D","ar":"د"}', 'draft');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- anon sees only the published service
set local role anon;
select _claims(null, null);
select is((select count(*) from public.services)::int, 1, 'anon sees only published services');

set local role authenticated;

-- content_creator sees drafts too
select _claims('content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.services)::int, 2, 'content_creator sees drafts');

-- content_creator can insert
select lives_ok(
  $$ insert into public.services (tenant_id, slug, title, status)
     values ('00000000-0000-0000-0000-000000000001', 'new-svc', '{"en":"N","ar":"ن"}', 'draft') $$,
  'content_creator can insert a service'
);

-- content_creator CANNOT archive (WITH CHECK blocks status=archived for non-admin)
select throws_ok(
  $$ update public.services set status = 'archived' where slug = 'published-svc' $$,
  '42501', null, 'content_creator cannot archive'
);

-- seo cannot write services
select _claims('seo', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into public.services (tenant_id, slug, title)
     values ('00000000-0000-0000-0000-000000000001', 'seo-svc', '{"en":"S","ar":"س"}') $$,
  '42501', null, 'seo cannot write services'
);

-- admin can archive and delete
select _claims('admin', '00000000-0000-0000-0000-000000000001');
select lives_ok(
  $$ update public.services set status = 'archived' where slug = 'published-svc' $$,
  'admin can archive'
);
select lives_ok(
  $$ delete from public.services where slug = 'draft-svc' $$,
  'admin can delete'
);

reset role;
select _claims(null, null);

select * from finish();
rollback;
