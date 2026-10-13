-- pgTAP: the lead-notification trigger (0048, hotfix H9). Run with `supabase test db`.
--
-- 0010 created leads_notify only where pg_net was installed when it ran; production's was
-- not, and no lead was ever announced, with nothing anywhere to say so. These assertions are
-- about what reaches pg_net's queue, not about the insert merely succeeding:
--
--   1. the function: SECURITY DEFINER, an empty search_path, an owner that bypasses RLS
--      (site_settings is FORCE RLS), and no API role (anon, authenticated, service_role,
--      PUBLIC) may execute it;
--   2. the trigger: enabled, AFTER INSERT FOR EACH ROW, no WHEN, calling the function; the
--      only caller of it, and the only trigger on leads that makes an HTTP call;
--   3. what it queues: nothing without a URL; nothing for an http:// URL (the bearer never
--      travels in plaintext); for an https:// URL and the Vault secret, exactly one POST to
--      that URL whose body is exactly {lead_id, tenant_id} and whose headers are exactly
--      the JSON content type and `Bearer <the secret>`; a lead in another tenant goes to
--      that tenant's URL only; a lead arriving through crm_ingest_lead (the service role,
--      the contact form's door) is announced once, and its retry is not announced again;
--   4. nothing it does fails an insert: a URL pg_net may refuse, and a configuration read
--      that raises (site_settings' column renamed inside this transaction), both leave the
--      lead saved.
--
-- Where pg_net is not installed, 0048 creates no trigger: (2) checks that none calls the
-- function and (3)-(4) are skipped, saying so. Requests are counted from this transaction's
-- own statistics (pg_stat_xact_user_tables, n_tup_ins on net.http_request_queue), which need
-- no privilege on pg_net's table; what a request holds is read from the table itself, and
-- skipped where this role may not read it. The Vault secret is created inside the
-- transaction and rolled back with it. CLAUDE.md §3 (Pillar 1), §9, §10.

begin;
select plan(27);

insert into public.tenants (id, name) values
  ('48000000-0000-4000-8000-00000000000a', 'NotifyA'),
  ('48000000-0000-4000-8000-00000000000b', 'NotifyB');
insert into public.site_settings (tenant_id) values
  ('48000000-0000-4000-8000-00000000000a'),
  ('48000000-0000-4000-8000-00000000000b')
on conflict (tenant_id) do nothing;

-- The bearer this test expects, in Vault under the name the trigger reads.
do $$
declare
  v_id uuid;
  v_secret text := 'pgtap-notify-' || gen_random_uuid();
begin
  select id into v_id from vault.secrets where name = 'notify_lead_secret';
  if v_id is null then
    perform vault.create_secret(v_secret, 'notify_lead_secret', 'pgTAP lead_notify (rolled back)');
  else
    perform vault.update_secret(v_id, v_secret);
  end if;
end $$;

create function _url(p_tenant uuid, p_url text) returns void language sql as $$
  update public.site_settings
     set identity = case when p_url is null then identity - 'notify_lead_url'
                         else identity || jsonb_build_object('notify_lead_url', p_url) end
   where tenant_id = p_tenant
$$;

-- Requests this transaction has queued so far (its own inserts into pg_net's queue).
create function _queued() returns bigint language sql as $$
  select coalesce((select s.n_tup_ins from pg_stat_xact_user_tables s
                    where s.schemaname = 'net' and s.relname = 'http_request_queue'), 0)
$$;

-- Whether this role may read pg_net's queue.
create function _readable() returns boolean language plpgsql as $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'net' and c.relname = 'http_request_queue') then
    return false;
  end if;
  return has_schema_privilege('net', 'usage')
     and has_table_privilege('net.http_request_queue', 'select');
end $$;

-- The queued requests that name a lead.
create function _requests(p_lead uuid)
returns table (method text, url text, headers jsonb, body jsonb) language plpgsql as $$
begin
  return query
    select q.method::text, q.url::text, q.headers, convert_from(q.body, 'UTF8')::jsonb
      from net.http_request_queue q
     where convert_from(q.body, 'UTF8') like '%' || p_lead::text || '%';
end $$;

-- ---- 1. The function --------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'app.tg_notify_lead()'::regprocedure),
  'app.tg_notify_lead() is SECURITY DEFINER with an empty search_path');
