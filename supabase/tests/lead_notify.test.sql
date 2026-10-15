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
--      leads that makes an HTTP call; no trigger is attached to pg_net's queue;
--   3. what it queues: nothing without the Vault URL, even where the tenant's site_settings
--      carry 0010's https notify_lead_url and the Vault secret is set (that source, which
--      Admin and Developer write, is never read); nothing for an http:// URL; nothing
--      for an https:// URL without the Vault secret; with both, exactly one POST to that URL
--      whose body is exactly {lead_id, tenant_id} and whose headers are exactly the JSON
--      content type, a timestamp and `v1=<HMAC-SHA-256 of '<ts>.<lead_id>.<tenant_id>'>`
--      under the secret, which the queue never holds; a lead in another tenant is signed
--      with that tenant's id; a lead arriving through crm_ingest_lead (the service role,
--      the contact form's door) is announced once, and its retry is not announced again;
--      a lead staff add by hand (source 'manual', 0041) is announced too;
--   4. nothing it does fails an insert: a URL pg_net refuses leaves the lead saved and
--      nothing queued, and a system_logs row that cannot be written fails nothing either;
--   5. not silent: configured but not announced (http://, no secret, an error) writes one
--      system_logs row (warn, source leads_notify, a fixed message, detail {} or
--      {sqlstate}); not configured, and announced, write none;
--   6. the daily check, public.lead_notify_misses(): a definer for the service role alone;
--      null while not configured; once configured, the leads created from 24 h 30 min to
--      15 min before it with no notification_log row, both edges checked: so one day's run
--      reaches into the window of the day before, and no lead falls between them;
--   7. a trigger attached to pg_net's queue (PUBLIC holds TRIGGER on it, EXC-012, and the
--      queue is written as the function's owner): nothing is queued, the attached trigger
--      never runs, the lead is saved and one system_logs row says why.
--
-- Nothing is skipped: 0048 creates pg_net where it is missing, so a database without it,
-- or a queue this role cannot read, fails here rather than passing as skips. Requests are
-- counted from this transaction's own statistics (pg_stat_xact_user_tables, n_tup_ins on
-- net.http_request_queue) and read from the queue itself. The Vault secrets are set inside
-- the transaction and rolled back with it. CLAUDE.md §3 (Pillar 1), §9, §10.

begin;
select plan(65);

insert into public.tenants (id, name) values
  ('48000000-0000-4000-8000-00000000000a', 'NotifyA'),
  ('48000000-0000-4000-8000-00000000000b', 'NotifyB');
-- Who adds a lead by hand in tenant A.
insert into auth.users (id, email) values
  ('48000000-0000-4000-8000-0000000000e1', 'notify-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('48000000-0000-4000-8000-0000000000e1', '48000000-0000-4000-8000-00000000000a', 'admin', true, null);

-- A Vault secret by name: set (created if missing), or taken away (renamed aside), inside
-- this transaction.
create function _vault(p_name text, p_value text) returns void language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if p_value is null then
    if v_id is not null then
      -- Positional, as Vault's documentation calls it: (id, new_secret, new_name); a null
      -- new_secret keeps the value.
      perform vault.update_secret(v_id, null, p_name || '-pgtap-off-' || gen_random_uuid());
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

-- This tenant's leads_notify rows in system_logs, and the latest as level|message|detail.
create function _logs(p_tenant uuid) returns bigint language sql as $$
  select count(*) from public.system_logs where tenant_id = p_tenant and source = 'leads_notify'
$$;
create function _last_log(p_tenant uuid) returns text language sql as $$
  select l.level || '|' || l.message || '|' || l.detail::text
    from public.system_logs l
   where l.tenant_id = p_tenant and l.source = 'leads_notify'
   order by l.id desc limit 1
$$;

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

-- The daily check's function: the service role's alone (other_tenant has no path to it:
-- no staff token executes it at all).
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.lead_notify_misses()'::regprocedure),
  'public.lead_notify_misses() is SECURITY DEFINER with an empty search_path');
select ok(has_function_privilege('service_role', 'public.lead_notify_misses()', 'execute'),
  'service_role executes public.lead_notify_misses()');
