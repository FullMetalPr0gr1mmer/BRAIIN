-- ─────────────────────────────────────────────────────────────────────────────
-- 0030 — Leads: make the GRANT layer say what 0011 meant (hotfix H2).
-- Forward-only. Depends on 0002, 0011.
--
-- 0011 §5d granted `select, update on public.leads to authenticated` and its comment says
-- withholding INSERT and DELETE "means no admin session can forge or destroy a lead by
-- talking to PostgREST". But 0011 only revoked the stock Supabase defaults from `anon`
-- (§5a). The bootstrap's `alter default privileges … grant all on tables to authenticated`
-- was never revoked from `authenticated`, so the explicit grant was additive, and the
-- 0011 postcondition checks only what `authenticated` MUST hold, never what it must not.
-- If the defaults were applied, `leads_admin_dev_all` (FOR ALL) lets an Admin or
-- Developer token insert forged leads, delete leads, and rewrite any column (email_enc,
-- retention_delete_after, consent_marketing) straight through PostgREST, bypassing the
-- Worker's Zod checks and audit. RLS would be the only layer, and §3 requires two.
--
-- This states the grants instead of inheriting them, as 0029 does for job_applications:
--   • authenticated: SELECT, and UPDATE on the two columns the admin writes (status and
--     internal_notes, src/pages/api/admin/leads/[id].ts PATCH). No INSERT (leads arrive
--     through the public form, written by the service role with a server-resolved tenant),
--     no DELETE (app.purge_leads(), the definer retention job), no TRUNCATE.
--   • service_role: stated explicitly. Supabase stops auto-granting on 2026-10-30, so
--     nothing here relies on a default privilege for the ingest and notify paths.
-- Revokes are idempotent, so this is correct whether or not the defaults were applied.
-- The postconditions below check both what must and what must not be granted.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on public.leads from public, anon, authenticated;
grant select on public.leads to authenticated;
grant update (status, internal_notes) on public.leads to authenticated;
grant select, insert, update, delete on public.leads to service_role;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  p text;
  c text;
begin
  if not has_table_privilege('authenticated', 'public.leads', 'select') then
    raise exception '0030: authenticated lost SELECT on leads (the admin lead list reads it)';
  end if;
  foreach p in array array['insert', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('authenticated', 'public.leads', p) then
      raise exception '0030: authenticated still holds % on leads', p;
    end if;
    if has_table_privilege('anon', 'public.leads', p) then
      raise exception '0030: anon holds % on leads', p;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.leads', 'select')
     or has_table_privilege('anon', 'public.leads', 'update') then
    raise exception '0030: anon has access to leads';
  end if;
  if has_table_privilege('authenticated', 'public.leads', 'update') then
    raise exception '0030: authenticated holds table-wide UPDATE on leads (must be status/internal_notes only)';
  end if;
  foreach c in array array['status', 'internal_notes'] loop
    if not has_column_privilege('authenticated', 'public.leads', c, 'update') then
      raise exception '0030: authenticated cannot update leads.% (the admin PATCH writes it)', c;
    end if;
  end loop;
  foreach c in array array['email_enc', 'phone_enc', 'budget_enc', 'timeline_text_enc', 'timeline_band',
                           'ip_inet', 'retention_delete_after', 'consent_marketing', 'tenant_id',
                           'name', 'message', 'created_at'] loop
    if has_column_privilege('authenticated', 'public.leads', c, 'update') then
      raise exception '0030: authenticated may update leads.%', c;
    end if;
  end loop;
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.leads', p) then
      raise exception '0030: service_role lacks % on leads (ingest, notify and retention need it)', p;
    end if;
  end loop;
end $$;
