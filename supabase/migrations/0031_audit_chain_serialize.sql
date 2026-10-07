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
--   3. Only READ COMMITTED is accepted. Under REPEATABLE READ or SERIALIZABLE the
--      snapshot is fixed when the statement starts, so the read after the wait would still
--      miss the row the lock waited for and fork the chain without an error. Every path
--      today (PostgREST, the cron, `db query`) runs at READ COMMITTED; anything else is
--      refused (0A000) rather than allowed to fork the chain without an error.
-- Everything else is unchanged: the same payload, the same HMAC, the same Vault key.
--
-- CHAINS WRITTEN BEFORE THIS MIGRATION may already hold breaks from the race: forks (two
-- rows naming the same prev_hash) and id reorders (a row linking to a HIGHER id). Both
-- leave every prev_hash naming a row that exists. A deleted or edited row does not: its
-- successor's prev_hash then names a hash no row carries. So classify old breaks by
-- following the links, not by id order. Rows this returns are unexplained by the race:
--   select a.id from public.audit_log a
--    where a.prev_hash is not null
--      and not exists (select 1 from public.audit_log b
--                       where b.tenant_id = a.tenant_id and b.hash = a.prev_hash);
-- (Each row's own HMAC is checked separately, as the verifier does.) The log is
-- append-only by design; record what you find, do not edit rows.
--
-- CLAUDE.md §3 (Pillar 1: audit_log append-only + HMAC-hash-chained), §9 (h), §10.

create or replace function app.tg_audit_chain() returns trigger
  language plpgsql security definer set search_path = public, app, vault, pg_temp as $$
declare
  v_prev text;
  v_key text;
  v_payload text;
begin
  -- The lock below serializes writers only if the read after it sees what they committed.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'audit_log inserts must run at READ COMMITTED (0031 chain serialization)'
      using errcode = '0A000';
  end if;
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
  -- In this order: the isolation check, the lock, the id, then the predecessor read.
  if v_src is null
     or not (0 < position('transaction_isolation' in v_src)
             and position('transaction_isolation' in v_src) < position('pg_advisory_xact_lock' in v_src)
             and position('pg_advisory_xact_lock' in v_src) < position('nextval(pg_get_serial_sequence' in v_src)
             and position('nextval(pg_get_serial_sequence' in v_src) < position('select hash into v_prev' in v_src)) then
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
