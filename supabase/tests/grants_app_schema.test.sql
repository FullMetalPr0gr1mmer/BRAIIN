-- pgTAP: schema `app` + schema `public` privileges (migration 0011).
--
-- This is the test that did not exist when it was needed. `anon` had no USAGE on schema
-- `app`, every RLS policy calls a helper that lives there, and so EVERY public read
-- failed with 42501 `permission denied for schema app` — the entire site, in production.
-- The 464-test Vitest suite was green throughout because it mocks the database: a GRANT
-- is invisible to a mock. Postgres authorization is two gates in sequence — GRANTs first,
-- RLS second — and only a test that talks to real Postgres as the real role sees the first.
--
-- Two halves, both blocking:
--   1. NOT BROKEN — anon/authenticated can reach what the policies need, or the site 500s.
--   2. NOT OPEN   — anon cannot reach anything else, or 0011 traded an outage for a leak.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §9.

begin;
select plan(25);

-- ---- 1. The schema gate itself -------------------------------------------------------
select ok(
  has_schema_privilege('anon', 'app', 'usage'),
  'anon has USAGE on schema app (without this every RLS policy fails 42501)'
);
select ok(
  has_schema_privilege('authenticated', 'app', 'usage'),
  'authenticated has USAGE on schema app'
);

-- ---- 2. The helper allowlist — what the policies actually call ------------------------
-- Every one of these appears in a USING/WITH CHECK expression. A policy is evaluated with
-- the QUERYING role's privileges, so a missing EXECUTE here is a hard outage, not a
-- degraded path. SECURITY DEFINER does not help: definer governs what the BODY may touch,
-- never the right to CALL.
select ok(has_function_privilege('anon', 'app.effective_tenant_id()', 'execute'),
  'anon can execute app.effective_tenant_id()');
select ok(has_function_privilege('anon', 'app.current_tenant_id()', 'execute'),
  'anon can execute app.current_tenant_id()');
select ok(has_function_privilege('anon', 'app.default_tenant_id()', 'execute'),
  'anon can execute app.default_tenant_id() (the anon fence)');
select ok(has_function_privilege('anon', 'app.current_role()', 'execute'),
  'anon can execute app.current_role()');
select ok(has_function_privilege('anon', 'app.is_staff()', 'execute'),
  'anon can execute app.is_staff() (the restrictive policies branch on it)');
select ok(has_function_privilege('anon', 'app.is_admin()', 'execute'),
  'anon can execute app.is_admin()');
select ok(has_function_privilege('anon', 'app.can_write_content()', 'execute'),
  'anon can execute app.can_write_content()');
select ok(has_function_privilege('authenticated', 'app.ar_tsvector(text)', 'execute'),
  'authenticated can execute app.ar_tsvector(text) — services/blog/portfolio search_ar are '
  'STORED generated columns re-evaluated in the WRITER''s session on every insert/update');

-- ---- 3. Default-deny — the privileged routines stay unreachable -----------------------
-- Postgres grants EXECUTE to PUBLIC by default, so opening the schema without revoking
-- first would have handed an anonymous visitor a data-deletion primitive.
select ok(not has_function_privilege('anon', 'app.purge_leads()', 'execute'),
  'anon CANNOT execute app.purge_leads()');
select ok(not has_function_privilege('anon', 'app.purge_telemetry()', 'execute'),
  'anon CANNOT execute app.purge_telemetry()');
select ok(not has_function_privilege('anon', 'app.run_retention()', 'execute'),
  'anon CANNOT execute app.run_retention()');
select ok(not has_function_privilege('anon', 'app.publish_scheduled()', 'execute'),
  'anon CANNOT execute app.publish_scheduled()');
select ok(not has_function_privilege('authenticated', 'app.purge_leads()', 'execute'),
  'authenticated CANNOT execute app.purge_leads() either — staff use the CMS, not the routine');
select ok(not has_function_privilege('anon', 'app.retention_max_int(text, int)', 'execute'),
  'anon CANNOT execute app.retention_max_int() — SECURITY DEFINER, reads site_settings '
  'past its staff-only policy with no tenant predicate');
select ok(not has_function_privilege('anon', 'app.tg_audit_chain()', 'execute'),
  'anon CANNOT execute app.tg_audit_chain() — it reads the Vault HMAC key');

-- ---- 4. Exhaustive: nothing outside the allowlist is reachable ------------------------
-- A named-function list rots the moment migration 0013 adds one. This assertion is a
-- property of the catalog instead, so a new PUBLIC-executable app.* routine fails here
-- rather than shipping.
select is(
  (
    select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text), '')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and has_function_privilege('anon', p.oid, 'execute')
       and p.oid::regprocedure::text not in (
         'app.effective_tenant_id()', 'app.current_tenant_id()', 'app.default_tenant_id()',
         'app.current_role()', 'app.is_staff()', 'app.is_admin()', 'app.can_write_content()',
         'app.normalize_ar(text)', 'app.normalize_ar_q(text)'
       )
  ),
  '',
  'no app.* routine outside the read-only allowlist is executable by anon'
);

-- ---- 5. Table privileges — RLS is only reached AFTER the GRANT passes -----------------
select ok(has_table_privilege('anon', 'public.services', 'select'),
  'anon has SELECT on services');
select ok(has_table_privilege('anon', 'public.entity_seo', 'select'),
  'anon has SELECT on entity_seo (src/lib/data/seo.ts reads it anonymously)');

-- SELECT and ONLY select. Supabase's stock bootstrap grants ALL on public tables to anon,
-- so an additive `grant select` would have left INSERT/UPDATE/DELETE/TRUNCATE in place —
-- RLS as the only guard, one layer not two, and TRUNCATE is not subject to RLS at all.
select is(
  (
    select coalesce(string_agg(distinct c.relname || ':' || pr.priv, ', '), '')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['insert', 'update', 'delete', 'truncate']) as pr(priv)
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and has_table_privilege('anon', c.oid, pr.priv)
  ),
  '',
  'anon holds NO insert/update/delete/truncate anywhere in schema public'
);

-- ---- 6. The tables anon must never reach at all --------------------------------------
select ok(not has_table_privilege('anon', 'public.leads', 'select'),
  'anon CANNOT select public.leads');
select ok(not has_table_privilege('anon', 'public.audit_log', 'select'),
  'anon CANNOT select public.audit_log');
select ok(not has_table_privilege('anon', 'public.profiles', 'select'),
  'anon CANNOT select public.profiles');
select ok(not has_table_privilege('anon', 'public.site_integrations', 'select'),
  'anon CANNOT select public.site_integrations (API keys)');

select * from finish();
rollback;
