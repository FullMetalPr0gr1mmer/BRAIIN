-- ─────────────────────────────────────────────────────────────────────────────
-- 0048 — The lead-notification trigger, restored and hardened (hotfix H9). Forward-only,
-- expand only. Depends on 0001 (site_settings), 0002 (leads), 0010 (app.tg_notify_lead,
-- the first leads_notify), 0011 (its revoke) and 0034 (leads_pipeline, leads_timeline).
--
-- CLAUDE.md §10: a new lead is announced by an AFTER INSERT trigger that asks pg_net to POST
-- {lead_id, tenant_id} to the Worker's /api/hooks/notify-lead, with
-- `Authorization: Bearer <notify_lead_secret from Vault>`; the Worker checks the bearer in
-- constant time and re-reads the row itself. 0010 created that trigger only if pg_net was
-- already installed when it ran. Where it was not, the function exists and nothing calls
-- it, so no lead has ever been announced (notification_log stays empty) and nothing says
-- so. pg_net is installed on those databases now, so this migration creates the trigger,
-- and re-creates the function first, hardened:
--
--   • SECURITY DEFINER with an empty search_path: every name it reaches is qualified
--     (public.site_settings, vault.decrypted_secrets, net.http_post, pg_catalog's
--     functions) and its variables are pg_catalog.text, so nothing on a caller's path,
--     pg_temp included, can stand in for any of them. 0010's path was
--     `public, app, extensions, net, pg_temp`.
--   • The contract is 0010's: the body is exactly {lead_id, tenant_id}, nothing from the
--     lead's content; the URL is site_settings.identity ->> 'notify_lead_url' of the row's
--     own tenant, never another's; the bearer is the Vault secret notify_lead_secret. No URL
--     means notifications are off for that tenant, and the trigger does nothing, silently.
--   • Only an https:// URL is called: the bearer secret never travels in plaintext. Any
--     other URL is skipped with a WARNING that names no value, as is a URL with no secret.
--   • Who chooses where it goes: site_settings is written by Admin and Developer (§5,
--     General settings), so either can point notify_lead_url, and with it the bearer, at any
--     https host. That is 0010's trust, kept on purpose: both roles already read lead PII,
--     and the bearer buys only the hook, which re-reads a lead server-side and answers a
--     recipient count (a forged call adds a notification_log row, nothing more). A bearer
--     sent somewhere it should not go is replaced in both places: vault.update_secret and
--     the Worker secret NOTIFY_LEAD_SECRET.
--   • Nothing it does can fail an insert. Any error while reading the configuration or
--     queueing the request is caught and becomes a WARNING carrying only the SQLSTATE
--     (never the URL, the secret or a lead value: an error message can quote any of them),
--     and the lead is saved. A contact form that fails because a notification could not be
--     queued is the worse failure (0010 §6). 0010's body had no handler, so a pg_net error
--     would have failed the insert.
--   • The request timeout is explicit (5 s; pg_net's parameter `timeout_milliseconds`). A
--     postcondition checks that net.http_post still takes the named parameters this
--     function passes, so a pg_net whose signature changed fails this migration instead of
--     every lead's notification failing quietly into a WARNING.
--
-- pg_net only queues the request in this transaction (a row in net.http_request_queue); its
-- background worker sends it after commit. A lead whose insert rolls back is never
-- announced, and the Worker always finds the row it is told about.
--
-- Turning notifications on stays an owner step (launch runbook §5): the Vault secret
-- notify_lead_secret, the Worker secret NOTIFY_LEAD_SECRET with the same value, and the
-- https URL in site_settings.identity.notify_lead_url. Until all three exist this trigger
-- queues nothing. CLAUDE.md §3 (Pillar 1), §10.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as in 0038 to 0045): creating the
-- trigger takes a SHARE ROW EXCLUSIVE lock on public.leads, which blocks the contact form's
-- inserts for as long as the lock request waits behind a long transaction. A statement
-- below that waits more than five seconds for a lock raises instead, the whole migration
-- rolls back, and the push is retried later. Transaction-local: it ends with this migration.
set local lock_timeout = '5s';

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
begin
  -- One block, one handler: whatever raises below (a missing schema, a Vault that cannot
  -- decrypt, a URL pg_net refuses, a changed signature) is rolled back to here and the
  -- insert goes on. SQLSTATE only: SQLERRM can quote the URL or the secret.
  begin
    select s.identity ->> 'notify_lead_url' into v_url
      from public.site_settings s
     where s.tenant_id = new.tenant_id;
    -- Not configured: notifications are off for this tenant. A choice, not a fault.
    if v_url is null or v_url = '' then
      return null;
    end if;

    if pg_catalog.lower(pg_catalog.left(v_url, 8)) <> 'https://' then
      raise warning 'leads_notify: notify_lead_url is not an https:// URL; lead notification skipped';
      return null;
    end if;

    select d.decrypted_secret into v_secret
      from vault.decrypted_secrets d
     where d.name = 'notify_lead_secret';
    if v_secret is null or v_secret = '' then
      raise warning 'leads_notify: the Vault secret notify_lead_secret is missing; lead notification skipped';
      return null;
    end if;

    perform net.http_post(
      url := v_url,
      body := pg_catalog.jsonb_build_object('lead_id', new.id, 'tenant_id', new.tenant_id),
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      timeout_milliseconds := 5000
    );
  exception when others then
    raise warning 'leads_notify: lead notification not queued (SQLSTATE %)', sqlstate;
  end;
  return null;
end $$;

-- ---- 2. No API role executes it ------------------------------------------------------------
-- A trigger function, run by its trigger as its owner; no session calls it (as 0011 stated).
revoke all on function app.tg_notify_lead() from public, anon, authenticated, service_role;

-- ---- 3. The trigger ------------------------------------------------------------------------
-- Dropped first on every database, so the end state is the same wherever this runs: the
-- trigger exists exactly when pg_net does. Where 0010 created it, it is re-created as it
-- was; where pg_net is missing, nothing is left that would call a net.http_post that does not
-- exist.
--
-- Order against leads_timeline (0034, AFTER INSERT OR UPDATE): AFTER row triggers on the same
-- event fire in name order, so leads_notify fires first. The order does not matter: this
-- trigger reads only the new row's id and tenant, site_settings and Vault, and writes only
-- pg_net's queue; leads_timeline reads none of that and writes only lead_events and the notes
-- mirror. The request is sent after commit, when both have run, and if leads_timeline raises,
-- the statement rolls back with the queued request in it, so no lead that was not saved is
-- ever announced.
drop trigger if exists leads_notify on public.leads;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    create trigger leads_notify after insert on public.leads
      for each row execute function app.tg_notify_lead();
  else
    raise notice '0048: pg_net is not installed, so leads_notify is not created (leads still save; launch runbook §5)';
  end if;
end $$;

-- ---- 4. Postconditions ----------------------------------------------------------------------
do $$
declare
  v_fn constant regprocedure := 'app.tg_notify_lead()'::regprocedure;
  v_owner name;
  v_role text;
  v_post regprocedure;
begin
  -- The function: a definer with an empty search_path, owned by the migration's role, and
  -- that role bypasses RLS (site_settings is FORCE RLS, readable only by staff tokens, so an
  -- owner held to its policy would read no URL and announce nothing).
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

  if exists (select 1 from pg_extension where extname = 'pg_net') then
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
  elsif exists (select 1 from pg_trigger t where t.tgfoid = v_fn) then
    raise exception '0048: without pg_net, no trigger may call app.tg_notify_lead()';
  end if;
end $$;
