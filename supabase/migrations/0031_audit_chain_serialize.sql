-- 0031 — Serialize the audit hash chain (hotfix H5, found by the Admin v2 F0 sweep).
--
-- THE DEFECT. app.tg_audit_chain() (0002, fixed in 0012) linked each new row to the
-- latest one with a plain read:
--
--     select hash into v_prev from audit_log where tenant_id = … order by id desc limit 1
--
-- Two transactions inserting at the same moment both read the SAME latest row, so both
-- new rows name the same predecessor: the chain FORKS. The admin's own verifier
-- (/api/admin/audit) then reports "Chain break detected", and the hourly anchor verifier
-- would page on it (CLAUDE.md §3: "verifier pages on mismatch") — a false tamper alarm,
-- and a chain that can no longer tell a race from an edit. Any two audited actions at
-- once reach it: two editors saving, a save and a sign-in. The signed-in e2e harness
-- signs four roles in at once and broke the chain at entry 2.
--
-- A second, quieter defect made a lock alone insufficient: the row's `id` (bigserial) is
-- taken by its column DEFAULT, BEFORE the trigger runs. A row that got id 10 but reached
-- the chain after id 11 would link to 11 while sitting below it, so walking by id
-- (as every verifier does) would still see a break.
--
-- THE FIX, inside the trigger, before anything is read:
--   1. A transaction-scoped advisory lock per tenant chain: one writer at a time, held
--      until commit, so the next writer reads the committed predecessor. The function is
--      VOLATILE, so under READ COMMITTED its SELECT takes a fresh snapshot after the wait.
--   2. The id is taken UNDER the lock (`nextval`, replacing the default's value; a gap
--      in the sequence is harmless), so id order is chain order.
-- Everything else is unchanged: the same payload, the same HMAC, the same Vault key.
--
-- CHAINS WRITTEN BEFORE THIS MIGRATION may already hold forks. A fork is recognisable:
-- two rows naming the SAME prev_hash, each a valid HMAC over its own payload. That is the
-- race this fixes; any other mismatch is not. Find candidates with:
--   select id, prev_hash from (
--     select id, prev_hash, lag(hash) over (partition by tenant_id order by id) as expected
--       from public.audit_log) t
--    where expected is not null and prev_hash is distinct from expected;
-- The log is append-only by design; record what you find, do not edit rows.
--
-- CLAUDE.md §3 (Pillar 1: audit_log append-only + HMAC-hash-chained), §9 (h), §10.

create or replace function app.tg_audit_chain() returns trigger
  language plpgsql security definer set search_path = public, app, vault, pg_temp as $$
declare
  v_prev text;
  v_key text;
  v_payload text;
begin
  -- One writer per tenant chain at a time (released at commit or rollback).
  perform pg_advisory_xact_lock(hashtextextended('audit_log:' || new.tenant_id::text, 0));
  -- The id is taken under the lock, so walking the chain by id walks it in link order.
  new.id := nextval(pg_get_serial_sequence('public.audit_log', 'id'));

  select hash into v_prev from public.audit_log
    where tenant_id = new.tenant_id order by id desc limit 1;
  new.prev_hash := v_prev;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'audit_hmac_key';
  if v_key is null then
    raise exception 'audit_hmac_key missing from Vault (run vault.create_secret(...))';
  end if;

  v_payload := coalesce(v_prev, '') || '|' || new.tenant_id::text || '|' || coalesce(new.actor_id::text, '')
    || '|' || coalesce(new.actor_role, '') || '|' || new.action || '|' || coalesce(new.entity_type, '')
    || '|' || coalesce(new.entity_id, '') || '|' || new.detail::text || '|' || new.created_at::text;

  -- extensions.-qualified (0012): pgcrypto lives in the `extensions` schema on Supabase.
  new.hash := encode(extensions.hmac(v_payload, v_key, 'sha256'), 'hex');
  return new;
end $$;

-- CREATE OR REPLACE keeps the ACL; re-asserted because this definer function reads the
-- Vault key that makes the chain tamper-evident.
revoke all on function app.tg_audit_chain() from public, anon, authenticated, service_role;

-- Postconditions: the trigger still fires the function, and the function now serializes.
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'tg_audit_chain';
  if v_src is null or position('pg_advisory_xact_lock' in v_src) = 0
     or position('nextval(pg_get_serial_sequence' in v_src) = 0 then
    raise exception '0031: app.tg_audit_chain() does not serialize the chain';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.audit_log'::regclass
       and t.tgfoid = 'app.tg_audit_chain()'::regprocedure
       and not t.tgisinternal
  ) then
    raise exception '0031: no trigger on public.audit_log runs app.tg_audit_chain()';
  end if;
  if pg_get_serial_sequence('public.audit_log', 'id') is null then
    raise exception '0031: public.audit_log.id has no owned sequence';
  end if;
end $$;
