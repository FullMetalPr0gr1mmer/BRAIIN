-- pgTAP: the lead-notification trigger (0048, hotfix H9). Run with `supabase test db`.
--
-- 0010 created leads_notify only where pg_net was installed when it ran; production's was
-- not, and no lead was ever announced, with nothing anywhere to say so. These assertions are
-- about what reaches pg_net's queue, not about the insert merely succeeding:
--
--   1. the function: SECURITY DEFINER, an empty search_path, an owner that bypasses RLS,
--      and no API role (anon, authenticated, service_role, PUBLIC) may execute it;
--   2. pg_net is there (0048 creates it) and the trigger is enabled, AFTER INSERT FOR EACH
--      ROW, no WHEN, calling the function; the only caller of it, and the only trigger on
--      leads that makes an HTTP call;
--   3. what it queues: nothing without the Vault URL; nothing for an http:// URL; nothing
--      for an https:// URL without the Vault secret; with both, exactly one POST to that URL
--      whose body is exactly {lead_id, tenant_id} and whose headers are exactly the JSON
--      content type, a timestamp and `v1=<HMAC-SHA-256 of '<ts>.<lead_id>.<tenant_id>'>`
--      under the secret, which the queue never holds; a lead in another tenant is signed
--      with that tenant's id; a lead arriving through crm_ingest_lead (the service role,
--      the contact form's door) is announced once, and its retry is not announced again;
--   4. nothing it does fails an insert: a URL pg_net refuses leaves the lead saved and
--      nothing queued.
--
-- Nothing is skipped: 0048 creates pg_net where it is missing, so a database without it,
-- or a queue this role cannot read, fails here rather than passing as skips. Requests are
-- counted from this transaction's own statistics (pg_stat_xact_user_tables, n_tup_ins on
-- net.http_request_queue) and read from the queue itself. The Vault secrets are set inside
-- the transaction and rolled back with it. CLAUDE.md §3 (Pillar 1), §9, §10.

begin;
select plan(34);

insert into public.tenants (id, name) values
  ('48000000-0000-4000-8000-00000000000a', 'NotifyA'),
  ('48000000-0000-4000-8000-00000000000b', 'NotifyB');

-- A Vault secret by name: set (created if missing), or taken away (renamed aside), inside
-- this transaction.
create function _vault(p_name text, p_value text) returns void language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if p_value is null then
    if v_id is not null then
      perform vault.update_secret(v_id, new_name := p_name || '-pgtap-off-' || gen_random_uuid());
    end if;
  elsif v_id is null then
    perform vault.create_secret(p_value, p_name, 'pgTAP lead_notify (rolled back)');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end $$;

-- Whatever this database holds, the suite starts with notifications off.
do $$ begin perform _vault('notify_lead_url', null); perform _vault('notify_lead_secret', null); end $$;

-- Requests this transaction has queued so far (its own inserts into pg_net's queue).
create function _queued() returns bigint language sql as $$
  select coalesce((select s.n_tup_ins from pg_stat_xact_user_tables s
                    where s.schemaname = 'net' and s.relname = 'http_request_queue'), 0)
$$;

-- Whether this role may read pg_net's queue.
create function _readable() returns boolean language plpgsql as $$
begin
  if to_regclass('net.http_request_queue') is null then
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

-- What the Worker recomputes: v1=<hex HMAC-SHA-256(secret, '<ts>.<lead>.<tenant>')>.
create function _sig(p_ts text, p_lead uuid, p_tenant uuid, p_secret text) returns text
language sql as $$
  select 'v1=' || encode(extensions.hmac(p_ts || '.' || p_lead::text || '.' || p_tenant::text,
                                         p_secret, 'sha256'), 'hex')
$$;

-- ---- 1. The function --------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'app.tg_notify_lead()'::regprocedure),
  'app.tg_notify_lead() is SECURITY DEFINER with an empty search_path');
