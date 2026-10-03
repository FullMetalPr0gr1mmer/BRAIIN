-- pgTAP: the private CV bucket (0029). Runs where Supabase Storage's schema exists (CI's
-- `supabase start`); the local PGlite replay has no storage schema and skips this file.
begin;
select plan(6);

select is((select public from storage.buckets where id = 'applications'), false,
  'the applications bucket is private');
select is((select file_size_limit from storage.buckets where id = 'applications'), 10485760::bigint,
  'the bucket refuses files over 10 MB');
select is(
  (select allowed_mime_types from storage.buckets where id = 'applications'),
  array['application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[],
  'the bucket accepts PDF and .docx only');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- Whether anon holds SELECT on storage.objects at all is Supabase's default, not ours:
-- either way (no privilege, or no policy naming the bucket) anon reads nothing from it.
create function _anon_visible() returns int language plpgsql as $f$
begin
  return (select count(*) from storage.objects where bucket_id = 'applications');
exception when insufficient_privilege then
  return 0;
end $f$;

-- No API role can put an object in the bucket: no storage policy names it (and the
-- RESTRICTIVE belt, where the migration role may add it, refuses it outright).
set local role authenticated;
select _claims('admin', '00000000-0000-0000-0000-000000000001');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('applications', 'x/y/z.pdf') $$,
  '42501', null, 'an authenticated admin cannot write into the CV bucket');
set local role anon;
select _claims(null, null);
select is(_anon_visible(), 0, 'anon sees no object in the CV bucket');

-- The orphan sweep (the Worker's daily job) runs as the service role against the real
-- storage schema: an empty bucket has no orphan. (tests/e2e/apply-roundtrip.e2e.ts proves
-- it finds a real one and leaves a referenced CV alone.)
reset role;
set local role service_role;
select is((select count(*)::int from public.application_orphan_cvs(0, 10)), 0,
  'the orphan sweep reads storage as the service role and finds nothing in an empty bucket');

select * from finish();
rollback;