select ok(
  (select r.rolsuper or r.rolbypassrls
     from pg_proc f join pg_roles r on r.oid = f.proowner
    where f.oid = 'app.tg_notify_lead()'::regprocedure),
  'its owner bypasses RLS, so it reads the URL past site_settings'' staff-only policy');
select ok(not has_function_privilege('anon', 'app.tg_notify_lead()', 'execute'),
  'anon cannot execute app.tg_notify_lead()');
select ok(not has_function_privilege('authenticated', 'app.tg_notify_lead()', 'execute'),
  'authenticated cannot execute app.tg_notify_lead()');
select ok(not has_function_privilege('service_role', 'app.tg_notify_lead()', 'execute'),
  'service_role cannot execute app.tg_notify_lead()');
select ok(not has_function_privilege('public', 'app.tg_notify_lead()', 'execute'),
  'PUBLIC cannot execute app.tg_notify_lead()');

-- ---- 2. The trigger ---------------------------------------------------------------------------
create function _shape() returns setof text language plpgsql as $f$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return next ok(
      not exists (select 1 from pg_trigger
                   where tgfoid = 'app.tg_notify_lead()'::regprocedure),
      'without pg_net, no trigger calls app.tg_notify_lead()');
    return next skip('pg_net is not installed here, so 0048 created no trigger', 1);
    return;
  end if;
  -- tgtype 5: ROW (1) + INSERT (4), BEFORE (2) clear.
  return next is(
    (select t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype || '|'
            || (t.tgqual is null) || '|' || t.tgnargs || '|'
            || (t.tgfoid = 'app.tg_notify_lead()'::regprocedure)
       from pg_trigger t
      where t.tgrelid = 'public.leads'::regclass and t.tgname = 'leads_notify'),
    'leads_notify|O|5|true|0|true',
    'leads_notify: enabled, AFTER INSERT FOR EACH ROW, no WHEN, calls app.tg_notify_lead()');
  return next ok(
    (select count(*) = 1 from pg_trigger
      where tgfoid = 'app.tg_notify_lead()'::regprocedure)
    and not exists (
      select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
       where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal
         and t.tgname <> 'leads_notify' and f.prosrc ~* 'http_(post|get|delete|request)'),
    'one announcement per lead: leads_notify alone calls the function, and no other trigger on leads makes an HTTP call');
end $f$;
select * from _shape();

