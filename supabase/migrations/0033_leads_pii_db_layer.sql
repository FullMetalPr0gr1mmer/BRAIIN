-- ─────────────────────────────────────────────────────────────────────────────
-- 0033 — Leads: personal data held at the database layer (Admin v2 C1a-1).
-- Forward-only. Depends on 0002, 0011, 0015, 0017, 0028, 0029, 0030.
--
-- Three gaps from the Admin v2 verification (docs/admin-v2/crm.md §1, D5 and D7, and the
-- plan's correction "one lead at a time is false at PostgREST"):
--
--   1. COLUMN READS. `authenticated` holds table-wide SELECT on leads (0011, restated by
--      0030). So any Admin or Developer token can read every lead's ciphertext, budget,
--      timeline, address and plaintext internal_notes in one PostgREST call, with no audit
--      row and no rate limit. The CMS only ever uses the audited reveal, but nothing in
--      the database made it the only way in.
--   2. STALE TOKENS (D5). RLS reads the role from the JWT. A Developer who is demoted,
--      deactivated or locked keeps reading leads, notes included, for up to an hour
--      through PostgREST. 0029 closed this for job applications only.
--   3. THE leads_safe SENTENCE (D7). CLAUDE.md said leads_safe's GRANT "is not to all
--      authenticated". It always was (0002, 0011): every app role signs in as the one
--      Postgres role `authenticated`, so a GRANT cannot tell Admin from SEO. RLS, through
--      security_invoker, is the control. The docs are corrected; the view is unchanged.
--
-- THE FIX
--   • SELECT on leads becomes a COLUMN grant: leads_safe's columns, plus tenant_id for
--     the tenant predicate every admin query adds. Not granted: email_enc, phone_enc,
--     budget_enc, timeline_band, timeline_text_enc, internal_notes, ip_inet,
--     retention_delete_after. Those leave the database only through the Worker's audited
--     paths, as the service role: the per-lead reveal (leads.pii + a live recheck + an
--     audit row written first, fail-closed) and the CSV export (the §3 lockdown). Staff
--     still WRITE notes through 0030's column UPDATE grant, because writing needs no read.
--     A column added to leads later is unreadable by staff until a migration grants it.
--   • app.live_role(): the caller's role as their profile says it NOW. It is null when
--     the profile is inactive, locked, in another tenant, or disagrees with the token
--     (CLAUDE.md §2, Phase 3: divergence is rejected, never downgraded). It generalises
--     app.is_live_admin() (0029) for the CRM tables that follow.
--   • One SQL helper per capability, starting with app.role_works_leads (leads.manage).
--     Adding the Sales role (C10) is then a one-line change, and
--     tests/authz/sqlHelpers.spec.ts holds every helper equal to ROLE_CAPS.
--   • Policies rewritten: FOR SELECT and FOR UPDATE only, to authenticated. 0030 withheld
--     INSERT and DELETE at the GRANT layer; with no policy for them, RLS refuses them too.
--     Plus a RESTRICTIVE live policy carrying its own tenant predicate (Admin v2 P-14).
--     The retention job (app.purge_leads, definer) and the service role are not
--     `authenticated`, so none of these policies applies to them: no change there.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. The live role ------------------------------------------------------------------
-- Reads only the caller's own profile row, which profiles_self_select allows anyway, so it
-- does not depend on the owner bypassing RLS. Used as `(select app.live_role())` it is an
-- InitPlan: one primary-key lookup per statement, not per row.
create or replace function app.live_role() returns text
  language sql stable security definer set search_path = ''
as $$
  with c as (
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb as j
  )
  select p.role::text
    from c
    -- CASE, not AND: SQL does not promise to test the shape before the cast (0029).
    join public.profiles p
      on p.id = case
                  when (c.j ->> 'sub') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (c.j ->> 'sub')::uuid
                end
   where p.is_active
     and (p.locked_until is null or p.locked_until <= now())
     and p.tenant_id = app.effective_tenant_id()
     -- The token and the profile must agree. A role change re-issues the token; until
     -- then the old one reads nothing.
     and p.role::text = (c.j #>> '{app_metadata,role}')
$$;
revoke all on function app.live_role() from public, anon, authenticated, service_role;
grant execute on function app.live_role() to authenticated;

-- ---- 2. One helper per capability ------------------------------------------------------
-- `language sql immutable`, so the planner inlines it. It mirrors one ROLE_CAPS column
-- (tests/authz/sqlHelpers.spec.ts parses the last definition and compares).
create or replace function app.role_works_leads(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin', 'developer'), false) $$;  -- leads.manage
revoke all on function app.role_works_leads(text) from public, anon, authenticated, service_role;
grant execute on function app.role_works_leads(text) to authenticated, service_role;

-- ---- 3. Policies -----------------------------------------------------------------------
drop policy if exists leads_admin_dev_all on public.leads;

drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()));

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()));

