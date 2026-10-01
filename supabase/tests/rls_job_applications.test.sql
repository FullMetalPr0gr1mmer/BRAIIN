-- pgTAP: job applications (0029) — Admin only; the public write limiter is service-role
-- only. Six principals: anon, content_creator, seo, developer, admin, other_tenant.
begin;
select plan(27);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');
insert into public.job_applications (id, tenant_id, name, email_enc, phone_enc, city, role,
  experience, work_type, availability, skills, portfolio_url, message, consent_version,
  retention_delete_after)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001',
        'Applicant', 'ciphertext', 'ciphertext', 'Jeddah', 'Motion designer', '1-3',
        'freelance', 'month', array['animation', 'motion-graphics'],
        'https://example.com/work', 'My best piece', '2026-09-30', now() + interval '12 months');

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- Rows a statement touched, as the CURRENT role (security invoker): data-modifying CTEs
-- cannot sit inside a subquery, so the "changes nothing" checks go through this.
create function _rows(p_sql text) returns int language plpgsql as $f$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;

-- ---- anon: refused at the GRANT layer ---------------------------------------------
set local role anon;
select _claims(null, null);
select throws_ok($$ select count(*) from public.job_applications $$, '42501', null,
  'anon is denied job_applications');
select throws_ok(
  $$ insert into public.job_applications (name, email_enc, phone_enc, city, role, experience,
       work_type, availability, portfolio_url, message, consent_version, retention_delete_after)
     values ('x', 'x', 'x', 'x', 'x', '1-3', 'any', 'month', 'https://x.test', 'x', '2026-09-30', now()) $$,
  '42501', null, 'anon cannot insert an application');
select throws_ok($$ select count(*) from public.public_write_attempts $$, '42501', null,
  'anon is denied the limiter table');

-- ---- staff who are not Admin: nothing ---------------------------------------------
set local role authenticated;
select _claims('content_creator', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.job_applications)::int, 0, 'content_creator sees no applications');
select _claims('seo', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.job_applications)::int, 0, 'seo sees no applications');
select _claims('developer', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.job_applications)::int, 0,
  'developer sees no applications (owner decision J6 — unlike leads)');
select is(
  _rows($q$ update public.job_applications set status = 'declined' $q$),
  0, 'developer changes no application');
select is(
  _rows($q$ delete from public.job_applications $q$),
  0, 'developer erases no application');
select throws_ok($$ select count(*) from public.public_write_attempts $$, '42501', null,
  'authenticated is denied the limiter table');

-- ---- other tenant's admin: nothing --------------------------------------------------
select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is((select count(*) from public.job_applications)::int, 0, 'admin of another tenant sees no applications');
select is(
  _rows($q$ update public.job_applications set status = 'declined' $q$),
  0, 'admin of another tenant changes nothing');

-- ---- admin: read, review, cannot insert or touch the record fields -------------------
select _claims('admin', '00000000-0000-0000-0000-000000000001');
select is((select count(*) from public.job_applications)::int, 1, 'admin sees the application');
select throws_ok(
  $$ insert into public.job_applications (name, email_enc, phone_enc, city, role, experience,
       work_type, availability, portfolio_url, message, consent_version, retention_delete_after)
     values ('x', 'x', 'x', 'x', 'x', '1-3', 'any', 'month', 'https://x.test', 'x', '2026-09-30', now()) $$,
  '42501', null, 'even admin cannot insert through the API (only the service role writes them)');
select lives_ok(
  $$ update public.job_applications set status = 'in_review', internal_notes = 'Strong reel'
     where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'admin can change status and notes');
select throws_ok(
  $$ update public.job_applications set retention_delete_after = now() + interval '10 years' $$,
  '42501', null, 'admin cannot extend retention');
select throws_ok(
  $$ update public.job_applications set email_enc = 'other' $$,
  '42501', null, 'admin cannot rewrite the encrypted contact details');
select throws_ok(
  $$ update public.job_applications set consent_version = '2020-01-01' $$,
  '42501', null, 'admin cannot rewrite the consent record');

-- Spam shortens retention to 30 days.
select lives_ok(
  $$ update public.job_applications set status = 'spam' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'admin can mark spam');
select ok(
  (select retention_delete_after <= now() + interval '30 days' + interval '1 minute'
     from public.job_applications where id = '00000000-0000-0000-0000-0000000000a1'),
  'spam caps retention at 30 days');
select lives_ok(
  $$ update public.job_applications set status = 'in_review' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'admin can un-mark spam');
select ok(
  (select retention_delete_after <= now() + interval '30 days' + interval '1 minute'
     from public.job_applications where id = '00000000-0000-0000-0000-0000000000a1'),
  'un-marking spam does not give the time back');

-- ---- the limiter function ---------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.public_write_hit(uuid, text, text, int)', 'execute'),
  'anon cannot execute public_write_hit');
select ok(not has_function_privilege('authenticated', 'public.public_write_hit(uuid, text, text, int)', 'execute'),
  'authenticated cannot execute public_write_hit');

reset role;
set local role service_role;
select is(public.public_write_hit('00000000-0000-0000-0000-000000000001', 'apply:ip',
  repeat('a', 64), 3600), 1, 'the first attempt in a window counts 1');
select is(public.public_write_hit('00000000-0000-0000-0000-000000000001', 'apply:ip',
  repeat('a', 64), 3600), 2, 'the second attempt in the same window counts 2');
select throws_ok(
  $$ select public.public_write_hit('00000000-0000-0000-0000-000000000001', 'apply:ip', 'not-a-hash', 3600) $$,
  '23514', null, 'a key that is not a 64-hex HMAC is refused');

-- ---- admin erase (last: it removes the fixture) -------------------------------------------
reset role;
set local role authenticated;
select _claims('admin', '00000000-0000-0000-0000-000000000001');
select is(
  _rows($q$ delete from public.job_applications where id = '00000000-0000-0000-0000-0000000000a1' $q$),
  1, 'admin can erase an application (DSAR)');

select * from finish();
rollback;