select ok(
  (select r.rolsuper or r.rolbypassrls
     from pg_proc f join pg_roles r on r.oid = f.proowner
    where f.oid = 'app.tg_notify_lead()'::regprocedure),
  'its owner bypasses RLS');
select ok(not has_function_privilege('anon', 'app.tg_notify_lead()', 'execute'),
  'anon cannot execute app.tg_notify_lead()');
select ok(not has_function_privilege('authenticated', 'app.tg_notify_lead()', 'execute'),
  'authenticated cannot execute app.tg_notify_lead()');
select ok(not has_function_privilege('service_role', 'app.tg_notify_lead()', 'execute'),
  'service_role cannot execute app.tg_notify_lead()');
select ok(not has_function_privilege('public', 'app.tg_notify_lead()', 'execute'),
  'PUBLIC cannot execute app.tg_notify_lead()');

-- ---- 2. pg_net and the trigger ------------------------------------------------------------------
select ok(
  exists (select 1 from pg_extension where extname = 'pg_net')
  and to_regclass('net.http_request_queue') is not null
  and to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null,
  'pg_net is installed (0048 creates it), its queue and http_post in schema net');
-- tgtype 5: ROW (1) + INSERT (4), BEFORE (2) clear.
select is(
  (select t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype || '|'
          || (t.tgqual is null) || '|' || t.tgnargs || '|'
          || (t.tgfoid = 'app.tg_notify_lead()'::regprocedure)
     from pg_trigger t
    where t.tgrelid = 'public.leads'::regclass and t.tgname = 'leads_notify'),
  'leads_notify|O|5|true|0|true',
  'leads_notify: enabled, AFTER INSERT FOR EACH ROW, no WHEN, calls app.tg_notify_lead()');
select ok(
  (select count(*) = 1 from pg_trigger
    where tgfoid = 'app.tg_notify_lead()'::regprocedure)
  and not exists (
    select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
     where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal
       and t.tgname <> 'leads_notify' and f.prosrc ~* 'http_(post|get|delete|request)'),
  'one announcement per lead: leads_notify alone calls the function, and no other trigger on leads makes an HTTP call');
select ok(_readable(), 'this role reads pg_net''s queue (unreadable is a failure, not a skip)');

-- ---- 3 and 4. What reaches the queue --------------------------------------------------------
-- The signing scheme on a fixed vector, the one tests/api/notifyLead.spec.ts checks the
-- Worker's verifier against, so the two sides cannot drift apart (the key is that test's
-- dummy secret).
select is(
  _sig('1760000000', '11111111-1111-4111-8111-111111111111',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'test-dummy-notify-lead-secret'),
  'v1=b0d61ac408b980012f8d511b395bf660f9c27e29836763a570d8c2138c7eea22',
  'the signature of a fixed vector matches the Worker''s (tests/api/notifyLead.spec.ts)');

create function _cases() returns setof text language plpgsql as $f$
declare
  a constant uuid := '48000000-0000-4000-8000-00000000000a';
  b constant uuid := '48000000-0000-4000-8000-00000000000b';
  v_url constant text := 'https://notify.pgtap.invalid/api/hooks/notify-lead';
  v_secret constant text := 'pgtap-notify-' || gen_random_uuid();
  v_n bigint;
  r record;