-- RESTRICTIVE: ANDed with the policies above, so it can only narrow. The token's role
-- opens the door (permissive); the profile's role, read live, must hold it open.
drop policy if exists leads_live on public.leads;
create policy leads_live on public.leads as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_works_leads((select app.live_role())));

-- ---- 4. Grants, stated -----------------------------------------------------------------
-- Revoking a table privilege also revokes that privilege on every column (Postgres,
-- REVOKE), so SELECT starts from nothing here. 0030's UPDATE (status, internal_notes) is
-- a different privilege and stays.
revoke select on public.leads from public, anon, authenticated;
grant select (id, tenant_id, kind, locale, name, company, message, service_of_interest,
              discipline_of_interest, status, consent_marketing, created_at, updated_at)
  on public.leads to authenticated;
grant select, insert, update, delete on public.leads to service_role;

-- leads_safe: read-only for staff, nothing for anon. It is SECURITY INVOKER, so it reads
-- leads with the caller's column grant and RLS; every column it selects is granted above.
revoke all on public.leads_safe from public, anon, authenticated;
grant select on public.leads_safe to authenticated;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  v_safe constant text[] := array['id', 'tenant_id', 'kind', 'locale', 'name', 'company',
    'message', 'service_of_interest', 'discipline_of_interest', 'status',
    'consent_marketing', 'created_at', 'updated_at'];
  v_readable text[];
  p text;
begin
  -- Exactly the safe columns are readable by staff tokens: no table-wide SELECT, no
  -- gated column, and no column this migration did not name.
  if has_table_privilege('authenticated', 'public.leads', 'select') then
    raise exception '0033: authenticated still holds table-wide SELECT on leads';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_readable
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'select');
  if not (v_readable @> v_safe and v_readable <@ v_safe) then
    raise exception '0033: authenticated reads leads columns % (expected exactly %)', v_readable, v_safe;
  end if;
  if has_any_column_privilege('anon', 'public.leads', 'select') then
    raise exception '0033: anon can read leads';
  end if;

  -- 0030's write layer is intact: notes and status only, no insert or delete.
  if not has_column_privilege('authenticated', 'public.leads', 'status', 'update')
     or not has_column_privilege('authenticated', 'public.leads', 'internal_notes', 'update') then
    raise exception '0033: staff lost the status/notes UPDATE grant';
  end if;
  foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.leads', p) then
      raise exception '0033: authenticated holds table-wide % on leads', p;
    end if;
  end loop;
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.leads', p) then
      raise exception '0033: service_role lacks % on leads (ingest, notify, reveal and export need it)', p;
    end if;
  end loop;

  -- Policies: no FOR ALL or INSERT/DELETE permissive policy is left, and the live one is
  -- RESTRICTIVE with the tenant predicate on both sides.
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'leads'
                and permissive = 'PERMISSIVE' and cmd in ('ALL', 'INSERT', 'DELETE')) then
    raise exception '0033: a permissive FOR ALL/INSERT/DELETE policy remains on leads';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_live'
                    and permissive = 'RESTRICTIVE' and cmd = 'ALL'
                    and qual like '%live_role%' and qual like '%effective_tenant_id%'
                    and with_check like '%live_role%' and with_check like '%effective_tenant_id%') then
    raise exception '0033: leads_live is missing, permissive, or lacks the live check or tenant predicate';
  end if;

  -- leads_safe: still invoker rights, still read-only, still none of the gated columns.
  if not (select coalesce(reloptions::text[] @> array['security_invoker=true'], false)
            from pg_class where oid = 'public.leads_safe'::regclass) then
    raise exception '0033: leads_safe lost security_invoker; every authenticated role would read all leads';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'leads_safe'
                and column_name in ('email_enc', 'phone_enc', 'budget_enc', 'timeline_band',
                                    'timeline_text_enc', 'internal_notes', 'ip_inet',
                                    'retention_delete_after')) then
    raise exception '0033: leads_safe exposes a gated lead column';
  end if;
  foreach p in array array['insert', 'update', 'delete'] loop
    if has_table_privilege('authenticated', 'public.leads_safe', p) then
      raise exception '0033: authenticated holds % on leads_safe', p;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.leads_safe', 'select') then
    raise exception '0033: anon can read leads_safe';
  end if;

  -- The helpers: staff execute them, anon does not; live_role is a definer.
  if has_function_privilege('anon', 'app.live_role()', 'execute')
     or not has_function_privilege('authenticated', 'app.live_role()', 'execute') then
    raise exception '0033: app.live_role() EXECUTE is wrong (authenticated only)';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'app.live_role()'::regprocedure and prosecdef) then
    raise exception '0033: app.live_role() is not SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'app.role_works_leads(text)', 'execute')
     or not has_function_privilege('authenticated', 'app.role_works_leads(text)', 'execute') then
    raise exception '0033: app.role_works_leads(text) EXECUTE is wrong';
  end if;
end $$;
