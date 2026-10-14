-- ─────────────────────────────────────────────────────────────────────────────
-- 0048 — The lead-notification trigger, restored and hardened (hotfix H9). Forward-only,
-- expand only. Depends on 0002 (leads), 0010 (app.tg_notify_lead, the first
-- leads_notify), 0011 (its revoke), 0012 (pgcrypto in schema extensions) and 0034
-- (leads_pipeline, leads_timeline).
--
-- CLAUDE.md §10: a new lead is announced by an AFTER INSERT trigger that asks pg_net to POST
-- {lead_id, tenant_id} to the Worker's /api/hooks/notify-lead; the Worker checks the call is
-- signed and re-reads the row itself. 0010 created that trigger only if pg_net was already
-- installed when it ran. Where it was not, the function exists and nothing calls it, so no
-- lead has ever been announced (notification_log stays empty) and nothing says so. This
-- migration makes pg_net a requirement instead of an option: it creates the extension where
-- it is missing (section 0), re-creates the function hardened (section 1) and creates the
-- trigger on every database (section 3):
--
--   • SECURITY DEFINER with an empty search_path: every name it reaches is qualified
--     (vault.decrypted_secrets, extensions.hmac, net.http_post, pg_catalog's functions) and
--     its variables are pg_catalog.text, so nothing on a caller's path, pg_temp included,
--     can stand in for any of them. 0010's path was `public, app, extensions, net, pg_temp`.
--   • The body is 0010's: exactly {lead_id, tenant_id}, nothing from the lead's content.
--   • Where it goes is the Vault secret `notify_lead_url`: one URL for the deployment, set
--     by whoever holds the database owner (the dashboard's Vault, or SQL as postgres), like
--     the secret beside it. site_settings.identity ->> 'notify_lead_url', 0010's source, is
--     no longer read: Admin and Developer write site_settings (§5), and neither should
--     choose where a signed call about a lead goes. No URL means notifications are off, and
--     the trigger does nothing.
--   • Only an https:// URL is called. Any other URL is skipped, as is a URL with no secret.
--   • Signed, never carrying the secret. pg_net keeps a queued request in
--     net.http_request_queue until its worker sends it, and on Supabase PUBLIC may read that
--     table (EXC-012), so a bearer token in the headers would be readable by every login
--     role. The request carries `X-Braiin-Timestamp: <unix seconds>` and
--     `X-Braiin-Signature: v1=<hex HMAC-SHA-256 under the Vault secret notify_lead_secret of
--     '<timestamp>.<lead_id>.<tenant_id>'>` instead. The canonical string is signed, not the
--     JSON bytes, so no serializer can break it; the Worker recomputes it over the body's
--     ids and refuses a timestamp more than 300 s from its clock. What the queue holds is
--     then good for one lead, for five minutes, and a replay only re-announces that lead.
--   • Nothing it does can fail an insert. Any error while reading the configuration or
--     queueing the request is caught, and the lead is saved. A contact form that fails because a notification could not be
--     queued is the worse failure (0010 §6). 0010's body had no handler, so a pg_net error
--     would have failed the insert.
--   • Not silent. Configured but not announced (a non-https URL, no secret, an error) is a
--     WARNING and a system_logs row (level warn, source leads_notify, a fixed message,
--     detail {sqlstate} for an error, else {}), naming no value: never the URL, the secret
--     or a lead value (an error message can quote any of them, so only the SQLSTATE is
--     kept). The row is written in its own block, so a failed log fails nothing. Not
--     configured at all is not logged per lead; the daily check (section 4) reports it.
--   • The request timeout is explicit (5 s; pg_net's parameter `timeout_milliseconds`). A
--     postcondition checks that net.http_post still takes the named parameters this
--     function passes, so a pg_net whose signature changed fails this migration instead of
--     every lead's notification failing quietly into a WARNING.
--
-- pg_net only queues the request in this transaction (a row in net.http_request_queue); its
-- background worker sends it after commit. A lead whose insert rolls back is never
-- announced, and the Worker always finds the row it is told about.
--
-- Turning notifications on stays an owner step (launch runbook §5): the Vault secrets
-- notify_lead_url (https) and notify_lead_secret, and the Worker secret NOTIFY_LEAD_SECRET
-- with the same value as the Vault one. Until both Vault secrets exist this trigger queues
-- nothing. CLAUDE.md §3 (Pillar 1), §10.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0045): creating the
-- trigger takes a SHARE ROW EXCLUSIVE lock on public.leads, which blocks the contact form's
-- inserts for as long as the lock request waits behind a long transaction. A statement
-- below that waits more than five seconds for a lock raises instead, the whole migration
-- rolls back, and the push is retried later. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

-- ---- 0. pg_net -----------------------------------------------------------------------------
-- A requirement now, not an option: a database without it would save leads that nobody is
-- told about, which is how production ran unannounced. Production has it (in schema
-- `extensions`, preloaded), so this is a no-op there; the CI stack (Supabase local) ships
-- it available but not created, so its pgTAP run exercises the real thing. Whichever
-- schema the extension is recorded in, its objects live in `net` (section 5 checks).
create extension if not exists pg_net with schema extensions;

-- ---- 1. The function ---------------------------------------------------------------------
-- CREATE OR REPLACE keeps 0010's owner and ACL; section 2 states the ACL again.
create or replace function app.tg_notify_lead() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_url pg_catalog.text;
  v_secret pg_catalog.text;
  v_ts pg_catalog.text;
  v_problem pg_catalog.text;  -- set when a configured lead was not announced: a fixed text
  v_state pg_catalog.text;    -- the SQLSTATE, when that was an error
begin
  -- One block, one handler: whatever raises below (a missing schema, a Vault that cannot
  -- decrypt, a URL pg_net refuses, a changed signature) is rolled back to here and the
  -- insert goes on. SQLSTATE only: SQLERRM can quote the URL or the secret.
  begin
    select d.decrypted_secret into v_url
      from vault.decrypted_secrets d
     where d.name = 'notify_lead_url';
    -- Not configured: notifications are off. A choice, not a fault, and not logged here
    -- (it would be one row per lead forever): the daily check says so once a day.
    if v_url is null or v_url = '' then
      return null;
    end if;

    if pg_catalog.lower(pg_catalog.left(v_url, 8)) <> 'https://' then
      v_problem := 'lead notification skipped: the Vault notify_lead_url is not an https URL';
    else
      select d.decrypted_secret into v_secret
        from vault.decrypted_secrets d
       where d.name = 'notify_lead_secret';
      if v_secret is null or v_secret = '' then
        v_problem := 'lead notification skipped: the Vault secret notify_lead_secret is missing';
      else
        -- Signed when the lead is saved (the clock, not the transaction's start), sent
        -- after commit; the Worker allows 300 s either way.
        v_ts := pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()))
                  ::pg_catalog.int8::pg_catalog.text;
        perform net.http_post(
          url := v_url,
          body := pg_catalog.jsonb_build_object('lead_id', new.id, 'tenant_id', new.tenant_id),
          headers := pg_catalog.jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Braiin-Timestamp', v_ts,
            'X-Braiin-Signature', 'v1=' || pg_catalog.encode(
              extensions.hmac(v_ts || '.' || new.id::pg_catalog.text || '.' || new.tenant_id::pg_catalog.text,
                              v_secret, 'sha256'),
              'hex')
          ),
          timeout_milliseconds := 5000
        );
        return null;
      end if;
    end if;
  exception when others then
    v_problem := 'lead notification not queued';
    v_state := sqlstate;
  end;

  -- Configured, and this lead was not announced: a WARNING for the Postgres log and a
  -- system_logs row for Site Health (CLAUDE.md §4 DoD 6, §10), both naming no value. Both
  -- in a block of their own, so a log that cannot be written fails nothing either: no
  -- statement of this function runs outside a handler.
  begin
    raise warning 'leads_notify: % (SQLSTATE %)', v_problem, coalesce(v_state, 'none');
    insert into public.system_logs (tenant_id, level, source, message, detail)
    values (new.tenant_id, 'warn', 'leads_notify', v_problem,
            case when v_state is null then '{}'::pg_catalog.jsonb
                 else pg_catalog.jsonb_build_object('sqlstate', v_state) end);
  exception when others then
    null;
  end;
  return null;
