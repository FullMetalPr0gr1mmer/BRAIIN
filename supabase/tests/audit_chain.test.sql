-- pgTAP: audit_log append-only + HMAC hash chain (migrations 0002 / 0012).
--
-- Written after the chain spent its entire life unable to write a single row. 0002's
-- trigger computed `encode(hmac(...), 'hex')` with `hmac` UNQUALIFIED, while the
-- function's search_path was `public, app, vault, pg_temp` — no `extensions`, which is
-- where Supabase installs pgcrypto. Every insert raised, and `writeAudit()` catches and
-- returns false so an audit failure cannot roll back the operation it describes. Net
-- effect: a CMS that worked perfectly and recorded nothing, with no error anywhere.
--
-- So these assertions are deliberately about the CHAIN, not about the caller succeeding.
-- The API returned 200 for the whole period it was broken; `insert ... ` "not throwing"
-- would also have passed. What must be true is that a row comes back with a well-formed
-- digest that LINKS to its predecessor, and that no one can rewrite history afterwards.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §9, §10.

begin;
select plan(11);

insert into public.tenants (id, name) values ('00000000-0000-0000-0000-000000000001', 'T1');

-- The trigger reads this from Vault and raises without it. On a bare-Postgres host with
-- no vault schema the whole suite is meaningless, so assert the precondition loudly
-- rather than let every case below fail for the wrong reason.
select ok(to_regclass('vault.secrets') is not null, 'vault.secrets exists (Supabase stack is up)');
select ok(
  exists (select 1 from vault.secrets where name = 'audit_hmac_key'),
  'audit_hmac_key is present in Vault (0010 created it)'
);

-- ---- 1. A row gets a real digest -----------------------------------------------------
insert into public.audit_log (tenant_id, actor_role, action, entity_type, entity_id, detail)
values ('00000000-0000-0000-0000-000000000001', 'admin', 'test.first', 'service', 's1', '{}'::jsonb);

select matches(
  (select hash from public.audit_log where action = 'test.first'),
  '^[0-9a-f]{64}$',
  'first entry gets a 64-char lowercase hex HMAC-SHA256 digest'
);
select is(
  (select prev_hash from public.audit_log where action = 'test.first'),
  null,
  'first entry in a tenant has a null prev_hash'
);

-- ---- 2. The chain actually links -----------------------------------------------------
insert into public.audit_log (tenant_id, actor_role, action, entity_type, entity_id, detail)
values ('00000000-0000-0000-0000-000000000001', 'admin', 'test.second', 'service', 's1', '{}'::jsonb);

select is(
  (select prev_hash from public.audit_log where action = 'test.second'),
  (select hash from public.audit_log where action = 'test.first'),
  'second entry''s prev_hash IS the first entry''s hash — the chain links'
);
select isnt(
  (select hash from public.audit_log where action = 'test.second'),
  (select hash from public.audit_log where action = 'test.first'),
  'distinct entries produce distinct digests'
);

-- ---- 3. The caller cannot supply, skip or forge the hash ------------------------------
-- The whole reason the digest is computed by a BEFORE INSERT trigger rather than by the
-- application: a caller that could pass `hash` could pass a plausible wrong one, and the
-- chain would verify against itself forever.
insert into public.audit_log (tenant_id, actor_role, action, detail, hash, prev_hash)
values ('00000000-0000-0000-0000-000000000001', 'admin', 'test.forged', '{}'::jsonb,
        'deadbeef', 'deadbeef');

select isnt(
  (select hash from public.audit_log where action = 'test.forged'),
  'deadbeef',
  'a caller-supplied hash is OVERWRITTEN by the trigger'
);
select is(
  (select prev_hash from public.audit_log where action = 'test.forged'),
  (select hash from public.audit_log where action = 'test.second'),
  'a caller-supplied prev_hash is overwritten with the real predecessor'
);

-- ---- 4. Chains are per-tenant --------------------------------------------------------
insert into public.tenants (id, name) values ('00000000-0000-0000-0000-000000000002', 'T2');
insert into public.audit_log (tenant_id, actor_role, action, detail)
values ('00000000-0000-0000-0000-000000000002', 'admin', 'test.other_tenant', '{}'::jsonb);

select is(
  (select prev_hash from public.audit_log where action = 'test.other_tenant'),
  null,
  'a second tenant starts its own chain — chains never interleave across tenants'
);

-- ---- 5. Append-only: no UPDATE, no DELETE --------------------------------------------
-- 0002 grants no update/delete policy (so RLS denies) AND hard-revokes the privilege, so
-- even service_role cannot tamper. Checked as `authenticated`, the role staff connect as.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('app_metadata',
    json_build_object('role', 'admin', 'tenant_id', '00000000-0000-0000-0000-000000000001')
  )::text,
  true
);

select throws_ok(
  $$ update public.audit_log set action = 'tampered' where action = 'test.first' $$,
  '42501', null, 'admin CANNOT update an audit row'
);
select throws_ok(
  $$ delete from public.audit_log where action = 'test.first' $$,
  '42501', null, 'admin CANNOT delete an audit row'
);

reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