begin
  -- No Vault URL: notifications are off.
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a1', '48000000-0000-4000-8000-00000000000a', 'One', 'x', 'hi') $$,
    'no Vault notify_lead_url: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'no Vault notify_lead_url: no request is queued');

  -- http://, with the secret: the call would travel in plaintext, so nothing is sent.
  perform _vault('notify_lead_url', 'http://notify.pgtap.invalid/api/hooks/notify-lead');
  perform _vault('notify_lead_secret', v_secret);
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a2', '48000000-0000-4000-8000-00000000000a', 'Two', 'x', 'hi') $$,
    'an http:// URL: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'an http:// URL: no request is queued');

  -- https://, no secret: nothing to sign with, so nothing is sent.
  perform _vault('notify_lead_url', v_url);
  perform _vault('notify_lead_secret', null);
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a7', '48000000-0000-4000-8000-00000000000a', 'Seven', 'x', 'hi') $$,
    'an https:// URL without the Vault secret: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'an https:// URL without the Vault secret: no request is queued');

  -- https:// and the secret: one request, the ids only, signed.
  perform _vault('notify_lead_secret', v_secret);
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a3', '48000000-0000-4000-8000-00000000000a', 'Three', 'x', 'hi') $$,
    'configured: the lead is saved');
  return next is(_queued() - v_n, 1::bigint, 'configured: exactly one request is queued');
  select * into r from _requests('48000000-0000-4000-8000-0000000000a3');
  return next is(
    r.body,
    jsonb_build_object('lead_id', '48000000-0000-4000-8000-0000000000a3'::uuid, 'tenant_id', a),
    'the body is exactly {lead_id, tenant_id}: nothing the lead says');
  return next is(
    (select string_agg(k, ',' order by k) from jsonb_object_keys(r.headers) k)
      || '|' || (r.headers ->> 'Content-Type'),
    'Content-Type,X-Braiin-Signature,X-Braiin-Timestamp|application/json',
    'the headers are exactly the JSON content type, the timestamp and the signature');
  return next is(
    r.headers ->> 'X-Braiin-Signature',
    _sig(r.headers ->> 'X-Braiin-Timestamp', '48000000-0000-4000-8000-0000000000a3', a, v_secret),
    'the signature is v1=HMAC-SHA-256(the Vault secret, ''<ts>.<lead_id>.<tenant_id>'')');
  return next ok(
    (r.headers ->> 'X-Braiin-Timestamp') ~ '^[0-9]{1,12}$'
    and abs((r.headers ->> 'X-Braiin-Timestamp')::bigint
            - floor(extract(epoch from clock_timestamp()))::bigint) <= 300,
    'the timestamp is unix seconds, within the Worker''s 300 s of the clock');
  return next ok(
    position(v_secret in r.headers::text) = 0 and position(v_secret in r.body::text) = 0
    and position(v_secret in r.url) = 0 and not (r.headers ? 'Authorization'),
    'the queue never holds the secret, and there is no bearer');
  return next is(r.method || ' ' || r.url, 'POST ' || v_url, 'it is a POST to the Vault URL');

  -- other_tenant: tenant B's lead is signed with tenant B's id, and A's id does not verify.
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000b1', '48000000-0000-4000-8000-00000000000b', 'Other', 'x', 'hi') $$,
    'tenant B: the lead is saved');
  return next is(_queued() - v_n, 1::bigint, 'tenant B: exactly one request is queued');
  select * into r from _requests('48000000-0000-4000-8000-0000000000b1');
  return next ok(
    r.body ->> 'tenant_id' = b::text
    and r.headers ->> 'X-Braiin-Signature'
        = _sig(r.headers ->> 'X-Braiin-Timestamp', '48000000-0000-4000-8000-0000000000b1', b, v_secret)
    and r.headers ->> 'X-Braiin-Signature'
        <> _sig(r.headers ->> 'X-Braiin-Timestamp', '48000000-0000-4000-8000-0000000000b1', a, v_secret),
    'the signature binds the tenant: B''s lead is signed with B''s id, and A''s id does not verify');

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

  -- An https URL pg_net refuses when it queues (curl's URL parser rejects a space in the
  -- host): the error is caught inside the trigger, and the lead is saved.
  perform _vault('notify_lead_url', 'https://notify a.pgtap.invalid/api/hooks/notify-lead');
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a5', '48000000-0000-4000-8000-00000000000a', 'Five', 'x', 'hi') $$,
    'a URL pg_net refuses: the insert does not fail');
  return next is(_queued() - v_n, 0::bigint, '... and nothing is queued');
  return next ok(
    exists (select 1 from public.leads where id = '48000000-0000-4000-8000-0000000000a5'),
    '... and the lead is there');
end $f$;
select * from _cases();

select * from finish();
rollback;