end $$;

-- ---- 2. No API role executes it ------------------------------------------------------------
-- A trigger function, run by its trigger as its owner; no session calls it (as 0011 stated).
revoke all on function app.tg_notify_lead() from public, anon, authenticated, service_role;

-- ---- 3. The trigger ------------------------------------------------------------------------
-- Dropped first, so the end state is the same wherever this runs: where 0010 created it
-- (pg_net was there first) it is re-created as it was; where 0010 skipped it (production,
-- CI), it is created.
--
-- Order against leads_timeline (0034, AFTER INSERT OR UPDATE): AFTER row triggers on the same
-- event fire in name order, so leads_notify fires first. The order does not matter: this
-- trigger reads only the new row's id and tenant and Vault, and writes only pg_net's queue
-- (or, for a lead it could not announce, one system_logs row); leads_timeline reads none of
-- that and writes only lead_events and the notes mirror. The request is sent after commit,
-- when both have run, and if leads_timeline raises, the statement rolls back with the
-- queued request in it, so no lead that was not saved is ever announced.
drop trigger if exists leads_notify on public.leads;
create trigger leads_notify after insert on public.leads
  for each row execute function app.tg_notify_lead();

-- ---- 4. The daily check: leads no notification reached ------------------------------------
-- The trigger's failures are logged as they happen; what it cannot see is a request queued
-- and then lost (the worker down past the Worker's 300 s window, a 401 from a secret that
-- differs between Vault and the Worker, the Worker failing). The Worker's daily cron
-- (src/lib/cron/jobs.ts, `lead-notify`) calls this and logs the count. A miss is a lead
-- created between 24 hours and 15 minutes ago with no notification_log row: the hook writes
-- one row for every lead it accepts, recipients or not (src/pages/api/hooks/notify-lead.ts),
-- so a lead nobody was eligible to hear about is not a miss. Null while notifications are
-- not configured (no https Vault URL or no secret): then nothing was meant to be sent, and
-- the cron logs that instead. Counted across tenants, since the URL is the deployment's.
-- The first check after notifications are switched on may count leads that arrived in the
-- day before; that once is expected (launch runbook §5). SECURITY DEFINER to read Vault;
-- the service role alone executes it.
create or replace function public.lead_notify_misses() returns integer
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_url pg_catalog.text;
  v_secret pg_catalog.text;
