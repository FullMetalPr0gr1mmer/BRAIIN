-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 — The audit chain could never write a row.
--
-- `app.tg_audit_chain()` (0002:93) computes the chain hash with
--
--     new.hash := encode(hmac(v_payload, v_key, 'sha256'), 'hex');
--
-- `hmac` is a pgcrypto function. On Supabase, pgcrypto is pre-installed into the
-- `extensions` schema — so 0001's `create extension if not exists pgcrypto` was a no-op
-- that never put it in `public` — and this function's search_path is
-- `public, app, vault, pg_temp`, which does not include `extensions`. The name therefore
-- does not resolve, the trigger raises `function hmac(text, text, unknown) does not
-- exist`, and the INSERT into audit_log fails.
--
-- Why this was invisible: `writeAudit()` (src/lib/admin/audit.ts) deliberately catches
-- and returns false rather than throwing, because an audit write must not roll back the
-- operation it describes. Correct call — but it means the failure mode is a CMS that
-- works perfectly and records nothing. Creating and publishing a service left
-- `/admin/audit` reading "Nothing recorded. 0 of 0" with no error anywhere.
--
-- Identical root cause to 0010's `gen_random_bytes`, which failed LOUDLY because it ran
-- at migration time. This one sat inside a plpgsql body, where nothing is resolved until
-- the trigger actually fires, so it survived every migration, the 464-test suite, and a
-- clean `db push`.
--
-- The fix is the schema qualification, not a wider search_path: adding `extensions` to a
-- SECURITY DEFINER function's search_path widens what every unqualified name in it can
-- resolve to, which is the opposite of what a definer function wants. The body is 0002's,
-- unchanged, except for that one qualified call.
--
-- Forward-only. CLAUDE.md §3 (Pillar 1 — audit chain), §8, §10.
--
-- ⚠ TESTS OUTSTANDING (§9), carried forward from 0011: neither
-- `supabase/tests/grants_app_schema.test.sql` nor an audit-chain regression test exists
-- yet. The §9 test this needs is specifically "insert an audit row and assert `hash` is a
-- 64-char hex digest and `prev_hash` links to its predecessor" — an assertion on the
-- CHAIN, not on the API returning 200, because the API returned 200 throughout.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.tg_audit_chain() returns trigger
  language plpgsql security definer set search_path = public, app, vault, pg_temp as $$
declare
  v_prev text;
  v_key text;
  v_payload text;
begin
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

  -- extensions.-qualified: see the header. This single missing prefix is the whole bug.
  new.hash := encode(extensions.hmac(v_payload, v_key, 'sha256'), 'hex');
  return new;
end $$;

-- CREATE OR REPLACE preserves a function's ACL, so 0011's revoke survives. Re-asserted
-- anyway: this function is SECURITY DEFINER over the Vault key that makes the chain
-- tamper-evident, and "it should still be revoked" is not something to leave implicit.
revoke all on function app.tg_audit_chain() from public, anon, authenticated, service_role;

-- Prove the name now resolves, in this transaction, before anything depends on it.
-- Deliberately does NOT insert into audit_log: that table is FORCE RLS with an
-- `app.is_staff()` insert policy, and the migration role carries no JWT claims, so a
-- self-test row would abort this migration for a reason unrelated to the bug it fixes.
do $$
declare
  v_probe text;
begin
  v_probe := encode(extensions.hmac('probe', 'key', 'sha256'), 'hex');
  if v_probe is null or length(v_probe) <> 64 then
    raise exception
      '0012 self-test failed: extensions.hmac did not return a 32-byte digest (length %)',
      coalesce(length(v_probe)::text, 'null');
  end if;
end $$;
