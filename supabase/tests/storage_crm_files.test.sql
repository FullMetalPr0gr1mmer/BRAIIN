-- pgTAP: the private contact-files bucket, its RESTRICTIVE belt (present, and still shut when a
-- permissive policy opens every bucket) and its orphan reader (0140, Admin v2 C16). Runs where
-- a `storage` schema exists (CI's `supabase start`; the local PGlite replay has a stand-in).
begin;
select plan(19);

select is((select public from storage.buckets where id = 'crm-files'), false,
  'the crm-files bucket is private');
select is((select file_size_limit from storage.buckets where id = 'crm-files'), 10485760::bigint,
  'the bucket refuses files over 10 MiB');
select is(
  (select allowed_mime_types from storage.buckets where id = 'crm-files'),
  array['application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/png', 'image/jpeg', 'image/webp']::text[],
  'the bucket accepts the five sniffed kinds only');

create function c16s_claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
-- Whether anon holds SELECT on storage.objects at all is Supabase's default, not ours: either
-- way (no privilege, or no policy naming the bucket) anon reads nothing from it.
create function c16s_anon_visible() returns int language plpgsql as $f$
begin
  return (select count(*) from storage.objects where bucket_id = 'crm-files');
exception when insufficient_privilege then
  return 0;
end $f$;
grant execute on function c16s_claims(text, text), c16s_anon_visible() to anon, authenticated;

-- Objects as Storage would hold them (as the migration role): an orphan in the Worker's shape,
-- one a row names, one too young, one in another shape (never the sweep's), and one in
-- another bucket.
insert into public.tenants (id, name) values ('c1600000-0000-4000-8000-0000000000b1', 'C16 S');
insert into public.crm_contacts (id, tenant_id, display_name) values
  ('c1600000-0000-4000-8000-0000000000c1', 'c1600000-0000-4000-8000-0000000000b1', 'Stored Person');
insert into public.crm_contact_files (tenant_id, contact_id, object_path, name, content_type, bytes) values
  ('c1600000-0000-4000-8000-0000000000b1', 'c1600000-0000-4000-8000-0000000000c1',
   'c1600000-0000-4000-8000-0000000000b1/c1600000-0000-4000-8000-0000000000c1/c1600000-0000-4000-8000-0000000000d2.pdf',
   'Named.pdf', 'application/pdf', 10);
insert into storage.objects (bucket_id, name, created_at) values
  ('crm-files', 'c1600000-0000-4000-8000-0000000000b1/c1600000-0000-4000-8000-0000000000c1/c1600000-0000-4000-8000-0000000000d1.pdf', now() - interval '2 hours'),
  ('crm-files', 'c1600000-0000-4000-8000-0000000000b1/c1600000-0000-4000-8000-0000000000c1/c1600000-0000-4000-8000-0000000000d2.pdf', now() - interval '2 hours'),
  ('crm-files', 'c1600000-0000-4000-8000-0000000000b1/c1600000-0000-4000-8000-0000000000c1/c1600000-0000-4000-8000-0000000000d3.png', now() - interval '10 minutes'),
  ('crm-files', 'by-hand/notes.txt', now() - interval '2 hours');

-- No API role can put an object in the bucket: no storage policy names it (and the RESTRICTIVE
-- belt, where the migration role may add it, refuses it outright).
set local role authenticated;
select c16s_claims('admin', '00000000-0000-0000-0000-0000000000b1');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('crm-files', 'x/y/z.pdf') $$,
  '42501', null, 'an authenticated admin cannot write into the contact-files bucket');
select is((select count(*)::int from storage.objects where bucket_id = 'crm-files'), 0,
  'nor read an object in it');
reset role;
set local role anon;
select c16s_claims(null, null);
select is(c16s_anon_visible(), 0, 'anon sees no object in the bucket');
reset role;

-- The orphan reader (the Worker's sweep) runs as the service role against the storage schema.
set local role service_role;
select is((select string_agg(object_name, ',') from public.crm_file_orphans(60, 10)),
  'c1600000-0000-4000-8000-0000000000b1/c1600000-0000-4000-8000-0000000000c1/c1600000-0000-4000-8000-0000000000d1.pdf',
  'the sweep finds the object no row names, older than the grace, in the Worker''s shape only');
select is((select count(*)::int from public.crm_file_orphans(5, 10)), 2,
  'with a short grace the young one is found too (never the named one or one put in by hand)');
select throws_ok($$ select * from public.crm_file_orphans(-1, 10) $$, '22023', null,
  'a negative grace is refused');
reset role;
delete from public.crm_contacts where id = 'c1600000-0000-4000-8000-0000000000c1';
set local role service_role;
select is((select count(*)::int from public.crm_file_orphans(60, 10)), 2,
  'when the contact goes (retention), its file''s object is an orphan the sweep removes');
reset role;

-- The belt (0140 §9), proven rather than assumed (C16 review, C16-SEC-2 and C16-COR-6; as
-- media_uploads.test.sql proves 0045's). Without it nothing names the bucket, so the refusals
-- above hold either way; here a permissive policy opens EVERY bucket to anon and authenticated
-- (as a later migration for some other bucket might), and the crm-files bucket must stay shut
-- while the other bucket opens. Adding a policy on storage.objects needs its owner's rights,
-- the same rights 0140 needed for the belt: where this role holds them the belt must exist;
-- where it does not, 0140's postcondition checked that no permissive policy admits either
-- role, and these are skipped, saying so.
create function c16s_objects(p_bucket text) returns int language plpgsql as $f$
begin
  return (select count(*)::int from storage.objects where bucket_id = p_bucket);
exception when insufficient_privilege then
  return -1;
end $f$;
create function c16s_touch(p_bucket text) returns int language plpgsql as $f$
declare n int;
begin
  update storage.objects set metadata = coalesce(metadata, '{}'::jsonb) where bucket_id = p_bucket;
  get diagnostics n = row_count;
  return n;
exception when insufficient_privilege then
  return -1;
end $f$;
create function c16s_can(p_role text, p_privilege text) returns boolean language sql as $f$
  select has_table_privilege(p_role, 'storage.objects', p_privilege) $f$;
grant execute on function c16s_objects(text), c16s_touch(text), c16s_can(text, text) to anon, authenticated;

create function c16s_belt_probe() returns setof text language plpgsql as $f$
declare
  v_open boolean := true;
begin
  begin
    create policy c16s_open_all on storage.objects as permissive
      for all to anon, authenticated using (true) with check (true);
  exception when insufficient_privilege then
    v_open := false;
  end;

  if v_open or exists (select 1 from pg_policies where schemaname = 'storage'
                         and tablename = 'objects' and policyname = 'crm_files_bucket_service_only') then
    return next is(
      (select permissive || '|' || cmd || '|'
              || array_to_string(array(select x::text from unnest(roles) as x order by 1), ',')
              || '|' || qual || '|' || with_check
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'crm_files_bucket_service_only'),
      'RESTRICTIVE|ALL|anon,authenticated|(bucket_id <> ''crm-files''::text)|(bucket_id <> ''crm-files''::text)',
      'the belt exists: RESTRICTIVE, every command, anon and authenticated, never the crm-files bucket');
  else
    return next skip('this role may not add a storage.objects policy; 0140 checked that no permissive policy admits anon or authenticated', 1);
  end if;
  if not v_open then
    return next skip('this role may not add a storage.objects policy, so the belt cannot be opened against here', 8);
    return;
  end if;

  -- A bucket no belt names, and one object in each (the service role writes, as the Worker).
  insert into storage.buckets (id, name, public) values ('c16s-open', 'c16s-open', false);
  set local role service_role;
  insert into storage.objects (bucket_id, name) values
    ('crm-files', 'belt/probe.pdf'),
    ('c16s-open', 'c16s/open.txt');
  reset role;

  set local role authenticated;
  perform c16s_claims('admin', '00000000-0000-0000-0000-0000000000b1');
  return next is(c16s_objects('c16s-open'),
    case when c16s_can('authenticated', 'select') then 1 else -1 end,
    'control: the open policy lets a staff token read the other bucket');
  return next is(c16s_objects('crm-files'),
    case when c16s_can('authenticated', 'select') then 0 else -1 end,
    'the belt hides every contact file from a staff token, whatever else is permitted');
  return next is(c16s_touch('crm-files'),
    case when c16s_can('authenticated', 'select') and c16s_can('authenticated', 'update') then 0 else -1 end,
    'the belt leaves a staff token no contact file to change (or delete: the same USING)');
  return next throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('crm-files', 'x/y/z.pdf') $$,
    '42501', null, 'the belt refuses a staff token''s write into the crm-files bucket, even opened');
  reset role;

  set local role anon;
  perform c16s_claims(null, null);
  return next is(c16s_objects('c16s-open'),
    case when c16s_can('anon', 'select') then 1 else -1 end,
    'control: the open policy lets anon read the other bucket');
  return next is(c16s_objects('crm-files'),
    case when c16s_can('anon', 'select') then 0 else -1 end,
    'the belt hides every contact file from anon');
  return next is(c16s_touch('crm-files'),
    case when c16s_can('anon', 'select') and c16s_can('anon', 'update') then 0 else -1 end,
    'the belt leaves anon no contact file to change');
  return next throws_ok(
    $$ insert into storage.objects (bucket_id, name) values ('crm-files', 'x/y/z.pdf') $$,
    '42501', null, 'the belt refuses anon''s write into the crm-files bucket, even opened');
  reset role;

  drop policy c16s_open_all on storage.objects;
end $f$;
select * from c16s_belt_probe();

select * from finish();
rollback;