begin
  select d.decrypted_secret into v_url
    from vault.decrypted_secrets d
   where d.name = 'notify_lead_url';
  select d.decrypted_secret into v_secret
    from vault.decrypted_secrets d
   where d.name = 'notify_lead_secret';
  if v_url is null or pg_catalog.lower(pg_catalog.left(v_url, 8)) <> 'https://'
     or v_secret is null or v_secret = '' then
    return null;
  end if;
  return (select pg_catalog.count(*)::pg_catalog.int4
            from public.leads l
           where l.created_at >= pg_catalog.now() - '24 hours'::pg_catalog.interval
             and l.created_at < pg_catalog.now() - '15 minutes'::pg_catalog.interval
             and not exists (select 1 from public.notification_log n where n.lead_id = l.id));
end $$;
revoke all on function public.lead_notify_misses() from public, anon, authenticated, service_role;
grant execute on function public.lead_notify_misses() to service_role;

-- ---- 5. Postconditions ----------------------------------------------------------------------
do $$
declare
  v_fn constant regprocedure := 'app.tg_notify_lead()'::regprocedure;
  v_owner name;
  v_role text;
  v_post regprocedure;
  v_name text;
  v_seq oid;
begin
  -- The function: a definer with an empty search_path, owned by the migration's role, and
  -- that role bypasses RLS (as 0034's and 0041's trigger owners do: a definer reaching a
  -- FORCE RLS table must not be held to staff policies).
  if not exists (select 1 from pg_proc f
                  where f.oid = v_fn and f.prosecdef
                    and f.proconfig = array['search_path=""']) then
    raise exception '0048: app.tg_notify_lead() must be SECURITY DEFINER with search_path = ''''';
  end if;
  select pg_get_userbyid(f.proowner) into v_owner from pg_proc f where f.oid = v_fn;
  if v_owner not in ('postgres', current_user) then
    raise exception '0048: app.tg_notify_lead() is owned by %, not postgres or the migration role', v_owner;
  end if;
  if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                  where f.oid = v_fn and (r.rolsuper or r.rolbypassrls)) then
    raise exception '0048: app.tg_notify_lead()''s owner does not bypass RLS';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_role, v_fn, 'execute') then
      raise exception '0048: % may execute app.tg_notify_lead()', v_role;
    end if;
  end loop;

  -- pg_net: installed, its queue and http_post in schema net.
  if not exists (select 1 from pg_extension where extname = 'pg_net')
     or to_regclass('net.http_request_queue') is null then
    raise exception '0048: pg_net is not installed, or its queue is not net.http_request_queue';
  end if;

  -- The trigger: enabled, AFTER INSERT FOR EACH ROW (tgtype 5: ROW 1 + INSERT 4, BEFORE 2
  -- clear), no WHEN clause, no arguments, calling the function.
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal
                    and t.tgname = 'leads_notify' and t.tgenabled::text = 'O'
                    and t.tgtype = 5 and t.tgqual is null and t.tgnargs = 0
                    and t.tgfoid = v_fn) then
    raise exception '0048: leads_notify is missing, disabled or not AFTER INSERT FOR EACH ROW calling app.tg_notify_lead()';
  end if;
  -- One announcement per lead: nothing else calls the function, and no other trigger on
  -- leads makes an HTTP call (a dashboard webhook would also send the whole row).
  if (select count(*) from pg_trigger t where t.tgfoid = v_fn) <> 1 then
    raise exception '0048: app.tg_notify_lead() must be called by leads_notify alone';
  end if;
  if exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
              where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal
                and f.oid <> v_fn and f.prosrc ~* 'http_(post|get|delete|request)') then
    raise exception '0048: another trigger on public.leads makes an HTTP call';
  end if;
  -- The log row: the owner writes system_logs (it bypasses RLS; the grant is checked too).
  if not has_table_privilege(v_owner, 'public.system_logs', 'insert') then
    raise exception '0048: % (the function''s owner) may not insert into system_logs', v_owner;
  end if;

  -- The daily check: a definer with an empty search_path, the service role's alone.
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.lead_notify_misses()'::regprocedure and f.prosecdef
                    and f.proconfig = array['search_path=""']) then
    raise exception '0048: public.lead_notify_misses() must be SECURITY DEFINER with search_path = ''''';
  end if;
  if not has_function_privilege('service_role', 'public.lead_notify_misses()', 'execute') then
    raise exception '0048: service_role may not execute public.lead_notify_misses()';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public.lead_notify_misses()', 'execute') then
      raise exception '0048: % may execute public.lead_notify_misses()', v_role;
    end if;
  end loop;

  -- The signature: pgcrypto's hmac where the function names it.
  if to_regprocedure('extensions.hmac(text, text, text)') is null then
    raise exception '0048: extensions.hmac(text, text, text) (pgcrypto) not found';
  end if;
  -- The call above passes named parameters; check pg_net still has them.
  v_post := to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)');
  if v_post is null or not exists (
       select 1 from pg_proc f
        where f.oid = v_post
          and f.proargnames @> array['url', 'body', 'headers', 'timeout_milliseconds']) then
    raise exception '0048: net.http_post(url, body, params, headers, timeout_milliseconds) not found';
  end if;
  if not (has_schema_privilege(v_owner, 'net', 'usage')
          and has_function_privilege(v_owner, v_post, 'execute')) then
    raise exception '0048: % (the function''s owner) may not call net.http_post', v_owner;
  end if;

  -- What the call needs from the owner beyond that. Since pg_net 0.10, net.http_post runs
  -- with its CALLER's rights (SECURITY INVOKER), and its caller here is the trigger
  -- function's owner: so the owner must be able to run every net function it calls (the
  -- URL encoders, net.wake()) and insert into every net table it writes (the queue, and
  -- the sequence behind its id). Read from http_post's own body, so a pg_net that calls
  -- something new is covered too. A failure here would otherwise surface only as every
  -- lead's WARNING (42501) and system_logs row, after the push.
  if not (select f.prosecdef from pg_proc f where f.oid = v_post) then
    for v_name in
      select distinct m[1]
        from pg_proc f
        cross join lateral regexp_matches(f.prosrc, 'net\.([a-z_][a-z0-9_]*)\s*\(', 'gi') m
       where f.oid = v_post
    loop
      if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'net' and p.proname = v_name)
         and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'net' and p.proname = v_name
                            and has_function_privilege(v_owner, p.oid, 'execute')) then
        raise exception '0048: % may not execute net.%(), which net.http_post calls', v_owner, v_name;
      end if;
    end loop;
    for v_name in
      select distinct m[1]
        from pg_proc f
        cross join lateral regexp_matches(f.prosrc, 'insert\s+into\s+net\.([a-z_][a-z0-9_]*)', 'gi') m
       where f.oid = v_post
    loop
      if to_regclass('net.' || v_name) is null
         or not has_table_privilege(v_owner, ('net.' || v_name)::regclass, 'insert') then
        raise exception '0048: % may not insert into net.%, which net.http_post writes', v_owner, v_name;
      end if;
      for v_seq in
        select s.oid from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
         where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass
           and d.refobjid = ('net.' || v_name)::regclass
      loop
        if not has_sequence_privilege(v_owner, v_seq, 'usage') then
          raise exception '0048: % may not use the sequence %, behind net.%', v_owner, v_seq::regclass, v_name;
        end if;
      end loop;
    end loop;
  end if;

  -- The configuration and the signature: the owner reads Vault and runs pgcrypto's hmac.
  if not (has_schema_privilege(v_owner, 'vault', 'usage')
          and has_table_privilege(v_owner, 'vault.decrypted_secrets', 'select')) then
    raise exception '0048: % (the function''s owner) may not read vault.decrypted_secrets', v_owner;
  end if;
  if not (has_schema_privilege(v_owner, 'extensions', 'usage')
          and has_function_privilege(v_owner, 'extensions.hmac(text, text, text)', 'execute')) then
    raise exception '0048: % (the function''s owner) may not run extensions.hmac', v_owner;
  end if;
end $$;