-- ---- 3 and 4. What reaches the queue --------------------------------------------------------
create function _cases() returns setof text language plpgsql as $f$
declare
  a constant uuid := '48000000-0000-4000-8000-00000000000a';
  b constant uuid := '48000000-0000-4000-8000-00000000000b';
  a_url constant text := 'https://notify-a.pgtap.invalid/api/hooks/notify-lead';
  b_url constant text := 'https://notify-b.pgtap.invalid/api/hooks/notify-lead';
  v_secret text := (select decrypted_secret from vault.decrypted_secrets
                     where name = 'notify_lead_secret');
  v_read boolean;
  v_n bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return next skip('pg_net is not installed here, so nothing is ever queued', 19);
    return;
  end if;
  v_read := _readable();

  -- No URL: notifications are off for the tenant.
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a1', '48000000-0000-4000-8000-00000000000a', 'One', 'x', 'hi') $$,
    'no notify_lead_url: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'no notify_lead_url: no request is queued');

  -- http://: the bearer would travel in plaintext, so nothing is sent.
  perform _url(a, 'http://notify-a.pgtap.invalid/api/hooks/notify-lead');
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a2', '48000000-0000-4000-8000-00000000000a', 'Two', 'x', 'hi') $$,
    'an http:// URL: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'an http:// URL: no request is queued');

  -- https:// and the Vault secret: one request, the id and tenant only.
  perform _url(a, a_url);
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a3', '48000000-0000-4000-8000-00000000000a', 'Three', 'x', 'hi') $$,
    'an https:// URL: the lead is saved');
  return next is(_queued() - v_n, 1::bigint, 'an https:// URL: exactly one request is queued');
  if v_read then
    return next is(
      (select r.body from _requests('48000000-0000-4000-8000-0000000000a3') r),
      jsonb_build_object('lead_id', '48000000-0000-4000-8000-0000000000a3'::uuid, 'tenant_id', a),
      'the body is exactly {lead_id, tenant_id}: nothing the lead says');
    return next is(
      (select r.headers from _requests('48000000-0000-4000-8000-0000000000a3') r),
      jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      'the headers are exactly the JSON content type and Authorization: Bearer <the Vault secret>');
    return next is(
      (select r.method || ' ' || r.url from _requests('48000000-0000-4000-8000-0000000000a3') r),
      'POST ' || a_url,
      'it is a POST to the tenant''s own URL');
  else
    return next skip('this role may not read net.http_request_queue', 3);
  end if;

  -- other_tenant: tenant B's lead goes to tenant B's URL, never tenant A's.
  perform _url(b, b_url);
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000b1', '48000000-0000-4000-8000-00000000000b', 'Other', 'x', 'hi') $$,
    'tenant B: the lead is saved');
  return next is(_queued() - v_n, 1::bigint, 'tenant B: exactly one request is queued');
  if v_read then
    return next is(
      (select string_agg(r.url, ', ') from _requests('48000000-0000-4000-8000-0000000000b1') r),
      b_url,
      'tenant B''s lead goes to tenant B''s URL only, never tenant A''s');
  else
    return next skip('this role may not read net.http_request_queue', 1);
  end if;

  -- The contact form's door: crm_ingest_lead as the service role. Announced once; its
  -- retry (the same id, a lost answer) inserts nothing, so it is not announced again.
  v_n := _queued();
  set local role service_role;
  perform set_config('request.jwt.claims', '', true);
  return next is(
    public.crm_ingest_lead(a, jsonb_build_object(
      'id', '48000000-0000-4000-8000-0000000000a4', 'name', 'Form', 'email_enc', 'x', 'message', 'hi')),
    '48000000-0000-4000-8000-0000000000a4'::uuid,
    'crm_ingest_lead (the service role) saves the lead');
  reset role;
  return next is(_queued() - v_n, 1::bigint, 'crm_ingest_lead: exactly one request is queued');
  v_n := _queued();
  set local role service_role;
  perform public.crm_ingest_lead(a, jsonb_build_object(
    'id', '48000000-0000-4000-8000-0000000000a4', 'name', 'Form', 'email_enc', 'x', 'message', 'hi'));
  reset role;
  return next is(_queued() - v_n, 0::bigint, 'a retried crm_ingest_lead is not announced again');

  -- An https URL pg_net may refuse when it queues (curl rejects a space): the lead is saved.
  perform _url(a, 'https://notify a.pgtap.invalid/api/hooks/notify-lead');
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a5', '48000000-0000-4000-8000-00000000000a', 'Five', 'x', 'hi') $$,
    'a URL pg_net may refuse: the lead is saved');

  -- A configuration read that raises (42703: the column is gone, inside this transaction
  -- only), with a URL that would otherwise be called: caught, and the lead is saved.
  perform _url(a, a_url);
  execute 'alter table public.site_settings rename column identity to identity_pgtap_off';
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a6', '48000000-0000-4000-8000-00000000000a', 'Six', 'x', 'hi') $$,
    'a configuration read that raises inside the trigger does not fail the insert');
  return next is(_queued() - v_n, 0::bigint, '... and queues nothing');
  execute 'alter table public.site_settings rename column identity_pgtap_off to identity';
  return next ok(
    exists (select 1 from public.leads where id = '48000000-0000-4000-8000-0000000000a6'),
    '... and the lead is there');
end $f$;
select * from _cases();

select * from finish();
rollback;