select ok(
  not has_function_privilege('anon', 'public.lead_notify_misses()', 'execute')
  and not has_function_privilege('authenticated', 'public.lead_notify_misses()', 'execute')
  and not has_function_privilege('public', 'public.lead_notify_misses()', 'execute'),
  'anon, authenticated and PUBLIC cannot execute public.lead_notify_misses()');
set local role authenticated;
select throws_ok($$ select public.lead_notify_misses() $$, '42501', null,
  'a staff token calling public.lead_notify_misses() is refused');
reset role;

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
select ok(
  not exists (select 1 from pg_trigger t
               where t.tgrelid = 'net.http_request_queue'::regclass and not t.tgisinternal),
  'no trigger is attached to pg_net''s queue (0048 refuses to apply over one)');

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
  v_l bigint;
  v_m integer;
  r record;
begin
  -- No Vault URL: notifications are off.
  v_n := _queued();
  v_l := _logs(a);
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a1', '48000000-0000-4000-8000-00000000000a', 'One', 'x', 'hi') $$,
    'no Vault notify_lead_url: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'no Vault notify_lead_url: no request is queued');
  return next is(_logs(a) - v_l, 0::bigint,
    'no Vault notify_lead_url: nothing is logged per lead (the daily check reports it)');

  -- 0010's source, which Admin and Developer write: tenant A's site_settings name an https
  -- URL, and the Vault secret 0010 signed with is set. Still no Vault URL, so nothing goes
  -- anywhere; a function that read site_settings again would queue here. The row stays for
  -- the rest of the suite, so every later request also shows where the URL comes from.
  insert into public.site_settings (tenant_id, identity)
    values (a, jsonb_build_object('notify_lead_url', 'https://staff-chosen.pgtap.invalid/x'))
  on conflict (tenant_id) do update set identity = excluded.identity;
  perform _vault('notify_lead_secret', v_secret);
  v_n := _queued();
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000aa', '48000000-0000-4000-8000-00000000000a', 'Ten', 'x', 'hi') $$,
    'site_settings.identity.notify_lead_url (https) and the secret, no Vault URL: the lead is saved');
  return next is(_queued() - v_n, 0::bigint,
    'site_settings.identity.notify_lead_url (https) and the secret, no Vault URL: no request is queued');
  perform _vault('notify_lead_secret', null);

  -- http://, with the secret: the call would travel in plaintext, so nothing is sent.
  perform _vault('notify_lead_url', 'http://notify.pgtap.invalid/api/hooks/notify-lead');
  perform _vault('notify_lead_secret', v_secret);
  v_n := _queued();
  v_l := _logs(a);
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a2', '48000000-0000-4000-8000-00000000000a', 'Two', 'x', 'hi') $$,
    'an http:// URL: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'an http:// URL: no request is queued');
  return next is(_logs(a) - v_l, 1::bigint, 'an http:// URL: one system_logs row, in the lead''s tenant');
  return next is(_last_log(a),
    'warn|lead notification skipped: the Vault notify_lead_url is not an https URL|{}',
    '... a warning with a fixed message, naming no value');

  -- https://, no secret: nothing to sign with, so nothing is sent.
  perform _vault('notify_lead_url', v_url);
  perform _vault('notify_lead_secret', null);
  v_n := _queued();
  v_l := _logs(a);
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a7', '48000000-0000-4000-8000-00000000000a', 'Seven', 'x', 'hi') $$,
    'an https:// URL without the Vault secret: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'an https:// URL without the Vault secret: no request is queued');
  return next is(_logs(a) - v_l, 1::bigint, 'an https:// URL without the Vault secret: one system_logs row');
  return next is(_last_log(a),
    'warn|lead notification skipped: the Vault secret notify_lead_secret is missing|{}',
    '... a warning with a fixed message, naming no value');

  -- https:// and the secret: one request, the ids only, signed.
  perform _vault('notify_lead_secret', v_secret);
  v_n := _queued();
  v_l := _logs(a);
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a3', '48000000-0000-4000-8000-00000000000a', 'Three', 'x', 'hi') $$,
    'configured: the lead is saved');
  return next is(_queued() - v_n, 1::bigint, 'configured: exactly one request is queued');
  return next is(_logs(a) - v_l, 0::bigint, 'configured and announced: nothing is logged');
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
  return next is(r.method || ' ' || r.url, 'POST ' || v_url,
    'it is a POST to the Vault URL, not the one in tenant A''s site_settings');

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

  -- A lead added by hand (0041: source 'manual', naming who added it) is announced too.
  v_n := _queued();
  set local role service_role;
  return next is(
    public.crm_ingest_lead(a, jsonb_build_object(
      'id', '48000000-0000-4000-8000-0000000000a8', 'name', 'Walk-in', 'email_enc', 'x',
      'message', 'came by', 'source', 'manual', 'channel', 'walk_in',
      'created_by', '48000000-0000-4000-8000-0000000000e1')),
    '48000000-0000-4000-8000-0000000000a8'::uuid,
    'a manual lead (source manual) is saved');
  reset role;
  return next is(_queued() - v_n, 1::bigint, 'a manual lead is announced, once');

  -- An https URL pg_net refuses when it queues (curl's URL parser rejects a space in the
  -- host): the error is caught inside the trigger, and the lead is saved.
  perform _vault('notify_lead_url', 'https://notify a.pgtap.invalid/api/hooks/notify-lead');
  v_n := _queued();
  v_l := _logs(a);
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a5', '48000000-0000-4000-8000-00000000000a', 'Five', 'x', 'hi') $$,
    'a URL pg_net refuses: the insert does not fail');
  return next is(_queued() - v_n, 0::bigint, '... and nothing is queued');
  return next ok(
    exists (select 1 from public.leads where id = '48000000-0000-4000-8000-0000000000a5'),
    '... and the lead is there');
  return next is(_logs(a) - v_l, 1::bigint, '... and one system_logs row says so');
  return next ok(
    (select l.level = 'warn' and l.message = 'lead notification not queued'
            and (select array_agg(k) from jsonb_object_keys(l.detail) k) = array['sqlstate']
            and l.detail ->> 'sqlstate' ~ '^[0-9A-Z]{5}$'
       from public.system_logs l
      where l.tenant_id = a and l.source = 'leads_notify'
      order by l.id desc limit 1),
    '... carrying the SQLSTATE and nothing else');

  -- A system_logs row that cannot be written (the column renamed, inside this transaction
  -- only) fails nothing: the lead is saved.
  perform _vault('notify_lead_url', 'http://notify.pgtap.invalid/api/hooks/notify-lead');
  execute 'alter table public.system_logs rename column message to message_pgtap_off';
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a6', '48000000-0000-4000-8000-00000000000a', 'Six', 'x', 'hi') $$,
    'a log row that cannot be written does not fail the insert');
  execute 'alter table public.system_logs rename column message_pgtap_off to message';
  return next ok(
    exists (select 1 from public.leads where id = '48000000-0000-4000-8000-0000000000a6'),
    '... and the lead is there');

  -- The daily check, as the cron calls it (the service role).
  perform _vault('notify_lead_url', null);
  set local role service_role;
  v_m := public.lead_notify_misses();
  reset role;
  return next is(v_m, null::integer, 'the daily check: null while notifications are not configured');

  perform _vault('notify_lead_url', v_url);
  set local role service_role;
  v_m := public.lead_notify_misses();
  reset role;
  insert into public.leads (id, tenant_id, name, email_enc, message, created_at) values
    ('48000000-0000-4000-8000-0000000000c1', a, 'An hour ago', 'x', 'hi', now() - interval '1 hour');
  set local role service_role;
  return next is(public.lead_notify_misses(), v_m + 1,
    'the daily check: a configured lead an hour old with no notification_log row is a miss');
  reset role;
  insert into public.leads (id, tenant_id, name, email_enc, message, created_at) values
    ('48000000-0000-4000-8000-0000000000c2', b, 'Just now', 'x', 'hi', now() - interval '5 minutes'),
    ('48000000-0000-4000-8000-0000000000c3', b, 'Yesterday', 'x', 'hi', now() - interval '25 hours');
  set local role service_role;
  return next is(public.lead_notify_misses(), v_m + 1,
    'the daily check: a lead 5 minutes old or 25 hours old is not counted');
  reset role;
  insert into public.notification_log (tenant_id, lead_id, channel, status)
    values (a, '48000000-0000-4000-8000-0000000000c1', 'inbox', 'queued');
  set local role service_role;
  return next is(public.lead_notify_misses(), v_m,
    'the daily check: a lead with its notification_log row is not a miss');
  reset role;
  -- The window's edges. now() is this transaction's start, the same in the inserts and in
  -- the function, so an edge can be hit to the microsecond.
  insert into public.leads (id, tenant_id, name, email_enc, message, created_at) values
    ('48000000-0000-4000-8000-0000000000c4', a, 'Day and ten', 'x', 'hi',
     now() - interval '24 hours 10 minutes');
  set local role service_role;
  return next is(public.lead_notify_misses(), v_m + 1,
    'the daily check: a lead 24 h 10 min old is counted (the run a day earlier saw it as 10 minutes old, too young to count)');
  reset role;
  insert into public.leads (id, tenant_id, name, email_enc, message, created_at) values
    ('48000000-0000-4000-8000-0000000000c5', b, 'Oldest edge', 'x', 'hi',
     now() - interval '24 hours 30 minutes'),
    ('48000000-0000-4000-8000-0000000000c6', b, 'Past the edge', 'x', 'hi',
     now() - interval '24 hours 30 minutes' - interval '1 microsecond');
  set local role service_role;
  return next is(public.lead_notify_misses(), v_m + 2,
    'the daily check''s older edge: a lead exactly 24 h 30 min old is counted, one a microsecond older is not');
  reset role;
  insert into public.leads (id, tenant_id, name, email_enc, message, created_at) values
    ('48000000-0000-4000-8000-0000000000c7', a, 'Newest edge', 'x', 'hi',
     now() - interval '15 minutes'),
    ('48000000-0000-4000-8000-0000000000c8', a, 'Just past it', 'x', 'hi',
     now() - interval '15 minutes' - interval '1 microsecond');
  set local role service_role;
  return next is(public.lead_notify_misses(), v_m + 3,
    'the daily check''s newer edge: a lead exactly 15 min old is not counted yet, one a microsecond older is');
  reset role;

  -- 7. Last, because only the table's owner may drop a trigger, so this one stays until the
  -- rollback. Configured (the https Vault URL and the secret are set): a trigger attached to
  -- pg_net's queue, as any login role may (EXC-012), would run as the function's owner on
  -- the queue insert. The function queues nothing instead; the spy records whether it ran.
  perform set_config('pgtap.queue_spy', 'idle', true);
  execute 'create function _queue_spy() returns trigger language plpgsql as $s$
             begin perform set_config(''pgtap.queue_spy'', ''ran'', true); return new; end $s$';
  execute 'create trigger pgtap_queue_spy before insert on net.http_request_queue
             for each row execute function _queue_spy()';
  v_n := _queued();
  v_l := _logs(a);
  return next lives_ok(
    $$ insert into public.leads (id, tenant_id, name, email_enc, message) values
       ('48000000-0000-4000-8000-0000000000a9', '48000000-0000-4000-8000-00000000000a', 'Nine', 'x', 'hi') $$,
    'a trigger on pg_net''s queue: the lead is saved');
  return next is(_queued() - v_n, 0::bigint, 'a trigger on pg_net''s queue: no request is queued');
  return next is(current_setting('pgtap.queue_spy'), 'idle',
    'a trigger on pg_net''s queue: it never runs (as the function''s owner)');
  return next is(_logs(a) - v_l, 1::bigint, 'a trigger on pg_net''s queue: one system_logs row');
  return next is(_last_log(a),
    'warn|lead notification skipped: a trigger is attached to pg_net''s queue|{}',
    '... a warning with a fixed message, naming no value');
end $f$;
select * from _cases();

select * from finish();
rollback;
